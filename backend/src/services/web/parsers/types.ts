export interface NewsItem {
  title: string;
  url: string;
  date: string;
  /**
   * Views when the source exposes them; `null`/absent when unknown. Never a
   * fake `0` — the formatter omits the field instead of printing a lie.
   */
  views?: number | null;
  description: string;
  /** Unix timestamp для сортировки */
  timestamp?: number;
  /** Абсолютный HTTP(S) URL заглавной картинки, если источник её отдаёт. */
  image?: string;
}

/** Health of one news source for the current fetch/parse. */
export type NewsSourceStatus = "ok" | "empty" | "error" | "fallback";

export interface NewsFeedSection {
  source: string;
  url: string;
  items: NewsItem[];
  /** Computed by `searchNews`; absent on hand-built sections (derived on read). */
  status?: NewsSourceStatus;
  error?: string;
  /** Markdown контент при отсутствии парсера (fetch по-старому) */
  fallbackMarkdown?: string;
}

export interface NewsParser {
  /** Домены, которые обрабатывает парсер */
  domains: string[];
  /** Парсит HTML и возвращает массив новостей */
  parse(html: string, baseUrl: string): NewsItem[];
}

/** Детальная статья (страница новости) */
export interface NewsArticle {
  title: string;
  url: string;
  date: string;
  timestamp?: number;
  /** Views when known; omitted/null when the page does not expose them. */
  views?: number | null;
  description: string;
  author?: string;
  body: string;
  tags?: string[];
  source: string;
  /** Абсолютный HTTP(S) URL заглавного фото статьи (og:image / header image). */
  image?: string;
}
