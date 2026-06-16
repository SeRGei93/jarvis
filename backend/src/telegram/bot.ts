import { Bot, type BotConfig, type Context } from "grammy";
import type { LibSQLDatabase } from "drizzle-orm/libsql";
import * as schema from "../db/schema.js";
import type { SettingsService } from "../config/settings.js";
import { resolveTelegramUser, type TelegramUserInfo } from "./identity.js";
import { createStreamer, type TelegramSender } from "./stream.js";
import { transcribeVoice, type VoiceApi, type VoiceTranscriber, type FetchLike } from "./voice.js";
import { Messenger } from "./messenger.js";
import { TelegramReplyError } from "./errors.js";
import {
  BOT_COMMANDS,
  cmdStart,
  cmdHelp,
  cmdNew,
  cmdMe,
  cmdTasks,
  cmdUsage,
  cmdAbout,
  cmdResetOnboarding,
  type CommandDeps,
  type ChatHandler,
} from "./commands.js";
import { logger } from "../pkg/logger.js";

const log = logger.child({ mod: "tg-bot" });

type Db = LibSQLDatabase<typeof schema>;

/** Shown when an unhandled error reaches bot.catch. */
export const GENERIC_ERROR = "Произошла ошибка при обработке сообщения. Попробуйте позже.";
/** Shown for content types the bot can't process (photos, stickers, …). */
export const UNSUPPORTED_REPLY =
  "Я пока не умею обрабатывать этот тип контента. Отправьте текстовое или голосовое сообщение.";

/** Minimal settings surface the allowlist gate needs. */
export interface AllowlistSettings {
  refreshIfStale(): Promise<void>;
  getAllowedUsers(): Promise<number[]>;
}

/** Everything the message/command handlers need, bundled once in createBot. */
export interface BotRuntime {
  api: TelegramSender & VoiceApi;
  db: Db;
  chat: ChatHandler;
  speech: VoiceTranscriber;
  messenger: Messenger;
  token: string;
  fetchFn: FetchLike;
  commandDeps: CommandDeps;
}

export interface BotOptions {
  token: string;
  db: Db;
  settings: SettingsService;
  chat: ChatHandler;
  speech: VoiceTranscriber;
  commandDeps: CommandDeps;
  /** Voice download fetch (tests). */
  fetchFn?: FetchLike;
  /** grammY Bot config passthrough (tests inject `botInfo` to run offline). */
  botConfig?: BotConfig<Context>;
}

/** True when the Telegram user passes the allowlist (empty list = allow everyone). */
export async function isAuthorized(settings: AllowlistSettings, userId?: number): Promise<boolean> {
  if (userId == null) return false;
  await settings.refreshIfStale();
  const allowed = await settings.getAllowedUsers();
  return allowed.length === 0 || allowed.includes(userId);
}

/**
 * Stream a chat reply: typing indicator → handleUserMessage(onText) → finalize.
 * `draftId` is the inbound `update_id`, correlating the streaming rich drafts.
 */
async function streamReply(
  rt: BotRuntime,
  userId: number,
  chatId: number,
  text: string,
  draftId: number,
): Promise<void> {
  const stopTyping = rt.messenger.startTypingLoop(chatId);
  const streamer = createStreamer(rt.api, chatId, draftId, { onFirstChunk: stopTyping });
  try {
    const result = await rt.chat.handleUserMessage(userId, chatId, text, streamer.onText);
    await streamer.finalize(result.text);
  } finally {
    stopTyping();
  }
}

/** Handle an inbound text message end-to-end. `draftId` is the inbound update_id. */
export async function processText(
  rt: BotRuntime,
  tgUser: TelegramUserInfo,
  chatId: number,
  text: string,
  draftId: number,
): Promise<void> {
  const { userId } = await resolveTelegramUser(rt.db, tgUser);
  await streamReply(rt, userId, chatId, text, draftId);
}

/** Handle an inbound voice message: transcribe, then stream the reply. */
export async function processVoice(
  rt: BotRuntime,
  tgUser: TelegramUserInfo,
  chatId: number,
  fileId: string,
  duration: number,
  draftId: number,
): Promise<void> {
  const { userId } = await resolveTelegramUser(rt.db, tgUser);
  // Transcription (download + speech model) can take seconds — show typing meanwhile.
  const stopTyping = rt.messenger.startTypingLoop(chatId);
  let text: string;
  try {
    // transcribeVoice throws TelegramReplyError on a user-visible failure; bot.catch surfaces it.
    text = await transcribeVoice(rt.api, rt.speech, rt.token, fileId, duration, rt.fetchFn);
  } catch (err) {
    stopTyping();
    throw err;
  }
  stopTyping(); // streamReply starts its own typing loop
  await streamReply(rt, userId, chatId, text, draftId);
}

