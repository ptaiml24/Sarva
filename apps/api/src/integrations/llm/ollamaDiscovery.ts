/**
 * List models exposed by a running Ollama server (same host as API unless remote URL is configured).
 * See https://github.com/ollama/ollama/blob/main/docs/api.md#list-local-models
 */

const LIST_TIMEOUT_MS = 10_000;

/** Hostnames allowed for Ollama discovery (SSRF mitigation). Override via env for Docker etc. */
function allowedOllamaHosts(): Set<string> {
  const defaults = new Set([
    "localhost",
    "127.0.0.1",
    "::1",
    "0.0.0.0",
    "host.docker.internal",
  ]);
  const extra = process.env.OLLAMA_LIST_EXTRA_HOSTS?.split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (extra?.length) {
    for (const h of extra) defaults.add(h);
  }
  return defaults;
}

export function assertOllamaListUrlAllowed(raw: string): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error("Invalid base URL");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new Error("Only http(s) URLs are allowed for Ollama discovery");
  }
  if (u.username || u.password) {
    throw new Error("Credentials in Ollama URL are not allowed");
  }
  const host = u.hostname.toLowerCase();
  if (!allowedOllamaHosts().has(host)) {
    throw new Error(
      `Host "${host}" is not allowed for Ollama model listing. Set OLLAMA_LIST_EXTRA_HOSTS (comma-separated) for internal hostnames.`
    );
  }
  return u;
}

export async function fetchOllamaInstalledModelNames(baseUrlInput: string): Promise<string[]> {
  const u = assertOllamaListUrlAllowed(baseUrlInput);
  const origin = `${u.protocol}//${u.host}`;
  const tagsUrl = `${origin.replace(/\/$/, "")}/api/tags`;
  const res = await fetch(tagsUrl, {
    method: "GET",
    signal: AbortSignal.timeout(LIST_TIMEOUT_MS),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Ollama /api/tags failed: ${res.status} ${t.slice(0, 300)}`);
  }
  const data = (await res.json()) as { models?: { name?: string }[] };
  const names = (data.models ?? [])
    .map((m) => (typeof m.name === "string" ? m.name.trim() : ""))
    .filter(Boolean);
  return [...new Set(names)].sort((a, b) => a.localeCompare(b));
}
