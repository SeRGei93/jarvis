# План реализации: jarvis — Инструменты и MCP (Milestone 5)

Branch: `feature/jarvis-tools-mcp-m5`
Created: 2026-06-14 · Refined: 2026-06-14 (`/aif-improve`, верификация по коду M0–M4)
Источник: пункт **Milestone 5** `.ai-factory/ROADMAP.md` («Инструменты и MCP»)

> Цель: дать агентам реальные инструменты поверх готовой диалоговой петли (M0–M4):
> `currency`, `tasks` (CRUD cron-задач), `profile-tools`, `skill-ref`, плюс `MCPClient`
> к внешнему серверу **`search`** — и закрыть поддерживающие сервисы M5 (`rate-limit`, `usage`).
> До M5 `tool-resolver` подключал только memory-tools (готовы в M3), остальные имена в
> `allowed-tools` давали WARN и пропускались. Референс для порта — Go-проект
> **`/Users/serg/GolandProjects/avocado-ai`** (остаётся нетронутым до переключения, M10).

## Структура (monorepo)
Все пути вида `src/...` ниже читаются как **`jarvis/backend/src/...`**. Frontend (Mini App) — M8, в этом заходе не трогаем.

## Roadmap Linkage
- **Milestone:** `5. Инструменты и MCP`
- **Rationale:** план целиком реализует M5 ROADMAP — реестр реальных инструментов (currency, tasks/cron CRUD, profile-tools, skill-ref), `MCPClient` (только сервер `search`) и — по `ARCHITECTURE.md` («[M5] rate-limit, usage») — сервисы `services/rate-limit.ts` и `services/usage.ts` (M4 заранее учёл онбординг-байпас лимита). Завершение плана закрывает milestone 5.

## Settings
- Testing: **yes** (unit на инструменты/валидацию; интеграционные на libSQL: tasks/profile/usage/rate-limit; фейк-fetch для currency; фейк-MCP сквозняком)
- Logging: **verbose** (pino, детальные DEBUG; уровень из `LOG_LEVEL`; секреты — `redact`; PII/тела промптов/env MCP не логируем)
- Docs: **yes** (обязательный чекпоинт `/aif-docs` при завершении)

## Объём
Покрывается **Milestone 5**:
- **MCPClient (`search`)** — обёртка над `@mastra/mcp`, конфиг из `settings.getMcpServers()` (только ключ `search`), алиасинг namespaced→bare-имён (`web_search`/`web_fetch`/`avby_search`/`read_resource`/`weather`), graceful-degradation.
- **Реестр инструментов** — расширение `resolveTools`/`ToolContext`: слияние бакетов memory → builtin → MCP, сохранение seam-поведения (неизвестное имя → WARN+skip).
- **Встроенные инструменты** — `currency_rates`; `task_*` (create/list/get/update/delete/toggle) поверх `cron_tasks` с валидацией schedule и лимитом `max_tasks`; `update_city`/`update_bot_vibe`/`update_bot_name`; `read_skill_reference` + заполнение слота `[SKILL REFERENCES]`.
- **Сервисы (по ARCHITECTURE.md)** — `services/usage.ts` (учёт `usage_stats`), `services/rate-limit.ts` (почасовое окно `message_rate_limits` + `hourly_limit` плана, онбординг-байпас).
- **Интеграция** — проброс расширенного `ToolContext`, инициализация MCP на старте, rate-limit gate на входе workflow, проводка usage после ответа.

**НЕ входит (следующие заходы):**
- **M6** — Telegram-бот; M5 не трогает доставку, но `tasks`-инструмент пишет `notificationChatId`/`sessionId` под будущие нотификации.
- **M7** — Cron-планировщик (node-cron исполнитель): M5 даёт только CRUD + валидацию расписаний; фактический запуск задач — M7.
- **M8** — миниапп и перенос `references` скилов в БД: в M5 `skill-ref` читает references с ФС каталога скилов (паритет с Go, read-only).
- Инструмент `exec` — **не переносим** (в Go зарегистрирован, но заблокирован от LLM). MCP-сервер `memory` — **не переносим** (память консолидирована, M3).

---

## Ключевые решения и константы (паритет с Go, верифицировано по коду)

