import type { Env } from "../config/env.js";
import { prisma } from "./prisma.js";
import { deliveryPolicyRecord } from "./deliveryPolicy.js";
import { appendProjectChatMessage } from "./projectChat.js";

/** Persisted count of automation stalls — reset on Begin execution and on operator resume. */
export const AUTONOMOUS_STALL_COUNT_KEY = "autonomousStallCount";

/** True once **Begin execution** has written `executionKickoffAt`. */
export function hasExecutionKickoff(policy: unknown): boolean {
  const p = deliveryPolicyRecord(policy);
  return typeof p.executionKickoffAt === "string";
}

/** Server-side prerequisites for unattended coder + reviewer loops. Exposed on delivery summary for UI. */
export function automationHandsOffEligibleFromEnv(env: Env): boolean {
  const coderOk = env.AGENT_CODER_USE_LLM === "true" || env.AGENT_CODER_E2E_STUB === "true";
  const reviewOk = env.AGENT_AUTOMATED_REVIEW === "true" || env.AGENT_AUTOMATED_REVIEW_E2E_STUB === "true";
  return coderOk && reviewOk;
}

export function readAutonomousStallCount(policy: unknown): number {
  const pol = deliveryPolicyRecord(policy);
  const n = pol[AUTONOMOUS_STALL_COUNT_KEY];
  return typeof n === "number" && Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
}

export function stallsBeforeOperatorHandsOn(env: Env): number {
  return env.AGENT_AUTONOMOUS_STALL_OPERATOR_THRESHOLD;
}

export function autonomousOperatorRequired(policy: unknown, env: Env): boolean {
  return readAutonomousStallCount(policy) >= stallsBeforeOperatorHandsOn(env);
}

/** Full board manipulation is hidden only when autonomy is reachable and stalls have not breached the threshold. */
export function shouldUseHandsOffBoardUi(policy: unknown, env: Env, allTasksDone: boolean): boolean {
  return (
    hasExecutionKickoff(policy) &&
    !allTasksDone &&
    automationHandsOffEligibleFromEnv(env) &&
    !autonomousOperatorRequired(policy, env)
  );
}

export async function resetAutonomousStallCount(projectId: string): Promise<void> {
  const project = await prisma.project.findUnique({ where: { id: projectId }, select: { deliveryPolicy: true } });
  const pol = deliveryPolicyRecord(project?.deliveryPolicy);
  delete pol[AUTONOMOUS_STALL_COUNT_KEY];
  await prisma.project.update({ where: { id: projectId }, data: { deliveryPolicy: pol as object } });
}

/**
 * Bump stall counter once kickoff exists. When the count crosses the operator threshold,
 * post a Chat line so operators know routine board actions are surfaced again.
 */
export async function recordAutonomousOrchestrationStall(
  projectId: string,
  env: Env,
  meta: Record<string, unknown>
): Promise<void> {
  const project = await prisma.project.findUnique({ where: { id: projectId }, select: { deliveryPolicy: true } });
  if (!project || !hasExecutionKickoff(project.deliveryPolicy)) return;

  /** Only meter stalls when coder + automated review are configured—the same precondition as hands-off board UI. */
  if (!automationHandsOffEligibleFromEnv(env)) return;

  const pol = deliveryPolicyRecord(project.deliveryPolicy);
  const prev = readAutonomousStallCount(pol);
  const next = prev + 1;
  pol[AUTONOMOUS_STALL_COUNT_KEY] = next;

  const threshold = stallsBeforeOperatorHandsOn(env);
  const crosses = prev < threshold && next >= threshold;

  await prisma.project.update({
    where: { id: projectId },
    data: { deliveryPolicy: pol as object },
  });

  if (!crosses) return;

  await appendProjectChatMessage({
    projectId,
    actorKind: "orchestrator",
    actorLabel: "Orchestrator",
    body:
      `**Operator attention:** unattended delivery stalled **more than ${threshold - 1}** time(s) (counter now **${next}**). ` +
      `Open the Board — **all manual controls are shown** until you fix bindings, reviewer routing, or tasks. ` +
      `Use **Continue hands-off automation** on the board after fixes to reset the stall counter (optional).`,
    meta: {
      event: "delivery.autonomous.operator_required",
      autonomousStallCount: next,
      threshold,
      ...meta,
    },
  });
}
