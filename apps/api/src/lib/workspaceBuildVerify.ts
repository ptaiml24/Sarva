import { constants } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { createServer } from "node:net";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { join, resolve } from "node:path";
import type { Env } from "../config/env.js";
import { prisma } from "./prisma.js";
import { appendProjectChatMessage } from "./projectChat.js";
import { deliveryPolicyRecord } from "./deliveryPolicy.js";
import { isDevWorkspacePathUnderAgentRoot } from "./workspaceScaffold.js";
import {
  ensurePackageJsonBuildScript,
  ensureSarvaPlaceholderBuildScriptFile,
  SARVA_PLACEHOLDER_BUILD_COMMAND,
} from "./workspacePackageBuildScript.js";

const execFileAsync = promisify(execFile);

/** Persisted on `Project.deliveryPolicy` */
export const POLICY_LAST_BUILD_KEY = "postCompletionWorkspaceLastBuild";
export const POLICY_AUTO_BUILD_STARTED_KEY = "postCompletionWorkspaceAutoBuildStartedAt";
export const POLICY_AUTO_BUILD_FINISHED_KEY = "postCompletionWorkspaceAutoBuildFinishedAt";
export const POLICY_PREVIEW_SERVER_KEY = "workspacePreviewServer";

export type WorkspaceLastBuildRecord = {
  at: string;
  ok: boolean;
  exitCode: number;
  stdoutTail: string;
  stderrTail: string;
  commandSummary: string;
  trigger: "post_completion_auto" | "manual";
};

export type WorkspacePreviewRecord = {
  pid: number;
  port: number;
  url: string;
  startedAt: string;
  command: string;
};

