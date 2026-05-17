import { prisma } from "./prisma.js";
import {
  resolveWorkflowAgentExcludingAgent,
  type OrchestrationLogTarget,
} from "./deliveryOrchestrationHub.js";

/**
 * Best seated reviewer for this project (same skill scorer as other workflows; `"code_review"` weights in
 * {@link scoreSeatForOrchestrationWorkflow}),
 * never the implementer. If no seat earns a positive score, returns `null` so callers can fall back to SDM/PM.
 */
export async function findReviewerAgentId(
  projectId: string,
  excludeAgentId: string,
  options?: { logger?: OrchestrationLogTarget }
): Promise<string | null> {
  const r = await resolveWorkflowAgentExcludingAgent(projectId, "code_review", excludeAgentId, {
    logger: options?.logger,
  });
  return r.skillMatchAgentId;
}

/**
 * SDM delivery assignment, else PM orchestrator — never returns `excludeAgentId` (avoids self-review fallback).
 */
export async function findSdmOrPmAgentId(
  projectId: string,
  excludeAgentId?: string | null
): Promise<string | null> {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: {
      pmOrchestratorAgentId: true,
      roleAssignments: { where: { duty: "sdm_delivery" }, select: { agentId: true }, take: 1 },
    },
  });
  if (!project) return null;
  const ex = excludeAgentId ?? null;
  const sdm = project.roleAssignments[0]?.agentId;
  if (sdm && sdm !== ex) return sdm;
  const pm = project.pmOrchestratorAgentId;
  if (pm && pm !== ex) return pm;
  return null;
}
