/**
 * Live comparison: local `search_news` feed vs Serper Google News.
 *
 * Run from the repo root (loads the root `.env`) or from `backend/`:
 *
 *   npx tsx backend/scripts/news-compare.ts
 *   cd backend && npx tsx --env-file=../.env scripts/news-compare.ts
 *
 * Writes `.ai-factory/references/news-serper-comparison.md`. No full raw JSON is
 * stored — only aggregate metrics plus a static payload-shape example.
 *
 * Logging is intentionally minimal (WARN on a failed query/source, ERROR when
 * the whole run fails). Metrics come from injected/mocked dependencies only
 * where needed; the Serper calls and the Belarus feeds are real.
 */
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  canonicalNewsUrl,
  classifyNewsLink,
  newsPublisherHost,
} from "./lib/news-links.js";
import {
  isSerperDateFresh,
  parseSerperRelativeDate,
} from "./lib/serper-date.js";
import type { SerperLocale } from "./lib/serper-date.js";

// `.env` from cwd first (backend), then the repo root; must run before any
// module that reads `process.env` at import time.
function loadEnv(): void {
  try {
    process.loadEnvFile();
  } catch {
    /* no cwd .env — fine */
  }
  if (process.env.SERPER_API_KEY) return;
  const rootEnv = fileURLToPath(new URL("../../.env", import.meta.url));
  if (!existsSync(rootEnv)) return;
  try {
    process.loadEnvFile(rootEnv);
  } catch {
    /* malformed/unreadable root .env — the key check below reports it */
  }
}
loadEnv();

const [{ performSerperNewsSearch }, { searchNews }] = await Promise.all([
  import("../src/services/web/search.js"),
  import("../src/services/web/parsers/index.js"),
]);

const REPORT_PATH = fileURLToPath(
  new URL("../../.ai-factory/references/news-serper-comparison.md", import.meta.url),
);
const SERPER_TIMEOUT_MS = 20_000;
const LOCAL_TIMEOUT_MS = 30_000;
const NEWS_COUNT = 10;
const FRESH_HOURS = 24;

const DEFAULT_LOCAL_SITES = [
  "onliner.by",
  "tochka.by",
  "smartpress.by",
  "gismeteo.by",
  "wikidom.by",
] as const;

type RegionKey = "by" | "ru" | "ua" | "us" | "de" | "world";

interface QuerySpec {
  id: string;
  region: RegionKey;
  query: string;
}

/**
 * 24 queries (≥20) covering Belarus cities, RU/UA/US/DE and the world.
 * `search_news` is a Belarus-only feed, so only `by` rows have a local baseline.
 */
const QUERIES: readonly QuerySpec[] = [
  { id: "by-general", region: "by", query: "новости Беларуси" },
  { id: "by-minsk", region: "by", query: "новости Минска" },
  { id: "by-brest", region: "by", query: "новости Бреста" },
  { id: "by-gomel", region: "by", query: "новости Гомеля" },
  { id: "by-grodno", region: "by", query: "новости Гродно" },
  { id: "by-society", region: "by", query: "Беларусь общество" },
  { id: "by-economy", region: "by", query: "Беларусь экономика" },
  { id: "by-incidents", region: "by", query: "Беларусь происшествия" },
  { id: "ru-general", region: "ru", query: "новости России" },
  { id: "ru-moscow", region: "ru", query: "новости Москвы" },
  { id: "ru-spb", region: "ru", query: "новости Санкт-Петербурга" },
  { id: "ru-economy", region: "ru", query: "Россия экономика новости" },
  { id: "ua-general", region: "ua", query: "новини України" },
  { id: "ua-kyiv", region: "ua", query: "новини Києва" },
  { id: "ua-lviv", region: "ua", query: "новини Львова" },
  { id: "us-general", region: "us", query: "US news" },
  { id: "us-ny", region: "us", query: "New York news" },
  { id: "us-tech", region: "us", query: "technology news" },
  { id: "de-general", region: "de", query: "Deutschland Nachrichten" },
  { id: "de-berlin", region: "de", query: "Berlin Nachrichten" },
  { id: "de-munich", region: "de", query: "München Nachrichten" },
  { id: "world-general", region: "world", query: "world news" },
  { id: "world-europe", region: "world", query: "Europe news" },
  { id: "world-politics", region: "world", query: "international politics" },
];

