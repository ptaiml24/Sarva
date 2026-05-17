# Sarva web (control plane UI)

React + Vite SPA that talks to the API on **`/api`** (proxied to `http://127.0.0.1:3000` in dev).

## Run (two terminals)

1. API + DB (see [`../api/README.md`](../api/README.md)): `npm run dev -w @sarva/api`
2. Web: `npm run dev -w @sarva/web` → open **http://127.0.0.1:5173**

Sign in with **admin** to create the company and edit catalog routes.

## Build

```bash
npm run build -w @sarva/web
```

Static output: `apps/web/dist/` (serve behind your gateway or copy to CDN).

## UX reference

Product flows align with **[`Requirement/SARVA-REQUIREMENTS.md`](../../Requirement/SARVA-REQUIREMENTS.md)** (**§8**) and **[`Requirement/SARVA-DESIGN.md`](../../Requirement/SARVA-DESIGN.md)**.
