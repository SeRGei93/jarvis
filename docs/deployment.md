[← Admin Mini App](admin.md) · [Back to README](../README.md)

# Deployment

A single-host Docker deployment: one app container (Telegram bot + cron + admin
API + Mini App) behind nginx with a Let's Encrypt certificate. A helper script
provisions secrets and issues SSL; a `Makefile` wraps the common commands.

## Architecture (one DB writer by design)

```
                 :443 / :80
  Telegram  ──▶  ┌────────┐   proxy    ┌──────────────────────────┐
  & browsers     │ nginx  │ ─────────▶ │ app  (one Node process)  │
                 │  TLS   │  :8080     │  bot + cron + admin API   │──▶ ./data/db
                 └────────┘            │  + Mini App (static)      │   (libSQL file)
                     ▲                 └──────────────────────────┘
                     │ certs (./data/letsencrypt, shared)
                 ┌────────┐
                 │ certbot│  issue / auto-renew
                 └────────┘
```

The Mini App is **not** a separate runtime service. `frontend/` is its source
(React + Vite); `npm run build` compiles it to static files that are baked into
the `app` image and served by the backend's Hono server (single origin — no CORS,
`initData` auth stays same-origin). In dev you run it separately with hot reload
(`cd frontend && npm run dev` on :5173, proxying the API to the backend).

| Service | Role | Touches the DB? |
|---------|------|-----------------|
| **app** | the whole jarvis process — bot, cron, admin API, Mini App static | **yes — the only one** |
| **nginx** | TLS termination + reverse-proxy to `app:8080`, serves the ACME challenge | no |
| **certbot** | obtains and renews the Let's Encrypt certificate | no |

> **Only `app` opens the database.** Bot, cron and the admin API run in a *single*
> Node process sharing *one* libSQL connection — this is the deliberate
> single-writer design (ROADMAP §2), so there is no concurrent-writer problem.
> nginx and certbot never touch the DB. To scale horizontally later, move
> `LIBSQL_URL` to **Turso** (libSQL server) — the code is unchanged.

All persistent state is bind-mounted under the host-visible **`./data/`** directory
(gitignored), so there are no opaque Docker named volumes to manage:

```
./data/db/avocado.db        libSQL database (only the app writes it)
./data/letsencrypt/         SSL certificates  (certbot writes, nginx reads)
./data/certbot-www/         ACME http-01 challenge webroot (certbot ↔ nginx)
```

## Prerequisites

- A Linux host with **Docker** + the Docker Compose plugin.
- A **domain** whose DNS `A`/`AAAA` record points at the host.
- Inbound **ports 80 and 443** open (80 is needed for the ACME HTTP-01 challenge).
- A **Telegram bot token** (@BotFather) and an **OpenRouter API key**; your Telegram
  user id for `ADMIN_USER_IDS`.

## Quick start

```bash
git clone <repo> jarvis && cd jarvis
make deploy        # provisions .env, builds, issues SSL, starts everything
```

`make deploy` runs `deploy/deploy.sh all`, which:

1. **Provisions `.env`** (interactive prompts; `chmod 600`) — domain, Let's Encrypt
   e-mail, bot token, OpenRouter key, admin ids, optional extra provider keys.
2. **Builds** the app image (multi-stage: build the Mini App → compile the backend
   → runtime that serves both).
3. **Issues the certificate** via `deploy/init-letsencrypt.sh` (idempotent).
4. **Starts** `app`, `nginx`, `certbot`.

Then set the Mini App URL in **@BotFather** (Bot → Menu Button → `https://<domain>`).

Non-interactive (CI/automation): export the values first —

```bash
DOMAIN=jarvis.example.com LETSENCRYPT_EMAIL=me@example.com \
TELEGRAM_BOT_TOKEN=... OPENROUTER_API_KEY=... ADMIN_USER_IDS=123 \
./deploy/deploy.sh all
```

## Local testing (no domain)

To try it on your machine without a domain, TLS, or nginx — just the app on
`:8080` (bot in polling mode):

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
an HTTPS tunnel (`cloudflared`/`ngrok`) and set that URL as the Mini App in @BotFather.

If port 8080 is already taken on your host, override it: `LOCAL_PORT=8081 make local`.

> The external MCP `search` server is a separate service (ROADMAP §9) and is **not**
> bundled in the image — locally those tools degrade to none (`mcpTools: 0`), which
> is best-effort by design; the core bot/LLM/memory/skills work without it.

## Make targets

| Target | Action |
|--------|--------|
| `make env` | create/fill `.env` (interactive; `FORCE=1` to overwrite) |
| `make build` | build the app image |
| `make ssl` | issue the certificate (idempotent) |
| `make up` / `make down` / `make restart` | start / stop / restart services |
| `make logs` / `make ps` | tail logs / show status |
| `make deploy` | full first-time deploy (env + build + ssl + up) |
| `make rebuild` | rebuild and restart just the app after a code change |

## SSL details

nginx needs *some* certificate to start, so `init-letsencrypt.sh` drops a temporary
self-signed cert, starts nginx, then requests the real one over the webroot
(`/var/www/certbot`) and reloads. The long-running `certbot` service renews every
12h; nginx reloads every 6h to pick up renewed certs. Set `CERTBOT_STAGING=1` in
`.env` to use Let's Encrypt's staging endpoint while testing (avoids rate limits;
issues untrusted certs).

## Configuration

All config lives in the root `.env` (see [`.env.example`](../.env.example)); the app
reads the same DB-backed settings documented in [Configuration](configuration.md).
Deploy-specific keys:

| Key | Meaning |
|-----|---------|
| `DOMAIN` | public domain (nginx `server_name`, cert CN, Mini App origin) |
| `LETSENCRYPT_EMAIL` | expiry-notice contact for Let's Encrypt |
| `CERTBOT_STAGING` | `1` = staging certs (testing) |
| `ADMIN_USER_IDS` | Telegram ids allowed into the admin (deny-by-default) |
| `LIBSQL_URL` | `file:/data/avocado.db` (volume) or a Turso URL |

## Updating

```bash
git pull
make rebuild     # rebuild + restart app only (nginx/certbot keep running)
```

Migrations and the idempotent seed run automatically on every app start
(`deploy/docker-entrypoint.sh` → `node dist/db/seed.js`).

## Data & backups

The libSQL database is a single host file at **`./data/db/avocado.db`** — back it
up by copying it (libSQL/SQLite is safe to copy when the app is briefly stopped,
or use the libSQL/sqlite backup API for hot copies):

```bash
cp ./data/db/avocado.db ./data/db/avocado-$(date +%F).db   # or off-host: rsync ./data
```

## Troubleshooting

- **Cert issuance fails** — confirm DNS points at the host and ports 80/443 are open;
  retry with `CERTBOT_STAGING=1` first to avoid rate limits.
- **`502` from nginx** — the app container isn't healthy: `make logs` / `docker compose logs app`.
- **Admin returns 401 for everyone** — `ADMIN_USER_IDS` is empty or `TELEGRAM_BOT_TOKEN`
  is unset (deny-by-default); fix `.env` and `make restart`.
- **Mini App won't open in Telegram** — it must be a public **HTTPS** URL set in
  @BotFather; `http://localhost` will not load (see [Admin Mini App](admin.md)).
