import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import type { Env } from "../config/env.js";
import type { JwtPayload } from "../lib/jwt.js";
import { prisma } from "../lib/prisma.js";
import { createAuthPreHandler } from "../plugins/auth.js";
import { recordAudit } from "../lib/audit.js";
import { requireAdmin } from "../lib/authz.js";
import { ensureLinkedDeliveryTaskForIssue, orchestrateProjectAfterIssueTaskChange } from "../lib/projectIssueDeliveryTask.js";

/** Stored lowercase — UI maps to Title Case. */
export const PROJECT_ISSUE_STATUSES = ["open", "closed", "deferred"] as const;

const projectIdParam = z.string().uuid();

function statusDisplay(status: string): string {
  const s = status.toLowerCase();
  if (s === "open") return "Open";
  if (s === "closed") return "Closed";
  if (s === "deferred") return "Deferred";
  return status;
}

async function rowRoleBelongsToProject(roleId: string, projectId: string): Promise<boolean> {
  const role = await prisma.role.findFirst({
    where: {
      id: roleId,
      team: { teamProjects: { some: { projectId } } },
    },
    select: { id: true },
  });
  return Boolean(role);
}

function serializeIssue(
  row: {
    id: string;
    projectId: string;
    issueNumber: number;
    title: string;
    description: string;
    status: string;
    assignedUserId: string;
    assignedUser: { email: string };
    ownerRoleId: string | null;
    ownerRole: null | {
      id: string;
      name: string;
      team: { id: string; name: string };
    };
    closedAt: Date | null;
    createdAt: Date;
    updatedAt: Date;
    linkedTaskId?: string | null;
  }
): Record<string, unknown> {
  const ownerSeatRole =
    row.ownerRole ?
      {
        roleId: row.ownerRole.id,
        roleName: row.ownerRole.name,
        teamId: row.ownerRole.team.id,
        teamName: row.ownerRole.team.name,
        display: `${row.ownerRole.team.name} · ${row.ownerRole.name}`,
      }
    : null;

  return {
    issueId: row.issueNumber,
    id: row.id,
    issueNumber: row.issueNumber,
    title: row.title,
    description: row.description,
    status: row.status,
    statusLabel: statusDisplay(row.status),
    assignedUserId: row.assignedUserId,
    assignedUserEmail: row.assignedUser.email,
    owner: ownerSeatRole,
    deliveryTaskId: row.linkedTaskId ?? null,
    closedAt: row.closedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function projectIssuesRoutes(env: Env): FastifyPluginAsync {
  const auth = createAuthPreHandler(env);
  return async (app) => {
    /** Roles/seats linked to this project via team membership — Owner column picker. */
    app.get<{ Params: { projectId: string } }>(
      "/api/v1/projects/:projectId/issues/role-options",
      { preHandler: auth },
      async (request, reply) => {
        const pid = projectIdParam.safeParse(request.params.projectId);
        if (!pid.success) {
          return reply.status(400).send({ error: { code: "VALIDATION", message: "Invalid project id" } });
        }
        const project = await prisma.project.findUnique({ where: { id: pid.data } });
        if (!project) {
          return reply.status(404).send({ error: { code: "NOT_FOUND", message: "project" } });
        }
        const roles = await prisma.role.findMany({
          where: {
            team: {
              teamProjects: { some: { projectId: pid.data } },
            },
          },
          orderBy: [{ team: { name: "asc" } }, { name: "asc" }],
          select: {
            id: true,
            name: true,
            teamId: true,
            team: { select: { id: true, name: true } },
            seats: {
              select: {
                id: true,
                label: true,
                assignedAgentId: true,
              },
              take: 4,
              orderBy: { id: "asc" },
            },
          },
        });
        const items = roles.map((r) => {
          const seatHint =
            r.seats.length === 1 ? (r.seats[0]!.label?.trim() || r.seats[0]!.id.slice(0, 8))
            : r.seats.length > 1 ?
              `${r.seats.length} seats`
            : "no seat rows";
          return {
            roleId: r.id,
            roleName: r.name,
            teamId: r.team.id,
            teamName: r.team.name,
            display: `${r.team.name} · ${r.name} (${seatHint})`,
          };
        });
        return { items };
      }
    );

    app.get<{ Params: { projectId: string }; Querystring: { scope?: unknown } }>(
      "/api/v1/projects/:projectId/issues",
      { preHandler: auth },
      async (request, reply) => {
        const pid = projectIdParam.safeParse(request.params.projectId);
        if (!pid.success) {
          return reply.status(400).send({ error: { code: "VALIDATION", message: "Invalid project id" } });
        }
        const project = await prisma.project.findUnique({ where: { id: pid.data } });
        if (!project) {
          return reply.status(404).send({ error: { code: "NOT_FOUND", message: "project" } });
        }
        const scopeParse = z.enum(["open", "all"]).safeParse(request.query?.scope ?? "open");
        const scope = scopeParse.success ? scopeParse.data : "open";

        const rows = await prisma.projectIssue.findMany({
          where: {
            projectId: pid.data,
            ...(scope === "open" ? { status: "open" } : {}),
          },
          include: {
            assignedUser: { select: { email: true } },
            ownerRole: { select: { id: true, name: true, team: { select: { id: true, name: true } } } },
          },
          orderBy: [{ issueNumber: "desc" }],
        });

        return {
          scope,
          items: rows.map(serializeIssue),
        };
      }
    );

    app.post<{ Params: { projectId: string }; Body?: unknown }>(
      "/api/v1/projects/:projectId/issues",
      { preHandler: auth },
      async (request, reply) => {
        const pid = projectIdParam.safeParse(request.params.projectId);
        if (!pid.success) {
          return reply.status(400).send({ error: { code: "VALIDATION", message: "Invalid project id" } });
        }
        const actor = request.auth as JwtPayload;
        const project = await prisma.project.findUnique({ where: { id: pid.data } });
        if (!project) {
          return reply.status(404).send({ error: { code: "NOT_FOUND", message: "project" } });
        }

        const body = z
          .object({
            title: z.string().trim().min(1).max(500),
            description: z.string().max(40_000).optional().default(""),
            ownerRoleId: z.string().uuid().optional().nullable(),
            assignedUserId: z.string().uuid().optional(),
            status: z.enum(PROJECT_ISSUE_STATUSES).optional().default("open"),
          })
          .safeParse(request.body ?? {});

        if (!body.success) {
          return reply.status(400).send({ error: { code: "VALIDATION", message: body.error.message } });
        }

        const assigneeId = body.data.assignedUserId ?? actor.sub;
        if (assigneeId !== actor.sub && !requireAdmin(request, reply)) {
          return;
        }

        const assigneeExists = await prisma.user.findUnique({ where: { id: assigneeId }, select: { id: true } });
        if (!assigneeExists) {
          return reply.status(400).send({ error: { code: "VALIDATION", message: "assigned user not found" } });
        }

        const ownerRoleId = body.data.ownerRoleId ?? null;
        if (ownerRoleId) {
          const ok = await rowRoleBelongsToProject(ownerRoleId, pid.data);
          if (!ok) {
            return reply.status(400).send({
              error: { code: "INVALID_OWNER", message: "Owner role must belong to a team linked to this project." },
            });
          }
        }

        const closedAt =
          body.data.status === "closed" ? new Date()
          : null;

        let spunDeliveryTask = false;
        const created = await prisma.$transaction(async (tx) => {
          const agg = await tx.projectIssue.aggregate({
            where: { projectId: pid.data },
            _max: { issueNumber: true },
          });
          const nextNum = (agg._max.issueNumber ?? 0) + 1;
          const issueRow = await tx.projectIssue.create({
            data: {
              projectId: pid.data,
              issueNumber: nextNum,
              title: body.data.title.trim(),
              description: body.data.description.trim(),
              status: body.data.status,
              assignedUserId: assigneeId,
              ownerRoleId,
              closedAt,
            },
          });
          const { created: spunFromIssue } = await ensureLinkedDeliveryTaskForIssue(tx, {
            issueId: issueRow.id,
            issueNumber: issueRow.issueNumber,
            issueTitle: issueRow.title,
            issueDescription: issueRow.description,
            issueStatus: issueRow.status,
            linkedTaskId: issueRow.linkedTaskId ?? null,
            projectId: pid.data,
            ownerRoleId: issueRow.ownerRoleId,
          });
          spunDeliveryTask = spunFromIssue;
          const finalized = await tx.projectIssue.findUnique({
            where: { id: issueRow.id },
            include: {
              assignedUser: { select: { email: true } },
              ownerRole: { select: { id: true, name: true, team: { select: { id: true, name: true } } } },
            },
          });
          if (!finalized) {
            throw new Error("project_issue row missing after create");
          }
          return finalized;
        });

        await recordAudit(actor.sub, "project.issue.create", `project:${pid.data}:${created.id}`);
        if (spunDeliveryTask) {
          void orchestrateProjectAfterIssueTaskChange(pid.data, env, { source: "project.issue.create.linked_task" }, request.log);
        }
        return serializeIssue(created);
      },
    );

    app.patch<{ Params: { projectId: string; issueId: string }; Body?: unknown }>(
      "/api/v1/projects/:projectId/issues/:issueId",
      { preHandler: auth },
      async (request, reply) => {
        const pid = projectIdParam.safeParse(request.params.projectId);
        if (!pid.success) {
          return reply.status(400).send({ error: { code: "VALIDATION", message: "Invalid project id" } });
        }
        const issueIdParse = projectIdParam.safeParse(request.params.issueId);
        if (!issueIdParse.success) {
          return reply.status(400).send({ error: { code: "VALIDATION", message: "Invalid issue id" } });
        }
        const actor = request.auth as JwtPayload;

        const existing = await prisma.projectIssue.findFirst({
          where: { id: issueIdParse.data, projectId: pid.data },
          select: {
            id: true,
            status: true,
            assignedUserId: true,
            closedAt: true,
            linkedTaskId: true,
            ownerRoleId: true,
            issueNumber: true,
            title: true,
            description: true,
          },
        });
        if (!existing) {
          return reply.status(404).send({ error: { code: "NOT_FOUND", message: "issue" } });
        }

        const body = z
          .object({
            title: z.string().trim().min(1).max(500).optional(),
            description: z.string().max(40_000).optional(),
            status: z.enum(PROJECT_ISSUE_STATUSES).optional(),
            ownerRoleId: z.union([z.string().uuid(), z.literal(""), z.null()]).optional(),
            assignedUserId: z.string().uuid().optional(),
          })
          .safeParse(request.body ?? {});

        if (!body.success) {
          return reply.status(400).send({ error: { code: "VALIDATION", message: body.error.message } });
        }

        if (
          typeof body.data.assignedUserId === "string" &&
          body.data.assignedUserId !== existing.assignedUserId &&
          !requireAdmin(request, reply)
        ) {
          return;
        }

        let ownerRolePatch: string | null | undefined;
        if (body.data.ownerRoleId === "") ownerRolePatch = null;
        else if (body.data.ownerRoleId === undefined) ownerRolePatch = undefined;
        else if (body.data.ownerRoleId === null) ownerRolePatch = null;
        else {
          ownerRolePatch = body.data.ownerRoleId;
          const ok = await rowRoleBelongsToProject(ownerRolePatch, pid.data);
          if (!ok) {
            return reply.status(400).send({
              error: { code: "INVALID_OWNER", message: "Owner role must belong to a team linked to this project." },
            });
          }
        }

        if (typeof body.data.assignedUserId === "string") {
          const u = await prisma.user.findUnique({
            where: { id: body.data.assignedUserId },
            select: { id: true },
          });
          if (!u) {
            return reply.status(400).send({ error: { code: "VALIDATION", message: "assigned user not found" } });
          }
        }

        const mergedStatus = body.data.status !== undefined ? body.data.status : existing.status;

        /** Status drives closed-at: first transition to closed sets timestamp; reopen clears; other edits preserve. */
        const closedAtPayload: { closedAt?: Date | null } = {};
        if (body.data.status !== undefined) {
          if (mergedStatus === "closed") {
            closedAtPayload.closedAt = existing.closedAt ?? new Date();
          } else {
            closedAtPayload.closedAt = null;
          }
        }

        let spunDeliveryTask = false;
        const updated = await prisma.$transaction(async (tx) => {
          await tx.projectIssue.update({
            where: { id: existing.id },
            data: {
              ...(body.data.title !== undefined ? { title: body.data.title.trim() } : {}),
              ...(body.data.description !== undefined ? { description: body.data.description.trim() } : {}),
              ...(body.data.status !== undefined ? { status: body.data.status } : {}),
              ...(body.data.assignedUserId !== undefined ?
                { assignedUserId: body.data.assignedUserId }
              : {}),
              ...(ownerRolePatch !== undefined ? { ownerRoleId: ownerRolePatch } : {}),
              ...closedAtPayload,
            },
          });

          const u = await tx.projectIssue.findUnique({
            where: { id: existing.id },
            select: {
              id: true,
              issueNumber: true,
              title: true,
              description: true,
              status: true,
              linkedTaskId: true,
              ownerRoleId: true,
              projectId: true,
            },
          });
          if (!u) {
            throw new Error("project_issue row missing after update");
          }

          const out = await ensureLinkedDeliveryTaskForIssue(tx, {
            issueId: u.id,
            issueNumber: u.issueNumber,
            issueTitle: u.title,
            issueDescription: u.description,
            issueStatus: u.status,
            linkedTaskId: u.linkedTaskId ?? null,
            projectId: u.projectId,
            ownerRoleId: u.ownerRoleId,
          });
          spunDeliveryTask = out.created;

          const finalized = await tx.projectIssue.findUnique({
            where: { id: existing.id },
            include: {
              assignedUser: { select: { email: true } },
              ownerRole: { select: { id: true, name: true, team: { select: { id: true, name: true } } } },
            },
          });
          if (!finalized) {
            throw new Error("project_issue row missing after linked delivery task attach");
          }
          return finalized;
        });

        await recordAudit(actor.sub, "project.issue.update", `project:${pid.data}:${existing.id}`);
        if (spunDeliveryTask) {
          void orchestrateProjectAfterIssueTaskChange(pid.data, env, { source: "project.issue.patch.linked_task" }, request.log);
        }
        return serializeIssue(updated);
      }
    );
  };
}
