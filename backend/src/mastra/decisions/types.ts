/**
 * Shape of the fast typed-decision layer.
 *
 * A decision model answers *questions* about a *state* (the text we care about)
 * with calibrated probabilities, in one cheap call and no generation. Mastra's
 * `Classifier` maps these to the vendor's System One API; nothing here is
 * specific to a vendor, so tests can drive a fake client.
 */

/** One question for the decision model. */
export type DecisionQuestion =
  | {
      type: "choice";
      instructions?: string;
      /** Option id → short description. **Must be non-empty** (the API 422s on {}). */
      criteria: Readonly<Record<string, string>>;
    }
  | { type: "boolean"; instructions?: string }
  | { type: "score"; instructions?: string; criteria: readonly string[] };

/** An answer, or the model declining to answer. */
export type DecisionAnswer =
  | { type: "choice"; choice: string; probabilities?: Record<string, number> }
  | { type: "boolean"; probability: number }
  | { type: "score"; score: number; probabilities?: Record<string, number> }
  | { type: "refusal" };

export interface DecisionResult {
  answers: Record<string, DecisionAnswer>;
  inputTokens?: number;
}

/**
 * Transport for one decision model. The production implementation is a Mastra
 * `Classifier` over OpenRouter; tests inject a fake.
 */
export interface DecisionClient {
  decide(
    state: string,
    questions: Record<string, DecisionQuestion>,
    opts?: { signal?: AbortSignal },
  ): Promise<DecisionResult>;
}
