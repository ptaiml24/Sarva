import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api, ApiError } from "../api/http.js";
import { useProjectOutlet } from "./ProjectLayout.js";

type Team = { id: string; name: string };

type SuggestedDeliveryAgentsResponse = {
  pmOrchestratorAgentId: string | null;
  sdmDeliveryAgentId: string | null;
  tpmSprintAgentId: string | null;
  hints: {
    duty: "pm_orchestrator" | "sdm_delivery" | "tpm_sprint";
    agentId: string;
    agentName: string;
    teamName: string;
    roleName: string;
    roleTemplateCode: string;
  }[];
};
/** Response from POST .../delivery/begin-execution — includes per-task coder outcomes for troubleshooting. */
type BeginExecutionResponse = {
  idempotent?: boolean;
  movedToTodo?: number;
  autoStarted?: number;
  /** Orchestrator-filled assignees on todo rows that had none */
  autoAssigned?: number;
  coderAgentRuns?: {
    ran: boolean;
    usedLlm?: boolean;
    submittedToReview?: boolean;
    skippedReason?: string;
    error?: string;
  }[];
};

type DeliveryOrchestrationKickResponse = Pick<
  BeginExecutionResponse,
  "movedToTodo" | "autoAssigned" | "autoStarted" | "coderAgentRuns"
> & { ok?: boolean };

/** Shared copy for `/delivery/run-orchestration` and `/delivery/resume-hands-off-automation` responses. */
function buildOrchestrationKickBoardInfo(r: DeliveryOrchestrationKickResponse, leadSentence: string): string {
  const assignSuffix =
    (r.autoAssigned ?? 0) > 0 ? ` Assigned ${r.autoAssigned} unassigned todo(s).` : "";
  const runs = r.coderAgentRuns ?? [];
  const submitted = runs.filter((x) => x.submittedToReview).length;
  const errs = runs.filter((x) => Boolean(x.error)).length;
  const skipped = runs.filter((x) => x.ran === false && x.skippedReason).length;
  const hint =
    errs || skipped ? " Open **Chat** for the latest orchestrator lines." : "";
  return [
    leadSentence,
    `Orchestration moved ${r.movedToTodo ?? 0} backlog row(s) to todo; auto-started ${r.autoStarted ?? 0}.${assignSuffix}`,
    runs.length > 0 ?
      `Coder batch: ${submitted}/${runs.length} submitted to review${errs ? `, ${errs} error(s)` : ""}${skipped ? `, ${skipped} skipped` : ""}.`
    : "",
    hint,
    "If tasks stay on **todo**, check **Chat** for dependency blocks, routing, unassigned seats, or the runnable snapshot.",
  ]
    .join(" ")
    .trim();
}

type Task = {
  id: string;
  title: string;
  state: string;
  version: number;
  assigneeAgentId: string | null;
  description: string | null;
  targetRoleId: string | null;
  sprintId: string | null;
  /** 0 = foundation wave; higher phases unlock after all lower-phase tasks are `done`. */
  executionPhase?: number;
  /** Markdown from the assignee agent’s mapped LLM (claim / run-coder). */
  agentGeneratedBody?: string | null;
  agentGeneratedAt?: string | null;
  reviewHandoffMarkdown?: string | null;
  /** Review ↔ fix cycles (request changes); resets on approve. */
  reviewRevisionCount?: number;
  assigneeAgent?: { id: string; name: string } | null;
  implementingAgent?: { id: string; name: string } | null;
  linkedBranch?: string | null;
  linkedPrUrl?: string | null;
  sprint?: { id: string; name: string } | null;
  targetRole?: {
    id: string;
    name: string;
    roleTemplate: { label: string; code: string } | null;
    team: { id: string; name: string };
  } | null;
  /** Finish-to-start: cannot claim until these tasks are `done`. */
  dependsOn?: { predecessorTaskId: string }[];
  /** Resolved TaskDependency rows; titles pending resolution may sit in dependencyHints until siblings are accepted. */
  dependencyHints?: { dependsOnTitles?: string[] } | null;
  skillTags?: string[];
  /** False when the seat is QA/PM/etc. without the Coder skill — implementation LLM is skipped (`not_coder_task`). */
  coderEligible?: boolean;
};
type AssignableRole = {
  id: string;
  name: string;
  teamId: string;
  teamName: string;
  roleTemplate: { id: string; code: string; label: string } | null;
};
type Proposed = {
  id: string;
  status: string;
  source?: string;
  payload: { title?: string; description?: string; phase?: number; dependsOnTitles?: string[] };
};

function ProposedDraftTitleCell({ it }: { it: Proposed }) {
  const title = it.payload.title ?? it.id;
  const desc = it.payload.description?.trim();
  const phase = typeof it.payload.phase === "number" && Number.isFinite(it.payload.phase) ? it.payload.phase : 0;
  const deps = Array.isArray(it.payload.dependsOnTitles) ? it.payload.dependsOnTitles.filter(Boolean) : [];
  return (
    <td style={{ maxWidth: "40rem", verticalAlign: "top" }}>
      <div style={{ display: "flex", flexWrap: "wrap", gap: "0.35rem", alignItems: "baseline" }}>
        <strong>{title}</strong>
        <span
          className="muted"
          style={{
            fontSize: "0.78rem",
            border: "1px solid var(--border)",
            borderRadius: 6,
            padding: "0.12rem 0.4rem",
          }}
          title="Execution phase: lower phases must complete before higher-phase tasks can be claimed"
        >
          Phase {phase}
        </span>
      </div>
      {deps.length > 0 ? (
        <div className="muted" style={{ marginTop: "0.35rem", fontSize: "0.82rem", lineHeight: 1.45 }}>
          <strong>Starts after:</strong> {deps.join(" · ")}
        </div>
      ) : (
        <p className="muted" style={{ marginTop: "0.25rem", marginBottom: 0, fontSize: "0.8rem", lineHeight: 1.4 }}>
          No same-batch predecessors — parallel within phase unless you edit links after tasks exist.
        </p>
      )}
      {desc ?
        <div
          className="muted"
          style={{
            marginTop: "0.4rem",
            fontSize: "0.86rem",
            lineHeight: 1.4,
            whiteSpace: "pre-wrap",
            maxHeight: "14rem",
            overflow: "auto",
          }}
        >
          {desc}
        </div>
      : null}
    </td>
  );
}

type Sprint = { id: string; name: string; startsAt: string | null; endsAt: string | null };
type Agent = { id: string; name: string };
type UserRow = { id: string; email: string };
type DesignArtifact = { id: string; title: string; body: string; status: string; updatedAt: string };

type DeliverySummary = {
  implementationStatus: string;
  readyForUat: boolean;
  intakeBaselineAt: string | null;
  backlogFeedbackNotes: string | null;
  /** Resolved PM propose model (binding); for UI before running propose. */
  proposeModelLabel: string | null;
  readiness: { ok: boolean; checks: { id: string; ok: boolean; detail: string }[] };
  draftProposals: number;
  blockedTasks: {
    id: string;
    title: string;
    state: string;
    blockedReason: string | null;
    escalationStrikes: number;
  }[];
  phaseProgress: {
    currentUnlockedPhase: number;
    nextPhase: number | null;
    canUnlockNextPhase: boolean;
    blockersCurrentPhase: { id: string; title: string; state: string; blockedReason: string | null }[];
    phases: {
      phase: number;
      total: number;
      counts: { backlog: number; todo: number; in_progress: number; review: number; done: number };
      blocked: number;
      blockers: { id: string; title: string; state: string; blockedReason: string | null }[];
    }[];
  };
  /** Post Begin execution stall counter (`delivery_policy.autonomousStallCount`). */
  autonomousStallCount?: number;
  /** True after Begin execution (`executionKickoffAt` on policy). */
  deliveryExecutionStarted?: boolean;
  stallThresholdForOperatorHandsOn?: number;
  /** True when every task for the project is `done` (including zero tasks). */
  allTasksDone?: boolean;
  /** Last `npm run build` in dev workspace (API host). */
  workspaceLastBuild?: {
    at: string;
    ok: boolean;
    exitCode: number;
    stdoutTail: string;
    stderrTail: string;
    commandSummary: string;
    trigger?: string;
  } | null;
  /** Detached preview server started from API workspace tools. */
  workspacePreview?: {
    url: string;
    port: number;
    pid: number;
    startedAt: string;
    command: string;
  } | null;
  postCompletionAutoWorkspaceBuildFinishedAt?: string | null;
  /** API allows POST workspace-git-push (SARVA_WORKSPACE_GIT_PUSH=true). */
  workspaceGitPushEnabled?: boolean;
  /** Company PAT + owner configured (Admin → GitHub publishing); enables POST …/delivery/github-publish. */
  githubCompanyPublishConfigured?: boolean;
  /** API env runs coder LLM + automated review (required for hands-off UI). */
  automationHandsOffEnvConfigured?: boolean;
  /** Stall count breached threshold — Chat already escalates; board shows full controls. */
  autonomousOperatorRequired?: boolean;
  /** Hide routine board edits while automation owns the loop (coder + reviewer). */
  boardHandsOffMinimalControls?: boolean;
};

type LinkRow = { label: string; url: string };

/** Rows reconstructed from persisted `requirementsLinks` (no UI staging row). */
function parseStoredRequirementsLinks(raw: unknown): LinkRow[] {
  if (!Array.isArray(raw)) return [];
  const rows: LinkRow[] = [];
  for (const entry of raw) {
    if (typeof entry === "string" && entry.trim()) {
      rows.push({ label: "", url: entry.trim() });
    } else if (entry && typeof entry === "object") {
      const o = entry as Record<string, unknown>;
      const url = typeof o.url === "string" ? o.url : "";
      const label = typeof o.label === "string" ? o.label : typeof o.title === "string" ? o.title : "";
      if (url.trim() || label.trim()) rows.push({ label, url });
    }
  }
  return rows;
}

/**
 * Intake editors always end with one empty staging row when the last saved link is filled,
 * so operators can paste the next PRD/ref without touching "Add link" unless they prefer it.
 */
function editingLinkRowsFromStored(raw: unknown): LinkRow[] {
  const base = parseStoredRequirementsLinks(raw);
  if (base.length === 0) return [{ label: "", url: "" }];
  const last = base[base.length - 1];
  const lastBlank = last.url.trim() === "" && last.label.trim() === "";
  return lastBlank ? base : [...base, { label: "", url: "" }];
}

function serializeLinks(rows: LinkRow[]): object[] {
  return rows
    .filter((r) => r.url.trim() || r.label.trim())
    .map((r) => ({ label: r.label.trim() || undefined, url: r.url.trim() || "" }))
    .filter((o) => (o as { url: string }).url.length > 0) as object[];
}

type StoredIntakeContextSlice =
  | {
      brief: string | null;
      goals: string | null;
      documentRepositoryUrl: string | null;
      requirementsLinks: unknown;
    }
  | null
  | undefined;

function intakeContextDraftMatchesStored(
  brief: string,
  goals: string,
  docRepoUrl: string,
  linkRows: LinkRow[],
  stored: StoredIntakeContextSlice
): boolean {
  const sg = (stored?.goals ?? "").trim();
  if (goals.trim() !== sg) return false;
  const sb = (stored?.brief ?? "").trim();
  if (brief.trim() !== sb) return false;
  const serverDoc = (stored?.documentRepositoryUrl ?? "").trim();
  if (docRepoUrl.trim() !== serverDoc) return false;
  const serverLinksJson = JSON.stringify(serializeLinks(parseStoredRequirementsLinks(stored?.requirementsLinks)));
  const draftLinksJson = JSON.stringify(serializeLinks(linkRows));
  return serverLinksJson === draftLinksJson;
}

function intakeContextDraftPatchPayload(brief: string, goals: string, docRepoUrl: string, linkRows: LinkRow[]) {
  return {
    brief: brief.trim() === "" ? null : brief.trim(),
    goals: goals.trim() === "" ? null : goals.trim(),
    requirementsLinks: serializeLinks(linkRows),
    documentRepositoryUrl: docRepoUrl.trim() === "" ? "" : docRepoUrl.trim(),
  };
}

type DeliveryWorkflowRow = {
  id: string;
  code: string;
  name: string;
  kind: string;
  description?: string | null;
  isBuiltin?: boolean;
};
type PrdArtifactRow = {
  id: string;
  title: string;
  body: string;
  status: string;
  updatedAt: string;
  feedbackNotes?: string | null;
};
type ProjectAttachmentMeta = { id: string; fileName: string; mimeType: string; byteSize: number; createdAt: string };

function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => {
      const s = r.result as string;
      const i = s.indexOf(",");
      resolve(i >= 0 ? s.slice(i + 1) : s);
    };
    r.onerror = () => reject(r.error ?? new Error("read failed"));
    r.readAsDataURL(file);
  });
}