/** Region alias passed to Serper; the client resolves it to `gl`/`hl`. */
const REGION_ALIAS: Record<RegionKey, string> = {
  by: "by",
  ru: "ru",
  ua: "ua",
  us: "us",
  de: "de",
  world: "world",
};

/** Locale hint for `date` parsing (Google returns dates in the UI language). */
const REGION_LOCALE: Record<RegionKey, SerperLocale | undefined> = {
  by: "ru",
  ru: "ru",
  ua: "uk",
  us: "en",
  de: "de",
  world: undefined,
};

/** Known outlets per region — used for the local/known-source share. */
const LOCAL_OUTLETS: Record<RegionKey, readonly string[]> = {
  by: [
    "onliner.by", "tochka.by", "smartpress.by", "gismeteo.by", "wikidom.by",
    "belta.by", "sputnik.by", "myfin.by", "officelife.media", "realt.by",
    "pressball.by", "gp.by", "newsgomel.by", "vb.by", "brestcity.com",
    "minsknews.by", "kp.by", "sb.by", "nn.by", "euroradio.fm",
  ],
  ru: [
    "rbc.ru", "tass.ru", "ria.ru", "kommersant.ru", "lenta.ru", "interfax.ru",
    "vedomosti.ru", "rg.ru", "iz.ru", "gazeta.ru", "forbes.ru", "bfm.ru",
    "rtvi.com", "mk.ru", "kp.ru", "vedomosti.ru", "1prime.ru",
  ],
  ua: [
    "pravda.com.ua", "unian.ua", "ukrinform.ua", "tsn.ua", "segodnya.ua",
    "nv.ua", "liga.net", "espreso.tv", "hromadske.ua", "suspilne.media",
    "kyivindependent.com", "kyivpost.com",
  ],
  us: [
    "nytimes.com", "cnn.com", "reuters.com", "apnews.com", "wsj.com",
    "usatoday.com", "washingtonpost.com", "nbcnews.com", "cbsnews.com",
    "abcnews.go.com", "politico.com", "axios.com", "bloomberg.com",
    "thehill.com", "npr.org", "foxnews.com",
  ],
  de: [
    "spiegel.de", "zeit.de", "faz.net", "sueddeutsche.de", "tagesschau.de",
    "bild.de", "welt.de", "ntv.de", "rnd.de", "t-online.de", "focus.de",
    "handelsblatt.com", "br.de", "wdr.de", "mdr.de",
  ],
  world: [
    "reuters.com", "apnews.com", "bbc.com", "bbc.co.uk", "cnn.com",
    "aljazeera.com", "dw.com", "france24.com", "theguardian.com", "nytimes.com",
    "washingtonpost.com", "bloomberg.com", "ft.com", "economist.com",
  ],
};

const LOCAL_TLD: Partial<Record<RegionKey, string>> = {
  by: ".by",
  ru: ".ru",
  ua: ".ua",
  de: ".de",
};

function matchesOutlet(host: string, outlets: readonly string[]): boolean {
  return outlets.some((outlet) => host === outlet || host.endsWith(`.${outlet}`));
}

function isKnownSource(host: string, region: RegionKey): boolean {
  if (matchesOutlet(host, LOCAL_OUTLETS[region])) return true;
  const tld = LOCAL_TLD[region];
  return tld ? host.endsWith(tld) : false;
}

interface Metrics {
  items: number;
  uniqueItems: number;
  duplicates: number;
  duplicateRate: number | null;
  uniqueSources: number;
  knownShare: number | null;
  knownSources: number;
  directLinks: number;
  googleRedirects: number;
  invalidLinks: number;
  fresh24h: number;
  freshShare: number | null;
  unknownAge: number;
  oldestAgeHours: number | null;
}

