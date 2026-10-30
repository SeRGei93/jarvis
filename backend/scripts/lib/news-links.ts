/**
 * Link classification for news-comparison metrics.
 *
 * Serper News sometimes returns Google redirect wrappers instead of the
 * publisher URL. Those are not citable sources: the harness counts them
 * separately and never treats them as a publisher hit.
 */

export type NewsLinkKind =
  /** A direct publisher URL (`https://gp.by/...`). */
  | "direct"
  /** `google.com/goto?url=...` / `google.com/url?q=...` wrapper. */
  | "google-redirect"
  /** `news.google.com/rss/articles/...` wrapper (usually unresolvable without JS). */
  | "google-news-redirect"
  /** Not a usable http(s) URL. */
  | "invalid";

function safeUrl(link: string): URL | undefined {
  try {
    return new URL(link);
  } catch {
    return undefined;
  }
}

/** Classify one `news[].link` value. */
export function classifyNewsLink(link: string): NewsLinkKind {
  if (typeof link !== "string" || !link.trim()) return "invalid";
  const url = safeUrl(link.trim());
  if (!url || (url.protocol !== "http:" && url.protocol !== "https:")) {
    return "invalid";
  }

  const host = url.hostname.toLowerCase();
  if (host === "news.google.com") return "google-news-redirect";
  if (
    (host === "google.com" || host.endsWith(".google.com")) &&
    (url.pathname === "/goto" || url.pathname === "/url")
  ) {
    return "google-redirect";
  }
  return "direct";
}

/**
 * Return the original publisher URL hidden in a Google wrapper, when it can be
 * recovered without following the redirect. `undefined` for direct/invalid
 * links or an unresolvable Google News article id.
 */
export function unwrapGoogleRedirect(link: string): string | undefined {
  const kind = classifyNewsLink(link);
  if (kind !== "google-redirect") return undefined;
  const url = safeUrl(link.trim());
  if (!url) return undefined;
  const target = url.searchParams.get("url") ?? url.searchParams.get("q");
  if (!target) return undefined;
  const unwrapped = safeUrl(target);
  if (!unwrapped || (unwrapped.protocol !== "http:" && unwrapped.protocol !== "https:")) {
    return undefined;
  }
  return unwrapped.href;
}

/**
 * Canonical form for duplicate detection: lowercase host, no hash, tracking
 * parameters removed, remaining query params sorted.
 */
export function canonicalNewsUrl(link: string): string | undefined {
  const raw = unwrapGoogleRedirect(link) ?? link;
  const url = safeUrl(raw);
  if (!url || (url.protocol !== "http:" && url.protocol !== "https:")) {
    return undefined;
  }
  url.hash = "";
  const tracking = /^(utm_|fbclid$|gclid$|yclid$|mc_cid$|mc_eid$|ref$|source$)/i;
  for (const key of [...url.searchParams.keys()]) {
    if (tracking.test(key)) url.searchParams.delete(key);
  }
  url.searchParams.sort();
  return url.href;
}

/** Hostname of a direct publisher link, or `undefined` for wrappers/invalid. */
export function newsPublisherHost(link: string): string | undefined {
  if (classifyNewsLink(link) !== "direct") return undefined;
  return safeUrl(link.trim())?.hostname.toLowerCase();
}
