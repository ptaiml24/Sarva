-- Coder agent LLM output persisted on task for operator review / local apply.
ALTER TABLE "task" ADD COLUMN "agent_generated_body" TEXT;
ALTER TABLE "task" ADD COLUMN "agent_generated_at" TIMESTAMPTZ(6);
