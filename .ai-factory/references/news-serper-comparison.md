# Serper News vs local `search_news` — comparison

Generated: 2026-10-30T10:36:50.187Z
Queries: 24 (0 failed)
Serper credits spent: 24
Content-provider calls for local SSR feeds: 0

## Method

- Every query was sent to `performSerperNewsSearch` (`POST google.serper.dev/news`) with
  an explicit region (`by`→`by`, `ru`→`ru`, `ua`→`ua`, `us`→`us`, `de`→`de`, `world`→`world`).
- `search_news` is a Belarus-only fixed feed; it was run once without a content
  provider and its metrics are reused as the baseline for every `by` row. Other
  regions have no local feed — that is the point of the comparison.
- **Fresh <24h** is the share of items whose date parses to < 24 h old.
  Unparseable dates are counted under **Unknown age** (never assumed fresh).
- **Known-outlet share** = direct publisher links whose host belongs to the
  region's outlet list (or the country TLD); Google wrappers are excluded.
- **Dup rate** = duplicate canonical URLs / all canonical URLs (tracking
  parameters and hash removed).
- `count` is a request, not a guarantee: Serper sometimes returns more items
  than `num`, so the table reports the actual item count.
- Credits are the `credits` value from Serper's body when present, otherwise 1
  per successful request.

## Serper News results

| Query id | Query | Region | Items | Sources | Known outlet | Dup rate | Fresh <24h | Unknown age | Google redirects | Credits |
|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
| by-general | новости Беларуси | by | 10 | 4 | 67% | 0.00 | 100% (10) | 0 | 7 | 1 |
| by-minsk | новости Минска | by | 17 | 7 | 100% | 0.00 | 100% (17) | 0 | 14 | 1 |
| by-brest | новости Бреста | by | 14 | 2 | 0% | 0.00 | 100% (14) | 0 | 11 | 1 |
| by-gomel | новости Гомеля | by | 14 | 10 | 100% | 0.00 | 100% (14) | 0 | 11 | 1 |
| by-grodno | новости Гродно | by | 15 | 4 | 100% | 0.00 | 67% (10) | 0 | 12 | 1 |
| by-society | Беларусь общество | by | 10 | 5 | 100% | 0.00 | 100% (10) | 0 | 7 | 1 |
| by-economy | Беларусь экономика | by | 10 | 8 | 100% | 0.00 | 70% (7) | 0 | 7 | 1 |
| by-incidents | Беларусь происшествия | by | 10 | 6 | 100% | 0.00 | 70% (7) | 0 | 7 | 1 |
| ru-general | новости России | ru | 10 | 10 | 67% | 0.00 | 100% (10) | 0 | 7 | 1 |
| ru-moscow | новости Москвы | ru | 10 | 9 | 67% | 0.00 | 90% (9) | 0 | 7 | 1 |
| ru-spb | новости Санкт-Петербурга | ru | 18 | 4 | 100% | 0.00 | 94% (17) | 0 | 15 | 1 |
| ru-economy | Россия экономика новости | ru | 10 | 10 | 100% | 0.00 | 20% (2) | 0 | 7 | 1 |
| ua-general | новини України | ua | 13 | 12 | 67% | 0.00 | 100% (13) | 0 | 10 | 1 |
| ua-kyiv | новини Києва | ua | 16 | 12 | 100% | 0.00 | 94% (15) | 0 | 13 | 1 |
| ua-lviv | новини Львова | ua | 26 | 12 | 67% | 0.00 | 100% (26) | 0 | 23 | 1 |
| us-general | US news | us | 13 | 12 | 0% | 0.00 | 85% (11) | 0 | 10 | 1 |
| us-ny | New York news | us | 22 | 12 | 67% | 0.00 | 100% (22) | 0 | 19 | 1 |
| us-tech | technology news | us | 10 | 10 | 0% | 0.00 | 100% (10) | 0 | 7 | 1 |
| de-general | Deutschland Nachrichten | de | 11 | 9 | 100% | 0.00 | 91% (10) | 0 | 8 | 1 |
| de-berlin | Berlin Nachrichten | de | 14 | 9 | 100% | 0.00 | 71% (10) | 0 | 11 | 1 |
| de-munich | München Nachrichten | de | 18 | 14 | 100% | 0.00 | 94% (17) | 0 | 15 | 1 |
| world-general | world news | world | 10 | 9 | 33% | 0.00 | 100% (10) | 0 | 7 | 1 |
| world-europe | Europe news | world | 16 | 13 | 67% | 0.00 | 100% (16) | 0 | 13 | 1 |
| world-politics | international politics | world | 10 | 10 | 0% | 0.00 | 100% (10) | 0 | 7 | 1 |

