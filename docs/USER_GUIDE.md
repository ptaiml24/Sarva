# Sarva — step-by-step setup & tenant guide

This guide is for anyone who clones the repo and wants a **working local Sarva**: database, API, web UI, then **Admin** (LLM + bindings) and **Organization** paths through **teams, roles, skills, agents**, and a **project** ready for delivery tabs.

Conceptual detail lives in **`Requirement/SARVA-REQUIREMENTS.md`** and **`Requirement/SARVA-DESIGN.md`**. Operational limits and legal disclaimer: root **`README.md`** and **`LICENSE`**.

---

## 1. What you’re building

Roughly:

1. **Runtime** — Node.js API + Postgres + Vite SPA.  
2. **LLM routing** — at least one **LLM provider connection** and a **company-scoped model binding** so orchestration/features can resolve a model (see **`apps/api/.env.example`** for feature flags like `PM_PROPOSE_USE_LLM`).  
3. **Org shell** — one **company** (R1 = single tenant record), optional **business units**, **teams** with **seats** (roles + skills per seat), **agents** roster, **seat ↔ agent** assignment.  
4. **Delivery** — **projects** (with a seeded **delivery workflow**), **Intake**, link a team / PM orchestrator, then **Board / Plan / backlog** flows as wired in your build.

Optional: **Dashboard → Company setup** checklist mirrors much of this order.

---

## 2. Prerequisites

| Requirement | Notes |
|-------------|--------|
| **Node.js 20+** | Matches API stack assumptions. |
| **npm** | Workspaces root at repo root. |
| **PostgreSQL 14+** (16 recommended) | Must be reachable with a URL you put in **`apps/api/.env`**. |
| **Ports** | API default **`3000`**, Web default **`5173`** (`127.0.0.1`). |

Terminal familiarity and a way to edit env files safely (no committing secrets).

---

## 3. Clone and install

From your machine:

```bash
git clone https://github.com/ptaiml24/Sarva-private.git sarva
cd sarva
npm install
```

*(Use SSH `git@github.com:ptaiml24/Sarva-private.git` or your fork’s URL instead if your workflow prefers that.)*

---

## 4. Database and environment

1. **Create or choose a Postgres database** user/database (examples in **`apps/api/.env.example`** and **`docker-compose.yml`**).

2. **Copy API env**:

   ```bash
   cp apps/api/.env.example apps/api/.env
   ```

3. **Edit `apps/api/.env`** minimally:

   - **`DATABASE_URL`** — must point at your Postgres.  
   - **`JWT_SECRET`** — ≥ 32 chars; treats auth as trusted in development.  

   Leave **`INTEGRATION_MCP_GIT=off`** unless you deliberately run an MCP Git gateway (advanced).

4. **Apply schema + seed** from repo root:

   ```bash
   npm run db:setup
   ```

   That runs Prisma **`generate`**, **`migrate deploy`**, and **`db:seed`** (catalogs, workflows, starter data—see **`apps/api/README.md`** if anything fails).

5. **Verify** optional: `docker compose up -d` only if you use the bundled Postgres service instead of local install.

---

## 5. Start the stack

Two terminals:

```bash
# Terminal A — API
npm run dev -w @sarva/api

# Terminal B — Web
npm run dev -w @sarva/web
```

- API health: **`http://127.0.0.1:3000/health`**  
- SPA: **`http://127.0.0.1:5173`**

---

## 6. Sign in (roles)

Open **`http://127.0.0.1:5173/login`**.

- **`admin`** — required for **System → Admin**, **creating the company**, business units (per UI), destructive org edits, deleting empty projects where allowed.  
- **`operator`** — day-to-day work on projects/tasks; blocked from **`/admin`**.

Pick any **email**; R1 **`/auth/login`** **upserts** a user row—it is **not** a production IdP.

---

## 7. Recommended order after login

Follow this path in the sidebar (or equivalents):

### 7.1 Organization → Business units

**Path:** **`/organization/business-units`** (Sidebar: **Organization → Business units**.)

1. If there is **no company**, create one (name only) — admin only.  
2. Add **at least one business unit** if you plan to organize teams under BUs.

### 7.2 System → Admin → LLM and model bindings *(do this before heavy LLM features)*

**Path:** **`/admin`** (Sidebar: **System → Admin**) — **`admin`** only.

**Tab: Model bindings**

1. **Add an LLM provider connection** (“Add provider connection” area):

   - Name (your label).  
   - Provider (OpenAI-compatible catalog entry, **Ollama**, etc.).  
   - Model id (or preset from catalog / Ollama list if you fetch models).  
   - **API key / base URL** as required by the provider.  
   - Use **Test** on that connection row to verify reachability before binding.

