import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api/http.js";
import { useAuth } from "../auth/AuthContext.js";
import { CollapsibleCard } from "../components/CollapsibleCard.js";

type RoleTemplate = {
  id: string;
  code: string;
  label: string;
  description: string | null;
  allowedSkills: { skillTemplate: { id: string; code: string; label: string } }[];
};
type SkillTemplate = {
  id: string;
  code: string;
  label: string;
  description: string | null;
  /** Effective prompt (built-in default merged when `agentPromptOverride` is null). */
  agentPrompt: string;
  agentPromptOverride?: string | null;
  builtinDefaultAgentPrompt?: string | null;
};

function humanizeSkillCode(code: string): string {
  const t = code.trim();
  if (!/^[a-zA-Z0-9_]+$/.test(t)) return t.length ? t : "Skill";
  return t
    .split(/_+/g)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(" ");
}

/**
 * Organization → Roles & skills — Sarva role types, skill catalog, and which skills each role type may use.
 * LLM connections & bindings: System → Admin only.
 */
export function SkillsModelsPage() {
  const { role } = useAuth();
  const admin = role === "admin";
  const [roleTemplates, setRoleTemplates] = useState<RoleTemplate[]>([]);
  const [skillTemplates, setSkillTemplates] = useState<SkillTemplate[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const [newRoleCode, setNewRoleCode] = useState("");
  const [newRoleLabel, setNewRoleLabel] = useState("");
  const [newRoleDesc, setNewRoleDesc] = useState("");
  const [newSkillCode, setNewSkillCode] = useState("");
  const [newSkillLabel, setNewSkillLabel] = useState("");
  const [newSkillDesc, setNewSkillDesc] = useState("");
  const [newSkillPrompt, setNewSkillPrompt] = useState("");
  const [editRoleId, setEditRoleId] = useState("");
  const [editRoleLabel, setEditRoleLabel] = useState("");
  const [editRoleDesc, setEditRoleDesc] = useState("");
  const [editSkillId, setEditSkillId] = useState("");
  const [editSkillLabel, setEditSkillLabel] = useState("");
  const [editSkillPrompt, setEditSkillPrompt] = useState("");
  const [linkRt, setLinkRt] = useState("");
  const [linkSt, setLinkSt] = useState("");
  const [skillDraftGenerating, setSkillDraftGenerating] = useState(false);

  const load = useCallback(async () => {
    setErr(null);
    try {
      const [rt, st] = await Promise.all([
        api<RoleTemplate[]>("/api/v1/role-templates"),
        api<SkillTemplate[]>("/api/v1/skill-templates"),
      ]);
      setRoleTemplates(rt);
      setSkillTemplates(st);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to load");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!roleTemplates.length) return;
    setLinkRt((prev) => prev || roleTemplates[0].id);
    setEditRoleId((prev) => prev || roleTemplates[0].id);
  }, [roleTemplates]);

  useEffect(() => {
    if (!skillTemplates.length) return;
    setLinkSt((prev) => prev || skillTemplates[0].id);
    setEditSkillId((prev) => prev || skillTemplates[0].id);
  }, [skillTemplates]);

  useEffect(() => {
    if (!roleTemplates.length || !editRoleId) return;
    const r = roleTemplates.find((x) => x.id === editRoleId);
    if (r) {
      setEditRoleLabel(r.label);
      setEditRoleDesc(r.description ?? "");
    }
  }, [roleTemplates, editRoleId]);

  useEffect(() => {
    if (!skillTemplates.length || !editSkillId) return;
    const s = skillTemplates.find((x) => x.id === editSkillId);
    if (s) {
      setEditSkillLabel(s.label);
      setEditSkillPrompt(s.agentPrompt);
    }
  }, [skillTemplates, editSkillId]);

  const editSkillSelected = useMemo(
    () => skillTemplates.find((x) => x.id === editSkillId),
    [skillTemplates, editSkillId]
  );

  const skillRollup = useMemo(() => {
    const bySkill = new Map<string, { skill: SkillTemplate; roleLabels: Set<string> }>();
    for (const rt of roleTemplates) {
      for (const link of rt.allowedSkills) {
        const st = link.skillTemplate;
        let row = bySkill.get(st.id);
        if (!row) {
          row = { skill: st as SkillTemplate, roleLabels: new Set() };
          bySkill.set(st.id, row);
        }
        row.roleLabels.add(rt.label);
      }
    }
    return [...bySkill.values()].sort((a, b) => a.skill.label.localeCompare(b.skill.label));
  }, [roleTemplates]);

  async function onEditRole(e: FormEvent) {
    e.preventDefault();
    if (!admin || !editRoleId) return;
    setMsg(null);
    try {
      await api(`/api/v1/role-templates/${encodeURIComponent(editRoleId)}`, {
        method: "PATCH",
        json: { label: editRoleLabel, description: editRoleDesc || null },
      });
      await load();
      setMsg("Role type updated.");
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : "Failed");
    }
  }

  async function onEditSkill(e: FormEvent) {
    e.preventDefault();
    if (!admin || !editSkillId) return;
    setMsg(null);
    try {
      const def = editSkillSelected?.builtinDefaultAgentPrompt?.trim();
      const trimmed = editSkillPrompt.trim();
      const agentPrompt =
        !trimmed ? null : def && trimmed === def ? null : editSkillPrompt || null;
      await api(`/api/v1/skill-templates/${encodeURIComponent(editSkillId)}`, {
        method: "PATCH",
        json: { label: editSkillLabel, agentPrompt },
      });
      await load();
      setMsg("Skill updated.");
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : "Failed");
    }
  }

  async function onAddRole(e: FormEvent) {
    e.preventDefault();
    if (!admin) return;
    setMsg(null);
    try {
      await api("/api/v1/role-templates", {
        method: "POST",
        json: { code: newRoleCode, label: newRoleLabel, description: newRoleDesc || null },
      });
      setNewRoleCode("");
      setNewRoleLabel("");
      setNewRoleDesc("");
      await load();
      setMsg("Role type created.");
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : "Failed");
    }
  }

  async function onGenerateSkillDraft() {
    if (!admin || !newSkillCode.trim() || !newSkillDesc.trim()) return;
    setErr(null);
    setMsg(null);
    setSkillDraftGenerating(true);
    try {
      const res = await api<{ label: string; agentPrompt: string }>(
        "/api/v1/skill-templates/generate-draft",
        {
          method: "POST",
          json: { code: newSkillCode.trim(), description: newSkillDesc.trim() },
        },
      );
      setNewSkillLabel(res.label);
      setNewSkillPrompt(res.agentPrompt);
      setMsg("Drafted display label and agent prompt with the company default model binding.");
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : "Generate failed");
    } finally {
      setSkillDraftGenerating(false);
    }
  }

  async function onAddSkill(e: FormEvent) {
    e.preventDefault();
    if (!admin) return;
    setMsg(null);
    const trimmedLabel = newSkillLabel.trim() || humanizeSkillCode(newSkillCode);
    try {
      await api("/api/v1/skill-templates", {
        method: "POST",
        json: {
          code: newSkillCode.trim(),
          label: trimmedLabel,
          description: newSkillDesc.trim() || null,
          agentPrompt: newSkillPrompt.trim() || null,
        },
      });
      setNewSkillCode("");
      setNewSkillLabel("");
      setNewSkillDesc("");
      setNewSkillPrompt("");
      await load();
      setMsg("Skill created.");
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : "Failed");
    }
  }

  async function onLinkRtSt(e: FormEvent) {
    e.preventDefault();
    if (!admin || !linkRt || !linkSt) return;
    setMsg(null);
    try {
      const res = await api<{ linked?: boolean; seatRolesPropagated?: number }>("/api/v1/role-template-skills", {
        method: "POST",
        json: { roleTemplateId: linkRt, skillTemplateId: linkSt },
      });
      await load();
      const n = typeof res.seatRolesPropagated === "number" ? res.seatRolesPropagated : 0;
      if (res.linked === false && n > 0) {
        setMsg(
          "Skill was already allowed for this role type — refreshed links on team seats so the API sees Coder/eligibility.",
        );
      } else if (res.linked === false) {
        setMsg("Skill was already allowed for this role type (no seat rows needed updating).");
      } else if (n > 0) {
        setMsg(
          `Skill allowed for role type — added to ${n} team seat row(s) (seat links drive implementation LLM eligibility).`,
        );
      } else {
        setMsg(
          "Skill allowed for role type (no seats exist for this type yet — new seats inherit skills when created).",
        );
      }
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : "Failed");
    }
  }

  async function unlinkRtSt() {
    if (!admin) return;
    if (!window.confirm("Remove from role type catalog and strip this skill from every team seat of that type until re-added?")) {
      return;
    }
    setMsg(null);
    try {
      await api(
        `/api/v1/role-template-skills?roleTemplateId=${encodeURIComponent(linkRt)}&skillTemplateId=${encodeURIComponent(linkSt)}`,
        { method: "DELETE" }
      );
      await load();
      setMsg("Skill removed from role type.");
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : "Failed");
    }
  }

  return (
    <div data-testid="skills-models-page">
      <p className="muted page-intro">
        <strong>Organization → Roles &amp; skills</strong> — Sarva <strong>role types</strong>, <strong>skills</strong>, and
        which skills each role type may use. <strong>LLM provider connections and model bindings</strong> are configured in{" "}
        <Link to="/admin">System → Admin</Link> only.
      </p>
      {msg ? <p className="ok">{msg}</p> : null}
      {err ? <p className="err">{err}</p> : null}

      <div className="callout-card">
        <p style={{ margin: 0, fontSize: "0.88rem", lineHeight: 1.55 }}>
          Catalogs here define which skills each <strong>Sarva role type</strong> may use. When you allow a skill, it also
          creates the corresponding skill link on <strong>existing team seats</strong> of that type (implementation LLM
          eligibility reads seat links, not catalog rows alone). <strong>Seat-level</strong> fine-tuning is under{" "}
          <Link to="/organization/teams">Teams</Link>
          . <strong>Model bindings:</strong> company default, per-agent override, or <strong>per team role (seat)</strong> in{" "}
          <Link to="/admin?tab=llm">Admin → Model bindings</Link>.
        </p>
      </div>

      <CollapsibleCard
        data-testid="section-skills-role-summary"
        heading={<strong>Skills × role types (summary)</strong>}
        subtitle="expand to scan which role types allow each skill"
      >
        <table className="data-table">
          <thead>
            <tr>
              <th>Skill</th>
              <th>Used by role types</th>
            </tr>
          </thead>
          <tbody>
            {skillRollup.length === 0 ? (
              <tr>
                <td colSpan={2} className="muted">
                  No links yet{admin ? " — allow skills for role types below." : "."}
                </td>
              </tr>
            ) : (
              skillRollup.map(({ skill, roleLabels }) => (
                <tr key={skill.id}>
                  <td>
                    <strong>{skill.label}</strong> <small className="muted">({skill.code})</small>
                  </td>
                  <td>{[...roleLabels].sort().join(", ") || "—"}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </CollapsibleCard>

      {!admin ? (
        <p className="muted">Sign in as <strong>admin</strong> to edit Sarva catalogs.</p>
      ) : (
        <>
          <CollapsibleCard
            defaultExpanded
            data-testid="section-role-types-catalog"
            heading={<strong>Sarva role types</strong>}
            subtitle="templates teams use when adding seats"
          >
            <p className="muted" style={{ fontSize: "0.88rem", lineHeight: 1.55, marginTop: "0.35rem" }}>
              Sarva role types — teams add seats from these templates under <Link to="/organization/teams">Teams</Link>.
            </p>
            <table>
              <thead>
                <tr>
                  <th>Label</th>
                  <th>Code</th>
                  <th>Allowed skills</th>
                </tr>
              </thead>
              <tbody>
                {roleTemplates.map((r) => (
                  <tr key={r.id}>
                    <td>{r.label}</td>
                    <td>
                      <code>{r.code}</code>
                    </td>
                    <td>{r.allowedSkills.map((x) => x.skillTemplate.label).join(", ") || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <h3 style={{ marginTop: "1rem" }}>Add role type</h3>
            <form className="row" onSubmit={onAddRole}>
              <label>
                Code{" "}
                <input value={newRoleCode} onChange={(e) => setNewRoleCode(e.target.value)} placeholder="MY_ROLE" required />
              </label>
              <label>
                Label <input value={newRoleLabel} onChange={(e) => setNewRoleLabel(e.target.value)} required />
              </label>
              <label>
                Description <input value={newRoleDesc} onChange={(e) => setNewRoleDesc(e.target.value)} />
              </label>
              <button type="submit" className="primary">
                Add role type
              </button>
            </form>
            <h3 style={{ marginTop: "1rem" }}>Edit role type</h3>
            <form onSubmit={onEditRole}>
              <div className="row">
                <label>
                  Role
                  <select value={editRoleId} onChange={(e) => setEditRoleId(e.target.value)}>
                    <option value="">—</option>
                    {roleTemplates.map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Label <input value={editRoleLabel} onChange={(e) => setEditRoleLabel(e.target.value)} />
                </label>
              </div>
              <label>
                Description <input value={editRoleDesc} onChange={(e) => setEditRoleDesc(e.target.value)} />
              </label>
              <button type="submit" className="secondary" disabled={!editRoleId}>
                Save role type
              </button>
            </form>
          </CollapsibleCard>

          <CollapsibleCard
            defaultExpanded
            data-testid="section-skills-catalog"
            heading={<strong>Skills catalog</strong>}
            subtitle="expand to browse prompts, add skills, or edit labels and overrides"
          >
            <p className="muted" style={{ fontSize: "0.88rem", lineHeight: 1.55, marginTop: "0.35rem" }}>
              Agent prompts for Sarva built-in skills are loaded from the API defaults (see{" "}
              <code className="mono">apps/api/src/prompt/skills/</code> per skill, merged in{" "}
              <code className="mono">defaultSkillPrompts.ts</code>) when you leave override empty on add or revert on edit.
              For <strong>new</strong> catalog entries: set machine <strong>code</strong>, a readable <strong>display name</strong>, and{" "}
              a short intent blurb — then{" "}
              <strong>Draft label &amp; prompt with company AI</strong> to refine the title and agent instructions using your{" "}
              <Link to="/admin?tab=llm">company default LLM binding</Link>. Edit anything before saving.
            </p>
            <table>
              <thead>
                <tr>
                  <th>Label</th>
                  <th>Code</th>
                  <th>Agent prompt (excerpt)</th>
                </tr>
              </thead>
              <tbody>
                {skillTemplates.map((s) => (
                  <tr key={s.id}>
                    <td>{s.label}</td>
                    <td>
                      <code>{s.code}</code>
                    </td>
                    <td style={{ maxWidth: "28rem", fontSize: "0.85rem" }}>
                      {s.agentPrompt.slice(0, 160)}
                      {s.agentPrompt.length > 160 ? "…" : ""}
                      {!s.agentPromptOverride ?
                        <small className="muted"> (built-in)</small>
                      : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <h3 style={{ marginTop: "1rem" }}>Add skill</h3>
            <form onSubmit={onAddSkill}>
              <div className="row">
                <label>
                  Code (machine id — use letters, numbers, underscores)
                  <input
                    value={newSkillCode}
                    onChange={(e) => setNewSkillCode(e.target.value)}
                    pattern="^[a-zA-Z0-9_]+$"
                    title="Letters, digits, underscores only."
                    placeholder="RELEASE_NOTES_HELPER"
                    required
                  />
                </label>
                <label>
                  Display label (readable name shown in catalogs and UI)
                  <input
                    value={newSkillLabel}
                    onChange={(e) => setNewSkillLabel(e.target.value)}
                    placeholder={`e.g. ${humanizeSkillCode(newSkillCode) || "Release notes assistant"}`}
                  />
                </label>
              </div>
              <label>
                Short description (purpose for seats and AI draft — plain language)
                <textarea
                  value={newSkillDesc}
                  onChange={(e) => setNewSkillDesc(e.target.value)}
                  placeholder="What should seat agents accomplish with this skill? One or two sentences is enough."
                  rows={4}
                  required
                  style={{ maxWidth: "42rem", width: "100%" }}
                />
              </label>
              <div className="row" style={{ alignItems: "flex-start", flexWrap: "wrap", gap: "0.65rem" }}>
                <button
                  type="button"
                  className="secondary"
                  disabled={
                    skillDraftGenerating ||
                    !newSkillCode.trim() ||
                    !/^([a-zA-Z0-9_]+)$/.test(newSkillCode.trim()) ||
                    !newSkillDesc.trim()
                  }
                  onClick={() => void onGenerateSkillDraft()}
                  data-testid="skill-draft-generate"
                >
                  {skillDraftGenerating ? "Calling company model…" : "Draft label & prompt with company AI"}
                </button>
                <p className="muted" style={{ fontSize: "0.82rem", margin: 0, maxWidth: "28rem", lineHeight: 1.5 }}>
                  Fills <strong>Display label</strong> and <strong>Agent prompt</strong> from the description above via your{" "}
                  <Link to="/admin?tab=llm">company default binding</Link>
                  . Override either field afterward.
                </p>
              </div>
              <label>
                Agent prompt (leave blank after draft only when a built-in default applies — uncommon for custom codes)
                <textarea value={newSkillPrompt} onChange={(e) => setNewSkillPrompt(e.target.value)} rows={6} />
              </label>
              <button type="submit" className="primary">
                Add skill
              </button>
            </form>
            <h3 style={{ marginTop: "1rem" }}>Edit skill</h3>
            <form onSubmit={onEditSkill}>
              <label>
                Skill
                <select value={editSkillId} onChange={(e) => setEditSkillId(e.target.value)}>
                  <option value="">—</option>
                  {skillTemplates.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.label}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Label <input value={editSkillLabel} onChange={(e) => setEditSkillLabel(e.target.value)} />
              </label>
              <label>
                Agent prompt
                <textarea value={editSkillPrompt} onChange={(e) => setEditSkillPrompt(e.target.value)} rows={5} />
              </label>
              {editSkillSelected && !editSkillSelected.agentPromptOverride ? (
                <p className="muted" style={{ fontSize: "0.82rem", margin: "0.25rem 0 0" }}>
                  Showing built-in default. Edit and save to override; save with text exactly matching default, or clear field,
                  to use built-in from code.
                </p>
              ) : null}
              <button type="submit" className="secondary" disabled={!editSkillId}>
                Save skill
              </button>
            </form>
          </CollapsibleCard>

          <div className="card">
            <h2>Role → Skill binding</h2>
            <p className="muted">Controls which skills appear for seats of each role type.</p>
            <form
              className="row"
              onSubmit={onLinkRtSt}
              style={{ flexWrap: "wrap", alignItems: "flex-end", gap: "0.5rem" }}
            >
              <label>
                Role type
                <select value={linkRt} onChange={(e) => setLinkRt(e.target.value)}>
                  {roleTemplates.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.label}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Skill
                <select value={linkSt} onChange={(e) => setLinkSt(e.target.value)}>
                  {skillTemplates.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.label}
                    </option>
                  ))}
                </select>
              </label>
              <button type="submit" className="secondary">
                Allow skill for role
              </button>
              <button type="button" className="secondary" onClick={() => void unlinkRtSt()}>
                Remove skill from role type
              </button>
            </form>
          </div>
        </>
      )}
    </div>
  );
}
