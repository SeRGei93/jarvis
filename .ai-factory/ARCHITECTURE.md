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
                 agents/ (router), memory/ (memory-service, profile-extractor, history),
                 tools/ (memory-tools), index.ts (Mastra instance: storage+vector+memory)
      pkg/       logger (pino + redact), promptguard, bootstrap-env
      services/  [M5] rate-limit, usage
      telegram/  [M6] bot, stream, format, voice, messenger
      scheduler/ [M7]
      admin/     [M8] api (Hono), auth (Telegram initData)
      server.ts  single-process entry (health server today; full host later)
    seed/        bundled config.yaml + skills/ + prompts/ (first-run seed source)
    test/        vitest — unit + libSQL integration; test/helpers/libsql.ts harness
  frontend/      [M8] React + Vite Mini App
  docker-compose.yaml
```

## Dependency Rules
- `domain/*` imports nothing from config/db/mastra — pure zod types + business rules.
- `config/` + `services/` depend only on `domain` + `db`.
- `mastra/*` are adapters over AI SDK / LibSQLVector; depend on domain + config.
- `server.ts` is the composition root (wires factory, settings, services).
- External calls are injectable (`ModelFactory`, `SettingsService`, `fetchFn`, `Embedder`, `routeModelFn`, `extractFn`) → unit tests run with zero network.

## Key Decisions
- **libSQL, not Postgres** — relational + vector in one engine; per-user RAG via vector **metadata filter** (`userId`).
- **AI SDK v6, not Genkit** — `provider:model` factory; watchdog / cost / retries / fallback ported from Go.
- **Memory consolidated** — built-in `memories` (LibSQLVector) + Mastra Memory for dialogue history; MCP `memory` server dropped.
- **No session encryption** — messages stored plaintext in libSQL.
- **Config in DB** — `.env` = secrets only; `SettingsService` caches + hot-reloads.
- **ESM/NodeNext** — relative imports carry `.js` extensions; dev via `tsx`, prod via `node dist`.

## Parity Constants (verified against Go)
dedup `0.92` · permanent cap `50` · onboarding `@4` msgs · RAG threshold/topK `10` · embedding dim `1024` · watchdog `30s` · llm_request `300s` · maxSteps `30` · maxRetries `3`. No automatic memory extraction (only `remember` + onboarding). MCP `search` only. `exec` tool not ported.
