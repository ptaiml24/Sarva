import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import type { Env } from "../config/env.js";
import { prisma } from "../lib/prisma.js";
import { createAuthPreHandler } from "../plugins/auth.js";
import { recordAudit } from "../lib/audit.js";
import { appendProjectChatMessage } from "../lib/projectChat.js";
import { IMPLEMENTATION_STATUS } from "../lib/projectDelivery.js";
import { deliveryPolicyRecord } from "../lib/deliveryPolicy.js";
import {
  buildIntakeContextPrefix,
  proposeBacklogFromRequirements,
  withProposeBindingFallback,
} from "../integrations/pmOrchestrator.js";
import { loadSeatForAgentOnProject } from "../lib/agentSeatPromptContext.js";
import { resolveWorkflowAgent } from "../lib/deliveryOrchestrationHub.js";
import { composePrdSystemPromptForSeat } from "../prompt/skills/composeSeatTaskPrompt.js";
import { runPrdGeneration } from "../integrations/prdLlm.js";

const ATTACH_MAX_BYTES = 8 * 1024 * 1024;

function kindFromWorkflow(w: { kind: string }) {
  return w.kind === "feature_dev" ? "feature_dev" : "full_e2e";
}

async function ensureEnvSetupProposedItem(
  projectId: string,
  kind: "full_e2e" | "feature_dev",
  repo: { cloneUrl: string | null; rootPath: string | null }
): Promise<void> {
  const drafts = await prisma.proposedBacklogItem.findMany({
    where: { projectId, status: "draft" },
  });
  const hasEnv = drafts.some((e) => {
    const t = String((e.payload as { title?: string }).title ?? "");
    return /environment setup/i.test(t);
  });
  if (hasEnv) {
    return;
  }
  const title =
    kind === "feature_dev"
      ? "Environment setup — sync local codebase"
      : "Environment setup — project scaffold and repository structure";
  const description =
    kind === "feature_dev"
      ? [
          "Ensure the working copy of the codebase is available and up to date before feature implementation.",
          repo.cloneUrl?.trim() ? `Git remote: ${repo.cloneUrl.trim()}` : "",
          repo.rootPath?.trim() ? `Local root: ${repo.rootPath.trim()}` : "",
          "If a Git URL is configured: clone or fetch and pull the latest default branch.",
        ]
          .filter(Boolean)
          .join("\n")
      : [
          "Create project folder layout, baseline repository, and minimal structure so implementation tasks can begin.",
          "Include README, source tree skeleton, and agreed baseline from design.",
        ].join("\n");
  await prisma.proposedBacklogItem.create({
    data: {
      projectId,
      source: "orchestrator",
      status: "draft",
      payload: { title, description, phase: 0 },
    },
  });
}

