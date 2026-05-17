-- R1 skill matrix: per-role catalog skills, individual prompt bodies in app (`prompt/skills/`).
-- Removes deprecated templates: CODE_REVIEWER → REVIEWER, DOC_WRITER / TECH_DOC_WRITER → DOCUMENTATION + ARCHITECT, DATA_ANALYZER dropped from catalog (use ANALYZER).

INSERT INTO "skill_template" ("id", "code", "label", "description", "sort_order") VALUES
('c0000001-0000-4000-8000-000000000101', 'ARCHITECT', 'Architect', 'Designing system structures, LLD, HLD.', 110),
('c0000001-0000-4000-8000-000000000102', 'DEBUGGER', 'Debugger', 'Finding and fixing logic errors.', 120),
('c0000001-0000-4000-8000-000000000103', 'REVIEWER', 'Reviewer', 'Evaluating peer code quality.', 130),
('c0000001-0000-4000-8000-000000000104', 'AUTOMATOR', 'Automator', 'Creating self-running scripts and pipelines.', 140),
('c0000001-0000-4000-8000-000000000105', 'DEPLOYER', 'Deployer', 'Pushing code to production environments.', 150),
('c0000001-0000-4000-8000-000000000106', 'VISIONARY', 'Visionary', 'Defining the long-term product goal.', 210),
('c0000001-0000-4000-8000-000000000107', 'PRIORITIZER', 'Prioritizer', 'Ranking tasks by business value.', 220),
('c0000001-0000-4000-8000-000000000108', 'RESEARCHER', 'Researcher', 'Studying users and market trends.', 230),
('c0000001-0000-4000-8000-000000000109', 'STRATEGIST', 'Strategist', 'Aligning the product with company goals.', 240),
('c0000001-0000-4000-8000-00000000010a', 'STORYTELLER', 'Storyteller', 'Communicating the why to stakeholders.', 250),
('c0000001-0000-4000-8000-00000000010b', 'DOCUMENTATION', 'Documentation', 'Writes documents like requirements, PRD, PR/FAQ.', 260),
('c0000001-0000-4000-8000-00000000010c', 'SCHEDULER', 'Scheduler', 'Managing timelines and deadlines.', 310),
('c0000001-0000-4000-8000-00000000010d', 'COORDINATOR', 'Coordinator', 'Syncing efforts between different teams.', 320),
('c0000001-0000-4000-8000-00000000010e', 'MITIGATOR', 'Mitigator', 'Identifying and reducing project risks.', 330),
('c0000001-0000-4000-8000-00000000010f', 'TRACKER', 'Tracker', 'Monitoring progress against milestones.', 340),
('c0000001-0000-4000-8000-000000000110', 'MEDIATOR', 'Mediator', 'Resolving internal team conflicts.', 410),
('c0000001-0000-4000-8000-000000000111', 'PLANNER', 'Planner', 'Assigning tasks to team members.', 420),
('c0000001-0000-4000-8000-000000000112', 'TESTER', 'Tester', 'Verifying that features work as intended.', 510),
('c0000001-0000-4000-8000-000000000113', 'BREAKER', 'Breaker', 'Finding ways to fail the system.', 520),
('c0000001-0000-4000-8000-000000000114', 'VALIDATOR', 'Validator', 'Ensuring the product meets requirements.', 530),
('c0000001-0000-4000-8000-000000000115', 'BUG_DOCUMENTER', 'Bug documenter', 'Recording bug steps and results.', 540),
('c0000001-0000-4000-8000-000000000116', 'TESTWRITER', 'Test writer', 'Coding automated test suites.', 550)
ON CONFLICT ("code") DO UPDATE SET
  "label" = EXCLUDED."label",
  "description" = EXCLUDED."description",
  "sort_order" = EXCLUDED."sort_order";

UPDATE "skill_template" SET "label" = 'Coder', "description" = 'Writing functional logic.', "sort_order" = 10 WHERE "code" = 'CODER';
UPDATE "skill_template" SET "description" = 'Interpreting data and usage metrics.', "sort_order" = 200 WHERE "code" = 'ANALYZER';

UPDATE "role_template" SET "label" = 'Software Engineer (SDE)' WHERE "code" = 'ENGINEER';
UPDATE "role_template" SET "label" = 'Product Manager (PM)' WHERE "code" = 'PM';
UPDATE "role_template" SET "label" = 'Technical Program Manager (TPM)' WHERE "code" = 'TPM';
UPDATE "role_template" SET "label" = 'Software Development Manager (SDM)' WHERE "code" = 'SDM';
UPDATE "role_template" SET "label" = 'Quality Assurance (QA)' WHERE "code" = 'QA';

DELETE FROM "role_template_skill";

DELETE FROM "role_skill_link"
WHERE "role_id" IN (SELECT "id" FROM "role" WHERE "role_template_id" IS NOT NULL);

DELETE FROM "skill_template" WHERE "code" IN ('CODE_REVIEWER', 'DOC_WRITER', 'TECH_DOC_WRITER', 'DATA_ANALYZER');

-- Software Engineer (SDE)
INSERT INTO "role_template_skill" ("role_template_id", "skill_template_id")
SELECT 'a0000001-0000-4000-8000-000000000001', "id" FROM "skill_template" WHERE "code" IN
  ('CODER', 'ARCHITECT', 'DEBUGGER', 'REVIEWER', 'AUTOMATOR', 'DEPLOYER');

-- Product Manager (PM)
INSERT INTO "role_template_skill" ("role_template_id", "skill_template_id")
SELECT 'a0000001-0000-4000-8000-000000000004', "id" FROM "skill_template" WHERE "code" IN
  ('VISIONARY', 'PRIORITIZER', 'RESEARCHER', 'STRATEGIST', 'STORYTELLER', 'ANALYZER', 'DOCUMENTATION');

-- Quality Assurance (QA)
INSERT INTO "role_template_skill" ("role_template_id", "skill_template_id")
SELECT 'a0000001-0000-4000-8000-000000000002', "id" FROM "skill_template" WHERE "code" IN
  ('TESTER', 'BREAKER', 'VALIDATOR', 'BUG_DOCUMENTER', 'TESTWRITER');

-- Software Development Manager (SDM)
INSERT INTO "role_template_skill" ("role_template_id", "skill_template_id")
SELECT 'a0000001-0000-4000-8000-000000000003', "id" FROM "skill_template" WHERE "code" IN
  ('MEDIATOR', 'PLANNER', 'ARCHITECT');

-- Technical Program Manager (TPM)
INSERT INTO "role_template_skill" ("role_template_id", "skill_template_id")
SELECT 'a0000001-0000-4000-8000-000000000006', "id" FROM "skill_template" WHERE "code" IN
  ('SCHEDULER', 'COORDINATOR', 'MITIGATOR', 'TRACKER');

-- Tech Director — leadership / architecture guardrails (catalog role retained)
INSERT INTO "role_template_skill" ("role_template_id", "skill_template_id")
SELECT 'a0000001-0000-4000-8000-000000000005', "id" FROM "skill_template" WHERE "code" IN
  ('ARCHITECT', 'REVIEWER', 'STRATEGIST', 'ANALYZER');

INSERT INTO "role_skill_link" ("role_id", "skill_template_id")
SELECT r."id", rts."skill_template_id"
FROM "role" r
INNER JOIN "role_template_skill" rts ON rts."role_template_id" = r."role_template_id"
WHERE r."role_template_id" IS NOT NULL
ON CONFLICT ("role_id", "skill_template_id") DO NOTHING;
