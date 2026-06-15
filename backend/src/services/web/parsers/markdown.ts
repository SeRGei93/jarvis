import type { NewsArticle, NewsFeedSection, NewsItem } from "./types.js";

export interface NewsItemWithSource extends NewsItem {
  source: string;
}

export function formatNewsToMarkdown(items: NewsItem[]): string {
  if (items.length === 0) return "";

  return items
    .map(
      (item) =>
        `- **[${item.title}](${item.url})**  
  ${item.description}  
  Просмотров: ${item.views} | ${item.date}`
    )
    .join("\n\n");
}

export function formatArticleToMarkdown(article: NewsArticle): string {
  const parts: string[] = [`# ${article.title}`, "", `Источник: [${article.source}](${article.url})`, ""];
  if (article.author) parts.push(`Автор: ${article.author}`);
  if (article.date) parts.push(`Дата: ${article.date}`);
  if (article.views > 0) parts.push(`Просмотров: ${article.views}`);
  if (article.tags?.length) parts.push(`Теги: ${article.tags.join(", ")}`);
  parts.push("");
  if (article.description) {
    parts.push(article.description, "");
  }
  parts.push("---", "", article.body);
  return parts.join("\n");
}

export function formatNewsWithSourceToMarkdown(items: NewsItemWithSource[]): string {
  if (items.length === 0) return "";

  const list = items
    .map(
      (item) =>
        `- **[${item.title}](${item.url})** (${item.source})\n  ${item.description}\n  Просмотров: ${item.views} | ${item.date}`
    )
    .join("\n\n");
  return `## Новости (сортировка по дате, самые свежие первыми)\n\n${list}`;
}

export function formatFeedSectionsToMarkdown(sections: NewsFeedSection[]): string {
  return sections
    .map((section) => {
      if (section.fallbackMarkdown) {
        return `## ${section.source}\n\n${section.fallbackMarkdown}`;
      }
      if (section.error) {
        return `## ${section.source}\n\nОшибка: ${section.error}`;
      }
      const markdown = formatNewsToMarkdown(section.items);
      return `## ${section.source}\n\n${markdown || "Новостей не найдено."}`;
    })
    .join("\n\n---\n\n");
}
