[← Tools](tools.md) · [Back to README](../README.md) · [Cron Scheduler →](scheduler.md)

# Telegram Bot

The user-facing transport (Milestone 6). A [grammY](https://grammy.dev) bot turns Telegram updates into calls to `ChatService.handleUserMessage` and streams the reply back. It runs in the **same process** as the health server and the [cron scheduler](scheduler.md) — no second port, one libSQL/Mastra stack. Code lives in `backend/src/telegram/`.

The bot adds **no** security or accounting logic of its own: prompt-guard, the hourly rate limit, and usage recording all live inside `runChat` (see [Chat Pipeline](chat-pipeline.md)). The bot resolves the user, streams, and shows whatever `handleUserMessage` returns.

## Startup

Wired in `server.ts` after `createChatService` resolves. **Best-effort**: the bot starts only when `TELEGRAM_BOT_TOKEN` is set, and a startup failure is logged without taking down the health server.

```
createChatService → SpeechService(new ModelFactory(), settings)
                  → createBot({ token, db, settings, chat, speech, commandDeps })
                  → setMyCommands(...)            // command menu
                  → bot.start()  (polling)  | webhookCallback(bot, "http")  (webhook)
```

`bot.stop()` is called from the existing `shutdown()` handler (alongside stopping the cron scheduler and closing the chat service / DB).

## Message flow

| Update | Handling |
|--------|----------|
| **Text** | `resolveTelegramUser` (get-or-create `users` + `user_channels`) → start typing → stream `handleUserMessage(userId, chatId, text, onText)` → `finalize(reply)` |
| **Voice** | guard ≤ 30s → download file → `SpeechService.transcribe(bytes, "audio/ogg")` → feed transcript into the same text flow |
| **Other** | reply "I can't handle this content type — send text or voice" |
| **Command** (`/...`) | resolve user → run handler → send the result via `Messenger` |

A new Telegram contact is mapped to an internal user by `identity.resolveTelegramUser`: it looks up `user_channels` by `(provider='telegram', external_id=<tg id>)` and creates the `users` + `user_channels` rows on first contact (`loadContext` requires the user to already exist). This is idempotent — repeat contacts return the same id.

## Streaming

`stream.ts` streams the reply with **Bot API 10.1 rich drafts** (`sendRichMessageDraft`, grammY 1.44+) — the evolution of Go's `SendMessageDraft`. Drafts are ephemeral previews that aren't edit-flood-limited, so the live preview is already **rich-formatted** and refreshes fast:

| Behavior | Value |
|----------|-------|
| Each tick | `sendRichMessageDraft(chatId, draftId, {markdown})` with the accumulated text; `draftId` = the inbound `update_id` |
| First tick | sent immediately; later ticks throttled to ~4/sec (`STREAM_THROTTLE_MS` 250) |
| Skip conditions | in-flight send · unchanged text · length > 32000 · text ends in an incomplete link |
| Typing indicator | stopped on the first draft |
| Finalize | wait for the in-flight draft, then `sendRichMessage` the full reply (split at 32768); the draft expires on its own |
| Send failure | a failed draft tick is skipped (next tick recovers); a failed finalize send retries as plain `sendMessage` |

When `handleUserMessage` was rejected (prompt-guard / rate limit) nothing streams, so `finalize` simply sends the rejection text. The draft's 30-second TTL is refreshed by every tick.

## Formatting

Replies are sent as **Bot API 10.1 rich messages** (`sendRichMessage`, grammY 1.44+). Telegram's rich markdown is a **GitHub-flavored-Markdown superset** (tables, headings, lists, blockquotes, spoilers, math, …), so the LLM's markdown is passed through **verbatim** — there is no MarkdownV2 escaping step. The output-format contract the model follows lives in `prompts/FORMAT.md`.

`format.ts` is therefore tiny: a `RichContent` type plus `splitMessage(text, 32768)`, which breaks the rare over-long reply on the nearest paragraph → line → word boundary (500-char search window, code-point counted), with a hard cut as the last resort. The 32768 bound is the rich-message limit (vs 4096 for the plain in-flight preview).

## Commands

Registered in the command menu via `setMyCommands` (parity with the Go bot):

| Command | Action |
|---------|--------|
| `/start` | Welcome text (the `WELCOME` prompt) |
| `/help` | Static help |
| `/new` | New session — rotate the dialogue thread + clear session-scoped memories (long-term facts kept) |
| `/me` | Profile (name, city, timezone, language, onboarding, channel count) |
| `/tasks [ID]` | List cron tasks, or `/tasks <ID>` to delete your own |
| `/usage [days]` | Cost + request totals over the last N days (default 30, max 365) |
| `/about` | Runs "Что ты умеешь?" through the pipeline |
| `/reset_onboarding` | Clear the onboarding flag, then greet through the pipeline |

`/new` **rotates** `sessions.threadId` to a fresh id and resets the rolling summary, then — since Mastra exposes no delete API — purges the old thread's messages with a raw SQL `DELETE` (best-effort). It also deletes `scope='session'` memories; long-term (permanent) facts are untouched.

## Allowlist

An `authorize` middleware reads `telegram_allowed_users` from settings (`settings.getAllowedUsers()`, hot-reloaded). An **empty list allows everyone**; otherwise unauthorized Telegram ids are dropped silently. See [Configuration](configuration.md).

## Notifications (Messenger)

`messenger.ts` wraps `bot.api` with `sendMessage` (split + `sendRichMessage` + plain fallback), `sendTyping`, and `startTypingLoop` (re-sends typing every 4s). It is the non-streaming send path used for command replies and for [cron notifications](scheduler.md#notifications).

## Webhook (optional, minimal)

Long polling is the default. Setting `TELEGRAM_USE_WEBHOOK=1` and a public `TELEGRAM_WEBHOOK_URL` mounts grammY's `webhookCallback(bot, "http")` on the existing HTTP server at the URL's path. Secret-token validation and hardened routing are deferred to **M8** (when the Hono admin server lands).

| Variable | Purpose |
|----------|---------|
| `TELEGRAM_BOT_TOKEN` | Bot token; the bot only starts when this is set |
| `TELEGRAM_USE_WEBHOOK` | `1`/`true`/`yes` → webhook mode (else polling) |
| `TELEGRAM_WEBHOOK_URL` | Public webhook URL (its path is served by the built-in HTTP server) |

## File map (`backend/src/telegram/`)

| File | Responsibility |
|------|----------------|
| `bot.ts` | grammY wiring: allowlist → commands → text/voice → error handler; `createBot()` |
| `stream.ts` | throttled `sendRichMessageDraft` streamer + rich finalize |
| `format.ts` | `RichContent` type + `splitMessage` (rich-message limit) |
| `voice.ts` | download + transcribe a voice note |
| `commands.ts` | slash-command handlers + `BOT_COMMANDS` menu |
| `identity.ts` | get-or-create user/channel for a Telegram contact |
| `messenger.ts` | outbound send + typing loop (cron notifications) |
| `errors.ts` | `TelegramReplyError` (carries a user-facing message) |

## See Also

- [Chat Pipeline](chat-pipeline.md) — what `handleUserMessage` does with the text the bot forwards
- [Configuration](configuration.md) — `telegram_allowed_users`, timeouts, and `.env` secrets
