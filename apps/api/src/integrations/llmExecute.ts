/**
 * PM propose backlog generation — delegates to per-provider adapters in `./llm/`.
 */
export type { ResolvedLlmCredentials } from "./llm/types.js";
import { generateBacklogViaProviderAdapter } from "./llm/providerAdapters.js";
import type { NormalizedBacklogLine } from "./llm/jsonBacklog.js";
import type { ResolvedLlmCredentials } from "./llm/types.js";

export async function generateBacklogItemsWithLlm(
  userPrompt: string,
  cred: ResolvedLlmCredentials,
  fallbackOpenAiEnvKey: string | undefined
): Promise<NormalizedBacklogLine[]> {
  return generateBacklogViaProviderAdapter(userPrompt, cred, fallbackOpenAiEnvKey);
}