function emptyMetrics(): Metrics {
  return {
    items: 0,
    uniqueItems: 0,
    duplicates: 0,
    duplicateRate: null,
    uniqueSources: 0,
    knownShare: null,
    knownSources: 0,
    directLinks: 0,
    googleRedirects: 0,
    invalidLinks: 0,
    fresh24h: 0,
    freshShare: null,
    unknownAge: 0,
    oldestAgeHours: null,
  };
}

function pct(part: number, total: number): number | null {
  return total > 0 ? (part / total) * 100 : null;
}

function fmtPct(value: number | null): string {
  return value === null ? "n/a" : `${value.toFixed(0)}%`;
}

function fmtRate(value: number | null): string {
  return value === null ? "n/a" : value.toFixed(2);
}

interface SerperNewsItem {
  title?: string;
  link?: string;
  snippet?: string;
  date?: string;
  source?: string;
  imageUrl?: string;
}

interface SerperNewsPayload {
  news?: SerperNewsItem[];
  credits?: number;
}

interface QueryResult {
  spec: QuerySpec;
  metrics: Metrics | null;
  credits: number;
  error?: string;
}

interface LocalSnapshot {
  metrics: Metrics;
  perSource: Array<{ source: string; items: number; fresh24h: number; unknownAge: number }>;
  errors: Array<{ source: string; status: string; message?: string }>;
  providerCalls: number;
}

/** Run the Belarus local feed once; every BY row reuses this baseline. */
async function runLocalBaseline(): Promise<LocalSnapshot> {
  const started = Date.now();
  let providerCalls = 0;
  const countingProvider = {
    name: "counting-noop",
    configured: true,
    async fetchPage(): Promise<never> {
      providerCalls += 1;
      throw new Error("comparison harness: provider must not be called for SSR feeds");
    },
  };

  const sections = await searchNews(
    [...DEFAULT_LOCAL_SITES],
    LOCAL_TIMEOUT_MS,
    // The harness only measures whether the provider is needed; a throwing
    // stub surfaces any call as a source error instead of spending credits.
    countingProvider,
  );

  const now = new Date();
  const seen = new Set<string>();
  const sources = new Set<string>();
  const knownHosts = new Set<string>();
  let items = 0;
  let duplicates = 0;
  let fresh24h = 0;
  let unknownAge = 0;
  let oldestAgeHours = 0;

  const perSource = sections.map((section) => {
    let sourceFresh = 0;
    let sourceUnknown = 0;
    for (const item of section.items) {
      const canonical = canonicalNewsUrl(item.url) ?? item.url;
      if (seen.has(canonical)) duplicates += 1;
      else {
        seen.add(canonical);
        items += 1;
      }
      sources.add(section.source);
      const host = newsPublisherHost(item.url);
      if (host) knownHosts.add(host);

      const ageHours =
        typeof item.timestamp === "number"
          ? (now.getTime() / 1000 - item.timestamp) / 3600
          : (() => {
              const date = parseSerperRelativeDate(item.date, now);
              return date ? (now.getTime() - date.getTime()) / 3_600_000 : undefined;
            })();
      if (ageHours === undefined) {
        unknownAge += 1;
        sourceUnknown += 1;
      } else {
        oldestAgeHours = Math.max(oldestAgeHours, ageHours);
        if (ageHours >= 0 && ageHours < FRESH_HOURS) {
          fresh24h += 1;
          sourceFresh += 1;
        }
      }
    }
    return {
      source: section.source,
      items: section.items.length,
      fresh24h: sourceFresh,
      unknownAge: sourceUnknown,
    };
  });

  const uniqueItems = seen.size;
  const metrics: Metrics = {
    items: perSource.reduce((sum, s) => sum + s.items, 0),
    uniqueItems,
    duplicates,
    duplicateRate: duplicates + uniqueItems > 0 ? duplicates / (duplicates + uniqueItems) : null,
    uniqueSources: sources.size,
    knownSources: knownHosts.size,
    knownShare: pct(knownHosts.size, Math.max(1, uniqueItems)),
    directLinks: uniqueItems,
    googleRedirects: 0,
    invalidLinks: 0,
    fresh24h,
    freshShare: pct(fresh24h, perSource.reduce((sum, s) => sum + s.items, 0)),
    unknownAge,
    oldestAgeHours: oldestAgeHours || null,
  };

  const errors = sections
    .filter((s) => s.error)
    .map((s) => ({ source: s.source, status: "error", message: s.error }));

  console.log(
    `news-compare: local baseline ${metrics.items} items, ${metrics.fresh24h} fresh, ` +
      `${providerCalls} provider call(s), ${Date.now() - started}ms`,
  );

  return { metrics, perSource, errors, providerCalls };
}

