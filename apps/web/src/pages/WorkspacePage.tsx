import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api/http.js";
import { useAuth } from "../auth/AuthContext.js";
import { CollapsibleCard } from "../components/CollapsibleCard.js";

type BU = { id: string; name: string; _count?: { teams: number } };
type Team = { id: string; name: string; businessUnitId: string | null; _count?: { roles: number } };
type RoleTemplate = {
  id: string;
  code: string;
  label: string;
  allowedSkills: { skillTemplate: { id: string; code: string; label: string } }[];
};
type SkillTemplate = { id: string; code: string; label: string; agentPrompt?: string | null };
type Role = {
  id: string;
  name: string;
  teamId: string;
  roleTemplate: { id: string; code: string; label: string } | null;
};
type Agent = { id: string; name: string; status: string };
type RoleSkillRow = { roleId: string; skillTemplateId: string; skillTemplate: SkillTemplate };
/** agent_seat row; `role.name` is the human seat label (e.g. Engineer 1). */
type AgentSeatRow = {
  id: string;
  roleId: string;
  assignedAgentId: string | null;
  label: string | null;
  assignedAgent?: { id: string; name: string } | null;
  role: {
    id: string;
    name: string;
    team: { id: string; name: string };
    roleTemplate: { id: string; code: string; label: string } | null;
  };
};

function skillTemplatesAllowedForRole(
  roles: Role[],
  sarvaRoleTemplates: RoleTemplate[],
  roleId: string
): SkillTemplate[] {
  const r = roles.find((x) => x.id === roleId);
  const rtId = r?.roleTemplate?.id;
  if (!rtId) return [];
  const tmpl = sarvaRoleTemplates.find((t) => t.id === rtId);
  if (!tmpl) return [];
  return tmpl.allowedSkills.map((x) => x.skillTemplate);
}

