# План реализации: jarvis — Скилы и chat workflow (Milestone 4)

Branch: `feature/jarvis-skills-chat-workflow-m4`
Created: 2026-06-14 · Refined: 2026-06-14 (`/aif-improve`, верификация по коду M0–M3)
Источник: пункт **Milestone 4** `.ai-factory/ROADMAP.md` («Скилы и воркфлоу»)

> Цель: ввести агентную диалоговую петлю Mastra поверх готового фундамента (M0–M3):
> фабрика skill-agent из БД, сборка системного промпта, синтезатор, **chat workflow** (route → runSkills → synthesize)
> для single- и multi-skill путей, плюс интеграция promptguard на входе. Референс для порта — Go-проект
> **`/Users/serg/GolandProjects/avocado-ai`** (остаётся нетронутым до переключения, M10).

## Структура (monorepo)
Все пути вида `src/...` ниже читаются как **`jarvis/backend/src/...`**. Frontend (Mini App) — M8, в этом заходе не трогаем.

## Roadmap Linkage
- **Milestone:** `4. Скилы и воркфлоу`
- **Rationale:** план целиком реализует M4 ROADMAP — фабрику skill-agent из БД, агент-роутер (уже есть, доинтеграция), синтезатор, chat workflow (single + multi) и promptguard. Завершение плана закрывает milestone 4.

## Settings
- Testing: **yes** (юнит на сборку промпта, роутинг, loop-guard, синтез; интеграционные на chat workflow и history)
- Logging: **verbose** (pino, детальные DEBUG; уровень из `LOG_LEVEL`; секреты — `redact`, PII/тела промптов не логируем)
- Docs: **yes** (обязательный чекпоинт `/aif-docs` при завершении)

## Объём
Покрывается **Milestone 4**:
- **Фабрика skill-agent из БД** — сборка sub-agent/single-skill промпта, резолв модели/temperature/reasoning/tools, запуск через `LlmService`.
- **Сборка системного промпта** — порт `prompt_builder.go` (полный / sub-agent / synthesizer варианты).
- **Синтезатор** — слияние результатов нескольких скилов (модель `synthesizer_model || session.model`, temp 0.3, стрим).
- **Chat workflow** — `route → runSkills → synthesize`, single (прямой стрим) + multi (параллельные суб-агенты → синтез), онбординг-форс и авто-комплит.
- **Интеграция promptguard** — `ValidateUserMessage`/sanitize на входе workflow (сам модуль готов в M0–M3).
- **Сервисный слой** — скилы/промпты из БД, **загрузчик контекста диалога** (User/Session/BotIdentity/threadId), защита от циклов суб-агентов, **полный I/O истории** (чтение/запись сообщений в Mastra Memory + тег скила).

**НЕ входит (следующие заходы):**
- **M5** — реестр реальных инструментов (currency, tasks/cron CRUD, profile-tools, **skill-ref** + данные `references` скилов), MCPClient (сервер `search`). В M4 подключены только **memory-tools** (готовы в M3); остальные имена инструментов в `allowed-tools` дают WARN и пропускаются (tool-resolver — seam под M5). Секция `[SKILL REFERENCES]` в промпте — структурный слот, пустой до M5.
- **M5** — `services/rate-limit.ts` (онбординг-байпас rate-limit учтён заранее, сам лимит — M5).
- **M6** — Telegram-бот; M4 предоставляет точку входа `handleUserMessage(..., onText)` и стрим-seam (`onText`), но потребитель стрима — M6.

---

## Ключевые решения и константы (паритет с Go, верифицировано по коду)

