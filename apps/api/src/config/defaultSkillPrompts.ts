/**
 * Skill template defaults — merges DB `agent_prompt` with built-ins from `prompt/skills/`.
 * Human-facing SOP / role narrative: Requirement/SARVA-REQUIREMENTS.md and prompts in Admin; optional legacy copy under Requirement/archive/ (gitignored).
 */

import { skillBuiltinPromptsByCode } from "../prompt/skills/index.js";

/** Alias for catalog consumers; same map as `skillBuiltinPromptsByCode`. */
export const DEFAULT_SKILL_AGENT_PROMPT_BY_CODE: Record<string, string> = skillBuiltinPromptsByCode;

const LEGACY_BUILTIN_PREFIX = "You perform work as";

/** True when DB value should be replaced by seed with the canonical default (short generic text). */
export function shouldReplaceWithBuiltinDefault(code: string, current: string | null | undefined): boolean {
  if (!skillBuiltinPromptsByCode[code]) return false;
  const p = current?.trim() ?? "";
  if (!p) return true;
  if (p.startsWith(LEGACY_BUILTIN_PREFIX) && p.length < 200) return true;
  return false;
}

export function resolveSkillAgentPrompt(code: string, stored: string | null | undefined): string {
  const trimmed = stored?.trim();
  if (trimmed) return trimmed;
  return skillBuiltinPromptsByCode[code] ?? genericSkillFallback(code);
}

function genericSkillFallback(code: string): string {
  return `You perform work for Sarva skill "${code}". Follow the task description, team standards, and output format requested by the orchestrator. If blocked, return BLOCKED with one clear reason.`;
}

export type SkillTemplateRow = {
  id: string;
  code: string;
  label: string;
  description: string | null;
  agentPrompt: string | null;
  sortOrder: number;
};

/** API shape: effective prompt + override metadata for UI and LLM callers. */
export function serializeSkillTemplate(row: SkillTemplateRow) {
  const builtin = skillBuiltinPromptsByCode[row.code] ?? null;
  return {
    id: row.id,
    code: row.code,
    label: row.label,
    description: row.description,
    sortOrder: row.sortOrder,
    agentPrompt: resolveSkillAgentPrompt(row.code, row.agentPrompt),
    agentPromptOverride: row.agentPrompt,
    builtinDefaultAgentPrompt: builtin,
  };
}
