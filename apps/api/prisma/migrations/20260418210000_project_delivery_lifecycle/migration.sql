-- R0–R6 delivery pipeline: explicit Proceed, backlog gates, execution, UAT flag, task escalation hints
ALTER TABLE "project" ADD COLUMN "implementation_status" TEXT NOT NULL DEFAULT 'draft';
ALTER TABLE "project" ADD COLUMN "intake_baseline_at" TIMESTAMPTZ(6);
ALTER TABLE "project" ADD COLUMN "ready_for_uat" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "project" ADD COLUMN "backlog_feedback_notes" TEXT;

ALTER TABLE "task" ADD COLUMN "blocked_reason" TEXT;
ALTER TABLE "task" ADD COLUMN "escalation_strikes" INTEGER NOT NULL DEFAULT 0;
