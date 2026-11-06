import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { basename, join } from "node:path";
import { env } from "../config/env.js";
import type { Message, MessageRole, StoredImageRef } from "../domain/entities.js";
import { logger } from "../pkg/logger.js";

const log = logger.child({ mod: "media" });

// ══════════════════════════════════════════════════════════════════════════
// Limits (single source of truth for the Telegram transport + chat pipeline)
// ══════════════════════════════════════════════════════════════════════════
/** Largest image we accept (Telegram Bot API download limit is 20 MB). */
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
/** Images accepted per user turn; extras are dropped with a warning. */
export const MAX_IMAGES_PER_TURN = 4;
/** MIME types we can store and send to a vision model (GIF deliberately excluded). */
export const SUPPORTED_IMAGE_MIMES = ["image/jpeg", "image/png", "image/webp"] as const;
/** How many of the most recent user messages may re-attach their images. */
export const VISION_HISTORY_USER_MESSAGES = 2;
/** Max images re-attached from history into one turn. */
export const VISION_HISTORY_MAX_IMAGES = 4;
/** Max total bytes re-attached from history into one turn. */
export const VISION_HISTORY_MAX_BYTES = 12 * 1024 * 1024;
/** Stored images older than this are deleted by the retention prune. */
export const MEDIA_RETENTION_DAYS = 7;
/** How often a running process re-runs the retention prune (startup + every 24 h). */
export const MEDIA_PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** Strict content-addressed file name — blocks path traversal in `load`. */
export const MEDIA_ID_RE = /^[a-f0-9]{64}\.(jpg|png|webp)$/;
/** Names the store has ever produced (incl. legacy gif) — prune ownership only. */
const OWNED_MEDIA_FILE_RE = /^[a-f0-9]{64}\.(jpg|png|webp|gif)$/;
/** In-flight `save()` temp file name (`<id>.<pid>.<random>.tmp`) — owned by the store. */
const OWNED_MEDIA_TMP_RE = /^[a-f0-9]{64}\.(jpg|png|webp|gif)\.\d+\.[a-z0-9]+\.tmp$/;

const MIME_EXT: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

const EXT_MIME: Record<string, string> = {
  jpg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
};

// ══════════════════════════════════════════════════════════════════════════
// Types
// ══════════════════════════════════════════════════════════════════════════
/** Raw image bytes coming from the transport (before they are stored). */
export interface ImageInput {
  data: Uint8Array;
  mediaType: string;
  width?: number;
  height?: number;
}

/** Image bytes read back from disk for the model. */
export interface LoadedImage {
  data: Uint8Array;
  mediaType: string;
}

/** History entry shaped for the orchestrator (text + optional image parts). */
export interface AgentMessage {
  role: MessageRole;
  text: string;
  images?: LoadedImage[];
}

export interface HydrateOptions {
  /** How many of the latest user messages may contribute images. */
  maxMessages?: number;
  /** Max images across the hydrated history. */
  maxImages?: number;
  /** Max total bytes across the hydrated history. */
  maxBytes?: number;
}

/** Lowercase a MIME type and drop parameters (`image/jpeg; charset=x` → `image/jpeg`). */
function normalizeMime(mime: string): string {
  return mime.split(";")[0]!.trim().toLowerCase();
}

/** Recursively list files under `dir` (best-effort: missing dir → empty). */
async function listFiles(dir: string): Promise<string[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const entry of entries) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await listFiles(abs)));
    else if (entry.isFile()) out.push(abs);
  }
  return out;
}

/** True when a path was produced by this store (image blob or its temp write). */
function isOwnedMediaFile(path: string): boolean {
  const name = basename(path);
  return OWNED_MEDIA_FILE_RE.test(name) || OWNED_MEDIA_TMP_RE.test(name);
}

/**
 * File-backed image store.
 *
 * Bytes are content-addressed on disk (`<dir>/<sha256[0..2]>/<sha256>.<ext>`);
 * only `{ id, mediaType, width?, height? }` refs are persisted in dialogue
 * history. The service depends only on config/domain/logger — no DB, no content
 * store — so it is trivially testable against a temp dir.
 */
