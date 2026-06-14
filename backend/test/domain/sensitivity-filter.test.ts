import { describe, it, expect } from "vitest";
import { isSensitive } from "../../src/domain/sensitivity-filter.js";

describe("isSensitive", () => {
  it("flags sensitive content (ru + en)", () => {
    expect(isSensitive("у меня депрессия")).toBe(true);
    expect(isSensitive("назначили лечение")).toBe(true);
    expect(isSensitive("planning a hack")).toBe(true);
    expect(isSensitive("недавно развод")).toBe(true);
    expect(isSensitive("got fired last week")).toBe(true);
  });

  it("passes neutral content", () => {
    expect(isSensitive("любит кофе по утрам")).toBe(false);
    expect(isSensitive("works as a software engineer")).toBe(false);
    expect(isSensitive("предпочитает чай зелёный")).toBe(false);
  });
});
