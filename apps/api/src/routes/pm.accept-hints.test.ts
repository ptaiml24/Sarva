import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { buildApp } from "../app.js";
import { loadEnv } from "../config/env.js";
import { prisma } from "../lib/prisma.js";

describe("POST proposed-backlog accept + dependency hints", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let projectId: string;
  let token: string;
  let propA: string;
  let propB: string;

  beforeAll(async () => {
    process.env.JWT_SECRET ??= "test-secret-32-chars-minimum-x";
    const env = loadEnv();
    app = await buildApp(env);

    const project = await prisma.project.create({
      data: { name: `vitest-pm-hints-${Date.now()}`, repoAssociationMode: "dedicated_repo" },
    });
    projectId = project.id;

    const a = await prisma.proposedBacklogItem.create({
      data: {
        projectId,
        source: "test",
        status: "draft",
        payload: { title: "Alpha root", description: "", phase: 0 },
      },
    });
    propA = a.id;
    const b = await prisma.proposedBacklogItem.create({
      data: {
        projectId,
        source: "test",
        status: "draft",
        payload: {
          title: "Beta child",
          description: "",
          phase: 0,
          dependsOnTitles: ["Alpha root"],
        },
      },
    });
    propB = b.id;

    const login = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: `vitest-pmh-${Date.now()}@sarva.test`, role: "operator" },
    });
    expect(login.statusCode).toBe(200);
    token = (login.json() as { token: string }).token;
  });

  afterAll(async () => {
    await prisma.project.delete({ where: { id: projectId } }).catch(() => undefined);
    await app.close();
  });

  it("creates dependency when accepting blocked draft first then predecessor", async () => {
    const acceptB = await app.inject({
      method: "POST",
      url: `/api/v1/proposed-backlog-items/${propB}/accept`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(acceptB.statusCode).toBe(200);
    const taskB = (acceptB.json() as { task: { id: string } }).task;
    const hintsOnly = await prisma.task.findUnique({
      where: { id: taskB.id },
      select: { dependencyHints: true },
    });
    expect(hintsOnly?.dependencyHints).toEqual({ dependsOnTitles: ["Alpha root"] });

    const depsBefore = await prisma.taskDependency.count({ where: { successorTaskId: taskB.id } });
    expect(depsBefore).toBe(0);

    const acceptA = await app.inject({
      method: "POST",
      url: `/api/v1/proposed-backlog-items/${propA}/accept`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(acceptA.statusCode).toBe(200);
    const taskA = (acceptA.json() as { task: { id: string } }).task;

    const dep = await prisma.taskDependency.findFirst({
      where: { successorTaskId: taskB.id, predecessorTaskId: taskA.id },
    });
    expect(dep).toBeTruthy();

    const hintsCleared = await prisma.task.findUnique({
      where: { id: taskB.id },
      select: { dependencyHints: true },
    });
    expect(hintsCleared?.dependencyHints).toBeNull();
  });
});
