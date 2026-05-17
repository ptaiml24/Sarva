/**
 * Builds LLM system prompts from a seat's linked skills (`role_skill_link` → `skill_template`)
 * and task kind. Copy always comes from `prompt/skills/*` defaults merged with DB `agent_prompt`
 * via `resolveSkillAgentPrompt` — no ad hoc persona strings here.
 */

import { resolveSkillAgentPrompt } from "../../config/defaultSkillPrompts.js";
import { DESIGN_DOCUMENT_STRUCTURE_APPENDIX, DESIGN_DOC_SYSTEM } from "../architect-prompts.js";
import { PRD_DOCUMENT_STRUCTURE_APPENDIX, PRD_DOC_SYSTEM } from "../pm-prompts.js";
import { BOARD_PLAN_SYSTEM, SDM_REVIEW_HANDOFF_SYSTEM } from "../sdm-prompts.js";
import {
  CODER_IMPLEMENTATION_OUTPUT_APPENDIX,
  DEFAULT_CODER_IMPLEMENTATION_SYSTEM_PROMPT,
} from "./coder.js";

const CODER = "CODER";

export type SeatSkillTemplateRef = {
  code: string;
  agentPrompt: string | null;
  sortOrder: number;
};

export type SeatForTaskPrompt = {
  skillLinks: { skillTemplate: SeatSkillTemplateRef }[];
} | null;

type SkillLinkRow = NonNullable<NonNullable<SeatForTaskPrompt>["skillLinks"]>[number];

function sortedLinks(links: SkillLinkRow[]): SkillLinkRow[] {
  return [...links].sort((a, b) => a.skillTemplate.sortOrder - b.skillTemplate.sortOrder);
}

function composePrimaryPlusSupplemental(params: {
  links: SkillLinkRow[];
  /** First matching skill on seat becomes primary; else `fallbackPrimaryCode` built-in is used. */
  preference: string[];
  fallbackPrimaryCode: string;
  primaryHeading: string;
}): string {
  const sorted = sortedLinks(params.links);
  const by = new Map(sorted.map((l) => [l.skillTemplate.code.toUpperCase(), l] as const));
  let primaryLink: SkillLinkRow | undefined;
  for (const pref of params.preference) {
    primaryLink = by.get(pref.toUpperCase());
    if (primaryLink) break;
  }
  const primaryBody = primaryLink
    ? resolveSkillAgentPrompt(primaryLink.skillTemplate.code, primaryLink.skillTemplate.agentPrompt)
    : resolveSkillAgentPrompt(params.fallbackPrimaryCode, null);

  const rest =
    primaryLink ?
      sorted.filter(
        (l) => l.skillTemplate.code.toUpperCase() !== primaryLink!.skillTemplate.code.toUpperCase()
      )
    : sorted;

  const supplemental = rest.map((l) => {
    const st = l.skillTemplate;
    return `## Seat skill: ${st.code}\n\n${resolveSkillAgentPrompt(st.code, st.agentPrompt)}`;
  });

  const parts = [`${params.primaryHeading}\n\n${primaryBody}`, ...supplemental];
  return parts.join("\n\n---\n\n");
}

/** True when any linked skill template has code **CODER** (minimal shape for list/eligibility callers). */
export function seatSkillLinksIncludeCoder(
  links: { skillTemplate: { code: string } }[] | undefined | null
): boolean {
  return links?.some((l) => l.skillTemplate.code.toUpperCase() === CODER) ?? false;
}

/** True if the seat explicitly links the Coder skill (unlocks implementation LLM for TPM/QA-type role templates). */
export function seatHasCoderSkill(targetRole: SeatForTaskPrompt): boolean {
  return seatSkillLinksIncludeCoder(targetRole?.skillLinks);
}

/**
 * System prompt for **implementation / run-coder**: primary Coder persona (seat override or built-in from
 * `coder.ts`) plus every other seat skill as supplemental context, then the shared Markdown output appendix.
 *
 * If the seat has no `CODER` link, the primary block still uses the catalog **CODER** built-in so the workflow stays consistent;
 * supplemental sections list any other skills on the seat (code review, docs, etc.).
 */
