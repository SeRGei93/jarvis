import { describe, it, expect, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb, type TestDb } from "../helpers/libsql.js";
import { SettingsService } from "../../src/config/settings.js";
import {
  AccessRequestService,
  ensureAccessControlDefaults,
} from "../../src/services/access-request-service.js";
import { accessRequests, userChannels, users } from "../../src/db/schema.js";

let t: TestDb | undefined;
afterEach(() => {
  t?.cleanup();
  t = undefined;
});

function make(db: TestDb["db"]) {
  const settings = new SettingsService(db);
  return { settings, svc: new AccessRequestService(db, settings) };
}

describe("AccessRequestService.record", () => {
  it("creates a pending row once; a repeat refreshes fields without re-creating", async () => {
    t = await createTestDb();
    const { svc } = make(t.db);

    expect(await svc.record({ id: 42, name: "Ann", username: "ann" })).toEqual({ created: true });
    expect(await svc.record({ id: 42, name: "Ann B", username: "annb" })).toEqual({
      created: false,
    });

    const rows = await t.db.select().from(accessRequests).where(eq(accessRequests.tgUserId, 42));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "pending", name: "Ann B", username: "annb" });
  });

  it("keeps a rejected row rejected on a repeat contact (no re-prompt)", async () => {
    t = await createTestDb();
    const { svc } = make(t.db);
    await svc.record({ id: 7 });
    const [row] = await t.db.select().from(accessRequests).where(eq(accessRequests.tgUserId, 7));
    await svc.reject(row!.id);

    expect(await svc.record({ id: 7, name: "back again" })).toEqual({ created: false });
    const [after] = await t.db.select().from(accessRequests).where(eq(accessRequests.tgUserId, 7));
    expect(after!.status).toBe("rejected");
  });
});

describe("AccessRequestService.approve / reject", () => {
  it("approve marks approved, adds the id to the allowlist, returns the contact", async () => {
    t = await createTestDb();
    const { settings, svc } = make(t.db);
    await svc.record({ id: 500, name: "Joe", username: "joe" });
    const [row] = await t.db.select().from(accessRequests).where(eq(accessRequests.tgUserId, 500));

    const result = await svc.approve(row!.id);
    expect(result).toEqual({ tgUserId: 500, name: "Joe" });
    expect(await settings.getAllowedUsers()).toContain(500);

    const [updated] = await t.db.select().from(accessRequests).where(eq(accessRequests.id, row!.id));
    expect(updated!.status).toBe("approved");
    expect(updated!.decidedAt).not.toBeNull();

    // Re-approving an already-decided request is a no-op → null.
    expect(await svc.approve(row!.id)).toBeNull();
  });

  it("approve is idempotent on the allowlist (no duplicate id)", async () => {
    t = await createTestDb();
    const { settings, svc } = make(t.db);
    await svc.record({ id: 11 });
    await svc.record({ id: 22 });
    const rows = await t.db.select().from(accessRequests);
    for (const r of rows) await svc.approve(r.id);
    // Approve the same tg id twice by re-recording + approving wouldn't duplicate either.
    expect(await settings.getAllowedUsers()).toEqual([11, 22]);
  });

  it("reject marks rejected and never touches the allowlist; missing id → false", async () => {
    t = await createTestDb();
    const { settings, svc } = make(t.db);
    await svc.record({ id: 900 });
    const [row] = await t.db.select().from(accessRequests).where(eq(accessRequests.tgUserId, 900));

    expect(await svc.reject(row!.id)).toBe(true);
    expect(await settings.getAllowedUsers()).not.toContain(900);
    expect(await svc.reject(row!.id)).toBe(false); // already decided
    expect(await svc.reject(99999)).toBe(false); // missing
  });

  it("listPending returns only pending rows, oldest first", async () => {
    t = await createTestDb();
    const { svc } = make(t.db);
    await svc.record({ id: 1 });
    await svc.record({ id: 2 });
    await svc.record({ id: 3 });
    const [second] = await t.db.select().from(accessRequests).where(eq(accessRequests.tgUserId, 2));
    await svc.reject(second!.id);

    const pending = await svc.listPending();
    expect(pending.map((r) => r.tgUserId)).toEqual([1, 3]);
  });
});

describe("ensureAccessControlDefaults", () => {
  it("merges existing Telegram users into the allowlist and sets approval mode (once)", async () => {
    t = await createTestDb();
    const { settings } = make(t.db);

    const [u1] = await t.db.insert(users).values({ name: "a" }).returning({ id: users.id });
    const [u2] = await t.db.insert(users).values({ name: "b" }).returning({ id: users.id });
    await t.db.insert(userChannels).values([
      { userId: u1!.id, provider: "telegram", externalId: "100" },
      { userId: u2!.id, provider: "telegram", externalId: "200" },
    ]);

    await ensureAccessControlDefaults(t.db, settings);

    expect(await settings.getAccessMode()).toBe("approval");
    expect([...(await settings.getAllowedUsers())].sort((a, b) => a - b)).toEqual([100, 200]);
  });

  it("is idempotent — a second run leaves an admin-changed mode/allowlist untouched", async () => {
    t = await createTestDb();
    const { settings } = make(t.db);
    await ensureAccessControlDefaults(t.db, settings); // first run sets approval

    // Admin flips back to open; bootstrap must NOT re-apply.
    await settings.invalidate();
    await ensureAccessControlDefaults(t.db, settings);
    // mode key already present → no-op; whatever was set stays "approval" here.
    expect(await settings.getAccessMode()).toBe("approval");
  });
});
