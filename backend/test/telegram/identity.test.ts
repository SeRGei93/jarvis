import { describe, it, expect, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb, type TestDb } from "../helpers/libsql.js";
import { resolveTelegramUser, TELEGRAM_PROVIDER } from "../../src/telegram/identity.js";
import { users, userChannels } from "../../src/db/schema.js";

let t: TestDb | undefined;
afterEach(() => {
  t?.cleanup();
  t = undefined;
});

describe("resolveTelegramUser", () => {
  it("creates a user + channel on first contact", async () => {
    t = await createTestDb();
    const res = await resolveTelegramUser(t.db, { id: 555, name: "Serg" });
    expect(res.created).toBe(true);

    const [u] = await t.db.select().from(users).where(eq(users.id, res.userId));
    expect(u!.name).toBe("Serg");

    const [ch] = await t.db.select().from(userChannels).where(eq(userChannels.userId, res.userId));
    expect(ch!.provider).toBe(TELEGRAM_PROVIDER);
    expect(ch!.externalId).toBe("555");
  });

  it("returns the same user id on a repeat contact (idempotent)", async () => {
    t = await createTestDb();
    const first = await resolveTelegramUser(t.db, { id: 555, name: "Serg" });
    const second = await resolveTelegramUser(t.db, { id: 555, name: "Serg renamed" });

    expect(second.userId).toBe(first.userId);
    expect(second.created).toBe(false);

    const allUsers = await t.db.select().from(users);
    const allChannels = await t.db.select().from(userChannels);
    expect(allUsers).toHaveLength(1);
    expect(allChannels).toHaveLength(1);
  });

  it("keeps different Telegram ids as separate users", async () => {
    t = await createTestDb();
    const a = await resolveTelegramUser(t.db, { id: 1 });
    const b = await resolveTelegramUser(t.db, { id: 2 });
    expect(a.userId).not.toBe(b.userId);
    expect(await t.db.select().from(users)).toHaveLength(2);
  });
});
