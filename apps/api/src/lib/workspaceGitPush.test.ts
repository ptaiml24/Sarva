import { describe, expect, it } from "vitest";
import type { Env } from "../config/env.js";
import { runWorkspaceGitPush } from "./workspaceGitPush.js";

describe("runWorkspaceGitPush", () => {
  it("returns GIT_PUSH_DISABLED when env flag is off", async () => {
    const env = { SARVA_WORKSPACE_GIT_PUSH: "false" } as unknown as Env;
    const r = await runWorkspaceGitPush("any-project-id", env, {});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("GIT_PUSH_DISABLED");
  });
});
