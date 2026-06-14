import { describe, it, expect } from "vitest";
import { toTelegramMarkdown, splitMessage } from "../../src/telegram/format.js";

describe("toTelegramMarkdown", () => {
  it("converts **bold** to *bold*", () => {
    expect(toTelegramMarkdown("**hi** there")).toBe("*hi* there");
  });

  it("renders headings as bold lines without '#'", () => {
    expect(toTelegramMarkdown("# Title\n\nbody")).toBe("*Title*\n\nbody");
  });

  it("strips italics to plain text (Go parity)", () => {
    expect(toTelegramMarkdown("an *word* here")).toBe("an word here");
  });

  it("keeps inline code verbatim (no escaping of underscores/dots inside)", () => {
    expect(toTelegramMarkdown("use `x_y.z` now")).toBe("use `x_y.z` now");
  });

  it("escapes backslash and backtick inside inline code", () => {
    // input `a\b`  →  output `a\\b`
    expect(toTelegramMarkdown("`a\\b`")).toBe("`a\\\\b`");
  });

  it("keeps fenced code blocks with their language tag", () => {
    expect(toTelegramMarkdown("```js\nconst a=1;\n```")).toBe("```js\nconst a=1;\n```");
  });

  it("keeps links and escapes the url parentheses only", () => {
    expect(toTelegramMarkdown("see [docs](https://e.com/a_b)")).toBe("see [docs](https://e.com/a_b)");
  });

  it("makes bare urls clickable", () => {
    const out = toTelegramMarkdown("go https://a.com/x now");
    expect(out).toContain("](https://a.com/x)");
    expect(out.startsWith("go [https://a")).toBe(true);
  });

  it("renders unordered lists with bullets", () => {
    expect(toTelegramMarkdown("- a\n- b")).toBe("• a\n• b");
  });

  it("renders ordered lists with escaped numbering", () => {
    expect(toTelegramMarkdown("1. a\n2. b")).toBe("1\\. a\n2\\. b");
  });

  it("indents nested lists", () => {
    expect(toTelegramMarkdown("- a\n  - a1\n- b")).toBe("• a\n    • a1\n• b");
  });

  it("converts ~~strikethrough~~ to ~text~", () => {
    expect(toTelegramMarkdown("~~gone~~ ok")).toBe("~gone~ ok");
  });

  it("escapes MarkdownV2 special characters in plain text", () => {
    expect(toTelegramMarkdown("a.b! (c) #d")).toBe("a\\.b\\! \\(c\\) \\#d");
  });

  it("prefixes blockquote lines with '>'", () => {
    expect(toTelegramMarkdown("> quoted line")).toBe(">quoted line");
  });

  it("degrades tables to plain rows with a bold header", () => {
    expect(toTelegramMarkdown("| H1 | H2 |\n|----|----|\n| a | b |")).toBe("*H1* | *H2*\na | b");
  });

  it("collapses 3+ blank lines and trims", () => {
    expect(toTelegramMarkdown("a\n\n\n\nb")).toBe("a\n\nb");
  });

  it("skips raw HTML", () => {
    expect(toTelegramMarkdown("text <div>x</div> more")).not.toContain("<div>");
  });
});

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
