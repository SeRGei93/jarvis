# jarvis — Project Rules

## Language / Язык
All speckit outputs (spec.md, plan.md, tasks.md, checklists) MUST be written in Russian.

## Monorepo
- **Backend** (Node + Mastra): `backend/` — run, test, and generate migrations from there (`cd backend`).
- **Frontend** (admin Mini App): `frontend/` — *M8*.
- `docker-compose.yaml` at the repo root.

## Architecture (domain ← services ← adapters)
```
domain/ (pure zod + rules) ← config/ services/ ← mastra/ adapters ← server.ts
```
- ❌ NEVER import `mastra`/`config`/`db` from `domain`.
- ❌ NEVER hard-wire a concrete impl where injection fits — keep `ModelFactory` / `SettingsService` / `fetchFn` / `DedupChecker` injectable (this is why tests need no network).

## Stack invariants
- **ESM / NodeNext**: relative imports use the `.js` extension.
- **AI SDK v6**: resolve models through `ModelFactory` (`provider:model`).
- **libSQL** via drizzle (dialect `turso`); schema changes → `npm run db:generate`. (No vector store — long-term memory is a plain relational table loaded whole.)
- Config comes from the DB via `SettingsService`; **`.env` = secrets ONLY**.

## Security
1. `promptguard.validateUserMessage()` (length + injection) at the inbound message entry.
2. `promptguard.sanitizeMemoryContent()` (≤500) before storing a memory.
3. Never commit `.env` / API keys; never log secret values (pino `redact`).
4. Treat LLM output, stored memories, and fetched web content (`fetch_url` / web tools) as **untrusted** (strip / delimit before reuse).
5. Scope every memory/data query by `userId`.

## Before commit (run in `backend/`)
- [ ] `npm run typecheck` clean?
- [ ] `npm test` green?
- [ ] Timeouts/watchdog on every LLM/HTTP call?
- [ ] Errors logged, not swallowed?
- [ ] New migration generated for any schema change?
- [ ] No secrets in code or logs?

## Runtime invariants (project defaults — tunable, not locked)
cap `50` · onboarding `@4` · watchdog `30s` · llm_request `300s` · maxSteps `30` · maxRetries `3`. These are current defaults, free to change as the design needs. Web search/scraping is **native** (the `web` tool bucket over SearXNG, no MCP); there is **no `exec` / model-driven code execution** (security stance — do not add it).

## Memory design
Long-term memory has **no vector/RAG/embeddings**: the per-user set is capped at 50 and loaded into context whole; dedup at save is an **LLM check** (`DedupChecker`). There is no `embedding` model role and no `rag_top_k` setting.

Beyond `remember` + onboarding, an **opportunistic extractor** (`FactExtractor`) may auto-save durable facts after a turn, gated by `agent.auto_memory` (default on); it still routes through `MemoryService.save` (sensitivity/dedup/cap). Dialogue history also carries a per-session **rolling summary** (`sessions.summary`) of messages evicted beyond `agent.max_history` (50).

## Status
Milestones **0–9 + 11 done** (10 — N/A). Roadmap + plans in `.ai-factory/ROADMAP.md` and `.ai-factory/plans/`. Latest: **M13** (long-term memory de-vectorised: load-all + LLM dedup, embeddings/LibSQLVector removed).
