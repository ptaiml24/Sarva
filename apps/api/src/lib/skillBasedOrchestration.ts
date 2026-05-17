import type { PlanningAgent, PlanningSeat } from "./linkedTeamPlanningAgents.js";
import { loadAgentsOnLinkedTeamSeats } from "./linkedTeamPlanningAgents.js";

/**
 * High-level orchestration steps. Sarva picks an **agent** (and their model bindings) by matching
 * **seat skills** on linked teams — the role label is only context; capabilities come from skills.
 */
export type OrchestrationWorkflow = "prd" | "design" | "backlog" | "board_plan" | "code_review";

/** Weighted skill codes per workflow (uppercase). Higher = more important for that step. */
const WORKFLOW_SKILL_WEIGHTS: Record<OrchestrationWorkflow, [code: string, weight: number][]> = {
  prd: [
    ["DOC_WRITER", 5],
    ["DOCUMENT_REVIEWER", 3],
    ["STRATEGIST", 4],
    ["STORYTELLER", 3],
    ["ANALYZER", 3],
    ["PRIORITIZER", 2],
    ["VISIONARY", 2],
    ["RESEARCHER", 2],
  ],
  design: [
    ["TECH_DOC_WRITER", 5],
    ["ARCHITECT", 4],
    ["STRATEGIST", 3],
    ["ANALYZER", 3],
    ["MEDIATOR", 1],
  ],
  backlog: [
    ["PRIORITIZER", 4],
    ["ANALYZER", 4],
    ["STRATEGIST", 3],
    ["VISIONARY", 2],
    ["COORDINATOR", 2],
    ["DOC_WRITER", 2],
    ["STORYTELLER", 2],
    ["SCHEDULER", 2],
  ],
  board_plan: [
    ["PLANNER", 5],
    ["COORDINATOR", 3],
    ["SCHEDULER", 3],
    ["MITIGATOR", 2],
    ["ARCHITECT", 2],
    ["TRACKER", 2],
  ],
  /** Post-implementation review routing: best skill match among seated agents other than the implementer. */
  code_review: [
    ["CODE_REVIEWER", 10],
    ["DOCUMENT_REVIEWER", 6],
    ["ANALYZER", 4],
    ["TESTER", 3],
    ["VALIDATOR", 3],
    ["STRATEGIST", 2],
    /** Weak signal so a peer engineer seat can still win over SDM/PM fallback when others lack review skills. */
    ["CODER", 1],
  ],
};

export function scoreSeatForOrchestrationWorkflow(seat: PlanningSeat, workflow: OrchestrationWorkflow): number {
  const skills = new Set(seat.skillCodes.map((c) => c.toUpperCase()));
  let score = 0;
  for (const [code, w] of WORKFLOW_SKILL_WEIGHTS[workflow]) {
    if (skills.has(code)) score += w;
  }
  const rt = seat.roleTemplateCode?.toUpperCase() ?? "";
  /** Prefer dedicated reviewer seats when multiple agents carry the same review skills (orchestration + tie-breaks). */
  if (workflow === "code_review" && rt === "REVIEWER") score += 3;
  return score;
}

export type ResolvedOrchestrationSeat = {
  agentId: string;
  /** Team `role` row id (target seat) with the strongest skill match for this workflow. */
  roleId: string;
  score: number;
  workflow: OrchestrationWorkflow;
};

/**
 * Picks the assigned agent whose linked seat(s) best match the workflow’s skill profile.
 * Returns `null` when no seated agents in `agents` or no positive skill match.
 */
export function resolveOrchestrationFromAgents(
  agents: PlanningAgent[],
  workflow: OrchestrationWorkflow
): ResolvedOrchestrationSeat | null {
  let best: ResolvedOrchestrationSeat | null = null;

  for (const ag of agents) {
    for (const seat of ag.seats) {
      const score = scoreSeatForOrchestrationWorkflow(seat, workflow);
      if (score <= 0) continue;
      if (!best || score > best.score) {
        best = { agentId: ag.id, roleId: seat.roleId, score, workflow };
      } else if (best && score === best.score) {
        const tie = `${ag.id}:${seat.roleId}:${seat.teamName}`.localeCompare(
          `${best.agentId}:${best.roleId}`
        );
        if (tie < 0) best = { agentId: ag.id, roleId: seat.roleId, score, workflow };
      }
    }
  }

  return best;
}

/**
 * One-shot loader for tests or legacy code. Prefer `resolveWorkflowAgent` in `deliveryOrchestrationHub.ts`.
 */
