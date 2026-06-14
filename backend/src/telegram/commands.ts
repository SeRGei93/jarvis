import { and, eq } from "drizzle-orm";
import type { LibSQLDatabase } from "drizzle-orm/libsql";
import * as schema from "../db/schema.js";
import { users, sessions, cronTasks, userChannels } from "../db/schema.js";
import type { SettingsService } from "../config/settings.js";
import type { SkillService } from "../services/skill-service.js";
import type { UsageService } from "../services/usage.js";
import type { MemoryService } from "../mastra/memory/memory-service.js";
import { rotateThread } from "../mastra/memory/history.js";
import type { ChatResult } from "../mastra/workflows/chat.js";
import type { StreamCallback } from "../mastra/llm.js";
import { logger } from "../pkg/logger.js";

const log = logger.child({ mod: "tg-commands" });

type Db = LibSQLDatabase<typeof schema>;

const DEFAULT_USAGE_DAYS = 30;
const MAX_USAGE_DAYS = 365;

/** Minimal chat surface — the ChatService satisfies this. */
export interface ChatHandler {
  handleUserMessage(
    userId: number,
    chatId: number,
    text: string,
    onText?: StreamCallback,
  ): Promise<ChatResult>;
}

export interface CommandDeps {
  db: Db;
  settings: SettingsService;
  skills: SkillService;
  usage: UsageService;
  memory: MemoryService;
  chat: ChatHandler;
}

/** Command menu registered via setMyCommands (parity with Go; /start stays hidden). */
export const BOT_COMMANDS = [
  { command: "help", description: "Справка" },
  { command: "new", description: "Начать новую сессию" },
  { command: "me", description: "Мой профиль" },
  { command: "tasks", description: "Мои задачи" },
  { command: "usage", description: "Статистика затрат" },
  { command: "about", description: "Что я умею" },
  { command: "reset_onboarding", description: "Сбросить онбординг" },
] as const;

const HELP_TEXT = [
  "Я ваш персональный ассистент. Просто напишите мне сообщение или отправьте голосовое.",
  "",
  "Команды:",
  "/new — начать новую сессию (очистить историю диалога)",
  "/me — мой профиль",
  "/tasks — список задач (`/tasks <ID>` — удалить задачу)",
  "/usage [дней] — статистика затрат (по умолчанию 30)",
  "/about — что я умею",
  "/reset_onboarding — пройти знакомство заново",
].join("\n");

/** Read-only session lookup by chat id (does NOT create one, unlike loadContext). */
async function findSession(db: Db, chatId: number): Promise<{ id: number } | null> {
  const [row] = await db.select({ id: sessions.id }).from(sessions).where(eq(sessions.chatId, chatId));
  return row ?? null;
}

/** /start — welcome text from the WELCOME prompt (no LLM call). */
export async function cmdStart(deps: CommandDeps): Promise<string> {
  const welcome = await deps.skills.getPrompt("WELCOME");
  log.info("command /start");
  return welcome || "Привет! Я ваш ассистент. Напишите что-нибудь, чтобы начать.";
}

/** /help — static help text. */
export function cmdHelp(): string {
  log.info("command /help");
  return HELP_TEXT;
}

/** /new — reset conversation history (rotate thread) + clear session memories. */
export async function cmdNew(deps: CommandDeps, userId: number, chatId: number): Promise<string> {
  log.info({ userId }, "command /new");
  const session = await findSession(deps.db, chatId);
  if (!session) return "Начал новую сессию.";
  await rotateThread(deps.db, session.id);
  const removed = await deps.memory.deleteSessionMemories(userId, session.id);
  log.debug({ userId, sessionId: session.id, removed }, "/new cleared session");
  return "Начал новую сессию — история диалога очищена. Долговременные факты о вас сохранены.";
}

