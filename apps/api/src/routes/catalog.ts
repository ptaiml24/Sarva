import type { FastifyPluginAsync } from "fastify";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import type { Env } from "../config/env.js";
import { prisma } from "../lib/prisma.js";
import { createAuthPreHandler } from "../plugins/auth.js";
import { requireAdmin } from "../lib/authz.js";
import { recordAudit } from "../lib/audit.js";
import {
  ensureDefaultSkillsForRole,
  propagateTemplateSkillToAllRolesOfTemplate,
  revokeTemplateSkillFromAllRolesOfTemplate,
} from "../lib/roleSkillDefaults.js";
import { getCompanyId, requireCompanyId } from "../lib/tenant.js";
import { serializeSkillTemplate } from "../config/defaultSkillPrompts.js";
import { bindingToCredentials } from "../integrations/pmOrchestrator.js";
import { generateSkillTemplateDraftFromCompanyModel } from "../integrations/skillTemplateDraftLlm.js";
import { testResolvedLlmCredentials } from "../integrations/llm/testLlmConnection.js";

/**
 * Merge duplicate composition rows for the same Sarva role template (UI often adds a second row defaulting to the
 * first template). Seat names use a single running index per template: Engineer 1…N, not Engineer 1,2 then 1,2 again.
 */
function aggregateTeamComposition(
  rows: { roleTemplateId: string; count: number }[]
): { roleTemplateId: string; count: number }[] {
  const countByTemplate = new Map<string, number>();
  const order: string[] = [];
  for (const row of rows) {
    if (!countByTemplate.has(row.roleTemplateId)) {
      order.push(row.roleTemplateId);
    }
    countByTemplate.set(row.roleTemplateId, (countByTemplate.get(row.roleTemplateId) ?? 0) + row.count);
  }
  return order.map((roleTemplateId) => ({
    roleTemplateId,
    count: countByTemplate.get(roleTemplateId)!,
  }));
}

