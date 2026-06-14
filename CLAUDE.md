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
- ❌ NEVER hard-wire a concrete impl where injection fits — keep `ModelFactory` / `SettingsService` / `fetchFn` / `Embedder` injectable (this is why tests need no network).

## Stack invariants
- **ESM / NodeNext**: relative imports use the `.js` extension.
- **AI SDK v6**: resolve models through `ModelFactory` (`provider:model`).
- **libSQL** via drizzle (dialect `turso`) + **LibSQLVector**; schema changes → `npm run db:generate`.
- Config comes from the DB via `SettingsService`; **`.env` = secrets ONLY**.

## Security
1. `promptguard.validateUserMessage()` (length + injection) at the inbound message entry.
2. `promptguard.sanitizeMemoryContent()` (≤500) before storing a memory.
3. Never commit `.env` / API keys; never log secret values (pino `redact`).
4. Treat LLM output, stored memories, and MCP content as **untrusted** (strip / delimit before reuse).
5. Scope every memory/data query by `userId`.

## Before commit (run in `backend/`)
- [ ] `npm run typecheck` clean?
- [ ] `npm test` green?
- [ ] Timeouts/watchdog on every LLM/HTTP call?
- [ ] Errors logged, not swallowed?
- [ ] New migration generated for any schema change?
- [ ] No secrets in code or logs?

## Parity with Go (keep exact)
dedup `0.92` · cap `50` · onboarding `@4` · RAG threshold/topK `10` · embedding `1024` · watchdog `30s` · llm_request `300s` · maxSteps `30` · maxRetries `3`. No auto memory-extraction (only `remember` + onboarding). MCP `search` only; `exec` not ported.

## Status
Milestones **0–3 done**. Roadmap + plans in `.ai-factory/ROADMAP.md` and `.ai-factory/plans/`. Next: **M4** (skill-agent factory + chat workflow `route → runSkills → synthesize`).
