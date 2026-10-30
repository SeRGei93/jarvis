# Implementation Plan: применение `serper_news` и доводка новостного контура

Branch: main (fast plan, без новой ветки)
Created: 2026-10-30

## Settings
- Testing: yes
- Logging: minimal (WARN/ERROR; без DEBUG-потока)
- Docs: yes — обязательный docs-checkpoint в конце

## Roadmap Linkage
Milestone: "none"
Rationale: пользователь выбрал не привязывать план к milestone; кандидат — M18 (структурированная выдача новостей).

## Research Context
Source: `.ai-factory/RESEARCH.md` (Active Summary), обновлено текущей сессией.

Goal:
- Применять `serper_news` как query-based news-поиск, не ломая локальный `search_news`.
- Проверить, насколько хорошо Serper ищет региональные новости, и решить, можно ли позже отказаться от `search_news` для общего дайджеста.
- Сохранить экономию: локальный readable/Firecrawl fallback не должен тратить кредиты на SSR-страницы.

Constraints:
- Маленький сервер: без self-host браузера; Firecrawl только fallback.
- `search_news` остаётся локальным фиксированным фидом для Беларуси (0 Serper/Firecrawl кредитов).
- `serper_news` возвращает сырой JSON; не форматировать и не терять `date`/`source`/`snippet`/`link`.
- Все новые сетевые вызовы инъектируемы (`fetchFn`), тесты без сети.

Decisions:
- Не отказываться от `search_news` до сравнительного прогона.
- Для небольших городов использовать `site:` по локальным изданиям, а не общий запрос «новости X».
- `serper_news` — отдельный инструмент (22-й в web bucket), не менять контракт `web_search` в этом плане.

Open questions:
- Нужен ли в будущем raw-режим для `web_search` (`/search`), или достаточно `serper_news` + текущего markdown-контракта.
- `maxChars` default 30–40k выбран; `offset`/`section` для длинных страниц — follow-up, не в этом плане.
- Заменять ли общий белорусский дайджест на `serper_news` после 1–2 недель сравнения.

## Current State (already delivered, do not redo)
- `a0e2faf`: локальный Readability/Turndown, `ContentProvider` + Firecrawl fallback, cookie-challenge Tochka, Onliner `news-tiles`, Wikidom SSR fallback, per-source news quota.
- `c78ce9f`: `serper_news` (raw JSON), news-skill routing, docs/tests.
- Live-аудит: все 5 источников `search_news` работают локально, 0 Firecrawl-вызовов; `serper_news` даёт хорошие результаты для BY/Minsk/Brest/UA/US, смешанные для Gomel/RU/DE.

## Commit Plan
- **Commit 1** (after tasks 1–2): `test(news): add regional serper_news comparison harness`
- **Commit 2** (after tasks 3–4): `fix(news): surface source health and budget fetched content`
- **Commit 3** (after tasks 5–7): `docs(news): document serper_news routing and credit policy`

## Tasks

### Phase 1: Применить и измерить `serper_news`

