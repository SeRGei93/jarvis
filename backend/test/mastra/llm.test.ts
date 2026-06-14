import { describe, it, expect, vi } from "vitest";
import {
  extractCost,
  reasoningProviderOptions,
  startWatchdog,
  buildRetryMessages,
} from "../../src/mastra/llm.js";
import type { Message } from "../../src/domain/entities.js";

describe("extractCost", () => {
  it("reads openrouter usage.cost / cost", () => {
    expect(extractCost({ openrouter: { usage: { cost: 0.0012 } } })).toBe(0.0012);
    expect(extractCost({ openrouter: { cost: 0.5 } })).toBe(0.5);
    expect(extractCost({})).toBeUndefined();
    expect(extractCost(undefined)).toBeUndefined();
  });
});

describe("reasoningProviderOptions", () => {
  it("maps tri-state reasoning to provider options", () => {
    expect(reasoningProviderOptions("openrouter:x/y", true)).toEqual({
      openrouter: { reasoning: { enabled: true } },
    });
    expect(reasoningProviderOptions("zai:glm-5", false)).toEqual({
      zai: { reasoning: { enabled: false } },
    });
    expect(reasoningProviderOptions("openrouter:x", null)).toBeUndefined();
    expect(reasoningProviderOptions("openrouter:x", undefined)).toBeUndefined();
  });
});

describe("buildRetryMessages", () => {
  const base: Message[] = [{ role: "user", content: "hi" }];
  it("returns messages unchanged when there are no errors", () => {
    expect(buildRetryMessages(base, [])).toEqual(base);
  });
  it("appends a user note listing unique errors", () => {
    const out = buildRetryMessages(base, ["boom", "kaboom"]);
    expect(out).toHaveLength(2);
    expect(out[1]?.role).toBe("user");
    expect(out[1]?.content).toContain("boom");
    expect(out[1]?.content).toContain("kaboom");
  });
});

describe("startWatchdog", () => {
  it("aborts after the idle window and resets on activity", () => {
    vi.useFakeTimers();
    try {
      const c = new AbortController();
      const wd = startWatchdog(c, 1000);
      vi.advanceTimersByTime(900);
      wd.reset(); // activity
      vi.advanceTimersByTime(900);
      expect(c.signal.aborted).toBe(false);
      vi.advanceTimersByTime(200); // 1100ms since last reset -> fire
      expect(c.signal.aborted).toBe(true);
      expect(wd.fired).toBe(true);
      wd.clear();
    } finally {
      vi.useRealTimers();
    }
  });
});
