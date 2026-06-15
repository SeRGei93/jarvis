# Architecture: jarvis (TypeScript + Mastra, monorepo)

## Overview
A single Node service (`backend/`) runs the Telegram bot + cron + admin API together — this removes the SQLite single-writer problem. Configuration is data in libSQL. Layering: **domain (pure) ← config/services ← mastra adapters ← server (composition root)**. Everything external is injectable, so the whole stack is testable without network.

## Layout
```
jarvis/
  backend/
    src/
      config/    env (zod, secrets, + SKILLS_DIR/PROMPTS_DIR), settings (DB cache + hot-reload), settings-keys
      content/   file-backed skill/prompt store: paths, store (populate-if-empty + atomicWrite + parseFrontmatter), skill-repository, prompt-repository
      db/        schema (drizzle, 12 tables — skills/prompts dropped), migrations, client, vector, migrate, seed (code seed), seed-data
      domain/    entities (zod + invariant constants), memory-classifier, sensitivity-filter
      mastra/    models (provider:model factory), llm (stream/watchdog/cost/retries/fallback),
                 strip-leaked-tools, embeddings, speech,
                 agents/ (router, prompt-builder, skill-agent, synthesizer, loop-guard),
                 memory/ (memory-service, profile-extractor, history+message I/O),
                 tools/ (memory-tools, currency, tasks, profile-tools, skill-ref, registry),
                 mcp (MCPClient `search` → AI-SDK ToolSet), workflows/ (chat),
                 index.ts (Mastra instance: storage+vector)
      pkg/       logger (pino + redact), promptguard, bootstrap-env
      services/  skill-service (file-backed via content repos), conversation-context, rate-limit, usage
      app.ts     composition root — createChatService() wires handleUserMessage()
      telegram/  bot (grammY wiring), stream (throttled editMessageText), format (md→MarkdownV2 + split),
                 voice (→speech), messenger (notify), identity (user/channel), commands, errors
      scheduler/ schedule (pure due/notify rules), executor (poll due cron_tasks → chat pipeline → notify),
                 scheduler (node-cron driver: 60s/5s polls), wiring (ChatService+Notifier → Scheduler)
      admin/     app (Hono: /health + webhook + /admin/api + static Mini App), auth (initData HMAC + ADMIN_USER_IDS),
                 api/ (settings, models, mcp, skills, prompts, users, plans, usage — CRUD + cache invalidation)
      server.ts  single-process entry (Hono via @hono/node-server: health + webhook + admin API + static)
                 + best-effort ChatService init + grammY bot + cron scheduler
    skills/      repo-bundled skill defaults (<name>/SKILL.md) — populated into SKILLS_DIR on first run
    prompts/     repo-bundled system-prompt defaults (<KEY>.md) — populated into PROMPTS_DIR on first run
    test/        vitest — unit + libSQL integration; test/helpers/libsql.ts harness
  frontend/      React + Vite + Mantine Mini App (@twa-dev/sdk, HashRouter); built to dist/, served by backend
  docker-compose.yaml
```

## Dependency Rules
- `domain/*` imports nothing from config/db/mastra — pure zod types + business rules.
- `config/` + `services/` depend on `domain` + `db`. Exception: *coordination* services may reuse mastra memory/id helpers (`conversation-context` → `history` thread/resource ids) and small router contract types (`skill-service` → `RoutableSkill`); type-only or thin helper imports, no import cycle.
- `content/` is the file-backed skill/prompt store layer (depends on `domain` + `config` env + `pkg`). `SkillService` (services) wraps `SkillRepository`/`PromptRepository`; both take a dir, so tests point them at temp dirs (no DB).
- `mastra/*` are adapters over AI SDK / LibSQLVector / Mastra Memory; depend on domain + config (+ services for the `chat` workflow orchestrator). `skill-ref` reads references from `SKILLS_DIR` (the content store).
- `app.ts` is the composition root (`createChatService` → `handleUserMessage`); `server.ts` initializes it at boot.
- External calls are injectable (`ModelFactory`, `SettingsService`, `fetchFn`, `Embedder`, `routeModelFn`, `extractFn`, `LoopGuard` clock) → unit tests run with zero network.

## Key Decisions
- **libSQL, not Postgres** — relational + vector in one engine; per-user RAG via vector **metadata filter** (`userId`).
- **AI SDK v6, not Genkit** — `provider:model` factory; watchdog / cost / retries / fallback ported from Go.
- **Memory consolidated** — built-in `memories` (LibSQLVector) + Mastra Memory for dialogue history; MCP `memory` server dropped.
- **No session encryption** — messages stored plaintext in libSQL.
- **Config in DB** — `.env` = secrets only; `SettingsService` caches + hot-reloads.
- **Skills & prompts = files, not DB (M12)** — `backend/{skills,prompts}` defaults populate a persistent volume (`SKILLS_DIR`/`PROMPTS_DIR`) on first run (populate-if-empty); the app reads AND writes there, so admin edits survive redeploys. Atomic write (`*.tmp`+rename) + mtime hot-reload; name/key containment validation. The `skills`/`prompts` tables are dropped; `config.yaml` → code seed (`db/seed-data.ts`), so the DB seeds only settings/models/plans.
- **ESM/NodeNext** — relative imports carry `.js` extensions; dev via `tsx`, prod via `node dist`.
- **Admin Mini App, one origin (M8)** — the Hono admin API (`/admin/api`) and the built React Mini App share the single backend HTTP server (`@hono/node-server`); auth = Telegram `initData` HMAC-SHA256 + `ADMIN_USER_IDS` (deny-by-default, distinct from the in-DB chat allowlist). Admin writes call `SettingsService`/`SkillService` `invalidate()` for hot-reload. Routers are mounted from `admin/api/index.ts`; handlers read deps + `adminUserId` from Hono context.

## Parity Constants (verified against Go)
dedup `0.92` · permanent cap `50` · onboarding `@4` msgs · RAG threshold/topK `10` · embedding dim `1024` · watchdog `30s` · llm_request `300s` · maxSteps `30` · maxRetries `3` · sub-agent loop cap `2`@`5min` · synthesizer temp `0.3` · sub-agent model `skill.model || roles.default` · cron poll `60s`/`5s` · task watchdog `llm_request+30s`. No automatic memory extraction (only `remember` + onboarding). MCP `search` only. `exec` tool not ported.
