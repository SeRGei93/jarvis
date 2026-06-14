import { describe, it, expect, afterEach } from "vitest";
import { createTestDb, type TestDb } from "../helpers/libsql.js";
import { loadContext } from "../../src/services/conversation-context.js";
import { users, botIdentities } from "../../src/db/schema.js";
import type { SettingsService } from "../../src/config/settings.js";

let t: TestDb | undefined;
afterEach(() => {
  t?.cleanup();
  t = undefined;
});

const settings = {
  getModelRoles: async () => ({
    default: "openrouter:default",
    router: "openrouter:router",
    embedding: "openrouter:embed",
    error_correction: "openrouter:ec",
    speech: "openrouter:speech",
    synthesizer: "openrouter:synth",
  }),
} as unknown as SettingsService;

describe("loadContext", () => {
  it("creates a session with the default model on first contact, identity null", async () => {
    t = await createTestDb();
    await t.db.insert(users).values({ id: 1, name: "Alex" });

    const ctx = await loadContext(t.db, settings, 1, 555);
    expect(ctx.user.name).toBe("Alex");
    expect(ctx.session.chatId).toBe(555);
    expect(ctx.session.model).toBe("openrouter:default");
    expect(ctx.identity).toBeNull();
    expect(ctx.threadId).toBe(`session-${ctx.session.id}`);
    expect(ctx.resourceId).toBe("user:1");
  });

  it("reuses the same session and thread on subsequent calls, loads identity", async () => {
    t = await createTestDb();
    await t.db.insert(users).values({ id: 1, name: "Alex" });
    await t.db.insert(botIdentities).values({ userId: 1, botName: "Jarvis", vibe: "dry" });

    const a = await loadContext(t.db, settings, 1, 555);
    const b = await loadContext(t.db, settings, 1, 555);
    expect(b.session.id).toBe(a.session.id);
    expect(b.threadId).toBe(a.threadId);
    expect(b.identity?.botName).toBe("Jarvis");
  });

  it("throws when the user does not exist", async () => {
    t = await createTestDb();
    await expect(loadContext(t.db, settings, 99, 1)).rejects.toThrow(/user 99 not found/);
  });
});
