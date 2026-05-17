# Sarva — Requirements (canonical)

**Version:** 0.5.1 (carried forward from legacy FRD v0.5.x)  
**File:** [`Requirement/SARVA-REQUIREMENTS.md`](SARVA-REQUIREMENTS.md) (this document)  
**Status:** Draft — baseline for design and implementation  
**Product codename:** Sarva (Autonomous Enterprise OS)  
**Design companion:** [`SARVA-DESIGN.md`](SARVA-DESIGN.md) — consolidated architecture, LLD, and TSD.

**Related:** Optional legacy **Word** MRD may exist only as a local **`Requirement/*.docx`** (not shipped); **phased R1 / agent-delivery** scope is normative in **this file** and **[`SARVA-DESIGN.md`](SARVA-DESIGN.md)**. Older split-doc copies may live under a **gitignored** **`Requirement/archive/`** tree. Cursor planning artifacts may live under `~/.cursor/plans/` (not always in-repo).

---

## 1. Purpose and audience

This document specifies **what** Sarva v0.1 must deliver: a **human-operated control plane** for defining AI-native organizations, running **Projects** and **Tasks** through **agents** with **tiered governance**, **full auditability**, **cost controls**, and **mediated outbound email**.

**Primary audience:** Product, UX, engineering, security/compliance reviewers.  
**Out of scope here:** Detailed API schemas, UI mockups, infrastructure runbooks (covered in design and technical specs).

---

## 2. Vision and product goal

Sarva enables a **founder, CEO, and partners** (when the org structure includes them) to **build and run a company** where **agents** fulfill **Roles**, **Skills** drive execution and **model routing**, and **Projects** run under **Scrum** with a **per-project Program Manager (PM) agent** as orchestrator—while **humans** retain control through **approvals**, **budgets**, and **audit trails**.

**One-sentence goal:** Sarva is a human-operated control plane to define an AI-native organization (Business Units, teams, roles, skills, model routing), run projects and Tasks through agents with tiered approvals and full auditability, and operate continuously with cost and policy guardrails—including a dedicated Email Agent for outbound email.

---

## 3. Scope

### 3.1 In scope (v0.1 “full-vision thin slice”)

- **Tenant / company** creation and configuration; **Business Units (BU)**; **teams** with hierarchy and charter.
- **Workflow:** **Roles assigned to teams** → **Skills attached to roles** → **model binding** (per role and/or per skill) → agent assignment to roles.
- **Prebuilt** and **custom** **Roles** and **Skills**; **Admin** flows to create, edit, clone, disable catalog entries and bindings.
- **Projects** with **Scrum** (product backlog, **sprints**, **sprint planning**, **standups**, sprint board); **project lifecycle** views.
- **Team ↔ Project** is **many-to-many** (incl. DevOps / multi-project teams); Tasks always identify **project** (and sprint when applicable).
- **Per-project PM / TPM agent** as **project orchestrator**; **system orchestrator** for platform routing and approvals integration.
- **Escalation:** stuck agent → PM → escalate up; **cross-team** via Director peer coordination, peer PM, and/or **approval workflow**.
- **Dashboard / control plane:** roll-ups at company, BU, team, individual; project views; **approvals inbox**; **task** review and traceability.
- **Email Agent:** no direct agent send; **rules and guardrails**; audit every send.
- **MCP gateway** for external tools (Jira, **GitHub**, etc.) with a defined **real vs stub** matrix for v0.1; **execution adapters** for agent runs (see **§9.17**); **project-scoped code repositories**, **folder/repo layout**, and **CI/CD visibility** (see **§9.18**).
- **Document / knowledge repositories** (see §9.13): connect **local**, **cloud**, and/or **Git-based** (e.g. GitHub) repos so agents (e.g. **Product Manager**) can **retrieve org templates and context** when authoring requirements; **gated approvals** (Director PM → CEO → engineering handoff) per policy.
- **Document templates library** (see §9.14): default **FRD, BRD, HLD, LLD** (and extensible) templates; referencable when creating governed documents; **starter files** in-repo under **`Requirement/templates/`**.
- **Budgets** (company, per-agent); **heartbeats** / schedules for agent activity; **immutable audit** for approvals, tool use, email, key state changes.
- **Chat** + **onboarding wizard**; **mandatory user journeys** (see §8); **tiered paths**, **org/industry templates**, and **readiness gates** per §8.6 and SARVA-FR-018/019/022/112/113.
- **Mobile-ready** UX expectation as NFR for monitoring and approvals (responsive web at minimum).

**R1 delivery tranche (implementation):** The first engineering release (**Sarva R1 — Agent project delivery**) **narrows** the bullets above versus the full vision — notably **Sarva-managed role and skill templates** with per-team **seat** counts (vs full tenant **custom** catalog CRUD for new role/skill **types**), while preserving the **same journey**: BU → team → roles/skills → model bindings → agents → project → PM-orchestrated backlog → tasks. Technical detail: **[`SARVA-DESIGN.md`](SARVA-DESIGN.md) Part II** — **§3.1.0**.

### 3.2 Explicitly out of scope or phase 2 (unless later change control)

- **Multi-company portfolio** in one deployment (may be phase 2; **decision pending** — see §15).
- **Full BYOA** (any runtime) beyond configured providers — may be **stub** in v0.1 (**decision pending**; **SARVA-FR-142–143** define required **adapter** surface; see **§9.17**).
- **Velocity analytics, burndown, WIP limits** — **recommended phase 2** for Sarva v0.1: they add reporting complexity and are not required to run **sprints, boards, and Tasks**. Pull into v0.1 only if executive/stakeholder reporting is a **launch blocker**.
- **Epics** (hierarchical grouping of Tasks) — **optional for v0.1**: include if large projects need parent/child work breakdown **before** design; otherwise **phase 2** when portfolio reporting matures.
- **Kanban** as first-class alternate methodology — **optional** for v0.1; **Scrum is primary**.
- **Desktop native app** — not required for v0.1.

### 3.3 Product non-goals (positioning)

- Sarva is **not** a general-purpose **team chat** or Slack-style messaging product; **chat** exists to accelerate **governance and delivery** tied to the **work graph** (Projects, Tasks, Approvals).
- Sarva is **not** positioned as a **full replacement** for Jira, GitHub Projects, or enterprise ITSM; **integrations** (e.g. MCP) connect to those systems where needed.
- Sarva **does not** require every tenant to adopt **strategic goals**; when goals are disabled, **Project and Sprint** context suffices for v0.1 (see **SARVA-FR-136**).

