import { describe, it, expect } from "vitest";
import { splitMessage } from "../../src/telegram/format.js";

describe("splitMessage", () => {
  it("returns [] for empty input", () => {
    expect(splitMessage("")).toEqual([]);
  });

  it("returns a single chunk when under the limit", () => {
    expect(splitMessage("hello", 4096)).toEqual(["hello"]);
  });

  it("splits on a paragraph boundary", () => {
    const out = splitMessage("para1 word\n\n" + "x".repeat(30), 15);
    expect(out).toEqual(["para1 word", "x".repeat(15), "x".repeat(15)]);
    for (const c of out) expect([...c].length).toBeLessThanOrEqual(15);
  });

  it("splits on a word boundary when no newline is available", () => {
    const out = splitMessage("alpha beta gamma delta", 12);
    for (const c of out) expect([...c].length).toBeLessThanOrEqual(12);
    expect(out.join(" ")).toBe("alpha beta gamma delta");
  });

  it("hard-cuts a single oversized token", () => {
    const out = splitMessage("a".repeat(20), 15);
    expect(out).toEqual(["a".repeat(15), "a".repeat(5)]);
  });

  it("counts by code points so multi-byte chars are not mis-split", () => {
    const out = splitMessage("я".repeat(20), 15);
    expect(out[0]!).toBe("я".repeat(15));
    expect([...out[0]!].length).toBe(15);
  });
});
