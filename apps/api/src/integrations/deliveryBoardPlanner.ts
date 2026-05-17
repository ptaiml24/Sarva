import type { Prisma } from "@prisma/client";
import type { Env } from "../config/env.js";
import { prisma } from "../lib/prisma.js";
import { BOARD_PLAN_SYSTEM } from "../prompt/sdm-prompts.js";
import { generateAssistantText } from "./llm/chatCompletion.js";
import type { ResolvedLlmCredentials } from "./llm/types.js";
import {
  buildIntakeContextPrefix,
  isLlmQuotaOrOverloadFailure,
  resolveDesignLlmAgentId,
  withProposeBindingFallback,
} from "./pmOrchestrator.js";
import { loadSeatForAgentOnProject } from "../lib/agentSeatPromptContext.js";
import {
  loadTeamRoutingSnapshot,
  resolveWorkflowAgent,
  type OrchestrationLogTarget,
} from "../lib/deliveryOrchestrationHub.js";
import { runDeliveryOrchestrationHook } from "../lib/deliveryOrchestration.js";
import { reconcilePredecessorPhasesForProject } from "../lib/planGraphReconcile.js";
import { composeBoardPlanSystemPromptForSeat } from "../prompt/skills/composeSeatTaskPrompt.js";
import { type PlanningAgent } from "../lib/linkedTeamPlanningAgents.js";
import { scoreSeatForTaskTextHeuristic, pickBestSeatForTask } from "../lib/skillBasedOrchestration.js";
import { areDuplicateTaskTitles, collapseDuplicateTasksForProject } from "../lib/taskDedupe.js";

/** RFC 4122 UUID string (lenient — models often fail strict zod uuid). */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isUuidString(s: unknown): s is string {
  return typeof s === "string" && UUID_RE.test(s.trim());
}

function trimStr(s: unknown): string | undefined {
  return typeof s === "string" ? s.trim() : undefined;
}

type NormalizedUpdate = {
  taskId: string;
  executionPhase?: number;
  assigneeAgentId?: string | null;
  targetRoleId?: string | null;
  priority?: string | null;
};

type NormalizedNewTask = {
  title: string;
  description?: string;
  executionPhase?: number;
  kind?: "qa" | "feature";
  targetRoleId?: string;
};

/**
 * Accepts messy model JSON: drops invalid UUIDs and unknown ids instead of failing the whole plan.
 */
function normalizeBoardPlanJson(
  json: unknown,
  eligibleTaskIds: Set<string>,
  agentSet: Set<string>,
  roleSet: Set<string>
): { updates: NormalizedUpdate[]; newTasks: NormalizedNewTask[] } {
  const updates: NormalizedUpdate[] = [];
  const newTasks: NormalizedNewTask[] = [];

  if (!json || typeof json !== "object" || Array.isArray(json)) {
    return { updates, newTasks };
  }

  const root = json as Record<string, unknown>;
  const rawUpdates = Array.isArray(root.updates) ? root.updates : [];
  const rawNewTasks = Array.isArray(root.newTasks) ? root.newTasks : [];

  for (const item of rawUpdates) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const u = item as Record<string, unknown>;
    const taskId = trimStr(u.taskId);
    if (!taskId || !isUuidString(taskId) || !eligibleTaskIds.has(taskId)) continue;

    const nu: NormalizedUpdate = { taskId };
    if (typeof u.executionPhase === "number" && Number.isFinite(u.executionPhase)) {
      nu.executionPhase = Math.min(50, Math.max(0, Math.floor(u.executionPhase)));
    }
    if (u.priority === null) {
      nu.priority = null;
    } else {
      const p = trimStr(u.priority);
      if (p !== undefined) nu.priority = p.slice(0, 200);
    }

    const aid = u.assigneeAgentId;
    if (aid === null) {
      nu.assigneeAgentId = null;
    } else if (isUuidString(aid) && agentSet.has(aid.trim())) {
      nu.assigneeAgentId = aid.trim();
    }

    const rid = u.targetRoleId;
    if (rid === null) {
      nu.targetRoleId = null;
    } else if (isUuidString(rid) && roleSet.has(rid.trim())) {
      nu.targetRoleId = rid.trim();
    }

    updates.push(nu);
  }

  const seenTask = new Map<string, NormalizedUpdate>();
  for (const u of updates) {
    seenTask.set(u.taskId, u);
  }
  const dedupedUpdates = [...seenTask.values()];

  for (const item of rawNewTasks) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const n = item as Record<string, unknown>;
    const title = trimStr(n.title);
    if (!title) continue;

    const nt: NormalizedNewTask = { title: title.slice(0, 500) };
    const desc = trimStr(n.description);
    if (desc) nt.description = desc.slice(0, 20_000);
    if (typeof n.executionPhase === "number" && Number.isFinite(n.executionPhase)) {
      nt.executionPhase = Math.min(50, Math.max(0, Math.floor(n.executionPhase)));
    }
    const k = n.kind;
    if (k === "qa" || k === "feature") nt.kind = k;
    const tr = n.targetRoleId;
    if (isUuidString(tr) && roleSet.has(tr.trim())) {
      nt.targetRoleId = tr.trim();
    }
    newTasks.push(nt);
  }

  return { updates: dedupedUpdates, newTasks };
}

