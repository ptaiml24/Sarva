import jwt from "jsonwebtoken";
import type { Env } from "../config/env.js";

export type JwtPayload = {
  sub: string;
  role: "admin" | "operator";
};

export function signUserToken(env: Env, payload: JwtPayload): string {
  return jwt.sign(payload, env.JWT_SECRET, { expiresIn: "7d" });
}

export function verifyUserToken(env: Env, token: string): JwtPayload {
  const decoded = jwt.verify(token, env.JWT_SECRET);
  if (typeof decoded !== "object" || decoded === null || !("sub" in decoded)) {
    throw new Error("Invalid token");
  }
  const sub = (decoded as { sub?: string }).sub;
  const role = (decoded as { role?: string }).role;
  if (!sub || (role !== "admin" && role !== "operator")) {
    throw new Error("Invalid token payload");
  }
  return { sub, role };
}
