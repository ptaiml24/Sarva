import { constants } from "node:fs";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

type PackageJsonLike = {
  name?: string;
  scripts?: Record<string, unknown>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

function depKeys(pkg: PackageJsonLike): Set<string> {
  const s = new Set<string>();
  for (const k of Object.keys(pkg.dependencies ?? {})) s.add(k);
  for (const k of Object.keys(pkg.devDependencies ?? {})) s.add(k);
  return s;
}

/** Used when no framework is detected — creates `dist/` and copies static assets (Sarva scaffold / plain HTML). */
export const SARVA_PLACEHOLDER_BUILD_COMMAND = "node scripts/sarva-placeholder-build.cjs";

const SARVA_PLACEHOLDER_BUILD_CJS = [
  "#!/usr/bin/env node",
  '"use strict";',
  "const fs = require(\"fs\");",
  "const path = require(\"path\");",
  "const root = process.cwd();",
  "const dist = path.join(root, \"dist\");",
  "",
  "function copyDirRecursive(src, dest) {",
  "  if (!fs.existsSync(src)) return;",
  "  fs.mkdirSync(dest, { recursive: true });",
  "  for (const name of fs.readdirSync(src)) {",
  "    if (name === \".\" || name === \"..\") continue;",
  "    const s = path.join(src, name);",
  "    const d = path.join(dest, name);",
  "    let st;",
  "    try { st = fs.lstatSync(s); } catch { continue; }",
  "    if (st.isDirectory()) copyDirRecursive(s, d);",
  "    else if (st.isFile()) fs.copyFileSync(s, d);",
  "  }",
  "}",
  "",
  "fs.mkdirSync(dist, { recursive: true });",
  "const html = path.join(root, \"index.html\");",
  "if (fs.existsSync(html)) {",
  "  fs.copyFileSync(html, path.join(dist, \"index.html\"));",
  "}",
  "// Mirror common static trees into dist/ (absolute paths in HTML like /js/game.js).",
  "for (const dir of [\"js\", \"css\", \"assets\", \"static\", \"images\", \"fonts\", \"media\", \"sounds\", \"lib\", \"vendor\", \"wasm\"]) {",
  "  copyDirRecursive(path.join(root, dir), path.join(dist, dir));",
  "}",
  "// Vite-style public/ → dist root",
  "const pub = path.join(root, \"public\");",
  "if (fs.existsSync(pub)) {",
  "  for (const name of fs.readdirSync(pub)) {",
  "    const s = path.join(pub, name);",
  "    const d = path.join(dist, name);",
  "    let st;",
  "    try { st = fs.lstatSync(s); } catch { continue; }",
  "    if (st.isDirectory()) copyDirRecursive(s, d);",
  "    else if (st.isFile()) fs.copyFileSync(s, d);",
  "  }",
  "}",
  "console.log(\"Sarva placeholder build: dist/ ready (replace with a real bundler when needed).\");",
  "",
].join("\n");

export async function ensureSarvaPlaceholderBuildScriptFile(workspacePath: string): Promise<void> {
  const dir = join(workspacePath, "scripts");
  const file = join(dir, "sarva-placeholder-build.cjs");
  await mkdir(dir, { recursive: true });
  await writeFile(file, SARVA_PLACEHOLDER_BUILD_CJS, "utf8");
}

async function pathReadable(p: string): Promise<boolean> {
  try {
    await access(p, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

async function firstExistingFile(workspacePath: string, names: string[]): Promise<string | null> {
  for (const n of names) {
    const p = join(workspacePath, n);
    if (await pathReadable(p)) return n;
  }
  return null;
}

/** Strong signals from repo layout (deps may be incomplete in agent workspaces). */
async function inferFromWorkspaceFiles(workspacePath: string): Promise<string | null> {
  if (
    await firstExistingFile(workspacePath, [
      "vite.config.ts",
      "vite.config.js",
      "vite.config.mjs",
      "vite.config.cjs",
      "vite.config.mts",
    ])
  ) {
    return "vite build";
  }
  if (
    await firstExistingFile(workspacePath, [
      "next.config.js",
      "next.config.mjs",
      "next.config.ts",
      "next.config.mts",
    ])
  ) {
    return "next build";
  }
  if (await firstExistingFile(workspacePath, ["nuxt.config.ts", "nuxt.config.js"])) {
    return "nuxt build";
  }
  if (await firstExistingFile(workspacePath, ["astro.config.mjs", "astro.config.ts", "astro.config.js"])) {
    return "astro build";
  }
  if (await pathReadable(join(workspacePath, "angular.json"))) {
    return "ng build";
  }
  if (await firstExistingFile(workspacePath, ["remix.config.js", "remix.config.ts"])) {
    return "remix build";
  }
  return null;
}

function scriptString(pkg: PackageJsonLike, key: string): string {
  const v = pkg.scripts?.[key];
  return typeof v === "string" ? v : "";
}

function inferFromDevOrStartScripts(pkg: PackageJsonLike): string | null {
  const combined = `${scriptString(pkg, "dev")} ${scriptString(pkg, "start")} ${scriptString(pkg, "serve")}`.toLowerCase();
  if (/\bvite\b/.test(combined)) return "vite build";
  if (/\bnext\b/.test(combined)) return "next build";
  if (/\bnuxt\b/.test(combined)) return "nuxt build";
  if (/\bastro\b/.test(combined)) return "astro build";
  if (/\bsvelte-kit\b/.test(combined)) return "svelte-kit build";
  if (/\bremix\b/.test(combined)) return "remix build";
  if (/\bparcel\b/.test(combined)) return "parcel build";
  if (/\bwebpack\b/.test(combined)) return "webpack --mode production";
  return null;
}

/**
 * Picks `npm run build` from config files, `scripts.dev` / `start`, dependencies, tsconfig, or Sarva placeholder.
 */
export async function inferBuildScriptForPackage(
  pkg: PackageJsonLike,
  workspacePath: string
): Promise<string> {
  const fromFile = await inferFromWorkspaceFiles(workspacePath);
  if (fromFile) return fromFile;

  const fromScripts = inferFromDevOrStartScripts(pkg);
  if (fromScripts) return fromScripts;

  const deps = depKeys(pkg);

  if (deps.has("astro")) {
    return "astro build";
  }
  if (deps.has("vite") || deps.has("@vitejs/plugin-react") || deps.has("@vitejs/plugin-vue")) {
    return "vite build";
  }
  if (deps.has("next")) {
    return "next build";
  }
  if (deps.has("nuxt") || deps.has("@nuxt/schema") || deps.has("@nuxt/kit")) {
    return "nuxt build";
  }
  if (deps.has("@sveltejs/kit")) {
    return "svelte-kit build";
  }
  if (deps.has("@remix-run/dev") || deps.has("@remix-run/node")) {
    return "remix build";
  }
  if (deps.has("react-scripts")) {
    return "react-scripts build";
  }
  if (deps.has("@angular/cli")) {
    return "ng build";
  }
  if (deps.has("typescript")) {
    const buildTs = join(workspacePath, "tsconfig.build.json");
    const rootTs = join(workspacePath, "tsconfig.json");
    if (await pathReadable(buildTs)) {
      return "tsc -p tsconfig.build.json";
    }
    if (await pathReadable(rootTs)) {
      return "tsc -p tsconfig.json";
    }
  }

  return SARVA_PLACEHOLDER_BUILD_COMMAND;
}

function buildScriptFromPackage(pkg: PackageJsonLike): string | null {
  const raw = pkg.scripts?.build;
  const s = typeof raw === "string" ? raw.trim() : "";
  return s.length > 0 ? s : null;
}

export type EnsurePackageBuildScriptResult =
  | { ok: true; addedScript: string | null }
  | { ok: false; skippedReason: string };

/**
 * If `package.json` has no usable `scripts.build`, infer one from layout / dependencies,
 * merge into `scripts`, and write the file back (pretty-printed).
 */
export async function ensurePackageJsonBuildScript(
  pkgPath: string,
  workspacePath: string
): Promise<EnsurePackageBuildScriptResult> {
  let raw: string;
  try {
    raw = await readFile(pkgPath, "utf8");
  } catch {
    return { ok: false, skippedReason: "no_package_json" };
  }

  let pkg: PackageJsonLike;
  try {
    pkg = JSON.parse(raw) as PackageJsonLike;
  } catch {
    return { ok: false, skippedReason: "package_json_invalid" };
  }

  if (buildScriptFromPackage(pkg)) {
    return { ok: true, addedScript: null };
  }

  const inferred = await inferBuildScriptForPackage(pkg, workspacePath);
  if (inferred === SARVA_PLACEHOLDER_BUILD_COMMAND) {
    await ensureSarvaPlaceholderBuildScriptFile(workspacePath);
  }

  const next = { ...pkg } as Record<string, unknown>;
  const scripts =
    typeof pkg.scripts === "object" && pkg.scripts !== null && !Array.isArray(pkg.scripts)
      ? { ...(pkg.scripts as Record<string, unknown>) }
      : {};
  scripts.build = inferred;
  next.scripts = scripts;

  await writeFile(pkgPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  return { ok: true, addedScript: inferred };
}
