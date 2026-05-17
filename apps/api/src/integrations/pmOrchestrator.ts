import type { Env } from "../config/env.js";
import { resolveWorkflowAgent, type OrchestrationLogTarget } from "../lib/deliveryOrchestrationHub.js";
import { prisma } from "../lib/prisma.js";
import type { ProjectContext, ProposedBacklogItem, RepositoryScope } from "@prisma/client";
import { generateBacklogItemsWithLlm, type ResolvedLlmCredentials } from "./llmExecute.js";

export type ProposeInput = {
  /** Structured backlog items (preferred for production). */
  items?: { title: string; description?: string }[];
  /** Requirements blob; sent to the LLM as user content (not line-split). */
  requirementsText?: string;
  documentLink?: string;
  /** @deprecated Ignored; propose always uses the LLM path (or E2E stub). */
  useLlm?: boolean;
};

export type ProposeBacklogResult = {
  proposed: ProposedBacklogItem[];
  /** True only when a real provider HTTP call was made. */
  usedLlm: boolean;
  /** Model / connection label for UI (or `e2e-stub` when stubbed). */
  modelLabel: string;
};

type CtxParts = {
  brief: string | null;
  goals: string | null;
  analysisNotes: string | null;
  requirementsLinks: unknown;
  repoSummary: string | null;
  documentRepositoryUrl: string | null;
};

function trimLinks(links: unknown): string {
  if (!Array.isArray(links)) return "";
  const lines: string[] = [];
  for (const entry of links.slice(0, 20)) {
    if (typeof entry === "string") {
      lines.push(`- ${entry}`);
    } else if (entry && typeof entry === "object") {
      const o = entry as Record<string, unknown>;
      const label = typeof o.label === "string" ? o.label : typeof o.title === "string" ? o.title : "link";
      const url = typeof o.url === "string" ? o.url : "";
      lines.push(url ? `- ${label}: ${url}` : `- ${label}`);
    }
  }
  return lines.join("\n");
}

export function buildProjectContextBlock(
  ctx: ProjectContext | null,
  repo: RepositoryScope | null
): CtxParts {
  const repoSummary =
    repo?.cloneUrl || repo?.rootPath || repo?.branchDefault
      ? [
          repo.cloneUrl ? `Clone: ${repo.cloneUrl}` : "",
          repo.branchDefault ? `Branch: ${repo.branchDefault}` : "",
          repo.rootPath ? `Paths: ${repo.rootPath}` : "",
        ]
          .filter(Boolean)
          .join(" · ") || null
      : null;
  return {
    brief: ctx?.brief ?? null,
    goals: ctx?.goals ?? null,
    analysisNotes: ctx?.analysisNotes ?? null,
    requirementsLinks: ctx?.requirementsLinks ?? [],
    repoSummary,
    documentRepositoryUrl: ctx?.documentRepositoryUrl ?? null,
  };
}

export function contextPrefix(parts: CtxParts): string {
  const chunks: string[] = [];
  if (parts.brief?.trim()) chunks.push(`Brief:\n${parts.brief.trim()}`);
  if (parts.goals?.trim()) chunks.push(`Goals:\n${parts.goals.trim()}`);
  if (parts.analysisNotes?.trim()) chunks.push(`Design / analysis notes:\n${parts.analysisNotes.trim()}`);
  const links = trimLinks(parts.requirementsLinks);
  if (links) chunks.push(`Requirement links:\n${links}`);
  if (parts.documentRepositoryUrl?.trim()) {
    chunks.push(`Document repository: ${parts.documentRepositoryUrl.trim()}`);
  }
  if (parts.repoSummary) chunks.push(`Repository: ${parts.repoSummary}`);
  return chunks.join("\n\n");
}

/**
 * Resolve one binding: **team seat (`role_id`)** → **agent** (both ordered by `priority` asc) → **company default**
 * (rows with only `companyId` set; agent/role/skill null).
 * Seat-level bindings follow orchestration’s `skillMatchRoleId` so the model stays with the seat for that workflow step.
 */
