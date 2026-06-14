[Back to README](../README.md) · [Architecture →](architecture.md)

# Getting Started

Get the `jarvis` backend running locally against a libSQL file database.

## Prerequisites

| Tool | Version | Notes |
|------|---------|-------|
| Node.js | ≥ 22 | ESM / NodeNext |
| npm | bundled with Node | |
| (optional) Turso | — | only for hosted libSQL in production |

All commands below run inside `backend/`.

## Install

```bash
cd backend
npm install
```

## Configure secrets

`.env` holds **only secrets and runtime flags** — everything else is configuration in the database.

```bash
cp .env.example .env
```

The default `LIBSQL_URL=file:./data/avocado.db` works with no external services. Add LLM provider keys (at minimum `OPENROUTER_API_KEY`) to actually call models. See [Configuration](configuration.md) for the full list.

## Create the database

```bash
npm run db:migrate    # apply drizzle migrations (14 tables + vector index)
npm run db:seed       # seed settings/models/skills/prompts from backend/seed/
```

The seed is idempotent on first run only — it skips if the `settings` table already has rows.

## Run

```bash
npm run dev           # tsx watch src/server.ts (auto-reload)
```

This boots the single-process service: a health server on `PORT` (default `8080`) plus a best-effort `ChatService` init. Verify it is up:

```bash
curl localhost:8080/health
# {"status":"ok","service":"jarvis"}
```

> If the DB is not migrated/seeded yet, the health server still starts and logs `WARN chat service init deferred` — run the migrate/seed steps and restart.

## Test

```bash
npm test              # vitest run — unit + libSQL integration
npm run typecheck     # tsc --noEmit
```

Integration tests spin up an isolated temp libSQL database per test via `test/helpers/libsql.ts` — no network or external services required.

## Build (production)

```bash
npm run build         # tsc → dist/
npm start             # node dist/server.js
```

## Next Steps

- Understand the layout → [Architecture](architecture.md)
- See how a message is answered → [Chat Pipeline](chat-pipeline.md)

## See Also

- [Configuration](configuration.md) — environment variables and DB-backed settings
- [Architecture](architecture.md) — layers, structure, dependency rules
