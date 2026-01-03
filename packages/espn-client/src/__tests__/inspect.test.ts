import { summarizePayload } from "../inspect.js";

describe("summarizePayload", () => {
  it("returns top-level keys and byte size for objects", () => {
    const payload = { a: 1, b: { nested: true } };
    const summary = summarizePayload(payload);

    expect(summary.topLevelKeys).toEqual(["a", "b"]);
    expect(summary.byteSize).toBeGreaterThan(0);
  });

  it("returns empty keys for non-objects", () => {
    const summary = summarizePayload("not an object");
    expect(summary.topLevelKeys).toEqual([]);
  });
});
