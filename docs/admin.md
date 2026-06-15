[← Configuration](configuration.md) · [Back to README](../README.md)

# Admin Mini App

The admin surface (Milestone 8): a **Telegram Mini App** that edits configuration — **skills and prompts** (the file-backed content store) plus **models, settings, plans, users, and usage** (libSQL) — without touching files or the database by hand. It is a React app (`frontend/`) talking to a **Hono REST API** (`backend/src/admin/`) that runs in the **same process** as the bot and the [cron scheduler](scheduler.md). Access is gated by Telegram `initData` verification plus a bootstrap admin allowlist.

## HTTP surface (one process, one port)

`server.ts` builds a single [Hono](https://hono.dev) app served by `@hono/node-server` (replacing the old raw `node:http` server). All surfaces share the one port (`PORT`, default `8080`):

| Route | Auth | Purpose |
|-------|------|---------|
| `GET /health` | none | Liveness probe (`{ status: "ok", service: "jarvis" }`) |
| `POST /telegram` (webhook path) | Telegram | grammY webhook (only in webhook mode; `503` until the bot is up) |
| `/admin/api/*` | admin | Admin REST API (see below) |
| `GET /`, `/index.html`, `/assets/*` | none | The built Mini App (`frontend/dist`), when present |

The chat service, bot, and scheduler are wired **asynchronously and best-effort** after the server starts listening, so `/health` is up even on a fresh, unmigrated DB. Admin routes answer `503` until the chat service has finished booting.

## Authentication

Every admin request must carry the raw Telegram WebApp `initData` in the header:

```
Authorization: tma <initData>
```

`backend/src/admin/auth.ts` verifies it per the [Telegram WebApp spec](https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app):

1. `secret = HMAC_SHA256(key="WebAppData", msg=TELEGRAM_BOT_TOKEN)`
2. `hash == HMAC_SHA256(key=secret, msg=dataCheckString)` — compared in constant time (`crypto.timingSafeEqual`); `dataCheckString` is every field except `hash`, sorted by key, joined with `\n`.
3. `auth_date` freshness — rejected when older than **24h** (`INIT_DATA_MAX_AGE_SEC`, replay protection).
4. The parsed `user.id` must be in **`ADMIN_USER_IDS`** (`.env`).

Outcomes:

| Condition | Status |
|-----------|--------|
| No `TELEGRAM_BOT_TOKEN`, or empty `ADMIN_USER_IDS` | `401` (deny-all, WARN at boot) |
| Missing / malformed / stale / forged `initData` | `401` |
| Valid `initData` but the user is not an admin | `403` |
| Valid admin | passes; `c.var.adminUserId` is set |

> **`ADMIN_USER_IDS` is deny-by-default.** An empty list locks everyone out of the admin — unlike the in-DB `telegram_allowed_users` chat allowlist, where empty means "allow everyone to chat". The two are independent: admin access is a `.env` secret; the chat allowlist is editable from the admin.

Admin inputs are **trusted**: handlers apply zod typing + length caps but deliberately skip prompt-injection filtering, because admins legitimately author system prompts containing instruction-like text.

## REST API

All routers live in `backend/src/admin/api/` and are mounted under `/admin/api` by `api/index.ts`. Each is a `Hono` sub-router that reads `c.var.deps` (the chat stack's services) and `c.var.adminUserId`.

| Group | Endpoints |
|-------|-----------|
| `GET /me` | the authenticated admin's id (liveness) |
| **settings** | `GET/PUT /settings/timeouts`, `GET/PUT /settings/agent` |
| **models** | `GET/POST /models`, `PATCH/DELETE /models/:id`, `GET/PUT /models/roles` |
| **skills** | `GET /skills`, `GET/PUT/DELETE /skills/:name`, `POST /skills`, `POST /skills/:name/test` |
| **prompts** | `GET /prompts`, `GET/PUT /prompts/:key` (SOUL/FORMAT/INTEGRITY/SYNTHESIZER/WELCOME/MONITORING) |
| **users** | `GET /users`, `GET/PATCH /users/:id`, `GET/PUT /users/allowlist` |
| **plans** | `GET/POST /plans`, `PATCH/DELETE /plans/:id`, `PUT /plans/assign` |
| **usage** | `GET /usage`, `GET /usage/user/:id`, `DELETE /usage/ratelimit/:userId` |

**Where writes go.** `settings`/`models`/`plans`/`users`/`usage` write libSQL rows and call `SettingsService.invalidate()`. `skills`/`prompts` write **files** in the content store (`SKILLS_DIR`/`PROMPTS_DIR`) — atomically (`*.tmp` + rename) via the repositories, which invalidate their own cache; the name/key is validated against path traversal. The HTTP contract is name/key-addressed (`PUT /skills/:name`, `PUT /prompts/:key`), so the front end is unchanged. The live chat re-reads the new value on its next turn (hot-reload) — see [Configuration](configuration.md).

**Skill test-run.** `POST /admin/api/skills/:name/test { message }` builds the skill's agent and runs one non-streaming generation (watchdog = `timeouts.llm_request`), returning `{ text, usage }`. Useful for editing a prompt and trying it before saving.

## Frontend

`frontend/` is a self-contained Vite + React 18 + [Mantine](https://mantine.dev) package using `@twa-dev/sdk` (HashRouter). `src/lib/api.ts` attaches `Authorization: tma <WebApp.initData>` to every call; `src/nav.tsx` is the single source of truth for the section list. Screens: Skills (with test-run), Models (+ role assignment), Settings, Prompts, Plans, Users (+ allowlist), Usage.

```
cd frontend && npm install
npm run dev      # Vite on :5173, proxies /admin/api + /health → backend :8080
npm run build    # → frontend/dist, served by the backend (single origin)
```

`ADMIN_STATIC_DIR` overrides where the backend looks for the built app (default `../frontend/dist`, relative to the backend CWD).

## Serving inside Telegram (HTTPS required)

Telegram only opens a Mini App from a public **`https://`** URL with a valid certificate — `http://localhost` will not load in the Telegram client. The `initData` HMAC check itself is transport-agnostic, but the client needs HTTPS to fetch the app.

- **Local testing:** expose the backend over HTTPS with a tunnel (`cloudflared tunnel --url http://localhost:8080` or `ngrok http 8080`) and set that URL as the Mini App in **@BotFather** (Menu Button / `web_app`).
- **Webhook mode** (`TELEGRAM_USE_WEBHOOK=1`) likewise needs a public HTTPS `TELEGRAM_WEBHOOK_URL`; the default long-polling mode does not.
- A production domain + TLS termination (reverse proxy / CDN) and the single-container build land in **Milestone 9**.

## Code map

| File | Responsibility |
|------|----------------|
| `admin/auth.ts` | `verifyInitData`, `isAdmin`, `requireAdmin` middleware |
| `admin/app.ts` | the Hono app (health + webhook + `/admin/api` + static) |
| `admin/api/deps.ts` | `AdminEnv` context contract (`deps`, `adminUserId`) |
| `admin/api/index.ts` | mounts the entity routers behind auth + a readiness gate |
| `admin/api/*.ts` | one router per entity group |
| `server.ts` | builds the app, wires deps/bot/scheduler, `serve()` |