function analyzeSerper(
  spec: QuerySpec,
  payload: SerperNewsPayload,
  now: Date,
): Metrics {
  const news = Array.isArray(payload.news) ? payload.news : [];
  const locale = REGION_LOCALE[spec.region];
  const seen = new Set<string>();
  const sources = new Set<string>();
  let directLinks = 0;
  let googleRedirects = 0;
  let invalidLinks = 0;
  let fresh24h = 0;
  let unknownAge = 0;
  let oldestAgeHours = 0;
  let knownSources = 0;
  let duplicates = 0;

  for (const item of news) {
    const link = typeof item.link === "string" ? item.link : "";
    const kind = classifyNewsLink(link);
    if (kind === "google-redirect" || kind === "google-news-redirect") {
      googleRedirects += 1;
    } else if (kind === "direct") {
      directLinks += 1;
    } else {
      invalidLinks += 1;
    }

    const canonical = canonicalNewsUrl(link);
    if (canonical) {
      if (seen.has(canonical)) duplicates += 1;
      else seen.add(canonical);
    }

    const host = newsPublisherHost(link);
    if (host) {
      knownSources += isKnownSource(host, spec.region) ? 1 : 0;
      sources.add(item.source?.trim().toLowerCase() || host);
    } else if (item.source?.trim()) {
      sources.add(item.source.trim().toLowerCase());
    }

    const fresh = item.date
      ? isSerperDateFresh(item.date, now, locale, FRESH_HOURS)
      : undefined;
    if (fresh === undefined) {
      unknownAge += 1;
    } else {
      const date = parseSerperRelativeDate(item.date!, now, locale);
      if (date) {
        oldestAgeHours = Math.max(oldestAgeHours, (now.getTime() - date.getTime()) / 3_600_000);
      }
      if (fresh) fresh24h += 1;
    }
  }

  const uniqueItems = seen.size;
  return {
    items: news.length,
    uniqueItems,
    duplicates,
    duplicateRate: uniqueItems + duplicates > 0 ? duplicates / (uniqueItems + duplicates) : null,
    uniqueSources: sources.size,
    knownShare: pct(knownSources, directLinks),
    knownSources,
    directLinks,
    googleRedirects,
    invalidLinks,
    fresh24h,
    freshShare: pct(fresh24h, news.length),
    unknownAge,
    oldestAgeHours: oldestAgeHours || null,
  };
}

async function runSerperQuery(spec: QuerySpec, now: Date): Promise<QueryResult> {
  try {
    const raw = await performSerperNewsSearch(spec.query, {
      count: NEWS_COUNT,
      region: REGION_ALIAS[spec.region],
      timeoutMs: SERPER_TIMEOUT_MS,
    });
    const payload = JSON.parse(raw) as SerperNewsPayload;
    const credits =
      typeof payload.credits === "number" && Number.isFinite(payload.credits)
        ? payload.credits
        : 1;
    const metrics = analyzeSerper(spec, payload, now);
    console.log(
      `news-compare: ${spec.id} ${metrics.items} items, ${metrics.fresh24h} fresh, ` +
        `${metrics.googleRedirects} redirect(s), ${credits} credit(s)`,
    );
    return { spec, metrics, credits };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`WARN [news-compare] ${spec.id} failed: ${message}`);
    return { spec, metrics: null, credits: 0, error: message };
  }
}

