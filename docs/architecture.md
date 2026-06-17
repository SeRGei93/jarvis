[← Getting Started](getting-started.md) · [Back to README](../README.md) · [Chat Pipeline →](chat-pipeline.md)

# Architecture

A single Node service (`backend/`) runs the Telegram bot + cron + admin API together — this removes the SQLite single-writer problem. Configuration is data in libSQL.

## Layering

```
domain (pure) ← config / services ← mastra adapters ← app.ts / server.ts (composition root)
```

- `domain/*` imports nothing from config/db/mastra — pure zod types + business rules.
- `config/` + `services/` depend only on `domain` + `db`.
- `content/` is the file-backed skill/prompt store (`SKILLS_DIR`/`PROMPTS_DIR`); `SkillService` wraps `SkillRepository`/`PromptRepository`, both taking a dir so tests point them at temp dirs.
- `mastra/*` are adapters over the AI SDK / Mastra Memory; depend on `domain` + `config`.
- `app.ts` is the composition root (wires the factory, settings, services into `handleUserMessage`).
- External calls are injectable (`ModelFactory`, `SettingsService`, `RouteModelFn`, `ExtractFn`, `DedupChecker`, `Summarizer`, `LoopGuard`'s clock) → tests run with zero network.

## Structure (`backend/src/`)

| Dir | Contents |
|-----|----------|
| `config/` | `env` (zod secrets, + `SKILLS_DIR`/`PROMPTS_DIR`), `settings` (DB cache + hot-reload), `settings-keys` |
| `content/` | file-backed skill/prompt store: `paths`, `store` (populate + atomic write + frontmatter), `skill-repository`, `prompt-repository` |
| `db/` | `schema` (13 tables — incl. `pending_confirmations`, no `skills`/`prompts`), `migrations/`, `client`, `migrate`, `seed` (code seed), `seed-data` |
| `domain/` | `entities` (zod + invariant constants), `memory-classifier`, `sensitivity-filter` |
| `mastra/` | `models`, `llm`, `strip-leaked-tools`, `speech`, `index` (Mastra instance) |
| `mastra/agents/` | `primary-skill` (pre-pass), `orchestrator` (the agent), `prompt-builder`, `skill-agent` + `loop-guard` (admin test-run only) |
| `mastra/confirmations/` | `confirmation-service` (confirm-before-execute for risky tools) |
| `mastra/memory/` | `memory-service` (load-all + cap), `rolling-summary`, `fact-extractor`, `dedup` (LLM), `profile-extractor`, `history` (+ message I/O) |
| `mastra/tools/` | `registry` (`resolveTools`/`resolveAllTools`), `load-skill`, `memory-tools`, `currency`, `web` (native web bucket), `tasks`, `profile-tools`, `skill-ref` |
| `mastra/workflows/` | `chat` (pre-pass → orchestrator agent) |
| `services/` | `skill-service`, `conversation-context`, `web/` (SearXNG search, browser-free fetch + SSRF guard, parsers + Belarus verticals) |
| `pkg/` | `logger` (pino + redact), `promptguard`, `bootstrap-env` |
| `app.ts` | composition root — `createChatService()` → `handleUserMessage()` |
| `server.ts` | single-process entry point (health server + best-effort ChatService init) |

## Key Decisions

- **libSQL, not Postgres** — one relational engine for config + memory. No vector store: long-term memory is capped (50) and loaded whole (M13), not RAG-retrieved.
- **AI SDK v6, not Genkit** — `provider:model` factory; watchdog / cost / retries / fallback ported from Go.
- **Config in DB** — `.env` = secrets only; `SettingsService` caches + hot-reloads. The code seed (`db/seed-data.ts`) fills `settings`/`models`/`subscription_plans`.
- **Skills & prompts are files, not DB rows (M12)** — repo defaults in `backend/{skills,prompts}` populate `SKILLS_DIR`/`PROMPTS_DIR` on a persistent volume on first run (populate-if-empty); the app reads and writes there, so admin edits survive redeploys. Atomic write + mtime hot-reload; the `skills`/`prompts` tables were dropped.
- **Memory** — long-term facts in a plain `memories` table (load-all + LLM dedup, M13), written by `remember`/onboarding **and** an opportunistic extractor (`agent.auto_memory`, M14). Dialogue history via Mastra Memory + a per-session rolling summary (`sessions.summary`, M14). The Go MCP `memory` server is dropped.
- **Chat is a flat async orchestrator** (`runChat`), not a Mastra `createWorkflow` graph — token streaming to Telegram (`onText`) stays first-class. See [Chat Pipeline](chat-pipeline.md).
- **ESM / NodeNext** — relative imports carry `.js` extensions; dev via `tsx`, prod via `node dist`.

## Parity Constants (verified against Go)

permanent cap `50` · onboarding `@4` msgs · max_history `50` · watchdog `30s` · `llm_request` `300s` · orchestrator maxSteps `50` · maxRetries `3`. (The old per-skill cap `30`, sub-agent loop cap `2`@`5min`, and synthesizer temp `0.3` now apply only to the admin skill test-run.) **Design choices:** no vector/RAG/embeddings — dedup is an LLM check (M13); memory extraction is opportunistic (`agent.auto_memory`, M14) on top of `remember` + onboarding; web tools are **native** (`services/web/` + the `web` bucket), no external MCP server; no model-driven code execution; the chat path is one dynamic Mastra `Agent` with progressive `load_skill` tool-gating (Mastra `Workspace` skills evaluated, not adopted — they don't gate tools).

## See Also

- [Chat Pipeline](chat-pipeline.md) — how the layers cooperate to answer one message
- [Configuration](configuration.md) — what lives in `.env` vs the database
