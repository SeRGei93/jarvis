/**
 * NON-BLOCKING nightly LLM-judge eval scaffold (B4).
 *
 * This file is intentionally NOT a `*.test.ts`, so vitest's `include`
 * (`test/**\/*.test.ts`) never picks it up and it is excluded from the blocking
 * `npm test` / `npm run eval` gate. It is a SEPARATE nightly job: judge-backed
 * scorers (answer-relevancy, faithfulness, …) are subjective and cost tokens, so
 * they must not gate PRs alongside the deterministic scorers in `scorers.ts`.
 *
 * Wiring (when a nightly runner is added — a cron/CI job, not vitest):
 *  - Resolve a judge model through `ModelFactory` (`provider:model`), same as the
 *    rest of the app — no hard-wired client.
 *  - Build judge scorers with `createScorer({ id, name, description, judge:
 *    { model, instructions } })` and an `.generateScore(...)` mapping.
 *  - `ModelFactory` is imported as a TYPE only and the judge model is built
 *    LAZILY inside `runNightlyEvals`, so merely importing this module touches no
 *    network and needs no API key.
 *
 * `runNightlyEvals()` is exported but NEVER auto-executed here.
 */
import { createScorer } from "@mastra/core/evals";
import type { LanguageModel } from "ai";
import type { ModelFactory } from "../../src/mastra/models.js";
import { ROUTING_FIXTURES, type RoutingFixture } from "./fixtures.js";

/** One judged result for nightly reporting (no thresholds gate the suite). */
export interface NightlyEvalResult {
  fixtureId: string;
  scorer: string;
  score: number;
}

/** Inputs for the nightly run: a factory + the judge model role to resolve. */
export interface NightlyEvalOptions {
  /** Injected so the nightly job stays as testable/offline-friendly as the app. */
  factory: ModelFactory;
  /** `provider:model` ref for the judge (e.g. a cheap roles.router-tier model). */
  judgeModelRef: string;
  /** Optional corpus override; defaults to the shared routing fixtures. */
  fixtures?: readonly RoutingFixture[];
}

/**
 * Build an answer-relevancy judge scorer. The judge model is supplied by the
 * caller (resolved via `ModelFactory`), keeping this module model-agnostic.
 *
 * NOTE: this is a SCAFFOLD — the exact judge contract / response shape should be
 * pinned against @mastra/core before the nightly job is enabled, the same way
 * `scorer-smoke.test.ts` pinned the deterministic `.run()` shape.
 */
function buildAnswerRelevancyScorer(model: LanguageModel) {
  return createScorer({
    id: "answer-relevancy",
    name: "answer-relevancy",
    description: "LLM-judged relevance of the assistant answer to the user message (nightly only).",
    judge: {
      model,
      instructions:
        "You are a strict evaluator. Rate how relevant the assistant's answer is " +
        "to the user's message on a 0..1 scale. Penalize off-topic or hallucinated content.",
    },
  });
}

/**
 * Run the nightly LLM-judge evals. Lazily resolves the judge model via the
 * injected `ModelFactory` (so importing this file hits no network) and would
 * iterate the corpus, scoring each case with judge-backed scorers.
 *
 * Left as a scaffold: it wires the judge model and corpus but does not perform
 * judge calls, so it is safe to import. A future nightly runner fills in the
 * per-fixture judge invocation and result collection.
 */
export async function runNightlyEvals(opts: NightlyEvalOptions): Promise<NightlyEvalResult[]> {
  const fixtures = opts.fixtures ?? ROUTING_FIXTURES;
  // Lazy: the model (and any network/key requirement) is only touched here, not
  // at import time. A real nightly runner would loop `fixtures` and call the
  // judge scorer's `.run(...)`, collecting `NightlyEvalResult`s for reporting.
  const judgeModel = opts.factory.model(opts.judgeModelRef);
  buildAnswerRelevancyScorer(judgeModel);
  void fixtures;
  throw new Error(
    "runNightlyEvals is a non-blocking scaffold: wire the nightly job (judge .run + result collection) before enabling.",
  );
}
