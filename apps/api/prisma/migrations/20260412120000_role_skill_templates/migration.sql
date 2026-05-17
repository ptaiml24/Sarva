-- Sarva catalog: role & skill templates (product-defined), team role instances link to templates.

CREATE TABLE "role_template" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "description" TEXT,
    "sort_order" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "role_template_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "role_template_code_key" ON "role_template"("code");

CREATE TABLE "skill_template" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "description" TEXT,
    "sort_order" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "skill_template_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "skill_template_code_key" ON "skill_template"("code");

CREATE TABLE "role_template_skill" (
    "role_template_id" UUID NOT NULL,
    "skill_template_id" UUID NOT NULL,

    CONSTRAINT "role_template_skill_pkey" PRIMARY KEY ("role_template_id","skill_template_id")
);

ALTER TABLE "role_template_skill" ADD CONSTRAINT "role_template_skill_role_template_id_fkey" FOREIGN KEY ("role_template_id") REFERENCES "role_template"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "role_template_skill" ADD CONSTRAINT "role_template_skill_skill_template_id_fkey" FOREIGN KEY ("skill_template_id") REFERENCES "skill_template"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Fixed UUIDs for stable seeds / tests
INSERT INTO "role_template" ("id", "code", "label", "description", "sort_order") VALUES
('a0000001-0000-4000-8000-000000000001', 'ENGINEER', 'Engineer', 'Builds and delivers implementation work.', 10),
('a0000001-0000-4000-8000-000000000002', 'QA', 'QA', 'Quality assurance and validation.', 20),
('a0000001-0000-4000-8000-000000000003', 'SDM', 'SDM', 'Software delivery / squad leadership.', 30),
('a0000001-0000-4000-8000-000000000004', 'PM', 'PM', 'Product management and prioritization.', 40),
('a0000001-0000-4000-8000-000000000005', 'TECH_DIRECTOR', 'Tech Director', 'Technical direction and architecture guardrails.', 50),
('a0000001-0000-4000-8000-000000000006', 'TPM', 'TPM', 'Technical program management.', 60);

INSERT INTO "skill_template" ("id", "code", "label", "description", "sort_order") VALUES
('b0000001-0000-4000-8000-000000000001', 'CODER', 'Coder', 'Implements code changes.', 10),
('b0000001-0000-4000-8000-000000000002', 'CODE_REVIEWER', 'Code reviewer', 'Reviews pull requests and code quality.', 20),
('b0000001-0000-4000-8000-000000000003', 'TECH_DOC_WRITER', 'Tech document writer', 'Technical documentation.', 30),
('b0000001-0000-4000-8000-000000000004', 'DOC_WRITER', 'Document writer', 'General documentation.', 40),
('b0000001-0000-4000-8000-000000000005', 'ANALYZER', 'Analyzer', 'Analysis and clarification.', 50),
('b0000001-0000-4000-8000-000000000006', 'DATA_ANALYZER', 'Data analyzer', 'Data analysis and interpretation.', 60);

-- Which skills each Sarva role may use (superset; teams still pick per seat)
INSERT INTO "role_template_skill" ("role_template_id", "skill_template_id") VALUES
('a0000001-0000-4000-8000-000000000001', 'b0000001-0000-4000-8000-000000000001'),
('a0000001-0000-4000-8000-000000000001', 'b0000001-0000-4000-8000-000000000002'),
('a0000001-0000-4000-8000-000000000001', 'b0000001-0000-4000-8000-000000000003'),
('a0000001-0000-4000-8000-000000000001', 'b0000001-0000-4000-8000-000000000005'),
('a0000001-0000-4000-8000-000000000002', 'b0000001-0000-4000-8000-000000000002'),
('a0000001-0000-4000-8000-000000000002', 'b0000001-0000-4000-8000-000000000004'),
('a0000001-0000-4000-8000-000000000002', 'b0000001-0000-4000-8000-000000000005'),
('a0000001-0000-4000-8000-000000000003', 'b0000001-0000-4000-8000-000000000004'),
('a0000001-0000-4000-8000-000000000003', 'b0000001-0000-4000-8000-000000000005'),
('a0000001-0000-4000-8000-000000000003', 'b0000001-0000-4000-8000-000000000003'),
('a0000001-0000-4000-8000-000000000004', 'b0000001-0000-4000-8000-000000000004'),
('a0000001-0000-4000-8000-000000000004', 'b0000001-0000-4000-8000-000000000005'),
('a0000001-0000-4000-8000-000000000005', 'b0000001-0000-4000-8000-000000000002'),
('a0000001-0000-4000-8000-000000000005', 'b0000001-0000-4000-8000-000000000003'),
('a0000001-0000-4000-8000-000000000005', 'b0000001-0000-4000-8000-000000000005'),
('a0000001-0000-4000-8000-000000000006', 'b0000001-0000-4000-8000-000000000004'),
('a0000001-0000-4000-8000-000000000006', 'b0000001-0000-4000-8000-000000000005'),
('a0000001-0000-4000-8000-000000000006', 'b0000001-0000-4000-8000-000000000006');

ALTER TABLE "role" ADD COLUMN "role_template_id" UUID;
ALTER TABLE "role" ADD CONSTRAINT "role_role_template_id_fkey" FOREIGN KEY ("role_template_id") REFERENCES "role_template"("id") ON DELETE SET NULL ON UPDATE CASCADE;

DROP TABLE "role_skill";

CREATE TABLE "role_skill_link" (
    "role_id" UUID NOT NULL,
    "skill_template_id" UUID NOT NULL,

    CONSTRAINT "role_skill_link_pkey" PRIMARY KEY ("role_id","skill_template_id")
);

ALTER TABLE "role_skill_link" ADD CONSTRAINT "role_skill_link_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "role"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "role_skill_link" ADD CONSTRAINT "role_skill_link_skill_template_id_fkey" FOREIGN KEY ("skill_template_id") REFERENCES "skill_template"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "project_context" ADD COLUMN "analysis_notes" TEXT;

ALTER TABLE "task" ADD COLUMN "target_role_id" UUID;
ALTER TABLE "task" ADD CONSTRAINT "task_target_role_id_fkey" FOREIGN KEY ("target_role_id") REFERENCES "role"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "task_target_role_id_idx" ON "task"("target_role_id");
