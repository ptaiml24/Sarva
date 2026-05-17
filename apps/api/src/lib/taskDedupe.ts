/**
 * Detects “same intent” duplicates (e.g. “Setup Project environment” vs “Environment setup …”)
 * so the board planner and operators can collapse extras safely.
 */

import { prisma } from "./prisma.js";

const STOPWORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "from",
  "that",
  "this",
  "your",
  "our",
  "are",
  "was",
  "has",
  "have",
  "into",
  "about",
]);

export function normalizeTaskTitleForDedupe(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function significantTokens(normalized: string): Set<string> {
  const words = normalized.split(" ").filter((w) => w.length > 0);
  const out = new Set<string>();
  for (const w of words) {
    if (w.length < 3) continue;
    if (STOPWORDS.has(w)) continue;
    out.add(w);
  }
  return out;
}

/** True when titles look like the same work item (word overlap / containment), not exact string match only. */
export function areDuplicateTaskTitles(a: string, b: string): boolean {
  const na = normalizeTaskTitleForDedupe(a);
  const nb = normalizeTaskTitleForDedupe(b);
  if (!na || !nb) return false;
  if (na === nb) return true;

  const wa = significantTokens(na);
  const wb = significantTokens(nb);
  if (wa.size === 0 || wb.size === 0) {
    return na === nb;
  }

  let inter = 0;
  for (const t of wa) {
    if (wb.has(t)) inter += 1;
  }
  const smaller = Math.min(wa.size, wb.size);
  const union = wa.size + wb.size - inter;
  if (inter === smaller) return true;
  if (union > 0 && inter / union >= 0.55) return true;
  return false;
}

export type TaskDedupeRow = {
  id: string;
  title: string;
  description: string | null;
  state: string;
};

function pickKeeperForGroup(group: TaskDedupeRow[]): TaskDedupeRow {
  return [...group].sort((a, b) => {
    const la = (a.description ?? "").length;
    const lb = (b.description ?? "").length;
    if (lb !== la) return lb - la;
    const ta = a.title.length;
    const tb = b.title.length;
    if (tb !== ta) return tb - ta;
    return a.id.localeCompare(b.id);
  })[0]!;
}

function connectedDuplicateGroups(rows: TaskDedupeRow[]): TaskDedupeRow[][] {
  const n = rows.length;
  if (n <= 1) return [];
  const parent = [...Array(n)].map((_, i) => i);

  function find(i: number): number {
    let p = parent[i]!;
    while (p !== parent[p]!) p = parent[p]!;
    parent[i] = p;
    return p;
  }

  function union(i: number, j: number): void {
    const pi = find(i);
    const pj = find(j);
    if (pi !== pj) parent[pj] = pi;
  }

  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (areDuplicateTaskTitles(rows[i].title, rows[j].title)) union(i, j);
    }
  }

  const rootToMembers = new Map<number, TaskDedupeRow[]>();
  for (let i = 0; i < n; i++) {
    const r = find(i);
    const list = rootToMembers.get(r) ?? [];
    list.push(rows[i]);
    rootToMembers.set(r, list);
  }

  return [...rootToMembers.values()].filter((g) => g.length > 1);
}

const DEFAULT_DEDUPE_STATES = ["backlog", "todo"] as const;

/**
 * Deletes duplicate tasks in the given states, keeping the richest description (then longer title, then id).
 * Only touches {@link DEFAULT_DEDUPE_STATES} unless overridden.
 */
export async function collapseDuplicateTasksForProject(
  projectId: string,
  options?: { states?: readonly string[] }
): Promise<{ removedTaskIds: string[]; keptTaskIds: string[] }> {
  const states = options?.states?.length ? [...options.states] : [...DEFAULT_DEDUPE_STATES];
  const rows = await prisma.task.findMany({
    where: { projectId, state: { in: states } },
    select: { id: true, title: true, description: true, state: true },
  });

  const groups = connectedDuplicateGroups(rows);
  const removed: string[] = [];
  const kept: string[] = [];

  for (const g of groups) {
    const keeper = pickKeeperForGroup(g);
    kept.push(keeper.id);
    for (const t of g) {
      if (t.id !== keeper.id) removed.push(t.id);
    }
  }

  if (removed.length === 0) {
    return { removedTaskIds: [], keptTaskIds: [] };
  }

  await prisma.task.deleteMany({ where: { id: { in: removed }, projectId } });
  return { removedTaskIds: removed, keptTaskIds: kept };
}
