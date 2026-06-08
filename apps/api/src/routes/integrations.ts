import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import type { Env } from "../config/env.js";
import { allTrackedLlmEnvKeys, SUPPORTED_LLM_PROVIDERS } from "../config/supportedLlmProviders.js";
import { fetchCursorModelPresets } from "../integrations/llm/cursorModelDiscovery.js";
import { fetchOllamaInstalledModelNames } from "../integrations/llm/ollamaDiscovery.js";
import { createAuthPreHandler } from "../plugins/auth.js";
import { requireAdmin } from "../lib/authz.js";
import { prisma } from "../lib/prisma.js";
import { linkBranchForTask } from "../integrations/mcpGit.js";
import { runPrePushVerify } from "../integrations/prePushVerify.js";

export function integrationRoutes(env: Env): FastifyPluginAsync {
  const auth = createAuthPreHandler(env);
  return async (app) => {
    /** Curated provider + model presets for Admin (secrets stay in env only). */
    app.get("/api/v1/integrations/llm-catalog", { preHandler: auth }, async () => {
      const providers = SUPPORTED_LLM_PROVIDERS.map((p) => ({ ...p, modelPresets: [...p.modelPresets] }));
      const cursorKey = process.env.CURSOR_API_KEY?.trim();
      if (cursorKey) {
        const cursor = providers.find((p) => p.id === "cursor");
        if (cursor) {
          try {
            cursor.modelPresets = await fetchCursorModelPresets(cursorKey);
          } catch {
            /* keep static fallback presets when list fails */
          }
        }
      }
      return { providers };
    });

    /** Which LLM-related env vars are set (boolean only; never returns secret values). Admin only. */
    app.get("/api/v1/integrations/llm-env-status", { preHandler: auth }, async (request, reply) => {
      if (!requireAdmin(request, reply)) return;
      const vars: Record<string, boolean> = {};
      for (const k of allTrackedLlmEnvKeys()) {
        vars[k] = Boolean(process.env[k]?.trim());
      }
      return {
        vars,
        note: "Shows whether each variable is non-empty on the API server. Add keys to apps/api/.env and restart the API.",
      };
    });

    /**
     * Lists tags from a running Ollama instance (GET /api/tags). Server-side call from the API host — use Base URL
     * that reaches Ollama from this process (e.g. http://127.0.0.1:11434). Admin only; host allowlist in ollamaDiscovery.
     */
    /**
     * Lists models from Cursor for the given API key (or server CURSOR_API_KEY). Admin only.
     * Uses Cursor.models.list() so new models (e.g. Composer 3.0) appear without a Sarva release.
     */
    app.get("/api/v1/integrations/cursor-models", { preHandler: auth }, async (request, reply) => {
      if (!requireAdmin(request, reply)) return;
      const q = z
        .object({
          apiKey: z.string().optional(),
        })
        .safeParse(request.query);
      if (!q.success) {
        return reply.status(400).send({ error: { code: "VALIDATION", message: q.error.message } });
      }
      const apiKey = q.data.apiKey?.trim() || process.env.CURSOR_API_KEY?.trim() || "";
      try {
        const models = await fetchCursorModelPresets(apiKey);
        return { models, source: "cursor.models.list" };
      } catch (e) {
        const message = e instanceof Error ? e.message : "Failed to list Cursor models";
        return reply.status(400).send({ error: { code: "CURSOR_LIST_FAILED", message } });
      }
    });

    app.get("/api/v1/integrations/ollama-models", { preHandler: auth }, async (request, reply) => {
      if (!requireAdmin(request, reply)) return;
      const q = z
        .object({
          baseUrl: z.string().optional(),
        })
        .safeParse(request.query);
      if (!q.success) {
        return reply.status(400).send({ error: { code: "VALIDATION", message: q.error.message } });
      }
      const baseUrl =
        q.data.baseUrl?.trim() ||
        process.env.OLLAMA_BASE_URL?.trim() ||
        "http://127.0.0.1:11434";
      try {
        const models = await fetchOllamaInstalledModelNames(baseUrl);
        return { baseUrl, models };
      } catch (e) {
        const message = e instanceof Error ? e.message : "Failed to list Ollama models";
        return reply.status(400).send({ error: { code: "OLLAMA_LIST_FAILED", message } });
      }
    });

    app.get("/api/v1/integrations/status", { preHandler: auth }, async () => {
      const company = await prisma.company.findFirst({
        select: {
          githubPat: true,
          githubOwnerLogin: true,
        },
      });
      const githubPublishConfigured = Boolean(company?.githubPat?.trim() && company?.githubOwnerLogin?.trim());
      return {
        mcpGit: env.INTEGRATION_MCP_GIT,
        gitMcpEndpointConfigured: Boolean(env.GIT_MCP_ENDPOINT),
        prePushVerifyTimeoutMs: Number(process.env.PRE_PUSH_VERIFY_TIMEOUT_MS ?? 1_200_000),
        githubPublishConfigured,
      };
    });

    app.post("/api/v1/integrations/github-verify", { preHandler: auth }, async (request, reply) => {
      if (!requireAdmin(request, reply)) return;
      const bodyParse = z.object({ githubPat: z.string().optional().nullable() }).safeParse(request.body ?? {});
      if (!bodyParse.success) {
        return reply.status(400).send({ error: { code: "VALIDATION", message: bodyParse.error.message } });
      }
      const company = await prisma.company.findFirst({
        select: { githubPat: true, githubOwnerLogin: true, githubOwnerIsOrganization: true },
      });
      if (!company) {
        return reply.status(400).send({ error: { code: "NO_COMPANY", message: "No company row found." } });
      }
      const bodyPat = bodyParse.data.githubPat?.trim();
      const pat = bodyPat && bodyPat.length > 0 ? bodyPat : company.githubPat?.trim();
      if (!pat) {
        return reply.status(400).send({
          error: {
            code: "NO_PAT",
            message: "Enter a token to test, or save a GitHub PAT in Admin → GitHub publishing first.",
          },
        });
      }
      const res = await fetch("https://api.github.com/user", {
        headers: {
          Authorization: `Bearer ${pat}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
      });
      const text = await res.text();
      if (!res.ok) {
        return reply.status(400).send({
          error: { code: "GITHUB_AUTH_FAILED", message: `GitHub returned ${res.status}` },
          detail: text.slice(0, 2000),
        });
      }
      let login = "";
      try {
        const u = JSON.parse(text) as { login?: string };
        login = typeof u.login === "string" ? u.login : "";
      } catch {
        return reply.status(502).send({ error: { code: "GITHUB_BAD_JSON", message: "Unexpected response from GitHub" } });
      }
      const owner = company.githubOwnerLogin?.trim() ?? "";
      const isOrg = Boolean(company.githubOwnerIsOrganization);
      const ownerHint =
        isOrg ?
          `Configured owner "${owner}" is an organization — ensure the PAT can create repositories there.`
        : owner && owner.toLowerCase() !== login.toLowerCase() ?
          `Warning: authenticated as "${login}" but owner is set to "${owner}". For user-owned repos, owner should match your GitHub login unless you only create org repos.`
        : `Authenticated as ${login}.`;
      return { ok: true as const, login, ownerHint };
    });

    app.post<{ Params: { taskId: string } }>(
      "/api/v1/tasks/:taskId/git/link-branch",
      { preHandler: auth },
      async (request, reply) => {
        const { taskId } = request.params;
        const result = await linkBranchForTask(taskId, env);
        if (!result.ok) {
          return reply.status(result.httpStatus).send({
            error: { code: result.code, message: result.message, ...(result.detail ? { detail: result.detail } : {}) },
          });
        }
        return { branch: result.branch, linkedPrUrl: result.linkedPrUrl };
      }
    );

    app.post<{ Params: { projectId: string } }>(
      "/api/v1/projects/:projectId/verify-dry-run",
      { preHandler: auth },
      async (request, reply) => {
        const idParse = z.string().uuid().safeParse(request.params.projectId);
        if (!idParse.success) {
          return reply.status(400).send({ error: { code: "VALIDATION", message: "Invalid project id" } });
        }
        return runPrePushVerify(idParse.data, env);
      }
    );
  };
}
