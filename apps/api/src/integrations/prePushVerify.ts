import type { Env } from "../config/env.js";
import { prisma } from "../lib/prisma.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

type DeliveryPolicy = {
  prePushVerify?: {
    enabled?: boolean;
    commands?: string[];
  };
};

/**
 * FRD §4.1.4 — workspace-local verify before push; stub runs echo when no commands.
 */
export async function runPrePushVerify(projectId: string, _env: Env) {
  const project = await prisma.project.findUnique({ where: { id: projectId } });
  if (!project) {
    return { ok: false, error: "project_not_found" as const };
  }

  const policy = project.deliveryPolicy as DeliveryPolicy | null;
  const cfg = policy?.prePushVerify;
  if (!cfg?.enabled) {
    return { ok: true, skipped: true as const, reason: "pre_push_verify_disabled" };
  }

  const commands = cfg.commands?.length ? cfg.commands : ["echo", "sarva-pre-push-verify-placeholder"];
  const timeoutMs = Number(process.env.PRE_PUSH_VERIFY_TIMEOUT_MS ?? 1_200_000);
  const results: { cmd: string; exitCode: number; stdout: string; stderr: string }[] = [];

  for (const line of commands) {
    const parts = line.trim().split(/\s+/);
    const [cmd, ...args] = parts;
    try {
      const { stdout, stderr } = await execFileAsync(cmd, args, {
        timeout: timeoutMs,
        env: { ...process.env, CI: "1" },
      });
      results.push({ cmd: line, exitCode: 0, stdout: stdout.toString(), stderr: stderr.toString() });
    } catch (err) {
      const code = err && typeof err === "object" && "code" in err ? Number((err as { code?: number }).code) : 1;
      return {
        ok: false,
        failedCommand: line,
        exitCode: code,
        results,
      };
    }
  }

  return { ok: true, results };
}