| Параметр | Значение | Источник (Go) |
|---|---|---|
| Loop-guard суб-агента: max повторов | **2** (`maxLoopCount`); 3-й вызов skill+query блокируется | `tools/subagent.go:18` |
| Loop-guard: TTL ключа | **5 мин** (`loopTTL`); ключ = `skill:md5(query)` | `tools/subagent.go:19,150` |
| Temperature суб-агента | `skill.temperature ?? agent.default_temperature` (**0.4**) | `subagent.go:123` |
| Модель суб-агента | `skill.model || roles.default` (**не** session.model) | `subagent.go` |
| Temperature синтезатора | **0.3** (hardcoded), tools = none | `handle_message.go:434,443` |
| Модель синтезатора | `synthesizer_model || session.model` | `handle_message.go:468` |
| Single vs multi | синтез только при `len(skills) > 1`; 0/1 → прямой стрим | `handle_message.go:103` |
| Окно истории для роутера | **6** последних сообщений (`RECENT_MESSAGE_WINDOW`) | router (уже в TS) |
| previousSkills | newest-first из model-сообщений с тегом `skill` | `skill_service.go:150` |
| Порог онбординга | **4** сообщения → авто-комплит + profile-extractor | `entity/user.go:11` |
| maxSteps (tool-turns) | **30** на каждый вызов | `provider.go:403,515` (в `llm.ts`) |

**Порядок секций системного промпта (полный, single-skill):**
`security(const)` → `SOUL`/override личности → `[CAPABILITIES]`(если кастомные botName/vibe) → `[USER CONTEXT]`(если есть name/city/timezone/language) → `[KNOWLEDGE ABOUT USER]`(memories из RAG, если непусто) → `[DATA INTEGRITY]`(**только если у скила есть tools**) → `[SKILL: name]` тело → `[SKILL REFERENCES]`(пусто до M5) → `[MESSAGE FORMATTING]`(FORMAT) → `[CURRENT DATE & TIME]`(tz пользователя, fallback UTC).

- **Sub-agent промпт** — урезанный: `security → USER CONTEXT → memories → INTEGRITY(если tools) → SKILL → refs → DATE/TIME`. **Без** SOUL/CAPABILITIES/FORMAT.
- **Synthesizer промпт** — `security → SOUL/override → CAPABILITIES → user context → memories → [SYNTHESIS RULES](SYNTHESIZER) → FORMAT → [SKILL RESULTS] → DATE/TIME`.

**Учтённые расхождения / опоры на готовое (M0–M3):**
- `router.ts` (SkillRouter: `resolveSkills` с форсом `onboarding`, фолбэком `research`, max 4) — **уже есть**, в M4 только доинтеграция в workflow + подача routable-скилов из skill-service.
- `pkg/promptguard.ts` — **уже есть**; M4 = вызов на входе workflow.
- `profile-extractor.ts` (онбординг, порог 4) — **уже есть**; M4 = вызов из post-processing.
- `stripLeakedToolCalls` живёт **внутри** `LlmService` (прозрачно): non-stream при утечке → hard error + ретрай на `error_correction`; stream → тихий strip. Результаты суб-агентов чистятся до попадания в `[SKILL RESULTS]`.
- Реализация workflow — **плоский async-оркестратор** (`runChat(input, ctx, onText)`), а не обязательная обёртка Mastra `createWorkflow`: это консистентно с уже принятой в проекте идиомой «LlmService напрямую» (как `router.ts`) и необходимо для токенового стрима в Telegram (`onText`-колбэк). Mastra `createWorkflow` можно навесить как обёртку позже без переписывания логики.
- Инструменты подключаются **через closure-контекст** (`buildMemoryTools(mem, userId)` — паттерн M3), не через Mastra runtime context.

**Типы libSQL/SQLite:** bool → integer 0/1; JSON (`allowed_tools`, `metadata`, `settings.value`) → text(mode:'json'). Новых таблиц/миграций в M4 не требуется — схема `skills`/`prompts`/`settings`/`sessions` готова в M1.

