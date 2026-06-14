import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { Bot, webhookCallback } from "grammy";
import { logger } from "./pkg/logger.js";
import { env } from "./config/env.js";
import { libsql, db } from "./db/client.js";
import { mastra, storage, vector } from "./mastra/index.js";
import { createChatService, type ChatService } from "./app.js";
import { ModelFactory } from "./mastra/models.js";
import { SpeechService } from "./mastra/speech.js";
import { createBot, applyBotCommands } from "./telegram/bot.js";
import type { CommandDeps } from "./telegram/commands.js";

const log = logger.child({ mod: "server" });
const PORT = Number(process.env.PORT ?? 8080);

/** Constructed at boot (best-effort); the Telegram bot (M6) drives it. */
export let chatService: ChatService | undefined;
/** The grammY bot, once started (only when TELEGRAM_BOT_TOKEN is set). */
let bot: Bot | undefined;
/** Webhook request handler, mounted on the health server in webhook mode. */
let webhookHandler: ((req: IncomingMessage, res: ServerResponse) => Promise<void>) | undefined;

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
 * Best-effort: any failure is logged and leaves the health server running.
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
    // TODO[M8]: secret-token validation + proper routing on the Hono admin server.
    await b.api.setWebhook(env.TELEGRAM_WEBHOOK_URL);
    webhookHandler = webhookCallback(b, "http");
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
 * Single-process entry point (ROADMAP §2): a health HTTP server plus the grammY
 * bot (and, later, the cron scheduler), all on one libSQL/Mastra-backed stack.
 */
function main(): void {
  // Touch the Mastra instance so storage/vector are constructed at boot.
  void mastra;

  // Wire the chat stack, then start the bot. Best-effort: a fresh DB (not yet
  // migrated/seeded) must not stop the health server from coming up.
  createChatService({ db, storage, vector })
    .then(async (svc) => {
      chatService = svc;
      bot = await startBot(svc).catch((err) => {
        log.error({ reason: err instanceof Error ? err.message : String(err) }, "telegram bot failed to start");
        return undefined;
      });
    })
    .catch((err) => {
      log.warn(
        { reason: err instanceof Error ? err.message : String(err) },
        "chat service init deferred (run migrations/seed?)",
      );
    });

  const path = webhookPath();
  const server: Server = createServer((req, res) => {
    if (webhookHandler && req.method === "POST" && req.url === path) {
      void webhookHandler(req, res).catch((err) => {
        log.warn({ reason: err instanceof Error ? err.message : String(err) }, "webhook handler error");
        if (!res.headersSent) res.writeHead(500).end();
      });
      return;
    }
    if (req.method === "GET" && req.url === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "ok", service: "jarvis" }));
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  });

  server.listen(PORT, () => log.info({ port: PORT }, "jarvis server started"));

  let shuttingDown = false;
  const shutdown = (signal: NodeJS.Signals): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info({ signal }, "graceful shutdown");
    void bot?.stop().catch(() => {}); // stop polling / webhook intake
    server.close(() => {
      void chatService?.close().catch(() => {}); // best-effort MCP disconnect
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
