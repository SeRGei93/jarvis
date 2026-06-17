import { describe, it, expect, afterEach } from "vitest";
import { createTestDb, type TestDb } from "../helpers/libsql.js";
import { runSeed } from "../../src/db/seed.js";
import { settings, models, subscriptionPlans } from "../../src/db/schema.js";
import { SettingKey } from "../../src/config/settings-keys.js";

let t: TestDb | undefined;
afterEach(() => {
  t?.cleanup();
  t = undefined;
});

describe("runSeed (code seed -> settings/models/plans)", () => {
  it("seeds settings, models and plans", async () => {
    t = await createTestDb();
    await runSeed(t.db);

    const s = await t.db.select().from(settings);
    const keys = s.map((r) => r.key);
    expect(keys).toContain(SettingKey.ModelRoles);
    expect(keys).toContain(SettingKey.Timeouts);
    expect(keys).toContain(SettingKey.Agent);

    const roles = s.find((r) => r.key === SettingKey.ModelRoles)?.value as Record<string, string>;
    expect(roles.default).toBe("openrouter:google/gemini-3.1-flash-lite");
    expect(roles.router).toContain("gpt-oss-120b");

    const agent = s.find((r) => r.key === SettingKey.Agent)?.value as Record<string, number>;
    expect(agent.max_history).toBe(50);

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

  // NOTE: skills & prompts are no longer DB-seeded — they live in the file-backed
  // content store. Their parsing/shape coverage lives in test/content/*.
});
