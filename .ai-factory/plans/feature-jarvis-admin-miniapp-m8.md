# План реализации: jarvis — Админка (Telegram Mini App, Milestone 8)

Branch: `feature/jarvis-admin-miniapp-m8`
Created: 2026-06-14
Источник: пункт **Milestone 8** `.ai-factory/ROADMAP.md` («Админка (Mini App) — Hono-API (CRUD skills/models/settings/prompts/plans/users/usage/mcp) + React Mini App + auth по `initData`»); детализация — ROADMAP §8 «Функционал админки».

> Цель: дать **редактирование конфигурации из Telegram** без правки БД руками. Бэкенд получает
> **Hono admin-API** (`/admin/api/*`), который читает/пишет уже существующие таблицы
> (`settings`/`models`/`skills`/`prompts`/`subscription_plans`/`user_subscriptions`/`users`/`usage_stats`),
> инвалидируя кэши `SettingsService`/`SkillService` для hot-reload. Доступ закрыт **валидацией
> Telegram `initData`** (HMAC-SHA256 по bot-token) + белым списком `ADMIN_USER_IDS` из `.env`.
> Фронт — **React + Vite Mini App** (`frontend/`) с экранами под каждый раздел, отдающий `initData`
> в заголовке. Всё в **едином процессе** (бот + cron + admin-API; зафиксированное решение ROADMAP §2):
> admin-API монтируется в тот же HTTP-сервер, что и health/webhook.
> Референс по UX-разделам — ROADMAP §8; жёсткого Go-аналога у миниаппа нет (в Go управление было
> через `cmd/cli`, который мы НЕ переносим — ROADMAP §9).

## Структура (monorepo)
Бэкенд-пути вида `src/...` читаются как **`jarvis/backend/src/...`**. Новый бэкенд-код — в `src/admin/`
(зарезервировано в `ARCHITECTURE.md`: «admin/ [M8] api (Hono), auth (Telegram initData)»).
Фронт — отдельный npm-пакет **`frontend/`** (сейчас в нём только `.gitkeep`; **не** npm-workspace —
паритет с текущей структурой, где `backend/` самодостаточен). Прод-контейнеризация в один контейнер —
**M9** (ROADMAP §7, фаза 9), здесь — только dev-режим (Vite :5173 ↔ backend :8080) + опц. отдача
собранной статики из Hono.

## Roadmap Linkage
- **Milestone:** `8. Админка (Mini App)`
- **Rationale:** план целиком реализует M8 ROADMAP — Hono admin-API с CRUD по
  skills/models/settings/prompts/plans/users/usage/mcp, React Mini App и auth по `initData`
  (HMAC + `ADMIN_USER_IDS`). Все целевые таблицы уже созданы в M1, read-пути есть в M1–M7 —
  M8 добавляет write-пути + инвалидацию кэшей + HTTP-поверхность + фронт. Завершение Task 9
  закрывает milestone 8.

## Settings
- Testing: **yes** (unit на чистую `verifyInitData`/`isAdmin`; integration на libSQL temp-DB harness
  через `app.request()` Hono — без реального сокета и сети; фронт — typecheck/сборка, компонентные опц.)
- Logging: **verbose** (pino, детальные DEBUG: попытки auth и их исход, мутации конфига; уровень из
  `LOG_LEVEL`; **`initData`, `hash`, bot-token, секреты, значения env, тела промптов/результатов, PII —
  НЕ логируем**, `redact`)
- Docs: **yes** (обязательный чекпоинт `/aif-docs` при завершении: `docs/admin.md`, README, ссылки из
  `docs/configuration.md`)

## Объём
Покрывается **Milestone 8**:
- **Auth** (`admin/auth.ts`) — чистая `verifyInitData` (HMAC-SHA256, `timingSafeEqual`, проверка
  `auth_date`), `isAdmin`, Hono-middleware `requireAdmin` (заголовок `Authorization: tma <initData>`).
- **HTTP-сервер** (`admin/server.ts` + рефактор `server.ts`) — переход с raw `node:http` на Hono +
  `@hono/node-server`; `/health` и webhook сворачиваются в Hono; `/admin/api/*` под `requireAdmin`;
  опц. `serveStatic(frontend/dist)`. Закрывает `TODO[M8]` в `server.ts:74`.
- **Admin-API CRUD** (`admin/api/*`) — settings/models/mcp (роли моделей), skills/prompts (+ тест-прогон
  скила), users/plans/usage. После записи — `settings.invalidate()` / `skills.invalidate()`.
