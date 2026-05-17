import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api/http.js";
import { formatProjectImplementationStatus } from "../lib/formatProjectImplementationStatus.js";

type CompanyRow = { id: string; name: string };
type TeamRow = { id: string; name: string; businessUnitId: string | null; _count?: { roles: number } };
type AgentSeatLite = { assignedAgentId: string | null };
type Project = {
  id: string;
  name: string;
  /** SDLC lane label — often stale for new projects (e.g. intake); prefer implementationStatus for lifecycle. */
  deliveryPhase?: string | null;
  implementationStatus?: string;
  readyForUat?: boolean;
  _count?: { tasks: number; teamLinks: number; sprints: number; proposedItems: number };
  context?: { brief: string | null; goals: string | null } | null;
  /** Same shape as project detail API — task counts by Kanban state. */
  taskStateSummary?: Record<string, number>;
};
type Agent = { id: string; name: string; status: string };
type BU = { id: string; name: string; _count?: { teams: number } };

function projectTaskCounts(p: Project): { total: number; done: number; open: number } {
  const ts = p.taskStateSummary ?? {};
  const total = p._count?.tasks ?? Object.values(ts).reduce((a, n) => a + (typeof n === "number" ? n : 0), 0);
  const done = typeof ts.done === "number" ? ts.done : 0;
  const open = Math.max(0, total - done);
  return { total, done, open };
}

type SetupStep = { id: string; label: string; done: boolean; to: string; hint?: string };

