import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import type { Env } from "../config/env.js";
import { prisma } from "../lib/prisma.js";
import { createAuthPreHandler } from "../plugins/auth.js";
import { jsonError } from "../lib/errors.js";
import { recordAudit } from "../lib/audit.js";
import { dependencyEdgesHaveCycle, dependencyHasInvalidPhaseOrdering } from "../lib/taskDependency.js";
import { runDeliveryOrchestrationHook } from "../lib/deliveryOrchestration.js";

/** Additional task routes: single task, create, comments (kept separate for readability). */
export function taskExtraRoutes(env: Env): FastifyPluginAsync {
  const auth = createAuthPreHandler(env);
  return async (app) => {
    app.get<{ Params: { taskId: string } }>("/api/v1/tasks/:taskId", { preHandler: auth }, async (request, reply) => {
      const { taskId } = request.params;
      const task = await prisma.task.findUnique({
        where: { id: taskId },
        include: {
          dependsOn: { select: { predecessorTaskId: true } },
          dependents: { select: { successorTaskId: true } },
        },
      });
      if (!task) {
        return reply.status(404).send({ error: { code: "NOT_FOUND", message: "task" } });
      }
      return task;
    });

    app.delete<{ Params: { taskId: string } }>(
      "/api/v1/tasks/:taskId",
      { preHandler: auth },
      async (request, reply) => {
        const idParse = z.string().uuid().safeParse(request.params.taskId);
        if (!idParse.success) {
          return reply.status(400).send({ error: { code: "VALIDATION", message: "Invalid task id" } });
        }
        const actorId = request.auth?.sub;
        if (!actorId) {
          return reply.status(401).send(jsonError("UNAUTHORIZED", "Not authenticated"));
        }
        const task = await prisma.task.findUnique({
          where: { id: idParse.data },
          select: { id: true, projectId: true, state: true },
        });
        if (!task) {
          return reply.status(404).send({ error: { code: "NOT_FOUND", message: "task" } });
        }
        const removable = new Set(["backlog", "todo"]);
        if (!removable.has(task.state)) {
          return reply.status(409).send(
            jsonError(
              "INVALID_STATE",
              "Only backlog or todo tasks can be deleted. Move or finish work in other columns first."
            )
          );
        }
        await prisma.task.delete({ where: { id: task.id } });
        await recordAudit(actorId, "task.delete", `task:${task.id}`);
        await runDeliveryOrchestrationHook(task.projectId, env);
        return reply.status(204).send();
      }
    );

    app.put<{ Params: { taskId: string } }>(
      "/api/v1/tasks/:taskId/predecessors",
      { preHandler: auth },
      async (request, reply) => {
        const idParse = z.string().uuid().safeParse(request.params.taskId);
        if (!idParse.success) {
          return reply.status(400).send({ error: { code: "VALIDATION", message: "Invalid task id" } });
        }
        const body = z
          .object({
            predecessorTaskIds: z.array(z.string().uuid()).max(40),
          })
          .safeParse(request.body);
        if (!body.success) {
          return reply.status(400).send({ error: { code: "VALIDATION", message: body.error.message } });
        }
        const successorId = idParse.data;
        const rawPreds = body.data.predecessorTaskIds;
        const predecessorTaskIds = [...new Set(rawPreds)];

        const actorId = request.auth?.sub;
        if (!actorId) {
          return reply.status(401).send(jsonError("UNAUTHORIZED", "Not authenticated"));
        }

        const successor = await prisma.task.findUnique({
          where: { id: successorId },
          select: { projectId: true, executionPhase: true },
        });
        if (!successor) {
          return reply.status(404).send({ error: { code: "NOT_FOUND", message: "task" } });
        }
        if (predecessorTaskIds.includes(successorId)) {
          return reply.status(400).send({
            error: { code: "VALIDATION", message: "A task cannot depend on itself" },
          });
        }

        if (predecessorTaskIds.length > 0) {
          const preds = await prisma.task.findMany({
            where: { id: { in: predecessorTaskIds } },
            select: { id: true, projectId: true, title: true, executionPhase: true },
          });
          if (preds.length !== predecessorTaskIds.length) {
            return reply.status(400).send({
              error: { code: "VALIDATION", message: "One or more predecessor task ids are invalid" },
            });
          }
          const succPhase = successor.executionPhase ?? 0;
          for (const p of preds) {
            if (p.projectId !== successor.projectId) {
              return reply.status(400).send({
                error: {
                  code: "VALIDATION",
                  message: "All predecessor tasks must belong to the same project as the successor task",
                },
              });
            }
            if (dependencyHasInvalidPhaseOrdering(p.executionPhase, succPhase)) {
              return reply.status(400).send({
                error: {
                  code: "DEPENDENCY_PHASE_ORDER",
                  message:
                    `Predecessor "${p.title}" cannot be scheduled in execution phase ${p.executionPhase ?? 0} while successor is in phase ${succPhase}: finish-to-start deps require the prerequisite in the same wave or earlier (lower-or-equal executionPhase). Adjust phases on the Board or remove the mistaken dependency.`,
                },
              });
            }
          }
        }

        const existing = await prisma.taskDependency.findMany({
          where: { successor: { projectId: successor.projectId } },
          select: { successorTaskId: true, predecessorTaskId: true },
        });
        const nextEdges = [
          ...existing.filter((e) => e.successorTaskId !== successorId),
          ...predecessorTaskIds.map((predecessorTaskId) => ({ successorTaskId: successorId, predecessorTaskId })),
        ];
        if (dependencyEdgesHaveCycle(nextEdges)) {
          return reply.status(400).send({
            error: {
              code: "DEPENDENCY_CYCLE",
              message: "These dependencies would create a cycle (A before B before A). Adjust the graph and try again.",
            },
          });
        }

        await prisma.$transaction([
          prisma.taskDependency.deleteMany({ where: { successorTaskId: successorId } }),
          ...(predecessorTaskIds.length > 0 ?
            [
              prisma.taskDependency.createMany({
                data: predecessorTaskIds.map((predecessorTaskId) => ({
                  successorTaskId: successorId,
                  predecessorTaskId,
                })),
              }),
            ]
          : []),
          prisma.task.update({
            where: { id: successorId },
            data: { version: { increment: 1 } },
          }),
        ]);

        await recordAudit(actorId, "task.predecessors.replace", `task:${successorId}`);

        const updated = await prisma.task.findUniqueOrThrow({
          where: { id: successorId },
          include: { dependsOn: { select: { predecessorTaskId: true } } },
        });
        return { task: updated };
      }
    );

    app.post("/api/v1/tasks", { preHandler: auth }, async (request, reply) => {
      const body = z
        .object({
          projectId: z.string().uuid(),
          title: z.string().min(1),
          description: z.string().default(""),
          state: z.string().default("backlog"),
          sprintId: z.string().uuid().nullable().optional(),
          targetRoleId: z.string().uuid().nullable().optional(),
          executionPhase: z.number().int().min(0).max(30).optional(),
        })
        .safeParse(request.body);
      if (!body.success) {
        return reply.status(400).send({ error: { code: "VALIDATION", message: body.error.message } });
      }
      const actorId = request.auth?.sub;
      if (!actorId) {
        return reply.status(401).send(jsonError("UNAUTHORIZED", "Not authenticated"));
      }
      const task = await prisma.task.create({
        data: {
          projectId: body.data.projectId,
          title: body.data.title,
          description: body.data.description,
          state: body.data.state,
          sprintId: body.data.sprintId ?? null,
          targetRoleId: body.data.targetRoleId ?? null,
          executionPhase: body.data.executionPhase ?? 0,
          version: 1,
        },
      });
      await recordAudit(actorId, "task.create", `task:${task.id}`);
      return task;
    });

    app.get<{ Params: { taskId: string } }>(
      "/api/v1/tasks/:taskId/comments",
      { preHandler: auth },
      async (request) => {
        const { taskId } = request.params;
        return prisma.taskComment.findMany({
          where: { taskId },
          orderBy: { createdAt: "asc" },
        });
      }
    );

    app.post<{ Params: { taskId: string } }>(
      "/api/v1/tasks/:taskId/comments",
      { preHandler: auth },
      async (request, reply) => {
        const { taskId } = request.params;
        const body = z.object({ body: z.string().min(1) }).safeParse(request.body);
        if (!body.success) {
          return reply.status(400).send({ error: { code: "VALIDATION", message: body.error.message } });
        }
        const authorId = request.auth?.sub;
        if (!authorId) {
          return reply.status(401).send(jsonError("UNAUTHORIZED", "Not authenticated"));
        }
        const c = await prisma.taskComment.create({
          data: { taskId, authorId, body: body.data.body },
        });
        await recordAudit(authorId, "task_comment.create", `task:${taskId}:comment:${c.id}`);
        return c;
      }
    );
  };
}
