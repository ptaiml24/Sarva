-- Sarva catalog: dedicated Reviewer role template with Code reviewer + Document reviewer skills.

INSERT INTO "role_template" ("id", "code", "label", "description", "sort_order") VALUES
(
  'a0000001-0000-4000-8000-000000000007',
  'REVIEWER',
  'Reviewer',
  'Peer review on implementation (pull requests) and on requirements, specs, and design docs.',
  25
)
ON CONFLICT ("code") DO UPDATE SET
  "label" = EXCLUDED."label",
  "description" = EXCLUDED."description",
  "sort_order" = EXCLUDED."sort_order";

INSERT INTO "role_template_skill" ("role_template_id", "skill_template_id")
SELECT rt."id", st."id"
FROM "role_template" rt
CROSS JOIN "skill_template" st
WHERE rt."code" = 'REVIEWER' AND st."code" IN ('CODE_REVIEWER', 'DOCUMENT_REVIEWER')
ON CONFLICT ("role_template_id", "skill_template_id") DO NOTHING;

-- Seats already tied to this template pick up eligible skills automatically.
INSERT INTO "role_skill_link" ("role_id", "skill_template_id")
SELECT r."id", rts."skill_template_id"
FROM "role" r
INNER JOIN "role_template_skill" rts ON rts."role_template_id" = r."role_template_id"
WHERE r."role_template_id" IS NOT NULL
ON CONFLICT ("role_id", "skill_template_id") DO NOTHING;
