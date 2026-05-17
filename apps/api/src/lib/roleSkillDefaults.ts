import type { PrismaClient } from "@prisma/client";

/**
 * For a new or existing seat with a Sarva `roleTemplateId`, create `role_skill_link` rows for every
 * catalog `role_template_skill` row (eligible skills). Idempotent via `skipDuplicates`.
 */
export async function ensureDefaultSkillsForRole(
  db: Pick<PrismaClient, "roleTemplateSkill" | "roleSkillLink">,
  roleId: string,
  roleTemplateId: string
): Promise<void> {
  const allowed = await db.roleTemplateSkill.findMany({
    where: { roleTemplateId },
    select: { skillTemplateId: true },
  });
  if (allowed.length === 0) return;
  await db.roleSkillLink.createMany({
    data: allowed.map((row) => ({ roleId, skillTemplateId: row.skillTemplateId })),
    skipDuplicates: true,
  });
}

/**
 * After a `(role_template, skill)` is allowed in catalog, mirror it onto every team **seat**
 * (`role` row) of that Sarva template so run-coder eligibility sees `RoleSkillLink`.
 */
export async function propagateTemplateSkillToAllRolesOfTemplate(
  db: Pick<PrismaClient, "role" | "roleSkillLink">,
  roleTemplateId: string,
  skillTemplateId: string,
): Promise<{ seatRoleCount: number }> {
  const roles = await db.role.findMany({
    where: { roleTemplateId },
    select: { id: true },
  });
  if (roles.length === 0) return { seatRoleCount: 0 };
  await db.roleSkillLink.createMany({
    data: roles.map((r) => ({ roleId: r.id, skillTemplateId })),
    skipDuplicates: true,
  });
  return { seatRoleCount: roles.length };
}

/** When removing a skill from the role type catalog, drop it from all seats using that template. */
export async function revokeTemplateSkillFromAllRolesOfTemplate(
  db: Pick<PrismaClient, "roleSkillLink">,
  roleTemplateId: string,
  skillTemplateId: string,
): Promise<void> {
  await db.roleSkillLink.deleteMany({
    where: {
      skillTemplateId,
      role: { roleTemplateId },
    },
  });
}
