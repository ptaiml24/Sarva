# Sarva

**Sarva** can help **you run your company's delivery backbone** — **bring software projects toward release**, guided stage-by-stage through the **software development lifecycle (SDLC)** inside Sarva: **intake** and clarified scope → backlog shaping and (**PM/agent**) orchestrated runs → disciplined tasks with audit trails plus workspace tooling where wired → gated reviews, **readiness for UAT**, and **closure**.

Under that lifecycle is modeled structure: **business units**, **teams**, **seat** placements tying **roles** to **skills**, **agents**, configurable **LLM providers + model bindings**, budgets—with **humans** accountable for merges, approvals, policy, governance, spend.

What **this repo** ships is **not** turnkey SaaS: a **thin, runnable slice** of that story as **Fastify + Postgres (Prisma) + React/Vite**, with **`Requirement/`** specs and **`docs/`** onboarding. Expect a **prototype / learning baseline**, not hardened production.

**Repository:** [github.com/ptaiml24/Sarva](https://github.com/ptaiml24/Sarva).

## Disclaimer (public releases)

This project is licensed under the **[MIT License](./LICENSE)**: see that file for the full **copyright notice** and warranty **disclaimer** (“AS IS”; no warranties; limited liability).

**Operational reality:** Authentication in R1 relies on **developer-style JWT issuance** (`/api/v1/auth/login`), not enterprise IdP workflows. Secrets belong in **`apps/api/.env`** and your host—not in source control. You are responsible for Postgres hardening, network exposure, patching, backups, LLM/Git credentials, and any compliance obligations. Naming, UX, and feature scope evolve; **backward compatibility between commits is not guaranteed** until a formal versioning story exists.

Different projects need different openness: permissive (**MIT**) vs patent clause (**Apache-2.0**) vs strong copyleft (**GPL-3.0**). Choosing a template is summarized at **[choosealicense.com](https://choosealicense.com)**. This repo ships **MIT** for simplicity—you may replace **[`LICENSE`](./LICENSE)** after your own legal review.

**Security disclosures:** Follow **[`SECURITY.md`](./SECURITY.md)**; do not use public issues for unfixed vulnerabilities.

**New to the stack?** Follow the **[Operator / setup guide](docs/USER_GUIDE.md)** (environment → Admin LLM & bindings → organization → projects).

---

## Repo layout

| Area | Location |
|------|----------|
| **Step-by-step setup & tenant walkthrough** | [`docs/USER_GUIDE.md`](docs/USER_GUIDE.md) |
| **Requirements** (`SARVA-REQUIREMENTS.md`) and **design** (`SARVA-DESIGN.md`) | [`Requirement/README.md`](Requirement/README.md) |
| Optional local archive (split R1 docs / mocks — **gitignored**) | **`Requirement/archive/`** (see [`.gitignore`](.gitignore) + [`Requirement/README.md`](Requirement/README.md)) |
| API (Fastify + Prisma) | [`apps/api/`](apps/api/) · details in [`apps/api/README.md`](apps/api/README.md) |
| Web UI (Vite + React) | [`apps/web/`](apps/web/) |
| E2E (Playwright) | [`e2e/`](e2e/) · `npm run e2e` |
| Example env knobs (integrations, MCP) | [`deploy/appendix-b.example.env`](deploy/appendix-b.example.env) |

## Prerequisites

- **Node.js** 20+ and **npm**
- **PostgreSQL** reachable from `apps/api` (API tests assume a real DB, not mocks)

## Getting started

```bash
npm install
cp apps/api/.env.example apps/api/.env
# Edit DATABASE_URL, JWT_SECRET, and integration vars as documented in apps/api/README.md

npm run db:setup  # prisma generate + migrate deploy + seed
npm run build     # builds apps/api + apps/web
npm run lint
npm run dev -w @sarva/api   # terminal 1 — API
npm run dev -w @sarva/web   # terminal 2 — http://127.0.0.1:5173
```

Additional scripts:

```bash
npm run test      # Vitest for API — needs DATABASE_URL (+ JWT_SECRET) in apps/api/.env
npm run e2e       # Playwright (boots stack; first run slow while Vite comes up)
npm run e2e:local # When API + web are already running
```

First-time Playwright: `npm run playwright:install` (Chromium; once per machine/update).

See [`docker-compose.yml`](docker-compose.yml) for an optional local Postgres bootstrap.

---

## Legal & security (summary)

| Document | Purpose |
|----------|---------|
| [`LICENSE`](./LICENSE) | MIT terms (replace only after your counsel agrees). |
| [`SECURITY.md`](./SECURITY.md) | How to report vulnerabilities privately. |

For larger or production deployments: maintain this README, dependency updates (`npm audit`, lockfile hygiene), TLS at the edge, secret rotation, and your own SOC2/ISO/other programs as applicable—**not implied by publishing this repo**.
