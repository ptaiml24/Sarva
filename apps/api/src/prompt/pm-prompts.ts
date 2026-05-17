/**
 * Product manager (PM) — backlog JSON and PRD generation.
 * Used by provider adapters (PM propose) and PRD LLM integration.
 */

/** Shared system prompt for PM backlog JSON generation across all adapters. */
export const PM_BACKLOG_JSON_SYSTEM = `You output only valid JSON: an array of objects {"title": string, "description": string, "phase"?: number, "dependsOnTitles"?: string[]}. No markdown fences. Max 25 items. Titles under 500 characters.

Field "phase" (integer, optional, default 0): execution wave. Use phase 0 for foundational work that must finish before other tasks start in parallel — e.g. create repo/folders, initial project scaffold, CI skeleton, first push to git, environment baseline. Use phase 1 for feature work that can run in parallel once phase 0 is complete. Use phase 2+ only when a second gate is truly needed. Tasks in the same phase may be worked in parallel. Omit "phase" or use 0 when unsure.

Field "dependsOnTitles" (string array, optional): finish-to-start links **within this same JSON array**. List the exact "title" strings of other items that must be **completed before** this item may start. Use [] or omit when nothing in this batch blocks this item. Every entry must match another object's "title" **exactly** (same spelling and casing). Prefer a higher "phase" when an entire wave must finish first; use dependsOnTitles for ordering among tasks in the **same** phase (or when two titles share a phase but one truly gates the other).`;

/** PRD section expectations and quality bar (follows primary skill persona when seat skills are composed). */
export const PRD_DOCUMENT_STRUCTURE_APPENDIX = `Write a clear Product Requirements Document (PRD) in Markdown only (no outer code fences).

Include sections: ## Overview, ## Goals, ## User stories / scope, ## Functional requirements, ## Non-functional requirements, ## Out of scope, ## Open questions.

Base content on the project context and any prior draft + feedback provided. Be concrete and testable.`;

/** System prompt for PRD / requirements document (openai-compatible chat) when no seat context is available. */
export const PRD_DOC_SYSTEM = `You are an experienced product manager. ${PRD_DOCUMENT_STRUCTURE_APPENDIX}`;
