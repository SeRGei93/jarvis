[← Admin Mini App](admin.md) · [Back to README](../README.md)

# Deployment

A single-host Docker deployment: one app container (Telegram bot + cron + admin
API + Mini App). TLS and the public domain are handled by an **external Caddy**
that lives on a shared `edge` Docker network and reverse-proxies to the app by
container name. A helper script provisions secrets; a `Makefile` wraps the
common commands.

## Architecture (one DB writer by design)

```
                 :443                       edge network
  Telegram  ──▶  ┌─────────────┐  proxy   ┌──────────────────────────┐
  & browsers     │ Caddy       │ ───────▶ │ jarvis-app (one process) │
                 │ (external,  │  :8080   │  bot + cron + admin API  │──▶ ./data/db
                 │  auto-TLS)  │          │  + Mini App (/miniapp)   │   (libSQL file)
                 └─────────────┘          └──────────────────────────┘
                                                      │ default network
                                                ┌───────────┐
                                                │ searxng + │
                                                │  redis    │
                                                └───────────┘
```

The external Caddy is **not** part of this compose project — it runs separately
(it usually fronts several apps) and only shares the `edge` network. It reaches
the app as `jarvis-app:8080` (the app's `container_name`) and terminates TLS for
`https://<domain>`. The Mini App is served under **`/miniapp`** (so the
@BotFather menu-button URL is `https://<domain>/miniapp`).

The Mini App is **not** a separate runtime service. `frontend/` is its source
(React + Vite, `base: "/miniapp/"`); `npm run build` compiles it to static files
baked into the `app` image and served by the backend's Hono server (single
origin — no CORS, `initData` auth stays same-origin). In dev you run it
separately with hot reload (`cd frontend && npm run dev`, open
`http://localhost:5173/miniapp/`, the API proxied to the backend).

| Service | Role | Touches the DB? |
|---------|------|-----------------|
| **app** (`jarvis-app`) | the whole jarvis process — bot, cron, admin API, Mini App static | **yes — the only one** |
| **searxng** | metasearch engine the app queries for web search (internal network only) | no |
| **redis** | cache / coordination backend for searxng (internal network only) | no |
| _Caddy_ | TLS + reverse-proxy to `jarvis-app:8080` — **external**, not in this compose | no |

`app` reaches searxng over the private `default` network (`SEARXNG_URL=http://searxng:8080`); searxng is **not** exposed publicly. searxng requires `SEARXNG_SECRET` (the compose fails fast if it is unset) and mounts its config read-only from `deploy/searxng/{settings.yml,limiter.toml}`. See [Web Search](web-search.md). Only the app joins the `edge` network; searxng and redis stay on `default`.

> **Only `app` opens the database.** Bot, cron and the admin API run in a *single*
> Node process sharing *one* libSQL connection — this is the deliberate
> single-writer design (ROADMAP §2), so there is no concurrent-writer problem.
> To scale horizontally later, move `LIBSQL_URL` to **Turso** (libSQL server) —
> the code is unchanged.

All persistent state is bind-mounted under the host-visible **`./data/`** directory
(gitignored), so there are no opaque Docker named volumes to manage:

```
./data/db/avocado.db        libSQL database (only the app writes it)
./data/db/web-cache/        web fetch/search file cache (app mounts ./data/db → /data, WEB_CACHE_DIR=/data/web-cache)
./data/redis/               redis persistence (searxng cache/coordination)
```

(TLS certificates are owned by the external Caddy, not stored under `./data`.)

## Prerequisites

- A Linux host with **Docker** + the Docker Compose plugin.
- An **external Caddy** (or another reverse proxy) that terminates TLS and is
  attached to a shared Docker network named **`edge`**. Create the network once:
  `docker network create edge` (the deploy script also does this if missing).
- A **domain** whose DNS `A`/`AAAA` record points at the Caddy host.
- A **Telegram bot token** (@BotFather) and an **OpenRouter API key**; your Telegram
  user id for `ADMIN_USER_IDS`.

## Quick start

```bash
git clone <repo> jarvis && cd jarvis
make deploy        # provisions .env, builds, starts everything (TLS via Caddy)
```

`make deploy` runs `deploy/deploy.sh all`, which:

1. **Provisions `.env`** (interactive prompts; `chmod 600`) — domain, bot token,
   OpenRouter key, admin ids, optional extra provider keys.
2. **Builds** the app image (multi-stage: build the Mini App → compile the backend
   → runtime that serves both).
3. **Ensures** the shared `edge` network exists, then **starts** `app`, `searxng`,
   `redis`.

