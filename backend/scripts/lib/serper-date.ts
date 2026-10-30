/**
 * Date parsing for Serper News `news[].date` values.
 *
 * Google News returns human, locale-dependent dates ("16 hours ago",
 * "20 авг. 2026 г.", "vor 5 Stunden", "2 тижні тому"). This module turns them
 * into real `Date`s so the comparison harness can compute a freshness metric.
 * Unknown/unsupported phrases return `undefined` — callers must report them as
 * `unknown-age` instead of silently treating them as fresh.
 *
 * Pure functions, no I/O: safe to unit-test and reuse.
 */

export type SerperLocale = "ru" | "en" | "de" | "uk";

const LOCALES: readonly SerperLocale[] = ["ru", "en", "de", "uk"];

/** Month names (full + common abbreviations), indexed by zero-based month. */
const MONTHS: Record<SerperLocale, Record<string, number>> = {
  ru: {
    янв: 0, январь: 0, января: 0,
    фев: 1, февраль: 1, февраля: 1,
    мар: 2, март: 2, марта: 2,
    апр: 3, апрель: 3, апреля: 3,
    май: 4, мая: 4,
    июн: 5, июнь: 5, июня: 5,
    июл: 6, июль: 6, июля: 6,
    авг: 7, август: 7, августа: 7,
    сен: 8, сент: 8, сентябрь: 8, сентября: 8,
    окт: 9, октябрь: 9, октября: 9,
    ноя: 10, нояб: 10, ноябрь: 10, ноября: 10,
    дек: 11, декабрь: 11, декабря: 11,
  },
  en: {
    jan: 0, january: 0,
    feb: 1, february: 1,
    mar: 2, march: 2,
    apr: 3, april: 3,
    may: 4,
    jun: 5, june: 5,
    jul: 6, july: 6,
    aug: 7, august: 7,
    sep: 8, sept: 8, september: 8,
    oct: 9, october: 9,
    nov: 10, november: 10,
    dec: 11, december: 11,
  },
  de: {
    jan: 0, januar: 0,
    feb: 1, februar: 1,
    mär: 2, märz: 2, maerz: 2,
    apr: 3, april: 3,
    mai: 4,
    jun: 5, juni: 5,
    jul: 6, juli: 6,
    aug: 7, august: 7,
    sep: 8, sept: 8, september: 8,
    okt: 9, oktober: 9,
    nov: 10, november: 10,
    dez: 11, dezember: 11,
  },
  uk: {
    січ: 0, січень: 0, січня: 0,
    лют: 1, лютий: 1, лютого: 1,
    бер: 2, березень: 2, березня: 2,
    квіт: 3, квітень: 3, квітня: 3,
    трав: 4, травень: 4, травня: 4,
    черв: 5, червень: 5, червня: 5,
    лип: 6, липень: 6, липня: 6,
    серп: 7, серпень: 7, серпня: 7,
    вер: 8, вересень: 8, вересня: 8,
    жовт: 9, жовтень: 9, жовтня: 9,
    лист: 10, листопад: 10, листопада: 10,
    груд: 11, грудень: 11, грудня: 11,
  },
};

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const WEEK_MS = 7 * DAY_MS;
/** Approximate; only used for a freshness bucket, never for exact scheduling. */
const MONTH_MS = 30 * DAY_MS;
const YEAR_MS = 365 * DAY_MS;

