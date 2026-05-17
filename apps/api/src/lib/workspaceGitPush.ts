import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Env } from "../config/env.js";
import { getValidatedDevWorkspacePath } from "./workspaceBuildVerify.js";

const execFileAsync = promisify(execFile);

const GIT_TIMEOUT_MS = 180_000;

function tail(s: string, max = 4000): string {
  if (s.length <= max) return s;
  return `…${s.slice(-max)}`;
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export type WorkspaceGitPushResult =
  | {
      ok: true;
      branch: string;
      /** `committed` when there were unstaged/uncommitted changes; `pushed` when push advanced remote; `synced` when nothing to commit or already up to date after push. */
      outcome: "committed_and_pushed" | "pushed" | "synced";
      detail: string;
    }
  | { ok: false; code: string; message: string; detail?: string };

/**
 * `git add -A`, `git commit` (if needed), `git push -u origin <branch>` in the project dev workspace.
 * Opt-in: `SARVA_WORKSPACE_GIT_PUSH=true`. Auth is whatever the API host provides to git (SSH agent, credential helper, etc.).
 */
export async function runWorkspaceGitPush(
  projectId: string,
  env: Env,
  opts: { commitMessage?: string }
): Promise<WorkspaceGitPushResult> {
  if (env.SARVA_WORKSPACE_GIT_PUSH !== "true") {
    return {
      ok: false,
      code: "GIT_PUSH_DISABLED",
      message:
        "Workspace git push is disabled. Set SARVA_WORKSPACE_GIT_PUSH=true on the API host and ensure git credentials work there (SSH key or credential helper for GitHub).",
    };
  }

  const cwd = await getValidatedDevWorkspacePath(projectId, env);
  if (!cwd) {
    return {
      ok: false,
      code: "NO_WORKSPACE",
      message: "No dev workspace or path is not under SARVA_AGENT_WORKSPACE.",
    };
  }

  if (!(await pathExists(join(cwd, ".git")))) {
    return {
      ok: false,
      code: "NOT_A_GIT_REPO",
      message:
        "This dev workspace is not a git repository. On the API host: clone your GitHub repo into this folder (Intake clone URL), or run git init && git remote add origin <url> && git fetch && git checkout -b <branch>.",
    };
  }

  const runGit = async (args: string[]): Promise<{ code: number; stdout: string; stderr: string }> => {
    try {
      const r = await execFileAsync("git", args, {
        cwd,
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: 12 * 1024 * 1024,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      });
      return { code: 0, stdout: String(r.stdout ?? ""), stderr: String(r.stderr ?? "") };
    } catch (e) {
      const err = e as { code?: number; stdout?: Buffer; stderr?: Buffer };
      return {
        code: typeof err.code === "number" ? err.code : 1,
        stdout: err.stdout?.toString() ?? "",
        stderr: err.stderr?.toString() ?? "",
      };
    }
  };

  const inside = await runGit(["rev-parse", "--is-inside-work-tree"]);
  if (inside.code !== 0 || !inside.stdout.trim().includes("true")) {
    return {
      ok: false,
      code: "GIT_ERROR",
      message: "git rev-parse failed in dev workspace.",
      detail: tail(inside.stderr + inside.stdout),
    };
  }

  const origin = await runGit(["remote", "get-url", "origin"]);
  if (origin.code !== 0) {
    return {
      ok: false,
      code: "NO_ORIGIN",
      message: 'No git remote named "origin". Add: git remote add origin <your-github-repo-url>',
      detail: tail(origin.stderr),
    };
  }

  const br = await runGit(["branch", "--show-current"]);
  const branch = br.stdout.trim();
  if (!branch) {
    return {
      ok: false,
      code: "DETACHED_HEAD",
      message: "Checkout a branch before pushing (e.g. git checkout -b delivery-work).",
      detail: tail(br.stderr),
    };
  }

  const status = await runGit(["status", "--porcelain"]);
  const dirty = status.stdout.trim().length > 0;

  const authorName = process.env.SARVA_GIT_AUTHOR_NAME?.trim() || "Sarva";
  const authorEmail = process.env.SARVA_GIT_AUTHOR_EMAIL?.trim() || "sarva@users.noreply.localhost";
  const defaultMsg =
    opts.commitMessage?.trim() ||
    `Sarva delivery workspace snapshot (${new Date().toISOString().slice(0, 19)}Z)`;

  let committed = false;
  if (dirty) {
    const add = await runGit(["add", "-A"]);
    if (add.code !== 0) {
      return {
        ok: false,
        code: "GIT_ADD_FAILED",
        message: "git add failed.",
        detail: tail(add.stderr + add.stdout),
      };
    }
    const commit = await runGit([
      "-c",
      `user.name=${authorName}`,
      "-c",
      `user.email=${authorEmail}`,
      "commit",
      "-m",
      defaultMsg,
    ]);
    if (commit.code !== 0) {
      return {
        ok: false,
        code: "GIT_COMMIT_FAILED",
        message: "git commit failed (nothing to commit after add, or hook failure).",
        detail: tail(commit.stderr + commit.stdout),
      };
    }
    committed = true;
  }

  const push = await runGit(["push", "-u", "origin", branch]);
  if (push.code !== 0) {
    return {
      ok: false,
      code: "GIT_PUSH_FAILED",
      message: `git push failed for branch "${branch}".`,
      detail: tail(push.stderr + push.stdout),
    };
  }

  const combined = push.stdout + push.stderr;
  const upToDate = /Everything up-to-date|already up to date/i.test(combined);
  const outcome =
    committed ? "committed_and_pushed"
    : upToDate ? "synced"
    : "pushed";

  return {
    ok: true,
    branch,
    outcome,
    detail: tail(combined.trim() || (committed ? "Committed and pushed." : "Push completed.")),
  };
}
