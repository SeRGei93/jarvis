import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const SKILL = readFileSync(
  new URL("../../skills/news/SKILL.md", import.meta.url),
  "utf-8",
);

describe("news skill routing rules", () => {
  it("enables serper_news and keeps the local feed", () => {
    const frontmatter = SKILL.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? "";
    expect(frontmatter).toContain("allowed-tools:");
    expect(frontmatter).toMatch(/\bserper_news\b/);
    expect(frontmatter).toMatch(/\bsearch_news\b/);
  });

  it("does not mention the removed SearXNG engine", () => {
    expect(SKILL.toLowerCase()).not.toContain("searxng");
  });

  it("forbids citing Google redirect wrappers", () => {
    expect(SKILL).toContain("google.com/goto");
    expect(SKILL).toContain("news.google.com/rss/articles");
  });

  it("documents regional site: recipes for small cities", () => {
    expect(SKILL).toContain("REGIONAL RECIPES");
    expect(SKILL).toContain("site:gp.by");
    expect(SKILL).toContain("site:newsgomel.by");
    expect(SKILL).toContain("site:vb.by");
    expect(SKILL).toContain("site:brestcity.com");
  });

  it("requires an explicit freshness statement when nothing is <24h old", () => {
    expect(SKILL).toMatch(/no item is <24h old/i);
    expect(SKILL).toMatch(/never present an older item as today's news/i);
  });
});
