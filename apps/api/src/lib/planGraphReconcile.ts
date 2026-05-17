import { prisma } from "./prisma.js";
import { appendProjectChatMessage } from "./projectChat.js";

const MAX_PHASE_RECONCILE_PASSES = 32;

/**
 * For every dependency edge, the predecessor's execution wave must be **≤** the successor's
 * wave. If planner/PM data violates that (deadlock), lower the prerequisite wave to the tightest successor bound.
 *
 * Runs in a transaction; repeats until stable or iteration cap.
 */
export async function reconcilePredecessorPhasesForProject(
  projectId: string,
  options?: { silent?: boolean }
): Promise<{ adjustedTaskIds: string[] }> {
  const adjustedOrdered: string[] = [];

  await prisma.$transaction(async (tx) => {
    for (let iter = 0; iter < MAX_PHASE_RECONCILE_PASSES; iter++) {
      const edges = await tx.taskDependency.findMany({
        where: { successor: { projectId } },
        select: { predecessorTaskId: true, successorTaskId: true },
      });

      if (edges.length === 0) break;

      const ids = new Set<string>();
      for (const e of edges) {
        ids.add(e.predecessorTaskId);
        ids.add(e.successorTaskId);
      }

      const taskRows = await tx.task.findMany({
        where: { id: { in: [...ids] }, projectId },
        select: { id: true, version: true, executionPhase: true },
      });
      const byId = new Map(taskRows.map((t) => [t.id, t]));

      const predsToMinSuccPhase = new Map<string, number>();

      for (const e of edges) {
        const pred = byId.get(e.predecessorTaskId);
        const succ = byId.get(e.successorTaskId);
        if (!pred || !succ) continue;

        const pp = pred.executionPhase ?? 0;
        const sp = succ.executionPhase ?? 0;

        if (pp <= sp) continue;

        const prev = predsToMinSuccPhase.get(pred.id);
        if (prev === undefined || sp < prev) predsToMinSuccPhase.set(pred.id, sp);
      }

      if (predsToMinSuccPhase.size === 0) break;

      let anyUpdated = false;

      for (const [pid, targetPhase] of predsToMinSuccPhase) {
        const row = byId.get(pid);
        if (!row) continue;
        if ((row.executionPhase ?? 0) <= targetPhase) continue;

        const res = await tx.task.updateMany({
          where: { id: pid, version: row.version, projectId },
          data: {
            executionPhase: targetPhase,
            version: { increment: 1 },
          },
        });

        if (res.count === 1) {
          anyUpdated = true;
          adjustedOrdered.push(pid);
        }
      }

      if (!anyUpdated) break;
    }
  });

  const unique = [...new Set(adjustedOrdered)];

  if (!options?.silent && unique.length > 0) {
    await appendProjectChatMessage({
      projectId,
      actorKind: "orchestrator",
      actorLabel: "Orchestrator",
      body:
        `**Plan graph reconcile:** execution waves lowered on **${unique.length}** prerequisite task(s) so each predecessor stays in phase **≤** every dependent (fixes phase ↔ dependency deadlock). Use **Run orchestration** afterward.`,
      meta: { event: "delivery.plan_graph.reconcile_phases", taskIds: unique },
    });
  }

  return { adjustedTaskIds: unique };
}
