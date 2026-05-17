import { Agent, CursorSdkError } from "@cursor/sdk";
import type { AgentOptions } from "@cursor/sdk";
import type { ResolvedLlmCredentials } from "./types.js";

function buildCursorAgentOptions(
  cred: ResolvedLlmCredentials,
  apiKey: string,
  preferredLocalCwd?: string | null
): AgentOptions {
  const mid = cred.modelId?.trim();
  const model = mid && mid.length > 0 ? { id: mid } : { id: "auto" };

  const repoFromConnection = cred.baseUrl?.trim();
  const repoFromEnv = process.env.CURSOR_CLOUD_REPO_URL?.trim();
  const repoUrl = repoFromConnection || repoFromEnv || "";

  if (repoUrl) {
    return {
      apiKey,
      model,
      cloud: {
        repos: [{ url: repoUrl, startingRef: process.env.CURSOR_CLOUD_REPO_REF?.trim() || "main" }],
        skipReviewerRequest: true,
      },
    };
  }

  const cwd =
    (typeof preferredLocalCwd === "string" && preferredLocalCwd.trim() ? preferredLocalCwd.trim() : "") ||
    process.env.CURSOR_AGENT_LOCAL_CWD?.trim() ||
    process.cwd();
  return {
    apiKey,
    model,
    local: { cwd },
  };
}

function formatCursorErrorResult(result: unknown): string {
  if (!result || typeof result !== "object") return "";
  const r = result as Record<string, unknown>;
  const parts: string[] = [];
  if (typeof r.id === "string" && r.id.trim()) parts.push(`runId=${r.id.trim()}`);
  if (typeof r.agentId === "string" && r.agentId.trim()) parts.push(`agentId=${r.agentId.trim()}`);
  if (typeof r.message === "string" && r.message.trim()) parts.push(r.message.trim().slice(0, 800));
  if (r.error != null) {
    const e = r.error;
    const s =
      typeof e === "string" ?
        e
      : typeof e === "object" && e !== null && "message" in e && typeof (e as { message: unknown }).message === "string" ?
        (e as { message: string }).message
      : JSON.stringify(e).slice(0, 600);
    if (s.trim()) parts.push(s.trim());
  }
  return parts.length ? parts.join(" — ") : "";
}

/**
 * One-shot Cursor agent prompt (same stack as IDE/Cloud Agents). System + user are concatenated because
 * `Agent.prompt` accepts a single message string.
 */
export async function cursorAgentPromptText(params: {
  cred: ResolvedLlmCredentials;
  systemPrompt: string;
  userPrompt: string;
  errorLabel: string;
  apiKey: string;
  /** When running local Cursor SDK, cwd for file tools (defaults: env CURSOR_AGENT_LOCAL_CWD → process.cwd()). */
  preferredLocalCwd?: string | null;
}): Promise<string> {
  const { cred, systemPrompt, userPrompt, errorLabel, apiKey, preferredLocalCwd } = params;
  const prompt = `${systemPrompt}\n\n---\n\n${userPrompt}`;
  const options = buildCursorAgentOptions(cred, apiKey, preferredLocalCwd);

  try {
    const result = await Agent.prompt(prompt, options);
    if (result.status === "error") {
      const detail = formatCursorErrorResult(result);
      throw new Error(
        `${errorLabel}: Cursor run finished with status error.${detail ? ` ${detail}` : " Inspect transcript in Cursor Cloud or local agent logs."}`
      );
    }
    if (result.status === "cancelled") {
      throw new Error(`${errorLabel}: Cursor run was cancelled.`);
    }
    const text = result.result?.trim();
    if (!text) {
      throw new Error(`${errorLabel}: Cursor returned no assistant text.`);
    }
    return text;
  } catch (e) {
    if (e instanceof CursorSdkError) {
      throw new Error(`${errorLabel}: ${e.message}${e.isRetryable ? " (retryable)" : ""}`);
    }
    throw e;
  }
}
