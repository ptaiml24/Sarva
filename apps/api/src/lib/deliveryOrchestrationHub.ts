/**
 * Thin hub for delivery-time routing: one place to load team seating + skills and resolve workflow agents.
 *
 * **Routing contract**
 * - Sources: teams linked to the project (`team_project`), agents assigned on `agent_seat`, skills on each seat via `role_skill_link` → `skill_template`.
 * - `resolveWorkflowAgent*` scores seats with {@link scoreSeatForOrchestrationWorkflow} (workflow-specific skill weights). First positive match wins with deterministic tie-break.
 * - **Model bindings** resolve in order: seat (`role_id`), then agent, then company default, each tier ordered by `priority` (see `listBindingsForProposeFallthrough`). Separate from skill scoring; board planning may advance down this list on quota-style LLM failures.
 * - **Seat prompts**: when an agent sits in multiple roles, pass `preferredRoleId = skillMatchRoleId` into `loadSeatForAgentOnProject` so skill personas match the winning seat.
 * - **Reviewer routing** (`code_review`): {@link resolveWorkflowAgentExcludingAgent} drops the implementer, then uses the same scorer (workflow-specific weights).
 */

import type { PlanningAgent } from "./linkedTeamPlanningAgents.js";
import { loadAgentsOnLinkedTeamSeats } from "./linkedTeamPlanningAgents.js";
import {
  type OrchestrationWorkflow,
  resolveOrchestrationFromAgents,
} from "./skillBasedOrchestration.js";

export type { OrchestrationWorkflow };

/** In-memory view of seated agents and skills for one project (request-scoped). */
export type TeamRoutingSnapshot = {
  projectId: string;
  agents: PlanningAgent[];
};

/** Why skill-based routing did or did not select a seat. */
export type OrchestrationRoutingReason =
  | "skill_match"
  | "no_agents_on_linked_teams"
  | "no_positive_skill_score";

/** Structured result for logging and for callers to merge with PM/SDM/binding fallbacks. */
export type WorkflowAgentResolution = {
  projectId: string;
  workflow: OrchestrationWorkflow;
  skillMatchAgentId: string | null;
  skillMatchRoleId: string | null;
  skillScore: number | null;
  routing: OrchestrationRoutingReason;
};

/** Optional Fastify/pino-style logger; falls back to JSON line on stdout. */
export type OrchestrationLogTarget = {
  info: (obj: Record<string, unknown>, msg?: string) => void;
};

function emitOrchestrationLog(
  logger: OrchestrationLogTarget | undefined,
  payload: Record<string, unknown>
): void {
  if (logger) {
    logger.info(payload, "orchestration.workflow_resolve");
  } else {
    console.info(JSON.stringify({ ...payload, msg: "orchestration.workflow_resolve" }));
  }
}

/** Request-coalescing cache for seated routing (seconds-level TTL via `process.env`). */
const routingSnapshotCache = new Map<string, { fetchedAtMs: number; snapshot: TeamRoutingSnapshot }>();

function routingSnapshotCacheTtlMs(): number {
  const raw =
    typeof process.env.ORCHESTRATION_ROUTING_SNAPSHOT_CACHE_MS === "string" ?
      process.env.ORCHESTRATION_ROUTING_SNAPSHOT_CACHE_MS.trim()
    : "";
  const n = raw.length ? Number(raw) : 0;
  return Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), 300_000) : 0;
}

export function invalidateTeamRoutingSnapshotCache(projectId: string): void {
  routingSnapshotCache.delete(projectId);
}

export async function loadTeamRoutingSnapshot(projectId: string): Promise<TeamRoutingSnapshot> {
  const ttl = routingSnapshotCacheTtlMs();
  if (ttl > 0) {
    const hit = routingSnapshotCache.get(projectId);
    if (hit && Date.now() - hit.fetchedAtMs < ttl) {
      return hit.snapshot;
    }
  }

  const agents = await loadAgentsOnLinkedTeamSeats(projectId);
  const snapshot: TeamRoutingSnapshot = { projectId, agents };
  if (ttl > 0) routingSnapshotCache.set(projectId, { fetchedAtMs: Date.now(), snapshot });
  return snapshot;
}

export function resolveWorkflowAgentFromSnapshot(
  snapshot: TeamRoutingSnapshot,
  workflow: OrchestrationWorkflow
): WorkflowAgentResolution {
  const { projectId, agents } = snapshot;
  if (agents.length === 0) {
    return {
      projectId,
      workflow,
      skillMatchAgentId: null,
      skillMatchRoleId: null,
      skillScore: null,
      routing: "no_agents_on_linked_teams",
    };
  }
  const best = resolveOrchestrationFromAgents(agents, workflow);
  if (!best) {
    return {
      projectId,
      workflow,
      skillMatchAgentId: null,
      skillMatchRoleId: null,
      skillScore: null,
      routing: "no_positive_skill_score",
    };
  }
  return {
    projectId,
    workflow,
    skillMatchAgentId: best.agentId,
    skillMatchRoleId: best.roleId,
    skillScore: best.score,
    routing: "skill_match",
  };
}

export async function resolveWorkflowAgent(
  projectId: string,
  workflow: OrchestrationWorkflow,
  options?: { snapshot?: TeamRoutingSnapshot; logger?: OrchestrationLogTarget }
): Promise<WorkflowAgentResolution> {
  const snapshot = options?.snapshot ?? (await loadTeamRoutingSnapshot(projectId));
  const resolution = resolveWorkflowAgentFromSnapshot(snapshot, workflow);
  emitOrchestrationLog(options?.logger, {
    projectId: resolution.projectId,
    workflow: resolution.workflow,
    routing: resolution.routing,
    skillMatchAgentId: resolution.skillMatchAgentId,
    skillMatchRoleId: resolution.skillMatchRoleId,
    skillScore: resolution.skillScore,
    seatedAgentCount: snapshot.agents.length,
  });
  return resolution;
}

/**
 * Same as {@link resolveWorkflowAgent}, but seats belonging to `excludeAgentId` are removed first
 * (e.g. implementer must not be picked as reviewer).
 */
export async function resolveWorkflowAgentExcludingAgent(
  projectId: string,
  workflow: OrchestrationWorkflow,
  excludeAgentId: string,
  options?: { snapshot?: TeamRoutingSnapshot; logger?: OrchestrationLogTarget }
): Promise<WorkflowAgentResolution> {
  const snapshot = options?.snapshot ?? (await loadTeamRoutingSnapshot(projectId));
  const ex = typeof excludeAgentId === "string" ? excludeAgentId.trim() : "";
  const agents = ex ? snapshot.agents.filter((a) => a.id !== ex) : snapshot.agents;
  const filteredSnapshot: TeamRoutingSnapshot = { projectId, agents };
  const resolution = resolveWorkflowAgentFromSnapshot(filteredSnapshot, workflow);
  emitOrchestrationLog(options?.logger, {
    projectId: resolution.projectId,
    workflow: resolution.workflow,
    routing: resolution.routing,
    skillMatchAgentId: resolution.skillMatchAgentId,
    skillMatchRoleId: resolution.skillMatchRoleId,
    skillScore: resolution.skillScore,
    seatedAgentCount: agents.length,
    excludedAgentId: ex || null,
  });
  return resolution;
}
