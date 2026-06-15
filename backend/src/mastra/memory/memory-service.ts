import { and, eq, inArray, desc } from "drizzle-orm";
import type { LibSQLDatabase } from "drizzle-orm/libsql";
import * as schema from "../../db/schema.js";
import { memories } from "../../db/schema.js";
import { classifyScope } from "../../domain/memory-classifier.js";
import { isSensitive } from "../../domain/sensitivity-filter.js";
import { sanitizeMemoryContent } from "../../pkg/promptguard.js";
import { MAX_PERMANENT_MEMORIES, type MemoryScope } from "../../domain/entities.js";
import type { DedupChecker } from "./dedup.js";
import { logger } from "../../pkg/logger.js";

const log = logger.child({ mod: "memory-service" });

type Db = LibSQLDatabase<typeof schema>;
export type StoredMemory = typeof memories.$inferSelect;

export type SaveResult =
  | { saved: true; id: number }
  | { saved: false; reason: "sensitive" | "duplicate" };

/**
 * Long-term user memory over a single relational table. The per-user set is small
 * (permanent cap 50), so the whole of it is loaded into context each turn — no
 * vector RAG, no embeddings. Save path: sensitivity filter, sanitize, scope
 * classification, LLM dedup, insert, and a permanent cap (50).
 */
export class MemoryService {
  constructor(
    private readonly db: Db,
    private readonly dedup: DedupChecker,
  ) {}

  private async allMemories(userId: number): Promise<StoredMemory[]> {
    return this.db.select().from(memories).where(eq(memories.userId, userId));
  }

  /**
   * Load all of a user's memories (onboarding/preference first). The set is capped
   * at 50 permanent facts, so it fits in context whole — selection is unnecessary.
   */
  async loadRelevant(userId: number): Promise<StoredMemory[]> {
    const all = await this.allMemories(userId);
    const onboarding = all.filter((m) => m.category === "preference");
    const regular = all.filter((m) => m.category !== "preference");
    log.debug({ total: all.length }, "load all memories");
    return [...onboarding, ...regular];
  }

  /** Save a memory (sensitivity -> sanitize -> classify -> LLM dedup -> insert -> cap). */
  async save(
    userId: number,
    category: string,
    content: string,
    sessionId: number | null = null,
    scopeOverride?: MemoryScope,
  ): Promise<SaveResult> {
    if (isSensitive(content)) {
      log.debug("skip save (sensitive content)");
      return { saved: false, reason: "sensitive" };
    }
    const clean = sanitizeMemoryContent(content);
    const scope = scopeOverride ?? classifyScope(category, clean);

    const existing = await this.allMemories(userId);
    if (await this.dedup.isDuplicate(clean, existing.map((m) => m.content))) {
      log.debug("dedup skip");
      return { saved: false, reason: "duplicate" };
    }

    const [row] = await this.db
      .insert(memories)
      .values({ userId, category, scope, sessionId, content: clean })
      .returning({ id: memories.id });
    const id = row!.id;

    if (scope === "permanent") await this.trimPermanent(userId);
    log.debug({ id, scope }, "memory saved");
    return { saved: true, id };
  }

  async listPermanent(userId: number): Promise<StoredMemory[]> {
    return this.db
      .select()
      .from(memories)
      .where(and(eq(memories.userId, userId), eq(memories.scope, "permanent")))
      .orderBy(desc(memories.id));
  }

  /** Delete a memory (only the owner's). Returns true if a row was removed. */
  async delete(userId: number, memoryId: number): Promise<boolean> {
    const res = await this.db
      .delete(memories)
      .where(and(eq(memories.userId, userId), eq(memories.id, memoryId)))
      .returning({ id: memories.id });
    if (res.length === 0) return false;
    log.debug({ id: memoryId }, "memory deleted");
    return true;
  }

  /**
   * Delete all session-scoped memories for one session. Used by the `/new` command;
   * permanent (long-term) facts are left untouched. Returns the number removed.
   */
  async deleteSessionMemories(userId: number, sessionId: number): Promise<number> {
    const where = and(
      eq(memories.userId, userId),
      eq(memories.sessionId, sessionId),
      eq(memories.scope, "session"),
    );
    const res = await this.db.delete(memories).where(where).returning({ id: memories.id });
    if (res.length === 0) return 0;
    log.info({ userId, sessionId, removed: res.length }, "session memories cleared");
    return res.length;
  }

  private async trimPermanent(userId: number): Promise<void> {
    const perm = await this.db
      .select({ id: memories.id })
      .from(memories)
      .where(and(eq(memories.userId, userId), eq(memories.scope, "permanent")))
      .orderBy(desc(memories.id));
    if (perm.length <= MAX_PERMANENT_MEMORIES) return;
    const toDelete = perm.slice(MAX_PERMANENT_MEMORIES).map((r) => r.id);
    await this.db.delete(memories).where(inArray(memories.id, toDelete));
    log.info({ removed: toDelete.length }, "cap trim (permanent > 50)");
  }
}
