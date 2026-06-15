# Project: jarvis

## Overview
Personalized AI assistant for Telegram — a TypeScript rewrite of **avocado-ai** (Go) on the **Mastra.ai** framework. Multi-provider LLM, skill-based routing, long-term memory with semantic search, tools, MCP, cron. Configuration (model roles, timeouts, plans) lives in the **database**; **skills and system prompts live in a file-backed store** (repo-bundled defaults populated onto a persistent volume — `SKILLS_DIR`/`PROMPTS_DIR`), read and written there so admin edits survive redeploys. All of it is editable from a Telegram Mini App admin; `.env` holds only secrets.

## Status
Migration **milestones 0–8 complete** (каркас, БД+настройки, LLM-слой, память, скилы+chat workflow, инструменты+MCP, Telegram-бот, Cron-планировщик, Админка). Source of truth: `.ai-factory/ROADMAP.md` (milestones 0→10). Next: **M9** — деплой (Dockerfile, 1 контейнер) + миграция данных Postgres→libSQL. M8 landed: admin Mini App — Hono admin-API (`/admin/api`, CRUD по settings/models/mcp/skills/prompts/users/plans/usage с инвалидацией кэшей `SettingsService`/`SkillService`) + auth по Telegram `initData` (HMAC-SHA256 + `ADMIN_USER_IDS`, deny-by-default) на едином Hono-сервере (`@hono/node-server`: health + webhook + admin-API + статика); фронт `frontend/` (React+Vite+Mantine, `@twa-dev/sdk`), собирается в `dist/` и отдаётся бэкендом. M7 landed: cron-планировщик в едином процессе (`backend/src/scheduler/`) — node-cron polls (60с recurring/`once`, 5с `now`), исполнитель прогоняет `cron_tasks.prompt` через `handleUserMessage` (watchdog `llm_request+30с`), нотификации через `Messenger`; `shouldNotify` гасит NO_CHANGES для мониторинга. M6 landed: grammY-бот (`backend/src/telegram/`) — polling по умолчанию (+ опц. минимальный webhook), throttled `editMessageText`-стриминг, markdown→MarkdownV2 (`marked`) + сплит по 4096, голос→speech, команды (`/start /help /new /me /tasks /usage /about /reset_onboarding`), get-or-create user/channel, allowlist, `Messenger` под cron-нотификации.

## Monorepo
- **`backend/`** — Node + Mastra service (Telegram bot + cron + admin API in one process).
- **`frontend/`** — admin Mini App (React + Vite + Mantine, `@twa-dev/sdk`) — *M8 done*; built to `dist/`, served by the backend.
- **`docker-compose.yaml`** — at the repo root.

## Tech Stack
- **Runtime:** Node.js 22, TypeScript 5, ESM (NodeNext)
- **Agent framework:** `@mastra/core` v1.42 (agents/workflows/tools), `@mastra/memory`
- **Storage / vector:** `@mastra/libsql` (LibSQLStore + LibSQLVector) — local file or Turso
- **ORM / migrations:** `drizzle-orm` 0.45 + `drizzle-kit` (dialect `turso`)
- **LLM:** Vercel AI SDK **v6** — `@openrouter/ai-sdk-provider`, `@ai-sdk/openai|google|xai`, `@ai-sdk/openai-compatible` (Z.AI)
- **MCP:** `@mastra/mcp` — server `search` only
- **Cron:** `cron-parser` (schedule validation, M5) + `node-cron` (execution — single-process 60s/5s polls, M7) · **Telegram:** grammY (polling + опц. webhook, throttled streaming), markdown→MarkdownV2 via `marked` · **HTTP/Admin:** Hono + `@hono/node-server` (health + webhook + `/admin/api` + static Mini App, M8)
- **Admin frontend:** React 18 + Vite + Mantine 7 + `@twa-dev/sdk` (`frontend/`, M8)
- **Validation:** zod v4 · **Logging:** pino (structured JSON) · **Tests:** vitest
- **Deploy:** Docker (single container), optional Turso

## Non-Functional Requirements
- Config read from DB via `SettingsService` (in-memory cache + hot-reload); `.env` = secrets only
- Structured pino logging with `LOG_LEVEL`; **secrets redacted**, never logged as values
- Security: `promptguard` (length + injection validation, content sanitization); no secrets in code/logs
- Timeouts on every LLM/HTTP call (`llm_request` / `http_client`) + idle `llm_activity` watchdog
- Tests: unit + libSQL integration via a vitest temp-DB harness
