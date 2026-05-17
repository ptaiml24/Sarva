import { useCallback, useEffect, useState, type Dispatch, type SetStateAction } from "react";
import { Link, NavLink, Outlet, useOutletContext, useParams } from "react-router-dom";
import { api } from "../api/http.js";

function formatHubImplementationStatus(st: string | undefined): string {
  const raw = st?.trim() || "draft";
  if (raw === "draft") return "draft";
  if (raw === "closed") return "Closed";
  return raw.replace(/_/g, " ");
}

/** Narrow slice of GET …/delivery/summary for hub-level gates. */
type ProjectDeliverySummaryBrief = {
  implementationStatus: string;
  readyForUat: boolean;
  /** From summary: zero non-done tasks (API convention). UI requires ≥1 task before showing gates. */
  allTasksDone?: boolean;
};

export type ReqLinkRow = { label?: string; url: string };

export type ProjectFull = {
  id: string;
  name: string;
  repoAssociationMode: string;
  /** SOP pipeline: draft → delivery_active → … → ready_for_uat → closed */
  implementationStatus?: string;
  intakeBaselineAt?: string | null;
  readyForUat?: boolean;
  backlogFeedbackNotes?: string | null;
  governanceMode: string | null;
  deliveryPhase: string | null;
  pmOrchestratorAgentId: string | null;
  designatedApproverUserId: string | null;
  /** JSON blob; `prePushVerify` gates workspace Git push when enabled (API applies policy). */
  deliveryPolicy: unknown | null;
  pmOrchestratorAgent: { id: string; name: string; status: string } | null;
  designatedApprover: { id: string; email: string } | null;
  /** Task counts by `state` (Kanban); aligns dashboard and project hub. */
  taskStateSummary?: Record<string, number>;
  _count?: {
    tasks: number;
    proposedItems: number;
    teamLinks: number;
    sprints: number;
  };
  context: {
    brief: string | null;
    requirementsLinks: unknown;
    repoScope: string | null;
    analysisNotes: string | null;
    goals: string | null;
    documentRepositoryUrl: string | null;
  } | null;
  repoScope: {
    cloneUrl: string | null;
    rootPath: string | null;
    branchDefault: string | null;
  } | null;
  teamLinks: { teamId: string; team: { id: string; name: string } }[];
  designArtifacts?: { id: string; title: string; body: string; status: string; updatedAt: string }[];
  roleAssignments?: { id: string; duty: string; agentId: string; agent: { id: string; name: string; status: string } }[];
  workflowId?: string | null;
  workflow?: { id: string; code: string; name: string; kind: string } | null;
  prdSummary?: {
    approved: { id: string; title: string; updatedAt: string } | null;
    draft: { id: string; title: string; updatedAt: string } | null;
  };
  /** On the API host: folder where delivery/coder scaffolds implementation (see `SARVA_AGENT_WORKSPACE`). */
  devWorkspacePath?: string | null;
};

export type ProjectOutletContext = {
  project: ProjectFull;
  reloadProject: () => Promise<void>;
  /** Persists while Plan tab runs publish-and-plan so switching project sub-tabs does not look “idle”. */
  planPublishBusy: boolean;
  setPlanPublishBusy: Dispatch<SetStateAction<boolean>>;
};

export function useProjectOutlet(): ProjectOutletContext {
  return useOutletContext<ProjectOutletContext>();
}

