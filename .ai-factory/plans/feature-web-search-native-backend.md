# Встроенный web-search в backend (перенос из mcp-servers)

**Branch:** `feature/web-search-native-backend`
**Created:** 2026-06-15
**Type:** feature / refactor

## Settings
- **Testing:** yes — unit-тесты с инъекцией `fetchFn` (парсеры, SearXNG-клиент, SSRF-guard, execute инструментов) по harness jarvis (vitest)
- **Logging:** verbose (DEBUG) — подробные логи на каждом HTTP-вызове web-слоя (URL, cache hit/miss, выбор парсера, кол-во результатов); секреты не логируются (pino redact)
- **Docs:** yes — обязательный чекпоинт документации на завершении (`/aif-docs`)

## Roadmap Linkage
- **Milestone:** "M11 — встроенный web-search (нативные инструменты)"
- **Rationale:** M0–M9 закрыты; это новый объём — перенос внешнего MCP-сервиса `search` в backend как нативных инструментов. **Внимание:** план отменяет ранее зафиксированные решения — ROADMAP §9 («search оставляем как отдельный MCP-сервис»), parity-заметку «MCP `search` only» и §10.3 (weather как MCP-tool). Фактическое обновление ROADMAP/ARCHITECTURE/CLAUDE — follow-up через `/aif-roadmap` и `/aif-rules` (планировщик владеет только plan-файлами).

## Research Context (из RESEARCH.md → Active Summary)
- **Topic:** Код web-search **встраивается нативно в `backend/`** (не отдельный MCP-контейнер). searxng + redis остаются контейнерами.
- **Goal:** Поиск/скрейпинг доступны агенту как **нативные AI-SDK инструменты** через `registry.ts`, без MCP-транспорта и без headless-браузера.
- **Constraints:** ❌ без Chromium/Playwright (только нативный `fetch` + `jsdom`/`turndown`); Mastra fetch/HTML-хелперов НЕ даёт. 🗑️ MCP-плумбинг удаляем целиком. 🆕 база с нуля — миграций нет (`mcp_servers` — строка в key/value `settings`, не колонка). 🔧 не переносить тупо — адаптировать и улучшать.
- **Decisions:** `web_fetch`→`fetch_url`; `nesty_*` НЕ переносим (сайт мёртв); cars.av.by/kufar.by — SSR, голый fetch вместо браузера (риск 403 → реалистичные заголовки); 103by 29→~4 инструмента; MCP-resources → lookup-тулзы; `realty` → `kufar_search`+`web_search`; weather переносим (нативного в jarvis нет).
- **Success signals:** навыки вызывают нативные инструменты, в логах нет «tool not available»; typecheck+test зелёные; SSRF-guard на `fetch_url`; в compose app+searxng+redis; образ app без Chromium.

## Целевая структура
```
backend/src/
  services/web/          # портированная логика (services-слой, domain чистый)
    config.ts types.ts cache.ts fetch-cache.ts
    search.ts            # SearXNG-клиент (fetchFn инъекция)
    fetch.ts ssrf-guard.ts   # fetchRawHtml + fetchPageAsMarkdown + SSRF (без браузера)
    parsers/             # news/article/page парсеры (jsdom/turndown)
    kufar/ avby/ rabota/ transport/ relax/ weather/ med103/
  mastra/tools/web.ts    # WEB_TOOL_NAMES + buildWebTools(ctx) → AI-SDK ToolSet
  mastra/tools/registry.ts   # + bucket web; − fallback ctx.mcpTools
deploy/searxng/{settings.yml,limiter.toml}
docker-compose.yaml / docker-compose.local.yml   # + redis + searxng
```

## Tasks

### Фаза 1 — Инфраструктура
- [x] **#1** Инфраструктура: searxng + redis в docker-compose — конфиг searxng в `deploy/searxng/`, сервисы redis+searxng в обоих compose, `secret_key`/`SEARXNG_*` из `.env`, app → `SEARXNG_URL=http://searxng:8080`. **+** `SEARXNG_URL`(+опц.`SEARXNG_ENGINES`) в zod `EnvSchema` (`config/env.ts`), не только в `.env.example`; web-кэш под уже примонтированный том `/data/web-cache` (без нового тома).

### Фаза 2 — Фундамент services/web
- [x] **#2** Каркас services/web: config (без BROWSER_DOMAINS/nesty; `SEARXNG_URL`/engines из env-слоя, не россыпью `process.env`), types, generic cache (каталог `/data/web-cache`, ленивое протухание по `expiresAt` — без мёртвого `setInterval`), fetch-cache, pino-logger. *(blockedBy: —)*
- [x] **#3** SearXNG-клиент: `performWebSearch/Batch`, retry/backoff, инъекция `fetchFn`, таймаут из settings, без rateLimit. *(blockedBy #2)*
- [x] **#4** fetch-слой без браузера + SSRF-guard: `fetchRawHtml`(+заголовки)/`fetchPageAsMarkdown`/`cleanHtml`(jsdom); убрать ветку браузера (fetch.ts:249-253); SSRF по **разрезолвленному IP** (резолв hostname → проверка IP: loopback/private/link-local/metadata, анти DNS-rebinding; только http/https). *(blockedBy #2)*

