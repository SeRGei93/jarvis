import { describe, it, expect, afterEach } from "vitest";
import { mkdirSync, writeFileSync, readFileSync, utimesSync } from "node:fs";
import { join } from "node:path";
import {
  SkillRepository,
  parseSkill,
  serializeSkill,
  isValidSkillName,
} from "../../src/content/skill-repository.js";
import { DEFAULTS_SKILLS_DIR } from "../../src/content/paths.js";
import { Skill } from "../../src/domain/entities.js";
import { tempSkillsDir, type TempDir } from "../helpers/content.js";

let tmp: TempDir | undefined;
afterEach(() => {
  tmp?.cleanup();
  tmp = undefined;
});

describe("parseSkill / serializeSkill round-trip", () => {
  it("round-trips every field (parse → serialize → parse ≡ parse)", () => {
    const raw = [
      "---",
      "name: weather",
      "description: forecast",
      "allowed-tools: weather web_search fetch_url",
      "model: openrouter:x",
      "reasoning: false",
      "temperature: 0.2",
      "routable: true",
      "max-turns: 3",
      "---",
      "",
      "Body text here.",
    ].join("\n");

    const a = parseSkill(raw, "weather");
    expect(a.allowedTools).toEqual(["weather", "web_search", "fetch_url"]);
    expect(a.reasoning).toBe(false);
    expect(a.temperature).toBe(0.2);
    expect(a.metadata).toEqual({ "max-turns": "3" });

    const b = parseSkill(serializeSkill(a), "weather");
    expect(b).toEqual(a);
  });

  it("falls back to the directory name when frontmatter has no name", () => {
    expect(parseSkill("---\ndescription: d\n---\nbody", "fallback").name).toBe("fallback");
  });

  it("normalises the legacy `tools` array to allowedTools", () => {
    const s = parseSkill("---\nname: t\ntools:\n  - a\n  - b\n---\nx", "t");
    expect(s.allowedTools).toEqual(["a", "b"]);
  });
});

describe("isValidSkillName", () => {
  it("accepts safe identifiers and rejects traversal/separators", () => {
    expect(isValidSkillName("research")).toBe(true);
    expect(isValidSkillName("web-search_2")).toBe(true);
    expect(isValidSkillName("..")).toBe(false);
    expect(isValidSkillName("a/b")).toBe(false);
    expect(isValidSkillName("")).toBe(false);
  });
});

describe("SkillRepository", () => {
  it("lists skills and the routable subset, getByName, and skips non-skill files", async () => {
    tmp = tempSkillsDir([
      { name: "research", description: "deep", routable: true, allowedTools: ["web_search"] },
      { name: "reminder", description: "cron only", routable: false },
    ]);
    // A stray top-level file is ignored (not a <name>/SKILL.md).
    writeFileSync(join(tmp.dir, "_TEMPLATE.md"), "ignored");
    const repo = new SkillRepository(tmp.dir);

    expect((await repo.list()).map((s) => s.name).sort()).toEqual(["reminder", "research"]);
    expect((await repo.getByName("research"))?.allowedTools).toEqual(["web_search"]);
    expect(await repo.getByName("missing")).toBeNull();
  });

  it("upsert writes SKILL.md atomically and the change is visible immediately", async () => {
    tmp = tempSkillsDir([]);
    const repo = new SkillRepository(tmp.dir);

    const stored = await repo.upsert(Skill.parse({ name: "weather", description: "w", routable: true }));
    expect(stored.skill.name).toBe("weather");
    expect(readFileSync(join(tmp.dir, "weather", "SKILL.md"), "utf8")).toContain("name: weather");
    expect((await repo.getByName("weather"))?.description).toBe("w");
  });

  it("delete removes the skill dir and returns false for an unknown skill", async () => {
    tmp = tempSkillsDir([{ name: "chat", description: "c", routable: true }]);
    const repo = new SkillRepository(tmp.dir);

    expect(await repo.delete("chat")).toBe(true);
    expect(await repo.getByName("chat")).toBeNull();
    expect(await repo.delete("chat")).toBe(false);
  });

  it("rejects unsafe names on upsert/delete", async () => {
    tmp = tempSkillsDir([]);
    const repo = new SkillRepository(tmp.dir);
    await expect(repo.upsert(Skill.parse({ name: "..", description: "x" }))).rejects.toThrow();
    await expect(repo.delete("../escape")).rejects.toThrow();
  });

  it("skips an unparseable SKILL.md (WARN) without failing the whole listing", async () => {
    tmp = tempSkillsDir([{ name: "good", description: "ok", routable: true }]);
    // Malformed YAML frontmatter (unterminated quote) → parse throws → skipped.
    mkdirSync(join(tmp.dir, "broken"), { recursive: true });
    writeFileSync(join(tmp.dir, "broken", "SKILL.md"), '---\nname: "broken\n---\nbody');
    const repo = new SkillRepository(tmp.dir);

    expect((await repo.list()).map((s) => s.name)).toEqual(["good"]);
  });

  it("hot-reloads on a content edit (mtime change) and on add/remove", async () => {
    tmp = tempSkillsDir([{ name: "chat", description: "v1", routable: true }]);
    const repo = new SkillRepository(tmp.dir);
    expect((await repo.getByName("chat"))?.description).toBe("v1");

    // External content edit + bumped mtime → repo reloads.
    const file = join(tmp.dir, "chat", "SKILL.md");
    writeFileSync(file, serializeSkill(Skill.parse({ name: "chat", description: "v2", routable: true })));
    const future = new Date(Date.now() + 10_000);
    utimesSync(file, future, future);
    expect((await repo.getByName("chat"))?.description).toBe("v2");

    // Adding a new skill dir changes the listing signature → reloads.
    mkdirSync(join(tmp.dir, "news"), { recursive: true });
    writeFileSync(join(tmp.dir, "news", "SKILL.md"), serializeSkill(Skill.parse({ name: "news", description: "n", routable: true })));
    expect((await repo.list()).map((s) => s.name).sort()).toEqual(["chat", "news"]);
  });

  it("parses the repo-bundled defaults (backend/skills) correctly", async () => {
    const repo = new SkillRepository(DEFAULTS_SKILLS_DIR);
    const all = await repo.list();
    // 19 real skills (the _TEMPLATE.md file is not a skill dir).
    expect(all).toHaveLength(19);

    const research = await repo.getByName("research");
    expect(research?.allowedTools).toEqual(["web_search", "fetch_url"]);
    expect(research?.reasoning).toBe(false);
    expect((research?.prompt.length ?? 0)).toBeGreaterThan(0);

    expect((await repo.getByName("reminder"))?.routable).toBe(false);
    expect((await repo.getByName("weather"))?.metadata["max-turns"]).toBe("3");

    const chat = await repo.getByName("chat");
    expect(chat?.routable).toBe(true);
    expect(chat?.allowedTools).toEqual([]);
  });
});
