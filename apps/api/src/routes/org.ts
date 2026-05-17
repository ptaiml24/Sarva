import type { Company, Prisma } from "@prisma/client";
import type { FastifyPluginAsync, FastifyReply } from "fastify";
import { z } from "zod";
import type { Env } from "../config/env.js";
import { prisma } from "../lib/prisma.js";
import { createAuthPreHandler } from "../plugins/auth.js";
import { recordAudit } from "../lib/audit.js";
import { suggestDeliveryAgentsFromLinkedTeams } from "../lib/suggestDeliveryAgents.js";

/** Safe company row for API clients (never exposes `githubPat`). */
export function companyForApiResponse(c: Company) {
  return {
    id: c.id,
    name: c.name,
    settings: c.settings,
    githubOwnerLogin: c.githubOwnerLogin,
    githubOwnerIsOrganization: c.githubOwnerIsOrganization,
    githubReposPrivateByDefault: c.githubReposPrivateByDefault,
    githubPatSet: Boolean(c.githubPat?.trim()),
  };
}

/** Returns false after sending reply when feature_dev workflow needs repo scope but it's missing. */
async function validateFeatureDevRepoOrReply(
  projectId: string,
  workflowId: string | null,
  reply: FastifyReply
): Promise<boolean> {
  if (!workflowId) return true;
  const wf = await prisma.deliveryWorkflow.findUnique({ where: { id: workflowId } });
  if (!wf || wf.kind !== "feature_dev") return true;
  const rs = await prisma.repositoryScope.findUnique({ where: { projectId } });
  if (!rs?.cloneUrl?.trim() && !rs?.rootPath?.trim()) {
    reply.status(400).send({
      error: {
        code: "REPO_REQUIRED",
        message:
          "Feature development workflow requires a Git clone URL or local root path on the repository scope (Intake).",
      },
    });
    return false;
  }
  return true;
}

