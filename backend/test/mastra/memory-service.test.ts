import { describe, it, expect, afterEach } from "vitest";
import { createTestDb, type TestDb } from "../helpers/libsql.js";
import { MemoryService } from "../../src/mastra/memory/memory-service.js";
import type { DedupChecker } from "../../src/mastra/memory/dedup.js";
import { users } from "../../src/db/schema.js";

// Stub dedup: an exact text match against an existing fact counts as a duplicate.
// (The real LlmDedupChecker decides this with a model; tests stay network-free.)
const dedup: DedupChecker = {
  isDuplicate: async (candidate, existing) => existing.includes(candidate),
};

let t: TestDb | undefined;
afterEach(() => {
  t?.cleanup();
  t = undefined;
});

async function setup(): Promise<MemoryService> {
  t = await createTestDb();
  await t.db.insert(users).values([
    { id: 1, name: "u1" },
    { id: 2, name: "u2" },
  ]);
  return new MemoryService(t.db, dedup);
}

describe("MemoryService", () => {
  it("loadRelevant returns all of a user's facts, preference first", async () => {
    const m = await setup();
    await m.save(1, "fact", "uses TypeScript");
    await m.save(1, "preference", "likes coffee");
    await m.save(1, "fact", "rides a gravel bike");
    const rel = await m.loadRelevant(1);
    expect(rel).toHaveLength(3);
    expect(rel[0]!.category).toBe("preference");
  });

  it("loadRelevant loads everything even past 10 facts (no RAG cap)", async () => {
    const m = await setup();
    await m.save(1, "preference", "onboarding profile fact");
    for (let i = 0; i < 12; i++) await m.save(1, "fact", `distinct fact number ${i}`);
    const rel = await m.loadRelevant(1);
    expect(rel).toHaveLength(13);
    expect(rel.filter((r) => r.category === "preference")).toHaveLength(1);
  });

  it("dedup skips a duplicate memory", async () => {
    const m = await setup();
    expect((await m.save(1, "fact", "drinks oat milk latte")).saved).toBe(true);
    const dup = await m.save(1, "fact", "drinks oat milk latte");
    expect(dup.saved).toBe(false);
    if (!dup.saved) expect(dup.reason).toBe("duplicate");
  });

  it("skips sensitive content", async () => {
    const m = await setup();
    const r = await m.save(1, "fact", "у меня депрессия");
    expect(r.saved).toBe(false);
    if (!r.saved) expect(r.reason).toBe("sensitive");
  });

  it("caps permanent memories at 50", async () => {
    const m = await setup();
    for (let i = 0; i < 55; i++) await m.save(1, "fact", `durable distinct fact token-${i}-${i * 7}`);
    expect(await m.listPermanent(1)).toHaveLength(50);
  });

  it("redacts an email address before storing", async () => {
    const m = await setup();
    const r = await m.save(1, "fact", "reach me at john.doe@example.com anytime");
    expect(r.saved).toBe(true);
    const [stored] = await m.listPermanent(1);
    expect(stored!.content).toContain("[redacted]");
    expect(stored!.content).not.toContain("john.doe@example.com");
  });

  it("redacts a phone number before storing", async () => {
    const m = await setup();
    const r = await m.save(1, "fact", "my number is +375 29 123-45-67 call me");
    expect(r.saved).toBe(true);
    const [stored] = await m.listPermanent(1);
    expect(stored!.content).toContain("[redacted]");
    expect(stored!.content).not.toContain("123-45-67");
  });

  it("redacts a credit-card number before storing", async () => {
    const m = await setup();
    const r = await m.save(1, "fact", "card 4111 1111 1111 1111 for groceries");
    expect(r.saved).toBe(true);
    const [stored] = await m.listPermanent(1);
    expect(stored!.content).toContain("[redacted]");
    expect(stored!.content).not.toContain("4111 1111 1111 1111");
    expect(stored!.content).not.toContain("4111111111111111");
  });

  it("does not redact ordinary years or short numbers", async () => {
    const m = await setup();
    const r = await m.save(1, "fact", "moved to Minsk in 2019 and paid 250 BYN");
    expect(r.saved).toBe(true);
    const [stored] = await m.listPermanent(1);
    expect(stored!.content).not.toContain("[redacted]");
    expect(stored!.content).toContain("2019");
    expect(stored!.content).toContain("250");
  });

  it("delete removes only the owner's memory", async () => {
    const m = await setup();
    const saved = await m.save(1, "fact", "deletable fact");
    expect(saved.saved).toBe(true);
    if (saved.saved) {
      expect(await m.delete(2, saved.id)).toBe(false);
      expect(await m.delete(1, saved.id)).toBe(true);
      expect(await m.listPermanent(1)).toHaveLength(0);
    }
  });
});
