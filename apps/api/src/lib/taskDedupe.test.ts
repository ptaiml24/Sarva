import { describe, it, expect } from "vitest";
import { areDuplicateTaskTitles, normalizeTaskTitleForDedupe } from "../lib/taskDedupe.js";

describe("taskDedupe title matching", () => {
  it("treats near-duplicate setup / environment intents as duplicates", () => {
    expect(areDuplicateTaskTitles("Setup Project environment", "Environment setup")).toBe(true);
    expect(areDuplicateTaskTitles("Project environment setup checklist", "Environment setup")).toBe(true);
  });

  it("does not merge unrelated backlog items", () => {
    expect(areDuplicateTaskTitles("Implement login API", "Add logging middleware")).toBe(false);
    expect(areDuplicateTaskTitles("QA: smoke test", "Write unit tests")).toBe(false);
  });

  it("normalize stable for punctuation spacing", () => {
    expect(normalizeTaskTitleForDedupe("  Foo — Bar!!!  ")).toBe("foo bar");
  });
});
