# Project Roadmap — Avocado AI → jarvis (TypeScript + Mastra)

> Переписать Avocado AI с Go на **TypeScript + Mastra.ai**, уйти от PostgreSQL к **libSQL/Turso** (реляционка + векторный поиск в одном движке), перенести максимум настроек в БД (в `.env` — только секреты) и добавить **админку в виде Telegram Mini App**. Это целевой репозиторий `jarvis`; референс для миграции — Go-проект в соседней папке `/Users/serg/GolandProjects/avocado-ai` (остаётся нетронутым до переключения).

## Milestones

- [x] **0. Каркас проекта** — структура `jarvis/`, `package.json`/`tsconfig`, инициализация Mastra, libSQL + Drizzle, `.env.example`
- [x] **1. БД и настройки** — Drizzle-схема (10 таблиц из Postgres + `settings`/`models`/`skills`/`prompts`), миграции, сид из текущих `config.yaml`/`skills`/`prompts`, `SettingsService` (кэш + hot-reload)
- [x] **2. LLM-слой** — провайдеры через AI SDK, фабрика модели `provider:model`, стрим + watchdog + ретраи/фолбэк + извлечение cost, embeddings (HTTP к OpenRouter), speech
- [x] **3. Память** — `memories` + LibSQLVector RAG, classifier permanent/session, sensitivity-фильтр, дедуп, cap; profile-extractor (онбординг); Mastra Memory для истории диалога
- [x] **4. Скилы и воркфлоу** — фабрика skill-agent из БД, агент-роутер, синтезатор, chat workflow (single + multi), promptguard
- [x] **5. Инструменты и MCP** — currency, tasks (cron CRUD), memory-tools, profile-tools, skill-ref; MCPClient (только сервер `search`)
- [x] **6. Telegram-бот** — grammY: polling/webhook, троттлинг-стриминг `editMessageText`, голос→speech, markdown-формат, команды, messenger для уведомлений
- [x] **7. Cron-планировщик** — node-cron, исполнитель задач, нотификации пользователю
- [x] **8. Админка (Mini App)** — Hono-API (CRUD skills/models/settings/prompts/plans/users/usage/mcp) + React Mini App + auth по `initData`
- [ ] **9. Деплой** — Docker (1 контейнер: сборка фронта → отдача бэкендом, Mini App под `/miniapp`) + внешний Caddy (TLS + reverse-proxy к `jarvis-app:8080` через общую сеть `edge`) + deploy-скрипт (генерация `.env`) и Makefile. ~~Миграция данных Postgres → libSQL — НЕ актуальна: запускаем как новый проект.~~
- [ ] ~~**10. Паритет и переключение**~~ — **НЕ актуально**: новый проект, Go не мигрируем и не выводим из эксплуатации.
- [x] **11. Встроенный web-search (нативные инструменты)** — перенос внешнего MCP-сервиса `search` в backend как нативный AI-SDK бакет `web` (21 инструмент: `web_search`/`web_search_batch`/`fetch_url`/`search_news`/маркетплейсы РБ kufar·av.by·rabota·zippybus·relax + 103.by (4 консолидированных) + `weather` + 6 lookup), `searxng`+`redis` в compose, SSRF-guard на `fetch_url`, без браузера/Chromium; MCP-плумбинг удалён целиком. **Отменяет** §9 («search оставляем как отдельный MCP-сервис»), parity-заметку «MCP `search` only» и §10.3 (weather как MCP-tool) — полную сверку ROADMAP/CLAUDE сделать через `/aif-roadmap` + `/aif-rules`.
- [x] **12. Файловый источник скилов и промтов** — скилы (`backend/skills/<name>/SKILL.md`) и системные промпты (`backend/prompts/*.md`) переехали из таблиц БД в **файловый стор** (`src/content/`): репо-дефолты + персистентный том (`SKILLS_DIR`/`PROMPTS_DIR`), **populate-if-empty** на старте, атомарная запись (`*.tmp`+rename) и hot-reload (сверка mtime), валидация имён/ключей (containment). Админка пишет файлы стора (HTTP-контракт name/key-адресный, фронт не тронут). Таблицы `skills`/`prompts` **удалены** (миграция 0001); `config.yaml` заменён на код-сид (`src/db/seed-data.ts`) — в БД сидятся только `settings`/`models`/`subscriptionPlans`.
- [x] **13. Память без вектора** — долгосрочная память де-векторизована: `LibSQLVector`/индекс `memories_vec`, `EmbeddingService` и весь RAG **удалены**. Таблица `memories` остаётся источником правды, но при cap 50 грузится в контекст **целиком** (`loadRelevant` без RAG/topK). Дедуп при `remember` — **LLM-проверка** (`DedupChecker`/`LlmDedupChecker`, инъектируемая → тесты без сети) вместо cosine `0.92`. Инструмент `memory_search` убран (вся память и так в контексте). Чистка: роль модели `embedding`, настройка `rag_top_k` и константы `EMBEDDING_DIM`/`RAG_*`/`DUPLICATE_SIMILARITY_THRESHOLD` удалены по бэку и фронту. **Сознательный отход от Go-паритета** (зафиксировано в CLAUDE.md).
- [x] **14. Надёжность и память агента (refactor)** — диалоговая история получила **per-session rolling summary** (`sessions.summary`): сообщения, вытесненные за окно `agent.max_history`, сворачиваются LLM-суммаризатором (роль `synthesizer || default`, watchdog 30s, fail-open). Долгосрочная память дополнена **опортунистичным экстрактором** (`FactExtractor`, гейт `agent.auto_memory`, по умолчанию on) поверх `remember` + онбординга — всё через `MemoryService.save` (sensitivity/dedup/cap). `agent.max_history` поднят 15 → 50 (миграция 0002); история прокинута мульти-скил суб-агентам; писатели для категорий `reflection`/`strategy`. Плюс калибровка промптов под flash-модели (убраны дубли с глобальными SOUL/INTEGRITY/FORMAT, срезаны лишние чек-листы, облегчён `_TEMPLATE.md`) и гигиена доков (`about` Go→TS, `ARCHITECTURE`/`DESCRIPTION` под M11–M13, `/new` cleanup осиротевших тредов). План: `.ai-factory/archive/plans/refactor.md`.
- [x] **15. Агент-оркестратор (mastra-adoption)** — связка Router → N скилов → Synthesizer заменена **одним динамическим Mastra `Agent`** (`mastra/agents/orchestrator.ts`): `instructions`/`model`/`tools` — функции от per-request `RequestContext` (DI + DB-конфиг сохранены, Agent standalone). Прогрессивная загрузка скилов через `load_skill` (все тулзы регистрируются сразу, гейтинг `prepareStep`→`activeTools`); дешёвый пред-проход (`primary-skill.ts`) выбирает основной скил + модель хода. Плюс: guardrails-процессоры (NFKC-нормализация до injection-чека, PII-редакция памяти), stream-статусы тулзов (`.fullStream`), `AbortSignal` в веб-тулзы, детерминированный eval-харнесс (`npm run eval`), tool-approval для рискованных тулзов (`forget`/`task_delete` → `pending_confirmations`, миграция 0003). ⚠️ Роль модели `synthesizer` сохранена (переиспользуется rolling-summary). План: `.ai-factory/archive/plans/mastra-adoption.md`.
- [ ] **16. Память на нативных фичах Mastra (watch — отложено)** — кандидаты из Фазы 4 плана mastra-adoption: **D1** working-memory schema (стабильный zod-профиль, запись только через `MemoryService.save`) и **D2** observational memory как замена `sessions.summary` (нативно, без RAG). Блокер: resource-scope (кросс-сессия на юзера) ещё experimental + фоновые LLM-вызовы вне бюджета watchdog — ревизит после GA.
- [x] **17. Доступ к боту по заявкам** — гейт бота получил режим `telegram_access_mode` (`open`|`approval`). В `approval` доступ только из `telegram_allowed_users`; незнакомец вместо тихого дропа создаёт заявку (`access_requests`, миграция 0004) и получает одноразовый ответ «Заявка отправлена», а админ одобряет в Mini App (Пользователи → «Заявки») → tg id добавляется в allowlist + клиенту уходит «Доступ открыт ✅». `AccessRequestService` (record/list/approve/reject) в `ChatDeps`; гейт (`bot.ts`) и админка делят один `SettingsService` (invalidate виден без рестарта); `ensureAccessControlDefaults` на старте один раз включает `approval`, перенеся текущих telegram-пользователей в allowlist (без локаута). Admin API `/users/access-mode` + `/users/requests` (approve/reject + notify); фронт — переключатель режима + инбокс заявок. План: `.ai-factory/plans/feature-telegram-access-requests.md`.

