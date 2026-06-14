import { describe, it, expect, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb, type TestDb } from "../helpers/libsql.js";
import { SkillService, derivePreviousSkills } from "../../src/services/skill-service.js";
import { skills, prompts } from "../../src/db/schema.js";
import type { Message } from "../../src/domain/entities.js";

let t: TestDb | undefined;
afterEach(() => {
  t?.cleanup();
  t = undefined;
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

describe("SkillService", () => {
  it("loads all skills and the routable subset", async () => {
    t = await createTestDb();
    await t.db.insert(skills).values([
      { name: "research", description: "research things", routable: true, allowedTools: ["web_search"] },
      { name: "reminder", description: "deliver reminders", routable: false },
    ]);
    const svc = new SkillService(t.db);

    expect((await svc.getAllSkills()).map((s) => s.name).sort()).toEqual(["reminder", "research"]);

    const routable = await svc.getRoutableSkills();
    expect(routable).toEqual([{ name: "research", description: "research things" }]);

    const research = await svc.getSkillByName("research");
    expect(research?.allowedTools).toEqual(["web_search"]);
    expect(await svc.getSkillByName("missing")).toBeNull();
  });

  it("loads prompts and reflects updates after invalidate()", async () => {
    t = await createTestDb();
    await t.db.insert(prompts).values([
      { key: "SOUL", body: "soul body" },
      { key: "FORMAT", body: "format body" },
    ]);
    const svc = new SkillService(t.db);

    expect(await svc.getPrompt("SOUL")).toBe("soul body");
    expect(await svc.getPrompt("MISSING")).toBe("");

    const core = await svc.getCorePrompts();
    expect(core.soul).toBe("soul body");
    expect(core.format).toBe("format body");
    expect(core.integrity).toBe(""); // not seeded

    // Cache is sticky until invalidate().
    await t.db.update(prompts).set({ body: "new soul" }).where(eq(prompts.key, "SOUL"));
    expect(await svc.getPrompt("SOUL")).toBe("soul body");
    svc.invalidate();
    expect(await svc.getPrompt("SOUL")).toBe("new soul");
  });
});