/** Register the slash-command menu so Telegram shows command hints. */
export async function applyBotCommands(api: {
  setMyCommands(cmds: { command: string; description: string }[]): Promise<unknown>;
}): Promise<void> {
  await api.setMyCommands(BOT_COMMANDS.map((c) => ({ command: c.command, description: c.description })));
}

function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function senderInfo(from: { id: number; first_name?: string; last_name?: string } | undefined): TelegramUserInfo | null {
  if (!from) return null;
  const name = [from.first_name, from.last_name].filter(Boolean).join(" ");
  return { id: from.id, name };
}

/**
 * Assemble the grammY bot: allowlist gate → command handlers → text/voice
 * streaming → unsupported fallback → global error handler. The streaming reply
 * path uses stream.ts; command replies and the error path use Messenger.
 */
export function createBot(opts: BotOptions): Bot {
  const bot = new Bot(opts.token, opts.botConfig);
  const messenger = new Messenger(bot.api);
  const rt: BotRuntime = {
    api: bot.api,
    db: opts.db,
    chat: opts.chat,
    speech: opts.speech,
    messenger,
    token: opts.token,
    fetchFn: opts.fetchFn ?? fetch,
    commandDeps: opts.commandDeps,
  };

  // Allowlist gate: drop unauthorized updates silently (parity with Go authorize()).
  bot.use(async (ctx, next) => {
    if (!(await isAuthorized(opts.settings, ctx.from?.id))) {
      log.warn({ tgUser: ctx.from?.id }, "unauthorized update dropped");
      return;
    }
    await next();
  });

  const runCommand = async (
    chatId: number,
    from: TelegramUserInfo | null,
    produce: (userId: number) => string | Promise<string>,
  ): Promise<void> => {
    if (!from) return;
    const { userId } = await resolveTelegramUser(rt.db, from);
    const text = await produce(userId);
    await rt.messenger.sendMessage(chatId, text);
  };

  bot.command("start", (ctx) => runCommand(ctx.chat.id, senderInfo(ctx.from), () => cmdStart(rt.commandDeps)));
  bot.command("help", (ctx) => runCommand(ctx.chat.id, senderInfo(ctx.from), () => cmdHelp()));
  bot.command("new", (ctx) => runCommand(ctx.chat.id, senderInfo(ctx.from), (uid) => cmdNew(rt.commandDeps, uid, ctx.chat.id)));
  bot.command("me", (ctx) => runCommand(ctx.chat.id, senderInfo(ctx.from), (uid) => cmdMe(rt.commandDeps, uid)));
  bot.command("tasks", (ctx) => runCommand(ctx.chat.id, senderInfo(ctx.from), (uid) => cmdTasks(rt.commandDeps, uid, ctx.match)));
  bot.command("usage", (ctx) => runCommand(ctx.chat.id, senderInfo(ctx.from), (uid) => cmdUsage(rt.commandDeps, uid, ctx.match)));
  bot.command("about", (ctx) => runCommand(ctx.chat.id, senderInfo(ctx.from), (uid) => cmdAbout(rt.commandDeps, uid, ctx.chat.id)));
  bot.command("reset_onboarding", (ctx) =>
    runCommand(ctx.chat.id, senderInfo(ctx.from), (uid) => cmdResetOnboarding(rt.commandDeps, uid, ctx.chat.id)),
  );

  bot.on("message:text", async (ctx) => {
    const from = senderInfo(ctx.from);
    if (from) await processText(rt, from, ctx.chat.id, ctx.message.text, ctx.update.update_id);
  });
  bot.on("message:voice", async (ctx) => {
    const from = senderInfo(ctx.from);
    if (from)
      await processVoice(
        rt,
        from,
        ctx.chat.id,
        ctx.message.voice.file_id,
        ctx.message.voice.duration,
        ctx.update.update_id,
      );
  });
  bot.on("message", (ctx) => rt.messenger.sendMessage(ctx.chat.id, UNSUPPORTED_REPLY));

  bot.catch(async (err) => {
    const chatId = err.ctx.chat?.id;
    const e = err.error;
    if (chatId == null) {
      log.error({ reason: errMessage(e) }, "handler error without a chat");
      return;
    }
    if (e instanceof TelegramReplyError) {
      await rt.messenger.sendMessage(chatId, e.userMessage).catch(() => {});
      return;
    }
    log.error({ reason: errMessage(e) }, "handler failed");
    await rt.messenger.sendMessage(chatId, GENERIC_ERROR).catch(() => {});
  });

  log.info("telegram bot wired");
  return bot;
}
