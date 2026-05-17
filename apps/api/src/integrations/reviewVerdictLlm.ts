import type { Env } from "../config/env.js";
import { prisma } from "../lib/prisma.js";
import { generateAssistantText } from "./llm/chatCompletion.js";
import { withProposeBindingFallback } from "./pmOrchestrator.js";
import { AUTOMATED_CODE_REVIEW_VERDICT_SYSTEM } from "../prompt/automated-review-prompts.js";
import { z } from "zod";

export type AutomatedReviewInput = {
  taskTitle: string;
  /** Full description (may embed prior review-feedback sections). */
  description: string | null;
  reviewHandoffMarkdown: string | null;
  coderDraft: string | null;
  reviewRevisionCount: number;
};

const verdictSchema = z.object({
  verdict: z.enum(["approve", "request_changes"]),
  notes: z.string().max(4500).optional(),
});

function extractLeadingJsonObject(raw: string): unknown {
  const trimmed = raw.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const m = trimmed.match(/\{[\s\S]*\}/);
    if (!m) throw new Error("LLM review verdict did not return JSON object");
    return JSON.parse(m[0]);
  }
}

export async function automatedReviewStubVerdict(task: AutomatedReviewInput): Promise<{
  verdict: "approve" | "request_changes";
  notes: string;
}> {
  if (task.reviewRevisionCount >= 1) {
    return {
      verdict: "approve",
      notes:
        `[E2E stub] Accepted after revision round ${task.reviewRevisionCount}. ` +
        `Task: ${task.taskTitle}`,
    };
  }
  return {
    verdict: "request_changes",
    notes: `[E2E stub] Automated reviewer requesting one revision pass (${task.taskTitle}).`,
  };
}

/** LLM-assisted verdict: tries the review assignee’s bindings in priority order, then company defaults (survives 429 when a backup binding exists). */
export async function proposeAutomatedReviewVerdict(
  _projectId: string,
  reviewerAssigneeAgentId: string | null,
  task: AutomatedReviewInput,
  env: Env,
  opts?: { preferredRoleId?: string | null }
): Promise<{ verdict: "approve" | "request_changes"; notes: string } | null> {
  if (env.AGENT_AUTOMATED_REVIEW_E2E_STUB === "true") {
    return automatedReviewStubVerdict(task);
  }
  if (!reviewerAssigneeAgentId) return null;

  const company = await prisma.company.findFirst();
  const companyId = company?.id ?? null;
  if (!companyId) return null;

  const user = [
    `## Automated review (${task.taskTitle})`,
    `Review revision rounds so far (count of prior review→fix cycles): ${task.reviewRevisionCount}`,
    `\n### Task description (may include pasted review-feedback)\n`,
    (task.description ?? "").slice(0, 24_000) || "(empty)",
    task.reviewHandoffMarkdown ? `\n### Handoff markdown\n${task.reviewHandoffMarkdown.slice(0, 12_000)}` : "",
    `\n### Implementation draft\n`,
    (task.coderDraft ?? "").slice(0, 28_000) || "(empty)",
  ].join("");

  /** Same seat → agent → company fallthrough as PM propose / coder paths; retries alternative bindings on transient quota (429). */
  let raw: string;
  try {
    raw = await withProposeBindingFallback(
      reviewerAssigneeAgentId,
      companyId,
      async ({ cred }) =>
        generateAssistantText({
          cred,
          systemPrompt: AUTOMATED_CODE_REVIEW_VERDICT_SYSTEM,
          userPrompt: user,
          temperature: 0.2,
          fallbackOpenAiEnvKey: env.OPENAI_API_KEY,
          errorLabel: "Automated review verdict LLM failed",
        }),
      {
        roleId: opts?.preferredRoleId ?? undefined,
        bindingAudit: { projectId: _projectId, workflow: "review.auto_verdict" },
      }
    );
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("No LLM is configured")) return null;
    throw e;
  }

  const parsed = verdictSchema.safeParse(extractLeadingJsonObject(raw));
  if (!parsed.success) {
    return {
      verdict: "approve",
      notes: `[Automated review] Model output did not validate — approving with caution. Raw (truncated): ${raw.slice(0, 400)}`,
    };
  }

  const notes = parsed.data.notes?.trim() || `(no notes) verdict=${parsed.data.verdict}`;
  return { verdict: parsed.data.verdict, notes };
}

export async function loadTaskForAutomatedReview(taskId: string) {
  return prisma.task.findUnique({
    where: { id: taskId },
    select: {
      id: true,
      projectId: true,
      state: true,
      version: true,
      title: true,
      description: true,
      reviewHandoffMarkdown: true,
      agentGeneratedBody: true,
      reviewRevisionCount: true,
      assigneeAgentId: true,
      targetRoleId: true,
    },
  });
}
