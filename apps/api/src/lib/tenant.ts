import { prisma } from "./prisma.js";

/** R1: resolve the deployment’s company (first `Company` row — one org per deployment in this release). */
export async function getCompanyId(): Promise<string | null> {
  const c = await prisma.company.findFirst({ select: { id: true } });
  return c?.id ?? null;
}

export async function requireCompanyId(): Promise<string> {
  const id = await getCompanyId();
  if (!id) {
    throw new Error("NO_COMPANY");
  }
  return id;
}