async function pathReadable(p: string): Promise<boolean> {
  try {
    await access(p, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

/** Resolved absolute dev workspace path, or null if unset / outside `SARVA_AGENT_WORKSPACE`. */
export async function getValidatedDevWorkspacePath(projectId: string, env: Env): Promise<string | null> {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { devWorkspacePath: true },
  });
  if (!project?.devWorkspacePath?.trim()) return null;
  const abs = resolve(project.devWorkspacePath.trim());
  if (!isDevWorkspacePathUnderAgentRoot(env, abs)) return null;
  return abs;
}

function tail(s: string, max = 6000): string {
  if (s.length <= max) return s;
  return `…${s.slice(-max)}`;
}

export type WorkspaceBuildOutcome =
  | (WorkspaceLastBuildRecord & { skippedReason?: undefined })
  | { ok: false; skippedReason: string; exitCode?: number; stderr?: string };

/**
 * Runs `npm install` (if needed) then `npm run build` under the project dev workspace on the API host.
 */
export async function runWorkspaceInstallAndBuild(
  projectId: string,
  env: Env,
  meta: {
    trigger: "post_completion_auto" | "manual";
    timeoutMs?: number;
    /** Invoked once immediately before `npm install` and/or `npm run build` (not called when verify is skipped up-front). */
    onBeforeLongRunningWork?: () => void | Promise<void>;
  }
): Promise<WorkspaceBuildOutcome> {
  const workspacePath = await getValidatedDevWorkspacePath(projectId, env);
  if (!workspacePath) {
    return { ok: false, skippedReason: "no_dev_workspace_or_path_not_allowed" };
  }
  const pkgPath = join(workspacePath, "package.json");
  if (!(await pathReadable(pkgPath))) {
    return { ok: false, skippedReason: "no_package_json" };
  }

  let pkg: { scripts?: Record<string, string> };
  try {
    pkg = JSON.parse(await readFile(pkgPath, "utf8")) as { scripts?: Record<string, string> };
  } catch {
    return { ok: false, skippedReason: "package_json_invalid" };
  }
  if (!pkg.scripts?.build?.trim()) {
    const ensured = await ensurePackageJsonBuildScript(pkgPath, workspacePath);
    if (!ensured.ok) {
      return { ok: false, skippedReason: ensured.skippedReason };
    }
    if (ensured.addedScript) {
      await appendProjectChatMessage({
        projectId,
        actorKind: "orchestrator",
        actorLabel: "Orchestrator",
        body: `**Dev workspace:** added missing \`scripts.build\` in \`package.json\`: \`${ensured.addedScript}\` (from config files, package dependencies, or Sarva’s default placeholder). Continuing with install/build.`,
        meta: { event: "delivery.workspace_package_build_script_added", command: ensured.addedScript },
      });
    }
    try {
      pkg = JSON.parse(await readFile(pkgPath, "utf8")) as { scripts?: Record<string, string> };
    } catch {
      return { ok: false, skippedReason: "package_json_invalid" };
    }
  }
  if (!pkg.scripts?.build?.trim()) {
    return { ok: false, skippedReason: "no_build_script" };
  }

  const buildCmd = pkg.scripts.build.trim();
  if (buildCmd === SARVA_PLACEHOLDER_BUILD_COMMAND) {
    await ensureSarvaPlaceholderBuildScriptFile(workspacePath);
  }

  const timeoutMs = meta.timeoutMs ?? Number(process.env.SARVA_WORKSPACE_BUILD_TIMEOUT_MS ?? 900_000);
  const nodeModules = join(workspacePath, "node_modules");
  const needInstall = !(await pathReadable(nodeModules));

  const installParts = needInstall ? "npm install --no-audit --no-fund && " : "";
  const commandSummary = `${installParts}npm run build`;

  if (meta.onBeforeLongRunningWork) {
    await meta.onBeforeLongRunningWork();
  }

  let combinedOut = "";
  let combinedErr = "";

  if (needInstall) {
    try {
      const r = await execFileAsync("npm", ["install", "--no-audit", "--no-fund"], {
        cwd: workspacePath,
        timeout: timeoutMs,
        maxBuffer: 12 * 1024 * 1024,
        env: { ...process.env, CI: "1" },
      });
      combinedOut += r.stdout?.toString() ?? "";
      combinedErr += r.stderr?.toString() ?? "";
    } catch (err) {
      const e = err as { code?: number; stdout?: Buffer; stderr?: Buffer };
      combinedOut += e.stdout?.toString() ?? "";
      combinedErr += e.stderr?.toString() ?? "";
      const exitCode = typeof e.code === "number" ? e.code : 1;
      const record: WorkspaceLastBuildRecord = {
        at: new Date().toISOString(),
        ok: false,
        exitCode,
        stdoutTail: tail(combinedOut),
        stderrTail: tail(combinedErr),
        commandSummary: "npm install …",
        trigger: meta.trigger,
      };
      await persistLastBuild(projectId, record);
      return record;
    }
  }

  try {
    const r = await execFileAsync("npm", ["run", "build"], {
      cwd: workspacePath,
      timeout: timeoutMs,
      maxBuffer: 12 * 1024 * 1024,
      env: { ...process.env, CI: "1" },
    });
    combinedOut += r.stdout?.toString() ?? "";
    combinedErr += r.stderr?.toString() ?? "";
    const record: WorkspaceLastBuildRecord = {
      at: new Date().toISOString(),
      ok: true,
      exitCode: 0,
      stdoutTail: tail(combinedOut),
      stderrTail: tail(combinedErr),
      commandSummary,
      trigger: meta.trigger,
    };
    await persistLastBuild(projectId, record);
    return record;
  } catch (err) {
    const e = err as { code?: number; stdout?: Buffer; stderr?: Buffer };
    combinedOut += e.stdout?.toString() ?? "";
    combinedErr += e.stderr?.toString() ?? "";
    const exitCode = typeof e.code === "number" ? e.code : 1;
    const record: WorkspaceLastBuildRecord = {
      at: new Date().toISOString(),
      ok: false,
      exitCode,
      stdoutTail: tail(combinedOut),
      stderrTail: tail(combinedErr),
      commandSummary,
      trigger: meta.trigger,
    };
    await persistLastBuild(projectId, record);
    return record;
  }
}

async function persistLastBuild(projectId: string, record: WorkspaceLastBuildRecord): Promise<void> {
  const project = await prisma.project.findUnique({ where: { id: projectId }, select: { deliveryPolicy: true } });
  if (!project) return;
  const pol = deliveryPolicyRecord(project.deliveryPolicy);
  pol[POLICY_LAST_BUILD_KEY] = record;
  await prisma.project.update({
    where: { id: projectId },
    data: { deliveryPolicy: pol as object },
  });
}

async function getFreePort(): Promise<number> {
  return new Promise((resolvePromise, reject) => {
    const srv = createServer();
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = addr && typeof addr === "object" ? addr.port : 0;
      srv.close((err) => {
        if (err) reject(err);
        else resolvePromise(port);
      });
    });
    srv.on("error", reject);
  });
}

