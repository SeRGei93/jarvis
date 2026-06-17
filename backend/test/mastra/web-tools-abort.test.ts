import { describe, it, expect, vi } from "vitest";
import { buildCurrencyTools } from "../../src/mastra/tools/currency.js";
import { fetchPageAsMarkdown } from "../../src/services/web/fetch.js";
import type { ToolContext } from "../../src/mastra/tools/registry.js";
import type { LookupFn } from "../../src/services/web/ssrf-guard.js";

/**
 * B3 "AbortSignal into tools": the tool-execution abort signal (the agent
 * watchdog) must reach the actual `fetch` call so an aborted turn really
 * cancels in-flight HTTP. These tests inject a recording `fetchFn` and assert
 * the composed signal is wired through (aborts when EITHER timeout or the
 * caller signal fires), without touching the network or real DNS.
 */

// Minimal ToolCallOptions for direct execute() calls; `abortSignal` is added per test.
function callOpts(abortSignal?: AbortSignal): never {
  return { toolCallId: "test", messages: [], abortSignal } as never;
}

// Only settings.getTimeouts is read by these tools.
const ctx = {
  settings: {
    getTimeouts: async () => ({ llm_request: "300s", http_client: "15s", llm_activity: "30s" }),
  },
} as unknown as ToolContext;

/** A lookupFn that resolves to a single public IPv4 (no real DNS). */
const publicLookup: LookupFn = async () => [{ address: "93.184.216.34", family: 4 }];

/**
 * Build a fetchFn that records the `signal` from each call's init, then resolves
 * with a canned JSON/HTML body. Lets tests inspect the wired signal afterwards.
 */
function recordingFetch(): {
  fetchFn: typeof globalThis.fetch;
  signals: Array<AbortSignal | undefined>;
} {
  const signals: Array<AbortSignal | undefined> = [];
  const fetchFn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    signals.push(init?.signal ?? undefined);
    const url = String(input);
    if (url.includes("api.nbrb.by")) {
      return new Response("[]", { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url.includes("belarusbank.by") || url.includes("myfin.by")) {
      return new Response("[]", { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response("<html><body>ok</body></html>", {
      status: 200,
      headers: { "content-type": "text/html" },
    });
  }) as unknown as typeof globalThis.fetch;
  return { fetchFn, signals };
}

describe("currency_rates: AbortSignal wiring", () => {
  it("forwards the caller abort signal into every source fetch", async () => {
    const { fetchFn, signals } = recordingFetch();
    const tools = buildCurrencyTools(ctx, fetchFn);

    const controller = new AbortController();
    await tools.currency_rates!.execute!({}, callOpts(controller.signal));

    // Three sources (NBRB, Belarusbank, myfin) → three fetches, each with a signal.
    expect(signals.length).toBe(3);
    for (const sig of signals) {
      expect(sig).toBeInstanceOf(AbortSignal);
      expect(sig!.aborted).toBe(false);
    }

    // Aborting the caller controller propagates to the composed signals.
    controller.abort();
    for (const sig of signals) {
      expect(sig!.aborted).toBe(true);
    }
  });

  it("the fetch sees an already-aborted signal when the watchdog has fired", async () => {
    const { fetchFn, signals } = recordingFetch();
    const tools = buildCurrencyTools(ctx, fetchFn);

    const controller = new AbortController();
    controller.abort(); // watchdog already fired before the tool runs

    await tools.currency_rates!.execute!({}, callOpts(controller.signal));

    expect(signals.length).toBe(3);
    for (const sig of signals) {
      expect(sig!.aborted).toBe(true);
    }
  });

  it("falls back to the timeout-only signal when no caller signal is supplied", async () => {
    const { fetchFn, signals } = recordingFetch();
    const tools = buildCurrencyTools(ctx, fetchFn);

    await tools.currency_rates!.execute!({}, callOpts(undefined));

    // Signal is still present (the per-request timeout controller), just not aborted.
    expect(signals.length).toBe(3);
    for (const sig of signals) {
      expect(sig).toBeInstanceOf(AbortSignal);
      expect(sig!.aborted).toBe(false);
    }
  });
});

describe("fetchPageAsMarkdown: AbortSignal wiring (fetch_url chokepoint)", () => {
  it("forwards the caller abort signal into the underlying fetch", async () => {
    const { fetchFn, signals } = recordingFetch();
    const controller = new AbortController();

    await fetchPageAsMarkdown("https://example.test/", 5000, {
      fetchFn,
      lookupFn: publicLookup,
      useCache: false,
      signal: controller.signal,
    });

    expect(signals.length).toBe(1);
    const sig = signals[0]!;
    expect(sig).toBeInstanceOf(AbortSignal);
    expect(sig.aborted).toBe(false);

    controller.abort();
    expect(sig.aborted).toBe(true);
  });

  it("rejects when the caller signal is already aborted before the fetch", async () => {
    const controller = new AbortController();
    controller.abort();

    // A fetchFn that honours its signal (throws an AbortError when aborted),
    // mirroring the real global fetch behaviour.
    const abortingFetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.signal?.aborted) {
        const err = new Error("The operation was aborted");
        err.name = "AbortError";
        throw err;
      }
      return new Response("<html><body>ok</body></html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      });
    }) as unknown as typeof globalThis.fetch;

    await expect(
      fetchPageAsMarkdown("https://example.test/", 5000, {
        fetchFn: abortingFetch,
        lookupFn: publicLookup,
        useCache: false,
        signal: controller.signal,
      }),
    ).rejects.toThrow(/abort/i);
  });
});
