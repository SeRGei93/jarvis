import { mkdir, readFile, writeFile } from "fs/promises";
import { existsSync } from "fs";
import { join, dirname } from "path";
import { JSDOM } from "jsdom";
import { extractGismeteoContent } from "../parsers/gismeteo.js";
import { fetchRawHtml } from "../fetch.js";
import { FETCH_LIMITS } from "../config.js";
import { webChild } from "../logger.js";

const log = webChild("weather");

/** Injectable network dependencies (no network in tests). */
export interface WebDeps {
  fetchFn?: typeof globalThis.fetch;
  timeoutMs?: number;
}

const ROW_LABELS: Record<string, string> = {
  "icon-tooltip": "Погода",
  "temperature-air": "Температура, °C",
  "temperature-heat-index": "Ощущается, °C",
  "wind": "Ветер (порывы), м/с",
  "precipitation-bars": "Осадки, мм",
  "icon-snow": "Снег, см",
  "pressure": "Давление, мм рт.ст.",
  "humidity": "Влажность, %",
  "radiation": "УФ-индекс",
  "geomagnetic": "Геомагнитная активность",
};

/** Converts cleaned gismeteo HTML into a flat accessibility-tree-like text */
function htmlToA11yTree(html: string): string {
  const dom = new JSDOM(html);
  const body = dom.window.document.body;
  const lines: string[] = [];

  function txt(node: Node): string {
    return (node.textContent ?? "").replace(/\s+/g, " ").trim();
  }

  function walk(el: Element): void {
    if (!txt(el)) return;
    if (el.classList.contains("is-hide")) return;

    const tag = el.tagName;

    // Headings
    const hm = tag.match(/^H(\d)$/i);
    if (hm) {
      lines.push(`- heading "${txt(el)}" [level=${hm[1]}]`);
      return;
    }

    // Paragraphs inside widget-rows are handled below — skip stray ones
    if (tag === "P") return;

    // Widget rows → single labeled line
    if (el.classList.contains("widget-row")) {
      const dataRow = el.getAttribute("data-row");
      if (el.querySelector(".row-item-nodata")) return;
      if (dataRow === "snow-height") return; // CSS-positioned values, unreadable as text

      const label = (dataRow && ROW_LABELS[dataRow])
        || txt(el.querySelector(".widget-row-caption") as Node ?? { textContent: "" });

      // Weather condition icons → tooltips
      if (dataRow === "icon-tooltip") {
        const vals = [...el.querySelectorAll("[data-tooltip]")]
          .map(i => i.getAttribute("data-tooltip")).filter(Boolean);
        if (vals.length) lines.push(`- ${label || "text"}: ${vals.join(" | ")}`);
        return;
      }

      // Chart values (.value elements) — handle maxt/mint for 10-day forecasts
      const chartVals = [...el.querySelectorAll(".chart .value")].map(i => {
        const maxt = i.querySelector(".maxt");
        const mint = i.querySelector(".mint");
        if (maxt && mint) return `${txt(maxt)}/${txt(mint)}`;
        return txt(i);
      }).filter(Boolean);
      if (chartVals.length) {
        lines.push(`- ${label || "text"}: ${chartVals.join(" | ")}`);
        return;
      }

      // Row items
      const items = [...el.querySelectorAll(".row-item")].map(i => txt(i)).filter(Boolean);
      if (items.length) {
        lines.push(`- ${label || "text"}: ${items.join(" | ")}`);
        return;
      }

      // Fallback — raw text (may be concatenated for some chart types like snow-height)
      const t = txt(el);
      if (t) lines.push(`- ${label || "text"}: ${t}`);
      return;
    }

    // Generic container — recurse
    for (const child of el.children) {
      walk(child);
    }
  }

  walk(body);
  dom.window.close();
  return lines.join("\n");
}

export interface City {
  name: string;
  path: string;
}

