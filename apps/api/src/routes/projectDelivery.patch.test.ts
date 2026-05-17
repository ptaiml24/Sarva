import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { loadEnv } from "../config/env.js";
import { prisma } from "../lib/prisma.js";
import { IMPLEMENTATION_STATUS } from "../lib/projectDelivery.js";

describe("PATCH /api/v1/projects/:projectId/delivery", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let projectId: string;
  let token: string;

  beforeAll(async () => {
    process.env.JWT_SECRET ??= "test-secret-32-chars-minimum-x";
    const env = loadEnv();
    app = await buildApp(env);

    const project = await prisma.project.create({
      data: { name: `vitest-delivery-patch-${Date.now()}`, repoAssociationMode: "dedicated_repo" },
    });
    projectId = project.id;

    const login = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: `vitest-delivery-patch-${Date.now()}@sarva.test`, role: "operator" },
    });
    expect(login.statusCode).toBe(200);
    token = (login.json() as { token: string }).token;
  });

  afterAll(async () => {
    await prisma.project.delete({ where: { id: projectId } }).catch(() => undefined);
    await app.close();
  });

  it("returns 409 when closing from draft", async () => {
    await prisma.project.update({
      where: { id: projectId },
      data: { implementationStatus: IMPLEMENTATION_STATUS.DRAFT, readyForUat: false },
    });
    const res = await app.inject({
      method: "PATCH",
      url: `/api/v1/projects/${projectId}/delivery`,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      payload: { closed: true },
    });
    expect(res.statusCode).toBe(409);
  });

  it("returns 409 when closing from executing without UAT readiness", async () => {
    await prisma.project.update({
      where: { id: projectId },
      data: { implementationStatus: IMPLEMENTATION_STATUS.EXECUTING, readyForUat: false },
    });
    const res = await app.inject({
      method: "PATCH",
      url: `/api/v1/projects/${projectId}/delivery`,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      payload: { closed: true },
    });
    expect(res.statusCode).toBe(409);
  });

  it("sets implementationStatus to closed from ready_for_uat after UAT", async () => {
    await prisma.project.update({
      where: { id: projectId },
      data: {
        implementationStatus: IMPLEMENTATION_STATUS.READY_FOR_UAT,
        readyForUat: true,
      },
    });
    const res = await app.inject({
      method: "PATCH",
      url: `/api/v1/projects/${projectId}/delivery`,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      payload: { closed: true },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { project: { implementationStatus: string } };
    expect(body.project.implementationStatus).toBe(IMPLEMENTATION_STATUS.CLOSED);
    const row = await prisma.project.findUniqueOrThrow({ where: { id: projectId } });
    expect(row.implementationStatus).toBe(IMPLEMENTATION_STATUS.CLOSED);
  });

  it("is idempotent when already closed", async () => {
    await prisma.project.update({
      where: { id: projectId },
      data: { implementationStatus: IMPLEMENTATION_STATUS.CLOSED },
    });
    const res = await app.inject({
      method: "PATCH",
      url: `/api/v1/projects/${projectId}/delivery`,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      payload: { closed: true },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { project: { implementationStatus: string } };
    expect(body.project.implementationStatus).toBe(IMPLEMENTATION_STATUS.CLOSED);
  });

  it("returns 409 when toggling readyForUat on a closed project", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: `/api/v1/projects/${projectId}/delivery`,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      payload: { readyForUat: true },
    });
    expect(res.statusCode).toBe(409);
  });
});