/**
 * Picks preview: `npm run preview` if defined, else `vite preview`, else static `serve dist` when `dist/` exists.
 */
export async function startWorkspacePreviewServer(projectId: string, env: Env): Promise<
  | { ok: true; preview: WorkspacePreviewRecord }
  | { ok: false; message: string }
> {
  const workspacePath = await getValidatedDevWorkspacePath(projectId, env);
  if (!workspacePath) {
    return { ok: false, message: "No dev workspace or path not under SARVA agent workspace root." };
  }

  const project = await prisma.project.findUnique({ where: { id: projectId }, select: { deliveryPolicy: true } });
  const pol = deliveryPolicyRecord(project?.deliveryPolicy);
  const existing = pol[POLICY_PREVIEW_SERVER_KEY] as WorkspacePreviewRecord | undefined;
  if (existing?.pid) {
    try {
      process.kill(existing.pid, 0);
      return { ok: true, preview: existing };
    } catch {
      /* stale pid — replace below */
    }
  }

  const pkgPath = join(workspacePath, "package.json");
  const raw = await readFile(pkgPath, "utf8").catch(() => "");
  let pkg: {
    scripts?: Record<string, string>;
    devDependencies?: Record<string, string>;
    dependencies?: Record<string, string>;
  } = {};
  try {
    pkg = JSON.parse(raw) as typeof pkg;
  } catch {
    return { ok: false, message: "Invalid package.json in workspace." };
  }

  const port = await getFreePort();
  if (!port) return { ok: false, message: "Could not allocate a local TCP port." };

  let command: string;
  let args: string[];
  let displayCmd: string;

  if (pkg.scripts?.preview) {
    command = "npm";
    args = ["run", "preview", "--", "--host", "127.0.0.1", "--port", String(port)];
    displayCmd = `npm run preview -- --host 127.0.0.1 --port ${port}`;
  } else if (pkg.devDependencies?.vite || pkg.dependencies?.vite) {
    command = "npx";
    args = ["vite", "preview", "--host", "127.0.0.1", "--port", String(port), "--strictPort"];
    displayCmd = `npx vite preview --host 127.0.0.1 --port ${port}`;
  } else if (await pathReadable(join(workspacePath, "dist"))) {
    command = "npx";
    args = ["--yes", "serve", "dist", "-l", String(port), "-n"];
    displayCmd = `npx serve dist -l ${port}`;
  } else {
    return {
      ok: false,
      message:
        "No preview target: add a `preview` script, use Vite, or run **Verify build** so `dist/` exists for static serve.",
    };
  }

  const child = spawn(command, args, {
    cwd: workspacePath,
    detached: true,
    stdio: "ignore",
    env: { ...process.env, BROWSER: "none", HOST: "127.0.0.1" },
  });
  child.unref();
  const pid = child.pid;
  if (!pid) {
    return { ok: false, message: "Failed to spawn preview process." };
  }

  const url = `http://127.0.0.1:${port}`;
  const preview: WorkspacePreviewRecord = {
    pid,
    port,
    url,
    startedAt: new Date().toISOString(),
    command: displayCmd,
  };

  const nextPol = deliveryPolicyRecord(project?.deliveryPolicy);
  nextPol[POLICY_PREVIEW_SERVER_KEY] = preview;
  await prisma.project.update({
    where: { id: projectId },
    data: { deliveryPolicy: nextPol as object },
  });

  return { ok: true, preview };
}

export async function stopWorkspacePreviewServer(projectId: string): Promise<{ ok: boolean; message: string }> {
  const project = await prisma.project.findUnique({ where: { id: projectId }, select: { deliveryPolicy: true } });
  if (!project) return { ok: false, message: "Project not found." };
  const pol = deliveryPolicyRecord(project.deliveryPolicy);
  const preview = pol[POLICY_PREVIEW_SERVER_KEY] as WorkspacePreviewRecord | undefined;
  if (!preview?.pid) {
    return { ok: false, message: "No preview server recorded for this project." };
  }
  try {
    process.kill(preview.pid, "SIGTERM");
  } catch {
    /* ignore */
  }
  delete pol[POLICY_PREVIEW_SERVER_KEY];
  await prisma.project.update({
    where: { id: projectId },
    data: { deliveryPolicy: pol as object },
  });
  return { ok: true, message: "Stopped preview server." };
}

