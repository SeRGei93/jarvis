export interface NewsItem {
  title: string;
  url: string;
  date: string;
  views: number;
  description: string;
  /** Unix timestamp для сортировки */
  timestamp?: number;
}

export interface NewsFeedSection {
  source: string;
  url: string;
  items: NewsItem[];
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
  views: number;
  description: string;
  author?: string;
  body: string;
  tags?: string[];
  source: string;
}