export type BoardPlanResult = {
  usedLlm: boolean;
  modelLabel: string;
  tasksUpdated: number;
  tasksCreated: number;
  /** Predecessors lowered so phase ≤ successor on every dependency edge (deterministic reconcile). */
  phasesReconciled: number;
};

function stripJsonFence(raw: string): string {
  let t = raw.trim();
  if (t.startsWith("```")) {
    t = t.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  }
  return t.trim();
}

async function chatBoardPlanJson(
  userPrompt: string,
  cred: ResolvedLlmCredentials,
  fallbackOpenAiEnvKey: string | undefined,
  systemPrompt: string = BOARD_PLAN_SYSTEM
): Promise<string> {
  return generateAssistantText({
    cred,
    systemPrompt,
    userPrompt,
    temperature: 0.2,
    jsonObjectMode: true,
    fallbackOpenAiEnvKey,
    errorLabel: "Board planning LLM failed",
  });
}

function pickBestQaSeat(agents: PlanningAgent[]): { agentId: string; roleId: string } | null {
  let best: { agentId: string; roleId: string; score: number } | null = null;
  const pseudoTask = "qa verification smoke test acceptance";
  for (const ag of agents) {
    for (const seat of ag.seats) {
      const sc = scoreSeatForTaskTextHeuristic(pseudoTask, seat);
      if (!best || sc > best.score) {
        best = { agentId: ag.id, roleId: seat.roleId, score: sc };
      }
    }
  }
  if (best && best.score > 0) return { agentId: best.agentId, roleId: best.roleId };

  for (const ag of agents) {
    const qaSeat = ag.seats.find((s) => s.roleTemplateCode?.toUpperCase() === "QA");
    if (qaSeat) return { agentId: ag.id, roleId: qaSeat.roleId };
  }

  return pickBestSeatForTask({ title: "general", description: null }, agents);
}

function assertHasSeatAgentsForPlanning(taskCount: number, agentCount: number): void {
  if (taskCount === 0 || agentCount > 0) return;
  throw new Error(
    "Board planning needs at least one agent assigned to a seat on a team linked to this project. " +
      "On Organization → Teams, open the linked team, map agents under Seat ↔ agent assignments, then publish again."
  );
}

