import { Bot, InlineKeyboard, type Api, type BotConfig, type Context } from "grammy";
import type { LibSQLDatabase } from "drizzle-orm/libsql";
import * as schema from "../db/schema.js";
import type { SettingsService } from "../config/settings.js";
import type { ChatResult } from "../mastra/workflows/chat.js";
import type { ConfirmationRequest, ConfirmationResult } from "../mastra/confirmations/confirmation-service.js";
import { resolveTelegramUser, type TelegramUserInfo } from "./identity.js";
import type { AccessRequestService } from "../services/access-request-service.js";
import { createStreamer, type TelegramSender, type Streamer } from "./stream.js";
import type { ToolEvents } from "../mastra/llm.js";
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
/** Sent once to an unknown user in `approval` mode when their access request is created. */
export const ACCESS_REQUESTED_REPLY =
  "Заявка на доступ отправлена администратору. Дождитесь одобрения 🙌";

/** Minimal settings surface the allowlist gate needs. */
export interface AllowlistSettings {
  refreshIfStale(): Promise<void>;
  getAllowedUsers(): Promise<number[]>;
}

/** Resolves a risky-tool confirmation when the user taps approve/decline (C1). */
export interface ConfirmationResolver {
  resolve(userId: number, id: number, approved: boolean): Promise<ConfirmationResult>;
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
  /** Risky-tool confirmations (C1); absent → confirmation buttons are not handled. */
  confirmations?: ConfirmationResolver;
  /** Telegram ids that get the debug trace (tool/skill calls + reasoning). */
  adminUserIds: number[];
}

export interface BotOptions {
  token: string;
  db: Db;
  settings: SettingsService;
  chat: ChatHandler;
  speech: VoiceTranscriber;
  commandDeps: CommandDeps;
  /** Risky-tool confirmation resolver (C1); wired to ChatService.deps.confirmations. */
  confirmations?: ConfirmationResolver;
  /**
   * Access-request inbox (M17). Required for `approval` mode: an unknown user's
   * message is recorded here instead of dropped. Absent → approval mode degrades to
   * a silent drop (logged).
   */
  accessRequests?: AccessRequestService;
  /** Voice download fetch (tests). */
  fetchFn?: FetchLike;
  /** grammY Bot config passthrough (tests inject `botInfo` to run offline). */
  botConfig?: BotConfig<Context>;
  /** Admin Telegram ids (from ADMIN_USER_IDS) — they see the debug trace. */
  adminUserIds?: number[];
}

/** True when the Telegram user passes the allowlist (empty list = allow everyone). */
export async function isAuthorized(settings: AllowlistSettings, userId?: number): Promise<boolean> {
  if (userId == null) return false;
  await settings.refreshIfStale();
  const allowed = await settings.getAllowedUsers();
  return allowed.length === 0 || allowed.includes(userId);
}

/** Friendly live status lines shown while the agent runs a tool (B2). */
const TOOL_STATUS: Record<string, string> = {
  load_skill: "🧩 подключаю навык…",
  web_search: "🔎 ищу в интернете…",
  web_search_batch: "🔎 ищу в интернете…",
  search_news: "📰 ищу новости…",
  fetch_url: "🌐 читаю страницу…",
  currency_rates: "💱 узнаю курс…",
  weather: "🌤 смотрю погоду…",
  kufar_search: "🛒 ищу объявления…",
  avby_search: "🚗 ищу авто…",
  rabota_search: "💼 ищу вакансии…",
  transport_search: "🚌 смотрю расписание…",
  relax_search: "🎭 ищу досуг…",
  relax_afisha: "🎭 смотрю афишу…",
  med103_doctor_search: "🩺 ищу врача…",
  med103_clinic_search: "🏥 ищу клинику…",
};
/** Generic fallback status for any other tool. */
const DEFAULT_TOOL_STATUS = "⏳ обрабатываю…";

function toolStatusLine(toolName: string): string {
  return TOOL_STATUS[toolName] ?? DEFAULT_TOOL_STATUS;
}

/** One running/finished tool call in the admin debug trace. */
interface TraceEntry {
  name: string;
  argsSummary: string;
  state: "run" | "ok" | "err";
}