---

## 4. Definitions and glossary

| Term | Definition |
|------|------------|
| **Business Unit (BU)** | Structural partition of the company (e.g. Tech, Sales, Marketing, HR). Canonical UI/spec term. |
| **Team** | Group with charter/mission under a BU; has internal hierarchy. **Roles are assigned to the team.** **M:N** with **Projects**. |
| **Role** | Org position (e.g. Software Engineer, Program Manager). Prebuilt library + custom. **Skills attach to Roles.** |
| **Skill** | Executable capability (e.g. coder, code reviewer, technical writer). **Not** interchangeable with Role. |
| **Agent** | Runtime assigned to fulfill a Role (and optionally human operators for partners). |
| **Task** | Atomic unit of work; tracked on backlog/sprint/board. **“Issue”** is not used in Sarva-facing copy. |
| **Project** | Scoped effort; **M:N** with teams; **Scrum** by default; has **per-project PM orchestrator** agent. |
| **Sprint** | Time-boxed iteration with goal; contains a subset of backlog Tasks. |
| **Orchestrator (system)** | **Platform layer** (infrastructure): task queues, message routing between services/agents, **enforcing approval gates** before high-risk or state-changing actions, audit hooks. **Not** a person-like role—it is the **runtime backbone** of Sarva. |
| **Orchestrator (project)** / **PM orchestrator** | **Per-project** **agent** (typically PM/TPM **Role**): **facilitates Scrum rituals**, coordinates **team communication**, **first responder** when IC agents are stuck, **escalates** per org policy. **Is** a **named agent** in the org chart for that project. |
| **Model binding** | LLM choice per **Role** (default) and/or **Skill** (override). **Precedence:** Skill > Role > company default. |
| **Email Agent** | Sole component authorized to **send** outbound email after policy check. |
| **Document repository (connection)** | Registered **source of truth** for files (templates, playbooks, ADRs): **local path**, **cloud storage**, or **Git remote** (e.g. GitHub). Access is **scoped** and **audited**; content is used for **retrieval** and **context** when agents produce deliverables (e.g. requirements). |
| **Document template** | A **structured outline** (sections, guidance) for a deliverable type (FRD, BRD, HLD, LLD, …). **Default templates** ship with the platform; **tenants** may customize. |
| **Execution adapter** | Pluggable connector that **invokes** or **schedules** an **agent run** per policy (**SARVA-FR-142–143**), aligned with **§9.15**; **TSD** defines categories (e.g. process, HTTP) and configuration. |
| **Host plugin** (deferred) | Third-party extension to the Sarva **application host** (beyond **MCP** and execution adapters). **Out of scope for v0.1** unless **change control** (**SARVA-FR-144**). |
| **Repository association mode** | How a **Project** links to **version-controlled code**: e.g. **dedicated repo or folder per project**, **multiple projects on one shared repo** (monorepo), or **one project spanning multiple repos** (**SARVA-FR-149**). |
| **Project technical context** | **Retrievable** bundle for a **Project** (requirements pointers, repo scope, indexes, optional brief) so **assigned agents** share aligned scope (**SARVA-FR-146**). |

**How they differ (system vs project orchestrator):** The **system orchestrator** is **always-on platform logic** (queues, approval gates, audit hooks). The **PM orchestrator** is a **project-scoped agent** (delivery lead). The PM agent **uses** the platform—including the system orchestrator—to route work and trigger approvals; neither replaces the other.

---

## 5. Personas

| Persona | Needs |
|---------|--------|
| **Founder / CEO** | Define strategy, org, policies; approve high-risk actions; dashboard and chat. |
| **Partner / operator** | Same or scoped permissions per **RBAC**; may approve per tier. |
| **Admin / config owner** | Maintain roles, skills, model bindings; integrations; **execution adapters**; **project repo association** and **CI/CD** links (**§9.18**); guardrails. |
| **Program Manager agent** | Per-project facilitation, standups/planning, unblock/escalate. |
| **Director / lead PM** (human or agent) | Review requirements/PRDs per approval matrix; may map to a **Role** in the org chart. |
| **IC agents** (e.g. coder) | Execute Tasks within Skills; escalate when stuck. |

---

## 6. Assumptions and dependencies

- **LLM providers** (cloud APIs and/or **local Ollama**) are configured with **secrets** stored per environment (design detail).
- **MCP servers** may be optional per integration; v0.1 may **stub** some connectors.
- **Human operators** authenticate via mechanism **TBD** (email invite, SSO — see §15).

---

## 7. Information architecture (logical)

```
Company
  └── Business Unit
        └── Team  ←──┐
              └── Role (on team) ── Skills (on role) ── Model bindings
              └── Agent assignment per Role
        └── Project  ←──┘ (M:N Team ↔ Project)
              └── Project Orchestrator (PM agent)
              └── **Delivery scope** (repos / folders / CI) — **SARVA-FR-147–150**
              └── Backlog / Sprint / Board
              └── Task
```

**Goals / strategic initiatives** (optional): at company or BU scope, may **link** to **Projects** and/or **Tasks** when enabled by policy (**SARVA-FR-136**). When disabled, alignment is through **Project**, **Sprint**, and templates alone.

---

## 8. User journeys (mandatory acceptance targets)

### 8.1 Greenfield tenant (happy path)

| Step | Actor | Action | Acceptance criteria |
|------|--------|--------|---------------------|
| 1 | Human | Create company | Company record exists; user is owner/admin. |
| 2 | Human | Define BUs | At least one BU; names editable. |
| 3 | Human | Create team + charter | Team under BU; hierarchy captured. |
| 4 | Human | **Assign Roles to team** | Roles visible on team; seats defined. |
| 5 | Human | **Attach Skills to each Role** | Skills list per role; can enable/disable. |
| 6 | Human | Bind **models** to Role and/or Skill | Precedence visible; test invocation uses resolved model. |
| 7 | Human | Assign agents to roles | Agent status visible (idle/active/error). |
| 8 | Human | Create **Project**; link **team(s)** M:N | Project shows linked teams. |
| 9 | System/Human | Assign **PM orchestrator** to project | PM agent can facilitate rituals. |
| 10 | PM agent / Human | **Sprint planning** | Tasks in sprint backlog; sprint goal set. |
| 11 | PM agent | **Standup** (scheduled) | Occurrence logged; blockers surfaced. |
| 12 | Agents | Execute **Tasks** on board | Status transitions; audit entries. |
| 13 | IC agent | **Stuck** → PM | PM attempts resolution per §9.5. |
| 14 | PM / Human | Escalation or cross-team | Follows §10; approvals if required. |
| 15 | Human | **Dashboard** | Roll-ups at company/BU/team/individual; project health. |

