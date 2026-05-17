/**
 * Dev / CI hygiene: remove User rows created by Vitest, Playwright, and similar logins
 * (emails ending with @sarva.test). Clears dependent rows first (comments, audits, approvals, approver refs).
 *
 * Run from repo root: npm run db:purge-test-users
 * Does NOT delete normal operator accounts (e.g. you@example.com).
 */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  const candidates = await prisma.user.findMany({
    where: { email: { endsWith: "@sarva.test", mode: "insensitive" } },
    select: { id: true, email: true },
  });
  let removed = 0;
  for (const u of candidates) {
    if (!u.email.toLowerCase().endsWith("@sarva.test")) continue;
    try {
      await prisma.$transaction(async (tx) => {
        await tx.taskComment.deleteMany({ where: { authorId: u.id } });
        await tx.auditEvent.deleteMany({ where: { actorId: u.id } });
        await tx.approval.deleteMany({ where: { approverUserId: u.id } });
        await tx.project.updateMany({
          where: { designatedApproverUserId: u.id },
          data: { designatedApproverUserId: null },
        });
        await tx.user.delete({ where: { id: u.id } });
      });
      removed += 1;
    } catch (e) {
      console.error(JSON.stringify({ skipped: u.email, reason: String(e) }));
    }
  }
  console.log(JSON.stringify({ ok: true, removed, scanned: candidates.length }, null, 2));
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
