/**
 * Deterministic, offline scorers for the B4 eval harness.
 *
 * All three are pure `generateScore` functions — NO judge, NO model, NO network
 * — so they run for free inside the blocking `npm test` suite as a routing /
 * dedup / summary regression net. The LLM-judge counterparts live in the
 * separate non-blocking `nightly.ts` scaffold.
 *
 * The Mastra scorer contract (pinned to @mastra/core 1.42.0, validated by
 * `scorer-smoke.test.ts`): `createScorer({id,name,description}).generateScore(
 * ({run}) => number).run({input, output, groundTruth})` resolves to a result
 * whose `.score` is the returned number.
 */
import { createScorer } from "@mastra/core/evals";

/** Lowercase, split on non-alphanumeric (Unicode-aware) into a unique token set. */
function tokenSet(text: string): Set<string> {
  const tokens = text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length > 0);
  return new Set(tokens);
}

/**
 * Routing gate: 1.0 when the chosen primary skill (`output`) equals the expected
 * skill (`groundTruth`), else 0.0. Mirrors the deterministic comparison in the
 * A3 pre-pass — it does NOT call the real classifier. Reuses the S2 pattern.
 */
export const primarySkillChoice = createScorer({
  id: "primary-skill-choice",
  name: "primary-skill-choice",
  description: "1.0 when the chosen primary skill equals the expected skill, else 0.0.",
}).generateScore(({ run }) => (run.output === run.groundTruth ? 1 : 0));

/**
 * Keyword coverage: fraction of `groundTruth` keywords (a string array) that
 * appear (case-insensitive substring) in `output` (a string). Empty keyword
 * list scores 1.0 (vacuously covered). Used for dedup/summary keyword checks.
 */
export const keywordCoverage = createScorer<string[], string>({
  id: "keyword-coverage",
  name: "keyword-coverage",
  description: "Fraction of groundTruth keywords present (case-insensitive) in the output string.",
}).generateScore(({ run }) => {
  const keywords = run.groundTruth ?? [];
  if (keywords.length === 0) return 1;
  const haystack = (run.output ?? "").toLowerCase();
  const hits = keywords.filter((kw) => haystack.includes(kw.toLowerCase())).length;
  return hits / keywords.length;
});

/**
 * Content similarity: token Jaccard similarity between `output` and `groundTruth`
 * strings (|A ∩ B| / |A ∪ B|), in [0, 1]. Two empty strings score 1.0. Used for
 * dedup/summary similarity checks (e.g. "is this memory a near-duplicate?").
 */
export const contentSimilarity = createScorer<string, string>({
  id: "content-similarity",
  name: "content-similarity",
  description: "Token Jaccard similarity (0..1) between the output and groundTruth strings.",
}).generateScore(({ run }) => {
  const a = tokenSet(run.output ?? "");
  const b = tokenSet(run.groundTruth ?? "");
  if (a.size === 0 && b.size === 0) return 1;
  let intersection = 0;
  for (const token of a) if (b.has(token)) intersection += 1;
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
});
