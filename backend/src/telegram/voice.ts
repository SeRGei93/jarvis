import { TelegramReplyError } from "./errors.js";
import { logger } from "../pkg/logger.js";

const log = logger.child({ mod: "tg-voice" });

/** Reject voice messages longer than this (parity with Go handleVoiceMessage). */
export const MAX_VOICE_DURATION_SEC = 30;
/** HTTP timeout for downloading the voice file from Telegram. */
export const VOICE_DOWNLOAD_TIMEOUT_MS = 60_000;
/** Telegram voice notes are OGG/Opus (parity with Go hardcoded mime). */
export const VOICE_MIME = "audio/ogg";

/** Minimal grammY `Api` surface — `api.getFile` returns a `File` with `file_path`. */
export interface VoiceApi {
  getFile(fileId: string): Promise<{ file_path?: string }>;
}

/** Minimal speech surface — `SpeechService` satisfies this. */
export interface VoiceTranscriber {
  transcribe(audio: Uint8Array, mimeType: string): Promise<string>;
}

interface FetchResponseLike {
  ok: boolean;
  status: number;
  arrayBuffer(): Promise<ArrayBuffer>;
}
export type FetchLike = (url: string, init?: { signal?: AbortSignal }) => Promise<FetchResponseLike>;

/**
 * Download a Telegram voice file and transcribe it to text. Guards duration,
 * downloads with a timeout, and transcribes via the speech service. Throws
 * `TelegramReplyError` (with a Russian user message) on any user-visible failure.
 *
 * The bot token is needed to build the file URL (`getFile` alone is not enough);
 * the URL contains the token, so it is never logged.
 */
export async function transcribeVoice(
  api: VoiceApi,
  speech: VoiceTranscriber,
  token: string,
  fileId: string,
  duration: number,
  fetchFn: FetchLike = fetch,
): Promise<string> {
  if (duration > MAX_VOICE_DURATION_SEC) {
    log.warn({ duration }, "voice rejected (too long)");
    throw new TelegramReplyError("Голосовое сообщение слишком длинное. Максимум — 30 секунд.");
  }

  const file = await api.getFile(fileId);
  if (!file.file_path) {
    log.warn("voice getFile returned no file_path");
    throw new TelegramReplyError("Не удалось получить голосовое сообщение. Попробуйте позже.");
  }

  const url = `https://api.telegram.org/file/bot${token}/${file.file_path}`;
  let buf: Uint8Array;
  try {
    const res = await fetchFn(url, { signal: AbortSignal.timeout(VOICE_DOWNLOAD_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`download status ${res.status}`);
    buf = new Uint8Array(await res.arrayBuffer());
  } catch (err) {
    log.warn({ reason: err instanceof Error ? err.message : String(err) }, "voice download failed");
    throw new TelegramReplyError("Не удалось загрузить голосовое сообщение. Попробуйте позже.");
  }

  log.debug({ duration, bytes: buf.byteLength }, "voice downloaded; transcribing");
  let text: string;
  try {
    text = (await speech.transcribe(buf, VOICE_MIME)).trim();
  } catch (err) {
    log.warn({ reason: err instanceof Error ? err.message : String(err) }, "voice transcription failed");
    throw new TelegramReplyError("Не удалось распознать голосовое сообщение.");
  }

  if (text === "") {
    log.warn("voice transcription empty");
    throw new TelegramReplyError("Не удалось распознать голосовое сообщение.");
  }
  return text;
}
