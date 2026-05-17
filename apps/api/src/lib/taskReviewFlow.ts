import type { Env } from "../config/env.js";
import { prisma } from "./prisma.js";
import { appendProjectChatMessage } from "./projectChat.js";
import { buildReviewHandoffMarkdown } from "../integrations/reviewHandoffLlm.js";
import { findReviewerAgentId, findSdmOrPmAgentId } from "./reviewerAssignment.js";
import { runDeliveryOrchestrationHook } from "./deliveryOrchestration.js";
import type { OrchestrationLogTarget } from "./deliveryOrchestrationHub.js";
import { TASK_REVIEW_MAX_REVISIONS } from "./errors.js";
import { recordAutonomousOrchestrationStall } from "./deliveryAutonomous.js";
import { closeLinkedProjectIssuesWhenTaskCompletes } from "./projectIssueDeliveryTask.js";

const MAX_BODY = 120_000;

function truncateBody(text: string): string {
  return text.length > MAX_BODY ? `${text.slice(0, MAX_BODY)}\n\n…(truncated)` : text;
}

function appendReviewFeedback(description: string | null, notes: string): string {
  const sep = "\n\n---\n**Review feedback:**\n";
  const base = description?.trim() ?? "";
  return base ? `${base}${sep}${notes}` : `${sep.replace("\n\n", "\n")}${notes}`;
}

const NO_REVIEWER_BLOCKED_REASON =
  "No eligible code reviewer: all routing options would assign the same agent as the implementer (no self-review), " +
  "or no other seated agent had review-relevant skills. " +
  "Link another agent to a team on this project—prefer a seat with the CODE_REVIEWER skill—or set SDM/PM to a different agent, then run the coder again.";

/**
 * After a successful coder LLM run: move task to **review**, stash **implementing** agent, assign **reviewer**
 * (skill-scored `code_review` seat → SDM → PM). Does **not** fall back to implementer; saves draft and sets `blockedReason` instead.
 */
export async function finalizeCoderOutputToReview(params: {
  taskId: string;
  body: string;
  env: Env;
  workspacePath: string | null;
  orchestrationLogger?: OrchestrationLogTarget;
}): Promise<{ ok: boolean; skippedReason?: string }> {
  const body = truncateBody(params.body);

  const plan = await prisma.$transaction(async (tx) => {
    const latest = await tx.task.findUnique({
      where: { id: params.taskId },
      include: { assigneeAgent: { select: { id: true, name: true } } },
    });
    if (!latest) {
      return { type: "skip" as const, reason: "task_not_found" };
    }
    /** Duplicate `runCoderAgentForTask` completions can race — first writer wins toward review; second must no-op cleanly. */
    if (latest.state === "review") {
      return { type: "skip" as const, reason: "already_in_review" };
    }
    if (!latest.assigneeAgentId) {
      return { type: "skip" as const, reason: "invalid_state_missing_assignee" };
    }
    if (latest.state !== "in_progress") {
      return { type: "skip" as const, reason: "invalid_state_not_in_progress" };
    }

    const implementerId = latest.assigneeAgentId;
    const implementerName = latest.assigneeAgent?.name ?? implementerId;

    let reviewerId = await findReviewerAgentId(latest.projectId, implementerId, {
      logger: params.orchestrationLogger,
    });
    if (!reviewerId) {
      reviewerId = await findSdmOrPmAgentId(latest.projectId, implementerId);
    }

    if (!reviewerId) {
      const up = await tx.task.updateMany({
        where: { id: params.taskId, version: latest.version, state: "in_progress" },
        data: {
          agentGeneratedBody: body,
          agentGeneratedAt: new Date(),
          blockedReason: NO_REVIEWER_BLOCKED_REASON,
          version: { increment: 1 },
        },
      });
      if (up.count === 0) {
        return { type: "skip" as const, reason: "concurrent_change" };
      }
      return {
        type: "blocked" as const,
        projectId: latest.projectId,
        taskTitle: latest.title,
        implementerName,
      };
    }

    const reviewerRow = await tx.agent.findUnique({ where: { id: reviewerId }, select: { name: true } });
    const reviewerName = reviewerRow?.name ?? reviewerId;

    return {
      type: "ready" as const,
      latestVersion: latest.version,
      projectId: latest.projectId,
      taskTitle: latest.title,
      implementerId,
      implementerName,
      reviewerId,
      reviewerName,
    };
  });

  if (plan.type === "skip") {
    if (plan.reason === "already_in_review") {
      return { ok: true, skippedReason: "already_in_review" };
    }
    return { ok: false, skippedReason: plan.reason };
  }

  if (plan.type === "blocked") {
    await appendProjectChatMessage({
      projectId: plan.projectId,
      actorKind: "orchestrator",
      actorLabel: "Orchestrator",
      body: `Cannot move **${plan.taskTitle}** to code review: no reviewer is available who is distinct from implementer **${plan.implementerName}**. Implementation draft is saved on the task—fix team/seat assignments, then run the coder again.`,
      meta: { event: "review.route.blocked", taskId: params.taskId, reason: "no_eligible_reviewer" },
    });
    return { ok: false, skippedReason: "no_eligible_reviewer" };
  }

  /**
   * Review handoff LLM can take minutes. It must not run inside `prisma.$transaction` — interactive tx timeouts
   * (default ~5s) surface as 500s after an otherwise successful coder run.
   */
  const handoff = await buildReviewHandoffMarkdown(
    plan.projectId,
    {
      taskTitle: plan.taskTitle,
      implementerName: plan.implementerName,
      reviewerName: plan.reviewerName,
      workspacePath: params.workspacePath,
      coderExcerpt: body.slice(0, 16_000),
    },
    params.env
  );

  const updated = await prisma.$transaction(async (tx) => {
    const up = await tx.task.updateMany({
      where: { id: params.taskId, version: plan.latestVersion, state: "in_progress" },
      data: {
        agentGeneratedBody: body,
        agentGeneratedAt: new Date(),
        implementingAgentId: plan.implementerId,
        assigneeAgentId: plan.reviewerId,
        reviewHandoffMarkdown: handoff.markdown,
        state: "review",
        blockedReason: null,
        version: { increment: 1 },
      },
    });
    return up.count > 0;
  });

  if (!updated) {
    return { ok: false, skippedReason: "concurrent_change" };
  }

  await appendProjectChatMessage({
    projectId: plan.projectId,
    actorKind: "orchestrator",
    actorLabel: "Orchestrator",
    body: `**${plan.taskTitle}** is ready for code review. Assignee set to **${plan.reviewerName}** (implementer **${plan.implementerName}** cannot self-review).`,
    meta: {
      event: "review.routed",
      taskId: params.taskId,
      reviewerId: plan.reviewerId,
      implementerName: plan.implementerName,
    },
  });

  return { ok: true };
}

