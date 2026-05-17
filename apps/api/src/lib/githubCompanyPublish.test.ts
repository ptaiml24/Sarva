import { describe, expect, it } from "vitest";
import { githubRepoSlug } from "./githubCompanyPublish.js";

describe("githubRepoSlug", () => {
  it("slugifies project names for GitHub repo names", () => {
    expect(githubRepoSlug("Project A")).toBe("project-a");
    expect(githubRepoSlug("Tetris!!!")).toBe("tetris");
  });
});
