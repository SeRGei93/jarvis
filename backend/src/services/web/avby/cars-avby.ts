import { JSDOM } from "jsdom";

export interface AvByBrand {
  id: number;
  name: string;
  slug: string;
  count?: number;
}

export interface AvByModel {
  id: number;
  name: string;
}

export interface AvByFilterOption {
  id?: number;
  label: string;
}

export interface AvByFilterBase {
  name: string;
  label: string;
  valueFormat: string;
  param: string;
  example: string;
}

export interface AvByFilterRange extends AvByFilterBase {
  valueFormat: "range";
  min?: number;
  max?: number;
}

export interface AvByFilterEnum extends AvByFilterBase {
  valueFormat: "array" | "value";
  options: AvByFilterOption[];
}

export type AvByFilter = AvByFilterRange | AvByFilterEnum;

export interface AvBySortOption {
  id: number;
  label: string;
}

export interface AvByFiltersResult {
  url_format: {
    base: string;
    params: {
      brands: string;
      range: string;
      array: string;
      value: string;
      sort: string;
      page: string;
    };
    examples: string[];
  };
  sorting: AvBySortOption[];
  filters: AvByFilter[];
}

function extractNextData(html: string): Record<string, unknown> | null {
  const m = html.match(/id="__NEXT_DATA__"[^>]*>(.*?)<\/script>/);
  if (!m) return null;
  try {
    return JSON.parse(m[1]) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function getPropertyMap(nextData: Record<string, unknown>): Record<string, unknown> | null {
  const props = nextData.props as Record<string, unknown> | undefined;
  const initialState = props?.initialState as Record<string, unknown> | undefined;
  const properties = initialState?.properties as Record<string, unknown> | undefined;
  const main = properties?.main as Record<string, unknown> | undefined;
  return (main?.propertyMap as Record<string, unknown>) ?? null;
}

/** Parse count string like "3 915" → 3915 */
function parseCount(text: string): number {
  const n = parseInt(text.replace(/\s/g, ""), 10);
  return isNaN(n) ? 0 : n;
}

/** Generate slug from brand name: "Alfa Romeo" → "alfa-romeo", "Lada (ВАЗ)" → "lada-vaz" */
function generateSlug(name: string): string {
  // Transliterate Cyrillic
  const cyr: Record<string, string> = {
    а:"a",б:"b",в:"v",г:"g",д:"d",е:"e",ё:"yo",ж:"zh",з:"z",и:"i",й:"y",
    к:"k",л:"l",м:"m",н:"n",о:"o",п:"p",р:"r",с:"s",т:"t",у:"u",ф:"f",
    х:"kh",ц:"ts",ч:"ch",ш:"sh",щ:"shch",ъ:"",ы:"y",ь:"",э:"e",ю:"yu",я:"ya",
  };
  const result = name
    .toLowerCase()
    .split("")
    .map((c) => cyr[c] ?? c)
    .join("")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return result || name.toLowerCase();
}

export function parseAvByBrands(html: string): AvByBrand[] {
  // Collect counts and slugs from HTML catalog
  const countMap = new Map<string, { slug: string; count: number }>();
  const dom = new JSDOM(html);
  const doc = dom.window.document;
  doc.querySelectorAll(".catalog__item").forEach((item) => {
    const link = item.querySelector(".catalog__link") as HTMLAnchorElement | null;
    const titleEl = item.querySelector(".catalog__title");
    const countEl = item.querySelector(".catalog__count");
    if (!link || !titleEl) return;
    const name = titleEl.textContent?.trim() ?? "";
    const href = link.getAttribute("href") ?? "";
    const slug = href.replace(/^\//, "").replace(/\/$/, "");
    const count = parseCount(countEl?.textContent?.trim() ?? "0");
    countMap.set(name, { slug, count });
  });

  // Full brand list from __NEXT_DATA__, enriched with HTML data
  const brands: AvByBrand[] = [];
  const nextData = extractNextData(html);
  if (nextData) {
    const pm = getPropertyMap(nextData);
    if (pm) {
      const brandsObj = pm.brands as Record<string, unknown> | undefined;
      const value = brandsObj?.value as Array<Record<string, unknown>> | undefined;
      const brandProp = value?.[0]?.brand as Record<string, unknown> | undefined;
      const options = brandProp?.options as Array<{ id: number; label: string }> | undefined;
      if (options) {
        for (const opt of options) {
          const htmlData = countMap.get(opt.label);
          brands.push({
            id: opt.id,
            name: opt.label,
            slug: htmlData?.slug || generateSlug(opt.label),
            ...(htmlData && { count: htmlData.count }),
          });
        }
      }
    }
  }

  return brands;
}

export function parseAvByModels(html: string): AvByModel[] {
  const nextData = extractNextData(html);
  if (!nextData) return [];

  const pm = getPropertyMap(nextData);
  if (!pm) return [];

  const brands = pm.brands as Record<string, unknown> | undefined;
  const value = brands?.value as Array<Record<string, unknown>> | undefined;
  const modelObj = value?.[0]?.model as Record<string, unknown> | undefined;
  const options = modelObj?.options as Array<{ id: number; label: string }> | undefined;
  if (!options) return [];

  return options.map((opt) => ({ id: opt.id, name: opt.label }));
}

/** Properties to skip in filter output (handled separately or internal) */
const SKIP_FILTER_KEYS = new Set([
  "brands",
  "price_compound_on_filter_form",
  "description",
  "video_url",
  "has_photo360",
  "has_nds",
  "has_exchange",
  "vin_indicated",
  "in_stock",
  "registration_status_deregistered",
  "ground_clearance",
  "organization",
  "creation_date",
  "registration_country",
  "options",
]);

const BASE_URL = "https://cars.av.by/filter";

/** Build URL param pattern for a given filter key and valueFormat */
function buildParamPattern(key: string, valueFormat: string): string {
  if (valueFormat === "range") return `${key}[min]=VALUE&${key}[max]=VALUE`;
  if (valueFormat === "array") return `${key}[0]=ID&${key}[1]=ID`;
  return `${key}=VALUE`;
}

/** Sensible example values for range filters without predefined options */
const RANGE_EXAMPLES: Record<string, [number, number]> = {
  price_byn: [5000, 50000],
  price_usd: [5000, 30000],
  engine_power_hp: [100, 300],
  mixed_driving_fuel_consumption_per_100_km: [4, 10],
  engine_endurance: [200, 500],
};

/** Build a full example URL for a filter */
function buildExample(
  key: string,
  valueFormat: string,
  options: Array<Record<string, unknown>>,
  min?: number,
  max?: number,
): string {
  const brand = "brands[0][brand]=6";
  if (valueFormat === "range") {
    const fallback = RANGE_EXAMPLES[key];
    const lo = min ?? fallback?.[0] ?? 0;
    const hi = max ?? fallback?.[1] ?? lo;
    return `${BASE_URL}?${brand}&${key}[min]=${lo}&${key}[max]=${hi}`;
  }
  if (valueFormat === "array" && options.length > 0) {
    const first = options[0].id as number;
    return `${BASE_URL}?${brand}&${key}[0]=${first}`;
  }
  if (options.length > 0) {
    const first = options[0].id as number;
    return `${BASE_URL}?${brand}&${key}=${first}`;
  }
  return `${BASE_URL}?${brand}&${key}=VALUE`;
}

function extractSortingOptions(nextData: Record<string, unknown>): AvBySortOption[] {
  const initialState = (nextData.props as Record<string, unknown>)
    ?.initialState as Record<string, unknown> | undefined;
  const filter = initialState?.filter as Record<string, unknown> | undefined;
  const main = filter?.main as Record<string, unknown> | undefined;
  const opts = main?.sortingOptions as Array<{ id: number; label: string }> | undefined;
  return opts?.map((o) => ({ id: o.id, label: o.label })) ?? [];
}

export function parseAvByFilters(html: string): AvByFiltersResult {
  const empty: AvByFiltersResult = {
    url_format: { base: "https://cars.av.by/filter", params: {
      brands: "brands[N][brand]=BRAND_ID&brands[N][model]=MODEL_ID&brands[N][generation]=GEN_ID",
      range: "FILTER_NAME[min]=VALUE&FILTER_NAME[max]=VALUE",
      array: "FILTER_NAME[0]=OPTION_ID&FILTER_NAME[1]=OPTION_ID",
      value: "FILTER_NAME=VALUE",
      sort: "sort=SORT_ID",
      page: "page=PAGE_NUMBER",
    }, examples: [] },
    sorting: [],
    filters: [],
  };

  const nextData = extractNextData(html);
  if (!nextData) return empty;

  const pm = getPropertyMap(nextData);
  if (!pm) return empty;

  const sorting = extractSortingOptions(nextData);

  const filters: AvByFilter[] = [];

  for (const [key, rawVal] of Object.entries(pm)) {
    if (SKIP_FILTER_KEYS.has(key)) continue;

    const val = rawVal as Record<string, unknown>;
    const label = (val.label as string) ?? "";
    const valueFormat = (val.valueFormat as string) ?? "";
    const rawOptions = val.options as Array<Record<string, unknown>> | undefined;

    if (!label) continue;

    const param = buildParamPattern(key, valueFormat);

    if (valueFormat === "range") {
      const ids = (rawOptions ?? [])
        .map((o) => o.id as number | undefined)
        .filter((id): id is number => id != null);
      const min = ids.length > 0 ? Math.min(...ids) : undefined;
      const max = ids.length > 0 ? Math.max(...ids) : undefined;
      filters.push({
        name: key,
        label,
        valueFormat,
        param,
        example: buildExample(key, valueFormat, rawOptions ?? [], min, max),
        ...(min != null && { min }),
        ...(max != null && { max }),
      });
    } else {
      const options: AvByFilterOption[] = [];
      if (rawOptions) {
        for (const opt of rawOptions) {
          options.push({
            id: opt.id as number | undefined,
            label: (opt.label as string) ?? "",
          });
        }
      }
      filters.push({
        name: key,
        label,
        valueFormat: valueFormat as "array" | "value",
        param,
        example: buildExample(key, valueFormat, rawOptions ?? []),
        options,
      });
    }
  }

  return {
    url_format: {
      base: "https://cars.av.by/filter",
      params: {
        brands: "brands[N][brand]=BRAND_ID&brands[N][model]=MODEL_ID&brands[N][generation]=GEN_ID",
        range: "FILTER_NAME[min]=VALUE&FILTER_NAME[max]=VALUE",
        array: "FILTER_NAME[0]=OPTION_ID&FILTER_NAME[1]=OPTION_ID",
        value: "FILTER_NAME=VALUE",
        sort: "sort=SORT_ID",
        page: "page=PAGE_NUMBER",
      },
      examples: [
        "https://cars.av.by/filter?brands[0][brand]=6&brands[0][model]=1428&year[min]=2018&year[max]=2024&price_usd[max]=30000",
        "https://cars.av.by/filter?brands[0][brand]=6&engine_type[0]=1&engine_type[1]=5&transmission_type[0]=1",
        "https://cars.av.by/filter?brands[0][brand]=8&brands[1][brand]=6&sort=2&page=2",
      ],
    },
    sorting,
    filters,
  };
}
