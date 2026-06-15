# Research

Updated: 2026-06-15 01:11
Status: active

## Active Summary (input for /aif-plan)
<!-- aif:active-summary:start -->
**Topic:** Перенос web-search из репозитория `/Users/serg/GolandProjects/mcp-servers` в монорепо `jarvis`. Код web-search **встраивается нативно в `backend/`** (не как отдельный MCP-контейнер). searxng + redis остаются контейнерами.

**Goal:** Поисковые/скрейпинговые возможности (web_search, fetch_url, news, маркетплейсы РБ и т.п.) доступны ассистенту как **нативные AI-SDK инструменты** через `registry.ts`, без MCP-транспорта и без headless-браузера.

**Constraints (зафиксировано пользователем):**
- ❌ Без Chromium/Playwright. Только нативный `fetch()` (Node 22) + `jsdom`/`turndown` для HTML→markdown. Mastra НЕ даёт fetch/HTML-хелперов (проверено: установлены только `@mastra/{core,libsql,mcp,memory,schema-compat}`).
- 🗑️ MCP-плумбинг удаляем целиком (`mastra/mcp.ts`, `loadMcpTools`, `@mastra/mcp`, настройка `mcp_servers`, admin-страница MCP, `.mcp.json` search-entry). search был единственным живым MCP-сервером.
- 🆕 База с нуля — миграций НЕ пишем. (`mcp_servers` — строка в key/value таблице `settings`, не колонка → изменения схемы нет в принципе.)
- 🔧 Принцип: **не переносить тупо — адаптировать под конвенции jarvis и улучшать.**

**Decisions:**
- Имя инструмента: `web_fetch` → **`fetch_url`** (канон). Обновить навыки, где `web_fetch`.
- `nesty_*` (аренда) **НЕ переносим** — сайт больше не работает. Удалить nesty-ресурсы тоже.
- cars.av.by и kufar.by — это **SSR**, парсятся обычным fetch (браузер был только ради обхода анти-бота). Переносим на голый fetch; риск 403/анти-бот лечится реалистичными заголовками; деградирует только конкретный сайт.
- 103by: 29 авто-сгенерированных тулзов → свернуть в `doctor_search(specialty,…)` + `clinic_search(type,…)` + `103by_services` + `103by_pharmacy` (улучшение).
- MCP-resources (`kufar://…`, `avby://…`, `relax://…`) → маленькие lookup-тулзы или внутреннее резолвинг внутри search-тулзы (дефолт: lookup-тулзы).
- searxng `secret_key` → из `.env`; кэш web-search → `./data/web-search` (или libSQL на свежей базе).

**Open questions:**
- **weather:** пользователь думал «у нас и так есть» — проверено, нативного weather в backend НЕТ (только web-search `weather`/gismeteo). По умолчанию переносим (крошечная, SSR). Подтвердить.
- **realty:** завязан на nesty (выпал) → перенацелить на `kufar_search` + `web_search` или убрать навык. Решить в плане.
- Кэш в файлах (`./data/web-search`) против libSQL-таблицы. Дефолт — файлы; libSQL опционально.
- Глобальный rate-limiter web-search (per-second/per-month) — вероятно избыточен (у jarvis уже есть per-user планы/лимиты). Кандидат на удаление.

**Success signals:**
- Навыки (research, shopping, cars, jobs, transport, leisure, news, health, weather) вызывают нативные инструменты; в логах нет «tool not available; skipped».
- `npm run typecheck` + `npm test` зелёные; HTTP-вызовы под watchdog/таймаут; `fetchFn` инъектируемый (тесты без сети).
- В docker-compose: app + searxng + redis (+ local). Образ app без Chromium.
- SSRF-фильтр на `fetch_url` (приватные/loopback сети заблокированы).

**Next step:** `/aif-plan full` — разложить на этапы: (1) вендоринг+адаптация services/web + tools/web, (2) удаление MCP-плумбинга, (3) compose searxng+redis, (4) правка навыков и seed, (5) тесты+SSRF.
<!-- aif:active-summary:end -->

## Sessions
<!-- aif:sessions:start -->
### 2026-06-15 01:11 — Изучение переноса web-search в backend
**What changed:**
- Изучены оба репозитория. Решение пользователя сменилось с «вендорить web-search как отдельный MCP-контейнер» на «встроить код web-search нативно в backend».
- Зафиксированы решения: без браузера; удалить MCP-слой; база с нуля; `web_fetch`→`fetch_url`; не переносить nesty; адаптировать и улучшать.

**Key notes:**
- Как jarvis сейчас цепляет MCP: конфиг в БД (`settings.mcp_servers`, формат stdio `{command,args,env}`); `@mastra/mcp` спавнит `npx -y mcp-remote <url>` как мост stdio↔HTTP к `host.docker.internal:3000/mcp`. После переноса всё это уходит.
- Инструменты в агент попадают per-skill через `allowed-tools`, резолвятся в `registry.ts` по «бакетам» (memory/currency/tasks/profile/skill-ref + текущий `ctx.mcpTools`). Добавляем новый бакет `web` (имена bare, как у текущих MCP-тулзов).
- Несовпадение имён (`web_fetch` vs `fetch_url`, `read_resource` как ресурс-не-тулза) при нативной реализации **исчезает** — имена контролируем сами.
- web-search реально содержит ~15 тулзов + 10 ресурсов (намного больше, чем его CLAUDE.md). Браузер нужен был только для cars.av.by и www.kufar.by (`BROWSER_DOMAINS`), и то ради анти-бота, а не рендеринга (kufar отдаёт `__NEXT_DATA__` SSR-JSON).
- Парсеры в основном чистые (HTML→data) → идеальны для unit-тестов jarvis.
- Улучшения-кандидаты: 103by 29→~4 тулзы; SSRF-guard; инъекция fetchFn; кэш в libSQL; убрать дублирующий rate-limiter; pino вместо console.error; resources→lookup-тулзы.

**Финальный набор инструментов (после решений):**
- Порт: web_search, web_search_batch, fetch_url, search_news, kufar_search, avby_search, rabota_search, transport_search, relax_search, relax_afisha, weather(подтвердить), 103by → doctor_search/clinic_search/services/pharmacy.
- Удалить: nesty_search (+ nesty-ресурсы).
- Ресурсы kufar/avby/relax → lookup-тулзы или внутреннее резолвинг.

**Skill-правки:**
- Везде `web_fetch` → `fetch_url`; `read_resource` → новые lookup-тулзы.
- realty: перенацелить (nesty мёртв) или убрать. health: на consolidated doctor_search/clinic_search. weather: оставить тулзу.

**Links (paths):**
- Источник: `/Users/serg/GolandProjects/mcp-servers/{web-search,searxng,docker-compose.yml}`
- Цель: `backend/src/{services,mastra/tools}/`, `backend/src/db/seed.ts`, `backend/seed/config.yaml`, `backend/seed/skills/*`, `docker-compose.yaml`, `docker-compose.local.yml`
- Ключевые файлы jarvis: `backend/src/mastra/mcp.ts` (удалить), `backend/src/mastra/tools/registry.ts` (новый бакет), `backend/src/config/settings-keys.ts`, `backend/src/db/seed.ts` (`searchOnly`)
<!-- aif:sessions:end -->
