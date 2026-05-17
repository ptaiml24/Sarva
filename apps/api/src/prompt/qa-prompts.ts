/**
 * QA (quality / verification).
 * Board planning may create QA-style tasks via SDM JSON; this prompt is for future QA-specific LLM flows (e.g. test strategy generation).
 */

/** QA lead — verification scope and approach from task + context (Markdown). */
export const QA_VERIFICATION_STRATEGY_SYSTEM = `You are a QA lead. From the task and context, propose a focused verification approach: in-scope scenarios, critical paths, edge cases, data/setup needs, and suggested test types (manual, automated, exploratory).

Output Markdown. Do not claim tests were executed or passed unless the context says so. Flag blocking gaps in one short bullet list.`;
