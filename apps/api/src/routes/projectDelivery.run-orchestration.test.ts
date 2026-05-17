import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { loadEnv } from "../config/env.js";
import { prisma } from "../lib/prisma.js";

describe("POST /api/v1/projects/:projectId/delivery/run-orchestration", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let token: string;
  let projectId: string;

  beforeAll(async () => {
    app = await buildApp(loadEnv());
    const project = await prisma.project.create({
      data: { name: `vitest-run-orch-${Date.now()}`, repoAssociationMode: "dedicated_repo" },
    });
    projectId = project.id;

    const login = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: `vitest-run-orch-${Date.now()}@sarva.test`, role: "operator" },
    });
    expect(login.statusCode).toBe(200);
    token = (login.json() as { token: string }).token;
  });

  afterAll(async () => {
    await prisma.project.delete({ where: { id: projectId } }).catch(() => undefined);
    await app.close();
  });

  it("returns 409 when executionKickoffAt is absent (Begin execution prerequisite)", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/delivery/run-orchestration`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(409);
    const body = res.json() as { error?: { code?: string } };
    expect(body.error?.code).toBe("INVALID_STATE");
  });
});