### Фаза 3 — Парсеры и вертикали
- [x] **#5** Перенос парсеров (новости+статьи+страницы) в `parsers/`; добавить deps `jsdom`,`turndown`; nesty не переносим. *(blockedBy #4)*
- [x] **#6** Вертикали kufar + avby: снять `fetchHtmlWithBrowser`→`fetchRawHtml`, верифицировать SSR `__NEXT_DATA__`, lookup-хелперы (категории/регионы/бренды/модели). *(blockedBy #4, #5)*
- [x] **#7** Вертикали rabota + transport + relax + weather (всё на голом fetch; relax-категории как константа; weather нативный). *(blockedBy #4, #5)*
- [x] **#8** 103by: консолидация 29 инструментов → `med103_doctor_search` + `med103_clinic_search` + `med103_services` + `med103_pharmacy`. *(blockedBy #4, #5)*

### Фаза 4 — Нативные инструменты
- [x] **#9** web-bucket `tools/web.ts` (15 инструментов + 6 lookup) по образцу `currency.ts`: `buildWebTools(ctx, fetchFn = globalThis.fetch)` — `fetchFn` параметром билдера (не через `ctx`); регистрация bucket в `registry.ts`. *(blockedBy #3, #5, #6, #7, #8)*

### Фаза 5 — Снос MCP
- [x] **#10** Удаление MCP-плумбинга: файлы `mcp.ts`/`admin/api/mcp.ts`/фронт-MCP; правки app/chat/skill-agent/registry/settings-keys/settings/seed/admin; убрать `@mastra/mcp`; `mcp_servers` из seed-конфига. *(blockedBy #9)*

### Фаза 6 — Навыки
- [x] **#11** Правка `seed/skills/*`: `web_fetch`→`fetch_url` (11), `read_resource`→lookup (4), `realty`→kufar+web_search, `health`→consolidated med103. *(blockedBy #9)*

### Фаза 7 — Тесты
- [x] **#12** Тесты (vitest, инъекция `fetchFn`): парсеры на фикстурах, SearXNG-клиент, SSRF-guard, execute ключевых инструментов. *(blockedBy #9)*

### Фаза 8 — Безопасность, проверка, доки
- [x] **#13** Безопасность + финал: SSRF на `fetch_url`, untrusted веб-контент (promptguard/sanitize), нет секретов в логах; `typecheck`+`test`+ручной smoke (compose searxng+redis+app). *(blockedBy #1, #10, #11, #12)*
- [x] **#14** Документация (обязательный чекпоинт): README/docs + пометить отмену ROADMAP §9 / parity «MCP search only» / §10.3 (follow-up через `/aif-roadmap`, `/aif-rules`); `/aif-docs`. *(blockedBy #13)*

## Commit Plan
- **Commit 1** (после #1): `chore(deploy): searxng + redis services in compose (M11)`
- **Commit 2** (после #2–#4): `feat(web): services/web foundation — searxng client + fetch layer (no browser) + SSRF`
- **Commit 3** (после #5–#8): `feat(web): port parsers + verticals (kufar/avby/rabota/transport/relax/weather/103by), drop nesty`
- **Commit 4** (после #9–#10): `feat(web): native web tool bucket; remove MCP plumbing`
- **Commit 5** (после #11): `feat(skills): repoint skills to native web tools (fetch_url, realty→kufar, health→med103)`
- **Commit 6** (после #12): `test(web): unit tests with injected fetchFn (parsers, searxng, SSRF)`
- **Commit 7** (после #13–#14): `chore(web): security pass, verification, docs (M11)`

## Риски / заметки
- **Анти-бот на cars.av.by / kufar.by:** данные в SSR (`__NEXT_DATA__`), но сайт может вернуть 403 на голый fetch. Митигация — реалистичные заголовки; деградирует только конкретный сайт.
- **SSRF:** `fetch_url` теперь в одном процессе с libSQL/admin → guard приватных сетей обязателен (по разрезолвленному IP, анти DNS-rebinding).
- **DB с нуля:** миграций не пишем; снятие `mcp_servers` = просто не сидим строку (схема не меняется).
- **Lookup vs read_resource:** MCP-ресурсы заменяются небольшими lookup-тулзами; альтернатива — вшить статические списки в описания инструментов (для relax-категорий).
