import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import type { Env } from "../config/env.js";
import { prisma } from "./prisma.js";
import { appendProjectChatMessage } from "./projectChat.js";
import { runCoderAgentForTask } from "./coderAgentRun.js";
import { findPhaseGateBlocking } from "./taskPhaseGate.js";
import { dependencyHasInvalidPhaseOrdering, findUndonePredecessors } from "./taskDependency.js";
import type { PlanningAgent } from "./linkedTeamPlanningAgents.js";
import { pickBestSeatForTask } from "./skillBasedOrchestration.js";
import { loadTeamRoutingSnapshot } from "./deliveryOrchestrationHub.js";
import { reconcilePredecessorPhasesForProject } from "./planGraphReconcile.js";
import { hasExecutionKickoff, resetAutonomousStallCount } from "./deliveryAutonomous.js";
import { maybeSchedulePostCompletionAutoWorkspaceBuild } from "./workspaceBuildVerify.js";
import {
  persistDeliveryOrchestrationPass,
  type OrchestrationTelemetryMeta,
} from "./deliveryOrchestrationTelemetry.js";

export type { OrchestrationTelemetryMeta };
export { deliveryOrchestrationPassSurfacedEffects } from "./deliveryOrchestrationTelemetry.js";

type Tx = Omit<
  Prisma.TransactionClient,
  "$connect" | "$disconnect" | "$on" | "$transaction" | "$use" | "$extends"
>;

/** True after **Begin execution** has run (delivery kickoff recorded on project policy). */
export function deliveryExecutionStarted(deliveryPolicy: unknown): boolean {
  const p = deliveryPolicy as Record<string, unknown> | null;
  return typeof p?.executionKickoffAt === "string";
}

/** Phase P may enter the todo queue when every task in phases &lt; P is `done` (phase 0 is always allowed). */
export async function lowerPhasesAllDone(tx: Tx, projectId: string, phase: number): Promise<boolean> {
  if (phase <= 0) return true;
  const blocking = await tx.task.findFirst({
    where: { projectId, executionPhase: { lt: phase }, state: { not: "done" } },
    select: { id: true },
  });
  return !blocking;
}

/** When a row is already on **todo**, any **backlog** predecessor would otherwise block assigns and auto-start without ever surfacing. Pull those predecessors onto todo first (respecting wave gates — same rule as backlog promotion). */
const MAX_DEPENDENCY_BLOCKS_PROMOTION_PASSES = 64;

/** Promotes **backlog → todo** for every predecessor of tasks already in **todo** when the prerequisite's wave allows it. Repeats to handle chains (grandparent prerequisite before parent before dependent). IDs are deduped. */
async function promoteBacklogBlockingPredecessorsOfTodo(tx: Tx, projectId: string): Promise<string[]> {
  const promotedOrdered: string[] = [];

  for (let iter = 0; iter < MAX_DEPENDENCY_BLOCKS_PROMOTION_PASSES; iter++) {
    const successors = await tx.task.findMany({
      where: { projectId, state: "todo" },
      select: { id: true },
    });

    let anyPromotionThisPass = false;

    for (const s of successors) {
      const predLinks = await tx.taskDependency.findMany({
        where: { successorTaskId: s.id },
        select: { predecessorTaskId: true },
      });
      if (predLinks.length === 0) continue;

      for (const { predecessorTaskId } of predLinks) {
        const p = await tx.task.findUnique({
          where: { id: predecessorTaskId },
          select: {
            id: true,
            projectId: true,
            state: true,
            executionPhase: true,
            version: true,
          },
        });

        if (!p || p.projectId !== projectId || p.state !== "backlog") continue;

        const phase = p.executionPhase ?? 0;
        if (!(await lowerPhasesAllDone(tx, projectId, phase))) continue;

        const up = await tx.task.updateMany({
          where: {
            id: p.id,
            version: p.version,
            state: "backlog",
            projectId,
          },
          data: { state: "todo", version: { increment: 1 } },
        });
        if (up.count === 1) {
          promotedOrdered.push(p.id);
          anyPromotionThisPass = true;
        }
      }
    }

    if (!anyPromotionThisPass) break;
  }

  return [...new Set(promotedOrdered)];
}

/**
 * Moves **backlog → todo** only for tasks whose execution phase is unlocked (all lower phases complete).
 * Keeps later-phase work off the todo board until the prior phase finishes.
 */
