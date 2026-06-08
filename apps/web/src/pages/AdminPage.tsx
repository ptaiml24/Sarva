import { FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api } from "../api/http.js";

/**
 * System → Admin — GitHub publishing, LLM bindings, and company baseline. Org catalogs and team structure live under Organization
 * (Roles & skills, Teams, …). Preview-only Admin tabs (guardrails, flows) stay out of the shell until backed by APIs.
 */
type Company = {
  id: string;
  name: string;
  settings?: unknown;
  githubOwnerLogin?: string | null;
  githubOwnerIsOrganization?: boolean;
  githubReposPrivateByDefault?: boolean;
  githubPatSet?: boolean;
};

type LlmProviderConnectionRow = {
  id: string;
  companyId: string;
  name: string;
  provider: string;
  modelId: string;
  baseUrl: string | null;
  apiKeySet: boolean;
};

type ModelBindingRow = {
  id: string;
  modelId: string;
  priority: number;
  companyId: string | null;
  roleId: string | null;
  skillId: string | null;
  agentId: string | null;
  agent?: { id: string; name: string } | null;
  company?: { id: string; name: string } | null;
  role?: { id: string; name: string } | null;
  skill?: { id: string; name: string } | null;
  llmProviderConnection?: {
    id: string;
    name: string;
    provider: string;
    modelId: string;
    baseUrl: string | null;
  } | null;
};

type LlmCatalogProvider = {
  id: string;
  label: string;
  description: string;
  docsUrl?: string;
  requiredEnv: { name: string; description: string }[];
  optionalEnv?: { name: string; description: string }[];
  modelPresets: { modelId: string; label: string }[];
  modelIdHint?: string;
};

type IntegrationsStatus = {
  mcpGit: unknown;
  gitMcpEndpointConfigured: boolean;
  prePushVerifyTimeoutMs: number;
  githubPublishConfigured?: boolean;
};

function bindingScopeLabel(m: ModelBindingRow): string {
  if (m.agentId) return `Agent: ${m.agent?.name ?? m.agentId}`;
  if (m.companyId) return `Company default`;
  if (m.roleId) return `Team role (seat): ${m.role?.name ?? m.roleId}`;
  if (m.skillId) return `Legacy (company skill row) — remove & recreate: ${m.skill?.name ?? m.skillId}`;
  return "—";
}

type TeamRoleOption = {
  id: string;
  name: string;
  team: { id: string; name: string };
  roleTemplate: { id: string; code: string; label: string } | null;
};

type AgentRow = { id: string; name: string; status: string };

const ADMIN_TABS = [
  { id: "company" as const, label: "Company" },
  { id: "github" as const, label: "GitHub publishing" },
  { id: "llm" as const, label: "Model bindings" },
];

