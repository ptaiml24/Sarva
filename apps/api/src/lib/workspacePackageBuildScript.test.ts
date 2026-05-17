import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ensurePackageJsonBuildScript,
  inferBuildScriptForPackage,
  SARVA_PLACEHOLDER_BUILD_COMMAND,
} from "./workspacePackageBuildScript.js";

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) {
    await rm(d, { recursive: true, force: true }).catch(() => undefined);
  }
});

async function tempWorkspace(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "sarva-ws-pkg-"));
  dirs.push(d);
  return d;
}

describe("inferBuildScriptForPackage", () => {
  it("returns vite build when vite is present", async () => {
    expect(await inferBuildScriptForPackage({ devDependencies: { vite: "^5.0.0" } }, "/tmp")).toBe(
      "vite build"
    );
  });

  it("returns next build when next is present", async () => {
    expect(await inferBuildScriptForPackage({ dependencies: { next: "14" } }, "/tmp")).toBe("next build");
  });

  it("returns tsc when typescript and tsconfig.json exist", async () => {
    const dir = await tempWorkspace();
    await writeFile(join(dir, "tsconfig.json"), "{}", "utf8");
    expect(await inferBuildScriptForPackage({ devDependencies: { typescript: "5" } }, dir)).toBe(
      "tsc -p tsconfig.json"
    );
  });

  it("returns vite build when vite.config exists without vite dep", async () => {
    const dir = await tempWorkspace();
    await writeFile(join(dir, "vite.config.ts"), "export default {}", "utf8");
    expect(await inferBuildScriptForPackage({ name: "x" }, dir)).toBe("vite build");
  });

  it("returns Sarva placeholder when nothing else matches", async () => {
    expect(await inferBuildScriptForPackage({ dependencies: { lodash: "4" } }, "/tmp")).toBe(
      SARVA_PLACEHOLDER_BUILD_COMMAND
    );
  });
});

describe("ensurePackageJsonBuildScript", () => {
  it("writes scripts.build when missing and vite is listed", async () => {
    const dir = await tempWorkspace();
    const pkgPath = join(dir, "package.json");
    await writeFile(
      pkgPath,
      JSON.stringify({ name: "x", devDependencies: { vite: "^5.0.0" }, scripts: { dev: "vite" } }),
      "utf8"
    );
    const r = await ensurePackageJsonBuildScript(pkgPath, dir);
    expect(r).toEqual({ ok: true, addedScript: "vite build" });
    const parsed = JSON.parse(await readFile(pkgPath, "utf8")) as { scripts: { build: string; dev: string } };
    expect(parsed.scripts.build).toBe("vite build");
    expect(parsed.scripts.dev).toBe("vite");
  });

  it("returns addedScript null when build already exists", async () => {
    const dir = await tempWorkspace();
    const pkgPath = join(dir, "package.json");
    await writeFile(
      pkgPath,
      JSON.stringify({ scripts: { build: "echo ok" } }),
      "utf8"
    );
    const r = await ensurePackageJsonBuildScript(pkgPath, dir);
    expect(r).toEqual({ ok: true, addedScript: null });
  });

  it("uses placeholder and writes helper script for bare package", async () => {
    const dir = await tempWorkspace();
    const pkgPath = join(dir, "package.json");
    await writeFile(pkgPath, JSON.stringify({ name: "bare" }), "utf8");
    const r = await ensurePackageJsonBuildScript(pkgPath, dir);
    expect(r).toEqual({ ok: true, addedScript: SARVA_PLACEHOLDER_BUILD_COMMAND });
    const helper = join(dir, "scripts", "sarva-placeholder-build.cjs");
    const h = await readFile(helper, "utf8");
    expect(h).toContain("copyDirRecursive");
    expect(h).toContain('"js"');
    const parsed = JSON.parse(await readFile(pkgPath, "utf8")) as { scripts: { build: string } };
    expect(parsed.scripts.build).toBe(SARVA_PLACEHOLDER_BUILD_COMMAND);
  });
});
