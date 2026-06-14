[← Chat Pipeline](chat-pipeline.md) · [Back to README](../README.md) · [Telegram Bot →](telegram.md)

# Tools & MCP

What a skill can *do* beyond generating text. A skill row lists `allowed-tools` (space-delimited); at runtime `tools/registry.resolveTools(allowedTools, ctx)` maps those names to a concrete AI SDK `ToolSet` that the model can call. Milestone 5 makes the full registry live: built-in tools plus the external MCP `search` server.

## How a skill gets its tools

```
skill.allowed-tools ─▶ resolveTools(names, ctx) ─▶ merge buckets ─▶ AI SDK ToolSet
                                                    memory → built-in → MCP
```

- Buckets are tried in order; **first match wins**. An unknown name is logged at `WARN` and skipped (the seam that lets a skill run even when it references a tool that isn't available).
- Buckets build **lazily** — a bucket is only constructed when a skill actually references one of its tools.
- `resolveTools` is **synchronous**: the MCP `ToolSet` is assembled once at boot and passed in via `ctx` (see [MCP `search`](#mcp-search)).

### ToolContext

Every tool's `execute` receives what it needs through the `ToolContext` threaded from the chat workflow:

| Field | Purpose |
|-------|---------|
| `userId` | scopes every read/write to the current user |
| `chatId`, `sessionId` | written onto created cron tasks |
| `db` | drizzle handle (`tasks`, `profile`) |
| `settings` | `SettingsService` (e.g. `timeouts.http_client` for `currency`) |
| `mem` | `MemoryService` (memory tools) |
| `mcpTools` | adapted MCP `ToolSet` (bare names), `{}` when MCP is disabled |
| `skillsRoot?` | filesystem root for `read_skill_reference` (defaults to the seeded skills dir) |

## Built-in tools

All built-in tools are scoped to `ctx.userId` and never touch another user's data.

### Memory (M3)

| Tool | Input | Effect |
|------|-------|--------|
| `remember` | `content`, `category` | store a durable fact (injection-guarded, permanent scope) |
| `forget` | `memory_id` | delete a stored memory by id |
| `list_memories` | — | list permanent memories with ids |
| `memory_search` | `query` | semantic search over the user's facts |

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
| `task_update` / `task_delete` / `task_toggle` | `task_id` (+ fields / `is_active`) | edit, delete, enable/disable |

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

`ref_path` must start with `references/`, `scripts/`, or `assets/`; absolute paths and `..` traversal are rejected. Available references are listed for the model in the `[SKILL REFERENCES]` prompt block, populated by `listReferences(skillName)` from the on-disk skills root (`backend/seed/skills`).

## MCP `search`

The only external MCP server kept from the Go project (the `memory` knowledge-graph server is dropped — memory is consolidated into built-in storage). It exposes `web_search`, `web_fetch`, `avby_search`, `read_resource`, and `weather`.

`mastra/mcp.ts` wraps `@mastra/mcp`'s `MCPClient`:

- Configured from `settings.mcp_servers.search` (`{ command, args, env? }`); connects once at boot.
- Tools are read via `listToolsetsWithErrors()`, which yields **bare** names per server — so skills reference `web_search`, not the namespaced `search_web_search`.
- Each Mastra tool is **adapted** into an AI SDK `tool()` (mapping `inputSchema` and the `execute({ context })` convention) so `LlmService` (`streamText`/`generateText`) can call it directly.
- **Graceful degradation:** an unreachable server, a construction error, or a per-server list error logs a `WARN` and yields an empty/partial `ToolSet` — the chat keeps working. The client is `disconnect()`-ed on shutdown.

## Rate limit & usage

Two services run around the tool-enabled turn (see the [Chat Pipeline](chat-pipeline.md)):

- **`RateLimitService`** — an hourly sliding window (`message_rate_limits`) gated by the user's plan `hourly_limit`. Un-onboarded users are bypassed. Over the limit, the turn is rejected before routing.
- **`UsageService`** — accumulates per-user, per-day `cost` + `requests` into `usage_stats` after each answer (cost surfaced from `LlmService`).

Plan limits live in `subscription_plans` — see [Configuration](configuration.md#plans-rate-limit-and-usage).

## See Also

- [Chat Pipeline](chat-pipeline.md) — where tool resolution, the rate-limit gate, and usage recording sit in a turn
- [Configuration](configuration.md) — `mcp_servers`, timeouts, and plan limits that drive these tools
