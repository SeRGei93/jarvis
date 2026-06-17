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
| `SEARXNG_URL` | no | `http://searxng:8080` | SearXNG instance the web-search client queries |
| `SEARXNG_ENGINES` | no | `google,yandex` | comma-separated engine override passed to SearXNG |
| `WEB_CACHE_DIR` | no | `./data/web-cache` | root dir for the web fetch/search file cache (container: `/data/web-cache`) |
| `SKILLS_DIR` | no | `./data/skills` | file-backed skill store dir (container: `/data/skills`) |
| `PROMPTS_DIR` | no | `./data/prompts` | file-backed system-prompt store dir (container: `/data/prompts`) |
| `SEARXNG_SECRET` | prod | — | secret key the SearXNG **container** requires (prod compose fails fast; local compose defaults it) |
| `NODE_ENV` | no | `development` | `development` \| `production` \| `test` |
| `LOG_LEVEL` | no | pino default | `debug` for verbose logs; secrets are always redacted |
| `PORT` | no | `8080` | health/HTTP server port |

`TELEGRAM_BOT_TOKEN` and `OPENROUTER_API_KEY` are required only when `NODE_ENV=production` (fail-fast on boot). Secrets are never logged as values — only key names appear at `DEBUG`. The web bucket and its config are documented in [Web Search](web-search.md).

## Database-backed settings

Seeded from a typed code module (`src/db/seed-data.ts`) into the `settings` table (key → JSON). Read via `SettingsService`; defaults apply when a key is absent. (The old `config.yaml` was retired in M12.)

| Key | Shape | Notes |
|-----|-------|-------|
| `model_roles` | `{ default, router, error_correction, speech, synthesizer }` | each value is a `provider:model` ref |
| `timeouts` | `{ llm_request, http_client, llm_activity }` | Go-style durations (`300s`, `30s`) |
| `agent` | `{ max_history, default_temperature, auto_memory }` | defaults `50` / `0.4` / `true` |
| `telegram_allowed_users` | `number[]` | empty = open to all |

The `timeouts.http_client` value is the per-request timeout for the `currency_rates` tool and the native [web bucket](web-search.md) (fetch + verticals). Web-search infrastructure (SearXNG endpoint, cache dir) is configured via `.env` runtime flags, not DB settings.

### How settings drive the chat pipeline

- `model_roles.router` → which model the [router](chat-pipeline.md) calls.
- `model_roles.default` → fallback model for skills that don't pin their own; also the new-session model.
- `model_roles.synthesizer` → multi-skill merge model (falls back to the session model).
- `agent.max_history` → how many recent messages are loaded per turn (default `50`). Older history is folded into a per-session rolling summary (`sessions.summary`), so context isn't lost when it scrolls past the window.
- `agent.default_temperature` → temperature for skills that leave it null.
- `agent.auto_memory` → when on (default), an extractor saves durable facts the user mentions in passing, on top of the explicit `remember` tool and onboarding. Turn it off to limit long-term memory to explicit saves.

## Skills and prompts (file-backed store, M12)

Skills and system prompts are **files, not DB rows**. Repo-bundled defaults ship in the image and are reconciled onto a persistent volume at boot (`reconcileDefaults`): the first run populates the empty store, and a later deploy that ships changed defaults delivers them **only to files the admin never edited** — admin edits made via the Mini App are preserved. A `.content-manifest.json` in each store records the default hash installed per file (the baseline used to tell "untouched" from "edited"); its `version` lets an unchanged image skip the walk. Afterwards the app reads *and* writes the store, so admin edits survive redeploys.

> Caveat: a store populated before the manifest existed has no per-file baseline, so files that already diverged from the new defaults are preserved (not auto-updated) on the first reconcile — apply those via the admin UI if wanted.

| What | Repo defaults | Runtime store | Used by |
|------|---------------|---------------|---------|
| skills | `backend/skills/<name>/SKILL.md` | `SKILLS_DIR` (`/data/skills`) | router (routable subset) + skill-agent factory + `read_skill_reference` |
| prompts | `backend/prompts/<KEY>.md` | `PROMPTS_DIR` (`/data/prompts`) | prompt-builder (`SOUL`, `FORMAT`, `INTEGRITY`, `SYNTHESIZER`, `WELCOME`, `MONITORING`) |
| models | code seed (`src/db/seed-data.ts`) | `models` table | admin UI + role validation |

A `SKILL.md` carries YAML frontmatter — `name`, `description`, `allowed-tools` (space-delimited), `model`, `temperature`, `reasoning` (tri-state), `routable`, plus any extra keys (e.g. `max-turns`) preserved as metadata — followed by the prompt body. Editing a skill/prompt (via the admin Mini App or directly on disk) takes effect without a redeploy: writes are **atomic** (`*.tmp` + rename) and the repositories **hot-reload** on file-mtime change; `SkillService.invalidate()` also drops the cache after an admin save.

> **Volume note:** the store lives on the `/data` volume. Deleting/recreating that volume reverts skills and prompts to the repo-bundled defaults (by design).

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

- [Tools](tools.md) — how `timeouts` and plan limits drive the agent's tools
- [Web Search](web-search.md) — `SEARXNG_*` / `WEB_CACHE_DIR` flags and the native web bucket
- [Getting Started](getting-started.md) — creating and seeding the database
- [Chat Pipeline](chat-pipeline.md) — how roles and agent params are consumed at runtime
