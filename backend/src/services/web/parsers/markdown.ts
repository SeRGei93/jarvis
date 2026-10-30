import type {
  NewsArticle,
  NewsFeedSection,
  NewsItem,
  NewsSourceStatus,
} from "./types.js";

export interface NewsItemWithSource extends NewsItem {
  source: string;
}

/** Derive a section's health; explicit `status` wins, otherwise infer it. */
export function newsSectionStatus(section: NewsFeedSection): NewsSourceStatus {
  if (section.status) return section.status;
  if (section.error) return "error";
  if (section.fallbackMarkdown) return "fallback";
  return section.items.length > 0 ? "ok" : "empty";
}

/**
 * One compact `Sources` block shared by both news formatters. It must be shown
 * even when SOME items were merged — otherwise a degraded source looks like
 * "no news today" instead of "this source failed".
 *
 * `shownCounts` maps a source to how many of its items actually reached the
 * merged digest; without it the block reports how many the source produced.
 */
export function formatNewsSourceStatuses(
  sections: NewsFeedSection[],
  shownCounts?: ReadonlyMap<string, number>,
): string {
  if (sections.length === 0) return "";
  const lines = sections.map((section) => {
    const status = newsSectionStatus(section);
    switch (status) {
      case "ok": {
        const found = section.items.length;
        const shown = shownCounts?.get(section.source);
        return shown !== undefined && shown !== found
          ? `- ${section.source}: ${found} новостей (${shown} в дайджесте)`
          : `- ${section.source}: ${found} новостей`;
      }
      case "empty":
        return `- ${section.source}: пусто (парсер вернул 0)`;
      case "fallback":
        return `- ${section.source}: fallback (markdown страницы)`;
      case "error":
        return `- ${section.source}: ошибка — ${section.error ?? "неизвестно"}`;
    }
  });
  return `## Источники\n${lines.join("\n")}`;
}

/** `Просмотров: N | date` when views are known, just `date` otherwise. */
function formatMetaLine(item: NewsItem): string {
  const parts: string[] = [];
  if (typeof item.views === "number") parts.push(`Просмотров: ${item.views}`);
  if (item.date) parts.push(item.date);
  return parts.join(" | ");
}

export function formatNewsToMarkdown(items: NewsItem[]): string {
  if (items.length === 0) return "";

  return items
    .map((item) => {
      const lines = [`- **[${item.title}](${item.url})**  `, `  ${item.description}  `];
      if (item.image) lines.push(`  Фото: ${item.image}  `);
      const meta = formatMetaLine(item);
      if (meta) lines.push(`  ${meta}`);
      return lines.join("\n");
    })
    .join("\n\n");
}

export function formatArticleToMarkdown(article: NewsArticle): string {
  const parts: string[] = [`# ${article.title}`, "", `Источник: [${article.source}](${article.url})`, ""];
  if (article.image) parts.push(`Фото: ${article.image}`);
  if (article.author) parts.push(`Автор: ${article.author}`);
  if (article.date) parts.push(`Дата: ${article.date}`);
  if (typeof article.views === "number" && article.views > 0) {
    parts.push(`Просмотров: ${article.views}`);
  }
  if (article.tags?.length) parts.push(`Теги: ${article.tags.join(", ")}`);
  parts.push("");
  if (article.description) {
    parts.push(article.description, "");
  }
  parts.push("---", "", article.body);
  return parts.join("\n");
}

/**
 * Merged feed. Pass `sections` to append the per-source health block; the tool
 * layer always does, so a partially degraded feed is visible.
 */
export function formatNewsWithSourceToMarkdown(
  items: NewsItemWithSource[],
  sections?: NewsFeedSection[],
): string {
  if (items.length === 0) return "";

  const list = items
    .map((item) => {
      const lines = [`- **[${item.title}](${item.url})** (${item.source})`, `  ${item.description}`];
      if (item.image) lines.push(`  Фото: ${item.image}`);
      const meta = formatMetaLine(item);
      if (meta) lines.push(`  ${meta}`);
      return lines.join("\n");
    })
    .join("\n\n");
  const statuses = sections && sections.length > 0
    ? `\n\n${formatNewsSourceStatuses(sections, countBySource(items))}`
    : "";
  return `## Новости (сортировка по дате, самые свежие первыми)\n\n${list}${statuses}`;
}

/** How many items of each source survived `mergeAndLimitNews`. */
function countBySource(items: NewsItemWithSource[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const item of items) counts.set(item.source, (counts.get(item.source) ?? 0) + 1);
  return counts;
}

export function formatFeedSectionsToMarkdown(sections: NewsFeedSection[]): string {
  if (sections.length === 0) return "Новостей не найдено.";

  const body = sections
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

  return `${body}\n\n---\n\n${formatNewsSourceStatuses(sections)}`;
}
