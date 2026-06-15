/**
 * Small file-backed cache for av.by brand/model lookups.
 *
 * Adapted to jarvis: writes under our web cache dir (`CACHE_DIR.avby`, rooted at
 * `env.WEB_CACHE_DIR`); every write is best-effort (failures are caught, swallowed
 * and debug-logged). No background cleanup timer — expiry is lazy on read.
 */
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { CACHE_DIR, CACHE_TTL } from "../config.js";
import { webChild } from "../logger.js";

const log = webChild("avby");

const TTL_MS = CACHE_TTL.filters; // 30 дней
const DIR = CACHE_DIR.avby;

async function ensureDir(): Promise<void> {
  if (!existsSync(DIR)) {
    await mkdir(DIR, { recursive: true });
  }
}

function filePath(key: string): string {
  return join(DIR, `${key}.json`);
}

/** Reads cached payload for `key`, or null if missing/expired. Never throws. */
export async function readAvbyCache<T>(key: string): Promise<T | null> {
  const fp = filePath(key);
  if (!existsSync(fp)) return null;
  try {
    const raw = await readFile(fp, "utf-8");
    const { expiresAt, data } = JSON.parse(raw) as { expiresAt: number; data: T };
    if (Date.now() < expiresAt) return data;
    return null;
  } catch {
    return null;
  }
}

/** Stores `data` under `key` with a fresh expiry. Best-effort: write failures are swallowed. */
export async function writeAvbyCache<T>(key: string, data: T): Promise<void> {
  try {
    await ensureDir();
    const payload = JSON.stringify({ expiresAt: Date.now() + TTL_MS, data });
    await writeFile(filePath(key), payload, "utf-8");
  } catch (err) {
    log.debug({ err, key }, "avby cache write failed (ignored)");
  }
}
