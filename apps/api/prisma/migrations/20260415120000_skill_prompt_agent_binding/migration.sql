-- Skill catalog: agent-facing prompt; model binding: optional agent scope
ALTER TABLE "skill_template" ADD COLUMN "agent_prompt" TEXT;

UPDATE "skill_template"
SET "agent_prompt" = COALESCE(
  NULLIF(TRIM("description"), ''),
  'You perform work as ' || "label" || '. Follow team standards and the task description.'
);

ALTER TABLE "model_binding" ADD COLUMN "agent_id" UUID;

ALTER TABLE "model_binding" ADD CONSTRAINT "model_binding_agent_id_fkey"
  FOREIGN KEY ("agent_id") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX "model_binding_agent_id_idx" ON "model_binding"("agent_id");
