import { serve, type ServerType } from "@hono/node-server";
import { Bot, webhookCallback } from "grammy";
import { logger } from "./pkg/logger.js";
import { env } from "./config/env.js";
import { libsql, db } from "./db/client.js";
import { mastra, storage } from "./mastra/index.js";
import { createChatService, type ChatService } from "./app.js";
import { ensurePopulated } from "./content/store.js";
import {
  DEFAULTS_PROMPTS_DIR,
  DEFAULTS_SKILLS_DIR,
  promptsStoreDir,
  skillsStoreDir,
} from "./content/paths.js";
import { ModelFactory } from "./mastra/models.js";
import { SpeechService } from "./mastra/speech.js";
import { createBot, applyBotCommands } from "./telegram/bot.js";
import type { CommandDeps } from "./telegram/commands.js";
import { Messenger } from "./telegram/messenger.js";
import { buildCronScheduler } from "./scheduler/wiring.js";
import type { Scheduler } from "./scheduler/scheduler.js";
import { buildAdminApp, type HonoWebhookHandler } from "./admin/app.js";

const log = logger.child({ mod: "server" });
const PORT = Number(process.env.PORT ?? 8080);

/** Constructed at boot (best-effort); the Telegram bot (M6) and admin API (M8) drive it. */
export let chatService: ChatService | undefined;
/** The grammY bot, once started (only when TELEGRAM_BOT_TOKEN is set). */
let bot: Bot | undefined;
/** The cron scheduler (M7), once started (only when the bot is up to deliver notifications). */
let scheduler: Scheduler | undefined;
/** Telegram webhook handler (Hono adapter), set only when the bot runs in webhook mode. */
let webhookHandler: HonoWebhookHandler | undefined;

/** Path the webhook listens on (pathname of TELEGRAM_WEBHOOK_URL, default /telegram). */
function webhookPath(): string {
  try {
    if (env.TELEGRAM_WEBHOOK_URL) return new URL(env.TELEGRAM_WEBHOOK_URL).pathname || "/telegram";
  } catch {
    /* fall through to default */
  }
  return "/telegram";
}

/**
 * Build and start the Telegram bot over the already-initialized chat service.
 * Best-effort: any failure is logged and leaves the HTTP server running.
 * Returns the bot (for shutdown) or undefined when not started.
 */
async function startBot(svc: ChatService): Promise<Bot | undefined> {
  if (!env.TELEGRAM_BOT_TOKEN) {
    log.warn("TELEGRAM_BOT_TOKEN not set — Telegram bot not started (chat service still available)");
    return undefined;
  }

  // SpeechService is not part of ChatDeps (it is Telegram-specific) — build it here.
  const speech = new SpeechService(new ModelFactory(), svc.deps.settings);
  const commandDeps: CommandDeps = {
    db: svc.deps.db,
    settings: svc.deps.settings,
    skills: svc.deps.skills,
    usage: svc.deps.usage,
    memory: svc.deps.memoryService,
    chat: svc,
  };

  const b = createBot({
    token: env.TELEGRAM_BOT_TOKEN,
    db: svc.deps.db,
    settings: svc.deps.settings,
    chat: svc,
    speech,
    commandDeps,
  });

  await applyBotCommands(b.api).catch((err) =>
    log.warn({ reason: err instanceof Error ? err.message : String(err) }, "setMyCommands failed"),
  );

  if (env.telegramUseWebhook && env.TELEGRAM_WEBHOOK_URL) {
    // TODO[M8]: secret-token validation on the webhook route.
    await b.api.setWebhook(env.TELEGRAM_WEBHOOK_URL);
    webhookHandler = webhookCallback(b, "hono");
    log.info({ mode: "webhook", path: webhookPath() }, "telegram bot ready (webhook)");
  } else {
    void b
      .start({ onStart: () => log.info({ mode: "polling" }, "telegram bot started (polling)") })
      .catch((err) =>
        log.error({ reason: err instanceof Error ? err.message : String(err) }, "telegram polling stopped"),
      );
  }
  return b;
}

/**
 * Start the cron scheduler (M7) once the bot is up. Best-effort: a failure is
 * logged and leaves the bot + HTTP server running. Skipped when there is no
 * bot — without a Telegram channel there is nowhere to deliver notifications.
 */
function startScheduler(svc: ChatService): void {
  if (!bot) {
    log.warn("cron scheduler not started (no Telegram bot — nowhere to deliver notifications)");
    return;
  }
  try {
    scheduler = buildCronScheduler(svc, new Messenger(bot.api));
    scheduler.start();
  } catch (err) {
    log.warn(
      { reason: err instanceof Error ? err.message : String(err) },
      "cron scheduler failed to start",
    );
  }
}

/**
 * Populate the file-backed skill/prompt store from the image's bundled defaults
 * on first run (idempotent — a no-op once the persistent volume has content).
 * MUST complete before {@link createChatService}, which constructs SkillService
 * and immediately reads skills/prompts from the store.
 */
async function populateContentStore(): Promise<void> {
  const [skillsCopied, promptsCopied] = await Promise.all([
    ensurePopulated(skillsStoreDir(), DEFAULTS_SKILLS_DIR),
    ensurePopulated(promptsStoreDir(), DEFAULTS_PROMPTS_DIR),
  ]);
  log.info({ skillsCopied, promptsCopied }, "content store ready");
}

/**
 * Single-process entry point (ROADMAP §2): one Hono HTTP server (health +
 * Telegram webhook + admin API) plus the grammY bot and the cron scheduler,
 * all on one libSQL/Mastra-backed stack.
 */
function main(): void {
  // Touch the Mastra instance so storage is constructed at boot.
  void mastra;

  // The HTTP surface comes up immediately; the chat stack, bot and scheduler are
  // wired asynchronously (best-effort) so a fresh, unmigrated DB cannot stop the
  // server from serving /health. Admin API / webhook routes read live state via
  // the getters below and answer 503 until that state exists.
  const app = buildAdminApp({
    getDeps: () => chatService?.deps,
    getWebhook: () => webhookHandler,
    webhookPath: webhookPath(),
    auth: { botToken: env.TELEGRAM_BOT_TOKEN, adminUserIds: env.adminUserIds },
    // Optional override; defaults to ../frontend/dist relative to the backend CWD.
    staticRoot: process.env.ADMIN_STATIC_DIR || undefined,
  });

  populateContentStore()
    .then(() => createChatService({ db, storage }))
    .then(async (svc) => {
      chatService = svc;
      bot = await startBot(svc).catch((err) => {
        log.error({ reason: err instanceof Error ? err.message : String(err) }, "telegram bot failed to start");
        return undefined;
      });
      startScheduler(svc);
    })
    .catch((err) => {
      log.warn(
        { reason: err instanceof Error ? err.message : String(err) },
        "chat service init deferred (run migrations/seed?)",
      );
    });

  const server: ServerType = serve({ fetch: app.fetch, port: PORT }, (info) =>
    log.info({ port: info.port }, "jarvis server started"),
  );

  let shuttingDown = false;
  const shutdown = (signal: NodeJS.Signals): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info({ signal }, "graceful shutdown");
    scheduler?.stop(); // stop cron ticks before tearing down the DB
    void bot?.stop().catch(() => {}); // stop polling / webhook intake
    server.close(() => {
      void chatService?.close().catch(() => {}); // best-effort resource release
      libsql.close();
      log.info("shutdown complete");
      process.exit(0);
    });
    // Safety net if connections don't drain in time.
    setTimeout(() => process.exit(1), 5000).unref();
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main();