export function catalogRoutes(env: Env): FastifyPluginAsync {
  const auth = createAuthPreHandler(env);
  return async (app) => {
    // --- Sarva catalogs (read-only; seeded in migration) ---
    app.get("/api/v1/role-templates", { preHandler: auth }, async () => {
      return prisma.roleTemplate.findMany({
        orderBy: { sortOrder: "asc" },
        include: {
          allowedSkills: { include: { skillTemplate: { select: { id: true, code: true, label: true } } } },
        },
      });
    });

    app.get("/api/v1/skill-templates", { preHandler: auth }, async () => {
      const rows = await prisma.skillTemplate.findMany({ orderBy: { sortOrder: "asc" } });
      return rows.map((r) => serializeSkillTemplate(r));
    });

    app.post("/api/v1/skill-templates/generate-draft", { preHandler: auth }, async (request, reply) => {
      if (!requireAdmin(request, reply)) return;
      const body = z
        .object({
          code: z.string().min(1).regex(/^[a-zA-Z0-9_]+$/),
          description: z.string().min(1).max(6000),
        })
        .safeParse(request.body);
      if (!body.success) {
        return reply.status(400).send({ error: { code: "VALIDATION", message: body.error.message } });
      }
      try {
        const { label, agentPrompt } = await generateSkillTemplateDraftFromCompanyModel(
          env,
          { code: body.data.code, description: body.data.description.trim() },
          env.OPENAI_API_KEY,
        );
        await recordAudit(
          request.auth!.sub,
          "skill_template.ai_draft",
          `skill_template_draft:${body.data.code}`,
        );
        return { label, agentPrompt };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (msg.includes("No company-wide default LLM binding")) {
          return reply.status(422).send({
            error: {
              code: "LLM_BINDING_REQUIRED",
              message: msg,
            },
          });
        }
        return reply.status(502).send({
          error: {
            code: "SKILL_DRAFT_LLM_FAILED",
            message: msg,
          },
        });
      }
    });

    app.post("/api/v1/role-templates", { preHandler: auth }, async (request, reply) => {
      if (!requireAdmin(request, reply)) return;
      const body = z
        .object({
          code: z.string().min(1).regex(/^[a-zA-Z0-9_]+$/),
          label: z.string().min(1),
          description: z.string().nullable().optional(),
          sortOrder: z.number().int().optional(),
        })
        .safeParse(request.body);
      if (!body.success) {
        return reply.status(400).send({ error: { code: "VALIDATION", message: body.error.message } });
      }
      const row = await prisma.roleTemplate.create({
        data: {
          code: body.data.code,
          label: body.data.label,
          description: body.data.description ?? null,
          sortOrder: body.data.sortOrder ?? 0,
        },
      });
      await recordAudit(request.auth!.sub, "role_template.create", `role_template:${row.id}`);
      return row;
    });

    app.patch<{ Params: { id: string } }>("/api/v1/role-templates/:id", { preHandler: auth }, async (request, reply) => {
      if (!requireAdmin(request, reply)) return;
      const id = z.string().uuid().safeParse(request.params.id);
      if (!id.success) {
        return reply.status(400).send({ error: { code: "VALIDATION", message: "Invalid id" } });
      }
      const body = z
        .object({
          code: z.string().min(1).regex(/^[a-zA-Z0-9_]+$/).optional(),
          label: z.string().min(1).optional(),
          description: z.string().nullable().optional(),
          sortOrder: z.number().int().optional(),
        })
        .safeParse(request.body);
      if (!body.success) {
        return reply.status(400).send({ error: { code: "VALIDATION", message: body.error.message } });
      }
      const row = await prisma.roleTemplate.update({ where: { id: id.data }, data: body.data });
      await recordAudit(request.auth!.sub, "role_template.update", `role_template:${id.data}`);
      return row;
    });

    app.delete<{ Params: { id: string } }>("/api/v1/role-templates/:id", { preHandler: auth }, async (request, reply) => {
      if (!requireAdmin(request, reply)) return;
      const id = z.string().uuid().safeParse(request.params.id);
      if (!id.success) {
        return reply.status(400).send({ error: { code: "VALIDATION", message: "Invalid id" } });
      }
      const inUse = await prisma.role.count({ where: { roleTemplateId: id.data } });
      if (inUse > 0) {
        return reply.status(409).send({
          error: {
            code: "IN_USE",
            message: "Cannot delete: team seats still reference this role type.",
          },
        });
      }
      await prisma.roleTemplateSkill.deleteMany({ where: { roleTemplateId: id.data } });
      await prisma.roleTemplate.delete({ where: { id: id.data } });
      await recordAudit(request.auth!.sub, "role_template.delete", `role_template:${id.data}`);
      return { deleted: true };
    });

    app.post("/api/v1/skill-templates", { preHandler: auth }, async (request, reply) => {
      if (!requireAdmin(request, reply)) return;
      const body = z
        .object({
          code: z.string().min(1).regex(/^[a-zA-Z0-9_]+$/),
          label: z.string().min(1),
          description: z.string().nullable().optional(),
          agentPrompt: z.string().nullable().optional(),
          sortOrder: z.number().int().optional(),
        })
        .safeParse(request.body);
      if (!body.success) {
        return reply.status(400).send({ error: { code: "VALIDATION", message: body.error.message } });
      }
      const trimmed = body.data.agentPrompt?.trim();
      const row = await prisma.skillTemplate.create({
        data: {
          code: body.data.code,
          label: body.data.label,
          description: body.data.description ?? null,
          /** null = built-in default from `prompt/skills/` when code matches Sarva catalog */
          agentPrompt: trimmed && trimmed.length > 0 ? trimmed : null,
          sortOrder: body.data.sortOrder ?? 0,
        },
      });
      await recordAudit(request.auth!.sub, "skill_template.create", `skill_template:${row.id}`);
      return serializeSkillTemplate(row);
    });

    app.patch<{ Params: { id: string } }>("/api/v1/skill-templates/:id", { preHandler: auth }, async (request, reply) => {
      if (!requireAdmin(request, reply)) return;
      const id = z.string().uuid().safeParse(request.params.id);
      if (!id.success) {
        return reply.status(400).send({ error: { code: "VALIDATION", message: "Invalid id" } });
      }
      const body = z
        .object({
          code: z.string().min(1).regex(/^[a-zA-Z0-9_]+$/).optional(),
          label: z.string().min(1).optional(),
          description: z.string().nullable().optional(),
          agentPrompt: z.string().nullable().optional(),
          sortOrder: z.number().int().optional(),
        })
        .safeParse(request.body);
      if (!body.success) {
        return reply.status(400).send({ error: { code: "VALIDATION", message: body.error.message } });
      }
      const patch = { ...body.data };
      if (patch.agentPrompt !== undefined) {
        const t = patch.agentPrompt?.trim();
        patch.agentPrompt = t && t.length > 0 ? t : null;
      }
      const row = await prisma.skillTemplate.update({ where: { id: id.data }, data: patch });
      await recordAudit(request.auth!.sub, "skill_template.update", `skill_template:${id.data}`);
      return serializeSkillTemplate(row);
    });

    app.delete<{ Params: { id: string } }>("/api/v1/skill-templates/:id", { preHandler: auth }, async (request, reply) => {
      if (!requireAdmin(request, reply)) return;
      const id = z.string().uuid().safeParse(request.params.id);
      if (!id.success) {
        return reply.status(400).send({ error: { code: "VALIDATION", message: "Invalid id" } });
      }
      const links = await prisma.roleSkillLink.count({ where: { skillTemplateId: id.data } });
      const tmplLinks = await prisma.roleTemplateSkill.count({ where: { skillTemplateId: id.data } });
      if (links > 0 || tmplLinks > 0) {
        return reply.status(409).send({
          error: {
            code: "IN_USE",
            message: "Remove skill from all seats and role types before deleting.",
          },
        });
      }
      await prisma.skillTemplate.delete({ where: { id: id.data } });
      await recordAudit(request.auth!.sub, "skill_template.delete", `skill_template:${id.data}`);
      return { deleted: true };
    });

    app.post("/api/v1/role-template-skills", { preHandler: auth }, async (request, reply) => {
      if (!requireAdmin(request, reply)) return;
      const body = z
        .object({
          roleTemplateId: z.string().uuid(),
          skillTemplateId: z.string().uuid(),
        })
        .safeParse(request.body);
      if (!body.success) {
        return reply.status(400).send({ error: { code: "VALIDATION", message: body.error.message } });
      }
      let createdCatalogLink = false;
      try {
        await prisma.roleTemplateSkill.create({
          data: {
            roleTemplateId: body.data.roleTemplateId,
            skillTemplateId: body.data.skillTemplateId,
          },
        });
        createdCatalogLink = true;
      } catch (e) {
        if (!(e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002")) {
          throw e;
        }
        const exists = await prisma.roleTemplateSkill.findUnique({
          where: {
            roleTemplateId_skillTemplateId: {
              roleTemplateId: body.data.roleTemplateId,
              skillTemplateId: body.data.skillTemplateId,
            },
          },
        });
        if (!exists) throw e;
      }
      if (createdCatalogLink) {
        await recordAudit(
          request.auth!.sub,
          "role_template_skill.create",
          `rt:${body.data.roleTemplateId}:st:${body.data.skillTemplateId}`,
        );
      }
      const propagated = await propagateTemplateSkillToAllRolesOfTemplate(
        prisma,
        body.data.roleTemplateId,
        body.data.skillTemplateId,
      );
      return {
        linked: createdCatalogLink,
        seatRolesPropagated: propagated.seatRoleCount,
      };
    });

    app.delete("/api/v1/role-template-skills", { preHandler: auth }, async (request, reply) => {
      if (!requireAdmin(request, reply)) return;
      const q = z
        .object({
          roleTemplateId: z.string().uuid(),
          skillTemplateId: z.string().uuid(),
        })
        .safeParse(request.query);
      if (!q.success) {
        return reply.status(400).send({ error: { code: "VALIDATION", message: q.error.message } });
      }
      await prisma.$transaction(async (tx) => {
        await tx.roleTemplateSkill.delete({
          where: {
            roleTemplateId_skillTemplateId: {
              roleTemplateId: q.data.roleTemplateId,
              skillTemplateId: q.data.skillTemplateId,
            },
          },
        });
        await revokeTemplateSkillFromAllRolesOfTemplate(tx, q.data.roleTemplateId, q.data.skillTemplateId);
      });
      await recordAudit(request.auth!.sub, "role_template_skill.delete", `rt:${q.data.roleTemplateId}:st:${q.data.skillTemplateId}`);
      return { deleted: true };
    });

    // --- Business units ---
    app.get("/api/v1/business-units", { preHandler: auth }, async () => {
      const companyId = await getCompanyId();
      if (!companyId) return [];
      return prisma.businessUnit.findMany({
        where: { companyId },
        orderBy: { name: "asc" },
        include: { _count: { select: { teams: true } } },
      });
    });

    app.post("/api/v1/business-units", { preHandler: auth }, async (request, reply) => {
      if (!requireAdmin(request, reply)) return;
      const companyId = await requireCompanyId().catch(() => null);
      if (!companyId) {
        return reply.status(400).send({ error: { code: "NO_COMPANY", message: "Create company first" } });
      }
      const body = z.object({ name: z.string().min(1) }).safeParse(request.body);
      if (!body.success) {
        return reply.status(400).send({ error: { code: "VALIDATION", message: body.error.message } });
      }
      const bu = await prisma.businessUnit.create({
        data: { companyId, name: body.data.name },
      });
      await recordAudit(request.auth!.sub, "business_unit.create", `business_unit:${bu.id}`);
      return bu;
    });

    app.delete<{ Params: { buId: string } }>("/api/v1/business-units/:buId", { preHandler: auth }, async (request, reply) => {
      if (!requireAdmin(request, reply)) return;
      const companyId = await getCompanyId();
      if (!companyId) {
        return reply.status(400).send({ error: { code: "NO_COMPANY", message: "Create company first" } });
      }
      const parsed = z.string().uuid().safeParse(request.params.buId);
      if (!parsed.success) {
        return reply.status(400).send({ error: { code: "VALIDATION", message: "Invalid business unit id" } });
      }
      const bu = await prisma.businessUnit.findFirst({
        where: { id: parsed.data, companyId },
        include: { _count: { select: { teams: true } } },
      });
      if (!bu) {
        return reply.status(404).send({ error: { code: "NOT_FOUND", message: "business unit" } });
      }
      if (bu._count.teams > 0) {
        return reply.status(409).send({
          error: {
            code: "NOT_EMPTY",
            message: "Remove or reassign teams before deleting this business unit.",
          },
        });
      }
      await prisma.businessUnit.delete({ where: { id: parsed.data } });
      await recordAudit(request.auth!.sub, "business_unit.delete", `business_unit:${parsed.data}`);
      return { deleted: true };
    });

    // --- Teams ---
    app.get("/api/v1/teams", { preHandler: auth }, async (request) => {
      const buId = (request.query as { businessUnitId?: string }).businessUnitId;
      return prisma.team.findMany({
        where: buId ? { businessUnitId: buId } : undefined,
        orderBy: { name: "asc" },
        take: 200,
        include: {
          _count: { select: { roles: true } },
        },
      });
    });

    app.post("/api/v1/teams", { preHandler: auth }, async (request, reply) => {
      if (!requireAdmin(request, reply)) return;
      const body = z
        .object({
          name: z.string().min(1),
          businessUnitId: z.string().uuid().nullable().optional(),
          charter: z.string().optional(),
          /** Headcount per Sarva role template (e.g. 3× Engineer, 1× SDM). */
          composition: z
            .array(
              z.object({
                roleTemplateId: z.string().uuid(),
                count: z.number().int().min(1).max(50),
              })
            )
            .optional(),
        })
        .safeParse(request.body);
      if (!body.success) {
        return reply.status(400).send({ error: { code: "VALIDATION", message: body.error.message } });
      }
      const composition = aggregateTeamComposition(body.data.composition ?? []);
      for (const row of composition) {
        const exists = await prisma.roleTemplate.findUnique({ where: { id: row.roleTemplateId }, select: { id: true } });
        if (!exists) {
          return reply.status(400).send({
            error: { code: "VALIDATION", message: `Unknown Sarva role template: ${row.roleTemplateId}` },
          });
        }
      }
      const team = await prisma.$transaction(async (tx) => {
        const t = await tx.team.create({
          data: {
            name: body.data.name,
            businessUnitId: body.data.businessUnitId ?? null,
            charter: body.data.charter ?? null,
          },
        });
        for (const row of composition) {
          const tmpl = await tx.roleTemplate.findUniqueOrThrow({ where: { id: row.roleTemplateId } });
          for (let i = 0; i < row.count; i++) {
            const seat = await tx.role.create({
              data: {
                teamId: t.id,
                roleTemplateId: tmpl.id,
                name: `${tmpl.label} ${i + 1}`,
              },
            });
            await ensureDefaultSkillsForRole(tx, seat.id, tmpl.id);
          }
        }
        return t;
      });
      await recordAudit(request.auth!.sub, "team.create", `team:${team.id}`);
      return prisma.team.findUniqueOrThrow({
        where: { id: team.id },
        include: { _count: { select: { roles: true } } },
      });
    });

    app.patch<{ Params: { teamId: string } }>("/api/v1/teams/:teamId", { preHandler: auth }, async (request, reply) => {
      if (!requireAdmin(request, reply)) return;
      const { teamId } = request.params;
      const body = z
        .object({
          name: z.string().min(1).optional(),
          charter: z.string().nullable().optional(),
          businessUnitId: z.string().uuid().nullable().optional(),
        })
        .safeParse(request.body);
      if (!body.success) {
        return reply.status(400).send({ error: { code: "VALIDATION", message: body.error.message } });
      }
      const team = await prisma.team.update({ where: { id: teamId }, data: body.data });
      await recordAudit(request.auth!.sub, "team.update", `team:${teamId}`);
      return team;
    });

    app.delete<{ Params: { teamId: string } }>("/api/v1/teams/:teamId", { preHandler: auth }, async (request, reply) => {
      if (!requireAdmin(request, reply)) return;
      const parsed = z.string().uuid().safeParse(request.params.teamId);
      if (!parsed.success) {
        return reply.status(400).send({ error: { code: "VALIDATION", message: "Invalid team id" } });
      }
      const companyId = await getCompanyId();
      if (!companyId) {
        return reply.status(400).send({ error: { code: "NO_COMPANY", message: "Create company first" } });
      }
      const team = await prisma.team.findFirst({
        where: {
          id: parsed.data,
          OR: [{ businessUnit: { companyId } }, { businessUnitId: null }],
        },
      });
      if (!team) {
        return reply.status(404).send({ error: { code: "NOT_FOUND", message: "Team not found" } });
      }
      await prisma.team.delete({ where: { id: parsed.data } });
      await recordAudit(request.auth!.sub, "team.delete", `team:${parsed.data}`);
      return { deleted: true };
    });

    // --- Roles ---
    app.get("/api/v1/roles", { preHandler: auth }, async (request, reply) => {
      const q = request.query as { teamId?: string; all?: string };
      if (q.all === "true" || q.all === "1") {
        if (!requireAdmin(request, reply)) return;
        const companyId = await getCompanyId();
        if (!companyId) {
          return reply.status(400).send({ error: { code: "NO_COMPANY", message: "Create company first" } });
        }
        return prisma.role.findMany({
          where: {
            team: {
              OR: [{ businessUnit: { companyId } }, { businessUnitId: null }],
            },
          },
          include: {
            team: { select: { id: true, name: true, businessUnitId: true } },
            roleTemplate: { select: { id: true, code: true, label: true } },
            skillLinks: { include: { skillTemplate: { select: { id: true, code: true, label: true } } } },
          },
          orderBy: [{ team: { name: "asc" } }, { name: "asc" }],
          take: 500,
        });
      }
      const teamId = q.teamId;
      if (!teamId) {
        return [];
      }
      return prisma.role.findMany({
        where: { teamId },
        orderBy: { name: "asc" },
        include: { roleTemplate: { select: { id: true, code: true, label: true } } },
      });
    });

    app.post("/api/v1/roles", { preHandler: auth }, async (request, reply) => {
      if (!requireAdmin(request, reply)) return;
      const body = z
        .object({
          teamId: z.string().uuid(),
          roleTemplateId: z.string().uuid(),
        })
        .safeParse(request.body);
      if (!body.success) {
        return reply.status(400).send({ error: { code: "VALIDATION", message: body.error.message } });
      }
      const tmpl = await prisma.roleTemplate.findUnique({ where: { id: body.data.roleTemplateId } });
      if (!tmpl) {
        return reply.status(400).send({ error: { code: "VALIDATION", message: "Unknown role template" } });
      }
      const n = await prisma.role.count({
        where: { teamId: body.data.teamId, roleTemplateId: tmpl.id },
      });
      const role = await prisma.role.create({
        data: {
          teamId: body.data.teamId,
          roleTemplateId: tmpl.id,
          name: `${tmpl.label} ${n + 1}`,
        },
      });
      await ensureDefaultSkillsForRole(prisma, role.id, tmpl.id);
      await recordAudit(request.auth!.sub, "role.create", `role:${role.id}`);
      return prisma.role.findUniqueOrThrow({
        where: { id: role.id },
        include: { roleTemplate: true },
      });
    });

    app.delete<{ Params: { id: string } }>("/api/v1/roles/:id", { preHandler: auth }, async (request, reply) => {
      if (!requireAdmin(request, reply)) return;
      const parsed = z.string().uuid().safeParse(request.params.id);
      if (!parsed.success) {
        return reply.status(400).send({ error: { code: "VALIDATION", message: "Invalid seat id" } });
      }
      const companyId = await getCompanyId();
      if (!companyId) {
        return reply.status(400).send({ error: { code: "NO_COMPANY", message: "Create company first" } });
      }
      const role = await prisma.role.findFirst({
        where: {
          id: parsed.data,
          team: {
            OR: [{ businessUnit: { companyId } }, { businessUnitId: null }],
          },
        },
      });
      if (!role) {
        return reply.status(404).send({ error: { code: "NOT_FOUND", message: "Seat not found" } });
      }
      await prisma.role.delete({ where: { id: parsed.data } });
      await recordAudit(request.auth!.sub, "role.delete", `role:${parsed.data}`);
      return { deleted: true };
    });

    // --- Skills (company-scoped) ---
    app.get("/api/v1/skills", { preHandler: auth }, async (request, reply) => {
      const companyId = (request.query as { companyId?: string }).companyId ?? (await getCompanyId());
      if (!companyId) {
        return reply.status(400).send({ error: { code: "NO_COMPANY", message: "companyId or seeded company required" } });
      }
      return prisma.skill.findMany({ where: { companyId }, orderBy: { name: "asc" } });
    });

    app.post("/api/v1/skills", { preHandler: auth }, async (request, reply) => {
      if (!requireAdmin(request, reply)) return;
      const companyId = await requireCompanyId().catch(() => null);
      if (!companyId) {
        return reply.status(400).send({ error: { code: "NO_COMPANY", message: "Create company first" } });
      }
      const body = z.object({ name: z.string().min(1) }).safeParse(request.body);
      if (!body.success) {
        return reply.status(400).send({ error: { code: "VALIDATION", message: body.error.message } });
      }
      const skill = await prisma.skill.create({
        data: { companyId, name: body.data.name },
      });
      await recordAudit(request.auth!.sub, "skill.create", `skill:${skill.id}`);
      return skill;
    });

    app.delete<{ Params: { skillId: string } }>("/api/v1/skills/:skillId", { preHandler: auth }, async (request, reply) => {
      if (!requireAdmin(request, reply)) return;
      const { skillId } = request.params;
      await prisma.skill.delete({ where: { id: skillId } });
      await recordAudit(request.auth!.sub, "skill.delete", `skill:${skillId}`);
      return { deleted: true };
    });

    // --- Team role seat ↔ Sarva skill template ---
    app.post("/api/v1/role-skills", { preHandler: auth }, async (request, reply) => {
      if (!requireAdmin(request, reply)) return;
      const body = z
        .object({
          roleId: z.string().uuid(),
          skillTemplateId: z.string().uuid(),
        })
        .safeParse(request.body);
      if (!body.success) {
        return reply.status(400).send({ error: { code: "VALIDATION", message: body.error.message } });
      }
      const role = await prisma.role.findUnique({
        where: { id: body.data.roleId },
        include: { roleTemplate: true },
      });
      if (!role?.roleTemplateId) {
        return reply.status(400).send({
          error: { code: "VALIDATION", message: "Role has no Sarva role template; recreate team roles from catalog." },
        });
      }
      const allowed = await prisma.roleTemplateSkill.findFirst({
        where: {
          roleTemplateId: role.roleTemplateId,
          skillTemplateId: body.data.skillTemplateId,
        },
      });
      if (!allowed) {
        return reply.status(400).send({
          error: {
            code: "SKILL_NOT_ALLOWED_FOR_ROLE",
            message: "That skill is not available for this Sarva role type.",
          },
        });
      }
      const row = await prisma.roleSkillLink.create({
        data: { roleId: body.data.roleId, skillTemplateId: body.data.skillTemplateId },
      });
      await recordAudit(
        request.auth!.sub,
        "role_skill_link.create",
        `role:${body.data.roleId}:skill_template:${body.data.skillTemplateId}`
      );
      return row;
    });

    app.get("/api/v1/role-skills", { preHandler: auth }, async (request, reply) => {
      const roleId = (request.query as { roleId?: string }).roleId;
      const parsed = z.string().uuid().safeParse(roleId);
      if (!parsed.success) {
        return reply.status(400).send({ error: { code: "VALIDATION", message: "roleId query (uuid) required" } });
      }
      const links = await prisma.roleSkillLink.findMany({
        where: { roleId: parsed.data },
        include: { skillTemplate: true },
        orderBy: { skillTemplateId: "asc" },
      });
      return links.map((l) => ({
        ...l,
        skillTemplate: serializeSkillTemplate(l.skillTemplate),
      }));
    });

    app.delete("/api/v1/role-skills", { preHandler: auth }, async (request, reply) => {
      if (!requireAdmin(request, reply)) return;
      const q = z
        .object({
          roleId: z.string().uuid(),
          skillTemplateId: z.string().uuid(),
        })
        .safeParse(request.query);
      if (!q.success) {
        return reply.status(400).send({ error: { code: "VALIDATION", message: q.error.message } });
      }
      await prisma.roleSkillLink.delete({
        where: {
          roleId_skillTemplateId: { roleId: q.data.roleId, skillTemplateId: q.data.skillTemplateId },
        },
      });
      await recordAudit(
        request.auth!.sub,
        "role_skill_link.delete",
        `role:${q.data.roleId}:skill_template:${q.data.skillTemplateId}`
      );
      return { deleted: true };
    });

    // --- Model bindings (exactly one scope: company | agent | role). Legacy rows may still have skillId. ---
    app.get("/api/v1/model-bindings", { preHandler: auth }, async () => {
      return prisma.modelBinding.findMany({
        take: 500,
        orderBy: { priority: "asc" },
        include: {
          agent: { select: { id: true, name: true } },
          company: { select: { id: true, name: true } },
          role: { select: { id: true, name: true } },
          skill: { select: { id: true, name: true } },
          llmProviderConnection: {
            select: { id: true, name: true, provider: true, modelId: true, baseUrl: true },
          },
        },
      });
    });

    app.post("/api/v1/model-bindings", { preHandler: auth }, async (request, reply) => {
      if (!requireAdmin(request, reply)) return;
      const body = z
        .object({
          scopeType: z.enum(["company", "agent", "role"]),
          /** Required when scopeType is `agent` or `role` (must match an existing id). */
          scopeId: z.string().uuid().optional(),
          llmProviderConnectionId: z.string().uuid(),
          priority: z.number().int().default(0),
        })
        .safeParse(request.body);
      if (!body.success) {
        return reply.status(400).send({ error: { code: "VALIDATION", message: body.error.message } });
      }
      const companyId = await requireCompanyId().catch(() => null);
      if (!companyId) {
        return reply.status(400).send({ error: { code: "NO_COMPANY", message: "Create company first" } });
      }

      const conn = await prisma.llmProviderConnection.findFirst({
        where: { id: body.data.llmProviderConnectionId, companyId },
      });
      if (!conn) {
        return reply.status(400).send({ error: { code: "VALIDATION", message: "Unknown LLM provider connection for this company" } });
      }

      let companyIdSet: string | null = null;
      let agentId: string | null = null;
      let roleIdSet: string | null = null;

      if (body.data.scopeType === "company") {
        companyIdSet = companyId;
      } else if (body.data.scopeType === "agent") {
        if (!body.data.scopeId) {
          return reply.status(400).send({ error: { code: "VALIDATION", message: "scopeId required for agent scope" } });
        }
        const agent = await prisma.agent.findFirst({ where: { id: body.data.scopeId } });
        if (!agent) {
          return reply.status(400).send({ error: { code: "VALIDATION", message: "Unknown agent id" } });
        }
        agentId = body.data.scopeId;
      } else {
        if (!body.data.scopeId) {
          return reply.status(400).send({ error: { code: "VALIDATION", message: "scopeId required for role scope" } });
        }
        const role = await prisma.role.findFirst({ where: { id: body.data.scopeId } });
        if (!role) {
          return reply.status(400).send({ error: { code: "VALIDATION", message: "Unknown team role (seat) id" } });
        }
        roleIdSet = body.data.scopeId;
      }

      const binding = await prisma.modelBinding.create({
        data: {
          companyId: companyIdSet,
          roleId: roleIdSet,
          skillId: null,
          agentId,
          llmProviderConnectionId: conn.id,
          modelId: conn.modelId,
          priority: body.data.priority,
        },
      });
      await recordAudit(request.auth!.sub, "model_binding.create", `model_binding:${binding.id}`);
      return prisma.modelBinding.findUniqueOrThrow({
        where: { id: binding.id },
        include: {
          agent: { select: { id: true, name: true } },
          company: { select: { id: true, name: true } },
          role: { select: { id: true, name: true } },
          skill: { select: { id: true, name: true } },
          llmProviderConnection: {
            select: { id: true, name: true, provider: true, modelId: true, baseUrl: true },
          },
        },
      });
    });

    app.patch<{ Params: { id: string } }>("/api/v1/model-bindings/:id", { preHandler: auth }, async (request, reply) => {
      if (!requireAdmin(request, reply)) return;
      const id = z.string().uuid().safeParse(request.params.id);
      if (!id.success) {
        return reply.status(400).send({ error: { code: "VALIDATION", message: "Invalid id" } });
      }
      const body = z
        .object({
          llmProviderConnectionId: z.string().uuid().optional(),
          modelId: z.string().min(1).optional(),
          priority: z.number().int().optional(),
        })
        .safeParse(request.body);
      if (!body.success) {
        return reply.status(400).send({ error: { code: "VALIDATION", message: body.error.message } });
      }
      const companyId = await requireCompanyId().catch(() => null);
      const data: { llmProviderConnectionId?: string; modelId?: string; priority?: number } = {};
      if (body.data.priority !== undefined) data.priority = body.data.priority;
      if (body.data.llmProviderConnectionId !== undefined) {
        if (!companyId) {
          return reply.status(400).send({ error: { code: "NO_COMPANY", message: "Create company first" } });
        }
        const conn = await prisma.llmProviderConnection.findFirst({
          where: { id: body.data.llmProviderConnectionId, companyId },
        });
        if (!conn) {
          return reply.status(400).send({ error: { code: "VALIDATION", message: "Unknown LLM provider connection" } });
        }
        data.llmProviderConnectionId = conn.id;
        data.modelId = conn.modelId;
      } else if (body.data.modelId !== undefined) {
        data.modelId = body.data.modelId;
      }
      const row = await prisma.modelBinding.update({ where: { id: id.data }, data });
      await recordAudit(request.auth!.sub, "model_binding.update", `model_binding:${id.data}`);
      return row;
    });

    app.delete<{ Params: { id: string } }>("/api/v1/model-bindings/:id", { preHandler: auth }, async (request, reply) => {
      if (!requireAdmin(request, reply)) return;
      const id = z.string().uuid().safeParse(request.params.id);
      if (!id.success) {
        return reply.status(400).send({ error: { code: "VALIDATION", message: "Invalid id" } });
      }
      await prisma.modelBinding.delete({ where: { id: id.data } });
      await recordAudit(request.auth!.sub, "model_binding.delete", `model_binding:${id.data}`);
      return { deleted: true };
    });

    app.post<{ Params: { id: string } }>("/api/v1/model-bindings/:id/test", { preHandler: auth }, async (request, reply) => {
      if (!requireAdmin(request, reply)) return;
      const id = z.string().uuid().safeParse(request.params.id);
      if (!id.success) {
        return reply.status(400).send({ error: { code: "VALIDATION", message: "Invalid id" } });
      }
      const binding = await prisma.modelBinding.findFirst({
        where: { id: id.data },
        include: { llmProviderConnection: true },
      });
      if (!binding) {
        return reply.status(404).send({ error: { code: "NOT_FOUND", message: "binding" } });
      }
      if (!binding.llmProviderConnection) {
        return reply.status(400).send({
          error: {
            code: "NO_CONNECTION",
            message: "This binding has no provider connection — add one and save before testing.",
          },
        });
      }
      const cred = bindingToCredentials(binding);
      if (!cred) {
        return reply.status(400).send({ error: { code: "NO_CREDENTIALS", message: "Could not resolve credentials." } });
      }
      const result = await testResolvedLlmCredentials(cred, env);
      await recordAudit(request.auth!.sub, "model_binding.test", `model_binding:${id.data}`);
      return result;
    });

    // --- Agents & seats ---
    app.get("/api/v1/agents", { preHandler: auth }, async () => {
      return prisma.agent.findMany({ orderBy: { name: "asc" }, take: 200 });
    });

    app.post("/api/v1/agents", { preHandler: auth }, async (request, reply) => {
      if (!requireAdmin(request, reply)) return;
      const body = z
        .object({
          name: z.string().min(1),
          status: z.string().default("idle"),
        })
        .safeParse(request.body);
      if (!body.success) {
        return reply.status(400).send({ error: { code: "VALIDATION", message: body.error.message } });
      }
      const agent = await prisma.agent.create({
        data: { name: body.data.name, status: body.data.status },
      });
      await recordAudit(request.auth!.sub, "agent.create", `agent:${agent.id}`);
      return agent;
    });

    app.patch<{ Params: { agentId: string } }>("/api/v1/agents/:agentId", { preHandler: auth }, async (request, reply) => {
      if (!requireAdmin(request, reply)) return;
      const { agentId } = request.params;
      const body = z
        .object({
          name: z.string().optional(),
          status: z.string().optional(),
        })
        .safeParse(request.body);
      if (!body.success) {
        return reply.status(400).send({ error: { code: "VALIDATION", message: body.error.message } });
      }
      const agent = await prisma.agent.update({ where: { id: agentId }, data: body.data });
      await recordAudit(request.auth!.sub, "agent.update", `agent:${agentId}`);
      return agent;
    });

    app.get("/api/v1/agent-seats", { preHandler: auth }, async (request) => {
      const roleId = (request.query as { roleId?: string }).roleId;
      return prisma.agentSeat.findMany({
        where: roleId ? { roleId } : undefined,
        take: 500,
        orderBy: { id: "asc" },
        include: {
          assignedAgent: { select: { id: true, name: true } },
          role: {
            select: {
              id: true,
              name: true,
              team: { select: { id: true, name: true } },
              roleTemplate: { select: { id: true, code: true, label: true } },
            },
          },
        },
      });
    });

    app.post("/api/v1/agent-seats", { preHandler: auth }, async (request, reply) => {
      if (!requireAdmin(request, reply)) return;
      const body = z
        .object({
          roleId: z.string().uuid(),
          label: z.string().optional(),
          assignedAgentId: z.string().uuid().nullable().optional(),
        })
        .safeParse(request.body);
      if (!body.success) {
        return reply.status(400).send({ error: { code: "VALIDATION", message: body.error.message } });
      }
      const seat = await prisma.agentSeat.create({
        data: {
          roleId: body.data.roleId,
          label: body.data.label ?? null,
          assignedAgentId: body.data.assignedAgentId ?? null,
        },
      });
      await recordAudit(request.auth!.sub, "agent_seat.create", `agent_seat:${seat.id}`);
      return seat;
    });

    app.patch<{ Params: { seatId: string } }>("/api/v1/agent-seats/:seatId", { preHandler: auth }, async (request, reply) => {
      if (!requireAdmin(request, reply)) return;
      const { seatId } = request.params;
      const body = z
        .object({
          label: z.string().nullable().optional(),
          assignedAgentId: z.string().uuid().nullable().optional(),
        })
        .safeParse(request.body);
      if (!body.success) {
        return reply.status(400).send({ error: { code: "VALIDATION", message: body.error.message } });
      }
      const seat = await prisma.agentSeat.update({ where: { id: seatId }, data: body.data });
      await recordAudit(request.auth!.sub, "agent_seat.update", `agent_seat:${seatId}`);
      return seat;
    });

    // --- Sprints ---
    app.get("/api/v1/sprints", { preHandler: auth }, async (request) => {
      const projectId = (request.query as { projectId?: string }).projectId;
      if (!projectId) return [];
      return prisma.sprint.findMany({ where: { projectId }, orderBy: { startsAt: "asc" } });
    });

    app.post("/api/v1/sprints", { preHandler: auth }, async (request, reply) => {
      if (!requireAdmin(request, reply)) return;
      const body = z
        .object({
          projectId: z.string().uuid(),
          name: z.string().min(1),
          startsAt: z.string().datetime().optional(),
          endsAt: z.string().datetime().optional(),
        })
        .safeParse(request.body);
      if (!body.success) {
        return reply.status(400).send({ error: { code: "VALIDATION", message: body.error.message } });
      }
      const sprint = await prisma.sprint.create({
        data: {
          projectId: body.data.projectId,
          name: body.data.name,
          startsAt: body.data.startsAt ? new Date(body.data.startsAt) : null,
          endsAt: body.data.endsAt ? new Date(body.data.endsAt) : null,
        },
      });
      await recordAudit(request.auth!.sub, "sprint.create", `sprint:${sprint.id}`);
      return sprint;
    });

    // --- Team ↔ project (any signed-in user — operators complete intake without admin) ---
    app.post("/api/v1/team-projects", { preHandler: auth }, async (request, reply) => {
      const body = z
        .object({
          teamId: z.string().uuid(),
          projectId: z.string().uuid(),
        })
        .safeParse(request.body);
      if (!body.success) {
        return reply.status(400).send({ error: { code: "VALIDATION", message: body.error.message } });
      }
      const companyId = await getCompanyId();
      if (!companyId) {
        return reply.status(400).send({ error: { code: "NO_COMPANY", message: "Create company first" } });
      }
      const team = await prisma.team.findFirst({
        where: {
          id: body.data.teamId,
          OR: [{ businessUnit: { companyId } }, { businessUnitId: null }],
        },
        select: { id: true },
      });
      if (!team) {
        return reply.status(404).send({ error: { code: "NOT_FOUND", message: "Team not found" } });
      }
      const project = await prisma.project.findUnique({
        where: { id: body.data.projectId },
        select: { id: true },
      });
      if (!project) {
        return reply.status(404).send({ error: { code: "NOT_FOUND", message: "Project not found" } });
      }
      const existingForProject = await prisma.teamProject.findFirst({
        where: { projectId: body.data.projectId },
      });
      if (existingForProject && existingForProject.teamId !== body.data.teamId) {
        return reply.status(409).send({
          error: {
            code: "PROJECT_TEAM_LIMIT",
            message: "A project can only have one linked team. Unlink the current team on Intake, then link a different team.",
          },
        });
      }
      try {
        const row = await prisma.teamProject.create({
          data: { teamId: body.data.teamId, projectId: body.data.projectId },
        });
        await recordAudit(
          request.auth!.sub,
          "team_project.create",
          `team:${body.data.teamId}:project:${body.data.projectId}`
        );
        return row;
      } catch (e) {
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
          return reply.status(409).send({
            error: { code: "DUPLICATE", message: "This team is already linked to the project." },
          });
        }
        throw e;
      }
    });

    app.delete<{ Params: { projectId: string; teamId: string } }>(
      "/api/v1/team-projects/:projectId/:teamId",
      { preHandler: auth },
      async (request, reply) => {
        const projectIdParsed = z.string().uuid().safeParse(request.params.projectId);
        const teamIdParsed = z.string().uuid().safeParse(request.params.teamId);
        if (!projectIdParsed.success || !teamIdParsed.success) {
          return reply.status(400).send({ error: { code: "VALIDATION", message: "Invalid project or team id" } });
        }
        const companyId = await getCompanyId();
        if (!companyId) {
          return reply.status(400).send({ error: { code: "NO_COMPANY", message: "Create company first" } });
        }
        const team = await prisma.team.findFirst({
          where: {
            id: teamIdParsed.data,
            OR: [{ businessUnit: { companyId } }, { businessUnitId: null }],
          },
          select: { id: true },
        });
        if (!team) {
          return reply.status(404).send({ error: { code: "NOT_FOUND", message: "Team not found" } });
        }
        const project = await prisma.project.findUnique({
          where: { id: projectIdParsed.data },
          select: { id: true },
        });
        if (!project) {
          return reply.status(404).send({ error: { code: "NOT_FOUND", message: "Project not found" } });
        }
        const rm = await prisma.teamProject.deleteMany({
          where: { projectId: projectIdParsed.data, teamId: teamIdParsed.data },
        });
        if (rm.count === 0) {
          return reply.status(404).send({
            error: { code: "NOT_FOUND", message: "This team is not linked to the project." },
          });
        }
        await recordAudit(
          request.auth!.sub,
          "team_project.delete",
          `team:${teamIdParsed.data}:project:${projectIdParsed.data}`
        );
        return { ok: true as const };
      }
    );

  };
}
