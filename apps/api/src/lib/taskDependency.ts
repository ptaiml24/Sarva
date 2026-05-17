import type { Prisma } from "@prisma/client";

type Tx = Omit<
  Prisma.TransactionClient,
  "$connect" | "$disconnect" | "$on" | "$transaction" | "$use" | "$extends"
>;

export type TaskDependencyEdge = { successorTaskId: string; predecessorTaskId: string };

/** Build predecessor → successor adjacency (completion order: finish pred before succ). */
function predecessorToSuccessors(edges: TaskDependencyEdge[]): Map<string, string[]> {
  const adj = new Map<string, string[]>();
  for (const { successorTaskId: s, predecessorTaskId: p } of edges) {
    if (!adj.has(p)) adj.set(p, []);
    adj.get(p)!.push(s);
  }
  return adj;
}

/** True if adding these edges to a DAG would introduce a directed cycle (pred must precede succ). */
export function dependencyEdgesHaveCycle(edges: TaskDependencyEdge[]): boolean {
  const adj = predecessorToSuccessors(edges);
  const visiting = new Set<string>();
  const done = new Set<string>();

  function visit(u: string): boolean {
    if (done.has(u)) return false;
    if (visiting.has(u)) return true;
    visiting.add(u);
    for (const v of adj.get(u) ?? []) {
      if (visit(v)) return true;
    }
    visiting.delete(u);
    done.add(u);
    return false;
  }

  const nodes = new Set<string>();
  for (const e of edges) {
    nodes.add(e.predecessorTaskId);
    nodes.add(e.successorTaskId);
  }
  for (const n of nodes) {
    if (visit(n)) return true;
  }
  return false;
}

/**
 * Dependencies mean "finish predecessor before successor." A predecessor scheduled in a **later**
 * execution phase than its successor guarantees a deadlock with Sarva gates (later wave is not promoted/done earlier).
 */
export function dependencyHasInvalidPhaseOrdering(
  predecessorExecutionPhase: number | null | undefined,
  successorExecutionPhase: number | null | undefined,
): boolean {
  const p = predecessorExecutionPhase ?? 0;
  const s = successorExecutionPhase ?? 0;
  return p > s;
}

/** Predecessors of `successorTaskId` that are not yet `done` (blocks claim / auto-start). */
export async function findUndonePredecessors(
  tx: Tx,
  successorTaskId: string
): Promise<{ id: string; title: string; state: string }[]> {
  const deps = await tx.taskDependency.findMany({
    where: { successorTaskId },
    select: { predecessorTaskId: true },
  });
  if (deps.length === 0) return [];
  const ids = deps.map((d) => d.predecessorTaskId);
  return tx.task.findMany({
    where: { id: { in: ids }, state: { not: "done" } },
    select: { id: true, title: true, state: true },
    take: 30,
  });
}
