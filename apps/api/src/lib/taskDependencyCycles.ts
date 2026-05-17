import { prisma } from "./prisma.js";

enum DfsColor {
  White = 0,
  Gray = 1,
  Black = 2,
}

/**
 * Task dependencies are directed: predecessor finishes before successor.
 * Reports simple cycles among tasks in `projectId` (deadlocks for finish-to-start ordering).
 */
export async function findTaskDependencyCyclesForProject(projectId: string): Promise<string[][]> {
  const deps = await prisma.taskDependency.findMany({
    where: {
      successor: { projectId },
      predecessor: { projectId },
    },
    select: { predecessorTaskId: true, successorTaskId: true },
  });

  const adj = new Map<string, string[]>();
  const vertices = new Set<string>();
  for (const d of deps) {
    vertices.add(d.predecessorTaskId);
    vertices.add(d.successorTaskId);
    const list = adj.get(d.predecessorTaskId);
    if (list) list.push(d.successorTaskId);
    else adj.set(d.predecessorTaskId, [d.successorTaskId]);
  }

  const color = new Map<string, DfsColor>();
  const cycles: string[][] = [];

  function dfs(node: string, stack: string[]) {
    color.set(node, DfsColor.Gray);
    stack.push(node);
    for (const nxt of adj.get(node) ?? []) {
      const st = color.get(nxt) ?? DfsColor.White;
      if (st === DfsColor.Gray) {
        const ix = stack.indexOf(nxt);
        if (ix >= 0) cycles.push([...stack.slice(ix)]);
      } else if (st === DfsColor.White) {
        dfs(nxt, stack);
      }
    }
    stack.pop();
    color.set(node, DfsColor.Black);
  }

  for (const v of vertices) {
    if ((color.get(v) ?? DfsColor.White) === DfsColor.White) dfs(v, []);
  }

  return dedupeCyclesLex(cycles);
}

function dedupeCyclesLex(cycles: string[][]): string[][] {
  const seen = new Set<string>();
  const out: string[][] = [];
  for (const c of cycles) {
    const k = canonicalCycleSignature(c);
    if (!seen.has(k)) {
      seen.add(k);
      out.push(c);
    }
  }
  return out;
}

/** Pick lexicographically smallest rotation so A→B→C and B→C→A dedupe. */
function canonicalCycleSignature(cycle: string[]): string {
  if (cycle.length === 0) return "";
  const k = cycle.length;
  let best = cycle;
  for (let rot = 0; rot < k; rot++) {
    const cand = [...cycle.slice(rot), ...cycle.slice(0, rot)];
    if (lexLess(cand, best)) best = cand;
  }
  return best.join(">");
}

function lexLess(a: string[], b: string[]): boolean {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) return (a[i] ?? "") < (b[i] ?? "");
  }
  return a.length < b.length;
}
