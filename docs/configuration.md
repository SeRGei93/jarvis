[← Cron Scheduler](scheduler.md) · [Back to README](../README.md)

# Configuration

`jarvis` splits configuration in two: **secrets** live in `.env`, **everything else** lives in the database (editable later from the admin Mini App, M8). `SettingsService` reads the DB config, caches it in memory, and hot-reloads on change.

## `.env` (secrets + runtime flags only)

| Variable | Required | Default | Purpose |
|----------|----------|---------|---------|
| `LIBSQL_URL` | no | `file:./data/avocado.db` | libSQL file path or `libsql://<turso>.turso.io` |
| `LIBSQL_AUTH_TOKEN` | Turso only | — | auth token for hosted libSQL |
| `TELEGRAM_BOT_TOKEN` | prod | — | Telegram bot token (M6) |
| `OPENROUTER_API_KEY` | prod | — | primary LLM provider key |
| `ZAI_API_KEY` | no | — | Z.AI (OpenAI-compatible) |
| `OPENAI_API_KEY` | no | — | OpenAI provider |
| `XAI_API_KEY` | no | — | xAI provider |
| `GOOGLE_API_KEY` | no | — | Google provider |
| `ADMIN_USER_IDS` | no | `""` | comma-separated Telegram ids for the Mini App (M8) |
| `NODE_ENV` | no | `development` | `development` \| `production` \| `test` |
| `LOG_LEVEL` | no | pino default | `debug` for verbose logs; secrets are always redacted |
| `PORT` | no | `8080` | health/HTTP server port |

`TELEGRAM_BOT_TOKEN` and `OPENROUTER_API_KEY` are required only when `NODE_ENV=production` (fail-fast on boot). Secrets are never logged as values — only key names appear at `DEBUG`.

## Database-backed settings

Seeded from `backend/seed/config.yaml` into the `settings` table (key → JSON). Read via `SettingsService`; defaults apply when a key is absent.

| Key | Shape | Notes |
|-----|-------|-------|
| `model_roles` | `{ default, router, embedding, error_correction, speech, synthesizer }` | each value is a `provider:model` ref |
| `timeouts` | `{ llm_request, http_client, llm_activity }` | Go-style durations (`300s`, `30s`) |
| `agent` | `{ max_history, default_temperature, rag_top_k }` | defaults `15` / `0.4` / `10` |
| `telegram_allowed_users` | `number[]` | empty = open to all |
| `mcp_servers` | `{ search?: { command, args, env? } }` | only the `search` server is kept (see [Tools & MCP](tools.md#mcp-search)) |

The `search` server's `http_client` timeout (from `timeouts`) is also the global timeout passed to the MCP client and the per-source timeout for the `currency_rates` tool.

### How settings drive the chat pipeline

- `model_roles.router` → which model the [router](chat-pipeline.md) calls.
- `model_roles.default` → fallback model for skills that don't pin their own; also the new-session model.
- `model_roles.synthesizer` → multi-skill merge model (falls back to the session model).
- `agent.max_history` → how many past messages are loaded per turn.
- `agent.default_temperature` → temperature for skills that leave it null.
- `agent.rag_top_k` → number of long-term memories retrieved once a user has ≥ 10 facts.

## Skills and prompts (also in the DB)

| Table | Seeded from | Used by |
|-------|-------------|---------|
| `skills` | `backend/seed/skills/*/SKILL.md` | router (routable subset) + skill-agent factory |
| `prompts` | `backend/seed/prompts/*.md` | prompt-builder (`SOUL`, `FORMAT`, `INTEGRITY`, `SYNTHESIZER`, `WELCOME`, `MONITORING`) |
| `models` | `seed/config.yaml` | admin UI + role validation |

A skill row carries: `name`, `description`, `allowed_tools` (JSON), `model`, `temperature`, `reasoning` (tri-state), `routable`, `prompt`, `metadata`. Editing these rows changes behaviour without a redeploy — `SettingsService.invalidate()` / `SkillService.invalidate()` drop the caches.

## Plans, rate limit, and usage

Subscription plans gate two limits, both enforced per `userId`:

| Table | Columns | Drives |
|-------|---------|--------|
| `subscription_plans` | `name`, `hourly_limit`, `max_tasks` | the hourly message cap and the cron-task cap |
| `user_subscriptions` | `user_id`, `plan_id` | which plan a user is on |
| `message_rate_limits` | `(user_id, window_start)`, `count` | the sliding hourly window |
| `usage_stats` | `(user_id, date)`, `cost`, `requests` | per-day cost + request accounting |

- **Rate limit** — `RateLimitService` truncates the clock to the hour and increments the window counter; when `count > hourly_limit` the turn is rejected before routing. A user with no subscription falls back to the `free` plan, then to a default of 30/hour. `hourly_limit = 0` means unlimited. Un-onboarded users are never limited.
- **Task cap** — `task_create` refuses to create a task once the user has `max_tasks` active ones (default 3).
- **Usage** — `UsageService.recordUsage(userId, cost)` upserts the day's `usage_stats` row after every answered turn.

Schedule validation for cron tasks uses the `cron-parser` dependency (recurring schedules must be ≥ 1 hour apart); the scheduler that *runs* tasks is the [Cron Scheduler](scheduler.md).

## See Also

- [Tools & MCP](tools.md) — how `mcp_servers` and plan limits drive the agent's tools
- [Getting Started](getting-started.md) — creating and seeding the database
- [Chat Pipeline](chat-pipeline.md) — how roles and agent params are consumed at runtime
