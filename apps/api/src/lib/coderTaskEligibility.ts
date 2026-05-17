import { seatSkillLinksIncludeCoder } from "../prompt/skills/composeSeatTaskPrompt.js";

/** Role templates where the board should not invoke implementation / run-coder LLM unless the seat also links **Coder**. */
const NON_CODER_ROLE_CODES = new Set([
  "QA",
  "PM",
  "SDM",
  "TECH_DIRECTOR",
  "TPM",
  "REVIEWER",
]);

/** Task snapshot shape usable from Prisma reads and list APIs (minimal fields only). */
export type CoderEligibilitySnapshot = {
  assigneeAgentId: string | null;
  skillTags: string[];
  targetRole: {
    roleTemplate: { code: string } | null;
    skillLinks: { skillTemplate: { code: string } }[];
  } | null;
};

/**
 * Mirrors `runCoderAgentForTask` gating — true when POST /tasks/:id/run-coder should run implementation LLM
 * instead of skipping with `not_coder_task`.
 */
export function isCoderEligibleTask(task: CoderEligibilitySnapshot): boolean {
  if (!task.assigneeAgentId) return false;
  if (seatSkillLinksIncludeCoder(task.targetRole?.skillLinks)) return true;

  const roleCode = task.targetRole?.roleTemplate?.code?.toUpperCase() ?? null;
  if (roleCode && NON_CODER_ROLE_CODES.has(roleCode)) return false;
  if (roleCode === "ENGINEER") return true;
  if (task.skillTags.some((t) => t.toLowerCase() === "coder")) return true;
  if (!roleCode) return true;
  return false;
}
