import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api } from "../api/http.js";
import { useAuth } from "../auth/AuthContext.js";

type CompanyRow = { id: string; name: string };
type TeamRow = { id: string; name: string; _count?: { roles: number } };
type BU = { id: string; name: string };
type Agent = { id: string; name: string; status: string };
type AgentSeatLite = { assignedAgentId: string | null };
type LlmConn = { id: string; name: string; provider: string; modelId: string };
type ModelBindingRow = {
  companyId: string | null;
  agentId: string | null;
  roleId: string | null;
  skillId: string | null;
  llmProviderConnection?: { id: string; name: string } | null;
};
type Project = { id: string; _count?: { teamLinks: number } | null; context?: { brief: string | null; goals: string | null } | null };

type LayerId = "place" | "brain" | "people" | "delivery";

type GuideStep = {
  id: string;
  layer: LayerId;
  label: string;
  done: boolean;
  to: string;
  hint: string;
  /** Shown when user is not admin — action may require admin. */
  adminSuggested?: boolean;
};

function isCompanyWideModelBinding(m: ModelBindingRow): boolean {
  return Boolean(m.companyId) && !m.agentId && !m.roleId && !m.skillId;
}

const LAYER_META: Record<LayerId, { title: string; blurb: string }> = {
  place: {
    title: "Place",
    blurb: "Where work lives: company structure, teams, and seats (roles). Seat skills default from the catalog; trim on the team workspace if needed.",
  },
  brain: {
    title: "Brain",
    blurb: "Which model runs when agents need an LLM. A saved provider connection plus one company-scoped binding is your effective default for the org (same data as Admin → Model bindings → Company default).",
  },
  people: {
    title: "People",
    blurb: "Agents on the roster, then assigned to seats so each seat knows who acts.",
  },
  delivery: {
    title: "Delivery",
    blurb: "When the org is ready, create a project and link it to a team — same paths as today.",
  },
};

