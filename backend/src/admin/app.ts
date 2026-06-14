import { Hono, type Context } from "hono";
import { serveStatic } from "@hono/node-server/serve-static";
import { buildAdminApiRouter } from "./api/index.js";
import type { GetAdminDeps } from "./api/deps.js";
import type { AdminAuthDeps } from "./auth.js";
import { logger } from "../pkg/logger.js";

/** Default location of the built Mini App, relative to the backend CWD. */
const DEFAULT_STATIC_ROOT = "../frontend/dist";

const log = logger.child({ mod: "admin-app" });

/** A grammY webhook handler bound to the Hono adapter (`webhookCallback(bot, "hono")`). */
export type HonoWebhookHandler = (c: Context) => Response | Promise<Response>;

export interface AdminAppOptions {
  /** Lazily resolves chat deps (chat service boots after the server listens). */
  getDeps: GetAdminDeps;
  /** Lazily resolves the Telegram webhook handler (set only in webhook mode). */
  getWebhook: () => HonoWebhookHandler | undefined;
  /** Path the Telegram webhook listens on (default /telegram). */
  webhookPath: string;
  /** initData/admin-allowlist config for the admin API gate. */
  auth: AdminAuthDeps;
  /** Directory of the built Mini App to serve as static (default ../frontend/dist). */
  staticRoot?: string;
}

/**
 * Build the single-process HTTP surface (ROADMAP §2):
 *   - `GET /health`            — liveness, always available
 *   - `POST <webhookPath>`     — Telegram webhook (503 until the bot is up)
 *   - `/admin/api/*`           — admin REST API behind initData auth
 *
 * Static Mini App serving (`frontend/dist`) is mounted in Task 9, after the API
 * routes, once the build output exists — keeping route precedence unambiguous.
 */
export function buildAdminApp(opts: AdminAppOptions): Hono {
  const app = new Hono();

  app.get("/health", (c) => c.json({ status: "ok", service: "jarvis" }));

  app.post(opts.webhookPath, async (c) => {
    const webhook = opts.getWebhook();
    if (!webhook) return c.body(null, 503);
    return webhook(c);
  });

  app.route("/admin/api", buildAdminApiRouter(opts.getDeps, opts.auth));

  // Built Mini App (frontend/dist). It uses HashRouter, so only "/", "/index.html"
  // and "/assets/*" reach the server — registered AFTER the API/health/webhook so
  // they always take precedence (no catch-all that could shadow them). A no-op
  // (404) until the frontend is built. Prod container paths are finalized in M9.
  const staticRoot = opts.staticRoot ?? DEFAULT_STATIC_ROOT;
  const serveIndex = serveStatic({ root: staticRoot, rewriteRequestPath: () => "/index.html" });
  app.use("/assets/*", serveStatic({ root: staticRoot }));
  app.get("/", serveIndex);
  app.get("/index.html", serveIndex);

  if (!opts.auth.botToken || opts.auth.adminUserIds.length === 0) {
    log.warn(
      { hasToken: Boolean(opts.auth.botToken), adminCount: opts.auth.adminUserIds.length },
      "admin API in deny-all mode (set TELEGRAM_BOT_TOKEN and ADMIN_USER_IDS to enable)",
    );
  }

  return app;
}
