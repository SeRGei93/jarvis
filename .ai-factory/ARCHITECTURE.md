# Architecture: jarvis (TypeScript + Mastra, monorepo)

## Overview
A single Node service (`backend/`) runs the Telegram bot + cron + admin API together — this removes the SQLite single-writer problem. Configuration is data in libSQL. Layering: **domain (pure) ← config/services ← mastra adapters ← server (composition root)**. Everything external is injectable, so the whole stack is testable without network.

## Layout
```
jarvis/
  backend/
    src/
      config/    env (zod, secrets), settings (DB cache + hot-reload), settings-keys
      db/        schema (drizzle, 14 tables), migrations, client, vector, migrate, seed
      domain/    entities (zod + invariant constants), memory-classifier, sensitivity-filter
      mastra/    models (provider:model factory), llm (stream/watchdog/cost/retries/fallback),
                 strip-leaked-tools, embeddings, speech,
                 agents/ (router, prompt-builder, skill-agent, synthesizer, loop-guard),
                 memory/ (memory-service, profile-extractor, history+message I/O),
                 tools/ (memory-tools, currency, tasks, profile-tools, skill-ref, registry),
                 mcp (MCPClient `search` → AI-SDK ToolSet), workflows/ (chat),
                 index.ts (Mastra instance: storage+vector)
      pkg/       logger (pino + redact), promptguard, bootstrap-env
      services/  skill-service, conversation-context, rate-limit, usage
      app.ts     composition root — createChatService() wires handleUserMessage()
      telegram/  bot (grammY wiring), stream (throttled editMessageText), format (md→MarkdownV2 + split),
                 voice (→speech), messenger (notify), identity (user/channel), commands, errors
      scheduler/ [M7]
      admin/     [M8] api (Hono), auth (Telegram initData)
      server.ts  single-process entry (health server + best-effort ChatService init)
    seed/        bundled config.yaml + skills/ + prompts/ (first-run seed source)
    test/        vitest — unit + libSQL integration; test/helpers/libsql.ts harness
  frontend/      [M8] React + Vite Mini App
  docker-compose.yaml
```

## Dependency Rules
- `domain/*` imports nothing from config/db/mastra — pure zod types + business rules.
- `config/` + `services/` depend on `domain` + `db`. Exception: *coordination* services may reuse mastra memory/id helpers (`conversation-context` → `history` thread/resource ids) and small router contract types (`skill-service` → `RoutableSkill`); type-only or thin helper imports, no import cycle.
- `mastra/*` are adapters over AI SDK / LibSQLVector / Mastra Memory; depend on domain + config (+ services for the `chat` workflow orchestrator).
- `app.ts` is the composition root (`createChatService` → `handleUserMessage`); `server.ts` initializes it at boot.
- External calls are injectable (`ModelFactory`, `SettingsService`, `fetchFn`, `Embedder`, `routeModelFn`, `extractFn`, `LoopGuard` clock) → unit tests run with zero network.

## Key Decisions
- **libSQL, not Postgres** — relational + vector in one engine; per-user RAG via vector **metadata filter** (`userId`).
- **AI SDK v6, not Genkit** — `provider:model` factory; watchdog / cost / retries / fallback ported from Go.
- **Memory consolidated** — built-in `memories` (LibSQLVector) + Mastra Memory for dialogue history; MCP `memory` server dropped.
- **No session encryption** — messages stored plaintext in libSQL.
- **Config in DB** — `.env` = secrets only; `SettingsService` caches + hot-reloads.
- **ESM/NodeNext** — relative imports carry `.js` extensions; dev via `tsx`, prod via `node dist`.

## Parity Constants (verified against Go)
dedup `0.92` · permanent cap `50` · onboarding `@4` msgs · RAG threshold/topK `10` · embedding dim `1024` · watchdog `30s` · llm_request `300s` · maxSteps `30` · maxRetries `3` · sub-agent loop cap `2`@`5min` · synthesizer temp `0.3` · sub-agent model `skill.model || roles.default`. No automatic memory extraction (only `remember` + onboarding). MCP `search` only. `exec` tool not ported.
