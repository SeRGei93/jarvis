#!/bin/sh
# Container entrypoint: apply DB migrations + idempotent seed, then start jarvis.
# `dist/db/seed.js` runs runMigrations() and then seeds with onConflictDoNothing,
# so it is safe to run on every start (fresh DB → migrated+seeded; existing → no-op).
set -e

echo "[entrypoint] applying migrations + seed"
node dist/db/seed.js

echo "[entrypoint] starting jarvis"
exec node dist/server.js
