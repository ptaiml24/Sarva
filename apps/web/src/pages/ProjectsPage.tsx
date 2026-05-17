import { FormEvent, useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api } from "../api/http.js";
import { useAuth } from "../auth/AuthContext.js";
import { formatProjectImplementationStatus } from "../lib/formatProjectImplementationStatus.js";

type Project = {
  id: string;
  name: string;
  repoAssociationMode: string;
  implementationStatus?: string;
  intakeBaselineAt?: string | null;
  readyForUat?: boolean;
  _count?: { tasks: number; teamLinks: number; sprints: number; proposedItems: number };
  context?: { brief: string | null; goals: string | null } | null;
};

type DeliveryWorkflowRow = { id: string; name: string; kind: string };

/** Template kind on create, or backlog-only mode with no `workflowId` (legacy SDM tab). */
type WorkflowKindChoice = "full_e2e" | "feature_dev" | "legacy_none";

function projectIsEmpty(p: Project): boolean {
  const c = p._count;
  if (!c) return false;
  return c.tasks === 0 && c.teamLinks === 0 && c.sprints === 0 && c.proposedItems === 0;
}

export function ProjectsPage() {
  const navigate = useNavigate();
  const { role } = useAuth();
  const admin = role === "admin";
  const [projects, setProjects] = useState<Project[]>([]);
  const [name, setName] = useState("");
  const [workflowKindChoice, setWorkflowKindChoice] = useState<WorkflowKindChoice>("full_e2e");
  const [workflows, setWorkflows] = useState<DeliveryWorkflowRow[]>([]);
  const [err, setErr] = useState<string | null>(null);

  async function load() {
    setErr(null);
    try {
      const list = await api<Project[]>("/api/v1/projects");
      setProjects(list);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed");
    }
  }

  useEffect(() => {
    void load();
  }, []);

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
    const hasE2e = workflows.some((w) => w.kind === "full_e2e");
    const hasFd = workflows.some((w) => w.kind === "feature_dev");
    if (!hasE2e && hasFd) {
      setWorkflowKindChoice((prev) => (prev === "full_e2e" ? "feature_dev" : prev));
    }
  }, [workflows]);

  async function create(e: FormEvent) {
    e.preventDefault();
    setErr(null);
    try {
      if (workflowKindChoice === "legacy_none") {
        const project = await api<{ id: string }>("/api/v1/projects", {
          method: "POST",
          json: {
            name,
            repoAssociationMode: "dedicated_repo",
          },
        });
        setName("");
        await load();
        navigate(`/projects/${project.id}/intake`);
        return;
      }

      const workflowId = workflows.find((w) => w.kind === workflowKindChoice)?.id;
      if (!workflowId) {
        setErr(
          `No "${workflowKindChoice === "full_e2e" ? "full end-to-end" : "feature development"}" workflow in the catalog. Add one under Admin → Delivery workflows.`
        );
        return;
      }
      const project = await api<{ id: string }>("/api/v1/projects", {
        method: "POST",
        json: {
          name,
          repoAssociationMode: "dedicated_repo",
          workflowId,
        },
      });
      setName("");
      await load();
      navigate(`/projects/${project.id}/intake`);
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : "Failed");
    }
  }

  async function removeProject(id: string) {
    if (!admin) return;
    if (!window.confirm("Delete this project? Only allowed when it has no tasks, teams, sprints, or PM drafts.")) {
      return;
    }
    setErr(null);
    try {
      await api(`/api/v1/projects/${id}`, { method: "DELETE" });
      await load();
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : "Delete failed");
    }
  }

  return (
    <div data-testid="projects-page">
      <p className="muted page-intro">
        <strong>Work → Projects</strong>. After you create a project, complete <strong>Intake</strong> (definition + repo) and{" "}
        <strong>link at least one team</strong> so seats show up on Plan/Board. Follow the ordered{" "}
        <Link to="/dashboard">Dashboard → Company setup</Link> checklist for the full path from company to delivery.
      </p>
      <div className="card">
        <h2 className="card-title" style={{ marginTop: 0 }}>
          End-to-end path (summary)
        </h2>
        <ol className="muted" style={{ fontSize: "0.9rem", lineHeight: 1.6, margin: "0.25rem 0 0", paddingLeft: "1.25rem" }}>
          <li>
            <Link to="/organization/business-units">Business units</Link> — company (e.g. Sarva) + at least one BU under it
          </li>
          <li>
            <Link to="/organization/skills-models">Roles &amp; skills</Link> — catalogs (defaults ship with migrations)
          </li>
          <li>
            <Link to="/agents">Agents</Link> — roster, then <Link to="/organization/teams">Teams</Link> for seats, skills, and
            seat ↔ agent mapping
          </li>
          <li>
            <strong>Projects</strong> (this page) — create, then Intake for definition + <strong>link team</strong>
          </li>
        </ol>
      </div>
      <div className="card">
        <form className="row" onSubmit={create}>
          <label>
            Project name
            <input value={name} onChange={(e) => setName(e.target.value)} data-testid="project-name-input" required />
          </label>
          <label>
            Delivery workflow
            <select
              value={workflowKindChoice}
              onChange={(e) => setWorkflowKindChoice(e.target.value as WorkflowKindChoice)}
              data-testid="project-workflow-kind"
            >
              <option value="full_e2e" disabled={!workflows.some((w) => w.kind === "full_e2e")}>
                Full end-to-end project
              </option>
              <option value="feature_dev" disabled={!workflows.some((w) => w.kind === "feature_dev")}>
                Feature development
              </option>
              <option value="legacy_none">Legacy backlog only (no workflow template)</option>
            </select>
            <span className="muted" style={{ display: "block", fontSize: "0.85rem", marginTop: "0.25rem", fontWeight: 400 }}>
              {workflowKindChoice === "legacy_none" ?
                "Backlog tab uses the intake-based draft backlog flow (no PRD/design workflow gates)."
              : workflowKindChoice === "feature_dev" ?
                "Set a Git clone URL or local repo root on Intake before workflow steps that need a codebase."
              : "Uses the first delivery workflow in the catalog with this kind (by name)."}
            </span>
          </label>
          <button type="submit" className="primary" data-testid="project-create">
            Create project
          </button>
        </form>
        {err ? <p className="err">{err}</p> : null}
      </div>
      <div className="card">
        <h2>All projects</h2>
        {projects.length === 0 ? (
          <p>No projects yet.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Status</th>
                <th>Baseline</th>
                <th>Mode</th>
                <th>Team</th>
                <th />
                {admin ? <th /> : null}
              </tr>
            </thead>
            <tbody>
              {projects.map((p) => (
                <tr key={p.id}>
                  <td>{p.name}</td>
                  <td className="muted" data-testid={`project-status-${p.id}`}>
                    {formatProjectImplementationStatus(p.implementationStatus)}
                    {p.readyForUat ? " · UAT" : null}
                  </td>
                  <td className="muted">
                    {p.intakeBaselineAt ?
                      new Date(p.intakeBaselineAt).toLocaleDateString()
                    : p.implementationStatus && p.implementationStatus !== "draft" ?
                      "yes"
                    : "—"}
                  </td>
                  <td>{p.repoAssociationMode}</td>
                  <td className="muted">
                    {(p._count?.teamLinks ?? 0) === 0 ?
                      "— link on Intake"
                    : (p._count?.teamLinks ?? 0) === 1 ?
                      "1 linked"
                    : `${p._count?.teamLinks} linked (max 1)`}
                  </td>
                  <td>
                    <Link to={`/projects/${p.id}/intake`} data-testid={`open-project-${p.id}`}>
                      Open
                    </Link>
                  </td>
                  {admin ? (
                    <td>
                      {projectIsEmpty(p) ? (
                        <button
                          type="button"
                          className="secondary"
                          data-testid={`delete-project-${p.id}`}
                          onClick={() => void removeProject(p.id)}
                        >
                          Delete
                        </button>
                      ) : (
                        <span className="muted" title="Remove tasks, team links, sprints, and PM drafts first">
                          —
                        </span>
                      )}
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