### By region

- **by**: 8 queries, 100 items, fresh 89%, unknown-age 0, known-outlet 83%
- **ru**: 4 queries, 48 items, fresh 79%, unknown-age 0, known-outlet 83%
- **ua**: 3 queries, 55 items, fresh 98%, unknown-age 0, known-outlet 78%
- **us**: 3 queries, 45 items, fresh 96%, unknown-age 0, known-outlet 22%
- **de**: 3 queries, 43 items, fresh 86%, unknown-age 0, known-outlet 100%
- **world**: 3 queries, 36 items, fresh 100%, unknown-age 0, known-outlet 33%

## Local `search_news` baseline (Belarus)

| Source | Items | Fresh <24h | Unknown age |
|---|---:|---:|---:|
| onliner.by | 51 | 30 | 0 |
| tochka.by | 48 | 12 | 0 |
| smartpress.by | 23 | 23 | 0 |
| gismeteo.by | 27 | 6 | 0 |
| wikidom.by | 32 | 0 | 0 |
| **total** | **181** | **71** | **0** |

Open-source errors during the local run:

- none

Local feed fresh share: **39%**
(71 of 181; unknown age 0).

## Payload shape (illustrative, not a captured response)

```json
{
  "news": [
    {
      "title": "…",
      "link": "https://publisher.example/article",
      "snippet": "…",
      "date": "16 hours ago",
      "source": "Publisher",
      "imageUrl": "https://publisher.example/image.jpg"
    }
  ],
  "credits": 1
}
```

Redirect wrappers seen in the wild:

- `https://google.com/goto?url=…` — `google-redirect`; unwrap `url` when
  possible, otherwise never cite it.
- `https://news.google.com/rss/articles/…` — `google-news-redirect`; usually
  not resolvable without a browser, so treat the item as non-citable.

## Observations

- Failures: none.
- Content-provider calls: 0 (expected 0 for SSR feeds).
- Serper credits: 24 for 24 queries.
- Link citability: **72 of 327** items (22%) carried a direct publisher URL;
  **255** (78%) were Google redirect wrappers. A wrapper must be resolved with
  `fetch_url` (the fetched document now reports the final publisher URL in its
  `Source:` line) or dropped — never cited.
- Item count is not bounded by `num`: several queries returned 13–26 items for
  `count: 10`, so the model must not assume a fixed digest size.

## Decision

**Keep both paths.**

- `search_news` stays the zero-credit, fixed Belarus feed: the general BY
  digest and the verticals (gismeteo weather news, wikidom real estate). It
  produced 181 items from 5 sources with 0 provider calls and 0 Serper
  credits; 39% of them were <24h old, which is acceptable for a curated feed
  that also carries older weather/real-estate material.
- `serper_news` becomes the default for query-based regional/city/topic/world
  news: 89% <24h in BY (vs 39% local), 79–100% in RU/UA/US/DE/world, and it
  covers regions the local feed cannot. Use the `site:` recipes for small
  cities (Gomel/Brest) instead of a bare "новости <город>".
- Do not remove `search_news` code or routing: this is not a like-for-like
  replacement (fixed feed vs query search), and local feeds are the only
  zero-credit path for Belarus verticals.
- Link policy: ~78% of Serper links are Google wrappers. Always resolve them
  with `fetch_url` (the final URL is surfaced as `Source:`) and never cite the
  wrapper; unresolved `news.google.com/rss/articles/...` links are dropped.
- Re-check after 1–2 weeks of real usage with the same harness; switch the
  general BY digest to `serper_news` only if it keeps ≥90% freshness and
  redirect resolution proves reliable in production.
