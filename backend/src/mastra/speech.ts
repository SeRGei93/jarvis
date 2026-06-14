import { generateText, type ModelMessage } from "ai";
import { ModelFactory } from "./models.js";
import { SettingsService } from "../config/settings.js";
import { logger } from "../pkg/logger.js";

const log = logger.child({ mod: "speech" });

const TRANSCRIBE_PROMPT = "Transcribe this voice message. Return ONLY the transcription text, nothing else.";

/** Speech-to-text via a multimodal LLM (settings.speech), parity with Go speech.go. */
export class SpeechService {
  constructor(
    private readonly factory: ModelFactory,
    private readonly settings: SettingsService,
  ) {}

  async transcribe(audio: Uint8Array, mimeType: string): Promise<string> {
    const roles = await this.settings.getModelRoles();
    const ref = roles.speech || roles.default;
    log.debug({ model: ref, mimeType, bytes: audio.byteLength }, "transcribe");
    const messages: ModelMessage[] = [
      {
        role: "user",
        content: [
          { type: "file", data: audio, mediaType: mimeType },
          { type: "text", text: TRANSCRIBE_PROMPT },
        ],
      },
    ];
    const res = await generateText({ model: this.factory.model(ref), messages });
    return res.text.trim();
  }
}
