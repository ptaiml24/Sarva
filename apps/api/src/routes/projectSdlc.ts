import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import type { Env } from "../config/env.js";
import { prisma } from "../lib/prisma.js";
import { createAuthPreHandler } from "../plugins/auth.js";
import { recordAudit } from "../lib/audit.js";
import { appendProjectChatMessage } from "../lib/projectChat.js";
import { IMPLEMENTATION_STATUS } from "../lib/projectDelivery.js";
import {
  bindingToCredentials,
  buildIntakeContextPrefix,
  resolveDesignLlmAgentId,
  resolveBindingPreferringAgent,
} from "../integrations/pmOrchestrator.js";
import { loadSeatForAgentOnProject } from "../lib/agentSeatPromptContext.js";
import { resolveWorkflowAgent } from "../lib/deliveryOrchestrationHub.js";
import { composeDesignSystemPromptForSeat } from "../prompt/skills/composeSeatTaskPrompt.js";
import { runDesignGeneration } from "../integrations/designLlm.js";
import { deliveryPolicyRecord } from "../lib/deliveryPolicy.js";

/** Newest draft = full body (capped); older = titles only — avoids prompt size growing with N large artifacts. */
function buildPriorDesignPromptBlock(
  priorArtifacts: { title: string; body: string; status: string }[],
  anchorMaxChars: number,
  olderTitleListMax: number
): string {
  if (priorArtifacts.length === 0) return "";
  const truncate = (s: string, max: number) => {
    const t = s.trim();
    if (t.length <= max) return t;
    return `${t.slice(0, max)}\n\n[…truncated]`;
  };
  const [newest, ...older] = priorArtifacts;
  const parts = [
    "Most recent design artifact (primary continuity — preserve unless instructions say otherwise):",
    `### ${newest.title} (${newest.status})\n\n${truncate(newest.body, anchorMaxChars)}`,
  ];
  const olderSlice = older.slice(0, olderTitleListMax);
  if (olderSlice.length > 0) {
    parts.push(
      "Older drafts (titles only — keep decisions from the newest full artifact unless you are explicitly revising them):",
      olderSlice.map((a, i) => `${i + 1}. ${a.title} (${a.status})`).join("\n")
    );
  }
  const omitted = older.length - olderSlice.length;
  if (omitted > 0) {
    parts.push(`(${omitted} older artifact(s) omitted from this list.)`);
  }
  return parts.join("\n\n");
}

export const PROJECT_DUTIES = ["sdm_delivery", "tpm_sprint"] as const;
export type ProjectDuty = (typeof PROJECT_DUTIES)[number];