export function GuidedSetupPage() {
  const navigate = useNavigate();
  const { role } = useAuth();
  const admin = role === "admin";
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [company, setCompany] = useState<CompanyRow | null>(null);
  const [bus, setBus] = useState<BU[]>([]);
  const [teams, setTeams] = useState<TeamRow[]>([]);
  const [connections, setConnections] = useState<LlmConn[]>([]);
  const [bindings, setBindings] = useState<ModelBindingRow[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [seats, setSeats] = useState<AgentSeatLite[]>([]);
  const [roleTemplates, setRoleTemplates] = useState<{ id: string }[]>([]);
  const [skillTemplates, setSkillTemplates] = useState<{ id: string }[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);

  const load = useCallback(async () => {
    setErr(null);
    setLoading(true);
    try {
      const [
        co,
        buList,
        teamList,
        connRes,
        bindList,
        ag,
        seatList,
        rt,
        st,
        proj,
      ] = await Promise.all([
        api<CompanyRow | null>("/api/v1/company").catch(() => null),
        api<BU[]>("/api/v1/business-units").catch(() => []),
        api<TeamRow[]>("/api/v1/teams").catch(() => []),
        api<{ items: LlmConn[] }>("/api/v1/llm-provider-connections").catch(() => ({ items: [] })),
        api<ModelBindingRow[]>("/api/v1/model-bindings").catch(() => []),
        api<Agent[]>("/api/v1/agents").catch(() => []),
        api<AgentSeatLite[]>("/api/v1/agent-seats").catch(() => []),
        api<{ id: string }[]>("/api/v1/role-templates").catch(() => []),
        api<{ id: string }[]>("/api/v1/skill-templates").catch(() => []),
        api<Project[]>("/api/v1/projects").catch(() => []),
      ]);
      setCompany(co);
      setBus(buList);
      setTeams(teamList);
      setConnections(connRes.items);
      setBindings(bindList);
      setAgents(ag);
      setSeats(seatList);
      setRoleTemplates(rt);
      setSkillTemplates(st);
      setProjects(proj);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const steps = useMemo((): GuideStep[] => {
    const hasCompany = Boolean(company);
    const hasBU = bus.length > 0;
    const teamWithSeats = teams.some((t) => (t._count?.roles ?? 0) > 0);
    const catalogOk = roleTemplates.length > 0 && skillTemplates.length > 0;
    const hasLlmConnection = connections.length > 0;
    const hasCompanyBinding = bindings.some(
      (b) => isCompanyWideModelBinding(b) && Boolean(b.llmProviderConnection?.id)
    );
    const hasAgents = agents.length > 0;
    const seatAssigned = seats.some((s) => Boolean(s.assignedAgentId));
    const hasProject = projects.length > 0;
    const projectLinked = projects.some((p) => (p._count?.teamLinks ?? 0) > 0);
    const intakeOk = projects.some((p) => Boolean(p.context?.brief?.trim() || p.context?.goals?.trim()));
    const firstProjectId = projects[0]?.id;
    const intakeTarget = firstProjectId ? `/projects/${firstProjectId}/intake` : "/projects";

    return [
      {
        id: "company",
        layer: "place",
        label: "Company record",
        done: hasCompany,
        to: "/organization/business-units",
        hint: "Create or confirm the company (usually once per tenant).",
        adminSuggested: true,
      },
      {
        id: "bu",
        layer: "place",
        label: "Business unit",
        done: hasBU,
        to: "/organization/business-units",
        hint: "Recommended: at least one BU, then attach teams to it when you create them.",
        adminSuggested: true,
      },
      {
        id: "teams",
        layer: "place",
        label: "Team with seats",
        done: teamWithSeats,
        to: "/organization/teams",
        hint: "Classic workspace: define headcount per Sarva role type; seats get default skills from the catalog.",
        adminSuggested: true,
      },
      {
        id: "catalog",
        layer: "place",
        label: "Roles & skills catalog",
        done: catalogOk,
        to: "/organization/skills-models",
        hint: "Ships with seeded templates; extend role ↔ allowed skills here if your program needs more.",
        adminSuggested: true,
      },
      {
        id: "llm-conn",
        layer: "brain",
        label: "LLM provider connection",
        done: hasLlmConnection,
        to: "/admin?tab=llm",
        hint: "Admin → Model bindings: add a provider connection (API keys, model id).",
        adminSuggested: true,
      },
      {
        id: "company-binding",
        layer: "brain",
        label: "Company-wide model binding",
        done: hasCompanyBinding,
        to: "/admin?tab=llm",
        hint: "Same screen: add a binding with scope “Company” so agents without their own binding use this model.",
        adminSuggested: true,
      },
      {
        id: "agents",
        layer: "people",
        label: "Agents in roster",
        done: hasAgents,
        to: "/agents",
        hint: "Create agent identities; they stay unmapped until a company binding exists or you add per-agent overrides in Admin.",
        adminSuggested: true,
      },
      {
        id: "assign",
        layer: "people",
        label: "Agents assigned to seats",
        done: seatAssigned,
        to: "/organization/teams",
        hint: "On the classic team page: Seat ↔ agent assignments for each team.",
        adminSuggested: true,
      },
      {
        id: "project",
        layer: "delivery",
        label: "Project created",
        done: hasProject,
        to: "/projects",
        hint: "Work → Projects.",
      },
      {
        id: "intake",
        layer: "delivery",
        label: "Project intake (brief / goals)",
        done: intakeOk,
        to: intakeTarget,
        hint: "Open Intake and save at least a brief or goals.",
      },
      {
        id: "link",
        layer: "delivery",
        label: "Project linked to a team",
        done: projectLinked,
        to: intakeTarget,
        hint: "From Intake, link the project to a team.",
      },
    ];
  }, [company, bus, teams, connections, bindings, agents, seats, roleTemplates, skillTemplates, projects]);

  const foundationSteps = useMemo(() => steps.filter((s) => s.layer !== "delivery"), [steps]);
  const deliverySteps = useMemo(() => steps.filter((s) => s.layer === "delivery"), [steps]);

  const foundationDone = foundationSteps.filter((s) => s.done).length;
  const deliveryDone = deliverySteps.filter((s) => s.done).length;

  const nextFoundation = foundationSteps.find((s) => !s.done) ?? null;

  const layers: LayerId[] = ["place", "brain", "people", "delivery"];

  return (
    <div data-testid="guided-setup-page">
      <div className="card" style={{ marginBottom: "1rem", borderColor: "var(--accent)", background: "var(--accent-dim)" }}>
        <h1 style={{ margin: "0 0 0.35rem", fontSize: "1.2rem" }}>Guided setup (preview)</h1>
        <p className="muted" style={{ margin: 0 }}>
          Alternate <strong>V1</strong> layout: one story across org, LLM, and agents. Uses the same APIs and screens as
          today — links jump to the classic routes. Compare with the sidebar workflow anytime.
        </p>
        <p style={{ margin: "0.75rem 0 0" }}>
          <Link to="/organization/teams">Classic team workspace →</Link>
          {" · "}
          <Link to="/dashboard">Dashboard →</Link>
        </p>
      </div>

      {err ? <p className="err">{err}</p> : null}
      {loading ? <p className="muted">Loading status…</p> : null}

      {!loading && nextFoundation ? (
        <div
          className="card"
          data-testid="guided-setup-next"
          style={{
            marginBottom: "1rem",
            border: "2px solid var(--accent)",
            boxShadow: "0 0 0 1px rgba(61, 139, 253, 0.12)",
          }}
        >
          <p className="muted" style={{ fontSize: "0.72rem", textTransform: "uppercase", letterSpacing: "0.06em", margin: 0 }}>
            Suggested next (foundation)
          </p>
          <h2 style={{ margin: "0.35rem 0 0.5rem", fontSize: "1.05rem" }}>{nextFoundation.label}</h2>
          <p className="muted" style={{ margin: "0 0 0.75rem" }}>
            {nextFoundation.hint}
            {nextFoundation.adminSuggested && !admin ? (
              <>
                {" "}
                <strong>Admin</strong> access is required to complete this in the UI.
              </>
            ) : null}
          </p>
          <button
            type="button"
            className="primary"
            data-testid="guided-setup-next-cta"
            onClick={() => void navigate(nextFoundation.to)}
          >
            Go to step
          </button>
        </div>
      ) : null}

      {!loading && !nextFoundation ? (
        <div className="card" style={{ marginBottom: "1rem", borderColor: "var(--success)" }}>
          <p style={{ margin: 0 }}>
            <strong>Foundation complete.</strong> Optional: finish delivery steps below, or continue in the classic app.
          </p>
        </div>
      ) : null}

      <p className="muted" style={{ fontSize: "0.9rem" }}>
        Foundation progress:{" "}
        <strong>
          {foundationDone}/{foundationSteps.length}
        </strong>
        {deliverySteps.length ? (
          <>
            {" "}
            · Delivery:{" "}
            <strong>
              {deliveryDone}/{deliverySteps.length}
            </strong>
          </>
        ) : null}
      </p>

      {layers.map((layer) => {
        const meta = LAYER_META[layer];
        const layerSteps = steps.filter((s) => s.layer === layer);
        const doneN = layerSteps.filter((s) => s.done).length;
        return (
          <section key={layer} className="card" style={{ marginTop: "1rem" }} data-testid={`guided-layer-${layer}`}>
            <h2 style={{ margin: "0 0 0.25rem", fontSize: "1.05rem" }}>
              {meta.title}{" "}
              <span className="muted" style={{ fontWeight: 400, fontSize: "0.85rem" }}>
                ({doneN}/{layerSteps.length})
              </span>
            </h2>
            <p className="muted" style={{ margin: "0 0 1rem", fontSize: "0.88rem" }}>
              {meta.blurb}
            </p>
            <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: "0.65rem" }}>
              {layerSteps.map((s) => (
                <li
                  key={s.id}
                  style={{
                    display: "flex",
                    gap: "0.75rem",
                    alignItems: "flex-start",
                    padding: "0.65rem 0.75rem",
                    background: "var(--surface2)",
                    borderRadius: "8px",
                    border: "1px solid var(--border)",
                  }}
                >
                  <span
                    aria-hidden
                    style={{
                      flexShrink: 0,
                      width: "1.5rem",
                      textAlign: "center",
                      color: s.done ? "var(--success)" : "var(--muted)",
                      fontWeight: 700,
                    }}
                  >
                    {s.done ? "✓" : "○"}
                  </span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: "flex", flexWrap: "wrap", gap: "0.35rem", alignItems: "baseline" }}>
                      <strong>{s.label}</strong>
                      {s.adminSuggested ? (
                        <span className="muted" style={{ fontSize: "0.75rem" }}>
                          Admin UI
                        </span>
                      ) : null}
                    </div>
                    <p className="muted" style={{ margin: "0.25rem 0 0.5rem", fontSize: "0.82rem" }}>
                      {s.hint}
                    </p>
                    <Link to={s.to} style={{ fontSize: "0.88rem" }}>
                      Open →
                    </Link>
                  </div>
                </li>
              ))}
            </ul>
          </section>
        );
      })}

      <p className="muted" style={{ marginTop: "1.25rem", fontSize: "0.82rem" }}>
        <button type="button" className="linkish" onClick={() => void load()}>
          Refresh status
        </button>
      </p>
    </div>
  );
}