export async function promoteEligibleBacklogTasksToTodo(tx: Tx, projectId: string): Promise<string[]> {
  const backlog = await tx.task.findMany({
    where: { projectId, state: "backlog" },
    select: { id: true, version: true, executionPhase: true },
  });
  const promoted: string[] = [];
  for (const t of backlog) {
    const phase = t.executionPhase ?? 0;
    if (!(await lowerPhasesAllDone(tx, projectId, phase))) continue;
    const up = await tx.task.updateMany({
      where: { id: t.id, version: t.version, state: "backlog" },
      data: { state: "todo", version: { increment: 1 } },
    });
    if (up.count > 0) promoted.push(t.id);
  }
  return promoted;
}

/** Fills `assigneeAgentId` (and optional `targetRoleId`) on **todo** rows that pass phase + dependency gates. */
export async function assignUnassignedTodoTasksInTx(
  tx: Tx,
  projectId: string,
  routingAgents: PlanningAgent[]
): Promise<string[]> {
  const rows = await tx.task.findMany({
    where: { projectId, state: "todo", assigneeAgentId: null },
    orderBy: [{ executionPhase: "asc" }, { title: "asc" }],
    select: {
      id: true,
      version: true,
      executionPhase: true,
      targetRoleId: true,
      title: true,
      description: true,
    },
  });
  const assignedIds: string[] = [];
  for (const t of rows) {
    const phase = t.executionPhase ?? 0;
    const blocking = await findPhaseGateBlocking(tx, projectId, phase);
    if (blocking.length > 0) continue;
    const depBlocking = await findUndonePredecessors(tx, t.id);
    if (depBlocking.length > 0) continue;

    let agentId: string | null = null;
    let roleIdFromHeuristic: string | null = null;

    if (t.targetRoleId) {
      const seat = await tx.agentSeat.findFirst({
        where: { roleId: t.targetRoleId, assignedAgentId: { not: null } },
        select: { assignedAgentId: true },
      });
      agentId = seat?.assignedAgentId ?? null;
    }

    if (!agentId && routingAgents.length > 0) {
      const pick = pickBestSeatForTask({ title: t.title, description: t.description }, routingAgents);
      if (pick) {
        agentId = pick.agentId;
        roleIdFromHeuristic = pick.roleId;
      }
    }

    if (!agentId) continue;

    const up = await tx.task.updateMany({
      where: { id: t.id, version: t.version, state: "todo", assigneeAgentId: null },
      data: {
        assigneeAgentId: agentId,
        ...(!t.targetRoleId && roleIdFromHeuristic ? { targetRoleId: roleIdFromHeuristic } : {}),
        version: { increment: 1 },
      },
    });
    if (up.count > 0) assignedIds.push(t.id);
  }
  return assignedIds;
}

/** Starts **todo → in_progress** for assigned tasks that pass phase and predecessor gates. */
export async function autoStartEligibleTodoTasks(tx: Tx, projectId: string): Promise<string[]> {
  const candidates = await tx.task.findMany({
    where: { projectId, state: "todo", assigneeAgentId: { not: null } },
  });
  const startedTaskIds: string[] = [];
  for (const t of candidates) {
    const phase = t.executionPhase ?? 0;
    const blocking = await findPhaseGateBlocking(tx, projectId, phase);
    if (blocking.length > 0) continue;
    const depBlocking = await findUndonePredecessors(tx, t.id);
    if (depBlocking.length > 0) continue;
    const up = await tx.task.updateMany({
      where: { id: t.id, version: t.version, state: "todo" },
      data: { state: "in_progress", version: { increment: 1 } },
    });
    if (up.count > 0) startedTaskIds.push(t.id);
  }
  return startedTaskIds;
}

export async function promoteEligibleAndAutoStartInTx(
  tx: Tx,
  projectId: string,
  options?: { routingAgents?: PlanningAgent[] }
): Promise<{ promotedTaskIds: string[]; assignedTaskIds: string[]; startedTaskIds: string[] }> {
  const pulledFromDeps = await promoteBacklogBlockingPredecessorsOfTodo(tx, projectId);
  const fromPhase = await promoteEligibleBacklogTasksToTodo(tx, projectId);
  const promotedTaskIds = [...new Set([...pulledFromDeps, ...fromPhase])];
  let assignedTaskIds: string[] = [];
  if (options?.routingAgents && options.routingAgents.length > 0) {
    assignedTaskIds = await assignUnassignedTodoTasksInTx(tx, projectId, options.routingAgents);
  }
  const startedTaskIds = await autoStartEligibleTodoTasks(tx, projectId);
  return { promotedTaskIds, assignedTaskIds, startedTaskIds };
}