- **Frontend** (`frontend/`) — Vite+React+Mantine Mini App: каркас + API-клиент (`initData` в заголовке)
  + экраны под все разделы ROADMAP §8.
- **Сборка** (`.env.example`, npm-scripts, docker-compose dev) — bootstrap-конфиг и запуск в деве.

**НЕ входит (следующие заходы / задокументированные расхождения):**
- **Прод-контейнеризация (1 контейнер) и Dockerfile фронта — M9** (ROADMAP §7, фаза 9). Здесь — только
  dev-сервис в `docker-compose` + опц. отдача статики из Hono.
- **Миграция данных Postgres → libSQL — M9** (скрипт переноса).
- **Новых таблиц/миграций M8 не требует** — все целевые таблицы (`settings`/`models`/`skills`/`prompts`/
  `subscription_plans`/`user_subscriptions`/`users`/`usage_stats`) созданы в M1. Подтвердить отсутствие
  `db:generate` дельты.
- **`cmd/cli` (set-plan) из Go — НЕ переносим** (ROADMAP §9); управление планами — из миниаппа.
- **Реал-тайм/websocket** не вводим — фронт перечитывает после мутаций (poll on demand), как и
  hot-reload `SettingsService` (polling по `updated_at`, без pub-sub).
- **Слияние двух allowlist'ов не делаем:** `ADMIN_USER_IDS` (`.env`) — гейт **миниаппа** (кто админ);
  `telegram_allowed_users` (`settings`, БД) — кто допущен **до чата с ботом**. Это разные механизмы;
  M8 управляет вторым из админки, но вход в саму админку — только по первому.

---

## Ключевые решения и константы (верифицировано по коду M0–M7)

| Параметр | Значение | Источник / обоснование |
|---|---|---|
| HTTP-сервер | **Hono + `@hono/node-server`** `serve({ fetch, port })` вместо raw `node:http` | `server.ts:136` сейчас `createServer`; `TODO[M8]` на `server.ts:74`; `hono@^4.12.25` уже в deps, `@hono/node-server` — **добавляем** |
| Mastra-сервер | **НЕ используем** — `new Mastra({...})` это лишь storage/vector-контейнер | `mastra/index.ts:26`; своего Hono-хука не подключено → ставим standalone Hono |
| Точка монтирования | `/admin/api/*` под middleware `requireAdmin`; `/health`, webhook — корневые | паритет с текущими маршрутами `server.ts:144/137` |
| Доступ к deps | `chatService.deps.{db, settings, skills, ...}` (модульный `export let chatService` в `server.ts:20`) | `app.ts:30`, `chat.ts:42` |
| Auth-заголовок | **`Authorization: tma <initDataRaw>`** (де-факто стандарт Telegram Mini Apps) | конвенция `@telegram-apps`/grammY |
| Валидация initData | `secret = HMAC_SHA256("WebAppData", botToken)`; `hash == HMAC_SHA256(secret, dataCheckString)`; сравнение `crypto.timingSafeEqual` | Telegram WebApp spec; `node:crypto` (в репо ещё нет `createHmac` — новый код) |
| Свежесть | `now - auth_date <= INIT_DATA_MAX_AGE_SEC` (**86400с / 24ч**) | защита от replay; константа |
| Bootstrap-админы | **`env.adminUserIds`** (`.env ADMIN_USER_IDS`, уже распарсен) | `env.ts:32/68` — поле есть, но **нигде не потребляется** → M8 — первый потребитель |
| Пустой `adminUserIds` / нет токена | **deny-all** (401) + WARN на старте | безопасный дефолт: в админку нельзя без явного списка (в отличие от bot-allowlist, где пусто = всем можно, `bot.ts:67`) |
| Инвалидация кэша | после записи `settings`/`models` → `deps.settings.invalidate()`; после `skills`/`prompts` → `deps.skills.invalidate()` | `settings.ts:78`, `skill-service.ts:55`; pub-sub нет, single-process |
| Роли моделей | живут в `settings.model_roles` (default/router/embedding/error_correction/speech/synthesizer); назначение = PUT этого ключа | `settings-keys.ts`; `models`-таблица — это список ref'ов для UI/валидации |
| MCP-серверы | `settings.mcp_servers` (только сервер `search`); MCP `memory` не вводим | ROADMAP §5/§9 |
| Валидация admin-ввода | zod-типы + разумные length-каппы; **`promptguard.containsInjection` НЕ применяем** к admin-полям | админ доверенный, легитимно пишет системные промпты с «инструкциями»; `promptguard` — для **untrusted** user-сообщений (`promptguard.ts:65`) |
| Тест-прогон скила | `buildSkillAgent(row)` + один `generateText` (без стрима) + watchdog `llm_request` | ROADMAP §8 «тест-прогон скила»; реюз фабрики |
| UI-кит | **Mantine** (рекомендация; альтернатива — shadcn/ui) | ROADMAP §1 «shadcn/ui **или** Mantine»; Mantine быстрее на формах/таблицах admin-CRUD — **переключаемо**, открытое решение |
| Telegram SDK фронта | `@twa-dev/sdk` (`WebApp.initData`, `themeParams`, `ready/expand`) | ROADMAP §1 |
| Структура фронта | отдельный npm-пакет `frontend/` (не workspace) | паритет: корневого `package.json`/workspace нет |
| Новых миграций | **нет** — все таблицы из M1 | `db/schema.ts` (14 таблиц); подтвердить `db:generate` без дельты |

