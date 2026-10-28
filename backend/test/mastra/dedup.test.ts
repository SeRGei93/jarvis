import { describe, it, expect, vi } from "vitest";
import {
  DecisionDedupChecker,
  DEDUP_DUPLICATE_THRESHOLD,
  type DecisionJudge,
  type DedupChecker,
} from "../../src/mastra/memory/dedup.js";

/** LLM fallback stub that records whether it was consulted. */
function fallback(result = false): DedupChecker & { calls: number } {
  const stub = {
    calls: 0,
    isDuplicate: async () => {
      stub.calls += 1;
      return result;
    },
  };
  return stub;
}

function judge(p: number | null): DecisionJudge & { calls: number; lastState: string } {
  const stub = {
    calls: 0,
    lastState: "",
    judge: async (state: string) => {
      stub.calls += 1;
      stub.lastState = state;
      return p;
    },
  };
  return stub;
}

describe("DecisionDedupChecker", () => {
  it("never calls any API when there are no existing facts", async () => {
    const j = judge(0.99);
    const fb = fallback();
    const d = new DecisionDedupChecker(j, fb);
    expect(await d.isDuplicate("new fact", [])).toBe(false);
    expect(j.calls).toBe(0);
    expect(fb.calls).toBe(0);
  });

  it("treats p >= threshold as a duplicate", async () => {
    const fb = fallback(false);
    const d = new DecisionDedupChecker(judge(DEDUP_DUPLICATE_THRESHOLD), fb);
    expect(await d.isDuplicate("coffee", ["likes coffee"])).toBe(true);
    expect(fb.calls).toBe(0);
  });

  it("treats p < threshold as not a duplicate", async () => {
    const fb = fallback(true);
    const d = new DecisionDedupChecker(judge(0.69), fb);
    expect(await d.isDuplicate("coffee", ["likes tea"])).toBe(false);
    expect(fb.calls).toBe(0); // a confident "no" needs no LLM confirmation
  });

  it("delegates to the LLM checker when the decision layer is unavailable", async () => {
    const fb = fallback(true);
    const d = new DecisionDedupChecker(judge(null), fb);
    expect(await d.isDuplicate("coffee", ["likes coffee"])).toBe(true);
    expect(fb.calls).toBe(1);
  });

  it("passes the candidate and the numbered existing facts to the judge", async () => {
    const j = judge(0.1);
    const d = new DecisionDedupChecker(j, fallback());
    await d.isDuplicate("uses TS", ["likes coffee", "rides a bike"]);
    expect(j.lastState).toContain("uses TS");
    expect(j.lastState).toContain("1. likes coffee");
    expect(j.lastState).toContain("2. rides a bike");
  });

  it("caps each existing fact so ~50 memories fit the decision context", async () => {
    const j = judge(0.1);
    const d = new DecisionDedupChecker(j, fallback());
    await d.isDuplicate("candidate", ["x".repeat(1000)]);
    expect(j.lastState).toContain("…");
    expect(j.lastState.length).toBeLessThan(600);
  });

  it("propagates a thrown judge error to the caller (MemoryService guards)", async () => {
    const j = { judge: vi.fn(async () => { throw new Error("boom"); }) } as unknown as DecisionJudge;
    const d = new DecisionDedupChecker(j, fallback());
    await expect(d.isDuplicate("x", ["y"])).rejects.toThrow("boom");
  });

  it("honours a custom threshold", async () => {
    const d = new DecisionDedupChecker(judge(0.5), fallback(), { threshold: 0.4 });
    expect(await d.isDuplicate("x", ["y"])).toBe(true);
  });
});
