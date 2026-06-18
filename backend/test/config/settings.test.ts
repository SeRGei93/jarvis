import { describe, it, expect, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb, type TestDb } from "../helpers/libsql.js";
import { runSeed } from "../../src/db/seed.js";
import { settings } from "../../src/db/schema.js";
import { SettingsService, parseGoDuration } from "../../src/config/settings.js";
import { SettingKey } from "../../src/config/settings-keys.js";

let t: TestDb | undefined;
afterEach(() => {
  t?.cleanup();
  t = undefined;
});

describe("parseGoDuration", () => {
  it("parses Go duration strings to ms", () => {
    expect(parseGoDuration("300s")).toBe(300_000);
    expect(parseGoDuration("30s")).toBe(30_000);
    expect(parseGoDuration("5m")).toBe(300_000);
    expect(parseGoDuration("1h30m")).toBe(5_400_000);
    expect(parseGoDuration("500ms")).toBe(500);
    expect(parseGoDuration("")).toBe(0);
  });
});

describe("SettingsService", () => {
  it("reads typed settings + models from the DB", async () => {
    t = await createTestDb();
    await runSeed(t.db);
    const svc = new SettingsService(t.db);

    expect((await svc.getModelRoles()).default).toBe("openrouter:deepseek/deepseek-v4-flash:nitro");
    const agent = await svc.getAgent();
    expect(agent.max_history).toBe(50);
    expect(await svc.getAllowedUsers()).toEqual([]);
    expect((await svc.getTimeouts()).llm_request).toBe("300s");
    expect(await svc.getModels()).toHaveLength(11);
  });

  it("caches and hot-reloads on version bump", async () => {
    t = await createTestDb();
    await runSeed(t.db);
    const svc = new SettingsService(t.db);
    const roles = await svc.getModelRoles();
    expect(roles.default).toContain("deepseek");

    await t.db
      .update(settings)
      .set({ value: { ...roles, default: "openrouter:foo/bar" }, updatedAt: new Date(Date.now() + 5000) })
      .where(eq(settings.key, SettingKey.ModelRoles));

    // cached value unchanged until refreshed
    expect((await svc.getModelRoles()).default).toBe(roles.default);

    await svc.refreshIfStale();
    expect((await svc.getModelRoles()).default).toBe("openrouter:foo/bar");
  });

  it("invalidate() forces a reload", async () => {
    t = await createTestDb();
    await runSeed(t.db);
    const svc = new SettingsService(t.db);
    await svc.getAgent();

    await t.db
      .update(settings)
      .set({ value: { max_history: 99, default_temperature: 0.1 } })
      .where(eq(settings.key, SettingKey.Agent));

    svc.invalidate();
    expect((await svc.getAgent()).max_history).toBe(99);
  });
});