export const CITIES: Record<string, City> = {
  // Областные центры
  minsk:        { name: "Минск",        path: "/weather-minsk-4248/" },
  gomel:        { name: "Гомель",       path: "/weather-gomel-4918/" },
  grodno:       { name: "Гродно",       path: "/weather-grodno-4243/" },
  brest:        { name: "Брест",        path: "/weather-brest-4912/" },
  vitebsk:      { name: "Витебск",      path: "/weather-vitebsk-4218/" },
  mogilev:      { name: "Могилёв",      path: "/weather-mogilev-4251/" },
  // Крупные города
  bobruisk:     { name: "Бобруйск",     path: "/weather-bobruysk-4064/" },
  baranovichi:  { name: "Барановичи",   path: "/weather-baranovichi-4263/" },
  borisov:      { name: "Борисов",      path: "/weather-borisov-4235/" },
  pinsk:        { name: "Пинск",        path: "/weather-pinsk-4914/" },
  orsha:        { name: "Орша",         path: "/weather-orsha-4236/" },
  mozyr:        { name: "Мозырь",       path: "/weather-mozyr-4916/" },
  soligorsk:    { name: "Солигорск",    path: "/weather-soligorsk-11817/" },
  novopolotsk:  { name: "Новополоцк",   path: "/weather-novopolotsk-11026/" },
  lida:         { name: "Лида",         path: "/weather-lida-4244/" },
  molodechno:   { name: "Молодечно",    path: "/weather-molodechno-11818/" },
  polotsk:      { name: "Полоцк",       path: "/weather-polotsk-4215/" },
  zhlobin:      { name: "Жлобин",       path: "/weather-zhlobin-4267/" },
  svetlogorsk:  { name: "Светлогорск",  path: "/weather-svetlogorsk-11807/" },
  rechitsa:     { name: "Речица",       path: "/weather-rechytsa-11808/" },
  slutsk:       { name: "Слуцк",        path: "/weather-slutsk-4266/" },
  zhodino:      { name: "Жодино",       path: "/weather-zhodino-11949/" },
  kalinkovichi: { name: "Калинковичи",  path: "/weather-kalinkovichi-11015/" },
};

export interface Period {
  name: string;
  suffix: string;
}

export const PERIODS: Record<string, Period> = {
  today:    { name: "Сегодня",    suffix: "" },
  tomorrow: { name: "Завтра",     suffix: "tomorrow/" },
  "3-days": { name: "3 дня",      suffix: "3-days/" },
  weekend:  { name: "Выходные",   suffix: "weekend/" },
  "10-days":{ name: "10 дней",    suffix: "10-days/" },
};

const BASE_URL = "https://www.gismeteo.by";
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
const CACHE_DIR =
  process.env.WEATHER_CACHE_DIR ??
  (process.env.FETCH_CACHE_DIR
    ? join(dirname(process.env.FETCH_CACHE_DIR), "weather")
    : join(process.cwd(), ".cache", "weather"));

async function ensureCacheDir(): Promise<void> {
  if (!existsSync(CACHE_DIR)) {
    await mkdir(CACHE_DIR, { recursive: true });
  }
}

function getCacheFilePath(slug: string, periodSlug: string): string {
  return join(CACHE_DIR, `${slug}_${periodSlug}.json`);
}

async function readCache(slug: string, periodSlug: string): Promise<string | null> {
  const filePath = getCacheFilePath(slug, periodSlug);
  if (!existsSync(filePath)) return null;
  try {
    const raw = await readFile(filePath, "utf-8");
    const { expiresAt, data } = JSON.parse(raw) as { expiresAt: number; data: string };
    if (Date.now() < expiresAt) return data;
    return null;
  } catch {
    return null;
  }
}

async function writeCache(slug: string, periodSlug: string, data: string): Promise<void> {
  await ensureCacheDir();
  const filePath = getCacheFilePath(slug, periodSlug);
  await writeFile(filePath, JSON.stringify({ expiresAt: Date.now() + CACHE_TTL_MS, data }), "utf-8");
}

export async function fetchWeather(
  slug: string,
  periodSlug: string,
  deps: WebDeps = {},
): Promise<string> {
  const city = CITIES[slug];
  if (!city) {
    throw new Error(`Unknown city: ${slug}. Available: ${Object.keys(CITIES).join(", ")}`);
  }

  const period = PERIODS[periodSlug];
  if (!period) {
    throw new Error(`Unknown period: ${periodSlug}. Available: ${Object.keys(PERIODS).join(", ")}`);
  }

  const cached = await readCache(slug, periodSlug);
  if (cached) {
    log.debug({ slug, periodSlug }, "weather: cache hit");
    return cached;
  }

  const url = `${BASE_URL}${city.path}${period.suffix}`;
  const timeoutMs = deps.timeoutMs ?? FETCH_LIMITS.timeoutMs;
  const started = Date.now();
  log.debug({ url }, "weather: fetch");

  let html: string;
  try {
    // Route through fetchRawHtml for SSRF-guard consistency + injectable fetch.
    html = await fetchRawHtml(url, timeoutMs, { fetchFn: deps.fetchFn });
  } catch (err) {
    log.warn(
      { url, err: (err as Error).message, elapsedMs: Date.now() - started },
      "weather: failed",
    );
    throw err;
  }

  const result = extractGismeteoContent(html);

  if (!result) {
    log.warn({ url, elapsedMs: Date.now() - started }, "weather: parse failed");
    throw new Error(`Failed to parse weather data for ${city.name} (${period.name})`);
  }

  const data = `# ${city.name} — ${period.name}\n\n${htmlToA11yTree(result.html)}`;
  await writeCache(slug, periodSlug, data);
  log.debug(
    { url, len: data.length, elapsedMs: Date.now() - started },
    "weather: done",
  );

  return data;
}