### 8.2 Day-2 administration

| Step | Action | Acceptance criteria |
|------|--------|---------------------|
| 1 | Open Admin | Roles and Skills manageable without full wizard replay. |
| 2 | Edit Skill / Role | Changes audited; bindings validated. |
| 3 | Change model on Skill | New Tasks of that skill type use new model (per precedence). |

### 8.3 Multi-project team (DevOps-style)

| Step | Action | Acceptance criteria |
|------|--------|---------------------|
| 1 | Assign one team to multiple projects | Each project has distinct backlog/sprint context. |
| 2 | Create Tasks | Each Task shows **project** (and sprint). |
| 3 | PM per project | Each project has its own **project orchestrator** agent. |

### 8.4 Partner / multi-human

| Step | Action | Acceptance criteria |
|------|--------|---------------------|
| 1 | Invite partner | Partner account with role-scoped permissions. |
| 2 | Approve | Partner can approve only per **RBAC** tier. |

### 8.5 Requirements authoring with document repository and approvals (example: Project A)

**Goal:** A **Product Manager agent** (or human PM) produces **requirements** using **guidance from connected repositories**; output passes **human/agent review** per tier before **technical design**.

| Step | Actor | Action | Acceptance criteria |
|------|--------|--------|---------------------|
| 1 | Admin / PM | Register **document repository** (local, cloud, or GitHub/Git) for the company or project | Connection stored; credentials/secrets handled per NFR; access scoped. |
| 2 | System | **Index / understand** repository structure (folders, templates, key docs) within policy | PM agent can query or retrieve relevant snippets (implementation: RAG, MCP, or file API — **design**). |
| 3 | PM agent | For **Project A**, draft **requirements** using **Skills** (e.g. PRD/requirements) + **repo context** + optional **document template** (FRD/BRD/HLD/LLD per deliverable) | Draft references **templates** (§9.14) and repo patterns where applicable; stored as Task artifact or linked document. |
| 4 | Director PM (agent/human) | **Review** draft | Review recorded; approve, request changes, or reject per workflow. |
| 5 | CEO (human, policy) | **Final approval** on gated releases | Approval row in matrix; audit trail. |
| 6 | PM / system | **Hand off** to **technical team** (design Tasks created/assigned) | Downstream Tasks visible on board; dependencies clear. |

*Role titles (Director PM, CEO) map to your **org Roles** and **tiers**; configurable in RBAC.*

### 8.6 Onboarding workflow refinements (normative)

These rules refine **how** §8.1 is presented in product UX without changing the underlying data model (Company → BU → Team → Role → Skill → model → agent → project).

1. **Single binding pattern (Role ↔ Skill)**  
   **Attach/detach Skills to Roles** shall use the **same interaction model** in the first-run wizard and in **Admin / organization catalog** (see SARVA-FR-019). The **Skills & models** area may show a **read-only roll-up** (“used by roles”) and **deep-link** into the same editor; it must not be a conflicting second source of truth.

2. **Org / industry templates**  
   Operators may **start from a template** (e.g. industry or “AI-native SaaS”) that **pre-seeds** BUs, teams, role sets, and **default Skill bundles per Role** from the prebuilt library. All seeded data remains **editable** after apply (see SARVA-FR-018).

3. **Tiered onboarding paths**  
   The wizard shall support at least **Minimal**, **Standard**, and **Full** (see SARVA-FR-112). **Deferred** steps must be **explicitly labeled** and completable from Settings later.

   | Path | Primary goal in wizard | Typically in-wizard | Typically deferred to Settings (labeled) |
   |------|------------------------|---------------------|------------------------------------------|
   | **Minimal** | Fastest path to **first Project** + **first sprint** with **Tasks** | Company, BUs, teams, roles, **Role–Skill** bindings, model bindings, agents, project + team links, PM orchestrator, first sprint | **Document repositories**, **Email Agent** rules, **partner invites**, non-essential **integrations** |
   | **Standard** | Full **§8.1** through **first sprint** (same core org/skills/agents/project chain as Minimal) | Everything in **Minimal**, plus optional **partner invite + RBAC preview** (skippable step) | Repos, email rules, integrations (unless later pulled into Standard) |
   | **Full** | **Standard** scope plus **governance adjacent** setup in-flow | **Standard** items **plus** **document repository** connection, **Email Agent** rules (preview/setup), and **partner + RBAC** as first-class wizard screens | Only capabilities explicitly **out of v0.1** product scope |

   *All three paths share the same **readiness gates** (§8.6 point 4) and **unified Role–Skill binding** (§8.6 point 1); tiers differ in **what is asked during** onboarding vs **after**.*

   **Success target (UX):** the **Minimal** path should reach **first Task in progress** on a sprint board within **~5 minutes** in ideal conditions (validate in research; same order-of-magnitude intent as “time-to-first-success” for control-plane products).

4. **Readiness gates (policy-configurable)**  
   Before **activating an agent** on a role seat and before **starting a sprint** (or equivalent time-box), the system shall **validate** that **Skills are attached** to that Role (where required by policy) and that **model binding** resolves (Skill → Role → company default). Behavior when validation fails: **block**, **warn**, or **allow with recorded waiver** — **configurable** per tenant or role class (see SARVA-FR-022).

5. **Partners and RBAC preview**  
   Optional wizard step(s) shall allow **inviting human partners** and showing an **RBAC preview** (what they can approve or edit) before go-live, aligned with §8.4 (see SARVA-FR-113).

### 8.7 Product backlog, technical context, and delivery (normative)

| Step | Actor | Action | Acceptance criteria |
|------|--------|--------|---------------------|
| 1 | Human / PM agent | Provide **requirements** (text, artifacts, and/or **document repository** access) for a **Project** | Inputs are **scoped** to the Project and **audited** where governed (**SARVA-FR-120–124**). |
| 2 | **PM orchestrator** | **Propose or refine product backlog** (**Tasks**) from requirements and repos | **SARVA-FR-145**; proposed items are visible on the **product backlog** before sprint commitment. |
| 3 | Human / policy | **Review** backlog proposals | Adjust, split, or defer items per governance. |
| 4 | System / Admin | Configure **project technical context** and **repository association mode** | **SARVA-FR-146**, **SARVA-FR-148–149**; mode is **explicit** (dedicated folder/repo per project, **shared repo** across projects, or **multi-repo** project). |
| 5 | **Engineering agents** | Execute work with **shared awareness** of linked codebases and CI | Context available per **SARVA-FR-146** and **§9.18**; MCP/Git integration per **SARVA-FR-147**, **SARVA-FR-150**. |

