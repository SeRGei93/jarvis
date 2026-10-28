/**
 * Decision service — fast typed decisions before the agent.
 *
 * One cheap System One call answers "which skill?", "is this a duplicate?",
 * "is this a session or a permanent fact?" with calibrated probabilities, which
 * is much faster and cheaper than a generative round-trip. The whole layer is
 * **best-effort**: every failure (no role configured, unsupported provider,
 * network error, refusal, malformed answer, timeout) returns `null` and the
 * caller keeps its existing LLM/keyword path. An empty `model_roles.decision`
 * turns the layer off entirely.
 *
 * Transport: Mastra `Classifier` → `@ai-sdk/typesafe-ai` → OpenRouter's
 * `POST /api/v1/systemone` (same OPENROUTER_API_KEY as everything else). Verified
 * live on ai@6 — see the plan's spike #1a.
 */
import { Classifier, type ClassifierQuestion } from "@mastra/core/classifier";
import { createTypeSafeAi } from "@ai-sdk/typesafe-ai";
import type { SettingsService } from "../../config/settings.js";
import { env } from "../../config/env.js";
import { logger } from "../../pkg/logger.js";
import { timeoutFetch } from "../../pkg/timeout-fetch.js";
import type {
  DecisionAnswer,
  DecisionClient,
  DecisionQuestion,
  DecisionResult,
} from "./types.js";

const log = logger.child({ mod: "decisions" });

/** Per-call budget. A decision is expected in tens of ms; 10 s is already generous. */
export const DECISION_TIMEOUT_MS = 10_000;
/** Above ~32 KB the vendor switches to a slower, less accurate long-context mode. */
export const MAX_STATE_CHARS = 20_000;
/** OpenRouter's System One endpoint (the one the provider targets by default). */
const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
const OPENROUTER_PREFIX = "openrouter:";

/** Strip the `openrouter:` role prefix the provider does not expect. */
export function stripProviderPrefix(ref: string): string {
  return ref.startsWith(OPENROUTER_PREFIX) ? ref.slice(OPENROUTER_PREFIX.length) : ref;
}

/**
 * Build the production client for one model ref.
 *
 * The model id is passed verbatim to `decisionModel()` — the curated list in
 * `services/models-catalog.ts` already uses OpenRouter's naming (`cloudflare/clef`,
 * `~perplexity/pplx-decider-latest`, …). `maxRetries: 1` overrides the Classifier
 * default of 2: retrying a cheap-but-failed decision twice is pure double spend.
 */
export function createClassifierClient(
  modelRef: string,
  opts: { apiKey?: string; baseUrl?: string } = {},
): DecisionClient {
  const modelId = stripProviderPrefix(modelRef);
  const provider = createTypeSafeAi({
    apiKey: opts.apiKey ?? env.OPENROUTER_API_KEY ?? "",
    baseURL: opts.baseUrl ?? OPENROUTER_BASE_URL,
    fetch: timeoutFetch(DECISION_TIMEOUT_MS),
  });
  const model = provider.decisionModel(modelId as never);

  return {
    async decide(state, questions, callOpts = {}): Promise<DecisionResult> {
      const classifier = new Classifier({
        id: `jarvis-decision:${modelId}`,
        model,
        questions: questions as Record<string, ClassifierQuestion>,
      });
      const res = await classifier.decide({
        state,
        maxRetries: 1,
        abortSignal: callOpts.signal,
      });
      return {
        answers: res.answers as unknown as Record<string, DecisionAnswer>,
        inputTokens: res.usage?.inputTokens,
      };
    },
  };
}

export interface DecisionServiceOptions {
  /** Fake client for tests (bypasses the model ref entirely). */
  client?: DecisionClient;
  /** Client factory override (tests/spikes); defaults to {@link createClassifierClient}. */
  factory?: (modelRef: string) => DecisionClient;
  apiKey?: string;
  timeoutMs?: number;
}

/**
 * Thin, null-safe facade over one decision model. Instances are cheap; the
 * underlying client is memoised per model ref so the admin can switch models at
 * runtime without a restart.
 */
export class DecisionService {
  private client: DecisionClient | null = null;
  private clientRef: string | null = null;

  constructor(
    private readonly settings: SettingsService,
    private readonly opts: DecisionServiceOptions = {},
  ) {}

  /** Configured model ref (`openrouter:…`), or "" when the layer is off. */
  async modelRef(): Promise<string> {
    const roles = await this.settings.getModelRoles();
    return (roles.decision ?? "").trim();
  }

