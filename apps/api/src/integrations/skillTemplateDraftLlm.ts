import { z } from "zod";
import type { Env } from "../config/env.js";
import { generateAssistantText } from "./llm/chatCompletion.js";
import { bindingToCredentials, resolveDesignLlmBinding } from "./pmOrchestrator.js";

const SKILL_TEMPLATE_DRAFT_SYSTEM = [
  "You propose configuration for ONE new Sarva **Skill**, used as a specialty routed to assistants on team seats.",
  "The machine-readable SKILL CODE is fixed (ASCII, often SNAKE_CASE). The administrator provided a SHORT DESCRIPTION of what this skill does for the delivery organization.",
  "Return ONLY a JSON object with two string keys:",
  '- "label": a concise human-readable title (about 3–10 words); Title Case is fine; do not append the word "Skill"; avoid repeating the skill code verbatim unless it reads naturally.',
  '- "agentPrompt": detailed prose instructions FOR THE ASSISTANT MODEL when acting as ONLY this specialty. Explain purpose, boundaries, workflow style (clarify-before-code when appropriate), how to escalate, and formatting expectations. Aim for specificity the team can steer from; avoid placeholders like [TODO].',
  "The agentPrompt will be persisted as-is (plain text/Markdown style is OK). Respond with JSON only — no fences or prose outside the object.",
].join("\n");

const draftShape = z.object({
  label: z.string().min(1).max(220),
  agentPrompt: z.string().min(16).max(50_000),
});

function stripJsonFence(raw: string): string {
  let t = raw.trim();
  if (t.startsWith("```")) {
    t = t.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  }
  return t.trim();
}

/** Used by tests — mirrors production JSON shape validation. */
export function parseSkillTemplateDraftReply(rawText: string): { label: string; agentPrompt: string } {
  const stripped = stripJsonFence(rawText);
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripped);
  } catch {
    const m = stripped.match(/\{[\s\S]*\}/);
    if (!m) throw new Error("Model did not return a JSON object for the skill draft.");
    parsed = JSON.parse(m[0]);
  }
  const validated = draftShape.safeParse(parsed);
  if (!validated.success) {
    throw new Error(
      `Invalid skill draft JSON: ${validated.error.issues.slice(0, 3).map((i) => i.message).join("; ")}`
    );
  }
  return validated.data;
}

export async function stubSkillCatalogGenerate(code: string, description: string): Promise<{
  label: string;
  agentPrompt: string;
}> {
  const desc = description.trim() || "(no description)";
  const label = `${code.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())} assistant`.slice(0, 220);
  const agentPrompt = [
    `# ${label}`,
    `Machine skill code (fixed): ${code}`,
    "",
    "**Administrator intent:**",
    desc,
    "",
    "**Stub:** replace with Admin → Provider + company default model binding. When live, obey scope and produce concrete, actionable output.",
  ].join("\n");
  return { label, agentPrompt };
}

/** Uses company-wide model binding only (Admin → Model bindings). */
export async function generateSkillTemplateDraftFromCompanyModel(
  env: Env,
  input: { code: string; description: string },
  fallbackOpenAiEnvKey: string | undefined
): Promise<{ label: string; agentPrompt: string; usedStub: boolean }> {
  if (env.SKILL_CATALOG_GENERATE_E2E_STUB === "true") {
    return { ...(await stubSkillCatalogGenerate(input.code, input.description)), usedStub: true };
  }

  const binding = await resolveDesignLlmBinding();
  if (!binding) {
    throw new Error(
      "No company-wide default LLM binding. Add one under System → Admin → Model bindings (company-only row)."
    );
  }
  const cred = bindingToCredentials(binding);
  if (!cred?.modelId) {
    throw new Error("Resolved LLM credentials are incomplete for the company binding.");
  }

  const userPrompt = [
    `Skill code (fixed identifier): ${input.code}`,
    "",
    `Administrator description of what this skill should do:`,
    input.description.trim(),
  ].join("\n");

  const rawText = await generateAssistantText({
    cred,
    systemPrompt: SKILL_TEMPLATE_DRAFT_SYSTEM,
    userPrompt,
    temperature: 0.35,
    jsonObjectMode: true,
    fallbackOpenAiEnvKey,
    errorLabel: "Skill catalog draft generation failed",
  });

  try {
    return { ...parseSkillTemplateDraftReply(rawText), usedStub: false };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`${msg.slice(0, 400)} (raw excerpt: ${rawText.trim().slice(0, 200)}…)`, { cause: e });
  }
}
