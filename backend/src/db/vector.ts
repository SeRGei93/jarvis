import type { LibSQLVector } from "@mastra/libsql";
import { EMBEDDING_DIM } from "../domain/entities.js";
import { logger } from "../pkg/logger.js";

const log = logger.child({ mod: "vector" });

/** LibSQLVector index holding long-term memory embeddings. */
export const MEMORIES_INDEX = "memories_vec";

/**
 * Create the memories vector index (idempotent): 1024-dim, cosine.
 * Each vector is keyed by memory id and carries metadata
 * {memoryId, userId, scope, category} so RAG can filter per-user (Task 20).
 */
export async function ensureMemoriesIndex(vector: LibSQLVector): Promise<void> {
  await vector.createIndex({
    indexName: MEMORIES_INDEX,
    dimension: EMBEDDING_DIM,
    metric: "cosine",
  });
  log.info({ index: MEMORIES_INDEX, dimension: EMBEDDING_DIM, metric: "cosine" }, "memories vector index ready");
}