export function ProjectLayout() {
  const { projectId = "" } = useParams();
  const [project, setProject] = useState<ProjectFull | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [planPublishBusy, setPlanPublishBusy] = useState(false);
  /** Undefined = not fetched yet for this hub load; null = fetch failed or summary unavailable. */
  const [deliverySummary, setDeliverySummary] = useState<ProjectDeliverySummaryBrief | null | undefined>(undefined);
  const [gateBusy, setGateBusy] = useState(false);
  const [gateMsg, setGateMsg] = useState<string | null>(null);
  const [gateErr, setGateErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!projectId) return;
    setErr(null);
    setDeliverySummary(undefined);
    try {
      const p = await api<ProjectFull>(`/api/v1/projects/${encodeURIComponent(projectId)}`);
      setProject(p);
      try {
        const s = await api<ProjectDeliverySummaryBrief>(
          `/api/v1/projects/${encodeURIComponent(projectId)}/delivery/summary`
        );
        setDeliverySummary(s);
      } catch {
        setDeliverySummary(null);
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to load project");
      setProject(null);
      setDeliverySummary(null);
    }
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    setPlanPublishBusy(false);
  }, [projectId]);

  if (err && !project) {
    return (
      <div>
        <p className="err">{err}</p>
        <Link to="/projects">Back to projects</Link>
      </div>
    );
  }

  if (!project) {
    return <p>Loading…</p>;
  }

  const base = `/projects/${project.id}`;
  const intakeSaved = Boolean(
    project.context?.brief?.trim() || project.context?.goals?.trim()
  );
  const ts = project.taskStateSummary ?? {};
  const taskLine = ["todo", "in_progress", "review", "done"]
    .map((k) => (ts[k] ? `${k.replace("_", " ")} ${ts[k]}` : null))
    .filter(Boolean)
    .join(" · ");

  const taskTotal = project._count?.tasks ?? 0;
  const implGate = deliverySummary?.implementationStatus ?? project.implementationStatus ?? "draft";
  const everyBoardTaskDone =
    deliverySummary !== undefined &&
    deliverySummary !== null &&
    deliverySummary.allTasksDone === true &&
    taskTotal >= 1;
  const showUatClosedActions =
    everyBoardTaskDone &&
    implGate !== "closed" &&
    (implGate === "executing" || implGate === "ready_for_uat");
  const uatMarked = Boolean(project.readyForUat ?? deliverySummary?.readyForUat);

  async function runDeliveryGatePatch(okMessage: string, json: Record<string, unknown>) {
    if (!project?.id || gateBusy) return;
    setGateBusy(true);
    setGateMsg(null);
    setGateErr(null);
    try {
      await api(`/api/v1/projects/${encodeURIComponent(project.id)}/delivery`, {
        method: "PATCH",
        json,
      });
      setGateMsg(okMessage);
      await load();
    } catch (e) {
      setGateErr(e instanceof Error ? e.message : "Request failed");
    } finally {
      setGateBusy(false);
    }
  }

  return (
    <div data-testid="project-hub">
      <div style={{ marginBottom: "1rem" }}>
        <Link to="/projects">← Projects</Link>
      </div>
      <header className="project-hub-head" aria-labelledby="project-title-heading">
        <h1 id="project-title-heading" data-testid="project-title">
          {project.name}
        </h1>
        <div className="project-hub-workflow" data-testid="project-hub-workflow">
          <span className="project-hub-workflow-label">Delivery workflow</span>
          <span className="project-hub-workflow-value">{project.workflow?.name ?? "—"}</span>
          {project.workflow?.kind ?
            <span className="project-hub-workflow-kind muted">{project.workflow.kind}</span>
          : null}
        </div>
      </header>
      {project.implementationStatus === "closed" ? (
        <p className="muted" style={{ margin: "0 0 1rem", fontSize: "0.9rem" }} data-testid="delivery-closed-notice">
          This project is marked <strong>closed</strong> (delivery complete). Reopen is not available from the UI yet.
        </p>
      ) : null}
      {showUatClosedActions ?
        <div
          className="card"
          data-testid="project-delivery-gate-actions"
          style={{ marginBottom: "1rem", padding: "0.75rem 1rem", fontSize: "0.9rem" }}
        >
          <p style={{ margin: "0 0 0.5rem", fontWeight: 600 }}>Delivery gate</p>
          <p className="muted" style={{ margin: "0 0 0.65rem", fontSize: "0.82rem", lineHeight: 1.45 }}>
            All <strong>{taskTotal}</strong> board tasks are <strong>done</strong>. Mark ready for UAT first; then you can mark
            the project closed. These actions apply across every tab.
          </p>
          <div className="row" style={{ gap: "0.5rem", alignItems: "center", flexWrap: "wrap" }}>
            <button
              type="button"
              className="primary"
              data-testid="delivery-ready-uat"
              disabled={gateBusy || uatMarked}
              onClick={() =>
                void runDeliveryGatePatch("Marked ready for UAT.", { readyForUat: true })
              }
            >
              Mark ready for UAT
            </button>
            {uatMarked ?
              <>
                <button
                  type="button"
                  className="secondary"
                  data-testid="delivery-mark-closed"
                  disabled={gateBusy}
                  title="Sets implementation status to Closed. Allowed only after marking ready for UAT."
                  onClick={() => {
                    if (
                      !window.confirm(
                        "Mark this project as closed? This records delivery as complete (implementation status: closed)."
                      )
                    ) {
                      return;
                    }
                    void runDeliveryGatePatch("Project marked closed.", { closed: true });
                  }}
                >
                  Mark project closed
                </button>
                <span className="muted">Marked ready for UAT — close when stakeholder sign‑off is done.</span>
              </>
            : null}
          </div>
          {gateMsg ? (
            <p className="ok" style={{ marginTop: "0.5rem", marginBottom: 0 }}>
              {gateMsg}
            </p>
          ) : null}
          {gateErr ? (
            <p className="err" style={{ marginTop: "0.5rem", marginBottom: 0 }}>
              {gateErr}
            </p>
          ) : null}
        </div>
      : null}
      <div
        className="card"
        data-testid="project-status-strip"
        style={{ marginBottom: "1rem", padding: "0.75rem 1rem", fontSize: "0.88rem" }}
      >
        <strong style={{ display: "block", marginBottom: "0.35rem" }}>Project status</strong>
        <ul className="muted" style={{ margin: 0, paddingLeft: "1.1rem", lineHeight: 1.55 }}>
          <li>
            <strong>Delivery phase:</strong> {project.deliveryPhase ?? "—"}{" "}
            <span className="muted">(SDLC label; pipeline status below)</span>
          </li>
          <li>
            <strong>Implementation status:</strong> {formatHubImplementationStatus(project.implementationStatus)}
            {project.readyForUat && project.implementationStatus !== "closed" ?
              " · ready for UAT"
            : null}
            {project.intakeBaselineAt ? (
              <>
                {" "}
                · baseline {new Date(project.intakeBaselineAt).toLocaleString()}
              </>
            ) : null}
          </li>
          <li>
            <strong>Delivery team:</strong>{" "}
            {project.teamLinks.length === 0 ?
              "— link exactly one team on Intake"
            : project.teamLinks.length === 1 ?
              `${project.teamLinks[0].team.name} (${project.teamLinks[0].teamId})`
            : `${project.teamLinks.length} linked — only one supported; unlink extras on Intake`}
          </li>
          <li>
            <strong>Intake saved:</strong> {intakeSaved ? "yes (brief/goals)" : "no — add brief or goals on Intake"}
          </li>
          <li>
            <strong>PM orchestrator:</strong> {project.pmOrchestratorAgent?.name ?? "—"}
          </li>
          <li>
            <strong>Proposed backlog items:</strong> {project._count?.proposedItems ?? "—"}
          </li>
          <li>
            <strong>Tasks on board:</strong> {project._count?.tasks ?? 0} total
            {taskLine ? (
              <>
                {" "}
                — {taskLine}
              </>
            ) : null}
          </li>
        </ul>
      </div>
      <nav className="project-tabs" style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", marginBottom: "1rem" }}>
        <NavLink to={`${base}/intake`} data-testid="tab-intake">
          1 · Intake
        </NavLink>
        <NavLink to={`${base}/requirements`} data-testid="tab-requirements">
          2 · Requirements
        </NavLink>
        <NavLink to={`${base}/design`} data-testid="tab-design">
          3 · Design
        </NavLink>
        <NavLink to={`${base}/backlog`} data-testid="tab-backlog">
          4 · Backlog
        </NavLink>
        <NavLink to={`${base}/plan`} data-testid="tab-plan">
          5 · Plan
        </NavLink>
        <NavLink to={`${base}/board`} data-testid="tab-board">
          6 · Board
        </NavLink>
        <NavLink to={`${base}/chat`} data-testid="tab-chat">
          7 · Chat
        </NavLink>
        <NavLink to={`${base}/activity-log`} data-testid="tab-activity-log">
          8 · Activity log
        </NavLink>
      </nav>
      <Outlet
        context={
          {
            project,
            reloadProject: load,
            planPublishBusy,
            setPlanPublishBusy,
          } satisfies ProjectOutletContext
        }
      />
    </div>
  );
}
