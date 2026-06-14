import { parseModelRef } from "./models.js";
import { env } from "../config/env.js";
import { logger } from "../pkg/logger.js";

const log = logger.child({ mod: "embeddings" });

const DEFAULT_TIMEOUT_MS = 30_000;

function endpointFor(provider: string): string {
  switch (provider) {
    case "openai":
      return "https://api.openai.com/v1/embeddings";
    case "zai":
      return "https://api.z.ai/api/paas/v4/embeddings";
    default:
      return "https://openrouter.ai/api/v1/embeddings";
  }
}

function envKeyFor(provider: string): string | undefined {
  switch (provider) {
    case "openai":
      return env.OPENAI_API_KEY;
    case "zai":
      return env.ZAI_API_KEY;
    default:
      return env.OPENROUTER_API_KEY;
  }
}

export interface EmbeddingServiceOptions {
  /** e.g. "openrouter:intfloat/multilingual-e5-large". */
  modelRef: string;
  apiKey?: string;
  timeoutMs?: number;
  /** Injectable fetch (tests). */
  fetchFn?: typeof fetch;
}

/**
 * Thin HTTP client for OpenAI-compatible /embeddings (multilingual-e5-large, 1024-dim).
 * Parity with Go embedding_service.go: batch in one request, fall back to per-item on failure.
 */
export class EmbeddingService {
  private readonly modelId: string;
  private readonly endpoint: string;
  private readonly apiKey: string | undefined;
  private readonly timeoutMs: number;
  private readonly fetchFn: typeof fetch;

  constructor(opts: EmbeddingServiceOptions) {
    const { provider, modelId } = parseModelRef(opts.modelRef);
    this.modelId = modelId;
    this.endpoint = endpointFor(provider);
    this.apiKey = opts.apiKey ?? envKeyFor(provider);
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchFn = opts.fetchFn ?? fetch;
  }

  async generate(text: string): Promise<number[]> {
    const [vec] = await this.request(text);
    if (!vec) throw new Error("embeddings: empty response");
    return vec;
  }

  async generateBatch(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    if (texts.length === 1) return [await this.generate(texts[0]!)];
    try {
      const vecs = await this.request(texts);
      if (vecs.length !== texts.length) {
        throw new Error(`expected ${texts.length} embeddings, got ${vecs.length}`);
      }
      return vecs;
    } catch (err) {
      log.warn({ reason: err instanceof Error ? err.message : String(err) }, "batch embed failed -> individual");
      return this.fallbackIndividual(texts);
    }
  }

  private async fallbackIndividual(texts: string[]): Promise<number[][]> {
    const out: number[][] = [];
    for (const t of texts) out.push(await this.generate(t));
    return out;
  }

  private async request(input: string | string[]): Promise<number[][]> {
    log.debug({ batch: Array.isArray(input) ? input.length : 1 }, "embedding request");
    const res = await this.fetchFn(this.endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.apiKey ?? ""}`,
      },
      body: JSON.stringify({ model: this.modelId, input }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) throw new Error(`embeddings HTTP ${res.status}`);
    const json = (await res.json()) as { data?: { embedding: number[] }[] };
    if (!json.data) throw new Error("embeddings: missing data field");
    return json.data.map((d) => d.embedding);
  }
}
