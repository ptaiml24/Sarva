/** Preset row for Admin model dropdown (mirrors catalog `modelPresets` shape). */
export type CursorModelPreset = { modelId: string; label: string };

const CURSOR_LIST_TIMEOUT_MS = 15_000;
const CACHE_TTL_MS = 5 * 60_000;
const CURSOR_API_BASE = process.env.CURSOR_BACKEND_URL?.trim() || "https://api.cursor.com";

let presetCache: { apiKey: string; fetchedAt: number; presets: CursorModelPreset[] } | null = null;

type RawCursorModel = {
  id?: string;
  modelId?: string;
  displayName?: string;
  displayModelId?: string;
  name?: string;
  variants?: { displayName?: string; params?: unknown[] }[];
};

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${Math.round(ms / 1000)}s`)), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

/** Cursor `/v1/models` and `Cursor.models.list()` may return several shapes. */
export function extractCursorModelRows(raw: unknown): RawCursorModel[] {
  if (Array.isArray(raw)) return raw as RawCursorModel[];
  if (raw && typeof raw === "object") {
    const o = raw as Record<string, unknown>;
    for (const key of ["items", "models", "data"] as const) {
      const v = o[key];
      if (Array.isArray(v)) return v as RawCursorModel[];
    }
  }
  return [];
}

function rowModelId(row: RawCursorModel): string {
  const id = (row.id ?? row.modelId ?? row.displayModelId ?? "").trim();
  return id;
}

function rowLabel(row: RawCursorModel, modelId: string): string {
  const label = (row.displayName ?? row.name ?? row.displayModelId ?? "").trim();
  return label || modelId;
}

/**
 * Lists models available to the given Cursor API key via `Cursor.models.list()`.
 * Results are cached briefly per key so Admin refreshes do not hammer the API.
 */
export async function fetchCursorModelPresets(apiKey: string): Promise<CursorModelPreset[]> {
  const key = apiKey.trim();
  if (!key) {
    throw new Error("Cursor API key required (enter on the form or set CURSOR_API_KEY on the API host).");
  }

  if (
    presetCache &&
    presetCache.apiKey === key &&
    Date.now() - presetCache.fetchedAt < CACHE_TTL_MS
  ) {
    return presetCache.presets;
  }

  const { Cursor } = await import("@cursor/sdk");
  let rawList: unknown;
  try {
    rawList = await withTimeout(Cursor.models.list({ apiKey: key }), CURSOR_LIST_TIMEOUT_MS, "Cursor models.list");
  } catch (e) {
    const message = e instanceof Error ? e.message : "Cursor models.list failed";
    throw new Error(message);
  }

  let rows = extractCursorModelRows(rawList);
  if (rows.length === 0) {
    rows = await fetchCursorModelsViaHttp(key);
  }

  const seen = new Set<string>();
  const presets: CursorModelPreset[] = [];

  const push = (modelId: string, label: string) => {
    const id = modelId.trim();
    if (!id || seen.has(id)) return;
    seen.add(id);
    presets.push({ modelId: id, label: (label.trim() || id) });
  };

  push("auto", "Server default (auto)");

  for (const row of rows) {
    const modelId = rowModelId(row);
    if (!modelId) continue;
    push(modelId, rowLabel(row, modelId));
    for (const variant of row.variants ?? []) {
      const variantLabel = variant.displayName?.trim();
      if (variantLabel) {
        push(modelId, `${rowLabel(row, modelId)} — ${variantLabel}`);
      }
    }
  }

  const cursorOnly = presets.length - 1;
  if (cursorOnly === 0) {
    throw new Error(
      `Cursor returned no models for this API key. Confirm the key in Cursor Dashboard → Integrations, then retry. (${CURSOR_API_BASE}/v1/models)`
    );
  }

  presetCache = { apiKey: key, fetchedAt: Date.now(), presets };
  return presets;
}

/** Fallback when SDK list returns an unexpected shape (parses `{ items }` from the REST API). */
async function fetchCursorModelsViaHttp(apiKey: string): Promise<RawCursorModel[]> {
  const url = `${CURSOR_API_BASE.replace(/\/$/, "")}/v1/models`;
  const res = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: "application/json",
    },
    signal: AbortSignal.timeout(CURSOR_LIST_TIMEOUT_MS),
  });
  const text = await res.text();
  if (!res.ok) {
    let detail = text.slice(0, 300);
    try {
      const parsed = JSON.parse(text) as { error?: { message?: string }; message?: string };
      detail = parsed.error?.message ?? parsed.message ?? detail;
    } catch {
      /* keep raw slice */
    }
    throw new Error(`Cursor /v1/models failed (${res.status}): ${detail}`);
  }
  if (!text.trim()) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("Cursor /v1/models returned non-JSON.");
  }
  return extractCursorModelRows(parsed);
}

/** Clears in-process cache (tests). */
export function clearCursorModelPresetCache(): void {
  presetCache = null;
}