Then point your external **Caddy** at the app (see [Reverse proxy](#reverse-proxy-external-caddy))
and set the Mini App URL in **@BotFather** (Bot → Menu Button → `https://<domain>/miniapp`).

Non-interactive (CI/automation): export the values first —

```bash
DOMAIN=jarvis.example.com \
TELEGRAM_BOT_TOKEN=... OPENROUTER_API_KEY=... ADMIN_USER_IDS=123 \
./deploy/deploy.sh all
```

## Local testing (no domain)

To try it on your machine without a domain, TLS, or a reverse proxy — just the
app on `:8080` (bot in polling mode):

```bash
# fill the root .env first (at minimum TELEGRAM_BOT_TOKEN, OPENROUTER_API_KEY,
# ADMIN_USER_IDS) — `make env` or copy .env.example
make local        # build + run app on http://localhost:8080
make local-logs   # follow logs
make local-down   # stop
```

The bot works immediately (polling needs no public URL). `http://localhost:8080/health`
returns `ok`. The admin Mini App is served too, but it only authenticates when
opened from inside Telegram over HTTPS — in a plain browser `initData` is empty,
so you'll see "Нет доступа". To exercise the admin UI locally, expose the port via
an HTTPS tunnel (`cloudflared`/`ngrok`) and set `<tunnel-url>/miniapp` as the Mini
App in @BotFather.

If port 8080 is already taken on your host, override it: `LOCAL_PORT=8081 make local`.

> `docker-compose.local.yml` brings up `searxng` + `redis` alongside `app`, so the
> native web tools work locally too. The local compose defaults `SEARXNG_SECRET`
> (no setup needed) and publishes the searxng UI on `SEARXNG_PORT` (default `8888`)
> for debugging. If searxng is unreachable, web-search tools degrade per request
> while the rest of the bot keeps working. See [Web Search](web-search.md).

## Make targets

| Target | Action |
|--------|--------|
| `make env` | create/fill `.env` (interactive; `FORCE=1` to overwrite) |
| `make build` | build the app image |
| `make up` / `make down` / `make restart` | start / stop / restart services |
| `make logs` / `make ps` | tail logs / show status |
| `make deploy` | full first-time deploy (env + build + up) |
| `make rebuild` | rebuild and restart just the app after a code change |

## Reverse proxy (external Caddy)

TLS and the public domain are owned by an **external Caddy** that is not part of
this compose project — it runs on its own and shares the `edge` Docker network
with the app. The app publishes **no host ports**; Caddy reaches it as
`jarvis-app:8080` over `edge`.

A minimal `Caddyfile` entry (Caddy auto-provisions the certificate):

```caddyfile
jarvis.example.com {
    # Telegram voice/file uploads can be up to ~25 MB.
    request_body {
        max_size 25MB
    }
    # Long LLM streams: don't cut idle upstream connections early.
    reverse_proxy jarvis-app:8080 {
        transport http {
            read_timeout 360s
        }
    }
}
```

Caddy's own service must be attached to the `edge` network for the
`jarvis-app:8080` name to resolve, e.g. in Caddy's compose:

```yaml
services:
  caddy:
    # …
    networks: [edge]
networks:
  edge:
    external: true
```

> The everything-under-`/` proxy above also covers the Telegram webhook
> (`POST /telegram`), the admin API (`/admin/api/*`), `/health`, and the Mini App
> (`/miniapp`). No per-path config is needed.

## Configuration

All config lives in the root `.env` (see [`.env.example`](../.env.example)); the app
reads the same DB-backed settings documented in [Configuration](configuration.md).
Deploy-specific keys:

| Key | Meaning |
|-----|---------|
| `DOMAIN` | public domain the external Caddy serves / the Mini App origin (informational for the app; the Caddyfile is what binds it) |
| `ADMIN_USER_IDS` | Telegram ids allowed into the admin (deny-by-default) |
| `LIBSQL_URL` | `file:/data/avocado.db` (volume) or a Turso URL |
| `SEARXNG_SECRET` | secret key the searxng container requires (prod compose fails fast if unset) |
| `SEARXNG_PORT` | host port for the searxng UI (local compose only; default `8888`) |

## Updating

```bash
git pull
make rebuild     # rebuild + restart app only (the external Caddy keeps running)
```

Migrations and the idempotent seed run automatically on every app start
(`deploy/docker-entrypoint.sh` → `node dist/db/seed.js`). Skill/prompt default
changes shipped in the new image are also reconciled into the store on boot —
delivered to files the admin never edited, preserving admin edits (see
[Configuration](configuration.md#skills-and-prompts-file-backed-store-m12)).

## Data & backups

The libSQL database is a single host file at **`./data/db/avocado.db`** — back it
up by copying it (libSQL/SQLite is safe to copy when the app is briefly stopped,
or use the libSQL/sqlite backup API for hot copies):

```bash
cp ./data/db/avocado.db ./data/db/avocado-$(date +%F).db   # or off-host: rsync ./data
```

## Troubleshooting

- **Caddy can't reach the app / `502`** — confirm both containers share the `edge`
  network (`docker network inspect edge` should list `jarvis-app` and `caddy`) and
  that Caddy proxies to `jarvis-app:8080`. Check app health: `make logs` / `docker compose logs app`.
- **`network edge not found` on `up`** — create it once: `docker network create edge`
  (or just run `make deploy`, which ensures it).
- **TLS / certificate problems** — these are the external Caddy's domain now; check
  Caddy's logs and that DNS points at the Caddy host with ports 80/443 open there.
- **Admin returns 401 for everyone** — `ADMIN_USER_IDS` is empty or `TELEGRAM_BOT_TOKEN`
  is unset (deny-by-default); fix `.env` and `make restart`.
- **Mini App won't open in Telegram** — the @BotFather menu-button URL must be the
  public **HTTPS** `https://<domain>/miniapp` (note the `/miniapp` path);
  `http://localhost` will not load (see [Admin Mini App](admin.md)).
