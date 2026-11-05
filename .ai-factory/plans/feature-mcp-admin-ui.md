# План реализации: MCP-серверы через админку (HTTP, JSON-конфиг)

Branch: `feature/mcp-admin-ui`
Created: 2026-11-05 · Refined: 2026-11-06 (`/aif-improve`, сверка с `@mastra/mcp@2.8.0`)
Источник: запрос «добавить поддержку MCP через UI, чтобы можно было просто добавить конфиг в виде JSON».

> Цель: вернуть MCP-клиент в проект (удалён в M11) уже как **управляемый из Mini App** слой:
> админ вставляет JSON-конфиг HTTP MCP-серверов, проверяет подключение, сохраняет — и
> инструменты серверов сразу доступны оркестратору. Без stdio, без `exec`, без OAuth в v1.

## Settings
- Testing: **yes** (unit на конфиг/менеджер/реестр, integration на admin API + libSQL)
- Logging: **minimal** (только WARN/ERROR; секреты, `headers` и содержимое `env` не логируем)
- Docs: **yes** (обязательный чекпоинт `/aif-docs` при завершении)

## Roadmap Linkage
Milestone: "none"
Rationale: Пользователь выбрал без привязки; новый milestone в ROADMAP не создаём.

## Research Context
Source: `.ai-factory/RESEARCH.md` (Active Summary)

Активный RESEARCH.md относится к другому бэклогу (надёжность агента / news-скилл) и не содержит
требований по MCP. Релевантные ограничения берём из `CLAUDE.md`/`ARCHITECTURE.md`: ESM/NodeNext,
инъектируемость, таймауты на каждый внешний вызов, никакого `exec`/model-driven code execution.

## Ключевые решения

| Решение | Значение |
|---|---|
| Транспорт | **Только HTTP (Streamable HTTP)**: `url` + `headers`. stdio/`command`/`args`/`env` явно отклоняются с понятной ошибкой — это сохраняет security-stance «no exec». |
| Хранение | `settings` key **`mcp_servers`**, JSON. Миграция и seed **не нужны**: пустой конфиг — валидный дефолт. |
| Формат | Claude Desktop-совместимый: `{ "mcpServers": { "<name>": { "url": "...", "headers": { "...": "..." }, "enabled": true, "timeoutMs": 60000, "allowedHosts": ["..."] } } }`. |
| Env-подстановка | `${VAR}` в `url`, значениях `headers` и `allowedHosts`; значения берутся из `process.env`. В БД хранится **сырой** конфиг с `${VAR}`. Отсутствующая переменная → warning + пустая строка; в логах только имя переменной. |
| Discovery | **Один вызов** `listToolsetsWithErrors({ perServerTimeoutMs: 10_000 })`: toolsets уже сгруппированы по серверу, ключи собираем сами как `<server>_<tool>` (так же неймспейсит SDK). `connectTimeout` = 10s (дефолт SDK 3s!), `enableServerLogs: false`, `forwardInstructions: false`. Таймаут вызова инструмента — **60s**, переопределяется `timeoutMs`. |
| Имена инструментов | `<server>_<tool>` (конвенция `MCPClient`). Имена серверов: `[A-Za-z0-9][A-Za-z0-9-]{0,39}` — **без `_`**, чтобы неймспейс был однозначным. Discovery-фильтр: только tools, подходящие под `/^[A-Za-z0-9_-]{1,64}$/`, и итоговое имя ≤64 символов; иначе skip + WARN. |
| Доступ к модели | **Все инструменты всех включённых серверов всегда активны** (выбор пользователя), независимо от `allowed-tools` скилов. Коллизия с встроенным инструментом → встроенный побеждает, MCP-инструмент пропускается + WARN. |
| Жизненный цикл | `McpManager` в composition root: фоновый `refresh()` на старте (не блокирует boot), admin save → `settings.invalidate()` + `refresh({force:true})`, ручной refresh, `close()` на shutdown; `server.ts` ждёт `close()` перед `libsql.close()`. `registerProcessHooks: false`. |
| Кэш инстансов | `MCPClient` кэширует клиентов по `id` + конфигу и при смене конфига **синхронно отключает** старый инстанс. Поэтому id — generation-scoped (`jarvis-admin-mcp-<n>`): старый клиент отключаем сами (сразу/после короткого unref-грейса), не давая конструктору оборвать in-flight tool-call. Конфиг не изменился → текущий клиент переиспользуется; force-refresh при неизменном конфиге делает повторный discovery без пересоздания; `/test` — уникальный id + `finally disconnect`. |
| Admin API | `GET/PUT /admin/api/mcp`, `POST /admin/api/mcp/test`, `POST /admin/api/mcp/refresh`; auth — существующий `requireAdmin`. `/test` и `/refresh` подключаются только к `enabled !== false`; отключённые серверы возвращаются как `{ enabled: false, connected: false, toolCount: 0 }`. |
| UI | Новая секция «MCP»: monospace JSON-textarea, кнопки «Проверить» / «Сохранить» / «Обновить статус», таблица серверов (включён, статус, число инструментов, ошибка), блок предупреждений, кнопка «Вставить пример», инфо-состояние при `ready:false`, disabled-кнопка при `refreshing`, предупреждение о plaintext-хранении headers. |
| Безопасность | HTTP MCP-серверы может добавлять только админ; URL может указывать на внутреннюю сеть — это осознанный trust boundary админки. `allowedHosts` прокидывается в `MCPClient` как defense-in-depth. `headers` не логируются; GET отдаёт конфиг админу как есть (в БД — plaintext, поэтому секреты лучше через `${VAR}`). MCP tool output — untrusted model input: `forwardInstructions:false`, санитайзеры в v1 не добавляем, подключать только доверенные серверы. |
| Границы v1 | Только tools. Resources/prompts/events, OAuth, stdio и `requireToolApproval` — вне scope. `resolveTools` (admin skill test-run, AI SDK `LlmService`) MCP-инструменты не получает: они живут только в Mastra-оркестраторе. |

