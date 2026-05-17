import { generateAssistantText } from "./llm/chatCompletion.js";
import { DEFAULT_CODER_IMPLEMENTATION_SYSTEM_PROMPT } from "../prompt/skills/coder.js";
import type { ResolvedLlmCredentials } from "./llm/types.js";

export type GenerateCoderMarkdownOptions = {
  /** Full system message; defaults to `CODER_TASK_SYSTEM` from `sde-prompts` (use `resolveCoderSystemPromptForSeat`). */
  systemPrompt?: string;
  /** Cursor local SDK: use this directory as `local.cwd` (Sarva project dev workspace). */
  cursorLocalPreferredCwd?: string | null;
};

/** Implementation draft Markdown — uses whichever provider is on the assignee’s model binding. */
export async function generateCoderMarkdownWithLlm(
  userPrompt: string,
  cred: ResolvedLlmCredentials,
  fallbackOpenAiEnvKey: string | undefined,
  options?: GenerateCoderMarkdownOptions
): Promise<string> {
  const systemContent = options?.systemPrompt?.trim() || DEFAULT_CODER_IMPLEMENTATION_SYSTEM_PROMPT;
  return generateAssistantText({
    cred,
    systemPrompt: systemContent,
    userPrompt,
    temperature: 0.25,
    fallbackOpenAiEnvKey,
    errorLabel: "Coder LLM failed",
    cursorLocalPreferredCwd: options?.cursorLocalPreferredCwd,
  });
}

export function e2eStubCoderMarkdown(taskTitle: string): string {
  return [
    "## Plan",
    "- Stub implementation (no LLM).",
    "- Replace with real provider in non-test environments.",
    "",
    "## Example file `src/example.ts`",
    "```ts",
    `// TODO: implement — ${taskTitle}`,
    "export const placeholder = true;",
    "```",
  ].join("\n");
}