export async function findBindingForPropose(
  agentId: string | null,
  companyId: string | null,
  options?: { roleId?: string | null }
) {
  const include = { llmProviderConnection: true as const };
  const rid = typeof options?.roleId === "string" ? options.roleId.trim() : "";
  if (rid) {
    const b = await prisma.modelBinding.findFirst({
      where: { roleId: rid },
      orderBy: { priority: "asc" },
      include,
    });
    if (b) return b;
  }
  const aid = typeof agentId === "string" ? agentId.trim() : "";
  if (aid) {
    const b = await prisma.modelBinding.findFirst({
      where: { agentId: aid },
      orderBy: { priority: "asc" },
      include,
    });
    if (b) return b;
  }
  if (companyId) {
    return prisma.modelBinding.findFirst({
      where: {
        companyId,
        agentId: null,
        roleId: null,
        skillId: null,
      },
      orderBy: { priority: "asc" },
      include,
    });
  }
  return null;
}

export function bindingToCredentials(binding: {
  modelId: string;
  llmProviderConnection: {
    provider: string;
    modelId: string;
    baseUrl: string | null;
    apiKey: string | null;
  } | null;
}): ResolvedLlmCredentials | null {
  const c = binding.llmProviderConnection;
  if (!c) {
    return {
      provider: "openai",
      modelId: binding.modelId,
      apiKey: null,
      baseUrl: null,
    };
  }
  /** Binding `modelId` is the snapshot used for calls (copied from connection at create; patchable per binding). */
  const modelId = binding.modelId.trim() || c.modelId;
  return {
    provider: c.provider,
    modelId,
    apiKey: c.apiKey,
    baseUrl: c.baseUrl,
  };
}

/**
 * Ordered fallthrough: all bindings for the **seat (`role_id`)**, then **agent**, then **company-only** defaults;
 * deduped by binding id.
 */
export async function listBindingsForProposeFallthrough(
  agentId: string | null,
  companyId: string | null,
  options?: { roleId?: string | null }
) {
  const include = { llmProviderConnection: true as const };
  type Row = Awaited<ReturnType<typeof prisma.modelBinding.findMany<{ include: typeof include }>>>[number];
  const out: Row[] = [];
  const seenIds = new Set<string>();

  const rid = typeof options?.roleId === "string" ? options.roleId.trim() : "";
  if (rid) {
    const roleRows = await prisma.modelBinding.findMany({
      where: { roleId: rid },
      orderBy: { priority: "asc" },
      include,
    });
    for (const b of roleRows) {
      if (!seenIds.has(b.id)) {
        seenIds.add(b.id);
        out.push(b);
      }
    }
  }

  const aid = typeof agentId === "string" ? agentId.trim() : "";
  if (aid) {
    const agentRows = await prisma.modelBinding.findMany({
      where: { agentId: aid },
      orderBy: { priority: "asc" },
      include,
    });
    for (const b of agentRows) {
      if (!seenIds.has(b.id)) {
        seenIds.add(b.id);
        out.push(b);
      }
    }
  }
  if (companyId) {
    const companyRows = await prisma.modelBinding.findMany({
      where: {
        companyId,
        agentId: null,
        roleId: null,
        skillId: null,
      },
      orderBy: { priority: "asc" },
      include,
    });
    for (const b of companyRows) {
      if (!seenIds.has(b.id)) {
        seenIds.add(b.id);
        out.push(b);
      }
    }
  }
  return out;
}

export type ProposeBindingRow = Awaited<ReturnType<typeof listBindingsForProposeFallthrough>>[number];

/** True when the LLM/provider failure is likely transient quota overload — callers may try the next model binding. */
export function isLlmQuotaOrOverloadFailure(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const m = error.message;
  if (/\b429\b/.test(m)) return true;
  if (/\b503\b/.test(m)) return true;
  if (/RESOURCE_EXHAUSTED/i.test(m)) return true;
  if (/too many requests/i.test(m)) return true;
  if (/rate limit/i.test(m)) return true;
  if (/quota exhausted/i.test(m)) return true;
  if (/exhausted\b/i.test(m) && /try again later/i.test(m)) return true;
  return false;
}

export type BindingAuditOpts = {
  projectId: string;
  workflow: string;
};

export type ProposeBindingFallbackOpts = {
  roleId?: string | null;
  /**
   * If set and returns false for a thrown error, rethrow immediately (no further bindings).
   * Omit to keep legacy behavior: try every binding after any error.
   */
  shouldTryNextBinding?: (err: unknown) => boolean;
  /** When set, successful binding picks and exhaustion are recorded per project for operator debugging. */
  bindingAudit?: BindingAuditOpts;
};

