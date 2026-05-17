import type { Env } from "../config/env.js";
import { generateAssistantText } from "./llm/chatCompletion.js";
import { SDM_REVIEW_HANDOFF_SYSTEM } from "../prompt/sdm-prompts.js";
import type { ResolvedLlmCredentials } from "./llm/types.js";
import { bindingToCredentials, resolveBindingPreferringAgent, resolveDesignLlmAgentId } from "./pmOrchestrator.js";
import { loadSeatForAgentOnProject } from "../lib/agentSeatPromptContext.js";
import { composeReviewHandoffSystemPromptForSeat } from "../prompt/skills/composeSeatTaskPrompt.js";

export type ReviewHandoffInput = {
  taskTitle: string;
  implementerName: string;
  reviewerName: string;
  workspacePath: string | null;
  coderExcerpt: string;
};

async function generateReviewHandoffMarkdownWithLlm(
  userPrompt: string,
  cred: ResolvedLlmCredentials,
  fallbackOpenAiEnvKey: string | undefined,
  systemPrompt: string = SDM_REVIEW_HANDOFF_SYSTEM
): Promise<string> {
  const text = await generateAssistantText({
    cred,
    systemPrompt,
    userPrompt,
    temperature: 0.3,
    fallbackOpenAiEnvKey,
    errorLabel: "Review handoff LLM failed",
  });
  return text.slice(0, 12_000);
}

function deterministicHandoff(input: ReviewHandoffInput): string {
  const lines = [
    `## Code review: ${input.taskTitle}`,
    "",
    `- **Implementer:** ${input.implementerName}`,
    `- **Reviewer (assignee):** ${input.reviewerName}`,
    input.workspacePath ? `- **Workspace (API host):** \`${input.workspacePath}\`` : null,
    "",
    "### Focus",
    "- Verify behavior against the task description and acceptance criteria.",
    "- Check edge cases and obvious security issues.",
    "",
    "### Coder output (excerpt)",
    input.coderExcerpt.slice(0, 4000) + (input.coderExcerpt.length > 4000 ? "\n\n…" : ""),
  ];
  return lines.filter(Boolean).join("\n");
}

export function e2eStubReviewHandoff(input: ReviewHandoffInput): string {
  return [
    "## E2E stub — SDM review handoff",
    `Task: ${input.taskTitle}`,
    `Reviewer: ${input.reviewerName}`,
    input.workspacePath ? `Workspace: ${input.workspacePath}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

export async function buildReviewHandoffMarkdown(
  projectId: string,
  input: ReviewHandoffInput,
  env: Env
): Promise<{ markdown: string; usedLlm: boolean }> {
  if (env.AGENT_REVIEW_HANDOFF_E2E_STUB === "true") {
    return { markdown: e2eStubReviewHandoff(input), usedLlm: false };
  }
  if (env.AGENT_REVIEW_HANDOFF_USE_LLM !== "true") {
    return { markdown: deterministicHandoff(input), usedLlm: false };
  }

  try {
    const designAgentId = await resolveDesignLlmAgentId(projectId);
    const binding = await resolveBindingPreferringAgent(projectId, designAgentId, {});
    if (!binding) {
      return { markdown: deterministicHandoff(input), usedLlm: false };
    }
    const cred = bindingToCredentials(binding);
    if (!cred) {
      return { markdown: deterministicHandoff(input), usedLlm: false };
    }
    const seat = await loadSeatForAgentOnProject(projectId, designAgentId);
    const systemPrompt = composeReviewHandoffSystemPromptForSeat(seat);
    const user = [
      `Task title: ${input.taskTitle}`,
      `Implementer: ${input.implementerName}`,
      `Reviewer: ${input.reviewerName}`,
      input.workspacePath ? `Workspace path on delivery host: ${input.workspacePath}` : "",
      "\n## Latest coder draft (excerpt)\n",
      input.coderExcerpt.slice(0, 24_000),
    ].join("\n");
    const markdown = await generateReviewHandoffMarkdownWithLlm(user, cred, env.OPENAI_API_KEY, systemPrompt);
    return { markdown, usedLlm: true };
  } catch {
    return { markdown: deterministicHandoff(input), usedLlm: false };
  }
}
