import type { StreamCallback } from "../llm.js";
import { LlmService } from "../llm.js";
import type { Message, User, BotIdentity } from "../../domain/entities.js";
import type { StoredMemory } from "../memory/memory-service.js";
import { buildSynthesizerPrompt } from "./prompt-builder.js";
import { logger } from "../../pkg/logger.js";

const log = logger.child({ mod: "synthesizer" });

/** Synthesizer temperature — hardcoded in Go (handle_message.go), no tools. */
export const SYNTHESIZER_TEMPERATURE = 0.3;

export interface SynthesizeContext {
  user: User | null;
  identity: BotIdentity | null;
  memories: StoredMemory[];
  prompts: { soul: string; format: string; synthesizer: string };
  /** Recent history BEFORE the current turn (current message appended internally). */
  history: Message[];
  userMessage: string;
  /** roles.synthesizer — preferred model. */
  synthesizerModel: string;
  /** session.model — fallback when no synthesizer role is configured (Go parity). */
  sessionModel: string;
}

/**
 * Combine multiple skill results into one user-facing reply and stream it.
 * Model = synthesizer_model || session.model; temperature 0.3; no tools.
 * Parity with Go handle_message.go prepareMultiSkill/executeMultiSkillStream.
 */
/** Synthesizer answer plus the LLM cost it incurred (for usage accounting, M5). */
export interface SynthesizeResult {
  text: string;
  cost: number;
}

export async function synthesize(
  llm: LlmService,
  skillResults: Record<string, string>,
  ctx: SynthesizeContext,
  onText?: StreamCallback,
): Promise<SynthesizeResult> {
  const usingRole = ctx.synthesizerModel.length > 0;
  const model = usingRole ? ctx.synthesizerModel : ctx.sessionModel;

  const system = buildSynthesizerPrompt({
    prompts: ctx.prompts,
    user: ctx.user,
    memories: ctx.memories,
    identity: ctx.identity,
    skillResults,
  });
  const messages: Message[] = [...ctx.history, { role: "user", content: ctx.userMessage }];

  log.debug(
    { model, source: usingRole ? "synthesizer_role" : "session_model", skills: Object.keys(skillResults) },
    "synthesize start",
  );
  const res = await llm.stream(
    { model, system, messages, temperature: SYNTHESIZER_TEMPERATURE, reasoning: null },
    onText,
  );
  log.debug({ model, cost: res.cost, finishReason: res.finishReason }, "synthesize done");
  return { text: res.text, cost: res.cost ?? 0 };
}
