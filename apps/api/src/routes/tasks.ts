import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import type { Env } from "../config/env.js";
import { prisma } from "../lib/prisma.js";
import { createAuthPreHandler } from "../plugins/auth.js";
import { jsonError, TASK_CLAIM_CONFLICT, TASK_DEPENDENCY_GATE, TASK_PHASE_GATE, TASK_REVIEW_MAX_REVISIONS } from "../lib/errors.js";
import { recordAudit } from "../lib/audit.js";
import { findPhaseGateBlocking } from "../lib/taskPhaseGate.js";
import { findUndonePredecessors } from "../lib/taskDependency.js";
import { runCoderAgentForTask } from "../lib/coderAgentRun.js";
import { isCoderEligibleTask } from "../lib/coderTaskEligibility.js";
import { applyReviewVerdict } from "../lib/taskReviewFlow.js";
import { runAutomatedReviewAfterCoderSubmit } from "../lib/automatedReview.js";
import { closeLinkedProjectIssuesWhenTaskCompletes } from "../lib/projectIssueDeliveryTask.js";
import { runDeliveryOrchestrationHook } from "../lib/deliveryOrchestration.js";

const claimBody = z.object({
  assigneeAgentId: z.string().uuid(),
  expectedVersion: z.number().int().positive(),
});

