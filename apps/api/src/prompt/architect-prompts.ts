/**
 * Architecture / design documentation (design tab, design LLM).
 */

/** Design document section expectations (after primary skill persona when seat skills are composed). */
export const DESIGN_DOCUMENT_STRUCTURE_APPENDIX = `Write a concise design document in Markdown only (no outer code fences). Include: ## Context, ## Goals, ## Architecture overview, ## Key components, ## Data flows, ## Risks & mitigations, ## Open questions. Be specific to the project described.`;

/** System prompt for architecture / design markdown when no seat context is available. */
export const DESIGN_DOC_SYSTEM = `You are a senior software architect. ${DESIGN_DOCUMENT_STRUCTURE_APPENDIX}`;