| Параметр | Значение | Источник (Go) |
|---|---|---|
| MCP: переносим только сервер | **`search`** (memory dropped) | `seed.ts:searchOnly`, ROADMAP §9 |
| MCP-инструменты `search` | web_search · web_fetch · avby_search · read_resource · weather | inventory ROADMAP §10 |
| currency: источники | nbrb (JSON) · belarusbank (JSON) · myfin (HTML scrape) | `currency.go` |
| currency: таймаут на источник | `timeouts.http_client` (Go: 15s), без кэша | `currency.go` |
| currency: масштаб RUB | **scale=100** (belarusbank, myfin) | `currency.go` |
| cron: спец-значения schedule | `now` (фон, нужна сессия) · `once` (`scheduled_at` в будущем) · 5-полевой cron | `manage_cron_tasks.go` |
| cron: мин. интервал | **1 час** (две подряд `Next()` ≥ 1h) | `manage_cron_tasks.go:236–240` |
| cron: лимит задач | `subscription_plans.max_tasks` (дефолт 3) | `subscription_plan.go` |
| profile: набор tools | update_city · update_bot_vibe · update_bot_name (read-профиля и update-языка НЕТ) | `city/vibe/bot_name.go` |
| profile: vibe / поля | vibe ≤ 200 · city/bot_name через `sanitizeProfileField` (≤100) · timezone через `validateTimezone` | `vibe.go`, promptguard |
| skill-ref: префиксы пути | `references/` · `scripts/` · `assets/`; запрет `..`/абсолютных | `skill_repository.go:492–502` |
| skill-ref: обрезка контента | **8000** символов | `skill_reference.go` |
| rate-limit: окно | скользящий **час** (`message_rate_limits`), лимит = `hourly_limit` плана | `rate_limit_service.go` |
| rate-limit: байпас | `onboarded=false` лимит не тратит | M4 (учтено заранее) |

**Расхождения с Go / опоры на готовое:**
- **MCP API (проверено по `node_modules/@mastra/mcp` v1.10):** класс `MCPClient`, конфиг `{ servers, timeout, id }`, **ленивое** подключение. Берём инструменты через `listToolsetsWithErrors()` → **bare-имена по серверу** (`toolsets.search.web_search`) + per-server `errors`; `listTools()` namespace-ит (`search_<tool>`) — не используем. ОБЯЗАТЕЛЬНО передать `id` (иначе второй инстанс с тем же конфигом бросает). `timeout` = `parseGoDuration(http_client)`. `disconnect()` на shutdown. *(Task 1)*
- **MCP-инструменты НЕ AI-SDK-совместимы напрямую (баг совместимости).** `listToolsets()` отдаёт Mastra-`Tool` (`inputSchema`, `execute({context})`), а проект гоняет `streamText`/`generateText` напрямую (LlmService, не Mastra Agent). Нельзя `...spread` в `tools` — нужен тонкий адаптер каждого MCP-tool в `tool({inputSchema, execute})` из `ai`. Итог `getMcpTools()` — нормальный AI SDK ToolSet с bare-ключами. *(Task 1)*
- **`resolveTools` остаётся синхронным** на горячем пути: `mcpTools` (уже адаптированный AI SDK ToolSet) собираются один раз при старте (composition root) и кладутся в `ToolContext`, а не резолвятся async на каждый вызов скила. *(Task 2, 9)*
- **Слот `[SKILL REFERENCES]` уже разведён в M4** — `prompt-builder.ts` менять НЕ надо: есть `referencesHint(references?: SkillReference[])`, подключён в `buildSystemPrompt`/`buildSubAgentPrompt`. Работа Task 6 = `listReferences→SkillReference[]` + проброс `references` в сборку промпта из `skill-agent.ts` (сейчас не передаётся). Корень скилов — экспортируемая `SEED_DIR` из `db/seed.ts` (`join(SEED_DIR,"skills")`), не хардкод. *(Task 6)*
- **Surface cost (предусловие usage).** `runSkillStreaming`/`runSkillSubAgent` (`skill-agent.ts`) и `synthesize` (`synthesizer.ts`) сейчас возвращают `string` — `LlmResult.cost` логируется, но отбрасывается. Чтобы записать usage, возврат этих трёх меняем на `{ text, cost }`. *(Task 9; потребитель — Task 7)*
- **ToolContext threading (точки подтверждены кодом):** `SkillRunContext` сейчас несёт `mem`+`userId`; новые поля берём из `deps.db`, `deps.settings`, `input.chatId`, `ctx.session.id`. Rate-limit gate — между `ensureThread` и `getAgent` (`ctx.user.onboarded`/`ctx.session.id` в scope); MCP-init — в `app.ts::createChatService`. *(Task 9)*
- **Инъекция контекста через closure** (паттерн M3/M4, `buildMemoryTools(mem,userId)`), а не Mastra runtime-context: каждый бакет — фабрика, принимающая `ToolContext`.
- **`promptguard` уже содержит** `sanitizeProfileField`, `validateTimezone`, `validateLanguage`, `MAX_PROFILE_FIELD_LEN`, `MAX_TASK_PROMPT_LEN` (M0–M3) — новые санитайзеры не нужны. *(Task 4, 5)*
- **Схема БД готова (M1):** `cron_tasks`, `usage_stats`, `subscription_plans`, `user_subscriptions`, `message_rate_limits` уже есть → **новых миграций M5 не требует**. Типы libSQL: bool→integer 0/1, timestamp→integer(mode:'timestamp').
- **Новая зависимость:** `cron-parser` (вычисление двух подряд `Next()` для проверки мин. интервала; собственно планирование — node-cron в M7). HTML myfin парсим **регуляркой без cheerio** (зависимость не добавляем).
- **`skill-ref` читает с ФС** каталога скилов (дефолт `backend/seed/skills`, корень инъектируемый): паритет с Go; перенос references в БД — M8. Сид-скилы сейчас references/ не содержат → слот `[SKILL REFERENCES]` остаётся пустым, но машинерия (`listReferences` + чтение) готова.
- **`usage` cost** берётся из результата `LlmService` (извлечение `usage.cost` готово в M2); проводка — после ответа в workflow. *(Task 7, 9)*