async function loadPlanningContext(
  projectId: string,
  agents?: PlanningAgent[],
  opts?: { includeTodoTasks?: boolean }
) {
  const [tasks, agentsOut, roles, intakePrefix] = await Promise.all([
    prisma.task.findMany({
      where:
        opts?.includeTodoTasks === true ?
          { projectId, state: { in: ["backlog", "todo"] } }
        : { projectId, state: "backlog" },
      orderBy: { title: "asc" },
      select: { id: true, title: true, executionPhase: true, description: true, state: true },
    }),
    agents ? Promise.resolve(agents) : loadTeamRoutingSnapshot(projectId).then((s) => s.agents),
    prisma.role.findMany({
      where: { team: { teamProjects: { some: { projectId } } } },
      select: {
        id: true,
        name: true,
        roleTemplate: { select: { code: true, label: true } },
        team: { select: { name: true } },
      },
    }),
    buildIntakeContextPrefix(projectId).catch(() => ""),
  ]);

  return { tasks, agents: agentsOut, roles, intakePrefix };
}

async function runStubBoardPlan(projectId: string, env: Env, options?: { includeTodoTasks?: boolean }): Promise<BoardPlanResult> {
  const snapshot = await loadTeamRoutingSnapshot(projectId);
  const { tasks, agents, roles } = await loadPlanningContext(projectId, snapshot.agents, {
    includeTodoTasks: options?.includeTodoTasks,
  });
  if (tasks.length === 0) {
    return {
      usedLlm: false,
      modelLabel: "e2e-stub (no LLM)",
      tasksUpdated: 0,
      tasksCreated: 0,
      phasesReconciled: 0,
    };
  }
  assertHasSeatAgentsForPlanning(tasks.length, agents.length);

  const qaRe = /test|qa|verify|smoke|acceptance/i;
  const hasQa = tasks.some((t) => qaRe.test(t.title) || (t.description && qaRe.test(t.description)));
  const qaRole =
    roles.find((r) => r.roleTemplate?.code?.toLowerCase() === "qa") ??
    roles.find((r) => r.roleTemplate?.label?.toLowerCase().includes("qa"));

  let created = 0;
  let updated = 0;

  await prisma.$transaction(async (tx) => {
    for (let i = 0; i < tasks.length; i++) {
      const t = tasks[i];
      const phase = tasks.length === 1 ? 0 : i === 0 ? 0 : 1;
      const pick = pickBestSeatForTask(t, agents);
      const agent = pick?.agentId ?? null;
      const roleId = pick?.roleId ?? (roles.length ? roles[i % roles.length].id : null);
      await tx.task.update({
        where: { id: t.id },
        data: {
          executionPhase: phase,
          assigneeAgentId: agent,
          ...(roleId ? { targetRoleId: roleId } : {}),
          priority: phase === 0 ? "P0 — foundation" : "P1",
          version: { increment: 1 },
        },
      });
      updated += 1;
    }

    if (!hasQa) {
      const lastPhase = tasks.length === 1 ? 1 : 2;
      const qaPick = pickBestQaSeat(agents);
      const qaAgent = qaPick?.agentId ?? null;
      const qaTarget = qaPick?.roleId ?? qaRole?.id ?? (roles.length ? roles[roles.length - 1].id : null);
      await tx.task.create({
        data: {
          projectId,
          title: "QA: verify vertical slice (smoke)",
          description:
            "Run smoke or manual checks against acceptance criteria so the operator can validate the slice locally.",
          state: "backlog",
          executionPhase: lastPhase,
          priority: "P2 — QA",
          assigneeAgentId: qaAgent,
          ...(qaTarget ? { targetRoleId: qaTarget } : {}),
          version: 1,
        },
      });
      created += 1;
    }
  });

  const reconciled = await reconcilePredecessorPhasesForProject(projectId);
  if (updated > 0 || created > 0 || reconciled.adjustedTaskIds.length > 0) {
    await runDeliveryOrchestrationHook(projectId, env);
  }
  return {
    usedLlm: false,
    modelLabel: "e2e-stub (no LLM)",
    tasksUpdated: updated,
    tasksCreated: created,
    phasesReconciled: reconciled.adjustedTaskIds.length,
  };
}