export class MediaService {
  private readonly dir: string;
  private readonly now: () => number;

  constructor(opts: { dir?: string; now?: () => number } = {}) {
    this.dir = opts.dir ?? env.MEDIA_DIR;
    this.now = opts.now ?? Date.now;
  }

  /** Absolute path of a validated media id. Callers must validate first. */
  private pathFor(id: string): string {
    return join(this.dir, id.slice(0, 2), id);
  }

  /**
   * Store one image, deduplicating by sha256. An existing file is not
   * rewritten, but its mtime is refreshed so a re-sent old image survives the
   * retention prune.
   */
  async save(input: ImageInput): Promise<StoredImageRef> {
    const mediaType = normalizeMime(input.mediaType);
    const ext = MIME_EXT[mediaType];
    if (!ext) throw new Error(`unsupported image mime: ${mediaType}`);
    if (input.data.byteLength > MAX_IMAGE_BYTES) {
      throw new Error(`image too large: ${input.data.byteLength} bytes`);
    }

    const hash = createHash("sha256").update(input.data).digest("hex");
    const id = `${hash}.${ext}`;
    const shardDir = join(this.dir, id.slice(0, 2));
    const path = this.pathFor(id);
    await mkdir(shardDir, { recursive: true });

    const existing = await this.statOrNull(path);
    if (existing) {
      const touched = new Date(this.now());
      await utimes(path, touched, touched);
      log.debug(
        { id: hash.slice(0, 12), bytes: input.data.byteLength, mediaType, dedupe: true },
        "image already stored; refreshed mtime",
      );
    } else {
      // Atomic write: temp file in the same dir, then rename.
      const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
      try {
        await writeFile(tmp, input.data, { flag: "wx" });
        await rename(tmp, path);
      } catch (err) {
        await rm(tmp, { force: true }).catch(() => undefined);
        throw err;
      }
      log.debug(
        { id: hash.slice(0, 12), bytes: input.data.byteLength, mediaType, dedupe: false },
        "image stored",
      );
    }

    return {
      id,
      mediaType,
      ...(input.width !== undefined ? { width: input.width } : {}),
      ...(input.height !== undefined ? { height: input.height } : {}),
    };
  }

  /**
   * Store up to `max` images sequentially, preserving input order. A single I/O
   * failure is logged and skipped — one bad file must not fail the whole turn.
   */
  async saveMany(inputs: ImageInput[] | undefined, max = MAX_IMAGES_PER_TURN): Promise<StoredImageRef[]> {
    if (!inputs?.length) return [];
    if (inputs.length > max) {
      log.warn({ provided: inputs.length, max }, "image cap exceeded; dropping extras");
    }
    const refs: StoredImageRef[] = [];
    for (const input of inputs.slice(0, max)) {
      try {
        refs.push(await this.save(input));
      } catch (err) {
        log.warn(
          { err, bytes: input.data?.byteLength, mediaType: input.mediaType },
          "failed to store image; continuing",
        );
      }
    }
    log.debug({ saved: refs.length, provided: inputs.length }, "images saved");
    return refs;
  }

