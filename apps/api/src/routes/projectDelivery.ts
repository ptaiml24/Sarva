import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import type { Env } from "../config/env.js";
import { prisma } from "../lib/prisma.js";
import { createAuthPreHandler } from "../plugins/auth.js";
import { recordAudit } from "../lib/audit.js";
import { evaluateProjectReadiness, IMPLEMENTATION_STATUS } from "../lib/projectDelivery.js";
import { proposeBacklogFromRequirements, resolveProposeModelLabel } from "../integrations/pmOrchestrator.js";
import { runDeliveryBoardPlanning } from "../integrations/deliveryBoardPlanner.js";
import { loadTeamRoutingSnapshot } from "../lib/deliveryOrchestrationHub.js";
import {
  appendOrchestrationNextRunnableSummary,
  deliveryExecutionStarted,
  deliveryOrchestrationPassSurfacedEffects,
  promoteEligibleAndAutoStartInTx,
  runDeliveryOrchestrationHook,
  runParallelCoderRuns,
  type OrchestrationTelemetryMeta,
} from "../lib/deliveryOrchestration.js";
import { collapseDuplicateTasksForProject } from "../lib/taskDedupe.js";
import { appendProjectChatMessage } from "../lib/projectChat.js";
import { reconcilePredecessorPhasesForProject } from "../lib/planGraphReconcile.js";
import { deliveryPolicyRecord } from "../lib/deliveryPolicy.js";
import {
  automationHandsOffEligibleFromEnv,
  readAutonomousStallCount,
  resetAutonomousStallCount,
  stallsBeforeOperatorHandsOn,
  shouldUseHandsOffBoardUi,
  AUTONOMOUS_STALL_COUNT_KEY,
} from "../lib/deliveryAutonomous.js";
import {
  readWorkspaceDeliveryExtras,
  runWorkspaceInstallAndBuild,
  startWorkspacePreviewServer,
  stopWorkspacePreviewServer,
  type WorkspaceLastBuildRecord,
} from "../lib/workspaceBuildVerify.js";
import { runWorkspaceGitPush } from "../lib/workspaceGitPush.js";
import { publishProjectDevWorkspaceToGithub } from "../lib/githubCompanyPublish.js";

import { findTaskDependencyCyclesForProject } from "../lib/taskDependencyCycles.js";

const PHASE_TASK_STATES = ["backlog", "todo", "in_progress", "review", "done"] as const;
type PhaseTaskState = (typeof PHASE_TASK_STATES)[number];

/** Optional client correlation header for orchestration HTTP kicks (paired with persisted passes / async-job rows). */
function readCorrelationIdFromRequest(request: { headers?: unknown }): string | null {
  const h = request.headers;
  if (!h || typeof h !== "object") return null;
  const raw =
    Reflect.get(h as object, "x-sarva-correlation-id") ??
    Reflect.get(h as object, "X-Sarva-Correlation-Id") ??
    "";
  const text = typeof raw === "string" ? raw.trim() : "";
  return text.length === 0 ? null : text.slice(0, 200);
}

async function buildPhaseProgress(projectId: string) {
  const rows = await prisma.task.findMany({
    where: { projectId },
    select: { id: true, title: true, state: true, executionPhase: true, blockedReason: true },
  });
  const byPhase = new Map<number, {
    phase: number;
    total: number;
    counts: Record<PhaseTaskState, number>;
    blocked: number;
    blockers: { id: string; title: string; state: string; blockedReason: string | null }[];
  }>();

  for (const t of rows) {
    const phase = t.executionPhase ?? 0;
    const s = t.state as PhaseTaskState;
    const cur = byPhase.get(phase) ?? {
      phase,
      total: 0,
      counts: { backlog: 0, todo: 0, in_progress: 0, review: 0, done: 0 },
      blocked: 0,
      blockers: [],
    };
    cur.total += 1;
    if (PHASE_TASK_STATES.includes(s)) cur.counts[s] += 1;
    if (t.blockedReason?.trim()) {
      cur.blocked += 1;
      cur.blockers.push({ id: t.id, title: t.title, state: t.state, blockedReason: t.blockedReason });
    }
    byPhase.set(phase, cur);
  }

  const phases = [...byPhase.values()].sort((a, b) => a.phase - b.phase);
  const current = phases.find((p) => p.counts.done < p.total) ?? phases[phases.length - 1] ?? null;
  const next = current ? phases.find((p) => p.phase > current.phase) ?? null : null;
  const blockersCurrent = current ? rows
    .filter((t) => (t.executionPhase ?? 0) === current.phase && t.state !== "done")
    .map((t) => ({ id: t.id, title: t.title, state: t.state, blockedReason: t.blockedReason })) : [];

  return {
    currentUnlockedPhase: current?.phase ?? 0,
    nextPhase: next?.phase ?? null,
    canUnlockNextPhase: Boolean(next) && blockersCurrent.length === 0,
    blockersCurrentPhase: blockersCurrent.slice(0, 20),
    phases,
  };
}

/** Runs promotion / assign / auto-start / coders then posts a runnable snapshot when nothing visibly moved (explains deps, routing gaps). */
async function runOrchestrationWithIdleRunnableSummary(
  projectId: string,
  env: Env,
  telemetry?: OrchestrationTelemetryMeta
): Promise<{
  promotedTaskIds: string[];
  assignedTaskIds: string[];
  startedTaskIds: string[];
  coderAgentRuns: Awaited<ReturnType<typeof runParallelCoderRuns>>;
}> {
  const orchestration = await runDeliveryOrchestrationHook(projectId, env, telemetry);
  if (!deliveryOrchestrationPassSurfacedEffects(orchestration)) {
    await appendOrchestrationNextRunnableSummary(projectId);
  }
  return orchestration;
}

