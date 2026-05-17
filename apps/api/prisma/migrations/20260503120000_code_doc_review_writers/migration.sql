-- Split review and writing: CODE_REVIEWER vs DOCUMENT_REVIEWER; DOC_WRITER vs TECH_DOC_WRITER.
-- Drops generic REVIEWER + DOCUMENTATION in favor of explicit skills.

INSERT INTO "skill_template" ("id", "code", "label", "description", "sort_order") VALUES
('b0000001-0000-4000-8000-000000000002', 'CODE_REVIEWER', 'Code reviewer', 'Evaluating peer code quality (PRs, implementation).', 21),
('b0000001-0000-4000-8000-000000000003', 'TECH_DOC_WRITER', 'Tech document writer', 'Design documents, HLD, LLD, sequence diagrams, technical specs.', 31),
('b0000001-0000-4000-8000-000000000004', 'DOC_WRITER', 'Document writer', 'PR/FAQ, PRD, requirements, stakeholder product docs.', 41),
('c0000001-0000-4000-8000-000000000117', 'DOCUMENT_REVIEWER', 'Document reviewer', 'Reviewing requirements, PRDs, FAQs, and design docs for clarity and gaps.', 261)
ON CONFLICT ("code") DO UPDATE SET
  "label" = EXCLUDED."label",
  "description" = EXCLUDED."description",
  "sort_order" = EXCLUDED."sort_order";

DELETE FROM "role_template_skill";

DELETE FROM "role_skill_link"
WHERE "role_id" IN (SELECT "id" FROM "role" WHERE "role_template_id" IS NOT NULL);

DELETE FROM "skill_template" WHERE "code" IN ('REVIEWER', 'DOCUMENTATION');

-- Software Engineer (SDE)
INSERT INTO "role_template_skill" ("role_template_id", "skill_template_id")
SELECT 'a0000001-0000-4000-8000-000000000001', "id" FROM "skill_template" WHERE "code" IN
  ('CODER', 'ARCHITECT', 'DEBUGGER', 'CODE_REVIEWER', 'AUTOMATOR', 'DEPLOYER', 'TECH_DOC_WRITER');

-- Product Manager (PM)
INSERT INTO "role_template_skill" ("role_template_id", "skill_template_id")
SELECT 'a0000001-0000-4000-8000-000000000004', "id" FROM "skill_template" WHERE "code" IN
  ('VISIONARY', 'PRIORITIZER', 'RESEARCHER', 'STRATEGIST', 'STORYTELLER', 'ANALYZER', 'DOC_WRITER', 'DOCUMENT_REVIEWER');

-- Quality Assurance (QA)
INSERT INTO "role_template_skill" ("role_template_id", "skill_template_id")
SELECT 'a0000001-0000-4000-8000-000000000002', "id" FROM "skill_template" WHERE "code" IN
  ('TESTER', 'BREAKER', 'VALIDATOR', 'BUG_DOCUMENTER', 'TESTWRITER', 'DOCUMENT_REVIEWER');

-- Software Development Manager (SDM)
INSERT INTO "role_template_skill" ("role_template_id", "skill_template_id")
SELECT 'a0000001-0000-4000-8000-000000000003', "id" FROM "skill_template" WHERE "code" IN
  ('MEDIATOR', 'PLANNER', 'ARCHITECT', 'TECH_DOC_WRITER', 'CODE_REVIEWER', 'DOCUMENT_REVIEWER');

-- Technical Program Manager (TPM)
INSERT INTO "role_template_skill" ("role_template_id", "skill_template_id")
SELECT 'a0000001-0000-4000-8000-000000000006', "id" FROM "skill_template" WHERE "code" IN
  ('SCHEDULER', 'COORDINATOR', 'MITIGATOR', 'TRACKER', 'DOCUMENT_REVIEWER');

-- Tech Director
INSERT INTO "role_template_skill" ("role_template_id", "skill_template_id")
SELECT 'a0000001-0000-4000-8000-000000000005', "id" FROM "skill_template" WHERE "code" IN
  ('ARCHITECT', 'CODE_REVIEWER', 'STRATEGIST', 'ANALYZER', 'TECH_DOC_WRITER', 'DOCUMENT_REVIEWER');

INSERT INTO "role_skill_link" ("role_id", "skill_template_id")
SELECT r."id", rts."skill_template_id"
FROM "role" r
INNER JOIN "role_template_skill" rts ON rts."role_template_id" = r."role_template_id"
WHERE r."role_template_id" IS NOT NULL
ON CONFLICT ("role_id", "skill_template_id") DO NOTHING;