---

## Commit Plan
- **Commit 1** (задачи 1–2): `feat(tools): MCP client (search) + расширенный реестр инструментов и ToolContext`
- **Commit 2** (задачи 3–4): `feat(tools): currency_rates + CRUD cron-задач (task_*)`
- **Commit 3** (задачи 5–6): `feat(tools): profile-tools + read_skill_reference и слот [SKILL REFERENCES]`
- **Commit 4** (задачи 7–8): `feat(services): учёт usage + почасовой rate-limit`
- **Commit 5** (задача 9): `feat(tools): интеграция инструментов/MCP/лимитов в chat workflow` (завершает M5)

---

## Tasks (9)

### Фаза 5a — Реестр инструментов и MCP-клиент (фундамент)
- [x] **Task 1**: `mastra/mcp.ts` — обёртка `MCPClient` (`@mastra/mcp` v1.10) к серверу `search` из `settings.getMcpServers()`; `new MCPClient({servers, timeout=parseGoDuration(http_client), id})` (ленивый connect, `id` обязателен). Инструменты через **`listToolsetsWithErrors()`** (bare-имена + per-server errors). **Адаптер Mastra-`Tool`→AI SDK `tool({inputSchema,execute})`** (иначе не вызвать через LlmService). Экспорт `getMcpTools(): Promise<ToolSet>` + `disconnect()`. Graceful-degradation (errors/недоступен → пустой/частичный набор + WARN, чат не падает); клиент инъектируемый. Unit (адаптер схемы+execute, degradation, bare-ключи). INFO connect/число инструментов; WARN недоступность; env MCP не логируем.
- [x] **Task 2**: `mastra/tools/registry.ts` — расширить `ToolContext` до `{mem,userId,chatId,sessionId,db,settings,mcpTools}` (db=`deps.db`, settings=`deps.settings`, chatId=`input.chatId`, sessionId=`ctx.session.id`, mcpTools=адаптированный ToolSet из Task 1); `resolveTools` **остаётся sync**, сливает бакеты memory→builtin→MCP по первому совпадению, неизвестное → WARN+skip; зарегистрировать множества имён бакетов. Unit (микс бакетов, skipped, пустой список, bare MCP-имя). DEBUG набор+бакет на скил, WARN на недоступное. *(depends on 1)*
<!-- Commit checkpoint: tasks 1-2 -->

### Фаза 5b — Встроенные инструменты
- [x] **Task 3**: `mastra/tools/currency.ts` — `currency_rates`: три параллельных fetch (nbrb/belarusbank/myfin, `Promise.allSettled`, AbortController, таймаут `http_client`); myfin — регулярка без cheerio; RUB scale=100; отказ источника → `error`, не throw; `fetchFn` инъектируемый. Unit с фейк-fetch (все три / частичный отказ / пустой `currency`). DEBUG источник+длительность, WARN отказ. *(depends on 2)*
- [x] **Task 4**: `mastra/tools/tasks.ts` — `task_create/list/get/update/delete/toggle` поверх `cron_tasks` (drizzle), скоуп `userId`; sessionId/notificationChatId из ctx; `validateSchedule` (now/once/cron мин 1ч, `cron-parser`); лимит `max_tasks` плана; prompt ≤ `MAX_TASK_PROMPT_LEN`. Unit на validateSchedule; integration (libSQL) полный CRUD + скоуп + превышение лимита. DEBUG операция, INFO create/delete, WARN отказ. *(depends on 2)*
- [x] **Task 5**: `mastra/tools/profile-tools.ts` — `update_city` (users.city/timezone, `validateTimezone`/`sanitizeProfileField`), `update_bot_vibe` (≤200), `update_bot_name` — upsert `bot_identities` по userId; скоуп userId; read-профиля и язык НЕ переносим. Unit (валидация); integration (libSQL): запись users + upsert bot_identities (insert/update). DEBUG поле (без PII), INFO успех, WARN отклонение. *(depends on 2)*
- [x] **Task 6**: `mastra/tools/skill-ref.ts` (+ `skill-agent.ts`, **НЕ** prompt-builder) — `read_skill_reference {skill_name, ref_path}` (валидация пути references/|scripts/|assets/, запрет `..`/абсолютных, обрезка 8000) читает с ФС корня `join(SEED_DIR,"skills")` (`SEED_DIR` экспортируется из `db/seed.ts`, инъектируемый). Слот `[SKILL REFERENCES]` уже разведён (`referencesHint`) → работа: `listReferences(skillName): SkillReference[]` + проброс `references` в сборку промпта из `skill-agent.ts`. Unit (path traversal отклонён, валидный читается, listReferences на fixture). DEBUG запрос, WARN traversal/нет файла. *(depends on 2)*
<!-- Commit checkpoint: tasks 3-4 ; tasks 5-6 -->

