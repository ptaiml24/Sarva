import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  PORT: z.coerce.number().default(3000),
  DATABASE_URL: z.string().min(1),
  JWT_SECRET: z.string().min(16),
  /** `off` = no MCP Git calls (no placeholder URLs). `live` = call `GIT_MCP_ENDPOINT`. */
  INTEGRATION_MCP_GIT: z.enum(["off", "live"]).default("off"),
  /** Base URL of the MCP Git gateway (required when INTEGRATION_MCP_GIT=live). See Requirement/SARVA-DESIGN.md Part III (~ TSD Git/MCP sections). */
  GIT_MCP_ENDPOINT: z.string().url().optional(),
  /** When set with `PM_PROPOSE_USE_LLM=true`, PM propose may call the OpenAI-compatible chat API for backlog drafts. */
  OPENAI_API_KEY: z.string().optional(),
  /**
   * `true` = PM propose must call a configured LLM (no line-split fallback).
   * `false` = propose is disabled unless `PM_PROPOSE_E2E_STUB=true` (automated tests only).
   */
  PM_PROPOSE_USE_LLM: z.enum(["true", "false"]).default("true"),
  /**
   * When `true`, PM propose skips the LLM and creates a tiny deterministic backlog (for Playwright/CI without API keys).
   * Never enable in production.
   */
  PM_PROPOSE_E2E_STUB: z.enum(["true", "false"]).default("false"),
  /**
   * Plan → Publish board: SDM-style JSON plan (phases, assignees, QA tasks). Requires bindings when true.
   * `false` + no `PM_PLAN_BOARD_E2E_STUB` disables the LLM path (returns 400 from publish-and-plan-board).
   */
  PM_PLAN_BOARD_USE_LLM: z.enum(["true", "false"]).default("true"),
  /** When `true`, publish-and-plan-board uses deterministic planning (Playwright/CI only; never in production). */
  PM_PLAN_BOARD_E2E_STUB: z.enum(["true", "false"]).default("false"),
  /**
   * When true, claiming or auto-starting an in-progress task may invoke the **assignee agent's** mapped model
   * (agent binding, else company default) to draft implementation Markdown on the task.
   */
  AGENT_CODER_USE_LLM: z.enum(["true", "false"]).default("true"),
  /** Test-only: stub coder output without calling a provider (never enable in production). */
  AGENT_CODER_E2E_STUB: z.enum(["true", "false"]).default("false"),
  /** Max concurrent coder runs when orchestration auto-starts a batch (begin execution / phase unlock). */
  AGENT_CODER_MAX_PARALLEL_RUNS: z.coerce.number().int().min(1).max(32).default(4),
  /**
   * When set, coder agents scaffold `{SARVA_AGENT_WORKSPACE}/{slug}/` on the API host (README, src/, package.json).
   * Must be an absolute path; unset = skip filesystem scaffolding.
   */
  SARVA_AGENT_WORKSPACE: z.string().min(1).optional(),
  /** When true, POST .../delivery/workspace-git-push may run git commit/push in the dev workspace (API host must have credentials). */
  SARVA_WORKSPACE_GIT_PUSH: z.enum(["true", "false"]).default("false"),
  /** Author name for automated workspace commits (optional). */
  SARVA_GIT_AUTHOR_NAME: z.string().min(1).max(200).optional(),
  /** Author email for automated workspace commits (optional). */
  SARVA_GIT_AUTHOR_EMAIL: z.string().min(1).max(200).optional(),
  /** SDM review handoff note after coder submits (uses design/SDM LLM binding when true). */
  AGENT_REVIEW_HANDOFF_USE_LLM: z.enum(["true", "false"]).default("true"),
  /** Test-only stub for review handoff text (never enable in production). */
  AGENT_REVIEW_HANDOFF_E2E_STUB: z.enum(["true", "false"]).default("false"),
  /** After coder submits → review: run reviewer LLM to approve or bounce for fixes until cap (uses reviewer assignee’s binding). */
  AGENT_AUTOMATED_REVIEW: z.enum(["true", "false"]).default("true"),
  /** Test-only deterministic approve/request_changes path (never in production). */
  AGENT_AUTOMATED_REVIEW_E2E_STUB: z.enum(["true", "false"]).default("false"),
  /** Max review→implementer bounce rounds (`review_revision_count`); further automated request_changes halted. Manual cap too when env is wired. */
  AGENT_AUTOMATED_REVIEW_MAX_ROUNDS: z.coerce.number().int().min(1).max(50).default(5),
  /** After reviewer requests changes, immediately dispatch coder LLM again for the implementer. */
  AGENT_CODER_ON_REVIEW_FEEDBACK: z.enum(["true", "false"]).default("true"),
  /**
   * Post **Begin execution**: repeated automation stalls increment `deliveryPolicy.autonomousStallCount`.
   * When stalls **≥** this threshold, Chat escalates and the board shows full controls (default **4** ⇒ after **more than 3** stalls).
   */
  AGENT_AUTONOMOUS_STALL_OPERATOR_THRESHOLD: z.coerce.number().int().min(2).max(50).default(4),
  /**
   * Design `generate-llm`: max chars of the **newest** prior artifact body embedded in the prompt.
   * Older artifacts are titles-only so the prompt does not scale as N × large drafts.
   */
  DESIGN_GENERATE_PRIOR_ANCHOR_MAX_CHARS: z.coerce.number().int().min(1024).max(500_000).optional(),
  /** How many older design runs to list by title after the anchor (bodies omitted). Default 7. */
  DESIGN_GENERATE_PRIOR_TITLE_LIST_MAX: z.coerce.number().int().min(0).max(50).optional(),
  /** When `true`, POST skill-templates/generate-draft returns deterministic text (automated tests only; never production). */
  SKILL_CATALOG_GENERATE_E2E_STUB: z.enum(["true", "false"]).default("false"),
});

export type Env = z.infer<typeof envSchema>;

export function loadEnv(): Env {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    console.error(parsed.error.flatten().fieldErrors);
    throw new Error("Invalid environment variables");
  }
  return parsed.data;
}
