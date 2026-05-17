-- Delivery orchestration pass records (timeline / correlation without CI/CD dependency)

CREATE TABLE "delivery_orchestration_pass" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "project_id" UUID NOT NULL,
    "promoted_count" INTEGER NOT NULL,
    "assigned_count" INTEGER NOT NULL,
    "started_count" INTEGER NOT NULL,
    "coder_runs_count" INTEGER NOT NULL,
    "coder_submitted_count" INTEGER NOT NULL DEFAULT 0,
    "surfaced_effects" BOOLEAN NOT NULL DEFAULT false,
    "source" TEXT NOT NULL DEFAULT 'hook',
    "correlation_id" TEXT,
    "partial_errors" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "delivery_orchestration_pass_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "delivery_orchestration_pass_project_created_idx"
  ON "delivery_orchestration_pass" ("project_id", "created_at" DESC);

ALTER TABLE "delivery_orchestration_pass"
  ADD CONSTRAINT "delivery_orchestration_pass_project_id_fkey"
  FOREIGN KEY ("project_id") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Lightweight job rows (telemetry for synchronous MVP — no CI pipeline)

CREATE TABLE "delivery_async_job" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "project_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'completed',
    "payload" JSONB NOT NULL DEFAULT '{}',
    "result" JSONB,
    "error" TEXT,
    "correlation_id" TEXT,
    "started_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMPTZ(6),

    CONSTRAINT "delivery_async_job_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "delivery_async_job_project_started_idx"
  ON "delivery_async_job" ("project_id", "started_at" DESC);

ALTER TABLE "delivery_async_job"
  ADD CONSTRAINT "delivery_async_job_project_id_fkey"
  FOREIGN KEY ("project_id") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- LLM binding attempt trail (successful path + exhaustion count)

CREATE TABLE "orchestration_binding_attempt" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "project_id" UUID,
    "workflow" TEXT,
    "agent_id" UUID,
    "role_id" UUID,
    "binding_id" UUID,
    "provider" TEXT,
    "model_id" TEXT,
    "model_label" TEXT,
    "scope_hint" TEXT,
    "success" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "orchestration_binding_attempt_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "orchestration_binding_attempt_project_created_idx"
  ON "orchestration_binding_attempt" ("project_id", "created_at" DESC);

ALTER TABLE "orchestration_binding_attempt"
  ADD CONSTRAINT "orchestration_binding_attempt_project_id_fkey"
  FOREIGN KEY ("project_id") REFERENCES "project"("id") ON DELETE SET NULL ON UPDATE CASCADE;
