import { prisma } from "./prisma.js";

export type CoderAgentRunBrief = {
  ran?: boolean;
  submittedToReview?: boolean;
  error?: string;
};

export type OrchestrationTelemetryMeta = {
  source?: string;
  correlationId?: string | null;
};

export type PersistableOrchestrationPassShape = {
  promotedTaskIds: string[];
  assignedTaskIds: string[];
  startedTaskIds: string[];
  coderAgentRuns: CoderAgentRunBrief[];
};

/** True when a pass visibly changed the board or ran coders — used by summaries and persisted passes. */
export function deliveryOrchestrationPassSurfacedEffects(o: PersistableOrchestrationPassShape): boolean {
  return (
    o.promotedTaskIds.length > 0 ||
    o.assignedTaskIds.length > 0 ||
    o.startedTaskIds.length > 0 ||
    o.coderAgentRuns.some((r) => Boolean(r?.submittedToReview) || Boolean(r?.ran))
  );
}

export async function persistDeliveryOrchestrationPass(
  projectId: string,
  o: PersistableOrchestrationPassShape,
  meta?: OrchestrationTelemetryMeta
): Promise<void> {
  const partialErrors = o.coderAgentRuns
    .map((r) => r?.error?.trim())
    .filter((x): x is string => Boolean(x?.length))
    .map((m) => m.slice(0, 1200));

  await prisma.deliveryOrchestrationPass.create({
    data: {
      projectId,
      promotedCount: o.promotedTaskIds.length,
      assignedCount: o.assignedTaskIds.length,
      startedCount: o.startedTaskIds.length,
      coderRunsCount: o.coderAgentRuns.filter((r) => Boolean(r?.ran)).length,
      coderSubmittedCount: o.coderAgentRuns.filter((r) => Boolean(r?.submittedToReview)).length,
      surfacedEffects: deliveryOrchestrationPassSurfacedEffects(o),
      source: meta?.source?.trim() || "hook",
      correlationId: meta?.correlationId?.trim() || null,
      ...(partialErrors.length > 0 ? { partialErrors } : {}),
    },
  });
}