  /** Read one stored image back; `null` when the id is invalid or the file is gone. */
  async load(ref: StoredImageRef): Promise<LoadedImage | null> {
    if (!MEDIA_ID_RE.test(ref.id)) {
      log.warn({ id: ref.id }, "invalid media id rejected");
      return null;
    }
    const path = this.pathFor(ref.id);
    try {
      const data = await readFile(path);
      const ext = ref.id.slice(ref.id.lastIndexOf(".") + 1);
      const mediaType = MIME_EXT[normalizeMime(ref.mediaType)] ? normalizeMime(ref.mediaType) : (EXT_MIME[ext] ?? "image/jpeg");
      return { data: new Uint8Array(data), mediaType };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        log.debug({ id: ref.id }, "image missing on disk");
      } else {
        log.warn({ err, id: ref.id }, "failed to read image");
      }
      return null;
    }
  }

  /**
   * Turn history refs into model-ready image bytes.
   *
   * Only the latest `maxMessages` user messages contribute images, capped by
   * `maxImages` and `maxBytes`; files are `stat`-checked before reading so an
   * oversized image never costs a full read. Message order is preserved.
   */
  async hydrate(messages: Message[], opts: HydrateOptions = {}): Promise<AgentMessage[]> {
    const maxMessages = opts.maxMessages ?? VISION_HISTORY_USER_MESSAGES;
    const maxImages = opts.maxImages ?? VISION_HISTORY_MAX_IMAGES;
    const maxBytes = opts.maxBytes ?? VISION_HISTORY_MAX_BYTES;

    const out: AgentMessage[] = messages.map((m) => ({ role: m.role, text: m.content }));
    let budget = maxBytes;
    let imageCount = 0;
    let contributingMessages = 0;

    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i]!;
      if (message.role !== "user" || !message.images?.length) continue;
      if (contributingMessages >= maxMessages) break;

      const loaded: LoadedImage[] = [];
      for (const ref of message.images) {
        if (imageCount >= maxImages) break;
        const size = await this.sizeOf(ref.id);
        if (size === null) continue;
        if (size > budget) {
          log.debug({ id: ref.id, size, budget }, "image exceeds remaining vision budget; skipped");
          continue;
        }
        const image = await this.load(ref);
        if (!image) continue;
        loaded.push(image);
        budget -= image.data.byteLength;
        imageCount++;
      }

      if (loaded.length > 0) {
        out[i] = { role: message.role, text: message.content, images: loaded };
        contributingMessages++;
      }
    }

    log.debug(
      { messages: messages.length, hydratedImages: imageCount, contributingMessages, bytesLeft: budget },
      "history hydrated",
    );
    return out;
  }

  /**
   * Delete stored images older than `maxAgeDays` (mtime). Best-effort: never
   * throws; returns the number of deleted files.
   *
   * Only files this service owns are touched (a content-addressed image or an
   * in-flight `*.tmp` write). Anything else under `MEDIA_DIR` is left alone and
   * logged — a misconfigured `MEDIA_DIR` (e.g. a shared volume root) must never
   * turn the retention job into a recursive delete of unrelated data.
   */
  async prune(maxAgeDays = MEDIA_RETENTION_DAYS): Promise<number> {
    const startedAt = Date.now();
    const cutoff = this.now() - maxAgeDays * 24 * 60 * 60 * 1000;
    let deleted = 0;
    let skipped = 0;
    try {
      const files = await listFiles(this.dir);
      for (const file of files) {
        if (!isOwnedMediaFile(file)) {
          skipped++;
          continue;
        }
        try {
          const info = await stat(file);
          if (info.mtimeMs < cutoff) {
            await rm(file, { force: true });
            deleted++;
          }
        } catch (err) {
          log.warn({ err, file }, "failed to prune media file");
        }
      }
      if (skipped > 0) {
        log.warn(
          { dir: this.dir, skipped },
          "media prune skipped files it does not own (is MEDIA_DIR pointing at a shared directory?)",
        );
      }
      log.info({ deleted, skipped, ms: Date.now() - startedAt, dir: this.dir }, "media prune finished");
    } catch (err) {
      log.warn({ err, dir: this.dir }, "media prune failed");
    }
    return deleted;
  }

  /** `stat` a path, returning `null` for missing/unreadable entries. */
  private async statOrNull(path: string): Promise<Awaited<ReturnType<typeof stat>> | null> {
    try {
      return await stat(path);
    } catch {
      return null;
    }
  }

  /** Size of a stored image, or `null` when the id/file is unusable. */
  private async sizeOf(id: string): Promise<number | null> {
    if (!MEDIA_ID_RE.test(id)) return null;
    const info = await this.statOrNull(this.pathFor(id));
    return typeof info?.size === "number" ? info.size : null;
  }
}
