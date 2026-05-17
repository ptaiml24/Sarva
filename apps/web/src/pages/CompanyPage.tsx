import { FormEvent, useEffect, useState } from "react";
import { api } from "../api/http.js";
import { useAuth } from "../auth/AuthContext.js";

type Company = { id: string; name: string };

export function CompanyPage() {
  const { role } = useAuth();
  const [company, setCompany] = useState<Company | null | undefined>(undefined);
  const [name, setName] = useState("My company");
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let c = false;
    (async () => {
      try {
        const co = await api<Company | null>("/api/v1/company");
        if (!c) setCompany(co);
      } catch (e) {
        if (!c) setErr(e instanceof Error ? e.message : "Load failed");
      }
    })();
    return () => {
      c = true;
    };
  }, []);

  async function create(e: FormEvent) {
    e.preventDefault();
    setErr(null);
    setMsg(null);
    try {
      const co = await api<Company>("/api/v1/company", { method: "POST", json: { name } });
      setCompany(co);
      setMsg("Company created.");
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : "Failed");
    }
  }

  if (company === undefined) {
    return <p>Loading…</p>;
  }

  return (
    <div data-testid="company-page">
      <h1>Company</h1>
      <p>R1 uses one company record per deployment (single organization in the database).</p>
      {company ? (
        <div className="card" data-testid="company-card">
          <strong data-testid="company-name">{company.name}</strong>
          <p style={{ marginTop: "0.5rem", fontSize: "0.85rem" }}>ID: {company.id}</p>
        </div>
      ) : (
        <div className="card">
          {role !== "admin" ? (
            <p className="err">No company yet — sign in as admin to create one.</p>
          ) : (
            <form onSubmit={create}>
              <label>
                Company name
                <input value={name} onChange={(e) => setName(e.target.value)} data-testid="company-name-input" required />
              </label>
              <button type="submit" className="primary" data-testid="company-create">
                Create company
              </button>
            </form>
          )}
        </div>
      )}
      {msg ? (
        <p className="ok" data-testid="company-msg">
          {msg}
        </p>
      ) : null}
      {err ? <p className="err">{err}</p> : null}
    </div>
  );
}
