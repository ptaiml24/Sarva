import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { loadEnv } from "../config/env.js";
import { prisma } from "../lib/prisma.js";

describe("GET /api/v1/projects/:projectId/delivery/summary phase progress", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let token: string;
  let projectId: string;

  beforeAll(async () => {
    process.env.JWT_SECRET ??= "test-secret-32-chars-minimum-x";
    const env = loadEnv();
    app = await buildApp(env);

    const project = await prisma.project.create({
      data: { name: `vitest-delivery-summary-${Date.now()}`, repoAssociationMode: "dedicated_repo" },
    });
    projectId = project.id;

    await prisma.task.createMany({
      data: [
        { projectId, title: "phase0 done", state: "done", executionPhase: 0, version: 1 },
        { projectId, title: "phase1 todo", state: "todo", executionPhase: 1, version: 1 },
        {
          projectId,
          title: "phase1 blocked",
          state: "in_progress",
          executionPhase: 1,
          blockedReason: "waiting for external input",
          version: 1,
        },
        { projectId, title: "phase2 backlog", state: "backlog", executionPhase: 2, version: 1 },
      ],
    });

    const login = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: `vitest-delivery-summary-${Date.now()}@sarva.test`, role: "operator" },
    });
    expect(login.statusCode).toBe(200);
    token = (login.json() as { token: string }).token;
  });

  afterAll(async () => {
    await prisma.project.delete({ where: { id: projectId } }).catch(() => undefined);
    await app.close();
  });

  it("returns current phase and blockers needed to unlock next phase", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/delivery/summary`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      deliveryExecutionStarted: boolean;
      phaseProgress: {
        currentUnlockedPhase: number;
        nextPhase: number | null;
        canUnlockNextPhase: boolean;
        blockersCurrentPhase: { title: string }[];
        phases: {
          phase: number;
          counts: { backlog: number; todo: number; in_progress: number; review: number; done: number };
        }[];
      };
    };

    expect(body.deliveryExecutionStarted).toBe(false);
    expect(body.phaseProgress.currentUnlockedPhase).toBe(1);
    expect(body.phaseProgress.nextPhase).toBe(2);
    expect(body.phaseProgress.canUnlockNextPhase).toBe(false);
    expect(body.phaseProgress.blockersCurrentPhase.map((b) => b.title)).toEqual(
      expect.arrayContaining(["phase1 todo", "phase1 blocked"])
    );
    const phase1 = body.phaseProgress.phases.find((p) => p.phase === 1);
    expect(phase1?.counts.todo).toBe(1);
    expect(phase1?.counts.in_progress).toBe(1);
  });
});