export function DashboardPage() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [teams, setTeams] = useState<TeamRow[]>([]);
  const [bus, setBus] = useState<BU[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [setupSteps, setSetupSteps] = useState<SetupStep[] | null>(null);
  /** Full setup checklist: expanded until user collapses; auto-collapses when all steps complete. */
  const [setupChecklistOpen, setSetupChecklistOpen] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [co, teamRows, roleTemplates, skillTemplates, seats, list, agentList, buList] = await Promise.all([
          api<CompanyRow | null>("/api/v1/company"),
          api<TeamRow[]>("/api/v1/teams"),
          api<{ id: string }[]>("/api/v1/role-templates").catch(() => []),
          api<{ id: string }[]>("/api/v1/skill-templates").catch(() => []),
          api<AgentSeatLite[]>("/api/v1/agent-seats").catch(() => []),
          api<Project[]>("/api/v1/projects"),
          api<Agent[]>("/api/v1/agents"),
          api<BU[]>("/api/v1/business-units"),
        ]);
        if (cancelled) return;
        setProjects(list);
        setAgents(agentList);
        setTeams(teamRows);
        setBus(buList);

        const hasCompany = Boolean(co);
        const catalogOk = roleTemplates.length > 0 && skillTemplates.length > 0;
        const hasBU = buList.length > 0;
        const teamWithSeats = teamRows.some((t) => (t._count?.roles ?? 0) > 0);
        const hasAgents = agentList.length > 0;
        const seatAssigned = seats.some((s) => Boolean(s.assignedAgentId));
        const hasProject = list.length > 0;
        const intakeOk = list.some((p) => Boolean(p.context?.brief?.trim() || p.context?.goals?.trim()));
        const projectLinked = list.some((p) => (p._count?.teamLinks ?? 0) > 0);

        const firstProjectId = list[0]?.id;
        const intakeTarget = firstProjectId ? `/projects/${firstProjectId}/intake` : "/projects";

        setSetupSteps([
          {
            id: "company",
            label: "Company exists",
            done: hasCompany,
            to: "/organization/business-units",
            hint: "Create the company once (admin). New seeds use the name “Sarva”.",
          },
          {
            id: "catalog",
            label: "Role & skill catalogs ready",
            done: catalogOk,
            to: "/organization/skills-models",
            hint: "Ships with defaults from migrations; extend under Roles & skills (admin).",
          },
          {
            id: "bu",
            label: "Business unit under the company",
            done: hasBU,
            to: "/organization/business-units",
            hint: "Add at least one BU, then attach each team to it (recommended structure).",
          },
          {
            id: "teams",
            label: "Team with seats + seat skills",
            done: teamWithSeats,
            to: "/organization/teams",
            hint: "Create a team (headcount per Sarva role type), pick BU, then link skills to each seat.",
          },
          {
            id: "agents",
            label: "Agents in roster",
            done: hasAgents,
            to: "/agents",
            hint: "Work → Agents (admin creates roster entries).",
          },
          {
            id: "assign",
            label: "Agents assigned to seats",
            done: seatAssigned,
            to: "/organization/teams",
            hint: "Teams → Seat ↔ agent assignments.",
          },
          {
            id: "project",
            label: "Project created",
            done: hasProject,
            to: "/projects",
            hint: "Work → Projects → Create.",
          },
          {
            id: "intake",
            label: "Project definition (intake)",
            done: intakeOk,
            to: intakeTarget,
            hint: "Goals and/or brief saved on Intake.",
          },
          {
            id: "link",
            label: "Project linked to team",
            done: projectLinked,
            to: intakeTarget,
            hint: "Intake → Linked teams (any signed-in user).",
          },
        ]);
      } catch (e) {
        if (!cancelled) setErr(e instanceof Error ? e.message : "Failed to load");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const setupComplete = Boolean(setupSteps && setupSteps.length > 0 && setupSteps.every((s) => s.done));
  useEffect(() => {
    if (setupComplete) setSetupChecklistOpen(false);
  }, [setupComplete]);

  const taskRollup = useMemo(() => {
    let total = 0;
    let done = 0;
    for (const p of projects) {
      const c = projectTaskCounts(p);
      total += c.total;
      done += c.done;
    }
    return { total, done, open: Math.max(0, total - done) };
  }, [projects]);

  const activeAgents = agents.filter((a) => a.status === "active").length;

  /** Teams grouped by BU for org snapshot — includes `null` for teams with no BU. */
  const teamsByBuId = useMemo(() => {
    const m = new Map<string | null, TeamRow[]>();
    for (const t of teams) {
      const buId = t.businessUnitId ?? null;
      let arr = m.get(buId);
      if (!arr) {
        arr = [];
        m.set(buId, arr);
      }
      arr.push(t);
    }
    return m;
  }, [teams]);

  const teamsWithoutBu = teamsByBuId.get(null) ?? [];

  const setupNext = useMemo(() => setupSteps?.find((s) => !s.done) ?? null, [setupSteps]);

  return (
    <div data-testid="dashboard">
      {err ? <p className="err">{err}</p> : null}

      {setupNext ? (
        <div
          className="card"
          data-testid="setup-next-step"
          style={{
            marginBottom: "1rem",
            border: "2px solid var(--accent, #3d8bfd)",
            boxShadow: "0 0 0 1px rgba(61, 139, 253, 0.12)",
          }}
        >
          <p className="muted" style={{ fontSize: "0.72rem", textTransform: "uppercase", letterSpacing: "0.06em", margin: 0 }}>
            Guided setup · your next step
          </p>
          <h2 className="card-title" style={{ margin: "0.35rem 0 0.5rem" }}>
            {setupNext.label}
          </h2>
          {setupNext.hint ? (
            <p className="muted" style={{ fontSize: "0.92rem", margin: "0 0 1rem", lineHeight: 1.5 }}>
              {setupNext.hint}
            </p>
          ) : null}
          <Link to={setupNext.to} className="primary" data-testid="setup-next-cta">
            Continue →
          </Link>
          <p className="muted" style={{ fontSize: "0.78rem", margin: "0.85rem 0 0" }}>
            Full ordered checklist is below. After setup, use <strong>Projects</strong> and each project&apos;s{" "}
            <strong>Intake</strong> tab for definition and team link.
          </p>
        </div>
      ) : setupSteps && setupSteps.length > 0 ? (
        <div className="card" data-testid="setup-all-done" style={{ marginBottom: "1rem" }}>
          <p className="ok" style={{ margin: 0, fontWeight: 600 }}>
            ✓ Company setup checklist is complete
          </p>
          <p className="muted" style={{ fontSize: "0.88rem", margin: "0.5rem 0 0" }}>
            Open <Link to="/projects">Projects</Link> for delivery, or add more BUs/teams/agents as you scale.
          </p>
        </div>
      ) : null}

      {setupSteps ? (
        <details
          className="card"
          data-testid="setup-checklist"
          style={{ marginBottom: "1rem" }}
          open={setupChecklistOpen}
          onToggle={(e) => setSetupChecklistOpen((e.target as HTMLDetailsElement).open)}
        >
          <summary style={{ cursor: "pointer", fontWeight: 700, listStylePosition: "outside" }}>
            Company setup (full list)
            {setupSteps.every((s) => s.done) ? (
              <span className="badge badge-green" style={{ marginLeft: "0.5rem" }}>
                Complete
              </span>
            ) : (
              <span className="badge badge-amber" style={{ marginLeft: "0.5rem" }}>
                {setupSteps.filter((s) => !s.done).length} step{setupSteps.filter((s) => !s.done).length === 1 ? "" : "s"} left
              </span>
            )}
          </summary>
          <p className="muted" style={{ fontSize: "0.88rem", marginTop: "0.75rem" }}>
            Recommended order:{" "}
            <strong>company → catalogs → BU → team &amp; seats → agents → project → intake → link team</strong>.
            When something is still missing, the <strong>Next step</strong> card above shows where to go next; this list mirrors
            that path with live checkmarks.
          </p>
          <ol style={{ margin: "0.5rem 0 0", paddingLeft: "1.25rem", lineHeight: 1.55 }}>
            {setupSteps.map((s) => (
              <li key={s.id} style={{ marginBottom: "0.5rem" }}>
                <span className={s.done ? "ok" : "muted"} style={{ marginRight: "0.35rem", fontWeight: 600 }}>
                  {s.done ? "✓" : "○"}
                </span>
                <Link to={s.to}>{s.label}</Link>
                {s.hint ? (
                  <div className="muted" style={{ fontSize: "0.8rem", margin: "0.15rem 0 0 1.35rem" }}>
                    {s.hint}
                  </div>
                ) : null}
              </li>
            ))}
          </ol>
        </details>
      ) : null}

      <div className="grid-stats">
        <div className="stat-card">
          <span className="stat-label">Tasks (all projects)</span>
          <div className="stat-value">{taskRollup.total}</div>
          <div className="stat-sub muted">
            {taskRollup.open} open · {taskRollup.done} done
          </div>
        </div>
        <div className="stat-card">
          <span className="stat-label">Agents</span>
          <div className="stat-value">{agents.length}</div>
          <div className="stat-sub muted">
            {activeAgents} active · {agents.length - activeAgents} other
          </div>
        </div>
        <div className="stat-card">
          <span className="stat-label">Projects</span>
          <div className="stat-value">{projects.length}</div>
          <div className="stat-sub muted">Open one for Board / SDM</div>
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <h3 className="card-title">Org snapshot</h3>
          <Link to="/organization/business-units" className="badge badge-gray">
            Manage
          </Link>
        </div>
        {bus.length === 0 && teams.length === 0 ? (
          <p className="muted">No business units or teams yet — create under Organization.</p>
        ) : bus.length === 0 && teams.length > 0 ? (
          <p className="muted">
            No business units yet — add a BU under Organization, then assign teams. Ungrouped teams are listed below.
          </p>
        ) : null}
        {bus.map((b) => {
          const buTeams = (teamsByBuId.get(b.id) ?? []).sort((x, y) => x.name.localeCompare(y.name));
          return (
            <div key={b.id} style={{ marginBottom: "1rem" }}>
              <h4 style={{ margin: "0 0 0.35rem", fontSize: "1rem" }}>{b.name}</h4>
              {buTeams.length === 0 ? (
                <p className="muted" style={{ margin: "0", fontSize: "0.86rem" }}>
                  No teams in this BU — create or attach teams under Teams.
                </p>
              ) : (
                <ul style={{ margin: 0, paddingLeft: "1.25rem", lineHeight: 1.6, fontSize: "0.9rem" }}>
                  {buTeams.map((tm) => (
                    <li key={tm.id}>
                      <Link to="/organization/teams">{tm.name}</Link>
                      {typeof tm._count?.roles === "number" ? (
                        <span className="muted" style={{ fontSize: "0.82rem" }}>
                          {" "}
                          · {tm._count.roles} seat{tm._count.roles === 1 ? "" : "s"}
                        </span>
                      ) : null}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          );
        })}
        {teamsWithoutBu.length > 0 ? (
          <div style={{ marginTop: bus.length > 0 ? "1rem" : 0, paddingTop: bus.length > 0 ? "0.85rem" : 0 }}>
            <h4 style={{ margin: "0 0 0.35rem", fontSize: "0.95rem" }} className="muted">
              Teams without a business unit
            </h4>
            <ul style={{ margin: 0, paddingLeft: "1.25rem", lineHeight: 1.6, fontSize: "0.88rem" }}>
              {teamsWithoutBu
                .slice()
                .sort((x, y) => x.name.localeCompare(y.name))
                .map((tm) => (
                  <li key={tm.id}>
                    <Link to="/organization/teams">{tm.name}</Link>
                  </li>
                ))}
            </ul>
          </div>
        ) : null}
        {(bus.length > 0 || teams.length > 0) ? (
          <p className="muted" style={{ fontSize: "0.82rem", marginTop: "0.85rem", marginBottom: 0 }}>
            Link projects to teams from each project&apos;s <strong>Intake</strong> tab.
          </p>
        ) : null}
      </div>

      <div className="card">
        <h2 className="card-title" style={{ marginBottom: "0.5rem" }}>
          All projects
        </h2>
        {projects.length === 0 ? (
          <p className="muted">No projects yet — create under Projects.</p>
        ) : (
          <ul style={{ lineHeight: 1.65 }}>
            {projects.map((p) => {
              const statusText = formatProjectImplementationStatus(p.implementationStatus);
              return (
                <li key={p.id}>
                  <Link to={`/projects/${p.id}/intake`} data-testid={`dash-project-${p.id}`}>
                    {p.name}
                  </Link>
                  <span className="muted" style={{ fontSize: "0.82rem" }} data-testid={`dash-project-status-${p.id}`}>
                    {" "}
                    · status{" "}
                    <strong>{statusText}</strong>
                    {p.readyForUat ? <> · UAT</> : null}
                    {p._count?.proposedItems != null && p._count.proposedItems > 0 ? (
                      <> · proposed {p._count.proposedItems}</>
                    ) : null}
                    {p._count?.teamLinks === 0 ?
                      <span className="err"> · no delivery team linked</span>
                    : (p._count?.teamLinks ?? 0) > 1 ?
                      <span className="err"> · multiple teams (max 1 — fix on Intake)</span>
                    : null}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <div className="card">
        <h2 className="card-title" style={{ marginBottom: "0.5rem" }}>
          Tasks by project
        </h2>
        {projects.length === 0 ? (
          <p className="muted">No projects yet — create under Projects.</p>
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <th>Project</th>
                <th>Total</th>
                <th>Open</th>
                <th>Done</th>
              </tr>
            </thead>
            <tbody>
              {projects.map((p) => {
                const { total, open, done } = projectTaskCounts(p);
                return (
                  <tr key={p.id}>
                    <td>
                      <Link to={`/projects/${p.id}/board`}>{p.name}</Link>
                    </td>
                    <td>{total}</td>
                    <td>{open}</td>
                    <td>{done}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
