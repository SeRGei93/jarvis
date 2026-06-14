import { and, eq, inArray, desc } from "drizzle-orm";
import type { LibSQLDatabase } from "drizzle-orm/libsql";
import type { LibSQLVector } from "@mastra/libsql";
import * as schema from "../../db/schema.js";
import { memories } from "../../db/schema.js";
import { MEMORIES_INDEX } from "../../db/vector.js";
import { SettingsService } from "../../config/settings.js";
import { classifyScope } from "../../domain/memory-classifier.js";
import { isSensitive } from "../../domain/sensitivity-filter.js";
import { sanitizeMemoryContent } from "../../pkg/promptguard.js";
import {
  DUPLICATE_SIMILARITY_THRESHOLD,
  MAX_PERMANENT_MEMORIES,
  RAG_THRESHOLD,
  RAG_TOP_K,
  type MemoryScope,
} from "../../domain/entities.js";
import { logger } from "../../pkg/logger.js";

const log = logger.child({ mod: "memory-service" });

type Db = LibSQLDatabase<typeof schema>;
export type StoredMemory = typeof memories.$inferSelect;

/** Minimal embedding dependency (EmbeddingService satisfies this). */
export interface Embedder {
  generate(text: string): Promise<number[]>;
}

export type SaveResult =
  | { saved: true; id: number }
  | { saved: false; reason: "sensitive" | "duplicate" };

/**
 * Long-term user memory: RAG retrieval over LibSQLVector + relational rows, with
 * sensitivity filtering, scope classification, cosine dedup (0.92) and a permanent
 * cap (50). Parity with Go memory_service.go + extract_memories.go.
 */
export class MemoryService {
  constructor(
    private readonly db: Db,
    private readonly vector: LibSQLVector,
    private readonly embeddings: Embedder,
    private readonly settings: SettingsService,
  ) {}

  private async allMemories(userId: number): Promise<StoredMemory[]> {
    return this.db.select().from(memories).where(eq(memories.userId, userId));
  }

  /** Load memories relevant to the current message (onboarding always; RAG over the rest). */
  async loadRelevant(userId: number, userMessage: string): Promise<StoredMemory[]> {
    const all = await this.allMemories(userId);
    const onboarding = all.filter((m) => m.category === "preference");
    const regular = all.filter((m) => m.category !== "preference");

    if (regular.length < RAG_THRESHOLD) {
      log.debug({ regular: regular.length, mode: "all" }, "load relevant");
      return [...onboarding, ...regular];
    }

    const topK = (await this.settings.getAgent()).rag_top_k || RAG_TOP_K;
    let selected = regular;
    try {
      const qvec = await this.embeddings.generate(userMessage);
      const hits = await this.vector.query({
        indexName: MEMORIES_INDEX,
        queryVector: qvec,
        topK,
        // Onboarding (preference) facts are always loaded, so exclude them from RAG
        // to keep the whole topK budget for regular facts.
        filter: { userId, category: { $ne: "preference" } },
      });
      if (hits.length > 0) {
        const ids = new Set(hits.map((h) => Number(h.id)));
        selected = regular.filter((m) => ids.has(m.id));
      }
      log.debug({ regular: regular.length, topK, selected: selected.length, mode: "rag" }, "load relevant");
    } catch (err) {
      log.warn({ reason: err instanceof Error ? err.message : String(err) }, "RAG failed -> all regular");
    }
    return [...onboarding, ...selected];
  }

  /** Save a memory (sensitivity -> sanitize -> classify -> embed -> dedup -> insert -> cap). */
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

    let embedding: number[] | null = null;
    try {
      embedding = await this.embeddings.generate(clean);
    } catch (err) {
      log.warn({ reason: err instanceof Error ? err.message : String(err) }, "embed failed -> save without vector");
    }

    if (embedding) {
      const dup = await this.vector.query({
        indexName: MEMORIES_INDEX,
        queryVector: embedding,
        topK: 1,
        filter: { userId },
      });
      const top = dup[0];
      if (top && top.score >= DUPLICATE_SIMILARITY_THRESHOLD) {
        log.debug({ score: top.score }, "dedup skip");
        return { saved: false, reason: "duplicate" };
      }
    }

    const [row] = await this.db
      .insert(memories)
      .values({ userId, category, scope, sessionId, content: clean })
      .returning({ id: memories.id });
    const id = row!.id;

    if (embedding) {
      await this.vector.upsert({
        indexName: MEMORIES_INDEX,
        vectors: [embedding],
        ids: [String(id)],
        metadata: [{ memoryId: id, userId, scope, category }],
      });
    }

    if (scope === "permanent") await this.trimPermanent(userId);
    log.debug({ id, scope }, "memory saved");
    return { saved: true, id };
  }

  /** Vector search for the memory_search tool (top-`limit`, per-user). */
  async search(userId: number, query: string, limit = RAG_TOP_K): Promise<StoredMemory[]> {
    const qvec = await this.embeddings.generate(query);
    const hits = await this.vector.query({
      indexName: MEMORIES_INDEX,
      queryVector: qvec,
      topK: limit,
      filter: { userId },
    });
    const ids = hits.map((h) => Number(h.id));
    if (ids.length === 0) return [];
    const rows = await this.db
      .select()
      .from(memories)
      .where(and(eq(memories.userId, userId), inArray(memories.id, ids)));
    const order = new Map(ids.map((id, i) => [id, i]));
    return rows.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
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
    await this.deleteVector(memoryId);
    log.debug({ id: memoryId }, "memory deleted");
    return true;
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
    for (const id of toDelete) await this.deleteVector(id);
    log.info({ removed: toDelete.length }, "cap trim (permanent > 50)");
  }

  private async deleteVector(memoryId: number): Promise<void> {
    try {
      await this.vector.deleteVector({ indexName: MEMORIES_INDEX, id: String(memoryId) });
    } catch (err) {
      log.warn({ id: memoryId, reason: err instanceof Error ? err.message : String(err) }, "vector delete failed");
    }
  }
}