function row(result: QueryResult): string {
  const m = result.metrics;
  if (!m) {
    return `| ${result.spec.id} | ${result.spec.query} | ${result.spec.region} | — | — | — | — | — | — | — | 0 | ${result.error ?? "failed"} |`;
  }
  return (
    `| ${result.spec.id} | ${result.spec.query} | ${result.spec.region} | ${m.items} | ` +
    `${m.uniqueSources} | ${fmtPct(m.knownShare)} | ${fmtRate(m.duplicateRate)} | ` +
    `${fmtPct(m.freshShare)} (${m.fresh24h}) | ${m.unknownAge} | ${m.googleRedirects} | ` +
    `${result.credits} |`
  );
}

function regionSummary(results: readonly QueryResult[]): string {
  const regions: RegionKey[] = ["by", "ru", "ua", "us", "de", "world"];
  return regions
    .map((region) => {
      const rows = results.filter((r) => r.spec.region === region && r.metrics);
      if (rows.length === 0) return `- **${region}**: no successful queries`;
      const items = rows.reduce((sum, r) => sum + r.metrics!.items, 0);
      const fresh = rows.reduce((sum, r) => sum + r.metrics!.fresh24h, 0);
      const unknown = rows.reduce((sum, r) => sum + r.metrics!.unknownAge, 0);
      const known = rows.reduce((sum, r) => sum + r.metrics!.knownSources, 0);
      const direct = rows.reduce((sum, r) => sum + r.metrics!.directLinks, 0);
      return (
        `- **${region}**: ${rows.length} queries, ${items} items, ` +
        `fresh ${fmtPct(pct(fresh, items))}, unknown-age ${unknown}, ` +
        `known-outlet ${fmtPct(pct(known, direct))}`
      );
    })
    .join("\n");
}

function buildReport(
  results: readonly QueryResult[],
  local: LocalSnapshot | null,
  generatedAt: Date,
): string {
  const credits = results.reduce((sum, r) => sum + r.credits, 0);
  const failures = results.filter((r) => r.error);
  const providerCalls = local?.providerCalls ?? 0;
  const successful = results.filter((r) => r.metrics);
  const totalItems = successful.reduce((sum, r) => sum + r.metrics!.items, 0);
  const directLinks = successful.reduce((sum, r) => sum + r.metrics!.directLinks, 0);
  const redirectLinks = successful.reduce((sum, r) => sum + r.metrics!.googleRedirects, 0);

  const localTable = local
    ? [
        "| Source | Items | Fresh <24h | Unknown age |",
        "|---|---:|---:|---:|",
        ...local.perSource.map(
          (s) => `| ${s.source} | ${s.items} | ${s.fresh24h} | ${s.unknownAge} |`,
        ),
        `| **total** | **${local.metrics.items}** | **${local.metrics.fresh24h}** | **${local.metrics.unknownAge}** |`,
      ].join("\n")
    : "_The local `search_news` feed is Belarus-only; no baseline was collected._";

  const localErrors =
    local && local.errors.length > 0
      ? local.errors
          .map((e) => `- ${e.source}: ${e.status}${e.message ? ` — ${e.message}` : ""}`)
          .join("\n")
      : "- none";

  return `# Serper News vs local \`search_news\` — comparison

Generated: ${generatedAt.toISOString()}
Queries: ${results.length} (${failures.length} failed)
Serper credits spent: ${credits}
Content-provider calls for local SSR feeds: ${providerCalls}

## Method

- Every query was sent to \`performSerperNewsSearch\` (\`POST google.serper.dev/news\`) with
  an explicit region (${Object.entries(REGION_ALIAS).map(([k, v]) => `\`${k}\`→\`${v}\``).join(", ")}).