**Проверенные внешние факты:**
- `@mastra/mcp@2.8.0`: peer `@mastra/core >=1.79.0-0 <2.0.0-0` (в проекте 1.79), engines Node `>=22.13` (Docker `node:22-alpine`, локально Node 24) → в Task 3 поднять `engines.node` до `>=22.13`.
- `MCPClient` v2 отдаёт Mastra-инструменты (`ToolAction`), которые совместимы с `ToolsInput` оркестратора — AI-SDK-адаптер, как в старом M5-плане, больше не нужен.
- `listToolsetsWithErrors()` возвращает toolsets, сгруппированные по серверу; SDK неймспейсит tools как `${serverName}_${toolName}` (`dist/index.js`). Одного вызова достаточно и для tools, и для counts/errors/durations.
- `HttpServerDefinition.connectTimeout` по умолчанию **3000 ms**, `BaseServerOptions.enableServerLogs` — **true**, `forwardInstructions` — **false** (`dist/client/types.d.ts`). Первые два переопределяем в server definition.
- Конструктор `MCPClient` кэширует инстансы по `id` + конфигу: при смене конфига он **синхронно** вызывает `cached.disconnect()` (`dist/index.js:18191-18194`), а при совпадении возвращает существующий инстанс. `disconnect()` удаляет инстанс из кэша. Поэтому для смены конфига нужен generation-scoped `id`, а не фиксированный.
- `.mcp.json` в корне репозитория — конфиг Claude Code, **не** конфиг приложения; его не трогаем.

---

## Commit Plan
- **Commit 1** (задачи 1–2): `feat(mcp): config schema, env expansion and settings storage`
- **Commit 2** (задача 3): `feat(mcp): HTTP MCP manager with discovery and per-server status`
- **Commit 3** (задачи 4–5): `feat(mcp): expose admin MCP tools to the orchestrator (always active)`
- **Commit 4** (задачи 6–8): `feat(admin): MCP JSON config API and Mini App screen`
- **Commit 5** (задачи 9–10): `docs(mcp): document admin-managed HTTP MCP servers`

---

## Tasks (10)

### Фаза 1 — Конфиг и хранение
- [x] **Task 1**: `backend/src/domain/mcp-config.ts` (+ `backend/test/domain/mcp-config.test.ts`) — чистый доменный модуль:
  - Типы `McpConfig`, `McpServerConfig`, `ResolvedMcpServer`.
  - Zod-схема `{ mcpServers: Record<name, server> }`, `server = { url, headers?, enabled?, timeoutMs?, allowedHosts?, type? }`, `.strict()`.
  - `parseMcpConfig(raw): { ok: true; config } | { ok: false; error }`: осмысленные ошибки — имя сервера `[A-Za-z0-9][A-Za-z0-9-]{0,39}` (**без `_`**, иначе `<server>_<tool>` неоднозначен), URL не http/https, URL с `username`/`password` (только headers), `\r`/`\n` в значениях headers, неизвестные ключи, `type: "sse"`; **pre-check** `command`/`args`/`env` → «stdio не поддерживается, используйте url HTTP MCP».
  - `expandMcpConfig(config, env = process.env): { servers; warnings; error? }`: `${VAR}` в `url`/`headers`/`allowedHosts`, missing → warning + `""`; после подстановки URL обязан быть валидным http(s).
  - `stableMcpConfigKey(servers)` — стабильный ключ по **развёрнутым** `ResolvedMcpServer` (сортировка серверов), чтобы смена env пересоздавала клиент; используется для skip-if-unchanged.
  - **Логирование:** модуль чистый, ничего не логирует; WARN делает вызывающий слой. Unit-тесты на все ветки (валидный конфиг, stdio, плохой URL, userinfo, CRLF в headers, env, сортировка ключа).