export function WorkspacePage() {
  const { role } = useAuth();
  const admin = role === "admin";
  const [err, setErr] = useState<string | null>(null);

  const [sarvaRoleTemplates, setSarvaRoleTemplates] = useState<RoleTemplate[]>([]);
  const [skillTemplates, setSkillTemplates] = useState<SkillTemplate[]>([]);
  const [bus, setBus] = useState<BU[]>([]);
  const [teams, setTeams] = useState<Team[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);

  const [teamName, setTeamName] = useState("");
  const [teamBuId, setTeamBuId] = useState<string>("");

  const [addRoleTemplateId, setAddRoleTemplateId] = useState("");

  const [selTeam, setSelTeam] = useState<string>("");
  const [roles, setRoles] = useState<Role[]>([]);
  const [selRole, setSelRole] = useState<string>("");
  const [roleSkills, setRoleSkills] = useState<RoleSkillRow[]>([]);
  const [linkSkillTemplateId, setLinkSkillTemplateId] = useState<string>("");

  const [seatRoleId, setSeatRoleId] = useState<string>("");
  const [seatAgentId, setSeatAgentId] = useState<string>("");
  const [agentSeats, setAgentSeats] = useState<AgentSeatRow[]>([]);

  const selTeamRef = useRef(selTeam);
  const addRoleTemplateIdRef = useRef(addRoleTemplateId);
  const teamBuIdRef = useRef(teamBuId);
  selTeamRef.current = selTeam;
  addRoleTemplateIdRef.current = addRoleTemplateId;
  teamBuIdRef.current = teamBuId;

  const refresh = useCallback(async () => {
    setErr(null);
    try {
      const [rt, st, b, t, ag, seats] = await Promise.all([
        api<RoleTemplate[]>("/api/v1/role-templates"),
        api<SkillTemplate[]>("/api/v1/skill-templates"),
        api<BU[]>("/api/v1/business-units"),
        api<Team[]>("/api/v1/teams"),
        api<Agent[]>("/api/v1/agents"),
        api<AgentSeatRow[]>("/api/v1/agent-seats").catch(() => [] as AgentSeatRow[]),
      ]);
      setSarvaRoleTemplates(rt);
      setSkillTemplates(st);
      setBus(b);
      setTeams(t);
      setAgents(ag);
      setAgentSeats(seats);
      if (t.length && !selTeamRef.current) setSelTeam(t[0].id);
      if (rt.length && !addRoleTemplateIdRef.current) setAddRoleTemplateId(rt[0].id);
      if (b.length && !teamBuIdRef.current) setTeamBuId(b[0].id);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Refresh failed");
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (teams.length && selTeam && !teams.some((t) => t.id === selTeam)) {
      setSelTeam(teams[0].id);
    }
  }, [teams, selTeam]);

  useEffect(() => {
    setSelRole("");
  }, [selTeam]);

  useEffect(() => {
    if (!selTeam) {
      setRoles([]);
      return;
    }
    let c = false;
    (async () => {
      try {
        const r = await api<Role[]>(`/api/v1/roles?teamId=${encodeURIComponent(selTeam)}`);
        if (!c) {
          setRoles(r);
          if (r.length) {
            setSelRole((prev) => (prev && r.some((x) => x.id === prev) ? prev : r[0].id));
          } else {
            setSelRole("");
          }
        }
      } catch {
        if (!c) setRoles([]);
      }
    })();
    return () => {
      c = true;
    };
  }, [selTeam]);

  useEffect(() => {
    if (!selRole) {
      setRoleSkills([]);
      return;
    }
    let c = false;
    (async () => {
      try {
        const rs = await api<RoleSkillRow[]>(`/api/v1/role-skills?roleId=${encodeURIComponent(selRole)}`);
        if (!c) setRoleSkills(rs);
      } catch {
        if (!c) setRoleSkills([]);
      }
    })();
    return () => {
      c = true;
    };
  }, [selRole]);

  useEffect(() => {
    if (!roles.length) {
      setSeatRoleId("");
      return;
    }
    setSeatRoleId((prev) => (prev && roles.some((r) => r.id === prev) ? prev : roles[0].id));
  }, [roles]);

  /** Assignments visible for the focused team only (easier multi-team workflows). */
  const agentSeatsFocused = useMemo(() => {
    if (!selTeam) return [];
    return [...agentSeats]
      .filter((x) => x.role.team.id === selTeam)
      .sort((a, b) => a.role.name.localeCompare(b.role.name));
  }, [agentSeats, selTeam]);

  const focusedTeam = useMemo(() => teams.find((t) => t.id === selTeam) ?? null, [teams, selTeam]);

  const focusedBuName = focusedTeam?.businessUnitId ?
      bus.find((b) => b.id === focusedTeam.businessUnitId)?.name ?? null
    : null;

  const selectedSeatForSkills = useMemo(() => roles.find((r) => r.id === selRole), [roles, selRole]);

  function allowedSkillOptionsForRole(roleId: string): SkillTemplate[] {
    return skillTemplatesAllowedForRole(roles, sarvaRoleTemplates, roleId);
  }

  /** Allowed skills for this seat that are not yet linked (defaults cover all; removals show up here to re-add). */
  const skillsNotYetOnSeat = useMemo(() => {
    const linked = new Set(roleSkills.map((x) => x.skillTemplateId));
    return skillTemplatesAllowedForRole(roles, sarvaRoleTemplates, selRole).filter((s) => !linked.has(s.id));
  }, [selRole, roles, roleSkills, sarvaRoleTemplates]);

  async function deleteTeamById(teamId: string) {
    if (!admin) return;
    if (!window.confirm("Delete this team and all its seats? This cannot be undone.")) return;
    setErr(null);
    try {
      await api(`/api/v1/teams/${encodeURIComponent(teamId)}`, { method: "DELETE" });
      await refresh();
      setSelTeam((prev) => (prev === teamId ? "" : prev));
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Delete failed");
    }
  }

  async function deleteSeat(roleId: string) {
    if (!admin) return;
    if (!window.confirm("Remove this seat from the team? Skill links and seat assignments are cleared.")) return;
    setErr(null);
    try {
      await api(`/api/v1/roles/${encodeURIComponent(roleId)}`, { method: "DELETE" });
      setSelRole((prev) => (prev === roleId ? "" : prev));
      setSeatRoleId((prev) => (prev === roleId ? "" : prev));
      await refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Delete failed");
    }
  }

  async function addTeam(e: FormEvent) {
    e.preventDefault();
    if (!admin || !teamName.trim()) return;
    setErr(null);
    try {
      const team = await api<Team>("/api/v1/teams", {
        method: "POST",
        json: {
          name: teamName.trim(),
          businessUnitId: teamBuId || null,
        },
      });
      setTeamName("");
      setSelTeam(team.id);
      await refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Create team failed");
    }
  }

  function focusTeam(teamId: string) {
    setSelTeam(teamId);
    setSeatAgentId("");
  }

  async function addRoleSlot(e: FormEvent) {
    e.preventDefault();
    if (!admin || !selTeam || !addRoleTemplateId) return;
    await api("/api/v1/roles", { method: "POST", json: { teamId: selTeam, roleTemplateId: addRoleTemplateId } });
    const r = await api<Role[]>(`/api/v1/roles?teamId=${encodeURIComponent(selTeam)}`);
    setRoles(r);
    await refresh();
  }

  async function linkRoleSkill(e: FormEvent) {
    e.preventDefault();
    if (!admin || !selRole || !linkSkillTemplateId) return;
    await api("/api/v1/role-skills", {
      method: "POST",
      json: { roleId: selRole, skillTemplateId: linkSkillTemplateId },
    });
    const rs = await api<RoleSkillRow[]>(`/api/v1/role-skills?roleId=${encodeURIComponent(selRole)}`);
    setRoleSkills(rs);
  }

  async function unlink(rs: RoleSkillRow) {
    if (!admin) return;
    const q = new URLSearchParams({ roleId: rs.roleId, skillTemplateId: rs.skillTemplateId });
    await api(`/api/v1/role-skills?${q}`, { method: "DELETE" });
    const list = await api<RoleSkillRow[]>(`/api/v1/role-skills?roleId=${encodeURIComponent(selRole)}`);
    setRoleSkills(list);
  }

  async function addSeat(e: FormEvent) {
    e.preventDefault();
    if (!admin || !seatRoleId) return;
    setErr(null);
    const agentId = seatAgentId || null;
    const forRole = agentSeats.filter((x) => x.roleId === seatRoleId);
    try {
      if (forRole.length === 1) {
        await api(`/api/v1/agent-seats/${encodeURIComponent(forRole[0].id)}`, {
          method: "PATCH",
          json: { assignedAgentId: agentId },
        });
      } else if (forRole.length === 0) {
        await api("/api/v1/agent-seats", {
          method: "POST",
          json: { roleId: seatRoleId, assignedAgentId: agentId },
        });
      } else {
        const unassigned = forRole.find((x) => !x.assignedAgentId);
        const target = unassigned ?? forRole[0];
        await api(`/api/v1/agent-seats/${encodeURIComponent(target.id)}`, {
          method: "PATCH",
          json: { assignedAgentId: agentId },
        });
      }
      await refresh();
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : "Failed to assign agent");
    }
  }

  return (
    <div data-testid="workspace-page">
      <p className="muted page-intro">
        <strong>Organization → Teams</strong>. Attach teams to business units via <strong>Business units</strong>, edit catalogs
        under{" "}
        <Link to="/organization/skills-models">
          Roles &amp; skills
        </Link>
        , roster agents via <Link to="/agents">Work → Agents</Link>, then map seats here. Workflow:{" "}
        <strong>Create empty team</strong> → <strong>Select</strong> → add seats/skills/agent links in one panel — no stray
        second Team dropdown while you multitask multiple rosters. LLM tuning:{" "}
        <Link to="/admin">System → Admin</Link>. Shortcut:{" "}
        <Link to="/organization/guided-setup">Guided setup (preview)</Link>.
      </p>
      {err ? <p className="err">{err}</p> : null}
      {!admin ? <p className="err">Sign in as admin to change teams and seats.</p> : null}

      {admin && bus.length === 0 ? (
        <div className="callout-card" data-testid="teams-needs-bu" style={{ marginBottom: "1rem" }}>
          <p style={{ margin: 0, fontSize: "0.9rem", lineHeight: 1.5 }}>
            <strong>Recommended:</strong> create at least one business unit under{" "}
            <Link to="/organization/business-units">Organization → Business units</Link> first, then attach new teams to it
            (see <Link to="/dashboard">Dashboard</Link> setup). You can still create a team without a BU using “—” in the BU
            field.
          </p>
        </div>
      ) : null}

      <CollapsibleCard
        data-testid="section-catalog"
        style={{ marginBottom: "1rem" }}
        heading={<strong>Sarva role &amp; skill catalogs</strong>}
        subtitle="expand for a lookup-only preview (configure under Roles &amp; skills)"
      >
        <p className="muted" style={{ fontSize: "0.9rem" }}>
          Editing catalogs is under{" "}
          <Link to="/organization/skills-models">
            Roles &amp; skills
          </Link>
          . Read-only checklist while you compose teams below.
        </p>
        <div className="row" style={{ alignItems: "flex-start" }}>
          <div style={{ flex: 1, minWidth: "12rem" }}>
            <strong>Roles</strong>
            <ul>
              {sarvaRoleTemplates.map((r) => (
                <li key={r.id}>
                  {r.label} <small className="muted">({r.code})</small>
                </li>
              ))}
            </ul>
          </div>
          <div style={{ flex: 1, minWidth: "12rem" }}>
            <strong>Skills</strong>
            <ul>
              {skillTemplates.map((s) => (
                <li key={s.id}>
                  {s.label} <small className="muted">({s.code})</small>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </CollapsibleCard>

      <div className="card" data-testid="section-create-team">
        <h2 className="card-title" style={{ marginTop: 0 }}>
          Create team
        </h2>
        <p className="muted" style={{ fontSize: "0.9rem", marginTop: "-0.25rem" }}>
          Name and optional BU only — no seat matrix here. After creation we focus the new row; add Sarva-role seats inside{" "}
          <strong>Edit selected team</strong>.
        </p>
        {admin ? (
          <form onSubmit={addTeam}>
            <div className="row">
              <label>
                Team name
                <input value={teamName} onChange={(e) => setTeamName(e.target.value)} data-testid="team-name" required />
              </label>
              <label>
                BU (optional)
                <select value={teamBuId} onChange={(e) => setTeamBuId(e.target.value)}>
                  <option value="">—</option>
                  {bus.map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.name}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <button type="submit" className="primary" style={{ marginTop: "0.65rem" }} data-testid="team-add">
              Create empty team
            </button>
          </form>
        ) : null}
      </div>

      <div className="card" data-testid="section-teams-list" style={{ position: "relative" }}>
        <h2 className="card-title" style={{ marginTop: 0 }}>
          Teams — choose one to work on
        </h2>
        <p className="muted" style={{ fontSize: "0.88rem", marginBottom: "0.75rem" }}>
          Seat counts, Sarva skill overrides, and agent mapping always apply to the team marked <strong>Editing</strong> — avoid
          the old mismatch between two Team dropdowns when you manage multiple rosters.
        </p>
        {teams.length === 0 ?
          <p className="muted">No teams yet.</p>
        : <table style={{ marginTop: "0.35rem" }}>
            <thead>
              <tr>
                <th>Focus</th>
                <th>Name</th>
                <th>BU</th>
                <th>Seats</th>
                {admin ? <th aria-label="Danger zone" /> : null}
              </tr>
            </thead>
            <tbody>
              {teams.map((t) => {
                const buLabel = t.businessUnitId ?
                    bus.find((b) => b.id === t.businessUnitId)?.name ?? "—"
                  : "—";
                const editing = selTeam === t.id;
                return (
                  <tr key={t.id} style={{ background: editing ? "rgba(127,127,127,0.08)" : undefined }}>
                    <td>
                      {admin ?
                        <button
                          type="button"
                          className={editing ? "primary" : "secondary"}
                          data-testid={`team-focus-${t.id}`}
                          onClick={() => focusTeam(t.id)}
                        >
                          {editing ? "Editing" : "Select"}
                        </button>
                      : <span className="muted">{editing ? "Showing" : "—"}</span>}
                    </td>
                    <td>{t.name}</td>
                    <td className="muted">{buLabel}</td>
                    <td>{t._count?.roles ?? 0}</td>
                    {admin ?
                      <td>
                        <button type="button" className="secondary" onClick={() => void deleteTeamById(t.id)}>
                          Delete
                        </button>
                      </td>
                    : null}
                  </tr>
                );
              })}
            </tbody>
          </table>
        }

        {/* Keep for Playwright selectors that still expect rs-team-select; synced to focused team. */}
        {admin ?
          <select
            aria-hidden="true"
            tabIndex={-1}
            data-testid="rs-team-select"
            value={selTeam}
            onChange={(e) => focusTeam(e.target.value)}
            style={{ position: "absolute", width: 1, height: 1, padding: 0, margin: -1, overflow: "hidden", clip: "rect(0,0,0,0)", border: 0 }}
          >
            {teams.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        : teams.length ?
          <label style={{ display: "block", marginTop: "0.85rem", maxWidth: "20rem" }}>
            Workspace team
            <select value={selTeam} data-testid="rs-team-select" onChange={(e) => focusTeam(e.target.value)}>
              {teams.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </label>
        : null}
      </div>

      {focusedTeam ?
        <div className="card" data-testid="team-workspace-focused">
          <h2 className="card-title" data-testid="focused-team-heading" style={{ marginTop: 0 }}>
            Edit selected team · {focusedTeam.name}
          </h2>
          <p className="muted" style={{ fontSize: "0.88rem", marginTop: "-0.2rem" }}>
            {focusedBuName ?
              <span>
                BU <strong>{focusedBuName}</strong> ·{" "}
              </span>
            : (
              <span>No BU · </span>
            )}
            {focusedTeam._count?.roles ?? 0} seats — seats / skills / agents below belong to this team only.
          </p>

          <section style={{ marginTop: "1rem" }}>
            <h3 style={{ fontSize: "1.05rem" }}>Add seats</h3>
            <p className="muted" style={{ fontSize: "0.86rem", marginBottom: "0.5rem" }}>
              Repeat to grow headcount: each action adds another Sarva-role seat on{" "}
              <strong>{focusedTeam.name}</strong>.
            </p>
            {admin ?
              <form className="row" onSubmit={addRoleSlot} style={{ alignItems: "flex-end" }}>
                <label>
                  Sarva role template
                  <select
                    value={addRoleTemplateId}
                    onChange={(e) => setAddRoleTemplateId(e.target.value)}
                    data-testid="role-template-add"
                  >
                    {sarvaRoleTemplates.map((rt) => (
                      <option key={rt.id} value={rt.id}>
                        {rt.label}
                      </option>
                    ))}
                  </select>
                </label>
                <button type="submit" className="secondary" data-testid="role-add">
                  Add seat on this team
                </button>
              </form>
            : null}
          </section>

          <hr style={{ margin: "1.25rem 0", opacity: 0.35 }} />

          <section data-testid="section-role-skills">
            <h3 style={{ fontSize: "1.05rem" }}>
              Seat skill overrides{" "}
              <span className="muted" style={{ fontWeight: "normal", fontSize: "0.88rem" }}>
                (optional)
              </span>
            </h3>
            <p className="muted" style={{ fontSize: "0.88rem", lineHeight: 1.55 }}>
              Sarva skills are wired at the catalogue:{" "}
              <Link to="/organization/skills-models">Roles &amp; skills</Link> declares which skills each Sarva{" "}
              <strong>role type</strong> may use.{" "}
              <strong>Each new seat inherits every allowed skill automatically</strong> — you rarely need this block. Use
              it only to <strong>trim or restore skills on one seat row</strong> (e.g. Engineer 2 should not carry the review
              skill) without creating a duplicate role template.
            </p>
            <label style={{ display: "block", marginTop: "0.65rem", maxWidth: "28rem" }}>
              Seat row to edit
              <select value={selRole} onChange={(e) => setSelRole(e.target.value)} data-testid="rs-role-select">
                {roles.length ?
                  roles.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.name}
                      {r.roleTemplate ? ` — ${r.roleTemplate.label}` : ""}
                    </option>
                  ))
                : <option value="">— Add seats above first —</option>}
              </select>
            </label>
        {selectedSeatForSkills ? (
          <p className="muted" style={{ fontSize: "0.88rem", margin: "0.35rem 0 0.75rem" }} data-testid="rs-selected-seat">
            <strong>Skills linked to:</strong> {selectedSeatForSkills.name}
            {selectedSeatForSkills.roleTemplate ? ` (${selectedSeatForSkills.roleTemplate.label})` : ""}. The table below is
            this seat&apos;s override list; <strong>Remove</strong> only affects this row — not the global{" "}
            <Link to="/organization/skills-models">Roles &amp; skills</Link> definition.
          </p>
        ) : (
          <p className="muted" style={{ fontSize: "0.88rem", margin: "0.35rem 0 0.75rem" }}>
            Pick a <strong>seat row</strong> — Engineer 1 and Engineer 2 can differ even when they share the same Sarva role
            type.
          </p>
        )}
        {admin ? (
          <form className="row" onSubmit={linkRoleSkill} style={{ marginBottom: "1rem", alignItems: "flex-end" }}>
            <label>
              Add back a removed skill for this seat
              <select
                value={linkSkillTemplateId}
                onChange={(e) => setLinkSkillTemplateId(e.target.value)}
                data-testid="rs-skill-select"
                aria-label="Skill to add back to the selected seat"
              >
                <option value="">—</option>
                {skillsNotYetOnSeat.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.label}
                  </option>
                ))}
              </select>
            </label>
            {selRole && allowedSkillOptionsForRole(selRole).length === 0 ? (
              <p className="err" style={{ margin: 0 }}>
                No skills allowed for this seat&apos;s role type — set &quot;Role ↔ allowed skills&quot; in Roles &amp; skills,
                or ensure
                the seat has a Sarva role template.
              </p>
            ) : null}
            {selRole && allowedSkillOptionsForRole(selRole).length > 0 && skillsNotYetOnSeat.length === 0 ? (
              <p className="muted" style={{ margin: 0 }}>
                Full template set attached — optional to remove unused skills row-by-row above.
              </p>
            ) : null}
            <button
              type="submit"
              className="secondary"
              data-testid="rs-link"
              disabled={!selRole || !linkSkillTemplateId}
              title={!selRole ? "Choose a seat first" : !linkSkillTemplateId ? "Pick a skill to restore" : undefined}
            >
              Link skill on this seat
            </button>
          </form>
        ) : null}
        <h4 style={{ margin: "0.75rem 0 0.35rem", fontSize: "0.95rem" }}>Skills on this seat row</h4>
        <p className="muted" style={{ fontSize: "0.82rem", marginTop: 0 }}>
          Skills inherited from{" "}
          <Link to="/organization/skills-models">Roles &amp; skills</Link> unless you&apos;ve dropped one with{" "}
          <strong>Remove</strong>; use the box above only to undo a removal.
        </p>
        <table>
          <thead>
            <tr>
              <th>Skill</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {roleSkills.map((rs) => (
              <tr key={rs.skillTemplateId}>
                <td>
                  {rs.skillTemplate.label}{" "}
                  <small className="muted">
                    ({rs.skillTemplate.code}) {rs.skillTemplateId}
                  </small>
                </td>
                <td>
                  {admin ? (
                    <button type="button" className="secondary" onClick={() => void unlink(rs)}>
                      Remove
                    </button>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {admin ? (
          <div data-testid="section-team-seats" style={{ marginTop: "1.25rem" }}>
            <h3 style={{ marginTop: 0 }}>Seats on this team (remove)</h3>
            <p className="muted" style={{ fontSize: "0.88rem" }}>
              Same seat rows as <strong>Seat row to edit</strong> — remove a row only if you are shrinking headcount.
            </p>
            <table>
              <thead>
                <tr>
                  <th>Seat</th>
                  <th>Role type</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {roles.length === 0 ? (
                  <tr>
                    <td colSpan={3} className="muted">
                      No seats yet — use <strong>Add seat on this team</strong>.
                    </td>
                  </tr>
                ) : (
                  roles.map((r) => (
                    <tr key={r.id}>
                      <td>{r.name}</td>
                      <td>{r.roleTemplate?.label ?? "—"}</td>
                      <td>
                        <button type="button" className="secondary" onClick={() => void deleteSeat(r.id)}>
                          Remove seat
                        </button>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        ) : null}
          </section>

          <hr style={{ margin: "1.25rem 0", opacity: 0.35 }} />

          <section data-testid="section-seats-focused">
            <h3 style={{ fontSize: "1.05rem" }}>Seat ↔ agents</h3>
            <p className="muted" style={{ fontSize: "0.88rem", marginBottom: "0.6rem" }}>
              List below only shows mappings for <strong>{focusedTeam.name}</strong>. Roster definitions live under{" "}
              <Link to="/agents">
                Work → Agents
              </Link>
              .
            </p>
            <table className="data-table">
              <thead>
                <tr>
                  <th>Seat</th>
                  <th>Role type</th>
                  <th>Agent</th>
                </tr>
              </thead>
              <tbody>
                {agentSeatsFocused.length === 0 ? (
                  <tr>
                    <td colSpan={3} className="muted">
                      No assignments here yet — assign after you attach seats above.
                    </td>
                  </tr>
                ) : (
                  agentSeatsFocused.map((s) => {
                    const seatLabel = (s.label?.trim() || s.role.name || "—").trim();
                    const agentName =
                      s.assignedAgent?.name ??
                      (s.assignedAgentId
                        ? agents.find((a) => a.id === s.assignedAgentId)?.name ?? null
                        : null);
                    return (
                      <tr key={s.id}>
                        <td>
                          <strong>{seatLabel}</strong>
                        </td>
                        <td>{s.role.roleTemplate?.label ?? "—"}</td>
                        <td>
                          {agentName ? (
                            agentName
                          ) : s.assignedAgentId ? (
                            <span className="muted" title="Agent not found in roster">
                              <code style={{ fontSize: "0.85em" }}>{s.assignedAgentId}</code>
                            </span>
                          ) : (
                            "—"
                          )}
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>

            <h4 style={{ marginTop: "1rem", marginBottom: "0.35rem", fontSize: "0.95rem" }}>Assign roster agent to seat</h4>
            <p className="muted" style={{ fontSize: "0.88rem", marginTop: "-0.2rem", marginBottom: "0.5rem" }}>
              Same roster as skill overrides above (one seat row maps to exactly one roster slot).
            </p>
            <label style={{ display: "block", maxWidth: "28rem", marginTop: "0.5rem" }}>
              Seat on {focusedTeam.name}
              <select value={seatRoleId} onChange={(e) => setSeatRoleId(e.target.value)} data-testid="seat-role-select">
                <option value="">—</option>
                {roles.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name}
                    {r.roleTemplate ? ` — ${r.roleTemplate.label}` : ""}
                  </option>
                ))}
              </select>
            </label>
            {admin && seatRoleId ? (
              <form className="row" onSubmit={addSeat} style={{ marginTop: "0.75rem" }}>
                <label>
                  Agent
                  <select value={seatAgentId} onChange={(e) => setSeatAgentId(e.target.value)} data-testid="seat-agent-select">
                    <option value="">— unassigned</option>
                    {agents.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name}
                      </option>
                    ))}
                  </select>
                </label>
                <button type="submit" className="secondary" data-testid="seat-add">
                  Save assignment
                </button>
              </form>
            ) : null}
          </section>

        </div>
      : teams.length ? (
        <p className="muted card" style={{ padding: "0.95rem", marginBottom: "1rem" }} data-testid="team-workspace-placeholder">
          Select a team row above — the unified editor loads once a roster is highlighted.
        </p>
      ) : null}
    </div>
  );
}