---

## 9. Functional requirements

Subsections are ordered **9.1–9.18** for navigation: company/dashboard → org/skills → admin → projects → PM orchestrator → system orchestrator → governance → email → MCP → cost → audit → onboarding/chat → **document repositories** → **document templates** → **agent invocation** → **engineering traceability** → **execution adapters and extensibility** → **project repositories and delivery integration**.

### 9.1 Company, BU, and dashboard

| ID | Requirement |
|----|----------------|
| **SARVA-FR-001** | The system shall allow creating, editing, and archiving a **Company** profile within a tenant. |
| **SARVA-FR-002** | The system shall support **Business Units** under a company with name, description, and ordering. |
| **SARVA-FR-003** | The system shall provide a **dashboard** with roll-up metrics at **company, BU, team, and individual** levels (Tasks by status, blockers, stale work, cost vs budget where applicable). |
| **SARVA-FR-004** | The system shall provide **project-level** and **team portfolio** views for operators managing **M:N** team–project assignments. |
| **SARVA-FR-137** | **Tenant configuration portability** (import/export of org configuration and references to governed documents) defaults to **phase 2** unless promoted by §15; v0.1 may ship **export-only** or **none** — record the decision in **release notes** and **Appendix B**. |

### 9.2 Teams, roles, skills, and model binding

| ID | Requirement |
|----|----------------|
| **SARVA-FR-010** | The system shall allow creating **Teams** under a BU with **charter/mission** and **reporting hierarchy** as configured. |
| **SARVA-FR-011** | The system shall support **assigning Roles to a Team** (which positions exist on that team). |
| **SARVA-FR-012** | The system shall support **attaching one or more Skills to each Role**; Skills are not attached directly to teams in the primary workflow. |
| **SARVA-FR-013** | The system shall provide a **prebuilt Role library** (incl. leadership and IC tracks; **Program Manager / TPM** as project orchestrator option) with **default Skill bundles** editable after selection. |
| **SARVA-FR-014** | The system shall provide a **prebuilt Skill library** (see Appendix A) and allow **custom Skills** (name, description, governance hints). |
| **SARVA-FR-015** | The system shall support **model binding** at **Role** (default) and **Skill** (override) with **precedence:** Skill > Role > company default. |
| **SARVA-FR-016** | The system shall support **cloud LLM APIs** and **local models** (e.g. Ollama) where policy allows. |
| **SARVA-FR-017** | The system shall **audit** changes to Role, Skill, and model bindings (who/when/what). |
| **SARVA-FR-018** | The system shall support **org / industry templates** that **pre-populate** Business Units, teams, Role selections, and **default Skill bundles per Role** from the prebuilt libraries; the operator shall **review and edit** all seeded data after apply. |
| **SARVA-FR-019** | The system shall provide a **unified Role–Skill binding experience**: the same attach/detach semantics and primary UI pattern in the **first-run wizard** and in **Admin** (organization catalog). Summaries elsewhere (e.g. Skills & models) shall **not** define a separate binding mechanism. |

### 9.3 Administration

| ID | Requirement |
|----|----------------|
| **SARVA-FR-020** | The system shall provide an **Admin** (or Settings → Organization) area to **CRUD Roles and Skills** and to **attach/detach Skills to Roles** outside the first-run wizard. |
| **SARVA-FR-021** | The system shall enforce **RBAC** so only authorized operators can edit catalogs and model bindings (configurable tiers). |
| **SARVA-FR-022** | The system shall enforce **readiness gates** (policy-configurable): before **agent activation** on a role and before **starting a sprint**, validate **required Skills on Role** and **resolvable model binding**; on failure, **block**, **warn**, or **allow with waiver** per tenant policy, with **audit** of waivers. |

### 9.4 Projects, Scrum, and tasks

| ID | Requirement |
|----|----------------|
| **SARVA-FR-030** | The system shall support **Projects** with lifecycle states (e.g. Planned, Active, Complete). |
| **SARVA-FR-031** | The system shall support **M:N** association between **Teams** and **Projects**. |
| **SARVA-FR-032** | The system shall implement **Scrum** as the **primary** methodology: **product backlog**, **sprints** (name, dates, **sprint goal**), **sprint backlog**, **sprint board**. |
| **SARVA-FR-033** | The system shall support **sprint planning** (move/prioritize Tasks into sprint) with **PM orchestrator** facilitation. |
| **SARVA-FR-034** | The system shall support **scheduled standups** (cadence configurable) tied to project/PM agent and **heartbeats** or triggers. |
| **SARVA-FR-035** | The system shall represent **Tasks** on backlog and sprint board with filters by project, team, assignee, Skill, priority, sprint, status. |
| **SARVA-FR-036** | **Sprint review** and **retrospective** rituals: **phase 2 by default** unless explicitly included in v0.1 release scope. |
| **SARVA-FR-037** | **Kanban** project type is **optional**; not required for v0.1 minimum if Scrum covers primary use cases. |
| **SARVA-FR-131** | Each **Task** shall have at most **one active assignee** at a time for **in-progress execution** (v0.1 assumes **single assignee** unless a future revision defines multi-assignee). |
| **SARVA-FR-132** | Transition of a Task to **in progress** (or equivalent executing state) shall use **atomic claim** semantics: two agents/operators cannot successfully claim the same Task concurrently; the **losing** claim shall **fail safely** with a **visible conflict** (API/protocol detail in TSD; compare **atomic checkout** patterns). |
| **SARVA-FR-133** | **Comments** on **Tasks** shall be supported for collaboration, handoffs, and **audit-visible** discussion. |
| **SARVA-FR-134** | **Chat** ([SARVA-FR-110]) shall support **binding or deep-linking** to **Company**, **Project**, **Task**, and **Approval** context so conversation does not replace the authoritative work graph. |
| **SARVA-FR-135** | **Tasks** and **governed requirement/design artifacts** shall support **attachments** or **file references** with metadata; access **RBAC-scoped** and **audited**; storage implementation is **NFR / TSD**. |
| **SARVA-FR-136** | The system shall support **optional** company- or BU-level **goals or strategic initiatives** with **optional linkage** from Projects and/or Tasks when enabled by policy. When disabled, **Project and Sprint** context suffices for v0.1. |

