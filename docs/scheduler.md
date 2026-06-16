[← Telegram Bot](telegram.md) · [Back to README](../README.md) · [Configuration →](configuration.md)

# Cron Scheduler

The executor for scheduled work (Milestone 7). The `task_*` tools (see [Tools](tools.md#tasks-cron-crud)) let a skill *create* rows in `cron_tasks`; the scheduler is what actually *runs* them on time and delivers the result to the user's Telegram chat. It runs in the **same process** as the bot — no second binary (the Go version ran a separate `cmd/cron`). Code lives in `backend/src/scheduler/`.

A task run is **a full chat turn**: the stored `prompt` is fed through `ChatService.handleUserMessage` exactly as if the user had typed it, then the answer is sent via the bot's [`Messenger`](telegram.md#notifications-messenger). There is no separate "reminder" path.

## Poll model

Two `node-cron` jobs poll the database — there is **no** per-task cron registration and **no** `next_run_at` column, so new/edited/deleted tasks are picked up automatically on the next tick.

| Job | Cron | Selects | Due check |
|-----|------|---------|-----------|
| **Immediate** | `*/5 * * * * *` (5s) | `is_active AND schedule='now' AND last_run_at IS NULL` | always (run once) |
| **Scheduled** | `* * * * *` (60s) | `is_active AND schedule != 'now'` | per-task (see below) |

Both jobs use node-cron's native **`noOverlap`**, so a slow tick is skipped rather than stacked. The executor additionally guards each task id with an in-flight `Set`, so a long-running recurring task can't be double-fired by the next tick.

## Schedule kinds

The `schedule` column encodes the kind (parity with creation-time validation in [Tools](tools.md#tasks-cron-crud)):

| `schedule` | Kind | Due when | After a successful run |
|------------|------|----------|------------------------|
| `now` | immediate background | first 5s tick (never run yet) | `is_active = false` (single-shot) |
| `once` | one-time deferred | `scheduled_at <= now` | `is_active = false` |
| 5-field cron | recurring | `nextRun(schedule, last_run_at ?? created_at) <= now` | stays active, reschedules from the new `last_run_at` |

Recurring due-ness is computed with `cron-parser` from the last run (or creation, if never run); the minimum 1-hour interval enforced at creation guarantees the next run is always far enough ahead to avoid double-firing within a tick window. Cron expressions are interpreted in **server time** (no per-user timezone) — same as creation-time validation.

## Execution

Each due task, in `executor.ts`:

1. Skip with a `WARN` if it has no `notification_chat_id` (nowhere to deliver).
2. Skip if the same task id is already in flight (overlap guard).
3. Build the prompt — for **recurring** tasks the seeded `MONITORING` prompt is prepended (the "respond `NO_CHANGES` if nothing changed" convention); `now`/`once` use the prompt as-is.
4. Run `handleUserMessage(userId, notification_chat_id, prompt)` under a **watchdog** backstop (`timeouts.llm_request + 30s`). The chat pipeline already enforces its own `llm_request` (300s) and `llm_activity` (30s) timeouts — this outer race only guards against an unforeseen hang. A throw/timeout never crashes the scheduler.
5. Write `last_run_at` / `last_run_status` / `last_run_error` in one update; deactivate `now`/`once` on success.
6. Deliver the result when [`shouldNotify`](#notifications) allows it.

A **rejected** result (prompt-guard or rate limit, `result.rejected`) is recorded as an error and **not** delivered — a background task never spams the user with a rejection notice. A generation fallback (`rejected: false`) is treated as success and delivered.

## Notifications

Delivery goes through `Messenger.sendMessage(notification_chat_id, text)` (rich message + split + plain fallback). `shouldNotify` (ported from Go) suppresses noise:

- **Immediate** tasks always notify (the user explicitly asked).
- Otherwise the result is suppressed when it is empty, shorter than 20 chars with a negative word, contains a marker (`NO_CHANGES`, `NO_RESULT`, `NOTHING_FOUND`, `NO_NEW_LISTINGS`, …), or exactly matches a "no changes" phrase (`НЕТ ИЗМЕНЕНИЙ`, `НИЧЕГО`, …).

## Side effects & divergences from Go

Because a run is a real `handleUserMessage` call against the notification chat's session (rather than Go's isolated per-task session), each run:

- **consumes the user's hourly rate limit** and records **usage** (a limited user's task is recorded as an error and not delivered that cycle);
- **persists** the synthetic user + assistant turns into the chat's dialogue history (the task's output is visible in the conversation);
- can **advance onboarding** toward the `@4` auto-complete threshold.

The Go knowledge-graph dedup tools (`search_nodes` / `create_entities`) are **not** ported — the MCP `memory` server was dropped (memory is consolidated), so recurring monitoring relies on built-in memory + session history.

## Startup & shutdown

Wired in `server.ts` after the bot starts (`buildCronScheduler` in `scheduler/wiring.ts` keeps the glue out of the entry point so it stays testable):

```
createChatService → startBot → buildCronScheduler(svc, new Messenger(bot.api)) → scheduler.start()
```

**Best-effort**: the scheduler starts only when the bot is up (no bot → nowhere to deliver → skipped with a `WARN`); a start failure is logged without taking down the bot or health server. `scheduler.stop()` runs from the existing `shutdown()` handler before the DB is closed.

## File map (`backend/src/scheduler/`)

| File | Responsibility |
|------|----------------|
| `schedule.ts` | pure rules — kind predicates, `computeNextRun`, due checks, `shouldNotify`, tick constants (no IO) |
| `executor.ts` | poll due tasks → run via the chat pipeline (watchdog) → record `last_run_*` → notify |
| `scheduler.ts` | `node-cron` driver: two `noOverlap` polls, `start()` / `stop()` |
| `wiring.ts` | `buildCronScheduler` — wires a `ChatService` + `Notifier` into the scheduler |

## Constants

| Value | Parameter |
|-------|-----------|
| `60s` / `5s` | scheduled / immediate poll interval |
| `llm_request + 30s` | per-task watchdog backstop |
| `1h` | minimum recurring interval (enforced at creation) |
| `< 20 chars` | short-result threshold for `shouldNotify` |

## See Also

- [Tools](tools.md#tasks-cron-crud) — the `task_*` tools that create the `cron_tasks` this scheduler runs
- [Telegram Bot](telegram.md#notifications-messenger) — the `Messenger` used to deliver notifications
- [Configuration](configuration.md) — `timeouts`, plan `max_tasks`, and how a run consumes rate limit / usage