/** Max revision bounces enforced when caller passes env (routes); otherwise practically unlimited for legacy callers. */
function revisionCapThreshold(env?: Env): number | null {
  if (!env) return null;
  return env.AGENT_AUTOMATED_REVIEW_MAX_ROUNDS;
}

export async function applyReviewVerdict(params: {
  taskId: string;
  expectedVersion: number;
  verdict: "approve" | "request_changes";
  notes?: string;
  /** When set and verdict is approve, runs phase promotion + parallel auto-coder for the project. Also supplies revision cap threshold for request_changes. */
  env?: Env;
}): Promise<{ ok: boolean; skippedReason?: string; appliedVerdict?: "approve" | "request_changes" }> {
  const task = await prisma.task.findUnique({
    where: { id: params.taskId },
    include: {
      assigneeAgent: { select: { id: true, name: true } },
      implementingAgent: { select: { id: true, name: true } },
    },
  });
  if (!task || task.state !== "review") {
    return { ok: false, skippedReason: "not_in_review" };
  }
  if (task.version !== params.expectedVersion) {
    return { ok: false, skippedReason: "version_conflict" };
  }

  const reviewerId = task.assigneeAgentId;
  const reviewerLabel = task.assigneeAgent?.name ?? "Reviewer";

  if (params.verdict === "approve") {
    const up = await prisma.task.updateMany({
      where: { id: params.taskId, version: params.expectedVersion, state: "review" },
      data: {
        state: "done",
        reviewRevisionCount: 0,
        version: { increment: 1 },
        ...(params.notes?.trim() ? { description: appendReviewFeedback(task.description, params.notes.trim()) } : {}),
      },
    });
    if (up.count === 0) {
      return { ok: false, skippedReason: "concurrent_change" };
    }
    await closeLinkedProjectIssuesWhenTaskCompletes(params.taskId);
    if (reviewerId) {
      const note = params.notes?.trim();
      await appendProjectChatMessage({
        projectId: task.projectId,
        actorKind: "agent",
        actorId: reviewerId,
        actorLabel: reviewerLabel,
        body: note ?
          `Approved **${task.title}** (moved to done). Notes: ${note}`
        : `Approved **${task.title}** (moved to done).`,
        meta: { event: "task.review.approve", taskId: params.taskId },
      });
    }
    if (params.env) {
      await runDeliveryOrchestrationHook(task.projectId, params.env);
    }
    return { ok: true, appliedVerdict: "approve" };
  }

  const cap = revisionCapThreshold(params.env);
  if (cap !== null && task.reviewRevisionCount >= cap) {
    if (params.env) {
      await recordAutonomousOrchestrationStall(task.projectId, params.env, {
        event: "review.max_revision_batches",
        taskId: params.taskId,
      }).catch(() => undefined);
    }
    return {
      ok: false,
      skippedReason: TASK_REVIEW_MAX_REVISIONS,
    };
  }

  const backTo = task.implementingAgentId ?? task.assigneeAgentId;
  const implementerName = task.implementingAgent?.name ?? backTo ?? "implementer";
  const desc =
    params.notes?.trim() ?
      appendReviewFeedback(task.description, params.notes.trim())
    : task.description;

  const up = await prisma.task.updateMany({
    where: { id: params.taskId, version: params.expectedVersion, state: "review" },
    data: {
      state: "in_progress",
      assigneeAgentId: backTo,
      description: desc,
      reviewRevisionCount: { increment: 1 },
      version: { increment: 1 },
    },
  });
  if (up.count === 0) {
    return { ok: false, skippedReason: "concurrent_change" };
  }
  if (reviewerId) {
    const note = params.notes?.trim();
    await appendProjectChatMessage({
      projectId: task.projectId,
      actorKind: "agent",
      actorId: reviewerId,
      actorLabel: reviewerLabel,
      body: note ?
        `Requested changes on **${task.title}**. ${note} Work returned to **${implementerName}** for implementation.`
      : `Requested changes on **${task.title}**. Work returned to **${implementerName}** for implementation.`,
      meta: { event: "task.review.request_changes", taskId: params.taskId, implementerAgentId: backTo ?? null },
    });
  }

  return { ok: true, appliedVerdict: "request_changes" };
}
