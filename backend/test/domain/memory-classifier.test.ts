import { describe, it, expect } from "vitest";
import { classifyScope } from "../../src/domain/memory-classifier.js";

describe("classifyScope", () => {
  it("non-fact categories are always permanent", () => {
    for (const c of ["preference", "instruction", "lesson", "reflection", "strategy"]) {
      expect(classifyScope(c, "сейчас работаю над проектом")).toBe("permanent");
    }
  });

  it("fact with a session keyword -> session", () => {
    expect(classifyScope("fact", "Сейчас работаю над миграцией")).toBe("session");
    expect(classifyScope("fact", "Мы обсуждаем дизайн API")).toBe("session");
    expect(classifyScope("fact", "Временно использует Postgres")).toBe("session");
  });

  it("fact without a session keyword -> permanent", () => {
    expect(classifyScope("fact", "пишет на Go")).toBe("permanent");
    expect(classifyScope("fact", "любит горный велосипед")).toBe("permanent");
  });
});