/** Normalise case/whitespace and strip list/decoration prefixes. */
function normalize(input: string): string {
  return input
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\u00a0/g, " ")
    .replace(/^[\s·•*\-–—]+/, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Strip a trailing dot from a month token ("авг." → "авг"). */
function monthToken(token: string): string {
  return token.replace(/\.+$/, "");
}

function monthNumber(token: string, locales: readonly SerperLocale[]): number | undefined {
  const clean = monthToken(token);
  for (const locale of locales) {
    const hit = MONTHS[locale][clean];
    if (hit !== undefined) return hit;
    // Abbreviation fallback: first three letters are unique within a locale.
    const short = clean.slice(0, 3);
    const shortHit = MONTHS[locale][short];
    if (shortHit !== undefined && clean.length >= 3 && clean.length <= short.length + 1) {
      return shortHit;
    }
  }
  return undefined;
}

/** Build a local-time Date from calendar parts; `undefined` if invalid. */
function makeDate(
  year: number,
  month: number,
  day: number,
  hour = 0,
  minute = 0,
  second = 0,
): Date | undefined {
  if (year < 1990 || year > 2100) return undefined;
  if (month < 0 || month > 11) return undefined;
  if (day < 1 || day > 31) return undefined;
  const date = new Date(year, month, day, hour, minute, second);
  // Reject overflow (e.g. 31 February → 3 March).
  if (date.getFullYear() !== year || date.getMonth() !== month || date.getDate() !== day) {
    return undefined;
  }
  return date;
}

/** Parse ISO (`2026-10-29T10:00:00Z`) and ISO-date-only values. */
function parseIso(text: string): Date | undefined {
  const match = text.match(
    /^(\d{4})-(\d{2})-(\d{2})(?:[t ](\d{1,2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?(?:z|[+-]\d{2}:?\d{2})?)?$/,
  );
  if (!match) return undefined;
  const [, y, mo, d, h, mi, s] = match;
  return makeDate(
    Number(y),
    Number(mo) - 1,
    Number(d),
    h ? Number(h) : 0,
    mi ? Number(mi) : 0,
    s ? Number(s) : 0,
  );
}

/** Parse `DD.MM.YYYY` / `DD/MM/YYYY` (European order). */
function parseDotted(text: string): Date | undefined {
  const match = text.match(/^(\d{1,2})[./](\d{1,2})[./](\d{4})$/);
  if (!match) return undefined;
  return makeDate(Number(match[3]), Number(match[2]) - 1, Number(match[1]));
}

/** Parse "20 авг. 2026 г." / "20. Aug. 2026" / "20 August 2026". */
function parseDayMonthYear(text: string, locales: readonly SerperLocale[]): Date | undefined {
  const match = text.match(/(\d{1,2})\.?\s+([a-zа-яёіїєґäöüß]+)\.?,?\s+(\d{4})/u);
  if (!match) return undefined;
  const month = monthNumber(match[2]!, locales);
  if (month === undefined) return undefined;
  return makeDate(Number(match[3]), month, Number(match[1]));
}

/** Parse "Aug 20, 2026" / "August 20 2026". */
function parseMonthDayYear(text: string, locales: readonly SerperLocale[]): Date | undefined {
  const match = text.match(/([a-zа-яёіїєґäöüß]+)\.?\s+(\d{1,2}),?\s+(\d{4})/u);
  if (!match) return undefined;
  const month = monthNumber(match[1]!, locales);
  if (month === undefined) return undefined;
  return makeDate(Number(match[3]), month, Number(match[2]));
}

interface RelativeRule {
  pattern: RegExp;
  /** Milliseconds per unit; `undefined` means "use the whole phrase age". */
  unitMs: (unit: string) => number | undefined;
}

const RELATIVE_RULES: Record<SerperLocale, RelativeRule[]> = {
  ru: [
    {
      pattern: /(\d+)\s*(мин(?:уту|уты|ут)?|ч(?:ас|аса|асов|\.)?)\s+назад/,
      unitMs: (u) => (u.startsWith("мин") ? MINUTE_MS : HOUR_MS),
    },
    {
      pattern: /(\d+)\s*(день|дня|дней|неделю|недели|недель|месяц|месяца|месяцев|год|года|лет)\s+назад/,
      unitMs: (u) => {
        if (u.startsWith("недел")) return WEEK_MS;
        if (u.startsWith("месяц")) return MONTH_MS;
        if (u.startsWith("год") || u === "лет") return YEAR_MS;
        return DAY_MS;
      },
    },
  ],
  uk: [
    {
      pattern: /(\d+)\s*(хвилин(?:у|и)?|год(?:ину|ини|ин)?)\s+тому/,
      unitMs: (u) => (u.startsWith("хвилин") ? MINUTE_MS : HOUR_MS),
    },
    {
      pattern: /(\d+)\s*(день|дні|днів|тиждень|тижні|тижнів|місяць|місяці|місяців|рік|роки|років)\s+тому/,
      unitMs: (u) => {
        if (u.startsWith("тижн")) return WEEK_MS;
        if (u.startsWith("місяц")) return MONTH_MS;
        if (u === "рік" || u.startsWith("рок")) return YEAR_MS;
        return DAY_MS;
      },
    },
  ],
  en: [
    {
      pattern: /(\d+)\s*(minute|minutes|hour|hours)\s+ago/,
      unitMs: (u) => (u.startsWith("minute") ? MINUTE_MS : HOUR_MS),
    },
    {
      pattern: /(\d+)\s*(day|days|week|weeks|month|months|year|years)\s+ago/,
      unitMs: (u) => {
        if (u.startsWith("week")) return WEEK_MS;
        if (u.startsWith("month")) return MONTH_MS;
        if (u.startsWith("year")) return YEAR_MS;
        return DAY_MS;
      },
    },
  ],
  de: [
    {
      pattern: /vor\s+(\d+)\s*(minute|minuten|stunde|stunden)/,
      unitMs: (u) => (u.startsWith("minute") ? MINUTE_MS : HOUR_MS),
    },
    {
      pattern: /vor\s+(\d+)\s*(tag|tagen|woche|wochen|monat|monaten|jahr|jahren)/,
      unitMs: (u) => {
        if (u.startsWith("woche")) return WEEK_MS;
        if (u.startsWith("monat")) return MONTH_MS;
        if (u.startsWith("jahr")) return YEAR_MS;
        return DAY_MS;
      },
    },
  ],
};

const NOW_PHRASES: Record<SerperLocale, readonly string[]> = {
  ru: ["только что", "сейчас"],
  uk: ["щойно", "зараз"],
  en: ["just now", "now"],
  de: ["gerade eben", "soeben"],
};

const TODAY_PHRASES: Record<SerperLocale, readonly string[]> = {
  ru: ["сегодня"],
  uk: ["сьогодні"],
  en: ["today"],
  de: ["heute"],
};

const YESTERDAY_PHRASES: Record<SerperLocale, readonly string[]> = {
  ru: ["вчера"],
  uk: ["вчора"],
  en: ["yesterday"],
  de: ["gestern"],
};

function parseRelative(
  text: string,
  now: Date,
  locales: readonly SerperLocale[],
): Date | undefined {
  for (const locale of locales) {
    if (NOW_PHRASES[locale].includes(text)) return new Date(now.getTime());
    if (TODAY_PHRASES[locale].includes(text)) return new Date(now.getTime());
    if (YESTERDAY_PHRASES[locale].includes(text)) {
      return new Date(now.getTime() - DAY_MS);
    }
    for (const rule of RELATIVE_RULES[locale]) {
      const match = text.match(rule.pattern);
      if (!match) continue;
      const amount = Number(match[1]);
      const ms = rule.unitMs(match[2]!);
      if (!Number.isFinite(amount) || ms === undefined) continue;
      return new Date(now.getTime() - amount * ms);
    }
  }
  return undefined;
}

function parseAbsolute(
  text: string,
  locales: readonly SerperLocale[],
): Date | undefined {
  return (
    parseIso(text) ??
    parseDotted(text) ??
    parseDayMonthYear(text, locales) ??
    parseMonthDayYear(text, locales)
  );
}

/**
 * Parse a Serper/Google News date phrase.
 *
 * @param input  Raw `news[].date` value.
 * @param now    Clock used for relative phrases (injectable for tests).
 * @param locale Optional locale hint. When omitted, ru/en/de/uk are all tried;
 *               when supplied, only that locale's vocabulary is accepted
 *               (ISO/numeric absolute dates still parse).
 * @returns A `Date`, or `undefined` when the phrase is not recognised.
 */
export function parseSerperRelativeDate(
  input: string,
  now: Date = new Date(),
  locale?: SerperLocale,
): Date | undefined {
  if (typeof input !== "string" || !input.trim()) return undefined;
  const text = normalize(input);
  const locales = locale ? [locale] : LOCALES;
  return parseRelative(text, now, locales) ?? parseAbsolute(text, locales);
}

/** Age in hours, or `undefined` for an unparseable date. */
export function serperAgeHours(
  input: string,
  now: Date = new Date(),
  locale?: SerperLocale,
): number | undefined {
  const date = parseSerperRelativeDate(input, now, locale);
  if (!date) return undefined;
  return (now.getTime() - date.getTime()) / HOUR_MS;
}

/**
 * Freshness bucket: `true` (< maxHours), `false` (older or in the future by a
 * day), `undefined` (unknown age).
 */
export function isSerperDateFresh(
  input: string,
  now: Date = new Date(),
  locale?: SerperLocale,
  maxHours = 24,
): boolean | undefined {
  const age = serperAgeHours(input, now, locale);
  if (age === undefined) return undefined;
  // Strictly inside the window: "вчера" / "yesterday" / "gestern" / "вчора"
  // resolve to exactly `now - 24h`, and an item that old is NOT "fresh <24h".
  // Future-dated items (clock skew) count as fresh; far-future ones do not.
  return age < maxHours && age >= -maxHours;
}
