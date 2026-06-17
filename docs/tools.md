[← Chat Pipeline](chat-pipeline.md) · [Back to README](../README.md) · [Telegram Bot →](telegram.md)

# Tools

What a skill can *do* beyond generating text. A skill row lists `allowed-tools` (space-delimited). The registry exposes built-in tools (memory, currency, cron tasks, profile, skill references) plus a **native web bucket** (search / fetch / Belarus marketplaces / weather) — there is no external MCP server.

## How tools become available

The **chat orchestrator** registers *every* tool up front (`resolveAllTools(ctx)`) plus `load_skill`, then gates the live set per step (AI SDK can't add tools mid-generation):

```
all buckets ─▶ resolveAllTools(ctx) + load_skill ─▶ registered on the agent
                                                          │ prepareStep → activeTools
                              load_skill(name) widens the active set to that skill's allowed-tools
```

- `load_skill(name)` returns a skill's `SKILL.md` + reference list and adds it to the turn's loaded set; the next step exposes that skill's `allowed-tools` (intersected with the registered tools). The pre-pass's primary skill starts loaded. See [Chat Pipeline](chat-pipeline.md#the-orchestrator).
- The **admin skill test-run** instead uses `resolveTools(allowedTools, ctx)` — buckets tried in order, first match wins, unknown names logged at `WARN` and skipped, built lazily (`once()` per call).
- Each bucket's `build*` factory receives the `ToolContext`; the web/currency buckets accept an injectable `fetchFn` (defaults to the global `fetch`) so tests run without a network, and forward the tool-execution `AbortSignal` into HTTP so a watchdog abort cancels in-flight requests.

### ToolContext

Every tool's `execute` receives what it needs through the `ToolContext` threaded from the chat workflow:

| Field | Purpose |
|-------|---------|
| `userId` | scopes every read/write to the current user |
| `chatId`, `sessionId` | written onto created cron tasks |
| `db` | drizzle handle (`tasks`, `profile`) |
| `settings` | `SettingsService` (e.g. `timeouts.http_client` for `currency` and web fetches) |
| `mem` | `MemoryService` (memory tools) |
| `skillsRoot?` | filesystem root for `read_skill_reference` (defaults to the seeded skills dir) |
| `confirmations?` | `ConfirmationService`; when set, risky tools record a confirmation instead of acting (see [Tool approval](#tool-approval)) |

## Built-in tools

All built-in tools are scoped to `ctx.userId` and never touch another user's data.

### Memory (M3)

| Tool | Input | Effect |
|------|-------|--------|
| `remember` | `content`, `category` | store a durable fact (injection-guarded, permanent scope) |
| `forget` | `memory_id` | delete a stored memory by id — **requires confirmation** (see below) |
| `list_memories` | — | list permanent memories with ids |

### Currency

| Tool | Input | Effect |
|------|-------|--------|
| `currency_rates` | `currency?` (`USD`/`EUR`/`RUB`; empty = all three) | fetches Belarus rates from **three** sources in parallel |

Sources: NBRB (`api.nbrb.by`, official), Belarusbank (`belarusbank.by/api`, buy/sell), and myfin.by (best courses, HTML-scraped). Each request has its own timeout (`timeouts.http_client`); a failing source returns an `error` field without failing the others. `RUB` uses `scale=100`.

### Tasks (cron CRUD)

| Tool | Input | Effect |
|------|-------|--------|
| `task_create` | `name`, `prompt`, `schedule`, `description?`, `skill_name?`, `scheduled_at?` | create a scheduled task |
| `task_list` / `task_get` | — / `task_id` | list / fetch the user's tasks |
| `task_update` / `task_delete` / `task_toggle` | `task_id` (+ fields / `is_active`) | edit, delete (**requires confirmation**), enable/disable |

`schedule` accepts `now` (immediate background), `once` (with a future `scheduled_at`, RFC3339), or a 5-field cron expression. Recurring schedules are validated with `cron-parser` and must be **at least 1 hour** apart. `task_create` enforces the user's plan `max_tasks` limit. Tasks are stored in `cron_tasks` and executed by the [Cron Scheduler](scheduler.md).

### Profile

| Tool | Input | Effect |
|------|-------|--------|
| `update_city` | `city`, `timezone?` | set `users.city` (+ `timezone` when it is a valid IANA zone) |
| `update_bot_vibe` | `vibe` | set the bot's communication style (≤ 200 chars) |
| `update_bot_name` | `bot_name` | set the bot's name |

Free-form fields pass through `promptguard.sanitizeProfileField`; bot identity edits upsert the `bot_identities` row. (Parity with Go: there is no read-profile tool and no language tool — the profile is injected into the system prompt.)

### Skill references

| Tool | Input | Effect |
|------|-------|--------|
| `read_skill_reference` | `skill_name`, `ref_path` | read a reference doc from a skill's directory (≤ 8000 chars) |

`ref_path` must start with `references/`, `scripts/`, or `assets/`; absolute paths and `..` traversal are rejected. Available references are listed for the model in the `[SKILL REFERENCES]` prompt block, populated by `listReferences(skillName)` from the file-backed skills store (`SKILLS_DIR`, default `./data/skills`).

## Web tools (native bucket)

The `web` bucket (`mastra/tools/web.ts`, registered in `mastra/tools/registry.ts`) replaces the old external MCP `search` server. It runs **in-process**: web search goes to a self-hosted [SearXNG](https://docs.searxng.org/) instance over the internal Docker network, page fetches use a browser-free `fetch` + `jsdom`/`turndown` pipeline (no Chromium), and Belarus marketplace/weather verticals are plain HTTP scrapers. Service code lives under `backend/src/services/web/`.

The bucket exposes **21 tools** — 15 main and 6 lookup helpers. Each `execute` reads the per-request HTTP timeout from `SettingsService` (`timeouts.http_client`, Go parity) and treats fetched page content as untrusted data (wrapped in an envelope). Full reference — every tool, configuration, infrastructure, security, and caching — is in **[Web Search](web-search.md)**.

| Group | Tools |
|-------|-------|
| Search / fetch / news | `web_search`, `web_search_batch`, `fetch_url`, `search_news` |
| Marketplaces | `kufar_search`, `avby_search`, `rabota_search`, `transport_search`, `relax_search`, `relax_afisha` |
| Weather | `weather` |
| med103 (health) | `med103_doctor_search`, `med103_clinic_search`, `med103_services`, `med103_pharmacy` |
| Lookups | `kufar_categories`, `kufar_regions`, `avby_brands`, `avby_models`, `relax_categories`, `relax_afisha_categories` |

## Tool approval

Destructive tools require **confirm-before-execute** (C1). When `ctx.confirmations` is wired (the chat path), `forget` and `task_delete` do **not** act — they record a row in `pending_confirmations` and return "awaiting confirmation". The turn surfaces the request in `ChatResult.confirmations`; Telegram renders ✅ Подтвердить / ❌ Отменить inline buttons (`cfm:a|d:<id>`). A tap calls `ConfirmationService.resolve(userId, id, approved)`, which runs the recorded action on approval (scoped by `userId`, idempotent).

- The risky set is the `ConfirmationService` executor registry: today `forget` → `memory.delete`, `task_delete` → delete the cron row. Add a tool there to gate it everywhere.
- This is **our own** `pending_confirmations` table (drizzle migration), not Mastra suspend/resume snapshots — the schema stays under our migration control.
- The admin skill test-run has no `confirmations` wired, so risky tools execute directly there.

## See Also

- [Web Search](web-search.md) — the full native web bucket: tools, SearXNG infra, SSRF guard, caching
- [Chat Pipeline](chat-pipeline.md) — where tool resolution sits in a turn
- [Configuration](configuration.md) — `SEARXNG_URL`/`WEB_CACHE_DIR`, timeouts, and plan limits that drive these tools