function buildUserPrompt(
  intakePrefix: string,
  tasks: { id: string; title: string; executionPhase: number; description: string | null; state?: string }[],
  agents: PlanningAgent[],
  roles: { id: string; name: string; roleTemplate: { code: string; label: string } | null; team: { name: string } }[],
  heading: string
): string {
  const taskLines = tasks.map(
    (t) =>
      `- ${t.id} | phase ${t.executionPhase}${t.state ? ` | ${t.state}` : ""} | ${t.title}${
        t.description ? ` — ${t.description.slice(0, 400)}` : ""
      }`
  );
  const agentLines = agents.map((a) => `- ${a.id} | ${a.name}\n  ${a.capabilitySummary}`);
  const roleLines = roles.map(
    (r) =>
      `- ${r.id} | ${r.team.name} · ${r.name}${r.roleTemplate ? ` (${r.roleTemplate.label})` : ""}`
  );

  return [
    intakePrefix ? `## Intake context\n${intakePrefix}\n` : "",
    heading,
    taskLines.join("\n"),
    "\n\n## Agents on linked team seats (assigneeAgentId — only these agent ids are valid)\n",
    "Each line lists the **Sarva role template** and **skills currently linked to that seat**; use them to match task type to capability.\n",
    agentLines.length ? agentLines.join("\n") : "(none — link a team on Intake and assign agents to seats under Organization → Teams)",
    "\n\n## Team roles / seats (targetRoleId)\n",
    roleLines.length ? roleLines.join("\n") : "(none — use null targetRoleId)",
  ]
    .filter(Boolean)
    .join("");
}

