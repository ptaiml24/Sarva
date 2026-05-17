import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { loadEnv } from "../config/env.js";
import { prisma } from "../lib/prisma.js";
import { recordAudit } from "../lib/audit.js";

describe("GET /api/v1/projects/:projectId/audit-events", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let projectId: string;
  let token: string;
  let userId: string;

  beforeAll(async () => {
    process.env.JWT_SECRET ??= "test-secret-32-chars-minimum-x";
    const env = loadEnv();
    app = await buildApp(env);

    const project = await prisma.project.create({
      data: { name: `vitest-audit-events-${Date.now()}`, repoAssociationMode: "dedicated_repo" },
    });
    projectId = project.id;

    const email = `vitest-audit-events-${Date.now()}@sarva.test`;
    const login = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email, role: "operator" },
    });
    expect(login.statusCode).toBe(200);
    token = (login.json() as { token: string }).token;
    const user = await prisma.user.findFirstOrThrow({ where: { email } });
    userId = user.id;

    await recordAudit(userId, "project.delivery.proceed", `project:${projectId}`);
    await recordAudit(userId, "project.delivery.close", `project:${projectId}`);
    await recordAudit(userId, "company.update", `company:other`);
  });

  afterAll(async () => {
    await prisma.project.delete({ where: { id: projectId } }).catch(() => undefined);
    await app.close();
  });

  it("returns audit rows for the project resource prefix", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/audit-events`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      items: { action: string; resourceRef: string; actor: { email: string } }[];
    };
    expect(body.items.length).toBeGreaterThanOrEqual(2);
    expect(body.items.every((i) => i.resourceRef.startsWith(`project:${projectId}`))).toBe(true);
    expect(body.items.some((i) => i.action === "project.delivery.proceed")).toBe(true);
    expect(body.items.some((i) => i.action === "project.delivery.close")).toBe(true);
    expect(body.items.some((i) => i.resourceRef.startsWith("company:"))).toBe(false);
  });
});
