import { describe, it, expect } from "vitest";
import {
  isImmediate,
  isOnce,
  isRecurring,
  computeNextRun,
  isRecurringDue,
  isOnceDue,
  shouldNotify,
  RECURRING_TICK,
  IMMEDIATE_TICK,
  type ScheduleFields,
} from "../../src/scheduler/schedule.js";

// Build a recurring-task shape. Dates use the LOCAL constructor so they share the
// same (no-tz) frame as cron-parser, keeping the tests timezone-independent.
function task(over: Partial<ScheduleFields> & { schedule: string }): ScheduleFields {
  return {
    scheduledAt: null,
    lastRunAt: null,
    createdAt: new Date(2026, 5, 14, 9, 0, 0),
    ...over,
  };
}

describe("task-kind predicates", () => {
  it("classifies immediate / once / recurring by the schedule field", () => {
    expect(isImmediate({ schedule: "now" })).toBe(true);
    expect(isOnce({ schedule: "now" })).toBe(false);
    expect(isRecurring({ schedule: "now" })).toBe(false);

    expect(isOnce({ schedule: "once" })).toBe(true);
    expect(isImmediate({ schedule: "once" })).toBe(false);
    expect(isRecurring({ schedule: "once" })).toBe(false);

    expect(isRecurring({ schedule: "0 10 * * *" })).toBe(true);
    expect(isImmediate({ schedule: "0 10 * * *" })).toBe(false);
    expect(isOnce({ schedule: "0 10 * * *" })).toBe(false);
  });

  it("treats an empty schedule as none of the three kinds", () => {
    expect(isRecurring({ schedule: "" })).toBe(false);
    expect(isImmediate({ schedule: "" })).toBe(false);
    expect(isOnce({ schedule: "" })).toBe(false);
  });
});

describe("computeNextRun", () => {
  it("returns the next occurrence strictly after `from`", () => {
    const from = new Date(2026, 5, 14, 9, 0, 0); // local 09:00
    expect(computeNextRun("0 10 * * *", from)).toEqual(new Date(2026, 5, 14, 10, 0, 0));
  });

  it("rolls to the next day when `from` is already past the daily tick", () => {
    const from = new Date(2026, 5, 14, 10, 30, 0); // local 10:30, after 10:00
    expect(computeNextRun("0 10 * * *", from)).toEqual(new Date(2026, 5, 15, 10, 0, 0));
  });

  it("throws on an unparseable expression", () => {
    expect(() => computeNextRun("not a cron", new Date())).toThrow();
  });
});

describe("isRecurringDue", () => {
  it("uses createdAt as the base when never run", () => {
    const t = task({ schedule: "0 10 * * *", createdAt: new Date(2026, 5, 14, 9, 0, 0) });
    expect(isRecurringDue(t, new Date(2026, 5, 14, 9, 59, 0))).toBe(false); // before 10:00
    expect(isRecurringDue(t, new Date(2026, 5, 14, 10, 0, 0))).toBe(true); // exactly 10:00
    expect(isRecurringDue(t, new Date(2026, 5, 14, 11, 0, 0))).toBe(true); // after 10:00
  });

  it("uses lastRunAt as the base once run (no double-fire within the interval)", () => {
    const t = task({
      schedule: "0 10 * * *",
      lastRunAt: new Date(2026, 5, 14, 10, 0, 0), // ran today at 10:00
    });
    // A minute later: next run is tomorrow 10:00 → not due.
    expect(isRecurringDue(t, new Date(2026, 5, 14, 10, 1, 0))).toBe(false);
    // Tomorrow at 10:00 → due again.
    expect(isRecurringDue(t, new Date(2026, 5, 15, 10, 0, 0))).toBe(true);
  });
});

describe("isOnceDue", () => {
  const at = new Date(2026, 5, 14, 12, 0, 0);
  it("is due only once the scheduled time has arrived", () => {
    expect(isOnceDue({ scheduledAt: at }, new Date(2026, 5, 14, 11, 59, 0))).toBe(false);
    expect(isOnceDue({ scheduledAt: at }, at)).toBe(true);
    expect(isOnceDue({ scheduledAt: at }, new Date(2026, 5, 14, 12, 1, 0))).toBe(true);
  });

  it("is never due without a scheduled time", () => {
    expect(isOnceDue({ scheduledAt: null }, new Date())).toBe(false);
  });
});

describe("shouldNotify", () => {
  const recurring = { schedule: "0 10 * * *" };
  const immediate = { schedule: "now" };

  it("immediate tasks always notify on non-empty results", () => {
    expect(shouldNotify(immediate, "NO_CHANGES")).toBe(true);
    expect(shouldNotify(immediate, "anything")).toBe(true);
  });

  it("never notifies on empty / whitespace results", () => {
    expect(shouldNotify(recurring, "")).toBe(false);
    expect(shouldNotify(recurring, "   \n ")).toBe(false);
    expect(shouldNotify(immediate, "  ")).toBe(false);
  });

  it("suppresses EN no-result markers (substring, case-insensitive)", () => {
    expect(shouldNotify(recurring, "NO_CHANGES")).toBe(false);
    expect(shouldNotify(recurring, "...nothing found in the feed")).toBe(false);
    expect(shouldNotify(recurring, "NO NEW LISTINGS today")).toBe(false);
  });

  it("suppresses exact RU no-change phrases", () => {
    expect(shouldNotify(recurring, "нет изменений")).toBe(false);
    expect(shouldNotify(recurring, "  Ничего  ")).toBe(false);
  });

  it("suppresses short results containing a negative word", () => {
    expect(shouldNotify(recurring, "нет")).toBe(false);
    expect(shouldNotify(recurring, "none")).toBe(false);
    // The negative word in a long result is NOT suppressed by the short-word rule.
    expect(shouldNotify(recurring, "There is no reason to worry, all good here.")).toBe(true);
  });

  it("notifies on a normal meaningful result", () => {
    expect(shouldNotify(recurring, "Найдено 3 новых объявления по вашему запросу.")).toBe(true);
  });
});

describe("tick constants", () => {
  it("exposes the minute and 5-second cron expressions", () => {
    expect(RECURRING_TICK).toBe("* * * * *");
    expect(IMMEDIATE_TICK).toBe("*/5 * * * * *");
  });
});
