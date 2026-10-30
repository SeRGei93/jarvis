import { describe, expect, it } from "vitest";

import {
  isSerperDateFresh,
  parseSerperRelativeDate,
  serperAgeHours,
} from "../../../scripts/lib/serper-date.js";

const NOW = new Date("2026-10-30T12:00:00Z");

function ymd(date: Date | undefined): string | undefined {
  if (!date) return undefined;
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

describe("parseSerperRelativeDate: relative phrases", () => {
  it("parses Russian phrases (minutes, hours, days, weeks)", () => {
    expect(serperAgeHours("5 минут назад", NOW, "ru")).toBeCloseTo(5 / 60, 5);
    expect(serperAgeHours("2 часа назад", NOW, "ru")).toBeCloseTo(2, 5);
    expect(serperAgeHours("3 дня назад", NOW, "ru")).toBeCloseTo(72, 5);
    expect(serperAgeHours("2 недели назад", NOW, "ru")).toBeCloseTo(14 * 24, 5);
    expect(parseSerperRelativeDate("сегодня", NOW, "ru")?.getTime()).toBe(NOW.getTime());
    expect(serperAgeHours("вчера", NOW, "ru")).toBeCloseTo(24, 5);
    expect(serperAgeHours("5 мин назад", NOW, "ru")).toBeCloseTo(5 / 60, 5);
  });

  it("parses English phrases", () => {
    expect(serperAgeHours("16 hours ago", NOW, "en")).toBeCloseTo(16, 5);
    expect(serperAgeHours("1 day ago", NOW, "en")).toBeCloseTo(24, 5);
    expect(serperAgeHours("30 minutes ago", NOW, "en")).toBeCloseTo(0.5, 5);
    expect(serperAgeHours("2 weeks ago", NOW, "en")).toBeCloseTo(14 * 24, 5);
    expect(parseSerperRelativeDate("today", NOW, "en")?.getTime()).toBe(NOW.getTime());
    expect(serperAgeHours("yesterday", NOW, "en")).toBeCloseTo(24, 5);
  });

  it("parses German phrases", () => {
    expect(serperAgeHours("vor 5 Stunden", NOW, "de")).toBeCloseTo(5, 5);
    expect(serperAgeHours("vor 2 Tagen", NOW, "de")).toBeCloseTo(48, 5);
    expect(serperAgeHours("vor 3 Wochen", NOW, "de")).toBeCloseTo(21 * 24, 5);
    expect(parseSerperRelativeDate("heute", NOW, "de")?.getTime()).toBe(NOW.getTime());
    expect(serperAgeHours("gestern", NOW, "de")).toBeCloseTo(24, 5);
  });

  it("parses Ukrainian phrases", () => {
    expect(serperAgeHours("2 тижні тому", NOW, "uk")).toBeCloseTo(14 * 24, 5);
    expect(serperAgeHours("5 годин тому", NOW, "uk")).toBeCloseTo(5, 5);
    expect(serperAgeHours("3 дні тому", NOW, "uk")).toBeCloseTo(72, 5);
    expect(parseSerperRelativeDate("сьогодні", NOW, "uk")?.getTime()).toBe(NOW.getTime());
    expect(serperAgeHours("вчора", NOW, "uk")).toBeCloseTo(24, 5);
  });
});

describe("parseSerperRelativeDate: absolute dates", () => {
  it("parses Russian day-month-year with an abbreviation and 'г.'", () => {
    expect(ymd(parseSerperRelativeDate("20 авг. 2026 г.", NOW, "ru"))).toBe("2026-08-20");
    expect(ymd(parseSerperRelativeDate("29 октября 2026 в 8:00", NOW, "ru"))).toBe("2026-10-29");
  });

  it("parses English month-day-year", () => {
    expect(ymd(parseSerperRelativeDate("Aug 20, 2026", NOW, "en"))).toBe("2026-08-20");
    expect(ymd(parseSerperRelativeDate("August 20 2026", NOW, "en"))).toBe("2026-08-20");
  });

  it("parses German day-month-year", () => {
    expect(ymd(parseSerperRelativeDate("20. Aug. 2026", NOW, "de"))).toBe("2026-08-20");
    expect(ymd(parseSerperRelativeDate("20. August 2026", NOW, "de"))).toBe("2026-08-20");
  });

  it("parses Ukrainian day-month-year", () => {
    expect(ymd(parseSerperRelativeDate("20 серпня 2026", NOW, "uk"))).toBe("2026-08-20");
  });

  it("parses ISO and dotted numeric dates regardless of locale", () => {
    expect(ymd(parseSerperRelativeDate("2026-10-29T10:00:00Z", NOW, "de"))).toBe("2026-10-29");
    expect(ymd(parseSerperRelativeDate("29.10.2026", NOW, "ru"))).toBe("2026-10-29");
    expect(ymd(parseSerperRelativeDate("29/10/2026", NOW, "en"))).toBe("2026-10-29");
  });
});

describe("parseSerperRelativeDate: unknown and locale handling", () => {
  it("returns undefined for unrecognised phrases", () => {
    expect(parseSerperRelativeDate("недавно", NOW, "ru")).toBeUndefined();
    expect(parseSerperRelativeDate("", NOW)).toBeUndefined();
    expect(parseSerperRelativeDate("   ", NOW)).toBeUndefined();
    expect(serperAgeHours("soon", NOW, "en")).toBeUndefined();
  });

  it("does not accept another locale's words when a locale is supplied", () => {
    expect(parseSerperRelativeDate("vor 5 Stunden", NOW, "ru")).toBeUndefined();
    expect(parseSerperRelativeDate("2 тижні тому", NOW, "de")).toBeUndefined();
  });

  it("auto-detects the locale when no hint is given", () => {
    expect(serperAgeHours("vor 5 Stunden", NOW)).toBeCloseTo(5, 5);
    expect(serperAgeHours("2 тижні тому", NOW)).toBeCloseTo(14 * 24, 5);
    expect(serperAgeHours("16 hours ago", NOW)).toBeCloseTo(16, 5);
  });
});

describe("isSerperDateFresh", () => {
  it("classifies <24h as fresh, older as stale, unknown as undefined", () => {
    expect(isSerperDateFresh("16 hours ago", NOW, "en")).toBe(true);
    expect(isSerperDateFresh("2 days ago", NOW, "en")).toBe(false);
    expect(isSerperDateFresh("20 авг. 2026 г.", NOW, "ru")).toBe(false);
    expect(isSerperDateFresh("недавно", NOW, "ru")).toBeUndefined();
  });

  it("does not count 'yesterday' (exactly 24h) as fresh", () => {
    // These phrases resolve to `now - 24h`, i.e. the outer edge of the window.
    expect(serperAgeHours("вчера", NOW, "ru")).toBeCloseTo(24, 5);
    expect(isSerperDateFresh("вчера", NOW, "ru")).toBe(false);
    expect(isSerperDateFresh("yesterday", NOW, "en")).toBe(false);
    expect(isSerperDateFresh("gestern", NOW, "de")).toBe(false);
    expect(isSerperDateFresh("вчора", NOW, "uk")).toBe(false);
    expect(isSerperDateFresh("1 день назад", NOW, "ru")).toBe(false);
    // A hair inside the window is still fresh.
    expect(isSerperDateFresh("23 часа назад", NOW, "ru")).toBe(true);
  });
});
