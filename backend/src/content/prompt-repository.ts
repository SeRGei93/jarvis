import { readdir, readFile, stat } from "node:fs/promises";
import type { Dirent, Stats } from "node:fs";
import { join } from "node:path";
import { atomicWrite } from "./store.js";
import { promptsStoreDir } from "./paths.js";
import { logger } from "../pkg/logger.js";

const log = logger.child({ mod: "prompt-repository" });

/** System prompt keys the app + admin UI use (one `<KEY>.md` file each). */
export const KNOWN_PROMPT_KEYS = ["SOUL", "FORMAT", "INTEGRITY", "SYNTHESIZER", "WELCOME", "MONITORING"];

/** A prompt key is an uppercase identifier — also the on-disk file stem. */
const PROMPT_KEY_RE = /^[A-Z][A-Z0-9_]*$/;

/** True when `key` is a safe prompt key (no traversal / separators). */
export function isValidPromptKey(key: string): boolean {
  return PROMPT_KEY_RE.test(key);
}

/** A stored prompt: its key, body, and file mtime (exposed as `updatedAt`). */
export interface StoredPrompt {
  key: string;
  body: string;
  updatedAt: Date;
}

/**
 * File-backed system-prompt store over `PROMPTS_DIR`. Each prompt is `<KEY>.md`
 * (e.g. `SOUL.md`); the key is the uppercased file stem. Caches parsed bodies in
 * memory and hot-reloads on mtime change (same approach as SkillRepository, robust
 * where `fs.watch` is unreliable). Admin writes go through {@link upsert} (atomic +
 * cache invalidation).
 */
export class PromptRepository {
  private cache: Map<string, StoredPrompt> | null = null;
  private signature = "";

  constructor(private readonly dir: string = promptsStoreDir()) {}

  /** Drop the cache; the next accessor reloads from disk. */
  invalidate(): void {
    this.cache = null;
    this.signature = "";
    log.debug("prompt cache invalidated");
  }

  private promptFile(key: string): string {
    return join(this.dir, `${key}.md`);
  }

  /** Cheap stat-only fingerprint of `*.md` mtimes — detects edits/adds/removes. */
  private async signatureOf(): Promise<string> {
    let entries: Dirent[];
    try {
      entries = await readdir(this.dir, { withFileTypes: true });
    } catch {
      return "";
    }
    const parts: string[] = [];
    for (const e of entries) {
      if (e.isDirectory() || !e.name.endsWith(".md")) continue;
      try {
        const st = await stat(join(this.dir, e.name));
        parts.push(`${e.name}:${st.mtimeMs}`);
      } catch {
        // race: file removed between readdir and stat — ignore
      }
    }
    parts.sort();
    return parts.join("|");
  }

  private async load(): Promise<Map<string, StoredPrompt>> {
    const sig = await this.signatureOf();
    if (this.cache && sig === this.signature) return this.cache;

    const map = new Map<string, StoredPrompt>();
    let entries: Dirent[];
    try {
      entries = await readdir(this.dir, { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        this.cache = map;
        this.signature = sig;
        return map;
      }
      throw err;
    }

    for (const e of entries) {
      if (e.isDirectory() || !e.name.endsWith(".md")) continue;
      const key = e.name.replace(/\.md$/, "").toUpperCase();
      const file = join(this.dir, e.name);
      let raw: string;
      let st: Stats;
      try {
        st = await stat(file);
        raw = await readFile(file, "utf8");
      } catch {
        continue;
      }
      map.set(key, { key, body: raw.trim(), updatedAt: st.mtime });
    }

    this.cache = map;
    this.signature = sig;
    log.debug({ count: map.size }, "prompts loaded from store");
    return map;
  }

  /** Prompt body by key, or "" if absent (parity with the old DB-backed getPrompt). */
  async get(key: string): Promise<string> {
    return (await this.load()).get(key)?.body ?? "";
  }

  /** One prompt with file mtime, or null (admin API). */
  async getStored(key: string): Promise<StoredPrompt | null> {
    return (await this.load()).get(key) ?? null;
  }

  /** All prompts with file mtime (admin API). */
  async list(): Promise<StoredPrompt[]> {
    return [...(await this.load()).values()];
  }

  /** Create or overwrite a prompt's `<KEY>.md` atomically; returns it with the new mtime. */
  async upsert(key: string, body: string): Promise<StoredPrompt> {
    if (!isValidPromptKey(key)) throw new Error(`invalid prompt key: "${key}"`);
    const file = this.promptFile(key);
    await atomicWrite(file, `${body.trim()}\n`);
    this.invalidate();
    const st = await stat(file);
    log.info({ key }, "prompt upserted to store");
    return { key, body: body.trim(), updatedAt: st.mtime };
  }
}
