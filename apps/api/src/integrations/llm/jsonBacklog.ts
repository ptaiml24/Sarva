/** Parse model output into backlog items (shared by all LLM adapters). */

import { parseDependsOnTitlesField } from "../../lib/backlogDependencyTitles.js";

export { parseDependsOnTitlesField };

export type NormalizedBacklogLine = {
  title: string;
  description: string;
  /** Lower phases complete before higher phases can start (claim gate). */
  phase: number;
  /** Titles of other items in the same batch that must finish first (finish-to-start). */
  dependsOnTitles: string[];
};

export function extractJsonArray(raw: string): unknown {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    const m = raw.match(/\[[\s\S]*\]/);
    if (!m) throw new Error("LLM did not return JSON array");
    parsed = JSON.parse(m[0]);
  }
  return parsed;
}

export function normalizeBacklogItems(parsed: unknown): NormalizedBacklogLine[] {
  if (!Array.isArray(parsed)) throw new Error("LLM JSON must be an array");
  const out: NormalizedBacklogLine[] = [];
  for (const row of parsed.slice(0, 25)) {
    if (!row || typeof row !== "object") continue;
    const r = row as Record<string, unknown>;
    const title = typeof r.title === "string" ? r.title.trim() : "";
    if (!title) continue;
    const description = typeof r.description === "string" ? r.description : "";
    let phase = 0;
    if (r.phase !== undefined) {
      const p = typeof r.phase === "number" ? r.phase : Number(r.phase);
      phase = Number.isFinite(p) ? Math.min(30, Math.max(0, Math.floor(p))) : 0;
    }
    const dependsOnTitles = parseDependsOnTitlesField(r.dependsOnTitles);
    out.push({
      title: title.slice(0, 500),
      description: description.slice(0, 20_000),
      phase,
      dependsOnTitles,
    });
  }
  if (out.length === 0) throw new Error("LLM returned no usable backlog items");
  return out;
}
