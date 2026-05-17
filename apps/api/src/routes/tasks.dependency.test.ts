import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { buildApp } from "../app.js";
import { loadEnv } from "../config/env.js";
import { prisma } from "../lib/prisma.js";
import { dependencyEdgesHaveCycle, dependencyHasInvalidPhaseOrdering } from "../lib/taskDependency.js";

describe("task dependencies", () => {
  it("detects a simple cycle", () => {
    const a = "00000000-0000-4000-8000-000000000001";
    const b = "00000000-0000-4000-8000-000000000002";
    expect(
      dependencyEdgesHaveCycle([
        { successorTaskId: b, predecessorTaskId: a },
        { successorTaskId: a, predecessorTaskId: b },
      ])
    ).toBe(true);
  });

  it("flags predecessor in a later execution phase than successor", () => {
    expect(dependencyHasInvalidPhaseOrdering(2, 3)).toBe(false);
    expect(dependencyHasInvalidPhaseOrdering(3, 3)).toBe(false);
    expect(dependencyHasInvalidPhaseOrdering(3, 2)).toBe(true);
  });

  it("allows a DAG chain", () => {
    const a = "00000000-0000-4000-8000-000000000011";
    const b = "00000000-0000-4000-8000-000000000012";
    const c = "00000000-0000-4000-8000-000000000013";
    expect(
      dependencyEdgesHaveCycle([
        { successorTaskId: b, predecessorTaskId: a },
        { successorTaskId: c, predecessorTaskId: b },
      ])
    ).toBe(false);
  });
});

describe("POST /api/v1/tasks/:taskId/claim dependency gate", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let projectId: string;
  let token: string;
  let agentId: string;
  let t1: string;
  let t2: string;

  beforeAll(async () => {
    process.env.JWT_SECRET ??= "test-secret-32-chars-minimum-x";
    const env = loadEnv();
    app = await buildApp(env);

    const agent = await prisma.agent.create({
      data: { name: `vitest-dep-agent-${Date.now()}`, status: "active" },
    });
    agentId = agent.id;

    const project = await prisma.project.create({
      data: { name: `vitest-dep-${Date.now()}`, repoAssociationMode: "dedicated_repo" },
    });
    projectId = project.id;

    const a = await prisma.task.create({
      data: { projectId, title: "First", state: "todo", executionPhase: 0, version: 1 },
    });
    t1 = a.id;
    const b = await prisma.task.create({
      data: { projectId, title: "Second", state: "todo", executionPhase: 0, version: 1 },
    });
    t2 = b.id;

    await prisma.taskDependency.create({
      data: { successorTaskId: t2, predecessorTaskId: t1 },
    });

    const login = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: `vitest-dep-${Date.now()}@sarva.test`, role: "operator" },
    });
    expect(login.statusCode).toBe(200);
    token = (login.json() as { token: string }).token;
  });

  afterAll(async () => {
    await prisma.project.delete({ where: { id: projectId } }).catch(() => undefined);
    await prisma.agent.delete({ where: { id: agentId } }).catch(() => undefined);
    await app.close();
  });

  it("blocks claim when predecessors are not done", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/tasks/${t2}/claim`,
      headers: { authorization: `Bearer ${token}` },
      payload: { assigneeAgentId: agentId, expectedVersion: 1 },
    });
    expect(res.statusCode).toBe(409);
    const j = res.json() as { error: { code: string } };
    expect(j.error.code).toBe("TASK_DEPENDENCY_GATE");
  });

  it("allows claim after all predecessors are done", async () => {
    await prisma.task.update({
      where: { id: t1 },
      data: { state: "done", version: { increment: 1 } },
    });

    const res = await app.inject({
      method: "POST",
      url: `/api/v1/tasks/${t2}/claim`,
      headers: { authorization: `Bearer ${token}` },
      payload: { assigneeAgentId: agentId, expectedVersion: 1 },
    });
    expect(res.statusCode).toBe(200);
    const j = res.json() as { task: { state: string } };
    expect(j.task.state).toBe("in_progress");
  });
});

describe("PUT /api/v1/tasks/:taskId/predecessors", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let projectId: string;
  let token: string;
  let ta: string;
  let tb: string;
  let tc: string;

  beforeAll(async () => {
    process.env.JWT_SECRET ??= "test-secret-32-chars-minimum-x";
    const env = loadEnv();
    app = await buildApp(env);

    const project = await prisma.project.create({
      data: { name: `vitest-pred-put-${Date.now()}`, repoAssociationMode: "dedicated_repo" },
    });
    projectId = project.id;

    const tasks = await Promise.all([
      prisma.task.create({
        data: { projectId, title: "A", state: "backlog", executionPhase: 0, version: 1 },
      }),
      prisma.task.create({
        data: { projectId, title: "B", state: "backlog", executionPhase: 0, version: 1 },
      }),
      prisma.task.create({
        data: { projectId, title: "C", state: "backlog", executionPhase: 0, version: 1 },
      }),
    ]);
    ta = tasks[0]!.id;
    tb = tasks[1]!.id;
    tc = tasks[2]!.id;

    const login = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: `vitest-pred-${Date.now()}@sarva.test`, role: "admin" },
    });
    expect(login.statusCode).toBe(200);
    token = (login.json() as { token: string }).token;
  });

  afterAll(async () => {
    await prisma.project.delete({ where: { id: projectId } }).catch(() => undefined);
    await app.close();
  });

  it("rejects a cyclic dependency", async () => {
    await prisma.taskDependency.createMany({
      data: [
        { successorTaskId: tb, predecessorTaskId: ta },
        { successorTaskId: tc, predecessorTaskId: tb },
      ],
    });

    const res = await app.inject({
      method: "PUT",
      url: `/api/v1/tasks/${ta}/predecessors`,
      headers: { authorization: `Bearer ${token}` },
      payload: { predecessorTaskIds: [tc] },
    });
    expect(res.statusCode).toBe(400);
    const j = res.json() as { error: { code: string } };
    expect(j.error.code).toBe("DEPENDENCY_CYCLE");
  });

  it("rejects predecessor scheduled in a later execution phase than successor", async () => {
    const successor = await prisma.task.create({
      data: { projectId, title: "Wave2", state: "backlog", executionPhase: 2, version: 1 },
    });
    const latePred = await prisma.task.create({
      data: { projectId, title: "Wave3", state: "backlog", executionPhase: 3, version: 1 },
    });

    const res = await app.inject({
      method: "PUT",
      url: `/api/v1/tasks/${successor.id}/predecessors`,
      headers: { authorization: `Bearer ${token}` },
      payload: { predecessorTaskIds: [latePred.id] },
    });
    expect(res.statusCode).toBe(400);
    const phaseJ = res.json() as { error: { code: string } };
    expect(phaseJ.error.code).toBe("DEPENDENCY_PHASE_ORDER");
  });
});
