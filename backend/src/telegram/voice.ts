import { TelegramReplyError } from "./errors.js";
import { fetchTelegramFile, type FetchLike } from "./files.js";
import { logger } from "../pkg/logger.js";

const log = logger.child({ mod: "tg-voice" });

/** Reject voice messages longer than this (parity with Go handleVoiceMessage). */
export const MAX_VOICE_DURATION_SEC = 30;
/** HTTP timeout for downloading the voice file from Telegram. */
export const VOICE_DOWNLOAD_TIMEOUT_MS = 60_000;
/** Telegram voice notes are OGG/Opus (parity with Go hardcoded mime). */
export const VOICE_MIME = "audio/ogg";

export type { FetchLike } from "./files.js";

/** Minimal grammY `Api` surface — `api.getFile` returns a `File` with `file_path`. */
export interface VoiceApi {
  getFile(fileId: string): Promise<{ file_path?: string }>;
}

/** Minimal speech surface — `SpeechService` satisfies this. */
export interface VoiceTranscriber {
  transcribe(audio: Uint8Array, mimeType: string): Promise<string>;
}

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

  const { data } = await fetchTelegramFile(api, token, fileId, {
    fetchFn,
    timeoutMs: VOICE_DOWNLOAD_TIMEOUT_MS,
    kind: "voice",
    messages: {
      missingPath: "Не удалось получить голосовое сообщение. Попробуйте позже.",
      download: "Не удалось загрузить голосовое сообщение. Попробуйте позже.",
    },
  });

  log.debug({ duration, bytes: data.byteLength }, "voice downloaded; transcribing");
  let text: string;
  try {
    text = (await speech.transcribe(data, VOICE_MIME)).trim();
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
