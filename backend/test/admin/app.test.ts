import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildAdminApp } from "../../src/admin/app.js";
import type { AdminApiDeps } from "../../src/admin/api/deps.js";

const TOKEN = "123456:TEST-bot-token";
const NOW_SEC = Math.floor(Date.now() / 1000);

function signInitData(fields: Record<string, string>): string {
  const dcs = Object.entries(fields)
    .map(([k, v]) => `${k}=${v}`)
    .sort()
    .join("\n");
  const secret = createHmac("sha256", "WebAppData").update(TOKEN).digest();
  const hash = createHmac("sha256", secret).update(dcs).digest("hex");
  const params = new URLSearchParams(fields);
  params.set("hash", hash);
  return params.toString();
}

function adminInitData(id: number): string {
  return signInitData({
    auth_date: String(NOW_SEC),
    user: JSON.stringify({ id, first_name: "Ada" }),
  });
}

/** A stub that satisfies the deps gate; /me never touches its fields. */
const STUB_DEPS = {} as AdminApiDeps;

function makeApp(over: Partial<Parameters<typeof buildAdminApp>[0]> = {}) {
  return buildAdminApp({
    getDeps: () => STUB_DEPS,
    getWebhook: () => undefined,
    webhookPath: "/telegram",
    auth: { botToken: TOKEN, adminUserIds: [42] },
    ...over,
  });
}

describe("buildAdminApp", () => {
  it("serves /health without auth", async () => {
    const res = await makeApp().request("/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok", service: "jarvis" });
  });

  it("returns 503 on the webhook path until the bot is up", async () => {
    const res = await makeApp().request("/telegram", { method: "POST" });
    expect(res.status).toBe(503);
  });

  it("forwards the webhook to the handler once present", async () => {
    const app = makeApp({ getWebhook: () => (c) => c.text("handled", 200) });
    const res = await app.request("/telegram", { method: "POST" });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("handled");
  });

  it("401s on /admin/api/me without initData", async () => {
    const res = await makeApp().request("/admin/api/me");
    expect(res.status).toBe(401);
  });

  it("401s on /admin/api/me with invalid initData", async () => {
    const res = await makeApp().request("/admin/api/me", {
      headers: { Authorization: "tma bad=1&hash=00" },
    });
    expect(res.status).toBe(401);
  });

  it("403s a verified non-admin user", async () => {
    const res = await makeApp().request("/admin/api/me", {
      headers: { Authorization: `tma ${adminInitData(7)}` },
    });
    expect(res.status).toBe(403);
  });

  it("returns 503 when the chat service is not yet ready", async () => {
    const app = makeApp({ getDeps: () => undefined });
    const res = await app.request("/admin/api/me", {
      headers: { Authorization: `tma ${adminInitData(42)}` },
    });
    expect(res.status).toBe(503);
  });

  it("passes an authenticated admin through to /me", async () => {
    const res = await makeApp().request("/admin/api/me", {
      headers: { Authorization: `tma ${adminInitData(42)}` },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ adminUserId: 42 });
  });
});

describe("buildAdminApp static Mini App serving", () => {
  it("serves the built app without shadowing the API/health/webhook", async () => {
    const dir = mkdtempSync(join(tmpdir(), "jarvis-dist-"));
    mkdirSync(join(dir, "assets"));
    writeFileSync(join(dir, "index.html"), '<!doctype html><div id="root"></div>');
    writeFileSync(join(dir, "assets", "app.js"), "console.log(1)");
    try {
      const app = makeApp({ staticRoot: dir });

      const root = await app.request("/");
      expect(root.status).toBe(200);
      expect(await root.text()).toContain('id="root"');

      const asset = await app.request("/assets/app.js");
      expect(asset.status).toBe(200);

      // Static must not shadow the API, health, or 404 routing.
      expect((await app.request("/health")).status).toBe(200);
      expect((await app.request("/admin/api/me")).status).toBe(401);
      expect((await app.request("/no-such-path")).status).toBe(404);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