- [x] **Task 1 — Сравнительный harness `search_news` vs `serper_news`**
  Создать `backend/scripts/news-compare.ts` (запуск через `tsx`), который:
  - берёт набор запросов: Беларусь общее, Минск, Брест, Гомель, Россия, Украина, США, Германия;
  - вызывает `searchNews` без провайдера и `performSerperNewsSearch` с тем же регионом;
  - считает: количество items, уникальные источники, долю локальных источников, дубли, количество «свежих» (по `timestamp`/относительной дате), число Serper-кредитов и вызовов Firecrawl-провайдера (для проверки — инжектировать counting-provider, который не должен вызываться);
  - классифицирует ссылки: `google.com/goto?url=...` помечает как `google-redirect` и не считает валидным источником; канонический `source`/оригинальный URL — валидным;
  - учитывает, что Serper может вернуть больше `num` (в live-тесте вернул 14 при `count=5`), поэтому `count` — не гарантия размера;
  - пишет отчёт в `.ai-factory/references/news-serper-comparison.md` (таблица + примеры структуры, без полных сырых JSON).
  Для freshness-метрики добавить `backend/scripts/lib/serper-date.ts` с `parseSerperRelativeDate(date, now, locale?)`: поддержка ru/en/de/uk (`сегодня`, `N часов назад`, `16 hours ago`, `vor 5 Stunden`, `2 тижні тому`) и абсолютных дат (`20 авг. 2026 г.`); если локаль не распознана — вернуть `undefined`, а harness считает такие items `unknown-age`.
  Логирование (minimal): `WARN` на каждый неудачный источник/запрос, `ERROR` при полном провале прогона; без DEBUG.
  Файлы: `backend/scripts/news-compare.ts`, `backend/scripts/lib/serper-date.ts`, `.ai-factory/references/news-serper-comparison.md`.
  Тесты: unit-тест парсера дат (ru/en/de/uk + absolute + unknown) в `backend/test/services/web/serper-date.test.ts`; при необходимости — тест классификатора redirect-ссылок.

- [x] **Task 2 — Региональные рецепты для малых городов**
  Обновить `backend/skills/news/SKILL.md`: для городов, где общий `serper_news` даёт старьё/шум (Гомель и аналогичные), использовать `site:` по локальным изданиям (`gp.by`, `newsgomel.by`, `vb.by`, `brestcity.com`, `minsknews.by` и т.п.), с явным `region`.
  Добавить точные примеры запросов: `новости Гомеля site:gp.by OR site:newsgomel.by`, `новости Бреста site:vb.by OR site:brestcity.com`; таблицу «город → источники»; правило: если `<24ч` новостей нет — сказать об этом, не выдавать старое за свежее.
  Добавить правило про ссылки: `google.com/goto?url=...` не цитировать; использовать канонический URL из `source`/оригинальной ссылки, неразрешённый redirect отбрасывать.
  Логирование (minimal): не добавлять логи в промпт; изменения только в skill-файле.
  Файлы: `backend/skills/news/SKILL.md`.
  Тесты: обновить/добавить проверку, что `allowed-tools` содержит `serper_news`, в skill нет упоминаний SearXNG и есть правило про `google.com/goto`.

### Phase 2: Наблюдаемость и качество `search_news`

- [x] **Task 3 — Сделать деградацию `search_news` видимой**
  Сейчас пустой ответ парсера и ошибка источника могут выглядеть как «новостей нет», а ошибки/пустышки кэшируются на 30 минут. `formatNewsWithSourceToMarkdown` используется при непустом `merged` и не показывает ошибки источников.
  Изменить `backend/src/services/web/parsers/index.ts` и `markdown.ts`:
  - добавить в результат по каждому источнику `{source, count, error?, fallback?}` и выводить блок `Sources` **в обоих** форматтерах (`formatNewsWithSourceToMarkdown` и `formatFeedSectionsToMarkdown`), а не только в полностью пустом ответе;
  - если страница получена, но распаршено 0 — это `WARN`-статус «parser returned 0», а не тихий ноль;
  - не писать в кэш секции с ошибкой/нулём (или короткий negative TTL);
  - исправить ключ кэша: `getCacheIdForSite` для произвольного URL сейчас берёт только hostname — два разных URL на одном хосте делят один кэш; использовать полный нормализованный URL + версию парсера;
  - `views` сделать `number | null`/optional, чтобы не печатать фейковый `0`; в markdown выводить `Просмотров: н/д` или опускать поле.
  Логирование (minimal): `WARN` на источник с ошибкой/нулём, `ERROR` если все источники пусты; без DEBUG.
  Файлы: `backend/src/services/web/parsers/index.ts`, `backend/src/services/web/parsers/markdown.ts`, `backend/src/services/web/parsers/types.ts`, `backend/src/services/web/config.ts`.
  Тесты: `backend/test/services/web/parsers.test.ts` — пустой парсер, ошибка источника, статус при непустом merged, отсутствие фейкового `views: 0`, negative-cache, коллизия URL-кэша.

