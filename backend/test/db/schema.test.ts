import { describe, it, expect, afterEach } from "vitest";
import { createTestDb, type TestDb } from "../helpers/libsql.js";
import { users } from "../../src/db/schema.js";

let t: TestDb | undefined;
afterEach(() => {
  t?.cleanup();
  t = undefined;
});

const EXPECTED_TABLES = [
  "users",
  "user_channels",
  "sessions",
  "memories",
  "bot_identities",
  "cron_tasks",
  "usage_stats",
  "subscription_plans",
  "user_subscriptions",
  "message_rate_limits",
  "settings",
  "models",
];

describe("schema migrations", () => {
  it("creates all 12 tables", async () => {
    t = await createTestDb();
    const res = await t.client.execute("SELECT name FROM sqlite_master WHERE type='table'");
    const names = res.rows.map((r) => String(r.name));
    for (const tbl of EXPECTED_TABLES) expect(names).toContain(tbl);
  });

  it("inserts and reads a row (defaults applied)", async () => {
    t = await createTestDb();
    await t.db.insert(users).values({ id: 1, name: "Тест" });
    const got = await t.db.select().from(users);
    expect(got).toHaveLength(1);
    expect(got[0]?.name).toBe("Тест");
    expect(got[0]?.onboarded).toBe(false);
    expect(got[0]?.city).toBe("");
  });
});