export function projectExperienceRoutes(env: Env): FastifyPluginAsync {
  const auth = createAuthPreHandler(env);
  return async (app) => {
    app.get("/api/v1/delivery-workflows", { preHandler: auth }, async () => {
      const items = await prisma.deliveryWorkflow.findMany({ orderBy: { name: "asc" } });
      return { items };
    });

    app.post("/api/v1/delivery-workflows", { preHandler: auth }, async (request, reply) => {
      if (request.auth?.role !== "admin") {
        return reply.status(403).send({ error: { code: "FORBIDDEN", message: "admin only" } });
      }
      const body = z
        .object({
          code: z
            .string()
            .min(2)
            .max(64)
            .regex(/^[a-z][a-z0-9_]*$/),
          name: z.string().min(1).max(200),
          description: z.string().max(4000).optional(),
          kind: z.enum(["full_e2e", "feature_dev"]),
        })
        .safeParse(request.body);
      if (!body.success) {
        return reply.status(400).send({ error: { code: "VALIDATION", message: body.error.message } });
      }
      const row = await prisma.deliveryWorkflow.create({
        data: {
          code: body.data.code,
          name: body.data.name,
          description: body.data.description ?? null,
          kind: body.data.kind,
          isBuiltin: false,
        },
      });
      await recordAudit(request.auth!.sub, "delivery_workflow.create", `workflow:${row.id}`);
      return row;
    });

    app.patch<{ Params: { workflowId: string } }>(
      "/api/v1/delivery-workflows/:workflowId",
      { preHandler: auth },
      async (request, reply) => {
        if (request.auth?.role !== "admin") {
          return reply.status(403).send({ error: { code: "FORBIDDEN", message: "admin only" } });
        }
        const idParse = z.string().uuid().safeParse(request.params.workflowId);
        if (!idParse.success) {
          return reply.status(400).send({ error: { code: "VALIDATION", message: "Invalid workflow id" } });
        }
        const existing = await prisma.deliveryWorkflow.findUnique({ where: { id: idParse.data } });
        if (!existing) {
          return reply.status(404).send({ error: { code: "NOT_FOUND", message: "workflow" } });
        }
        if (existing.isBuiltin) {
          return reply.status(409).send({ error: { code: "BUILTIN", message: "Cannot edit builtin workflow" } });
        }
        const body = z
          .object({
            name: z.string().min(1).max(200).optional(),
            description: z.string().max(4000).nullable().optional(),
            kind: z.enum(["full_e2e", "feature_dev"]).optional(),
          })
          .safeParse(request.body);
        if (!body.success) {
          return reply.status(400).send({ error: { code: "VALIDATION", message: body.error.message } });
        }
        const row = await prisma.deliveryWorkflow.update({
          where: { id: idParse.data },
          data: {
            ...(body.data.name !== undefined ? { name: body.data.name } : {}),
            ...(body.data.description !== undefined ? { description: body.data.description } : {}),
            ...(body.data.kind !== undefined ? { kind: body.data.kind } : {}),
          },
        });
        await recordAudit(request.auth!.sub, "delivery_workflow.update", `workflow:${row.id}`);
        return row;
      }
    );

    app.delete<{ Params: { workflowId: string } }>(
      "/api/v1/delivery-workflows/:workflowId",
      { preHandler: auth },
      async (request, reply) => {
        if (request.auth?.role !== "admin") {
          return reply.status(403).send({ error: { code: "FORBIDDEN", message: "admin only" } });
        }
        const idParse = z.string().uuid().safeParse(request.params.workflowId);
        if (!idParse.success) {
          return reply.status(400).send({ error: { code: "VALIDATION", message: "Invalid workflow id" } });
        }
        const existing = await prisma.deliveryWorkflow.findUnique({ where: { id: idParse.data } });
        if (!existing) {
          return reply.status(404).send({ error: { code: "NOT_FOUND", message: "workflow" } });
        }
        if (existing.isBuiltin) {
          return reply.status(409).send({ error: { code: "BUILTIN", message: "Cannot delete builtin workflow" } });
        }
        const inUse = await prisma.project.count({ where: { workflowId: idParse.data } });
        if (inUse > 0) {
          return reply.status(409).send({ error: { code: "IN_USE", message: "Workflow is assigned to projects" } });
        }
        await prisma.deliveryWorkflow.delete({ where: { id: idParse.data } });
        await recordAudit(request.auth!.sub, "delivery_workflow.delete", `workflow:${idParse.data}`);
        return { ok: true as const };
      }
    );

    app.get<{ Params: { projectId: string } }>(
      "/api/v1/projects/:projectId/attachments",
      { preHandler: auth },
      async (request, reply) => {
        const idParse = z.string().uuid().safeParse(request.params.projectId);
        if (!idParse.success) {
          return reply.status(400).send({ error: { code: "VALIDATION", message: "Invalid project id" } });
        }
        const rows = await prisma.projectAttachment.findMany({
          where: { projectId: idParse.data },
          orderBy: { createdAt: "desc" },
          select: { id: true, fileName: true, mimeType: true, byteSize: true, createdAt: true },
        });
        return { items: rows };
      }
    );

    app.post<{ Params: { projectId: string } }>(
      "/api/v1/projects/:projectId/attachments",
      { preHandler: auth },
      async (request, reply) => {
        const idParse = z.string().uuid().safeParse(request.params.projectId);
        if (!idParse.success) {
          return reply.status(400).send({ error: { code: "VALIDATION", message: "Invalid project id" } });
        }
        const body = z
          .object({
            fileName: z.string().min(1).max(512),
            mimeType: z.string().max(200).optional(),
            dataBase64: z.string().min(1),
          })
          .safeParse(request.body);
        if (!body.success) {
          return reply.status(400).send({ error: { code: "VALIDATION", message: body.error.message } });
        }
        let buf: Buffer;
        try {
          buf = Buffer.from(body.data.dataBase64, "base64");
        } catch {
          return reply.status(400).send({ error: { code: "VALIDATION", message: "Invalid base64" } });
        }
        if (buf.length === 0 || buf.length > ATTACH_MAX_BYTES) {
          return reply.status(400).send({
            error: { code: "TOO_LARGE", message: `Attachment must be 1 byte – ${ATTACH_MAX_BYTES} bytes` },
          });
        }
        const row = await prisma.projectAttachment.create({
          data: {
            projectId: idParse.data,
            fileName: body.data.fileName,
            mimeType: body.data.mimeType?.trim() || "application/octet-stream",
            byteSize: buf.length,
            data: new Uint8Array(buf),
          },
          select: { id: true, fileName: true, mimeType: true, byteSize: true, createdAt: true },
        });
        await recordAudit(request.auth!.sub, "project_attachment.create", `project:${idParse.data}`);
        return row;
      }
    );

    app.get<{ Params: { attachmentId: string } }>(
      "/api/v1/project-attachments/:attachmentId/download",
      { preHandler: auth },
      async (request, reply) => {
        const idParse = z.string().uuid().safeParse(request.params.attachmentId);
        if (!idParse.success) {
          return reply.status(400).send({ error: { code: "VALIDATION", message: "Invalid attachment id" } });
        }
        const row = await prisma.projectAttachment.findUnique({ where: { id: idParse.data } });
        if (!row) {
          return reply.status(404).send({ error: { code: "NOT_FOUND", message: "attachment" } });
        }
        reply.header("Content-Type", row.mimeType);
        reply.header("Content-Disposition", `attachment; filename="${encodeURIComponent(row.fileName)}"`);
        return reply.send(row.data);
      }
    );

    app.delete<{ Params: { attachmentId: string } }>(
      "/api/v1/project-attachments/:attachmentId",
      { preHandler: auth },
      async (request, reply) => {
        const idParse = z.string().uuid().safeParse(request.params.attachmentId);
        if (!idParse.success) {
          return reply.status(400).send({ error: { code: "VALIDATION", message: "Invalid attachment id" } });
        }
        const row = await prisma.projectAttachment.findUnique({ where: { id: idParse.data } });
        if (!row) {
          return reply.status(404).send({ error: { code: "NOT_FOUND", message: "attachment" } });
        }
        await prisma.projectAttachment.delete({ where: { id: idParse.data } });
        await recordAudit(request.auth!.sub, "project_attachment.delete", `project:${row.projectId}`);
        return { ok: true as const };
      }
    );

    app.get<{ Params: { projectId: string } }>(
      "/api/v1/projects/:projectId/prd",
      { preHandler: auth },
      async (request, reply) => {
        const idParse = z.string().uuid().safeParse(request.params.projectId);
        if (!idParse.success) {
          return reply.status(400).send({ error: { code: "VALIDATION", message: "Invalid project id" } });
        }
        const items = await prisma.prdArtifact.findMany({
          where: { projectId: idParse.data },
          orderBy: { updatedAt: "desc" },
          take: 30,
        });
        return { items };
      }
    );

    app.post<{ Params: { projectId: string } }>(
      "/api/v1/projects/:projectId/prd/generate-llm",
      { preHandler: auth },
      async (request, reply) => {
        const idParse = z.string().uuid().safeParse(request.params.projectId);
        if (!idParse.success) {
          return reply.status(400).send({ error: { code: "VALIDATION", message: "Invalid project id" } });
        }
        const project = await prisma.project.findUnique({
          where: { id: idParse.data },
          include: { workflow: true, context: true, repoScope: true },
        });
        if (!project?.workflowId) {
          return reply.status(409).send({
            error: { code: "NO_WORKFLOW", message: "Assign a delivery workflow on Intake before generating a PRD." },
          });
        }
        const input = z
          .object({ feedbackNotes: z.string().max(16_000).optional() })
          .safeParse(request.body ?? {});
        if (!input.success) {
          return reply.status(400).send({ error: { code: "VALIDATION", message: input.error.message } });
        }
        const feedback = input.data.feedbackNotes?.trim() ?? "";
        const resolution = await resolveWorkflowAgent(idParse.data, "prd", { logger: request.log });
        const prdAgentId = resolution.skillMatchAgentId ?? project.pmOrchestratorAgentId ?? null;
        const preferredRoleId = resolution.skillMatchRoleId ?? null;
        const company = await prisma.company.findFirst();
        let prefix = "";
        try {
          prefix = await buildIntakeContextPrefix(idParse.data);
        } catch {
          prefix = "";
        }
        const prior = await prisma.prdArtifact.findFirst({
          where: { projectId: idParse.data, status: "draft" },
          orderBy: { updatedAt: "desc" },
        });
        const userPrompt = [
          `Project: ${project.name} (${project.id})`,
          `Workflow: ${project.workflow?.name ?? project.workflowId} (${project.workflow?.kind ?? ""})`,
          prefix ? `\n${prefix}\n` : "",
          prior?.body?.trim() ? `Prior PRD draft:\n${prior.body.trim()}` : "",
          feedback ? `Author feedback to incorporate:\n${feedback}` : "",
          project.repoScope?.cloneUrl || project.repoScope?.rootPath
            ? `Repository: cloneUrl=${project.repoScope.cloneUrl ?? "—"} rootPath=${project.repoScope.rootPath ?? "—"}`
            : "",
        ]
          .filter(Boolean)
          .join("\n\n");

        try {
          const { markdown, usedLlm, modelLabel } = await withProposeBindingFallback(
            prdAgentId,
            company?.id ?? null,
            async ({ cred, modelLabel: ml }) => {
              const seat = await loadSeatForAgentOnProject(idParse.data, prdAgentId, { preferredRoleId });
              const systemPrompt = composePrdSystemPromptForSeat(seat);
              const out = await runPrdGeneration(userPrompt, cred, env, { systemPrompt });
              return { ...out, modelLabel: ml };
            },
            {
              roleId: preferredRoleId ?? undefined,
              bindingAudit: { projectId: idParse.data, workflow: "prd.generate" },
            }
          );

          const row = prior
            ? await prisma.prdArtifact.update({
                where: { id: prior.id },
                data: { body: markdown, feedbackNotes: feedback || null, status: "draft" },
              })
            : await prisma.prdArtifact.create({
                data: {
                  projectId: idParse.data,
                  title: "Product requirements",
                  body: markdown,
                  status: "draft",
                  feedbackNotes: feedback || null,
                },
              });

          const pmAgent =
            prdAgentId ?
              await prisma.agent.findUnique({ where: { id: prdAgentId }, select: { id: true, name: true } })
            : null;
          await appendProjectChatMessage({
            projectId: idParse.data,
            actorKind: pmAgent ? "agent" : "orchestrator",
            actorId: pmAgent?.id ?? null,
            actorLabel: pmAgent?.name ?? "Orchestrator",
            body: pmAgent ?
              `Generated updated PRD draft (${modelLabel}${usedLlm ? "" : ", stub"}).`
            : `Invoked PRD generation via orchestration (${modelLabel}${usedLlm ? "" : ", stub"}).`,
            meta: { event: "prd.generate", prdId: row.id, prdSeatAgentId: prdAgentId },
          });
          await recordAudit(request.auth!.sub, "prd.generate_llm", `project:${idParse.data}`);
          return { prd: row, usedLlm, modelLabel };
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          if (msg.includes("No LLM is configured")) {
            return reply.status(400).send({ error: { code: "NO_BINDING", message: msg } });
          }
          if (msg.includes("Could not resolve LLM credentials")) {
            return reply.status(400).send({ error: { code: "NO_CREDENTIALS", message: msg } });
          }
          return reply.status(400).send({ error: { code: "PRD_GENERATE_FAILED", message: msg } });
        }
      }
    );

    app.post<{ Params: { projectId: string } }>(
      "/api/v1/projects/:projectId/prd/approve",
      { preHandler: auth },
      async (request, reply) => {
        const idParse = z.string().uuid().safeParse(request.params.projectId);
        if (!idParse.success) {
          return reply.status(400).send({ error: { code: "VALIDATION", message: "Invalid project id" } });
        }
        const body = z.object({ prdId: z.string().uuid().optional() }).safeParse(request.body ?? {});
        if (!body.success) {
          return reply.status(400).send({ error: { code: "VALIDATION", message: body.error.message } });
        }
        const draft =
          body.data.prdId ?
            await prisma.prdArtifact.findFirst({
              where: { id: body.data.prdId, projectId: idParse.data, status: "draft" },
            })
          : await prisma.prdArtifact.findFirst({
              where: { projectId: idParse.data, status: "draft" },
              orderBy: { updatedAt: "desc" },
            });
        if (!draft) {
          return reply.status(409).send({ error: { code: "NO_DRAFT", message: "No draft PRD to approve." } });
        }
        await prisma.$transaction([
          prisma.prdArtifact.updateMany({
            where: { projectId: idParse.data, status: "approved" },
            data: { status: "superseded" },
          }),
          prisma.prdArtifact.update({
            where: { id: draft.id },
            data: { status: "approved" },
          }),
        ]);
        await appendProjectChatMessage({
          projectId: idParse.data,
          actorKind: "user",
          actorId: request.auth?.sub ?? null,
          actorLabel: "Operator",
          body: `Approved PRD (${draft.title}).`,
          meta: { event: "prd.approve", prdId: draft.id },
        });
        await recordAudit(request.auth!.sub, "prd.approve", `project:${idParse.data}`);
        const row = await prisma.prdArtifact.findUniqueOrThrow({ where: { id: draft.id } });
        return { prd: row };
      }
    );

    app.get<{ Params: { projectId: string }; Querystring: Record<string, string | undefined> }>(
      "/api/v1/projects/:projectId/chat",
      { preHandler: auth },
      async (request, reply) => {
        const idParse = z.string().uuid().safeParse(request.params.projectId);
        if (!idParse.success) {
          return reply.status(400).send({ error: { code: "VALIDATION", message: "Invalid project id" } });
        }
        const qr = request.query ?? {};
        const qstr = (key: string): string | undefined => {
          const v = (qr as Record<string, unknown>)[key];
          if (typeof v === "string") return v;
          if (Array.isArray(v) && typeof v[0] === "string") return v[0];
          return undefined;
        };
        const qParse = z
          .object({
            actorKind: z.string().min(1).max(120).optional(),
            /** Matches `meta.event` string prefix (post-filter within the fetched 500 rows). */
            metaEventPrefix: z.string().min(1).max(200).optional(),
          })
          .safeParse({ actorKind: qstr("actorKind"), metaEventPrefix: qstr("metaEventPrefix") });
        if (!qParse.success) {
          return reply.status(400).send({ error: { code: "VALIDATION", message: qParse.error.message } });
        }
        const { actorKind, metaEventPrefix } = qParse.data;
        let items = await prisma.projectChatMessage.findMany({
          where: {
            projectId: idParse.data,
            ...(actorKind?.trim() ? { actorKind: actorKind.trim() } : {}),
          },
          orderBy: { createdAt: "desc" },
          take: 500,
        });
        if (metaEventPrefix?.trim()) {
          const pref = metaEventPrefix.trim();
          items = items.filter((m) => {
            const meta = m.meta as Record<string, unknown> | null;
            const ev =
              meta && typeof meta.event === "string" ? meta.event : "";
            return ev.startsWith(pref);
          });
        }
        return { items };
      }
    );

    app.post<{ Params: { projectId: string } }>(
      "/api/v1/projects/:projectId/chat",
      { preHandler: auth },
      async (request, reply) => {
        const idParse = z.string().uuid().safeParse(request.params.projectId);
        if (!idParse.success) {
          return reply.status(400).send({ error: { code: "VALIDATION", message: "Invalid project id" } });
        }
        const body = z.object({ body: z.string().min(1).max(8000) }).safeParse(request.body);
        if (!body.success) {
          return reply.status(400).send({ error: { code: "VALIDATION", message: body.error.message } });
        }
        const row = await appendProjectChatMessage({
          projectId: idParse.data,
          actorKind: "user",
          actorId: request.auth?.sub ?? null,
          actorLabel: "Operator",
          body: body.data.body,
          meta: {},
        });
        if (!row) {
          return reply.status(400).send({ error: { code: "VALIDATION", message: "Empty message" } });
        }
        await recordAudit(request.auth!.sub, "project_chat.user_post", `project:${idParse.data}`);
        return row;
      }
    );

    app.post<{ Params: { projectId: string } }>(
      "/api/v1/projects/:projectId/delivery/generate-backlog",
      { preHandler: auth },
      async (request, reply) => {
        const idParse = z.string().uuid().safeParse(request.params.projectId);
        if (!idParse.success) {
          return reply.status(400).send({ error: { code: "VALIDATION", message: "Invalid project id" } });
        }
        const project = await prisma.project.findUnique({
          where: { id: idParse.data },
          include: { workflow: true, context: true, repoScope: true },
        });
        if (!project) {
          return reply.status(404).send({ error: { code: "NOT_FOUND", message: "project" } });
        }
        if (!project.workflowId || !project.workflow) {
          return reply.status(409).send({
            error: { code: "NO_WORKFLOW", message: "Workflow projects only. Use PM propose for legacy projects." },
          });
        }
        const prd = await prisma.prdArtifact.findFirst({
          where: { projectId: idParse.data, status: "approved" },
          orderBy: { updatedAt: "desc" },
        });
        if (!prd) {
          return reply.status(409).send({
            error: { code: "NO_PRD", message: "Approve the PRD on the Requirements tab first." },
          });
        }
        const design = await prisma.designArtifact.findFirst({
          where: { projectId: idParse.data, status: "approved" },
        });
        if (!design) {
          return reply.status(409).send({
            error: { code: "NO_DESIGN", message: "Approve a design artifact before generating backlog." },
          });
        }
        const wfKind = kindFromWorkflow(project.workflow);
        const parts = [
          "## Approved PRD\n",
          prd.body,
          "\n## Approved design\n",
          `### ${design.title}\n\n${design.body}`,
          project.context?.goals?.trim() ? `\n## Goals\n${project.context.goals}` : "",
          project.context?.brief?.trim() ? `\n## Requirements notes\n${project.context.brief}` : "",
          "\n## Instructions for backlog",
          " Produce a JSON array via the PM backlog tool (titles + descriptions + phase).",
          " The first item MUST be an environment / setup story as described below; you may add more items after it.",
          wfKind === "feature_dev"
            ? " Environment setup: ensure repository is available and current — clone or pull latest from the configured Git URL if provided."
            : " Environment setup: create project folder structure, baseline repo, and scaffolding so coding can begin.",
        ];
        const requirementsText = parts.join("\n");

        try {
          const result = await proposeBacklogFromRequirements(idParse.data, { requirementsText }, env, {
            orchestrationLogger: request.log,
          });
          await ensureEnvSetupProposedItem(idParse.data, wfKind, {
            cloneUrl: project.repoScope?.cloneUrl ?? null,
            rootPath: project.repoScope?.rootPath ?? null,
          });
          const backlogPm =
            project.pmOrchestratorAgentId ?
              await prisma.agent.findUnique({
                where: { id: project.pmOrchestratorAgentId },
                select: { id: true, name: true },
              })
            : null;
          await appendProjectChatMessage({
            projectId: idParse.data,
            actorKind: backlogPm ? "agent" : "orchestrator",
            actorId: backlogPm?.id ?? null,
            actorLabel: backlogPm?.name ?? "Orchestrator",
            body: backlogPm ?
              `Proposed backlog from approved PRD and design (${result.modelLabel}); ${result.proposed} draft item(s).`
            : `Orchestration proposed backlog from PRD and design (${result.modelLabel}); ${result.proposed} draft item(s).`,
            meta: { event: "backlog.generate", proposed: result.proposed },
          });
          await recordAudit(request.auth!.sub, "delivery.generate_backlog", `project:${idParse.data}`);
          const pol = deliveryPolicyRecord(project.deliveryPolicy);
          delete pol.lastAssignmentPlanAt;
          pol.workflowBacklogBaseline = {
            prdId: prd.id,
            designId: design.id,
            prdUpdatedAt: prd.updatedAt.toISOString(),
            designUpdatedAt: design.updatedAt.toISOString(),
          };
          await prisma.project.update({
            where: { id: idParse.data },
            data: {
              implementationStatus: IMPLEMENTATION_STATUS.BACKLOG_PROPOSED,
              deliveryPolicy: pol as object,
            },
          });
          return {
            proposed: result.proposed,
            usedLlm: result.usedLlm,
            modelLabel: result.modelLabel,
          };
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          return reply.status(400).send({ error: { code: "GENERATE_BACKLOG_FAILED", message: msg } });
        }
      }
    );
  };
}
