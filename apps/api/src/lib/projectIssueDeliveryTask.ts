import type { Prisma } from "@prisma/client";
import type { FastifyBaseLogger } from "fastify";
import type { Env } from "../config/env.js";
import { prisma } from "./prisma.js";
import { runDeliveryOrchestrationHook } from "./deliveryOrchestration.js";

export type Tx = Omit<
  Prisma.TransactionClient,
  "$connect" | "$disconnect" | "$on" | "$transaction" | "$use" | "$extends"
>;

/** Prefer the deepest active wave so ad-hoc defect work aligns with ongoing delivery. */
export async function resolveAdHocIssueExecutionPhase(tx: Tx, projectId: string): Promise<number> {
  const row = await tx.task.findFirst({
    where: { projectId, state: { not: "done" } },
    orderBy: [{ executionPhase: "desc" }, { id: "desc" }],
    select: { executionPhase: true },
  });
  const phase = typeof row?.executionPhase === "number" ? Math.floor(row.executionPhase) : 0;
  return Math.min(30, Math.max(0, phase));
}

/** One backlog task per Issue when a seat lane is set and the Issue is actionable (open/deferred — not closed at create/update time). */
export function shouldSpinLinkedDeliveryTask(ownerRoleId: string | null, status: string): boolean {
  if (!ownerRoleId) return false;
  const s = status.toLowerCase();
  return s === "open" || s === "deferred";
}

export function linkedIssueBacklogTitle(issueNumber: number, issueTitle: string): string {
  const prefix = `[Issue #${issueNumber}] `;
  const max = 512;
  const rest = issueTitle.trim().slice(0, Math.max(0, max - prefix.length));
  return `${prefix}${rest}`;
}

export function linkedIssueTaskDescription(description: string, issueNumber: number, issuePk: string): string {
  const body = description.trim().length ? description.trim().concat("\n\n") : "";
  return `${body}---\nSarva Issues · #${issueNumber} (${issuePk})`;
}

/** Creates backlog task + FK on issue when eligibility holds; skips if linked task already exists. */
export async function ensureLinkedDeliveryTaskForIssue(tx: Tx, args: {
  issueId: string;
  issueNumber: number;
  issueTitle: string;
  issueDescription: string;
  issueStatus: string;
  linkedTaskId: string | null;
  projectId: string;
  ownerRoleId: string | null;
}): Promise<{ created: boolean }> {
  const {
    issueId,
    issueNumber,
    issueTitle,
    issueDescription,
    issueStatus,
    linkedTaskId,
    projectId,
    ownerRoleId,
  } = args;
  if (linkedTaskId) return { created: false };
  if (!shouldSpinLinkedDeliveryTask(ownerRoleId, issueStatus)) return { created: false };

  const phase = await resolveAdHocIssueExecutionPhase(tx, projectId);

  const task = await tx.task.create({
    data: {
      projectId,
      title: linkedIssueBacklogTitle(issueNumber, issueTitle),
      description: linkedIssueTaskDescription(issueDescription, issueNumber, issueId),
      state: "backlog",
      executionPhase: phase,
      targetRoleId: ownerRoleId!,
      version: 1,
    },
  });

  await tx.projectIssue.update({
    where: { id: issueId },
    data: { linkedTaskId: task.id },
  });

  return { created: true };
}

/** When a linked delivery task completes (`done`), close the originating Issue rows (still Open/Deferred). */
export async function closeLinkedProjectIssuesWhenTaskCompletes(taskId: string): Promise<number> {
  const now = new Date();
  const r = await prisma.projectIssue.updateMany({
    where: {
      linkedTaskId: taskId,
      status: { in: ["open", "deferred"] },
    },
    data: {
      status: "closed",
      closedAt: now,
    },
  });
  return r.count;
}

/** Best-effort: never fail Issue writes if orchestration throws. */
export async function orchestrateProjectAfterIssueTaskChange(
  projectId: string,
  env: Env,
  orchestrationMeta: { source: string },
  logger: FastifyBaseLogger,
): Promise<void> {
  try {
    await runDeliveryOrchestrationHook(projectId, env, orchestrationMeta);
  } catch (e) {
    logger.warn({ err: e, projectId, ...orchestrationMeta }, "delivery orchestration after project issue hook failed");
  }
}