/** Compact, single-line summary of a tool's args for the debug trace. */
function summarizeArgs(toolName: string, args: unknown): string {
  if (args == null || typeof args !== "object") return "";
  const obj = args as Record<string, unknown>;
  // load_skill's `name` is the most useful debug detail — show just the skill.
  if (toolName === "load_skill" && typeof obj.name === "string") return obj.name;
  const parts: string[] = [];
  for (const [k, v] of Object.entries(obj)) {
    if (v == null || typeof v === "object") continue; // skip nested/empty
    let s = String(v).replace(/\s+/g, " ").trim();
    if (s.length > 40) s = s.slice(0, 39) + "…";
    parts.push(`${k}=${s}`);
    if (parts.join(", ").length > 80) break;
  }
  return parts.join(", ");
}

/** Render the trace entries into the draft footer (e.g. "🔧 load_skill(currency) ✓"). */
function renderTrace(entries: TraceEntry[]): string {
  const icon = { run: "…", ok: "✓", err: "✗" } as const;
  return entries
    .map((e) => `🔧 ${e.name}(${e.argsSummary})`.replace("()", "") + ` ${icon[e.state]}`)
    .join("\n");
}

/**
 * Stream a chat reply: typing indicator → handleUserMessage(onText, onTool) →
 * finalize. `draftId` is the inbound `update_id`, correlating the streaming rich
 * drafts. Tool activity surfaces as transient "🔎 ищу…" status drafts (B2).
 */
async function streamReply(
  rt: BotRuntime,
  userId: number,
  chatId: number,
  text: string,
  draftId: number,
  tgUserId: number,
): Promise<ChatResult> {
  const stopTyping = rt.messenger.startTypingLoop(chatId);
  const streamer = createStreamer(rt.api, chatId, draftId, { onFirstChunk: stopTyping });
  // Gate the debug overlay on the *Telegram* id (ADMIN_USER_IDS holds Telegram ids),
  // NOT the internal users.id that resolveTelegramUser returns.
  const isAdmin = rt.adminUserIds.includes(tgUserId);
  try {
    const result = await rt.chat.handleUserMessage(userId, chatId, text, streamer.onText, toolEvents(streamer, isAdmin));
    await streamer.finalize(result.text);
    return result;
  } finally {
    stopTyping();
  }
}

/**
 * Tool-event wiring. Admins get a live debug trace (tool/skill calls with args +
 * ✓/✗, dropped on finalize) plus the reasoning stream (kept in a spoiler). Everyone
 * else gets the friendly pre-text status line (B2).
 */
function toolEvents(streamer: Streamer, isAdmin: boolean): ToolEvents {
  if (!isAdmin) {
    return { onStart: (toolName) => streamer.status(toolStatusLine(toolName)) };
  }
  const trace: TraceEntry[] = [];
  return {
    onStart: (toolName, args) => {
      trace.push({ name: toolName, argsSummary: summarizeArgs(toolName, args), state: "run" });
      streamer.setTrace(renderTrace(trace));
    },
    onFinish: (toolName, isError) => {
      // Mark the most recent still-running call of this tool done.
      for (let i = trace.length - 1; i >= 0; i--) {
        if (trace[i].name === toolName && trace[i].state === "run") {
          trace[i].state = isError ? "err" : "ok";
          break;
        }
      }
      streamer.setTrace(renderTrace(trace));
    },
    onReasoning: (accumulated) => streamer.setReasoning(accumulated),
  };
}

/**
 * Send approve/decline inline-keyboard messages for any risky-tool confirmations
 * the turn requested (C1). callback_data is `cfm:<a|d>:<id>`, matched below.
 */
async function sendConfirmations(api: Api, chatId: number, requests?: ConfirmationRequest[]): Promise<void> {
  if (!requests?.length) return;
  for (const r of requests) {
    const kb = new InlineKeyboard()
      .text("✅ Подтвердить", `cfm:a:${r.id}`)
      .text("❌ Отменить", `cfm:d:${r.id}`);
    await api
      .sendMessage(chatId, r.summary || "Подтвердите действие:", { reply_markup: kb })
      .catch((err) => log.warn({ reason: errMessage(err) }, "send confirmation buttons failed"));
  }
}