export async function runParallelCoderRuns(
  taskIds: string[],
  env: Env
): Promise<Awaited<ReturnType<typeof runCoderAgentForTask>>[]> {
  const maxParallel = env.AGENT_CODER_MAX_PARALLEL_RUNS;
  const out: Awaited<ReturnType<typeof runCoderAgentForTask>>[] = new Array(taskIds.length);
  for (let i = 0; i < taskIds.length; i += maxParallel) {
    const batch = taskIds.slice(i, i + maxParallel);
    const batchResults = await Promise.all(
      batch.map(async (tid) => {
        try {
          return await runCoderAgentForTask(tid, env);
        } catch (e) {
          return { ran: false, error: e instanceof Error ? e.message : String(e) };
        }
      })
    );
    for (let j = 0; j < batchResults.length; j++) {
      out[i + j] = batchResults[j]!;
    }
  }
  return out;
}

/** Lightweight board snapshot after promotions / auto-starts / coder completions. */
export async function appendOrchestrationNextRunnableSummary(projectId: string): Promise<void> {
  const [[todoRows, todoUnassigned], wipRows, reviewRows] = await Promise.all([
    Promise.all([
      prisma.task.findMany({
        where: { projectId, state: "todo", assigneeAgentId: { not: null } },
        orderBy: [{ executionPhase: "asc" }, { title: "asc" }],
        take: 12,
        select: {
          id: true,
          title: true,
          executionPhase: true,
          assigneeAgent: { select: { name: true } },
        },
      }),
      prisma.task.count({
        where: { projectId, state: "todo", assigneeAgentId: null },
      }),
    ]),
    prisma.task.findMany({
      where: { projectId, state: "in_progress" },
      orderBy: [{ executionPhase: "asc" }, { title: "asc" }],
      take: 12,
      select: {
        title: true,
        executionPhase: true,
        assigneeAgent: { select: { name: true } },
      },
    }),
    prisma.task.findMany({
      where: { projectId, state: "review" },
      orderBy: [{ title: "asc" }],
      take: 8,
      select: { title: true, assigneeAgent: { select: { name: true } } },
    }),
  ]);

  if (todoRows.length === 0 && todoUnassigned === 0 && wipRows.length === 0 && reviewRows.length === 0) {
    return;
  }

  const lines: string[] = ["**Delivery snapshot — who owns active work**\n"];

  if (wipRows.length > 0) {
    lines.push(`- **In progress** (${wipRows.length}):\n`);
    for (const r of wipRows.slice(0, 10)) {
      const nm = r.assigneeAgent?.name ?? "—";
      lines.push(`  - ${r.title} · phase ${r.executionPhase ?? 0} — **${nm}**\n`);
    }
    if (wipRows.length > 10) lines.push(`  _(+${wipRows.length - 10} more)_\n`);
  }

  if (reviewRows.length > 0) {
    lines.push(`- **In review** (${reviewRows.length}):\n`);
    for (const r of reviewRows.slice(0, 10)) {
      const nm = r.assigneeAgent?.name ?? "—";
      lines.push(`  - ${r.title} — reviewer **${nm}**\n`);
    }
    if (reviewRows.length > 10) lines.push(`  _(+${reviewRows.length - 10} more)_\n`);
  }

  if (todoUnassigned > 0) {
    lines.push(
      `- **Todo (unassigned, ${todoUnassigned})** — link teams with seated agents so orchestration can pick a seat, or assign manually.\n`,
    );
  }

  if (todoRows.length > 0) {
    lines.push(
      `- **Todo (assigned)** (${todoRows.length}) — rows move to **in progress** when phase and predecessor gates pass (orchestration / Run orchestration).\n`,
    );
    const px = prisma as Tx;
    for (const r of todoRows.slice(0, 10)) {
      const nm = r.assigneeAgent?.name ?? "—";
      lines.push(`  - **${r.title}** · phase ${r.executionPhase ?? 0} — **${nm}**\n`);

      const phaseBlocking = await findPhaseGateBlocking(px, projectId, r.executionPhase ?? 0);
      const predBlocking = await findUndonePredecessors(px, r.id);

      if (phaseBlocking.length > 0) {
        const qb = phaseBlocking
          .slice(0, 5)
          .map((x) => `“${x.title}” (phase ${x.executionPhase}, ${x.state})`)
          .join(", ");
        const more =
          phaseBlocking.length > 5 ? ` _(+${phaseBlocking.length - 5} more)_` : "";
        lines.push(`    - **Phase gate:** earlier phases still have work not marked **done** — ${qb}${more}\n`);
      }
      if (predBlocking.length > 0) {
        const succPhaseNum = r.executionPhase ?? 0;
        const predMeta = await prisma.task.findMany({
          where: { id: { in: predBlocking.map((x) => x.id) } },
          select: { title: true, executionPhase: true },
        });
        const phaseInverted = predMeta.some((p) =>
          dependencyHasInvalidPhaseOrdering(p.executionPhase, succPhaseNum)
        );
        const pb = predBlocking
          .slice(0, 5)
          .map((x) => `“${x.title}” (${x.state})`)
          .join(", ");
        const more =
          predBlocking.length > 5 ? ` _(+${predBlocking.length - 5} more)_` : "";
        lines.push(`    - **Predecessors:** dependencies not **done** yet — ${pb}${more}\n`);
        if (phaseInverted) {
          lines.push(
            `    - **Plan mismatch:** at least one undone predecessor sits in a **later execution wave** than this row (` +
              `${succPhaseNum}` +
              `). **Run orchestration** auto-aligns prerequisite waves toward dependents each pass; if you still see this, lower the predecessor wave manually on the Board.\n`,
          );
        }
      }
      if (phaseBlocking.length === 0 && predBlocking.length === 0) {
        lines.push(
          `    - _No blocking phase tasks or undone predecessors recorded — orchestration should be able to start this row._\n`,
        );
      }
    }

    if (todoRows.length > 10) {
      lines.push(`  _(+${todoRows.length - 10} more todo rows omitted)_\n`);
    }
  }

  await appendProjectChatMessage({
    projectId,
    actorKind: "orchestrator",
    actorLabel: "Orchestrator",
    body: lines.join("").trimEnd(),
    meta: { event: "delivery.runnable.summary" },
  });
}

