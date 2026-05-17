import type { Env } from "../config/env.js";
import { prisma } from "./prisma.js";
import { appendProjectChatMessage } from "./projectChat.js";
import { recordAutonomousOrchestrationStall } from "./deliveryAutonomous.js";
import { finalizeCoderOutputToReview } from "./taskReviewFlow.js";
import { ensureProjectDevWorkspace, validateProjectDevWorkspaceAgainstRecord } from "./workspaceScaffold.js";
import { buildIntakeContextPrefix, withProposeBindingFallback } from "../integrations/pmOrchestrator.js";
import { e2eStubCoderMarkdown, generateCoderMarkdownWithLlm } from "../integrations/coderTaskLlm.js";
import {
  composeImplementationSystemPromptForSeat,
} from "../prompt/skills/composeSeatTaskPrompt.js";
import type { OrchestrationLogTarget } from "./deliveryOrchestrationHub.js";
import { isCoderEligibleTask } from "./coderTaskEligibility.js";

export type CoderAgentRunResult = {
  ran: boolean;
  usedLlm?: boolean;
  submittedToReview?: boolean;
  skippedReason?: string;
  error?: string;
};

/**
 * Scaffolds optional on-disk workspace, invokes the assignee’s mapped model to draft implementation Markdown,
 * then moves the task to **review** with reviewer assignment and SDM handoff text.
 */
