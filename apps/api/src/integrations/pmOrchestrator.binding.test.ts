import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "../lib/prisma.js";
import { findBindingForPropose, listBindingsForProposeFallthrough } from "./pmOrchestrator.js";

/**
 * Real Postgres: validates seat → agent → company tier order and `priority` within tier.
 */
describe("pmOrchestrator binding resolution", () => {
  let companyId: string;
  let connectionId: string;
  let teamId: string;
  let roleId: string;
  let agentId: string;
  const bindingIds: string[] = [];

  beforeAll(async () => {
    const company = await prisma.company.create({
      data: { name: `vitest-mb-co-${Date.now()}`, settings: {} },
    });
    companyId = company.id;

    const conn = await prisma.llmProviderConnection.create({
      data: {
        companyId,
        name: `vitest-mb-${Date.now()}`,
        provider: "openai",
        modelId: "gpt-4o-mini",
        baseUrl: null,
        apiKey: null,
      },
    });
    connectionId = conn.id;

    const team = await prisma.team.create({
      data: { name: `vitest-mb-team-${Date.now()}` },
    });
    teamId = team.id;

    const role = await prisma.role.create({
      data: {
        teamId,
        name: "Vitest seat",
        roleTemplateId: null,
      },
    });
    roleId = role.id;

    const agent = await prisma.agent.create({
      data: { name: `vitest-mb-agent-${Date.now()}`, status: "active" },
    });
    agentId = agent.id;

    const mkBinding = async (data: Parameters<typeof prisma.modelBinding.create>[0]["data"]) => {
      const row = await prisma.modelBinding.create({ data });
      bindingIds.push(row.id);
      return row;
    };

    await mkBinding({
      roleId,
      llmProviderConnectionId: connectionId,
      modelId: "role-model-p1",
      priority: 1,
    });
    await mkBinding({
      roleId,
      llmProviderConnectionId: connectionId,
      modelId: "role-model-p2",
      priority: 2,
    });
    await mkBinding({
      agentId,
      llmProviderConnectionId: connectionId,
      modelId: "agent-model",
      priority: 0,
    });
    await mkBinding({
      companyId,
      agentId: null,
      roleId: null,
      skillId: null,
      llmProviderConnectionId: connectionId,
      modelId: "company-model",
      priority: 0,
    });
  });

  afterAll(async () => {
    if (bindingIds.length) {
      await prisma.modelBinding.deleteMany({ where: { id: { in: bindingIds } } });
    }
    await prisma.agent.delete({ where: { id: agentId } }).catch(() => undefined);
    await prisma.role.delete({ where: { id: roleId } }).catch(() => undefined);
    await prisma.team.delete({ where: { id: teamId } }).catch(() => undefined);
    await prisma.llmProviderConnection.delete({ where: { id: connectionId } }).catch(() => undefined);
    await prisma.company.delete({ where: { id: companyId } }).catch(() => undefined);
  });

  it("prefers role binding over agent when roleId option is set", async () => {
    const b = await findBindingForPropose(agentId, companyId, { roleId });
    expect(b?.modelId).toBe("role-model-p1");
  });

  it("uses agent binding before company when roleId is absent", async () => {
    const b = await findBindingForPropose(agentId, companyId, undefined);
    expect(b?.modelId).toBe("agent-model");
  });

  it("listBindingsForProposeFallthrough orders role rows, then agent, then company", async () => {
    const list = await listBindingsForProposeFallthrough(agentId, companyId, { roleId });
    expect(list.map((x) => x.modelId)).toEqual([
      "role-model-p1",
      "role-model-p2",
      "agent-model",
      "company-model",
    ]);
  });
});