export function projectSdlcRoutes(env: Env): FastifyPluginAsync {
  const auth = createAuthPreHandler(env);
  return async (app) => {
    app.get<{ Params: { projectId: string } }>(
      "/api/v1/projects/:projectId/design-artifacts",
      { preHandler: auth },
      async (request, reply) => {
        const idParse = z.string().uuid().safeParse(request.params.projectId);
        if (!idParse.success) {
          return reply.status(400).send({ error: { code: "VALIDATION", message: "Invalid project id" } });
        }
        const rows = await prisma.designArtifact.findMany({
          where: { projectId: idParse.data },
          orderBy: { updatedAt: "desc" },
          take: 50,
        });
        return { items: rows };
      }
    );

    app.post<{ Params: { projectId: string } }>(
      "/api/v1/projects/:projectId/design-artifacts",
      { preHandler: auth },
      async (request, reply) => {
        const idParse = z.string().uuid().safeParse(request.params.projectId);
        if (!idParse.success) {
          return reply.status(400).send({ error: { code: "VALIDATION", message: "Invalid project id" } });
        }
        const body = z.object({ title: z.string().min(1), body: z.string().default("") }).safeParse(request.body);
        if (!body.success) {
          return reply.status(400).send({ error: { code: "VALIDATION", message: body.error.message } });
        }
        const row = await prisma.designArtifact.create({
          data: {
            projectId: idParse.data,
            title: body.data.title,
            body: body.data.body,
            status: "draft",
          },
        });
        await recordAudit(request.auth!.sub, "design_artifact.create", `project:${idParse.data}`);
        return row;
      }
    );

    app.post<{ Params: { projectId: string } }>(
      "/api/v1/projects/:projectId/design-artifacts/generate-llm",
      { preHandler: auth },
      async (request, reply) => {
        const idParse = z.string().uuid().safeParse(request.params.projectId);
        if (!idParse.success) {
          return reply.status(400).send({ error: { code: "VALIDATION", message: "Invalid project id" } });
        }
        const project = await prisma.project.findUnique({ where: { id: idParse.data } });
        if (!project) {
          return reply.status(404).send({ error: { code: "NOT_FOUND", message: "project" } });
        }
        const st = project.implementationStatus;
        const usesWorkflow = Boolean(project.workflowId);

        if (!usesWorkflow) {
          const designAllowed: string[] = [
            IMPLEMENTATION_STATUS.BACKLOG_APPROVED,
            IMPLEMENTATION_STATUS.EXECUTING,
            IMPLEMENTATION_STATUS.READY_FOR_UAT,
            IMPLEMENTATION_STATUS.CLOSED,
          ];
          if (!designAllowed.includes(st)) {
            return reply.status(409).send({
              error: {
                code: "INVALID_STATE",
                message:
                  st === IMPLEMENTATION_STATUS.BACKLOG_PROPOSED
                    ? "Accept or reject every draft backlog item first (Backlog tab), then generate design."
                    : "Backlog must be approved before SDM design generation. Finish Backlog first.",
              },
            });
          }
        } else {
          const prdApproved = await prisma.prdArtifact.findFirst({
            where: { projectId: idParse.data, status: "approved" },
          });
          if (!prdApproved) {
            return reply.status(409).send({
              error: {
                code: "NO_APPROVED_PRD",
                message: "Approve the PRD on the Requirements tab before generating design.",
              },
            });
          }
        }
        const input = z
          .object({
            /** Human steering for regeneration (open questions, constraints, deltas). */
            extraInstructions: z.string().max(24_000).optional(),
          })
          .safeParse(request.body ?? {});
        if (!input.success) {
          return reply.status(400).send({ error: { code: "VALIDATION", message: input.error.message } });
        }
        const extra = input.data.extraInstructions?.trim() ?? "";
        const anchorMax = env.DESIGN_GENERATE_PRIOR_ANCHOR_MAX_CHARS ?? 18_000;
        const olderTitleMax = env.DESIGN_GENERATE_PRIOR_TITLE_LIST_MAX ?? 7;
        const priorFetchTake = 1 + olderTitleMax;
        try {
          const prefix = await buildIntakeContextPrefix(idParse.data);
          const prdApprovedRow = usesWorkflow
            ? await prisma.prdArtifact.findFirst({
                where: { projectId: idParse.data, status: "approved" },
                orderBy: { updatedAt: "desc" },
              })
            : null;
          const prdBlock =
            prdApprovedRow ?
              `Approved PRD (${prdApprovedRow.title}):\n${prdApprovedRow.body.trim().slice(0, 28_000)}${prdApprovedRow.body.trim().length > 28_000 ? "\n\n…(truncated)" : ""}`
            : "";

          const [tasks, priorArtifacts] = await Promise.all([
            prisma.task.findMany({
              where: { projectId: idParse.data },
              orderBy: { id: "asc" },
              take: 50,
              select: { title: true, state: true },
            }),
            prisma.designArtifact.findMany({
              where: { projectId: idParse.data },
              orderBy: { updatedAt: "desc" },
              take: priorFetchTake,
              select: { title: true, body: true, status: true },
            }),
          ]);
          const taskLines =
            tasks.length > 0 ? tasks.map((t) => `- ${t.title} (${t.state})`).join("\n") : "(no tasks yet)";
          const priorBlock = buildPriorDesignPromptBlock(priorArtifacts, anchorMax, olderTitleMax);
          const closing =
            priorArtifacts.length > 0 ?
              "Output a single complete design document in Markdown (not a patch/diff). Merge prior content with any new decisions; resolve open questions where instructions provide answers."
            : "Produce the design document for implementing this work.";
          const userPrompt = [
            prefix.trim() ? `Project context:\n${prefix}` : "",
            usesWorkflow && prdBlock ? `Product requirements:\n${prdBlock}` : "",
            `Backlog / tasks (may be empty early in the flow):\n${taskLines}`,
            priorBlock,
            extra
              ? [
                  "Author / reviewer instructions — address explicitly in the document (resolve or update open questions where applicable):",
                  extra,
                ].join("\n\n")
              : "",
            closing,
          ]
            .filter(Boolean)
            .join("\n\n");

          const resolution = await resolveWorkflowAgent(idParse.data, "design", { logger: request.log });
          const designAgentId = resolution.skillMatchAgentId ?? (await resolveDesignLlmAgentId(idParse.data));
          const preferredRoleId = resolution.skillMatchRoleId ?? null;
          const binding = await resolveBindingPreferringAgent(idParse.data, resolution.skillMatchAgentId ?? null, {
            preferredRoleId: resolution.skillMatchRoleId ?? null,
          });
          if (!binding) {
            return reply.status(400).send({
              error: {
                code: "NO_BINDING",
                message:
                  "No LLM binding for a skill-matched design seat, SDM, PM, or company. Configure Admin → Model bindings and a provider connection.",
              },
            });
          }
          const cred = bindingToCredentials(binding);
          if (!cred) {
            return reply.status(400).send({ error: { code: "NO_CREDENTIALS", message: "Could not resolve LLM credentials." } });
          }
          const seat = await loadSeatForAgentOnProject(idParse.data, designAgentId, { preferredRoleId });
          const systemPrompt = composeDesignSystemPromptForSeat(seat);
          const { markdown, usedLlm } = await runDesignGeneration(userPrompt, cred, env, { systemPrompt });
          const modelLabel =
            binding.llmProviderConnection?.name ?? binding.llmProviderConnection?.modelId ?? binding.modelId ?? "llm";
          const title = `LLM design · ${new Date().toISOString().replace("T", " ").slice(0, 19)} UTC`;
          const row = await prisma.designArtifact.create({
            data: {
              projectId: idParse.data,
              title,
              body: markdown,
              status: "draft",
            },
          });
          await appendProjectChatMessage({
            projectId: idParse.data,
            actorKind: "orchestrator",
            actorLabel: "Orchestrator",
            body: `Dispatched design agent to produce draft "${title}" (${modelLabel}${usedLlm ? "" : ", stub"}).`,
            meta: { artifactId: row.id },
          });
          await recordAudit(request.auth!.sub, "design_artifact.generate_llm", `project:${idParse.data}`);
          if (usesWorkflow) {
            const prdRow = await prisma.prdArtifact.findFirst({
              where: { projectId: idParse.data, status: "approved" },
              orderBy: { updatedAt: "desc" },
            });
            if (prdRow) {
              const proj = await prisma.project.findUnique({
                where: { id: idParse.data },
                select: { deliveryPolicy: true },
              });
              const pol = deliveryPolicyRecord(proj?.deliveryPolicy);
              pol.designLlmPrdWatermark = prdRow.updatedAt.toISOString();
              await prisma.project.update({
                where: { id: idParse.data },
                data: { deliveryPolicy: pol as object },
              });
            }
          }
          return { artifact: row, usedLlm, modelLabel };
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          return reply.status(400).send({ error: { code: "DESIGN_GENERATE_FAILED", message: msg } });
        }
      }
    );

    app.patch<{ Params: { artifactId: string } }>(
      "/api/v1/design-artifacts/:artifactId",
      { preHandler: auth },
      async (request, reply) => {
        const idParse = z.string().uuid().safeParse(request.params.artifactId);
        if (!idParse.success) {
          return reply.status(400).send({ error: { code: "VALIDATION", message: "Invalid artifact id" } });
        }
        const body = z
          .object({
            title: z.string().min(1).optional(),
            body: z.string().optional(),
            status: z.enum(["draft", "approved", "superseded"]).optional(),
          })
          .safeParse(request.body);
        if (!body.success) {
          return reply.status(400).send({ error: { code: "VALIDATION", message: body.error.message } });
        }
        const existing = await prisma.designArtifact.findUnique({ where: { id: idParse.data } });
        if (!existing) {
          return reply.status(404).send({ error: { code: "NOT_FOUND", message: "artifact" } });
        }

        if (body.data.status === "approved") {
          const row = await prisma.$transaction(async (tx) => {
            await tx.designArtifact.updateMany({
              where: { projectId: existing.projectId, id: { not: idParse.data }, status: "approved" },
              data: { status: "superseded" },
            });
            const updated = await tx.designArtifact.update({
              where: { id: idParse.data },
              data: {
                ...(body.data.title !== undefined ? { title: body.data.title } : {}),
                ...(body.data.body !== undefined ? { body: body.data.body } : {}),
                status: "approved",
              },
            });
            const proj = await tx.project.findUnique({
              where: { id: existing.projectId },
              select: { deliveryPolicy: true },
            });
            const pol = deliveryPolicyRecord(proj?.deliveryPolicy);
            const prd = await tx.prdArtifact.findFirst({
              where: { projectId: existing.projectId, status: "approved" },
              orderBy: { updatedAt: "desc" },
            });
            if (prd) {
              pol.designLlmPrdWatermark = prd.updatedAt.toISOString();
            }
            await tx.project.update({
              where: { id: existing.projectId },
              data: { deliveryPolicy: pol as object },
            });
            return updated;
          });
          await recordAudit(request.auth!.sub, "design_artifact.update", `artifact:${idParse.data}`);
          return row;
        }

        const row = await prisma.designArtifact.update({
          where: { id: idParse.data },
          data: {
            ...(body.data.title !== undefined ? { title: body.data.title } : {}),
            ...(body.data.body !== undefined ? { body: body.data.body } : {}),
            ...(body.data.status !== undefined ? { status: body.data.status } : {}),
          },
        });
        await recordAudit(request.auth!.sub, "design_artifact.update", `artifact:${idParse.data}`);
        return row;
      }
    );

    app.get<{ Params: { projectId: string } }>(
      "/api/v1/projects/:projectId/role-assignments",
      { preHandler: auth },
      async (request, reply) => {
        const idParse = z.string().uuid().safeParse(request.params.projectId);
        if (!idParse.success) {
          return reply.status(400).send({ error: { code: "VALIDATION", message: "Invalid project id" } });
        }
        const rows = await prisma.projectRoleAssignment.findMany({
          where: { projectId: idParse.data },
          include: { agent: { select: { id: true, name: true, status: true } } },
        });
        return { items: rows };
      }
    );

    app.put<{ Params: { projectId: string } }>(
      "/api/v1/projects/:projectId/role-assignments",
      { preHandler: auth },
      async (request, reply) => {
        const idParse = z.string().uuid().safeParse(request.params.projectId);
        if (!idParse.success) {
          return reply.status(400).send({ error: { code: "VALIDATION", message: "Invalid project id" } });
        }
        const body = z
          .object({
            assignments: z.array(
              z.object({
                duty: z.enum(PROJECT_DUTIES),
                agentId: z.string().uuid().nullable(),
              })
            ),
          })
          .safeParse(request.body);
        if (!body.success) {
          return reply.status(400).send({ error: { code: "VALIDATION", message: body.error.message } });
        }
        const project = await prisma.project.findUnique({ where: { id: idParse.data } });
        if (!project) {
          return reply.status(404).send({ error: { code: "NOT_FOUND", message: "project" } });
        }

        await prisma.$transaction(async (tx) => {
          for (const a of body.data.assignments) {
            if (a.agentId === null) {
              await tx.projectRoleAssignment.deleteMany({
                where: { projectId: idParse.data, duty: a.duty },
              });
            } else {
              await tx.projectRoleAssignment.upsert({
                where: {
                  projectId_duty: { projectId: idParse.data, duty: a.duty },
                },
                create: {
                  projectId: idParse.data,
                  duty: a.duty,
                  agentId: a.agentId,
                },
                update: { agentId: a.agentId },
              });
            }
          }
        });

        await recordAudit(request.auth!.sub, "project_role_assignment.put", `project:${idParse.data}`);
        const rows = await prisma.projectRoleAssignment.findMany({
          where: { projectId: idParse.data },
          include: { agent: { select: { id: true, name: true, status: true } } },
        });
        return { items: rows };
      }
    );
  };
}
