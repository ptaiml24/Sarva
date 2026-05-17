import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import type { Env } from "../config/env.js";
import { prisma } from "../lib/prisma.js";
import { createAuthPreHandler } from "../plugins/auth.js";
import { Prisma } from "@prisma/client";

export function costRoutes(env: Env): FastifyPluginAsync {
  const auth = createAuthPreHandler(env);
  return async (app) => {
    app.get("/api/v1/cost-events", { preHandler: auth }, async (request) => {
      const projectId = (request.query as { projectId?: string }).projectId;
      const where = projectId
        ? { task: { projectId } }
        : {};
      const items = await prisma.costEvent.findMany({
        where,
        orderBy: { occurredAt: "desc" },
        take: 200,
      });
      return { items };
    });

    app.post("/api/v1/cost-events", { preHandler: auth }, async (request, reply) => {
      const body = z
        .object({
          amount: z.string(),
          unit: z.string(),
          agentId: z.string().uuid().optional(),
          taskId: z.string().uuid().optional(),
        })
        .safeParse(request.body);
      if (!body.success) {
        return reply.status(400).send({ error: { code: "VALIDATION", message: body.error.message } });
      }
      const row = await prisma.costEvent.create({
        data: {
          amount: new Prisma.Decimal(body.data.amount),
          unit: body.data.unit,
          agentId: body.data.agentId ?? null,
          taskId: body.data.taskId ?? null,
        },
      });
      return row;
    });

    app.get("/api/v1/budgets", { preHandler: auth }, async () => {
      return prisma.budget.findMany({ take: 50 });
    });
  };
}
