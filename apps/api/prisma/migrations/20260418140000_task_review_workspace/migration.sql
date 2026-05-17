-- Dev workspace path on project; implementer + SDM handoff on task for review flow.
ALTER TABLE "project" ADD COLUMN IF NOT EXISTS "dev_workspace_path" TEXT;

ALTER TABLE "task" ADD COLUMN IF NOT EXISTS "implementing_agent_id" UUID;
ALTER TABLE "task" ADD COLUMN IF NOT EXISTS "review_handoff_markdown" TEXT;

ALTER TABLE "task" DROP CONSTRAINT IF EXISTS "task_implementing_agent_id_fkey";
ALTER TABLE "task" ADD CONSTRAINT "task_implementing_agent_id_fkey" FOREIGN KEY ("implementing_agent_id") REFERENCES "Agent"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX IF NOT EXISTS "task_implementing_agent_id_idx" ON "task"("implementing_agent_id");