/** /me — user profile + channel count. */
export async function cmdMe(deps: CommandDeps, userId: number): Promise<string> {
  log.info({ userId }, "command /me");
  const [user] = await deps.db.select().from(users).where(eq(users.id, userId));
  if (!user) return "Профиль не найден.";
  const channels = await deps.db
    .select({ id: userChannels.id })
    .from(userChannels)
    .where(eq(userChannels.userId, userId));
  const lines = [
    "*Ваш профиль*",
    `Имя: ${user.name || "—"}`,
    `Город: ${user.city || "—"}`,
    `Часовой пояс: ${user.timezone || "—"}`,
    `Язык: ${user.language || "—"}`,
    `Онбординг: ${user.onboarded ? "пройден" : "не пройден"}`,
    `Каналов: ${channels.length}`,
  ];
  return lines.join("\n");
}

/** /tasks — list the user's cron tasks, or `/tasks <ID>` to delete one (own only). */
export async function cmdTasks(deps: CommandDeps, userId: number, arg: string): Promise<string> {
  const trimmed = arg.trim();
  if (trimmed !== "") {
    const id = Number(trimmed);
    if (!Number.isInteger(id) || id <= 0) return "Укажите корректный ID задачи.";
    log.info({ userId, taskId: id }, "command /tasks delete");
    const deleted = await deps.db
      .delete(cronTasks)
      .where(and(eq(cronTasks.id, id), eq(cronTasks.userId, userId)))
      .returning({ id: cronTasks.id });
    return deleted.length > 0 ? `Задача #${id} удалена.` : "Задача не найдена.";
  }

  log.info({ userId }, "command /tasks list");
  const tasks = await deps.db
    .select({
      id: cronTasks.id,
      name: cronTasks.name,
      schedule: cronTasks.schedule,
      isActive: cronTasks.isActive,
    })
    .from(cronTasks)
    .where(eq(cronTasks.userId, userId));
  if (tasks.length === 0) return "У вас пока нет задач.";
  const lines = tasks.map(
    (tk) => `#${tk.id} ${tk.name} — ${tk.schedule || "—"} [${tk.isActive ? "вкл" : "выкл"}]`,
  );
  return ["*Ваши задачи*", ...lines, "", "Удалить: /tasks <ID>"].join("\n");
}

/** Compute the UTC 'YYYY-MM-DD' that is `days-1` days before today (inclusive window). */
function sinceDate(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - (days - 1));
  return d.toISOString().slice(0, 10);
}

/** /usage [days] — total cost/requests over the last N days (default 30, max 365). */
export async function cmdUsage(deps: CommandDeps, userId: number, arg: string): Promise<string> {
  let days = DEFAULT_USAGE_DAYS;
  const parsed = Number(arg.trim());
  if (Number.isInteger(parsed) && parsed > 0) days = Math.min(parsed, MAX_USAGE_DAYS);
  log.info({ userId, days }, "command /usage");
  const { cost, requests } = await deps.usage.getUsageSince(userId, sinceDate(days));
  return [
    `*Статистика за последние ${days} дн.*`,
    `Запросов: ${requests}`,
    `Стоимость: $${cost.toFixed(4)}`,
  ].join("\n");
}

/** /about — run a fixed prompt through the pipeline (non-streaming). */
export async function cmdAbout(deps: CommandDeps, userId: number, chatId: number): Promise<string> {
  log.info({ userId }, "command /about");
  const res = await deps.chat.handleUserMessage(userId, chatId, "Что ты умеешь?");
  return res.text;
}

/** /reset_onboarding — mark onboarding incomplete, then greet through the pipeline. */
export async function cmdResetOnboarding(deps: CommandDeps, userId: number, chatId: number): Promise<string> {
  log.info({ userId }, "command /reset_onboarding");
  await deps.db.update(users).set({ onboarded: false, updatedAt: new Date() }).where(eq(users.id, userId));
  const res = await deps.chat.handleUserMessage(userId, chatId, "Привет!");
  return res.text;
}
