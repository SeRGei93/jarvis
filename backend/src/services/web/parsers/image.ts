/**
 * Извлечение заглавной картинки из элемента-карточки новости. Поддерживает
 * `<img src/data-src>`, `<img srcset>` / `<picture><source srcset>` (берётся самый
 * крупный вариант) и инлайновый `background-image`. Возвращает только абсолютный
 * HTTP(S) URL; data:-URI, не-HTTP схемы и `.svg`-иконки отбрасываются.
 */

/** Признаки заглушек/плейсхолдеров lazy-загрузки (не настоящее фото). */
const PLACEHOLDER_RE = /(empty|placeholder|no-?photo|no-?image|blank|spacer|transparent|1x1|pixel|stub|lazyload|loading)/i;

/** Резолвит относительный URL в абсолютный и пропускает только http(s), не svg/data/заглушки. */
export function toAbsoluteHttp(raw: string | undefined | null, baseUrl: string): string | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.startsWith("data:")) return undefined;
  try {
    const u = new URL(trimmed, baseUrl);
    if (u.protocol !== "http:" && u.protocol !== "https:") return undefined;
    if (/\.svg(\?|$)/i.test(u.pathname)) return undefined; // иконки, не фото
    if (PLACEHOLDER_RE.test(u.pathname)) return undefined; // lazy-плейсхолдер (напр. empty_1600_1200.png)
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

  // 2. Ленивые атрибуты ПЕРЕД `src` — у lazy-картинок реальный URL в data-*,
  //    а в `src` лежит заглушка.
  const direct =
    img?.getAttribute("data-src") ??
    img?.getAttribute("data-original") ??
    img?.getAttribute("data-lazy-src") ??
    img?.getAttribute("src") ??
    undefined;
  const fromImg = toAbsoluteHttp(direct, baseUrl);
  if (fromImg) return fromImg;

  // 3. Инлайновый background-image — на самом элементе ИЛИ у потомка.
  const styledEl = el.matches("[style*='background-image']")
    ? el
    : el.querySelector<HTMLElement>("[style*='background-image']");
  return toAbsoluteHttp(extractBgUrl(styledEl?.getAttribute("style") ?? undefined), baseUrl);
}

/**
 * Собирает до `max` различных абсолютных URL картинок внутри `root`
 * (<img>, <picture><source srcset>, inline background-image). Порядок сохраняется,
 * дубли убираются. Используется для сбора галереи объявления под коллаж/слайдшоу.
 */
export function collectImageUrls(root: ParentNode, baseUrl: string, max = 8): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (raw?: string): void => {
    const abs = toAbsoluteHttp(raw, baseUrl);
    if (abs && !seen.has(abs)) {
      seen.add(abs);
      out.push(abs);
    }
  };
  for (const img of root.querySelectorAll("img")) {
    if (out.length >= max) return out;
    add(
      pickFromSrcset(img.getAttribute("srcset") ?? undefined) ??
        img.getAttribute("data-src") ??
        img.getAttribute("data-original") ??
        img.getAttribute("data-lazy-src") ??
        img.getAttribute("src") ??
        undefined,
    );
  }
  for (const source of root.querySelectorAll("source[srcset]")) {
    if (out.length >= max) return out;
    add(pickFromSrcset(source.getAttribute("srcset") ?? undefined));
  }
  for (const styled of root.querySelectorAll("[style*='background-image']")) {
    if (out.length >= max) return out;
    add(extractBgUrl(styled.getAttribute("style") ?? undefined));
  }
  return out;
}
