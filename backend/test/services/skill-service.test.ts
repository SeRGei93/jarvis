import { describe, it, expect, afterEach } from "vitest";
import { writeFileSync, utimesSync } from "node:fs";
import { join } from "node:path";
import {
  SkillService,
  derivePreviousSkills,
  formatSkillCatalog,
} from "../../src/services/skill-service.js";
import { tempContent, type ContentFixture } from "../helpers/content.js";
import type { Message } from "../../src/domain/entities.js";

let c: ContentFixture | undefined;
afterEach(() => {
  c?.cleanup();
  c = undefined;
});

describe("derivePreviousSkills", () => {
  it("returns assistant skills newest-first, ignoring user/untagged messages", () => {
    const msgs: Message[] = [
      { role: "user", content: "hi" },
      { role: "assistant", content: "a", skill: "chat" },
      { role: "user", content: "weather?" },
      { role: "assistant", content: "b", skill: "weather" },
      { role: "assistant", content: "c" }, // untagged -> skipped
    ];
    expect(derivePreviousSkills(msgs)).toEqual(["weather", "chat"]);
  });

  it("returns [] when no assistant message carries a skill", () => {
    expect(derivePreviousSkills([{ role: "user", content: "hi" }])).toEqual([]);
  });
});

describe("formatSkillCatalog", () => {
  it("renders one '- name: when-to-apply' line per skill and collapses whitespace", () => {
    expect(
      formatSkillCatalog([
        { name: "weather", description: "  Weather\nforecasts " },
        { name: "chat", description: "Casual chat" },
      ]),
    ).toBe("- weather: Weather forecasts\n- chat: Casual chat");
  });

  it("returns an empty string for no skills", () => {
    expect(formatSkillCatalog([])).toBe("");
  });
});

describe("SkillService", () => {
  it("loads all skills and the routable subset", async () => {
    c = tempContent({
      skills: [
        { name: "research", description: "research things", routable: true, allowedTools: ["web_search"] },
        { name: "reminder", description: "deliver reminders", routable: false },
      ],
    });
    const svc = c.skills;

    expect((await svc.getAllSkills()).map((s) => s.name).sort()).toEqual(["reminder", "research"]);

    const routable = await svc.getRoutableSkills();
    expect(routable).toEqual([{ name: "research", description: "research things" }]);

    const research = await svc.getSkillByName("research");
    expect(research?.allowedTools).toEqual(["web_search"]);
    expect(await svc.getSkillByName("missing")).toBeNull();
  });

  it("builds a compact one-line-per-skill catalog of the routable subset", async () => {
    c = tempContent({
      skills: [
        { name: "research", description: "Research a topic\n  with sources", routable: true },
        { name: "currency", description: "Currency rates", routable: true },
        { name: "reminder", description: "deliver reminders", routable: false },
      ],
    });
    const catalog = await c.skills.getSkillCatalog();
    // One line per routable skill; descriptions collapsed; cron-only skill excluded.
    expect(catalog.split("\n").sort()).toEqual([
      "- currency: Currency rates",
      "- research: Research a topic with sources",
    ]);
  });

  it("loads prompts and reflects updates after invalidate()", async () => {
    c = tempContent({ prompts: { SOUL: "soul body", FORMAT: "format body" } });
    const svc = new SkillService(c.skillRepo, c.promptRepo);

    expect(await svc.getPrompt("SOUL")).toBe("soul body");
    expect(await svc.getPrompt("MISSING")).toBe("");

    const core = await svc.getCorePrompts();
    expect(core.soul).toBe("soul body");
    expect(core.format).toBe("format body");
    expect(core.integrity).toBe(""); // not seeded

    // Pin the file mtime to a fixed value, warm the cache, then edit the file
    // and restore the SAME mtime — so the hot-reload fingerprint is unchanged and
    // the cache stays sticky, proving invalidate() is what forces the reload.
    const file = join(c.promptsDir, "SOUL.md");
    const pinned = new Date("2020-01-01T00:00:00.000Z");
    utimesSync(file, pinned, pinned);
    svc.invalidate(); // re-read so the cached fingerprint uses the pinned mtime
    expect(await svc.getPrompt("SOUL")).toBe("soul body");

    writeFileSync(file, "new soul\n");
    utimesSync(file, pinned, pinned);
    expect(await svc.getPrompt("SOUL")).toBe("soul body"); // fingerprint unchanged → cached
    svc.invalidate();
    expect(await svc.getPrompt("SOUL")).toBe("new soul"); // forced reload
  });
});
