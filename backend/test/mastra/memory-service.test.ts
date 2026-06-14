import { describe, it, expect, afterEach } from "vitest";
import { createTestDb, type TestDb } from "../helpers/libsql.js";
import { MemoryService, type Embedder } from "../../src/mastra/memory/memory-service.js";
import { users } from "../../src/db/schema.js";
import type { SettingsService } from "../../src/config/settings.js";

// Deterministic 4-hot embedding keyed on the FULL text: identical text -> identical
// vector (cosine 1, triggers dedup); different text -> ~orthogonal (cosine < 0.92).
function fakeVec(text: string): number[] {
  const v = new Array(1024).fill(0);
  let base = 2166136261 >>> 0;
  for (let i = 0; i < text.length; i++) {
    base ^= text.charCodeAt(i);
    base = Math.imul(base, 16777619);
  }
  for (let s = 1; s <= 4; s++) {
    const h = (base ^ Math.imul(s, 2654435761)) >>> 0;
    v[h % 1024] += 1;
  }
  return v;
}

const embedder: Embedder = { generate: async (t) => fakeVec(t) };
const fakeSettings = {
  getAgent: async () => ({ max_history: 15, default_temperature: 0.4, rag_top_k: 10 }),
} as unknown as SettingsService;

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
  return new MemoryService(t.db, t.vector, embedder, fakeSettings);
}

describe("MemoryService", () => {
  it("loadRelevant returns all facts when there are < 10 regular facts", async () => {
    const m = await setup();
    await m.save(1, "preference", "likes coffee");
    await m.save(1, "fact", "uses TypeScript");
    await m.save(1, "fact", "rides a gravel bike");
    expect(await m.loadRelevant(1, "anything")).toHaveLength(3);
  });

  it("dedup skips a near-identical memory (cosine >= 0.92)", async () => {
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

  it("RAG limits regular facts to topK once there are >= 10", async () => {
    const m = await setup();
    await m.save(1, "preference", "onboarding profile fact");
    for (let i = 0; i < 12; i++) await m.save(1, "fact", `subject ${i} unrelated topic ${i * 3}`);
    const rel = await m.loadRelevant(1, "subject 3 unrelated topic 9");
    expect(rel.filter((r) => r.category === "preference")).toHaveLength(1);
    expect(rel.filter((r) => r.category !== "preference")).toHaveLength(10);
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
