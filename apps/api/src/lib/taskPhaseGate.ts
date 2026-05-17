import type { Prisma } from "@prisma/client";

type Tx = Omit<
  Prisma.TransactionClient,
  "$connect" | "$disconnect" | "$on" | "$transaction" | "$use" | "$extends"
>;

export async function findPhaseGateBlocking(
  tx: Tx,
  projectId: string,
  executionPhase: number
): Promise<{ id: string; title: string; state: string; executionPhase: number }[]> {
  if (executionPhase <= 0) return [];
  return tx.task.findMany({
    where: { projectId, executionPhase: { lt: executionPhase }, state: { not: "done" } },
    select: { id: true, title: true, state: true, executionPhase: true },
    take: 20,
  });
}
