import type { Env } from "../config/env.js";
import { appendProjectChatMessage } from "./projectChat.js";
import { prisma } from "./prisma.js";
import { applyReviewVerdict } from "./taskReviewFlow.js";
import { runCoderAgentForTask } from "./coderAgentRun.js";
import { recordAutonomousOrchestrationStall } from "./deliveryAutonomous.js";
import { loadTaskForAutomatedReview, proposeAutomatedReviewVerdict } from "../integrations/reviewVerdictLlm.js";
import type { OrchestrationLogTarget } from "./deliveryOrchestrationHub.js";

function logAutomationFailure(log: OrchestrationLogTarget | undefined, err: unknown, msg: string) {
  const text = err instanceof Error ? err.message : String(err);
  log?.info({ err: text }, msg);
}

/**
 * Runs after a coder run lands the row in **review**: optional reviewer LLM approves or bounces for fixes,
 * dispatching the coder again recursively until approve, cap, or failure.
 */
export async function runAutomatedReviewAfterCoderSubmit(
  taskId: string,
  env: Env,
  log?: OrchestrationLogTarget
): Promise<void> {
  if (env.AGENT_AUTOMATED_REVIEW !== "true" && env.AGENT_AUTOMATED_REVIEW_E2E_STUB !== "true") {
    return;
  }

  const task = await loadTaskForAutomatedReview(taskId);
  if (!task || task.state !== "review") return;

  const max = env.AGENT_AUTOMATED_REVIEW_MAX_ROUNDS;

  let proposed: Awaited<ReturnType<typeof proposeAutomatedReviewVerdict>>;
  try {
    proposed = await proposeAutomatedReviewVerdict(
      task.projectId,
      task.assigneeAgentId,
      {
        taskTitle: task.title,
        description: task.description,
        reviewHandoffMarkdown: task.reviewHandoffMarkdown,
        coderDraft: task.agentGeneratedBody,
        reviewRevisionCount: task.reviewRevisionCount,
      },
      env
    );
  } catch (e) {
    logAutomationFailure(log, e, "automated_review_verdict_failed");
    await appendProjectChatMessage({
      projectId: task.projectId,
      actorKind: "orchestrator",
      actorLabel: "Orchestrator",
      body: `Automated review step failed on **${task.title}**: ${String(e).slice(0, 1200)}. Task stays in review for human action.`,
      meta: { event: "review.auto.llm_failure", taskId },
    });
    await recordAutonomousOrchestrationStall(task.projectId, env, {
      event: "review.auto.propose_failure",
      taskId,
      err: String(e).slice(0, 240),
    }).catch(() => undefined);
    return;
  }

  if (!proposed) {
    await appendProjectChatMessage({
      projectId: task.projectId,
      actorKind: "orchestrator",
      actorLabel: "Orchestrator",
      body:
        `**${task.title}** skipped automated verdict (no reviewer model binding). ` +
        `Approve or request changes from the board when ready.`,
      meta: { event: "review.auto.no_binding", taskId },
    });
    await recordAutonomousOrchestrationStall(task.projectId, env, {
      event: "review.auto.no_review_binding",
      taskId,
    }).catch(() => undefined);
    return;
  }

  if (proposed.verdict === "approve") {
    const r = await applyReviewVerdict({
      taskId,
      expectedVersion: task.version,
      verdict: "approve",
      notes: proposed.notes,
      env,
    });
    if (!r.ok) {
      await appendProjectChatMessage({
        projectId: task.projectId,
        actorKind: "orchestrator",
        actorLabel: "Orchestrator",
        body: `Automated approve for **${task.title}** did not apply (${r.skippedReason ?? "unknown"}). Refresh the board.`,
        meta: { event: "review.auto.approve_failed", taskId },
      });
      await recordAutonomousOrchestrationStall(task.projectId, env, {
        event: "review.auto.approve_conflict",
        taskId,
        skippedReason: r.skippedReason,
      }).catch(() => undefined);
    }
    return;
  }

  if (task.reviewRevisionCount >= max) {
    await appendProjectChatMessage({
      projectId: task.projectId,
      actorKind: "orchestrator",
      actorLabel: "Orchestrator",
      body:
        `Automated reviewer asks for further changes but **${task.title}** already used **${max}** revision round(s). ` +
        `Complete review manually (**Approve** or **Request changes**).`,
      meta: { event: "review.auto.cap_blocks_request_changes", taskId },
    });
    await recordAutonomousOrchestrationStall(task.projectId, env, {
      event: "review.auto.revision_cap_blocked",
      taskId,
      reviewRevisionCount: task.reviewRevisionCount,
    }).catch(() => undefined);
    return;
  }

  const req = await applyReviewVerdict({
    taskId,
    expectedVersion: task.version,
    verdict: "request_changes",
    notes: proposed.notes,
    env,
  });
  if (!req.ok) {
    await appendProjectChatMessage({
      projectId: task.projectId,
      actorKind: "orchestrator",
      actorLabel: "Orchestrator",
      body: `Automated reviewer could not bounce **${task.title}**: ${req.skippedReason ?? "unknown"}. Refresh and act from the board.`,
      meta: { event: "review.auto.request_changes_failed", taskId },
    });
    await recordAutonomousOrchestrationStall(task.projectId, env, {
      event: "review.auto.request_changes_rejected",
      taskId,
      skippedReason: req.skippedReason,
    }).catch(() => undefined);
    return;
  }

  /** Ensure the bounce is visible before the chained coder reconnects (`runCoderAgentForTask` rejects non–in-progress rows). */
  const reopened = await prisma.task.findUnique({
    where: { id: taskId },
    select: { state: true, assigneeAgentId: true, version: true },
  });
  if (!reopened || reopened.state !== "in_progress" || !reopened.assigneeAgentId) {
    await appendProjectChatMessage({
      projectId: task.projectId,
      actorKind: "orchestrator",
      actorLabel: "Orchestrator",
      body:
        `Automated review wrote **requested changes** for **${task.title}**, but the row did not reopen for the implementer ` +
        `(seen state=${reopened?.state ?? "missing"}, assignee=${reopened?.assigneeAgentId ? "set" : "empty"}). **Refresh** the Board; ` +
        `coder follow-up skipped until the row is **in progress** with an assignee.`,
      meta: { event: "review.auto.request_changes_reopen_miss", taskId },
    });
    await recordAutonomousOrchestrationStall(task.projectId, env, {
      event: "review.auto.bounce_visibility_miss",
      taskId,
      state: reopened?.state,
    }).catch(() => undefined);
    return;
  }

  if (env.AGENT_CODER_ON_REVIEW_FEEDBACK !== "true") {
    await appendProjectChatMessage({
      projectId: task.projectId,
      actorKind: "orchestrator",
      actorLabel: "Orchestrator",
      body: `Automated reviewer requested changes on **${task.title}** but coder auto-follow-up is disabled — use **Run coder** (advanced) on the board.`,
      meta: { event: "review.auto.coder_followup_disabled", taskId },
    });
    await recordAutonomousOrchestrationStall(task.projectId, env, {
      event: "review.auto.followup_disabled",
      taskId,
    }).catch(() => undefined);
    return;
  }

  await appendProjectChatMessage({
    projectId: task.projectId,
    actorKind: "orchestrator",
    actorLabel: "Orchestrator",
    body: `Automated reviewer requested revisions on **${task.title}**; dispatcher is re-running the coder now.`,
    meta: { event: "review.auto.dispatch_coder", taskId },
  });

  try {
    const run = await runCoderAgentForTask(taskId, env, { orchestrationLogger: log });
    if (!run.submittedToReview) {
      return;
    }
  } catch (e) {
    logAutomationFailure(log, e, "automated_review_coder_chain_failed");
    await recordAutonomousOrchestrationStall(task.projectId, env, {
      event: "review.auto.coder_chain_exception",
      taskId,
      err: String(e).slice(0, 240),
    }).catch(() => undefined);
    return;
  }

  await runAutomatedReviewAfterCoderSubmit(taskId, env, log);
}
