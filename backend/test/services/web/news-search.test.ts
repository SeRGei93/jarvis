import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
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

/** Seconds left on every news cache entry (one entry per requested feed). */
async function cacheSecondsLeft(): Promise<number[]> {
  const dir = join(cacheRoot, "news");
  if (!existsSync(dir)) return [];
  const files = await readdir(dir);
  return Promise.all(
    files.map(async (file) => {
      const raw = JSON.parse(await readFile(join(dir, file), "utf-8")) as {
        expiresAt: number;
      };
      return (raw.expiresAt - Date.now()) / 1000;
    }),
  );
}

/** Simulate the passage of the short negative window without waiting. */
async function expireAll(): Promise<void> {
  const dir = join(cacheRoot, "news");
  for (const file of await readdir(dir)) {
    const path = join(dir, file);
    const entry = JSON.parse(await readFile(path, "utf-8")) as { expiresAt: number };
    entry.expiresAt = Date.now() - 1;
    await writeFile(path, JSON.stringify(entry), "utf-8");
  }
}

describe("searchNews source health", () => {
  it("reports a fetched-but-empty parser as 'empty' and caches it briefly", async () => {
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
    expect(await cacheFiles()).toHaveLength(1);

    // Degraded, so the entry expires on the short window, not on the 30 min TTL.
    const [secondsLeft] = await cacheSecondsLeft();
    expect(secondsLeft).toBeGreaterThan(0);
    expect(secondsLeft).toBeLessThanOrEqual(3 * 60);
  });

  it("serves a degraded feed from the short window, then retries after it expires", async () => {
    const url = "https://tech.onliner.by/";
    const emptyFetch = vi.fn(async () => htmlResp(EMPTY_ONLINER_HTML)) as unknown as typeof globalThis.fetch;

    const first = await searchNews([url], 5000, undefined, {
      fetchFn: emptyFetch,
      lookupFn: publicLookup,
      useCache: true,
    });
    expect(first[0]!.status).toBe("empty");
    const filesAfterFirst = (await cacheFiles()).length;

    // Inside the window the degraded section is served from the cache.
    const throwingFetch = vi.fn(async () => {
      throw new Error("network must not be used");
    }) as unknown as typeof globalThis.fetch;
    const fromCache = await searchNews([url], 5000, undefined, {
      fetchFn: throwingFetch,
      lookupFn: publicLookup,
      useCache: true,
    });
    expect(throwingFetch).not.toHaveBeenCalled();
    expect(fromCache[0]!.status).toBe("empty");

    // After the window it is retried and a good parse replaces the entry.
    await expireAll();
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
    expect(await cacheFiles()).toHaveLength(filesAfterFirst);

    // Third call is served from the (now healthy) cache: no network at all.
    const neverFetch = vi.fn(async () => {
      throw new Error("network must not be used");
    }) as unknown as typeof globalThis.fetch;
    const third = await searchNews([url], 5000, undefined, {
      fetchFn: neverFetch,
      lookupFn: publicLookup,
      useCache: true,
    });
    expect(neverFetch).not.toHaveBeenCalled();
    expect(third[0]!.items).toHaveLength(1);
  });

  it("reports a fetch failure as 'error', caches it briefly and retries after the window", async () => {
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
    expect(await cacheFiles()).toHaveLength(before + 1);

    await expireAll();
    const goodFetch = vi.fn(async () => htmlResp(ONLINER_HTML)) as unknown as typeof globalThis.fetch;
    const retried = await searchNews([url], 5000, undefined, {
      fetchFn: goodFetch,
      lookupFn: publicLookup,
      useCache: true,
    });
    expect(goodFetch).toHaveBeenCalledOnce();
    expect(retried[0]!.status).toBe("ok");
  });
});
