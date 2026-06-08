import { describe, expect, it } from "vitest";
import { extractCursorModelRows } from "./cursorModelDiscovery.js";

describe("extractCursorModelRows", () => {
  it("reads items array from Cursor list response", () => {
    const rows = extractCursorModelRows({
      items: [{ modelId: "composer-2.5", displayName: "Composer 2.5" }],
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].modelId).toBe("composer-2.5");
  });

  it("reads bare array", () => {
    const rows = extractCursorModelRows([{ id: "gpt-5.2", displayName: "GPT 5.2" }]);
    expect(rows[0].id).toBe("gpt-5.2");
  });

  it("reads OpenAI-style data array", () => {
    const rows = extractCursorModelRows({ object: "list", data: [{ id: "auto" }] });
    expect(rows[0].id).toBe("auto");
  });

  it("returns empty for unknown shapes", () => {
    expect(extractCursorModelRows(undefined)).toEqual([]);
    expect(extractCursorModelRows({})).toEqual([]);
  });
});
