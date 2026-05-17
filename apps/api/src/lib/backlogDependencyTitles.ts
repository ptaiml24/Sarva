/** Normalize dependsOnTitles from PM backlog JSON (exact titles of sibling items). */
export function parseDependsOnTitlesField(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const x of raw) {
    if (typeof x !== "string") continue;
    const t = x.trim();
    if (t) out.push(t.slice(0, 500));
  }
  return [...new Set(out)];
}