- [x] **Task 4 — Бюджет вывода `fetch_url`/Readability**
  Ограничить длинные страницы (пример: Wikipedia — 291k символов Markdown), чтобы не раздувать контекст и не терять хвост.
  Контракт:
  - кэшировать **полный** извлечённый текст (raw/readable), а обрезать на границе tool-вывода, чтобы повторный запрос мог получить хвост;
  - добавить `maxChars` в схему `fetch_url` (`backend/src/mastra/tools/web.ts`), default 30–40k, допустимый диапазон 1k–100k;
  - применять лимит и к provider-output (Firecrawl fallback), а не только к локальному Readability;
  - в ответе добавлять `[truncated: показано X из Y]`; `offset`/`section` — **вне v1** (зафиксировать в плане как follow-up).
  Логирование (minimal): `WARN` при обрезке с `{url, shown, total}`; `ERROR` при невозможности извлечь контент.
  Файлы: `backend/src/services/web/fetch.ts`, `backend/src/services/web/readable.ts`, `backend/src/mastra/tools/web.ts`.
  Тесты: `backend/test/services/web/fetch.test.ts`, `backend/test/services/web/readable.test.ts` — обрезка, пометка, provider-output cap, короткая статья не обрезается, кэш хранит полный текст.

### Phase 3: Документация и проверка

- [x] **Task 5 — Решить судьбу `search_news` по результатам Task 1** *(depends on Task 1)*
  На основании отчёта зафиксировать решение в плане/доке. Критерии (N≥20 запросов, включая BY/Minsk/Brest/Gomel/RU/UA/US/DE):
  - fresh <24h: доля свежих items;
  - unique sources и local-source share;
  - duplicate rate;
  - Serper credits per digest и Firecrawl calls (должно быть 0 для SSR).
  Решение:
  - оставить `search_news` для Беларуси/погоды/недвижимости;
  - либо перевести общий дайджест на `serper_news`, оставив локальные фиды только для вертикалей.
  Не удалять код до появления отчёта и решения; если Serper не выигрывает по freshness/coverage — оставить оба пути.
  Логирование: не применимо (аналитический шаг).
  Файлы: `.ai-factory/references/news-serper-comparison.md`, `docs/web-search.md`.

- [x] **Task 6 — Docs checkpoint** *(depends on Tasks 1–5)*
  Обновить:
  - `docs/web-search.md` — `serper_news`, routing, credit policy, local-first;
  - `docs/tools.md` — 22 инструмента, группа Search/news;
  - `docs/configuration.md` — `CONTENT_PROVIDER`/Firecrawl как fallback;
  - `AGENTS.md` — при необходимости структура `services/web/content`.
  Логирование: не применимо.
  Файлы: `docs/web-search.md`, `docs/tools.md`, `docs/configuration.md`, `AGENTS.md`.

- [x] **Task 7 — Верификация** *(depends on Tasks 1–6)*
  Запустить в `backend/`:
  - `npm run typecheck`;
  - `npm test`;
  - детерминированные тесты news-контура: raw JSON `serper_news`, source status при непустом merged, truncation marker, cache full text; `npm run eval` не требуется, если отдельный news-eval сценарий не добавлен;
  - ручной smoke: `serper_news` по BY/Minsk/Brest/Gomel, `search_news` по всем 5 источникам, `fetch_url` на статье и на длинной странице.
  Проверить: 0 Firecrawl-вызовов на SSR-новостях, `serper_news` не форматирует JSON, пустые источники видны, обрезка помечена.
  Логирование: `ERROR` только на реальные сбои; отчёт о количестве credits/вызовов.
  Файлы: `backend/test/services/web/news-tool.test.ts` (новый), `backend/test/services/web/fetch.test.ts`, `backend/test/services/web/parsers.test.ts`.
