import { fetchPageAsMarkdown, type PageParser } from "../fetch.js";
import { FETCH_LIMITS } from "../config.js";
import { webChild } from "../logger.js";
import { isZippybusUrl, extractZippybusContent } from "./zippybus-page.js";

const log = webChild("transport");

// ---------------------------------------------------------------------------
// Injectable deps
// ---------------------------------------------------------------------------

export interface WebDeps {
  fetchFn?: typeof globalThis.fetch;
  timeoutMs?: number;
}

// ---------------------------------------------------------------------------
// Page-parser registry (injected into fetchPageAsMarkdown)
// ---------------------------------------------------------------------------

export const transportPageParsers: PageParser[] = [
  { match: isZippybusUrl, extract: extractZippybusContent },
];

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ZippybusSearchParams {
  city: string;
  transport?: string;
  route?: string;
}

// ---------------------------------------------------------------------------
// Available cities (from the /by/ index page)
// ---------------------------------------------------------------------------

const CITY_SLUGS = new Set([
  "baranovichi", "belynichi-region", "borisov", "brest", "byhov",
  "vileyka", "vitebsk", "volkovysk", "glubokoe", "gorki-region",
  "grodno", "dobrush", "zhlobin", "zhodino", "zaslavl",
  "ivanovo", "kobrin", "krichev", "krichev-region",
  "lida", "luninets", "minsk", "mogilev", "molodechno",
  "mstislavskiy-rayon", "myadel", "nesvizh", "novopolotsk",
  "pinsk", "pinsk-region", "polotsk", "postavy",
  "slavgorod-region", "smolevichi", "stolin",
]);

const TRANSPORT_TYPES = new Set([
  "bus", "trolleybus", "tram", "routetaxi",
]);

// ---------------------------------------------------------------------------
// URL builder
// ---------------------------------------------------------------------------

function buildZippybusUrl(params: ZippybusSearchParams): string {
  const city = params.city.toLowerCase();
  if (!CITY_SLUGS.has(city)) {
    const available = [...CITY_SLUGS].sort().join(", ");
    throw new Error(`Unknown city "${params.city}". Available: ${available}`);
  }

  let path = `/by/${city}`;

  if (params.transport) {
    const transport = params.transport.toLowerCase();
    if (!TRANSPORT_TYPES.has(transport)) {
      const available = [...TRANSPORT_TYPES].join(", ");
      throw new Error(`Unknown transport type "${params.transport}". Available: ${available}`);
    }
    path += `/${transport}`;

    if (params.route) {
      path += `/${params.route}`;
    }
  }

  return `https://zippybus.com${path}`;
}

// ---------------------------------------------------------------------------
// Search function
// ---------------------------------------------------------------------------

export async function zippybusSearch(
  params: ZippybusSearchParams,
  deps: WebDeps = {},
): Promise<string> {
  const url = buildZippybusUrl(params);
  const timeoutMs = deps.timeoutMs ?? FETCH_LIMITS.timeoutMs;
  const started = Date.now();
  log.debug({ url }, "transport: fetch");
  try {
    const md = await fetchPageAsMarkdown(url, timeoutMs, {
      fetchFn: deps.fetchFn,
      pageParsers: transportPageParsers,
    });
    log.debug({ url, len: md.length, elapsedMs: Date.now() - started }, "transport: done");
    return md;
  } catch (err) {
    log.warn(
      { url, err: (err as Error).message, elapsedMs: Date.now() - started },
      "transport: failed",
    );
    throw err;
  }
}
