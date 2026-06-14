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
- **Tools & MCP** — skills get built-in tools (currency, cron tasks, profile, skill references) plus the external MCP `search` server, with hourly rate limits and per-user usage accounting. See [Tools & MCP](docs/tools.md).
- **Telegram bot** — a grammY bot (polling, or optional webhook) with throttled `editMessageText` streaming, markdown→MarkdownV2, voice→speech, commands, and an allowlist. See [Telegram Bot](docs/telegram.md).
- **Cron scheduler** — `node-cron` polls run due `cron_tasks` through the chat pipeline and deliver the result to Telegram (`now` / `once` / recurring). See [Cron Scheduler](docs/scheduler.md).
- **Admin Mini App** — a Telegram Mini App (React + Vite + Mantine) edits the DB-backed config (skills/models/settings/prompts/plans/users/usage/mcp) via a Hono API, gated by `initData` HMAC + `ADMIN_USER_IDS`. See [Admin Mini App](docs/admin.md).
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
| [Tools & MCP](docs/tools.md) | built-in tools, MCP `search`, rate limit & usage |
| [Telegram Bot](docs/telegram.md) | grammY transport, streaming, voice, commands, allowlist |
| [Cron Scheduler](docs/scheduler.md) | node-cron polls, due tasks → chat pipeline → notify |
| [Configuration](docs/configuration.md) | `.env` secrets and DB-backed settings |
| [Admin Mini App](docs/admin.md) | Hono admin API, `initData` auth, the React Mini App |
| [Deployment](docs/deployment.md) | Docker + nginx + Let's Encrypt, deploy script, Makefile |

## Project Status

Migration milestones **0–8 complete** (scaffold, DB + settings, LLM layer, memory, skills + chat workflow, tools + MCP, Telegram bot, cron scheduler, admin Mini App). Roadmap and remaining milestones (M9 deploy + data migration → M10 cutover) live in `.ai-factory/ROADMAP.md`.

## License

UNLICENSED — private project.
