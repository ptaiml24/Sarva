import { describe, it, expect } from "vitest";
import { resolveWorkflowAgentFromSnapshot, resolveWorkflowAgentExcludingAgent } from "./deliveryOrchestrationHub.js";
import type { PlanningAgent } from "./linkedTeamPlanningAgents.js";

function agent(id: string, seats: PlanningAgent["seats"]): PlanningAgent {
  return { id, name: id, seats, capabilitySummary: "" };
}

describe("deliveryOrchestrationHub", () => {
  it("code_review picks the strongest review skill among agents after excluding implementer", async () => {
    const impl = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const reviewer = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const peer = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const agents: PlanningAgent[] = [
      agent(impl, [
        {
          roleId: "10000000-0000-4000-8000-000000000001",
          teamName: "T",
          roleName: "Eng",
          roleTemplateCode: "ENGINEER",
          roleTemplateLabel: null,
          skillCodes: ["CODER"],
          skillLabels: [],
        },
      ]),
      agent(reviewer, [
        {
          roleId: "10000000-0000-4000-8000-000000000002",
          teamName: "T",
          roleName: "Rev",
          roleTemplateCode: "QA",
          roleTemplateLabel: null,
          skillCodes: ["CODE_REVIEWER"],
          skillLabels: [],
        },
      ]),
      agent(peer, [
        {
          roleId: "10000000-0000-4000-8000-000000000003",
          teamName: "T",
          roleName: "Peer",
          roleTemplateCode: "ENGINEER",
          roleTemplateLabel: null,
          skillCodes: ["CODER"],
          skillLabels: [],
        },
      ]),
    ];

    const r = await resolveWorkflowAgentExcludingAgent("p", "code_review", impl, {
      snapshot: { projectId: "p", agents },
      logger: { info: () => {} },
    });
    expect(r.skillMatchAgentId).toBe(reviewer);
    expect(r.routing).toBe("skill_match");
    expect(r.skillScore).toBeGreaterThan(0);
  });

  it("code_review falls back through scorer when no dedicated reviewer (CODER-weighted peer)", () => {
    const impl = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const peer = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const snap = {
      projectId: "p",
      agents: [
        agent(impl, [
          {
            roleId: "10000000-0000-4000-8000-000000000001",
            teamName: "T",
            roleName: "Eng",
            roleTemplateCode: "ENGINEER",
            roleTemplateLabel: null,
            skillCodes: ["CODER"],
            skillLabels: [],
          },
        ]),
        agent(peer, [
          {
            roleId: "10000000-0000-4000-8000-000000000003",
            teamName: "T",
            roleName: "Peer",
            roleTemplateCode: "ENGINEER",
            roleTemplateLabel: null,
            skillCodes: ["CODER"],
            skillLabels: [],
          },
        ]),
      ].filter((a) => a.id !== impl),
    };
    const r = resolveWorkflowAgentFromSnapshot(snap, "code_review");
    expect(r.skillMatchAgentId).toBe(peer);
  });
});
