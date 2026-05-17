/**
 * Vitest setup: real PostgreSQL only — no in-memory or mocked DB for API tests.
 * Loads `apps/api/.env` (create from `.env.example`; Postgres may be local or Docker).
 */
import { config as loadDotenv } from "dotenv";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
loadDotenv({ path: resolve(__dirname, "../../.env") });

if (!process.env.DATABASE_URL?.trim()) {
  throw new Error(
    "DATABASE_URL is required for API tests (mock databases are not used). " +
      "From repo root: cp apps/api/.env.example apps/api/.env (edit DATABASE_URL), ensure Postgres is running, then npm run db:setup"
  );
}
if (!process.env.JWT_SECRET?.trim()) {
  throw new Error("JWT_SECRET is required in apps/api/.env (see .env.example).");
}

/** Claim/begin-execution hooks must not call real LLM providers during Vitest (avoids hangs / flaky CI). */
process.env.AGENT_CODER_USE_LLM = "false";
process.env.AGENT_CODER_E2E_STUB = "false";
process.env.AGENT_AUTOMATED_REVIEW = "false";
process.env.AGENT_REVIEW_HANDOFF_USE_LLM = "false";
process.env.AGENT_REVIEW_HANDOFF_E2E_STUB = "false";