**Расхождения с Go / опоры на готовое (верифицировано):**
- **Управление в Go было через `cmd/cli` (set-plan)** — НЕ переносим (ROADMAP §9). Весь CRUD — из миниаппа.
- **`env.adminUserIds` распарсен, но не потреблён** (`env.ts:68`) — M8 первым его использует как гейт админки.
- **`TELEGRAM_BOT_TOKEN`** опционален в dev/test, обязателен в prod (`env.ts:18/47`). Без токена нечем
  валидировать `initData` → admin-API в deny-режиме + WARN (паритет best-effort со scheduler M7).
- **`SettingsService` без pub-sub**: hot-reload через `refreshIfStale()` (polling `max(updated_at)`) +
  явный `invalidate()` (`settings.ts:78/84`). Запись из админки **обязана** бампать `updated_at` и звать
  `invalidate()` — иначе `models`-кэш не самолечится (отдельной stale-проверки моделей нет).
- **`SkillService` — read+seed-only сейчас** (`skill-service.ts`, `seed.ts` с `onConflictDoNothing`):
  M8 добавляет write-пути для `skills`/`prompts` + `invalidate()`.
- **`subscription_plans`/`user_subscriptions` — seed-only / без write** (`seed.ts:107`, у `user_subscriptions`
  write-кода нет): M8 — первый write (CRUD планов + назначение плана пользователю; PK `user_subscriptions.user_id`).
- **CRUD-паттерн берём из `mastra/tools/tasks.ts`** (zod `inputSchema`, partial-patch, `updatedAt` на записи,
  `{ error }`/`{ message }`), но **без userId-scoping** (admin видит всё).
- **Webhook уже спроектирован под монтирование** (`server.ts:26` — `webhookHandler` как `(req,res)`), но
  на Hono переходим к `app.fetch`; grammY даёт `webhookCallback(bot, "hono")` — используем hono-адаптер.
- **Frontend пуст** (`frontend/.gitkeep`), `@twa-dev/sdk`/React/Vite/Mantine **нигде нет** — ставим с нуля.
- **docker-compose**: frontend-сервис закомментирован («enabled in milestone 8») — раскомментируем dev-вариант.

---

## Commit Plan
- **Commit 1** (задачи 1–2): `feat(admin): валидация Telegram initData + Hono admin-сервер (health/webhook/admin-api)`
- **Commit 2** (задачи 3–5): `feat(admin): CRUD-эндпоинты settings/models/mcp, skills/prompts, users/plans/usage`
- **Commit 3** (задачи 6–8): `feat(frontend): каркас Mini App (Vite+React+Mantine) + экраны конфига/скилов/пользователей`
- **Commit 4** (задача 9): `chore(admin): статика/env/npm-scripts/docker dev` (завершает M8)

---

## Tasks (9)

