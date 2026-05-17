import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import type { Env } from "../config/env.js";
import { prisma } from "../lib/prisma.js";
import { createAuthPreHandler } from "../plugins/auth.js";
import { requireAdmin } from "../lib/authz.js";
import { recordAudit } from "../lib/audit.js";

export function supportRoutes(env: Env): FastifyPluginAsync {
  const auth = createAuthPreHandler(env);
  return async (app) => {
    app.get("/api/v1/approvals", { preHandler: auth }, async () => {
      return prisma.approval.findMany({ orderBy: { createdAt: "desc" }, take: 100 });
    });

    app.get("/api/v1/execution-adapters", { preHandler: auth }, async () => {
      return prisma.executionAdapter.findMany({ take: 50 });
    });

    app.post("/api/v1/execution-adapters", { preHandler: auth }, async (request, reply) => {
      if (!requireAdmin(request, reply)) return;
      const body = z
        .object({
          type: z.string().min(1),
          config: z.any().optional(),
          enabled: z.boolean().optional(),
        })
        .safeParse(request.body);
      if (!body.success) {
        return reply.status(400).send({ error: { code: "VALIDATION", message: body.error.message } });
      }
      const row = await prisma.executionAdapter.create({
        data: {
          type: body.data.type,
          config: (body.data.config ?? {}) as object,
          enabled: body.data.enabled ?? true,
        },
      });
      await recordAudit(request.auth!.sub, "execution_adapter.create", `execution_adapter:${row.id}`);
      return row;
    });
  };
}
