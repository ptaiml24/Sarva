import type { Env } from "../config/env.js";
import { generateAssistantText } from "./llm/chatCompletion.js";
import { DESIGN_DOC_SYSTEM } from "../prompt/architect-prompts.js";
import type { ResolvedLlmCredentials } from "./llm/types.js";

/** Assistant Markdown via the model binding’s provider (OpenAI-compatible, Anthropic, Gemini, etc.). */
export async function generateDesignMarkdownWithLlm(
  userPrompt: string,
  cred: ResolvedLlmCredentials,
  fallbackOpenAiEnvKey: string | undefined,
  systemPrompt: string = DESIGN_DOC_SYSTEM
): Promise<string> {
  return generateAssistantText({
    cred,
    systemPrompt,
    userPrompt,
    temperature: 0.35,
    fallbackOpenAiEnvKey,
    errorLabel: "Design LLM failed",
  });
}

export function e2eStubDesignMarkdown(): string {
  return [
    "## Context",
    "E2E stub design (no LLM).",
    "## Goals",
    "Validate design approval gate.",
    "## Architecture overview",
    "Placeholder.",
  ].join("\n\n");
}

export async function runDesignGeneration(
  userPrompt: string,
  cred: ResolvedLlmCredentials,
  env: Env,
  options?: { systemPrompt?: string }
): Promise<{ markdown: string; usedLlm: boolean }> {
  if (env.PM_PROPOSE_E2E_STUB === "true") {
    return { markdown: e2eStubDesignMarkdown(), usedLlm: false };
  }
  if (env.PM_PROPOSE_USE_LLM !== "true") {
    throw new Error("Set PM_PROPOSE_USE_LLM=true to run design generation.");
  }
  const markdown = await generateDesignMarkdownWithLlm(
    userPrompt,
    cred,
    env.OPENAI_API_KEY,
    options?.systemPrompt ?? DESIGN_DOC_SYSTEM
  );
  return { markdown, usedLlm: true };
}