### Фаза 8a — Auth-фундамент (чистая логика + middleware)
- [x] **Task 1**: `admin/auth.ts` — чистая `verifyInitData(initDataRaw, botToken, { maxAgeSec=86400, now? }) → { ok, user?, reason? }`: парс query-string, извлечь `hash`, собрать data-check-string (отсортированные `k=v` через `\n`), `secret = HMAC_SHA256("WebAppData", botToken)`, `computed = HMAC_SHA256(secret, dcs)` (`node:crypto.createHmac`), сравнить `timingSafeEqual`; проверить `auth_date` (свежесть); распарсить `user` JSON → `{ id, ... }`. `isAdmin(userId, adminUserIds)`. Hono-middleware `requireAdmin(deps)`: читает `Authorization: tma <initData>`, валидирует, сверяет `user.id` с `env.adminUserIds`, на успехе `c.set('adminUserId', id)`, иначе `401`. Нет токена / пустой `adminUserIds` → deny-all + WARN. **Логи:** DEBUG (auth-попытка/исход reason), WARN (нет токена/пустой список/отказ); **никогда** `initData`/`hash`/токен (redact). **Тесты:** unit — `verifyInitData` (валидный с фикс. токеном и собранным dcs; tampered hash; протухший `auth_date`; нет `user`; нет токена), `isAdmin` (in/out). Без сети.

### Фаза 8b — HTTP-сервер на Hono
- [x] **Task 2**: добавить `@hono/node-server`; `admin/server.ts` — `new Hono()`, маршруты `GET /health`, webhook (`webhookCallback(bot, "hono")`), под-роутер `/admin/api/*` с `requireAdmin`; опц. `serveStatic(frontend/dist)` + SPA-fallback. Рефактор `server.ts`: заменить `createServer` на `serve({ fetch: app.fetch, port: PORT })`; пробросить `chatService.deps` в app (фабрика `buildAdminApp(deps)`); закрыть `TODO[M8]` (`server.ts:74`). **Логи:** INFO (admin API up, mount-path, порт), WARN (нет токена → deny-режим). **Тесты:** integration через `app.request()` — `/health` 200; `/admin/api/*` без initData → 401; битый initData → 401. *(depends on 1)*
<!-- Commit checkpoint: tasks 1-2 -->

### Фаза 8c — Admin-API CRUD (бэкенд; задачи 3–5 параллелизуемы после Task 2)
- [x] **Task 3**: `admin/api/{settings,models,mcp}.ts` — settings `timeouts`/`agent` (GET/PUT, zod: Go-duration строки, `max_history`/`default_temperature`/`rag_top_k`); `model_roles` (GET/PUT, валидировать ref ∈ enabled `models`); `models` (GET/POST/PATCH/DELETE, `ref` уникален); `mcp_servers` (GET/PUT, только `search`). После записи settings/models → `deps.settings.invalidate()`. **Логи:** INFO (что/кем изменено: key/ref + adminUserId), DEBUG (без секретов/env-значений), WARN (валидация). **Тесты:** integration (libSQL harness + `app.request()`) — PUT setting → `SettingsService` getter отдаёт новое + `invalidate` вызван; невалидный ref роли → 4xx; CRUD `models`. *(depends on 2)*
- [x] **Task 4**: `admin/api/{skills,prompts}.ts` — skills GET/GET:name/POST/PUT/DELETE (`allowed_tools[]`, `model`, `temperature?`, `reasoning?`, `routable`, `prompt`, `metadata`; `updatedAt` на записи); prompts GET/GET:key/PUT (SOUL/FORMAT/INTEGRITY/SYNTHESIZER/WELCOME/MONITORING); после записи → `deps.skills.invalidate()`. Тест-прогон `POST /admin/api/skills/:name/test { message }` → `buildSkillAgent(row)` + один `generateText` + watchdog `llm_request`, вернуть `{ text, usage }`. **Admin-ввод доверенный:** zod + length-каппы, **без** `containsInjection`. **Логи:** INFO (skill/prompt изменён + adminUserId), DEBUG (без тел промптов/результата), WARN. **Тесты:** integration — PUT skill → `getSkillByName` видит новое после invalidate; PUT prompt → `getPrompt` видит; тест-прогон с фейк-LLM. *(depends on 2)*
- [x] **Task 5**: `admin/api/{users,plans,usage}.ts` — users GET-список (+ каналы/план)/GET:id/PATCH (`display_name`/`city`/`timezone`/`language`/`onboarded`); chat-allowlist (`telegram_allowed_users` add/remove → `settings.invalidate()`); `subscription_plans` GET/POST/PATCH/DELETE (`hourly_limit`, `max_tasks`); `user_subscriptions` PUT (upsert по `user_id`); usage GET (`getDailyUsage`/`getUsageSince` + новый агрегат SUM по всем); опц. сброс `message_rate_limits`. **Логи:** INFO (мутации + adminUserId), DEBUG (PII не в телах без нужды), WARN. **Тесты:** integration — список пользователей; назначить план → `RateLimitService.resolveLimit` отдаёт новый лимит; CRUD plans; агрегат usage. *(depends on 2)*
<!-- Commit checkpoint: tasks 3-5 -->