export function orgRoutes(env: Env): FastifyPluginAsync {
  const auth = createAuthPreHandler(env);
  return async (app) => {
    app.get("/api/v1/company", { preHandler: auth }, async () => {
      const company = await prisma.company.findFirst();
      return company ? companyForApiResponse(company) : null;
    });

    app.post("/api/v1/company", { preHandler: auth }, async (request, reply) => {
      if (request.auth?.role !== "admin") {
        return reply.status(403).send({ error: { code: "FORBIDDEN", message: "admin only" } });
      }
      const body = z.object({ name: z.string().min(1) }).safeParse(request.body);
      if (!body.success) {
        return reply.status(400).send({ error: { code: "VALIDATION", message: body.error.message } });
      }
      const existing = await prisma.company.findFirst();
      if (existing) {
        return reply.status(409).send({ error: { code: "CONFLICT", message: "Company already exists" } });
      }
      const company = await prisma.company.create({
        data: { name: body.data.name, settings: {} },
      });
      await recordAudit(request.auth!.sub, "company.create", `company:${company.id}`);
      return companyForApiResponse(company);
    });

    app.patch("/api/v1/company", { preHandler: auth }, async (request, reply) => {
      if (request.auth?.role !== "admin") {
        return reply.status(403).send({ error: { code: "FORBIDDEN", message: "admin only" } });
      }
      const body = z
        .object({
          name: z.string().min(1).optional(),
          githubOwnerLogin: z.union([z.string().max(200), z.null()]).optional(),
          githubOwnerIsOrganization: z.boolean().optional(),
          githubPat: z.union([z.string().min(1).max(4000), z.literal(""), z.null()]).optional(),
          githubReposPrivateByDefault: z.boolean().optional(),
        })
        .refine((o) => Object.keys(o).length > 0, { message: "Provide at least one field to update" })
        .safeParse(request.body);
      if (!body.success) {
        return reply.status(400).send({ error: { code: "VALIDATION", message: body.error.message } });
      }
      const existing = await prisma.company.findFirst();
      if (!existing) {
        return reply.status(404).send({ error: { code: "NOT_FOUND", message: "No company to update" } });
      }
      const d = body.data;
      const data: Prisma.CompanyUpdateInput = {};
      if (d.name !== undefined) data.name = d.name;
      if (d.githubOwnerLogin !== undefined) {
        data.githubOwnerLogin = d.githubOwnerLogin === null ? null : d.githubOwnerLogin.trim() || null;
      }
      if (d.githubOwnerIsOrganization !== undefined) data.githubOwnerIsOrganization = d.githubOwnerIsOrganization;
      if (d.githubReposPrivateByDefault !== undefined) {
        data.githubReposPrivateByDefault = d.githubReposPrivateByDefault;
      }
      if (d.githubPat !== undefined) {
        if (d.githubPat === "" || d.githubPat === null) data.githubPat = null;
        else data.githubPat = d.githubPat;
      }
      const company = await prisma.company.update({
        where: { id: existing.id },
        data,
      });
      await recordAudit(request.auth!.sub, "company.update", `company:${company.id}`);
      return companyForApiResponse(company);
    });

    app.get("/api/v1/projects", { preHandler: auth }, async () => {
      const projects = await prisma.project.findMany({
        orderBy: { name: "asc" },
        take: 100,
        include: {
          _count: {
            select: {
              tasks: true,
              teamLinks: true,
              sprints: true,
              proposedItems: true,
            },
          },
          context: {
            select: {
              brief: true,
              goals: true,
            },
          },
        },
      });
      if (projects.length === 0) return projects;
      const idList = projects.map((p) => p.id);
      const groups = await prisma.task.groupBy({
        by: ["projectId", "state"],
        where: { projectId: { in: idList } },
        _count: { _all: true },
      });
      const summaryByProject = new Map<string, Record<string, number>>();
      for (const g of groups) {
        const cur = summaryByProject.get(g.projectId) ?? {};
        cur[g.state] = g._count._all;
        summaryByProject.set(g.projectId, cur);
      }
      return projects.map((p) => ({
        ...p,
        taskStateSummary: summaryByProject.get(p.id) ?? {},
      }));
    });

    app.get("/api/v1/admin/overview", { preHandler: auth }, async (request, reply) => {
      if (request.auth?.role !== "admin") {
        return reply.status(403).send({ error: { code: "FORBIDDEN", message: "admin only" } });
      }
      const [sarvaRoleTemplates, sarvaSkillTemplates] = await Promise.all([
        prisma.roleTemplate.findMany({
          orderBy: { sortOrder: "asc" },
          include: {
            allowedSkills: { include: { skillTemplate: { select: { id: true, code: true, label: true } } } },
          },
        }),
        prisma.skillTemplate.findMany({ orderBy: { sortOrder: "asc" } }),
      ]);

      const company = await prisma.company.findFirst();
      if (!company) {
        return {
          company: null,
          jwtRolesDoc:
            "Sign-in role is chosen at login (admin or operator). It is not stored in the database for R1.",
          catalogNote:
            "Role and skill catalogs are managed in Admin (add/edit). Teams allocate headcount per role type; each seat links skills allowed for that role type.",
          sarvaRoleTemplates,
          sarvaSkillTemplates,
          businessUnits: [] as { id: string; name: string; teamCount: number }[],
          teams: [] as { id: string; name: string; businessUnitId: string | null }[],
          teamRoleSeats: [] as unknown[],
          users: [] as { id: string; email: string }[],
          agents: [] as { id: string; name: string; status: string }[],
          projects: [] as unknown[],
          modelBindingsCompany: [] as unknown[],
        };
      }
      const [businessUnits, teams, users, agents, projects, modelBindingsCompany, teamRoleSeats] =
        await Promise.all([
          prisma.businessUnit.findMany({
            where: { companyId: company.id },
            orderBy: { name: "asc" },
            include: { _count: { select: { teams: true } } },
          }),
          prisma.team.findMany({
            where: {
              OR: [{ businessUnit: { companyId: company.id } }, { businessUnitId: null }],
            },
            orderBy: { name: "asc" },
            take: 300,
            select: { id: true, name: true, businessUnitId: true },
          }),
          prisma.user.findMany({ orderBy: { email: "asc" }, take: 200, select: { id: true, email: true } }),
          prisma.agent.findMany({ orderBy: { name: "asc" }, take: 200, select: { id: true, name: true, status: true } }),
          prisma.project.findMany({
            orderBy: { name: "asc" },
            take: 100,
            include: {
              _count: {
                select: { tasks: true, teamLinks: true, sprints: true, proposedItems: true },
              },
            },
          }),
          prisma.modelBinding.findMany({
            where: { companyId: company.id },
            orderBy: { priority: "asc" },
            take: 100,
            include: {
              llmProviderConnection: true,
            },
          }),
          prisma.role.findMany({
            where: {
              team: {
                OR: [{ businessUnit: { companyId: company.id } }, { businessUnitId: null }],
              },
            },
            include: {
              team: { select: { id: true, name: true } },
              roleTemplate: { select: { id: true, code: true, label: true } },
              skillLinks: { include: { skillTemplate: { select: { id: true, code: true, label: true } } } },
            },
            orderBy: [{ team: { name: "asc" } }, { name: "asc" }],
            take: 500,
          }),
        ]);

      return {
        company: companyForApiResponse(company),
        jwtRolesDoc:
          "Sign-in role is chosen at login (admin or operator). It is not stored in the database for R1.",
        catalogNote:
          "Role and skill catalogs are managed in Admin (add/edit). Teams allocate headcount per role type; each seat links skills allowed for that role type.",
        sarvaRoleTemplates,
        sarvaSkillTemplates,
        businessUnits: businessUnits.map((b) => ({
          id: b.id,
          name: b.name,
          teamCount: b._count.teams,
        })),
        teams,
        teamRoleSeats,
        users,
        agents,
        projects,
        modelBindingsCompany: modelBindingsCompany.map((b) => {
          const { llmProviderConnection: rawConn, ...rest } = b;
          return {
            ...rest,
            llmProviderConnection: rawConn
              ? {
                  id: rawConn.id,
                  name: rawConn.name,
                  provider: rawConn.provider,
                  modelId: rawConn.modelId,
                  baseUrl: rawConn.baseUrl,
                  apiKeySet: Boolean(rawConn.apiKey?.trim()),
                }
              : null,
          };
        }),
      };
    });

    app.get<{ Params: { projectId: string } }>(
      "/api/v1/projects/:projectId/assignable-roles",
      { preHandler: auth },
      async (request, reply) => {
        const parsed = z.string().uuid().safeParse(request.params.projectId);
        if (!parsed.success) {
          return reply.status(400).send({ error: { code: "VALIDATION", message: "Invalid project id" } });
        }
        const links = await prisma.teamProject.findMany({
          where: { projectId: parsed.data },
          include: {
            team: {
              include: {
                roles: {
                  include: { roleTemplate: { select: { id: true, code: true, label: true } } },
                  orderBy: { name: "asc" },
                },
              },
            },
          },
        });
        const roles = links.flatMap((l) =>
          l.team.roles.map((r) => ({
            id: r.id,
            name: r.name,
            teamId: l.teamId,
            teamName: l.team.name,
            roleTemplate: r.roleTemplate,
          }))
        );
        return { roles };
      }
    );

    app.get("/api/v1/users", { preHandler: auth }, async () => {
      return prisma.user.findMany({ orderBy: { email: "asc" }, take: 200 });
    });

    app.get<{ Params: { projectId: string } }>("/api/v1/projects/:projectId", { preHandler: auth }, async (request, reply) => {
      const parsed = z.string().uuid().safeParse(request.params.projectId);
      if (!parsed.success) {
        return reply.status(400).send({ error: { code: "VALIDATION", message: "Invalid project id" } });
      }
      const project = await prisma.project.findUnique({
        where: { id: parsed.data },
        include: {
          context: true,
          repoScope: true,
          teamLinks: { include: { team: true } },
          pmOrchestratorAgent: true,
          designatedApprover: true,
          workflow: true,
          designArtifacts: { orderBy: { updatedAt: "desc" }, take: 20 },
          roleAssignments: { include: { agent: { select: { id: true, name: true, status: true } } } },
          _count: {
            select: { tasks: true, proposedItems: true, teamLinks: true, sprints: true },
          },
        },
      });
      if (!project) {
        return reply.status(404).send({ error: { code: "NOT_FOUND", message: "project" } });
      }
      const taskGroups = await prisma.task.groupBy({
        by: ["state"],
        where: { projectId: parsed.data },
        _count: { _all: true },
      });
      const taskStateSummary = Object.fromEntries(taskGroups.map((r) => [r.state, r._count._all]));
      const [prdApproved, prdDraft] = await Promise.all([
        prisma.prdArtifact.findFirst({
          where: { projectId: parsed.data, status: "approved" },
          orderBy: { updatedAt: "desc" },
          select: { id: true, title: true, updatedAt: true },
        }),
        prisma.prdArtifact.findFirst({
          where: { projectId: parsed.data, status: "draft" },
          orderBy: { updatedAt: "desc" },
          select: { id: true, title: true, updatedAt: true },
        }),
      ]);
      return {
        ...project,
        taskStateSummary,
        prdSummary: {
          approved: prdApproved,
          draft: prdDraft,
        },
      };
    });

    /** Recent audit rows for delivery gates on this project (proceed, close, publish, etc.). */
    app.get<{ Params: { projectId: string } }>(
      "/api/v1/projects/:projectId/audit-events",
      { preHandler: auth },
      async (request, reply) => {
        const parsed = z.string().uuid().safeParse(request.params.projectId);
        if (!parsed.success) {
          return reply.status(400).send({ error: { code: "VALIDATION", message: "Invalid project id" } });
        }
        const prefix = `project:${parsed.data}`;
        const rows = await prisma.auditEvent.findMany({
          where: { resourceRef: { startsWith: prefix } },
          orderBy: { createdAt: "desc" },
          take: 40,
          include: { actor: { select: { id: true, email: true } } },
        });
        return {
          items: rows.map((r) => ({
            id: r.id,
            action: r.action,
            resourceRef: r.resourceRef,
            createdAt: r.createdAt,
            actor: r.actor,
          })),
        };
      }
    );

    app.get<{ Params: { projectId: string } }>(
      "/api/v1/projects/:projectId/suggested-delivery-agents",
      { preHandler: auth },
      async (request, reply) => {
        const parsed = z.string().uuid().safeParse(request.params.projectId);
        if (!parsed.success) {
          return reply.status(400).send({ error: { code: "VALIDATION", message: "Invalid project id" } });
        }
        const project = await prisma.project.findUnique({ where: { id: parsed.data } });
        if (!project) {
          return reply.status(404).send({ error: { code: "NOT_FOUND", message: "project" } });
        }
        return suggestDeliveryAgentsFromLinkedTeams(parsed.data);
      }
    );

    app.patch<{ Params: { projectId: string } }>(
      "/api/v1/projects/:projectId/context",
      { preHandler: auth },
      async (request, reply) => {
        const { projectId } = request.params;
        const idParse = z.string().uuid().safeParse(projectId);
        if (!idParse.success) {
          return reply.status(400).send({ error: { code: "VALIDATION", message: "Invalid project id" } });
        }
        const body = z
          .object({
            brief: z.string().nullable().optional(),
            requirementsLinks: z.array(z.any()).optional(),
            repoScope: z.string().nullable().optional(),
            analysisNotes: z.string().nullable().optional(),
            goals: z.string().nullable().optional(),
            documentRepositoryUrl: z.union([z.string().url(), z.literal(""), z.null()]).optional(),
          })
          .safeParse(request.body);
        if (!body.success) {
          return reply.status(400).send({ error: { code: "VALIDATION", message: body.error.message } });
        }
        const docUrl =
          body.data.documentRepositoryUrl === undefined
            ? undefined
            : body.data.documentRepositoryUrl === "" || body.data.documentRepositoryUrl === null
              ? null
              : body.data.documentRepositoryUrl;
        const ctx = await prisma.projectContext.update({
          where: { projectId },
          data: {
            ...(body.data.brief !== undefined ? { brief: body.data.brief } : {}),
            ...(body.data.requirementsLinks !== undefined
              ? { requirementsLinks: body.data.requirementsLinks as object[] }
              : {}),
            ...(body.data.repoScope !== undefined ? { repoScope: body.data.repoScope } : {}),
            ...(body.data.analysisNotes !== undefined ? { analysisNotes: body.data.analysisNotes } : {}),
            ...(body.data.goals !== undefined ? { goals: body.data.goals } : {}),
            ...(docUrl !== undefined ? { documentRepositoryUrl: docUrl } : {}),
          },
        });
        await recordAudit(request.auth!.sub, "project_context.update", `project:${projectId}`);
        return ctx;
      }
    );

    app.patch<{ Params: { projectId: string } }>("/api/v1/projects/:projectId", { preHandler: auth }, async (request, reply) => {
      const { projectId } = request.params;
      const idParse = z.string().uuid().safeParse(projectId);
      if (!idParse.success) {
        return reply.status(400).send({ error: { code: "VALIDATION", message: "Invalid project id" } });
      }
      const body = z
        .object({
          governanceMode: z.enum(["inbox", "external"]).optional(),
          designatedApproverUserId: z.string().uuid().nullable().optional(),
          pmOrchestratorAgentId: z.string().uuid().nullable().optional(),
          deliveryPhase: z.enum(["intake", "design", "delivery", "sustain"]).nullable().optional(),
          deliveryPolicy: z.any().optional(),
          name: z.string().min(1).max(500).optional(),
          workflowId: z.string().uuid().nullable().optional(),
        })
        .safeParse(request.body);
      if (!body.success) {
        return reply.status(400).send({ error: { code: "VALIDATION", message: body.error.message } });
      }
      const existing = await prisma.project.findUnique({
        where: { id: projectId },
        select: { workflowId: true },
      });
      if (!existing) {
        return reply.status(404).send({ error: { code: "NOT_FOUND", message: "project" } });
      }
      const nextWorkflowId =
        body.data.workflowId !== undefined ? body.data.workflowId : existing.workflowId;
      if (body.data.workflowId !== undefined) {
        if (body.data.workflowId !== null) {
          const wf = await prisma.deliveryWorkflow.findUnique({ where: { id: body.data.workflowId } });
          if (!wf) {
            return reply.status(400).send({ error: { code: "VALIDATION", message: "Unknown workflow id" } });
          }
        }
        if (!(await validateFeatureDevRepoOrReply(projectId, nextWorkflowId, reply))) {
          return;
        }
      }
      const updated = await prisma.project.update({
        where: { id: projectId },
        data: {
          ...(body.data.governanceMode !== undefined ? { governanceMode: body.data.governanceMode } : {}),
          ...(body.data.designatedApproverUserId !== undefined
            ? { designatedApproverUserId: body.data.designatedApproverUserId }
            : {}),
          ...(body.data.pmOrchestratorAgentId !== undefined
            ? { pmOrchestratorAgentId: body.data.pmOrchestratorAgentId }
            : {}),
          ...(body.data.deliveryPhase !== undefined ? { deliveryPhase: body.data.deliveryPhase } : {}),
          ...(body.data.deliveryPolicy !== undefined
            ? { deliveryPolicy: body.data.deliveryPolicy as object }
            : {}),
          ...(body.data.name !== undefined ? { name: body.data.name } : {}),
          ...(body.data.workflowId !== undefined ? { workflowId: body.data.workflowId } : {}),
        },
      });
      await recordAudit(request.auth!.sub, "project.update", `project:${projectId}`);
      return updated;
    });

    app.post("/api/v1/projects", { preHandler: auth }, async (request, reply) => {
      const body = z
        .object({
          name: z.string().min(1),
          repoAssociationMode: z.string().default("dedicated_repo"),
          governanceMode: z.enum(["inbox", "external"]).optional(),
          workflowId: z.string().uuid().nullable().optional(),
        })
        .safeParse(request.body);
      if (!body.success) {
        return reply.status(400).send({ error: { code: "VALIDATION", message: body.error.message } });
      }
      let workflowId: string | null = body.data.workflowId ?? null;
      if (workflowId) {
        const wf = await prisma.deliveryWorkflow.findUnique({ where: { id: workflowId } });
        if (!wf) {
          return reply.status(400).send({ error: { code: "VALIDATION", message: "Unknown workflow id" } });
        }
      } else {
        workflowId = null;
      }
      const project = await prisma.project.create({
        data: {
          name: body.data.name,
          repoAssociationMode: body.data.repoAssociationMode,
          governanceMode: body.data.governanceMode ?? null,
          workflowId,
        },
      });
      await prisma.projectContext.create({
        data: {
          projectId: project.id,
          requirementsLinks: [],
          brief: null,
          repoScope: null,
        },
      });
      await prisma.repositoryScope.create({
        data: { projectId: project.id, cloneUrl: null, rootPath: null, branchDefault: "main" },
      });
      await recordAudit(request.auth!.sub, "project.create", `project:${project.id}`);
      return project;
    });

    app.patch<{ Params: { projectId: string } }>(
      "/api/v1/projects/:projectId/repository-scope",
      { preHandler: auth },
      async (request, reply) => {
        const { projectId } = request.params;
        const body = z
          .object({
            /** Empty string clears the field in the UI */
            cloneUrl: z
              .union([z.string().url(), z.literal(""), z.null()])
              .optional()
              .transform((v) => (v === "" ? null : v)),
            rootPath: z
              .union([z.string(), z.literal(""), z.null()])
              .optional()
              .transform((v) => (v === "" ? null : v)),
            branchDefault: z
              .union([z.string(), z.literal(""), z.null()])
              .optional()
              .transform((v) => (v === "" ? null : v)),
          })
          .safeParse(request.body);
        if (!body.success) {
          return reply.status(400).send({ error: { code: "VALIDATION", message: body.error.message } });
        }
        const scope = await prisma.repositoryScope.upsert({
          where: { projectId },
          create: {
            projectId,
            cloneUrl: body.data.cloneUrl ?? null,
            rootPath: body.data.rootPath ?? null,
            branchDefault: body.data.branchDefault ?? "main",
          },
          update: {
            ...(body.data.cloneUrl !== undefined ? { cloneUrl: body.data.cloneUrl } : {}),
            ...(body.data.rootPath !== undefined ? { rootPath: body.data.rootPath } : {}),
            ...(body.data.branchDefault !== undefined ? { branchDefault: body.data.branchDefault } : {}),
          },
        });
        await recordAudit(request.auth!.sub, "repository_scope.update", `project:${projectId}`);
        return scope;
      }
    );

    app.delete<{ Params: { projectId: string } }>("/api/v1/projects/:projectId", { preHandler: auth }, async (request, reply) => {
      if (request.auth?.role !== "admin") {
        return reply.status(403).send({ error: { code: "FORBIDDEN", message: "admin only" } });
      }
      const parsed = z.string().uuid().safeParse(request.params.projectId);
      if (!parsed.success) {
        return reply.status(400).send({ error: { code: "VALIDATION", message: "Invalid project id" } });
      }
      const projectId = parsed.data;
      const p = await prisma.project.findUnique({
        where: { id: projectId },
        include: {
          _count: {
            select: {
              tasks: true,
              teamLinks: true,
              sprints: true,
              proposedItems: true,
            },
          },
        },
      });
      if (!p) {
        return reply.status(404).send({ error: { code: "NOT_FOUND", message: "project" } });
      }
      const c = p._count;
      if (c.tasks > 0 || c.teamLinks > 0 || c.sprints > 0 || c.proposedItems > 0) {
        return reply.status(409).send({
          error: {
            code: "NOT_EMPTY",
            message:
              "Delete tasks, unlink teams, remove sprints, and clear PM drafts before deleting this project.",
          },
        });
      }
      await prisma.project.delete({ where: { id: projectId } });
      await recordAudit(request.auth!.sub, "project.delete", `project:${projectId}`);
      return { deleted: true };
    });
  };
}
