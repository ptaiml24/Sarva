-- Project-scoped issues (code review / testing), assigned user + optional team role lane.

CREATE TABLE "project_issue" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "project_id" UUID NOT NULL,
    "issue_number" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT 'open',
    "assigned_user_id" UUID NOT NULL,
    "owner_role_id" UUID,
    "closed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "project_issue_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "project_issue_project_id_issue_number_key"
  ON "project_issue"("project_id", "issue_number");

CREATE INDEX "project_issue_project_id_status_idx"
  ON "project_issue"("project_id", "status");

ALTER TABLE "project_issue"
  ADD CONSTRAINT "project_issue_project_id_fkey"
  FOREIGN KEY ("project_id") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "project_issue"
  ADD CONSTRAINT "project_issue_assigned_user_id_fkey"
  FOREIGN KEY ("assigned_user_id") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "project_issue"
  ADD CONSTRAINT "project_issue_owner_role_id_fkey"
  FOREIGN KEY ("owner_role_id") REFERENCES "role"("id") ON DELETE SET NULL ON UPDATE CASCADE;
