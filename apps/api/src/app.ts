import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import type { Env } from "./config/env.js";
import { healthRoutes } from "./routes/health.js";
import { authRoutes } from "./routes/auth.js";
import { taskRoutes } from "./routes/tasks.js";
import { taskExtraRoutes } from "./routes/tasks-extra.js";
import { orgRoutes } from "./routes/org.js";
import { catalogRoutes } from "./routes/catalog.js";
import { integrationRoutes } from "./routes/integrations.js";
import { costRoutes } from "./routes/cost.js";
import { pmRoutes } from "./routes/pm.js";
import { projectSdlcRoutes } from "./routes/projectSdlc.js";
import { llmProviderConnectionRoutes } from "./routes/llmProviderConnections.js";
import { supportRoutes } from "./routes/support.js";
import { projectDeliveryRoutes } from "./routes/projectDelivery.js";
import { projectExperienceRoutes } from "./routes/projectExperience.js";
import { projectIssuesRoutes } from "./routes/projectIssues.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export async function buildApp(env: Env) {
  const app = Fastify({
    logger: true,
    requestIdHeader: "x-correlation-id",
    genReqId: () => randomUUID(),
    /** PM propose + design LLM (local Ollama) can exceed default server limits. */
    requestTimeout: 0,
    connectionTimeout: 0,
  });

  await app.register(cors, { origin: true });

  await app.register(fastifyStatic, {
    root: path.join(__dirname, "../static"),
    prefix: "/ui/",
  });

  await app.register(healthRoutes);
  await app.register(authRoutes(env));
  await app.register(taskExtraRoutes(env));
  await app.register(taskRoutes(env));
  await app.register(orgRoutes(env));
  await app.register(catalogRoutes(env));
  await app.register(llmProviderConnectionRoutes(env));
  await app.register(integrationRoutes(env));
  await app.register(costRoutes(env));
  await app.register(pmRoutes(env));
  await app.register(projectSdlcRoutes(env));
  await app.register(projectDeliveryRoutes(env));
  await app.register(projectExperienceRoutes(env));
  await app.register(projectIssuesRoutes(env));
  await app.register(supportRoutes(env));

  return app;
}