export function composeImplementationSystemPromptForSeat(targetRole: SeatForTaskPrompt): string {
  const links = [...(targetRole?.skillLinks ?? [])].sort(
    (a, b) => a.skillTemplate.sortOrder - b.skillTemplate.sortOrder
  );

  if (links.length === 0) {
    return DEFAULT_CODER_IMPLEMENTATION_SYSTEM_PROMPT;
  }

  const merged = composePrimaryPlusSupplemental({
    links,
    preference: [CODER],
    fallbackPrimaryCode: CODER,
    primaryHeading: "## Primary task: implementation (Coder skill)",
  });
  return `${merged}\n\n---\n${CODER_IMPLEMENTATION_OUTPUT_APPENDIX}`;
}

/** PRD generation — primary: analyzer/doc skills; then SDM-style delivery appendix for document shape. */
export function composePrdSystemPromptForSeat(seat: SeatForTaskPrompt | null): string {
  if (!seat?.skillLinks?.length) {
    return PRD_DOC_SYSTEM;
  }
  const merged = composePrimaryPlusSupplemental({
    links: seat.skillLinks,
    preference: [
      "DOC_WRITER",
      "STRATEGIST",
      "DOCUMENT_REVIEWER",
      "STORYTELLER",
      "ANALYZER",
      "VISIONARY",
      "PRIORITIZER",
      "RESEARCHER",
    ],
    fallbackPrimaryCode: "DOC_WRITER",
    primaryHeading: "## Primary: product requirements",
  });
  return `${merged}\n\n---\n${PRD_DOCUMENT_STRUCTURE_APPENDIX}`;
}

/** Design artifact generation — primary: technical writer / analyzer; then architecture section contract. */
export function composeDesignSystemPromptForSeat(seat: SeatForTaskPrompt | null): string {
  if (!seat?.skillLinks?.length) {
    return DESIGN_DOC_SYSTEM;
  }
  const merged = composePrimaryPlusSupplemental({
    links: seat.skillLinks,
    preference: ["TECH_DOC_WRITER", "ARCHITECT", "ANALYZER", "STRATEGIST", "DOC_WRITER"],
    fallbackPrimaryCode: "TECH_DOC_WRITER",
    primaryHeading: "## Primary: technical design documentation",
  });
  return `${merged}\n\n---\n${DESIGN_DOCUMENT_STRUCTURE_APPENDIX}`;
}

/** Board JSON planning — primary: analysis skills; then full SDM board JSON contract. */
export function composeBoardPlanSystemPromptForSeat(seat: SeatForTaskPrompt | null): string {
  if (!seat?.skillLinks?.length) {
    return BOARD_PLAN_SYSTEM;
  }
  const merged = composePrimaryPlusSupplemental({
    links: seat.skillLinks,
    preference: [
      "PLANNER",
      "COORDINATOR",
      "SCHEDULER",
      "TRACKER",
      "MITIGATOR",
      "ARCHITECT",
      "TECH_DOC_WRITER",
      "DOC_WRITER",
      "ANALYZER",
      CODER,
    ],
    fallbackPrimaryCode: "PLANNER",
    primaryHeading: "## Primary: delivery planning",
  });
  return `${merged}\n\n---\n${BOARD_PLAN_SYSTEM}`;
}

/** Review handoff markdown — primary: reviewer skill; then SDM handoff instructions. */
export function composeReviewHandoffSystemPromptForSeat(seat: SeatForTaskPrompt | null): string {
  if (!seat?.skillLinks?.length) {
    return SDM_REVIEW_HANDOFF_SYSTEM;
  }
  const merged = composePrimaryPlusSupplemental({
    links: seat.skillLinks,
    preference: ["CODE_REVIEWER", "DOCUMENT_REVIEWER", "ANALYZER", "ARCHITECT"],
    fallbackPrimaryCode: "CODE_REVIEWER",
    primaryHeading: "## Primary: review handoff",
  });
  return `${merged}\n\n---\n${SDM_REVIEW_HANDOFF_SYSTEM}`;
}
