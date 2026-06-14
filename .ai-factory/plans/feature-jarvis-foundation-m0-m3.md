# План реализации: jarvis — фундамент миграции (Milestones 0–3)

Branch: `feature/jarvis-foundation-m0-m3`
Created: 2026-06-14 · Refined: 2026-06-14 (/aif-improve, верификация по Go-коду)
Источник: первые 4 пункта `.ai-factory/ROADMAP.md` (Milestones **0–3**)

> Цель: переписать Avocado AI (Go) на **TypeScript + Mastra.ai**. Этот план покрывает фундамент:
> каркас проекта, БД и настройки в libSQL, LLM-слой и память. Это целевой репозиторий `jarvis`;
> референс для миграции — Go-проект в соседней папке **`/Users/serg/GolandProjects/avocado-ai`**
> (остаётся нетронутым до переключения, Milestone 10).

## Структура (monorepo)
Проект `jarvis/` — монорепо:
- **`backend/`** — Node + Mastra сервис (всё из ROADMAP §2: `src/{config,db,domain,mastra,services,telegram,scheduler,admin,pkg}`, `test/`, `package.json`, `tsconfig.json`, `drizzle.config.ts`).
- **`frontend/`** — админ Mini App (React + Vite; бывш. `admin-web/`).
- **`docker-compose.yaml`** — в корне `jarvis/`.

> Все пути вида `jarvis/src/...` / `jarvis/package.json` в задачах ниже читаются как **`jarvis/backend/src/...`** / `jarvis/backend/package.json`. Frontend-код — в `jarvis/frontend/`.

## Settings
- Testing: **yes** (юнит на портированную логику + интеграционные на БД/миграции/память)
- Logging: **verbose** (pino, детальные DEBUG-логи; уровень из `LOG_LEVEL`; секреты — `redact`)
- Docs: **yes** (`/aif-docs` после реализации)

## Объём
Покрываются milestones **0, 1, 2, 3**:
- **M0. Каркас проекта** — структура, package.json/tsconfig, Mastra init, libSQL + Drizzle, `.env.example`
- **M1. БД и настройки** — Drizzle-схема (10 перенесённых + 4 конфиг-таблицы), миграции, сид, `SettingsService`
- **M2. LLM-слой** — провайдеры (AI SDK), фабрика модели, стрим+watchdog+ретраи/фолбэк+cost, embeddings, speech, router
- **M3. Память** — `memories` + LibSQLVector RAG, classifier, sensitivity-filter, dedup, cap, profile-extractor, Mastra Memory

НЕ входит (следующие заходы): скилы→агенты/chat workflow (M4), инструменты+MCP (M5), Telegram (M6),
cron (M7), админка (M8), деплой+миграция данных (M9), паритет/переключение (M10).
Профиль-тулзы `update_city`/`update_bot_name`/`update_bot_vibe` — **M5** (в Task 21 не входят).

---

## Ключевые решения и константы (паритет с Go, верифицировано по коду)

| Параметр | Значение | Источник (Go) |
|---|---|---|
| Размерность эмбеддинга | **1024** (`intfloat/multilingual-e5-large`) | migration 00004 |
| Порог дедупликации (cosine) | **0.92** | `entity/memory.go` |
| Cap permanent-памяти | **50** | `entity/memory.go` |
| Порог онбординга (сообщений) | **4** | `entity/user.go` |
| RAG: переключение на vector-поиск | при ≥ **10** regular-фактов | `memory_service.go` |
| RAG: top-K | **10** (теперь настраивается из БД) | `memory_service.go` |
| Watchdog (тишина между чанками) | **30s** (`llm_activity`) | `provider.go` |
| Overall LLM timeout | **300s** (`llm_request`) | `handle_message.go:313` |
| HTTP timeout (compat-провайдеры) | **300s** (`http_client`) на http.Client | `provider.go:160` |
| Max tool-call turns | **30** (на КАЖДОМ вызове) | `provider.go:403,515` |
| reasoning/temperature | `WithConfig({temperature, reasoning:{enabled}})` | `provider.go:394` |
| Ретраи / фолбэк | maxRetries=3; attempts 2–3 → `error_correction_model` | `provider.go` |
| RAG vector-поиск | **scoped по user_id** (`WHERE user_id`) | `memory_repository.go:136` |
| Эмбеддинг при save | **синхронно**; провал → save без вектора, skip dedup | `extract_memories.go:176` |
| previousSkills роутера | из `Skill` model-сообщений, newest-first | `skill_service.go:149` |
| subscription_plans | free(15,3) / pro(50,5) / admin(100,10) — сид | migrations 00013–00017 |

