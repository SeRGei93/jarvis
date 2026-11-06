import { TelegramReplyError } from "./errors.js";
import { logger } from "../pkg/logger.js";

const log = logger.child({ mod: "tg-files" });

/** Default HTTP timeout for downloading a file from Telegram. */
export const TELEGRAM_FILE_TIMEOUT_MS = 60_000;

interface FetchResponseLike {
  ok: boolean;
  status: number;
  arrayBuffer(): Promise<ArrayBuffer>;
}

/** Minimal `fetch` surface, injectable for tests (no real network). */
export type FetchLike = (url: string, init?: { signal?: AbortSignal }) => Promise<FetchResponseLike>;

/** Minimal grammY `Api` surface — `api.getFile` returns a `File` with `file_path`. */
export interface TelegramFileApi {
  getFile(fileId: string): Promise<{ file_path?: string }>;
}

export interface FetchTelegramFileOptions {
  fetchFn?: FetchLike;
  timeoutMs?: number;
  /** Reject payloads above this size. Defaults to unlimited. */
  maxBytes?: number;
  /** Label used only in debug/warn logs (never the file id or URL). */
  kind?: string;
  /** Override user-facing (Russian) failure messages per call site. */
  messages?: {
    missingPath?: string;
    download?: string;
    tooLarge?: string;
  };
}

const DEFAULT_MISSING_PATH = "Не удалось получить файл. Попробуйте позже.";
const DEFAULT_DOWNLOAD = "Не удалось загрузить файл. Попробуйте позже.";
const DEFAULT_TOO_LARGE = "Файл слишком большой.";

/**
 * Download a file from Telegram: `getFile(file_id)` → `api.telegram.org/file/...`.
 *
 * The bot token is part of the URL, so the URL (and `file_id`) is never logged.
 * Every user-visible failure throws `TelegramReplyError` with a Russian message.
 */
export async function fetchTelegramFile(
  api: TelegramFileApi,
  token: string,
  fileId: string,
  opts: FetchTelegramFileOptions = {},
): Promise<{ data: Uint8Array; filePath: string }> {
  const {
    fetchFn = fetch,
    timeoutMs = TELEGRAM_FILE_TIMEOUT_MS,
    maxBytes = Number.POSITIVE_INFINITY,
    kind = "file",
  } = opts;
  const missingPath = opts.messages?.missingPath ?? DEFAULT_MISSING_PATH;
  const download = opts.messages?.download ?? DEFAULT_DOWNLOAD;

  let file: { file_path?: string };
  try {
    file = await api.getFile(fileId);
  } catch (err) {
    log.warn({ kind, reason: err instanceof Error ? err.message : String(err) }, "telegram getFile failed");
    throw new TelegramReplyError(missingPath);
  }
  if (!file.file_path) {
    log.warn({ kind }, "telegram getFile returned no file_path");
    throw new TelegramReplyError(missingPath);
  }

  const url = `https://api.telegram.org/file/bot${token}/${file.file_path}`;
  let data: Uint8Array;
  try {
    const res = await fetchFn(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) throw new Error(`download status ${res.status}`);
    data = new Uint8Array(await res.arrayBuffer());
  } catch (err) {
    log.warn({ kind, reason: err instanceof Error ? err.message : String(err) }, "telegram file download failed");
    throw new TelegramReplyError(download);
  }

  if (data.byteLength > maxBytes) {
    log.warn({ kind, bytes: data.byteLength, maxBytes }, "telegram file exceeds size limit");
    throw new TelegramReplyError(opts.messages?.tooLarge ?? DEFAULT_TOO_LARGE);
  }

  log.debug({ kind, bytes: data.byteLength }, "telegram file downloaded");
  return { data, filePath: file.file_path };
}