### 9.5 Project orchestrator and collaboration

| ID | Requirement |
|----|----------------|
| **SARVA-FR-040** | Each **Project** shall have exactly one designated **project orchestrator** agent (PM/TPM or configured equivalent). |
| **SARVA-FR-041** | The PM orchestrator shall **facilitate** sprint planning and standups per project policy. |
| **SARVA-FR-042** | The PM orchestrator shall **enable communication** among project agents (mechanism is design-dependent). |
| **SARVA-FR-043** | When an agent is **stuck**, escalation shall default to **PM orchestrator** first; PM may resolve, **escalate upward** (manager/Director/CEO per tier), or initiate **cross-team** coordination per §10. |
| **SARVA-FR-044** | **Internal messaging** between agents shall be supported for handoffs and Q&A. |
| **SARVA-FR-045** | For a team assigned to **multiple projects**, each **project** shall retain its own **PM orchestrator** and **backlog/sprint** context. |
| **SARVA-FR-145** | The **PM orchestrator** shall **facilitate creation and refinement of the product backlog** (**Tasks**) from **requirements inputs** (including **governed text**, **artifacts**, and **document repository** context per **§9.13**) and shall support **proposing backlog items** for **human or policy review** before **sprint planning** commits work (**SARVA-FR-033**). |
| **SARVA-FR-146** | Each **Project** shall maintain **project technical context**—**retrievable** information (e.g. links to requirements, **repository scope** per **SARVA-FR-148–149**, optional **project brief** or index) so **agents assigned to that project** operate with a **consistent** understanding of scope; implementation may use **indexing**, **RAG**, **MCP**, or file APIs (**TSD**). |

### 9.6 System orchestrator

| ID | Requirement |
|----|----------------|
| **SARVA-FR-050** | The platform shall provide a **system orchestrator** (platform layer) responsible for **task queues**, **message routing** between components/agents, and **enforcement of approval gates** before state-changing or high-risk actions. It is **distinct** from the **per-project PM orchestrator** agent (see §4, §9.5). |

### 9.7 Governance and approvals

| ID | Requirement |
|----|----------------|
| **SARVA-FR-060** | The system shall implement **tiered RBAC** (e.g. CEO, Director/SDM, IC agents) with configurable permissions. |
| **SARVA-FR-061** | Actions that **modify company state**, run **high-risk** operations, or perform **governed communications** shall enter **pending approval** when policy requires. |
| **SARVA-FR-062** | **Creative** agents may **propose** strategies; **execution** of consequential actions requires approval per policy. |
| **SARVA-FR-063** | Operators shall have an **approvals inbox** with approve, reject, and request-revision flows. |

**Approval matrix (baseline — refine per deployment):**

| Action category | Typical approver | Notes |
|-----------------|------------------|--------|
| Major strategy / pivot | CEO / board policy | Configurable |
| Budget, hiring, large spend | CEO / partner per tier | |
| Operational / merge / release | Director / SDM per policy | |
| Outbound email (actual send) | Email Agent + **human-approved rules** | No direct agent send |
| Cross-team dependency (high risk) | Director coordination **or** approval workflow | Order **TBD** — see §15 |
| **Requirements / PRD** (gated release) | Director PM **review** → **CEO** final (if policy) → engineering handoff | See §8.5, SARVA-FR-123 |

### 9.8 Email Agent

| ID | Requirement |
|----|----------------|
| **SARVA-FR-070** | No agent shall send email **directly** to external recipients. |
| **SARVA-FR-071** | Agents shall submit **send requests** (payload, audience, intent) to the **Email Agent**. |
| **SARVA-FR-072** | The Email Agent shall **compose**, **validate against approved rules/guardrails**, and **send**; all sends shall be **audited**. |
| **SARVA-FR-073** | Policy ownership may be **CEO** or **delegated partner** per configuration. |

### 9.9 Integrations (MCP)

| ID | Requirement |
|----|----------------|
| **SARVA-FR-080** | The system shall provide an **MCP gateway** to register and invoke external tool servers (e.g. Jira, GitHub). |
| **SARVA-FR-081** | The v0.1 release shall document which integrations are **live** vs **stub** (see Appendix B). |

### 9.10 Cost and budgets

| ID | Requirement |
|----|----------------|
| **SARVA-FR-090** | The system shall track **cost events** (tokens/spend) attributable to agents and projects. |
| **SARVA-FR-091** | The system shall support **monthly budgets** at **company** and **per-agent** levels; **enforce pause/stop** at limit per policy. |
| **SARVA-FR-092** | The dashboard shall show **spend vs budget**. |

### 9.11 Audit and traceability

| ID | Requirement |
|----|----------------|
| **SARVA-FR-100** | The system shall maintain an **append-only / immutable** audit trail for approvals, agent decisions material to governance, tool invocations (as configured), Email Agent sends, **Role/Skill/catalog and model-binding** changes, **document template** create/update/version events (see SARVA-FR-128), and **project repository association** / **delivery integration** configuration changes (**SARVA-FR-148–150**). |
| **SARVA-FR-101** | Operators shall be able to **trace** a Task to relevant decisions and tool use for accountability. |

### 9.12 Onboarding and chat

| ID | Requirement |
|----|----------------|
| **SARVA-FR-110** | The system shall provide **chat** for strategic and operational commands. |
| **SARVA-FR-111** | The system shall provide a **wizard** for first-time setup following the order in §8.1, subject to **tiered paths** and **deferred optional steps** in §8.6. |
| **SARVA-FR-112** | The system shall support **tiered onboarding** (e.g. Minimal, Standard, Full) such that **non-blocking** items (e.g. document repositories, Email Agent rules, some integrations) may be **deferred** and completed later from Settings; the UI shall **label** deferred items clearly. |
| **SARVA-FR-113** | The system shall optionally support **partner invitations** and an **RBAC preview** during or immediately after onboarding, consistent with §8.4. |

### 9.13 Document repositories and requirements workflow

