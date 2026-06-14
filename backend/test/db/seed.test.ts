import { describe, it, expect, afterEach } from "vitest";
import { createTestDb, type TestDb } from "../helpers/libsql.js";
import { runSeed } from "../../src/db/seed.js";
import { settings, models, subscriptionPlans, skills, prompts } from "../../src/db/schema.js";
import { SettingKey } from "../../src/config/settings-keys.js";

let t: TestDb | undefined;
afterEach(() => {
  t?.cleanup();
  t = undefined;
});

describe("runSeed (config.yaml -> settings/models/plans)", () => {
  it("seeds settings, models and plans", async () => {
    t = await createTestDb();
    await runSeed(t.db);

    const s = await t.db.select().from(settings);
    const keys = s.map((r) => r.key);
    expect(keys).toContain(SettingKey.ModelRoles);
    expect(keys).toContain(SettingKey.Timeouts);
    expect(keys).toContain(SettingKey.Agent);
    expect(keys).toContain(SettingKey.McpServers);

    const roles = s.find((r) => r.key === SettingKey.ModelRoles)?.value as Record<string, string>;
    expect(roles.default).toBe("openrouter:google/gemini-3.1-flash-lite");
    expect(roles.router).toContain("gpt-oss-120b");

    const agent = s.find((r) => r.key === SettingKey.Agent)?.value as Record<string, number>;
    expect(agent.rag_top_k).toBe(10);
    expect(agent.max_history).toBe(15);

    // Only the `search` MCP server is kept (memory dropped).
    const mcp = s.find((r) => r.key === SettingKey.McpServers)?.value as Record<string, unknown>;
    expect(Object.keys(mcp)).toEqual(["search"]);

    const m = await t.db.select().from(models);
    expect(m).toHaveLength(11);

    const plans = await t.db.select().from(subscriptionPlans);
    expect(plans).toHaveLength(3);
    expect(plans.find((p) => p.name === "free")?.hourlyLimit).toBe(15);
    expect(plans.find((p) => p.name === "admin")?.maxTasks).toBe(10);
  });

  it("is idempotent (second run is a no-op)", async () => {
    t = await createTestDb();
    await runSeed(t.db);
    await runSeed(t.db);
    const m = await t.db.select().from(models);
    expect(m).toHaveLength(11);
  });

  it("seeds 19 skills and the system prompts with correct shapes", async () => {
    t = await createTestDb();
    await runSeed(t.db);

    const sk = await t.db.select().from(skills);
    expect(sk).toHaveLength(19);

    // routable: false comes through (cron-only skill)
    expect(sk.find((s) => s.name === "reminder")?.routable).toBe(false);

    // allowed-tools parsed from space-delimited string; reasoning tri-state
    const research = sk.find((s) => s.name === "research");
    expect(research?.allowedTools).toEqual(["web_fetch", "web_search"]);
    expect(research?.reasoning).toBe(false);
    expect((research?.prompt.length ?? 0)).toBeGreaterThan(0);

    // unknown frontmatter key -> metadata
    expect(sk.find((s) => s.name === "weather")?.metadata["max-turns"]).toBe("3");

    // a no-tools skill defaults routable=true with empty tools
    const chat = sk.find((s) => s.name === "chat");
    expect(chat?.routable).toBe(true);
    expect(chat?.allowedTools).toEqual([]);

    const pkeys = (await t.db.select().from(prompts)).map((p) => p.key);
    expect(pkeys).toEqual(
      expect.arrayContaining(["SOUL", "FORMAT", "INTEGRITY", "SYNTHESIZER", "WELCOME", "MONITORING"]),
    );
  });
});