function bindingTierHint(binding: ProposeBindingRow): string {
  if (binding.roleId) return "seat";
  if (binding.agentId) return "agent";
  return "company";
}

async function recordBindingAuditSuccess(
  audit: BindingAuditOpts | undefined,
  binding: ProposeBindingRow,
  modelLabel: string
): Promise<void> {
  if (!audit?.projectId?.trim()) return;
  await prisma.orchestrationBindingAttempt.create({
    data: {
      projectId: audit.projectId.trim(),
      workflow: audit.workflow.trim().slice(0, 160),
      agentId: binding.agentId,
      roleId: binding.roleId,
      bindingId: binding.id,
      provider: binding.llmProviderConnection?.provider ?? null,
      modelId: binding.modelId,
      modelLabel: modelLabel.slice(0, 500),
      scopeHint: bindingTierHint(binding),
      success: true,
    },
  }).catch(() => undefined);
}

async function recordBindingAuditExhaustion(
  audit: BindingAuditOpts | undefined,
  ladderBindings: number,
  triedFingerprints: number
): Promise<void> {
  if (!audit?.projectId?.trim()) return;
  await prisma.orchestrationBindingAttempt.create({
    data: {
      projectId: audit.projectId.trim(),
      workflow: audit.workflow.trim().slice(0, 160),
      success: false,
      scopeHint: "exhausted_binding_ladder",
      modelLabel: `tried ${triedFingerprints} distinct fingerprints; ladder=${ladderBindings} rows`,
      provider: null,
    },
  }).catch(() => undefined);
}

/**
 * Try each binding in fallthrough order until `run` succeeds. Skips duplicate provider endpoint credentials
 * (same connection + resolved model + URLs + key) so priority lists don’t retry an exhausted quota twice.
 * @throws Last error if every attempt fails (or no resolvable credentials).
 */
export async function withProposeBindingFallback<T>(
  agentId: string | null,
  companyId: string | null,
  run: (ctx: { binding: ProposeBindingRow; cred: ResolvedLlmCredentials; modelLabel: string }) => Promise<T>,
  opts?: ProposeBindingFallbackOpts
): Promise<T> {
  const bindings = await listBindingsForProposeFallthrough(agentId, companyId, {
    roleId: opts?.roleId ?? undefined,
  });
  if (bindings.length === 0) {
    throw new Error(
      "No LLM is configured: add a model binding for the orchestrated seat (team role), the agent, or a company-wide default (Admin → Model bindings), each linked to a provider connection."
    );
  }
  let lastErr: unknown;
  const triedCredFingerprints = new Set<string>();
  for (const binding of bindings) {
    const cred = bindingToCredentials(binding);
    if (!cred) {
      lastErr = new Error("Could not resolve LLM credentials from binding.");
      continue;
    }
    const fp = [
      binding.llmProviderConnectionId ?? "legacy",
      cred.provider,
      cred.modelId,
      cred.baseUrl ?? "",
      cred.apiKey ?? "",
    ].join("|");
    if (triedCredFingerprints.has(fp)) continue;
    triedCredFingerprints.add(fp);
    const modelLabel =
      binding.llmProviderConnection?.name ?? binding.llmProviderConnection?.modelId ?? binding.modelId ?? "llm";
    try {
      const out = await run({ binding, cred, modelLabel });
      await recordBindingAuditSuccess(opts?.bindingAudit, binding, modelLabel);
      return out;
    } catch (e) {
      lastErr = e;
      const continueToNext =
        opts?.shouldTryNextBinding === undefined ? true : opts.shouldTryNextBinding(e);
      if (!continueToNext) {
        throw e;
      }
    }
  }
  await recordBindingAuditExhaustion(opts?.bindingAudit, bindings.length, triedCredFingerprints.size);
  if (lastErr instanceof Error) {
    throw new Error(
      `${lastErr.message} (binding ladder exhausted: ${triedCredFingerprints.size} distinct credential fingerprints tried from ${bindings.length} prioritized rows).`,
    );
  }
  throw new Error(String(lastErr ?? "All model bindings failed."));
}

