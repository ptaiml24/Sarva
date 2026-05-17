import { describe, it, expect } from "vitest";
import {
  composeBoardPlanSystemPromptForSeat,
  composeDesignSystemPromptForSeat,
  composeImplementationSystemPromptForSeat,
  composePrdSystemPromptForSeat,
  composeReviewHandoffSystemPromptForSeat,
  seatHasCoderSkill,
} from "./composeSeatTaskPrompt.js";
import {
  CODER_IMPLEMENTATION_OUTPUT_APPENDIX,
  CODER_SKILL_AGENT_PROMPT,
  DEFAULT_CODER_IMPLEMENTATION_SYSTEM_PROMPT,
} from "./coder.js";
import { CODE_REVIEWER_SKILL_AGENT_PROMPT } from "./code-reviewer.js";
import { ANALYZER_SKILL_AGENT_PROMPT } from "./analyzer.js";
import { TECH_DOC_WRITER_SKILL_AGENT_PROMPT } from "./tech-doc-writer.js";
import { DOC_WRITER_SKILL_AGENT_PROMPT } from "./doc-writer.js";
import { PRD_DOC_SYSTEM, PRD_DOCUMENT_STRUCTURE_APPENDIX } from "../pm-prompts.js";
import { DESIGN_DOC_SYSTEM, DESIGN_DOCUMENT_STRUCTURE_APPENDIX } from "../architect-prompts.js";
import { BOARD_PLAN_SYSTEM, SDM_REVIEW_HANDOFF_SYSTEM } from "../sdm-prompts.js";

describe("composeImplementationSystemPromptForSeat", () => {
  it("matches default folder prompt when seat has no skills", () => {
    expect(composeImplementationSystemPromptForSeat(null)).toBe(DEFAULT_CODER_IMPLEMENTATION_SYSTEM_PROMPT);
    expect(composeImplementationSystemPromptForSeat({ skillLinks: [] })).toBe(
      DEFAULT_CODER_IMPLEMENTATION_SYSTEM_PROMPT
    );
  });

  it("includes CODER built-in and supplemental CODE_REVIEWER when both are on the seat", () => {
    const r = composeImplementationSystemPromptForSeat({
      skillLinks: [
        {
          skillTemplate: {
            code: "CODE_REVIEWER",
            agentPrompt: null,
            sortOrder: 20,
          },
        },
        {
          skillTemplate: {
            code: "CODER",
            agentPrompt: null,
            sortOrder: 10,
          },
        },
      ],
    });
    expect(r).toContain(CODER_SKILL_AGENT_PROMPT);
    expect(r).toContain("## Seat skill: CODE_REVIEWER");
    expect(r).toContain(CODE_REVIEWER_SKILL_AGENT_PROMPT);
    expect(r).toContain(CODER_IMPLEMENTATION_OUTPUT_APPENDIX);
  });

  it("respects custom CODER agent_prompt on the seat", () => {
    const custom = "SEAT_SPECIFIC_CODER_RULES";
    const r = composeImplementationSystemPromptForSeat({
      skillLinks: [{ skillTemplate: { code: "CODER", agentPrompt: custom, sortOrder: 0 } }],
    });
    expect(r).toContain(custom);
    expect(r).toContain(CODER_IMPLEMENTATION_OUTPUT_APPENDIX);
  });

  it("seatHasCoderSkill", () => {
    expect(seatHasCoderSkill(null)).toBe(false);
    expect(
      seatHasCoderSkill({
        skillLinks: [{ skillTemplate: { code: "CODER", agentPrompt: null, sortOrder: 0 } }],
      })
    ).toBe(true);
  });
});

describe("composePrdSystemPromptForSeat", () => {
  it("falls back to full PM doc system when no seat", () => {
    expect(composePrdSystemPromptForSeat(null)).toBe(PRD_DOC_SYSTEM);
    expect(composePrdSystemPromptForSeat({ skillLinks: [] })).toBe(PRD_DOC_SYSTEM);
  });

  it("uses DOC_WRITER primary and PRD appendix when seat has skills", () => {
    const r = composePrdSystemPromptForSeat({
      skillLinks: [{ skillTemplate: { code: "DOC_WRITER", agentPrompt: null, sortOrder: 0 } }],
    });
    expect(r).toContain("## Primary: product requirements");
    expect(r).toContain(DOC_WRITER_SKILL_AGENT_PROMPT);
    expect(r).toContain(PRD_DOCUMENT_STRUCTURE_APPENDIX);
  });
});

describe("composeDesignSystemPromptForSeat", () => {
  it("falls back when no seat", () => {
    expect(composeDesignSystemPromptForSeat(null)).toBe(DESIGN_DOC_SYSTEM);
  });

  it("prefers TECH_DOC_WRITER and appends design structure", () => {
    const r = composeDesignSystemPromptForSeat({
      skillLinks: [{ skillTemplate: { code: "TECH_DOC_WRITER", agentPrompt: null, sortOrder: 0 } }],
    });
    expect(r).toContain("## Primary: technical design documentation");
    expect(r).toContain(TECH_DOC_WRITER_SKILL_AGENT_PROMPT);
    expect(r).toContain(DESIGN_DOCUMENT_STRUCTURE_APPENDIX);
  });
});

describe("composeBoardPlanSystemPromptForSeat", () => {
  it("falls back to BOARD_PLAN_SYSTEM only when empty", () => {
    expect(composeBoardPlanSystemPromptForSeat(null)).toBe(BOARD_PLAN_SYSTEM);
  });

  it("prefixes seat skills then full board JSON contract", () => {
    const r = composeBoardPlanSystemPromptForSeat({
      skillLinks: [{ skillTemplate: { code: "ANALYZER", agentPrompt: null, sortOrder: 0 } }],
    });
    expect(r).toContain("## Primary: delivery planning");
    expect(r).toContain(ANALYZER_SKILL_AGENT_PROMPT);
    expect(r).toContain(BOARD_PLAN_SYSTEM);
  });
});

describe("composeReviewHandoffSystemPromptForSeat", () => {
  it("falls back when empty", () => {
    expect(composeReviewHandoffSystemPromptForSeat(null)).toBe(SDM_REVIEW_HANDOFF_SYSTEM);
  });

  it("uses CODE_REVIEWER primary and appends handoff contract", () => {
    const r = composeReviewHandoffSystemPromptForSeat({
      skillLinks: [
        { skillTemplate: { code: "CODE_REVIEWER", agentPrompt: null, sortOrder: 0 } },
        { skillTemplate: { code: "ANALYZER", agentPrompt: null, sortOrder: 1 } },
      ],
    });
    expect(r).toContain("## Primary: review handoff");
    expect(r).toContain(CODE_REVIEWER_SKILL_AGENT_PROMPT);
    expect(r).toContain("## Seat skill: ANALYZER");
    expect(r).toContain(SDM_REVIEW_HANDOFF_SYSTEM);
  });
});
