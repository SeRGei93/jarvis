# AGENTS.md — jarvis

> Project map for AI agents. Keep this file up-to-date as the project evolves.

## Overview
Telegram AI assistant — a TypeScript + Mastra rewrite of avocado-ai (Go). Monorepo: `backend/` (Node service) + `frontend/` (admin Mini App — React + Vite + Mantine). Migration **milestones 0–8 done**.

## Tech Stack
Node 22 · TS5 ESM · `@mastra/core` 1.42 · `@mastra/libsql` (LibSQLStore + LibSQLVector) · `drizzle-orm` 0.45 · Vercel AI SDK v6 · zod v4 · grammY 1.44 (polling + opt. webhook; Bot API 10.1 rich messages) · node-cron (M7) · Hono (M8) · pino · vitest.

## Structure (`backend/src/`)
| Dir | Contents |
|-----|----------|
| `config/` | `env` (zod secrets, + `SKILLS_DIR`/`PROMPTS_DIR`), `settings` (DB cache + hot-reload), `settings-keys` |
| `content/` | file-backed skill/prompt store: `paths`, `store` (populate + atomic write + frontmatter), `skill-repository`, `prompt-repository` |
| `db/` | `schema` (13 tables — incl. `pending_confirmations`, no `skills`/`prompts`), `migrations/`, `client`, `migrate`, `seed` (code seed), `seed-data` |
| `domain/` | `entities` (+ constants), `memory-classifier`, `sensitivity-filter` |
| `mastra/` | `models`, `llm`, `strip-leaked-tools`, `speech`, `agents/{primary-skill,orchestrator,prompt-builder,skill-agent,loop-guard}`, `confirmations/confirmation-service`, `memory/{memory-service,profile-extractor,history,…}`, `tools/{load-skill,memory-tools,registry,…}`, `workflows/chat`, `index` |
| `services/` | `skill-service` (file-backed via content repos), `conversation-context`, `rate-limit`, `usage` |
| `telegram/` | `bot`, `stream`, `format`, `voice`, `messenger`, `identity`, `commands`, `errors` (grammY transport, M6) |
| `scheduler/` | `schedule`, `executor`, `scheduler` (node-cron), `wiring` — due cron tasks → chat pipeline → notify (M7) |
| `admin/` | `app` (Hono), `auth` (Telegram `initData` HMAC + `ADMIN_USER_IDS`), `api/{settings,models,mcp,skills,prompts,users,plans,usage}` (M8) |
| `pkg/` | `logger`, `promptguard`, `bootstrap-env` |
| `app.ts` | composition root — `createChatService()` → `handleUserMessage()` |
| `server.ts` | single-process entry (Hono via `@hono/node-server`: `/health` + webhook + `/admin/api` + static Mini App; + ChatService + grammY bot + cron scheduler) |
| `backend/skills/`, `backend/prompts/` | repo-bundled content-store defaults (populated into `SKILLS_DIR`/`PROMPTS_DIR` on first run) |
| `test/` | vitest (unit + libSQL integration); `helpers/libsql.ts` harness |

## Structure (`frontend/src/`)
Vite + React 18 + Mantine 7 + `@twa-dev/sdk`, HashRouter. `lib/api` (typed client, sends `Authorization: tma <initData>`), `lib/types`, `lib/theme` (Telegram themeParams), `nav` (section registry — single source of truth), `components/{Layout,AuthGate,AccessDenied}`, `screens/` (Skills/Models/Settings/Prompts/Plans/Users/Usage/Mcp). Dev proxies `/admin/api`→:8080; `npm run build` → `dist/`, served by the backend (single origin).

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
| Chat Pipeline | `docs/chat-pipeline.md` | pre-pass → orchestrator agent, load_skill, guardrails, tool approval, evals |
| Tools & MCP | `docs/tools.md` | built-in tools, MCP `search`, rate limit & usage |
| Telegram Bot | `docs/telegram.md` | grammY transport, streaming, voice, commands, allowlist |
| Cron Scheduler | `docs/scheduler.md` | node-cron polls, due tasks → chat pipeline → notify |
| Configuration | `docs/configuration.md` | `.env` secrets and DB-backed settings |
| Admin Mini App | `docs/admin.md` | Hono admin API, `initData` auth, React Mini App (M8) |
| Deployment | `docs/deployment.md` | Docker + external Caddy (TLS) on shared `edge` net, deploy.sh, Makefile (M9) |

## Next
**M9** — deploy & data migration: multi-stage Dockerfile (build frontend → serve from the single backend container), npm-scripts, Postgres → libSQL data migration script.
