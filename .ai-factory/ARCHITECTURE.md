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
      db/        schema (drizzle, 12 tables — skills/prompts dropped), migrations, client, migrate, seed (code seed), seed-data
      domain/    entities (zod + invariant constants), memory-classifier, sensitivity-filter
      mastra/    models (provider:model factory), llm (stream/watchdog/cost/retries/fallback),
                 strip-leaked-tools, speech,
                 agents/ (orchestrator, primary-skill, prompt-builder, skill-agent, loop-guard),
                 memory/ (memory-service, rolling-summary, fact-extractor, dedup, profile-extractor, history+message I/O),
                 tools/ (web bucket, load-skill, memory-tools, currency, tasks, profile-tools, skill-ref, registry),
                 workflows/ (chat),
                 index.ts (Mastra instance: storage)
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
- `mastra/*` are adapters over AI SDK / Mastra Memory; depend on domain + config (+ services for the `chat` workflow orchestrator). `skill-ref` reads references from `SKILLS_DIR` (the content store).
- `app.ts` is the composition root (`createChatService` → `handleUserMessage`); `server.ts` initializes it at boot.
- External calls are injectable (`ModelFactory`, `SettingsService`, `fetchFn`, `routeModelFn`, `extractFn`, `DedupChecker`, `Summarizer`, `LoopGuard` clock) → unit tests run with zero network.

## Key Decisions
- **libSQL, not Postgres** — one relational engine for config + memory. No vector store: long-term memory is capped (50) and loaded whole (M13), not RAG-retrieved.
- **AI SDK v6, not Genkit** — `provider:model` factory; watchdog / cost / retries / fallback ported from Go.
- **Single orchestrator Agent (mastra-adoption)** — the chat path is **one dynamic Mastra `Agent`** (`agents/orchestrator.ts`) whose `instructions`/`model`/`tools` are functions of a per-request `RequestContext` pulled live from `SettingsService`/`SkillService` (DI preserved; Agent kept standalone, not on a `Mastra` instance). It replaces the old router → N skill-agents → synthesizer. A cheap pre-pass (`primary-skill.ts`) picks the primary skill + turn model. ALL tools register up front and are gated per step via `prepareStep → activeTools`, widened by the `load_skill` tool (progressive skill loading). Stream off `agent.stream().fullStream`; our own `AbortSignal` watchdog (Mastra has no timeout) + `stripLeakedToolCalls` post-stream. Risky tools (`forget`/`task_delete`) go through **confirm-before-execute** (`ConfirmationService` + `pending_confirmations`). `skill-agent`/`loop-guard` survive only for the admin skill test-run.
- **Memory** — long-term facts in a plain `memories` table (load-all + LLM dedup, M13); written by explicit `remember`/onboarding **and** an opportunistic extractor (`agent.auto_memory`, M14). Dialogue history via Mastra Memory + a per-session rolling summary (`sessions.summary`, M14). MCP `memory` server dropped.
- **No session encryption** — messages stored plaintext in libSQL.
- **Config in DB** — `.env` = secrets only; `SettingsService` caches + hot-reloads.
- **Skills & prompts = files, not DB (M12)** — `backend/{skills,prompts}` defaults populate a persistent volume (`SKILLS_DIR`/`PROMPTS_DIR`) on first run (populate-if-empty); the app reads AND writes there, so admin edits survive redeploys. Atomic write (`*.tmp`+rename) + mtime hot-reload; name/key containment validation. The `skills`/`prompts` tables are dropped; `config.yaml` → code seed (`db/seed-data.ts`), so the DB seeds only settings/models/plans.
- **ESM/NodeNext** — relative imports carry `.js` extensions; dev via `tsx`, prod via `node dist`.
- **Admin Mini App, one origin (M8)** — the Hono admin API (`/admin/api`) and the built React Mini App share the single backend HTTP server (`@hono/node-server`); auth = Telegram `initData` HMAC-SHA256 + `ADMIN_USER_IDS` (deny-by-default, distinct from the in-DB chat allowlist). Admin writes call `SettingsService`/`SkillService` `invalidate()` for hot-reload.
- **Bot access gate (M17)** — `telegram_access_mode` (`open`|`approval`) controls who may chat. `open` keeps the legacy allowlist (empty = everyone); `approval` admits only `telegram_allowed_users` and turns an unknown user's message into a pending `access_requests` row (one-time reply) instead of dropping it. The admin reviews them in the Mini App (Users → «Заявки»); approving adds the id to the allowlist (via `AccessRequestService`) and DMs the user. `ensureAccessControlDefaults()` opts in once on startup, merging existing Telegram users into the allowlist so nobody is locked out. Routers are mounted from `admin/api/index.ts`; handlers read deps + `adminUserId` from Hono context.

## Parity Constants (verified against Go)
permanent cap `50` · onboarding `@4` msgs · max_history `50` (was 15, M14) · watchdog `30s` · llm_request `300s` · orchestrator maxSteps `50` · maxRetries `3` · admin skill-test loop cap `2`@`5min` · sub-agent model `skill.model || roles.default` · cron poll `60s`/`5s` · task watchdog `llm_request+30s`.

**Diverged from Go:** single dynamic orchestrator `Agent` with progressive `load_skill` tool-gating replaces the router → skills → synthesizer pipeline (mastra-adoption; `maxSteps 50`). No vector/RAG/embeddings — dedup is an LLM check, not cosine `0.92` (M13). Web search/scraping is the native `web` tool bucket, not MCP (M11). Memory extraction is opportunistic (`agent.auto_memory`) on top of `remember` + onboarding (M14). `exec` tool not ported.
