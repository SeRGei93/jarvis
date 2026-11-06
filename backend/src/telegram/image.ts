import { TelegramReplyError } from "./errors.js";
import { fetchTelegramFile, type FetchLike, type TelegramFileApi } from "./files.js";
import { MAX_IMAGE_BYTES, SUPPORTED_IMAGE_MIMES } from "../services/media-service.js";
import { logger } from "../pkg/logger.js";

const log = logger.child({ mod: "tg-image" });

/** HTTP timeout for downloading an image from Telegram. */
export const IMAGE_DOWNLOAD_TIMEOUT_MS = 60_000;

/** User-facing refusal for a MIME type we cannot feed to a vision model. */
export const UNSUPPORTED_IMAGE_REPLY =
  "Этот формат изображения не поддерживается. Отправьте JPEG, PNG или WebP.";

/** User-facing refusal when an image exceeds {@link MAX_IMAGE_BYTES}. */
export const IMAGE_TOO_LARGE_REPLY = "Изображение слишком большое. Максимум — 10 МБ.";

/** One size variant of a Telegram photo (`message.photo` is smallest → largest). */
export interface PhotoSize {
  file_id: string;
  file_size?: number;
  width: number;
  height: number;
}

export interface DownloadImageOptions {
  fetchFn?: FetchLike;
  /** MIME hint from `document.mime_type` (authoritative when supported). */
  mimeHint?: string;
  maxBytes?: number;
}

const EXT_MIME: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
};

function normalizeMime(mime: string): string {
  return mime.split(";")[0]!.trim().toLowerCase();
}

function isSupportedMime(mime: string | undefined): mime is (typeof SUPPORTED_IMAGE_MIMES)[number] {
  return !!mime && (SUPPORTED_IMAGE_MIMES as readonly string[]).includes(mime);
}

/**
 * Pick the largest photo variant that fits `maxBytes`. Telegram orders
 * `message.photo` from smallest to largest; when every variant is too large we
 * fall back to the last one (Telegram itself compresses photos) and warn.
 */
export function pickLargestPhoto(sizes: PhotoSize[], maxBytes = MAX_IMAGE_BYTES): PhotoSize | undefined {
  if (!sizes?.length) return undefined;
  const fitting = sizes.filter((s) => s.file_size === undefined || s.file_size <= maxBytes);
  if (fitting.length > 0) {
    const chosen = fitting[fitting.length - 1]!;
    log.debug({ variants: sizes.length, bytes: chosen.file_size, width: chosen.width, height: chosen.height }, "photo size picked");
    return chosen;
  }
  const fallback = sizes[sizes.length - 1]!;
  log.warn(
    { variants: sizes.length, bytes: fallback.file_size, maxBytes },
    "all photo variants exceed the limit; using the largest",
  );
  return fallback;
}

/**
 * Infer an image MIME type from a Telegram `file_path`/file name or an explicit
 * MIME hint. Unknown formats (HEIC/AVIF/…) return `undefined`.
 */
export function inferImageMime(filePathOrName?: string, hint?: string): string | undefined {
  const normalizedHint = hint ? normalizeMime(hint) : "";
  if (isSupportedMime(normalizedHint)) return normalizedHint;
  if (!filePathOrName) return undefined;
  const clean = filePathOrName.split("?")[0]!;
  const ext = clean.slice(clean.lastIndexOf(".") + 1).toLowerCase();
  return EXT_MIME[ext];
}

/**
 * Download an image from Telegram and validate it against the supported MIME
 * whitelist and size cap. Throws `TelegramReplyError` on any user-visible issue.
 */
export async function downloadTelegramImage(
  api: TelegramFileApi,
  token: string,
  fileId: string,
  opts: DownloadImageOptions = {},
): Promise<{ data: Uint8Array; mediaType: string }> {
  const maxBytes = opts.maxBytes ?? MAX_IMAGE_BYTES;
  const { data, filePath } = await fetchTelegramFile(api, token, fileId, {
    fetchFn: opts.fetchFn,
    timeoutMs: IMAGE_DOWNLOAD_TIMEOUT_MS,
    maxBytes,
    kind: "image",
    messages: {
      missingPath: "Не удалось получить изображение. Попробуйте позже.",
      download: "Не удалось загрузить изображение. Попробуйте позже.",
      tooLarge: IMAGE_TOO_LARGE_REPLY,
    },
  });

  const mediaType = inferImageMime(filePath, opts.mimeHint);
  if (!mediaType) {
    log.warn({ bytes: data.byteLength }, "unsupported image mime; refusing");
    throw new TelegramReplyError(UNSUPPORTED_IMAGE_REPLY);
  }

  log.debug({ bytes: data.byteLength, mediaType }, "image downloaded");
  return { data, mediaType };
}