**Учтённые расхождения с Go (из §10 ROADMAP):**
- Авто-извлечения памяти из диалога в Go НЕТ → в TS тоже нет (только `remember` + онбординг).
- Мёртвый конфиг `agent.rag.enabled` / `agent.memory_extraction.*` не переносим; `rag.top_k` делаем реально работающим.
- MCP-сервер `memory` (knowledge-graph) не переносим — память консолидирована; остаётся только MCP `search`.
- `exec`-инструмент не переносим. Шифрование переписки убираем (`SESSION_*` ключи удалены).
- Таблицы `messages` нет (удалена в Go-миграции 00018) — история переезжает в Mastra Memory.

**Типы libSQL/SQLite (нет DECIMAL/TIMESTAMPTZ/BOOLEAN):** cost → REAL/text; bool → integer 0/1;
timestamps → integer(unixepoch)/text; JSON → text(mode:'json').

---

## Commit Plan
- **Commit 1** (после задач 1–3): `chore(jarvis): scaffold project, deps, libSQL+Mastra bootstrap` (M0)
- **Commit 2** (после задач 4–7, 24): `feat(db): drizzle schema, migrations, vector index, entities + test harness`
- **Commit 3** (после задач 8–11): `feat(config): seed from config.yaml/skills/prompts + SettingsService` (завершает M1)
- **Commit 4** (после задач 12–15): `feat(llm): model factory, stream+watchdog+cost, retries/fallback, strip leaked tool-calls`
- **Commit 5** (после задач 16–17): `feat(llm): embeddings, speech, skill router` (завершает M2)
- **Commit 6** (после задач 18–20): `feat(memory): classifier, sensitivity-filter, MemoryService (RAG/dedup/cap)`
- **Commit 7** (после задач 21–23): `feat(memory): memory tools, profile-extractor, Mastra Memory history` (завершает M3)

---

## Tasks (24)

### Фаза 0 — Каркас проекта (M0)
- [x] **Task 1**: Создать скелет проекта jarvis — `git init`, `package.json` (ESM, Node 22), `tsconfig.json` (TS5, strict), структура папок по §2 ROADMAP, npm-скрипты.
- [x] **Task 2**: Зависимости + `pkg/logger.ts` (pino, `LOG_LEVEL`, **redact секретов**) + `config/env.ts` (zod-валидация секретов) + `.env.example`. *(depends on 1)*
- [x] **Task 3**: `db/client.ts` (libSQL) + `mastra/index.ts` (Mastra: LibSQLStore + LibSQLVector) + `server.ts` (единый процесс-заглушка, `npm run dev` стартует). *(depends on 2)*
<!-- Commit checkpoint: tasks 1-3 -->

