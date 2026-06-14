import { describe, it, expect } from "vitest";
import { EmbeddingService } from "../../src/mastra/embeddings.js";

type Body = { model: string; input: string | string[] };

function fakeFetch(handler: (body: Body) => Response): typeof fetch {
  return (async (_url: unknown, init?: RequestInit) =>
    handler(JSON.parse(String(init?.body)) as Body)) as typeof fetch;
}

function ok(data: number[][]): Response {
  return new Response(JSON.stringify({ data: data.map((embedding) => ({ embedding })) }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("EmbeddingService", () => {
  it("returns a single embedding", async () => {
    const svc = new EmbeddingService({
      modelRef: "openrouter:m",
      apiKey: "k",
      fetchFn: fakeFetch((b) => ok([[String(b.input).length, 9]])),
    });
    expect(await svc.generate("ab")).toEqual([2, 9]);
  });

  it("falls back to individual requests when the batch call fails", async () => {
    const svc = new EmbeddingService({
      modelRef: "openrouter:m",
      apiKey: "k",
      fetchFn: fakeFetch((b) =>
        Array.isArray(b.input) ? new Response("err", { status: 500 }) : ok([[b.input.length]]),
      ),
    });
    expect(await svc.generateBatch(["a", "bbb"])).toEqual([[1], [3]]);
  });

  it("falls back when the batch length mismatches the input", async () => {
    const svc = new EmbeddingService({
      modelRef: "openrouter:m",
      apiKey: "k",
      fetchFn: fakeFetch((b) =>
        Array.isArray(b.input) ? ok([[0]]) /* 1 vec for 2 inputs */ : ok([[b.input.length]]),
      ),
    });
    expect(await svc.generateBatch(["a", "bb"])).toEqual([[1], [2]]);
  });
});