export function projectDeliveryRoutes(env: Env): FastifyPluginAsync {
  const auth = createAuthPreHandler(env);
  return async (app) => {
    const projectIdParam = z.string().uuid();

    app.get<{ Params: { projectId: string } }>(
      "/api/v1/projects/:projectId/delivery/readiness",
      { preHandler: auth },
      async (request, reply) => {
        const id = projectIdParam.safeParse(request.params.projectId);
        if (!id.success) {
          return reply.status(400).send({ error: { code: "VALIDATION", message: "Invalid project id" } });
        }
        const project = await prisma.project.findUnique({ where: { id: id.data } });
        if (!project) {
          return reply.status(404).send({ error: { code: "NOT_FOUND", message: "project" } });
        }
        const readiness = await evaluateProjectReadiness(id.data);
        return {
          implementationStatus: project.implementationStatus,
          readyForUat: project.readyForUat,
          intakeBaselineAt: project.intakeBaselineAt,
          readiness,
        };
      }
    );

    app.get<{ Params: { projectId: string } }>(
      "/api/v1/projects/:projectId/delivery/summary",
      { preHandler: auth },
      async (request, reply) => {
        const id = projectIdParam.safeParse(request.params.projectId);
        if (!id.success) {
          return reply.status(400).send({ error: { code: "VALIDATION", message: "Invalid project id" } });
        }
        const project = await prisma.project.findUnique({
          where: { id: id.data },
          select: {
            implementationStatus: true,
            readyForUat: true,
            intakeBaselineAt: true,
            backlogFeedbackNotes: true,
            deliveryPolicy: true,
          },
        });
        if (!project) {
          return reply.status(404).send({ error: { code: "NOT_FOUND", message: "project" } });
        }
        const [readiness, draftCount, blockedTasks, proposeModelLabel, phaseProgress, notDoneTasks, companyGh] =
          await Promise.all([
          evaluateProjectReadiness(id.data),
          prisma.proposedBacklogItem.count({ where: { projectId: id.data, status: "draft" } }),
          prisma.task.findMany({
            where: { projectId: id.data, blockedReason: { not: null } },
            select: { id: true, title: true, state: true, blockedReason: true, escalationStrikes: true },
            take: 50,
          }),
          resolveProposeModelLabel(id.data, { logger: request.log }),
          buildPhaseProgress(id.data),
          prisma.task.count({ where: { projectId: id.data, state: { not: "done" } } }),
          prisma.company.findFirst({
            select: { githubPat: true, githubOwnerLogin: true },
          }),
        ]);

        const allTasksDone = notDoneTasks === 0;
        const automationHandsOffEnvConfigured = automationHandsOffEligibleFromEnv(env);
        const autonomousStallCount = readAutonomousStallCount(project.deliveryPolicy);
        const stallThreshold = stallsBeforeOperatorHandsOn(env);
        const autonomousOperatorRequired = autonomousStallCount >= stallThreshold;
        const boardHandsOffMinimalControls = shouldUseHandsOffBoardUi(project.deliveryPolicy, env, allTasksDone);

        const githubCompanyPublishConfigured = Boolean(
          companyGh?.githubPat?.trim() && companyGh?.githubOwnerLogin?.trim()
        );

        const workspaceDelivery = readWorkspaceDeliveryExtras(project.deliveryPolicy);

        return {
          ...project,
          readiness,
          draftProposals: draftCount,
          blockedTasks,
          proposeModelLabel,
          phaseProgress,
          allTasksDone,
          /** Mirrors `executionKickoffAt` on `deliveryPolicy` — false until Begin execution. */
          deliveryExecutionStarted: deliveryExecutionStarted(project.deliveryPolicy),
          autonomousStallCount,
          stallThresholdForOperatorHandsOn: stallThreshold,
          automationHandsOffEnvConfigured,
          autonomousOperatorRequired,
          boardHandsOffMinimalControls,
          workspaceGitPushEnabled: env.SARVA_WORKSPACE_GIT_PUSH === "true",
          githubCompanyPublishConfigured,
          ...workspaceDelivery,
        };
      }
    );

    const takeClamp = z.coerce.number().int().min(1).max(200);

    app.get<{ Params: { projectId: string }; Querystring: { take?: unknown } }>(
      "/api/v1/projects/:projectId/delivery/orchestration-passes",
      { preHandler: auth },
      async (request, reply) => {
        const id = projectIdParam.safeParse(request.params.projectId);
        if (!id.success) {
          return reply.status(400).send({ error: { code: "VALIDATION", message: "Invalid project id" } });
        }
        const project = await prisma.project.findUnique({ where: { id: id.data } });
        if (!project) {
          return reply.status(404).send({ error: { code: "NOT_FOUND", message: "project" } });
        }
        const takeParse = takeClamp.safeParse((request.query as { take?: unknown })?.take);
        const take = takeParse.success ? takeParse.data : 50;

        const rows = await prisma.deliveryOrchestrationPass.findMany({
          where: { projectId: id.data },
          orderBy: { createdAt: "desc" },
          take,
        });

        return {
          items: rows.map((r) => ({
            id: r.id,
            createdAt: r.createdAt.toISOString(),
            promotedCount: r.promotedCount,
            assignedCount: r.assignedCount,
            startedCount: r.startedCount,
            coderRunsCount: r.coderRunsCount,
            coderSubmittedCount: r.coderSubmittedCount,
            surfacedEffects: r.surfacedEffects,
            source: r.source,
            correlationId: r.correlationId,
            partialErrors: r.partialErrors,
          })),
        };
      },
    );

    app.get<{ Params: { projectId: string }; Querystring: { take?: unknown } }>(
      "/api/v1/projects/:projectId/delivery/async-jobs",
      { preHandler: auth },
      async (request, reply) => {
        const id = projectIdParam.safeParse(request.params.projectId);
        if (!id.success) {
          return reply.status(400).send({ error: { code: "VALIDATION", message: "Invalid project id" } });
        }
        const project = await prisma.project.findUnique({ where: { id: id.data } });
        if (!project) {
          return reply.status(404).send({ error: { code: "NOT_FOUND", message: "project" } });
        }
        const takeParse = takeClamp.safeParse((request.query as { take?: unknown })?.take);
        const take = takeParse.success ? takeParse.data : 50;

        const rows = await prisma.deliveryAsyncJob.findMany({
          where: { projectId: id.data },
          orderBy: { startedAt: "desc" },
          take,
        });

        return {
          items: rows.map((r) => ({
            id: r.id,
            kind: r.kind,
            status: r.status,
            correlationId: r.correlationId,
            startedAt: r.startedAt.toISOString(),
            finishedAt: r.finishedAt?.toISOString() ?? null,
            error: r.error,
            result: r.result,
          })),
        };
      },
    );

    app.get<{ Params: { projectId: string } }>(
      "/api/v1/projects/:projectId/delivery/dag-health",
      { preHandler: auth },
      async (request, reply) => {
        const id = projectIdParam.safeParse(request.params.projectId);
        if (!id.success) {
          return reply.status(400).send({ error: { code: "VALIDATION", message: "Invalid project id" } });
        }
        const project = await prisma.project.findUnique({ where: { id: id.data } });
        if (!project) {
          return reply.status(404).send({ error: { code: "NOT_FOUND", message: "project" } });
        }

        const [edgeCount, taskCount, cycles] = await Promise.all([
          prisma.taskDependency.count({
            where: { successor: { projectId: id.data } },
          }),
          prisma.task.count({ where: { projectId: id.data } }),
          findTaskDependencyCyclesForProject(id.data),
        ]);

        const maxCyclesReturned = 20;
        const limited = cycles.slice(0, maxCyclesReturned);

        return {
          projectId: id.data,
          dependencyEdgeCount: edgeCount,
          taskCount,
          hasDirectedCycle: cycles.length > 0,
          cycleCountTotal: cycles.length,
          cycles: limited,
        };
      },
    );

    app.get<{ Params: { projectId: string }; Querystring: { take?: unknown } }>(
      "/api/v1/projects/:projectId/delivery/binding-log",
      { preHandler: auth },
      async (request, reply) => {
        const id = projectIdParam.safeParse(request.params.projectId);
        if (!id.success) {
          return reply.status(400).send({ error: { code: "VALIDATION", message: "Invalid project id" } });
        }
        const project = await prisma.project.findUnique({ where: { id: id.data } });
        if (!project) {
          return reply.status(404).send({ error: { code: "NOT_FOUND", message: "project" } });
        }
        const takeParse = takeClamp.safeParse((request.query as { take?: unknown })?.take);
        const take = takeParse.success ? takeParse.data : 50;

        const rows = await prisma.orchestrationBindingAttempt.findMany({
          where: { projectId: id.data },
          orderBy: { createdAt: "desc" },
          take,
        });

        return {
          items: rows.map((r) => ({
            id: r.id,
            createdAt: r.createdAt.toISOString(),
            workflow: r.workflow,
            bindingId: r.bindingId,
            provider: r.provider,
            modelId: r.modelId,
            modelLabel: r.modelLabel,
            scopeHint: r.scopeHint,
            success: r.success,
          })),
        };
      },
    );

    app.post<{ Params: { projectId: string } }>(
      "/api/v1/projects/:projectId/delivery/workspace-verify-build",
      { preHandler: auth },
      async (request, reply) => {
        const id = projectIdParam.safeParse(request.params.projectId);
        if (!id.success) {
          return reply.status(400).send({ error: { code: "VALIDATION", message: "Invalid project id" } });
        }
        const project = await prisma.project.findUnique({ where: { id: id.data } });
        if (!project) {
          return reply.status(404).send({ error: { code: "NOT_FOUND", message: "project" } });
        }
        const actorId = request.auth?.sub;
        if (actorId) {
          await recordAudit(actorId, "project.delivery.workspace_verify_build", `project:${id.data}`);
        }
        const result = await runWorkspaceInstallAndBuild(id.data, env, {
          trigger: "manual",
          onBeforeLongRunningWork: async () => {
            await appendProjectChatMessage({
              projectId: id.data,
              actorKind: "orchestrator",
              actorLabel: "Orchestrator",
              body:
                "**Manual verify build** started — running `npm install` (if needed) and `npm run build` on the API host. Large installs can take several minutes; leave the API process running.",
              meta: { event: "delivery.workspace_verify_build_started", trigger: "manual" },
            });
          },
        });

        if ("skippedReason" in result && result.skippedReason) {
          await appendProjectChatMessage({
            projectId: id.data,
            actorKind: "orchestrator",
            actorLabel: "Orchestrator",
            body: `**Manual verify build** did not run: ${result.skippedReason.replace(/_/g, " ")}.`,
            meta: {
              event: "delivery.workspace_verify_build_skipped",
              reason: result.skippedReason,
              trigger: "manual",
            },
          });
          return reply.status(409).send({
            error: {
              code: "WORKSPACE_VERIFY_SKIPPED",
              message: result.skippedReason,
            },
            skippedReason: result.skippedReason,
          });
        }

        if (result.ok) {
          await appendProjectChatMessage({
            projectId: id.data,
            actorKind: "orchestrator",
            actorLabel: "Orchestrator",
            body: `**Manual verify build** finished: **passed** (\`${result.commandSummary}\`, exit 0).`,
            meta: { event: "delivery.workspace_verify_build_ok", trigger: "manual" },
          });
        } else {
          const failed = result as WorkspaceLastBuildRecord;
          await appendProjectChatMessage({
            projectId: id.data,
            actorKind: "orchestrator",
            actorLabel: "Orchestrator",
            body: `**Manual verify build** finished: **failed** (exit ${failed.exitCode}). Fix the workspace and retry, or inspect stderr in message metadata.`,
            meta: {
              event: "delivery.workspace_verify_build_failed",
              exitCode: failed.exitCode,
              stderrTail: failed.stderrTail,
              trigger: "manual",
            },
          });
        }

        return { build: result };
      }
    );

    app.post<{ Params: { projectId: string } }>(
      "/api/v1/projects/:projectId/delivery/workspace-preview-start",
      { preHandler: auth },
      async (request, reply) => {
        const id = projectIdParam.safeParse(request.params.projectId);
        if (!id.success) {
          return reply.status(400).send({ error: { code: "VALIDATION", message: "Invalid project id" } });
        }
        const project = await prisma.project.findUnique({ where: { id: id.data } });
        if (!project) {
          return reply.status(404).send({ error: { code: "NOT_FOUND", message: "project" } });
        }
        const r = await startWorkspacePreviewServer(id.data, env);
        if (!r.ok) {
          return reply.status(400).send({ error: { code: "PREVIEW_START_FAILED", message: r.message } });
        }
        const actorId = request.auth?.sub;
        if (actorId) {
          await recordAudit(actorId, "project.delivery.workspace_preview_start", `project:${id.data}`);
        }
        await appendProjectChatMessage({
          projectId: id.data,
          actorKind: "orchestrator",
          actorLabel: "Orchestrator",
          body: `**Preview server** (${r.preview.command}) — open **${r.preview.url}** on the API host.`,
          meta: { event: "delivery.workspace_preview_start", ...r.preview },
        });
        return r;
      }
    );

    app.post<{ Params: { projectId: string } }>(
      "/api/v1/projects/:projectId/delivery/workspace-preview-stop",
      { preHandler: auth },
      async (request, reply) => {
        const id = projectIdParam.safeParse(request.params.projectId);
        if (!id.success) {
          return reply.status(400).send({ error: { code: "VALIDATION", message: "Invalid project id" } });
        }
        const project = await prisma.project.findUnique({ where: { id: id.data } });
        if (!project) {
          return reply.status(404).send({ error: { code: "NOT_FOUND", message: "project" } });
        }
        const r = await stopWorkspacePreviewServer(id.data);
        const actorId = request.auth?.sub;
        if (actorId) {
          await recordAudit(actorId, "project.delivery.workspace_preview_stop", `project:${id.data}`);
        }
        if (!r.ok) {
          return reply.status(409).send({ error: { code: "PREVIEW_STOP_FAILED", message: r.message } });
        }
        return r;
      }
    );

    app.post<{ Params: { projectId: string }; Body: { message?: string } }>(
      "/api/v1/projects/:projectId/delivery/workspace-git-push",
      { preHandler: auth },
      async (request, reply) => {
        const id = projectIdParam.safeParse(request.params.projectId);
        if (!id.success) {
          return reply.status(400).send({ error: { code: "VALIDATION", message: "Invalid project id" } });
        }
        const body = z.object({ message: z.string().max(500).optional() }).safeParse(request.body ?? {});
        if (!body.success) {
          return reply.status(400).send({ error: { code: "VALIDATION", message: body.error.message } });
        }
        const project = await prisma.project.findUnique({ where: { id: id.data } });
        if (!project) {
          return reply.status(404).send({ error: { code: "NOT_FOUND", message: "project" } });
        }
        const actorId = request.auth?.sub;
        if (actorId) {
          await recordAudit(actorId, "project.delivery.workspace_git_push", `project:${id.data}`);
        }
        const r = await runWorkspaceGitPush(id.data, env, { commitMessage: body.data.message });
        if (!r.ok) {
          const status =
            r.code === "GIT_PUSH_DISABLED" ? 403
            : r.code === "NO_WORKSPACE" || r.code === "NOT_A_GIT_REPO" || r.code === "NO_ORIGIN" || r.code === "DETACHED_HEAD" ?
              409
            : 400;
          return reply.status(status).send({
            error: { code: r.code, message: r.message },
            detail: r.detail,
          });
        }
        await appendProjectChatMessage({
          projectId: id.data,
          actorKind: "orchestrator",
          actorLabel: "Orchestrator",
          body: `**Git push** completed on branch \`${r.branch}\` (${r.outcome}). ${r.detail.slice(0, 500)}`,
          meta: { event: "delivery.workspace_git_push_ok", branch: r.branch, outcome: r.outcome },
        });
        return r;
      }
    );

    app.post<{ Params: { projectId: string }; Body: { isPublic?: boolean; repoName?: string } }>(
      "/api/v1/projects/:projectId/delivery/github-publish",
      { preHandler: auth },
      async (request, reply) => {
        const id = projectIdParam.safeParse(request.params.projectId);
        if (!id.success) {
          return reply.status(400).send({ error: { code: "VALIDATION", message: "Invalid project id" } });
        }
        const body = z
          .object({
            isPublic: z.boolean().optional(),
            repoName: z.string().max(120).optional(),
          })
          .safeParse(request.body ?? {});
        if (!body.success) {
          return reply.status(400).send({ error: { code: "VALIDATION", message: body.error.message } });
        }
        const project = await prisma.project.findUnique({ where: { id: id.data } });
        if (!project) {
          return reply.status(404).send({ error: { code: "NOT_FOUND", message: "project" } });
        }
        const actorId = request.auth?.sub;
        if (actorId) {
          await recordAudit(actorId, "project.delivery.github_publish", `project:${id.data}`);
        }
        const r = await publishProjectDevWorkspaceToGithub(id.data, env, {
          isPublic: body.data.isPublic,
          repoNameOverride: body.data.repoName,
        });
        if (!r.ok) {
          const st =
            r.code === "NOT_FOUND" ? 404
            : r.code === "NO_WORKSPACE" || r.code === "GIT_ORIGIN_EXISTS" ? 409
            : r.code === "GITHUB_API_ERROR" ? 502
            : 400;
          return reply.status(st).send({ error: { code: r.code, message: r.message }, detail: r.detail });
        }
        await appendProjectChatMessage({
          projectId: id.data,
          actorKind: "orchestrator",
          actorLabel: "Orchestrator",
          body: `**GitHub:** created repository and pushed from the dev workspace — ${r.htmlUrl} · clone: \`${r.cloneUrl}\`. Intake clone URL was updated.`,
          meta: { event: "delivery.github_publish_ok", htmlUrl: r.htmlUrl, cloneUrl: r.cloneUrl, repoName: r.repoName },
        });
        return r;
      }
    );

    /** Collapse backlog/todo rows that look like duplicates (similar titles); keeps the task with more description text. */
    app.post<{ Params: { projectId: string } }>(
      "/api/v1/projects/:projectId/delivery/dedupe-tasks",
      { preHandler: auth },
      async (request, reply) => {
        const id = projectIdParam.safeParse(request.params.projectId);
        if (!id.success) {
          return reply.status(400).send({ error: { code: "VALIDATION", message: "Invalid project id" } });
        }
        const project = await prisma.project.findUnique({ where: { id: id.data } });
        if (!project) {
          return reply.status(404).send({ error: { code: "NOT_FOUND", message: "project" } });
        }
        const actorId = request.auth?.sub;
        if (!actorId) {
          return reply.status(401).send({ error: { code: "UNAUTHORIZED", message: "Not authenticated" } });
        }
        const result = await collapseDuplicateTasksForProject(id.data);
        if (result.removedTaskIds.length > 0) {
          await recordAudit(actorId, "project.tasks.dedupe", `project:${id.data}:removed:${result.removedTaskIds.length}`);
          await runDeliveryOrchestrationHook(id.data, env);
        }
        return result;
      }
    );

    app.post<{ Params: { projectId: string } }>(
      "/api/v1/projects/:projectId/delivery/resume-hands-off-automation",
      { preHandler: auth },
      async (request, reply) => {
        const id = projectIdParam.safeParse(request.params.projectId);
        if (!id.success) {
          return reply.status(400).send({ error: { code: "VALIDATION", message: "Invalid project id" } });
        }
        const project = await prisma.project.findUnique({ where: { id: id.data } });
        if (!project) {
          return reply.status(404).send({ error: { code: "NOT_FOUND", message: "project" } });
        }
        const pol = deliveryPolicyRecord(project.deliveryPolicy);
        if (typeof pol.executionKickoffAt !== "string") {
          return reply.status(409).send({
            error: { code: "INVALID_STATE", message: "Begin execution must run before resuming the stall counter." },
          });
        }
        await resetAutonomousStallCount(id.data);
        await appendProjectChatMessage({
          projectId: id.data,
          actorKind: "orchestrator",
          actorLabel: "Orchestrator",
          body:
            "**Autonomous stall counter reset.** Hands-off board mode applies again until repeated automation stalls cross the configured threshold. Running a delivery orchestration pass now (eligible backlog promotion, assigning unassigned todos, auto-start where gates allow, then coder runs).",
          meta: { event: "delivery.autonomous.stalls_reset_by_operator" },
        });
        const actorId = request.auth?.sub;
        if (actorId) {
          await recordAudit(actorId, "project.delivery.resume_hands_off", `project:${id.data}`);
        }
        const orchestration = await runOrchestrationWithIdleRunnableSummary(id.data, env, {
          source: "http_resume_hands_off",
          correlationId: readCorrelationIdFromRequest(request),
        });

        const updated = await prisma.project.findUniqueOrThrow({ where: { id: id.data } });
        return {
          ok: true as const,
          project: updated,
          movedToTodo: orchestration.promotedTaskIds.length,
          autoAssigned: orchestration.assignedTaskIds.length,
          autoStarted: orchestration.startedTaskIds.length,
          coderAgentRuns: orchestration.coderAgentRuns,
        };
      }
    );

    /**
     * Idempotent delivery engine tick after kickoff — same work as lifecycle hooks (promote backlog, assign todos,
     * auto-start gated rows, run coders). Use when tasks sit on **todo** and no event fired the orchestrator lately
     * (hands-off hides manual **Start work** until stall threshold).
     */
    app.post<{ Params: { projectId: string } }>(
      "/api/v1/projects/:projectId/delivery/run-orchestration",
      { preHandler: auth },
      async (request, reply) => {
        const id = projectIdParam.safeParse(request.params.projectId);
        if (!id.success) {
          return reply.status(400).send({ error: { code: "VALIDATION", message: "Invalid project id" } });
        }
        const project = await prisma.project.findUnique({ where: { id: id.data } });
        if (!project) {
          return reply.status(404).send({ error: { code: "NOT_FOUND", message: "project" } });
        }
        if (!deliveryExecutionStarted(project.deliveryPolicy)) {
          return reply.status(409).send({
            error: {
              code: "INVALID_STATE",
              message: "Begin execution must run before the orchestrator can drive this board.",
            },
          });
        }
        const orchestration = await runOrchestrationWithIdleRunnableSummary(id.data, env, {
          source: "http_run_orchestration",
          correlationId: readCorrelationIdFromRequest(request),
        });
        const actorId = request.auth?.sub;
        if (actorId) {
          await recordAudit(actorId, "project.delivery.run_orchestration", `project:${id.data}`);
        }
        const updated = await prisma.project.findUniqueOrThrow({ where: { id: id.data } });
        return {
          ok: true as const,
          project: updated,
          movedToTodo: orchestration.promotedTaskIds.length,
          autoAssigned: orchestration.assignedTaskIds.length,
          autoStarted: orchestration.startedTaskIds.length,
          coderAgentRuns: orchestration.coderAgentRuns,
        };
      }
    );

    app.post<{ Params: { projectId: string } }>(
      "/api/v1/projects/:projectId/delivery/proceed",
      { preHandler: auth },
      async (request, reply) => {
        const id = projectIdParam.safeParse(request.params.projectId);
        if (!id.success) {
          return reply.status(400).send({ error: { code: "VALIDATION", message: "Invalid project id" } });
        }
        const project = await prisma.project.findUnique({ where: { id: id.data } });
        if (!project) {
          return reply.status(404).send({ error: { code: "NOT_FOUND", message: "project" } });
        }
        if (
          project.implementationStatus !== IMPLEMENTATION_STATUS.DRAFT &&
          project.implementationStatus !== IMPLEMENTATION_STATUS.DELIVERY_ACTIVE
        ) {
          return reply.status(409).send({
            error: {
              code: "INVALID_STATE",
              message: `Proceed only from draft or when already delivery_active. Current: ${project.implementationStatus}`,
            },
          });
        }
        const readiness = await evaluateProjectReadiness(id.data);
        if (!readiness.ok) {
          return reply.status(400).send({
            error: { code: "NOT_READY", message: "Preconditions not met", checks: readiness.checks },
          });
        }
        if (project.implementationStatus === IMPLEMENTATION_STATUS.DELIVERY_ACTIVE) {
          return { project, idempotent: true as const };
        }
        const actorId = request.auth?.sub;
        const updated = await prisma.project.update({
          where: { id: id.data },
          data: {
            implementationStatus: IMPLEMENTATION_STATUS.DELIVERY_ACTIVE,
            intakeBaselineAt: new Date(),
          },
        });
        if (actorId) {
          await recordAudit(actorId, "project.delivery.proceed", `project:${id.data}`);
        }
        return { project: updated };
      }
    );

    app.post<{ Params: { projectId: string } }>(
      "/api/v1/projects/:projectId/delivery/pm-propose-intake",
      { preHandler: auth },
      async (request, reply) => {
        const id = projectIdParam.safeParse(request.params.projectId);
        if (!id.success) {
          return reply.status(400).send({ error: { code: "VALIDATION", message: "Invalid project id" } });
        }
        const body = z.object({}).passthrough().safeParse(request.body);
        if (!body.success) {
          return reply.status(400).send({ error: { code: "VALIDATION", message: body.error.message } });
        }
        const project = await prisma.project.findUnique({
          where: { id: id.data },
          include: { context: true },
        });
        if (!project) {
          return reply.status(404).send({ error: { code: "NOT_FOUND", message: "project" } });
        }
        if (
          project.implementationStatus !== IMPLEMENTATION_STATUS.DELIVERY_ACTIVE &&
          project.implementationStatus !== IMPLEMENTATION_STATUS.BACKLOG_PROPOSED
        ) {
          return reply.status(409).send({
            error: {
              code: "INVALID_STATE",
              message: `Run PM propose from delivery_active (click Proceed first). Current: ${project.implementationStatus}`,
            },
          });
        }
        const goals = project.context?.goals?.trim() ?? "";
        const brief = project.context?.brief?.trim() ?? "";
        const requirementsText = [goals && `Goals:\n${goals}`, brief && `Brief:\n${brief}`].filter(Boolean).join("\n\n");
        if (!requirementsText.trim()) {
          return reply.status(400).send({
            error: { code: "VALIDATION", message: "Intake must include goals and/or brief before PM propose" },
          });
        }
        try {
          const result = await proposeBacklogFromRequirements(id.data, { requirementsText }, env, {
            orchestrationLogger: request.log,
          });
          const updated = await prisma.project.update({
            where: { id: id.data },
            data: { implementationStatus: IMPLEMENTATION_STATUS.BACKLOG_PROPOSED },
          });
          const actorId = request.auth?.sub;
          if (actorId) {
            await recordAudit(actorId, "project.delivery.pm_propose_intake", `project:${id.data}`);
          }
          return {
            proposed: result.proposed,
            usedLlm: result.usedLlm,
            modelLabel: result.modelLabel,
            project: updated,
          };
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          return reply.status(400).send({ error: { code: "PROPOSE_FAILED", message: msg } });
        }
      }
    );

    app.post<{ Params: { projectId: string } }>(
      "/api/v1/projects/:projectId/delivery/approve-backlog",
      { preHandler: auth },
      async (request, reply) => {
        const id = projectIdParam.safeParse(request.params.projectId);
        if (!id.success) {
          return reply.status(400).send({ error: { code: "VALIDATION", message: "Invalid project id" } });
        }
        const project = await prisma.project.findUnique({ where: { id: id.data } });
        if (!project) {
          return reply.status(404).send({ error: { code: "NOT_FOUND", message: "project" } });
        }
        if (project.implementationStatus !== IMPLEMENTATION_STATUS.BACKLOG_PROPOSED) {
          return reply.status(409).send({
            error: {
              code: "INVALID_STATE",
              message: `Approve backlog only from backlog_proposed. Current: ${project.implementationStatus}`,
            },
          });
        }
        const drafts = await prisma.proposedBacklogItem.findMany({
          where: { projectId: id.data, status: "draft" },
          orderBy: { id: "asc" },
        });
        if (drafts.length === 0) {
          return reply.status(400).send({
            error: { code: "NO_DRAFTS", message: "No draft proposed items to accept" },
          });
        }
        const actorId = request.auth?.sub;
        const tasks = await prisma.$transaction(async (tx) => {
          const created: { id: string; title: string }[] = [];
          for (const proposed of drafts) {
            const payload = proposed.payload as { title?: string; description?: string; phase?: number };
            const phase =
              typeof payload.phase === "number" && Number.isFinite(payload.phase) ?
                Math.min(30, Math.max(0, Math.floor(payload.phase)))
              : 0;
            await tx.proposedBacklogItem.update({
              where: { id: proposed.id },
              data: { status: "accepted" },
            });
            const task = await tx.task.create({
              data: {
                projectId: proposed.projectId,
                title: payload.title ?? "Untitled",
                description: payload.description ?? "",
                state: "backlog",
                executionPhase: phase,
                version: 1,
              },
            });
            created.push({ id: task.id, title: task.title });
          }
          await tx.project.update({
            where: { id: id.data },
            data: { implementationStatus: IMPLEMENTATION_STATUS.BACKLOG_APPROVED },
          });
          return created;
        });
        if (actorId) {
          await recordAudit(actorId, "project.delivery.approve_backlog", `project:${id.data}`);
        }
        return { tasksAccepted: tasks.length, tasks };
      }
    );

    app.post<{ Params: { projectId: string } }>(
      "/api/v1/projects/:projectId/delivery/plan-assignments",
      { preHandler: auth },
      async (request, reply) => {
        const id = projectIdParam.safeParse(request.params.projectId);
        if (!id.success) {
          return reply.status(400).send({ error: { code: "VALIDATION", message: "Invalid project id" } });
        }
        const project = await prisma.project.findUnique({ where: { id: id.data } });
        if (!project) {
          return reply.status(404).send({ error: { code: "NOT_FOUND", message: "project" } });
        }
        const st = project.implementationStatus;
        const stOkForAiPlan =
          st === IMPLEMENTATION_STATUS.BACKLOG_APPROVED ||
          st === IMPLEMENTATION_STATUS.BACKLOG_PROPOSED ||
          st === IMPLEMENTATION_STATUS.EXECUTING;
        if (!stOkForAiPlan) {
          return reply.status(409).send({
            error: {
              code: "INVALID_STATE",
              message: `AI assignment needs backlog work in progress (e.g. backlog_proposed or backlog_approved). Current: ${st}`,
            },
          });
        }
        const policy = deliveryPolicyRecord(project.deliveryPolicy);
        if (typeof policy.executionKickoffAt === "string") {
          return reply.status(409).send({
            error: {
              code: "INVALID_STATE",
              message: "Execution has already started; task assignments are frozen.",
            },
          });
        }
        const approvedDesign = await prisma.designArtifact.findFirst({
          where: { projectId: id.data, status: "approved" },
        });
        if (!approvedDesign) {
          return reply.status(400).send({
            error: {
              code: "NO_APPROVED_DESIGN",
              message: "Approve a design artifact on the Design tab before running the assignment planner.",
            },
          });
        }
        const collapsedPlan = await collapseDuplicateTasksForProject(id.data);
        if (collapsedPlan.removedTaskIds.length > 0) {
          await runDeliveryOrchestrationHook(id.data, env);
        }
        const backlogCount = await prisma.task.count({ where: { projectId: id.data, state: "backlog" } });
        if (backlogCount === 0) {
          return reply.status(400).send({
            error: { code: "NO_BACKLOG", message: "No backlog tasks to assign." },
          });
        }
        let planning: Awaited<ReturnType<typeof runDeliveryBoardPlanning>>;
        try {
          planning = await runDeliveryBoardPlanning(id.data, env, { orchestrationLogger: request.log });
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          return reply.status(400).send({ error: { code: "PLAN_FAILED", message: msg } });
        }
        policy.lastAssignmentPlanAt = new Date().toISOString();
        await prisma.project.update({
          where: { id: id.data },
          data: { deliveryPolicy: policy as object },
        });
        const actorId = request.auth?.sub;
        if (actorId) {
          await recordAudit(actorId, "project.delivery.plan_assignments", `project:${id.data}`);
        }
        return { planning };
      }
    );

    app.post<{ Params: { projectId: string } }>(
      "/api/v1/projects/:projectId/delivery/publish-and-plan-board",
      { preHandler: auth },
      async (request, reply) => {
        const id = projectIdParam.safeParse(request.params.projectId);
        if (!id.success) {
          return reply.status(400).send({ error: { code: "VALIDATION", message: "Invalid project id" } });
        }
        const project = await prisma.project.findUnique({ where: { id: id.data } });
        if (!project) {
          return reply.status(404).send({ error: { code: "NOT_FOUND", message: "project" } });
        }
        const policy = deliveryPolicyRecord(project.deliveryPolicy);
        if (typeof policy.executionKickoffAt === "string") {
          return reply.status(409).send({
            error: {
              code: "INVALID_STATE",
              message: "Execution has already started; board planning is frozen.",
            },
          });
        }
        const st = project.implementationStatus;
        if (st !== IMPLEMENTATION_STATUS.BACKLOG_APPROVED && st !== IMPLEMENTATION_STATUS.EXECUTING) {
          return reply.status(409).send({
            error: {
              code: "INVALID_STATE",
              message: `Publish & plan requires backlog_approved or executing (before kickoff). Current: ${st}`,
            },
          });
        }
        const approvedDesign = await prisma.designArtifact.findFirst({
          where: { projectId: id.data, status: "approved" },
        });
        if (!approvedDesign) {
          return reply.status(400).send({
            error: {
              code: "NO_APPROVED_DESIGN",
              message: "Approve a design artifact on the Design tab before publishing the board.",
            },
          });
        }
        const collapsedPub = await collapseDuplicateTasksForProject(id.data);
        if (collapsedPub.removedTaskIds.length > 0) {
          await runDeliveryOrchestrationHook(id.data, env);
        }
        const backlogCount = await prisma.task.count({ where: { projectId: id.data, state: "backlog" } });
        if (backlogCount === 0) {
          return reply.status(400).send({
            error: { code: "NO_BACKLOG", message: "No backlog tasks to plan." },
          });
        }
        let planning: Awaited<ReturnType<typeof runDeliveryBoardPlanning>> | { skipped: true; reason: string };
        try {
          if (typeof policy.lastAssignmentPlanAt === "string") {
            planning = { skipped: true, reason: "reuse_recent_ai_plan" };
          } else {
            planning = await runDeliveryBoardPlanning(id.data, env, { orchestrationLogger: request.log });
            policy.lastAssignmentPlanAt = new Date().toISOString();
          }
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          return reply.status(400).send({ error: { code: "PLAN_FAILED", message: msg } });
        }
        policy.boardPlannedAt = new Date().toISOString();
        const updated = await prisma.project.update({
          where: { id: id.data },
          data: {
            implementationStatus: IMPLEMENTATION_STATUS.EXECUTING,
            deliveryPolicy: policy as object,
          },
        });
        const actorId = request.auth?.sub;
        if (actorId) {
          await recordAudit(actorId, "project.delivery.publish_plan_board", `project:${id.data}`);
        }
        return { project: updated, planning };
      }
    );

    app.post<{ Params: { projectId: string } }>(
      "/api/v1/projects/:projectId/delivery/begin-execution",
      { preHandler: auth },
      async (request, reply) => {
        const id = projectIdParam.safeParse(request.params.projectId);
        if (!id.success) {
          return reply.status(400).send({ error: { code: "VALIDATION", message: "Invalid project id" } });
        }
        const project = await prisma.project.findUnique({ where: { id: id.data } });
        if (!project) {
          return reply.status(404).send({ error: { code: "NOT_FOUND", message: "project" } });
        }
        const policy = deliveryPolicyRecord(project.deliveryPolicy);
        if (typeof policy.executionKickoffAt === "string") {
          return { project, idempotent: true as const, movedToTodo: 0, autoStarted: 0, autoAssigned: 0 };
        }
        if (typeof policy.boardPlannedAt !== "string") {
          return reply.status(409).send({
            error: {
              code: "INVALID_STATE",
              message: "Run Publish board from Plan first so the SDM can plan phases and assignments.",
            },
          });
        }
        if (project.implementationStatus !== IMPLEMENTATION_STATUS.EXECUTING) {
          return reply.status(409).send({
            error: {
              code: "INVALID_STATE",
              message: `Begin execution expects implementationStatus executing. Current: ${project.implementationStatus}`,
            },
          });
        }

        const routing = await loadTeamRoutingSnapshot(id.data);
        const actorId = request.auth?.sub;
        const { movedToTodo, autoStarted, autoAssigned, startedTaskIds, promotedTaskIds, assignedTaskIds } =
          await prisma.$transaction(async (tx) => {
            const { promotedTaskIds: promoted, assignedTaskIds: assigned, startedTaskIds: started } =
              await promoteEligibleAndAutoStartInTx(tx, id.data, { routingAgents: routing.agents });
            policy.executionKickoffAt = new Date().toISOString();
            delete policy[AUTONOMOUS_STALL_COUNT_KEY];
            await tx.project.update({
              where: { id: id.data },
              data: { deliveryPolicy: policy as object },
            });
            if (actorId) {
              await tx.auditEvent.create({
                data: {
                  actorId,
                  action: "project.delivery.begin_execution",
                  resourceRef: `project:${id.data}`,
                  payloadHash: null,
                },
              });
            }
            return {
              movedToTodo: promoted.length,
              autoStarted: started.length,
              autoAssigned: assigned.length,
              startedTaskIds: started,
              promotedTaskIds: promoted,
              assignedTaskIds: assigned,
            };
          });

        if (assignedTaskIds.length > 0) {
          await appendProjectChatMessage({
            projectId: id.data,
            actorKind: "orchestrator",
            actorLabel: "Orchestrator",
            body: `Begin execution: orchestration assigned **${assignedTaskIds.length}** todo row(s) missing an assignee.`,
            meta: { event: "delivery.begin_execution.auto_assign", taskIds: assignedTaskIds },
          });
        }

        if (promotedTaskIds.length > 0) {
          const phases = await prisma.task.findMany({
            where: { id: { in: promotedTaskIds } },
            select: { executionPhase: true },
          });
          const minPhase = Math.min(...phases.map((p) => p.executionPhase ?? 0));
          await appendProjectChatMessage({
            projectId: id.data,
            actorKind: "orchestrator",
            actorLabel: "Orchestrator",
            body: `Begin execution: unlocked phase **${minPhase}** — **${promotedTaskIds.length}** task(s) moved from backlog to todo (phase-by-phase).`,
            meta: { event: "delivery.begin_execution.promote", taskIds: promotedTaskIds, minPhase },
          });
        }

        const coderAgentRuns =
          startedTaskIds.length > 0 ? await runParallelCoderRuns(startedTaskIds, env) : [];

        const refreshed = await prisma.project.findUniqueOrThrow({ where: { id: id.data } });
        return { project: refreshed, movedToTodo, autoStarted, autoAssigned, coderAgentRuns };
      }
    );

    app.post<{ Params: { projectId: string } }>(
      "/api/v1/projects/:projectId/delivery/replan-board",
      { preHandler: auth },
      async (request, reply) => {
        const id = projectIdParam.safeParse(request.params.projectId);
        if (!id.success) {
          return reply.status(400).send({ error: { code: "VALIDATION", message: "Invalid project id" } });
        }
        const project = await prisma.project.findUnique({ where: { id: id.data } });
        if (!project) {
          return reply.status(404).send({ error: { code: "NOT_FOUND", message: "project" } });
        }
        if (!deliveryExecutionStarted(project.deliveryPolicy)) {
          return reply.status(409).send({
            error: {
              code: "INVALID_STATE",
              message:
                "Replan applies after Begin execution. Before kickoff, use Assign tasks with AI on the Plan tab instead.",
            },
          });
        }
        const impl = project.implementationStatus;
        if (impl !== IMPLEMENTATION_STATUS.EXECUTING && impl !== IMPLEMENTATION_STATUS.READY_FOR_UAT) {
          return reply.status(409).send({
            error: {
              code: "INVALID_STATE",
              message: `Board replan expects an active executing delivery project. Current: ${impl}`,
            },
          });
        }
        const approvedDesign = await prisma.designArtifact.findFirst({
          where: { projectId: id.data, status: "approved" },
        });
        if (!approvedDesign) {
          return reply.status(400).send({
            error: {
              code: "NO_APPROVED_DESIGN",
              message: "Approve a design artifact on the Design tab before replanning the board.",
            },
          });
        }
        const planSurfaceCount = await prisma.task.count({
          where: { projectId: id.data, state: { in: ["backlog", "todo"] } },
        });
        if (planSurfaceCount === 0) {
          return reply.status(400).send({
            error: {
              code: "NO_PLAN_TARGETS",
              message: "There are no backlog or todo tasks to refresh.",
            },
          });
        }
        const collapsedPlan = await collapseDuplicateTasksForProject(id.data);
        if (collapsedPlan.removedTaskIds.length > 0) {
          await runDeliveryOrchestrationHook(id.data, env);
        }
        let planning: Awaited<ReturnType<typeof runDeliveryBoardPlanning>>;
        try {
          planning = await runDeliveryBoardPlanning(id.data, env, {
            includeTodoTasks: true,
            orchestrationLogger: request.log,
          });
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          return reply.status(400).send({ error: { code: "PLAN_FAILED", message: msg } });
        }
        const policy = deliveryPolicyRecord(project.deliveryPolicy);
        policy.lastAssignmentPlanAt = new Date().toISOString();
        policy.boardPlannedAt = new Date().toISOString();
        const updated = await prisma.project.update({
          where: { id: id.data },
          data: { deliveryPolicy: policy as object },
        });
        const actorId = request.auth?.sub;
        if (actorId) {
          await recordAudit(actorId, "project.delivery.replan_board", `project:${id.data}`);
        }
        return { project: updated, planning };
      },
    );

    app.post<{ Params: { projectId: string } }>(
      "/api/v1/projects/:projectId/delivery/reconcile-plan-graph",
      { preHandler: auth },
      async (request, reply) => {
        const id = projectIdParam.safeParse(request.params.projectId);
        if (!id.success) {
          return reply.status(400).send({ error: { code: "VALIDATION", message: "Invalid project id" } });
        }
        const project = await prisma.project.findUnique({ where: { id: id.data } });
        if (!project) {
          return reply.status(404).send({ error: { code: "NOT_FOUND", message: "project" } });
        }
        const reconciled = await reconcilePredecessorPhasesForProject(id.data);
        const orchestration =
          deliveryExecutionStarted(project.deliveryPolicy) ?
            await runOrchestrationWithIdleRunnableSummary(id.data, env, {
              source: "http_reconcile_plan_graph",
              correlationId: readCorrelationIdFromRequest(request),
            })
          : {
              promotedTaskIds: [] as string[],
              assignedTaskIds: [] as string[],
              startedTaskIds: [] as string[],
              coderAgentRuns: [] as Awaited<
                ReturnType<typeof runParallelCoderRuns>
              >,
            };
        const actorId = request.auth?.sub;
        if (actorId) {
          await recordAudit(actorId, "project.delivery.reconcile_plan_graph", `project:${id.data}`);
        }
        return {
          adjustedTaskIds: reconciled.adjustedTaskIds,
          phasesReconciled: reconciled.adjustedTaskIds.length,
          orchestrationRan: deliveryExecutionStarted(project.deliveryPolicy),
          promotedTaskIds: orchestration.promotedTaskIds,
          assignedTaskIds: orchestration.assignedTaskIds,
          startedTaskIds: orchestration.startedTaskIds,
          coderAgentRuns: orchestration.coderAgentRuns,
        };
      },
    );

    app.post<{ Params: { projectId: string } }>(
      "/api/v1/projects/:projectId/delivery/publish-board",
      { preHandler: auth },
      async (request, reply) => {
        const id = projectIdParam.safeParse(request.params.projectId);
        if (!id.success) {
          return reply.status(400).send({ error: { code: "VALIDATION", message: "Invalid project id" } });
        }
        const project = await prisma.project.findUnique({ where: { id: id.data } });
        if (!project) {
          return reply.status(404).send({ error: { code: "NOT_FOUND", message: "project" } });
        }
        if (project.implementationStatus !== IMPLEMENTATION_STATUS.BACKLOG_APPROVED) {
          return reply.status(409).send({
            error: {
              code: "INVALID_STATE",
              message: `Publish board only after backlog_approved. Current: ${project.implementationStatus}`,
            },
          });
        }
        const routing = await loadTeamRoutingSnapshot(id.data);
        const { movedToTodo, startedTaskIds, assignedTaskIds } = await prisma.$transaction(async (tx) => {
          const { promotedTaskIds, startedTaskIds, assignedTaskIds } = await promoteEligibleAndAutoStartInTx(
            tx,
            id.data,
            { routingAgents: routing.agents }
          );
          await tx.project.update({
            where: { id: id.data },
            data: { implementationStatus: IMPLEMENTATION_STATUS.EXECUTING },
          });
          return { movedToTodo: promotedTaskIds.length, startedTaskIds, assignedTaskIds };
        });
        if (assignedTaskIds.length > 0) {
          await appendProjectChatMessage({
            projectId: id.data,
            actorKind: "orchestrator",
            actorLabel: "Orchestrator",
            body: `Publish board: orchestration assigned **${assignedTaskIds.length}** todo row(s) missing an assignee.`,
            meta: { event: "delivery.publish_board.auto_assign", taskIds: assignedTaskIds },
          });
        }
        const coderAgentRuns = startedTaskIds.length > 0 ? await runParallelCoderRuns(startedTaskIds, env) : [];
        const updated = await prisma.project.findUniqueOrThrow({ where: { id: id.data } });
        const actorId = request.auth?.sub;
        if (actorId) {
          await recordAudit(actorId, "project.delivery.publish_board", `project:${id.data}`);
        }
        return {
          movedToTodo,
          autoStarted: startedTaskIds.length,
          autoAssigned: assignedTaskIds.length,
          coderAgentRuns,
          project: updated,
        };
      }
    );

    app.post<{ Params: { projectId: string } }>(
      "/api/v1/projects/:projectId/delivery/reject-backlog",
      { preHandler: auth },
      async (request, reply) => {
        const id = projectIdParam.safeParse(request.params.projectId);
        if (!id.success) {
          return reply.status(400).send({ error: { code: "VALIDATION", message: "Invalid project id" } });
        }
        const body = z.object({ notes: z.string().max(8000).optional() }).safeParse(request.body);
        if (!body.success) {
          return reply.status(400).send({ error: { code: "VALIDATION", message: body.error.message } });
        }
        const project = await prisma.project.findUnique({ where: { id: id.data } });
        if (!project) {
          return reply.status(404).send({ error: { code: "NOT_FOUND", message: "project" } });
        }
        if (project.implementationStatus !== IMPLEMENTATION_STATUS.BACKLOG_PROPOSED) {
          return reply.status(409).send({
            error: { code: "INVALID_STATE", message: "Reject only applies in backlog_proposed" },
          });
        }
        await prisma.proposedBacklogItem.deleteMany({ where: { projectId: id.data, status: "draft" } });
        const pol = deliveryPolicyRecord(project.deliveryPolicy);
        delete pol.lastAssignmentPlanAt;
        const updated = await prisma.project.update({
          where: { id: id.data },
          data: {
            implementationStatus: IMPLEMENTATION_STATUS.DELIVERY_ACTIVE,
            backlogFeedbackNotes: body.data.notes?.trim() || null,
            deliveryPolicy: pol as object,
          },
        });
        const actorId = request.auth?.sub;
        if (actorId) {
          await recordAudit(actorId, "project.delivery.reject_backlog", `project:${id.data}`);
        }
        return { project: updated };
      }
    );

    app.patch<{ Params: { projectId: string } }>(
      "/api/v1/projects/:projectId/delivery",
      { preHandler: auth },
      async (request, reply) => {
        const id = projectIdParam.safeParse(request.params.projectId);
        if (!id.success) {
          return reply.status(400).send({ error: { code: "VALIDATION", message: "Invalid project id" } });
        }
        const body = z
          .object({
            readyForUat: z.boolean().optional(),
            /** Operator marks delivery finished; only after marking ready for UAT (`ready_for_uat`). */
            closed: z.boolean().optional(),
          })
          .safeParse(request.body);
        if (!body.success) {
          return reply.status(400).send({ error: { code: "VALIDATION", message: body.error.message } });
        }
        const project = await prisma.project.findUnique({ where: { id: id.data } });
        if (!project) {
          return reply.status(404).send({ error: { code: "NOT_FOUND", message: "project" } });
        }

        const wantsClose = body.data.closed === true;
        const uat = body.data.readyForUat;

        if (project.implementationStatus === IMPLEMENTATION_STATUS.CLOSED) {
          if (wantsClose) {
            return { project };
          }
          if (uat !== undefined) {
            return reply.status(409).send({
              error: {
                code: "PROJECT_CLOSED",
                message: "This project is already closed; reopen is not supported from this endpoint.",
              },
            });
          }
          return reply.status(400).send({ error: { code: "VALIDATION", message: "No changes" } });
        }

        if (wantsClose) {
          const st = project.implementationStatus;
          if (st !== IMPLEMENTATION_STATUS.READY_FOR_UAT || !project.readyForUat) {
            const detail =
              st === IMPLEMENTATION_STATUS.EXECUTING ?
                "Mark ready for UAT before closing the project."
              : `Mark closed only from ready_for_uat (after operator UAT readiness). Current: ${st}`;
            return reply.status(409).send({
              error: {
                code: "UAT_REQUIRED",
                message: detail,
              },
            });
          }
          const updated = await prisma.project.update({
            where: { id: id.data },
            data: { implementationStatus: IMPLEMENTATION_STATUS.CLOSED },
          });
          const actorId = request.auth?.sub;
          if (actorId) {
            await recordAudit(actorId, "project.delivery.close", `project:${id.data}`);
          }
          await appendProjectChatMessage({
            projectId: id.data,
            actorKind: "orchestrator",
            actorLabel: "Orchestrator",
            body: "**Project closed** — implementation status set to `closed` (delivery complete).",
            meta: { event: "delivery.project_closed" },
          });
          return { project: updated };
        }

        const data: {
          readyForUat?: boolean;
          implementationStatus?: string;
        } = {};
        if (uat === true) {
          data.readyForUat = true;
          data.implementationStatus = IMPLEMENTATION_STATUS.READY_FOR_UAT;
        }
        if (uat === false) {
          data.readyForUat = false;
          if (project.implementationStatus === IMPLEMENTATION_STATUS.READY_FOR_UAT) {
            data.implementationStatus = IMPLEMENTATION_STATUS.EXECUTING;
          }
        }
        if (Object.keys(data).length === 0) {
          return reply.status(400).send({ error: { code: "VALIDATION", message: "No changes" } });
        }
        const updated = await prisma.project.update({ where: { id: id.data }, data });
        const actorId = request.auth?.sub;
        if (actorId) {
          await recordAudit(actorId, "project.delivery.patch", `project:${id.data}`);
        }
        return { project: updated };
      }
    );
  };
}
