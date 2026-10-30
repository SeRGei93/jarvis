import { mkdtemp, readdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// CACHE_DIR is resolved from env at module load, so point it at a temp dir
// BEFORE importing the news service. Every import below is dynamic on purpose.
const cacheRoot = await mkdtemp(join(tmpdir(), "jarvis-news-cache-"));
process.env.WEB_CACHE_DIR = cacheRoot;

const publicLookup = async () => [{ address: "93.184.216.34", family: 4 }];

function htmlResp(body: string, status = 200): Response {
  return new Response(body, { status, headers: { "content-type": "text/html" } });
}

const ONLINER_HTML = `<html><body>
  <div class="news-tidings">
    <div class="news-tidings__item" data-post-date="1793250010">
      <a class="news-tidings__link" href="/2026/10/29/headline"><span>Headline</span></a>
      <div class="news-tidings__speech">Short description</div>
      <div class="news-tidings__time">29 октября 2026</div>
    </div>
  </div>
</body></html>`;

const EMPTY_ONLINER_HTML = `<html><body><div class="news-tidings"></div></body></html>`;

type SearchNews = typeof import("../../../src/services/web/parsers/index.js").searchNews;
let searchNews: SearchNews;

beforeAll(async () => {
  ({ searchNews } = await import("../../../src/services/web/parsers/index.js"));
});

afterAll(async () => {
  await rm(cacheRoot, { recursive: true, force: true });
});

async function cacheFiles(): Promise<string[]> {
  const dir = join(cacheRoot, "news");
  if (!existsSync(dir)) return [];
  return readdir(dir);
}

describe("searchNews source health", () => {
  it("reports a fetched-but-empty parser as 'empty' and does not cache it", async () => {
    const url = "https://money.onliner.by/";
    const fetchFn = vi.fn(async () => htmlResp(EMPTY_ONLINER_HTML)) as unknown as typeof globalThis.fetch;

    const sections = await searchNews([url], 5000, undefined, {
      fetchFn,
      lookupFn: publicLookup,
      useCache: true,
    });

    expect(sections).toHaveLength(1);
    expect(sections[0]!.status).toBe("empty");
    expect(sections[0]!.error).toBeUndefined();
    expect(await cacheFiles()).toHaveLength(0);
  });

  it("retries an empty source on the next call (no negative caching) and caches success", async () => {
    const url = "https://tech.onliner.by/";
    const emptyFetch = vi.fn(async () => htmlResp(EMPTY_ONLINER_HTML)) as unknown as typeof globalThis.fetch;

    const first = await searchNews([url], 5000, undefined, {
      fetchFn: emptyFetch,
      lookupFn: publicLookup,
      useCache: true,
    });
    expect(first[0]!.status).toBe("empty");
    expect(await cacheFiles()).toHaveLength(0);

    const goodFetch = vi.fn(async () => htmlResp(ONLINER_HTML)) as unknown as typeof globalThis.fetch;
    const second = await searchNews([url], 5000, undefined, {
      fetchFn: goodFetch,
      lookupFn: publicLookup,
      useCache: true,
    });
    expect(goodFetch).toHaveBeenCalledOnce();
    expect(second[0]!.status).toBe("ok");
    expect(second[0]!.items).toHaveLength(1);
    expect(second[0]!.items[0]!.title).toBe("Headline");
    expect(second[0]!.items[0]!.views).toBeNull();
    expect(await cacheFiles()).toHaveLength(1);

    // Third call is served from the cache: no network at all.
    const throwingFetch = vi.fn(async () => {
      throw new Error("network must not be used");
    }) as unknown as typeof globalThis.fetch;
    const third = await searchNews([url], 5000, undefined, {
      fetchFn: throwingFetch,
      lookupFn: publicLookup,
      useCache: true,
    });
    expect(throwingFetch).not.toHaveBeenCalled();
    expect(third[0]!.items).toHaveLength(1);
  });

  it("reports a fetch failure as 'error' and does not cache it", async () => {
    const url = "https://people.onliner.by/";
    const before = (await cacheFiles()).length;
    const fetchFn = vi.fn(async () => {
      throw new Error("HTTP 503");
    }) as unknown as typeof globalThis.fetch;

    const sections = await searchNews([url], 5000, undefined, {
      fetchFn,
      lookupFn: publicLookup,
      useCache: true,
    });

    expect(sections[0]!.status).toBe("error");
    expect(sections[0]!.error).toContain("HTTP 503");
    expect(await cacheFiles()).toHaveLength(before);
  });
});
