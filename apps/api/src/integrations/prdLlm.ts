import type { Env } from "../config/env.js";
import { generateAssistantText } from "./llm/chatCompletion.js";
import { PRD_DOC_SYSTEM } from "../prompt/pm-prompts.js";
import type { ResolvedLlmCredentials } from "./llm/types.js";

export async function generatePrdMarkdownWithLlm(
  userPrompt: string,
  cred: ResolvedLlmCredentials,
  fallbackOpenAiEnvKey: string | undefined,
  systemPrompt: string = PRD_DOC_SYSTEM
): Promise<string> {
  return generateAssistantText({
    cred,
    systemPrompt,
    userPrompt,
    temperature: 0.35,
    fallbackOpenAiEnvKey,
    errorLabel: "PRD LLM failed",
  });
}

export function e2eStubPrdMarkdown(): string {
  return [
    "## Overview",
    "E2E stub PRD (no LLM).",
    "## Goals",
    "Validate PRD approval gate.",
    "## Functional requirements",
    "- FR-1: Placeholder requirement",
  ].join("\n\n");
}

export async function runPrdGeneration(
  userPrompt: string,
  cred: ResolvedLlmCredentials,
  env: Env,
  options?: { systemPrompt?: string }
): Promise<{ markdown: string; usedLlm: boolean }> {
  if (env.PM_PROPOSE_E2E_STUB === "true") {
    return { markdown: e2eStubPrdMarkdown(), usedLlm: false };
  }
  if (env.PM_PROPOSE_USE_LLM !== "true") {
    throw new Error("Set PM_PROPOSE_USE_LLM=true to run PRD generation.");
  }
  const markdown = await generatePrdMarkdownWithLlm(
    userPrompt,
    cred,
    env.OPENAI_API_KEY,
    options?.systemPrompt ?? PRD_DOC_SYSTEM
  );
  return { markdown, usedLlm: true };
}
