/**
 * Generic best-effort, file-backed cache with lazy expiry.
 *
 * Ported from the external MCP server, adapted:
 *  - the `setInterval` cleanup timer is removed (no dead timers); expiry is
 *    checked lazily on `read`. A manual `cleanup()` remains for callers that
 *    want to reclaim disk space explicitly.
 *  - all I/O is best-effort: failures are swallowed (debug-logged) so the
 *    cache stays an optimization, never a hard dependency.
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { webChild } from "./logger.js";
import type { CacheEntry } from "./types.js";

const log = webChild("cache");

export interface CacheOptions {
  dir: string;
  ttlMs: number;
}

export class Cache<T> {
  private readonly dir: string;
  private readonly ttlMs: number;

  constructor(options: CacheOptions) {
    this.dir = options.dir;
    this.ttlMs = options.ttlMs;
  }

  private async ensureDir(): Promise<void> {
    if (!existsSync(this.dir)) {
      await mkdir(this.dir, { recursive: true });
    }
  }

  private getFilePath(key: string): string {
    const hash = createHash("sha256").update(key, "utf8").digest("hex");
    return join(this.dir, `${hash}.json`);
  }

  /** Returns the cached payload, or null if missing or expired. Never throws. */
  async read(key: string): Promise<T | null> {
    const filePath = this.getFilePath(key);
    if (!existsSync(filePath)) return null;
    try {
      const raw = await readFile(filePath, "utf-8");
      const { expiresAt, data } = JSON.parse(raw) as CacheEntry<T>;
      if (Date.now() < expiresAt) return data;
      return null;
    } catch {
      return null;
    }
  }

  /** Stores `data` with a fresh expiry. Best-effort: write failures are swallowed. */
  async write(key: string, data: T): Promise<void> {
    try {
      await this.ensureDir();
      const filePath = this.getFilePath(key);
      const entry: CacheEntry<T> = { expiresAt: Date.now() + this.ttlMs, data };
      await writeFile(filePath, JSON.stringify(entry), "utf-8");
    } catch (err) {
      log.debug({ err }, "cache write failed (ignored)");
    }
  }

  /** Removes the entry for `key`. Best-effort; missing/locked files are ignored. */
  async delete(key: string): Promise<void> {
    const filePath = this.getFilePath(key);
    if (existsSync(filePath)) {
      await unlink(filePath).catch(() => {});
    }
  }

  /**
   * Manually purges expired (or unparseable) entries. Optional — there is no
   * background timer; callers invoke this if/when they want to reclaim space.
   * Returns the number of files deleted.
   */
  async cleanup(): Promise<number> {
    if (!existsSync(this.dir)) return 0;
    const now = Date.now();
    let deleted = 0;
    try {
      const files = await readdir(this.dir);
      for (const file of files) {
        if (!file.endsWith(".json")) continue;
        const filePath = join(this.dir, file);
        try {
          const raw = await readFile(filePath, "utf-8");
          const { expiresAt } = JSON.parse(raw) as CacheEntry<T>;
          if (now >= expiresAt) {
            await unlink(filePath);
            deleted++;
          }
        } catch {
          await unlink(filePath).catch(() => {});
          deleted++;
        }
      }
    } catch (err) {
      log.debug({ err }, "cache cleanup failed (ignored)");
    }
    return deleted;
  }
}

export function createCache<T>(options: CacheOptions): Cache<T> {
  return new Cache<T>(options);
}