export function taskRoutes(env: Env): FastifyPluginAsync {
  const auth = createAuthPreHandler(env);
  return async (app) => {
    app.get(
      "/api/v1/tasks",
      { preHandler: auth },
      async (request, reply) => {
        const raw = request.query as { projectId?: string | string[] };
        const first = raw.projectId;
        const projectId = Array.isArray(first) ? first[0] : first;
        const parsed = z
          .object({
            projectId: z.string().uuid({ message: "projectId must be a valid UUID" }),
          })
          .safeParse({ projectId });
        if (!parsed.success) {
          const msg = parsed.error.flatten().fieldErrors.projectId?.[0] ?? "Invalid query";
          return reply.status(400).send(jsonError("VALIDATION", msg));
        }
        const tasksRaw = await prisma.task.findMany({
          where: { projectId: parsed.data.projectId },
          /** Board and planning UIs: lowest execution phase first (wave 0 before 1), then stable title order. */
          orderBy: [{ executionPhase: "asc" }, { title: "asc" }, { id: "asc" }],
          take: 100,
          include: {
            sprint: { select: { id: true, name: true } },
            assigneeAgent: { select: { id: true, name: true } },
            implementingAgent: { select: { id: true, name: true } },
            dependsOn: { select: { predecessorTaskId: true } },
            targetRole: {
              include: {
                roleTemplate: { select: { id: true, code: true, label: true } },
                team: { select: { id: true, name: true } },
                skillLinks: { include: { skillTemplate: { select: { code: true } } } },
              },
            },
          },
        });
        const items = tasksRaw.map((row) => {
          const { targetRole, ...rest } = row;
          const coderEligible = isCoderEligibleTask({
            assigneeAgentId: row.assigneeAgentId,
            skillTags: row.skillTags,
            targetRole,
          });
          return {
            ...rest,
            targetRole:
              targetRole ?
                {
                  id: targetRole.id,
                  name: targetRole.name,
                  roleTemplate: targetRole.roleTemplate,
                  team: targetRole.team,
                }
              : null,
            coderEligible,
          };
        });
        return { items, nextCursor: null };
      }
    );

    app.post<{ Params: { taskId: string } }>(
      "/api/v1/tasks/:taskId/run-coder",
      { preHandler: auth },
      async (request, reply) => {
        const idParse = z.string().uuid().safeParse(request.params.taskId);
        if (!idParse.success) {
          return reply.status(400).send(jsonError("VALIDATION", "Invalid task id"));
        }
        let r;
        try {
          r = await runCoderAgentForTask(idParse.data, env, { orchestrationLogger: request.log });
        } catch (e) {
          request.log.error(e);
          const msg = e instanceof Error ? e.message : String(e);
          return reply.status(500).send(jsonError("RUN_CODER_FAILED", msg.slice(0, 800)));
        }
        const task = await prisma.task.findUnique({
          where: { id: idParse.data },
          include: {
            sprint: { select: { id: true, name: true } },
            assigneeAgent: { select: { id: true, name: true } },
            implementingAgent: { select: { id: true, name: true } },
            targetRole: {
              include: {
                roleTemplate: { select: { id: true, code: true, label: true } },
                team: { select: { id: true, name: true } },
              },
            },
          },
        });
        return { coderAgent: r, task };
      }
    );

    app.post<{ Params: { taskId: string } }>(
      "/api/v1/tasks/:taskId/run-automated-review",
      { preHandler: auth },
      async (request, reply) => {
        const idParse = z.string().uuid().safeParse(request.params.taskId);
        if (!idParse.success) {
          return reply.status(400).send(jsonError("VALIDATION", "Invalid task id"));
        }
        if (env.AGENT_AUTOMATED_REVIEW !== "true" && env.AGENT_AUTOMATED_REVIEW_E2E_STUB !== "true") {
          return reply.status(409).send(
            jsonError(
              "AUTOMATED_REVIEW_DISABLED",
              "Automated review is off in API env (set AGENT_AUTOMATED_REVIEW=true or AGENT_AUTOMATED_REVIEW_E2E_STUB=true for tests).",
              { taskId: idParse.data }
            )
          );
        }
        const row = await prisma.task.findUnique({
          where: { id: idParse.data },
          select: { id: true, projectId: true, title: true, state: true },
        });
        if (!row) {
          return reply.status(404).send(jsonError("NOT_FOUND", "Task not found", { taskId: idParse.data }));
        }
        if (row.state !== "review") {
          return reply.status(409).send(
            jsonError("TASK_NOT_IN_REVIEW", "Automated review can only run while the task is in the review column.", {
              taskId: idParse.data,
              state: row.state,
            })
          );
        }

        await runAutomatedReviewAfterCoderSubmit(idParse.data, env, request.log);

        const taskInclude = {
          sprint: { select: { id: true, name: true } },
          assigneeAgent: { select: { id: true, name: true } },
          implementingAgent: { select: { id: true, name: true } },
          targetRole: {
            include: {
              roleTemplate: { select: { id: true, code: true, label: true } },
              team: { select: { id: true, name: true } },
            },
          },
        };
        const task = await prisma.task.findUnique({
          where: { id: idParse.data },
          include: taskInclude,
        });

        const actorId = request.auth?.sub;
        if (actorId) {
          await recordAudit(actorId, "task.run_automated_review", `task:${idParse.data}`);
        }

        return {
          task,
          message: `Automated review step finished for "${row.title}". Check Chat if the verdict failed or stalled.`,
        };
      }
    );

    app.post<{ Params: { taskId: string } }>(
      "/api/v1/tasks/:taskId/review-verdict",
      { preHandler: auth },
      async (request, reply) => {
        const idParse = z.string().uuid().safeParse(request.params.taskId);
        if (!idParse.success) {
          return reply.status(400).send(jsonError("VALIDATION", "Invalid task id"));
        }
        const body = z
          .object({
            verdict: z.enum(["approve", "request_changes"]),
            expectedVersion: z.number().int().positive(),
            notes: z.string().max(8000).optional(),
          })
          .safeParse(request.body);
        if (!body.success) {
          return reply.status(400).send(jsonError("VALIDATION", body.error.message));
        }
        const r = await applyReviewVerdict({
          taskId: idParse.data,
          expectedVersion: body.data.expectedVersion,
          verdict: body.data.verdict,
          notes: body.data.notes,
          env,
        });
        if (!r.ok) {
          if (r.skippedReason === TASK_REVIEW_MAX_REVISIONS) {
            const t = await prisma.task.findUnique({
              where: { id: idParse.data },
              select: { reviewRevisionCount: true },
            });
            return reply.status(409).send(
              jsonError(TASK_REVIEW_MAX_REVISIONS, "Maximum review revision rounds reached for this task.", {
                taskId: idParse.data,
                reviewRevisionCount: t?.reviewRevisionCount ?? null,
                maxRounds: env.AGENT_AUTOMATED_REVIEW_MAX_ROUNDS,
              })
            );
          }
          return reply
            .status(409)
            .send(jsonError(TASK_CLAIM_CONFLICT, r.skippedReason ?? "Review verdict failed", { taskId: idParse.data }));
        }
        let coderFollowUp: Awaited<ReturnType<typeof runCoderAgentForTask>> | undefined;
        if (
          r.appliedVerdict === "request_changes" &&
          (env.AGENT_CODER_USE_LLM === "true" || env.AGENT_CODER_E2E_STUB === "true") &&
          env.AGENT_CODER_ON_REVIEW_FEEDBACK === "true"
        ) {
          try {
            coderFollowUp = await runCoderAgentForTask(idParse.data, env, { orchestrationLogger: request.log });
          } catch (e) {
            request.log.warn({ err: e }, "coder_after_review_feedback_failed");
            coderFollowUp = {
              ran: false,
              error: e instanceof Error ? e.message : String(e),
            };
          }
        }
        const task = await prisma.task.findUnique({
          where: { id: idParse.data },
          include: {
            sprint: { select: { id: true, name: true } },
            assigneeAgent: { select: { id: true, name: true } },
            implementingAgent: { select: { id: true, name: true } },
            targetRole: {
              include: {
                roleTemplate: { select: { id: true, code: true, label: true } },
                team: { select: { id: true, name: true } },
              },
            },
          },
        });
        const actorId = request.auth?.sub;
        if (actorId) {
          await recordAudit(actorId, "task.review_verdict", `task:${idParse.data}`);
        }
        return { task, coderFollowUp };
      }
    );

    app.post<{ Params: { taskId: string } }>(
      "/api/v1/tasks/:taskId/claim",
      { preHandler: auth },
      async (request, reply) => {
        const parsed = claimBody.safeParse(request.body);
        if (!parsed.success) {
          return reply.status(400).send({ error: { code: "VALIDATION", message: parsed.error.message } });
        }
        const { taskId } = request.params;
        const { assigneeAgentId, expectedVersion } = parsed.data;
        const actorId = request.auth?.sub;
        if (!actorId) {
          return reply.status(401).send(jsonError("UNAUTHORIZED", "Not authenticated"));
        }

        try {
          const task = await prisma.$transaction(async (tx) => {
            const current = await tx.task.findUnique({ where: { id: taskId } });
            if (!current || current.version !== expectedVersion) {
              return null;
            }
            if (current.state !== "todo") {
              return null;
            }
            const myPhase = current.executionPhase ?? 0;
            const blocking = await findPhaseGateBlocking(tx, current.projectId, myPhase);
            if (blocking.length > 0) {
              return { type: "phase_gate" as const, blocking };
            }

            const depBlocking = await findUndonePredecessors(tx, taskId);
            if (depBlocking.length > 0) {
              return { type: "dependency_gate" as const, depBlocking };
            }

            const result = await tx.task.updateMany({
              where: {
                id: taskId,
                version: expectedVersion,
                state: "todo",
              },
              data: {
                state: "in_progress",
                assigneeAgentId,
                version: { increment: 1 },
              },
            });

            if (result.count === 0) {
              return null;
            }

            const updated = await tx.task.findUniqueOrThrow({ where: { id: taskId } });

            await tx.auditEvent.create({
              data: {
                actorId,
                action: "task.claim",
                resourceRef: `task:${taskId}`,
                payloadHash: null,
              },
            });

            return { type: "ok" as const, task: updated };
          });

          if (!task) {
            return reply.status(409).send(jsonError(TASK_CLAIM_CONFLICT, "Task already claimed or state changed", { taskId }));
          }
          if (task.type === "phase_gate") {
            return reply.status(409).send(
              jsonError(
                TASK_PHASE_GATE,
                "Earlier execution phases must be completed (tasks marked done) before claiming work in this phase.",
                { taskId, blocking: task.blocking }
              )
            );
          }
          if (task.type === "dependency_gate") {
            return reply.status(409).send(
              jsonError(
                TASK_DEPENDENCY_GATE,
                "This task cannot start until all predecessor tasks are marked done.",
                { taskId, blocking: task.depBlocking }
              )
            );
          }

          let coderAgent: Awaited<ReturnType<typeof runCoderAgentForTask>> | undefined;
          try {
            coderAgent = await runCoderAgentForTask(task.task.id, env, {
              orchestrationLogger: request.log,
            });
          } catch (e) {
            request.log.warn({ err: e }, "coder_agent_failed");
            coderAgent = {
              ran: false,
              error: e instanceof Error ? e.message : String(e),
            };
          }
          const latest = await prisma.task.findUnique({
            where: { id: task.task.id },
            include: {
              sprint: { select: { id: true, name: true } },
              assigneeAgent: { select: { id: true, name: true } },
              implementingAgent: { select: { id: true, name: true } },
              targetRole: {
                include: {
                  roleTemplate: { select: { id: true, code: true, label: true } },
                  team: { select: { id: true, name: true } },
                },
              },
            },
          });
          return { task: latest ?? task.task, coderAgent };
        } catch (e) {
          request.log.error(e);
          return reply.status(500).send(jsonError("INTERNAL", "Claim failed"));
        }
      }
    );

    app.patch<{ Params: { taskId: string } }>(
      "/api/v1/tasks/:taskId",
      { preHandler: auth },
      async (request, reply) => {
        const idParse = z.string().uuid().safeParse(request.params.taskId);
        if (!idParse.success) {
          return reply.status(400).send(jsonError("VALIDATION", "Invalid task id"));
        }
        const linkedBranchField = z
          .union([z.string().min(1).max(500), z.literal(""), z.null()])
          .optional();
        const linkedPrUrlField = z.union([z.string().url(), z.literal(""), z.null()]).optional();
        const body = z
          .object({
            state: z.string().optional(),
            expectedVersion: z.number().int().positive(),
            targetRoleId: z.string().uuid().nullable().optional(),
            sprintId: z.string().uuid().nullable().optional(),
            /** Delivery wave (`execution_phase`): must be ≥ any predecessor task’s wave for dependencies to behave. */
            executionPhase: z.number().int().min(0).max(50).optional(),
            linkedBranch: linkedBranchField,
            linkedPrUrl: linkedPrUrlField,
            blockedReason: z.union([z.string().max(4000), z.literal(""), z.null()]).optional(),
            escalationStrikes: z.number().int().min(0).max(99).optional(),
          })
          .safeParse(request.body);
        if (!body.success) {
          return reply.status(400).send({ error: { code: "VALIDATION", message: body.error.message } });
        }
        const {
          state,
          expectedVersion,
          targetRoleId,
          sprintId,
          executionPhase,
          linkedBranch,
          linkedPrUrl,
          blockedReason,
          escalationStrikes,
        } = body.data;

        const branchValue =
          linkedBranch === undefined ? undefined : linkedBranch === "" || linkedBranch === null ? null : linkedBranch;
        const prValue =
          linkedPrUrl === undefined ? undefined : linkedPrUrl === "" || linkedPrUrl === null ? null : linkedPrUrl;
        const blockedValue =
          blockedReason === undefined
            ? undefined
            : blockedReason === "" || blockedReason === null
              ? null
              : blockedReason;

        const updated = await prisma.task.updateMany({
          where: { id: idParse.data, version: expectedVersion },
          data: {
            ...(state ? { state } : {}),
            ...(targetRoleId !== undefined ? { targetRoleId } : {}),
            ...(sprintId !== undefined ? { sprintId } : {}),
            ...(executionPhase !== undefined ? { executionPhase } : {}),
            ...(branchValue !== undefined ? { linkedBranch: branchValue } : {}),
            ...(prValue !== undefined ? { linkedPrUrl: prValue } : {}),
            ...(blockedValue !== undefined ? { blockedReason: blockedValue } : {}),
            ...(escalationStrikes !== undefined ? { escalationStrikes } : {}),
            version: { increment: 1 },
          },
        });
        if (updated.count === 0) {
          return reply.status(409).send(jsonError(TASK_CLAIM_CONFLICT, "Version conflict", { taskId: idParse.data }));
        }
        const task = await prisma.task.findUniqueOrThrow({ where: { id: idParse.data } });
        const actorId = request.auth?.sub;
        if (actorId) {
          await recordAudit(actorId, "task.update", `task:${idParse.data}`);
        }
        if (state === "done") {
          await closeLinkedProjectIssuesWhenTaskCompletes(idParse.data);
          await runDeliveryOrchestrationHook(task.projectId, env);
        }
        return { task };
      }
    );
  };
}
