import { fetchPageAsMarkdown, type PageParser } from "../fetch.js";
import { FETCH_LIMITS } from "../config.js";
import { webChild } from "../logger.js";
import {
  isRabotaByVacancyUrl,
  isRabotaBySearchUrl,
  extractRabotaByVacancyContent,
  extractRabotaBySearchContent,
} from "./rabota-page.js";

const log = webChild("rabota");

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

export const rabotaPageParsers: PageParser[] = [
  { match: isRabotaByVacancyUrl, extract: extractRabotaByVacancyContent },
  { match: isRabotaBySearchUrl, extract: extractRabotaBySearchContent },
];

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RabotaSearchParams {
  text: string;
  area?: string;
  experience?: string;
  education?: string;
  schedule?: string;
  employment?: string;
  salary?: number;
  only_with_salary?: boolean;
  order_by?: string;
  page?: number;
}

// ---------------------------------------------------------------------------
// City slug -> area ID mapping
// ---------------------------------------------------------------------------

const AREA_MAP: Record<string, string> = {
  minsk: "1002",
  brest: "1007",
  vitebsk: "1005",
  gomel: "1003",
  grodno: "1006",
  mogilev: "1004",
};

const BELARUS_AREA = "16";

// ---------------------------------------------------------------------------
// URL builder
// ---------------------------------------------------------------------------

function buildRabotaUrl(params: RabotaSearchParams): string {
  const qp = new URLSearchParams();

  qp.set("text", params.text);

  if (params.area) {
    const areaId = AREA_MAP[params.area.toLowerCase()];
    if (!areaId) {
      const available = Object.keys(AREA_MAP).join(", ");
      throw new Error(`Unknown area "${params.area}". Available: ${available}`);
    }
    qp.set("area", areaId);
  } else {
    qp.set("area", BELARUS_AREA);
  }

  if (params.experience) {
    qp.set("experience", params.experience);
  }

  if (params.education) {
    qp.set("education", params.education);
  }

  if (params.schedule) {
    qp.set("schedule", params.schedule);
  }

  if (params.employment) {
    qp.set("employment", params.employment);
  }

  if (params.salary != null) {
    qp.set("salary", String(params.salary));
  }

  if (params.only_with_salary) {
    qp.set("only_with_salary", "true");
  }

  if (params.order_by) {
    qp.set("order_by", params.order_by);
  }

  if (params.page != null && params.page > 0) {
    qp.set("page", String(params.page - 1));
  }

  return `https://rabota.by/search/vacancy?${qp.toString()}`;
}

// ---------------------------------------------------------------------------
// Search function
// ---------------------------------------------------------------------------

export async function rabotaSearch(
  params: RabotaSearchParams,
  deps: WebDeps = {},
): Promise<string> {
  const url = buildRabotaUrl(params);
  const timeoutMs = deps.timeoutMs ?? FETCH_LIMITS.timeoutMs;
  const started = Date.now();
  log.debug({ url }, "rabota: fetch");
  try {
    const md = await fetchPageAsMarkdown(url, timeoutMs, {
      fetchFn: deps.fetchFn,
      pageParsers: rabotaPageParsers,
    });
    log.debug({ url, len: md.length, elapsedMs: Date.now() - started }, "rabota: done");
    return md;
  } catch (err) {
    log.warn(
      { url, err: (err as Error).message, elapsedMs: Date.now() - started },
      "rabota: failed",
    );
    throw err;
  }
}