export async function runDeliveryBoardPlanning(
  projectId: string,
  env: Env,
  options?: { orchestrationLogger?: OrchestrationLogTarget; includeTodoTasks?: boolean }
): Promise<BoardPlanResult> {
  const deduped = await collapseDuplicateTasksForProject(projectId);
  if (deduped.removedTaskIds.length > 0) {
    await runDeliveryOrchestrationHook(projectId, env);
  }
  if (env.PM_PLAN_BOARD_E2E_STUB === "true") {
    return runStubBoardPlan(projectId, env, options);
  }
  if (env.PM_PLAN_BOARD_USE_LLM !== "true") {
    throw new Error(
      "Board planning requires an LLM. Set PM_PLAN_BOARD_USE_LLM=true and configure SDM/company model bindings, or PM_PLAN_BOARD_E2E_STUB=true only in automated tests."
    );
  }

  const snapshot = await loadTeamRoutingSnapshot(projectId);
  const includeTodoTasks = options?.includeTodoTasks === true;
  const { tasks, agents, roles, intakePrefix } = await loadPlanningContext(projectId, snapshot.agents, {
    includeTodoTasks,
  });
  if (tasks.length === 0) {
    return { usedLlm: false, modelLabel: "(no tasks to plan)", tasksUpdated: 0, tasksCreated: 0, phasesReconciled: 0 };
  }
  assertHasSeatAgentsForPlanning(tasks.length, agents.length);

  const company = await prisma.company.findFirst();
  const companyId = company?.id ?? null;
  if (!companyId) {
    throw new Error("No company record; cannot resolve LLM bindings.");
  }

  const resolution = await resolveWorkflowAgent(projectId, "board_plan", {
    snapshot,
    logger: options?.orchestrationLogger,
  });
  const boardAgentId = resolution.skillMatchAgentId ?? (await resolveDesignLlmAgentId(projectId));
  const preferredRoleId = resolution.skillMatchRoleId ?? null;

  const taskHeading = includeTodoTasks ?
      "## Tasks to plan — backlog **and todo** rows (updates must reference these taskId values; new tasks remain backlog)."
    : "## Backlog tasks (must reference these taskId values).";
  const userPrompt = buildUserPrompt(intakePrefix, tasks, agents, roles, taskHeading);
  const seat = await loadSeatForAgentOnProject(projectId, boardAgentId, {
    preferredRoleId,
  });
  const boardSystemPrompt = composeBoardPlanSystemPromptForSeat(seat);

  let modelLabel = "llm";
  const raw = await withProposeBindingFallback(
    boardAgentId,
    companyId,
    async ({ cred, modelLabel: ml }) => {
      modelLabel = ml;
      return chatBoardPlanJson(userPrompt, cred, env.OPENAI_API_KEY, boardSystemPrompt);
    },
    {
      roleId: preferredRoleId ?? undefined,
      shouldTryNextBinding: isLlmQuotaOrOverloadFailure,
      bindingAudit: { projectId, workflow: "board.plan" },
    },
  );

  const eligibleTaskIds = new Set(tasks.map((t) => t.id));
  const agentSet = new Set(agents.map((a) => a.id));
  const roleSet = new Set(roles.map((r) => r.id));

  let parsed: { updates: NormalizedUpdate[]; newTasks: NormalizedNewTask[] };
  try {
    const json = JSON.parse(stripJsonFence(raw)) as unknown;
    parsed = normalizeBoardPlanJson(json, eligibleTaskIds, agentSet, roleSet);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`Board planner returned invalid JSON: ${msg.slice(0, 400)}`);
  }

  const validUpdates = parsed.updates;
  const rawNewTasks = parsed.newTasks.slice(0, 5);
  const existingTitles = tasks.map((t) => t.title);
  const acceptedNewTitles: string[] = [];
  const newTasks = rawNewTasks.filter((nt) => {
    if (existingTitles.some((et) => areDuplicateTaskTitles(et, nt.title))) return false;
    if (acceptedNewTitles.some((at) => areDuplicateTaskTitles(at, nt.title))) return false;
    acceptedNewTitles.push(nt.title);
    return true;
  });

  if (validUpdates.length === 0 && newTasks.length === 0 && tasks.length > 0) {
    throw new Error(
      "Board planner produced no usable updates: every taskId or agent id from the model was invalid or not in your backlog/catalog. Retry publish, or confirm teams are linked on Intake, role ids appear in the prompt, and assigneeAgentId values are agents seated on those teams."
    );
  }

  let tasksUpdated = 0;
  let tasksCreated = 0;

  await prisma.$transaction(async (tx) => {
    for (const u of validUpdates) {
      const data: Prisma.TaskUncheckedUpdateInput = { version: { increment: 1 } };
      if (u.executionPhase !== undefined) {
        data.executionPhase = Math.min(50, Math.max(0, Math.floor(u.executionPhase)));
      }
      if (u.priority !== undefined && u.priority !== null) {
        data.priority = u.priority;
      }
      if (u.assigneeAgentId !== undefined) {
        const id = u.assigneeAgentId;
        if (id === null || agentSet.has(id)) {
          data.assigneeAgentId = id;
        }
      }
      if (u.targetRoleId !== undefined) {
        const id = u.targetRoleId;
        if (id === null || roleSet.has(id)) {
          data.targetRoleId = id;
        }
      }
      await tx.task.update({ where: { id: u.taskId }, data });
      tasksUpdated += 1;
    }

    for (const nt of newTasks) {
      const phase =
        nt.executionPhase !== undefined ?
          Math.min(50, Math.max(0, Math.floor(nt.executionPhase)))
        : 1;
      const tr = nt.targetRoleId && roleSet.has(nt.targetRoleId) ? nt.targetRoleId : null;
      await tx.task.create({
        data: {
          projectId,
          title: nt.title.slice(0, 500),
          description: nt.description?.slice(0, 20_000) ?? "",
          state: "backlog",
          executionPhase: phase,
          ...(tr ? { targetRoleId: tr } : {}),
          priority: nt.kind === "qa" ? "QA" : null,
          version: 1,
        },
      });
      tasksCreated += 1;
    }
  });

  const reconciled = await reconcilePredecessorPhasesForProject(projectId);
  if (tasksUpdated > 0 || tasksCreated > 0 || reconciled.adjustedTaskIds.length > 0) {
    await runDeliveryOrchestrationHook(projectId, env);
  }

  return {
    usedLlm: true,
    modelLabel,
    tasksUpdated,
    tasksCreated,
    phasesReconciled: reconciled.adjustedTaskIds.length,
  };
}