/** Handle an inbound text message end-to-end. `draftId` is the inbound update_id. */
export async function processText(
  rt: BotRuntime,
  tgUser: TelegramUserInfo,
  chatId: number,
  text: string,
  draftId: number,
): Promise<ChatResult> {
  const { userId } = await resolveTelegramUser(rt.db, tgUser);
  return streamReply(rt, userId, chatId, text, draftId, tgUser.id);
}

/** Handle an inbound voice message: transcribe, then stream the reply. */
export async function processVoice(
  rt: BotRuntime,
  tgUser: TelegramUserInfo,
  chatId: number,
  fileId: string,
  duration: number,
  draftId: number,
): Promise<ChatResult> {
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
  return streamReply(rt, userId, chatId, text, draftId, tgUser.id);
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
    confirmations: opts.confirmations,
    adminUserIds: opts.adminUserIds ?? [],
  };

  // Access gate (M17). `open` mode keeps the legacy behavior (empty allowlist =
  // everyone). `approval` mode admits only allowlisted ids; an unknown user's
  // message is turned into an access request (instead of a silent drop) and they
  // get a one-time "request sent" reply. refreshIfStale() picks up an admin
  // approval made in this same process (shared SettingsService → invalidate()).
  bot.use(async (ctx, next) => {
    const userId = ctx.from?.id;
    if (userId == null) return;
    // One staleness check, then read both values from the (now-fresh) cache —
    // avoids a second SELECT max(updated_at) that an isAuthorized() call would do.
    await opts.settings.refreshIfStale();
    const [mode, allowed] = await Promise.all([
      opts.settings.getAccessMode(),
      opts.settings.getAllowedUsers(),
    ]);
    // open: empty list = everyone. approval: only listed ids (no empty shortcut).
    const authorized =
      mode === "open" ? allowed.length === 0 || allowed.includes(userId) : allowed.includes(userId);
    if (authorized) {
      await next();
      return;
    }

    if (mode === "open") {
      log.warn({ tgUser: userId, mode }, "unauthorized update dropped");
      return;
    }

    // approval mode: turn the unknown user into an access request + one-time reply.
    if (!opts.accessRequests) {
      log.warn({ tgUser: userId, mode }, "unauthorized update dropped (no access-request service)");
      return;
    }
    const { created } = await opts.accessRequests.record({
      id: userId,
      name: [ctx.from?.first_name, ctx.from?.last_name].filter(Boolean).join(" "),
      username: ctx.from?.username,
    });
    if (created) {
      log.info({ tgUser: userId }, "access request created; prompting user");
      await messenger.sendMessage(ctx.chat?.id ?? userId, ACCESS_REQUESTED_REPLY).catch(() => {});
    } else {
      log.warn({ tgUser: userId, mode }, "unauthorized update dropped (request already pending/decided)");
    }
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

  // Risky-tool confirmations (C1): user taps approve/decline → resolve + report.
  bot.callbackQuery(/^cfm:(a|d):(\d+)$/, async (ctx) => {
    const from = senderInfo(ctx.from);
    if (!from || !rt.confirmations) {
      await ctx.answerCallbackQuery();
      return;
    }
    const approved = ctx.match![1] === "a";
    const id = Number(ctx.match![2]);
    const { userId } = await resolveTelegramUser(rt.db, from);
    const res = await rt.confirmations.resolve(userId, id, approved);
    await ctx.answerCallbackQuery({ text: res.message.slice(0, 200) });
    // Replace the buttons with the outcome so it can't be tapped twice.
    await ctx.editMessageText(res.message).catch(() => {});
  });

  bot.on("message:text", async (ctx) => {
    const from = senderInfo(ctx.from);
    if (!from) return;
    const result = await processText(rt, from, ctx.chat.id, ctx.message.text, ctx.update.update_id);
    await sendConfirmations(bot.api, ctx.chat.id, result.confirmations);
  });
  bot.on("message:voice", async (ctx) => {
    const from = senderInfo(ctx.from);
    if (!from) return;
    const result = await processVoice(
      rt,
      from,
      ctx.chat.id,
      ctx.message.voice.file_id,
      ctx.message.voice.duration,
      ctx.update.update_id,
    );
    await sendConfirmations(bot.api, ctx.chat.id, result.confirmations);
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
