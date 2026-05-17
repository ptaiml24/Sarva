import { describe, it, expect } from "vitest";
import { normalizeBacklogItems } from "./jsonBacklog.js";

describe("normalizeBacklogItems", () => {
  it("parses dependsOnTitles", () => {
    const items = normalizeBacklogItems([
      { title: "A", description: "x", phase: 0 },
      { title: "B", description: "y", phase: 0, dependsOnTitles: ["A"] },
    ]);
    expect(items).toHaveLength(2);
    expect(items[0]!.dependsOnTitles).toEqual([]);
    expect(items[1]!.dependsOnTitles).toEqual(["A"]);
  });

  it("dedupes dependsOnTitles", () => {
    const items = normalizeBacklogItems([
      { title: "A", description: "", dependsOnTitles: ["B", " B ", "B"] },
      { title: "B", description: "" },
    ]);
    expect(items[0]!.dependsOnTitles).toEqual(["B"]);
  });
});