## Completed

| Milestone | Date |
|-----------|------|
| 0. Каркас проекта | 2026-06-14 |
| 1. БД и настройки | 2026-06-14 |
| 2. LLM-слой | 2026-06-14 |
| 3. Память | 2026-06-14 |
| 4. Скилы и воркфлоу | 2026-06-14 |
| 5. Инструменты и MCP | 2026-06-14 |
| 6. Telegram-бот | 2026-06-14 |
| 7. Cron-планировщик | 2026-06-14 |
| 8. Админка (Mini App) | 2026-06-14 |
| 11. Встроенный web-search (нативные инструменты) | 2026-06-15 |
| 12. Файловый источник скилов и промтов | 2026-06-15 |
| 13. Память без вектора | 2026-06-15 |
| 14. Надёжность и память агента (refactor) | 2026-06-17 |
| 15. Агент-оркестратор (mastra-adoption) | 2026-06-18 |
| 17. Доступ к боту по заявкам | 2026-06-18 |

---

# Детальный план миграции (полный)

> Статус: черновик для ревью. Дата: 2026-06-14.
> Цель: переписать Avocado AI с Go на TypeScript на базе фреймворка [Mastra.ai](https://mastra.ai/),
> уйти от PostgreSQL в пользу **libSQL/Turso** (реляционка + векторный поиск в одном движке),
> перенести максимум настроек в БД (в `.env` — только секреты), добавить **админку в виде Telegram Mini App**.

## Зафиксированные решения

1. **БД:** libSQL (SQLite-совместимый) + LibSQLVector. Локально — файл, в проде — Turso. Это родное дефолтное хранилище Mastra.
2. **Процессы:** один Node-сервис (бот + cron + админ-API в одном процессе) — снимает проблему «single writer» у SQLite.
3. **Скилы и системные промпты:** хранятся полностью в БД, редактируются через миниапп. Текущие `skills/*/SKILL.md` и `prompts/*.md` — сид при первом запуске.
4. **Конфиг:** роли моделей, список моделей, таймауты, `agent.*`, планы/лимиты, allowed_users, MCP-серверы — в БД. В `.env` — только секреты.

---

## 1. Целевой стек

| Слой | Технология |
|---|---|
| Runtime | Node.js 22 LTS, TypeScript 5, ESM |
| Агентный фреймворк | `@mastra/core` (agents, workflows, tools), `@mastra/memory` |
| Хранилище / вектор | `@mastra/libsql` (`LibSQLStore` + `LibSQLVector`) |
| Реляционка/миграции | Drizzle ORM (`drizzle-orm` + `drizzle-kit`) поверх libSQL — для наших таблиц настроек/скилов/планов |
| LLM-провайдеры | Vercel AI SDK: `@openrouter/ai-sdk-provider`, `@ai-sdk/openai`, `@ai-sdk/google`, `@ai-sdk/xai`; Z.AI через `@ai-sdk/openai-compatible` |
| MCP | `@mastra/mcp` (`MCPClient`) |
| Telegram | grammY (`grammy`, `@grammyjs/*`) |
| Cron | `node-cron` (внутри основного процесса) |
| Валидация | `zod` |
| HTTP/Admin API | Hono (встроен в Mastra server) |
| Admin UI | React + Vite + `@twa-dev/sdk` (Telegram Web App), UI-кит (shadcn/ui или Mantine) |
| Логи | `pino` (structured JSON) — аналог slog |
| Деплой | Docker (один контейнер app), опц. Turso |

### Соответствие подсистем (Go → TS/Mastra)

| Сейчас (Go) | Станет |
|---|---|
| Genkit + 5 провайдеров | AI SDK провайдеры; фабрика модели по строке `provider:model` |
| LLMAdapter (стрим, watchdog, ретраи, фолбэк, cost) | обёртка над AI SDK `streamText`/`generateText` + `onChunk`-watchdog + парсинг `usage.cost` |
| SkillRouter (router_model) | агент-роутер со structured output (zod) |
| Скил = SKILL.md | запись в таблице `skills` → фабрика Mastra-агента |
| router → суб-агенты → synthesizer | Mastra Workflow: `route` → параллельный `runSkills` → `synthesize` |
| MemoryService + pgvector RAG | модуль памяти на LibSQLVector + Mastra Memory для истории диалога |
| ProfileExtractor (онбординг) | агент со structured output (авто-извлечения фактов нет) |
| EmbeddingService | HTTP-клиент к OpenRouter `/embeddings` (батч), §6.1 |
| SpeechRecognizer | мультимодальная модель через AI SDK (media part) |
| Tools registry (встроенные: currency/tasks/remember/forget/memory_search/profile/skill-ref) | Mastra Tools (zod-схемы); `exec` НЕ переносим |
| MCP client | `@mastra/mcp` MCPClient — только сервер `search` (web_search/web_fetch/avby_search/read_resource/weather) |
| Telegram (go-telegram/bot) | grammY |
| Cron (robfig/cron) | node-cron + воркфлоу исполнения задачи |
| sessionstorage (зашифрованные файлы) | сообщения в Mastra Memory (libSQL), без шифрования |
| config.yaml + .env | таблицы `settings`/`models`/`skills`/`prompts` + минимальный `.env` |
| goose миграции | drizzle-kit миграции |

---

## 2. Структура проекта

> Это целевой репозиторий `jarvis`. Референс (исходник) для миграции — Go-проект `avocado-ai` в соседней папке `/Users/serg/GolandProjects/avocado-ai` (остаётся нетронутым до переключения).

```
jarvis/
  src/
    config/
      env.ts             # zod-валидация .env (секреты)
      settings.ts        # SettingsService: чтение конфига из БД + кэш + hot-reload
    db/
      client.ts          # libSQL client
      schema.ts          # Drizzle схема
      migrations/        # drizzle-kit миграции
      seed.ts            # сид из старых config.yaml/skills/prompts
    domain/
      entities.ts        # zod-типы: User, Session, Memory, Skill, CronTask, ...
      memory-classifier.ts   # permanent/session (порт из rules)
      sensitivity-filter.ts  # фильтр чувствительных тем (порт из rules)
    mastra/
      index.ts           # Mastra instance (storage, vector, memory, agents, workflows)
      models.ts          # фабрика модели по строке provider:model
      llm.ts             # стрим + watchdog + ретраи/фолбэк + cost
      agents/
        skill-agent.ts   # фабрика агента из записи skills
        router.ts        # агент-роутер
        synthesizer.ts   # агент-синтезатор
        extractors.ts    # memory/profile extractors
      workflows/
        chat.ts          # route → runSkills → synthesize
      memory/
        memory-service.ts  # RAG по фактам (LibSQLVector), дедуп, cap
        profile-extractor.ts  # извлечение профиля при онбординге (авто-извлечения фактов нет — паритет с Go)
      tools/
        currency.ts  tasks.ts  memory-tools.ts  profile-tools.ts  skill-ref.ts
      mcp.ts             # MCPClient — только сервер search
      speech.ts          # транскрипция
    services/
      skill-service.ts   # загрузка скилов из БД, фильтр routable
      rate-limit.ts      # планы/лимиты
      usage.ts           # учёт стоимости
    telegram/
      bot.ts             # grammY: команды, апдейты
      stream.ts          # throttled editMessageText стриминг
      format.ts          # markdown → Telegram (порт goldmark-логики)
      voice.ts           # голос → speech
      messenger.ts       # отправка уведомлений из cron
    scheduler/
      scheduler.ts       # node-cron, исполнение задач, нотификации
    admin/
      api/               # Hono-роуты: skills, models, settings, prompts, plans, users, usage, mcp
      auth.ts            # валидация Telegram initData + белый список админов
    pkg/
      promptguard.ts     # валидация ввода, sanitize
      logger.ts          # pino
    server.ts            # единый процесс: Mastra server (Hono) + grammY + scheduler
  admin-web/             # отдельный пакет: React + Vite Mini App
  drizzle.config.ts
  package.json  tsconfig.json
  Dockerfile  docker-compose.yml
  .env.example
```

---

## 3. Схема БД (libSQL)

### Переносим из Postgres (Drizzle)
- `users` (id, name, display_name, city, timezone, language, onboarded, created_at, updated_at)
- `user_channels` (id, user_id, provider, external_id, UNIQUE(provider, external_id))
- `sessions` (id, chat_id UNIQUE, user_id, model, thread_id, created_at, updated_at) — `thread_id` связывает с Mastra Memory
- `memories` (id, user_id, category, scope, session_id, content, created_at, updated_at) + вектор в LibSQLVector index `memories_vec` (1024-dim)
- `bot_identities` (user_id UNIQUE, bot_name, vibe, system_prompt_override)
- `cron_tasks` (все поля как сейчас)
- `usage_stats` (user_id, date, cost, requests, UNIQUE(user_id, date))
- `subscription_plans` (name UNIQUE, hourly_limit, max_tasks)
- `user_subscriptions` (user_id PK, plan_id)
- `message_rate_limits` (user_id, window_start, count, PK(user_id, window_start))

### Новые таблицы для конфигурации
- `settings` (key TEXT PK, value JSON) — глобальный конфиг: роли моделей (default/router/embedding/error_correction/speech/synthesizer), `timeouts.*`, `agent.*` (max_history, default_temperature, rag.top_k — в Go захардкожено =10, теперь настраивается), `telegram.allowed_users`, `mcp_servers` (только `search`).
- `models` (id, ref `provider:model`, provider, enabled, label, supports_tools, supports_reasoning, notes) — список доступных моделей для UI и валидации ролей.
- `skills` (name PK, description, allowed_tools JSON, model, temperature, reasoning, routable, prompt TEXT, metadata JSON, updated_at).
- `prompts` (key PK, body TEXT, updated_at) — SOUL/FORMAT/INTEGRITY/SYNTHESIZER/WELCOME/MONITORING.

### Создаются Mastra автоматически
- `mastra_threads`, `mastra_messages` (история диалога), таблицы vector-индексов. Сообщения мигрируют сюда из зашифрованных файлов.

> Сообщения переезжают из зашифрованных файлов в libSQL и хранятся в открытом виде (шифрование отключено, см. §6).

---

## 4. Конфиг: что в БД, что в .env

### `.env` (только секреты, минимум)
```
LIBSQL_URL=file:./data/avocado.db        # или libsql://<turso>.turso.io
LIBSQL_AUTH_TOKEN=                         # только для Turso
TELEGRAM_BOT_TOKEN=
OPENROUTER_API_KEY=
ZAI_API_KEY=
OPENAI_API_KEY=
XAI_API_KEY=
GOOGLE_API_KEY=
ADMIN_USER_IDS=123,456                     # bootstrap-админы миниаппа (Telegram user id)
```
> Ключи шифрования сессий (`SESSION_HMAC_KEY`, `SESSION_ENCRYPTION_KEY`) убраны — переписку не шифруем.

### В БД (редактируется из админки)
Роли моделей, список моделей, таймауты, параметры агента и RAG (max_history, default_temperature, rag.top_k), планы и лимиты, allowed_users, MCP-серверы, **скилы**, **системные промпты**.

`SettingsService` читает конфиг из БД, кэширует в памяти, поддерживает hot-reload (инвалидция кэша при сохранении через админку — pub/sub или простой версионный счётчик/`updated_at`).

---

## 5. Агентная архитектура (Mastra)

### Скил → агент
Фабрика `buildSkillAgent(skillRow)`: `instructions` = тело промпта скила (+ собранный системный контекст), `model` = `skill.model || settings.default_model`, `tools` = разрешённые инструменты, `temperature/reasoning` из записи.

### Chat Workflow (router → суб-агенты → синтезатор)
1. **route** — агент с `router_model`, structured output (zod-массив имён скилов, 1–4). Учитывает предыдущие скилы и историю. Фолбэк → `research`. Онбординг → форс `onboarding`.
2. **runSkills** — параллельно (`.foreach`/`Promise.all`) по выбранным скилам; каждый суб-агент исполняется со своими инструментами; защита от циклов (тот же запрос+скил не чаще N раз).
3. **synthesize** — если скил один: стримим ответ напрямую (без синтезатора). Если несколько: агент с `synthesizer_model` (если не задан — берётся `session.Model`, как в Go) сводит результаты по правилам `SYNTHESIZER`, стримим в Telegram.

Системный промпт собирается как сейчас: security-инструкция → SOUL (или override личности) → capabilities (имя/vibe) → user context → memories → INTEGRITY (если есть инструменты) → тело скила → ссылки скила → FORMAT → текущая дата/время.

### Память (консолидированная — одна система)
- **История диалога** — Mastra Memory (threads/messages) с working memory; semantic recall опционально.
- **Долговременные факты о пользователе** — отдельный модуль на LibSQLVector (порт текущей логики): classifier permanent/session, sensitivity filter, дедуп по косинусу (0.92), cap (50 permanent), RAG-выборка (порог/top_k = 10, теперь настраивается из БД).
- **Запись фактов — паритет с Go:** только инструментом `remember` (LLM решает сам) и при онбординге (`profile-extractor`). Автоматического фонового LLM-извлечения фактов НЕТ (в Go оно не подключено, а `agent.memory_extraction.*` — мёртвый конфиг).
- **MCP-сервер `memory` (knowledge-graph) НЕ переносим** — функция консолидирована во встроенную память. Остаётся только MCP-сервер `search`.

---

## 6. Сложные места и решения

1. **Эмбеддинги — РЕШЕНО: оставляем OpenRouter** (`multilingual-e5-large`, 1024-dim). Поскольку AI SDK-провайдер OpenRouter эмбеддинги отдаёт ненадёжно, делаем **тонкий HTTP-клиент** к `https://openrouter.ai/api/v1/embeddings` (как в текущем `embedding_service.go`). Размерность сохраняется → векторы переносятся 1:1, пересчёт не нужен.
2. **Стриминг в Telegram.** Go использует `SendMessageDraft` (Bot API 9.3 — нестандартный механизм черновиков с курсором `▌`). В grammY его нет — переходим на троттлинг `editMessageText` (≈каждые 0.7–1.5с) с финальной отправкой полного markdown. UX слегка меняется (курсор-черновик уходит) — приемлемо.
3. **watchdog + cost.** Нет из коробки: watchdog по тишине реализуем через таймер, сбрасываемый в `onChunk`; стоимость OpenRouter — из `response.usage`/провайдер-метаданных AI SDK.
4. **«Утёкшие» tool-call в тексте** (`stripLeakedToolCalls`) — переносим как пост-обработку ответа.
5. **Шифрование сообщений — РЕШЕНО: не шифруем.** Сообщения хранятся в libSQL в открытом виде. Ключи `SESSION_HMAC_KEY` / `SESSION_ENCRYPTION_KEY` удаляются. Защита — на уровне диска/хоста.
6. **Single writer SQLite.** Решается единым процессом; cron внутри него. Для горизонтального масштабирования — Turso.
7. **Миграция данных.** Скрипт переноса из Postgres → libSQL: users, channels, memories (+перенос эмбеддингов 1:1), bot_identities, cron_tasks, usage_stats, plans, subscriptions; сообщения из старых зашифрованных файлов расшифровываются текущими ключами и пишутся в `mastra_messages` в открытом виде. Таблицы `messages` в Postgres НЕТ (удалена миграцией 00018) — переписка лежит только в зашифрованных файлах сессий.

---

## 7. Этапы работ

| Фаза | Содержание | Результат |
|---|---|---|
| 0. Каркас | моно-структура, package.json, tsconfig, Mastra init, libSQL+Drizzle, `.env.example` | пустой сервис запускается |
| 1. БД и настройки | Drizzle-схема, миграции, seed из config.yaml/skills/prompts, `SettingsService` (кэш+hot-reload) | конфиг читается из БД |
| 2. LLM-слой | провайдеры, фабрика модели, стрим, watchdog, ретраи/фолбэк, cost, embeddings, speech | паритет LLMAdapter |
| 3. Память | memories+LibSQLVector RAG, classifier/sensitivity/dedup/cap, profile-extractor (онбординг), remember/forget; Mastra Memory для истории | паритет MemoryService |
| 4. Скилы/воркфлоу | фабрика skill-agent, router, synthesizer, chat workflow (single+multi), promptguard | работает диалог с роутингом |
| 5. Инструменты + MCP | currency, tasks(cron CRUD), memory tools, profile tools, skill-ref; MCPClient (только `search`). `exec` не переносим | инструменты доступны агентам |
| 6. Telegram | grammY: polling/webhook, стриминг, голос→speech, markdown, команды, messenger | бот отвечает в Telegram |
| 7. Cron | node-cron, исполнитель задач, нотификации | напоминания/задачи работают |
| 8. Админка | Hono-API (CRUD skills/models/settings/prompts/plans/users/usage/mcp) + React Mini App + auth initData | редактирование из Telegram |
| 9. Деплой+данные | Dockerfile (1 контейнер), npm-scripts (аналог Makefile), скрипт миграции данных из Postgres | прод-развёртывание |
| 10. Паритет/тесты | debug-harness (аналог cmd/debug_chat), unit/integration, сверка поведения, вывод Go из эксплуатации | переключение на TS |

---

## 8. Функционал админки (Mini App)

- **Скилы:** список / создание / редактирование (name, description, tools — мультиселект, model — селект, temperature, reasoning, routable, prompt — textarea с предпросмотром), удаление, тест-прогон скила.
- **Модели:** список, вкл/выкл, добавление `provider:model`, назначение ролей (default/router/embedding/error_correction/speech/synthesizer).
- **Настройки:** таймауты, max_history, default_temperature, RAG top_k.
- **Промпты:** SOUL / FORMAT / INTEGRITY / SYNTHESIZER / WELCOME / MONITORING.
- **Планы:** free/pro/admin (hourly_limit, max_tasks), назначение плана пользователю.
- **Пользователи:** список, план, usage.
- **Usage:** суточная стоимость и число запросов.
- **MCP-серверы:** список, вкл/выкл, URL.
- **Auth:** валидация `initData` (HMAC по bot token) + белый список `ADMIN_USER_IDS`.

---

## 9. Что НЕ переносим / упрощаем
- ~~Внешний MCP-сервер `search` (cars.av.by, web_search/web_fetch/avby_search/read_resource/weather) оставляем как есть — отдельный сервис; скилы продолжают на него опираться.~~ **ОТМЕНЕНО (M11, 2026-06-15):** `search` перенесён в backend как нативный бакет `web`; MCP-плумбинг удалён. См. milestone 11.
- MCP-сервер `memory` (knowledge-graph) убираем — память консолидирована во встроенную (см. §5).
- Инструмент `exec` не переносим (в Go он зарегистрирован, но заблокирован от LLM).
- Файловое хранилище сессий заменяется на libSQL.
- `cmd/cli` (set-plan) заменяется управлением из админки.
- Мёртвый конфиг Go (`agent.rag.enabled`, `agent.memory_extraction.*`) не тащим; `rag.top_k` делаем реально работающим и настраиваемым.

---

## 10. Расхождения с Go-версией, учтённые при ревью (2026-06-14)
1. **Авто-извлечения памяти** из диалога в Go **нет** → в TS тоже не делаем (только `remember` + онбординг).
2. **Мёртвый конфиг:** `agent.rag.*` и `agent.memory_extraction.*` в `config.yaml` не парсятся (порог/top_k захардкожены = 10) → переносим только реально используемое.
3. **`weather`** — ~~не встроенный инструмент, приходит из MCP `search` → в инвентаре он MCP-tool, не Go-tool.~~ **ОТМЕНЕНО (M11, 2026-06-15):** `weather` теперь нативный инструмент бакета `web` (gismeteo.by, без MCP).
4. **Две системы памяти** (встроенная + MCP `memory`) → консолидируем в одну.
5. **`exec`** зарегистрирован, но заблокирован → не переносим.
6. **Synthesizer-модель:** фактически `session.Model`, переопределяется `synthesizer_model` если задан.
7. **`SendMessageDraft`** (Bot API 9.3) → в grammY заменяется троттлингом `editMessageText` (курсор-черновик уходит).
8. Таблицы **`messages`** в Postgres нет (удалена в 00018); переписка — в файлах сессий.
9. **Observability** (Grafana/Loki/Promtail) в Go-инфре есть → в TS: pino→stdout, Loki опционально на этапе деплоя (§7, фаза 9).
