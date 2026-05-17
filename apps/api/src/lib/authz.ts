import type { FastifyReply, FastifyRequest } from "fastify";

export function requireAdmin(request: FastifyRequest, reply: FastifyReply): boolean {
  if (request.auth?.role !== "admin") {
    void reply.status(403).send({ error: { code: "FORBIDDEN", message: "admin role required" } });
    return false;
  }
  return true;
}
