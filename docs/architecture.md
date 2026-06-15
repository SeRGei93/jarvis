[← Getting Started](getting-started.md) · [Back to README](../README.md) · [Chat Pipeline →](chat-pipeline.md)

# Architecture

A single Node service (`backend/`) runs the Telegram bot + cron + admin API together — this removes the SQLite single-writer problem. Configuration is data in libSQL.

## Layering

```
domain (pure) ← config / services ← mastra adapters ← app.ts / server.ts (composition root)
```

- `domain/*` imports nothing from config/db/mastra — pure zod types + business rules.
- `config/` + `services/` depend only on `domain` + `db`.
- `mastra/*` are adapters over the AI SDK / LibSQLVector / Mastra Memory; depend on `domain` + `config`.
- `app.ts` is the composition root (wires the factory, settings, services into `handleUserMessage`).
- External calls are injectable (`ModelFactory`, `SettingsService`, `Embedder`, `RouteModelFn`, `ExtractFn`, `LoopGuard`'s clock) → tests run with zero network.

## Structure (`backend/src/`)

| Dir | Contents |
|-----|----------|
| `config/` | `env` (zod secrets), `settings` (DB cache + hot-reload), `settings-keys` |
| `db/` | `schema` (14 tables), `migrations/`, `client`, `vector`, `migrate`, `seed` |
| `domain/` | `entities` (zod + invariant constants), `memory-classifier`, `sensitivity-filter` |
| `mastra/` | `models`, `llm`, `strip-leaked-tools`, `embeddings`, `speech`, `index` (Mastra instance) |
| `mastra/agents/` | `router`, `prompt-builder`, `skill-agent`, `synthesizer`, `loop-guard` |
| `mastra/memory/` | `memory-service` (RAG), `profile-extractor`, `history` (+ message I/O) |
| `mastra/tools/` | `registry` (bucket resolver), `memory-tools`, `currency`, `web` (native web bucket), `tasks`, `profile-tools`, `skill-ref` |
| `mastra/workflows/` | `chat` (route → runSkills → synthesize) |
| `services/` | `skill-service`, `conversation-context`, `web/` (SearXNG search, browser-free fetch + SSRF guard, parsers + Belarus verticals) |
| `pkg/` | `logger` (pino + redact), `promptguard`, `bootstrap-env` |
| `app.ts` | composition root — `createChatService()` → `handleUserMessage()` |
| `server.ts` | single-process entry point (health server + best-effort ChatService init) |

## Key Decisions

- **libSQL, not Postgres** — relational + vector in one engine; per-user RAG via vector metadata filter (`userId`).
- **AI SDK v6, not Genkit** — `provider:model` factory; watchdog / cost / retries / fallback ported from Go.
- **Config in DB** — `.env` = secrets only; `SettingsService` caches + hot-reloads.
- **Memory consolidated** — built-in `memories` (LibSQLVector) + Mastra Memory for dialogue history; the Go MCP `memory` server is dropped.
- **Chat is a flat async orchestrator** (`runChat`), not a Mastra `createWorkflow` graph — token streaming to Telegram (`onText`) stays first-class. See [Chat Pipeline](chat-pipeline.md).
- **ESM / NodeNext** — relative imports carry `.js` extensions; dev via `tsx`, prod via `node dist`.

## Parity Constants (verified against Go)

dedup `0.92` · permanent cap `50` · onboarding `@4` msgs · RAG threshold/topK `10` · embedding dim `1024` · watchdog `30s` · `llm_request` `300s` · maxSteps `30` · maxRetries `3` · sub-agent loop cap `2`@`5min` · synthesizer temp `0.3`. No automatic memory extraction (only `remember` + onboarding). The web tools are **native** (`services/web/` + the `web` tool bucket) — there is no external MCP server; the Go MCP `exec` tool is not ported.

## See Also

- [Chat Pipeline](chat-pipeline.md) — how the layers cooperate to answer one message
- [Configuration](configuration.md) — what lives in `.env` vs the database
