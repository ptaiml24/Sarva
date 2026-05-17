import { config as loadDotenv } from "dotenv";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnv } from "./config/env.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
loadDotenv({ path: resolve(__dirname, "../.env") });
import { buildApp } from "./app.js";

async function main() {
  const env = loadEnv();
  const app = await buildApp(env);
  const port = env.PORT;
  await app.listen({ port, host: "0.0.0.0" });
  const raw = app.server;
  /** Node defaults (e.g. headers 60s) apply to the raw HTTP server; disable for long LLM routes. */
  raw.headersTimeout = 0;
  raw.requestTimeout = 0;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
