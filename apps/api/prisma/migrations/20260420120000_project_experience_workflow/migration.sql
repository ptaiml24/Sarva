-- Delivery workflow templates + PRD + attachments + project chat

CREATE TABLE "delivery_workflow" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "kind" TEXT NOT NULL,
    "is_builtin" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "delivery_workflow_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "delivery_workflow_code_key" ON "delivery_workflow"("code");

ALTER TABLE "project" ADD COLUMN "workflow_id" UUID;

ALTER TABLE "project"
  ADD CONSTRAINT "project_workflow_id_fkey"
  FOREIGN KEY ("workflow_id") REFERENCES "delivery_workflow"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "project_attachment" (
    "id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "file_name" TEXT NOT NULL,
    "mime_type" TEXT NOT NULL DEFAULT 'application/octet-stream',
    "byte_size" INTEGER NOT NULL,
    "data" BYTEA NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "project_attachment_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "project_attachment_project_id_idx" ON "project_attachment"("project_id");

ALTER TABLE "project_attachment"
  ADD CONSTRAINT "project_attachment_project_id_fkey"
  FOREIGN KEY ("project_id") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "prd_artifact" (
    "id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "title" TEXT NOT NULL DEFAULT 'Product requirements',
    "body" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT 'draft',
    "feedback_notes" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "prd_artifact_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "prd_artifact_project_id_idx" ON "prd_artifact"("project_id");

ALTER TABLE "prd_artifact"
  ADD CONSTRAINT "prd_artifact_project_id_fkey"
  FOREIGN KEY ("project_id") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "project_chat_message" (
    "id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "actor_kind" TEXT NOT NULL,
    "actor_id" UUID,
    "actor_label" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "meta" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "project_chat_message_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "project_chat_message_project_id_created_at_idx" ON "project_chat_message"("project_id", "created_at");

ALTER TABLE "project_chat_message"
  ADD CONSTRAINT "project_chat_message_project_id_fkey"
  FOREIGN KEY ("project_id") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

INSERT INTO "delivery_workflow" ("id", "code", "name", "description", "kind", "is_builtin", "created_at")
SELECT 'a0000001-0001-4000-8000-000000000001', 'full_e2e', 'Full end-to-end project',
  'Greenfield: PRD → Design → Implementation → Review → Test → Deploy (deploy later).',
  'full_e2e', true, CURRENT_TIMESTAMP
WHERE NOT EXISTS (SELECT 1 FROM "delivery_workflow" WHERE "code" = 'full_e2e');

INSERT INTO "delivery_workflow" ("id", "code", "name", "description", "kind", "is_builtin", "created_at")
SELECT 'a0000001-0001-4000-8000-000000000002', 'feature_dev', 'Feature development',
  'Extend an existing codebase; repository location (Git URL or local path) is required.',
  'feature_dev', true, CURRENT_TIMESTAMP
WHERE NOT EXISTS (SELECT 1 FROM "delivery_workflow" WHERE "code" = 'feature_dev');