| ID | Requirement |
|----|----------------|
| **SARVA-FR-120** | The system shall allow **registering one or more document repositories** per **company** and/or **project**, including **local** paths, **cloud** document stores (provider TBD in design), and **Git-based** remotes (e.g. **GitHub**). |
| **SARVA-FR-121** | The system shall, when access is granted, **ingest or query** repository content for **organizational context**: templates, glossaries, architecture notes, and other approved guidance (exact mechanism **RAG/MCP/files** — design). |
| **SARVA-FR-122** | Agents with appropriate **Skills** (e.g. Product Manager authoring **requirements**) shall be able to **use connected repository context** when producing or revising **requirement** deliverables linked to a **Project** (e.g. Project A). |
| **SARVA-FR-123** | The system shall support a **review and approval** workflow for such deliverables: at minimum **Director-level product review** → **CEO final approval** (when policy requires) → **handoff** to **technical/design** Tasks for the engineering team. Approvers may be **human** or **agent** per **Role** mapping. |
| **SARVA-FR-124** | All repository access and use in generated artifacts shall be **audited** (which repo, which scope, optional citation metadata). |
| **SARVA-FR-125** | Repository connections shall respect **RBAC** and **secrets** management (NFR); read-only vs read-write **TBD** per integration. |

### 9.14 Document templates library (FRD, BRD, HLD, LLD, etc.)

| ID | Requirement |
|----|----------------|
| **SARVA-FR-126** | The system shall provide a **templates folder** (or equivalent logical store) containing **default document templates** for standard deliverables, including at minimum: **FRD**, **BRD**, **HLD**, **LLD**, and extensible types (e.g. PRD, architecture decision record). |
| **SARVA-FR-127** | Operators and agents shall be able to **select a template** when creating a new governed document so structure and required sections are **pre-filled** per org standards. |
| **SARVA-FR-128** | **Tenant administrators** shall be able to **override**, **add**, or **version** templates (subject to RBAC); changes shall be **audited**. |
| **SARVA-FR-129** | **Connected document repositories** (§9.13) may **mirror** or **extend** the default template folder; the system shall prefer **tenant-specific** templates when configured, else **platform defaults**. |
| **SARVA-FR-130** | Reference **starter templates** for the Sarva product itself shall live under the repository path **`Requirement/templates/`** (or successor) as the **canonical examples** for humans and for agent grounding during implementation. |

### 9.15 Agent invocation and execution contract

Functional summary; **adapter-specific** behavior belongs in **TSD** (see §15 BYOA).

| ID | Requirement |
|----|-------------|
| **SARVA-FR-138** | **Agent runs** shall be **invocable** on **schedule or event** per policy, consistent with **heartbeats** and triggers in scope; **invoke** contract summarized here; adapter details in TSD. |
| **SARVA-FR-139** | Operators shall be able to **cancel or stop** in-flight agent runs where the execution path supports termination. |
| **SARVA-FR-140** | **Context packaging** for agent runs shall be **policy-controlled** (e.g. summary vs extended operational context). |

### 9.16 Traceability to technical specification (engineering)

| ID | Requirement |
|----|-------------|
| **SARVA-FR-141** | Engineering shall maintain **traceability** from **SARVA-FR-xxx** (and **SARVA-NFR-xxx**) to **technical specification and APIs**; each release shall document **stub vs live** for integrations (**Appendix B** and release notes), analogous to **spec vs shipped** discipline in comparable control-plane products. |

### 9.17 Execution adapters and extensibility

**Execution adapters** connect **agent assignments** to **runtimes** (local process, HTTP-triggered worker, vendor-specific runner, etc.) and implement the behaviors summarized in **§9.15** and detailed in **TSD**. **MCP** (**§9.9**) remains the primary **tool and external-system** extension surface for v0.1.

| ID | Requirement |
|----|-------------|
| **SARVA-FR-142** | The platform shall support **pluggable execution adapters** that implement the **agent run contract** consistent with **SARVA-FR-138–140** (e.g. invoke, report status where applicable, cancel where supported). **TSD** shall define **adapter categories** (at minimum **process** and **HTTP**-style triggers, and allow **named / first-party** adapters), **configuration schema** per adapter type, and **failure semantics**. |
| **SARVA-FR-143** | **Authorized operators** shall **register**, **enable**, **disable**, and **configure** execution adapters (including **secrets** and endpoints where applicable) via **Admin** or **Settings**, subject to **RBAC** and **audit** (same class of change as model bindings and integration configuration). |
| **SARVA-FR-144** | **Tool and integration extension** in v0.1 shall use the **MCP gateway** (**SARVA-FR-080**) and **execution adapters** (**SARVA-FR-142–143**). A **general-purpose third-party host plugin SDK** (arbitrary extensions to the Sarva **application host** UI or server beyond these mechanisms) is **out of scope for v0.1** and **deferred to phase 2** unless introduced by **change control**; if added later, **TSD** shall require **capability manifest**, **tenant policy**, **RBAC**, **audit**, and **SARVA-FR-141** traceability. |

### 9.18 Project repositories, code layout, and delivery integration

Companies may run **many teams** and **many projects**. **Version-controlled code** (e.g. **GitHub**) is integrated via **MCP** and/or APIs (**SARVA-FR-080**). **Layout** (folders, repos, monorepo paths) is **TSD**; **association mode** is a **product** choice per **Project**.

| ID | Requirement |
|----|-------------|
| **SARVA-FR-147** | The system shall support **integration with Git hosting** (e.g. **GitHub** via **MCP** or equivalent) for **code delivery**: **repositories**, **branches**, **pull requests** / merge requests, and **links** from **Tasks** or **releases** where configured. |
| **SARVA-FR-148** | By default, operators shall be able to use a **distinct repository or root folder per Project** under the **company’s** Git organization or naming convention so **project work** is **separable** in the VCS when **dedicated-repo-per-project** mode is selected (**SARVA-FR-149**); exact **folder/repo naming** and **automation** (e.g. repo creation) are **TSD**. |
| **SARVA-FR-149** | For each **Project**, **authorized operators** shall configure a **repository association mode**, **audited**: **(a)** **Dedicated** — one **primary** repo or root folder for this Project; **(b)** **Shared repository** — **multiple projects** (optionally multiple teams) work in the **same** codebase (e.g. **monorepo**); **path**, **package**, or **branch** conventions distinguish scope; **(c)** **Multi-repository** — one **Project** tracks **more than one** linked repository. The **active mode** shall be **visible** in the product so agents and humans share the same assumption. |
| **SARVA-FR-150** | The system shall support **CI/CD visibility**: integrate with **pipelines** (e.g. **GitHub Actions** or equivalent via **MCP**/API) to surface **build / test / deploy status** on **Tasks**, **Projects**, or **release records** where configured. **v0.1** may ship **read-only status**, **manual link**, or **stub** per **Appendix B** and **SARVA-FR-141**; **triggering** pipelines from Sarva is **optional** and **policy-gated**. |