/**
 * After a task completes (or on begin-execution): promote unlocked backlog waves to todo, auto-start eligible
 * assigned work, run coders **in parallel** for newly started implementation tasks. No-op until delivery kickoff exists.
 */
export async function runDeliveryOrchestrationHook(
  projectId: string,
  env: Env,
  meta?: OrchestrationTelemetryMeta
): Promise<{
  promotedTaskIds: string[];
  assignedTaskIds: string[];
  startedTaskIds: string[];
  coderAgentRuns: Awaited<ReturnType<typeof runParallelCoderRuns>>;
}> {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { deliveryPolicy: true },
  });
  if (!project || !deliveryExecutionStarted(project.deliveryPolicy)) {
    return { promotedTaskIds: [], assignedTaskIds: [], startedTaskIds: [], coderAgentRuns: [] };
  }

  const jobId = randomUUID();
  let jobEnded = false;
  const finishTelemetryJob = async (status: "completed" | "failed", extras: {
    error?: string;
    result?: Record<string, number>;
  }) => {
    if (jobEnded) return;
    jobEnded = true;
    await prisma.deliveryAsyncJob.update({
      where: { id: jobId },
      data:
        status === "failed"
          ? {
              status: "failed",
              finishedAt: new Date(),
              error: extras.error?.slice(0, 4000) ?? "orchestration_failed",
            }
          : {
              status: "completed",
              finishedAt: new Date(),
              error: null,
              result: extras.result,
            },
    }).catch(() => undefined);
  };

  await prisma.deliveryAsyncJob.create({
    data: {
      id: jobId,
      projectId,
      kind: "orchestration.pass",
      status: "running",
      correlationId: meta?.correlationId?.trim() || null,
      payload: {
        source: meta?.source?.trim() || "hook",
      },
    },
  });

  let promotedTaskIds: string[] = [];
  let assignedTaskIds: string[] = [];
  let startedTaskIds: string[] = [];
  let coderAgentRuns: Awaited<ReturnType<typeof runParallelCoderRuns>> = [];

  try {
    /** Planner/PM graphs can violate “predecessor wave ≤ successor wave”; promotion then deadlocks even with dependency-pull. Align waves before backlog → todo promotion. */
    const reconcileOut = await reconcilePredecessorPhasesForProject(projectId, { silent: true });

    const snapshot = await loadTeamRoutingSnapshot(projectId);
    const txOut = await prisma.$transaction(async (tx) =>
      promoteEligibleAndAutoStartInTx(tx, projectId, { routingAgents: snapshot.agents })
    );
    promotedTaskIds = txOut.promotedTaskIds;
    assignedTaskIds = txOut.assignedTaskIds;
    startedTaskIds = txOut.startedTaskIds;

    if (reconcileOut.adjustedTaskIds.length > 0) {
      await appendProjectChatMessage({
        projectId,
        actorKind: "orchestrator",
        actorLabel: "Orchestrator",
        body:
          `**Orchestration:** aligned prerequisite **execution waves** for **${reconcileOut.adjustedTaskIds.length}** task(s) so every predecessor stays in wave **≤** its dependents — then continuing backlog → todo promotion and assigns.`,
        meta: { event: "delivery.orchestration.reconcile_phases", taskIds: reconcileOut.adjustedTaskIds },
      });
    }

    if (assignedTaskIds.length > 0) {
      await appendProjectChatMessage({
        projectId,
        actorKind: "orchestrator",
        actorLabel: "Orchestrator",
        body: `Orchestration assigned **${assignedTaskIds.length}** todo task(s) that had no assignee (seat on **targetRole** when set, otherwise the same skill heuristic as board planning). Only tasks with clear phase and predecessor gates were eligible.`,
        meta: { event: "delivery.auto_assign_todo", taskIds: assignedTaskIds },
      });
    }

    if (promotedTaskIds.length > 0) {
      const phases = await prisma.task.findMany({
        where: { id: { in: promotedTaskIds } },
        select: { executionPhase: true },
      });
      const minPhase = Math.min(...phases.map((p) => p.executionPhase ?? 0));
      await appendProjectChatMessage({
        projectId,
        actorKind: "orchestrator",
        actorLabel: "Orchestrator",
        body: `Unlocked delivery work at phase **${minPhase}**: **${promotedTaskIds.length}** task(s) moved from backlog to todo (lower phases complete).`,
        meta: { event: "delivery.phase_promote", taskIds: promotedTaskIds, minPhase },
      });
    }

    coderAgentRuns =
      startedTaskIds.length > 0 ? await runParallelCoderRuns(startedTaskIds, env) : [];

    const summarized =
      reconcileOut.adjustedTaskIds.length > 0 ||
      promotedTaskIds.length > 0 ||
      assignedTaskIds.length > 0 ||
      startedTaskIds.length > 0 ||
      coderAgentRuns.some((r) => r.submittedToReview || Boolean(r?.ran));

    if (summarized) {
      await appendOrchestrationNextRunnableSummary(projectId);
    }

    /** Delivery complete — stall meter is only meaningful while work remains; clear so Board does not stay in “operator” mode. */
    const remainingNotDone = await prisma.task.count({
      where: { projectId, state: { not: "done" } },
    });
    if (remainingNotDone === 0) {
      const p = await prisma.project.findUnique({
        where: { id: projectId },
        select: { deliveryPolicy: true },
      });
      if (p && hasExecutionKickoff(p.deliveryPolicy)) {
        await resetAutonomousStallCount(projectId);
        maybeSchedulePostCompletionAutoWorkspaceBuild(projectId, env);
      }
    }

    await persistDeliveryOrchestrationPass(
      projectId,
      { promotedTaskIds, assignedTaskIds, startedTaskIds, coderAgentRuns },
      meta
    ).catch(() => undefined);

    await finishTelemetryJob("completed", {
      result: {
        promotedCount: promotedTaskIds.length,
        assignedCount: assignedTaskIds.length,
        startedCount: startedTaskIds.length,
        coderBatchSize: coderAgentRuns.length,
        coderErrors: coderAgentRuns.filter((r) => Boolean(r?.error)).length,
      },
    });

    return { promotedTaskIds, assignedTaskIds, startedTaskIds, coderAgentRuns };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await finishTelemetryJob("failed", { error: msg.slice(0, 4000) });
    throw e;
  }
}
