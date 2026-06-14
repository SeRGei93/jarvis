# Project: jarvis

## Overview
Personalized AI assistant for Telegram — a TypeScript rewrite of **avocado-ai** (Go) on the **Mastra.ai** framework. Multi-provider LLM, skill-based routing, long-term memory with semantic search, tools, MCP, cron. Configuration (model roles, timeouts, skills, prompts, plans, MCP servers) lives in the **database** and is editable from a Telegram Mini App admin; `.env` holds only secrets.

## Status
Migration **milestones 0–3 complete** (каркас, БД+настройки, LLM-слой, память). Source of truth: `.ai-factory/ROADMAP.md` (milestones 0→10). Next: **M4** — skill-agent factory + chat workflow.

## Monorepo
- **`backend/`** — Node + Mastra service (Telegram bot + cron + admin API in one process).
- **`frontend/`** — admin Mini App (React + Vite) — *not started (M8)*.
- **`docker-compose.yaml`** — at the repo root.

## Tech Stack
- **Runtime:** Node.js 22, TypeScript 5, ESM (NodeNext)
- **Agent framework:** `@mastra/core` v1.42 (agents/workflows/tools), `@mastra/memory`
- **Storage / vector:** `@mastra/libsql` (LibSQLStore + LibSQLVector) — local file or Turso
- **ORM / migrations:** `drizzle-orm` 0.45 + `drizzle-kit` (dialect `turso`)
- **LLM:** Vercel AI SDK **v6** — `@openrouter/ai-sdk-provider`, `@ai-sdk/openai|google|xai`, `@ai-sdk/openai-compatible` (Z.AI)
- **MCP:** `@mastra/mcp` — server `search` only
- **Telegram:** grammY *(M6)* · **Cron:** node-cron *(M7)* · **HTTP/Admin:** Hono *(M8)*
- **Validation:** zod v4 · **Logging:** pino (structured JSON) · **Tests:** vitest
- **Deploy:** Docker (single container), optional Turso

## Non-Functional Requirements
- Config read from DB via `SettingsService` (in-memory cache + hot-reload); `.env` = secrets only
- Structured pino logging with `LOG_LEVEL`; **secrets redacted**, never logged as values
- Security: `promptguard` (length + injection validation, content sanitization); no secrets in code/logs
- Timeouts on every LLM/HTTP call (`llm_request` / `http_client`) + idle `llm_activity` watchdog
- Tests: unit + libSQL integration via a vitest temp-DB harness