export async function resolveOrchestrationAgentForProject(
  projectId: string,
  workflow: OrchestrationWorkflow
): Promise<ResolvedOrchestrationSeat | null> {
  const agents = await loadAgentsOnLinkedTeamSeats(projectId);
  return resolveOrchestrationFromAgents(agents, workflow);
}

/** Score a seat for board stub / heuristic assignment from free-text task (skills + role). */
export function scoreSeatForTaskTextHeuristic(taskTextLower: string, seat: PlanningSeat): number {
  const code = seat.roleTemplateCode?.toUpperCase() ?? "";
  const skills = new Set(seat.skillCodes.map((c) => c.toUpperCase()));

  let score = scoreSeatForOrchestrationWorkflow(seat, "board_plan") * 0.35;

  const looksQa =
    /\b(test|tests|testing|qa|quality|verify|verification|smoke|regression|acceptance|uat)\b/i.test(taskTextLower);
  const looksImplement =
    /\b(build|implement|code|dev|api|feature|service|ui|frontend|backend|bugfix|refactor)\b/i.test(taskTextLower);
  const looksPlan =
    /\b(plan|assign|schedule|milestone|dependency|wave|phase)\b/i.test(taskTextLower);

  const looksReview =
    /\b(code review|document review|pull request|pr review)\b/i.test(taskTextLower) ||
    /\breview (the )?(pr|pull request|code|design|requirements|spec|docs)\b/i.test(taskTextLower);
  if (looksReview) {
    if (skills.has("CODE_REVIEWER")) score += 14;
    if (skills.has("DOCUMENT_REVIEWER")) score += 11;
    if (code === "REVIEWER") score += 6;
  }

  if (looksQa) {
    if (skills.has("TESTER") || skills.has("VALIDATOR") || skills.has("BREAKER")) score += 14;
    if (skills.has("TESTWRITER") || skills.has("BUG_DOCUMENTER")) score += 10;
    if (code === "QA") score += 8;
    if (skills.has("DOCUMENT_REVIEWER") || skills.has("ANALYZER")) score += 4;
    if (!looksImplement) score += 2;
  }
  if (looksImplement) {
    if (skills.has("CODER")) score += 12;
    if (skills.has("ARCHITECT") || skills.has("DEBUGGER")) score += 6;
    if (skills.has("AUTOMATOR") || skills.has("DEPLOYER")) score += 4;
    if (code === "ENGINEER") score += 6;
    if (code === "QA" && looksQa) score -= 4;
  }
  if (looksPlan) {
    if (skills.has("PLANNER")) score += 10;
    if (skills.has("COORDINATOR") || skills.has("SCHEDULER")) score += 6;
  }
  if (looksImplement || (!looksQa && !looksImplement)) {
    if (code === "ENGINEER") score += 4;
    if (skills.has("CODER")) score += 4;
  }
  if (code === "SDM" || code === "PM" || code === "TPM") score -= 1;
  return score;
}

/**
 * Deterministic seat/agent pick for a task (used by board stub planning and delivery auto-assign).
 * Falls back to first linked agent seat when all scores are non-positive.
 */
export function pickBestSeatForTask(
  task: { title: string; description: string | null },
  agents: PlanningAgent[],
): { agentId: string; roleId: string } | null {
  const text = `${task.title}\n${task.description ?? ""}`.toLowerCase();
  let best: { agentId: string; roleId: string; score: number } | null = null;

  for (const ag of agents) {
    for (const seat of ag.seats) {
      const sc = scoreSeatForTaskTextHeuristic(text, seat);
      if (!best || sc > best.score) {
        best = { agentId: ag.id, roleId: seat.roleId, score: sc };
      } else if (best && sc === best.score) {
        const tie = `${ag.id}:${seat.roleId}`.localeCompare(`${best.agentId}:${best.roleId}`);
        if (tie < 0) best = { agentId: ag.id, roleId: seat.roleId, score: sc };
      }
    }
  }

  if (agents.length > 0 && agents[0].seats[0]) {
    const fallback = { agentId: agents[0].id, roleId: agents[0].seats[0].roleId, score: -999 };
    if (!best) return { agentId: fallback.agentId, roleId: fallback.roleId };
    if (best.score <= 0) return { agentId: fallback.agentId, roleId: fallback.roleId };
  }

  return best ? { agentId: best.agentId, roleId: best.roleId } : null;
}
