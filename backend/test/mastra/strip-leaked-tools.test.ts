import { describe, it, expect } from "vitest";
import { stripLeakedToolCalls } from "../../src/mastra/strip-leaked-tools.js";

describe("stripLeakedToolCalls", () => {
  it("strips inline tool-call lines (brace + paren styles)", () => {
    const r = stripLeakedToolCalls(
      ['Here you go:', 'kufar_search{"q":"x"}', 'web_search(query="minsk")', 'Done.'].join("\n"),
    );
    expect(r.stripped).toBe(2);
    expect(r.text).not.toContain("kufar_search");
    expect(r.text).not.toContain("web_search(");
    expect(r.text).toContain("Here you go:");
    expect(r.text).toContain("Done.");
  });

  it("strips XML function_calls / tool_call blocks", () => {
    const r = stripLeakedToolCalls(
      "before <function_calls><invoke name='x'></invoke></function_calls> after",
    );
    expect(r.stripped).toBeGreaterThanOrEqual(1);
    expect(r.text).not.toContain("function_calls");
    expect(r.text).toContain("before");
    expect(r.text).toContain("after");
  });

  it("returns empty text when only a tool-call is present", () => {
    const r = stripLeakedToolCalls('web_search(query="x")');
    expect(r.text).toBe("");
    expect(r.stripped).toBe(1);
  });

  it("leaves normal prose untouched", () => {
    const r = stripLeakedToolCalls("Just a normal answer with no tools.");
    expect(r.stripped).toBe(0);
    expect(r.text).toBe("Just a normal answer with no tools.");
  });
});