function e2eStubLines(
  input: ProposeInput,
  prefix: string,
  documentLink: string | undefined
): { title: string; description: string; phase: number; dependsOnTitles: string[] }[] {
  if (input.items?.length) {
    return input.items.map((it, idx) => {
      const descParts = [prefix, it.description ?? "", documentLink ? `Ref: ${documentLink}` : ""].filter(Boolean);
      return {
        title: it.title.slice(0, 500),
        description: descParts.join("\n\n").slice(0, 20_000),
        phase: idx === 0 ? 0 : 1,
        dependsOnTitles: [] as string[],
      };
    });
  }
  const text = input.requirementsText?.trim() ?? "";
  if (!text) {
    throw new Error("Provide `items` or non-empty `requirementsText`");
  }
  /** E2E-only: one item per non-empty line so journeys stay stable without a real LLM. */
  const rawLines = text
    .split(/\n+/)
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, 50);
  if (rawLines.length === 0) {
    throw new Error("Provide `items` or non-empty `requirementsText`");
  }
  return rawLines.map((line, idx) => {
    const descParts = [prefix, documentLink ? `Ref: ${documentLink}` : ""].filter(Boolean);
    return {
      title: line.slice(0, 500),
      description: descParts.join("\n\n").slice(0, 20_000),
      phase: rawLines.length === 1 ? 0 : idx === 0 ? 0 : 1,
      dependsOnTitles: [] as string[],
    };
  });
}

/** Human-readable model label for PM propose (same seat → agent → company order as {@link proposeBacklogFromRequirements}). */
export async function resolveProposeModelLabel(
  projectId: string,
  options?: { logger?: OrchestrationLogTarget }
): Promise<string | null> {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { pmOrchestratorAgentId: true },
  });
  const company = await prisma.company.findFirst();
  const companyId = company?.id ?? null;
  const resolution = await resolveWorkflowAgent(projectId, "backlog", { logger: options?.logger });
  const proposeAgentId = resolution.skillMatchAgentId ?? project?.pmOrchestratorAgentId ?? null;
  const proposeRoleId = resolution.skillMatchRoleId ?? null;
  const bindings = await listBindingsForProposeFallthrough(proposeAgentId, companyId, {
    roleId: proposeRoleId,
  });
  const binding = bindings[0];
  if (!binding) return null;
  return (
    binding.llmProviderConnection?.name ??
    binding.llmProviderConnection?.modelId ??
    binding.modelId ??
    null
  );
}

/** SDM or PM agent id used for design / board / review-handoff LLM seat resolution (in order). */
export async function resolveDesignLlmAgentId(projectId: string): Promise<string | null> {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: {
      pmOrchestratorAgentId: true,
      roleAssignments: {
        where: { duty: "sdm_delivery" },
        select: { agentId: true },
      },
    },
  });
  const sdmId = project?.roleAssignments[0]?.agentId ?? null;
  if (sdmId) return sdmId;
  return project?.pmOrchestratorAgentId ?? null;
}

/**
 * Resolve LLM binding for a workflow step: **seat (`preferredRoleId`)** then **agent**, then **company default** only.
 * Does not walk unrelated agents (e.g. SDM then PM); pass the orchestration’s agent (and seat id) from the caller.
 */
export async function resolveBindingPreferringAgent(
  _projectId: string,
  preferredAgentId: string | null,
  options?: { preferredRoleId?: string | null }
) {
  const company = await prisma.company.findFirst();
  const companyId = company?.id ?? null;
  const trimmed = typeof preferredAgentId === "string" ? preferredAgentId.trim() : "";
  const roleId = typeof options?.preferredRoleId === "string" ? options.preferredRoleId.trim() : "";
  if (trimmed || roleId) {
    const direct = await findBindingForPropose(trimmed || null, companyId, {
      roleId: roleId || undefined,
    });
    if (direct) return direct;
  }
  return resolveDesignLlmBinding();
}

/** Company-wide default binding only (no agent/seat). Used when the orchestrated seat has no model binding. */
export async function resolveDesignLlmBinding() {
  const company = await prisma.company.findFirst();
  const companyId = company?.id ?? null;
  return findBindingForPropose(null, companyId, undefined);
}

