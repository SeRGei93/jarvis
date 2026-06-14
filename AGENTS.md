# AGENTS.md — jarvis

> Project map for AI agents. Keep this file up-to-date as the project evolves.

## Overview
Telegram AI assistant — a TypeScript + Mastra rewrite of avocado-ai (Go). Monorepo: `backend/` (Node service) + `frontend/` (admin Mini App, M8). Migration **milestones 0–6 done**.

## Tech Stack
Node 22 · TS5 ESM · `@mastra/core` 1.42 · `@mastra/libsql` (LibSQLStore + LibSQLVector) · `drizzle-orm` 0.45 · Vercel AI SDK v6 · zod v4 · grammY (polling + opt. webhook) · `marked` (md→MarkdownV2) · node-cron (M7) · Hono (M8) · pino · vitest.

## Structure (`backend/src/`)
| Dir | Contents |
|-----|----------|
| `config/` | `env` (zod secrets), `settings` (DB cache + hot-reload), `settings-keys` |
| `db/` | `schema` (14 tables), `migrations/`, `client`, `vector`, `migrate`, `seed` |
| `domain/` | `entities` (+ constants), `memory-classifier`, `sensitivity-filter` |
| `mastra/` | `models`, `llm`, `strip-leaked-tools`, `embeddings`, `speech`, `agents/{router,prompt-builder,skill-agent,synthesizer,loop-guard}`, `memory/{memory-service,profile-extractor,history}`, `tools/{memory-tools,registry}`, `workflows/chat`, `index` |
| `services/` | `skill-service`, `conversation-context`, `rate-limit`, `usage` |
| `telegram/` | `bot`, `stream`, `format`, `voice`, `messenger`, `identity`, `commands`, `errors` (grammY transport, M6) |
| `pkg/` | `logger`, `promptguard`, `bootstrap-env` |
| `app.ts` | composition root — `createChatService()` → `handleUserMessage()` |
| `server.ts` | single-process entry point (health server + ChatService + grammY bot start) |
| `seed/` | bundled `config.yaml` + `skills/` + `prompts/` (first-run seed) |
| `test/` | vitest (unit + libSQL integration); `helpers/libsql.ts` harness |

## Commands (run in `backend/`)
| Command | Purpose |
|---------|---------|
| `npm run dev` | run the service (`tsx watch src/server.ts`) |
| `npm run typecheck` | `tsc --noEmit` |
| `npm test` | `vitest run` |
| `npm run db:generate` / `db:migrate` / `db:seed` | drizzle migrations + DB seed |
| `npm run build` / `start` | compile to `dist/` / run compiled |

## AI Context Files
| File | Purpose |
|------|---------|
| `CLAUDE.md` | project rules, security, before-commit checklist |
| `AGENTS.md` | this map |
| `.ai-factory/DESCRIPTION.md` | spec + tech stack |
| `.ai-factory/ARCHITECTURE.md` | architecture + dependency rules |
| `.ai-factory/ROADMAP.md` | migration roadmap (milestones 0→10) |
| `.ai-factory/plans/` | implementation plans (e.g. `feature-jarvis-foundation-m0-m3.md`) |

## Documentation
| Document | Path | Description |
|----------|------|-------------|
| README | `README.md` | Project landing page |
| Getting Started | `docs/getting-started.md` | Install, migrate, seed, run, test |
| Architecture | `docs/architecture.md` | Layering, structure, dependency rules |
| Chat Pipeline | `docs/chat-pipeline.md` | route → runSkills → synthesize, agents, memory |
| Tools & MCP | `docs/tools.md` | built-in tools, MCP `search`, rate limit & usage |
| Telegram Bot | `docs/telegram.md` | grammY transport, streaming, voice, commands, allowlist |
| Configuration | `docs/configuration.md` | `.env` secrets and DB-backed settings |

## Next
**M7** — cron scheduler: node-cron executor + task notifications (via the M6 `Messenger`). M5/M6 left `cron_tasks` CRUD + schedule validation and the notification send-path ready.
