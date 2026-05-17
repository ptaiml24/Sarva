import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import type { Env } from "../config/env.js";
import { prisma } from "./prisma.js";
import { getValidatedDevWorkspacePath } from "./workspaceBuildVerify.js";

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT_MS = 300_000;

function tail(s: string, max = 4000): string {
  if (s.length <= max) return s;
  return `…${s.slice(-max)}`;
}

/** GitHub allows [A-Za-z0-9._-]; max 100 chars. */
export function githubRepoSlug(projectName: string): string {
  const s = projectName
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-")
    .slice(0, 100);
  return s || "sarva-project";
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function runGit(
  cwd: string,
  args: string[]
): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const r = await execFileAsync("git", args, {
      cwd,
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: 20 * 1024 * 1024,
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
}

type CreateRepoResponse = {
  name: string;
  clone_url: string;
  html_url: string;
  message?: string;
  errors?: unknown;
};

async function githubCreateRepository(params: {
  pat: string;
  ownerLogin: string;
  isOrg: boolean;
  repoName: string;
  isPrivate: boolean;
  description: string;
}): Promise<{ ok: true; data: CreateRepoResponse } | { ok: false; status: number; body: string }> {
  const path = params.isOrg ? `orgs/${params.ownerLogin}/repos` : "user/repos";
  const url = `https://api.github.com/${path}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${params.pat}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      name: params.repoName,
      private: params.isPrivate,
      description: params.description.slice(0, 350),
      auto_init: false,
    }),
  });
  const text = await res.text();
  if (!res.ok) {
    return { ok: false, status: res.status, body: text.slice(0, 8000) };
  }
  try {
    const data = JSON.parse(text) as CreateRepoResponse;
    return { ok: true, data };
  } catch {
    return { ok: false, status: 502, body: "Invalid JSON from GitHub API" };
  }
}

export type GithubPublishResult =
  | {
      ok: true;
      repoName: string;
      htmlUrl: string;
      cloneUrl: string;
      detail: string;
    }
  | { ok: false; code: string; message: string; detail?: string };

/**
 * Creates a new GitHub repository under the company-configured owner, then `git init` (if needed),
 * commit, push from the project dev workspace, and updates `repository_scope.clone_url`.
 */
export async function publishProjectDevWorkspaceToGithub(
  projectId: string,
  env: Env,
  opts: { isPublic?: boolean; repoNameOverride?: string }
): Promise<GithubPublishResult> {
  const company = await prisma.company.findFirst({
    select: {
      githubPat: true,
      githubOwnerLogin: true,
      githubOwnerIsOrganization: true,
      githubReposPrivateByDefault: true,
    },
  });
  if (!company) {
    return {
      ok: false,
      code: "GITHUB_NOT_CONFIGURED",
      message:
        "GitHub publishing is not configured. An admin must set owner and token under Admin → GitHub publishing.",
    };
  }
  const pat = company.githubPat?.trim();
  const owner = company.githubOwnerLogin?.trim();
  if (!pat || !owner) {
    return {
      ok: false,
      code: "GITHUB_NOT_CONFIGURED",
      message:
        "GitHub publishing is not configured. An admin must set owner and token under Admin → GitHub publishing.",
    };
  }

  const isOrg = Boolean(company.githubOwnerIsOrganization);
  const defaultPrivate = company.githubReposPrivateByDefault !== false;
  const isPrivate = opts.isPublic === true ? false : defaultPrivate;

  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { name: true },
  });
  if (!project) {
    return { ok: false, code: "NOT_FOUND", message: "Project not found." };
  }

  const cwd = await getValidatedDevWorkspacePath(projectId, env);
  if (!cwd) {
    return {
      ok: false,
      code: "NO_WORKSPACE",
      message: "No dev workspace or path is not under SARVA_AGENT_WORKSPACE.",
    };
  }

  const gitDir = join(cwd, ".git");
  const hasGit = await pathExists(gitDir);
  if (hasGit) {
    const originProbe = await runGit(cwd, ["remote", "get-url", "origin"]);
    if (originProbe.code === 0 && originProbe.stdout.trim()) {
      return {
        ok: false,
        code: "GIT_ORIGIN_EXISTS",
        message:
          "This workspace already has a git remote named origin. Remove it or use **Push to GitHub** to push to the existing remote. Publish is only for workspaces without origin yet.",
        detail: originProbe.stdout.trim(),
      };
    }
  }

  let baseName = (opts.repoNameOverride?.trim() || githubRepoSlug(project.name)).slice(0, 100);
  if (!baseName) baseName = "sarva-project";

  let created: CreateRepoResponse | null = null;
  let lastErr = "";
  for (let attempt = 0; attempt < 4; attempt++) {
    const repoName = attempt === 0 ? baseName : `${baseName}-sarva-${attempt}`.slice(0, 100);
    const cr = await githubCreateRepository({
      pat,
      ownerLogin: owner,
      isOrg,
      repoName,
      isPrivate,
      description: `Sarva project: ${project.name}`,
    });
    if (cr.ok) {
      created = cr.data;
      baseName = repoName;
      break;
    }
    lastErr = cr.body;
    if (cr.status !== 422) {
      return {
        ok: false,
        code: "GITHUB_API_ERROR",
        message: `GitHub API returned ${cr.status}.`,
        detail: tail(cr.body),
      };
    }
  }
  if (!created?.clone_url) {
    return {
      ok: false,
      code: "GITHUB_CREATE_FAILED",
      message: "Could not create a unique repository name on GitHub.",
      detail: tail(lastErr),
    };
  }

  const authorName = process.env.SARVA_GIT_AUTHOR_NAME?.trim() || "Sarva";
  const authorEmail = process.env.SARVA_GIT_AUTHOR_EMAIL?.trim() || "sarva@users.noreply.localhost";
  const commitMsg = `Initial publish from Sarva (${project.name})`;

  if (!hasGit) {
    const ini = await runGit(cwd, ["init"]);
    if (ini.code !== 0) {
      return {
        ok: false,
        code: "GIT_INIT_FAILED",
        message: "git init failed in dev workspace.",
        detail: tail(ini.stderr + ini.stdout),
      };
    }
  }

  const add = await runGit(cwd, ["add", "-A"]);
  if (add.code !== 0) {
    return {
      ok: false,
      code: "GIT_ADD_FAILED",
      message: "git add failed.",
      detail: tail(add.stderr),
    };
  }

  const por = await runGit(cwd, ["status", "--porcelain"]);
  const commitArgs = [
    "-c",
    `user.name=${authorName}`,
    "-c",
    `user.email=${authorEmail}`,
    "commit",
    "-m",
    commitMsg,
  ];
  if (!por.stdout.trim()) {
    commitArgs.push("--allow-empty");
  }
  const com = await runGit(cwd, commitArgs);
  if (com.code !== 0) {
    return {
      ok: false,
      code: "GIT_COMMIT_FAILED",
      message: "git commit failed.",
      detail: tail(com.stderr + com.stdout),
    };
  }

  const main = await runGit(cwd, ["branch", "-M", "main"]);
  if (main.code !== 0) {
    return {
      ok: false,
      code: "GIT_BRANCH_FAILED",
      message: "Could not rename branch to main.",
      detail: tail(main.stderr),
    };
  }

  const safePat = encodeURIComponent(pat);
  const authedRemote = `https://x-access-token:${safePat}@github.com/${owner}/${baseName}.git`;
  const addRemote = await runGit(cwd, ["remote", "add", "origin", authedRemote]);
  if (addRemote.code !== 0) {
    return {
      ok: false,
      code: "GIT_REMOTE_FAILED",
      message: "git remote add failed.",
      detail: tail(addRemote.stderr + addRemote.stdout),
    };
  }

  const push = await runGit(cwd, ["push", "-u", "origin", "main"]);
  if (push.code !== 0) {
    return {
      ok: false,
      code: "GIT_PUSH_FAILED",
      message: "git push to the new GitHub repository failed.",
      detail: tail(push.stderr + push.stdout),
    };
  }

  const cleanRemote = created.clone_url;
  await runGit(cwd, ["remote", "set-url", "origin", cleanRemote]);

  await prisma.repositoryScope.upsert({
    where: { projectId },
    create: {
      projectId,
      cloneUrl: cleanRemote,
      branchDefault: "main",
    },
    update: {
      cloneUrl: cleanRemote,
      branchDefault: "main",
    },
  });

  return {
    ok: true,
    repoName: baseName,
    htmlUrl: created.html_url,
    cloneUrl: cleanRemote,
    detail: `Repository ${owner}/${baseName} is ${isPrivate ? "private" : "public"}. Intake clone URL was updated.`,
  };
}