- [x] **Task 2**: `backend/src/config/settings-keys.ts` + `backend/src/config/settings.ts` (+ `backend/test/config/settings.test.ts`) — `SettingKey.McpServers = "mcp_servers"`, тип `McpConfig` из domain, `SettingsService.getMcpServers()`:
  - Нет строки → `{ mcpServers: {} }`; валидная строка → parse; невалидная → **WARN** `{ key: "mcp_servers" }` (без значений) и пустой конфиг, не бросать.
  - Миграция/seed не нужны. **Логирование:** только WARN на невалидный сохранённый конфиг; без INFO/DEBUG. Тесты: default, round-trip, битый JSON.
  <!-- Commit checkpoint: tasks 1-2 -->

### Фаза 2 — MCP-менеджер
- [x] **Task 3**: `backend/package.json`/`package-lock.json` (+ `backend/src/mastra/mcp/manager.ts`, `backend/test/mastra/mcp-manager.test.ts`) — зависимость `@mastra/mcp@^2.8.0` и `McpManager`:
  - Инъектируемый `McpClientFactory` (дефолт — `new MCPClient({ id: generationId, servers, timeout: 60_000, registerProcessHooks: false })`); интерфейс `McpClientLike` для тестов (`listToolsetsWithErrors`, `disconnect`).
  - **Server definition:** `url: new URL(...)`, `requestInit.headers`, `timeout: timeoutMs ?? 60_000`, `connectTimeout: 10_000` (дефолт SDK 3s — иначе холодный сервер ложно падает), `enableServerLogs: false`, `forwardInstructions: false`, `allowedHosts` (если задан).
  - **Discovery — один вызов** `listToolsetsWithErrors({ perServerTimeoutMs: 10_000 })`: toolsets уже сгруппированы по серверу; собираем ключи `${server}_${tool}` в `tools` (конвенция SDK), counts/errors/durations — из того же ответа. Не вызывать `listToolsWithErrors` вторым проходом.
  - **Tool-name filter:** пропускать tools, не подходящие под `/^[A-Za-z0-9_-]{1,64}$/`, и итоговое `<server>_<tool>` длиннее 64 символов; WARN `{ server, tool }`; ошибки статуса обрезать до 500 символов.
  - **Lifecycle:** generation-scoped id `jarvis-admin-mcp-<n>` на каждую генерацию конфига; конфиг не изменился и `!force` → no-op; force при неизменном конфиге → повторный discovery на текущем клиенте; изменился → новый клиент, swap, старый отключаем сами (сразу или после короткого `unref`-грейса). `closed`-guard: refresh после `close()` — no-op.
  - **Refresh queue:** сериализовать refresh; если force-запрос пришёл во время in-flight refresh, выполнить ровно один follow-up после текущего (latest-wins), чтобы admin save не потерялся. `getStatus(): { ready, refreshing, servers }`.
  - `getTools(): ToolsInput` (синхронно, снапшот), `test(config): { servers; warnings }` (ephemeral client с уникальным id, только `enabled !== false`, `finally disconnect`, live-снапшот не трогает), `close()`.
  - Per-server статус: `{ name, enabled, connected, toolCount, tools, error?, durationMs? }`; отключённые серверы — `{ enabled:false, connected:false, toolCount:0 }`; частичный отказ одного сервера не ломает остальные; полный сбой → пустые tools + статусы с ошибкой (старые tools не подсовываем).
  - `backend/package.json`: `engines.node` → `>=22.13` (требование `@mastra/mcp` 2.8).
  - **Логирование:** только WARN на отказ сервера/refresh/missing env (имя сервера/переменной + текст ошибки, без значений); никогда не логировать `headers`, URL с query-секретами и env-значения. Тесты с фейк-фабрикой: enabled-фильтр, mapping (`connectTimeout`, `enableServerLogs`, `forwardInstructions`, headers→`requestInit`), flatten/namespacing, tool-name filter, частичный отказ, пустой конфиг, skip-if-unchanged, force, refresh queue, disconnect при замене/close, изоляция `test()`.
  <!-- Commit checkpoint: task 3 -->