export async function runCoderAgentForTask(
  taskId: string,
  env: Env,
  options?: { orchestrationLogger?: OrchestrationLogTarget }
): Promise<CoderAgentRunResult> {
  if (env.AGENT_CODER_USE_LLM !== "true" && env.AGENT_CODER_E2E_STUB !== "true") {
    return { ran: false, skippedReason: "coder_llm_disabled" };
  }

  const task = await prisma.task.findUnique({
    where: { id: taskId },
    include: {
      targetRole: {
        include: {
          roleTemplate: { select: { code: true } },
          skillLinks: {
            include: { skillTemplate: { select: { code: true, agentPrompt: true, sortOrder: true } } },
          },
        },
      },
      assigneeAgent: { select: { id: true, name: true } },
      project: { select: { id: true, name: true, devWorkspacePath: true } },
    },
  });
  if (!task || task.state !== "in_progress") {
    return { ran: false, skippedReason: "not_in_progress" };
  }
  if (!isCoderEligibleTask(task)) {
    return { ran: false, skippedReason: "not_coder_task" };
  }

  const ws = await ensureProjectDevWorkspace(task.projectId, env);
  let workspacePath = ws.path ?? task.project.devWorkspacePath ?? null;
  if (!workspacePath && !ws.error) {
    const p = await prisma.project.findUnique({
      where: { id: task.projectId },
      select: { devWorkspacePath: true },
    });
    workspacePath = p?.devWorkspacePath ?? null;
  }

  const pathGuard = validateProjectDevWorkspaceAgainstRecord(env, task.project, workspacePath);
  if (!pathGuard.ok) {
    await appendProjectChatMessage({
      projectId: task.projectId,
      actorKind: "orchestrator",
      actorLabel: "Orchestrator",
      body:
        `Coder run skipped — workspace path rejected (**${pathGuard.reason}**). ` +
        `Expected the scaffolded folder recorded on the project (` +
        `\`devWorkspacePath\` under **SARVA_AGENT_WORKSPACE**).`,
      meta: { event: "coder.workspace_path_guard", taskId: task.id, reason: pathGuard.reason },
    });
    return { ran: false, error: `workspace_path_guard:${pathGuard.reason}` };
  }

  const company = await prisma.company.findFirst();
  const companyId = company?.id ?? null;

  let markdown: string;
  let usedLlm: boolean;

  if (env.AGENT_CODER_E2E_STUB === "true") {
    const assigneeName = task.assigneeAgent?.name ?? "Agent";
    await appendProjectChatMessage({
      projectId: task.projectId,
      actorKind: "orchestrator",
      actorLabel: "Orchestrator",
      body: `Dispatched coder run for "${task.title}" to ${assigneeName}.`,
      meta: {
        event: "coder.run.dispatch",
        taskId: task.id,
        assigneeAgentId: task.assigneeAgentId,
        mode: "stub",
      },
    });
    markdown = e2eStubCoderMarkdown(task.title);
    usedLlm = false;
  } else {
    const assigneeName = task.assigneeAgent?.name ?? "Agent";
    await appendProjectChatMessage({
      projectId: task.projectId,
      actorKind: "orchestrator",
      actorLabel: "Orchestrator",
      body: `Dispatched coder run for "${task.title}" to ${assigneeName}.`,
      meta: {
        event: "coder.run.dispatch",
        taskId: task.id,
        assigneeAgentId: task.assigneeAgentId,
        mode: "llm",
      },
    });
    let prefix = "";
    try {
      prefix = await buildIntakeContextPrefix(task.projectId);
    } catch {
      prefix = "";
    }
    /** Text-only context: DB intake + task. No automatic embedding of repo file contents (OpenAI path). Cursor local uses `cursorLocalPreferredCwd` for filesystem tools. */
    const user = [
      `Project: ${task.project.name} (${task.projectId})`,
      task.assigneeAgent ? `\nAssignee agent: ${task.assigneeAgent.name} (${task.assigneeAgent.id})` : "",
      workspacePath ? `\n**On-disk workspace (API host):** \`${workspacePath}\` — place new files under this tree.` : "",
      prefix ? `\n${prefix}\n` : "",
      `\n## Task\n**Title:** ${task.title}`,
      task.description ? `\n**Description:**\n${task.description}` : "",
      `\n**Execution phase:** ${task.executionPhase ?? 0}`,
      `\nProduce implementation artifacts as described in your system instructions.`,
    ].join("");
    const systemPrompt = composeImplementationSystemPromptForSeat(task.targetRole);
    try {
      markdown = await withProposeBindingFallback(
        task.assigneeAgentId,
        companyId,
        async ({ cred }) =>
          generateCoderMarkdownWithLlm(user, cred, env.OPENAI_API_KEY, {
            systemPrompt,
            cursorLocalPreferredCwd: workspacePath,
          }),
        {
          roleId: task.targetRoleId ?? undefined,
          bindingAudit: { projectId: task.projectId, workflow: "coder.implement" },
        }
      );
      usedLlm = true;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await appendProjectChatMessage({
        projectId: task.projectId,
        actorKind: "orchestrator",
        actorLabel: "Orchestrator",
        body: `Coder LLM failed for "${task.title}": ${msg.slice(0, 1200)}`,
        meta: { event: "coder.run.llm_failure", taskId: task.id, assigneeAgentId: task.assigneeAgentId },
      });
      if (msg.includes("No LLM is configured")) {
        await recordAutonomousOrchestrationStall(task.projectId, env, {
          event: "coder.llm_failure",
          taskId: task.id,
          skippedReason: "no_model_binding",
        }).catch(() => undefined);
        return { ran: false, skippedReason: "no_model_binding" };
      }
      if (msg.includes("Could not resolve LLM credentials")) {
        await recordAutonomousOrchestrationStall(task.projectId, env, {
          event: "coder.llm_failure",
          taskId: task.id,
          skippedReason: "no_credentials",
        }).catch(() => undefined);
        return { ran: false, skippedReason: "no_credentials" };
      }
      await recordAutonomousOrchestrationStall(task.projectId, env, {
        event: "coder.llm_failure",
        taskId: task.id,
        skippedReason: "llm_error",
      }).catch(() => undefined);
      return { ran: false, error: msg };
    }
  }

  const fin = await finalizeCoderOutputToReview({
    taskId,
    body: markdown,
    env,
    workspacePath,
    orchestrationLogger: options?.orchestrationLogger,
  });
  if (!fin.ok) {
    const reason = fin.skippedReason ?? "unknown";
    const detail =
      reason === "no_eligible_reviewer" ?
        "No separate reviewer agent is available — the draft is saved on this task (`blockedReason` set). Assign another reviewer-capable seat on the team or change SDM/PM, then run **Run coder** again."
      : reason === "concurrent_change" ?
        "The task row changed while finalizing — refresh and run **Run coder** once; if LLM timed out twice, fix provider quota or bindings."
      : reason === "invalid_state_missing_assignee" ?
        "Row had **no assignee** when saving —often the board changed mid-run— refresh and retry **Run coder** once."
      : reason === "invalid_state_not_in_progress" ?
        "Row was **not in progress** when saving (often state changed mid-run)— refresh before retry."
      : reason === "invalid_state" ?
        "Task is no longer **in progress** (state changed mid-run)."
      : `finalize step: ${reason}`;
    await appendProjectChatMessage({
      projectId: task.projectId,
      actorKind: "orchestrator",
      actorLabel: "Orchestrator",
      body: `Coder run for "${task.title}" **did not move to review** (${reason}). ${detail}`,
      meta: { event: "coder.run.finalize_skipped", taskId: task.id, reason },
    });
    await recordAutonomousOrchestrationStall(task.projectId, env, {
      event: "coder.finalize_failed",
      taskId: task.id,
      skippedReason: fin.skippedReason ?? "finalize_failed",
    }).catch(() => undefined);
    return {
      ran: true,
      usedLlm,
      submittedToReview: false,
      skippedReason: fin.skippedReason ?? "finalize_failed",
    };
  }

  /** Another finalize won the race legitimately (`already_in_review`) — skip duplicate agent chat and automated-review re-entry. */
  const idempotentAlreadyReview =
    typeof fin.skippedReason === "string" && fin.skippedReason === "already_in_review";

  if (!idempotentAlreadyReview && (env.AGENT_AUTOMATED_REVIEW === "true" || env.AGENT_AUTOMATED_REVIEW_E2E_STUB === "true")) {
    const { runAutomatedReviewAfterCoderSubmit } = await import("./automatedReview.js");
    void runAutomatedReviewAfterCoderSubmit(task.id, env, options?.orchestrationLogger).catch((e) => {
      options?.orchestrationLogger?.info(
        { err: e instanceof Error ? e.message : String(e) },
        "automated_review_after_coder_submit_failed",
      );
    });
  }

  const coderId = task.assigneeAgentId;
  const coderLabel = task.assigneeAgent?.name ?? "Coder";
  if (!idempotentAlreadyReview && coderId) {
    await appendProjectChatMessage({
      projectId: task.projectId,
      actorKind: "agent",
      actorId: coderId,
      actorLabel: coderLabel,
      body: `Completed implementation for "${task.title}" and submitted output for review.`,
      meta: { event: "coder.run.submitted_review", taskId: task.id },
    });
  }

  return { ran: true, usedLlm, submittedToReview: true };
}