**Уточнения после `/aif-improve` (верификация по коду M0–M3):**
- `mastra/memory/history.ts` сейчас содержит ТОЛЬКО `createConversationMemory` + хелперы thread-id (`resourceIdForUser`/`threadIdForSession`/`resolveThreadId`) — **чтения/записи сообщений нет вообще**; весь I/O истории через Mastra Memory строится в Task 7 (и user-, и assistant-сообщения).
- Точка входа RAG-памяти для промпта — `MemoryService.loadRelevant(userId, userMessage): StoredMemory[]` (уже есть, M3). Workflow обязан её вызвать; prompt-builder потребляет `StoredMemory[]` (категории `reflection`/`strategy` → суффикс `(learned <date>)`).
- Секции `SECURITY` среди промптов БД НЕТ (сидятся SOUL/FORMAT/INTEGRITY/SYNTHESIZER/WELCOME/MONITORING) → security-инструкция = hardcoded const, порт из Go `prompt_builder.go:42`.
- `promptguard.validateUserMessage(text)` возвращает `{ok:true} | {ok:false, reason, userMessage}` — при отказе вернуть `userMessage` и НЕ роутить (sanitize самого сообщения нет). В коде помечено `// full guard in M4`.
- Онбординг авто-комплит = готовый `ProfileExtractor.applyOnboarding(db, userId, messages)` (extract + merge только пустых полей + `onboarded=true` + upsert `bot_identities`).
- Загрузчик контекста (User/Session/BotIdentity/threadId) ОТСУТСТВУЕТ — добавлен как Task 10; `sessions.model` NOT NULL (дефолт `roles.default` при создании), `bot_identities` nullable до онбординга. Get-or-create пользователя по `user_channels` — M6.
- Composition root сейчас создаёт только `libsql`-клиент; drizzle-`db` (`LibSQLDatabase<typeof schema>`) собирается в Task 9 и пробрасывается во все сервисы; `conversationMemory` в `index.ts` захардкожен `15` → пересобрать из `agent.max_history`.

---

## Commit Plan
- **Commit 1** (после задач 1–4): `feat(skills): skill-service, prompt-builder, tool-resolver, loop-guard`
- **Commit 2** (после задач 5–7, 10): `feat(skills): skill-agent, synthesizer, history I/O, conversation-context`
- **Commit 3** (после задач 8–9): `feat(workflow): chat workflow (single+multi) + composition wiring` (завершает M4)

---

## Tasks (10)

### Фаза 4 — Сервисный слой и сборка промпта
- [x] **Task 1**: `services/skill-service.ts` — `getAllSkills`, `getRoutableSkills` (фильтр routable), `getSkillByName`, `derivePreviousSkills` (newest-first), загрузчик промптов `getPrompt(key)` (SOUL/FORMAT/INTEGRITY/SYNTHESIZER) с кэшем. Unit + integration (libSQL). DEBUG: кол-во routable/всего, miss → WARN.
- [x] **Task 2**: `mastra/agents/prompt-builder.ts` — порт `prompt_builder.go`: `buildSystemPrompt` / `buildSubAgentPrompt` / `buildSynthesizerPrompt` (порядок секций + условное включение, см. Key Decisions). Вход памяти = `StoredMemory[]` (`reflection`/`strategy` → суффикс `(learned <date>)`); security = hardcoded const (порт Go `prompt_builder.go:42`, секции в БД нет). Чистые функции. Unit-тесты на порядок/условия (нет tools→нет INTEGRITY; нет memories→нет KNOWLEDGE; нет identity→нет CAPABILITIES; reflection→learned). DEBUG: список включённых секций (без содержимого/PII). *(depends on 1)*
- [x] **Task 3**: `mastra/tools/registry.ts` — `resolveTools(allowedTools, ctx)`: подключает memory-tools; неизвестные имена → WARN + пропуск (seam под M5). Unit. DEBUG: итоговый набор tools на скил; WARN на каждый недоступный.
- [x] **Task 4**: `mastra/agents/loop-guard.ts` — порт `subagent.go` (maxLoopCount=2, TTL=5мин, ключ `skill:md5(query)`); 3-й вызов → ошибка. Unit (fake timers). DEBUG инкремент, WARN блок.
<!-- Commit checkpoint: tasks 1-4 -->