### Фаза 1 — БД и настройки (M1)
- [x] **Task 4**: Drizzle-схема `db/schema.ts` — 10 перенесённых таблиц, FK ON DELETE CASCADE, индексы, **типы под SQLite** (REAL/integer/text-json). *(depends on 3)*
- [x] **Task 5**: Drizzle-схема — 4 конфиг-таблицы (settings, models, skills, prompts). *(depends on 3)*
- [x] **Task 24**: Vitest config + **libSQL тест-харнесс** (temp-БД + миграции + фикстуры) — общая инфра для интеграционных тестов 6/11/20. *(depends on 2, 4, 5)*
- [x] **Task 6**: `drizzle.config.ts` + миграции + LibSQLVector индекс `memories_vec` (1024, cosine, **метаданные {memoryId,userId,scope,category}**) + интеграционный тест схемы. *(depends on 4, 5, 24)*
- [x] **Task 7**: `domain/entities.ts` — zod-типы (вкл. `Message.skill?`) + константы-инварианты (0.92 / 50 / 4 / 10 / 1024). *(depends on 3)*
<!-- Commit checkpoint: tasks 4-7, 24 -->
- [x] **Task 8**: `pkg/promptguard.ts` — SanitizeMemoryContent (≤500), SanitizeProfileField, ContainsInjection, ValidateUserMessage + тест. *(depends on 2)*
- [x] **Task 9**: `db/seed.ts` (ч.1) — config.yaml → settings + models + **дефолтные subscription_plans** (free/pro/admin). *(depends on 6, 7)*
- [x] **Task 10**: `db/seed.ts` (ч.2) — skills/*/SKILL.md (19 скилов) → skills; prompts/*.md → prompts. *(depends on 6, 7)*
- [x] **Task 11**: `config/settings.ts` — `SettingsService` (кэш, hot-reload, warn `http_client < llm_request`) + тест. *(depends on 9, 24)*
<!-- Commit checkpoint: tasks 8-11 -->

### Фаза 2 — LLM-слой (M2)
- [x] **Task 12**: `mastra/models.ts` — фабрика `provider:model` (дефолт openrouter) + **HTTP-timeout=http_client для compat-провайдеров** + тест. *(depends on 11)*
- [x] **Task 13**: `mastra/llm.ts` — stream/generate + **temperature/reasoning/maxSteps(30)** + watchdog (30s) + overall timeout (llm_request) + cost. *(depends on 12)*
- [x] **Task 14**: `mastra/llm.ts` — ретраи (maxRetries=3) + фолбэк на `error_correction_model` + buildRetryMessages. *(depends on 13)*
- [x] **Task 15**: `mastra/strip-leaked-tools.ts` — strip утёкших tool-call (inline + XML), паритет stream/non-stream + тесты. *(depends on 13)*
<!-- Commit checkpoint: tasks 12-15 -->
- [x] **Task 16**: `mastra/embeddings.ts` (HTTP к OpenRouter, 1024, батч+fallback) + `mastra/speech.ts` (мультимодал) + тест. *(depends on 11)*
- [x] **Task 17**: `mastra/agents/router.ts` — агент-роутер (structured output zod, 1–4, фолбэк research, форс onboarding) + тест. *(depends on 13, 10)*
<!-- Commit checkpoint: tasks 16-17 -->

### Фаза 3 — Память (M3)
- [ ] **Task 18**: `domain/memory-classifier.ts` — порт permanent/session (полный список русских временных фраз) + тест. *(depends on 7)*
- [ ] **Task 19**: `domain/sensitivity-filter.ts` — порт keyword-фильтра чувствительных тем + тест. *(depends on 7)*
- [x] **Task 20**: `mastra/memory/memory-service.ts` — RAG (**query-эмбеддинг + per-user фильтр**, topK=10) + dedup (0.92, **embed-fail parity**) + cap (50) + scopes + интеграционный тест. *(depends on 6, 16, 18, 19, 24)*
<!-- Commit checkpoint: tasks 18-20 -->
- [x] **Task 21**: `mastra/tools/memory-tools.ts` — remember/forget/list_memories/memory_search (Mastra zod-tools). *(depends on 20, 8)*
- [x] **Task 22**: `mastra/memory/profile-extractor.ts` — онбординг (structured output, порог 4, обновление только пустых полей) + тест. *(depends on 13, 8)*
- [x] **Task 23**: `mastra/memory/history.ts` + `mastra/index.ts` — Mastra Memory (threads/messages, sessions.thread_id, **model-msg metadata `skill`**, max_history=15, без шифрования). *(depends on 6, 11)*
<!-- Commit checkpoint: tasks 21-23 -->

---

## Граф зависимостей (порядок выполнения)
```
M0:  1 → 2 → 3
M1:  3 → {4, 5} ;  {2,4,5} → 24 ;  {4,5,24} → 6 ;  3 → 7 ;  2 → 8
     {6,7} → {9, 10} ;  {9,24} → 11
M2:  11 → 12 → 13 → {14, 15} ;  11 → 16 ;  {13,10} → 17
M3:  7 → {18, 19} ;  {6,16,18,19,24} → 20 ;  {20,8} → 21 ;  {13,8} → 22 ;  {6,11} → 23
```

## Артефакт-результат
По завершении: `jarvis/` запускается единым процессом, конфиг/скилы/промпты/планы читаются из libSQL,
LLM-слой даёт паритет с Go-`LLMAdapter` (стрим, watchdog, ретраи/фолбэк, cost, reasoning/temperature/maxSteps,
embeddings, speech, router), память работает (per-user RAG/dedup/cap, classifier, sensitivity, профиль, история
диалога в Mastra Memory). Готова почва для M4 (скилы→агенты, chat workflow).
