# jarvis

> Personalized AI assistant for Telegram — a TypeScript + Mastra rewrite of **avocado-ai** (Go).

Multi-provider LLM with skill-based routing, long-term memory with semantic search, native web tools, and cron — in a single Node process. Settings/models/plans live in the **database**; **skills and prompts are a file-backed store** (repo defaults on a persistent volume) — all editable from a Telegram Mini App admin; `.env` holds only secrets.

## Quick Start

```bash
cd backend
npm install
cp .env.example .env        # fill in secrets (LIBSQL_URL works out of the box)
npm run db:migrate          # create the libSQL schema
npm run db:seed             # seed settings/models/plans (skills/prompts populate from backend/{skills,prompts} on first run)
npm run dev                 # start the single-process service
```

## Key Features

- **Skill-based chat** — a router picks 1–4 skills per message; one skill streams directly, several run as parallel sub-agents and are merged by a synthesizer. See [Chat Pipeline](docs/chat-pipeline.md).
- **Config split** — model roles, timeouts, agent params, and plans are libSQL rows hot-reloaded by `SettingsService`; **skills and prompts are files** in a content store (repo defaults populated onto a persistent volume, read+written there, hot-reloaded). See [Configuration](docs/configuration.md).
- **Consolidated memory** — long-term facts via LibSQLVector RAG (per-user, dedup, cap) plus Mastra Memory for dialogue history.
- **Tools** — skills get built-in tools (currency, cron tasks, profile, skill references). See [Tools](docs/tools.md).
- **Native web tools** — in-process web search, page fetch, Belarus marketplaces (kufar/av.by/rabota/transport/relax/103) and weather, backed by a self-hosted SearXNG (no MCP server, no rate limiter). See [Web Search](docs/web-search.md).
- **Telegram bot** — a grammY bot (polling, or optional webhook) with throttled `editMessageText` streaming, markdown→MarkdownV2, voice→speech, commands, and an allowlist. See [Telegram Bot](docs/telegram.md).
- **Cron scheduler** — `node-cron` polls run due `cron_tasks` through the chat pipeline and deliver the result to Telegram (`now` / `once` / recurring). See [Cron Scheduler](docs/scheduler.md).
- **Admin Mini App** — a Telegram Mini App (React + Vite + Mantine) edits the config (file-backed skills/prompts + DB-backed models/settings/plans/users/usage) via a Hono API, gated by `initData` HMAC + `ADMIN_USER_IDS`. See [Admin Mini App](docs/admin.md).
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
| [Tools](docs/tools.md) | built-in tools (currency, cron tasks, profile, skill references) |
| [Web Search](docs/web-search.md) | native web bucket — SearXNG search, fetch, marketplaces, weather |
| [Telegram Bot](docs/telegram.md) | grammY transport, streaming, voice, commands, allowlist |
| [Cron Scheduler](docs/scheduler.md) | node-cron polls, due tasks → chat pipeline → notify |
| [Configuration](docs/configuration.md) | `.env` secrets, DB-backed settings, file-backed skills/prompts |
| [Admin Mini App](docs/admin.md) | Hono admin API, `initData` auth, the React Mini App |
| [Deployment](docs/deployment.md) | Docker + external Caddy (TLS) on a shared `edge` network, deploy script, Makefile |

## Project Status

Migration milestones **0–9 + M11 + M12 complete** (scaffold, DB + settings, LLM layer, memory, skills + chat workflow, tools, Telegram bot, cron scheduler, admin Mini App, deploy stack, the native web-tool bucket that replaced the external MCP `search` server, and the file-backed skill/prompt store that replaced the `skills`/`prompts` DB tables). Roadmap and remaining milestones live in `.ai-factory/ROADMAP.md`.

## License

UNLICENSED — private project.
