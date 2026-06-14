import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import { Hono } from "hono";
import {
  verifyInitData,
  isAdmin,
  parseTmaHeader,
  requireAdmin,
  INIT_DATA_MAX_AGE_SEC,
  type AdminVariables,
} from "../../src/admin/auth.js";

const TOKEN = "123456:TEST-bot-token";
const NOW_MS = 1_700_000_000_000;
const NOW_SEC = Math.floor(NOW_MS / 1000);

/** Sign initData the way Telegram does, so verifyInitData accepts it. */
function signInitData(fields: Record<string, string>, botToken = TOKEN): string {
  const dataCheckString = Object.entries(fields)
    .map(([k, v]) => `${k}=${v}`)
    .sort()
    .join("\n");
  const secret = createHmac("sha256", "WebAppData").update(botToken).digest();
  const hash = createHmac("sha256", secret).update(dataCheckString).digest("hex");
  const params = new URLSearchParams(fields);
  params.set("hash", hash);
  return params.toString();
}

function freshFields(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    auth_date: String(NOW_SEC),
    query_id: "AAA",
    user: JSON.stringify({ id: 42, first_name: "Ada", username: "ada" }),
    ...overrides,
  };
}

describe("verifyInitData", () => {
  it("accepts valid, fresh initData and returns the parsed user", () => {
    const res = verifyInitData(signInitData(freshFields()), TOKEN, { now: NOW_MS });
    expect(res.ok).toBe(true);
    expect(res.user?.id).toBe(42);
    expect(res.user?.username).toBe("ada");
    expect(res.authDate).toBe(NOW_SEC);
  });

  it("rejects empty initData", () => {
    expect(verifyInitData("", TOKEN, { now: NOW_MS })).toMatchObject({ ok: false, reason: "empty" });
  });

  it("rejects when bot token is missing", () => {
    const res = verifyInitData(signInitData(freshFields()), undefined, { now: NOW_MS });
    expect(res).toMatchObject({ ok: false, reason: "no_bot_token" });
  });

  it("rejects initData without a hash", () => {
    const params = new URLSearchParams(freshFields());
    expect(verifyInitData(params.toString(), TOKEN, { now: NOW_MS })).toMatchObject({
      ok: false,
      reason: "missing_hash",
    });
  });

  it("rejects a tampered hash", () => {
    const raw = signInitData(freshFields());
    const tampered = raw.replace(/hash=[0-9a-f]+/, "hash=deadbeef");
    expect(verifyInitData(tampered, TOKEN, { now: NOW_MS })).toMatchObject({ ok: false, reason: "bad_hash" });
  });

  it("rejects when a signed field is mutated after signing", () => {
    // Re-sign with the right token but a different one used to verify → hash mismatch.
    const raw = signInitData(freshFields(), "999:other-token");
    expect(verifyInitData(raw, TOKEN, { now: NOW_MS })).toMatchObject({ ok: false, reason: "bad_hash" });
  });

  it("rejects stale initData (older than max age)", () => {
    const old = NOW_SEC - INIT_DATA_MAX_AGE_SEC - 10;
    const res = verifyInitData(signInitData(freshFields({ auth_date: String(old) })), TOKEN, { now: NOW_MS });
    expect(res).toMatchObject({ ok: false, reason: "expired" });
  });

  it("accepts initData exactly at the freshness boundary", () => {
    const edge = NOW_SEC - INIT_DATA_MAX_AGE_SEC;
    const res = verifyInitData(signInitData(freshFields({ auth_date: String(edge) })), TOKEN, { now: NOW_MS });
    expect(res.ok).toBe(true);
  });

  it("rejects valid signature without a user", () => {
    const fields = freshFields();
    delete fields.user;
    expect(verifyInitData(signInitData(fields), TOKEN, { now: NOW_MS })).toMatchObject({
      ok: false,
      reason: "missing_user",
    });
  });

  it("rejects when the user field is not valid JSON", () => {
    const res = verifyInitData(signInitData(freshFields({ user: "not-json" })), TOKEN, { now: NOW_MS });
    expect(res).toMatchObject({ ok: false, reason: "bad_user" });
  });

  it("respects a custom maxAgeSec", () => {
    const ten = NOW_SEC - 10;
    const res = verifyInitData(signInitData(freshFields({ auth_date: String(ten) })), TOKEN, {
      now: NOW_MS,
      maxAgeSec: 5,
    });
    expect(res).toMatchObject({ ok: false, reason: "expired" });
  });
});

describe("isAdmin", () => {
  it("is true only for ids in the allowlist", () => {
    expect(isAdmin(42, [1, 42, 7])).toBe(true);
    expect(isAdmin(99, [1, 42, 7])).toBe(false);
    expect(isAdmin(42, [])).toBe(false);
  });
});

describe("parseTmaHeader", () => {
  it("extracts initData from a tma header (scheme case-insensitive)", () => {
    expect(parseTmaHeader("tma abc=1&hash=2")).toBe("abc=1&hash=2");
    expect(parseTmaHeader("TMA abc=1")).toBe("abc=1");
  });

  it("returns null for missing, malformed, or wrong-scheme headers", () => {
    expect(parseTmaHeader(undefined)).toBeNull();
    expect(parseTmaHeader("")).toBeNull();
    expect(parseTmaHeader("Bearer xyz")).toBeNull();
    expect(parseTmaHeader("tma")).toBeNull();
    expect(parseTmaHeader("tma   ")).toBeNull();
  });
});

describe("requireAdmin middleware", () => {
  function appWith(deps: Parameters<typeof requireAdmin>[0]) {
    const app = new Hono<{ Variables: AdminVariables }>();
    app.use("/admin/*", requireAdmin(deps));
    app.get("/admin/ping", (c) => c.json({ adminUserId: c.var.adminUserId }));
    return app;
  }

  const base = { botToken: TOKEN, adminUserIds: [42], now: () => NOW_MS };

  it("denies all when bot token is missing", async () => {
    const app = appWith({ ...base, botToken: undefined });
    const res = await app.request("/admin/ping");
    expect(res.status).toBe(401);
  });

  it("denies all when admin allowlist is empty", async () => {
    const app = appWith({ ...base, adminUserIds: [] });
    const res = await app.request("/admin/ping");
    expect(res.status).toBe(401);
  });

  it("401s without an Authorization header", async () => {
    const res = await appWith(base).request("/admin/ping");
    expect(res.status).toBe(401);
  });

  it("401s on invalid initData", async () => {
    const res = await appWith(base).request("/admin/ping", {
      headers: { Authorization: "tma garbage=1&hash=00" },
    });
    expect(res.status).toBe(401);
  });

  it("403s when the verified user is not an admin", async () => {
    const initData = signInitData(freshFields({ user: JSON.stringify({ id: 7, first_name: "Bob" }) }));
    const res = await appWith(base).request("/admin/ping", {
      headers: { Authorization: `tma ${initData}` },
    });
    expect(res.status).toBe(403);
  });

  it("passes a valid admin through and exposes adminUserId", async () => {
    const initData = signInitData(freshFields());
    const res = await appWith(base).request("/admin/ping", {
      headers: { Authorization: `tma ${initData}` },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ adminUserId: 42 });
  });
});
