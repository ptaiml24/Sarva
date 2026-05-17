import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { loadEnv } from "../config/env.js";
import { prisma } from "../lib/prisma.js";

describe("project issues", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let token: string;
  let operatorUserId: string;
  let projectId: string;
  let roleId: string;
  let teamId: string;

  beforeAll(async () => {
    app = await buildApp(loadEnv());
    const stamp = `${Date.now()}`;
    const project = await prisma.project.create({
      data: { name: `vitest-issues-${stamp}`, repoAssociationMode: "dedicated_repo" },
    });
    projectId = project.id;

    const team = await prisma.team.create({
      data: {
        name: `vitest-issues-team-${stamp}`,
      },
    });
    teamId = team.id;
    await prisma.teamProject.create({
      data: { teamId: team.id, projectId },
    });

    const role = await prisma.role.create({
      data: { teamId: team.id, name: `QA lane ${stamp}` },
    });
    roleId = role.id;

    const login = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: `vitest-issues-${stamp}@sarva.test`, role: "operator" },
    });
    expect(login.statusCode).toBe(200);
    const j = login.json() as { token: string; userId: string };
    token = j.token;
    operatorUserId = j.userId;
  });

  afterAll(async () => {
    await prisma.project.deleteMany({ where: { id: projectId } }).catch(() => undefined);
    await prisma.role.deleteMany({ where: { teamId } }).catch(() => undefined);
    await prisma.team.deleteMany({ where: { id: teamId } }).catch(() => undefined);
    await prisma.auditEvent.deleteMany({ where: { actorId: operatorUserId } }).catch(() => undefined);
    await prisma.user.deleteMany({ where: { id: operatorUserId } }).catch(() => undefined);
    await app.close();
  });

  it("covers issue CRUD, optional Owner seat → backlog Task + orchestrator hook paths", async () => {
    const headers = { authorization: `Bearer ${token}` };

    /** No seat ⇒ no backlog task or delivery linkage. */
    const baselineTasks = await prisma.task.count({ where: { projectId } });
    let create = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/issues`,
      headers,
      payload: { title: "TBD lane — backlog later", description: "—" },
    });
    expect(create.statusCode).toBe(200);
    expect((create.json() as { deliveryTaskId: string | null }).deliveryTaskId).toBeNull();
    expect(await prisma.task.count({ where: { projectId } })).toBe(baselineTasks);

    /** Owner seat ⇒ backlog row + FK for delivery orchestration. */
    create = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/issues`,
      headers,
      payload: {
        title: "Login fails on safari",
        description: "Repro attached",
        ownerRoleId: roleId,
      },
    });
    expect(create.statusCode).toBe(200);
    let row = create.json() as {
      issueNumber: number;
      status: string;
      owner: { roleId: string };
      id: string;
      deliveryTaskId: string | null;
    };
    expect(row.issueNumber).toBe(2);
    expect(row.owner?.roleId).toBe(roleId);
    expect(row.deliveryTaskId).toBeTruthy();
    const linked = await prisma.task.findUnique({ where: { id: row.deliveryTaskId! } });
    expect(linked?.projectId).toBe(projectId);
    expect(linked?.state).toBe("backlog");
    expect(linked?.targetRoleId).toBe(roleId);
    const issuePkClosedLater = row.id;

    create = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/issues`,
      headers,
      payload: { title: "Second item", ownerRoleId: roleId },
    });
    expect(create.statusCode).toBe(200);
    row = create.json() as typeof row;
    expect(row.issueNumber).toBe(3);
    expect(row.deliveryTaskId).toBeTruthy();

    let openList = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/issues?scope=open`,
      headers,
    });
    expect(openList.statusCode).toBe(200);
    expect((openList.json() as { items: unknown[] }).items.length).toBe(3);

    const closed = await app.inject({
      method: "PATCH",
      url: `/api/v1/projects/${projectId}/issues/${issuePkClosedLater}`,
      headers,
      payload: { status: "closed" },
    });
    expect(closed.statusCode).toBe(200);
    expect((closed.json() as { status: string }).status).toBe("closed");

    openList = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/issues?scope=open`,
      headers,
    });
    expect((openList.json() as { items: unknown[] }).items.length).toBe(2);

    const noSeat = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/issues`,
      headers,
      payload: { title: "Defer seat until patch", description: "-" },
    });
    expect(noSeat.statusCode).toBe(200);
    expect((noSeat.json() as { deliveryTaskId: string | null }).deliveryTaskId).toBeNull();
    const noSeatPk = (noSeat.json() as { id: string }).id;
    const taskCountBeforePatch = await prisma.task.count({ where: { projectId } });

    const patchSeat = await app.inject({
      method: "PATCH",
      url: `/api/v1/projects/${projectId}/issues/${noSeatPk}`,
      headers,
      payload: { ownerRoleId: roleId },
    });
    expect(patchSeat.statusCode).toBe(200);
    expect((patchSeat.json() as { deliveryTaskId: string | null }).deliveryTaskId).toBeTruthy();
    expect(await prisma.task.count({ where: { projectId } })).toBe(taskCountBeforePatch + 1);

    const allList = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/issues?scope=all`,
      headers,
    });
    expect((allList.json() as { items: unknown[] }).items.length).toBe(4);
  });

  it("marks linked issue closed when the delivery task is marked done", async () => {
    const headers = { authorization: `Bearer ${token}` };
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/issues`,
      headers,
      payload: { title: "Auto-close linked issue via task done", ownerRoleId: roleId },
    });
    expect(res.statusCode).toBe(200);
    const row = res.json() as { deliveryTaskId: string | null; id: string };
    expect(row.deliveryTaskId).toBeTruthy();
    const done = await app.inject({
      method: "PATCH",
      url: `/api/v1/tasks/${row.deliveryTaskId}`,
      headers,
      payload: { state: "done", expectedVersion: 1 },
    });
    expect(done.statusCode).toBe(200);
    const list = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/issues?scope=all`,
      headers,
    });
    expect(list.statusCode).toBe(200);
    const items = (list.json() as { items: { id: string; status: string }[] }).items;
    expect(items.find((i) => i.id === row.id)?.status).toBe("closed");
  });

  it("lists role-options for seats linked via team↔project", async () => {
    const opts = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/issues/role-options`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(opts.statusCode).toBe(200);
    const j = opts.json() as { items: { roleId: string }[] };
    expect(j.items.some((r) => r.roleId === roleId)).toBe(true);
  });
});