### Фаза 3 — Оркестратор
- [x] **Task 4**: `backend/src/mastra/tools/registry.ts` + `backend/src/mastra/tools/load-skill.ts` (+ `backend/test/mastra/tool-registry.test.ts`, `backend/test/mastra/load-skill.test.ts`) — слияние MCP в реестр:
  - `ToolContext.mcpTools?: ToolsInput`; `resolveAllTools(ctx): ToolsInput` (не `ToolSet`), порядок memory → builtins → MCP; коллизия имени → встроенный остаётся, MCP пропускается + **WARN** `{ tool }`; `load_skill` из MCP отбрасывается.
  - `activeToolNames(..., extraActive: Iterable<string> = [])` — добавляет extra-имена, если они зарегистрированы (для always-active MCP).
  - `resolveTools` (AI SDK skill-test path) не меняется. **Логирование:** WARN на коллизию; DEBUG-лог `resolveAllTools` сохранить как есть. Тесты: MCP-инструмент появляется, коллизия выигрывается builtin, extra active.
- [x] **Task 5**: `backend/src/mastra/agents/orchestrator.ts` + `backend/src/mastra/workflows/chat.ts` + `backend/src/app.ts` + `backend/src/server.ts` (+ `backend/test/mastra/orchestrator.test.ts`) — проводка:
  - `OrchestratorDeps.mcp?: { getTools(): ToolsInput }`; в `run()` брать снапшот раз в ход, класть в `ToolContext`, `load_skill` регистрировать **после** MCP (не перетирается), `prepareStep` передаёт `Object.keys(mcpTools)` в `activeToolNames`.
  - `ChatDeps.mcp: McpManager` (нужен admin API); `createChatService` создаёт менеджер, запускает `void mcp.refresh({ force: true })` (фоном, boot не блокируется), прокидывает в `Orchestrator`, `close()` → `await mcp.close()`.
  - `server.ts`: сделать callback `server.close` async и **дождаться** `chatService?.close()` до `libsql.close()`/`process.exit(0)`, иначе MCP `disconnect()` обрывается (сейчас там `void close()` + немедленный exit, строки 199-204).
  - Тесты оркестратора: MCP-инструмент активен на шаге 0 без загруженного скила; MCP-тул с именем `load_skill` не перетирает настоящий `load_skill`.
  - **Логирование:** новых INFO/DEBUG нет; WARN — только из менеджера. Обновить фейк в `orchestrator.test.ts`, если поле обязательное (или сделать `mcp?` опциональным с пустым фолбэком).
  <!-- Commit checkpoint: tasks 4-5 -->

### Фаза 4 — Admin API и Mini App
- [x] **Task 6**: `backend/src/admin/api/mcp.ts` + `backend/src/admin/api/index.ts` + `backend/src/admin/api/setting-write.ts` (вынести `upsertSetting` из `settings.ts`) (+ `backend/test/admin/mcp.test.ts`) — роуты (depends on **2, 3**):
  - `GET /` → `{ config, ready, refreshing, status }`; `PUT /` → parse → upsert `mcp_servers` → `settings.invalidate()` → `await mcp.refresh({ force: true })` → `{ ok, config, ready, refreshing, status, warnings }`; `POST /test` → parse → `mcp.test(config)` → `{ ok, status, warnings }` (per-server ошибки в 200, 400 только на schema); `POST /refresh` → force-refresh сохранённого конфига.
  - `/test` и `/refresh` подключаются только к `enabled !== false`; отключённые серверы — `{ enabled: false, connected: false, toolCount: 0 }`. Ошибки — `{ error: string }` (400), без эха значений и headers.
  - **Логирование:** WARN на validation failure и на отказ refresh; `adminUserId` в контексте, без конфига. Integration-тест с libSQL + фейковым менеджером: default GET, stdio→400, успешный PUT (строка в settings + invalidate + refresh), `/test` без записи и только enabled, `/refresh` force, отсутствие секретов в error-ответе.
