import type { Env } from "../config/env.js";
import { prisma } from "../lib/prisma.js";

export type LinkBranchResult =
  | { ok: true; branch: string; linkedPrUrl: string | null }
  | {
      ok: false;
      httpStatus: number;
      code: string;
      message: string;
      detail?: string;
    };

/**
 * When `INTEGRATION_MCP_GIT=live`, calls `GIT_MCP_ENDPOINT` (see TSD §8.1).
 * No synthetic GitHub URLs — integration off means no persisted branch/PR from this path.
 */
export async function linkBranchForTask(taskId: string, env: Env): Promise<LinkBranchResult> {
  if (env.INTEGRATION_MCP_GIT === "off") {
    return {
      ok: false,
      httpStatus: 501,
      code: "INTEGRATION_MCP_GIT_OFF",
      message:
        "MCP Git integration is off. Set INTEGRATION_MCP_GIT=live and GIT_MCP_ENDPOINT to your gateway. With integration off, branch/PR are not set by this API (see TSD §8).",
    };
  }

  if (!env.GIT_MCP_ENDPOINT) {
    return {
      ok: false,
      httpStatus: 503,
      code: "GIT_MCP_ENDPOINT_REQUIRED",
      message: "GIT_MCP_ENDPOINT must be set when INTEGRATION_MCP_GIT=live.",
    };
  }

  const task = await prisma.task.findUnique({
    where: { id: taskId },
    include: { project: { include: { repoScope: true } } },
  });

  if (!task) {
    return { ok: false, httpStatus: 404, code: "NOT_FOUND", message: "task not found" };
  }

  const cloneUrl = task.project.repoScope?.cloneUrl;
  if (!cloneUrl) {
    return {
      ok: false,
      httpStatus: 400,
      code: "NO_CLONE_URL",
      message: "Set repository_scope.clone_url for the project (PATCH repository scope via API or DB).",
    };
  }

  const branch = `feature/task-${taskId}`;
  const base = env.GIT_MCP_ENDPOINT.replace(/\/$/, "");
  const url = `${base}/link-task-branch`;

  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ taskId, cloneUrl, branch }),
    });

    const text = await resp.text();
    if (!resp.ok) {
      return {
        ok: false,
        httpStatus: 502,
        code: "MCP_GATEWAY_ERROR",
        message: `MCP gateway returned ${resp.status}`,
        detail: text.slice(0, 2000),
      };
    }

    let data: { branch: string; pullRequestUrl?: string | null };
    try {
      data = JSON.parse(text) as { branch: string; pullRequestUrl?: string | null };
    } catch {
      return {
        ok: false,
        httpStatus: 502,
        code: "MCP_INVALID_JSON",
        message: "MCP gateway response was not valid JSON",
        detail: text.slice(0, 500),
      };
    }

    if (!data.branch || typeof data.branch !== "string") {
      return {
        ok: false,
        httpStatus: 502,
        code: "MCP_MISSING_BRANCH",
        message: "MCP gateway JSON must include string `branch`",
      };
    }

    const linkedPrUrl = data.pullRequestUrl ?? null;

    await prisma.task.update({
      where: { id: taskId },
      data: { linkedBranch: data.branch, linkedPrUrl, version: { increment: 1 } },
    });

    return { ok: true, branch: data.branch, linkedPrUrl };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      ok: false,
      httpStatus: 502,
      code: "MCP_FETCH_FAILED",
      message: "Failed to reach MCP Git gateway",
      detail: msg,
    };
  }
}
