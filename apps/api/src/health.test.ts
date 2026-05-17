import { describe, it, expect } from "vitest";
import { buildApp } from "./app.js";
import { loadEnv } from "./config/env.js";

describe("health", () => {
  it("returns ok", async () => {
    const env = loadEnv();
    const app = await buildApp(env);
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { status: string };
    expect(body.status).toBe("ok");
    await app.close();
  });
});
