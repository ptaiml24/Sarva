import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { buildApp } from "../app.js";
import { loadEnv } from "../config/env.js";
import { prisma } from "../lib/prisma.js";

describe("POST /api/v1/projects/:projectId/verify-dry-run", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let projectId: string;
  let token: string;

  beforeAll(async () => {
    process.env.JWT_SECRET ??= "test-secret-32-chars-minimum-x";
    const env = loadEnv();
    app = await buildApp(env);

    const project = await prisma.project.create({
      data: { name: `vitest-verify-${Date.now()}`, repoAssociationMode: "dedicated_repo" },
    });
    projectId = project.id;

    const login = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: `vitest-verify-${Date.now()}@sarva.test`, role: "operator" },
    });
    expect(login.statusCode).toBe(200);
    token = (login.json() as { token: string }).token;
  });

  afterAll(async () => {
    await prisma.project.delete({ where: { id: projectId } }).catch(() => undefined);
    await app.close();
  });

  it("returns skipped when pre_push_verify is disabled", async () => {
    await prisma.project.update({
      where: { id: projectId },
      data: { deliveryPolicy: { prePushVerify: { enabled: false } } },
    });
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/verify-dry-run`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { ok: boolean; skipped?: boolean; reason?: string };
    expect(body.ok).toBe(true);
    expect(body.skipped).toBe(true);
    expect(body.reason).toBe("pre_push_verify_disabled");
  });

  it("runs configured commands when enabled", async () => {
    const node = process.execPath;
    await prisma.project.update({
      where: { id: projectId },
      data: { deliveryPolicy: { prePushVerify: { enabled: true, commands: [`${node} -e process.exit(0)`] } } },
    });
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/verify-dry-run`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { ok: boolean; results?: { cmd: string; exitCode: number }[] };
    expect(body.ok).toBe(true);
    expect(body.results?.length).toBeGreaterThanOrEqual(1);
    expect(body.results?.[0]?.exitCode).toBe(0);
  });

  it("returns 400 for invalid project id", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/projects/not-a-uuid/verify-dry-run",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(400);
  });
});
