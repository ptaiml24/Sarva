import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api/http.js";
import { useAuth } from "../auth/AuthContext.js";

type Agent = { id: string; name: string; status: string };

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

const AGENT_STATUS_PRESETS = ["idle", "active", "paused"] as const;

/**
 * Work → Agents — define the company agent roster here; map agents to team seats under Organization → Teams.
 */
export function AgentsPage() {
  const { role } = useAuth();
  const admin = role === "admin";
  const [agents, setAgents] = useState<Agent[]>([]);
  const [seats, setSeats] = useState<AgentSeatRow[]>([]);
  const [newName, setNewName] = useState("");
  const [newStatus, setNewStatus] = useState<string>("idle");
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  /** Inline edit (admin) */
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftName, setDraftName] = useState("");
  const [draftStatus, setDraftStatus] = useState("");
  const [savingId, setSavingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setErr(null);
    try {
      const [list, seatRows] = await Promise.all([
        api<Agent[]>("/api/v1/agents"),
        api<AgentSeatRow[]>("/api/v1/agent-seats").catch(() => [] as AgentSeatRow[]),
      ]);
      setAgents(list);
      setSeats(seatRows);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Load failed");
      setAgents([]);
      setSeats([]);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const seatRowsByAgentId = useMemo(() => {
    const m = new Map<string, { seatId: string; line: string }[]>();
    for (const s of seats) {
      const aid = s.assignedAgentId;
      if (!aid) continue;
      const seatLabel = (s.label?.trim() || s.role.name || "Seat").trim();
      const line = `${s.role.team.name} · ${seatLabel}${s.role.roleTemplate ? ` (${s.role.roleTemplate.label})` : ""}`;
      const arr = m.get(aid) ?? [];
      arr.push({ seatId: s.id, line });
      m.set(aid, arr);
    }
    for (const [, arr] of m) arr.sort((a, b) => a.line.localeCompare(b.line));
    return m;
  }, [seats]);

  function startEdit(a: Agent) {
    setMsg(null);
    setErr(null);
    setEditingId(a.id);
    setDraftName(a.name);
    setDraftStatus(a.status);
  }

  function cancelEdit() {
    setEditingId(null);
    setDraftName("");
    setDraftStatus("");
    setSavingId(null);
  }

  async function onSaveEdit(e: FormEvent, agentId: string) {
    e.preventDefault();
    if (!admin || editingId !== agentId) return;
    const name = draftName.trim();
    if (!name) {
      setErr("Name is required.");
      return;
    }
    setErr(null);
    setMsg(null);
    setSavingId(agentId);
    try {
      await api(`/api/v1/agents/${encodeURIComponent(agentId)}`, {
        method: "PATCH",
        json: { name, status: draftStatus.trim() || "idle" },
      });
      setMsg("Agent updated.");
      cancelEdit();
      await load();
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : "Update failed");
    } finally {
      setSavingId(null);
    }
  }

  function statusOptions(current: string): string[] {
    const set = new Set<string>([...AGENT_STATUS_PRESETS, current]);
    return [...set].sort();
  }

  async function onCreateAgent(e: FormEvent) {
    e.preventDefault();
    if (!admin || !newName.trim()) return;
    setMsg(null);
    setErr(null);
    try {
      await api("/api/v1/agents", {
        method: "POST",
        json: { name: newName.trim(), status: newStatus || "idle" },
      });
      setNewName("");
      setNewStatus("idle");
      setMsg("Agent created.");
      await load();
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : "Create failed");
    }
  }

  return (
    <div data-testid="agents-page">
      <p className="muted page-intro">
        <strong>Work → Agents</strong> — the <strong>agent catalog</strong> (who exists in Sarva).{" "}
        <strong>Organization → Teams</strong> maps each agent to a <strong>seat</strong> (team role instance) and skills.
        Model bindings: <Link to="/admin">Admin</Link>.
      </p>
      {msg ? <p className="ok">{msg}</p> : null}
      {err ? <p className="err">{err}</p> : null}

      {admin ? (
        <div className="card" data-testid="agents-create-card">
          <h2 className="card-title" style={{ marginTop: 0 }}>
            Add agent
          </h2>
          <p className="muted" style={{ fontSize: "0.88rem", marginTop: 0 }}>
            Creates a roster entry. Then assign them under <Link to="/organization/teams">Teams → Seat ↔ agent assignments</Link>.
          </p>
          <form className="row" onSubmit={(e) => void onCreateAgent(e)}>
            <label>
              Name
              <input
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="e.g. Nova PM"
                data-testid="agents-add-name"
                required
              />
            </label>
            <label>
              Initial status
              <select value={newStatus} onChange={(e) => setNewStatus(e.target.value)} data-testid="agents-add-status">
                {AGENT_STATUS_PRESETS.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </label>
            <button type="submit" className="primary" data-testid="agents-add-submit">
              Create agent
            </button>
          </form>
        </div>
      ) : (
        <div className="callout-card">
          <p style={{ margin: 0, fontSize: "0.88rem" }}>
            Sign in as <strong>admin</strong> to create or edit agents here. Seat mapping stays on{" "}
            <Link to="/organization/teams">Teams</Link> (admin for assignment changes in this release).
          </p>
        </div>
      )}

      <div className="card">
        <div className="card-head">
          <h2 className="card-title" style={{ margin: 0 }}>
            Agent roster
          </h2>
          <span className="badge badge-gray">{agents.length} total</span>
        </div>
        {agents.length === 0 ? (
          <p className="muted">
            No agents yet — {admin ? "use Add agent above." : "ask an admin to create agents on this page."}
          </p>
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Status</th>
                <th>Seat on team</th>
                <th>Id</th>
                {admin ? <th aria-label="Actions" /> : null}
              </tr>
            </thead>
            <tbody>
              {agents.map((a) => {
                const mapped = seatRowsByAgentId.get(a.id);
                const isEditing = admin && editingId === a.id;
                return (
                  <tr key={a.id} data-testid={`agents-row-${a.id}`}>
                    <td>
                      {isEditing ? (
                        <input
                          value={draftName}
                          onChange={(e) => setDraftName(e.target.value)}
                          data-testid={`agents-edit-name-${a.id}`}
                          aria-label="Agent name"
                        />
                      ) : (
                        <strong>{a.name}</strong>
                      )}
                    </td>
                    <td>
                      {isEditing ? (
                        <select
                          value={draftStatus}
                          onChange={(e) => setDraftStatus(e.target.value)}
                          data-testid={`agents-edit-status-${a.id}`}
                          aria-label="Agent status"
                        >
                          {statusOptions(a.status).map((s) => (
                            <option key={s} value={s}>
                              {s}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <span className="badge badge-blue">{a.status}</span>
                      )}
                    </td>
                    <td className="muted" style={{ fontSize: "0.9rem" }}>
                      {mapped?.length ? (
                        <>
                          {mapped.length > 1 ? (
                            <span className="badge badge-amber" style={{ marginBottom: "0.35rem", display: "inline-block" }}>
                              Multiple seats
                            </span>
                          ) : null}
                          <ul style={{ margin: 0, paddingLeft: "1.1rem" }}>
                            {mapped.map(({ seatId, line }) => (
                              <li key={seatId}>{line}</li>
                            ))}
                          </ul>
                        </>
                      ) : (
                        <span>— not assigned to a seat</span>
                      )}
                    </td>
                    <td className="mono" style={{ fontSize: "0.8rem" }}>
                      {a.id}
                    </td>
                    {admin ? (
                      <td style={{ whiteSpace: "nowrap" }}>
                        {isEditing ? (
                          <form
                            className="row"
                            style={{ gap: "0.35rem", flexWrap: "nowrap", alignItems: "center" }}
                            onSubmit={(e) => void onSaveEdit(e, a.id)}
                          >
                            <button
                              type="submit"
                              className="primary"
                              disabled={savingId === a.id}
                              data-testid={`agents-save-${a.id}`}
                            >
                              {savingId === a.id ? "Saving…" : "Save"}
                            </button>
                            <button
                              type="button"
                              className="secondary"
                              disabled={savingId === a.id}
                              data-testid={`agents-cancel-${a.id}`}
                              onClick={() => cancelEdit()}
                            >
                              Cancel
                            </button>
                          </form>
                        ) : (
                          <button type="button" className="secondary" data-testid={`agents-edit-${a.id}`} onClick={() => startEdit(a)}>
                            Edit
                          </button>
                        )}
                      </td>
                    ) : null}
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
