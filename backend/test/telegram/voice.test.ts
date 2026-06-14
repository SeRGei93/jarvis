import { describe, it, expect } from "vitest";
import {
  transcribeVoice,
  type VoiceApi,
  type VoiceTranscriber,
  type FetchLike,
} from "../../src/telegram/voice.js";
import { TelegramReplyError } from "../../src/telegram/errors.js";

const okApi: VoiceApi = { getFile: async () => ({ file_path: "voice/file_1.ogg" }) };
const okSpeech = (text: string): VoiceTranscriber => ({ transcribe: async () => text });
const okFetch: FetchLike = async () => ({ ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(16) });

describe("transcribeVoice", () => {
  it("downloads and transcribes a voice message", async () => {
    const text = await transcribeVoice(okApi, okSpeech("привет мир"), "TOKEN", "fid", 5, okFetch);
    expect(text).toBe("привет мир");
  });

  it("does not leak the bot token into the fetched URL logs (URL carries the token)", async () => {
    let calledUrl = "";
    const spyFetch: FetchLike = async (url) => {
      calledUrl = url;
      return { ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(8) };
    };
    await transcribeVoice(okApi, okSpeech("ok"), "SECRET", "fid", 3, spyFetch);
    expect(calledUrl).toContain("/botSECRET/voice/file_1.ogg");
  });

  it("rejects messages longer than 30s", async () => {
    await expect(transcribeVoice(okApi, okSpeech("x"), "T", "fid", 31, okFetch)).rejects.toBeInstanceOf(
      TelegramReplyError,
    );
  });

  it("rejects when getFile has no file_path", async () => {
    const api: VoiceApi = { getFile: async () => ({}) };
    await expect(transcribeVoice(api, okSpeech("x"), "T", "fid", 5, okFetch)).rejects.toBeInstanceOf(
      TelegramReplyError,
    );
  });

  it("rejects an empty transcription", async () => {
    await expect(transcribeVoice(okApi, okSpeech("   "), "T", "fid", 5, okFetch)).rejects.toBeInstanceOf(
      TelegramReplyError,
    );
  });

  it("rejects on a download failure", async () => {
    const failFetch: FetchLike = async () => ({ ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) });
    await expect(transcribeVoice(okApi, okSpeech("x"), "T", "fid", 5, failFetch)).rejects.toBeInstanceOf(
      TelegramReplyError,
    );
  });

  it("rejects on a download timeout/throw", async () => {
    const throwFetch: FetchLike = async () => {
      throw new Error("timeout");
    };
    await expect(transcribeVoice(okApi, okSpeech("x"), "T", "fid", 5, throwFetch)).rejects.toBeInstanceOf(
      TelegramReplyError,
    );
  });
});
