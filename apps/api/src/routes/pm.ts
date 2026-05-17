import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import type { Env } from "../config/env.js";
import { prisma } from "../lib/prisma.js";
import { createAuthPreHandler } from "../plugins/auth.js";
import { proposeBacklogFromRequirements } from "../integrations/pmOrchestrator.js";
import { IMPLEMENTATION_STATUS } from "../lib/projectDelivery.js";
import { recordAudit } from "../lib/audit.js";
import { parseDependsOnTitlesField } from "../lib/backlogDependencyTitles.js";
import { resolveDependencyHintsAfterTaskCreate } from "../lib/taskDependencyHints.js";

const proposeBody = z
  .object({
    items: z.array(z.object({ title: z.string().min(1), description: z.string().optional() })).optional(),
    requirementsText: z.string().optional(),
    documentLink: z.string().url().optional(),
    /** @deprecated Ignored; server always uses LLM (or PM_PROPOSE_E2E_STUB in tests). */
    useLlm: z.boolean().optional(),
  })
  .refine((d) => (d.items && d.items.length > 0) || (d.requirementsText && d.requirementsText.trim().length > 0), {
    message: "Provide `items` or `requirementsText`",
  });

export function pmRoutes(env: Env): FastifyPluginAsync {
  const auth = createAuthPreHandler(env);
  return async (app) => {
    app.get("/api/v1/projects/:projectId/proposed-backlog-items", { preHandler: auth }, async (request, reply) => {
      const projectId = (request.params as { projectId: string }).projectId;
      const idParse = z.string().uuid().safeParse(projectId);
      if (!idParse.success) {
        return reply.status(400).send({ error: { code: "VALIDATION", message: "Invalid project id" } });
      }
      const project = await prisma.project.findUnique({ where: { id: projectId } });
      if (!project) {
        return reply.status(404).send({ error: { code: "NOT_FOUND", message: "project" } });
      }
      const items = await prisma.proposedBacklogItem.findMany({
        where: { projectId },
        orderBy: { id: "asc" },
        take: 200,
      });
      return { items };
    });

    app.post("/api/v1/projects/:projectId/pm/propose", { preHandler: auth }, async (request, reply) => {
      const projectId = (request.params as { projectId: string }).projectId;
      const parsed = proposeBody.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: { code: "VALIDATION", message: parsed.error.message } });
      }
      const project = await prisma.project.findUnique({ where: { id: projectId } });
      if (!project) {
        return reply.status(404).send({ error: { code: "NOT_FOUND", message: "project" } });
      }
      if (project.workflowId) {
        const approvedDesign = await prisma.designArtifact.findFirst({
          where: { projectId, status: "approved" },
        });
        if (!approvedDesign) {
          return reply.status(409).send({
            error: {
              code: "NO_APPROVED_DESIGN",
              message:
                "Workflow projects require an approved design before PM propose / backlog drafts. Approve design on the Design tab, or use Generate backlog after design approval.",
            },
          });
        }
      }
      try {
        const result = await proposeBacklogFromRequirements(projectId, parsed.data, env, {
          orchestrationLogger: request.log,
        });
        await recordAudit(request.auth!.sub, "pm.propose", `project:${projectId}`);
        return {
          proposed: result.proposed,
          usedLlm: result.usedLlm,
          modelLabel: result.modelLabel,
        };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return reply.status(400).send({ error: { code: "PROPOSE_FAILED", message: msg } });
      }
    });

    app.post("/api/v1/proposed-backlog-items/:id/accept", { preHandler: auth }, async (request, reply) => {
      const id = (request.params as { id: string }).id;
      const proposed = await prisma.proposedBacklogItem.findUnique({ where: { id } });
      if (!proposed || proposed.status !== "draft") {
        return reply.status(409).send({ error: { code: "CONFLICT", message: "not draft" } });
      }
      const payload = proposed.payload as {
        title?: string;
        description?: string;
        phase?: number;
        dependsOnTitles?: unknown;
      };
      const phase =
        typeof payload.phase === "number" && Number.isFinite(payload.phase) ?
          Math.min(30, Math.max(0, Math.floor(payload.phase)))
        : 0;
      const dependsOnTitles = parseDependsOnTitlesField(payload.dependsOnTitles);
      const actorId = request.auth!.sub;
      const task = await prisma.$transaction(async (tx) => {
        await tx.proposedBacklogItem.update({
          where: { id },
          data: { status: "accepted" },
        });
        const created = await tx.task.create({
          data: {
            projectId: proposed.projectId,
            title: payload.title ?? "Untitled",
            description: payload.description ?? "",
            state: "backlog",
            executionPhase: phase,
            version: 1,
            dependencyHints: dependsOnTitles.length > 0 ? { dependsOnTitles } : undefined,
          },
        });
        await resolveDependencyHintsAfterTaskCreate(tx, proposed.projectId, created.id);
        return created;
      });
      const remainingDrafts = await prisma.proposedBacklogItem.count({
        where: { projectId: proposed.projectId, status: "draft" },
      });
      if (remainingDrafts === 0) {
        const proj = await prisma.project.findUnique({ where: { id: proposed.projectId } });
        if (proj?.implementationStatus === IMPLEMENTATION_STATUS.BACKLOG_PROPOSED) {
          await prisma.project.update({
            where: { id: proposed.projectId },
            data: { implementationStatus: IMPLEMENTATION_STATUS.BACKLOG_APPROVED },
          });
        }
      }
      if (actorId) {
        await recordAudit(actorId, "proposed_backlog.accept", `task:${task.id}`);
      }
      return { task };
    });
  };
}
