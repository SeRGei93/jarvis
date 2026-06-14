# jarvis

> Personalized AI assistant for Telegram — a TypeScript + Mastra rewrite of **avocado-ai** (Go).

Multi-provider LLM with skill-based routing, long-term memory with semantic search, tools, MCP, and cron — in a single Node process. Configuration (model roles, timeouts, skills, prompts, plans) lives in the **database** and is editable from a Telegram Mini App admin; `.env` holds only secrets.

## Quick Start

```bash
cd backend
npm install
cp .env.example .env        # fill in secrets (LIBSQL_URL works out of the box)
npm run db:migrate          # create the libSQL schema
npm run db:seed             # seed settings/models/skills/prompts from seed/
npm run dev                 # start the single-process service
```

## Key Features

- **Skill-based chat** — a router picks 1–4 skills per message; one skill streams directly, several run as parallel sub-agents and are merged by a synthesizer. See [Chat Pipeline](docs/chat-pipeline.md).
- **Config in the database** — model roles, timeouts, agent params, skills, and prompts are rows in libSQL, hot-reloaded by `SettingsService`. See [Configuration](docs/configuration.md).
- **Consolidated memory** — long-term facts via LibSQLVector RAG (per-user, dedup, cap) plus Mastra Memory for dialogue history.
- **Multi-provider LLM** — Vercel AI SDK v6 (`provider:model` factory) with watchdog, retries/fallback, and cost extraction ported 1:1 from the Go `LLMAdapter`.
- **Single process** — bot + cron + admin API in one Node service over libSQL (no SQLite single-writer problem); Turso-ready.

## Example

```ts
import { createChatService } from "./src/app.js";
import { db } from "./src/db/client.js";
import { storage, vector } from "./src/mastra/index.js";

const chat = await createChatService({ db, storage, vector });

// One entry point for Telegram (M6) and cron (M7); streams tokens via onText.
const result = await chat.handleUserMessage(userId, chatId, "what's the weather and any news?", (chunk) =>
  process.stdout.write(chunk),
);
// → { text: "...merged answer...", skills: ["weather", "news"], rejected: false }
```

---

## Documentation

| Guide | Description |
|-------|-------------|
| [Getting Started](docs/getting-started.md) | Prerequisites, install, migrate, seed, run, test |
| [Architecture](docs/architecture.md) | Layering, structure, dependency rules |
| [Chat Pipeline](docs/chat-pipeline.md) | route → runSkills → synthesize, agents, memory, entry point |
| [Configuration](docs/configuration.md) | `.env` secrets and DB-backed settings |

## Project Status

Migration milestones **0–4 complete** (scaffold, DB + settings, LLM layer, memory, skills + chat workflow). Roadmap and remaining milestones (M5 tools/MCP → M10 cutover) live in `.ai-factory/ROADMAP.md`.

## License

UNLICENSED — private project.
