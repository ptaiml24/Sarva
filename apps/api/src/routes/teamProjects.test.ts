import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { loadEnv } from "../config/env.js";
import { prisma } from "../lib/prisma.js";

describe("POST/DELETE /api/v1/team-projects", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let token: string;
  let operatorUserId: string;
  let projectId: string;
  let teamAId: string;
  let teamBId: string;

  beforeAll(async () => {
    process.env.JWT_SECRET ??= "test-secret-32-chars-minimum-x";
    app = await buildApp(loadEnv());
    const stamp = `${Date.now()}`;
    const project = await prisma.project.create({
      data: { name: `vitest-team-projects-${stamp}`, repoAssociationMode: "dedicated_repo" },
    });
    projectId = project.id;

    const [a, b] = await prisma.$transaction([
      prisma.team.create({ data: { name: `vitest-tp-A-${stamp}` } }),
      prisma.team.create({ data: { name: `vitest-tp-B-${stamp}` } }),
    ]);
    teamAId = a.id;
    teamBId = b.id;

    const login = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: `vitest-team-projects-${stamp}@sarva.test`, role: "operator" },
    });
    expect(login.statusCode).toBe(200);
    const j = login.json() as { token: string; userId: string };
    token = j.token;
    operatorUserId = j.userId;
  });

  afterAll(async () => {
    await prisma.project.deleteMany({ where: { id: projectId } }).catch(() => undefined);
    await prisma.team.deleteMany({ where: { id: { in: [teamAId, teamBId] } } }).catch(() => undefined);
    await prisma.auditEvent.deleteMany({ where: { actorId: operatorUserId } }).catch(() => undefined);
    await prisma.user.deleteMany({ where: { id: operatorUserId } }).catch(() => undefined);
    await app.close();
  });

  it("allows one team link then rejects a second team with PROJECT_TEAM_LIMIT", async () => {
    const auth = { authorization: `Bearer ${token}` };
    let res = await app.inject({
      method: "POST",
      url: "/api/v1/team-projects",
      headers: auth,
      payload: { teamId: teamAId, projectId },
    });
    expect(res.statusCode).toBe(200);

    res = await app.inject({
      method: "POST",
      url: "/api/v1/team-projects",
      headers: auth,
      payload: { teamId: teamBId, projectId },
    });
    expect(res.statusCode).toBe(409);
    expect((res.json() as { error: { code: string } }).error.code).toBe("PROJECT_TEAM_LIMIT");
  });

  it("unlink then link alternate team succeeds", async () => {
    const auth = { authorization: `Bearer ${token}` };
    let res = await app.inject({
      method: "DELETE",
      url: `/api/v1/team-projects/${projectId}/${teamAId}`,
      headers: auth,
    });
    expect(res.statusCode).toBe(200);

    res = await app.inject({
      method: "POST",
      url: "/api/v1/team-projects",
      headers: auth,
      payload: { teamId: teamBId, projectId },
    });
    expect(res.statusCode).toBe(200);
  });
});
