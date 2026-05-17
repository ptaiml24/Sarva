/**
 * **Workspace reset** — removes operational data so you can rebuild org + projects from scratch.
 *
 * Deletes: all projects (and PM drafts, design artifacts, tasks, sprints, repo/context rows, team↔project links),
 * all teams (cascades roles, seats, seat skills), all **business units**, all **agents**, all **budgets**, **cost
 * events**, **approvals**, and **audit events** for the company. Also purges legacy **SARVA_DEMO_SEED** rows if present.
 *
 * **Keeps:** Sarva **role/skill templates**, **users**, **LLM provider connections**, **company-scoped model bindings** (and
 * company `Skill` rows if any). The **Company** row is kept when present; if legacy cleanup removed it or the DB had none,
 * a fresh **“Sarva”** company is created so the API always has an organization record.
 *
 * Run: `npm run db:clean-sample` from repo root (or `npx tsx prisma/clean-sample-data.ts` in `apps/api`).
 */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

/** Former `prisma/seed.ts` demo when `SARVA_DEMO_SEED=1` (removed — delete if still in your DB). */
const LEGACY_DEMO = {
  userId: "00000000-0000-4000-8000-000000000010",
  agentId: "00000000-0000-4000-8000-000000000002",
  modelBindingId: "00000000-0000-4000-8000-000000000030",
} as const;

async function purgeLegacyDemoArtifacts() {
  const seedUsers = await prisma.user.findMany({
    where: { OR: [{ id: LEGACY_DEMO.userId }, { email: "seed@example.com" }] },
    select: { id: true },
  });
  for (const { id } of seedUsers) {
    await prisma.auditEvent.deleteMany({ where: { actorId: id } });
    await prisma.taskComment.deleteMany({ where: { authorId: id } });
    await prisma.approval.deleteMany({ where: { approverUserId: id } });
    await prisma.project.updateMany({ where: { designatedApproverUserId: id }, data: { designatedApproverUserId: null } });
  }
  await prisma.user.deleteMany({
    where: { OR: [{ id: LEGACY_DEMO.userId }, { email: "seed@example.com" }] },
  });

  await prisma.modelBinding.deleteMany({ where: { id: LEGACY_DEMO.modelBindingId } });
  await prisma.agent.deleteMany({ where: { id: LEGACY_DEMO.agentId } });
  /** Name-only: do not match legacy demo company by fixed UUID (that id may have been reused / renamed to “Sarva”). */
  await prisma.company.deleteMany({ where: { name: "Sarva Demo Co" } });
}

const DEFAULT_TENANT_NAME = "Sarva";

async function ensureCompanyAfterReset() {
  const n = await prisma.company.count();
  if (n > 0) return { recreated: false as const };
  await prisma.company.create({ data: { name: DEFAULT_TENANT_NAME, settings: {} } });
  return { recreated: true as const };
}

async function main() {
  const company = await prisma.company.findFirst({ select: { id: true } });
  const companyId = company?.id;

  await prisma.$transaction(async (tx) => {
    await tx.taskComment.deleteMany();
    await tx.proposedBacklogItem.deleteMany();
    await tx.designArtifact.deleteMany();
    await tx.projectRoleAssignment.deleteMany();
    await tx.task.deleteMany();
    await tx.sprint.deleteMany();
    await tx.teamProject.deleteMany();
    await tx.projectContext.deleteMany();
    await tx.repositoryScope.deleteMany();
    await tx.project.deleteMany();
    await tx.team.deleteMany();
    if (companyId) {
      await tx.businessUnit.deleteMany({ where: { companyId } });
    }
    await tx.costEvent.deleteMany();
    await tx.approval.deleteMany();
    await tx.auditEvent.deleteMany();
    await tx.budget.deleteMany();
    await tx.agent.deleteMany();
  });

  await purgeLegacyDemoArtifacts();

  const { recreated } = await ensureCompanyAfterReset();
  const companiesLeft = await prisma.company.count();

  console.log(
    JSON.stringify(
      {
        ok: true,
        message:
          "Workspace reset: projects, teams, business units, agents, budgets, cost events, approvals, and audit events removed. Sarva catalogs + users preserved. Add BUs and teams from the UI.",
        companiesLeft,
        ...(recreated
          ? {
              note: `No company row was left after cleanup — created "${DEFAULT_TENANT_NAME}" (same default as db:seed).`,
            }
          : {}),
      },
      null,
      2
    )
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
