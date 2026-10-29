import { describe, it, expect, vi } from "vitest";
import {
  performWebSearch,
  performWebSearchBatch,
  performSerperNewsSearch,
  resolveSearchRegion,
} from "../../../src/services/web/search.js";
import { googleLocale } from "../../../src/services/web/config.js";

/** Captured Serper request (body + headers) from the last call. */
interface Captured {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: { q?: string; num?: number; gl?: string; hl?: string };
}

/** Build a JSON Response with the Serper `{ organic: [...] }` shape. */
function serperResp(
  organic: Array<{ title?: string; link?: string; snippet?: string }>,
  status = 200,
): Response {
  return new Response(JSON.stringify({ organic }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** fetchFn stub that records every request it serves. */
function recordingFetch(make: (n: number, req: Captured) => Response): {
  fetchFn: typeof globalThis.fetch;
  calls: Captured[];
} {
  const calls: Captured[] = [];
  const fetchFn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const req: Captured = {
      url: String(input),
      method: init?.method ?? "GET",
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: JSON.parse(String(init?.body ?? "{}")),
    };
    calls.push(req);
    return make(calls.length, req);
  }) as unknown as typeof globalThis.fetch;
  return { fetchFn, calls };
}

const DEPS = { timeoutMs: 5000, apiKey: "k-test" };

describe("resolveSearchRegion", () => {
  it("returns the default region for undefined", () => {
    const r = resolveSearchRegion(undefined);
    expect(r.resolved).toBe("ru-by");
    expect(r.requested).toBe("default");
  });

  it("maps aliases to a canonical region", () => {
    expect(resolveSearchRegion("belarus").resolved).toBe("ru-by");
    expect(resolveSearchRegion("by").resolved).toBe("ru-by");
    expect(resolveSearchRegion("ru").resolved).toBe("ru-ru");
  });

  it("maps global/world aliases to the worldwide region (not Belarus)", () => {
    expect(resolveSearchRegion("global").resolved).toBe("wt-wt");
    expect(resolveSearchRegion("world").resolved).toBe("wt-wt");
    expect(resolveSearchRegion("all").resolved).toBe("wt-wt");
    expect(resolveSearchRegion("wt").resolved).toBe("wt-wt");
  });

  it("passes a xx-yy literal through unchanged", () => {
    const r = resolveSearchRegion("de-de");
    expect(r.resolved).toBe("de-de");
    expect(r.requested).toBe("de-de");
  });

  it("falls back (with a note) for an unknown region", () => {
    const r = resolveSearchRegion("atlantis");
    expect(r.resolved).toBe("ru-by");
    expect(r.note).toContain("Unknown region");
  });
});

describe("googleLocale", () => {
  it("maps canonical regions to Google gl/hl", () => {
    expect(googleLocale("ru-by")).toEqual({ gl: "by", hl: "ru" });
    expect(googleLocale("ua-uk")).toEqual({ gl: "ua", hl: "uk" });
    expect(googleLocale("us-en")).toEqual({ gl: "us", hl: "en" });
    expect(googleLocale("uk-en")).toEqual({ gl: "gb", hl: "en" });
  });

  it("sends no locale for worldwide", () => {
    expect(googleLocale("wt-wt")).toEqual({});
  });

  it("derives country/language for an unlisted xx-yy region", () => {
    expect(googleLocale("it-it")).toEqual({ gl: "it", hl: "it" });
  });
});

describe("performWebSearch (Serper)", () => {
  it("posts the query + gl/hl and formats results as markdown", async () => {
    const { fetchFn, calls } = recordingFetch(() =>
      serperResp([
        { title: "T1", snippet: "C1", link: "https://a.test" },
        { title: "T2", snippet: "C2", link: "https://b.test" },
      ]),
    );

    const md = await performWebSearch("test", { ...DEPS, fetchFn, region: "belarus" });

    expect(md).toContain("# Web Search Results");
    expect(md).toContain("Query: test");
    expect(md).toContain("Region: ru-by");
    expect(md).toContain("Results: 2");
    expect(md).toContain("T1");
    expect(md).toContain("https://b.test");

    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.url).toBe("https://google.serper.dev/search");
    expect(calls[0]!.headers["X-API-KEY"]).toBe("k-test");
    expect(calls[0]!.body).toMatchObject({ q: "test", num: 10, gl: "by", hl: "ru" });
  });

  it("omits gl/hl for the worldwide region", async () => {
    const { fetchFn, calls } = recordingFetch(() => serperResp([]));
    await performWebSearch("x", { ...DEPS, fetchFn, region: "global" });
    expect(calls[0]!.body.gl).toBeUndefined();
    expect(calls[0]!.body.hl).toBeUndefined();
  });

  it("caps num at 10 (one Google page) even when more are requested", async () => {
    const { fetchFn, calls } = recordingFetch(() => serperResp([]));
    await performWebSearch("x", { ...DEPS, fetchFn, count: 20 });
    expect(calls[0]!.body.num).toBe(10);
  });

  it("returns a 'No results found' message for an empty organic list", async () => {
    const { fetchFn } = recordingFetch(() => serperResp([]));
    const md = await performWebSearch("nothing", { ...DEPS, fetchFn });
    expect(md).toContain("No results found.");
    expect(md).toContain("Query: nothing");
  });

  it("skips rows without a link", async () => {
    const { fetchFn } = recordingFetch(() =>
      serperResp([{ title: "no link" }, { title: "ok", link: "https://ok.test" }]),
    );
    const md = await performWebSearch("x", { ...DEPS, fetchFn });
    expect(md).toContain("Results: 1");
    expect(md).not.toContain("no link");
  });

  it("retries on HTTP 500 then succeeds", async () => {
    const { fetchFn, calls } = recordingFetch((n) =>
      n === 1 ? serperResp([], 500) : serperResp([{ title: "Recovered", link: "https://r.test" }]),
    );
    const md = await performWebSearch("retry", { ...DEPS, fetchFn });
    expect(calls).toHaveLength(2);
    expect(md).toContain("Recovered");
  });

  it("retries on network errors then succeeds", async () => {
    let n = 0;
    const fetchFn = vi.fn(async () => {
      n += 1;
      if (n === 1) throw new Error("ECONNRESET");
      return serperResp([{ title: "After flap", link: "https://f.test" }]);
    }) as unknown as typeof globalThis.fetch;

    const md = await performWebSearch("flap", { ...DEPS, fetchFn });
    expect(n).toBe(2);
    expect(md).toContain("After flap");
  });

  it("does not retry a 401 and reports the key/credits problem", async () => {
    const { fetchFn, calls } = recordingFetch(() => serperResp([], 401));
    await expect(performWebSearch("x", { ...DEPS, fetchFn })).rejects.toThrow(/SERPER_API_KEY/);
    expect(calls).toHaveLength(1);
  });

  it("reports 403 as a key/credits problem", async () => {
    const { fetchFn } = recordingFetch(() => serperResp([], 403));
    await expect(performWebSearch("x", { ...DEPS, fetchFn })).rejects.toThrow(/credits/);
  });

  it("fails fast with a clear message when no API key is configured", async () => {
    const fetchFn = vi.fn(async () => serperResp([])) as unknown as typeof globalThis.fetch;
    await expect(performWebSearch("x", { fetchFn, apiKey: "" })).rejects.toThrow(
      /SERPER_API_KEY is missing/,
    );
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

describe("performWebSearchBatch", () => {
  it("returns a grouped batch report mentioning every query (POST body echo)", async () => {
    const { fetchFn, calls } = recordingFetch((_n, req) => {
      const q = req.body.q ?? "";
      return serperResp([{ title: `title-${q}`, snippet: `c-${q}`, link: `https://${q}.test` }]);
    });

    const md = await performWebSearchBatch(["q1", "q2"], { ...DEPS, fetchFn });

    expect(md).toContain("# Batch Web Search Results");
    expect(md).toContain("Total queries: 2");
    expect(md).toContain("## Query: q1");
    expect(md).toContain("## Query: q2");
    expect(md).toContain("title-q1");
    expect(md).toContain("title-q2");
    expect(calls.map((c) => c.body.q).sort()).toEqual(["q1", "q2"]);
  });

  it("reports a failed query inside the batch instead of throwing", async () => {
    const { fetchFn } = recordingFetch(() => serperResp([], 400));
    const md = await performWebSearchBatch(["bad"], { ...DEPS, fetchFn });
    expect(md).toContain("Failed: 1");
    expect(md).toContain("Error:");
  });
});

describe("performSerperNewsSearch (raw JSON)", () => {
  function rawResp(body: string, status = 200): Response {
    return new Response(body, { status, headers: { "content-type": "application/json" } });
  }

  it("returns the Serper News body verbatim and sends region/num", async () => {
    const raw = JSON.stringify(
      { news: [{ title: "N1", link: "https://n.test", date: "1 day", source: "Src" }], credits: 1 },
      null,
      2,
    );
    const { fetchFn, calls } = recordingFetch(() => rawResp(raw));

    const out = await performSerperNewsSearch("news", {
      ...DEPS,
      fetchFn,
      region: "belarus",
      count: 20,
    });

    expect(out).toBe(raw);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://google.serper.dev/news");
    expect(calls[0]!.headers["X-API-KEY"]).toBe("k-test");
    expect(calls[0]!.body).toMatchObject({ q: "news", num: 20, gl: "by", hl: "ru" });
  });

  it("omits gl/hl for worldwide", async () => {
    const { fetchFn, calls } = recordingFetch(() => rawResp("{}"));
    await performSerperNewsSearch("x", { ...DEPS, fetchFn, region: "world" });
    expect(calls[0]!.body.gl).toBeUndefined();
    expect(calls[0]!.body.hl).toBeUndefined();
  });

  it("does not retry a 401 and reports the key/credits problem", async () => {
    const { fetchFn, calls } = recordingFetch(() => rawResp("{}", 401));
    await expect(performSerperNewsSearch("x", { ...DEPS, fetchFn })).rejects.toThrow(/SERPER_API_KEY/);
    expect(calls).toHaveLength(1);
  });

  it("fails fast when no API key is configured", async () => {
    const fetchFn = vi.fn() as unknown as typeof globalThis.fetch;
    await expect(performSerperNewsSearch("x", { fetchFn, apiKey: "" })).rejects.toThrow(
      /SERPER_API_KEY is missing/,
    );
    expect(fetchFn).not.toHaveBeenCalled();
  });
});
