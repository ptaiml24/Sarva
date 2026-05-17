import { prisma } from "./prisma.js";

export async function recordAudit(
  actorId: string,
  action: string,
  resourceRef: string,
  payloadHash: string | null = null
): Promise<void> {
  await prisma.auditEvent.create({
    data: { actorId, action, resourceRef, payloadHash },
  });
}
