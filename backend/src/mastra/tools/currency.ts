import { tool, type ToolSet } from "ai";
import { z } from "zod";
import type { ToolContext } from "./registry.js";
import { parseGoDuration } from "../../config/settings.js";
import { logger } from "../../pkg/logger.js";

const log = logger.child({ mod: "tool-currency" });

/** Tool names provided by this bucket. */
export const CURRENCY_TOOL_NAMES = new Set(["currency_rates"]);

const DEFAULT_CURRENCIES = ["USD", "EUR", "RUB"];
const FETCH_TIMEOUT_FALLBACK_MS = 15000;
const USER_AGENT = "Jarvis-AI/1.0";

/** A single currency rate from one source. */
interface ExchangeRate {
  currency: string;
  buy?: number;
  sell?: number;
  official?: number;
  scale?: number;
}

/** Exchange rates (or an error) from a single source. */
interface CurrencySource {
  name: string;
  url: string;
  source: string;
  rates: ExchangeRate[];
  error?: string;
}

const NBRB_URL = "https://api.nbrb.by/exrates/rates?periodicity=0";
const BELARUSBANK_URL = "https://belarusbank.by/api/kursExchange?city=Минск";
const MYFIN_URL = "https://myfin.by/currency/minsk";

/**
 * GET `url` with a per-request AbortController timeout; returns the Response or
 * throws. When a caller `signal` (the agent watchdog) is supplied it is composed
 * with the timeout via `AbortSignal.any`, so EITHER aborts the in-flight fetch.
 */
