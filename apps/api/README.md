# Sarva R1 — Control plane API

Implements the baseline described in **`Requirement/SARVA-DESIGN.md`** (architecture + interfaces + runtime stack consolidated from prior LLD/TSD lineage).

## Prereqs

- Node 20+
- **PostgreSQL 16+** running locally (Homebrew, Postgres.app, Linux package, etc.) **or** the optional [`docker-compose.yml`](../../docker-compose.yml) stack at repo root

## Setup (local Postgres, no Docker)

1. Ensure the server is listening (often `localhost:5432`). Create a database and user that match your `DATABASE_URL`, **or** run the optional bootstrap (matches `.env.example`):

   ```bash
   # From repo root — as a DB superuser (adjust -U / host if needed):
   psql -h localhost -U postgres -f scripts/postgres/bootstrap-dev.sql
   ```

2. From **repository root**:

   ```bash
   npm install
   cp apps/api/.env.example apps/api/.env
   # Edit DATABASE_URL / JWT_SECRET if you did not use bootstrap-dev.sql
   npm run db:setup
   npm run dev -w @sarva/api
   ```

`npm run db:setup` runs, in order: **`db:generate`** → **`db:migrate`** (`prisma migrate deploy`) → **`db:seed`**. Prisma loads `apps/api/.env` automatically when those commands run in the `@sarva/api` workspace.

### Optional: Docker Postgres instead

From repo root: `docker compose up -d`, then use the default URL in `.env.example` (`sarva` / `sarva_dev` / database `sarva`).

## Setup (command reference)

Equivalent to `npm run db:setup` if you prefer explicit Prisma flags from repo root:

```bash
npm install
cp apps/api/.env.example apps/api/.env
npx prisma generate --schema apps/api/prisma/schema.prisma
npx prisma migrate deploy --schema apps/api/prisma/schema.prisma
npx prisma db seed --schema apps/api/prisma/schema.prisma
npm run dev -w @sarva/api
```

- Health: `GET http://localhost:3000/health`
- Login (dev JWT): `POST /api/v1/auth/login` with `{ "email": "you@example.com", "role": "admin" }`
- Use `Authorization: Bearer <token>` on `/api/v1/*` routes.
- **Full web UI (recommended):** run [`apps/web`](../web/) dev server (Vite) — login, company, teams/agents, projects, PM, board.
- Minimal L4 board (static): `GET /ui/board.html` — paste token + project id to list tasks.
- Optional tuning: `AGENT_CODER_MAX_PARALLEL_RUNS` controls concurrency for orchestration-triggered coder batches.

## Scripts

| Script (from repo root) | Purpose |
|-------------------------|--------|
| `npm run dev -w @sarva/api` | Hot-reload API |
| `npm run build -w @sarva/api` | Typecheck + emit `dist/` |
| `npm run test -w @sarva/api` | Vitest — **requires** real Postgres (`DATABASE_URL` in `apps/api/.env`) and applied migrations; no mocked DB (see `../../.cursor/rules/real-postgres-no-mock-data.mdc`) |
| `npm run lint -w @sarva/api` | ESLint |
| **`npm run db:setup`** | **`db:generate` + `db:migrate` + `db:seed`** (use after clone or new migrations) |
| `npm run db:generate` | `prisma generate` |
| `npm run db:migrate` | `prisma migrate deploy` |
| `npm run db:seed` | `prisma db seed` |
| `npm run db:migrate:dev` | `prisma migrate dev` (creates migrations; run inside `apps/api` via workspace) |
| `npm run db:studio` | Prisma Studio |
| `npm run db:clean-sample` | **Workspace reset:** projects, teams, **BUs**, **agents**, budgets, costs, approvals, audits; keeps company, users, Sarva catalogs, LLM connections |
| `npm run db:purge-test-users` | Deletes `*@sarva.test` users and their comments/audits (dev / CI hygiene) |

## M3 deployment checklist (M3-03)

Use this before a release demo or shared environment (see **[`docs/USER_GUIDE.md`](../../docs/USER_GUIDE.md)** and **[`Requirement/SARVA-REQUIREMENTS.md`](../../Requirement/SARVA-REQUIREMENTS.md)** for the current operator story).

1. **Database:** `DATABASE_URL` points at Postgres 16+; run `npm run db:setup` from repo root after clone or new migrations.
2. **Secrets:** `JWT_SECRET` (32+ characters); LLM keys per provider in Admin / `LlmProviderConnection` rows.
3. **Workspace:** `SARVA_AGENT_WORKSPACE` (optional) — directory on the API host for coder output; ensure disk space and permissions.
4. **Git push (env):** `SARVA_WORKSPACE_GIT_PUSH=true` plus SSH/credential helper on the API host enables **Push to GitHub** on the board when the dev workspace already has `origin`. Optional: `SARVA_GIT_AUTHOR_NAME` / `SARVA_GIT_AUTHOR_EMAIL`.
5. **GitHub publish (company DB):** Admin → **GitHub publishing** stores owner + PAT on the `Company` row (not in `.env`). Used by **Create GitHub repo & publish** on the board (`POST /api/v1/projects/:id/delivery/github-publish`). Test with **Test connection** (`POST /api/v1/integrations/github-verify`). New repos default **private** unless overridden per publish.
6. **Appendix B:** Copy [`deploy/appendix-b.example.env`](../../deploy/appendix-b.example.env) values into `apps/api/.env`; align with your deployment’s Postgres, JWT, and integration endpoints.

## OpenAPI

See [`openapi/sarva-r1-api.yaml`](openapi/sarva-r1-api.yaml).