- [x] **Task 7**: `frontend/src/lib/types.ts` — `McpServerConfig`, `McpConfig`, `McpServerStatus`, `McpStatusResponse` (включая `ready`/`refreshing`; зеркало admin-контракта; `Timestamp` не нужен). **Логирование:** n/a (типы).
- [x] **Task 8**: `frontend/src/screens/McpScreen.tsx` + `frontend/src/nav.tsx` — секция «MCP»:
  - Загрузка `GET /mcp`, JSON в monospace `Textarea` (autosize, `spellCheck=false`), `savedText` для dirty-состояния; при `ready:false` — инфо-Alert «статус ещё собирается».
  - «Проверить» → `POST /mcp/test` с распарсенным JSON; «Сохранить» → `PUT /mcp`; «Обновить статус» → `POST /mcp/refresh` (disabled при `refreshing`); клиентский `JSON.parse` с понятной ошибкой; блок `warnings`; таблица `McpServerStatus` (Badge connected/disabled/error, число инструментов, tooltip со списком имён, текст ошибки); кнопка «Вставить пример» с HTTP-конфигом и `${ENV}`; предупреждение, что headers хранятся в БД открытым текстом.
  - Ошибки — через `handleApiError`/`reportError` (`_adminHelpers`), успех — toast. Новых зависимостей нет. **Логирование:** без `console.*`; только UI-toast/Alert.
  <!-- Commit checkpoint: tasks 6-8 -->

### Фаза 5 — Документация и проверка
- [x] **Task 9**: документация (обязательный чекпоинт `/aif-docs`, depends on **6, 8**):
  - `docs/mcp.md` — формат JSON (HTTP-only), `${ENV}`-подстановка, always-active инструменты и коллизии, статусы/refresh, admin API, безопасность и ограничения (no stdio/OAuth/resources/prompts, no `requireToolApproval`; MCP tool output — untrusted; headers в БД plaintext; admin skill test-run MCP-инструменты не видит), troubleshooting.
  - `README.md` (feature bullet + таблица docs), `docs/admin.md` (раздел MCP), `docs/architecture.md` (`mastra/mcp/`, dependency rules), `docs/tools.md` (MCP-бакет и ссылка на `docs/mcp.md`), `docs/chat-pipeline.md` (always-active MCP tools), `docs/configuration.md` (ключ `mcp_servers` + `${VAR}`), `.env.example` (закомментированный пример токена), `AGENTS.md` (структура `mastra/mcp/`, admin API `mcp`, экран, docs), `ARCHITECTURE.md` (layout + key decision), `DESCRIPTION.md` (статус/стек), `CLAUDE.md` (снять «no MCP» и зафиксировать HTTP-only/no-exec), `ROADMAP.md` (поправить устаревшие «MCP-плумбинг удалён» в M11/§9 — без нового milestone).
  - **Логирование:** n/a (docs).
- [x] **Task 10**: проверка и стабилизация (depends on **5, 6, 8, 9**):
  - `cd backend && npm install && npm run typecheck && npm test`; `cd frontend && npm run build`.
  - Ручной smoke: поднять сервис, добавить публичный HTTP MCP-сервер через UI, «Проверить» → «Сохранить», увидеть инструменты в статусе, задать боту запрос, требующий MCP-инструмента; проверить `enabled:false`, битый URL, отсутствующую `${ENV}`, `ready:false`/`refreshing` и то, что headers не попадают в логи.
  - Убедиться, что тесты не ходят в сеть (`test/helpers/no-network.ts`), `McpManager` в тестах всегда с фейк-фабрикой, а реальный `MCPClient` не конструируется внутри `npm test`.
  <!-- Commit checkpoint: tasks 9-10 -->

---

## Граф зависимостей

```
1 → 2 → 3 → 4 → 5
2, 3 → 6 → 8
7 → 8
6, 8 → 9
5, 6, 8, 9 → 10
```

## Артефакт-результат

В Mini App появляется секция «MCP»: админ вставляет JSON с HTTP MCP-серверами, проверяет
подключение, сохраняет и видит per-server статус (инструменты/ошибки). Включённые серверы
подключаются в фоне; их инструменты `<server>_<tool>` регистрируются в оркестраторе и активны
на каждом ходу. Discovery идёт одним `listToolsetsWithErrors`-вызовом, клиент пересоздаётся
generation-scoped id, а старый отключается после swap; shutdown ждёт `McpManager.close()`.
Конфиг переживает рестарт (settings в libSQL), секреты можно держать в `.env` через `${VAR}`,
в логи попадают только имена серверов и ошибки. stdio/`exec` не добавляются.