export function AdminPage() {
  const [searchParams] = useSearchParams();
  const [adminTab, setAdminTab] = useState<(typeof ADMIN_TABS)[number]["id"]>("company");
  const [company, setCompany] = useState<Company | null | undefined>(undefined);
  const [companySettingsName, setCompanySettingsName] = useState("");
  const [roleTemplateCount, setRoleTemplateCount] = useState<number | null>(null);
  const [skillTemplateCount, setSkillTemplateCount] = useState<number | null>(null);
  const [bindings, setBindings] = useState<ModelBindingRow[]>([]);
  const [llmConnections, setLlmConnections] = useState<LlmProviderConnectionRow[]>([]);
  const [llmProviders, setLlmProviders] = useState<LlmCatalogProvider[]>([]);
  const [intStatus, setIntStatus] = useState<IntegrationsStatus | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [llmTestBusy, setLlmTestBusy] = useState<string | null>(null);
  const [llmTestResult, setLlmTestResult] = useState<{
    key: string;
    ok: boolean;
    latencyMs: number;
    detail: string;
  } | null>(null);

  const [mbScope, setMbScope] = useState<"company" | "agent" | "role">("company");
  const [mbAgentId, setMbAgentId] = useState("");
  const [mbRoleId, setMbRoleId] = useState("");
  const [agents, setAgents] = useState<AgentRow[]>([]);
  const [teamRoles, setTeamRoles] = useState<TeamRoleOption[]>([]);
  const [mbConnectionId, setMbConnectionId] = useState("");
  const [mbPriority, setMbPriority] = useState(0);

  const [pcName, setPcName] = useState("");
  const [pcProviderId, setPcProviderId] = useState("openai");
  const [pcModelId, setPcModelId] = useState("gpt-4o-mini");
  const [pcUseCustomModel, setPcUseCustomModel] = useState(false);
  const [pcBaseUrl, setPcBaseUrl] = useState("");
  const [pcApiKey, setPcApiKey] = useState("");
  const pcApiKeyRef = useRef(pcApiKey);
  pcApiKeyRef.current = pcApiKey;
  const [ollamaInstalledModels, setOllamaInstalledModels] = useState<string[]>([]);
  const [ollamaListLoading, setOllamaListLoading] = useState(false);
  const [cursorModelPresets, setCursorModelPresets] = useState<{ modelId: string; label: string }[]>([]);
  const [cursorListLoading, setCursorListLoading] = useState(false);

  const [ghOwnerLogin, setGhOwnerLogin] = useState("");
  const [ghIsOrg, setGhIsOrg] = useState(false);
  const [ghPrivateDefault, setGhPrivateDefault] = useState(true);
  const [ghPatInput, setGhPatInput] = useState("");
  const [ghBusy, setGhBusy] = useState(false);
  const [ghVerifyBusy, setGhVerifyBusy] = useState(false);
  const [ghVerifyMsg, setGhVerifyMsg] = useState<string | null>(null);

  const load = useCallback(async () => {
    setErr(null);
    try {
      const [co, b, connRes, int, ag, rt, st, rolesAll] = await Promise.all([
        api<Company | null>("/api/v1/company").catch(() => null),
        api<ModelBindingRow[]>("/api/v1/model-bindings"),
        api<{ items: LlmProviderConnectionRow[] }>("/api/v1/llm-provider-connections").catch(() => ({
          items: [] as LlmProviderConnectionRow[],
        })),
        api<IntegrationsStatus>("/api/v1/integrations/status").catch(() => null),
        api<AgentRow[]>("/api/v1/agents").catch(() => [] as AgentRow[]),
        api<{ id: string }[]>("/api/v1/role-templates").catch(() => []),
        api<{ id: string }[]>("/api/v1/skill-templates").catch(() => []),
        api<TeamRoleOption[]>("/api/v1/roles?all=true").catch(() => [] as TeamRoleOption[]),
      ]);
      setCompany(co ?? null);
      setBindings(b);
      setLlmConnections(connRes.items);
      setIntStatus(int);
      setAgents(ag);
      setRoleTemplateCount(rt.length);
      setSkillTemplateCount(st.length);
      setTeamRoles(rolesAll);
      const cat = await api<{ providers: LlmCatalogProvider[] }>("/api/v1/integrations/llm-catalog");
      setLlmProviders(cat.providers);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to load");
      try {
        const cat = await api<{ providers: LlmCatalogProvider[] }>("/api/v1/integrations/llm-catalog");
        setLlmProviders(cat.providers);
      } catch {
        setLlmProviders([]);
      }
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const t = searchParams.get("tab");
    if (t === "llm") setAdminTab("llm");
    if (t === "github") setAdminTab("github");
    /** Legacy Admin tab removed — static env readouts live in docs / `apps/api/.env`. */
    if (t === "integrations" || t === "workflows") setAdminTab("company");
  }, [searchParams]);

  useEffect(() => {
    if (!company) return;
    setGhOwnerLogin((company.githubOwnerLogin ?? "").trim());
    setGhIsOrg(Boolean(company.githubOwnerIsOrganization));
    setGhPrivateDefault(company.githubReposPrivateByDefault !== false);
    setGhPatInput("");
    setGhVerifyMsg(null);
  }, [company]);

  useEffect(() => {
    if (company?.name) setCompanySettingsName(company.name);
    else if (company === null) setCompanySettingsName("");
  }, [company]);

  useEffect(() => {
    if (pcProviderId !== "ollama") setOllamaInstalledModels([]);
    if (pcProviderId !== "cursor") setCursorModelPresets([]);
  }, [pcProviderId]);

  useEffect(() => {
    const p = llmProviders.find((x) => x.id === pcProviderId);
    const catalogIds = p?.modelPresets.map((m) => m.modelId) ?? [];
    const ollamaIds = pcProviderId === "ollama" ? ollamaInstalledModels : [];
    const cursorIds = pcProviderId === "cursor" ? cursorModelPresets.map((m) => m.modelId) : [];
    const allIds = [...new Set([...ollamaIds, ...cursorIds, ...catalogIds])];
    if (allIds.length === 0) return;
    if (!pcUseCustomModel) {
      const first = allIds[0];
      setPcModelId((prev) => (allIds.includes(prev) ? prev : first));
    }
  }, [pcProviderId, llmProviders, pcUseCustomModel, ollamaInstalledModels, cursorModelPresets]);

  useEffect(() => {
    if (!llmConnections.length) {
      setMbConnectionId("");
      return;
    }
    setMbConnectionId((prev) => (prev && llmConnections.some((c) => c.id === prev) ? prev : llmConnections[0].id));
  }, [llmConnections]);

  useEffect(() => {
    if (!agents.length) {
      setMbAgentId("");
      return;
    }
    setMbAgentId((prev) => (prev && agents.some((a) => a.id === prev) ? prev : agents[0].id));
  }, [agents]);

  useEffect(() => {
    if (!teamRoles.length) {
      setMbRoleId("");
      return;
    }
    setMbRoleId((prev) => (prev && teamRoles.some((r) => r.id === prev) ? prev : teamRoles[0].id));
  }, [teamRoles]);

  async function refreshOllamaInstalledModels() {
    setOllamaListLoading(true);
    setErr(null);
    try {
      const base = pcBaseUrl.trim() || "http://127.0.0.1:11434";
      const res = await api<{ models: string[]; baseUrl: string }>(
        `/api/v1/integrations/ollama-models?baseUrl=${encodeURIComponent(base)}`
      );
      setOllamaInstalledModels(res.models);
      setMsg(`Loaded ${res.models.length} model(s) from Ollama (${res.baseUrl}).`);
      if (res.models.length && !pcUseCustomModel) {
        setPcModelId((prev) => (res.models.includes(prev) ? prev : res.models[0]));
      }
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : "Failed to list Ollama models");
      setOllamaInstalledModels([]);
    } finally {
      setOllamaListLoading(false);
    }
  }

  const refreshCursorModels = useCallback(async () => {
    setCursorListLoading(true);
    setErr(null);
    try {
      const keyQ =
        pcApiKeyRef.current.trim() ? `?apiKey=${encodeURIComponent(pcApiKeyRef.current.trim())}` : "";
      const res = await api<{ models: { modelId: string; label: string }[] }>(
        `/api/v1/integrations/cursor-models${keyQ}`
      );
      setCursorModelPresets(res.models);
      const cursorCount = res.models.filter((m) => m.modelId !== "auto").length;
      setMsg(
        cursorCount > 0
          ? `Loaded ${cursorCount} Cursor model(s) (+ auto).`
          : "Cursor returned no models for this key — check the API key and try again."
      );
      if (res.models.length && !pcUseCustomModel) {
        const ids = res.models.map((m) => m.modelId);
        setPcModelId((prev) => (ids.includes(prev) ? prev : res.models[0].modelId));
      }
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : "Failed to list Cursor models");
      setCursorModelPresets([]);
    } finally {
      setCursorListLoading(false);
    }
  }, [pcUseCustomModel]);

  async function onAddProviderConnection(e: FormEvent) {
    e.preventDefault();
    setMsg(null);
    const modelId = pcModelId.trim();
    if (!modelId) {
      setErr("Enter a model id or pick a preset.");
      return;
    }
    if (!pcName.trim()) {
      setErr("Enter a name for this provider connection.");
      return;
    }
    try {
      await api("/api/v1/llm-provider-connections", {
        method: "POST",
        json: {
          name: pcName.trim(),
          provider: pcProviderId,
          modelId,
          baseUrl: pcBaseUrl.trim() || undefined,
          apiKey: pcApiKey.trim() || undefined,
        },
      });
      setPcName("");
      setPcBaseUrl("");
      setPcApiKey("");
      await load();
      setMsg("Provider connection saved.");
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : "Failed");
    }
  }

  async function deleteProviderConnection(id: string) {
    if (!window.confirm("Delete this provider connection? Bindings that use it must be removed first.")) return;
    setErr(null);
    try {
      await api(`/api/v1/llm-provider-connections/${encodeURIComponent(id)}`, { method: "DELETE" });
      await load();
      setMsg("Provider connection deleted.");
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : "Failed");
    }
  }

  async function testProviderConnection(connId: string) {
    const key = `pc:${connId}`;
    setLlmTestBusy(key);
    setLlmTestResult(null);
    setErr(null);
    try {
      const r = await api<{ ok: boolean; latencyMs: number; detail?: string; error?: string }>(
        `/api/v1/llm-provider-connections/${encodeURIComponent(connId)}/test`,
        { method: "POST" }
      );
      setLlmTestResult({
        key,
        ok: r.ok,
        latencyMs: r.latencyMs,
        detail: r.ok ? (r.detail ?? "OK") : (r.error ?? "Unknown error"),
      });
    } catch (ex) {
      setLlmTestResult({
        key,
        ok: false,
        latencyMs: 0,
        detail: ex instanceof Error ? ex.message : "Request failed",
      });
    } finally {
      setLlmTestBusy(null);
    }
  }

  async function testModelBinding(bindingId: string) {
    const key = `mb:${bindingId}`;
    setLlmTestBusy(key);
    setLlmTestResult(null);
    setErr(null);
    try {
      const r = await api<{ ok: boolean; latencyMs: number; detail?: string; error?: string }>(
        `/api/v1/model-bindings/${encodeURIComponent(bindingId)}/test`,
        { method: "POST" }
      );
      setLlmTestResult({
        key,
        ok: r.ok,
        latencyMs: r.latencyMs,
        detail: r.ok ? (r.detail ?? "OK") : (r.error ?? "Unknown error"),
      });
    } catch (ex) {
      setLlmTestResult({
        key,
        ok: false,
        latencyMs: 0,
        detail: ex instanceof Error ? ex.message : "Request failed",
      });
    } finally {
      setLlmTestBusy(null);
    }
  }

  async function onAddBinding(e: FormEvent) {
    e.preventDefault();
    setMsg(null);
    if (!mbConnectionId) {
      setErr("Add an LLM provider connection first.");
      return;
    }
    try {
      await api("/api/v1/model-bindings", {
        method: "POST",
        json: {
          scopeType: mbScope,
          scopeId:
            mbScope === "agent" ? mbAgentId : mbScope === "role" ? mbRoleId : undefined,
          llmProviderConnectionId: mbConnectionId,
          priority: mbPriority,
        },
      });
      await load();
      setMsg("Model binding added.");
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : "Failed");
    }
  }

  async function deleteBinding(id: string) {
    if (!window.confirm("Delete this model binding?")) return;
    setErr(null);
    await api(`/api/v1/model-bindings/${encodeURIComponent(id)}`, { method: "DELETE" });
    await load();
  }

  async function saveCompanySettings(e: FormEvent) {
    e.preventDefault();
    setMsg(null);
    setErr(null);
    const name = companySettingsName.trim();
    if (!name) {
      setErr("Company name is required.");
      return;
    }
    try {
      const updated = await api<Company>("/api/v1/company", { method: "PATCH", json: { name } });
      setCompany(updated);
      setMsg("Company name saved.");
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : "Save failed");
    }
  }

  async function saveGithubPublishing(e: FormEvent) {
    e.preventDefault();
    setMsg(null);
    setErr(null);
    setGhVerifyMsg(null);
    const owner = ghOwnerLogin.trim();
    if (!owner) {
      setErr("GitHub owner login is required (user or organization).");
      return;
    }
    const patTrim = ghPatInput.trim();
    const json: Record<string, unknown> = {
      githubOwnerLogin: owner,
      githubOwnerIsOrganization: ghIsOrg,
      githubReposPrivateByDefault: ghPrivateDefault,
    };
    if (patTrim.length > 0) {
      json.githubPat = patTrim;
    }
    setGhBusy(true);
    try {
      const updated = await api<Company>("/api/v1/company", { method: "PATCH", json });
      setCompany(updated);
      setGhPatInput("");
      setMsg("GitHub publishing settings saved.");
      const int = await api<IntegrationsStatus>("/api/v1/integrations/status").catch(() => null);
      setIntStatus(int);
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : "Save failed");
    } finally {
      setGhBusy(false);
    }
  }

  async function verifyGithubToken() {
    setMsg(null);
    setErr(null);
    setGhVerifyMsg(null);
    const patTrim = ghPatInput.trim();
    setGhVerifyBusy(true);
    try {
      const res = await api<{ ok: boolean; login?: string; ownerHint?: string; message?: string }>(
        "/api/v1/integrations/github-verify",
        { method: "POST", json: patTrim.length > 0 ? { githubPat: patTrim } : {} },
      );
      if (res.ok && res.login) {
        setGhVerifyMsg(`Token valid for GitHub user “${res.login}”. ${res.ownerHint ?? ""}`.trim());
      } else {
        setGhVerifyMsg(res.message ?? "Verification returned no details.");
      }
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : "Verification failed");
    } finally {
      setGhVerifyBusy(false);
    }
  }

  if (company === undefined) {
    return (
      <div data-testid="admin-page">
        <p>Loading…</p>
      </div>
    );
  }

  return (
    <div data-testid="admin-page">
      <p className="muted page-intro">
        <strong>System → Admin</strong> — GitHub publishing and model bindings for the tenant. Git/MCP and LLM defaults are configured on the{' '}
        <strong>API host</strong> (<code>apps/api/.env</code> — see README). Org catalogs live under{" "}
        <Link to="/organization/skills-models">Roles &amp; skills</Link> and <Link to="/organization/teams">Teams</Link>.
      </p>
      {msg ? <p className="ok">{msg}</p> : null}
      {err ? <p className="err">{err}</p> : null}

      <div className="admin-tabs" role="tablist" aria-label="Admin sections">
        {ADMIN_TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={adminTab === t.id}
            className={adminTab === t.id ? "active" : ""}
            data-testid={`admin-tab-${t.id}`}
            onClick={() => setAdminTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {adminTab === "company" ? (
        <>
          <div className="card">
            <div className="card-head">
              <h2 className="card-title">Company settings</h2>
            </div>
              {company ? (
                <form onSubmit={saveCompanySettings}>
                  <label>
                    Company display name
                    <input
                      value={companySettingsName}
                      onChange={(e) => setCompanySettingsName(e.target.value)}
                      data-testid="admin-company-name"
                    />
                  </label>
                  <p className="muted" style={{ fontSize: "0.82rem" }}>
                    Id <code className="mono">{company.id}</code>
                  </p>
                  <p className="muted" style={{ fontSize: "0.82rem", marginTop: "0.65rem", marginBottom: 0 }}>
                    <strong>Backlog:</strong> tenant-level enforcement of human approval before outbound email (Email Agent /
                    sends) — FRD-aligned; no API or UI control in this release.
                  </p>
                  <button type="submit" className="primary" style={{ marginTop: "0.75rem" }} data-testid="admin-save-company">
                    Save company name
                  </button>
                </form>
              ) : (
                <p className="muted">
                  No company record — create one under <Link to="/organization/business-units">Business units</Link>.
                </p>
              )}
            </div>
          <div className="card" style={{ marginTop: "1rem" }}>
            <div className="card-head">
              <h2 className="card-title">Prebuilt catalogs</h2>
              <Link to="/organization/skills-models" className="badge badge-blue">
                Edit templates
              </Link>
            </div>
            <p className="muted" style={{ margin: 0 }}>
              Role templates: <strong>{roleTemplateCount ?? "—"}</strong> · Skill templates:{" "}
              <strong>{skillTemplateCount ?? "—"}</strong> — managed under <strong>Organization → Roles &amp; skills</strong>.
            </p>
          </div>
        </>
      ) : null}

      {adminTab === "github" ? (
        <>
          <div className="card">
            <div className="card-head">
              <h2 className="card-title">GitHub publishing</h2>
              {intStatus?.githubPublishConfigured ? (
                <span className="badge badge-green">ready</span>
              ) : (
                <span className="badge badge-gray">incomplete</span>
              )}
            </div>
            <p className="muted" style={{ marginTop: 0 }}>
              Sarva uses a <strong>fine-grained or classic personal access token</strong> stored for your company to create
              repositories and push the project dev workspace. Tokens are not shown after save; leave the token field empty
              to keep the current secret. New repositories follow the default visibility below unless overridden when
              publishing from the board.
            </p>
            {!company ? (
              <p className="muted">No company record — cannot configure GitHub.</p>
            ) : (
              <form onSubmit={saveGithubPublishing} style={{ maxWidth: "36rem" }}>
                <label style={{ display: "block", marginTop: "0.75rem" }}>
                  <span className="muted">Owner login (user or org)</span>
                  <input
                    type="text"
                    className="input"
                    style={{ width: "100%", marginTop: "0.25rem" }}
                    autoComplete="off"
                    value={ghOwnerLogin}
                    onChange={(e) => setGhOwnerLogin(e.target.value)}
                    placeholder="e.g. acme-corp or jane"
                  />
                </label>
                <label style={{ display: "flex", alignItems: "center", gap: "0.5rem", marginTop: "0.75rem" }}>
                  <input type="checkbox" checked={ghIsOrg} onChange={(e) => setGhIsOrg(e.target.checked)} />
                  <span>Owner is a GitHub organization</span>
                </label>
                <fieldset style={{ border: "1px solid var(--border)", borderRadius: 8, padding: "0.75rem 1rem", marginTop: "0.75rem" }}>
                  <legend className="muted" style={{ fontSize: "0.85rem" }}>
                    Default visibility for new repos
                  </legend>
                  <label style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
                    <input
                      type="radio"
                      name="gh-vis-default"
                      checked={ghPrivateDefault}
                      onChange={() => setGhPrivateDefault(true)}
                    />
                    <span>Private (recommended)</span>
                  </label>
                  <label style={{ display: "flex", alignItems: "center", gap: "0.5rem", marginTop: "0.35rem" }}>
                    <input
                      type="radio"
                      name="gh-vis-default"
                      checked={!ghPrivateDefault}
                      onChange={() => setGhPrivateDefault(false)}
                    />
                    <span>Public</span>
                  </label>
                </fieldset>
                <label style={{ display: "block", marginTop: "0.75rem" }}>
                  <span className="muted">Personal access token {company.githubPatSet ? "(leave blank to keep saved token)" : ""}</span>
                  <input
                    type="password"
                    className="input"
                    style={{ width: "100%", marginTop: "0.25rem" }}
                    autoComplete="new-password"
                    value={ghPatInput}
                    onChange={(e) => setGhPatInput(e.target.value)}
                    placeholder="ghp_… or github_pat_…"
                  />
                </label>
                <div style={{ display: "flex", flexWrap: "wrap", gap: "0.5rem", marginTop: "1rem" }}>
                  <button type="submit" className="btn btn-primary" disabled={ghBusy}>
                    {ghBusy ? "Saving…" : "Save GitHub settings"}
                  </button>
                  <button
                    type="button"
                    className="btn"
                    disabled={ghVerifyBusy}
                    onClick={() => void verifyGithubToken()}
                  >
                    {ghVerifyBusy ? "Testing…" : "Test connection"}
                  </button>
                </div>
                {ghVerifyMsg ? <p className="ok" style={{ marginTop: "0.75rem", marginBottom: 0 }}>{ghVerifyMsg}</p> : null}
              </form>
            )}
          </div>
        </>
      ) : null}

      {adminTab === "llm" ? (
        <>
      <div className="card">
        <h2>LLM provider connections</h2>
        <p className="muted">
          API keys and model ids for vendors. <strong>Model bindings</strong> (below) attach a saved connection to{" "}
          <strong>company</strong> (company-wide default) or a specific <strong>agent</strong>. When both exist, the{" "}
          <strong>agent</strong> binding wins. Leave <strong>Base URL</strong> empty for typical cloud APIs; set it for Ollama or
          OpenAI-compatible proxies. Use <strong>Test</strong> on a connection or binding to run a short live check (can take up to
          ~2 minutes for slow providers).
        </p>
        {llmConnections.length === 0 ? (
          <p className="muted">No connections yet.</p>
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Provider</th>
                <th>Model</th>
                <th>Base URL</th>
                <th>API key</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {llmConnections.map((c) => (
                <tr key={c.id}>
                  <td>{c.name}</td>
                  <td>
                    <code>{c.provider}</code>
                  </td>
                  <td>
                    <code>{c.modelId}</code>
                  </td>
                  <td>{c.baseUrl ?? "—"}</td>
                  <td>{c.apiKeySet ? "saved" : "—"}</td>
                  <td>
                    <div className="row" style={{ flexWrap: "wrap", gap: "0.35rem", alignItems: "center" }}>
                      <button
                        type="button"
                        className="secondary"
                        disabled={llmTestBusy !== null}
                        data-testid={`llm-conn-test-${c.id}`}
                        onClick={() => void testProviderConnection(c.id)}
                      >
                        {llmTestBusy === `pc:${c.id}` ? "Testing…" : "Test"}
                      </button>
                      <button type="button" className="secondary" onClick={() => void deleteProviderConnection(c.id)}>
                        Delete
                      </button>
                    </div>
                    {llmTestResult?.key === `pc:${c.id}` ? (
                      <p
                        className={llmTestResult.ok ? "ok" : "err"}
                        style={{ margin: "0.35rem 0 0", fontSize: "0.88rem", maxWidth: "28rem" }}
                        data-testid={`llm-conn-test-result-${c.id}`}
                      >
                        <strong>{llmTestResult.ok ? "Success" : "No success"}</strong>
                        {llmTestResult.latencyMs > 0 ? (
                          <span className="muted"> · {llmTestResult.latencyMs}ms</span>
                        ) : null}
                        <br />
                        <span style={{ fontWeight: "normal" }}>{llmTestResult.detail}</span>
                      </p>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        <h3 style={{ marginTop: "1rem" }}>Add connection</h3>
        {llmProviders.length === 0 ? (
          <p className="muted">Could not load provider catalog.</p>
        ) : (
          <form onSubmit={onAddProviderConnection}>
            <div className="row" style={{ flexWrap: "wrap", alignItems: "flex-end" }}>
              <label>
                Display name
                <input value={pcName} onChange={(e) => setPcName(e.target.value)} placeholder="e.g. OpenAI prod" required />
              </label>
              <label>
                Provider
                <select
                  value={pcProviderId}
                  onChange={(e) => {
                    setPcProviderId(e.target.value);
                    setPcUseCustomModel(false);
                  }}
                >
                  {llmProviders.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.label}
                    </option>
                  ))}
                </select>
              </label>
              {pcProviderId === "cursor" || pcProviderId === "ollama" ? (
                <label style={{ flex: "1 1 14rem" }}>
                  API key / token
                  <input
                    type="password"
                    autoComplete="off"
                    value={pcApiKey}
                    onChange={(e) => setPcApiKey(e.target.value)}
                    placeholder={pcProviderId === "cursor" ? "Cursor Dashboard → Integrations" : "Optional for Ollama"}
                  />
                </label>
              ) : null}
              {pcProviderId === "ollama" ? (
                <div style={{ flex: "1 1 100%", marginBottom: "0.35rem" }}>
                  <button
                    type="button"
                    className="secondary"
                    disabled={ollamaListLoading}
                    onClick={() => void refreshOllamaInstalledModels()}
                  >
                    {ollamaListLoading ? "Loading…" : "Load installed models"}
                  </button>
                </div>
              ) : null}
              {pcProviderId === "cursor" ? (
                <div style={{ flex: "1 1 100%", marginBottom: "0.35rem" }}>
                  <button
                    type="button"
                    className="secondary"
                    disabled={cursorListLoading}
                    onClick={() => void refreshCursorModels()}
                  >
                    {cursorListLoading ? "Loading…" : "Load models from Cursor"}
                  </button>
                  <span className="muted" style={{ display: "block", fontSize: "0.82rem", marginTop: "0.35rem" }}>
                    Enter your API key first, or set <code>CURSOR_API_KEY</code> on the API host. New Composer versions appear after refresh.
                  </span>
                </div>
              ) : null}
              <label>
                Preset model
                <select
                  value={pcUseCustomModel ? "__custom__" : pcModelId}
                  onChange={(e) => {
                    const v = e.target.value;
                    if (v === "__custom__") {
                      setPcUseCustomModel(true);
                      setPcModelId("");
                    } else {
                      setPcUseCustomModel(false);
                      setPcModelId(v);
                    }
                  }}
                >
                  {(() => {
                    const catalog = llmProviders.find((x) => x.id === pcProviderId)?.modelPresets ?? [];
                    const installed =
                      pcProviderId === "ollama"
                        ? ollamaInstalledModels.map((name) => ({ modelId: name, label: `${name} (installed)` }))
                      : pcProviderId === "cursor"
                        ? cursorModelPresets.map((m) => ({ modelId: m.modelId, label: m.label }))
                        : [];
                    const seen = new Set<string>();
                    const rows: { modelId: string; label: string }[] = [];
                    for (const o of [...installed, ...catalog]) {
                      if (seen.has(o.modelId)) continue;
                      seen.add(o.modelId);
                      rows.push(o);
                    }
                    return rows.map((m) => (
                      <option key={m.modelId} value={m.modelId}>
                        {m.label} ({m.modelId})
                      </option>
                    ));
                  })()}
                  <option value="__custom__">Custom model id…</option>
                </select>
              </label>
              {pcUseCustomModel ? (
                <label>
                  Custom model id
                  <input value={pcModelId} onChange={(e) => setPcModelId(e.target.value)} required />
                </label>
              ) : null}
            </div>
            <div className="row" style={{ marginTop: "0.5rem", flexWrap: "wrap", alignItems: "flex-end" }}>
              {pcProviderId !== "cursor" && pcProviderId !== "ollama" ? (
                <label>
                  API key / token
                  <input
                    type="password"
                    autoComplete="off"
                    value={pcApiKey}
                    onChange={(e) => setPcApiKey(e.target.value)}
                  />
                </label>
              ) : null}
              <label>
                Base URL (optional — for Ollama / local OpenAI-compatible APIs)
                <input
                  value={pcBaseUrl}
                  onChange={(e) => setPcBaseUrl(e.target.value)}
                  placeholder="e.g. http://127.0.0.1:11434 — leave blank for OpenAI/Anthropic cloud"
                />
              </label>
            </div>
            <button type="submit" className="primary" style={{ marginTop: "0.75rem" }}>
              Save connection
            </button>
          </form>
        )}
      </div>

      <div className="card">
        <h2>Model bindings</h2>
        <p className="muted">
          Map <strong>company</strong> (org default), <strong>agent</strong> (overrides for that agent), or{" "}
          <strong>team role</strong> (seat on a team — same <code>role</code> row orchestration uses as{" "}
          <code>targetRoleId</code>) to a provider connection. At runtime, resolution is typically{" "}
          <strong>seat → agent → company</strong>, each tier sorted by <strong>priority</strong> (lower first).{" "}
          <strong>Test</strong> uses the binding&apos;s snapshot <code>modelId</code> and the linked connection credentials.
          Create agents and team roles under <Link to="/organization/teams">Teams</Link>.
        </p>
        {bindings.length === 0 ? (
          <p>None.</p>
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <th>Scope</th>
                <th>Connection</th>
                <th>Model (snapshot)</th>
                <th>Priority</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {bindings.map((m) => (
                <tr key={m.id}>
                  <td>{bindingScopeLabel(m)}</td>
                  <td>
                    {m.llmProviderConnection ? (
                      <>
                        <strong>{m.llmProviderConnection.name}</strong>{" "}
                        <span className="muted">
                          (<code>{m.llmProviderConnection.provider}</code>)
                        </span>
                      </>
                    ) : (
                      <span className="muted">Legacy (env / no connection)</span>
                    )}
                  </td>
                  <td>
                    <code>{m.modelId}</code>
                  </td>
                  <td>{m.priority}</td>
                  <td>
                    <div className="row" style={{ flexWrap: "wrap", gap: "0.35rem", alignItems: "center" }}>
                      <button
                        type="button"
                        className="secondary"
                        disabled={llmTestBusy !== null || !m.llmProviderConnection}
                        data-testid={`model-binding-test-${m.id}`}
                        title={!m.llmProviderConnection ? "No provider connection on this binding" : undefined}
                        onClick={() => void testModelBinding(m.id)}
                      >
                        {llmTestBusy === `mb:${m.id}` ? "Testing…" : "Test"}
                      </button>
                      <button type="button" className="secondary" onClick={() => void deleteBinding(m.id)}>
                        Delete
                      </button>
                    </div>
                    {llmTestResult?.key === `mb:${m.id}` ? (
                      <p
                        className={llmTestResult.ok ? "ok" : "err"}
                        style={{ margin: "0.35rem 0 0", fontSize: "0.88rem", maxWidth: "28rem" }}
                        data-testid={`model-binding-test-result-${m.id}`}
                      >
                        <strong>{llmTestResult.ok ? "Success" : "No success"}</strong>
                        {llmTestResult.latencyMs > 0 ? (
                          <span className="muted"> · {llmTestResult.latencyMs}ms</span>
                        ) : null}
                        <br />
                        <span style={{ fontWeight: "normal" }}>{llmTestResult.detail}</span>
                      </p>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        <h3 style={{ marginTop: "1rem" }}>Add binding</h3>
        <form onSubmit={onAddBinding}>
          <div className="row" style={{ flexWrap: "wrap", alignItems: "flex-end" }}>
            <label>
              Provider connection
              <select
                value={mbConnectionId}
                onChange={(e) => setMbConnectionId(e.target.value)}
                required
                disabled={llmConnections.length === 0}
              >
                {llmConnections.length === 0 ? (
                  <option value="">Add a connection above first</option>
                ) : (
                  llmConnections.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name} — {c.provider} / {c.modelId}
                    </option>
                  ))
                )}
              </select>
            </label>
            <label>
              Scope
              <select
                value={mbScope}
                onChange={(e) => {
                  setMbScope(e.target.value as typeof mbScope);
                }}
              >
                <option value="company">Company (default)</option>
                <option value="agent">Agent (override)</option>
                <option value="role">Team role — seat (targetRoleId)</option>
              </select>
            </label>
            {mbScope === "agent" ? (
              <label>
                Agent
                <select
                  value={mbAgentId}
                  onChange={(e) => setMbAgentId(e.target.value)}
                  required
                  disabled={agents.length === 0}
                >
                  {agents.length === 0 ? (
                    <option value="">Add an agent under Teams first</option>
                  ) : (
                    agents.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name} ({a.status})
                      </option>
                    ))
                  )}
                </select>
              </label>
            ) : null}
            {mbScope === "role" ? (
              <label>
                Team role (seat)
                <select
                  value={mbRoleId}
                  onChange={(e) => setMbRoleId(e.target.value)}
                  required
                  disabled={teamRoles.length === 0}
                >
                  {teamRoles.length === 0 ? (
                    <option value="">Add a team with roles under Organization first</option>
                  ) : (
                    teamRoles.map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.team.name} · {r.name}
                        {r.roleTemplate?.code ? ` (${r.roleTemplate.code})` : ""}
                      </option>
                    ))
                  )}
                </select>
              </label>
            ) : null}
            <label>
              Priority (lower first)
              <input type="number" value={mbPriority} onChange={(e) => setMbPriority(Number(e.target.value))} />
            </label>
            <button
              type="submit"
              className="primary"
              disabled={
                llmConnections.length === 0 ||
                (mbScope === "agent" && agents.length === 0) ||
                (mbScope === "role" && teamRoles.length === 0)
              }
            >
              Add binding
            </button>
          </div>
        </form>
      </div>
        </>
      ) : null}
    </div>
  );
}
