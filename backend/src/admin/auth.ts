import { createHmac, timingSafeEqual } from "node:crypto";
import type { MiddlewareHandler } from "hono";
import { logger } from "../pkg/logger.js";

const log = logger.child({ mod: "admin-auth" });

/** Max age of Telegram initData, in seconds (replay protection): 24h. */
export const INIT_DATA_MAX_AGE_SEC = 86_400;

/** Authorization scheme carrying raw initData: `Authorization: tma <initData>`. */
const AUTH_SCHEME = "tma";

/** Telegram WebApp user parsed from the initData `user` field. */
export interface TelegramInitUser {
  id: number;
  first_name?: string;
  last_name?: string;
  username?: string;
  language_code?: string;
  is_premium?: boolean;
  [key: string]: unknown;
}

/** Why initData verification failed (never surfaced to the client verbatim). */
export type InitDataFailure =
  | "empty"
  | "missing_hash"
  | "no_bot_token"
  | "bad_hash"
  | "expired"
  | "missing_user"
  | "bad_user";

export interface InitDataResult {
  ok: boolean;
  user?: TelegramInitUser;
  authDate?: number;
  reason?: InitDataFailure;
}

/**
 * Verify Telegram Mini App initData per the WebApp spec:
 *
 *   secret = HMAC_SHA256(key="WebAppData", msg=botToken)
 *   hash   = HMAC_SHA256(key=secret,       msg=dataCheckString)
 *
 * where dataCheckString is every `key=value` pair except `hash`, sorted by key
 * and joined with "\n". Comparison is constant-time; `auth_date` freshness is
 * enforced to block replay.
 *
 * Pure and synchronous: no network and no env access — `botToken` and `now`
 * are injected so unit tests run deterministically.
 */
export function verifyInitData(
  initDataRaw: string,
  botToken: string | undefined,
  opts: { maxAgeSec?: number; now?: number } = {},
): InitDataResult {
  if (!initDataRaw) return { ok: false, reason: "empty" };
  if (!botToken) return { ok: false, reason: "no_bot_token" };

  const params = new URLSearchParams(initDataRaw);
  const hash = params.get("hash");
  if (!hash) return { ok: false, reason: "missing_hash" };

  // data-check-string: all fields except `hash`, sorted by key, joined by "\n".
  // URLSearchParams yields already-decoded values, which is what Telegram signs.
  const pairs: string[] = [];
  for (const [key, value] of params) {
    if (key === "hash") continue;
    pairs.push(`${key}=${value}`);
  }
  pairs.sort();
  const dataCheckString = pairs.join("\n");

  const secret = createHmac("sha256", "WebAppData").update(botToken).digest();
  const computed = createHmac("sha256", secret).update(dataCheckString).digest();

  const provided = hexToBytes(hash);
  if (!provided || provided.length !== computed.length || !timingSafeEqual(provided, computed)) {
    return { ok: false, reason: "bad_hash" };
  }

  // Freshness — reject stale initData (replay protection).
  const authDateRaw = params.get("auth_date");
  const authDate = authDateRaw ? Number(authDateRaw) : Number.NaN;
  const maxAgeSec = opts.maxAgeSec ?? INIT_DATA_MAX_AGE_SEC;
  const nowSec = Math.floor((opts.now ?? Date.now()) / 1000);
  if (!Number.isFinite(authDate) || nowSec - authDate > maxAgeSec) {
    return { ok: false, reason: "expired", authDate: Number.isFinite(authDate) ? authDate : undefined };
  }

  // A `user` is required to gate admin access by Telegram id.
  const userRaw = params.get("user");
  if (!userRaw) return { ok: false, reason: "missing_user", authDate };
  let user: TelegramInitUser;
  try {
    user = JSON.parse(userRaw) as TelegramInitUser;
  } catch {
    return { ok: false, reason: "bad_user", authDate };
  }
  if (typeof user.id !== "number" || !Number.isFinite(user.id)) {
    return { ok: false, reason: "bad_user", authDate };
  }

  return { ok: true, user, authDate };
}

/** Decode a lowercase/uppercase hex string to bytes, or null when malformed. */
function hexToBytes(hex: string): Buffer | null {
  if (hex.length === 0 || hex.length % 2 !== 0 || /[^0-9a-fA-F]/.test(hex)) return null;
  return Buffer.from(hex, "hex");
}

/** True when `userId` is in the bootstrap admin allowlist (ADMIN_USER_IDS). */
export function isAdmin(userId: number, adminUserIds: readonly number[]): boolean {
  return adminUserIds.includes(userId);
}

/** Extract raw initData from `Authorization: tma <initData>` (scheme case-insensitive). */
export function parseTmaHeader(header: string | undefined): string | null {
  if (!header) return null;
  const trimmed = header.trim();
  const sp = trimmed.indexOf(" ");
  if (sp === -1) return null;
  if (trimmed.slice(0, sp).toLowerCase() !== AUTH_SCHEME) return null;
  const value = trimmed.slice(sp + 1).trim();
  return value || null;
}

/** Everything the admin auth middleware needs — all injectable for tests. */
export interface AdminAuthDeps {
  /** Telegram bot token; when absent the middleware denies every request. */
  botToken: string | undefined;
  /** Bootstrap admin Telegram ids (env.adminUserIds). Empty = deny everyone. */
  adminUserIds: readonly number[];
  /** Override initData TTL (seconds). Defaults to INIT_DATA_MAX_AGE_SEC. */
  maxAgeSec?: number;
  /** Clock injection (ms) for tests. Defaults to Date.now. */
  now?: () => number;
}

/** Hono context variables published by {@link requireAdmin}. */
export interface AdminVariables {
  adminUserId: number;
}

/**
 * Hono middleware: validate `Authorization: tma <initData>` and require the
 * resolved Telegram user to be in ADMIN_USER_IDS.
 *
 * - missing/empty bot token OR empty ADMIN_USER_IDS → 401 (deny-all, WARN once
 *   per request) — admin access stays closed until explicitly configured,
 *   unlike the bot chat allowlist where an empty list means "allow everyone".
 * - missing/invalid initData → 401
 * - valid initData but user not an admin → 403
 * - success → sets `c.var.adminUserId` and continues.
 */
export function requireAdmin(deps: AdminAuthDeps): MiddlewareHandler<{ Variables: AdminVariables }> {
  const { botToken, adminUserIds } = deps;
  return async (c, next) => {
    if (!botToken || adminUserIds.length === 0) {
      log.warn(
        { hasToken: Boolean(botToken), adminCount: adminUserIds.length },
        "admin auth deny-all: bot token missing or ADMIN_USER_IDS empty",
      );
      return c.json({ error: "admin access not configured" }, 401);
    }

    const initData = parseTmaHeader(c.req.header("Authorization"));
    if (!initData) {
      log.debug("admin auth: missing or malformed Authorization header");
      return c.json({ error: "unauthorized" }, 401);
    }

    const res = verifyInitData(initData, botToken, {
      maxAgeSec: deps.maxAgeSec,
      now: deps.now?.(),
    });
    if (!res.ok || !res.user) {
      log.debug({ reason: res.reason }, "admin auth: initData verification failed");
      return c.json({ error: "unauthorized" }, 401);
    }
    if (!isAdmin(res.user.id, adminUserIds)) {
      log.warn({ userId: res.user.id }, "admin auth: user not in ADMIN_USER_IDS");
      return c.json({ error: "forbidden" }, 403);
    }

    c.set("adminUserId", res.user.id);
    log.debug({ userId: res.user.id }, "admin auth ok");
    await next();
  };
}
