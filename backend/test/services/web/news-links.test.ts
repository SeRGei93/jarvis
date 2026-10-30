import { describe, expect, it } from "vitest";

import {
  canonicalNewsUrl,
  classifyNewsLink,
  newsPublisherHost,
  unwrapGoogleRedirect,
} from "../../../scripts/lib/news-links.js";

describe("classifyNewsLink", () => {
  it("accepts direct publisher URLs", () => {
    expect(classifyNewsLink("https://gp.by/news/123")).toBe("direct");
    expect(classifyNewsLink("https://www.onliner.by/2026/10/29/x")).toBe("direct");
    expect(newsPublisherHost("https://gp.by/news/123")).toBe("gp.by");
  });

  it("marks Google redirect wrappers", () => {
    const link =
      "https://www.google.com/goto?url=https%3A%2F%2Fgp.by%2Fnews%2F123";
    expect(classifyNewsLink(link)).toBe("google-redirect");
    expect(newsPublisherHost(link)).toBeUndefined();
    expect(unwrapGoogleRedirect(link)).toBe("https://gp.by/news/123");
  });

  it("marks Google News article wrappers (unresolvable without a browser)", () => {
    const link = "https://news.google.com/rss/articles/CBMiabc123?oc=5";
    expect(classifyNewsLink(link)).toBe("google-news-redirect");
    expect(unwrapGoogleRedirect(link)).toBeUndefined();
    expect(newsPublisherHost(link)).toBeUndefined();
  });

  it("rejects non-http(s) and malformed links", () => {
    expect(classifyNewsLink("ftp://gp.by/news")).toBe("invalid");
    expect(classifyNewsLink("javascript:alert(1)")).toBe("invalid");
    expect(classifyNewsLink("")).toBe("invalid");
    expect(classifyNewsLink("not a url")).toBe("invalid");
  });
});

describe("canonicalNewsUrl", () => {
  it("unwraps Google redirects", () => {
    const link =
      "https://google.com/goto?url=https%3A%2F%2Fgp.by%2Fnews%2F1%3Futm_source%3Dnews";
    expect(canonicalNewsUrl(link)).toBe("https://gp.by/news/1");
  });

  it("strips tracking params and hash and sorts the rest", () => {
    expect(
      canonicalNewsUrl("https://GP.BY/news/1?b=2&utm_source=x&a=1#comments"),
    ).toBe("https://gp.by/news/1?a=1&b=2");
  });

  it("returns undefined for invalid links", () => {
    expect(canonicalNewsUrl("javascript:void(0)")).toBeUndefined();
  });
});