export function ProjectIntakeTab() {
  const navigate = useNavigate();
  const { project, reloadProject } = useProjectOutlet();
  const [brief, setBrief] = useState(project.context?.brief ?? "");
  const [goals, setGoals] = useState(project.context?.goals ?? "");
  const [linkRows, setLinkRows] = useState<LinkRow[]>(() =>
    editingLinkRowsFromStored(project.context?.requirementsLinks)
  );
  const [reqJson, setReqJson] = useState(
    project.context?.requirementsLinks ? JSON.stringify(project.context.requirementsLinks, null, 2) : "[]"
  );
  const [docRepoUrl, setDocRepoUrl] = useState(project.context?.documentRepositoryUrl ?? "");
  const [cloneUrl, setCloneUrl] = useState(project.repoScope?.cloneUrl ?? "");
  const [branchDefault, setBranchDefault] = useState(project.repoScope?.branchDefault ?? "main");
  const [teamId, setTeamId] = useState("");
  const [teams, setTeams] = useState<Team[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [users, setUsers] = useState<UserRow[]>([]);
  const [pmAgentId, setPmAgentId] = useState(project.pmOrchestratorAgentId ?? "");
  const [approverId, setApproverId] = useState(project.designatedApproverUserId ?? "");
  const [phase, setPhase] = useState(project.deliveryPhase ?? "");
  const [sdmAgentId, setSdmAgentId] = useState(
    project.roleAssignments?.find((r) => r.duty === "sdm_delivery")?.agentId ?? ""
  );
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [delivery, setDelivery] = useState<DeliverySummary | null>(null);
  const [deliveryBusy, setDeliveryBusy] = useState(false);
  const [workflows, setWorkflows] = useState<DeliveryWorkflowRow[]>([]);
  const [workflowDraftId, setWorkflowDraftId] = useState(project.workflowId ?? "");
  const [rootPath, setRootPath] = useState(project.repoScope?.rootPath ?? "");
  const [attachments, setAttachments] = useState<ProjectAttachmentMeta[]>([]);
  const [attachBusy, setAttachBusy] = useState(false);

  const loadDelivery = useCallback(async () => {
    try {
      const s = await api<DeliverySummary>(`/api/v1/projects/${project.id}/delivery/summary`);
      setDelivery(s);
    } catch {
      setDelivery(null);
    }
  }, [project.id]);

  useEffect(() => {
    setBrief(project.context?.brief ?? "");
    setGoals(project.context?.goals ?? "");
    setLinkRows(editingLinkRowsFromStored(project.context?.requirementsLinks));
    setReqJson(project.context?.requirementsLinks ? JSON.stringify(project.context.requirementsLinks, null, 2) : "[]");
    setDocRepoUrl(project.context?.documentRepositoryUrl ?? "");
    setCloneUrl(project.repoScope?.cloneUrl ?? "");
    setBranchDefault(project.repoScope?.branchDefault ?? "main");
    setPmAgentId(project.pmOrchestratorAgentId ?? "");
    setApproverId(project.designatedApproverUserId ?? "");
    setPhase(project.deliveryPhase ?? "");
    setSdmAgentId(project.roleAssignments?.find((r) => r.duty === "sdm_delivery")?.agentId ?? "");
    setRootPath(project.repoScope?.rootPath ?? "");
    setWorkflowDraftId(project.workflowId ?? "");
  }, [project]);

  useEffect(() => {
    void loadDelivery();
  }, [loadDelivery, project.implementationStatus, project.readyForUat]);

  const loadAttachments = useCallback(async () => {
    try {
      const { items } = await api<{ items: ProjectAttachmentMeta[] }>(
        `/api/v1/projects/${encodeURIComponent(project.id)}/attachments`
      );
      setAttachments(items);
    } catch {
      setAttachments([]);
    }
  }, [project.id]);

  useEffect(() => {
    void loadAttachments();
  }, [loadAttachments]);

  useEffect(() => {
    void (async () => {
      try {
        const { items } = await api<{ items: DeliveryWorkflowRow[] }>("/api/v1/delivery-workflows");
        setWorkflows(items);
      } catch {
        setWorkflows([]);
      }
    })();
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        const t = await api<Team[]>("/api/v1/teams");
        setTeams(t);
      } catch {
        setTeams([]);
      }
      try {
        const a = await api<Agent[]>("/api/v1/agents");
        setAgents(a);
      } catch {
        setAgents([]);
      }
      try {
        const u = await api<UserRow[]>("/api/v1/users");
        setUsers(u);
      } catch {
        setUsers([]);
      }
    })();
  }, []);

  /** When PM/SDM are unset on the project, prefill selects from linked team seats (same as former “Suggest”). */
  useEffect(() => {
    if (agents.length === 0 || project.teamLinks.length === 0) return;

    const sdmSaved = project.roleAssignments?.find((r) => r.duty === "sdm_delivery")?.agentId ?? null;
    const needsPm = !project.pmOrchestratorAgentId;
    const needsSdm = !sdmSaved;
    if (!needsPm && !needsSdm) return;

    let cancelled = false;
    void (async () => {
      try {
        const res = await api<SuggestedDeliveryAgentsResponse>(
          `/api/v1/projects/${encodeURIComponent(project.id)}/suggested-delivery-agents`
        );
        if (cancelled) return;
        setPmAgentId((prev) => {
          if (prev.trim() !== "") return prev;
          return res.pmOrchestratorAgentId ?? prev;
        });
        setSdmAgentId((prev) => {
          if (prev.trim() !== "") return prev;
          return res.sdmDeliveryAgentId ?? prev;
        });
      } catch {
        /* omit toast — settings still editable */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [
    agents.length,
    project.id,
    project.pmOrchestratorAgentId,
    project.roleAssignments,
    project.teamLinks.length,
  ]);

  const storedRequirementsSignature = JSON.stringify(project.context?.requirementsLinks ?? null);

  /** Goals, brief, document repo URL, and requirement rows persist shortly after edits (debounced). */
  useEffect(() => {
    if (
      intakeContextDraftMatchesStored(
        brief,
        goals,
        docRepoUrl,
        linkRows,
        project.context ?? undefined
      )
    ) {
      return;
    }

    const delayMs = 900;
    const tid = window.setTimeout(() => {
      void (async () => {
        try {
          await api(`/api/v1/projects/${project.id}/context`, {
            method: "PATCH",
            json: intakeContextDraftPatchPayload(brief, goals, docRepoUrl, linkRows),
          });
          setErr(null);
          await reloadProject();
        } catch (ex) {
          setErr(ex instanceof Error ? ex.message : "Save failed");
        }
      })();
    }, delayMs);
    return () => window.clearTimeout(tid);
  }, [
    brief,
    goals,
    docRepoUrl,
    linkRows,
    project.id,
    project.context?.brief,
    project.context?.goals,
    project.context?.documentRepositoryUrl,
    project.context,
    storedRequirementsSignature,
    reloadProject,
  ]);

  async function persistAndAddRequirementLinkRow() {
    const last = linkRows[linkRows.length - 1];
    if (!last.url.trim()) {
      setErr("Enter a URL in the last row before adding another link (label optional).");
      return;
    }
    setErr(null);
    try {
      await api(`/api/v1/projects/${project.id}/context`, {
        method: "PATCH",
        json: intakeContextDraftPatchPayload(brief, goals, docRepoUrl, linkRows),
      });
      await reloadProject();
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : "Save failed");
    }
  }

  function updateLinkRow(i: number, field: keyof LinkRow, value: string) {
    setLinkRows((rows) => rows.map((r, j) => (j === i ? { ...r, [field]: value } : r)));
  }

  async function saveReqJson(e: FormEvent) {
    e.preventDefault();
    setErr(null);
    setMsg(null);
    try {
      let links: unknown = [];
      try {
        links = JSON.parse(reqJson || "[]");
      } catch {
        throw new Error("Requirements links must be valid JSON array");
      }
      await api(`/api/v1/projects/${project.id}/context`, {
        method: "PATCH",
        json: { requirementsLinks: links as object[] },
      });
      setMsg("Requirements links (JSON) saved.");
      await reloadProject();
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : "Save failed");
    }
  }

  async function saveRepo(e: FormEvent) {
    e.preventDefault();
    setErr(null);
    setMsg(null);
    try {
      await api(`/api/v1/projects/${project.id}/repository-scope`, {
        method: "PATCH",
        json: {
          cloneUrl: cloneUrl.trim() === "" ? "" : cloneUrl,
          branchDefault: branchDefault || "main",
          rootPath: rootPath.trim() === "" ? "" : rootPath.trim(),
        },
      });
      setMsg("Repository scope saved.");
      await reloadProject();
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : "Save failed");
    }
  }

  async function saveProjectSettings(e: FormEvent) {
    e.preventDefault();
    setErr(null);
    setMsg(null);
    try {
      await api(`/api/v1/projects/${project.id}`, {
        method: "PATCH",
        json: {
          pmOrchestratorAgentId: pmAgentId || null,
          designatedApproverUserId: approverId || null,
          deliveryPhase: phase === "" ? null : (phase as "intake" | "design" | "delivery" | "sustain"),
        },
      });
      await api(`/api/v1/projects/${project.id}/role-assignments`, {
        method: "PUT",
        json: {
          assignments: [{ duty: "sdm_delivery", agentId: sdmAgentId || null }],
        },
      });
      setMsg("Project settings saved.");
      await reloadProject();
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : "Save failed");
    }
  }

  async function linkTeam(e: FormEvent) {
    e.preventDefault();
    if (!teamId) return;
    if (project.teamLinks.length >= 1) {
      setErr("Only one delivery team is allowed per project — unlink first, then link a different team.");
      return;
    }
    setErr(null);
    try {
      await api("/api/v1/team-projects", { method: "POST", json: { teamId, projectId: project.id } });
      setMsg("Team linked.");
      setTeamId("");
      await reloadProject();
    } catch (ex) {
      if (ex instanceof ApiError && ex.status === 409) {
        const code =
          typeof ex.body === "object" && ex.body !== null && "error" in ex.body
            ? (ex.body as { error?: { code?: string } }).error?.code
            : undefined;
        setErr(
          code === "PROJECT_TEAM_LIMIT"
            ? "A project can only have one linked team. Unlink the current team first."
            : "That team is already linked to this project."
        );
        return;
      }
      setErr(ex instanceof Error ? ex.message : "Link failed");
    }
  }

  async function unlinkTeam(teamIdRm: string) {
    setErr(null);
    setMsg(null);
    try {
      await api(
        `/api/v1/team-projects/${encodeURIComponent(project.id)}/${encodeURIComponent(teamIdRm)}`,
        { method: "DELETE" }
      );
      setMsg("Team unlinked.");
      await reloadProject();
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : "Unlink failed");
    }
  }

  async function uploadAttachmentFile(file: File) {
    setErr(null);
    setAttachBusy(true);
    try {
      const dataBase64 = await readFileAsBase64(file);
      await api(`/api/v1/projects/${encodeURIComponent(project.id)}/attachments`, {
        method: "POST",
        json: { fileName: file.name, mimeType: file.type || undefined, dataBase64 },
      });
      setMsg(`Uploaded ${file.name}.`);
      await loadAttachments();
      await reloadProject();
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : "Upload failed");
    } finally {
      setAttachBusy(false);
    }
  }

  async function saveIntakeAndLockBaseline() {
    setErr(null);
    setMsg(null);
    setDeliveryBusy(true);
    try {
      const links = serializeLinks(linkRows);
      const g = goals.trim();
      const b = brief.trim();
      const effectiveWfId = (workflowDraftId || project.workflowId || "").trim();
      const usesWorkflow = Boolean(workflowDraftId || project.workflowId);

      if (usesWorkflow) {
        if (!g || !b) {
          setErr("Goals and incoming brief are required before locking the baseline.");
          return;
        }
        if (!effectiveWfId) {
          setErr("Select a delivery workflow.");
          return;
        }
        const wf = workflows.find((w) => w.id === effectiveWfId);
        if (wf?.kind === "feature_dev" && !cloneUrl.trim() && !rootPath.trim()) {
          setErr("Feature workflow requires a clone URL or local root path — set them under Repository.");
          return;
        }
      } else if (!g && !b) {
        setErr("Save at least a brief or goals before locking the baseline.");
        return;
      }

      const teamOk = project.teamLinks.length > 0 || Boolean(teamId);
      if (!teamOk) {
        setErr("Link a delivery team (Intake → Delivery team) before locking the baseline.");
        return;
      }
      const pendingNewTeam =
        Boolean(teamId) && project.teamLinks.length > 0 && !project.teamLinks.some((l) => l.teamId === teamId);
      if (pendingNewTeam) {
        setErr(
          "Only one delivery team allowed — unlink the current team on Intake first, then link the team you chose in the dropdown."
        );
        return;
      }

      await api(`/api/v1/projects/${project.id}/context`, {
        method: "PATCH",
        json: {
          brief: b || null,
          goals: g || null,
          requirementsLinks: links,
          documentRepositoryUrl: docRepoUrl.trim() === "" ? "" : docRepoUrl.trim(),
        },
      });
      await api(`/api/v1/projects/${project.id}/repository-scope`, {
        method: "PATCH",
        json: {
          cloneUrl: cloneUrl.trim() === "" ? "" : cloneUrl,
          branchDefault: branchDefault || "main",
          rootPath: rootPath.trim() === "" ? "" : rootPath.trim(),
        },
      });
      if (usesWorkflow && effectiveWfId && effectiveWfId !== project.workflowId) {
        await api(`/api/v1/projects/${project.id}`, {
          method: "PATCH",
          json: { workflowId: effectiveWfId },
        });
      }
      if (teamId && !project.teamLinks.some((l) => l.teamId === teamId)) {
        await api("/api/v1/team-projects", { method: "POST", json: { teamId, projectId: project.id } });
      }

      await api(`/api/v1/projects/${project.id}`, {
        method: "PATCH",
        json: {
          pmOrchestratorAgentId: pmAgentId || null,
          designatedApproverUserId: approverId || null,
          deliveryPhase: phase === "" ? null : (phase as "intake" | "design" | "delivery" | "sustain"),
        },
      });
      await api(`/api/v1/projects/${project.id}/role-assignments`, {
        method: "PUT",
        json: {
          assignments: [{ duty: "sdm_delivery", agentId: sdmAgentId || null }],
        },
      });

      await reloadProject();

      const r = (await api(`/api/v1/projects/${project.id}/delivery/proceed`, { method: "POST" })) as {
        idempotent?: boolean;
        project?: { intakeBaselineAt?: string | null };
      };
      const when = r.project?.intakeBaselineAt
        ? new Date(r.project.intakeBaselineAt).toLocaleString()
        : "now";
      const next = usesWorkflow ? "Requirements" : "Backlog";
      const nextDetail = usesWorkflow ? "generate and approve the PRD next." : "run **Generate draft backlog** there.";
      setMsg(
        r.idempotent
          ? `Already baselined (${when}). Opening ${next}…`
          : `Intake baseline recorded (${when}). Opening ${next} — ${nextDetail}`
      );
      await reloadProject();
      await loadDelivery();
      navigate(usesWorkflow ? `/projects/${project.id}/requirements` : `/projects/${project.id}/backlog`);
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : "Request failed");
    } finally {
      setDeliveryBusy(false);
    }
  }

  const implStForBaseline = delivery?.implementationStatus ?? project.implementationStatus ?? "draft";
  const intakeBaselineRecorded = Boolean(project.intakeBaselineAt);
  const lockBaselineDisabled =
    deliveryBusy || !delivery || intakeBaselineRecorded || implStForBaseline !== "draft";

  const intakeFormDirty = useMemo(() => {
    const sg = (project.context?.goals ?? "").trim();
    const sb = (project.context?.brief ?? "").trim();
    if (goals.trim() !== sg || brief.trim() !== sb) return true;
    const serverDoc = (project.context?.documentRepositoryUrl ?? "").trim();
    if (docRepoUrl.trim() !== serverDoc) return true;
    const serverLinks = JSON.stringify(serializeLinks(parseStoredRequirementsLinks(project.context?.requirementsLinks)));
    if (JSON.stringify(serializeLinks(linkRows)) !== serverLinks) return true;
    const sc = (project.repoScope?.cloneUrl ?? "").trim();
    const sr = (project.repoScope?.rootPath ?? "").trim();
    const sbd = (project.repoScope?.branchDefault ?? "main").trim();
    if (cloneUrl.trim() !== sc || rootPath.trim() !== sr || (branchDefault || "main").trim() !== sbd) return true;
    if ((pmAgentId || "") !== (project.pmOrchestratorAgentId ?? "")) return true;
    if ((approverId || "") !== (project.designatedApproverUserId ?? "")) return true;
    if ((phase || "") !== (project.deliveryPhase ?? "")) return true;
    if ((workflowDraftId || "") !== (project.workflowId ?? "")) return true;
    const sdmSaved = project.roleAssignments?.find((r) => r.duty === "sdm_delivery")?.agentId ?? "";
    if ((sdmAgentId || "") !== sdmSaved) return true;
    return false;
  }, [
    project,
    goals,
    brief,
    docRepoUrl,
    linkRows,
    cloneUrl,
    rootPath,
    branchDefault,
    pmAgentId,
    approverId,
    phase,
    workflowDraftId,
    sdmAgentId,
  ]);

  return (
    <div data-testid="project-intake">
      {project.teamLinks.length === 0 ? (
        <div className="callout-card" data-testid="intake-link-team-hint" style={{ marginBottom: "1rem" }}>
          <p style={{ margin: 0, fontSize: "0.9rem", lineHeight: 1.5 }}>
            <strong>Finish setup:</strong> link exactly one delivery team below so Plan/Board can use seats from that
            team. Create teams under <Link to="/organization/teams">Organization → Teams</Link> and{" "}
            <Link to="/agents">Work → Agents</Link>; only one team may be linked per project.
          </p>
        </div>
      ) : null}
      <p className="muted" style={{ marginBottom: "1rem" }}>
        Work top to bottom: fill goals &amp; brief (they save automatically after you pause typing), repository, project settings,
        and link a delivery team — then use <strong>Save intake &amp; lock baseline</strong> under Begin delivery (persists repo,
        PM/SDM settings, team link, records the baseline, and opens Requirements or Backlog). Use{" "}
        <strong>Save repository scope</strong> whenever you edit clone URL only.
      </p>
      <div className="card">
        <h2>Goals &amp; brief</h2>
        <p className="muted" style={{ fontSize: "0.88rem", marginTop: "-0.25rem" }}>
          Goals, incoming brief, and document repository URL auto-save (~1&nbsp;s pause after edits).
        </p>
        <div>
          <label>
            Project goals
            <textarea
              value={goals}
              onChange={(e) => setGoals(e.target.value)}
              data-testid="project-goals"
              placeholder="Outcomes and success criteria…"
            />
          </label>
          <label>
            Incoming requirement / brief
            <textarea value={brief} onChange={(e) => setBrief(e.target.value)} data-testid="project-brief" />
          </label>
          <label>
            Document repository URL (wiki, Confluence, second git remote…)
            <input
              type="url"
              value={docRepoUrl}
              onChange={(e) => setDocRepoUrl(e.target.value)}
              data-testid="project-doc-repo-url"
              placeholder="https://…"
            />
          </label>
          <h3 style={{ marginTop: "1rem" }}>Requirement &amp; doc links</h3>
          <p className="muted" style={{ fontSize: "0.9rem" }}>
            Typing persists automatically (~1&nbsp;s pause). Requirement rows need a <strong>URL</strong>; label optional.{" "}
            <strong>Add link</strong> saves all links now (same as autosave), then clears the staging row below for another URL.
          </p>
          {linkRows.map((row, i) => (
            <div key={i} className="row" style={{ alignItems: "flex-end", marginBottom: "0.5rem", gap: "0.5rem" }}>
              <label style={{ flex: 1 }}>
                Label
                <input
                  value={row.label}
                  onChange={(e) => updateLinkRow(i, "label", e.target.value)}
                  data-testid={`req-link-label-${i}`}
                  placeholder="PRD, Confluence…"
                />
              </label>
              <label style={{ flex: 2 }}>
                URL
                <input
                  type="url"
                  value={row.url}
                  onChange={(e) => updateLinkRow(i, "url", e.target.value)}
                  data-testid={`req-link-url-${i}`}
                  placeholder="https://…"
                />
              </label>
            </div>
          ))}
          <button
            type="button"
            className="secondary"
            data-testid="add-requirement-link-row"
            onClick={() => void persistAndAddRequirementLinkRow()}
          >
            Add link
          </button>
        </div>
        <details style={{ marginTop: "1rem" }}>
          <summary>Advanced: edit raw JSON</summary>
          <form onSubmit={saveReqJson}>
            <label>
              Requirements links (JSON array)
              <textarea value={reqJson} onChange={(e) => setReqJson(e.target.value)} data-testid="project-req-json" />
            </label>
            <button type="submit" className="secondary">
              Save JSON only
            </button>
          </form>
        </details>
      </div>
      <div className="card">
        <h2>Delivery workflow</h2>
        <p className="muted" style={{ fontSize: "0.88rem", marginTop: "-0.25rem" }}>
          Workflow projects use <strong>Requirements (PRD)</strong> before design and backlog. Legacy projects leave this unset
          and keep the SDM path on <Link to={`/projects/${project.id}/backlog`}>Backlog</Link>.
        </p>
        <label>
          Template
          <select
            value={workflowDraftId}
            onChange={(e) => setWorkflowDraftId(e.target.value)}
            data-testid="intake-workflow-select"
          >
            <option value="">— None (legacy) —</option>
            {workflows.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name} ({w.kind})
              </option>
            ))}
          </select>
        </label>
        {workflowDraftId ?
          <p className="muted" style={{ fontSize: "0.82rem", marginTop: "0.5rem" }}>
            {workflows.find((w) => w.id === workflowDraftId)?.description?.trim() || (
              <>
                <strong>{workflows.find((w) => w.id === workflowDraftId)?.kind}</strong> —{" "}
                {workflows.find((w) => w.id === workflowDraftId)?.kind === "feature_dev" ?
                  "requires clone URL or local root path below."
                : "greenfield path; repo optional unless you want Git integration."}
              </>
            )}
          </p>
        : null}
      </div>
      <div className="card">
        <h2>Repository (code)</h2>
        <form onSubmit={saveRepo}>
          <label>
            Clone URL (optional)
            <input
              value={cloneUrl}
              onChange={(e) => setCloneUrl(e.target.value)}
              data-testid="project-clone-url"
              placeholder="https://github.com/org/repo.git"
            />
          </label>
          <label>
            Local root path (optional)
            <input
              value={rootPath}
              onChange={(e) => setRootPath(e.target.value)}
              data-testid="project-root-path"
              placeholder="/Users/you/code/my-repo"
            />
          </label>
          <label>
            Default branch
            <input value={branchDefault} onChange={(e) => setBranchDefault(e.target.value)} data-testid="project-branch" />
          </label>
          <button type="submit" className="secondary" data-testid="save-repo">
            Save repo scope
          </button>
        </form>
      </div>
      <div className="card">
        <h2>Attachments</h2>
        <p className="muted" style={{ fontSize: "0.88rem" }}>
          Upload supporting files (stored on the project). Optional for legacy; helpful for PRD context when using a workflow.
        </p>
        <label>
          Add file
          <input
            type="file"
            disabled={attachBusy}
            data-testid="intake-attachment-input"
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = "";
              if (f) void uploadAttachmentFile(f);
            }}
          />
        </label>
        {attachments.length === 0 ?
          <p className="muted" style={{ marginTop: "0.5rem" }}>
            No attachments yet.
          </p>
        : (
          <ul style={{ marginTop: "0.5rem", fontSize: "0.88rem" }}>
            {attachments.map((a) => (
              <li key={a.id}>
                {a.fileName}{" "}
                <span className="muted">
                  ({a.byteSize} bytes · {new Date(a.createdAt).toLocaleString()})
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="card">
        <h2>Project settings — agents</h2>
        <p className="muted" style={{ fontSize: "0.88rem", marginTop: "-0.25rem" }}>
          When PM orchestrator or SDM delivery agent is not saved on the project yet, the dropdowns default to seated
          agents from the <strong>linked delivery team</strong> (PM / SDM role templates, stable ordering). Override
          anytime; <strong>Save project settings</strong> persists.
        </p>
        <form onSubmit={saveProjectSettings}>
          <label>
            PM orchestrator agent
            <select value={pmAgentId} onChange={(e) => setPmAgentId(e.target.value)} data-testid="project-pm-agent">
              <option value="">— None —</option>
              {agents.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Designated approver (user)
            <select value={approverId} onChange={(e) => setApproverId(e.target.value)} data-testid="project-approver">
              <option value="">— None —</option>
              {users.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.email}
                </option>
              ))}
            </select>
          </label>
          <label>
            Delivery phase
            <select value={phase} onChange={(e) => setPhase(e.target.value)} data-testid="project-phase">
              <option value="">—</option>
              <option value="intake">intake</option>
              <option value="design">design</option>
              <option value="delivery">delivery</option>
              <option value="sustain">sustain</option>
            </select>
          </label>
          <label>
            SDM delivery agent (seat narrative)
            <select value={sdmAgentId} onChange={(e) => setSdmAgentId(e.target.value)} data-testid="project-sdm-agent">
              <option value="">— None —</option>
              {agents.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          </label>
          <button type="submit" className="primary" data-testid="save-project-settings">
            Save project settings
          </button>
        </form>
      </div>
      <div className="card">
        <h2>Delivery team</h2>
        <p className="muted" style={{ fontSize: "0.88rem", marginTop: "-0.25rem" }}>
          Exactly <strong>one</strong> team may be linked. Unlink to switch teams.
        </p>
        {project.teamLinks.length > 1 ? (
          <p className="err" style={{ fontSize: "0.88rem", marginBottom: "0.5rem" }}>
            Multiple teams were linked historically — unlink until only one remains to match routing rules.
          </p>
        ) : null}
        <ul style={{ paddingLeft: "1.1rem", margin: "0 0 0.75rem" }}>
          {project.teamLinks.map((l) => (
            <li key={l.teamId}>
              <div className="row" style={{ alignItems: "center", gap: "0.75rem", flexWrap: "wrap", marginBottom: "0.35rem" }}>
                <span>
                  {l.team.name} <small className="muted">{l.teamId}</small>
                </span>
                <button
                  type="button"
                  className="secondary"
                  data-testid={`unlink-team-${l.teamId}`}
                  onClick={() => void unlinkTeam(l.teamId)}
                >
                  Unlink
                </button>
              </div>
            </li>
          ))}
        </ul>
        {project.teamLinks.length === 0 ?
          <form className="row" onSubmit={linkTeam}>
            <label>
              Team
              <select value={teamId} onChange={(e) => setTeamId(e.target.value)} data-testid="link-team-select">
                <option value="">—</option>
                {teams.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
            </label>
            <button type="submit" className="secondary" disabled={!teamId} data-testid="link-team">
              Link team
            </button>
          </form>
        : null}
      </div>
      {intakeFormDirty ? (
        <p
          className="callout-card"
          data-testid="intake-dirty-banner"
          style={{ marginBottom: "0.75rem", fontSize: "0.88rem" }}
        >
          You have unsaved changes on this tab (repository, workflow, agents, …). Goals, brief, and requirement links autosave —
          pause typing so patches finish before baseline.{" "}
          <strong>Save intake &amp; lock baseline</strong> persists repository, workflow (if staged), PM/SDM settings, and
          delivery team link, then records the baseline.
        </p>
      ) : null}
      <div id="begin-delivery" className="card" data-testid="delivery-pipeline">
        <h2>Begin delivery</h2>
        <p className="muted" style={{ fontSize: "0.88rem", marginTop: "-0.25rem" }}>
          Use <strong>Save intake &amp; lock baseline</strong> when repository, workflow (if used), delivery team link, PM
          orchestrator, and any autosaved intake text look right. That PATCH saves repo/scope/settings, records the baseline,
          and routes you to <strong>{project.workflowId || workflowDraftId ? "Requirements" : "Backlog"}</strong>. Goals,
          brief, and links save on their own after you pause (~1&nbsp;s). You can still use{" "}
          <strong>Save project settings</strong> alone for agents / phase without locking the baseline.
        </p>
        {(() => {
          const st = delivery?.implementationStatus ?? project.implementationStatus ?? "draft";
          const intakeOk = Boolean(project.context?.brief?.trim() || project.context?.goals?.trim());
          const baselineDone = Boolean(project.intakeBaselineAt) || st !== "draft";
          const draftsExist = (delivery?.draftProposals ?? 0) > 0;
          const proposedOrLater =
            st === "backlog_proposed" ||
            st === "backlog_approved" ||
            st === "executing" ||
            st === "ready_for_uat" ||
            st === "closed";
          const prdApproved = Boolean(project.prdSummary?.approved);
          const designApproved = project.designArtifacts?.some((a) => a.status === "approved") ?? false;
          const backlogAcceptedOrLater =
            st === "backlog_approved" ||
            st === "executing" ||
            st === "ready_for_uat" ||
            st === "closed";
          const usesWorkflow = Boolean(project.workflowId);
          const steps: { label: string; done: boolean; hint?: string }[] = usesWorkflow
            ? [
                { label: "Add goals & brief on Intake", done: intakeOk, hint: "Typing autosaves (~1 s after edits). Requirement links need a URL in each row." },
                {
                  label: "Save intake & lock baseline (Begin delivery)",
                  done: baselineDone,
                  hint: "Then open Requirements to generate and approve the PRD.",
                },
                {
                  label: "Approve PRD (Requirements tab)",
                  done: prdApproved,
                  hint: "Generate / refresh PRD, then approve when ready — unlocks design.",
                },
                {
                  label: "Approve design (Design tab)",
                  done: designApproved,
                  hint: "Generate from approved PRD, then approve an artifact — unlocks backlog generation.",
                },
                {
                  label: "Backlog → Plan → Board",
                  done: backlogAcceptedOrLater,
                  hint: "Generate backlog drafts on Backlog, accept them, publish from Plan, then use Board when executing.",
                },
              ]
            : [
                { label: "Add goals & brief on Intake", done: intakeOk, hint: "Typing autosaves (~1 s after edits). Requirement links need a URL in each row." },
                { label: "Save intake & lock baseline (Begin delivery)", done: baselineDone, hint: "Then continue on Backlog." },
                { label: "Generate & review drafts (Backlog tab)", done: draftsExist || proposedOrLater, hint: "LLM uses saved goals & brief." },
                {
                  label: "Design → Plan → execution",
                  done: st === "executing" || st === "ready_for_uat" || st === "closed",
                  hint: "Approve design, then publish the board from Plan when ready.",
                },
              ];
          return (
            <ol style={{ margin: "0.75rem 0 1rem", paddingLeft: "1.25rem", lineHeight: 1.65, fontSize: "0.9rem" }}>
              {steps.map((s, i) => (
                <li key={i} style={{ color: s.done ? "var(--ok, #0a0)" : undefined }}>
                  <strong>{s.label}</strong>
                  {s.done ? " — done" : ""}
                  {s.hint ? (
                    <span className="muted" style={{ display: "block", fontSize: "0.85rem" }}>
                      {s.hint}
                    </span>
                  ) : null}
                </li>
              ))}
            </ol>
          );
        })()}
        {delivery ? (
          <>
            <p style={{ fontSize: "0.88rem", marginBottom: "0.35rem" }}>
              <strong>Readiness</strong> (all must pass before baseline):
            </p>
            <ul className="muted" style={{ fontSize: "0.85rem", margin: "0 0 1rem", paddingLeft: "1.1rem" }}>
              {delivery.readiness.checks.map((c) => (
                <li key={c.id} style={{ color: c.ok ? undefined : "var(--err, #c00)" }}>
                  {c.detail}
                </li>
              ))}
            </ul>
          </>
        ) : (
          <p className="muted">Loading pipeline state…</p>
        )}
        {delivery?.backlogFeedbackNotes ? (
          <p className="callout-card" style={{ fontSize: "0.88rem" }}>
            <strong>Last backlog feedback:</strong> {delivery.backlogFeedbackNotes}
          </p>
        ) : null}
        <div className="row" style={{ flexWrap: "wrap", gap: "0.5rem", alignItems: "center", marginBottom: "0.75rem" }}>
          <button
            type="button"
            className="primary"
            data-testid="delivery-proceed"
            disabled={lockBaselineDisabled}
            title="Saves goals/brief, links, repository, workflow (if any), and pending team link — then records the intake baseline and opens the next tab."
            onClick={() => void saveIntakeAndLockBaseline()}
          >
            {deliveryBusy ? "Saving…" : "Save intake & lock baseline"}
          </button>
          <span className="muted" style={{ fontSize: "0.82rem", maxWidth: "28rem" }}>
            After success, you go to{" "}
            <strong>{project.workflowId || workflowDraftId ? "Requirements" : "Backlog"}</strong>
            {project.workflowId || workflowDraftId ? " to start the PRD." : " for PM propose."} Disabled after the baseline
            is recorded or once delivery has left <strong>draft</strong>.
          </span>
        </div>
        <p className="muted" style={{ fontSize: "0.88rem", marginBottom: "0.75rem" }}>
          {project.workflowId ? (
            <>
              Pipeline tabs:{" "}
              <Link to={`/projects/${project.id}/requirements`}>
                <strong>Requirements</strong>
              </Link>{" "}
              (PRD),{" "}
              <Link to={`/projects/${project.id}/design`}>
                <strong>Design</strong>
              </Link>
              ,{" "}
              <Link to={`/projects/${project.id}/backlog`}>
                <strong>Backlog</strong>
              </Link>{" "}
              (drafts from PRD + design),{" "}
              <Link to={`/projects/${project.id}/plan`}>
                <strong>Plan &amp; backlog</strong>
              </Link>
              , and{" "}
              <Link to={`/projects/${project.id}/board`}>
                <strong>Board</strong>
              </Link>
              .
            </>
          ) : (
            <>
              Draft backlog, accept/reject, and publish are handled on{" "}
              <Link to={`/projects/${project.id}/backlog`}>
                <strong>Backlog</strong>
              </Link>{" "}
              and{" "}
              <Link to={`/projects/${project.id}/plan`}>
                <strong>Plan &amp; backlog</strong>
              </Link>
              .
            </>
          )}
        </p>
        {delivery && delivery.blockedTasks.length > 0 ? (
          <div style={{ marginTop: "1rem" }}>
            <h3 style={{ fontSize: "1rem" }}>Blocked tasks (execution)</h3>
            <ul style={{ margin: "0.35rem 0 0", paddingLeft: "1.1rem", fontSize: "0.88rem" }}>
              {delivery.blockedTasks.map((t) => (
                <li key={t.id}>
                  <strong>{t.title}</strong> ({t.state}) — {t.blockedReason ?? "blocked"}{" "}
                  {t.escalationStrikes > 0 ? `· strikes ${t.escalationStrikes}` : null}
                </li>
              ))}
            </ul>
            <p className="muted" style={{ fontSize: "0.82rem", marginTop: "0.35rem" }}>
              Clear via <code>PATCH /api/v1/tasks/:id</code> or tooling.
            </p>
          </div>
        ) : null}
      </div>
      {msg ? (
        <p className="ok" data-testid="overview-msg">
          {msg}
        </p>
      ) : null}
      {err ? <p className="err">{err}</p> : null}
    </div>
  );
}

type ProjectGateAuditRow = {
  id: string;
  action: string;
  resourceRef: string;
  createdAt: string;
  actor: { email: string };
};

export function ProjectActivityLogTab() {
  const { project } = useProjectOutlet();
  const [auditEvents, setAuditEvents] = useState<ProjectGateAuditRow[]>([]);

  const loadAuditEvents = useCallback(async () => {
    try {
      const { items } = await api<{ items: ProjectGateAuditRow[] }>(
        `/api/v1/projects/${encodeURIComponent(project.id)}/audit-events`
      );
      setAuditEvents(items);
    } catch {
      setAuditEvents([]);
    }
  }, [project.id]);

  useEffect(() => {
    void loadAuditEvents();
  }, [loadAuditEvents, project.intakeBaselineAt, project.implementationStatus]);

  return (
    <div data-testid="project-activity-log-tab">
      <div className="callout-card" style={{ marginBottom: "1rem", fontSize: "0.9rem", lineHeight: 1.55 }}>
        Delivery-related audit rows for this project (baseline, UAT, backlog actions, orchestration-linked events, …).
      </div>
      <div className="card" data-testid="project-activity-feed">
        <h2 style={{ marginTop: 0, fontSize: "1.1rem" }}>Activity log</h2>
        <p className="muted" style={{ fontSize: "0.82rem", marginTop: "-0.25rem" }}>
          Recent delivery gates (baseline, UAT, close, GitHub publish).
        </p>
        {auditEvents.length === 0 ? (
          <p className="muted" style={{ fontSize: "0.85rem" }}>No gate events yet.</p>
        ) : (
          <ul style={{ margin: "0.35rem 0 0", paddingLeft: "1.1rem", fontSize: "0.85rem", lineHeight: 1.5 }}>
            {auditEvents.map((ev) => (
              <li key={ev.id}>
                <strong>{ev.action}</strong> — {new Date(ev.createdAt).toLocaleString()} ({ev.actor.email})
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

export function ProjectRequirementsTab() {
  const navigate = useNavigate();
  const { projectId = "" } = useParams();
  const { project, reloadProject } = useProjectOutlet();
  const [items, setItems] = useState<PrdArtifactRow[]>([]);
  const [feedback, setFeedback] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    const { items: rows } = await api<{ items: PrdArtifactRow[] }>(
      `/api/v1/projects/${encodeURIComponent(projectId)}/prd`
    );
    setItems(rows);
  }, [projectId]);

  useEffect(() => {
    void load().catch(() => setItems([]));
  }, [load]);

  async function generatePrd() {
    setBusy(true);
    setErr(null);
    setMsg(null);
    try {
      await api(`/api/v1/projects/${encodeURIComponent(projectId)}/prd/generate-llm`, {
        method: "POST",
        json: { feedbackNotes: feedback.trim() || undefined },
      });
      setMsg("PRD draft generated or refreshed.");
      setFeedback("");
      await load();
      await reloadProject();
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : "Generate failed");
    } finally {
      setBusy(false);
    }
  }

  async function approveLatestDraft() {
    setBusy(true);
    setErr(null);
    setMsg(null);
    try {
      await api(`/api/v1/projects/${encodeURIComponent(projectId)}/prd/approve`, { method: "POST", json: {} });
      await load();
      await reloadProject();
      navigate(`/projects/${encodeURIComponent(projectId)}/design`);
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : "Approve failed");
    } finally {
      setBusy(false);
    }
  }

  if (!project.workflowId) {
    return (
      <div data-testid="project-requirements">
        <div className="callout-card">
          <p style={{ margin: 0, fontSize: "0.92rem", lineHeight: 1.55 }}>
            No delivery workflow is assigned — this project uses the <strong>legacy</strong> path. Capture requirements via PM
            propose on the <Link to={`/projects/${project.id}/backlog`}>Backlog</Link> tab instead of a formal PRD.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div data-testid="project-requirements">
      <div className="callout-card" style={{ marginBottom: "1rem", fontSize: "0.9rem", lineHeight: 1.55 }}>
        Generate a PRD draft from intake context, iterate with feedback, then <strong>Approve PRD</strong> to unlock SDM design
        generation.
      </div>
      <div className="card">
        <h2>PRD draft</h2>
        <label>
          Feedback for next generation (optional)
          <textarea
            value={feedback}
            onChange={(e) => setFeedback(e.target.value)}
            rows={4}
            data-testid="prd-feedback"
            placeholder="What to change, missing sections, constraints…"
          />
        </label>
        <div className="row" style={{ gap: "0.5rem", flexWrap: "wrap", marginTop: "0.75rem" }}>
          <button type="button" className="primary" data-testid="prd-generate" disabled={busy} onClick={() => void generatePrd()}>
            {busy ? "Working…" : "Generate / refresh PRD"}
          </button>
          <button type="button" className="secondary" data-testid="prd-approve" disabled={busy} onClick={() => void approveLatestDraft()}>
            Approve PRD → Design
          </button>
        </div>
        {msg ? (
          <p className="ok" style={{ marginTop: "0.75rem" }}>
            {msg}
          </p>
        ) : null}
        {err ? (
          <p className="err" style={{ marginTop: "0.75rem" }}>
            {err}
          </p>
        ) : null}
      </div>
      <div className="card">
        <h2>Versions</h2>
        {items.length === 0 ?
          <p className="muted">No PRD rows yet — generate above.</p>
        : (
          <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
            {items.map((r) => (
              <li
                key={r.id}
                style={{
                  borderBottom: "1px solid var(--border)",
                  padding: "0.65rem 0",
                  fontSize: "0.88rem",
                }}
              >
                <strong>{r.title}</strong>{" "}
                <span className="muted">
                  ({r.status}) · updated {new Date(r.updatedAt).toLocaleString()}
                </span>
                <details style={{ marginTop: "0.35rem" }}>
                  <summary className="muted" style={{ cursor: "pointer", fontSize: "0.82rem" }}>
                    Body preview
                  </summary>
                  <pre
                    style={{
                      whiteSpace: "pre-wrap",
                      fontSize: "0.78rem",
                      maxHeight: "14rem",
                      overflow: "auto",
                      margin: "0.35rem 0 0",
                    }}
                  >
                    {r.body}
                  </pre>
                </details>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

export function ProjectDesignTab() {
  const { project, reloadProject } = useProjectOutlet();
  const [analysisNotes, setAnalysisNotes] = useState(project.context?.analysisNotes ?? "");
  const [artifacts, setArtifacts] = useState<DesignArtifact[]>([]);
  /** Draft artifact bodies while editing (synced from server when ids appear). */
  const [artifactBodies, setArtifactBodies] = useState<Record<string, string>>({});
  const [savingArtifactId, setSavingArtifactId] = useState<string | null>(null);
  const [newTitle, setNewTitle] = useState("Design note");
  const [newBody, setNewBody] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [designGenBusy, setDesignGenBusy] = useState(false);
  const [designExtraInstructions, setDesignExtraInstructions] = useState("");

  useEffect(() => {
    setAnalysisNotes(project.context?.analysisNotes ?? "");
  }, [project]);

  const loadArtifacts = useCallback(async () => {
    const { items } = await api<{ items: DesignArtifact[] }>(
      `/api/v1/projects/${encodeURIComponent(project.id)}/design-artifacts`
    );
    setArtifacts(items);
  }, [project.id]);

  useEffect(() => {
    void loadArtifacts().catch(() => setArtifacts([]));
  }, [loadArtifacts]);

  useEffect(() => {
    setArtifactBodies((prev) => {
      const next = { ...prev };
      for (const a of artifacts) {
        if (!(a.id in next)) next[a.id] = a.body;
      }
      for (const id of Object.keys(next)) {
        if (!artifacts.some((a) => a.id === id)) delete next[id];
      }
      return next;
    });
  }, [artifacts]);

  async function save(e: FormEvent) {
    e.preventDefault();
    setErr(null);
    setMsg(null);
    try {
      await api(`/api/v1/projects/${project.id}/context`, {
        method: "PATCH",
        json: { analysisNotes: analysisNotes || null },
      });
      setMsg("Design notes saved.");
      await reloadProject();
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : "Save failed");
    }
  }

  async function createArtifact(e: FormEvent) {
    e.preventDefault();
    setErr(null);
    try {
      await api(`/api/v1/projects/${project.id}/design-artifacts`, {
        method: "POST",
        json: { title: newTitle, body: newBody },
      });
      setNewBody("");
      await loadArtifacts();
      await reloadProject();
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : "Create failed");
    }
  }

  async function saveArtifactBody(id: string) {
    setErr(null);
    setMsg(null);
    const body = artifactBodies[id];
    if (body === undefined) return;
    setSavingArtifactId(id);
    try {
      const row = await api<DesignArtifact>(`/api/v1/design-artifacts/${encodeURIComponent(id)}`, {
        method: "PATCH",
        json: { body },
      });
      setArtifactBodies((b) => ({ ...b, [id]: row.body }));
      setMsg("Design artifact saved.");
      await loadArtifacts();
      await reloadProject();
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : "Save failed");
    } finally {
      setSavingArtifactId(null);
    }
  }

  async function approveArtifact(id: string) {
    setErr(null);
    try {
      const body = artifactBodies[id];
      await api(`/api/v1/design-artifacts/${encodeURIComponent(id)}`, {
        method: "PATCH",
        json: {
          status: "approved",
          ...(body !== undefined ? { body } : {}),
        },
      });
      await loadArtifacts();
      await reloadProject();
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : "Update failed");
    }
  }

  const st = project.implementationStatus ?? "draft";
  const designEarly = st === "draft" || st === "delivery_active";
  const usesWorkflow = Boolean(project.workflowId);
  const prdApproved = Boolean(project.prdSummary?.approved);
  const canSdmDesign = ["backlog_approved", "executing", "ready_for_uat", "closed"].includes(st);
  const allowDesignGenerate = usesWorkflow ? prdApproved : canSdmDesign;
  const hasApprovedDesign = artifacts.some((a) => a.status === "approved");
  const approvedPrdForWatermark = project.prdSummary?.approved ?? null;
  const designLlmWatermark = readDesignLlmPrdWatermark(project.deliveryPolicy);
  const canReRegenerateDesign =
    !hasApprovedDesign ||
    Boolean(designExtraInstructions.trim()) ||
    Boolean(
      approvedPrdForWatermark &&
        designLlmWatermark &&
        approvedPrdForWatermark.updatedAt !== designLlmWatermark
    );

  async function generateDesignFromLlm() {
    setErr(null);
    setMsg(null);
    setDesignGenBusy(true);
    try {
      const trimmed = designExtraInstructions.trim();
      const res = await api<{ artifact: DesignArtifact; usedLlm: boolean; modelLabel: string }>(
        `/api/v1/projects/${encodeURIComponent(project.id)}/design-artifacts/generate-llm`,
        {
          method: "POST",
          json: trimmed ? { extraInstructions: trimmed } : {},
        }
      );
      setMsg(
        `Design draft created with **${res.modelLabel}** (${res.usedLlm ? "live LLM" : "test stub"}). Review and **Mark approved** when human sign-off is complete.`
      );
      setDesignExtraInstructions("");
      await loadArtifacts();
      await reloadProject();
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : "Design generation failed");
    } finally {
      setDesignGenBusy(false);
    }
  }

  return (
    <div data-testid="project-design">
      {designEarly ? (
        <div className="callout-card" style={{ marginBottom: "1rem", fontSize: "0.9rem", lineHeight: 1.5 }}>
          {usesWorkflow ?
            <>
              <strong>Suggested order:</strong> finish <Link to={`/projects/${project.id}/intake`}>Intake</Link>, approve a PRD
              on <Link to={`/projects/${project.id}/requirements`}>Requirements</Link>, then generate design here after PRD
              approval.
            </>
          : <>
              <strong>Suggested order:</strong> finish{" "}
              <Link to={`/projects/${project.id}/intake#begin-delivery`}>
                Intake → Begin delivery
              </Link>{" "}
              and <Link to={`/projects/${project.id}/backlog`}>Backlog</Link> (accept drafts) before SDM-led design here.
            </>}
        </div>
      ) : null}
      {allowDesignGenerate ? (
        <div className="card" style={{ marginBottom: "1rem" }} data-testid="design-llm-generate-card">
          <h2>{hasApprovedDesign ? "Re-generate design (LLM)" : usesWorkflow ? "Generate design (LLM)" : "SDM · Generate design (LLM)"}</h2>
          <p className="muted" style={{ fontSize: "0.88rem" }}>
            {hasApprovedDesign ?
              <>
                After you <strong>mark a design as approved</strong>, run the model again only when the{" "}
                <strong>approved PRD changed</strong> (Requirements) or you add <strong>instructions</strong> below. Each run
                creates a new draft artifact.
              </>
            : usesWorkflow ?
              <>
                Creates the <strong>first draft</strong> from intake context and the <strong>approved PRD</strong>. Approve an
                artifact below before generating backlog on the Backlog tab.
              </>
            : <>
                Creates the <strong>first draft</strong> from intake context and accepted tasks. Optional instructions steer
                the model (constraints, format). Approve an artifact below before Plan recommends publishing execution.
              </>}
          </p>
          <label style={{ marginTop: "0.5rem", width: "100%", maxWidth: "100%" }}>
            <span className="muted" style={{ fontSize: "0.8rem" }}>
              {hasApprovedDesign ? "Instructions for this run (required unless the PRD changed)" : "Optional instructions for this run"}
            </span>
            <textarea
              className="design-artifact-scroll"
              value={designExtraInstructions}
              onChange={(e) => setDesignExtraInstructions(e.target.value)}
              placeholder={
                hasApprovedDesign ?
                  "e.g. PRD v2: address new compliance section; shorten deployment; answer open questions 3–5."
                : "e.g. Call out PCI scope, prefer REST over GraphQL, keep the doc under 2 pages."
              }
              data-testid="design-generate-extra-instructions"
              rows={hasApprovedDesign ? 6 : 4}
              spellCheck={true}
            />
          </label>
          <button
            type="button"
            className="primary"
            data-testid="design-generate-llm"
            disabled={designGenBusy || (hasApprovedDesign && !canReRegenerateDesign)}
            style={{ marginTop: "0.75rem" }}
            onClick={() => void generateDesignFromLlm()}
            title={
              hasApprovedDesign && !canReRegenerateDesign ?
                "Add instructions or update the approved PRD on Requirements first."
              : undefined
            }
          >
            {designGenBusy ? "Generating…" : hasApprovedDesign ? "Re-generate design" : "Generate design draft"}
          </button>
        </div>
      ) : null}
      {!allowDesignGenerate ? (
        <p className="muted" style={{ marginBottom: "1rem" }}>
          {usesWorkflow ?
            <>
              Generate design unlocks after a PRD is <strong>approved</strong> on the Requirements tab.
            </>
          : <>
              Generate design unlocks after backlog is <strong>approved</strong> (all draft items accepted on Backlog).
            </>}
        </p>
      ) : null}
      <p className="muted" style={{ marginBottom: "1rem" }}>
        Record architecture and design decisions; align artifacts to backlog items from the{" "}
        <Link to={`/projects/${project.id}/backlog`}>Backlog</Link> tab.
      </p>
      <div className="card">
        <h2>Analysis &amp; design</h2>
        <form onSubmit={save}>
          <label>
            Design notes
            <textarea
              value={analysisNotes}
              onChange={(e) => setAnalysisNotes(e.target.value)}
              data-testid="project-analysis-notes"
              placeholder="Architecture, tradeoffs, open questions…"
            />
          </label>
          <button type="submit" className="primary" data-testid="save-analysis">
            Save design notes
          </button>
        </form>
      </div>
      <div className="card">
        <h2>Design artifacts</h2>
        <p className="muted" style={{ fontSize: "0.9rem" }}>
          Lightweight HLD-lite records. Drafts are scrollable below. Only <strong>one</strong> artifact can be{" "}
          <strong>approved</strong> at a time; approving a draft supersedes the previous approval. Answer{" "}
          <strong>Open questions</strong> in the draft body (save), or re-run the LLM above when the PRD changes or you add
          instructions.
        </p>
        <form onSubmit={createArtifact}>
          <label>
            Title
            <input value={newTitle} onChange={(e) => setNewTitle(e.target.value)} data-testid="design-artifact-title" />
          </label>
          <label>
            Body
            <textarea value={newBody} onChange={(e) => setNewBody(e.target.value)} data-testid="design-artifact-body" />
          </label>
          <button type="submit" className="secondary" data-testid="design-artifact-add">
            Add artifact
          </button>
        </form>
        {artifacts.length === 0 ? (
          <p className="muted">No artifacts yet.</p>
        ) : (
          <ul style={{ listStyle: "none", padding: 0 }}>
            {artifacts.map((a) => (
              <li
                key={a.id}
                style={{ border: "1px solid var(--border)", borderRadius: 8, padding: "0.75rem", marginBottom: "0.5rem" }}
                data-testid={`design-artifact-${a.id}`}
              >
                <strong>{a.title}</strong>{" "}
                <span style={{ color: "var(--muted)", fontSize: "0.85rem" }}>({a.status})</span>
                {a.status === "superseded" ?
                  <p className="muted" style={{ fontSize: "0.82rem", marginTop: "0.5rem", marginBottom: 0 }}>
                    Superseded — another artifact is the active approved design.
                  </p>
                : null}
                {a.status === "draft" ? (
                  <>
                    <label style={{ marginTop: "0.5rem", width: "100%", maxWidth: "100%" }}>
                      <span className="muted" style={{ fontSize: "0.8rem" }}>
                        Body (scrollable; edit to answer open questions)
                      </span>
                      <textarea
                        className="design-artifact-scroll"
                        value={artifactBodies[a.id] ?? a.body}
                        onChange={(e) => setArtifactBodies((b) => ({ ...b, [a.id]: e.target.value }))}
                        data-testid={`design-artifact-body-edit-${a.id}`}
                        spellCheck={false}
                      />
                    </label>
                    <div className="row" style={{ marginTop: "0.5rem" }}>
                      <button
                        type="button"
                        className="secondary"
                        disabled={savingArtifactId === a.id}
                        onClick={() => void saveArtifactBody(a.id)}
                        data-testid={`design-artifact-save-${a.id}`}
                      >
                        {savingArtifactId === a.id ? "Saving…" : "Save changes"}
                      </button>
                      <button type="button" className="secondary" onClick={() => void approveArtifact(a.id)}>
                        Mark approved
                      </button>
                    </div>
                  </>
                ) : null}
                {a.status === "approved" || a.status === "superseded" ? (
                  <pre className="design-artifact-scroll" data-testid={`design-artifact-body-read-${a.id}`}>
                    {a.body}
                  </pre>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </div>
      {msg ? (
        <p className="ok" data-testid="design-msg">
          {msg}
        </p>
      ) : null}
      {err ? <p className="err">{err}</p> : null}
    </div>
  );
}

function LegacyProjectBacklogPanel() {
  const { projectId = "" } = useParams();
  const { project, reloadProject } = useProjectOutlet();
  const [text, setText] = useState("");
  const [items, setItems] = useState<Proposed[]>([]);
  const [summary, setSummary] = useState<DeliverySummary | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [rejectNotes, setRejectNotes] = useState("");
  const [proposePhase, setProposePhase] = useState<"idle" | "running" | "done">("idle");
  const [lastRunModel, setLastRunModel] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const loadSummary = useCallback(async () => {
    try {
      const s = await api<DeliverySummary>(`/api/v1/projects/${encodeURIComponent(projectId)}/delivery/summary`);
      setSummary(s);
    } catch {
      setSummary(null);
    }
  }, [projectId]);

  const refresh = useCallback(async () => {
    const { items: list } = await api<{ items: Proposed[] }>(
      `/api/v1/projects/${encodeURIComponent(projectId)}/proposed-backlog-items`
    );
    setItems(list);
  }, [projectId]);

  useEffect(() => {
    void loadSummary().catch(() => setSummary(null));
    void refresh().catch(() => setItems([]));
  }, [loadSummary, refresh]);

  const st = summary?.implementationStatus ?? project.implementationStatus ?? "draft";
  const canIntakePropose = st === "delivery_active" || st === "backlog_proposed";
  const draftRows = items.filter((i) => i.status === "draft");
  const modelConfigured = Boolean(summary?.proposeModelLabel?.trim());

  async function runIntakePropose() {
    setErr(null);
    setMsg(null);
    setProposePhase("running");
    setBusy(true);
    setLastRunModel(null);
    try {
      const res = await api<{
        proposed: unknown[];
        usedLlm: boolean;
        modelLabel: string;
      }>(`/api/v1/projects/${encodeURIComponent(projectId)}/delivery/pm-propose-intake`, {
        method: "POST",
        json: {},
      });
      const n = res.proposed?.length ?? 0;
      setLastRunModel(res.modelLabel);
      setProposePhase("done");
      setMsg(
        res.usedLlm
          ? `Finished: ${n} draft(s) using model **${res.modelLabel}**. Review the table below and accept or reject.`
          : `Finished: ${n} draft(s) via **${res.modelLabel}** (test stub).`
      );
      await refresh();
      await loadSummary();
      await reloadProject();
    } catch (ex) {
      setProposePhase("idle");
      setErr(ex instanceof Error ? ex.message : "Propose failed");
    } finally {
      setBusy(false);
    }
  }

  async function acceptDraft(id: string) {
    setErr(null);
    try {
      await api(`/api/v1/proposed-backlog-items/${encodeURIComponent(id)}/accept`, { method: "POST" });
      await refresh();
      await loadSummary();
      await reloadProject();
      setMsg("Item accepted as a task (backlog column).");
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : "Accept failed");
    }
  }

  async function acceptAllDrafts() {
    setErr(null);
    setBusy(true);
    try {
      await api(`/api/v1/projects/${encodeURIComponent(projectId)}/delivery/approve-backlog`, { method: "POST" });
      await refresh();
      await loadSummary();
      await reloadProject();
      setMsg("All drafts accepted as tasks. Next: **Design** tab to generate and approve design, then **Plan** to publish.");
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : "Bulk accept failed");
    } finally {
      setBusy(false);
    }
  }

  async function rejectAllDrafts() {
    setErr(null);
    setBusy(true);
    try {
      await api(`/api/v1/projects/${encodeURIComponent(projectId)}/delivery/reject-backlog`, {
        method: "POST",
        json: { notes: rejectNotes.trim() || undefined },
      });
      await refresh();
      await loadSummary();
      await reloadProject();
      setMsg("Drafts cleared. Refine Intake and generate again.");
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : "Reject failed");
    } finally {
      setBusy(false);
    }
  }

  async function proposeAdvanced(e: FormEvent) {
    e.preventDefault();
    setErr(null);
    setMsg(null);
    setBusy(true);
    setProposePhase("running");
    try {
      const res = await api<{ proposed: unknown[]; usedLlm: boolean; modelLabel: string }>(
        `/api/v1/projects/${encodeURIComponent(projectId)}/pm/propose`,
        {
          method: "POST",
          json: { requirementsText: text },
        }
      );
      const n = res.proposed?.length ?? 0;
      setLastRunModel(res.modelLabel);
      setProposePhase("done");
      setMsg(
        res.usedLlm
          ? `Advanced propose: ${n} draft(s) via **${res.modelLabel}**.`
          : `${n} draft(s) via **${res.modelLabel}** (stub).`
      );
      await refresh();
      await loadSummary();
      await reloadProject();
    } catch (ex) {
      setProposePhase("idle");
      setErr(ex instanceof Error ? ex.message : "Propose failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div data-testid="project-backlog">
      <div className="callout-card" style={{ marginBottom: "1rem", fontSize: "0.9rem", lineHeight: 1.55 }}>
        <strong>Flow:</strong> complete{" "}
        <Link to={`/projects/${project.id}/intake#begin-delivery`}>Intake → Save intake &amp; lock baseline</Link>
        , then use <strong>Generate draft backlog</strong> here. You will see which model runs, live status, and results in
        the table below. Accept line-by-line or all at once, then continue to Design.
      </div>

      <div className="card">
        <h2>Generate draft backlog (from Intake)</h2>
        <p className="muted" style={{ fontSize: "0.88rem" }}>
          Uses the goals &amp; brief saved on Intake. Pipeline status: <strong>{st}</strong>
          {summary?.proposeModelLabel ? (
            <>
              {" "}
              · PM model binding: <strong>{summary.proposeModelLabel}</strong>
            </>
          ) : (
            <span className="err"> · No model binding — add Admin → Model bindings before running.</span>
          )}
        </p>
        {proposePhase === "running" ? (
          <p className="ok" data-testid="sdm-propose-status" style={{ margin: "0.5rem 0" }}>
            Running… calling{" "}
            <strong>{modelConfigured ? (summary?.proposeModelLabel ?? "LLM") : "— (configure binding first)"}</strong> to
            produce backlog JSON. This may take a few seconds.
          </p>
        ) : null}
        {proposePhase === "done" && lastRunModel ? (
          <p className="ok" style={{ margin: "0.5rem 0" }}>
            Last run used: <strong>{lastRunModel}</strong>
          </p>
        ) : null}
        <button
          type="button"
          className="primary"
          data-testid="delivery-pm-propose"
          disabled={busy || !canIntakePropose || !modelConfigured}
          title={!canIntakePropose ? "Save intake & lock baseline on Intake first" : undefined}
          onClick={() => void runIntakePropose()}
        >
          {busy && proposePhase === "running" ? "Working…" : "Generate draft backlog"}
        </button>
        {!canIntakePropose ? (
          <p className="muted" style={{ fontSize: "0.85rem", marginTop: "0.5rem" }}>
            Baseline not recorded yet — open <Link to={`/projects/${project.id}/intake#begin-delivery`}>Intake</Link> and
            click <strong>Save intake &amp; lock baseline</strong>.
          </p>
        ) : null}
        {msg ? (
          <p className="ok" data-testid="sdm-main-msg" style={{ marginTop: "0.75rem" }}>
            {msg}
          </p>
        ) : null}
        {err ? (
          <p className="err" data-testid="sdm-main-err" style={{ marginTop: "0.75rem" }}>
            {err}
          </p>
        ) : null}
      </div>

      <div className="card">
        <h2>Draft backlog — accept or reject</h2>
        <p className="muted" style={{ fontSize: "0.88rem" }}>
          {draftRows.length} draft(s). Accepting the last draft moves the project to <strong>backlog_approved</strong> so
          Design unlocks.
        </p>
        <div className="row" style={{ flexWrap: "wrap", gap: "0.5rem", marginBottom: "0.75rem" }}>
          <button type="button" className="secondary" disabled={busy} onClick={() => void refresh()}>
            Refresh
          </button>
          <button
            type="button"
            className="secondary"
            disabled={busy || draftRows.length === 0 || st !== "backlog_proposed"}
            onClick={() => void acceptAllDrafts()}
          >
            Accept all drafts as tasks
          </button>
        </div>
        <label>
          Notes if rejecting all drafts
          <textarea
            value={rejectNotes}
            onChange={(e) => setRejectNotes(e.target.value)}
            rows={2}
            style={{ display: "block", width: "100%", marginTop: "0.35rem" }}
          />
        </label>
        <button
          type="button"
          className="secondary"
          disabled={busy || draftRows.length === 0 || st !== "backlog_proposed"}
          style={{ marginTop: "0.5rem" }}
          onClick={() => void rejectAllDrafts()}
        >
          Reject all drafts &amp; reset
        </button>
        {draftRows.length === 0 ? (
          <p className="muted" style={{ marginTop: "0.75rem" }}>
            No drafts — generate above (or nothing left to accept).
          </p>
        ) : (
          <table style={{ marginTop: "0.75rem", width: "100%", fontSize: "0.88rem" }}>
            <thead>
              <tr>
                <th style={{ textAlign: "left" }}>Title &amp; description</th>
                <th style={{ textAlign: "left" }}>Source</th>
                <th style={{ textAlign: "left" }}>Action</th>
              </tr>
            </thead>
            <tbody>
              {draftRows.map((it) => (
                <tr key={it.id}>
                  <ProposedDraftTitleCell it={it} />
                  <td className="muted">{it.source ?? "—"}</td>
                  <td>
                    <button
                      type="button"
                      className="primary"
                      data-testid={`accept-${it.id}`}
                      disabled={busy}
                      onClick={() => void acceptDraft(it.id)}
                    >
                      Accept
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="muted" style={{ fontSize: "0.85rem", marginTop: "0.75rem" }}>
          You can also fine-tune on <Link to={`/projects/${project.id}/plan`}>Plan &amp; backlog</Link>.
        </p>
      </div>

      <details className="card" style={{ marginTop: "1rem" }} data-testid="sdm-advanced-propose">
        <summary style={{ cursor: "pointer", fontWeight: 600 }}>Advanced: propose from custom text (legacy API)</summary>
        <p className="muted" style={{ fontSize: "0.88rem", marginTop: "0.5rem" }}>
          Same LLM stack as above, but sends this text instead of Intake goals/brief.
        </p>
        <form onSubmit={proposeAdvanced}>
          <label>
            Requirements (free text)
            <textarea value={text} onChange={(e) => setText(e.target.value)} data-testid="pm-requirements" />
          </label>
          <button type="submit" className="primary" data-testid="pm-propose" disabled={busy}>
            Generate draft tasks
          </button>
        </form>
        {err && proposePhase !== "running" ? <p className="err">{err}</p> : null}
      </details>
    </div>
  );
}

function WorkflowProjectBacklogPanel() {
  const { projectId = "" } = useParams();
  const navigate = useNavigate();
  const { project, reloadProject } = useProjectOutlet();
  const [items, setItems] = useState<Proposed[]>([]);
  const [summary, setSummary] = useState<DeliverySummary | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [rejectNotes, setRejectNotes] = useState("");
  const [busy, setBusy] = useState(false);

  const loadSummary = useCallback(async () => {
    try {
      const s = await api<DeliverySummary>(`/api/v1/projects/${encodeURIComponent(projectId)}/delivery/summary`);
      setSummary(s);
    } catch {
      setSummary(null);
    }
  }, [projectId]);

  const refresh = useCallback(async () => {
    const { items: list } = await api<{ items: Proposed[] }>(
      `/api/v1/projects/${encodeURIComponent(projectId)}/proposed-backlog-items`
    );
    setItems(list);
  }, [projectId]);

  useEffect(() => {
    void loadSummary().catch(() => setSummary(null));
    void refresh().catch(() => setItems([]));
  }, [loadSummary, refresh]);

  const st = summary?.implementationStatus ?? project.implementationStatus ?? "draft";
  const draftRows = items.filter((i) => i.status === "draft");
  const prdApproved = Boolean(project.prdSummary?.approved);
  const designApproved = project.designArtifacts?.some((a) => a.status === "approved") ?? false;
  const modelConfigured = Boolean(summary?.proposeModelLabel?.trim());
  const baseline = readWorkflowBacklogBaseline(project.deliveryPolicy);
  const approvedDesignRow = project.designArtifacts?.find((d) => d.status === "approved");
  const approvedPrdRow = project.prdSummary?.approved ?? null;
  const currentBacklogSourceSig =
    approvedPrdRow && approvedDesignRow ?
      `${approvedPrdRow.id}|${approvedPrdRow.updatedAt}|${approvedDesignRow.id}|${approvedDesignRow.updatedAt}`
    : null;
  const baselineSig =
    baseline ?
      `${baseline.prdId}|${baseline.prdUpdatedAt}|${baseline.designId}|${baseline.designUpdatedAt}`
    : null;
  const backlogSourcesChanged = Boolean(
    currentBacklogSourceSig && baselineSig && currentBacklogSourceSig !== baselineSig
  );
  const canGenerate =
    prdApproved &&
    designApproved &&
    modelConfigured &&
    draftRows.length === 0 &&
    (st !== "backlog_approved" || !baselineSig || backlogSourcesChanged);

  async function runGenerateBacklog() {
    setErr(null);
    setMsg(null);
    setBusy(true);
    try {
      const res = await api<{ proposed: number; usedLlm: boolean; modelLabel: string }>(
        `/api/v1/projects/${encodeURIComponent(projectId)}/delivery/generate-backlog`,
        { method: "POST", json: {} }
      );
      setMsg(
        `Generated ${Array.isArray(res.proposed) ? res.proposed.length : res.proposed} draft item(s) via **${res.modelLabel}** (${res.usedLlm ? "live LLM" : "stub"}).`
      );
      await refresh();
      await loadSummary();
      await reloadProject();
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : "Generate failed");
    } finally {
      setBusy(false);
    }
  }

  async function acceptDraft(id: string) {
    setErr(null);
    try {
      await api(`/api/v1/proposed-backlog-items/${encodeURIComponent(id)}/accept`, { method: "POST" });
      const { items: list } = await api<{ items: Proposed[] }>(
        `/api/v1/projects/${encodeURIComponent(projectId)}/proposed-backlog-items`
      );
      setItems(list);
      const s = await api<DeliverySummary>(`/api/v1/projects/${encodeURIComponent(projectId)}/delivery/summary`);
      setSummary(s);
      await reloadProject();
      setMsg("Item accepted as a task (backlog column).");
      const stillDraft = list.filter((i) => i.status === "draft").length;
      if (stillDraft === 0 && s.implementationStatus === "backlog_approved") {
        navigate(`/projects/${encodeURIComponent(projectId)}/plan`);
      }
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : "Accept failed");
    }
  }

  async function acceptAllDrafts() {
    setErr(null);
    setBusy(true);
    try {
      await api(`/api/v1/projects/${encodeURIComponent(projectId)}/delivery/approve-backlog`, { method: "POST" });
      const { items: list } = await api<{ items: Proposed[] }>(
        `/api/v1/projects/${encodeURIComponent(projectId)}/proposed-backlog-items`
      );
      setItems(list);
      const s = await api<DeliverySummary>(`/api/v1/projects/${encodeURIComponent(projectId)}/delivery/summary`);
      setSummary(s);
      await reloadProject();
      setMsg("All drafts accepted as tasks. Opening **Plan** …");
      const stillDraft = list.filter((i) => i.status === "draft").length;
      if (stillDraft === 0 && s.implementationStatus === "backlog_approved") {
        navigate(`/projects/${encodeURIComponent(projectId)}/plan`);
      }
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : "Bulk accept failed");
    } finally {
      setBusy(false);
    }
  }

  async function rejectAllDrafts() {
    setErr(null);
    setBusy(true);
    try {
      await api(`/api/v1/projects/${encodeURIComponent(projectId)}/delivery/reject-backlog`, {
        method: "POST",
        json: { notes: rejectNotes.trim() || undefined },
      });
      await refresh();
      await loadSummary();
      await reloadProject();
      setMsg("Drafts cleared.");
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : "Reject failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div data-testid="project-backlog">
      <div className="callout-card" style={{ marginBottom: "1rem", fontSize: "0.9rem", lineHeight: 1.55 }}>
        <strong>Workflow backlog:</strong> complete{" "}
        <Link to={`/projects/${project.id}/requirements`}>Requirements (approve PRD)</Link>, then{" "}
        <Link to={`/projects/${project.id}/design`}>Design</Link> (approve an artifact). Generate backlog drafts here from the
        approved PRD + design. Pipeline status: <strong>{st}</strong>
      </div>

      <div className="card">
        <h2>Generate backlog from PRD + design</h2>
        <p className="muted" style={{ fontSize: "0.88rem" }}>
          Requires an <strong>approved PRD</strong>, an <strong>approved design</strong> artifact, and a PM model binding.
        </p>
        <ul className="muted" style={{ fontSize: "0.85rem", lineHeight: 1.55 }}>
          <li style={{ color: prdApproved ? "var(--ok, #080)" : undefined }}>
            PRD approved: {prdApproved ? "yes" : "no — Requirements tab"}
          </li>
          <li style={{ color: designApproved ? "var(--ok, #080)" : undefined }}>
            Design approved: {designApproved ? "yes" : "no — Design tab"}
          </li>
          <li style={{ color: modelConfigured ? undefined : "var(--err, #c00)" }}>
            PM model binding: {modelConfigured ? summary?.proposeModelLabel : "missing — Admin → Model bindings"}
          </li>
        </ul>
        <button
          type="button"
          className="primary"
          data-testid="workflow-generate-backlog"
          disabled={busy || !canGenerate}
          onClick={() => void runGenerateBacklog()}
        >
          {busy ? "Working…" : "Generate backlog drafts"}
        </button>
        {st === "backlog_approved" && !canGenerate && baselineSig && !backlogSourcesChanged && draftRows.length === 0 ? (
          <p className="muted" style={{ fontSize: "0.82rem", marginTop: "0.5rem", maxWidth: "40rem", lineHeight: 1.45 }}>
            Drafts already match this <strong>approved PRD + design</strong>. To generate again, approve an updated PRD on
            Requirements and/or select a new approved design on Design so the sources change.
          </p>
        ) : null}
        {msg ? (
          <p className="ok" style={{ marginTop: "0.75rem" }}>
            {msg}
          </p>
        ) : null}
        {err ? (
          <p className="err" style={{ marginTop: "0.75rem" }}>
            {err}
          </p>
        ) : null}
      </div>

      <div className="card">
        <h2>Draft backlog — accept or reject</h2>
        <p className="muted" style={{ fontSize: "0.88rem" }}>
          {draftRows.length} draft(s). Accept drafts before publishing from Plan.
        </p>
        <div className="row" style={{ flexWrap: "wrap", gap: "0.5rem", marginBottom: "0.75rem" }}>
          <button type="button" className="secondary" disabled={busy} onClick={() => void refresh()}>
            Refresh
          </button>
          <button
            type="button"
            className="secondary"
            disabled={busy || draftRows.length === 0 || st !== "backlog_proposed"}
            onClick={() => void acceptAllDrafts()}
          >
            Accept all drafts as tasks
          </button>
        </div>
        <label>
          Notes if rejecting all drafts
          <textarea
            value={rejectNotes}
            onChange={(e) => setRejectNotes(e.target.value)}
            rows={2}
            style={{ display: "block", width: "100%", marginTop: "0.35rem" }}
          />
        </label>
        <button
          type="button"
          className="secondary"
          disabled={busy || draftRows.length === 0 || st !== "backlog_proposed"}
          style={{ marginTop: "0.5rem" }}
          onClick={() => void rejectAllDrafts()}
        >
          Reject all drafts &amp; reset
        </button>
        {draftRows.length === 0 ? (
          <p className="muted" style={{ marginTop: "0.75rem" }}>
            No drafts — generate above (or nothing left to accept).
          </p>
        ) : (
          <table style={{ marginTop: "0.75rem", width: "100%", fontSize: "0.88rem" }}>
            <thead>
              <tr>
                <th style={{ textAlign: "left" }}>Title &amp; description</th>
                <th style={{ textAlign: "left" }}>Source</th>
                <th style={{ textAlign: "left" }}>Action</th>
              </tr>
            </thead>
            <tbody>
              {draftRows.map((it) => (
                <tr key={it.id}>
                  <ProposedDraftTitleCell it={it} />
                  <td className="muted">{it.source ?? "—"}</td>
                  <td>
                    <button
                      type="button"
                      className="primary"
                      data-testid={`accept-${it.id}`}
                      disabled={busy}
                      onClick={() => void acceptDraft(it.id)}
                    >
                      Accept
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="muted" style={{ fontSize: "0.85rem", marginTop: "0.75rem" }}>
          Continue on <Link to={`/projects/${project.id}/plan`}>Plan &amp; backlog</Link>.
        </p>
      </div>
    </div>
  );
}

export function ProjectBacklogTab() {
  const { project } = useProjectOutlet();
  if (!project.workflowId) return <LegacyProjectBacklogPanel />;
  return <WorkflowProjectBacklogPanel />;
}

/** @deprecated Prefer {@link ProjectBacklogTab} */
export const ProjectSdmTab = ProjectBacklogTab;

export function ProjectPlanTab() {
  const { projectId = "" } = useParams();
  const navigate = useNavigate();
  const { project, reloadProject, planPublishBusy, setPlanPublishBusy } = useProjectOutlet();
  const [items, setItems] = useState<Proposed[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [assignable, setAssignable] = useState<AssignableRole[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [planAiBusy, setPlanAiBusy] = useState(false);
  const [replanBusy, setReplanBusy] = useState(false);
  const [reconcileBusy, setReconcileBusy] = useState(false);
  /** Blocks a second handler before React re-renders `disabled` (does not cancel the HTTP request). */
  const planPublishStartedRef = useRef(false);

  const refreshProposed = useCallback(async () => {
    const { items: list } = await api<{ items: Proposed[] }>(
      `/api/v1/projects/${encodeURIComponent(projectId)}/proposed-backlog-items`
    );
    setItems(list);
  }, [projectId]);

  const refreshTasks = useCallback(async () => {
    const { items: list } = await api<{ items: Task[] }>(`/api/v1/tasks?projectId=${encodeURIComponent(projectId)}`);
    setTasks(list);
  }, [projectId]);

  useEffect(() => {
    void refreshProposed().catch(() => setItems([]));
  }, [refreshProposed]);

  useEffect(() => {
    void refreshTasks().catch(() => setTasks([]));
  }, [refreshTasks]);

  useEffect(() => {
    planPublishStartedRef.current = false;
  }, [projectId]);

  useEffect(() => {
    void api<{ roles: AssignableRole[] }>(`/api/v1/projects/${encodeURIComponent(projectId)}/assignable-roles`)
      .then((r) => setAssignable(r.roles))
      .catch(() => setAssignable([]));
  }, [projectId, project.teamLinks]);

  async function accept(id: string) {
    setErr(null);
    try {
      await api(`/api/v1/proposed-backlog-items/${encodeURIComponent(id)}/accept`, { method: "POST" });
      await refreshProposed();
      await refreshTasks();
      await reloadProject();
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : "Accept failed");
    }
  }

  async function assignRole(task: Task, roleId: string) {
    setErr(null);
    try {
      await api(`/api/v1/tasks/${encodeURIComponent(task.id)}`, {
        method: "PATCH",
        json: {
          targetRoleId: roleId || null,
          expectedVersion: task.version,
        },
      });
      await refreshTasks();
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : "Assign failed");
    }
  }

  const drafts = items.filter((i) => i.status === "draft");
  const implSt = project.implementationStatus ?? "draft";
  const hasApprovedDesign = Boolean(project.designArtifacts?.some((a) => a.status === "approved"));
  const executionKickoffAt = deliveryPolicyIso(project.deliveryPolicy, "executionKickoffAt");
  const hasBacklogTasks = tasks.some((t) => t.state === "backlog");
  const hasPlanSurfaceTasks = tasks.some((t) => t.state === "backlog" || t.state === "todo");
  const canReplanBoardAfterKickoff =
    Boolean(executionKickoffAt) &&
    hasApprovedDesign &&
    assignable.length > 0 &&
    hasPlanSurfaceTasks &&
    (implSt === "executing" || implSt === "ready_for_uat");
  const canOneClickPublish =
    implSt === "backlog_approved" && hasApprovedDesign && hasBacklogTasks;
  const canRunAiPlanner =
    hasApprovedDesign &&
    !executionKickoffAt &&
    hasBacklogTasks &&
    assignable.length > 0 &&
    (implSt === "backlog_approved" || implSt === "backlog_proposed" || implSt === "executing");

  const aiPlannerBlockedReason =
    !hasApprovedDesign ? "Approve a design artifact on the Design tab first."
    : executionKickoffAt ? "Execution has already started; assignments are locked."
    : !hasBacklogTasks ?
      "There are no tasks in the backlog column — if you already published, open the Board tab, or accept drafts on Backlog first."
    : assignable.length === 0 ? "Link a team on Intake and map agents to seats under Organization → Teams."
    : implSt !== "backlog_approved" && implSt !== "backlog_proposed" && implSt !== "executing" ?
      "Accept backlog drafts on the Backlog tab until tasks exist, or finish intake/delivery setup."
    : null;

  async function runAiAssignments() {
    if (planAiBusy) return;
    setErr(null);
    setPlanAiBusy(true);
    try {
      await api(`/api/v1/projects/${encodeURIComponent(projectId)}/delivery/plan-assignments`, { method: "POST" });
      await refreshTasks();
      await reloadProject();
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : "AI planner failed");
    } finally {
      setPlanAiBusy(false);
    }
  }

  async function replanBoardAfterKickoff() {
    if (replanBusy) return;
    setErr(null);
    setReplanBusy(true);
    try {
      await api(`/api/v1/projects/${encodeURIComponent(projectId)}/delivery/replan-board`, { method: "POST" });
      await refreshTasks();
      await reloadProject();
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : "Replan failed");
    } finally {
      setReplanBusy(false);
    }
  }

  async function reconcilePlanGraphOnly() {
    if (reconcileBusy) return;
    setErr(null);
    setReconcileBusy(true);
    try {
      await api(`/api/v1/projects/${encodeURIComponent(projectId)}/delivery/reconcile-plan-graph`, {
        method: "POST",
      });
      await refreshTasks();
      await reloadProject();
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : "Reconcile failed");
    } finally {
      setReconcileBusy(false);
    }
  }

  async function publishBoardAndPlan() {
    if (planPublishBusy || planPublishStartedRef.current) return;
    planPublishStartedRef.current = true;
    setErr(null);
    setPlanPublishBusy(true);
    try {
      await api(`/api/v1/projects/${encodeURIComponent(projectId)}/delivery/publish-and-plan-board`, { method: "POST" });
      await refreshTasks();
      await reloadProject();
      navigate(`/projects/${encodeURIComponent(projectId)}/board`);
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : "Publish failed");
    } finally {
      planPublishStartedRef.current = false;
      setPlanPublishBusy(false);
    }
  }

  return (
    <div data-testid="project-plan">
      {implSt === "backlog_approved" && !hasApprovedDesign ? (
        <div className="callout-card" style={{ marginBottom: "1rem", fontSize: "0.9rem", lineHeight: 1.5 }}>
          <strong>Next:</strong> approve a design artifact on the{" "}
          <Link to={`/projects/${project.id}/design`}>Design</Link> tab, then return here to publish the board and start
          execution in one step.
        </div>
      ) : null}
      {canOneClickPublish ? (
        <div className="callout-card" style={{ marginBottom: "1rem" }}>
          <h3 style={{ margin: "0 0 0.5rem", fontSize: "1rem" }}>Publish board</h3>
          <p className="muted" style={{ fontSize: "0.88rem", margin: "0 0 0.75rem" }}>
            Confirms the plan and moves the project to <strong>executing</strong>, then opens the Board. Use{" "}
            <strong>Assign tasks with AI</strong> below first if you want the model to set phases, seats, and owners from
            team skills; otherwise publish runs that planner once automatically.
          </p>
          <button
            type="button"
            className="primary"
            data-testid="plan-publish-execution"
            disabled={planPublishBusy || replanBusy || reconcileBusy}
            onClick={() => void publishBoardAndPlan()}
          >
            {planPublishBusy ? "Publishing…" : "Publish board"}
          </button>
          {planPublishBusy ? (
            <p className="muted" style={{ fontSize: "0.82rem", margin: "0.55rem 0 0" }}>
              Request still running — switching tabs does not cancel it, and we do not abort an in-flight publish from the
              browser (a duplicate click is ignored until this one finishes). Wait for the server response or check the Board
              tab after redirect.
            </p>
          ) : null}
        </div>
      ) : null}
      {implSt === "executing" || implSt === "ready_for_uat" ? (
        <p className="ok" style={{ marginBottom: "1rem" }}>
          Delivery status: <strong>{implSt}</strong>. Day-to-day work lives on the <strong>Board</strong> tab.
        </p>
      ) : null}
      <div className="callout-card" style={{ marginBottom: "1rem", fontSize: "0.88rem", lineHeight: 1.55 }}>
        <strong>Phases and finish-to-start:</strong> each task has an execution <strong>phase</strong> (lower phases must be{" "}
        <strong>done</strong> before claiming work in higher phases). Within the same phase, the PM draft may list{" "}
        <strong>Starts after</strong> titles — those become board predecessors when you accept drafts (any order). You can
        still edit <strong>predecessors</strong> on each task below or on the Board before execution.
      </div>
      <p className="muted" style={{ marginBottom: "1rem" }}>
        Use <strong>Assign tasks with AI</strong> to let the planner set phases, seat mapping, and agent owners from linked
        teams (roles and skills). Then tweak rows below if needed and run the AI step again, or click <strong>Publish board</strong>{" "}
        when ready.
      </p>
      {err ? <p className="err">{err}</p> : null}
      <div className="card" style={{ marginBottom: "1rem" }} data-testid="plan-ai-assign-card">
        <h2 style={{ marginTop: 0 }}>Assign tasks with AI</h2>
        <p className="muted" style={{ fontSize: "0.88rem", lineHeight: 1.5, marginBottom: "0.75rem" }}>
          Calls the delivery planner LLM (same binding as design/board planning). It reads backlog tasks, your approved
          design, intake context, and <strong>every agent seated on a linked team</strong> with their role template and skill
          codes, then proposes phases, <code>targetRoleId</code>, and <code>assigneeAgentId</code> per task.
        </p>
        {aiPlannerBlockedReason ?
          <p className="muted" style={{ fontSize: "0.86rem", marginBottom: "0.65rem" }}>
            <strong>Not available yet:</strong> {aiPlannerBlockedReason}
          </p>
        : null}
        <button
          type="button"
          className="primary"
          data-testid="plan-ai-assignments"
          disabled={planAiBusy || planPublishBusy || replanBusy || reconcileBusy || !canRunAiPlanner}
          onClick={() => void runAiAssignments()}
          title={!canRunAiPlanner && aiPlannerBlockedReason ? aiPlannerBlockedReason : undefined}
        >
          {planAiBusy ? "Planning…" : "Run AI planner (seats & skills)"}
        </button>
      </div>
      <div className="card" style={{ marginBottom: "1rem" }} data-testid="plan-reconcile-phase-order-card">
        <h2 style={{ marginTop: 0 }}>Fix waves vs predecessors</h2>
        <p className="muted" style={{ fontSize: "0.88rem", lineHeight: 1.55, marginBottom: "0.75rem" }}>
          If prerequisites sit in <strong>higher execution waves</strong> than dependents, work can deadlock before anyone
          starts.{" "}
          <strong>Reconcile execution waves</strong> lowers prerequisite waves deterministically so every predecessor sits in wave{" "}
          <strong>≤</strong> its dependents — no LLM. After Begin execution we also trigger a delivery orchestration pass when
          you click this button.
        </p>
        <button
          type="button"
          className="secondary"
          data-testid="plan-reconcile-graph"
          disabled={reconcileBusy || replanBusy || planPublishBusy || planAiBusy}
          onClick={() => void reconcilePlanGraphOnly()}
          title="Safe before or after kickoff; orchestration runs only after Begin execution."
        >
          {reconcileBusy ? "Reconciling…" : "Reconcile execution waves vs dependencies"}
        </button>
      </div>
      {executionKickoffAt ?
        <div className="card" style={{ marginBottom: "1rem" }} data-testid="plan-replan-after-kickoff">
          <h2 style={{ marginTop: 0 }}>Adjust plan after execution started</h2>
          <p className="muted" style={{ fontSize: "0.88rem", lineHeight: 1.5, marginBottom: "0.75rem" }}>
            The SDM planner normally runs before kickoff. After <strong>Begin execution</strong>, use{" "}
            <strong>Re-run SDM board planner</strong> when you want the model to revisit phases and seat mapping across
            backlog and todo rows. For phase ↔ predecessor mismatches alone, prefer <strong>Reconcile execution waves</strong>{" "}
            above (faster).
          </p>
          {!hasApprovedDesign ?
            <p className="muted" style={{ fontSize: "0.86rem", marginBottom: "0.65rem" }}>
              <strong>Not available:</strong> approve a design artifact on the Design tab first.
            </p>
          : assignable.length === 0 ?
            <p className="muted" style={{ fontSize: "0.86rem", marginBottom: "0.65rem" }}>
              <strong>Not available:</strong> link a team on Intake and map agents to seats under Organization → Teams.
            </p>
          : !hasPlanSurfaceTasks ?
            <p className="muted" style={{ fontSize: "0.86rem", marginBottom: "0.65rem" }}>
              <strong>Nothing to replan:</strong> there are no backlog or todo tasks in this project.
            </p>
          : !(implSt === "executing" || implSt === "ready_for_uat") ?
            <p className="muted" style={{ fontSize: "0.86rem", marginBottom: "0.65rem" }}>
              <strong>Not available:</strong> project must be executing delivery (current:{" "}
              <code>{implSt}</code>).
            </p>
          : null}
          <div style={{ display: "flex", flexWrap: "wrap", gap: "0.5rem", alignItems: "center" }}>
            <button
              type="button"
              className="primary"
              data-testid="plan-replan-board"
              disabled={replanBusy || reconcileBusy || planPublishBusy || !canReplanBoardAfterKickoff}
              onClick={() => void replanBoardAfterKickoff()}
              title={!canReplanBoardAfterKickoff ? "Requirements above must be satisfied before replanning." : undefined}
            >
              {replanBusy ? "Replanning…" : "Re-run SDM board planner"}
            </button>
          </div>
        </div>
      : null}
      <div className="card">
        <h2>Draft backlog items</h2>
        {drafts.length === 0 ? (
          <p className="muted">No drafts — add requirements on the SDM tab.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Phase, predecessors &amp; title</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {drafts.map((it) => (
                <tr key={it.id}>
                  <ProposedDraftTitleCell it={it} />
                  <td style={{ verticalAlign: "top" }}>
                    <button type="button" className="secondary" onClick={() => void accept(it.id)} data-testid={`accept-${it.id}`}>
                      Accept → task
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      <div className="card">
        <h2>Tasks — phase, predecessors &amp; seat</h2>
        {assignable.length === 0 ? (
          <p className="muted">Link a team on Intake so seats appear here.</p>
        ) : null}
        <table>
          <thead>
            <tr>
              <th>Task</th>
              <th style={{ minWidth: "14rem" }}>Predecessors</th>
              <th>Assign to seat</th>
            </tr>
          </thead>
          <tbody>
            {[...tasks]
              .sort(
                (a, b) =>
                  (a.executionPhase ?? 0) - (b.executionPhase ?? 0) || a.title.localeCompare(b.title)
              )
              .map((t) => (
              <tr key={t.id}>
                <td style={{ verticalAlign: "top" }}>
                  <strong>{t.title}</strong>
                  <div className="muted" style={{ fontSize: "0.78rem", marginTop: "0.25rem" }}>
                    Phase {t.executionPhase ?? 0}
                  </div>
                  {t.dependencyHints?.dependsOnTitles && t.dependencyHints.dependsOnTitles.length > 0 ? (
                    <p className="muted" style={{ fontSize: "0.78rem", marginTop: "0.35rem", marginBottom: 0 }}>
                      <strong>Pending titles:</strong> {t.dependencyHints.dependsOnTitles.join(" · ")} (resolves when a
                      matching task exists)
                    </p>
                  ) : null}
                </td>
                <td style={{ verticalAlign: "top" }}>
                  <TaskPredecessorsBlock
                    task={t}
                    tasks={tasks}
                    onRefresh={() => void refreshTasks()}
                    setErr={setErr}
                  />
                </td>
                <td style={{ verticalAlign: "top" }}>
                  <select
                    value={t.targetRoleId ?? ""}
                    onChange={(e) => void assignRole(t, e.target.value)}
                    data-testid={`task-role-${t.id}`}
                  >
                    <option value="">— Unassigned —</option>
                    {assignable.map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.teamName} · {r.name}
                        {r.roleTemplate ? ` (${r.roleTemplate.label})` : ""}
                      </option>
                    ))}
                  </select>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function deliveryPolicyIso(obj: unknown, key: string): string | undefined {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return undefined;
  const v = (obj as Record<string, unknown>)[key];
  return typeof v === "string" ? v : undefined;
}

function readWorkflowBacklogBaseline(policy: unknown): {
  prdId: string;
  designId: string;
  prdUpdatedAt: string;
  designUpdatedAt: string;
} | null {
  if (!policy || typeof policy !== "object" || Array.isArray(policy)) return null;
  const b = (policy as Record<string, unknown>).workflowBacklogBaseline;
  if (!b || typeof b !== "object" || Array.isArray(b)) return null;
  const o = b as Record<string, unknown>;
  const prdId = typeof o.prdId === "string" ? o.prdId : null;
  const designId = typeof o.designId === "string" ? o.designId : null;
  const prdUpdatedAt = typeof o.prdUpdatedAt === "string" ? o.prdUpdatedAt : null;
  const designUpdatedAt = typeof o.designUpdatedAt === "string" ? o.designUpdatedAt : null;
  if (!prdId || !designId || !prdUpdatedAt || !designUpdatedAt) return null;
  return { prdId, designId, prdUpdatedAt, designUpdatedAt };
}

function readDesignLlmPrdWatermark(policy: unknown): string | undefined {
  if (!policy || typeof policy !== "object" || Array.isArray(policy)) return undefined;
  const w = (policy as Record<string, unknown>).designLlmPrdWatermark;
  return typeof w === "string" ? w : undefined;
}

const BOARD_STATES = ["backlog", "todo", "in_progress", "review", "done"] as const;

function TaskPredecessorsBlock({
  task,
  tasks,
  onRefresh,
  setErr,
}: {
  task: Task;
  tasks: Task[];
  onRefresh: () => void;
  setErr: (msg: string | null) => void;
}) {
  const others = tasks.filter((x) => x.id !== task.id);
  const initial = (task.dependsOn ?? []).map((d) => d.predecessorTaskId);
  const [selected, setSelected] = useState<string[]>(initial);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setSelected((task.dependsOn ?? []).map((d) => d.predecessorTaskId));
  }, [task.id, task.version, task.dependsOn]);

  const labels = selected
    .map((id) => tasks.find((x) => x.id === id)?.title ?? id.slice(0, 8))
    .join(", ");

  async function save() {
    setBusy(true);
    try {
      setErr(null);
      await api(`/api/v1/tasks/${encodeURIComponent(task.id)}/predecessors`, {
        method: "PUT",
        json: { predecessorTaskIds: selected },
      });
      await onRefresh();
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : "Failed to save predecessors");
    } finally {
      setBusy(false);
    }
  }

  return (
    <details style={{ marginTop: "0.35rem", fontSize: "0.82rem" }}>
      <summary data-testid={`task-pred-summary-${task.id}`}>Predecessors (finish before start)</summary>
      {selected.length > 0 ? (
        <div className="muted" style={{ marginTop: "0.25rem" }}>
          <strong>Starts after:</strong> {labels || "—"}
        </div>
      ) : (
        <p className="muted" style={{ marginTop: "0.25rem", marginBottom: "0.35rem" }}>
          No predecessors — can run in parallel with other same-phase work (phase + predecessor rules still apply).
        </p>
      )}
      {others.length > 0 ? (
        <>
          <label className="muted" style={{ display: "block", marginTop: "0.35rem" }}>
            Hold Ctrl/Cmd to select multiple
            <select
              multiple
              size={Math.min(6, Math.max(3, others.length))}
              value={selected}
              onChange={(e) => setSelected([...e.target.selectedOptions].map((o) => o.value))}
              data-testid={`task-pred-select-${task.id}`}
              style={{ display: "block", width: "100%", marginTop: "0.25rem" }}
            >
              {others.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.title}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            className="secondary"
            style={{ marginTop: "0.35rem" }}
            disabled={busy}
            data-testid={`task-pred-save-${task.id}`}
            onClick={() => void save()}
          >
            {busy ? "Saving…" : "Save predecessors"}
          </button>
        </>
      ) : null}
    </details>
  );
}

/** How often mounted Board / Chat tabs refetch REST data so orchestration updates appear without reloading. */
const PROJECT_LIVE_REFRESH_INTERVAL_MS = 5000;

const BOARD_MANUAL_CONTROL_PREFIX = "sarva_board_manual_control:";

function boardManualControlStorageKey(projectId: string): string {
  return `${BOARD_MANUAL_CONTROL_PREFIX}${projectId}`;
}

function readBoardManualControl(projectId: string): boolean {
  if (!projectId || typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(boardManualControlStorageKey(projectId)) === "1";
  } catch {
    return false;
  }
}

function writeBoardManualControl(projectId: string, value: boolean): void {
  if (!projectId || typeof window === "undefined") return;
  try {
    window.localStorage.setItem(boardManualControlStorageKey(projectId), value ? "1" : "0");
  } catch {
    /* quota / private mode */
  }
}

type DeliveryOrchestrationDagHealth = {
  hasDirectedCycle: boolean;
  dependencyEdgeCount: number;
  taskCount: number;
  cycleCountTotal: number;
  cycles: string[][];
};

type DeliveryOrchestrationPassRow = {
  id: string;
  createdAt: string;
  promotedCount: number;
  assignedCount?: number;
  startedCount?: number;
  coderSubmittedCount?: number;
  coderRunsCount?: number;
  surfacedEffects?: boolean;
  source?: string;
  correlationId?: string | null;
  partialErrors?: unknown;
};

type OrchestrationObservability = {
  dag: DeliveryOrchestrationDagHealth;
  passes: DeliveryOrchestrationPassRow[];
};

/** Correlation id joined to API persistence rows for orchestration kicks. */
function orchestrationCorrelationHeaders(): Headers {
  const h = new Headers();
  const cid =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function" ?
      crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  h.set("x-sarva-correlation-id", cid);
  return h;
}

export function ProjectBoardTab() {
  const { projectId = "" } = useParams();
  const { project, reloadProject } = useProjectOutlet();
  const [tasks, setTasks] = useState<Task[]>([]);
  const [summary, setSummary] = useState<DeliverySummary | null>(null);
  const [orchObs, setOrchObs] = useState<OrchestrationObservability | null>(null);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [title, setTitle] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [beginBusy, setBeginBusy] = useState(false);
  const [coderBusyId, setCoderBusyId] = useState<string | null>(null);
  const [reviewBusyId, setReviewBusyId] = useState<string | null>(null);
  const [autoReviewBusyId, setAutoReviewBusyId] = useState<string | null>(null);
  const [reviewNotes, setReviewNotes] = useState<Record<string, string>>({});
  const [boardInfo, setBoardInfo] = useState<string | null>(null);
  const [dedupeBusy, setDedupeBusy] = useState(false);
  const [deleteBusyId, setDeleteBusyId] = useState<string | null>(null);
  const [claimBusyId, setClaimBusyId] = useState<string | null>(null);
  const [phasePatchBusyId, setPhasePatchBusyId] = useState<string | null>(null);
  const [deliveryHookBusy, setDeliveryHookBusy] = useState(false);
  const [verifyBuildBusy, setVerifyBuildBusy] = useState(false);
  const [previewStartBusy, setPreviewStartBusy] = useState(false);
  const [previewStopBusy, setPreviewStopBusy] = useState(false);
  const [gitPushBusy, setGitPushBusy] = useState(false);
  const [githubPublishBusy, setGithubPublishBusy] = useState(false);
  const [githubPublishAsPublic, setGithubPublishAsPublic] = useState(false);
  const [githubPublishRepoName, setGithubPublishRepoName] = useState("");
  const [verifyBuildBanner, setVerifyBuildBanner] = useState<{
    tone: "running" | "ok" | "err" | "skip";
    text: string;
  } | null>(null);

  const [manualBoardControl, setManualBoardControl] = useState(() => readBoardManualControl(projectId));

  useEffect(() => {
    setManualBoardControl(readBoardManualControl(projectId));
  }, [projectId]);

  function persistManualBoardControl(next: boolean): void {
    writeBoardManualControl(projectId, next);
    setManualBoardControl(next);
  }

  const boardPlannedAt = deliveryPolicyIso(project.deliveryPolicy, "boardPlannedAt");
  const executionKickoffAt = deliveryPolicyIso(project.deliveryPolicy, "executionKickoffAt");
  const implSt = project.implementationStatus ?? "";

  const stallCountUi = summary?.autonomousStallCount ?? 0;
  const stallThresholdUi = summary?.stallThresholdForOperatorHandsOn ?? 4;
  const boardHandsOffMinimal = Boolean(summary?.boardHandsOffMinimalControls);
  const hideRoutineBoardUi = boardHandsOffMinimal && !manualBoardControl;
  const handsOffEligible = summary?.automationHandsOffEnvConfigured === true;
  /** Hands-off autonomy is owning the loop — keep manual LLM retries out of sight unless the operator unfolds “Stuck”. */
  const tuckManualLlmRecovery =
    Boolean(executionKickoffAt && handsOffEligible && hideRoutineBoardUi);

  async function runDeliveryOrchestrationNow() {
    setErr(null);
    setBoardInfo(null);
    setDeliveryHookBusy(true);
    try {
      const r = await api<DeliveryOrchestrationKickResponse>(
        `/api/v1/projects/${encodeURIComponent(projectId)}/delivery/run-orchestration`,
        { method: "POST", headers: orchestrationCorrelationHeaders() }
      );
      setBoardInfo(
        buildOrchestrationKickBoardInfo(
          r,
          "**Orchestration:** ran the same delivery-engine pass as task lifecycle hooks."
        )
      );
      await refresh();
      await reloadProject();
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : "Could not run orchestration");
    } finally {
      setDeliveryHookBusy(false);
    }
  }

  async function resumeHandsOffAutomation() {
    setErr(null);
    setBoardInfo(null);
    setDeliveryHookBusy(true);
    try {
      const r = await api<DeliveryOrchestrationKickResponse>(
        `/api/v1/projects/${encodeURIComponent(projectId)}/delivery/resume-hands-off-automation`,
        { method: "POST", headers: orchestrationCorrelationHeaders() }
      );
      setBoardInfo(
        buildOrchestrationKickBoardInfo(r, "**Hands-off resume:** autonomous stall meter cleared.")
      );
      await refresh();
      await reloadProject();
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : "Could not reset stall meter");
    } finally {
      setDeliveryHookBusy(false);
    }
  }

  async function runWorkspaceVerifyBuild() {
    setErr(null);
    setVerifyBuildBanner({
      tone: "running",
      text: "Running npm install (if needed) and npm run build on the API host. The button stays busy until the API finishes — large installs can take several minutes.",
    });
    setVerifyBuildBusy(true);
    try {
      const r = await api<{ build: NonNullable<DeliverySummary["workspaceLastBuild"]> }>(
        `/api/v1/projects/${encodeURIComponent(projectId)}/delivery/workspace-verify-build`,
        { method: "POST" }
      );
      const b = r.build;
      setVerifyBuildBanner({
        tone: b.ok ? "ok" : "err",
        text: b.ok ?
          `Build finished: passed (${b.commandSummary}, exit 0). The same result was posted to Project chat.`
        : `Build finished: failed (exit ${b.exitCode}). See Project chat for details (stderr tail is in message metadata).`,
      });
      await refresh();
      await reloadProject();
    } catch (ex) {
      if (ex instanceof ApiError && ex.status === 409) {
        const skipped =
          typeof ex.body === "object" && ex.body !== null && "skippedReason" in ex.body
            ? String((ex.body as { skippedReason?: unknown }).skippedReason ?? "")
            : "";
        setVerifyBuildBanner({
          tone: "skip",
          text: skipped ?
            `Verify did not run: ${skipped.replace(/_/g, " ")}. (A line was added to Project chat.)`
          : "Verify did not run — workspace not ready. (Check Project chat.)",
        });
      } else {
        setVerifyBuildBanner(null);
        setErr(ex instanceof Error ? ex.message : "Could not run verify build");
      }
    } finally {
      setVerifyBuildBusy(false);
    }
  }

  async function startWorkspacePreview() {
    setErr(null);
    setBoardInfo(null);
    setPreviewStartBusy(true);
    try {
      const r = await api<{ ok: boolean; preview?: NonNullable<DeliverySummary["workspacePreview"]>; message?: string }>(
        `/api/v1/projects/${encodeURIComponent(projectId)}/delivery/workspace-preview-start`,
        { method: "POST" }
      );
      if (!r.ok || !r.preview) {
        setErr(r.message ?? "Could not start preview server");
        return;
      }
      setBoardInfo(`**Preview server** — open **${r.preview.url}** on the API host (${r.preview.command}).`);
      await refresh();
      await reloadProject();
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : "Could not start preview server");
    } finally {
      setPreviewStartBusy(false);
    }
  }

  async function stopWorkspacePreview() {
    setErr(null);
    setBoardInfo(null);
    setPreviewStopBusy(true);
    try {
      await api<{ ok: boolean; message?: string }>(
        `/api/v1/projects/${encodeURIComponent(projectId)}/delivery/workspace-preview-stop`,
        { method: "POST" }
      );
      setBoardInfo("Preview server stopped.");
      await refresh();
      await reloadProject();
    } catch (ex) {
      if (ex instanceof ApiError && ex.status === 409) {
        setErr(ex.message);
      } else {
        setErr(ex instanceof Error ? ex.message : "Could not stop preview server");
      }
    } finally {
      setPreviewStopBusy(false);
    }
  }

  async function pushDevWorkspaceGit() {
    setErr(null);
    setBoardInfo(null);
    setGitPushBusy(true);
    try {
      const r = await api<{
        ok: true;
        branch: string;
        outcome: string;
        detail: string;
      }>(`/api/v1/projects/${encodeURIComponent(projectId)}/delivery/workspace-git-push`, {
        method: "POST",
        json: {},
      });
      setBoardInfo(
        `**Git:** pushed branch **${r.branch}** (${r.outcome}). See Project chat for the full line.`
      );
      await refresh();
      await reloadProject();
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : "Could not push from dev workspace");
    } finally {
      setGitPushBusy(false);
    }
  }

  async function publishDevWorkspaceToNewGithub() {
    setErr(null);
    setBoardInfo(null);
    setGithubPublishBusy(true);
    try {
      const r = await api<{
        ok: true;
        repoName: string;
        htmlUrl: string;
        cloneUrl: string;
        detail: string;
      }>(`/api/v1/projects/${encodeURIComponent(projectId)}/delivery/github-publish`, {
        method: "POST",
        json: {
          ...(githubPublishAsPublic ? { isPublic: true } : {}),
          ...(githubPublishRepoName.trim() ? { repoName: githubPublishRepoName.trim() } : {}),
        },
      });
      setBoardInfo(
        `**GitHub:** created repository “${r.repoName}” and pushed. Repo: ${r.htmlUrl}. Intake clone URL set to ${r.cloneUrl}. See Project chat for details.`
      );
      await refresh();
      await reloadProject();
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : "Could not create repository or publish");
    } finally {
      setGithubPublishBusy(false);
    }
  }

  const refresh = useCallback(async () => {
    const encoded = encodeURIComponent(projectId);
    const [{ items }, s] = await Promise.all([
      api<{ items: Task[] }>(`/api/v1/tasks?projectId=${encoded}`),
      api<DeliverySummary>(`/api/v1/projects/${encoded}/delivery/summary`),
    ]);
    setTasks(items);
    setSummary(s);

    if (!executionKickoffAt) {
      setOrchObs(null);
      return;
    }

    const base = `/api/v1/projects/${encoded}/delivery`;
    const [dhRaw, pj] = await Promise.all([
      api<DeliveryOrchestrationDagHealth>(`${base}/dag-health`).catch(() => null),
      api<{ items: DeliveryOrchestrationPassRow[] }>(`${base}/orchestration-passes?take=5`).catch(() => ({
        items: [] as DeliveryOrchestrationPassRow[],
      })),
    ]);

    const emptyDag: DeliveryOrchestrationDagHealth = {
      hasDirectedCycle: false,
      dependencyEdgeCount: 0,
      taskCount: 0,
      cycleCountTotal: 0,
      cycles: [],
    };

    setOrchObs({
      dag: dhRaw ?? emptyDag,
      passes: pj.items ?? [],
    });
  }, [projectId, executionKickoffAt]);

  useEffect(() => {
    setVerifyBuildBanner(null);
  }, [projectId]);

  useEffect(() => {
    void refresh().catch(() => setTasks([]));
  }, [refresh]);

  const boardPollBusy = useRef(false);
  useEffect(() => {
    if (!projectId) return undefined;

    const poll = () => {
      if (document.visibilityState !== "visible") return;
      if (boardPollBusy.current) return;
      boardPollBusy.current = true;
      void refresh()
        .catch(() => undefined)
        .finally(() => {
          boardPollBusy.current = false;
        });
    };

    const id = window.setInterval(poll, PROJECT_LIVE_REFRESH_INTERVAL_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") {
        void refresh().catch(() => undefined);
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [refresh, projectId]);

  useEffect(() => {
    void api<Agent[]>("/api/v1/agents").then(setAgents).catch(() => setAgents([]));
  }, []);

  async function beginExecution() {
    setErr(null);
    setBoardInfo(null);
    setBeginBusy(true);
    try {
      const r = await api<BeginExecutionResponse>(
        `/api/v1/projects/${encodeURIComponent(projectId)}/delivery/begin-execution`,
        { method: "POST" }
      );
      if (r.idempotent) {
        setBoardInfo(
          "Execution was already started earlier. If a task looks stuck in **in progress**, open **Chat** — each coder run posts there. Use the card’s **advanced retry** only if orchestration failed after a binding fix."
        );
      } else {
        const runs = r.coderAgentRuns ?? [];
        const submitted = runs.filter((x) => x.submittedToReview).length;
        const errs = runs.filter((x) => Boolean(x.error)).length;
        const skipped = runs.filter((x) => x.ran === false && x.skippedReason).length;
        const hint =
          errs || skipped ?
            " Open **Chat** for orchestrator lines (success and failure). Tasks left **in progress** usually need model binding or reviewer routing fixed, then the **advanced retry** on the card."
          : submitted < runs.length ?
            " Some batches did not submit to review — check **Chat**."
          : "";
        const assignSuffix =
          (r.autoAssigned ?? 0) > 0 ? ` Assigned ${r.autoAssigned} unassigned todo(s).` : "";
        setBoardInfo(
          [
            `Kickoff: moved ${r.movedToTodo ?? 0} backlog row(s) to todo, auto-started ${r.autoStarted ?? 0}.${assignSuffix}`,
            runs.length > 0 ?
              `Coder batch: ${submitted}/${runs.length} submitted to review${errs ? `, ${errs} error(s)` : ""}${skipped ? `, ${skipped} skipped` : ""}.`
            : "No coder batch (nothing auto-started with an assignee yet, or tasks are not coder-eligible).",
            "While the button said **Starting…**, the server was running coder LLMs (can take minutes on slow models).",
            hint,
          ]
            .join(" ")
            .trim()
        );
      }
      await refresh();
      await reloadProject();
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : "Begin execution failed");
    } finally {
      setBeginBusy(false);
    }
  }

  function agentLabel(id: string | null | undefined) {
    if (!id) return null;
    return agents.find((a) => a.id === id)?.name ?? id.slice(0, 8);
  }

  async function createTask(e: FormEvent) {
    e.preventDefault();
    setErr(null);
    try {
      await api("/api/v1/tasks", {
        method: "POST",
        json: { projectId, title, description: "", state: "backlog" },
      });
      setTitle("");
      await refresh();
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : "Create failed");
    }
  }

  async function setState(task: Task, state: string) {
    setErr(null);
    try {
      await api(`/api/v1/tasks/${encodeURIComponent(task.id)}`, {
        method: "PATCH",
        json: { state, expectedVersion: task.version },
      });
      await refresh();
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : "Update failed");
    }
  }

  async function patchExecutionWave(task: Task, phaseRaw: string) {
    setErr(null);
    const n = Number.parseInt(phaseRaw.trim(), 10);
    if (!Number.isFinite(n) || n < 0 || n > 50) {
      setErr("Execution wave must be an integer from 0 to 50.");
      return;
    }
    if (n === (task.executionPhase ?? 0)) return;
    setPhasePatchBusyId(task.id);
    try {
      await api(`/api/v1/tasks/${encodeURIComponent(task.id)}`, {
        method: "PATCH",
        json: { expectedVersion: task.version, executionPhase: n },
      });
      await refresh();
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : "Wave update failed");
    } finally {
      setPhasePatchBusyId(null);
    }
  }

  async function claim(task: Task, agentId: string) {
    setErr(null);
    setClaimBusyId(task.id);
    try {
      await api(`/api/v1/tasks/${encodeURIComponent(task.id)}/claim`, {
        method: "POST",
        json: { assigneeAgentId: agentId, expectedVersion: task.version },
      });
      await refresh();
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : "Claim failed");
    } finally {
      setClaimBusyId(null);
    }
  }

  async function runCoder(t: Task) {
    setErr(null);
    setCoderBusyId(t.id);
    try {
      type CoderOutcome = {
        ran: boolean;
        usedLlm?: boolean;
        submittedToReview?: boolean;
        skippedReason?: string;
        error?: string;
      };
      const out = await api<{ coderAgent: CoderOutcome }>(
        `/api/v1/tasks/${encodeURIComponent(t.id)}/run-coder`,
        { method: "POST" }
      );
      const c = out.coderAgent;
      const reason = (c.skippedReason ?? "").toLowerCase();
      if (c.error) {
        setErr(`Coder LLM failed: ${c.error.slice(0, 800)} (see Chat for duplicate notice)`);
      } else if (!c.submittedToReview && c.skippedReason) {
        const hint =
          reason === "no_eligible_reviewer"
            ? "Draft saved but no reviewer was available — assign a second agent for code review."
          : reason === "no_model_binding" || reason === "no_credentials"
            ? "Fix Admin model bindings / API keys on the assignee seat, then retry."
          : reason === "concurrent_change"
            ? "Task changed while saving — refresh and retry once."
          : reason === "coder_llm_disabled"
            ? "Coder LLM is disabled in API env (`AGENT_CODER_USE_LLM`)."
          : reason === "not_coder_task"
            ? "This row’s seat is not an implementation lane (e.g. QA or PM without the **Coder** skill). Do the work manually, then use **Mark done** or your review flow—the coder LLM only runs on engineer seats or seats that link **Coder**."
          : reason.startsWith("invalid_state") || reason === "task_not_found"
            ? "Refresh the Board and confirm the row is **in progress** with an assignee, then retry **Run coder** once."
          : null;
        setErr(
          `Coder did not submit to review (${c.skippedReason}).${hint ? ` ${hint}` : ""} See **Chat** for details.`
        );
      }
      await refresh();
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : "Coder agent failed");
    } finally {
      setCoderBusyId(null);
    }
  }

  async function runAutomatedReviewManual(t: Task) {
    setErr(null);
    setAutoReviewBusyId(t.id);
    try {
      const res = await api<{ message?: string }>(
        `/api/v1/tasks/${encodeURIComponent(t.id)}/run-automated-review`,
        { method: "POST" }
      );
      if (res.message) {
        setBoardInfo(res.message);
      }
      await refresh();
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : "Automated review failed");
    } finally {
      setAutoReviewBusyId(null);
    }
  }

  async function reviewVerdict(t: Task, verdict: "approve" | "request_changes") {
    setErr(null);
    setReviewBusyId(t.id);
    try {
      const res = await api<{ task: Task; coderFollowUp?: { submittedToReview?: boolean; skippedReason?: string; error?: string } }>(
        `/api/v1/tasks/${encodeURIComponent(t.id)}/review-verdict`,
        {
          method: "POST",
          json: {
            verdict,
            expectedVersion: t.version,
            notes: reviewNotes[t.id]?.trim() || undefined,
          },
        }
      );
      const c = res.coderFollowUp;
      if (verdict === "request_changes" && c && !c.submittedToReview) {
        const reason = c.skippedReason ?? "unknown";
        const hint =
          reason === "no_model_binding" ? " Assign a model binding to the coder agent seat." :
          reason === "no_credentials"
            ? " Fix LLM credentials on the binding."
          : reason === "coder_llm_disabled" ? " Coder LLM is disabled (`AGENT_CODER_USE_LLM`)." :
          null;
        setErr(
          `Coder did not re-submit after request changes (${reason}).${hint ? ` ${hint}` : ""} See **Chat** for orchestrator lines.`
        );
      }
      setReviewNotes((m) => {
        const next = { ...m };
        delete next[t.id];
        return next;
      });
      await refresh();
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : "Review verdict failed");
    } finally {
      setReviewBusyId(null);
    }
  }

  async function dedupeBoardTasks() {
    setErr(null);
    setBoardInfo(null);
    setDedupeBusy(true);
    try {
      const r = await api<{ removedTaskIds: string[]; keptTaskIds: string[] }>(
        `/api/v1/projects/${encodeURIComponent(projectId)}/delivery/dedupe-tasks`,
        { method: "POST" }
      );
      await refresh();
      setBoardInfo(
        r.removedTaskIds.length > 0 ?
          `Removed ${r.removedTaskIds.length} duplicate task(s) (kept the row with the most description text per group).`
        : "No duplicate backlog or todo tasks detected."
      );
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : "Dedupe failed");
    } finally {
      setDedupeBusy(false);
    }
  }

  async function deleteBoardTask(t: Task) {
    setErr(null);
    setBoardInfo(null);
    if (!window.confirm(`Delete task “${t.title}”? This cannot be undone.`)) return;
    setDeleteBusyId(t.id);
    try {
      await api(`/api/v1/tasks/${encodeURIComponent(t.id)}`, { method: "DELETE" });
      await refresh();
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : "Delete failed");
    } finally {
      setDeleteBusyId(null);
    }
  }

  const byState = (s: string) => tasks.filter((t) => t.state === s);

  const showExecutionCompleted = Boolean(
    summary?.allTasksDone && executionKickoffAt && tasks.length > 0
  );
  const cloneUrl = project.repoScope?.cloneUrl?.trim() ?? "";
  const repoRootHint = project.repoScope?.rootPath?.trim() ?? "";
  const devWs = project.devWorkspacePath?.trim() ?? "";

  return (
    <div data-testid="project-board">
      {showExecutionCompleted ? (
        <div
          className="callout-card"
          style={{
            marginBottom: "0.85rem",
            borderColor: "var(--ok, #15803d)",
            background: "color-mix(in srgb, var(--ok, #15803d) 8%, transparent)",
          }}
          data-testid="board-execution-completed"
        >
          <h3 style={{ margin: "0 0 0.4rem", fontSize: "1.05rem" }}>Project execution completed</h3>
          <p className="muted" style={{ fontSize: "0.9rem", margin: "0 0 0.75rem", lineHeight: 1.55 }}>
            Every board task for this project is marked <strong>done</strong> after execution kickoff. Use the checks below to
            validate the implementation in your repository and (if applicable) this Sarva environment.
          </p>
          {devWs ? (
            <div
              style={{
                marginBottom: "0.9rem",
                padding: "0.65rem 0.75rem",
                border: "1px solid color-mix(in srgb, var(--border, #ccc) 80%, transparent)",
                borderRadius: "6px",
                background: "var(--panel, #fafafa)",
              }}
              data-testid="board-workspace-tools"
            >
              <h4 style={{ margin: "0 0 0.4rem", fontSize: "0.92rem" }}>Dev workspace on the API host</h4>
              <p className="muted" style={{ fontSize: "0.86rem", margin: "0 0 0.55rem", lineHeight: 1.5 }}>
                Coder output lives under <code>{devWs}</code> (see <code>SARVA_AGENT_WORKSPACE</code>). After the last task
                completes, Sarva runs <code>npm install</code> if needed and <code>npm run build</code> once automatically — follow{" "}
                <Link to={`/projects/${encodeURIComponent(projectId)}/chat`}>Project chat</Link> for the transcript.
              </p>
              {summary?.postCompletionAutoWorkspaceBuildFinishedAt ? (
                <p className="muted" style={{ fontSize: "0.8rem", margin: "0 0 0.45rem" }}>
                  Auto verify finished:{" "}
                  <strong>{new Date(summary.postCompletionAutoWorkspaceBuildFinishedAt).toLocaleString()}</strong>
                </p>
              ) : null}
              {summary?.workspaceLastBuild ? (
                <p style={{ fontSize: "0.82rem", margin: "0 0 0.5rem", lineHeight: 1.45 }}>
                  Last verify build:{" "}
                  <strong style={{ color: summary.workspaceLastBuild.ok ? "var(--ok, #15803d)" : "var(--danger, #b91c1c)" }}>
                    {summary.workspaceLastBuild.ok ? "passed" : "failed"}
                  </strong>{" "}
                  · exit {summary.workspaceLastBuild.exitCode} · {new Date(summary.workspaceLastBuild.at).toLocaleString()}
                  {summary.workspaceLastBuild.commandSummary ?
                    <>
                      {" "}
                      · <code style={{ fontSize: "0.78rem" }}>{summary.workspaceLastBuild.commandSummary}</code>
                    </>
                  : null}
                </p>
              ) : (
                <p className="muted" style={{ fontSize: "0.8rem", margin: "0 0 0.5rem" }}>
                  No workspace build recorded yet — it runs after orchestration sees every task <strong>done</strong>, or use{" "}
                  <strong>Run verify build</strong> below.
                </p>
              )}
              <div className="row" style={{ flexWrap: "wrap", gap: "0.5rem", alignItems: "center", marginBottom: "0.45rem" }}>
                <button
                  type="button"
                  className={verifyBuildBusy ? "primary is-busy" : "primary"}
                  disabled={verifyBuildBusy}
                  aria-busy={verifyBuildBusy || undefined}
                  data-testid="board-workspace-verify-build"
                  title="Run npm install (if needed) and npm run build in the API dev workspace"
                  onClick={() => void runWorkspaceVerifyBuild()}
                >
                  {verifyBuildBusy ? (
                    <>
                      <span className="btn-inline-spinner" aria-hidden />
                      Running build…
                    </>
                  ) : (
                    "Run verify build"
                  )}
                </button>
                <button
                  type="button"
                  className="secondary"
                  disabled={previewStartBusy || previewStopBusy || Boolean(summary?.workspacePreview)}
                  data-testid="board-workspace-preview-start"
                  onClick={() => void startWorkspacePreview()}
                >
                  {previewStartBusy ? "Starting…" : "Start preview server"}
                </button>
                <button
                  type="button"
                  className="secondary"
                  disabled={previewStartBusy || previewStopBusy || !summary?.workspacePreview}
                  data-testid="board-workspace-preview-stop"
                  onClick={() => void stopWorkspacePreview()}
                >
                  {previewStopBusy ? "Stopping…" : "Stop preview"}
                </button>
                <button
                  type="button"
                  className="secondary"
                  disabled={gitPushBusy || !summary?.workspaceGitPushEnabled}
                  data-testid="board-workspace-git-push"
                  title={
                    summary?.workspaceGitPushEnabled ?
                      "git add -A, commit (if there are changes), git push -u origin <current branch> on the API host"
                    : "Enable on the API: SARVA_WORKSPACE_GIT_PUSH=true plus working git credentials (SSH or credential helper)."
                  }
                  onClick={() => void pushDevWorkspaceGit()}
                >
                  {gitPushBusy ? "Pushing…" : "Push to GitHub"}
                </button>
                <button
                  type="button"
                  className="secondary"
                  disabled={githubPublishBusy || !summary?.githubCompanyPublishConfigured}
                  data-testid="board-workspace-github-publish"
                  title={
                    !summary?.githubCompanyPublishConfigured ?
                      "Configure GitHub owner and PAT under System → Admin → GitHub publishing."
                    : "Creates a new GitHub repository under the company owner, commits the dev workspace, pushes main, and updates Intake clone URL. Fails if the workspace already has a git remote named origin."
                  }
                  onClick={() => void publishDevWorkspaceToNewGithub()}
                >
                  {githubPublishBusy ? "Publishing…" : "Create GitHub repo & publish"}
                </button>
              </div>
              <label style={{ display: "block", marginTop: "0.5rem", fontSize: "0.85rem" }}>
                Repository name (optional)
                <input
                  type="text"
                  value={githubPublishRepoName}
                  disabled={!summary?.githubCompanyPublishConfigured}
                  onChange={(e) => setGithubPublishRepoName(e.target.value)}
                  placeholder="Defaults from project name slug"
                  data-testid="board-github-repo-name"
                  style={{ display: "block", marginTop: "0.25rem", maxWidth: "20rem" }}
                />
              </label>
              <label
                className="muted"
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "0.45rem",
                  fontSize: "0.8rem",
                  marginTop: "0.35rem",
                  cursor: summary?.githubCompanyPublishConfigured ? "pointer" : "not-allowed",
                }}
              >
                <input
                  type="checkbox"
                  checked={githubPublishAsPublic}
                  disabled={!summary?.githubCompanyPublishConfigured}
                  onChange={(e) => setGithubPublishAsPublic(e.target.checked)}
                />
                <span>Create this repository as <strong>public</strong> (company default is private when unchecked)</span>
              </label>
              <p className="muted" style={{ fontSize: "0.78rem", margin: "0.5rem 0 0", lineHeight: 1.5 }}>
                {summary?.workspaceGitPushEnabled ?
                  <>
                    <strong>Push to GitHub</strong> runs on the API host: commits any uncommitted work in this folder, then{" "}
                    <code>git push -u origin &lt;current-branch&gt;</code>. The folder must be a <strong>clone</strong> with{" "}
                    <code>origin</code> pointing at your repo (see Intake clone URL
                    {cloneUrl ?
                      <>
                        :{" "}
                        <a href={cloneUrl} target="_blank" rel="noreferrer">
                          open clone URL
                        </a>
                      </>
                    : null}
                    ). Use SSH or a credential helper on that machine so <code>git push</code> is non-interactive.
                  </>
                : <>
                    <strong>Push to GitHub</strong> is hidden until the API sets{" "}
                    <code>SARVA_WORKSPACE_GIT_PUSH=true</code> (safety gate). Optional: <code>SARVA_GIT_AUTHOR_NAME</code> /{" "}
                    <code>SARVA_GIT_AUTHOR_EMAIL</code> for automated commit metadata.
                  </>}
              </p>
              <p className="muted" style={{ fontSize: "0.78rem", margin: "0.35rem 0 0", lineHeight: 1.5 }}>
                <strong>Create GitHub repo &amp; publish</strong> uses the company token from{" "}
                <Link to="/admin?tab=github">Admin → GitHub publishing</Link> to create a <em>new</em> repository (no existing{" "}
                <code>origin</code> in the dev workspace), push <code>main</code>, and point Intake at the new clone URL. Use{" "}
                <strong>Push to GitHub</strong> when you already have a remote configured.
              </p>
              {verifyBuildBanner ? (
                <div
                  role="status"
                  aria-live="polite"
                  data-testid="board-workspace-verify-feedback"
                  style={{
                    fontSize: "0.84rem",
                    lineHeight: 1.45,
                    marginTop: verifyBuildBanner.tone === "running" ? "0.1rem" : 0,
                    padding: "0.5rem 0.6rem",
                    borderRadius: "6px",
                    border:
                      verifyBuildBanner.tone === "running"
                        ? "1px solid color-mix(in srgb, var(--accent) 50%, transparent)"
                      : verifyBuildBanner.tone === "ok"
                        ? "1px solid color-mix(in srgb, var(--ok) 55%, transparent)"
                      : verifyBuildBanner.tone === "skip"
                        ? "1px dashed var(--border)"
                      : "1px solid color-mix(in srgb, var(--danger) 50%, transparent)",
                    background:
                      verifyBuildBanner.tone === "running"
                        ? "color-mix(in srgb, var(--accent) 14%, var(--surface, transparent))"
                      : verifyBuildBanner.tone === "ok"
                        ? "color-mix(in srgb, var(--ok) 12%, transparent)"
                      : verifyBuildBanner.tone === "skip"
                        ? "var(--surface2, rgba(255,255,255,0.03))"
                      : "color-mix(in srgb, var(--danger) 12%, transparent)",
                    color: "var(--text)",
                  }}
                >
                  {verifyBuildBanner.tone === "running" ? (
                    <span className="btn-inline-spinner" style={{ marginRight: "0.45rem" }} aria-hidden />
                  ) : null}
                  <span>{verifyBuildBanner.text}</span>{" "}
                  <Link
                    to={`/projects/${encodeURIComponent(projectId)}/chat`}
                    style={{
                      fontWeight: 600,
                      whiteSpace: "nowrap",
                    }}
                  >
                    Open Project chat
                  </Link>
                </div>
              ) : null}
              {summary?.workspacePreview ? (
                <p style={{ fontSize: "0.86rem", margin: "0", lineHeight: 1.5 }}>
                  Preview URL (open on the machine running the Sarva API):{" "}
                  <a href={summary.workspacePreview.url} target="_blank" rel="noreferrer">
                    {summary.workspacePreview.url}
                  </a>
                  <span className="muted" style={{ fontSize: "0.78rem", display: "block", marginTop: "0.35rem" }}>
                    Command: <code>{summary.workspacePreview.command}</code>
                  </span>
                </p>
              ) : (
                <p className="muted" style={{ fontSize: "0.78rem", margin: "0", lineHeight: 1.45 }}>
                  Start preview after a successful build (Vite <code>preview</code> script, <code>npx vite preview</code>, or static{" "}
                  <code>serve dist</code>).
                </p>
              )}
            </div>
          ) : null}
          <h4 style={{ margin: "0 0 0.35rem", fontSize: "0.92rem" }}>Suggested steps to test</h4>
          <ol
            style={{
              margin: "0.35rem 0 0",
              paddingLeft: "1.25rem",
              fontSize: "0.88rem",
              lineHeight: 1.55,
              maxWidth: "48rem",
            }}
          >
            <li style={{ marginBottom: "0.4rem" }}>
              <strong>Application repository.</strong> Open or clone your product repo
              {cloneUrl ?
                <>
                  {" "}
                  (<a href={cloneUrl} target="_blank" rel="noreferrer">
                    clone URL
                  </a>
                  {project.repoScope?.branchDefault ?
                    <>
                      , default branch <code>{project.repoScope.branchDefault}</code>
                    </>
                  : null}
                  )
                </>
              : null}
              . Confirm paths on{" "}
              <Link to={`/projects/${encodeURIComponent(projectId)}/intake`}>Intake</Link> under repository scope if needed.
              {repoRootHint ?
                <>
                  {" "}
                  Recorded root path (if used on your workstation): <code>{repoRootHint}</code>.
                </>
              : null}{" "}
              Run <code>npm install</code>, then <code>npm run build</code> and <code>npm test</code> (or the equivalents in
              that repo’s <code>README</code> / package scripts). If this project has a Sarva **dev workspace** configured, the
              orchestrator also runs install/build on the API host once when every task is done (see the card above and **Project
              chat**).
            </li>
            <li style={{ marginBottom: "0.4rem" }}>
              <strong>Run the product locally.</strong> Start the dev or preview server from that repo (often <code>
                npm run dev
              </code>
              , <code>npm start</code>, or <code>npm run serve</code>). Exercise the flows that map to your completed tasks
              (Acceptance / QA notes, PRD links, or task titles).
            </li>
            {devWs ?
              <li style={{ marginBottom: "0.4rem" }}>
                <strong>API-side dev workspace.</strong> The same repo on the API machine is under <code>{devWs}</code>. Use{" "}
                <strong>Run verify build</strong> / <strong>Start preview server</strong> in the card above (after a build,
                open the preview URL on that host).
              </li>
            : null}
            {devWs ?
              <li style={{ marginBottom: "0.4rem" }}>
                <strong>Push to GitHub from Sarva.</strong> When the API enables it, use <strong>Push to GitHub</strong> in the
                dev-workspace card above after your workspace is a <code>git clone</code> with <code>origin</code> and
                non-interactive credentials on the API host. You do not need a new Sarva project for this — same project,
                same workspace path.
              </li>
            : null}
            <li style={{ marginBottom: "0" }}>
              <strong>Sarva control plane (optional).</strong> To smoke-test this UI against a local API: from the Sarva
              monorepo root run <code>npm run dev:api</code> and <code>npm run dev:web</code>, then open{" "}
              <a href="http://127.0.0.1:5173" target="_blank" rel="noreferrer">
                http://127.0.0.1:5173
              </a>
              . See the root <code>README.md</code> for database setup.
            </li>
          </ol>
        </div>
      ) : null}
      {implSt === "executing" && boardPlannedAt && !executionKickoffAt ? (
        <div className="callout-card" style={{ marginBottom: "0.75rem" }}>
          <h3 style={{ margin: "0 0 0.5rem", fontSize: "1rem" }}>Ready for execution</h3>
          <p className="muted" style={{ fontSize: "0.78rem", margin: "0 0 0.5rem", lineHeight: 1.45 }}>
            Execution started: <strong>no</strong> · Autonomous stall meter applies after <strong>Begin execution</strong>.
          </p>
          <p className="muted" style={{ fontSize: "0.88rem", margin: "0 0 0.75rem", lineHeight: 1.55 }}>
            The SDM plan is on the board: review backlog assignments, then click <strong>Begin execution</strong>. Sarva will
            move eligible backlog rows to <strong>todo</strong>, auto-start assigned rows that pass phase gates to{" "}
            <strong>in progress</strong>, and <strong>run the coder LLM</strong> for that batch automatically (follow{" "}
            <strong>Chat</strong>). Any remaining <strong>todo</strong> rows can be started with <strong>Start work</strong>.
            Real code still happens in your repo — mark tasks <strong>done</strong> so later phases unlock.
          </p>
          <button
            type="button"
            className="primary"
            data-testid="board-begin-execution"
            disabled={beginBusy}
            onClick={() => void beginExecution()}
          >
            {beginBusy ? "Starting…" : "Begin execution"}
          </button>
        </div>
      ) : null}
      {executionKickoffAt ? (
        <>
          {boardHandsOffMinimal ? (
            <div className="callout-card" style={{ marginBottom: "0.75rem" }}>
              <h3 style={{ margin: "0 0 0.35rem", fontSize: "1rem" }}>Hands-off delivery</h3>
              <p className="muted" style={{ fontSize: "0.86rem", margin: "0", lineHeight: 1.55 }}>
                Automation is driving coders and (when enabled in API env) automated review until every task reaches{" "}
                <strong>done</strong>. While that runs, routine board edits stay compact unless you enable{" "}
                <strong>Manual board controls</strong> below (saved per project in this browser) — then columns, predecessors,
                approve/review actions, and task creation match the full board. Otherwise repeated unattended failures eventually
                restore controls automatically at the stall threshold.
              </p>
              <p className="muted" style={{ fontSize: "0.82rem", margin: "0.5rem 0 0", lineHeight: 1.45 }}>
                Stall counter: <strong>{stallCountUi}</strong> / <strong>{stallThresholdUi}</strong> before mandatory operator.
              </p>
              <div className="row" style={{ marginTop: "0.55rem", flexWrap: "wrap", gap: "0.65rem", alignItems: "center" }}>
                <label
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: "0.45rem",
                    cursor: "pointer",
                    fontSize: "0.88rem",
                    color: "var(--text)",
                  }}
                >
                  <input
                    type="checkbox"
                    checked={manualBoardControl}
                    onChange={(e) => persistManualBoardControl(e.target.checked)}
                    data-testid="board-manual-control-toggle"
                  />
                  <span>
                    <strong>Manual board controls</strong>
                    <span className="muted" style={{ fontWeight: 400 }}>
                      {" "}
                      — move columns, predecessors, approvals, add tasks anytime
                    </span>
                  </span>
                </label>
              </div>
              <div className="row" style={{ marginTop: "0.55rem", flexWrap: "wrap", gap: "0.65rem", alignItems: "center" }}>
                <button
                  type="button"
                  className="primary"
                  disabled={deliveryHookBusy || !projectId}
                  data-testid="board-run-orchestration"
                  onClick={() => void runDeliveryOrchestrationNow()}
                >
                  {deliveryHookBusy ? "Running…" : "Run orchestration"}
                </button>
                <span className="muted" style={{ fontSize: "0.8rem", lineHeight: 1.45, maxWidth: "32rem" }}>
                  Promotes eligible backlog rows, assigns unassigned todos when routing allows, moves gated work from todo →
                  in progress, queues coder LLMs — same logic as hooks after completions. Idle rows get a runnable snapshot
                  in Chat explaining blockers when nothing advances.
                </span>
              </div>
            </div>
          ) : null}
          {executionKickoffAt && handsOffEligible && summary?.autonomousOperatorRequired && summary?.allTasksDone === false ? (
            <div className="callout-card" style={{ marginBottom: "0.75rem", borderColor: "var(--muted)" }}>
              <h3 style={{ margin: "0 0 0.35rem", fontSize: "1rem" }}>Operator controls active</h3>
              <p className="muted" style={{ fontSize: "0.86rem", margin: "0", lineHeight: 1.55 }}>
                Repeated automation stalls reached the threshold—you can use full board actions (move columns, approvals,
                delete, predecessors, …). Stall counter: <strong>{stallCountUi}</strong> (fires at ≥ {stallThresholdUi}).
              </p>
              <div className="row" style={{ marginTop: "0.5rem", flexWrap: "wrap", gap: "0.5rem" }}>
                <button
                  type="button"
                  className="secondary"
                  disabled={deliveryHookBusy || !projectId}
                  data-testid="board-run-orchestration-operator"
                  onClick={() => void runDeliveryOrchestrationNow()}
                >
                  {deliveryHookBusy ? "Running…" : "Run orchestration"}
                </button>
                <button
                  type="button"
                  className="secondary"
                  disabled={deliveryHookBusy || !projectId}
                  data-testid="board-resume-hands-off"
                  onClick={() => void resumeHandsOffAutomation()}
                >
                  {deliveryHookBusy ? "Working…" : "Continue hands-off automation"}
                </button>
                <span className="muted" style={{ fontSize: "0.8rem" }}>
                  Clears stall counter once fixes are applied (Begin execution resets it automatically next kickoff too).
                </span>
              </div>
            </div>
          ) : null}
          {executionKickoffAt && !handsOffEligible ? (
            <p className="muted" style={{ fontSize: "0.82rem", marginBottom: "0.75rem", lineHeight: 1.5 }}>
              <strong>Hands-off UI disabled:</strong> set API <code>AGENT_CODER_USE_LLM</code> /{" "}
              <code>AGENT_AUTOMATED_REVIEW</code> (or stubs) together so unattended loops can finish without manual approvals.
            </p>
          ) : null}
          <p className="muted" style={{ fontSize: "0.86rem", marginBottom: "0.75rem", lineHeight: 1.55 }}>
            Execution started (delivery): <strong>yes</strong> · Autonomous stall meter: <strong>{stallCountUi}</strong> /{" "}
            <strong>{stallThresholdUi}</strong> before full board controls. Kickoff {new Date(executionKickoffAt).toLocaleString()}
            . Coder LLMs run automatically for tasks moved to <strong>in progress</strong> here and when later phases unlock —
            check <strong>Chat</strong> for orchestrator lines.
            {manualBoardControl && boardHandsOffMinimal ?
              <>
                {" "}
                <strong>Manual board controls</strong> are on for this project (this browser).
              </>
            : null}
            {summary?.allTasksDone ?
              <>
                {" "}
                All board tasks are <strong>done</strong> — delivery work for this board is complete unless you add new tasks.
              </>
            : hideRoutineBoardUi ?
              <>
                {" "}
                Rows on <strong>todo</strong> may need another engine pass — use <strong>Run orchestration</strong> above if
                they stay idle after Chat updates.
              </>
            : <>
                {" "}
                Use <strong>Start work</strong> on <strong>todo</strong> rows the automation did not start yet (unassigned rows
                or manual timing).
              </>
            }
          </p>
          {orchObs ? (
            <details
              style={{
                marginBottom: "0.75rem",
                border: "1px solid color-mix(in srgb, var(--border, #ccc) 80%, transparent)",
                borderRadius: "6px",
                padding: "0.55rem 0.75rem",
              }}
              data-testid="board-orchestration-observability"
            >
              <summary style={{ cursor: "pointer", fontWeight: 600, fontSize: "0.9rem" }}>
                Orchestration observability
              </summary>
              <div className="muted" style={{ fontSize: "0.82rem", marginTop: "0.45rem", lineHeight: 1.55 }}>
                <p style={{ margin: "0 0 0.4rem" }}>
                  Dependency edges: <strong>{orchObs.dag.dependencyEdgeCount}</strong> · tasks:{" "}
                  <strong>{orchObs.dag.taskCount}</strong> · cycles:{" "}
                  <strong
                    style={{ color: orchObs.dag.hasDirectedCycle ? "var(--danger, #b91c1c)" : "var(--muted, inherit)" }}
                  >
                    {orchObs.dag.hasDirectedCycle ? `${orchObs.dag.cycleCountTotal}` : "none"}
                  </strong>
                  {orchObs.dag.hasDirectedCycle && orchObs.dag.cycles[0]?.length ?
                    <>
                      {" "}
                      · example IDs: ({orchObs.dag.cycles[0].slice(0, 4).join(" → ")})
                      {orchObs.dag.cycles[0].length > 4 ? "…" : ""}
                    </>
                  : null}
                </p>
                <p style={{ margin: "0 0 0.25rem", fontWeight: 600 }}>Recent persisted passes</p>
                {orchObs.passes.length === 0 ?
                  <p style={{ margin: 0 }}>No persisted passes yet — run orchestration once after kickoff.</p>
                : (
                  <ul style={{ margin: 0, paddingLeft: "1.25rem" }}>
                    {orchObs.passes.map((row) => (
                      <li key={row.id} style={{ marginBottom: "0.3rem" }}>
                        {new Date(row.createdAt).toLocaleString()} · promote {(row.promotedCount ?? 0)} · assign{" "}
                        {(row.assignedCount ?? 0)} · start {(row.startedCount ?? 0)} · coders {(row.coderSubmittedCount ?? 0)}/
                        {(row.coderRunsCount ?? 0)}
                        {Array.isArray(row.partialErrors) && row.partialErrors.length > 0 ? " · partial errors" : ""}{" "}
                        <span className="muted">({row.source ?? "hook"})</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </details>
          ) : null}
        </>
      ) : null}
      {err ? <p className="err">{err}</p> : null}
      {boardInfo ? (
        <p className="muted" style={{ fontSize: "0.88rem", marginBottom: "0.5rem" }}>
          {boardInfo}
        </p>
      ) : null}
      {!hideRoutineBoardUi ? (
        <div className="row" style={{ marginBottom: "0.65rem", flexWrap: "wrap", gap: "0.5rem", alignItems: "center" }}>
          <button
            type="button"
            className="secondary"
            data-testid="board-dedupe-tasks"
            disabled={dedupeBusy || !projectId}
            onClick={() => void dedupeBoardTasks()}
          >
            {dedupeBusy ? "Checking…" : "Remove duplicate tasks"}
          </button>
          <span className="muted" style={{ fontSize: "0.82rem", lineHeight: 1.4 }}>
            Merges similar titles in backlog and todo (the AI planner dedupes automatically too). Use <strong>Delete</strong>
            on a card for a single row.
          </span>
        </div>
      ) : null}
      {!hideRoutineBoardUi ?
        <p className="muted" style={{ fontSize: "0.88rem", marginBottom: "0.5rem" }}>
          <strong>Coder drafts:</strong> generated automatically when Sarva puts a row <strong>in progress</strong> (Begin execution
          or phase unlock).
          Prefer <strong>Run orchestration</strong> plus <strong>Chat</strong>—each card exposes <strong>Run coder LLM again</strong> /{" "}
          <strong>Run automated review</strong> below when you may need quota or routing escapes.
          After a draft, work moves toward <strong>review</strong>; approve or request changes on each card where shown.
        </p>
      : <p className="muted" style={{ fontSize: "0.88rem", marginBottom: "0.5rem" }}>
          <strong>Hands-off:</strong> orchestration assigns seats where routing allows and runs coder + reviewer LLMs automatically.
          Turn on <strong>Manual board controls</strong> in the banner above whenever you need full moves and approvals without waiting for stalls.
          If nothing moves after <strong>Run orchestration</strong> + <strong>Chat</strong>, expand <strong>Stuck — retry…</strong> on a row to rerun a model manually.
          After repeated unattended failures the board restores full controls automatically.
        </p>
      }
      {summary?.phaseProgress ? (
        <div className="card" style={{ marginBottom: "0.75rem" }} data-testid="board-phase-progress">
          <h3 style={{ marginTop: 0, marginBottom: "0.4rem", fontSize: "1rem" }}>Phase progress</h3>
          <p className="muted" style={{ margin: 0, fontSize: "0.86rem" }}>
            Current unlocked phase: <strong>{summary.phaseProgress.currentUnlockedPhase}</strong>
            {summary.phaseProgress.nextPhase !== null
              ? ` · Next phase: ${summary.phaseProgress.nextPhase}`
              : " · No higher phase queued"}
            {summary.phaseProgress.nextPhase !== null
              ? summary.phaseProgress.canUnlockNextPhase
                ? " · ready to unlock next phase"
                : " · complete current phase to unlock next"
              : ""}
          </p>
          {summary.phaseProgress.blockersCurrentPhase.length > 0 ? (
            <ul style={{ margin: "0.4rem 0 0", paddingLeft: "1rem", fontSize: "0.84rem" }}>
              {summary.phaseProgress.blockersCurrentPhase.slice(0, 6).map((b) => (
                <li key={b.id}>
                  {b.title} ({b.state})
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
      {!hideRoutineBoardUi ? (
      <details className="card">
        <summary>Manual task (exception)</summary>
        <p className="muted" style={{ fontSize: "0.9rem" }}>
          Prefer PM → SDM drafts, then accept on Plan. Use this only for ad-hoc work.
        </p>
        <form className="row" onSubmit={createTask}>
          <label>
            Title
            <input value={title} onChange={(e) => setTitle(e.target.value)} data-testid="task-title-input" />
          </label>
          <button type="submit" className="secondary" data-testid="task-create">
            Add task
          </button>
        </form>
      </details>
      ) : null}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))", gap: "0.75rem" }}>
        {BOARD_STATES.map((state) => (
          <div key={state} className="card" data-testid={`column-${state}`}>
            <h3 style={{ textTransform: "capitalize", marginTop: 0 }}>{state.replace("_", " ")}</h3>
            {byState(state).map((t) => (
              <div
                key={t.id}
                style={{
                  border: "1px solid var(--border)",
                  borderRadius: 8,
                  padding: "0.5rem",
                  marginBottom: "0.5rem",
                  fontSize: "0.9rem",
                }}
                data-testid={`task-card-${t.id}`}
              >
                <strong>{t.title}</strong>
                <div style={{ color: "var(--muted)", fontSize: "0.75rem" }} data-testid={`task-phase-${t.id}`}>
                  Execution wave (phase): {t.executionPhase ?? 0}
                </div>
                {!hideRoutineBoardUi ? (
                  <form
                    className="row"
                    style={{
                      marginTop: "0.25rem",
                      flexWrap: "wrap",
                      gap: "0.35rem",
                      alignItems: "center",
                      fontSize: "0.72rem",
                    }}
                    onSubmit={(e) => {
                      e.preventDefault();
                      void patchExecutionWave(t, String(new FormData(e.currentTarget).get("execPhase") ?? ""));
                    }}
                  >
                    <label className="muted" style={{ display: "flex", gap: "0.35rem", alignItems: "center" }}>
                      Set wave
                      <input
                        key={`eph-${t.id}-${t.version}`}
                        name="execPhase"
                        type="number"
                        min={0}
                        max={50}
                        defaultValue={t.executionPhase ?? 0}
                        style={{ width: "3rem" }}
                        data-testid={`task-exec-phase-${t.id}`}
                      />
                    </label>
                    <button
                      type="submit"
                      className="secondary"
                      style={{ fontSize: "0.72rem" }}
                      disabled={phasePatchBusyId === t.id}
                    >
                      {phasePatchBusyId === t.id ? "Updating…" : "Apply"}
                    </button>
                  </form>
                ) : null}
                {t.assigneeAgentId ? (
                  <div style={{ color: "var(--muted)", fontSize: "0.75rem" }} data-testid={`task-assignee-${t.id}`}>
                    Assignee: {t.assigneeAgent?.name ?? agentLabel(t.assigneeAgentId)}
                  </div>
                ) : null}
                {t.implementingAgent ? (
                  <div style={{ color: "var(--muted)", fontSize: "0.75rem" }} data-testid={`task-implementer-${t.id}`}>
                    Implementer: {t.implementingAgent.name}
                  </div>
                ) : null}
                {t.targetRole ? (
                  <div style={{ color: "var(--muted)", fontSize: "0.75rem" }}>
                    Seat: {t.targetRole.team.name} · {t.targetRole.name}
                    {t.targetRole.roleTemplate ? ` (${t.targetRole.roleTemplate.label})` : ""}
                  </div>
                ) : null}
                {!hideRoutineBoardUi ? (
                  <TaskPredecessorsBlock task={t} tasks={tasks} onRefresh={() => void refresh()} setErr={setErr} />
                ) : null}
                {t.linkedBranch || t.linkedPrUrl ? (
                  <div
                    style={{ color: "var(--muted)", fontSize: "0.75rem" }}
                    data-testid={`task-git-links-${t.id}`}
                  >
                    {t.linkedBranch ? <div>Branch: {t.linkedBranch}</div> : null}
                    {t.linkedPrUrl ? (
                      <div>
                        <a href={t.linkedPrUrl} target="_blank" rel="noreferrer">
                          Pull request
                        </a>
                      </div>
                    ) : null}
                  </div>
                ) : null}
                <div style={{ color: "var(--muted)", fontSize: "0.75rem" }}>v{t.version}</div>
                {!hideRoutineBoardUi ? (
                  <div className="row" style={{ marginTop: "0.35rem", flexWrap: "wrap", gap: "0.35rem", alignItems: "center" }}>
                    <select
                      aria-label="Move"
                      value={t.state}
                      onChange={(e) => void setState(t, e.target.value)}
                      data-testid={`task-state-${t.id}`}
                    >
                      {BOARD_STATES.map((s) => (
                        <option key={s} value={s}>
                          {s}
                        </option>
                      ))}
                    </select>
                  </div>
                ) : (
                  <div style={{ marginTop: "0.35rem", fontSize: "0.8rem", color: "var(--muted)" }}>
                    Column: <strong>{t.state.replace("_", " ")}</strong>
                  </div>
                )}
                {(t.state === "backlog" || t.state === "todo") && !hideRoutineBoardUi && (
                  <div className="row" style={{ marginTop: "0.35rem" }}>
                    <button
                      type="button"
                      className="secondary"
                      style={{ fontSize: "0.82rem" }}
                      disabled={deleteBusyId === t.id}
                      data-testid={`task-delete-${t.id}`}
                      onClick={() => void deleteBoardTask(t)}
                    >
                      {deleteBusyId === t.id ? "Deleting…" : "Delete"}
                    </button>
                  </div>
                )}
                {t.state === "todo" && !hideRoutineBoardUi && (
                  <div className="row" style={{ marginTop: "0.35rem", flexWrap: "wrap", gap: "0.35rem" }}>
                    {t.assigneeAgentId ? (
                      <button
                        type="button"
                        className="primary"
                        style={{ fontSize: "0.82rem" }}
                        data-testid={`task-start-assigned-${t.id}`}
                        disabled={claimBusyId === t.id}
                        onClick={() => void claim(t, t.assigneeAgentId!)}
                      >
                        {claimBusyId === t.id ?
                          "Starting…"
                        : `Start work (${t.assigneeAgent?.name ?? agentLabel(t.assigneeAgentId) ?? "assignee"})`}
                      </button>
                    ) : (
                      <>
                        <p className="muted" style={{ fontSize: "0.78rem", margin: 0, flex: "1 1 100%" }}>
                          No planner assignee on this row — run AI board planning from Plan or pick an agent below to override.
                        </p>
                        <select
                          aria-label="Start work with chosen agent"
                          data-testid={`task-claim-agent-${t.id}`}
                          defaultValue=""
                          onChange={(e) => {
                            const v = e.target.value;
                            if (v) void claim(t, v);
                            e.target.value = "";
                          }}
                        >
                          <option value="">Start work with agent…</option>
                          {agents.map((a) => (
                            <option key={a.id} value={a.id}>
                              {a.name}
                            </option>
                          ))}
                        </select>
                      </>
                    )}
                  </div>
                )}
                {t.agentGeneratedBody ? (
                  <details style={{ marginTop: "0.35rem", fontSize: "0.82rem" }}>
                    <summary data-testid={`task-coder-draft-summary-${t.id}`}>Coder agent draft (LLM)</summary>
                    <pre
                      className="design-artifact-scroll"
                      style={{ maxHeight: "14rem", marginTop: "0.35rem", whiteSpace: "pre-wrap" }}
                      data-testid={`task-coder-draft-${t.id}`}
                    >
                      {t.agentGeneratedBody}
                    </pre>
                    {t.agentGeneratedAt ? (
                      <div className="muted" style={{ fontSize: "0.72rem" }}>
                        Generated {new Date(t.agentGeneratedAt).toLocaleString()}
                      </div>
                    ) : null}
                  </details>
                ) : null}
                {t.reviewHandoffMarkdown ? (
                  <details style={{ marginTop: "0.35rem", fontSize: "0.82rem" }}>
                    <summary data-testid={`task-sdm-handoff-summary-${t.id}`}>SDM review handoff</summary>
                    <pre
                      className="design-artifact-scroll"
                      style={{ maxHeight: "12rem", marginTop: "0.35rem", whiteSpace: "pre-wrap" }}
                      data-testid={`task-sdm-handoff-${t.id}`}
                    >
                      {t.reviewHandoffMarkdown}
                    </pre>
                  </details>
                ) : null}
                {t.state === "in_progress" && t.assigneeAgentId ?
                  t.coderEligible === false ?
                    <p
                      className="muted"
                      style={{ marginTop: "0.55rem", fontSize: "0.78rem", lineHeight: 1.45 }}
                      data-testid={`task-non-coder-seat-${t.id}`}
                    >
                      <strong>No coder LLM</strong> for seat <strong>{t.targetRole?.name ?? t.targetRole?.roleTemplate?.label ?? "—"}</strong>
                      ({t.targetRole?.roleTemplate?.code ?? "no template"}). QA / coordination tasks are finished manually —
                      use <strong>Mark done</strong> or move to review as your workflow requires. Only engineer seats or seats with the{" "}
                      <strong>Coder</strong> skill run implementation LLM.
                    </p>
                  : tuckManualLlmRecovery ?
                    <details
                      style={{ marginTop: "0.55rem", fontSize: "0.82rem" }}
                      data-testid={`task-run-coder-stuck-details-${t.id}`}
                    >
                      <summary className="muted" style={{ cursor: "pointer", fontSize: "0.8rem" }}>
                        Stuck — retry coder LLM
                      </summary>
                      <div style={{ marginTop: "0.45rem" }}>
                        <button
                          type="button"
                          className="secondary"
                          style={{ fontSize: "0.85rem", width: "100%", boxSizing: "border-box" }}
                          disabled={coderBusyId === t.id}
                          data-testid={`task-run-coder-${t.id}`}
                          title="Calls POST /api/v1/tasks/:id/run-coder — re-draft implementation and submit to review when finalize succeeds."
                          onClick={() => void runCoder(t)}
                        >
                          {coderBusyId === t.id ? "Calling coder model…" : "Run coder LLM again"}
                        </button>
                        <p className="muted" style={{ fontSize: "0.72rem", margin: "0.35rem 0 0", lineHeight: 1.45 }}>
                          Prefer <strong>Run orchestration</strong> once first. Use after Chat shows a stall, binding error, or
                          finalize glitch.
                        </p>
                      </div>
                    </details>
                  : <div style={{ marginTop: "0.55rem", fontSize: "0.82rem" }}>
                      <button
                        type="button"
                        className="secondary"
                        style={{ fontSize: "0.85rem", width: "100%", boxSizing: "border-box" }}
                        disabled={coderBusyId === t.id}
                        data-testid={`task-run-coder-${t.id}`}
                        title="Calls POST /api/v1/tasks/:id/run-coder — re-draft implementation and submit to review when finalize succeeds."
                        onClick={() => void runCoder(t)}
                      >
                        {coderBusyId === t.id ? "Calling coder model…" : "Run coder LLM again"}
                      </button>
                      <p className="muted" style={{ fontSize: "0.72rem", margin: "0.35rem 0 0", lineHeight: 1.45 }}>
                        Usually runs automatically when the row enters <strong>in progress</strong> — rerun after orchestration stalls
                        (see Chat) or when resolving bindings / reviewer routing.
                      </p>
                    </div>

                : null}
                {t.state === "review" ? (
                  <div style={{ marginTop: "0.35rem", fontSize: "0.82rem" }}>
                    {tuckManualLlmRecovery ?
                      <details
                        style={{ marginBottom: "0.35rem" }}
                        data-testid={`task-run-autoreview-stuck-details-${t.id}`}
                      >
                        <summary className="muted" style={{ cursor: "pointer", fontSize: "0.8rem" }}>
                          Stuck — retry automated review
                        </summary>
                        <div style={{ marginTop: "0.45rem" }}>
                          <button
                            type="button"
                            className="secondary"
                            style={{ fontSize: "0.82rem", width: "100%", boxSizing: "border-box" }}
                            disabled={autoReviewBusyId === t.id || reviewBusyId === t.id}
                            data-testid={`task-run-automated-review-${t.id}`}
                            onClick={() => void runAutomatedReviewManual(t)}
                          >
                            {autoReviewBusyId === t.id ? "Running reviewer model…" : "Run automated review now"}
                          </button>
                          <p className="muted" style={{ fontSize: "0.72rem", margin: "0.3rem 0 0", lineHeight: 1.4 }}>
                            Automated review normally runs once when work lands here; use after Chat indicates a stalled or
                            failed verdict attempt.
                          </p>
                        </div>
                      </details>
                    : <div style={{ marginBottom: hideRoutineBoardUi ? "0.35rem" : "0.5rem" }}>
                        <button
                          type="button"
                          className="secondary"
                          style={{ fontSize: "0.82rem", width: "100%", boxSizing: "border-box" }}
                          disabled={autoReviewBusyId === t.id || reviewBusyId === t.id}
                          data-testid={`task-run-automated-review-${t.id}`}
                          onClick={() => void runAutomatedReviewManual(t)}
                        >
                          {autoReviewBusyId === t.id ? "Running reviewer model…" : "Run automated review now"}
                        </button>
                        <p className="muted" style={{ fontSize: "0.72rem", margin: "0.3rem 0 0", lineHeight: 1.4 }}>
                          Calls the reviewer LLM again (quota errors or stalls — confirm in Chat).
                        </p>
                      </div>
                    }
                    {hideRoutineBoardUi ?
                      <p className="muted" style={{ fontSize: "0.8rem", lineHeight: 1.45 }}>
                        Automated verdicts run when unattended review is configured; manual Approve / Request controls appear
                        if stalls cross the configured threshold — until then rely on orchestration plus any{" "}
                        <strong>Stuck — retry…</strong> section you expand on a row.
                      </p>
                    : <>
                        {typeof t.reviewRevisionCount === "number" && t.reviewRevisionCount > 0 ? (
                          <div className="muted" style={{ fontSize: "0.74rem", marginBottom: "0.35rem" }}>
                            Revision rounds applied (fixes requested): <strong>{t.reviewRevisionCount}</strong>
                          </div>
                        ) : null}
                        <label style={{ display: "block", marginBottom: "0.25rem" }}>
                          <span className="muted" style={{ fontSize: "0.75rem" }}>
                            Review notes (optional for approve; recommended for request changes)
                          </span>
                          <textarea
                            value={reviewNotes[t.id] ?? ""}
                            onChange={(e) => setReviewNotes((m) => ({ ...m, [t.id]: e.target.value }))}
                            rows={2}
                            style={{ display: "block", width: "100%", marginTop: "0.25rem" }}
                            data-testid={`task-review-notes-${t.id}`}
                          />
                        </label>
                        <div className="row" style={{ gap: "0.35rem", flexWrap: "wrap" }}>
                          <button
                            type="button"
                            className="primary"
                            disabled={reviewBusyId === t.id || autoReviewBusyId === t.id}
                            data-testid={`task-review-approve-${t.id}`}
                            onClick={() => void reviewVerdict(t, "approve")}
                          >
                            {reviewBusyId === t.id ? "…" : "Approve → done"}
                          </button>
                          <button
                            type="button"
                            className="secondary"
                            disabled={reviewBusyId === t.id || autoReviewBusyId === t.id}
                            data-testid={`task-review-request-changes-${t.id}`}
                            onClick={() => void reviewVerdict(t, "request_changes")}
                          >
                            Request changes → implementer
                          </button>
                        </div>
                      </>
                    }
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

export function ProjectSprintsTab() {
  const { projectId = "" } = useParams();
  const [sprints, setSprints] = useState<Sprint[]>([]);
  const [name, setName] = useState("Sprint 1");
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    const list = await api<Sprint[]>(`/api/v1/sprints?projectId=${encodeURIComponent(projectId)}`);
    setSprints(list);
  }, [projectId]);

  useEffect(() => {
    void load().catch(() => setSprints([]));
  }, [load]);

  async function add(e: FormEvent) {
    e.preventDefault();
    setErr(null);
    try {
      await api("/api/v1/sprints", { method: "POST", json: { projectId, name } });
      setName("Sprint 2");
      await load();
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : "Failed");
    }
  }

  return (
    <div data-testid="project-sprints">
      <div className="card">
        <form className="row" onSubmit={add}>
          <label>
            Sprint name
            <input value={name} onChange={(e) => setName(e.target.value)} data-testid="sprint-name" />
          </label>
          <button type="submit" className="primary" data-testid="sprint-add">
            Add sprint
          </button>
        </form>
        {err ? <p className="err">{err}</p> : null}
      </div>
      <div className="card">
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Id</th>
            </tr>
          </thead>
          <tbody>
            {sprints.map((s) => (
              <tr key={s.id}>
                <td>{s.name}</td>
                <td>{s.id}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

type ProjectChatMsg = {
  id: string;
  actorKind: string;
  actorLabel: string;
  actorId: string | null;
  body: string;
  meta: unknown;
  createdAt: string;
};

function chatMetaEventLabel(meta: unknown): string | null {
  if (!meta || typeof meta !== "object") return null;
  const e = (meta as Record<string, unknown>).event;
  return typeof e === "string" && e.trim() ? e : null;
}

/** Project-scoped orchestration/agent/user timeline (REST `.../projects/:id/chat`). */
export function ProjectChatTab() {
  const { projectId = "" } = useParams();
  const [items, setItems] = useState<ProjectChatMsg[]>([]);
  const [draft, setDraft] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [filterActorKind, setFilterActorKind] = useState<string>("");
  const [filterMetaPrefix, setFilterMetaPrefix] = useState<string>("");

  const load = useCallback(async () => {
    if (!projectId) return;
    const params = new URLSearchParams();
    if (filterActorKind.trim()) params.set("actorKind", filterActorKind.trim());
    if (filterMetaPrefix.trim()) params.set("metaEventPrefix", filterMetaPrefix.trim());
    const qs = params.toString();
    const suffix = qs ? `?${qs}` : "";
    const data = await api<{ items: ProjectChatMsg[] }>(
      `/api/v1/projects/${encodeURIComponent(projectId)}/chat${suffix}`
    );
    setItems(data.items);
  }, [projectId, filterActorKind, filterMetaPrefix]);

  useEffect(() => {
    void load().catch(() => setItems([]));
  }, [load]);

  const chatPollBusy = useRef(false);
  useEffect(() => {
    if (!projectId) return undefined;

    const poll = () => {
      if (document.visibilityState !== "visible") return;
      if (chatPollBusy.current) return;
      chatPollBusy.current = true;
      void load()
        .catch(() => undefined)
        .finally(() => {
          chatPollBusy.current = false;
        });
    };

    const id = window.setInterval(poll, PROJECT_LIVE_REFRESH_INTERVAL_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") {
        void load().catch(() => undefined);
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [load, projectId]);

  async function post(e: FormEvent) {
    e.preventDefault();
    const trimmed = draft.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    setErr(null);
    try {
      await api(`/api/v1/projects/${encodeURIComponent(projectId)}/chat`, {
        method: "POST",
        json: { body: trimmed },
      });
      setDraft("");
      await load();
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : "Send failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div data-testid="project-chat">
      <p className="muted" style={{ marginBottom: "1rem", fontSize: "0.9rem" }}>
        Timeline of orchestration, agent milestones, and operator notes for this project. <strong>Newest first.</strong> Lines
        refresh automatically every few seconds while you keep this tab open (browser tab must be visible). Filters apply to
        the latest 500 messages from the API (narrow by actor kind and/or{" "}
        <code className="mono">meta.event</code> prefixes).
      </p>
      <div className="card" style={{ marginBottom: "1rem" }}>
        <div className="row" style={{ alignItems: "flex-end", flexWrap: "wrap", gap: "0.65rem" }}>
          <label>
            Actor filter
            <select
              value={filterActorKind}
              onChange={(e) => setFilterActorKind(e.target.value)}
              data-testid="project-chat-filter-actor"
            >
              <option value="">All</option>
              <option value="orchestrator">Orchestrator</option>
              <option value="agent">Agent</option>
              <option value="user">User</option>
            </select>
          </label>
          <label>
            Event prefix (<code className="mono">meta.event</code>)
            <select
              value={filterMetaPrefix}
              onChange={(e) => setFilterMetaPrefix(e.target.value)}
              data-testid="project-chat-filter-event"
            >
              <option value="">Any event</option>
              <option value="delivery.">delivery.*</option>
              <option value="prd.">prd.*</option>
              <option value="task.">task.*</option>
            </select>
          </label>
        </div>
      </div>
      <div className="card">
        <h2 style={{ marginTop: 0 }}>Timeline</h2>
        {items.length === 0 ? (
          <p className="muted">No messages yet.</p>
        ) : (
          <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
            {items.map((m) => {
              const eventLabel = chatMetaEventLabel(m.meta);
              return (
              <li
                key={m.id}
                style={{
                  borderBottom: "1px solid var(--border)",
                  padding: "0.65rem 0",
                  fontSize: "0.9rem",
                }}
              >
                <div style={{ marginBottom: "0.35rem", color: "var(--muted)", fontSize: "0.75rem" }}>
                  {new Date(m.createdAt).toLocaleString()} ·{" "}
                  <span style={{ fontWeight: 600, color: "var(--foreground, inherit)" }}>
                    [{m.actorKind}] {m.actorLabel}
                  </span>
                  {eventLabel ?
                    <>
                      {" "}
                      · <code className="mono">{eventLabel}</code>
                    </>
                  : null}
                </div>
                <div style={{ whiteSpace: "pre-wrap", lineHeight: 1.45 }}>{m.body}</div>
              </li>
            );
            })}
          </ul>
        )}
      </div>
      <div className="card">
        <h2 style={{ marginTop: 0 }}>Operator message</h2>
        <form onSubmit={post}>
          <label>
            Message
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              rows={4}
              data-testid="project-chat-draft"
              disabled={busy}
            />
          </label>
          <button type="submit" className="primary" disabled={busy} data-testid="project-chat-send">
            {busy ? "Sending…" : "Send"}
          </button>
        </form>
        {err ? <p className="err">{err}</p> : null}
      </div>
    </div>
  );
}
