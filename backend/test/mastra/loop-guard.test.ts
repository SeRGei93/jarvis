import { describe, it, expect } from "vitest";
import { LoopGuard, LoopGuardError, LOOP_TTL_MS } from "../../src/mastra/agents/loop-guard.js";

describe("LoopGuard", () => {
  it("allows two runs of the same skill+query, blocks the third", () => {
    const guard = new LoopGuard(() => 0);
    expect(() => guard.check("research", "find cats")).not.toThrow();
    expect(() => guard.check("research", "find cats")).not.toThrow();
    expect(() => guard.check("research", "find cats")).toThrow(LoopGuardError);
  });

  it("tracks distinct skills and queries independently", () => {
    const guard = new LoopGuard(() => 0);
    guard.check("research", "q1");
    guard.check("research", "q1");
    // different query and different skill are unaffected
    expect(() => guard.check("research", "q2")).not.toThrow();
    expect(() => guard.check("weather", "q1")).not.toThrow();
  });

  it("resets the counter after the TTL elapses", () => {
    let now = 0;
    const guard = new LoopGuard(() => now);
    guard.check("research", "q");
    guard.check("research", "q");
    expect(() => guard.check("research", "q")).toThrow(LoopGuardError);

    now += LOOP_TTL_MS + 1; // entry expires and is evicted
    expect(() => guard.check("research", "q")).not.toThrow();
  });
});