2. **Create at least one model binding** scoped to **`Company default`** initially:

   - Pick the connection you added.  
   - Set priority (lower often wins—see binding resolution rules in **`Requirement/SARVA-DESIGN.md`** Part II if you tune multiple bindings).  

   Optionally add **Agent** or **Team seat** scoped bindings once agents and seats exist (finer routing).

*(Optional)** **Company** tab:** set display name.**  
*(Optional)** **GitHub publishing** tab:** PAT + owner only if you will use repo publish flows from the board.**

> **Reminder:** MCP Git, coder concurrency, stubs, timeouts, etc. are mostly **`apps/api/.env`**—not all are exposed in UI.

---

## 8. Organization → Teams *(seats = roles × skills × agents)*

**Path:** **`/organization/teams`**

Rough flow per team:

1. **Create a team**, attach optional **business unit**.  
2. **Add seats (roles)** from **Sarva role templates** (Engineer, PM, etc.—seeded catalogs). Multiple seats per role type = duplicate role rows following UI affordances on the page.  
3. For each seat (role):

   - **Link allowed skills** to that seat (**Skill templates** seeded or extended under **Roles & skills** page).  

4. **`Work → Agents`:** create roster entries (**idle / active / paused**).  
5. **`Organization → Teams`:** assign **`seat ↔ agent`** mapping so deliveries know **which agent** owns work for that skill profile.

Repeat until each team has a coherent skill graph for how you intend to orchestrate backlog and board work.

---

## 9. Organization → Roles & skills *(catalog authoring)*

**Path:** **`/organization/skills-models`**

Used to **inspect or extend catalogs** Sarva seeded (within admin capability).

- **`Role templates`** and **`skill templates`** power the picker when building teams.  
- Skill **`agent_prompt`** text can be edited here; builtins merge when empty (runtime behavior documented in **`apps/api/README.md`** archive notes).

Teams page drives **seat-level** linkage; Roles & skills page drives **canonical definitions**.

---

## 10. Work → Projects

**Path:** **`/projects`**

1. Pick a **delivery workflow**:

   - **Full end-to-end** vs **Feature development** (feature dev assumes you set **repository scope / clone URL** on Intake when required).

2. **Create project**, then land on **`Intake`**.

3. **`Intake` tab:**

   - Add **brief / goals**.  
   - **Link exactly one delivery team** (required for sane Plan/board routing later).  
   - Select **PM orchestrator agent**.  
   - Set **technical context** fields as needed (**clone URL**, paths, docs).  

4. Navigate project tabs **`Requirements → Design → Backlog → Plan → Board → Chat`** as your process requires; **`Begin execution` / orchestration kicks** behave per current API/policy ( **`deliveryPolicy`**, thresholds—see SARVA-DESIGN and API routes).

Dashboard **task rollups** and **delivery gates** (UAT / close) surface on the **project hub** when applicable.

---

## 11. Optional: Guided setup checklist

**Path:** **`/organization/guided-setup`**

Offers a condensed **ordered checklist** (company → catalogs → BU → seats → agents → project → intake)—use alongside this document.

---

## 12. When you’re “done,” how to propose changes later

Treat this artifact as living software:

- Prefer **opening a structured issue on the repository’s issue tracker** (commonly GitHub Issues) describing what you’d change, reproduction steps if it’s broken behavior, and environment (branch, Postgres version).  
- For **security-sensitive** reports, **do not** rely on issues first—follow **`SECURITY.md`** in the repo root.  
- For **upstream features** vs local forks: link back to **`Requirement/`** rationale so maintainers understand product intent (`SARVA-REQUIREMENTS.md` IDs when possible).

Patches via pull requests typically reference an issue unless it’s trivial.

---

## 13. Quick troubleshooting

| Symptom | Things to verify |
|---------|-------------------|
| `db:setup` fails | Postgres up, **`DATABASE_URL`**, user has DDL rights if creating DB. |
| API 401 everywhere | SPA proxy + token; redo login after clearing storage. |
| LLM-heavy actions no-op/errors | **`PM_PROPOSE_USE_LLM`**, **`AGENT_CODER_USE_LLM`**, stubs off; bindings + provider connection test succeeds. |
| “No workflow in catalog” on project create | Migrations/seeds incomplete—re-run **`npm run db:setup`**; see DB row **`delivery_workflow`**. |
| Admin invisible | Wrong role—logout, sign in **`admin`**. |

Deeper troubleshooting: **`apps/api/README.md`**, **`e2e/journey.spec.ts`** sequences, Postgres-only test rule in `.cursor/rules/real-postgres-no-mock-data.mdc`.

---

*Last updated alongside public-readiness housekeeping; align with your fork’s branching and governance norms.*