---

## 10. Cross-team and escalation (normative behavior)

1. **Stuck → PM orchestrator** (same project).  
2. PM **resolves** (clarify, reassign within project) **or** **escalates upward** per org chart.  
3. **Cross-team need:** PM uses **Director peer** coordination, **peer PM** request, and/or **approval workflow** / manual intervention—**no bypass** of governance.  
4. **Exact priority** among peer Director vs PM-to-PM vs approval: **document in deployment policy** (open item §15).

---

## 11. Non-functional requirements

| ID | Category | Requirement |
|----|----------|-------------|
| **SARVA-NFR-001** | Performance | Primary operator **chat** interactions should meet **&lt; 2 s** perceived response for routine input (target; validate under load in design). |
| **SARVA-NFR-002** | Security | **Execution sandbox** for agents: no arbitrary OS control; tool/API-only execution; align with MRD safety constraints. |
| **SARVA-NFR-003** | Integrity | **Anti-hallucination** behaviors: prefer **verified** data via MCP where possible; block unapproved external comms. |
| **SARVA-NFR-004** | Availability UX | **Mobile-ready** responsive UI for monitoring, approvals, and key dashboards. |
| **SARVA-NFR-005** | Secrets | API keys for LLMs and integrations stored as **secrets** (not logged); rotation **TBD** in security spec. |
| **SARVA-NFR-006** | Privacy | Data handling and retention **TBD** with legal; minimum: tenant isolation for company data. |
| **SARVA-NFR-007** | Observability | Operational metrics and alerts for platform health **TBD** in technical design. |
| **SARVA-NFR-008** | Security / deployment | The product shall document **deployment posture** at requirements level (e.g. **development / local-trusted** vs **authenticated production**); detailed exposure and auth matrix in **security TSD**. |
| **SARVA-NFR-009** | UX | **Progressive disclosure:** primary views emphasize **human-readable intent and progress**; **raw logs and transcripts** are **secondary** (expandable). |

---

## 12. Data entities (logical)

| Entity | Key attributes (non-exhaustive) |
|--------|-----------------------------------|
| **Company** | id, name, settings, default model, budget |
| **BusinessUnit** | id, companyId, name |
| **Team** | id, buId, name, charter, hierarchy |
| **Role** | id, catalog ref or custom, metadata |
| **TeamRole** | teamId, roleId, count/seats |
| **RoleSkill** | roleId, skillId, enabled |
| **Skill** | id, name, description |
| **ModelBinding** | scopeType (company/role/skill), refId, provider, modelId, params |
| **Agent** | id, roleBinding, team, status, budget |
| **ExecutionAdapter** (config) | id, companyId?, type/category, config blob, enabled, secretsRef; **SARVA-FR-142–143** |
| **Project** | id, name, status, methodology, orchestratorAgentId; **delivery scope** (repos, folder convention, association mode) — **SARVA-FR-146–150** |
| **ProjectDeliveryScope** (logical) | projectId, **associationMode** (dedicated \| shared \| multi-repo), primaryRepoRef, folderOrPath?, additionalRepoRefs[], ciLinkConfig; **audited** |
| **TeamProject** | teamId, projectId |
| **Sprint** | id, projectId, name, goal, dates |
| **Task** | id, projectId, sprintId?, assignee, status, priority, skillType (see SARVA-FR-131–132) |
| **TaskComment** | id, taskId, author (user and/or agent), body, timestamps (**SARVA-FR-133**) |
| **StrategicGoal** (optional) | id, companyId or buId, title, link to Project/Task when SARVA-FR-136 enabled |
| **ApprovalRequest** | id, type, payload, status, approver, timestamps |
| **AuditEvent** | id, type, actor, payload ref, immutable timestamp |
| **CostEvent** | id, agentId, projectId?, amount, tokens, model |
| **DocumentRepository** | id, companyId/projectId?, type (local/cloud/git), uri, branch?, credentialsRef, scope |
| **RequirementArtifact** (or Task subtype) | id, projectId, author, content ref, reviewStatus, approval chain |
| **DocumentTemplate** | id, type (FRD/BRD/HLD/LLD/…), version, storage ref, tenantId?, isDefault |

---

## 13. Appendices

### Appendix A — Seed list: prebuilt Skills (non-exhaustive)

| Area | Examples |
|------|----------|
| Engineering | Code implementation, code review, document review, technical documentation, QA/testing, debugging, security review (light), DevOps/CI, API design |
| Product / UX | PRD, prioritization, UX/UI design, research synthesis, analytics |
| GTM | Sales, decks, marketing copy, SEO, competitive intel |
| Comms | Email drafting (send via Email Agent), meeting notes, status reporting |
| Leadership / PM | Project coordination, standup facilitation |

### Appendix B — Integration matrix (v0.1 placeholder)

| Integration | v0.1 target | Notes |
|-------------|-------------|--------|
| MCP framework | Required | Gateway present |
| Jira | Real or stub | **Confirm per sprint** |
| GitHub | Real or stub | **Confirm per sprint** |
| **Document repo (Git)** | v0.1 target **TBD** | e.g. clone/read for context |
| **Cloud doc provider** | Phase 2 or v0.1 | Per product decision |
| **Execution adapters** | Required (categories **TBD** in TSD) | **SARVA-FR-142–143**; stub vs live per **SARVA-FR-141** |
| **GitHub / Git (delivery)** | Real or stub | **SARVA-FR-147**; repos, PRs; per-project folder/repo — **SARVA-FR-148–149** |
| **CI/CD visibility** (pipelines) | Real, read-only, or stub | **SARVA-FR-150**; Actions / equivalent; trigger-from-Sarva **optional** |
| **Host plugins** (SDK) | **Not v0.1** | **SARVA-FR-144**; phase 2 if approved |
| Other MCP servers | As needed | Document in release notes |

### Appendix C — Seed list: prebuilt Roles (non-exhaustive)

Executive/Director: CTO, CPO, CMO, VP Sales, Tech Director, Engineering Manager, **Program Manager / TPM** (project orchestrator), Product Manager, Software Engineer, QA, UX, AE, SDR, CSM, DevOps/SRE (titles may vary).

---

## 14. Consolidated traceability (plan → FRD)

