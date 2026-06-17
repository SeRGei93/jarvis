import { describe, it, expect } from "vitest";
import { createScorer } from "@mastra/core/evals";
import { createRequire } from "node:module";

/**
 * Phase 0 de-risk spike (task S2). Proves Mastra's `createScorer(...).run(...)`
 * works as a DETERMINISTIC offline scorer (no model, no network) and pins down
 * the under-documented `.run()` result shape with a snapshot. This is the
 * foundation for the B4 eval harness (deterministic routing/dedup/summary gates).
 *
 * Throwaway PoC — keep until B4 lands the real harness.
 */

// A deterministic scorer: 1 if the chosen primary skill matches the expected one.
// groundTruth = expected skill; output = chosen skill. No judge -> no model call.
const primarySkillChoice = createScorer({
  id: "primary-skill-choice",
  name: "primary-skill-choice",
  description: "1.0 when the chosen primary skill equals the expected skill, else 0.0.",
}).generateScore(({ run }) => (run.output === run.groundTruth ? 1 : 0));

describe("createScorer offline smoke (S2 go/no-go)", () => {
  it("pins @mastra/core to the spiked version (under-documented API)", () => {
    const require = createRequire(import.meta.url);
    const version = require("@mastra/core/package.json").version as string;
    // S2 snapshotted the .run() shape against this exact version. Bumping it must
    // be a deliberate act that re-validates the scorer contract below.
    expect(version).toBe("1.42.0");
  });

  it("scores a correct skill choice as 1 with no network", async () => {
    const res = await primarySkillChoice.run({
      input: { userMessage: "сколько стоит доллar?" },
      output: "currency",
      groundTruth: "currency",
    });
    expect(res.score).toBe(1);
  });

  it("scores a wrong skill choice as 0", async () => {
    const res = await primarySkillChoice.run({
      input: { userMessage: "сколько стоит доллар?" },
      output: "weather",
      groundTruth: "currency",
    });
    expect(res.score).toBe(0);
  });

  it("freezes the .run() result shape (contract snapshot)", async () => {
    const res = await primarySkillChoice.run({
      input: { userMessage: "x" },
      output: "currency",
      groundTruth: "currency",
    });
    // Core contract fields the B4 harness depends on.
    expect(typeof res.runId).toBe("string");
    expect(typeof res.score).toBe("number");
    expect(res.output).toBe("currency");
    // Snapshot the full key set so an API drift on version bump is caught.
    expect(Object.keys(res).sort()).toMatchInlineSnapshot(`
      [
        "analyzePrompt",
        "analyzeStepResult",
        "generateReasonPrompt",
        "generateScorePrompt",
        "groundTruth",
        "input",
        "output",
        "preprocessPrompt",
        "preprocessStepResult",
        "reason",
        "runId",
        "score",
      ]
    `);
  });
});
