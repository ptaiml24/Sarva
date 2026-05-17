/**
 * SDE (software development engineer) — re-exports implementation defaults from `prompt/skills/coder.ts`
 * so role-oriented imports stay stable.
 */

export {
  CODER_IMPLEMENTATION_OUTPUT_APPENDIX as CODER_TASK_OUTPUT_GUIDELINES,
  DEFAULT_CODER_IMPLEMENTATION_SYSTEM_PROMPT as CODER_TASK_SYSTEM,
} from "./skills/coder.js";
