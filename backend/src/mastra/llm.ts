import { streamText, generateText, stepCountIs, type ModelMessage, type ToolSet } from "ai";
import type { Message } from "../domain/entities.js";
import { ModelFactory, parseModelRef } from "./models.js";
import { stripLeakedToolCalls } from "./strip-leaked-tools.js";
import { SettingsService, parseGoDuration } from "../config/settings.js";
import { logger } from "../pkg/logger.js";

const log = logger.child({ mod: "llm" });

/** Max tool-call turns per call — parity with Go's WithMaxTurns(30). */
export const MAX_STEPS = 30;
/** Non-stream attempts: 1 with the original model + retries on the fallback model. */
export const MAX_RETRIES = 3;
const DEFAULT_ACTIVITY_MS = 30_000;
const DEFAULT_REQUEST_MS = 300_000;

export interface LlmCallOptions {
  /** `provider:model` ref. */
  model: string;
  system?: string;
  messages: Message[];
  tools?: ToolSet;
  temperature?: number | null;
  reasoning?: boolean | null;
}

export interface LlmResult {
  text: string;
  usage?: unknown;
  /** OpenRouter cost in USD, if reported. */
  cost?: number;
  finishReason?: string;
}

export type StreamCallback = (accumulatedText: string) => void;

/**
 * Tool-activity callbacks for surfacing live "🔎 ищу… / 💱 конвертирую…" statuses
 * while the agent runs tools. Emitted from the orchestrator's `fullStream` loop;
 * the Telegram layer maps tool names to friendly status lines (B2).
 */
export interface ToolEvents {
  onStart?: (toolName: string) => void;
  onFinish?: (toolName: string) => void;
}

function toModelMessages(messages: Message[]): ModelMessage[] {
  return messages.map((m) => ({ role: m.role, content: m.content })) as ModelMessage[];
}

/** Map a tri-state `reasoning` flag to provider-specific providerOptions (Go parity). */
export function reasoningProviderOptions(
  ref: string,
  reasoning?: boolean | null,
): Record<string, { reasoning: { enabled: boolean } }> | undefined {
  if (reasoning == null) return undefined;
  const { provider } = parseModelRef(ref);
  return { [provider]: { reasoning: { enabled: reasoning } } };
}

/** Extract OpenRouter request cost (USD) from AI SDK provider metadata, if present. */
export function extractCost(meta: unknown): number | undefined {
  const or = (meta as { openrouter?: { usage?: { cost?: unknown }; cost?: unknown } } | undefined)?.openrouter;
  const c = or?.usage?.cost ?? or?.cost;
  return typeof c === "number" ? c : undefined;
}

