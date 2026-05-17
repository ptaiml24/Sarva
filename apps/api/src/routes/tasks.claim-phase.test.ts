import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { buildApp } from "../app.js";
import { loadEnv } from "../config/env.js";
import { prisma } from "../lib/prisma.js";

describe("POST /api/v1/tasks/:taskId/claim execution phase gate", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let projectId: string;
  let token: string;
  let agentId: string;
  let phase0Id: string;
  let phase1Id: string;

  beforeAll(async () => {
    process.env.JWT_SECRET ??= "test-secret-32-chars-minimum-x";
    const env = loadEnv();
    app = await buildApp(env);

    const agent = await prisma.agent.create({
      data: { name: `vitest-phase-agent-${Date.now()}`, status: "active" },
    });
    agentId = agent.id;

    const project = await prisma.project.create({
      data: { name: `vitest-phase-${Date.now()}`, repoAssociationMode: "dedicated_repo" },
    });
    projectId = project.id;

    const t0 = await prisma.task.create({
      data: { projectId, title: "Setup repo", state: "todo", executionPhase: 0, version: 1 },
    });
    phase0Id = t0.id;
    const t1 = await prisma.task.create({
      data: { projectId, title: "Feature A", state: "todo", executionPhase: 1, version: 1 },
    });
    phase1Id = t1.id;

    const login = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: `vitest-phase-${Date.now()}@sarva.test`, role: "operator" },
    });
    expect(login.statusCode).toBe(200);
    token = (login.json() as { token: string }).token;
  });

  afterAll(async () => {
    await prisma.project.delete({ where: { id: projectId } }).catch(() => undefined);
    await prisma.agent.delete({ where: { id: agentId } }).catch(() => undefined);
    await app.close();
  });

  it("blocks claim on phase 1 while phase 0 is not done", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/tasks/${phase1Id}/claim`,
      headers: { authorization: `Bearer ${token}` },
      payload: { assigneeAgentId: agentId, expectedVersion: 1 },
    });
    expect(res.statusCode).toBe(409);
    const j = res.json() as { error: { code: string } };
    expect(j.error.code).toBe("TASK_PHASE_GATE");
  });

  it("allows claim on phase 1 after all lower-phase tasks are done", async () => {
    await prisma.task.update({
      where: { id: phase0Id },
      data: { state: "done", version: { increment: 1 } },
    });

    const res = await app.inject({
      method: "POST",
      url: `/api/v1/tasks/${phase1Id}/claim`,
      headers: { authorization: `Bearer ${token}` },
      payload: { assigneeAgentId: agentId, expectedVersion: 1 },
    });
    expect(res.statusCode).toBe(200);
    const j = res.json() as { task: { state: string } };
    expect(j.task.state).toBe("in_progress");
  });
});