### Фаза 4 — Агенты, история, контекст
- [x] **Task 5**: `mastra/agents/skill-agent.ts` — `runSkillAgent`: резолв модели (`skill.model||roles.default`), temperature (`?? 0.4`), reasoning, tools (registry); sub-agent промпт для multi / полный для single; `llm.generate` (суб-агент) либо `llm.stream` (прямой single); loop-guard перед суб-агентом. Unit с фейковым LlmService. DEBUG: имя/модель/temp/tools, длительность/cost. *(depends on 2, 3, 4)*
- [x] **Task 6**: `mastra/agents/synthesizer.ts` — `synthesize(skillResults, ctx, {onText})`: модель `synthesizer_model||session.model`, temp 0.3, без tools, `buildSynthesizerPrompt`, стрим. Unit (фолбэк модели, сборка `[SKILL RESULTS]`). DEBUG источник модели, число скилов. *(depends on 2)*
- [x] **Task 7**: `mastra/memory/history.ts` (полный I/O) — в файле сейчас НЕТ чтения/записи сообщений. Добавить `ensureThread`, `saveUserMessage`, `saveAssistant(...,skill)` (skill в metadata), `getRecentMessages(...): Message[]` с заполненным `skill` (limit=max_history). Plaintext. Integration (libSQL): сохранить user+assistant(skill), прочитать и проверить metadata.skill и порядок. DEBUG запись/чтение.
- [x] **Task 10**: `services/conversation-context.ts` — `loadContext(db, settings, userId, chatId)`: User по id; get-or-create `Session` по `chatId` (model=`roles.default`, NOT NULL); `BotIdentity` (nullable); `resolveThreadId` + `resourceIdForUser`. Get-or-create user по `user_channels` — M6. Integration (libSQL): создание сессии, дефолт model, идемпотентность. DEBUG ids/наличие identity; INFO при создании сессии.
<!-- Commit checkpoint: tasks 5-7, 10 -->

### Фаза 4 — Chat workflow и сборка
- [x] **Task 8**: `mastra/workflows/chat.ts` — `runChat(input, ctx, onText)`: (1) `validateUserMessage` → при `ok:false` вернуть `userMessage`, не роутить; (2) `loadContext` (Task 10); (3) `memoryService.loadRelevant` → `[KNOWLEDGE]`; (4) `getRecentMessages` + `derivePreviousSkills`, `saveUserMessage`; (5) онбординг-форс / `router.resolveSkills`; (6) single → `runSkillAgent` прямой стрим / multi → суб-агенты (loop-guard, Promise.all) → `synthesize` стрим; (7) `saveAssistant(...,skill)`; (8) авто-комплит `profileExtractor.applyOnboarding(db,userId,allMessages)`. Integration с фейковыми LLM (single/multi/онбординг/guard-отказ). DEBUG на каждом шаге. *(depends on 1, 5, 6, 7, 10)*
- [x] **Task 9**: `server.ts` / `mastra/index.ts` — composition root: собрать drizzle-`db` (`LibSQLDatabase<typeof schema>`) поверх `libsql` и пробросить в сервисы; `conversationMemory` из `settings.agent.max_history` (сейчас захардкожено 15); конструкция ChatService со всеми зависимостями; экспорт точки входа `handleUserMessage(userId, chatId, text, onText)` для M6. Smoke/integration на libSQL. INFO о готовности ChatService (кол-во скилов, активные роли — без секретов). *(depends on 8)*
<!-- Commit checkpoint: tasks 8-9 -->

---

## Граф зависимостей (порядок выполнения)
```
Фаза A:  1 → 2 ;  3 ;  4                 (1,3,4 — независимы; 2 зависит от 1)
Фаза B:  {2,3,4} → 5 ;  2 → 6 ;  7 ;  10 (7 и 10 — независимы)
Фаза C:  {1,5,6,7,10} → 8 → 9
```
Готовое из M0–M3 (зависимости, но не задачи): `router.ts`, `llm.ts`, `models.ts`, `settings.ts`,
`promptguard.ts`, `memory-tools.ts`, `memory-service.ts`, `profile-extractor.ts`, `history.ts`, `mastra/index.ts`.

## Артефакт-результат
По завершении: входящее сообщение пользователя проходит promptguard → роутер выбирает 1–4 скила (или форс
`onboarding`) → single-скил стримится напрямую с полным системным промптом, multi-скил исполняется параллельными
суб-агентами и сводится синтезатором → ответ тегируется скилом и пишется в Mastra Memory; онбординг авто-завершается
на 4-м сообщении через profile-extractor. Паритет с Go-петлёй `HandleMessage` (минус реальные инструменты/skill-ref —
это M5). Готова точка входа `handleUserMessage(..., onText)` под Telegram (M6).
