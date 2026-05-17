import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join, resolve, sep } from "node:path";
import type { Env } from "../config/env.js";
import { prisma } from "./prisma.js";
import { ensurePackageJsonBuildScript } from "./workspacePackageBuildScript.js";

function slugify(name: string): string {
  const s = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);
  return s || "project";
}

function isPathInsideRoot(root: string, candidate: string): boolean {
  const r = resolve(root);
  const c = resolve(candidate);
  return c === r || c.startsWith(r + sep);
}

export type WorkspaceEnsureResult = {
  path: string | null;
  created: boolean;
  error?: string;
};

function defaultWorkspaceRoot(): string {
  // apps/api/src/lib -> repo root
  const here = fileURLToPath(new URL(".", import.meta.url));
  return resolve(here, "../../../../workspace");
}

/** Resolved root for `SARVA_AGENT_WORKSPACE` (or repo `workspace/` default). */
export function resolveAgentWorkspaceRoot(env: Env): string {
  const rootRaw = env.SARVA_AGENT_WORKSPACE?.trim() || defaultWorkspaceRoot();
  return resolve(rootRaw);
}

/** True when `absPath` is the workspace root or a subdirectory (agent workspaces must stay under here). */
export function isDevWorkspacePathUnderAgentRoot(env: Env, absPath: string): boolean {
  return isPathInsideRoot(resolveAgentWorkspaceRoot(env), absPath);
}

/**
 * Creates `{workspaceRoot}/{slug}/` on the API host (once per project) with a minimal Node-friendly layout.
 * `workspaceRoot` defaults to `Sarva/workspace/` at repo root and can be overridden via `SARVA_AGENT_WORKSPACE`.
 * Paths are constrained under the workspace root to avoid traversal.
 */
export async function ensureProjectDevWorkspace(projectId: string, env: Env): Promise<WorkspaceEnsureResult> {
  const root = resolveAgentWorkspaceRoot(env);

  const project = await prisma.project.findUnique({ where: { id: projectId } });
  if (!project) {
    return { path: null, created: false, error: "project_not_found" };
  }
  if (project.devWorkspacePath) {
    return { path: project.devWorkspacePath, created: false };
  }

  const slug = slugify(project.name);
  const target = resolve(root, slug);
  if (!isPathInsideRoot(root, target)) {
    return { path: null, created: false, error: "invalid_workspace_path" };
  }

  await mkdir(join(target, "src"), { recursive: true });
  await writeFile(
    join(target, "README.md"),
    `# ${project.name}\n\nSarva agent workspace — implement work under \`src/\`. Sync to your real repo as needed.\n`,
    "utf8"
  );
  await writeFile(join(target, "src", ".gitkeep"), "", "utf8");
  const pkgPath = join(target, "package.json");
  await writeFile(
    pkgPath,
    JSON.stringify(
      {
        name: slug,
        private: true,
        version: "0.0.0",
        description: "Scaffolded by Sarva — extend as needed",
      },
      null,
      2
    ),
    "utf8"
  );
  await ensurePackageJsonBuildScript(pkgPath, target);
  await writeFile(join(target, ".gitignore"), "node_modules/\n.env\n.DS_Store\n", "utf8");

  await prisma.project.update({
    where: { id: projectId },
    data: { devWorkspacePath: target },
  });

  return { path: target, created: true };
}

/**
 * Ensures an active workspace path stays under SARVA_AGENT_WORKSPACE root and matches the project record.
 * Guards against traversal or drifting paths before filesystem-backed coder runs.
 */
export function validateProjectDevWorkspaceAgainstRecord(
  env: Env,
  project: { devWorkspacePath: string | null },
  candidateAbsolutePath: string | null | undefined
): { ok: true } | { ok: false; reason: string } {
  if (!candidateAbsolutePath?.trim()) return { ok: true };
  let resolvedWs: string;
  try {
    resolvedWs = resolve(candidateAbsolutePath);
  } catch {
    return { ok: false, reason: "invalid_workspace_path_resolve" };
  }

  const root = resolveAgentWorkspaceRoot(env);
  if (!isPathInsideRoot(root, resolvedWs)) {
    return { ok: false, reason: "workspace_outside_agent_root" };
  }

  if (project.devWorkspacePath) {
    try {
      const expected = resolve(project.devWorkspacePath);
      if (resolvedWs !== expected) {
        return { ok: false, reason: "workspace_path_mismatch" };
      }
    } catch {
      return { ok: false, reason: "invalid_saved_workspace_record" };
    }
  }

  return { ok: true };
}
