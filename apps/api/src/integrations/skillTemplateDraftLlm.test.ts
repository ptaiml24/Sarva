import { describe, expect, it } from "vitest";
import { parseSkillTemplateDraftReply } from "./skillTemplateDraftLlm.js";

describe("parseSkillTemplateDraftReply", () => {
  it("parses raw JSON object", () => {
    const raw =
      '{"label":"Compliance checklist","agentPrompt":"Assist with SOC2 evidence. Ask for gaps. Produce tables when useful."}';
    const out = parseSkillTemplateDraftReply(raw);
    expect(out.label).toBe("Compliance checklist");
    expect(out.agentPrompt.startsWith("Assist with SOC2")).toBe(true);
  });

  it("strips markdown fences", () => {
    const body = `\`\`\`json\n{"label":"X","agentPrompt":"${"y".repeat(20)}"}\n\`\`\``;
    const out = parseSkillTemplateDraftReply(body);
    expect(out.label).toBe("X");
    expect(out.agentPrompt.length).toBeGreaterThanOrEqual(16);
  });
});