/**
 * Fires once after all board tasks are `done`: runs install+build and posts Chat lines (orchestrator “judge”).
 */
export function maybeSchedulePostCompletionAutoWorkspaceBuild(projectId: string, env: Env): void {
  void (async () => {
    const project = await prisma.project.findUnique({
      where: { id: projectId },
      select: { deliveryPolicy: true, devWorkspacePath: true },
    });
    if (!project?.devWorkspacePath?.trim()) return;

    const pol0 = deliveryPolicyRecord(project.deliveryPolicy);
    if (pol0[POLICY_AUTO_BUILD_FINISHED_KEY]) return;
    if (pol0[POLICY_AUTO_BUILD_STARTED_KEY]) return;

    const pol = { ...pol0, [POLICY_AUTO_BUILD_STARTED_KEY]: new Date().toISOString() };
    await prisma.project.update({
      where: { id: projectId },
      data: { deliveryPolicy: pol as object },
    });

    await appendProjectChatMessage({
      projectId,
      actorKind: "orchestrator",
      actorLabel: "Orchestrator",
      body: `**Post-completion verify:** running \`npm install\` (if needed) and \`npm run build\` in the dev workspace to confirm the implementation builds.`,
      meta: { event: "delivery.workspace_verify_build_start", path: project.devWorkspacePath },
    });

    const result = await runWorkspaceInstallAndBuild(projectId, env, { trigger: "post_completion_auto" });

    const pol2 = deliveryPolicyRecord(
      (await prisma.project.findUnique({ where: { id: projectId }, select: { deliveryPolicy: true } }))?.deliveryPolicy
    );
    pol2[POLICY_AUTO_BUILD_FINISHED_KEY] = new Date().toISOString();
    await prisma.project.update({
      where: { id: projectId },
      data: { deliveryPolicy: pol2 as object },
    });

    if ("skippedReason" in result && result.skippedReason) {
      await appendProjectChatMessage({
        projectId,
        actorKind: "orchestrator",
        actorLabel: "Orchestrator",
        body: `**Post-completion verify skipped:** ${result.skippedReason.replace(/_/g, " ")}.`,
        meta: { event: "delivery.workspace_verify_build_skipped", reason: result.skippedReason },
      });
      return;
    }

    if (!result.ok) {
      await appendProjectChatMessage({
        projectId,
        actorKind: "orchestrator",
        actorLabel: "Orchestrator",
        body: `**Post-completion verify failed** (exit ${result.exitCode}). Check stderr in Chat metadata or run **Verify build** again on the Board after fixing the workspace.`,
        meta: {
          event: "delivery.workspace_verify_build_failed",
          exitCode: result.exitCode,
          stderrTail: "stderrTail" in result ? result.stderrTail : undefined,
        },
      });
      return;
    }

    await appendProjectChatMessage({
      projectId,
      actorKind: "orchestrator",
      actorLabel: "Orchestrator",
      body: `**Post-completion verify passed:** \`npm run build\` succeeded in the dev workspace. Use **Start preview server** on the Board when you want a local URL.`,
      meta: { event: "delivery.workspace_verify_build_ok" },
    });
  })().catch(() => undefined);
}

export function readWorkspaceDeliveryExtras(policy: unknown): {
  workspaceLastBuild: WorkspaceLastBuildRecord | null;
  workspacePreview: WorkspacePreviewRecord | null;
  postCompletionAutoWorkspaceBuildFinishedAt: string | null;
} {
  const pol = deliveryPolicyRecord(policy);
  const last = pol[POLICY_LAST_BUILD_KEY] as WorkspaceLastBuildRecord | undefined;
  const preview = pol[POLICY_PREVIEW_SERVER_KEY] as WorkspacePreviewRecord | undefined;
  return {
    workspaceLastBuild: last?.at ? last : null,
    workspacePreview: preview?.url ? preview : null,
    postCompletionAutoWorkspaceBuildFinishedAt:
      typeof pol[POLICY_AUTO_BUILD_FINISHED_KEY] === "string" ? (pol[POLICY_AUTO_BUILD_FINISHED_KEY] as string) : null,
  };
}
