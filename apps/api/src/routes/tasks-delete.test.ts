import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { buildApp } from "../app.js";
import { loadEnv } from "../config/env.js";
import { prisma } from "../lib/prisma.js";

describe("DELETE /api/v1/tasks/:taskId board cleanup", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let projectId: string;
  let backlogTaskId: string;
  let inProgressTaskId: string;
  let token: string;

  beforeAll(async () => {
    process.env.JWT_SECRET ??= "test-secret-32-chars-minimum-x";
    const env = loadEnv();
    app = await buildApp(env);

    const project = await prisma.project.create({
      data: { name: `vitest-task-del-${Date.now()}`, repoAssociationMode: "dedicated_repo" },
    });
    projectId = project.id;
    const a = await prisma.task.create({
      data: { projectId, title: "Backlog row", state: "backlog", version: 1 },
    });
    backlogTaskId = a.id;
    const b = await prisma.task.create({
      data: { projectId, title: "In progress row", state: "in_progress", version: 1 },
    });
    inProgressTaskId = b.id;

    const login = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: `vitest-task-del-${Date.now()}@sarva.test`, role: "operator" },
    });
    expect(login.statusCode).toBe(200);
    token = (login.json() as { token: string }).token;
  });

  afterAll(async () => {
    await prisma.project.delete({ where: { id: projectId } }).catch(() => undefined);
    await app.close();
  });

  it("deletes backlog task and returns 204", async () => {
    const res = await app.inject({
      method: "DELETE",
      url: `/api/v1/tasks/${backlogTaskId}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(204);
    const gone = await prisma.task.findUnique({ where: { id: backlogTaskId } });
    expect(gone).toBeNull();
  });

  it("rejects deleting in_progress task", async () => {
    const res = await app.inject({
      method: "DELETE",
      url: `/api/v1/tasks/${inProgressTaskId}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(409);
    const still = await prisma.task.findUnique({ where: { id: inProgressTaskId } });
    expect(still).not.toBeNull();
  });
});
