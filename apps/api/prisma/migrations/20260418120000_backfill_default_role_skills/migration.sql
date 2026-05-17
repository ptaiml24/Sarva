-- Every seat with a Sarva role template gets all catalog-eligible skill templates linked by default.
-- Matches app behavior: new seats call ensureDefaultSkillsForRole; this backfills existing rows.
INSERT INTO "role_skill_link" ("role_id", "skill_template_id")
SELECT r."id", rts."skill_template_id"
FROM "role" r
INNER JOIN "role_template_skill" rts ON rts."role_template_id" = r."role_template_id"
WHERE r."role_template_id" IS NOT NULL
ON CONFLICT ("role_id", "skill_template_id") DO NOTHING;