  async isEnabled(): Promise<boolean> {
    return (await this.modelRef()) !== "";
  }

  /**
   * Pick one option out of `criteria` (`id → description`).
   * Returns `null` when the layer is off, the criteria are empty, or anything fails.
   */
  async choose(
    state: string,
    instructions: string,
    criteria: Record<string, string>,
  ): Promise<{ choice: string; probabilities?: Record<string, number> } | null> {
    if (Object.keys(criteria).length === 0) return null; // the API rejects empty criteria
    const answer = await this.ask(state, { type: "choice", instructions, criteria });
    if (!answer || answer.type !== "choice") return null;
    if (!Object.prototype.hasOwnProperty.call(criteria, answer.choice)) {
      log.warn({ choice: answer.choice }, "decision returned an option outside the criteria");
      return null;
    }
    return { choice: answer.choice, probabilities: answer.probabilities };
  }

  /**
   * Ask a yes/no question; returns **P(yes)** in `[0, 1]`.
   * Returns `null` when the layer is off or anything fails.
   */
  async judge(state: string, instructions: string): Promise<number | null> {
    const answer = await this.ask(state, { type: "boolean", instructions });
    if (!answer || answer.type !== "boolean") return null;
    return typeof answer.probability === "number" ? answer.probability : null;
  }

  /**
   * Core call: one question, one state, every failure converted to `null`.
   * Never throws — callers rely on this to keep their fallback path simple.
   */
  async ask(state: string, question: DecisionQuestion): Promise<DecisionAnswer | null> {
    const ref = await this.modelRef();
    if (!ref) {
      log.debug("decision layer off (empty model_roles.decision)");
      return null;
    }
    if (!ref.startsWith(OPENROUTER_PREFIX)) {
      log.warn({ ref }, "decision model must be an openrouter: ref — falling back");
      return null;
    }

    const client = this.clientFor(ref);
    if (!client) return null;

    const timeoutMs = this.opts.timeoutMs ?? DECISION_TIMEOUT_MS;
    const trimmed = state.length > MAX_STATE_CHARS ? state.slice(0, MAX_STATE_CHARS) : state;

    try {
      const res = await client.decide(trimmed, { q: question }, {
        signal: AbortSignal.timeout(timeoutMs),
      });
      const answer = res.answers.q;
      if (!answer || answer.type === "refusal") {
        log.warn({ model: ref }, "decision model refused or returned no answer — falling back");
        return null;
      }
      log.debug({ model: ref, type: answer.type, inputTokens: res.inputTokens }, "decision answered");
      return answer;
    } catch (err) {
      log.warn(
        { model: ref, err: err instanceof Error ? err.message : String(err) },
        "decision call failed — falling back",
      );
      return null;
    }
  }

  private clientFor(ref: string): DecisionClient | null {
    if (this.opts.client) return this.opts.client;
    if (this.client && this.clientRef === ref) return this.client;
    try {
      const client = this.opts.factory
        ? this.opts.factory(ref)
        : createClassifierClient(ref, { apiKey: this.opts.apiKey });
      this.client = client;
      this.clientRef = ref;
      log.info({ model: ref }, "decision client ready");
      return client;
    } catch (err) {
      log.warn(
        { model: ref, err: err instanceof Error ? err.message : String(err) },
        "could not build the decision client — falling back",
      );
      return null;
    }
  }
}

/** `session` vs `permanent` for a plain fact (the keyword classifier stays the fallback). */
const SCOPE_CRITERIA: Record<string, string> = {
  permanent:
    "долговременный факт о пользователе: профиль, биография, устойчивые предпочтения и привычки",
  session:
    "деталь текущей беседы или задачи, актуальная только сейчас (временный контекст, разовая просьба)",
};

/**
 * Adapt the decision layer to `MemoryService`'s optional scope hook. Returns
 * `null` (→ keyword classifier) whenever the layer is off or unsure.
 */
export function createScopeDecider(
  decisions: DecisionService,
): (category: string, content: string) => Promise<"session" | "permanent" | null> {
  return async (category, content) => {
    const picked = await decisions.choose(
      `Факт о пользователе: ${content}`,
      "Этот факт стоит помнить постоянно или он относится только к текущей сессии?",
      SCOPE_CRITERIA,
    );
    if (!picked) return null;
    if (picked.choice === "permanent" || picked.choice === "session") return picked.choice;
    log.warn({ category, choice: picked.choice }, "scope decision returned an unexpected option");
    return null;
  };
}
