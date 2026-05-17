import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import type { Env } from "../config/env.js";
import { prisma } from "../lib/prisma.js";
import { createAuthPreHandler } from "../plugins/auth.js";
import { requireAdmin } from "../lib/authz.js";
import { recordAudit } from "../lib/audit.js";
import { requireCompanyId } from "../lib/tenant.js";
import type { ResolvedLlmCredentials } from "../integrations/llm/types.js";
import { testResolvedLlmCredentials } from "../integrations/llm/testLlmConnection.js";

function redactConnection(c: {
  id: string;
  companyId: string;
  name: string;
  provider: string;
  modelId: string;
  baseUrl: string | null;
  apiKey: string | null;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: c.id,
    companyId: c.companyId,
    name: c.name,
    provider: c.provider,
    modelId: c.modelId,
    baseUrl: c.baseUrl,
    apiKeySet: Boolean(c.apiKey?.trim()),
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
  };
}

export function llmProviderConnectionRoutes(env: Env): FastifyPluginAsync {
  const auth = createAuthPreHandler(env);
  return async (app) => {
    app.get("/api/v1/llm-provider-connections", { preHandler: auth }, async (request, reply) => {
      if (!requireAdmin(request, reply)) return;
      const companyId = await requireCompanyId().catch(() => null);
      if (!companyId) {
        return reply.status(400).send({ error: { code: "NO_COMPANY", message: "Create company first" } });
      }
      const rows = await prisma.llmProviderConnection.findMany({
        where: { companyId },
        orderBy: { name: "asc" },
        take: 100,
      });
      return { items: rows.map(redactConnection) };
    });

    app.post("/api/v1/llm-provider-connections", { preHandler: auth }, async (request, reply) => {
      if (!requireAdmin(request, reply)) return;
      const companyId = await requireCompanyId().catch(() => null);
      if (!companyId) {
        return reply.status(400).send({ error: { code: "NO_COMPANY", message: "Create company first" } });
      }
      const body = z
        .object({
          name: z.string().min(1),
          provider: z.enum(["openai", "anthropic", "google", "ollama", "meta", "cursor"]),
          modelId: z.string().min(1),
          baseUrl: z.string().url().optional().or(z.literal("")),
          apiKey: z.string().optional(),
        })
        .safeParse(request.body);
      if (!body.success) {
        return reply.status(400).send({ error: { code: "VALIDATION", message: body.error.message } });
      }
      const baseUrl =
        body.data.baseUrl === undefined || body.data.baseUrl === "" ? null : body.data.baseUrl;
      const apiKey = body.data.apiKey?.trim() === "" ? null : body.data.apiKey?.trim() ?? null;
      const row = await prisma.llmProviderConnection.create({
        data: {
          companyId,
          name: body.data.name,
          provider: body.data.provider,
          modelId: body.data.modelId,
          baseUrl,
          apiKey,
        },
      });
      await recordAudit(request.auth!.sub, "llm_provider_connection.create", `llm_provider_connection:${row.id}`);
      return redactConnection(row);
    });

    app.patch<{ Params: { id: string } }>("/api/v1/llm-provider-connections/:id", { preHandler: auth }, async (request, reply) => {
      if (!requireAdmin(request, reply)) return;
      const id = z.string().uuid().safeParse(request.params.id);
      if (!id.success) {
        return reply.status(400).send({ error: { code: "VALIDATION", message: "Invalid id" } });
      }
      const companyId = await requireCompanyId().catch(() => null);
      if (!companyId) {
        return reply.status(400).send({ error: { code: "NO_COMPANY", message: "Create company first" } });
      }
      const body = z
        .object({
          name: z.string().min(1).optional(),
          provider: z.enum(["openai", "anthropic", "google", "ollama", "meta", "cursor"]).optional(),
          modelId: z.string().min(1).optional(),
          baseUrl: z.string().url().nullable().optional().or(z.literal("")),
          apiKey: z.string().nullable().optional(),
        })
        .safeParse(request.body);
      if (!body.success) {
        return reply.status(400).send({ error: { code: "VALIDATION", message: body.error.message } });
      }
      const existing = await prisma.llmProviderConnection.findFirst({
        where: { id: id.data, companyId },
      });
      if (!existing) {
        return reply.status(404).send({ error: { code: "NOT_FOUND", message: "connection" } });
      }
      const baseUrl =
        body.data.baseUrl === undefined
          ? undefined
          : body.data.baseUrl === "" || body.data.baseUrl === null
            ? null
            : body.data.baseUrl;
      const apiKey =
        body.data.apiKey === undefined
          ? undefined
          : body.data.apiKey === null || body.data.apiKey === ""
            ? null
            : body.data.apiKey;
      const row = await prisma.llmProviderConnection.update({
        where: { id: id.data },
        data: {
          ...(body.data.name !== undefined ? { name: body.data.name } : {}),
          ...(body.data.provider !== undefined ? { provider: body.data.provider } : {}),
          ...(body.data.modelId !== undefined ? { modelId: body.data.modelId } : {}),
          ...(baseUrl !== undefined ? { baseUrl } : {}),
          ...(apiKey !== undefined ? { apiKey } : {}),
        },
      });
      await recordAudit(request.auth!.sub, "llm_provider_connection.update", `llm_provider_connection:${id.data}`);
      return redactConnection(row);
    });

    app.post<{ Params: { id: string } }>(
      "/api/v1/llm-provider-connections/:id/test",
      { preHandler: auth },
      async (request, reply) => {
        if (!requireAdmin(request, reply)) return;
        const id = z.string().uuid().safeParse(request.params.id);
        if (!id.success) {
          return reply.status(400).send({ error: { code: "VALIDATION", message: "Invalid id" } });
        }
        const companyId = await requireCompanyId().catch(() => null);
        if (!companyId) {
          return reply.status(400).send({ error: { code: "NO_COMPANY", message: "Create company first" } });
        }
        const row = await prisma.llmProviderConnection.findFirst({
          where: { id: id.data, companyId },
        });
        if (!row) {
          return reply.status(404).send({ error: { code: "NOT_FOUND", message: "connection" } });
        }
        const cred: ResolvedLlmCredentials = {
          provider: row.provider,
          modelId: row.modelId,
          apiKey: row.apiKey,
          baseUrl: row.baseUrl,
        };
        const result = await testResolvedLlmCredentials(cred, env);
        await recordAudit(request.auth!.sub, "llm_provider_connection.test", `llm_provider_connection:${id.data}`);
        return result;
      }
    );

    app.delete<{ Params: { id: string } }>("/api/v1/llm-provider-connections/:id", { preHandler: auth }, async (request, reply) => {
      if (!requireAdmin(request, reply)) return;
      const id = z.string().uuid().safeParse(request.params.id);
      if (!id.success) {
        return reply.status(400).send({ error: { code: "VALIDATION", message: "Invalid id" } });
      }
      const companyId = await requireCompanyId().catch(() => null);
      if (!companyId) {
        return reply.status(400).send({ error: { code: "NO_COMPANY", message: "Create company first" } });
      }
      const inUse = await prisma.modelBinding.count({ where: { llmProviderConnectionId: id.data } });
      if (inUse > 0) {
        return reply.status(409).send({
          error: {
            code: "IN_USE",
            message: "Remove or re-point model bindings that use this connection first.",
          },
        });
      }
      await prisma.llmProviderConnection.deleteMany({ where: { id: id.data, companyId } });
      await recordAudit(request.auth!.sub, "llm_provider_connection.delete", `llm_provider_connection:${id.data}`);
      return { deleted: true };
    });
  };
}
