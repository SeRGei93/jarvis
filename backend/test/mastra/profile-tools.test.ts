import { describe, it, expect, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb, type TestDb } from "../helpers/libsql.js";
import { buildProfileTools } from "../../src/mastra/tools/profile-tools.js";
import { users, botIdentities } from "../../src/db/schema.js";
import type { ToolContext } from "../../src/mastra/tools/registry.js";

// Minimal ToolCallOptions for direct execute() calls in tests.
const opts = { toolCallId: "test", messages: [] } as never;
const USER_ID = 1;

let t: TestDb | undefined;
afterEach(() => {
  t?.cleanup();
  t = undefined;
});

async function setup() {
  t = await createTestDb();
  // FK: a bot_identities/users.city write requires the user row to exist first.
  await t.db.insert(users).values({ id: USER_ID, name: "u" });
  const ctx = { db: t.db, userId: USER_ID } as unknown as ToolContext;
  return buildProfileTools(ctx);
}

describe("profile tools", () => {
  it("update_city writes users.city and a valid timezone", async () => {
    const ts = await setup();
    const r = (await ts.update_city!.execute!(
      { city: "Минск", timezone: "Europe/Minsk" },
      opts,
    )) as { message: string };
    expect(r.message).toContain("Минск");
    expect(r.message).toContain("Europe/Minsk");

    const [row] = await t!.db.select().from(users).where(eq(users.id, USER_ID));
    expect(row!.city).toBe("Минск");
    expect(row!.timezone).toBe("Europe/Minsk");
  });

  it("update_city rejects an invalid timezone but still sets the city", async () => {
    const ts = await setup();
    const r = (await ts.update_city!.execute!(
      { city: "Гомель", timezone: "Not/AReal_Zone" },
      opts,
    )) as { message: string };
    expect(r.message).toContain("Гомель");

    const [row] = await t!.db.select().from(users).where(eq(users.id, USER_ID));
    expect(row!.city).toBe("Гомель");
    expect(row!.timezone).toBe(""); // unchanged default — rejected tz not applied
  });

  it("update_bot_vibe inserts a row when none exists, then updates it (single row)", async () => {
    const ts = await setup();

    const r1 = (await ts.update_bot_vibe!.execute!(
      { vibe: "краткий, дружелюбный" },
      opts,
    )) as { message: string };
    expect(r1.message).toContain("краткий, дружелюбный");

    let rows = await t!.db
      .select()
      .from(botIdentities)
      .where(eq(botIdentities.userId, USER_ID));
    expect(rows.length).toBe(1);
    expect(rows[0]!.vibe).toBe("краткий, дружелюбный");

    // Second call upserts on the unique userId -> still one row, updated vibe.
    const r2 = (await ts.update_bot_vibe!.execute!(
      { vibe: "формальный и подробный" },
      opts,
    )) as { message: string };
    expect(r2.message).toContain("формальный и подробный");

    rows = await t!.db.select().from(botIdentities).where(eq(botIdentities.userId, USER_ID));
    expect(rows.length).toBe(1);
    expect(rows[0]!.vibe).toBe("формальный и подробный");
  });

  it("update_bot_vibe truncates vibe over 200 chars", async () => {
    const ts = await setup();
    const long = "a".repeat(250);
    await ts.update_bot_vibe!.execute!({ vibe: long }, opts);

    const [row] = await t!.db
      .select()
      .from(botIdentities)
      .where(eq(botIdentities.userId, USER_ID));
    expect([...row!.vibe].length).toBe(200);
  });

  it("update_bot_name upserts: inserts then updates (single row)", async () => {
    const ts = await setup();

    const r1 = (await ts.update_bot_name!.execute!({ bot_name: "Жарвис" }, opts)) as {
      message: string;
    };
    expect(r1.message).toContain("Жарвис");

    let rows = await t!.db
      .select()
      .from(botIdentities)
      .where(eq(botIdentities.userId, USER_ID));
    expect(rows.length).toBe(1);
    expect(rows[0]!.botName).toBe("Жарвис");

    const r2 = (await ts.update_bot_name!.execute!({ bot_name: "Ava" }, opts)) as {
      message: string;
    };
    expect(r2.message).toContain("Ava");

    rows = await t!.db.select().from(botIdentities).where(eq(botIdentities.userId, USER_ID));
    expect(rows.length).toBe(1);
    expect(rows[0]!.botName).toBe("Ava");
  });
});