- \`search_news\` is a Belarus-only fixed feed; it was run once without a content
  provider and its metrics are reused as the baseline for every \`by\` row. Other
  regions have no local feed — that is the point of the comparison.
- **Fresh <24h** is the share of items whose date parses to < 24 h old.
  Unparseable dates are counted under **Unknown age** (never assumed fresh).
- **Known-outlet share** = direct publisher links whose host belongs to the
  region's outlet list (or the country TLD); Google wrappers are excluded.
- **Dup rate** = duplicate canonical URLs / all canonical URLs (tracking
  parameters and hash removed).
- \`count\` is a request, not a guarantee: Serper sometimes returns more items
  than \`num\`, so the table reports the actual item count.
- Credits are the \`credits\` value from Serper's body when present, otherwise 1
  per successful request.

## Serper News results

| Query id | Query | Region | Items | Sources | Known outlet | Dup rate | Fresh <24h | Unknown age | Google redirects | Credits |
|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
${results.map(row).join("\n")}

### By region

${regionSummary(results)}

## Local \`search_news\` baseline (Belarus)

${localTable}

Open-source errors during the local run:

${localErrors}

Local feed fresh share: **${local ? fmtPct(local.metrics.freshShare) : "n/a"}**
(${local?.metrics.fresh24h ?? 0} of ${local?.metrics.items ?? 0}; unknown age ${local?.metrics.unknownAge ?? 0}).

## Payload shape (illustrative, not a captured response)

\`\`\`json
{
  "news": [
    {
      "title": "…",
      "link": "https://publisher.example/article",
      "snippet": "…",
      "date": "16 hours ago",
      "source": "Publisher",
      "imageUrl": "https://publisher.example/image.jpg"
    }
  ],
  "credits": 1
}
\`\`\`

Redirect wrappers seen in the wild:

- \`https://google.com/goto?url=…\` — \`google-redirect\`; unwrap \`url\` when
  possible, otherwise never cite it.
- \`https://news.google.com/rss/articles/…\` — \`google-news-redirect\`; usually
  not resolvable without a browser, so treat the item as non-citable.

## Observations

- Failures: ${failures.length === 0 ? "none" : failures.map((f) => `\`${f.spec.id}\``).join(", ")}.
- Content-provider calls: ${providerCalls} (expected 0 for SSR feeds).
- Serper credits: ${credits} for ${results.length} queries.
- Link citability: **${directLinks} of ${totalItems}** items (${fmtPct(pct(directLinks, totalItems))})
  carried a direct publisher URL; **${redirectLinks}** (${fmtPct(pct(redirectLinks, totalItems))})
  were Google redirect wrappers. A wrapper must be resolved with \`fetch_url\`
  (the fetched document now reports the final publisher URL in its \`Source:\`
  line) or dropped — never cited.
- Item count is not bounded by \`num\`: several queries returned 13–26 items for
  \`count: 10\`, so the model must not assume a fixed digest size.

## Decision

_Filled in Task 5 after reviewing this report._
`;
}

async function main(): Promise<void> {
  if (!process.env.SERPER_API_KEY) {
    console.error(
      "ERROR [news-compare] SERPER_API_KEY is missing (checked cwd .env and repo-root .env)",
    );
    process.exitCode = 1;
    return;
  }

  const generatedAt = new Date();
  const results: QueryResult[] = [];

  for (const spec of QUERIES) {
    results.push(await runSerperQuery(spec, generatedAt));
  }

  const successes = results.filter((r) => r.metrics);
  if (successes.length === 0) {
    console.error("ERROR [news-compare] every Serper query failed; no report written");
    process.exitCode = 1;
    return;
  }

  const local = await runLocalBaseline();

  const report = buildReport(results, local, generatedAt);
  await mkdir(dirname(REPORT_PATH), { recursive: true });
  await writeFile(REPORT_PATH, report, "utf-8");

  const credits = results.reduce((sum, r) => sum + r.credits, 0);
  console.log(
    `news-compare: ${successes.length}/${results.length} queries, ${credits} Serper credit(s), ` +
      `${local.providerCalls} provider call(s). Report: ${REPORT_PATH}`,
  );
}

await main();
