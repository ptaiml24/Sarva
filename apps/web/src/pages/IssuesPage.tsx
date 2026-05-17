import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api/http.js";

type ProjectRow = { id: string; name: string };

type RoleOption = {
  roleId: string;
  roleName: string;
  teamId: string;
  teamName: string;
  display: string;
};

type IssueApiRow = {
  issueId: number;
  issueNumber: number;
  title: string;
  description: string;
  status: string;
  statusLabel: string;
  assignedUserEmail: string;
  owner: null | {
    roleId: string;
    roleName: string;
    teamName: string;
    display: string;
  };
  id: string;
  deliveryTaskId: string | null;
};

function shortenBody(text: string, max = 120): string {
  const t = text.replace(/\s+/g, " ").trim();
  if (t.length <= max) return t || "—";
  return `${t.slice(0, max)}…`;
}

export function IssuesPage() {
  const [projects, setProjects] = useState<ProjectRow[]>([]);
  const [projectId, setProjectId] = useState<string>("");
  const [scope, setScope] = useState<"open" | "all">("open");
  const [items, setItems] = useState<IssueApiRow[]>([]);
  const [roleOpts, setRoleOpts] = useState<RoleOption[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** Row id receiving a status PATCH. */
  const [patchBusyId, setPatchBusyId] = useState<string | null>(null);

  const [draftTitle, setDraftTitle] = useState("");
  const [draftDescription, setDraftDescription] = useState("");
  const [draftOwnerRoleId, setDraftOwnerRoleId] = useState("");
  const [createBusy, setCreateBusy] = useState(false);

  const encodedProject = projectId.trim() ? encodeURIComponent(projectId) : "";

  const loadProjects = useCallback(async () => {
    try {
      const rows = await api<ProjectRow[]>("/api/v1/projects");
      setProjects(rows);
    } catch {
      setProjects([]);
    }
  }, []);

  const loadIssues = useCallback(async () => {
    if (!encodedProject) {
      setItems([]);
      setRoleOpts([]);
      return;
    }
    setErr(null);
    setBusy(true);
    try {
      const [{ items: iss }, opts] = await Promise.all([
        api<{ scope: string; items: IssueApiRow[] }>(
          `/api/v1/projects/${encodedProject}/issues?scope=${scope}`
        ),
        api<{ items: RoleOption[] }>(
          `/api/v1/projects/${encodedProject}/issues/role-options`
        ).catch(() => ({ items: [] as RoleOption[] })),
      ]);
      setItems(iss ?? []);
      setRoleOpts(opts.items ?? []);
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : "Could not load issues");
      setItems([]);
    } finally {
      setBusy(false);
    }
  }, [encodedProject, scope]);

  useEffect(() => {
    void loadProjects();
  }, [loadProjects]);

  useEffect(() => {
    void loadIssues();
  }, [loadIssues]);

  const projectName = useMemo(
    () => projects.find((p) => p.id === projectId)?.name ?? "",
    [projects, projectId],
  );

  async function patchStatus(row: IssueApiRow, status: IssueApiRow["status"]) {
    if (!encodedProject) return;
    setErr(null);
    setPatchBusyId(row.id);
    try {
      await api(`/api/v1/projects/${encodedProject}/issues/${encodeURIComponent(row.id)}`, {
        method: "PATCH",
        json: { status },
      });
      await loadIssues();
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : "Update failed");
    } finally {
      setPatchBusyId(null);
    }
  }

  async function submitCreate(e: FormEvent) {
    e.preventDefault();
    if (!encodedProject || !draftTitle.trim()) return;
    setErr(null);
    setCreateBusy(true);
    try {
      await api(`/api/v1/projects/${encodedProject}/issues`, {
        method: "POST",
        json: {
          title: draftTitle.trim(),
          description: draftDescription.trim(),
          ...(draftOwnerRoleId.trim() ? { ownerRoleId: draftOwnerRoleId.trim() } : {}),
          status: "open",
        },
      });
      setDraftTitle("");
      setDraftDescription("");
      setDraftOwnerRoleId("");
      await loadIssues();
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : "Create failed");
    } finally {
      setCreateBusy(false);
    }
  }

  return (
    <section className="page-pad">
      <h1 className="page-title">Issues</h1>
      <p className="muted">
        Capture findings from reviews and testing against a project. Each issue defaults to{" "}
        <strong>Open</strong> and stays assigned to the signed-in operator (admins may pick another assignee via the API).
        The <strong>Owner</strong> column is the team <strong>seat / role lane</strong> doing the remediation work — pick
        from roles on teams linked to the project.         Choosing an Owner spins a backlog task on this project&apos;s Board while delivery orchestration runs in the background
        (after <strong>Begin execution</strong>) — Save finishes as soon as the issue is stored, not when coders finish. Leave Owner
        empty while triaging and add it later to start that backlog link.
      </p>

      <div style={{ marginBottom: "1rem", display: "flex", flexWrap: "wrap", gap: "1rem", alignItems: "center" }}>
        <label style={{ display: "flex", flexDirection: "column", gap: "0.35rem", minWidth: "18rem" }}>
          <span className="muted" style={{ fontSize: "0.85rem" }}>
            Project
          </span>
          <select value={projectId} onChange={(e) => setProjectId(e.target.value)} style={{ padding: "0.45rem" }}>
            <option value="">Choose a project…</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>

        <label style={{ display: "flex", flexDirection: "column", gap: "0.35rem" }}>
          <span className="muted" style={{ fontSize: "0.85rem" }}>
            List
          </span>
          <select
            value={scope}
            onChange={(e) => setScope(e.target.value as typeof scope)}
            disabled={!projectId}
          >
            <option value="open">Open issues only</option>
            <option value="all">All statuses (Open, Closed, Deferred)</option>
          </select>
        </label>
        {projectId ?
          <Link className="linkish" style={{ alignSelf: "flex-end", fontSize: "0.92rem" }} to={`/projects/${encodedProject}/board`}>
            Open Board for {projectName || "project"}
          </Link>
        : null}
      </div>

      {err ?
        <p className="err" style={{ marginBottom: "0.75rem" }}>
          {err}
        </p>
      : null}

      {!projectId ? (
        <p className="muted">Select a project to create or inspect issues.</p>
      ) : (
        <>
          <div className="card" style={{ marginBottom: "1.25rem" }}>
            <h2 style={{ marginTop: 0, fontSize: "1rem" }}>Record a new issue</h2>
            <form className="form-stack" style={{ gap: "0.6rem", maxWidth: "48rem" }} onSubmit={(e) => void submitCreate(e)}>
              <label>
                Title
                <input
                  value={draftTitle}
                  onChange={(e) => setDraftTitle(e.target.value)}
                  placeholder="Brief finding or defect title"
                  maxLength={500}
                  required
                />
              </label>
              <label>
                Description
                <textarea
                  rows={5}
                  value={draftDescription}
                  onChange={(e) => setDraftDescription(e.target.value)}
                  placeholder="Repro steps, log excerpt, reviewer notes…"
                  style={{ fontFamily: "inherit" }}
                />
              </label>
              <label>
                Owner (seat / role lane)
                <select
                  value={draftOwnerRoleId}
                  onChange={(e) => setDraftOwnerRoleId(e.target.value)}
                  style={{ marginTop: "0.35rem", padding: "0.35rem", width: "100%" }}
                >
                  <option value="">Unset — assign a lane once triaged</option>
                  {roleOpts.map((r) => (
                    <option key={r.roleId} value={r.roleId}>
                      {r.display}
                    </option>
                  ))}
                </select>
              </label>
              <button type="submit" className="primary" disabled={createBusy}>
                {createBusy ? "Saving…" : "Create issue"}
              </button>
            </form>
          </div>

          <h2 style={{ fontSize: "1.05rem" }}>Issues for this project</h2>
          {busy ?
            <p className="muted">Loading…</p>
          : items.length === 0 ?
            <p className="muted">No issues match this filter.</p>
          : (
            <div style={{ overflowX: "auto" }}>
              <table className="data-table issues-table">
                <thead>
                  <tr>
                    <th scope="col">Issue ID</th>
                    <th scope="col">Title</th>
                    <th scope="col">Description</th>
                    <th scope="col">Status</th>
                    <th scope="col">Owner</th>
                    <th scope="col">Assigned user</th>
                    <th scope="col">Delivery</th>
                    <th scope="col">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((row) => (
                    <tr key={row.id}>
                      <td>
                        <code>#{row.issueNumber}</code>
                      </td>
                      <td style={{ whiteSpace: "normal", fontWeight: 600 }}>{row.title}</td>
                      <td className="muted" style={{ maxWidth: "22rem", fontSize: "0.85rem", whiteSpace: "normal" }}>
                        {shortenBody(row.description, 180)}
                      </td>
                      <td>{row.statusLabel}</td>
                      <td className="muted" style={{ whiteSpace: "normal", fontSize: "0.85rem" }}>
                        {row.owner?.display ?? "—"}
                      </td>
                      <td style={{ fontSize: "0.82rem", whiteSpace: "nowrap" }}>{row.assignedUserEmail}</td>
                      <td style={{ fontSize: "0.78rem" }}>
                        {row.deliveryTaskId && projectId ?
                          <Link
                            className="muted"
                            title="Opened from this issue via Owner seat lane"
                            to={`/projects/${encodeURIComponent(projectId)}/board`}
                          >
                            Board ↔ task
                          </Link>
                        : (
                          <span className="muted" title="Set an Owner (seat lane) to open a backlog task for orchestration">
                            —
                          </span>
                        )}
                      </td>
                      <td>
                        <div className="row" style={{ flexWrap: "wrap", gap: "0.35rem" }}>
                          {row.status !== "closed" ?
                            <button
                              type="button"
                              className="secondary"
                              style={{ padding: "0.25rem 0.55rem", fontSize: "0.78rem" }}
                              disabled={patchBusyId === row.id}
                              onClick={() => void patchStatus(row, "closed")}
                            >
                              Close
                            </button>
                          : null}
                          {row.status !== "deferred" && row.status !== "closed" ?
                            <button
                              type="button"
                              className="secondary"
                              style={{ padding: "0.25rem 0.55rem", fontSize: "0.78rem" }}
                              disabled={patchBusyId === row.id}
                              onClick={() => void patchStatus(row, "deferred")}
                            >
                              Defer
                            </button>
                          : null}
                          {row.status !== "open" ?
                            <button
                              type="button"
                              className="secondary"
                              style={{ padding: "0.25rem 0.55rem", fontSize: "0.78rem" }}
                              disabled={patchBusyId === row.id}
                              onClick={() => void patchStatus(row, "open")}
                            >
                              Reopen
                            </button>
                          : null}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </section>
  );
}