/** Full intake + repo context block for LLM prompts (design, etc.). */
export async function buildIntakeContextPrefix(projectId: string): Promise<string> {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    include: { context: true, repoScope: true },
  });
  if (!project) {
    throw new Error("Project not found");
  }
  const ctxParts = buildProjectContextBlock(project.context, project.repoScope);
  return contextPrefix(ctxParts);
}

/**
 * Creates `ProposedBacklogItem` rows (draft). Always uses the LLM (or `PM_PROPOSE_E2E_STUB` for tests).
 * There is no line-split “fake backlog” in production.
 */
export async function proposeBacklogFromRequirements(
  projectId: string,
  input: ProposeInput,
  env: Env,
  options?: { orchestrationLogger?: OrchestrationLogTarget }
): Promise<ProposeBacklogResult> {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    include: {
      context: true,
      repoScope: true,
      pmOrchestratorAgent: { select: { id: true, name: true } },
    },
  });
  if (!project) {
    throw new Error("Project not found");
  }

  const company = await prisma.company.findFirst();
  const companyId = company?.id ?? null;

  const ctxParts = buildProjectContextBlock(project.context, project.repoScope);
  const prefix = contextPrefix(ctxParts);

  const hasItems = Boolean(input.items?.length);
  const hasText = Boolean(input.requirementsText?.trim());
  if (!hasItems && !hasText) {
    throw new Error("Provide `items` or non-empty `requirementsText`");
  }

  let lines: { title: string; description: string; phase: number; dependsOnTitles: string[] }[];
  let usedLlm: boolean;
  let modelLabel: string;

  if (env.PM_PROPOSE_E2E_STUB === "true") {
    lines = e2eStubLines(input, prefix, input.documentLink);
    usedLlm = false;
    modelLabel = "e2e-stub (no LLM)";
  } else {
    if (env.PM_PROPOSE_USE_LLM !== "true") {
      throw new Error(
        "PM propose requires an LLM. Set PM_PROPOSE_USE_LLM=true and configure a provider connection plus model binding (Admin), or use PM_PROPOSE_E2E_STUB=true only in automated tests."
      );
    }
    if (!companyId) {
      throw new Error("No company record; cannot resolve LLM bindings.");
    }

    const reqBlock = input.items?.length
      ? input.items.map((i) => `- ${i.title}: ${i.description ?? ""}`).join("\n")
      : (input.requirementsText ?? "");

    const userPrompt = [
      prefix ? `Project context:\n${prefix}\n` : "",
      `Produce a backlog as JSON array from the following requirements (split into concrete, verifiable items).`,
      `Each object may use "dependsOnTitles": string[] with exact "title" strings of other objects in the SAME array for finish-to-start ordering (usually within the same phase); omit or use [] when nothing in this batch blocks the item.`,
      `\n\nRequirements:\n\n${reqBlock}`,
      input.documentLink ? `\n\nReference: ${input.documentLink}` : "",
    ]
      .filter(Boolean)
      .join("\n");

    const resolution = await resolveWorkflowAgent(projectId, "backlog", {
      logger: options?.orchestrationLogger,
    });
    const proposeAgentId = resolution.skillMatchAgentId ?? project.pmOrchestratorAgentId ?? null;
    const proposeRoleId = resolution.skillMatchRoleId ?? null;

    const pack = await withProposeBindingFallback(
      proposeAgentId,
      companyId,
      async ({ cred, modelLabel: ml }) => {
        const result = await generateBacklogItemsWithLlm(userPrompt, cred, env.OPENAI_API_KEY);
        return { lines: result, modelLabel: ml };
      },
      {
        roleId: proposeRoleId ?? undefined,
        bindingAudit: { projectId, workflow: "backlog.propose" },
      }
    );
    lines = pack.lines;
    usedLlm = true;
    modelLabel = pack.modelLabel;
  }

  const sourceTag = usedLlm ? `llm:${modelLabel}` : `stub:${modelLabel}`;

  const created: ProposedBacklogItem[] = [];
  for (const line of lines) {
    const row = await prisma.proposedBacklogItem.create({
      data: {
        projectId,
        source: sourceTag,
        status: "draft",
        payload: {
          title: line.title,
          description: line.description,
          phase: line.phase,
          dependsOnTitles: line.dependsOnTitles.length ? line.dependsOnTitles : undefined,
        },
      },
    });
    created.push(row);
  }

  return { proposed: created, usedLlm, modelLabel };
}