### Фаза 8d — Frontend Mini App (React + Vite)
- [x] **Task 6**: каркас `frontend/` — Vite+React+TS+`@twa-dev/sdk`+Mantine; `vite.config.ts` dev-прокси `/admin/api`,`/health` → `:8080`; `src/lib/api.ts` (fetch-клиент кладёт `Authorization: tma <WebApp.initData>`); bootstrap `WebApp.ready()/expand()`, тема из `themeParams` → `MantineProvider`, экран «нет доступа» при 401; layout/навигация (Tabs/AppShell) под разделы Skills/Models/Settings/Prompts/Plans/Users/Usage/MCP. **Логи:** dev-console, без `initData`. **Тесты:** typecheck/сборка (компонентные опц.). *(depends on 2)*
- [x] **Task 7**: экраны конфига `frontend/src/screens/` — Settings (`timeouts`/`agent`), Models (таблица + вкл/выкл + добавление `provider:model` + назначение ролей через селекты), Prompts (textarea + предпросмотр), MCP (список/вкл-выкл/URL `search`). Чтение/запись через `api.ts`; после-save рефетч; индикация ошибок 4xx. **Тесты:** typecheck/сборка. *(depends on 3, 6)*
- [x] **Task 8**: экраны `frontend/src/screens/` — Skills (CRUD: tools-мультиселект, model-селект, temperature/reasoning/routable, prompt+предпросмотр; «тест-прогон» → `skills/:name/test`), Users (план-селект + chat-allowlist toggle), Plans (CRUD), Usage (per-user + агрегат за период). Через `api.ts`. **Тесты:** typecheck/сборка. *(depends on 4, 5, 6)*
<!-- Commit checkpoint: tasks 6-8 -->

### Фаза 8e — Сборка в едином процессе
- [x] **Task 9**: `serveStatic(frontend/dist)` подтвердить из Task 2; `.env.example` — `ADMIN_USER_IDS=123,456` с комментарием (bootstrap-админы миниаппа); npm-scripts фронта (dev/build) + документированный запуск обоих в деве (Vite :5173 + backend :8080); `docker-compose.yaml` — раскомментировать **dev**-сервис frontend (порт 5173, `depends_on: backend`), пометив, что прод-контейнер (1 шт.) — M9. Прогон `npm run typecheck` + `npm test` (backend) зелёные; ручная end-to-end проверка (вход по initData → правка данных). **Логи:** INFO о готовности. **Тесты:** финальный `npm test` зелёный. *(depends on 7, 8)* — **завершает Milestone 8.**
<!-- Commit checkpoint: task 9 -->

---

## Граф зависимостей (порядок выполнения)
```
Task 1 (admin/auth.ts — initData + guard)
   └─> Task 2 (Hono server: /health + webhook + /admin/api)
          ├─> Task 3 (API: settings/models/mcp) ──┐
          ├─> Task 4 (API: skills/prompts) ───────┤
          ├─> Task 5 (API: users/plans/usage) ────┤
          └─> Task 6 (frontend: каркас + API + auth)
                          ├─ Task 7 (экраны конфига)  ← Task 3
                          └─ Task 8 (экраны skills/users) ← Task 4, 5
                                    └─> Task 9 (сборка M8) — закрывает M8
```
Задачи 3/4/5 независимы между собой (общий блокер — Task 2) и могут идти параллельно;
Task 6 — тоже после Task 2. Task 7 ждёт 3+6, Task 8 ждёт 4+5+6, Task 9 — 7+8.

## Проверка перед коммитом (в `backend/`)
- [ ] `npm run typecheck` чисто (backend); `cd frontend && npm run build` собирается
- [ ] `npm test` зелёный (unit `verifyInitData`/`isAdmin` + integration admin-API по libSQL, без сети)
- [ ] Watchdog/таймаут на тест-прогоне скила и любых LLM/HTTP-вызовах
- [ ] Auth: нет токена / пустой `ADMIN_USER_IDS` → admin-API в deny (401), процесс жив, WARN
- [ ] После записи конфига вызван соответствующий `invalidate()` (settings/models или skills/prompts)
- [ ] Новых миграций нет (схема M1 покрывает все таблицы) — подтвердить `db:generate` без дельты
- [ ] Нет секретов / `initData` / bot-token / тел промптов / PII в логах (`redact`)
