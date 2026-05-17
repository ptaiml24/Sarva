import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import type { Env } from "../config/env.js";
import { prisma } from "../lib/prisma.js";
import { signUserToken } from "../lib/jwt.js";

const loginBody = z.object({
  email: z.string().email(),
  role: z.enum(["admin", "operator"]).default("operator"),
});

export function authRoutes(env: Env): FastifyPluginAsync {
  return async (app) => {
    app.post("/api/v1/auth/login", async (request, reply) => {
      const parsed = loginBody.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: { code: "VALIDATION", message: parsed.error.message } });
      }
      const { email, role } = parsed.data;
      const user = await prisma.user.upsert({
        where: { email },
        create: { email },
        update: {},
      });
      const token = signUserToken(env, { sub: user.id, role });
      return { token, userId: user.id, role };
    });
  };
}
