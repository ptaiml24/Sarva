import { FormEvent, useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api/http.js";
import { useAuth } from "../auth/AuthContext.js";

type BU = { id: string; name: string; _count?: { teams: number } };
type Company = { id: string; name: string };

/**
 * Organization → Business units (separate from Teams).
 * Includes company create when missing (R1 single company per deployment).
 */
export function BusinessUnitsPage() {
  const { role } = useAuth();
  const admin = role === "admin";
  const [company, setCompany] = useState<Company | null | undefined>(undefined);
  const [bus, setBus] = useState<BU[]>([]);
  const [buName, setBuName] = useState("");
  const [companyName, setCompanyName] = useState("My company");
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const load = useCallback(async () => {
    setErr(null);
    try {
      const [co, b] = await Promise.all([
        api<Company | null>("/api/v1/company"),
        api<BU[]>("/api/v1/business-units"),
      ]);
      setCompany(co);
      setBus(b);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Load failed");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function createCompany(e: FormEvent) {
    e.preventDefault();
    if (!admin) return;
    setErr(null);
    setMsg(null);
    try {
      const co = await api<Company>("/api/v1/company", { method: "POST", json: { name: companyName } });
      setCompany(co);
      setMsg("Company created.");
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : "Failed");
    }
  }

  async function addBU(e: FormEvent) {
    e.preventDefault();
    if (!admin) return;
    setErr(null);
    await api("/api/v1/business-units", { method: "POST", json: { name: buName } });
    setBuName("");
    await load();
  }

  async function deleteBU(id: string) {
    if (!admin) return;
    if (!window.confirm("Delete this business unit? Only allowed when no teams are assigned to it.")) return;
    setErr(null);
    try {
      await api(`/api/v1/business-units/${id}`, { method: "DELETE" });
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Delete failed");
    }
  }

  if (company === undefined) {
    return (
      <div data-testid="business-units-page">
        <p>Loading…</p>
      </div>
    );
  }

  return (
    <div data-testid="business-units-page">
      <p className="muted page-intro">
        Business units group teams under your company (e.g. <strong>Sarva</strong>). This is step 3 in the{" "}
        <Link to="/dashboard">Dashboard</Link> guided setup — add BUs here, then create teams under{" "}
        <Link to="/organization/teams">Teams</Link> and attach each team to a BU.
      </p>
      {company && bus.length === 0 ? (
        <div className="callout-card" data-testid="bu-first-hint" style={{ marginBottom: "1rem" }}>
          <p style={{ margin: 0, fontSize: "0.9rem", lineHeight: 1.5 }}>
            <strong>Start here:</strong> add your first business unit below (e.g. Engineering, Product). Then continue on{" "}
            <Link to="/organization/teams">Teams</Link> to define headcount and link the team to that BU.
          </p>
        </div>
      ) : null}
      {msg ? <p className="ok">{msg}</p> : null}
      {err ? <p className="err">{err}</p> : null}

      <div className="card">
        <div className="card-head">
          <h2 className="card-title">Company</h2>
        </div>
        {company ? (
          <p data-testid="company-card">
            <strong data-testid="company-name">{company.name}</strong>
            <span className="muted" style={{ marginLeft: "0.5rem", fontSize: "0.85rem" }}>
              <code>{company.id}</code>
            </span>
          </p>
        ) : admin ? (
          <form className="row" onSubmit={createCompany}>
            <label>
              Company name
              <input
                value={companyName}
                onChange={(e) => setCompanyName(e.target.value)}
                data-testid="company-name-input"
                required
              />
            </label>
            <button type="submit" className="primary" data-testid="company-create">
              Create company
            </button>
          </form>
        ) : (
          <p className="err">No company yet — sign in as admin to create one.</p>
        )}
      </div>

      <div className="card" data-testid="section-bu">
        <div className="card-head">
          <h2 className="card-title">Business units</h2>
          {admin ? (
            <form className="row" style={{ margin: 0 }} onSubmit={addBU}>
              <label style={{ margin: 0 }}>
                Name
                <input value={buName} onChange={(e) => setBuName(e.target.value)} data-testid="bu-name" />
              </label>
              <button type="submit" className="secondary" data-testid="bu-add">
                Add BU
              </button>
            </form>
          ) : null}
        </div>
        <table className="data-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Teams</th>
              <th>Id</th>
              {admin ? <th /> : null}
            </tr>
          </thead>
          <tbody>
            {bus.map((b) => {
              const teamCount = b._count?.teams ?? 0;
              const canDelete = admin && teamCount === 0;
              return (
                <tr key={b.id}>
                  <td>{b.name}</td>
                  <td>{teamCount}</td>
                  <td>
                    <code className="mono">{b.id}</code>
                  </td>
                  {admin ? (
                    <td>
                      {canDelete ? (
                        <button
                          type="button"
                          className="secondary"
                          data-testid={`delete-bu-${b.id}`}
                          onClick={() => void deleteBU(b.id)}
                        >
                          Delete
                        </button>
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </td>
                  ) : null}
                </tr>
              );
            })}
          </tbody>
        </table>
        {bus.length === 0 ? <p className="muted">No business units yet.</p> : null}
      </div>
    </div>
  );
}
