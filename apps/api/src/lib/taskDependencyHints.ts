import { Prisma } from "@prisma/client";
import { parseDependsOnTitlesField } from "./backlogDependencyTitles.js";
import { dependencyEdgesHaveCycle, dependencyHasInvalidPhaseOrdering, type TaskDependencyEdge } from "./taskDependency.js";

type Tx = Omit<
  Prisma.TransactionClient,
  "$connect" | "$disconnect" | "$on" | "$transaction" | "$use" | "$extends"
>;

/** Case- and whitespace-normalized key for matching proposal titles to task titles. */
export function normalizeDependencyTitleKey(title: string): string {
  return title.trim().toLowerCase().replace(/\s+/g, " ");
}

function dependsOnTitlesFromHintsJson(raw: Prisma.JsonValue | null | undefined): string[] {
  if (raw === null || raw === undefined) return [];
  if (typeof raw !== "object" || Array.isArray(raw)) return [];
  const o = raw as Record<string, unknown>;
  return parseDependsOnTitlesField(o.dependsOnTitles);
}

/**
 * After creating a task (e.g. from draft accept), link predecessors by title and clear resolved hints.
 * Safe if accept order differs from PM proposal order.
 */
export async function resolveDependencyHintsAfterTaskCreate(tx: Tx, projectId: string, newTaskId: string): Promise<void> {
  const newTask = await tx.task.findFirst({
    where: { id: newTaskId, projectId },
    select: { id: true, title: true, dependencyHints: true },
  });
  if (!newTask) return;

  let edges: TaskDependencyEdge[] = await tx.taskDependency.findMany({
    where: { successor: { projectId }, predecessor: { projectId } },
    select: { successorTaskId: true, predecessorTaskId: true },
  });

  const tryAdd = async (successorTaskId: string, predecessorTaskId: string): Promise<boolean> => {
    if (successorTaskId === predecessorTaskId) return false;
    if (edges.some((e) => e.successorTaskId === successorTaskId && e.predecessorTaskId === predecessorTaskId)) {
      return true;
    }
    const [succRow, predRow] = await Promise.all([
      tx.task.findUnique({ where: { id: successorTaskId }, select: { executionPhase: true } }),
      tx.task.findUnique({ where: { id: predecessorTaskId }, select: { executionPhase: true } }),
    ]);
    if (!succRow || !predRow) return false;
    if (dependencyHasInvalidPhaseOrdering(predRow.executionPhase, succRow.executionPhase)) return false;

    const next = [...edges, { successorTaskId, predecessorTaskId }];
    if (dependencyEdgesHaveCycle(next)) return false;
    await tx.taskDependency.create({ data: { successorTaskId, predecessorTaskId } });
    edges = next;
    return true;
  };

  const allTasks = await tx.task.findMany({
    where: { projectId },
    select: { id: true, title: true, dependencyHints: true },
  });

  const titleToFirstId = new Map<string, string>();
  for (const t of allTasks) {
    const k = normalizeDependencyTitleKey(t.title);
    if (!titleToFirstId.has(k)) titleToFirstId.set(k, t.id);
  }

  const hintsOnNew = dependsOnTitlesFromHintsJson(newTask.dependencyHints);
  const stillUnresolved: string[] = [];
  for (const ht of hintsOnNew) {
    const predId = titleToFirstId.get(normalizeDependencyTitleKey(ht));
    if (predId && predId !== newTask.id) {
      const added = await tryAdd(newTask.id, predId);
      if (!added) stillUnresolved.push(ht);
    } else {
      stillUnresolved.push(ht);
    }
  }

  await tx.task.update({
    where: { id: newTask.id },
    data: {
      dependencyHints:
        stillUnresolved.length > 0 ? ({ dependsOnTitles: stillUnresolved } satisfies Prisma.InputJsonValue) : Prisma.DbNull,
    },
  });

  const newKey = normalizeDependencyTitleKey(newTask.title);
  for (const t of allTasks) {
    if (t.id === newTask.id) continue;
    const th = dependsOnTitlesFromHintsJson(t.dependencyHints);
    if (th.length === 0) continue;
    const remaining: string[] = [];
    for (const ht of th) {
      if (normalizeDependencyTitleKey(ht) === newKey) {
        const added = await tryAdd(t.id, newTask.id);
        if (!added) remaining.push(ht);
      } else {
        remaining.push(ht);
      }
    }
    if (remaining.length !== th.length) {
      await tx.task.update({
        where: { id: t.id },
        data: {
          dependencyHints:
            remaining.length > 0 ? ({ dependsOnTitles: remaining } satisfies Prisma.InputJsonValue) : Prisma.DbNull,
        },
      });
    }
  }
}
