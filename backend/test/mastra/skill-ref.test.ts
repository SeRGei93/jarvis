import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildSkillRefTools,
  listReferences,
  SKILLREF_TOOL_NAMES,
} from "../../src/mastra/tools/skill-ref.js";
import type { ToolContext } from "../../src/mastra/tools/registry.js";

// Minimal ToolCallOptions for direct execute() calls in tests.
const opts = { toolCallId: "test", messages: [] } as never;

// Known fixture content; long enough to exercise the 8000-char truncation.
const GUIDE_CONTENT = "A".repeat(10_000);

let root: string | undefined;

/** Build a fixture skills root: <root>/research/references/guide.md */
function makeFixture(): string {
  const r = mkdtempSync(join(tmpdir(), "skillref-"));
  const refsDir = join(r, "research", "references");
  mkdirSync(refsDir, { recursive: true });
  writeFileSync(join(refsDir, "guide.md"), GUIDE_CONTENT, "utf8");
  return r;
}

/** ctx carrying only what the skill-ref tool reads (skillsRoot). */
function ctxFor(skillsRoot: string): ToolContext {
  return { skillsRoot } as unknown as ToolContext;
}

function readTool(skillsRoot: string) {
  const ts = buildSkillRefTools(ctxFor(skillsRoot));
  return ts.read_skill_reference!;
}

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

describe("skill-ref", () => {
  it("exports the expected tool name", () => {
    expect(SKILLREF_TOOL_NAMES.has("read_skill_reference")).toBe(true);
  });

  it("reads a valid references/guide.md and truncates to 8000 chars", async () => {
    root = makeFixture();
    const r = (await readTool(root).execute!(
      { skill_name: "research", ref_path: "references/guide.md" },
      opts,
    )) as { content?: string; path?: string; error?: string };

    expect(r.error).toBeUndefined();
    expect(r.path).toBe("research/references/guide.md");
    expect(r.content).toBeDefined();
    // 8000 chars of original + truncation marker.
    expect(r.content!.startsWith("A".repeat(8000))).toBe(true);
    expect(r.content).toContain("[Content truncated to 8000 characters]");
    expect(r.content!.length).toBeLessThan(GUIDE_CONTENT.length);
  });

  it("does not truncate content under the limit", async () => {
    root = mkdtempSync(join(tmpdir(), "skillref-"));
    const refsDir = join(root, "research", "references");
    mkdirSync(refsDir, { recursive: true });
    writeFileSync(join(refsDir, "short.md"), "hello world", "utf8");

    const r = (await readTool(root).execute!(
      { skill_name: "research", ref_path: "references/short.md" },
      opts,
    )) as { content?: string; error?: string };

    expect(r.error).toBeUndefined();
    expect(r.content).toBe("hello world");
  });

  it("rejects path traversal without reading", async () => {
    root = makeFixture();
    const r = (await readTool(root).execute!(
      { skill_name: "research", ref_path: "../../etc/passwd" },
      opts,
    )) as { content?: string; error?: string };

    expect(r.content).toBeUndefined();
    expect(r.error).toBeDefined();
    expect(r.error).toContain("..");
  });

  it("rejects absolute paths without reading", async () => {
    root = makeFixture();
    const r = (await readTool(root).execute!(
      { skill_name: "research", ref_path: "/etc/passwd" },
      opts,
    )) as { content?: string; error?: string };

    expect(r.content).toBeUndefined();
    expect(r.error).toBeDefined();
    expect(r.error).toContain("absolute");
  });

  it("rejects a path without an allowed prefix without reading", async () => {
    root = makeFixture();
    const r = (await readTool(root).execute!(
      { skill_name: "research", ref_path: "notes.md" },
      opts,
    )) as { content?: string; error?: string };

    expect(r.content).toBeUndefined();
    expect(r.error).toBeDefined();
    expect(r.error).toContain("references/, scripts/, or assets/");
  });

  it("returns an error for a missing (but well-formed) reference path", async () => {
    root = makeFixture();
    const r = (await readTool(root).execute!(
      { skill_name: "research", ref_path: "references/missing.md" },
      opts,
    )) as { content?: string; error?: string };

    expect(r.content).toBeUndefined();
    expect(r.error).toBeDefined();
    expect(r.error).toContain("not found");
  });

  it("listReferences returns the fixture's references/guide.md", () => {
    root = makeFixture();
    const refs = listReferences("research", root);
    expect(refs).toEqual([{ path: "references/guide.md" }]);
  });

  it("listReferences returns [] for a skill with no reference dirs", () => {
    root = mkdtempSync(join(tmpdir(), "skillref-"));
    mkdirSync(join(root, "empty"), { recursive: true });
    const refs = listReferences("empty", root);
    expect(refs).toEqual([]);
  });
});