| Theme | SARVA IDs |
|-------|-----------|
| Dashboard, company, portability | SARVA-FR-001–004, SARVA-FR-137 |
| Org, roles, skills, models | SARVA-FR-010–019, SARVA-FR-020–022 |
| Projects, Scrum, tasks, assignee, claim, comments, chat anchoring, attachments, strategic goals | SARVA-FR-030–037, SARVA-FR-131–136 |
| PM orchestrator, backlog from requirements, project context | SARVA-FR-040–045, SARVA-FR-145–146 |
| System orchestrator | SARVA-FR-050 |
| Governance | SARVA-FR-060–063 |
| Email | SARVA-FR-070–073 |
| MCP | SARVA-FR-080–081 |
| Cost | SARVA-FR-090–092 |
| Audit | SARVA-FR-100–101 |
| UX, onboarding | SARVA-FR-110–113 |
| Document repos & requirements workflow | SARVA-FR-120–125 |
| Document templates library | SARVA-FR-126–130 |
| Agent invocation | SARVA-FR-138–140 |
| Engineering traceability | SARVA-FR-141 |
| Execution adapters & extensibility | SARVA-FR-142–144 |
| Project repositories, layout, Git, CI/CD | SARVA-FR-147–150 |
| NFR (incl. deployment, progressive disclosure) | SARVA-NFR-001–009 |

---

## 15. Open decisions (resolve before implementation lock)

1. **Multi-company** in one deployment: v0.1 or phase 2?  
2. **Partner onboarding:** email invite vs SSO vs manual (wizard **RBAC preview** covered by SARVA-FR-113; exact auth **TBD**).  
3. **BYOA / heartbeat** depth in v0.1 vs stub (constrained by **SARVA-FR-138–140** and **SARVA-FR-142–143**; full adapter matrix in TSD).  
4. **Sprint review / retro** in v0.1 vs phase 2.  
5. **Kanban** project type in v0.1 vs phase 2.  
6. **Cross-team routing priority** (Director vs PM-to-PM vs approval-first).  
7. **Integration matrix** final (Jira/GitHub real vs stub).  
8. **Velocity / burndown / WIP** in v0.1 vs phase 2 (default phase 2).  
9. **Epics** in v0.1 vs phase 2 (optional if hierarchy needed early).  
10. **Document repository**: read-only vs commit-back; which Git/cloud providers in v0.1.  
11. **Template customization**: who may edit platform vs tenant templates (see FR-128).  
12. **Tenant import/export:** full **import** vs **export-only** vs phase 2 only (**SARVA-FR-137**).  
13. **CI/CD:** **read-only pipeline status** vs **trigger runs from Sarva** vs **stub** in v0.1 (**SARVA-FR-150**).  
14. **Repo creation automation:** manual link only vs **auto-create repo/folder** per **SARVA-FR-148** (**TSD**).

---

## 16. Document history

| Version | Date | Notes |
|---------|------|--------|
| 0.1 | 2026-04-07 | Initial FRD from consolidated requirements plan |
| 0.2 | 2026-04-07 | System vs PM orchestrator clarity; scope guidance on velocity/epics; document repo + requirements approval workflow (FR-120–125); journey §8.5 |
| 0.3 | 2026-04-07 | Document templates library (FR-126–130); starter templates under `Requirement/templates/` |
| 0.3.1 | 2026-04-07 | Editorial: glossary table fix; §9 reordered (9.13–9.14 after 9.12); §8.1 cross-ref §9.5; SARVA-FR-100 includes template audit; traceability IDs; file renamed to `Sarva-FRD-v0.3.md` |
| 0.3.2 | 2026-04-07 | §8.6 onboarding refinements (unified Role–Skill UX, templates, tiers, gates, partners); SARVA-FR-018/019/022, FR-112/113; traceability updated |
| 0.3.3 | 2026-04-07 | §8.6: explicit **Minimal / Standard / Full** comparison table (wizard vs deferred) |
| 0.4.0 | 2026-04-11 | §3.3 non-goals; SARVA-FR-131–141, NFR-008–009; §9.15–9.16; optional strategic goals (**FR-136**); atomic Task claim (**FR-132**); traceability and deployment NFRs; success target in §8.6; file `Sarva-FRD-v0.4.md` |
| 0.4.1 | 2026-04-11 | **§9.17** execution adapters (**SARVA-FR-142–143**); MCP-first extension + deferred host plugin SDK (**SARVA-FR-144**); Appendix B rows; **ExecutionAdapter** entity; traceability |
| 0.5.0 | 2026-04-11 | **§8.7** backlog/context/delivery journey; **§9.18** repos/CI (**SARVA-FR-145–150**); per-project folder/repo default + **shared** and **multi-repo** modes (**SARVA-FR-148–149**); glossary; **ProjectDeliveryScope**; audit extension **FR-100**; published as **`SARVA-REQUIREMENTS.md`** |
| 0.5.1 | 2026-04-11 | **§3.1** closing paragraph: **R1 delivery tranche** may use Sarva template-first org catalog; pointer to R1 FRD + LLD §3.1.0 |

---

## 17. Consistency and alignment (review notes)

This section records **editorial fixes** and **remaining alignment** checks for readers.

| Check | Status |
|-------|--------|
| **§9 subsection order** | **9.1–9.18** sequential; **9.18** follows **9.17** (project repositories and delivery integration). |
| **Glossary** | Orchestrator rows and “How they differ” are valid markdown (table not split by prose). |
| **Cross-references** | §8.1 step 13 points to **§9.5** (PM orchestrator). **§8.7** ties backlog, context, and delivery. §3.1 references **§9.13–§9.14**, **§9.17–§9.18**. |
| **Audit coverage** | SARVA-FR-100 includes **document template** (FR-128) and **project delivery** configuration (**FR-148–150**). |
| **IDs** | Functional IDs **SARVA-FR-xxx** through **SARVA-FR-150**; NFR **SARVA-NFR-001–009**; traceability table uses full prefix. |
| **Personas** | **Director / lead PM** row added in §5 to align with §8.5 and approval matrix. |
| **Open decisions** | §15 still governs multi-company, auth, integrations, analytics depth — not contradicted by body text. |
| **§8.6** | Onboarding refinements are **normative**; optional reference HTML mocks (kept privately under **`Requirement/archive/mockups/`**, gitignored) should align when used (tier, template, gates, partners). |
| **Legacy MRD** | Any Word MRD is **optional local-only** (`Requirement/*.docx`, gitignored) — **this document** is authoritative for shipped v0.1 text. |

---

*End of document*
