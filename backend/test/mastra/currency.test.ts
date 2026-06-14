import { describe, it, expect, vi } from "vitest";
import { buildCurrencyTools } from "../../src/mastra/tools/currency.js";
import type { ToolContext } from "../../src/mastra/tools/registry.js";

// Minimal ToolCallOptions for direct execute() calls in tests.
const opts = { toolCallId: "test", messages: [] } as never;

// Only settings.getTimeouts is used by the tool.
const ctx = {
  settings: {
    getTimeouts: async () => ({ llm_request: "300s", http_client: "15s", llm_activity: "30s" }),
  },
} as unknown as ToolContext;

const NBRB_BODY = JSON.stringify([
  { Cur_Abbreviation: "USD", Cur_Scale: 1, Cur_OfficialRate: 3.21 },
  { Cur_Abbreviation: "EUR", Cur_Scale: 1, Cur_OfficialRate: 3.45 },
  { Cur_Abbreviation: "RUB", Cur_Scale: 100, Cur_OfficialRate: 3.5 },
  { Cur_Abbreviation: "PLN", Cur_Scale: 10, Cur_OfficialRate: 8.0 }, // not requested → filtered out
]);

const BELARUSBANK_BODY = JSON.stringify([
  {
    USD_in: "3.18",
    USD_out: "3.25",
    EUR_in: "3.40",
    EUR_out: "3.50",
    RUB_in: "3.45",
    RUB_out: "3.55",
  },
]);

// HTML with the best-courses block; <span class="accent"> values in order:
// USD buy/sell, EUR buy/sell, RUB buy/sell.
const MYFIN_HTML = `
<html><body>
  <div class="course-brief-info--best-courses">
    <div class="course-brief-info__r"><span class="accent">3.19</span><span class="accent">3.24</span></div>
    <div class="course-brief-info__r"><span class="accent">3.41</span><span class="accent">3.49</span></div>
    <div class="course-brief-info__r"><span class="accent">3.46</span><span class="accent">3.54</span></div>
  </div>
</body></html>`;

function jsonResp(body: string, status = 200): Response {
  return new Response(body, { status, headers: { "content-type": "application/json" } });
}
function htmlResp(body: string, status = 200): Response {
  return new Response(body, { status, headers: { "content-type": "text/html" } });
}

/** Route by URL to the canned response. `overrides` lets a test swap one source. */
function makeFetch(overrides: Record<string, () => Promise<Response>> = {}) {
  return vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
    const url = String(input);
    const pick = (key: string, def: () => Promise<Response>) =>
      overrides[key] ? overrides[key]!() : def();
    if (url.includes("api.nbrb.by")) return pick("nbrb", async () => jsonResp(NBRB_BODY));
    if (url.includes("belarusbank.by")) return pick("belarusbank", async () => jsonResp(BELARUSBANK_BODY));
    if (url.includes("myfin.by")) return pick("myfin", async () => htmlResp(MYFIN_HTML));
    throw new Error(`unexpected url: ${url}`);
  }) as unknown as typeof globalThis.fetch;
}

interface Rate {
  currency: string;
  buy?: number;
  sell?: number;
  official?: number;
  scale?: number;
}
interface Source {
  name: string;
  url: string;
  source: string;
  rates: Rate[];
  error?: string;
}
interface Out {
  sources: Source[];
}

async function run(fetchFn: typeof globalThis.fetch, currency?: string): Promise<Out> {
  const ts = buildCurrencyTools(ctx, fetchFn);
  return (await ts.currency_rates!.execute!(currency === undefined ? {} : { currency }, opts)) as Out;
}

const byName = (out: Out, source: string) => out.sources.find((s) => s.source === source)!;

describe("currency_rates tool", () => {
  it("parses all three sources", async () => {
    const out = await run(makeFetch());
    expect(out.sources).toHaveLength(3);

    const nbrb = byName(out, "nbrb");
    expect(nbrb.error).toBeUndefined();
    expect(nbrb.url).toBe("https://api.nbrb.by/exrates/rates?periodicity=0");
    expect(nbrb.rates).toEqual([
      { currency: "USD", official: 3.21, scale: 1 },
      { currency: "EUR", official: 3.45, scale: 1 },
      { currency: "RUB", official: 3.5, scale: 100 },
    ]);

    const bank = byName(out, "belarusbank");
    expect(bank.error).toBeUndefined();
    expect(bank.rates).toEqual([
      { currency: "USD", buy: 3.18, sell: 3.25, scale: 1 },
      { currency: "EUR", buy: 3.4, sell: 3.5, scale: 1 },
      { currency: "RUB", buy: 3.45, sell: 3.55, scale: 100 }, // RUB scale=100 parity
    ]);

    const myfin = byName(out, "myfin");
    expect(myfin.error).toBeUndefined();
    expect(myfin.rates).toEqual([
      { currency: "USD", buy: 3.19, sell: 3.24, scale: 1 },
      { currency: "EUR", buy: 3.41, sell: 3.49, scale: 1 },
      { currency: "RUB", buy: 3.46, sell: 3.54, scale: 100 }, // RUB scale=100 parity
    ]);
  });

  it("isolates a failing source (500) without affecting the others", async () => {
    const out = await run(makeFetch({ belarusbank: async () => jsonResp("[]", 500) }));

    const bank = byName(out, "belarusbank");
    expect(bank.error).toBe("status code: 500");
    expect(bank.rates).toEqual([]);

    // The other two stayed healthy.
    expect(byName(out, "nbrb").error).toBeUndefined();
    expect(byName(out, "nbrb").rates.length).toBe(3);
    expect(byName(out, "myfin").error).toBeUndefined();
    expect(byName(out, "myfin").rates.length).toBe(3);
  });

  it("isolates a rejecting source (network throw) without affecting the others", async () => {
    const out = await run(
      makeFetch({
        myfin: async () => {
          throw new Error("boom");
        },
      }),
    );

    const myfin = byName(out, "myfin");
    expect(myfin.error).toContain("boom");
    expect(myfin.rates).toEqual([]);

    expect(byName(out, "nbrb").error).toBeUndefined();
    expect(byName(out, "belarusbank").error).toBeUndefined();
  });

  it("sets an error when myfin HTML does not match the best-courses block", async () => {
    const out = await run(makeFetch({ myfin: async () => htmlResp("<html><body>no rates here</body></html>") }));
    const myfin = byName(out, "myfin");
    expect(myfin.error).toBe("no rates found in HTML");
    expect(myfin.rates).toEqual([]);
  });

  it("defaults to USD/EUR/RUB when currency is empty", async () => {
    const fetchFn = makeFetch();
    const out = await run(fetchFn, "");
    const nbrb = byName(out, "nbrb");
    expect(nbrb.rates.map((r) => r.currency)).toEqual(["USD", "EUR", "RUB"]);
  });

  it("filters to a single requested currency (uppercased)", async () => {
    const out = await run(makeFetch(), "usd");
    const nbrb = byName(out, "nbrb");
    expect(nbrb.rates).toEqual([{ currency: "USD", official: 3.21, scale: 1 }]);
    const bank = byName(out, "belarusbank");
    expect(bank.rates).toEqual([{ currency: "USD", buy: 3.18, sell: 3.25, scale: 1 }]);
  });
});