async function fetchWithTimeout(
  fetchFn: typeof globalThis.fetch,
  url: string,
  timeoutMs: number,
  callerSignal?: AbortSignal,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const signal = callerSignal
    ? AbortSignal.any([controller.signal, callerSignal])
    : controller.signal;
  try {
    return await fetchFn(url, {
      method: "GET",
      headers: { "User-Agent": USER_AGENT },
      signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

/** NBRB official rates (JSON). */
async function fetchNBRB(
  fetchFn: typeof globalThis.fetch,
  currencies: string[],
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<CurrencySource> {
  const source: CurrencySource = {
    name: "Национальный банк Республики Беларусь (НБРБ)",
    url: NBRB_URL,
    source: "nbrb",
    rates: [],
  };
  const started = Date.now();
  try {
    const resp = await fetchWithTimeout(fetchFn, source.url, timeoutMs, signal);
    if (!resp.ok) {
      log.warn({ source: "nbrb", url: source.url, status: resp.status }, "nbrb non-200");
      source.error = `status code: ${resp.status}`;
      return source;
    }
    const data = (await resp.json()) as Array<{
      Cur_Abbreviation?: string;
      Cur_Scale?: number;
      Cur_OfficialRate?: number;
    }>;
    const wanted = new Set(currencies);
    for (const rate of data) {
      const abbr = rate.Cur_Abbreviation;
      if (abbr && wanted.has(abbr)) {
        source.rates.push({
          currency: abbr,
          official: rate.Cur_OfficialRate,
          scale: rate.Cur_Scale,
        });
      }
    }
    log.debug({ source: "nbrb", count: source.rates.length, ms: Date.now() - started }, "nbrb done");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn({ source: "nbrb", url: source.url, err: msg }, "nbrb fetch failed");
    source.error = `fetch: ${msg}`;
  }
  return source;
}

/** Belarusbank buy/sell rates (JSON array of branches; use the first). */
async function fetchBelarusbank(
  fetchFn: typeof globalThis.fetch,
  currencies: string[],
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<CurrencySource> {
  const source: CurrencySource = {
    name: "Беларусбанк (курсы покупки/продажи, г. Минск)",
    url: BELARUSBANK_URL,
    source: "belarusbank",
    rates: [],
  };
  const started = Date.now();
  try {
    const resp = await fetchWithTimeout(fetchFn, source.url, timeoutMs, signal);
    if (!resp.ok) {
      log.warn({ source: "belarusbank", url: source.url, status: resp.status }, "belarusbank non-200");
      source.error = `status code: ${resp.status}`;
      return source;
    }
    const branches = (await resp.json()) as Array<Record<string, unknown>>;
    if (!Array.isArray(branches) || branches.length === 0) {
      source.error = "no branches returned";
      return source;
    }
    const branch = branches[0]!;
    for (const cur of currencies) {
      const buyRaw = branch[`${cur}_in`];
      const sellRaw = branch[`${cur}_out`];
      if (typeof buyRaw !== "string" || typeof sellRaw !== "string") continue;
      const buy = parseFloat(buyRaw);
      const sell = parseFloat(sellRaw);
      const buyVal = Number.isFinite(buy) ? buy : 0;
      const sellVal = Number.isFinite(sell) ? sell : 0;
      if (buyVal === 0 && sellVal === 0) continue; // skip zero rates
      source.rates.push({
        currency: cur,
        buy: buyVal,
        sell: sellVal,
        scale: cur === "RUB" ? 100 : 1,
      });
    }
    log.debug(
      { source: "belarusbank", count: source.rates.length, ms: Date.now() - started },
      "belarusbank done",
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn({ source: "belarusbank", url: source.url, err: msg }, "belarusbank fetch failed");
    source.error = `fetch: ${msg}`;
  }
  return source;
}

const MYFIN_CURRENCY_ORDER = ["USD", "EUR", "RUB"];

/**
 * Scrape myfin's "best courses" block via regex (no cheerio): inside the
 * `course-brief-info--best-courses` div, collect `<span class="accent">` numeric
 * values in document order (2 per currency: buy, sell) and map onto USD, EUR, RUB.
 */
function parseMyfinBestRates(htmlText: string, currencies: string[]): ExchangeRate[] {
  const blockMatch = /course-brief-info--best-courses/i.exec(htmlText);
  if (!blockMatch) return [];
  const block = htmlText.slice(blockMatch.index);

  const accentRe = /<span[^>]*class="[^"]*\baccent\b[^"]*"[^>]*>\s*([\d.,]+)\s*<\/span>/gi;
  const values: number[] = [];
  let m: RegExpExecArray | null;
  while ((m = accentRe.exec(block)) !== null) {
    const val = parseFloat(m[1]!.replace(",", "."));
    if (Number.isFinite(val) && val > 0) values.push(val);
  }

  const wanted = new Set(currencies);
  const rates: ExchangeRate[] = [];
  for (let i = 0; i < MYFIN_CURRENCY_ORDER.length && i * 2 + 1 < values.length; i++) {
    const currency = MYFIN_CURRENCY_ORDER[i]!;
    if (!wanted.has(currency)) continue;
    rates.push({
      currency,
      buy: values[i * 2]!,
      sell: values[i * 2 + 1]!,
      scale: currency === "RUB" ? 100 : 1,
    });
  }
  return rates;
}

/** myfin best rates (HTML scraped with a regex). */
async function fetchMyfin(
  fetchFn: typeof globalThis.fetch,
  currencies: string[],
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<CurrencySource> {
  const source: CurrencySource = {
    name: "Myfin.by (лучшие курсы в Минске)",
    url: MYFIN_URL,
    source: "myfin",
    rates: [],
  };
  const started = Date.now();
  try {
    const resp = await fetchWithTimeout(fetchFn, source.url, timeoutMs, signal);
    if (!resp.ok) {
      log.warn({ source: "myfin", url: source.url, status: resp.status }, "myfin non-200");
      source.error = `status code: ${resp.status}`;
      return source;
    }
    const htmlText = await resp.text();
    source.rates = parseMyfinBestRates(htmlText, currencies);
    if (source.rates.length === 0) {
      source.error = "no rates found in HTML";
    }
    log.debug({ source: "myfin", count: source.rates.length, ms: Date.now() - started }, "myfin done");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn({ source: "myfin", url: source.url, err: msg }, "myfin fetch failed");
    source.error = `fetch: ${msg}`;
  }
  return source;
}

/**
 * Build the `currency_rates` tool: fetch Belarusian exchange rates from NBRB,
 * Belarusbank and myfin in parallel. `fetchFn` is injectable for tests.
 */
export function buildCurrencyTools(
  ctx: ToolContext,
  fetchFn: typeof globalThis.fetch = globalThis.fetch,
): ToolSet {
  return {
    currency_rates: tool({
      description:
        "Fetch current exchange rates in Belarus from multiple sources. " +
        "Returns structured data: NBRB official rates, Belarusbank buy/sell rates, and best rates from myfin.by. " +
        "Each source returns an array of rates with currency code, buy/sell/official values.",
      inputSchema: z.object({
        currency: z
          .string()
          .optional()
          .describe(
            "Currency code to look up (e.g. USD, EUR, RUB). If empty, returns rates for USD, EUR, RUB.",
          ),
      }),
      execute: async ({ currency }, { abortSignal }) => {
        const currencies =
          currency && currency.trim() !== "" ? [currency.trim().toUpperCase()] : [...DEFAULT_CURRENCIES];

        const timeouts = await ctx.settings.getTimeouts();
        const timeoutMs = parseGoDuration(timeouts.http_client) || FETCH_TIMEOUT_FALLBACK_MS;

        // Thread the agent watchdog's abort signal into each source fetch so an
        // aborted turn really cancels the in-flight HTTP requests.
        const settled = await Promise.allSettled([
          fetchNBRB(fetchFn, currencies, timeoutMs, abortSignal),
          fetchBelarusbank(fetchFn, currencies, timeoutMs, abortSignal),
          fetchMyfin(fetchFn, currencies, timeoutMs, abortSignal),
        ]);

        const fallbacks: Array<{ name: string; url: string; source: string }> = [
          { name: "Национальный банк Республики Беларусь (НБРБ)", url: NBRB_URL, source: "nbrb" },
          { name: "Беларусбанк (курсы покупки/продажи, г. Минск)", url: BELARUSBANK_URL, source: "belarusbank" },
          { name: "Myfin.by (лучшие курсы в Минске)", url: MYFIN_URL, source: "myfin" },
        ];

        const sources: CurrencySource[] = settled.map((res, i) => {
          if (res.status === "fulfilled") return res.value;
          const fb = fallbacks[i]!;
          const msg = res.reason instanceof Error ? res.reason.message : String(res.reason);
          log.warn({ source: fb.source, url: fb.url, err: msg }, "source rejected");
          return { ...fb, rates: [], error: `fetch: ${msg}` };
        });

        return { sources };
      },
    }),
  };
}
