/**
 * Извлечение заглавной картинки из элемента-карточки новости. Поддерживает
 * `<img src/data-src>`, `<img srcset>` / `<picture><source srcset>` (берётся самый
 * крупный вариант) и инлайновый `background-image`. Возвращает только абсолютный
 * HTTP(S) URL; data:-URI, не-HTTP схемы и `.svg`-иконки отбрасываются.
 */

/** Резолвит относительный URL в абсолютный и пропускает только http(s), не svg/data. */
export function toAbsoluteHttp(raw: string | undefined | null, baseUrl: string): string | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.startsWith("data:")) return undefined;
  try {
    const u = new URL(trimmed, baseUrl);
    if (u.protocol !== "http:" && u.protocol !== "https:") return undefined;
    if (/\.svg(\?|$)/i.test(u.pathname)) return undefined; // иконки, не фото
    return u.href;
  } catch {
    return undefined;
  }
}

/** Из srcset ("url 280w, url 800w") берёт URL с наибольшей шириной (или первый). */
function pickFromSrcset(srcset?: string): string | undefined {
  if (!srcset) return undefined;
  let best: { url: string; w: number } | undefined;
  for (const part of srcset.split(",")) {
    const seg = part.trim();
    if (!seg) continue;
    const [url, desc] = seg.split(/\s+/, 2);
    if (!url) continue;
    const m = desc?.match(/(\d+)w/);
    const w = m ? Number.parseInt(m[1], 10) : 0;
    if (!best || w > best.w) best = { url, w };
  }
  return best?.url;
}

/** Достаёт URL из `style="background-image:url(...)"`. */
function extractBgUrl(style?: string): string | undefined {
  if (!style) return undefined;
  const m = style.match(/background-image\s*:\s*url\((['"]?)([^'")]+)\1\)/i);
  return m?.[2];
}

/** Лучший URL заглавной картинки внутри элемента-карточки, либо undefined. */
export function extractImageUrl(el: Element, baseUrl: string): string | undefined {
  const img = el.querySelector("img");

  // 1. srcset (img или picture>source) — берём самый крупный вариант.
  const srcset =
    img?.getAttribute("srcset") ?? el.querySelector("source[srcset]")?.getAttribute("srcset") ?? undefined;
  const fromSet = toAbsoluteHttp(pickFromSrcset(srcset), baseUrl);
  if (fromSet) return fromSet;

  // 2. Прямой src / ленивые атрибуты.
  const direct =
    img?.getAttribute("src") ??
    img?.getAttribute("data-src") ??
    img?.getAttribute("data-original") ??
    img?.getAttribute("data-lazy-src") ??
    undefined;
  const fromImg = toAbsoluteHttp(direct, baseUrl);
  if (fromImg) return fromImg;

  // 3. Инлайновый background-image.
  const styled = el.querySelector<HTMLElement>("[style*='background-image']")?.getAttribute("style") ?? undefined;
  return toAbsoluteHttp(extractBgUrl(styled), baseUrl);
}
