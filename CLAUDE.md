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
1. `promptguard.validateUserMessage()` at the inbound message entry: Unicode-normalize (NFKC + strip zero-width/control) **before** the length + injection check.
2. `promptguard.sanitizeMemoryContent()` before storing a memory: PII-redact (email/phone/card) then truncate (≤500).
3. Never commit `.env` / API keys; never log secret values (pino `redact`).
4. Treat LLM output, stored memories, and fetched web content (`fetch_url` / web tools) as **untrusted** (strip / delimit before reuse).
5. Scope every memory/data query by `userId`.
6. **Bot access gate** — `telegram_access_mode` (`open`|`approval`). `open`: empty `telegram_allowed_users` = everyone. `approval`: only allowlisted ids chat; an unknown user's message creates a pending `access_requests` row (one-time "заявка отправлена" reply, no silent spam) — admin approves in the Mini App → id added to the allowlist + user notified. The gate (`bot.ts`) and admin share one `SettingsService`, so an approval's `invalidate()` is seen without restart. `ensureAccessControlDefaults` (server boot) opts into `approval` once, merging existing Telegram users first (no lockout).

## Before commit (run in `backend/`)
- [ ] `npm run typecheck` clean?
- [ ] `npm test` green?
- [ ] Timeouts/watchdog on every LLM/HTTP call?
- [ ] Errors logged, not swallowed?
- [ ] New migration generated for any schema change?
- [ ] No secrets in code or logs?

## Agent / chat architecture
The chat path is **one dynamic Mastra `Agent`** (`mastra/agents/orchestrator.ts`) — `instructions`/`model`/`tools` are functions of a per-request `RequestContext`, values pulled live from `SettingsService`/`SkillService` (DI preserved; Agent kept standalone, not on a `Mastra` instance). It replaces the old router → N skills → synthesizer. A cheap pre-pass (`primary-skill.ts`) picks the primary skill + turn model. Skills load progressively: ALL tools registered up front, gated per step via `prepareStep→activeTools`, widened by the `load_skill` tool (Mastra `Workspace` skills evaluated, **not** adopted — they don't gate tools). Stream off `agent.stream().fullStream`; keep our `AbortSignal` watchdog (Mastra has no timeout); `stripLeakedToolCalls` post-stream. Risky tools (`forget`/`task_delete`) go through **confirm-before-execute** (`ConfirmationService` + `pending_confirmations` table — our own, not Mastra snapshots). `skill-agent.ts`/`loop-guard.ts` survive only for the admin skill test-run.

## Runtime invariants (project defaults — tunable, not locked)
cap `50` · onboarding `@4` · watchdog `30s` · llm_request `300s` · orchestrator maxSteps `50` · maxRetries `3`. These are current defaults, free to change as the design needs. Web search/scraping is **native** (the `web` tool bucket over SearXNG, no MCP); there is **no `exec` / model-driven code execution** (security stance — do not add it).

## Memory design
Long-term memory has **no vector/RAG/embeddings**: the per-user set is capped at 50 and loaded into context whole; dedup at save is an **LLM check** (`DedupChecker`). There is no `embedding` model role and no `rag_top_k` setting.

Beyond `remember` + onboarding, an **opportunistic extractor** (`FactExtractor`) may auto-save durable facts after a turn, gated by `agent.auto_memory` (default on); it still routes through `MemoryService.save` (sensitivity/dedup/cap). Dialogue history also carries a per-session **rolling summary** (`sessions.summary`) of messages evicted beyond `agent.max_history` (50).

## Status
Milestones **0–9 + 11 done** (10 — N/A). Roadmap + plans in `.ai-factory/ROADMAP.md` and `.ai-factory/plans/`. Latest: **mastra-adoption** refactor (`.ai-factory/plans/mastra-adoption.md`) — single orchestrator `Agent` + `load_skill` replaces router/synthesizer; guardrail processors; stream tool-status; deterministic eval harness (`npm run eval`); tool-approval for risky tools.
