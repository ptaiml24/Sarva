import type { JwtPayload } from "../lib/jwt.js";

declare module "fastify" {
  interface FastifyRequest {
    auth?: JwtPayload;
  }
}
