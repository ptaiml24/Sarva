import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { buildApp } from "../app.js";
import { loadEnv } from "../config/env.js";
import { prisma } from "../lib/prisma.js";

describe("PATCH /api/v1/tasks/:taskId linkedBranch / linkedPrUrl", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let projectId: string;
  let taskId: string;
  let token: string;

  beforeAll(async () => {
    process.env.JWT_SECRET ??= "test-secret-32-chars-minimum-x";
    const env = loadEnv();
    app = await buildApp(env);

    const project = await prisma.project.create({
      data: { name: `vitest-task-patch-${Date.now()}`, repoAssociationMode: "dedicated_repo" },
    });
    projectId = project.id;
    const task = await prisma.task.create({
      data: { projectId, title: "Branch link test", state: "todo", version: 1 },
    });
    taskId = task.id;

    const login = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: `vitest-task-${Date.now()}@sarva.test`, role: "operator" },
    });
    expect(login.statusCode).toBe(200);
    token = (login.json() as { token: string }).token;
  });

  afterAll(async () => {
    await prisma.project.delete({ where: { id: projectId } }).catch(() => undefined);
    await app.close();
  });

  it("sets and clears linkedBranch / linkedPrUrl with expectedVersion", async () => {
    const prUrl = "https://github.com/org/repo/pull/42";
    const patch1 = await app.inject({
      method: "PATCH",
      url: `/api/v1/tasks/${taskId}`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        expectedVersion: 1,
        linkedBranch: "feature/task-abc",
        linkedPrUrl: prUrl,
      },
    });
    expect(patch1.statusCode).toBe(200);
    const t1 = (patch1.json() as { task: { version: number; linkedBranch: string | null; linkedPrUrl: string | null } })
      .task;
    expect(t1.version).toBe(2);
    expect(t1.linkedBranch).toBe("feature/task-abc");
    expect(t1.linkedPrUrl).toBe(prUrl);

    const patch2 = await app.inject({
      method: "PATCH",
      url: `/api/v1/tasks/${taskId}`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        expectedVersion: 2,
        linkedBranch: null,
        linkedPrUrl: "",
      },
    });
    expect(patch2.statusCode).toBe(200);
    const t2 = (patch2.json() as { task: { linkedBranch: string | null; linkedPrUrl: string | null } }).task;
    expect(t2.linkedBranch).toBeNull();
    expect(t2.linkedPrUrl).toBeNull();

    const bad = await app.inject({
      method: "PATCH",
      url: `/api/v1/tasks/${taskId}`,
      headers: { authorization: `Bearer ${token}` },
      payload: { expectedVersion: 1, state: "todo" },
    });
    expect(bad.statusCode).toBe(409);
  });

  it("sets and clears blockedReason and escalationStrikes (R5)", async () => {
    const before = await prisma.task.findUniqueOrThrow({ where: { id: taskId } });
    const patch1 = await app.inject({
      method: "PATCH",
      url: `/api/v1/tasks/${taskId}`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        expectedVersion: before.version,
        blockedReason: "Waiting on dependency X",
        escalationStrikes: 2,
      },
    });
    expect(patch1.statusCode).toBe(200);
    const t1 = (patch1.json() as { task: { blockedReason: string | null; escalationStrikes: number; version: number } })
      .task;
    expect(t1.blockedReason).toBe("Waiting on dependency X");
    expect(t1.escalationStrikes).toBe(2);

    const patch2 = await app.inject({
      method: "PATCH",
      url: `/api/v1/tasks/${taskId}`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        expectedVersion: t1.version,
        blockedReason: null,
      },
    });
    expect(patch2.statusCode).toBe(200);
    const t2 = (patch2.json() as { task: { blockedReason: string | null } }).task;
    expect(t2.blockedReason).toBeNull();
  });

  it("updates executionPhase (delivery wave)", async () => {
    const waveTask = await prisma.task.create({
      data: {
        projectId,
        title: "Wave edit",
        state: "backlog",
        executionPhase: 5,
        version: 3,
      },
    });
    const res = await app.inject({
      method: "PATCH",
      url: `/api/v1/tasks/${waveTask.id}`,
      headers: { authorization: `Bearer ${token}` },
      payload: { expectedVersion: 3, executionPhase: 2 },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { task: { executionPhase: number; version: number } };
    expect(body.task.executionPhase).toBe(2);
    expect(body.task.version).toBe(4);
  });
});
