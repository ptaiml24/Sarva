import type { FastifyReply, FastifyRequest } from "fastify";
import type { Env } from "../config/env.js";
import { verifyUserToken } from "../lib/jwt.js";
import { jsonError } from "../lib/errors.js";

export function createAuthPreHandler(env: Env) {
  return async function authenticate(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const header = request.headers.authorization;
    if (!header?.startsWith("Bearer ")) {
      return reply.status(401).send(jsonError("UNAUTHORIZED", "Missing Bearer token"));
    }
    const token = header.slice("Bearer ".length).trim();
    try {
      request.auth = verifyUserToken(env, token);
    } catch {
      return reply.status(401).send(jsonError("UNAUTHORIZED", "Invalid token"));
    }
  };
}