### Фаза 5c — Поддерживающие сервисы (по ARCHITECTURE.md)
- [x] **Task 7**: `services/usage.ts` — `recordUsage(userId,cost,requests=1)` (upsert `usage_stats` по userId+date UTC, инкремент; cost из `LlmResult.cost`, undefined→0), `getDailyUsage(userId,date?)`; drizzle, скоуп userId. Integration (libSQL): суммирование за день, разные даты — разные строки, cost=undefined→0. DEBUG проводка. *(независим; проводка + surface cost из агентов — Task 9)*
- [x] **Task 8**: `services/rate-limit.ts` — `checkAndConsume(userId)`: окно = час, upsert `message_rate_limits`, лимит = `hourly_limit` плана (дефолт free), онбординг-байпас; clock инъектируемый. Unit/integration (фейк-clock): отказ на limit+1, сброс при смене часа, onboarded=false не тратит. DEBUG окно/счётчик, WARN отказ. *(независим; подключение — Task 9)*
<!-- Commit checkpoint: tasks 7-8 -->

### Фаза 5d — Интеграция и composition root
- [x] **Task 9**: `chat.ts` / `skill-agent.ts` / **`synthesizer.ts`** / `app.ts` / `server.ts` — (1) **surface cost**: возврат `runSkillStreaming`/`runSkillSubAgent`/`synthesize` → `{text,cost}` (сейчас `string`, cost теряется); (2) проброс расширенного `ToolContext` (оба пути skill-agent, источники deps.db/deps.settings/input.chatId/ctx.session.id); (3) MCP-init в `app.ts::createChatService` (кэш `mcpTools`, недоступен → WARN; `disconnect()` на shutdown); (4) rate-limit gate между `ensureThread` и `getAgent` (онбординг-байпас, отказ → userMessage без роутинга); (5) `usage.recordUsage` после ответа; (6) расширить `ChatDeps` (+rateLimit/+usage/+mcpTools). Integration (libSQL + фейк-LLM + фейк-MCP): резолв builtin+MCP, отказ по лимиту, запись usage (cost проброшен), чат при недоступном MCP. INFO готовность (число MCP-инструментов, план — без секретов). *(depends on 2,3,4,5,6,7,8)*
<!-- Commit checkpoint: task 9 -->

---

## Граф зависимостей (порядок выполнения)
```
Фаза A:  1 → 2
Фаза B:  2 → {3, 4, 5, 6}            (3,4,5,6 — независимы между собой)
Фаза C:  7 ;  8                      (независимы, поверх готовой схемы)
Фаза D:  {2,3,4,5,6,7,8} → 9
```
Готовое из M0–M4 (зависимости, но не задачи): `settings.ts`/`settings-keys.ts` (getMcpServers/getTimeouts/parseGoDuration), `db/schema.ts` (cron_tasks/usage_stats/plans/rate_limits), `promptguard.ts` (sanitize/validate), `memory-tools.ts`, `registry.ts` (seam), `skill-agent.ts`, `workflows/chat.ts`, `prompt-builder.ts`, `app.ts`/`mastra/index.ts`. Новые зависимости npm: `cron-parser`.

## Артефакт-результат
По завершении: скил с `allowed-tools` (например `web_search currency_rates task_create`) получает реальные инструменты — встроенные (currency/tasks/profile/skill-ref) и MCP `search` (через namespaced→bare-алиасинг); неизвестные имена по-прежнему WARN+skip. Cron-задачи создаются/редактируются с валидацией расписания и лимитом плана (исполнение — M7). Профиль и личность бота правятся инструментами. `[SKILL REFERENCES]` наполняется из каталога скилов, `read_skill_reference` отдаёт документы с защитой от traversal. На входе диалога работает почасовой rate-limit (с онбординг-байпасом), после ответа фиксируется usage. Паритет с Go-реестром инструментов (минус `exec` и MCP `memory`). Готова база под Telegram-бота (M6) и cron-планировщик (M7).
