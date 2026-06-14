#!/usr/bin/env bash
#
# Issue the initial Let's Encrypt certificate for $DOMAIN (idempotent).
# Pattern: drop a temporary self-signed cert so nginx can boot, answer the ACME
# HTTP-01 challenge over :80 via the shared webroot, then swap in the real cert.
# Renewals afterwards are handled by the long-running `certbot` compose service.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
mkdir -p data/db data/letsencrypt data/certbot-www
[ -f .env ] || { echo "[ssl] .env missing — run: make env" >&2; exit 1; }
set -a; . ./.env; set +a
: "${DOMAIN:?DOMAIN not set in .env}"
: "${LETSENCRYPT_EMAIL:?LETSENCRYPT_EMAIL not set in .env}"

compose() { docker compose "$@"; }
cb()      { compose run --rm --entrypoint "$1" certbot "${@:2}"; }

live="/etc/letsencrypt/live/$DOMAIN/fullchain.pem"

# Already have a (non-dummy) certificate? Nothing to do.
if cb sh -c "[ -s '$live' ] && ! openssl x509 -in '$live' -noout -issuer | grep -qi 'CN=$DOMAIN\$'" >/dev/null 2>&1; then
  echo "[ssl] certificate for $DOMAIN already present — skipping issuance."
  exit 0
fi

echo "[ssl] creating a temporary self-signed certificate so nginx can start"
cb sh -c "mkdir -p /etc/letsencrypt/live/$DOMAIN && \
  openssl req -x509 -nodes -newkey rsa:2048 -days 1 \
    -keyout /etc/letsencrypt/live/$DOMAIN/privkey.pem \
    -out    /etc/letsencrypt/live/$DOMAIN/fullchain.pem \
    -subj   '/CN=$DOMAIN'"

echo "[ssl] starting app + nginx to answer the ACME challenge"
compose up -d app nginx

echo "[ssl] removing the temporary certificate"
cb sh -c "rm -rf /etc/letsencrypt/live/$DOMAIN \
  /etc/letsencrypt/archive/$DOMAIN \
  /etc/letsencrypt/renewal/$DOMAIN.conf"

staging=""
[ "${CERTBOT_STAGING:-}" = "1" ] && { staging="--staging"; echo "[ssl] using STAGING (test certificates)"; }

echo "[ssl] requesting the Let's Encrypt certificate for $DOMAIN"
cb certbot certonly --webroot -w /var/www/certbot $staging \
  -d "$DOMAIN" \
  --email "$LETSENCRYPT_EMAIL" \
  --agree-tos --no-eff-email --non-interactive

echo "[ssl] reloading nginx"
compose exec nginx nginx -s reload 2>/dev/null || compose restart nginx
echo "[ssl] done → https://$DOMAIN"