function errString(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Append a user note listing unique prior errors so the model can self-correct (Go parity). */
export function buildRetryMessages(messages: Message[], errors: string[]): Message[] {
  if (errors.length === 0) return messages;
  const note = `Previous attempt(s) failed with: ${errors.join("; ")}. Please try again and return a correct response.`;
  return [...messages, { role: "user", content: note }];
}

interface Watchdog {
  reset(): void;
  clear(): void;
  readonly fired: boolean;
}

/** Abort the call if no chunk arrives within `ms` (reset on every chunk). */
export function startWatchdog(controller: AbortController, ms: number): Watchdog {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let fired = false;
  const arm = () => {
    timer = setTimeout(() => {
      fired = true;
      log.warn({ idleMs: ms }, "watchdog fired (idle)");
      controller.abort(new Error("watchdog: idle timeout"));
    }, ms);
  };
  arm();
  return {
    reset() {
      if (fired) return;
      if (timer) clearTimeout(timer);
      arm();
    },
    clear() {
      if (timer) clearTimeout(timer);
    },
    get fired() {
      return fired;
    },
  };
}

/**
 * Thin wrapper over AI SDK streamText/generateText with parity to Go's LLMAdapter:
 * idle watchdog (llm_activity), overall timeout (llm_request), cost extraction,
 * and temperature/reasoning/maxSteps plumbing.
 */
export class LlmService {
  constructor(
    private readonly factory: ModelFactory,
    private readonly settings: SettingsService,
  ) {}

  private async timeouts(): Promise<{ activityMs: number; overallMs: number }> {
    const t = await this.settings.getTimeouts();
    return {
      activityMs: parseGoDuration(t.llm_activity) || DEFAULT_ACTIVITY_MS,
      overallMs: parseGoDuration(t.llm_request) || DEFAULT_REQUEST_MS,
    };
  }

  private baseParams(opts: LlmCallOptions) {
    const po = reasoningProviderOptions(opts.model, opts.reasoning);
    return {
      model: this.factory.model(opts.model),
      system: opts.system,
      messages: toModelMessages(opts.messages),
      ...(opts.temperature != null ? { temperature: opts.temperature } : {}),
      ...(opts.tools ? { tools: opts.tools, stopWhen: stepCountIs(MAX_STEPS) } : {}),
      ...(po ? { providerOptions: po } : {}),
    };
  }

  /** Streamed generation with a single non-stream fallback on failure (Go parity). */
  async stream(opts: LlmCallOptions, onText?: StreamCallback): Promise<LlmResult> {
    try {
      return await this.streamOnce(opts, onText);
    } catch (err) {
      log.warn({ reason: errString(err) }, "stream failed -> single non-stream fallback (original model)");
      return await this.generateOnce(opts);
    }
  }

  /** Non-streamed generation: retry up to MAX_RETRIES, switching to the fallback model. */
  async generate(opts: LlmCallOptions): Promise<LlmResult> {
    const fallback = await this.fallbackModel();
    const errors: string[] = [];
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      const callOpts: LlmCallOptions =
        attempt === 1
          ? opts
          : { ...opts, model: fallback, messages: buildRetryMessages(opts.messages, errors) };
      try {
        return await this.generateOnce(callOpts);
      } catch (err) {
        const msg = errString(err);
        if (!errors.includes(msg)) errors.push(msg);
        const canRetry = attempt < MAX_RETRIES && fallback.length > 0;
        log.warn({ attempt, model: callOpts.model, willRetry: canRetry, reason: msg }, "llm attempt failed");
        if (!canRetry) {
          log.error({ errors }, "llm failed (no fallback model or retries exhausted)");
          throw err;
        }
      }
    }
    throw new Error("unreachable");
  }

  /** error_correction_model ref (used as the retry/fallback model), or "" if unset. */
  private async fallbackModel(): Promise<string> {
    const roles = await this.settings.getModelRoles();
    return roles.error_correction ?? "";
  }

  /** Single streamed attempt (no retry). `onText` receives ACCUMULATED text. */
  private async streamOnce(opts: LlmCallOptions, onText?: StreamCallback): Promise<LlmResult> {
    const { activityMs, overallMs } = await this.timeouts();
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(overallMs)]);
    const wd = startWatchdog(controller, activityMs);
    log.debug({ model: opts.model, stream: true, reasoning: opts.reasoning, temperature: opts.temperature }, "llm stream start");
    try {
      const res = streamText({ ...this.baseParams(opts), abortSignal: signal, onChunk: () => wd.reset() });
      let acc = "";
      for await (const delta of res.textStream) {
        acc += delta;
        onText?.(acc);
      }
      const [usage, providerMetadata, finishReason] = await Promise.all([
        res.usage,
        res.providerMetadata,
        res.finishReason,
      ]);
      const cost = extractCost(providerMetadata);
      // Stream: strip leaked tool-calls silently (can't retry mid-stream).
      const { text: cleaned } = stripLeakedToolCalls(acc);
      if (!cleaned) throw new Error("empty response after stripping leaked tool-calls");
      log.info({ model: opts.model, cost, finishReason }, "llm stream done");
      return { text: cleaned, usage, cost, finishReason };
    } finally {
      wd.clear();
    }
  }

  /** Single non-streamed attempt (no retry, overall timeout only). */
  private async generateOnce(opts: LlmCallOptions): Promise<LlmResult> {
    const { overallMs } = await this.timeouts();
    log.debug({ model: opts.model, stream: false, reasoning: opts.reasoning }, "llm generate start");
    const res = await generateText({ ...this.baseParams(opts), abortSignal: AbortSignal.timeout(overallMs) });
    const cost = extractCost(res.providerMetadata);
    // Non-stream: if tool-calls leaked into the text, error out so generate() retries
    // with the error fed back to the model (Go parity).
    const { text: cleaned, stripped } = stripLeakedToolCalls(res.text);
    if (stripped > 0) throw new Error(`model leaked ${stripped} tool-call(s) into text output`);
    log.info({ model: opts.model, cost, finishReason: res.finishReason }, "llm generate done");
    return { text: cleaned, usage: res.usage, cost, finishReason: res.finishReason };
  }
}
