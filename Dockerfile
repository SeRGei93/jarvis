# syntax=docker/dockerfile:1
#
# jarvis — single runtime image: the Node backend (Telegram bot + cron + admin
# API) serves the built admin Mini App as static. One process, one port (8080).
# nginx terminates TLS in front of it (see docker-compose.yaml).

# ── 1. Build the admin Mini App (→ /frontend/dist) ───────────────────────────
FROM node:22-alpine AS frontend
WORKDIR /frontend
COPY frontend/package.json frontend/package-lock.json ./
# npm install (not ci): npm@10 `ci` mis-handles cross-OS optional deps (esbuild
# platform binaries) → EBADPLATFORM; install skips incompatible optionals and
# resolves the right native bindings for this platform.
RUN npm install --no-audit --no-fund
COPY frontend/ ./
RUN npm run build

# ── 2. Compile the backend (TypeScript → /backend/dist) ──────────────────────
FROM node:22-alpine AS backend
WORKDIR /backend
COPY backend/package.json backend/package-lock.json ./
RUN npm install --no-audit --no-fund
COPY backend/ ./
RUN npm run build

# ── 3. Runtime ───────────────────────────────────────────────────────────────
FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app/backend

# production-only dependencies
COPY backend/package.json backend/package-lock.json ./
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force

# compiled backend
COPY --from=backend /backend/dist ./dist
# drizzle migration SQL is not emitted by tsc — place it next to the compiled
# migrator (runMigrations resolves ./migrations relative to dist/db/migrate.js)
COPY backend/src/db/migrations ./dist/db/migrations
# bundled first-run seed (config.yaml / skills / prompts), read via ../../seed
COPY backend/seed ./seed
# built Mini App — served as static from ../frontend/dist (relative to CWD)
COPY --from=frontend /frontend/dist /app/frontend/dist

# migrate (+ idempotent seed) then start the single process
COPY deploy/docker-entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

ENV ADMIN_STATIC_DIR=/app/frontend/dist
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
