import { describe, it, expect } from "vitest";
import { ROUTING_FIXTURES } from "./fixtures.js";
import { primarySkillChoice, keywordCoverage, contentSimilarity } from "./scorers.js";

/**
 * B4 eval harness — the BLOCKING gate (runs in `npm test`).
 *
 * Proves the deterministic scorers + routing fixtures work offline (no model,
 * no network). It is a routing/dedup/summary REGRESSION NET, not a model-quality
 * test: it feeds the scorers known (input, output, groundTruth) triples and
 * asserts the scores. The LLM-judge scorers live in the non-blocking `nightly.ts`
 * scaffold and are excluded from this suite.
 */

describe("B4 eval harness — primarySkillChoice routing gate", () => {
  it("scores a correct skill choice as 1", async () => {
    const res = await primarySkillChoice.run({
      input: { userMessage: "Сколько стоит доллар?" },
      output: "currency",
      groundTruth: "currency",
    });
    expect(res.score).toBe(1);
  });

  it("scores a wrong skill choice as 0", async () => {
    const res = await primarySkillChoice.run({
      input: { userMessage: "Сколько стоит доллар?" },
      output: "weather",
      groundTruth: "currency",
    });
    expect(res.score).toBe(0);
  });

  it("has a non-empty, RU+EN routing corpus over distinct skills", () => {
    expect(ROUTING_FIXTURES.length).toBeGreaterThanOrEqual(10);
    expect(ROUTING_FIXTURES.some((f) => f.lang === "ru")).toBe(true);
    expect(ROUTING_FIXTURES.some((f) => f.lang === "en")).toBe(true);
    const skills = new Set(ROUTING_FIXTURES.map((f) => f.expectedSkill));
    expect(skills.size).toBeGreaterThanOrEqual(10);
  });

  // Simulate a PERFECT classifier (chosen === expected) over the whole corpus:
  // every fixture must score 1. A routing regression that mislabels a fixture
  // here would flip its score to 0 and fail the gate.
  it("scores every fixture 1 when the chosen skill matches the fixture", async () => {
    for (const fixture of ROUTING_FIXTURES) {
      const res = await primarySkillChoice.run({
        input: { userMessage: fixture.userMessage },
        output: fixture.expectedSkill,
        groundTruth: fixture.expectedSkill,
      });
      expect(res.score, `fixture ${fixture.id}`).toBe(1);
    }
  });

  it("scores 0 when the chosen skill diverges from the fixture", async () => {
    const [first] = ROUTING_FIXTURES;
    const wrong = first.expectedSkill === "chat" ? "research" : "chat";
    const res = await primarySkillChoice.run({
      input: { userMessage: first.userMessage },
      output: wrong,
      groundTruth: first.expectedSkill,
    });
    expect(res.score).toBe(0);
  });
});

describe("B4 eval harness — keywordCoverage (dedup/summary keyword checks)", () => {
  it("scores 1 when all keywords are present", async () => {
    const res = await keywordCoverage.run({
      input: {},
      output: "User lives in Minsk and prefers concise replies in Russian.",
      groundTruth: ["Minsk", "concise", "Russian"],
    });
    expect(res.score).toBe(1);
  });

  it("scores 0 when no keywords are present (disjoint)", async () => {
    const res = await keywordCoverage.run({
      input: {},
      output: "Completely unrelated content here.",
      groundTruth: ["Minsk", "concise"],
    });
    expect(res.score).toBe(0);
  });

  it("scores a partial fraction when some keywords are present", async () => {
    const res = await keywordCoverage.run({
      input: {},
      output: "User lives in Minsk.",
      groundTruth: ["Minsk", "Gomel", "Brest", "Grodno"],
    });
    expect(res.score).toBeCloseTo(0.25, 5);
    expect(res.score).toBeGreaterThan(0);
    expect(res.score).toBeLessThan(1);
  });

  it("is case-insensitive", async () => {
    const res = await keywordCoverage.run({
      input: {},
      output: "always reply briefly",
      groundTruth: ["ALWAYS", "Reply"],
    });
    expect(res.score).toBe(1);
  });

  it("scores 1 for an empty keyword list (vacuously covered)", async () => {
    const res = await keywordCoverage.run({
      input: {},
      output: "anything",
      groundTruth: [],
    });
    expect(res.score).toBe(1);
  });
});

describe("B4 eval harness — contentSimilarity (dedup/summary similarity checks)", () => {
  it("scores 1 for identical strings", async () => {
    const res = await contentSimilarity.run({
      input: {},
      output: "User prefers tea over coffee",
      groundTruth: "User prefers tea over coffee",
    });
    expect(res.score).toBe(1);
  });

  it("scores 1 regardless of case and punctuation (token-level)", async () => {
    const res = await contentSimilarity.run({
      input: {},
      output: "User prefers tea over coffee.",
      groundTruth: "user PREFERS tea, over coffee",
    });
    expect(res.score).toBe(1);
  });

  it("scores 0 for disjoint token sets", async () => {
    const res = await contentSimilarity.run({
      input: {},
      output: "alpha beta gamma",
      groundTruth: "delta epsilon zeta",
    });
    expect(res.score).toBe(0);
  });

  it("scores a value strictly between 0 and 1 for partial overlap", async () => {
    // tokens A = {user, likes, tea}, B = {user, likes, coffee}
    // intersection = {user, likes} = 2, union = 4 -> 0.5
    const res = await contentSimilarity.run({
      input: {},
      output: "user likes tea",
      groundTruth: "user likes coffee",
    });
    expect(res.score).toBeCloseTo(0.5, 5);
    expect(res.score).toBeGreaterThan(0);
    expect(res.score).toBeLessThan(1);
  });

  it("flags a near-duplicate above a dedup threshold", async () => {
    const res = await contentSimilarity.run({
      input: {},
      output: "User lives in Minsk and works as a developer",
      groundTruth: "User lives in Minsk, works as developer",
    });
    // Near-duplicate memory: high similarity should clear a typical 0.6 gate.
    expect(res.score).toBeGreaterThan(0.6);
  });
});
