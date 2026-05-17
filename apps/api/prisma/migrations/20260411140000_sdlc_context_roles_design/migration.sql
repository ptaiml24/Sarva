-- AlterTable
ALTER TABLE "project_context" ADD COLUMN     "goals" TEXT,
ADD COLUMN "document_repository_url" TEXT;

-- AlterTable
ALTER TABLE "project" ADD COLUMN "delivery_phase" TEXT;

-- CreateTable
CREATE TABLE "project_role_assignment" (
    "id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "agent_id" UUID NOT NULL,
    "duty" TEXT NOT NULL,

    CONSTRAINT "project_role_assignment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "design_artifact" (
    "id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT 'draft',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "design_artifact_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "project_role_assignment_project_id_duty_key" ON "project_role_assignment"("project_id", "duty");

-- AddForeignKey
ALTER TABLE "project_role_assignment" ADD CONSTRAINT "project_role_assignment_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_role_assignment" ADD CONSTRAINT "project_role_assignment_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "design_artifact" ADD CONSTRAINT "design_artifact_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
