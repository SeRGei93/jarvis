# План: Агент-оркестратор + принятие фич Mastra

**Branch:** `refactor` · **Создан:** 2026-06-17
**Источник:** исследование всей доки Mastra (сессия 2026-06-17) + решение сменить модель поведения.

## Settings

- **Testing:** да — unit-тесты в существующем стиле (vitest + инъекции, без сети).
- **Logging:** verbose — DEBUG через pino child-логгеры; WARN/ERROR на сбоях LLM/таймаутах.
- **Docs:** да — docs-чекпоинт на завершении (через `/aif-docs`).
- **Out of scope (по решению):** трейсинг и observability (Mastra AI tracing, OTEL, Langfuse/Sentry, PinoLogger-замена) — НЕ берём.

## Решения по архитектуре (зафиксированы)

1. **Один динамический агент-оркестратор** заменяет связку Router → N скилов параллельно → Synthesizer. Один голос, без артефактов сшивки, без лишнего LLM-вызова синтеза.
2. **Скилы = прогрессивно подгружаемые инструкции + наборы тулзов** через инструмент `load_skill(name)` + компактный каталог (1 строка на скил: имя + когда применять). Как skills в Claude Code; опирается на существующий `read_skill_reference`/`listReferences`.
3. **Лёгкий пред-проход** выбирает *основной* скил → задаёт модель/температуру хода (из `SKILL.md` основного скила, с учётом `session.model`-override) и предзагружает его. Это **не** старый роутер: он не решает «путь ответа» и ничего не запускает. Общий single-skill кейс работает без единого `load_skill`-вызова; кросс-доменный — агент добирает сам.
4. **Движок — класс `@mastra/core` Agent.** `instructions`/`model`/`tools` — функции от runtime-context, значения тянутся из `SettingsService` на каждом запросе → DI и DB-конфиг сохраняются. Стрим в Telegram — через `agent.stream()`.
5. **Расплаты (приняты):** уходит параллельный запуск скилов и мульти-модель в одном ходу; маршрутизация становится суждением агента (какой скил подгрузить), а не детерминированным `generateObject`. Прикрытие риска — eval-харнесс (Фаза 2, делаем рано).
6. **Scope переезда на `Agent`:** на класс `Agent` переезжает **только оркестратор**. Пред-проход, дедуп (`LlmDedupChecker`), суммаризатор (`LlmSummarizer`), `FactExtractor`, `ProfileExtractor` остаются прямыми `generateObject`/`generateText` на `LlmService`/`ModelFactory`. Историю ведём **вручную** (`getRecentMessages`/`saveAssistant` + rolling summary) — персист сообщений **не** отдаём в `Agent.memory`; `messages` оркестратору собираем сами; `Agent` держим standalone (не регистрируем на инстансе `Mastra`).

## Что НЕ трогаем (сохранить как есть)

- Долгосрочная память: таблица `memories`, load-all, **без RAG/векторов** (M13), `DedupChecker`, sensitivity/`sanitizeMemoryContent`/scope-classifier в `MemoryService.save`.
- Rolling summary (`sessions.summary`) и `FactExtractor` (опционально → Фаза 4 D2).
- promptguard, watchdog (idle 30s / overall 300s), scope-by-userId, rate-limit, onboarding.
- Доменное знание в `SKILL.md` (slugs, шаблоны таблиц, параметры тулзов).
- **Роль модели `synthesizer`** в настройках НЕ удалять — её переиспользует rolling-summary; удаляем только агент-синтез ответа.

---

## Tasks

### Фаза 0 — Спайк / де-риск (строго первым; решает go/no-go)

- [x] **S1. PoC одного Mastra `Agent` с динамикой из `SettingsService`.** Поднять `new Agent({...})` с `instructions`/`model`/`tools` как функциями от runtimeContext. **Пять go/no-go проверок:** (а) конфиг тянется из `SettingsService`, не из конструктора; (б) unit-тест с mock-моделью проходит **без сети**; (в) в `Agent` передаётся инстанс `factory.model(ref)` (это AI-SDK `LanguageModel`, `models.ts:61`) и модель меняется per-request; (г) **`prepareStep`→`activeTools`-гейтинг работает через `agent.stream`** (линчпин `load_skill` — без него прогрессивная загрузка тулзов невозможна); (д) `stripLeakedToolCalls` воспроизводится как output-процессор. Стрим через `agent.stream().textStream` в фейковый sink. *Артефакт: `backend/src/mastra/agents/_spike-orchestrator.ts` + тест. Это GO/NO-GO по решениям №4 и №2.*
- [x] **S2. PoC оффлайн-скорера.** `createScorer({...}).run({input, output})` — детерминированный скорер (например, «выбран ли ожидаемый скил») в vitest **без модели/сети**. Зафиксировать форму результата (`.run()` слабо задокументирован) снапшотом и **запиннить версию `@mastra/core`**. *Артефакт: `backend/test/evals/scorer-smoke.test.ts`.*

### Фаза 1 — Ядро: агент-оркестратор

- [x] **A1. Каталог скилов.** В `SkillService` добавить компактный реестр: для каждого роутируемого скила — `name` + однострочное «когда применять» (из frontmatter `SKILL.md`). Используется в системном промпте оркестратора и для пред-прохода. *Tests: skill-service. Файлы: `services/skill-service.ts`, `backend/skills/*/SKILL.md` (frontmatter).*
- [x] **A2. `load_skill(name)` + механизм активации тулзов.** ⚠️ Одна генерация AI SDK **не может добавить новые тулзы в середине вызова** — наивная «активация bucket'а из тулзы» не сработает. Механизм: на оркестраторе регистрируются **все** тулзы скилов сразу; `load_skill(name)` возвращает полную инструкцию `SKILL.md` + ссылки (`listReferences`) и **добавляет скил в мутабельный set загруженных**; живой набор тулзов гейтится по шагам через AI SDK `prepareStep`→`activeTools`. Карта скил→тулзы — из уже экспортированных name-set'ов (`WEB_TOOL_NAMES`/`CURRENCY_TOOL_NAMES`/`TASK_TOOL_NAMES`/…). *Tests: новый `tools/load-skill.test.ts`. Файлы: `mastra/tools/`, `mastra/tools/registry.ts` (нужен `resolveAllTools`).*
- [x] **A3. Пред-проход выбора основного скила.** Дешёвая классификация (одна `generateObject`-классификация или эвристика по триггерам) → primary skill → задаёт `model`/`temperature` хода (из `SKILL.md`, с учётом `session.model`) и предзагрузку primary в контекст. **Обязательно сохранить из `router.ts`:** форсирование онбординга при `!onboarded` (`router.ts:117` → primary = `onboarding`) и research-fallback (`normalizeRoutedSkills`); переиспользовать `derivePreviousSkills` для непрерывности follow-up'ов. Логику извлечь/перенести **до** удаления `router.ts` в A6. *Tests: новый `agents/primary-skill.test.ts` (вкл. кейс `!onboarded`).*
- [x] **A4. Агент-оркестратор.** Динамический `Agent`: `instructions` = base SOUL/identity (`prompts.soul`/`format`/`integrity`) + каталог (A1) + предзагруженный primary (A3); `tools` = `load_skill` + **все** тулзы скилов, гейтинг через `prepareStep`→`activeTools` (механизм A2); `model`/`temperature` от runtimeContext. Заменяет `runSkillStreaming`/`runSkillSubAgent`. Memories/history/summary прокидываются как сейчас. Watchdog/`maxSteps`/`maxRetries` — выразить опциями Agent + сохранить `AbortSignal`. ⚠️ `maxSteps` поднять выше 30: оркестратор за один цикл делает больше тул-шагов (`load_skill` + тулзы скила); константа больше не залочена. *blockedBy S1, A1, A2, A3. Tests: переписать `skill-agent.test.ts` → `orchestrator.test.ts`.*
- [x] **A5. Переписать `runChat`.** Убрать `router.resolveSkills`, multi-skill `Promise.all` (chat.ts:171-210) и `synthesize`. Один `agent.stream()` → `onText` → Telegram. Сохранить шаги 1-4, 6a-8 (promptguard, ctx, rate-limit, history, memories, usage, save turn, rolling summary, fact-extract, onboarding). `skillTag` = primary skill из A3. *blockedBy A4. Tests: `chat.test.ts` (переписать сценарии single/multi → один путь).*
- [x] **A6. Удалить мёртвый код.** *(удалены `router.ts`+`synthesizer.ts`+тесты, `buildSynthesizerPrompt`, плечо synthesizer в `getCorePrompts`. ⚠️ `skill-agent.ts`/`loop-guard.ts`/`LlmService` ОСТАВЛЕНЫ — их использует admin skill test-run.)* `mastra/agents/router.ts`, `mastra/agents/synthesizer.ts`, multi-skill ветку, `buildSynthesizerPrompt` + `SynthesizerPromptInput` в `prompt-builder.ts`, осиротевший **core-prompt `synthesizer`** (текст) + его плечо в `getCorePrompts`, `SkillRouter` из `ChatDeps`. ⚠️ Различать: **роль модели `synthesizer` НЕ удалять** (`rolling-summary.ts:48` `roles.synthesizer || roles.default`) — удаляется только агент-синтезатор и текст его промпта. Сверить `loop-guard` (был для мульти-скила — нужен ли). *blockedBy A5. Tests: typecheck + прогон.*
- [x] **A7. Композиционный корень + интерфейсы.** `app.ts` `createChatService`: убрать `router`/`loopGuard` из wiring (`app.ts:70,76-90`) и из `ChatDeps`/`ChatService`; подключить оркестратор + пред-проход; обновить doc-комментарий (`app.ts:48-55`, упоминает «router, loop guard»). *blockedBy A5, A6. Tests: typecheck.*
- [x] **A8. Сохранить `stripLeakedToolCalls` на оркестраторе.** *(пост-стрим strip в `orchestrator.run`; тест в `orchestrator.test.ts`.)* Воспроизвести очистку протёкших tool-call'ов (`llm.ts:195` стрим — молча; `llm.ts:212` финал — отбросить) как output-процессор/пост-стрим шаг агента. Модели проекта реально протекают tool-call'ами → без этого регрессия. *blockedBy A4. Tests: orchestrator strip-тест.*

### Фаза 2 — Принять фичи на агенте (нативно), кроме observability

- [x] **B1. Guardrails как процессоры.** Input: Unicode/control-char нормализация (homoglyph/zero-width) **до** injection-regex — встроить в `validateUserMessage` (`pkg/promptguard.ts`), без LLM. Output: PII-редакция (email/phone/card) перед сохранением памяти — усилить `sanitizeMemoryContent`. *Tests: `promptguard` (новый), `memory-service.test.ts`.*
- [x] **B2. Stream-events → статусы.** *(оркестратор на `.fullStream`, `ToolEvents` onStart/onFinish → `streamer.status` «🔎 ищу…»; дебаунс Telegram уже был 250ms.)* Переключить цикл стриминга с `.textStream` на `.fullStream` (AI SDK v6 / Agent); бранч на `tool-call`/`tool-result`/`text-delta`. Расширить `StreamCallback` (`mastra/llm.ts:35`) колбэками `onToolStart(name)`/`onToolFinish` → строки «🔎 ищу… / 💱 конвертирую…» в Telegram-драфт. **Дебаунс** правок Telegram. *Tests: `llm`/стрим-тест с фейковым fullStream.*
- [x] **B3. AbortSignal в тулзы.** *(центральный chokepoint `fetch.ts` + `fetch_url` + currency; вертикали — follow-up.)* Пробросить watchdog-`AbortSignal` в `fetch` веб-тулзов (реальная отмена in-flight HTTP). *(`activeTools`-гейтинг перенесён в A2/A4 — это часть механизма `load_skill`.)* *Tests: web-tools abort.*
- [x] **B4. Eval-харнесс (страховка маршрутизации).** *(`test/evals/`: 15 фикстур, детерминированные скореры primarySkillChoice/keywordCoverage/contentSimilarity, `npm run eval`; nightly LLM-судьи — non-blocking scaffold `nightly.ts`.)* Каталог фикстур + **детерминированные** скореры гейтят PR бесплатно: «выбран правильный primary скил» (по A3), `content-similarity`/`keyword-coverage` для дедупа и саммари. LLM-судьи (`answer-relevancy`/`faithfulness`) — **отдельным non-blocking nightly** джобом, модель через `ModelFactory`. *blockedBy S2, A3. Файлы: `backend/test/evals/*`, npm-скрипт `eval`.*

### Фаза 3 — Новые возможности (фич-драйв)

- [x] **C1. Tool-approval для рискованных тулзов.** *(своя таблица `pending_confirmations` + миграция 0003; `ConfirmationService` (create/listPending/resolve + executor-реестр); `forget`/`task_delete` пишут подтверждение вместо действия; `runChat` отдаёт `confirmations` в `ChatResult`; Telegram inline approve/decline + callbackQuery `cfm:a|d:<id>`. risky-set: forget, task_delete.)* Confirm-before-execute (удаление/трата/отправка): паттерн suspend/resume — durable строка `pending_confirmation` (своя drizzle-таблица, миграция), Telegram inline-кнопки approve/decline, матч следующего входящего. **Свою таблицу, не Mastra-снапшоты** (миграционная дисциплина). *Tests: confirmation-flow. Миграция: да.*
- [x] **C2. Раннер запланированных задач.** *(уже реализовано в M7: `scheduler/executor.ts`+`scheduler.ts`+`wiring.ts`, стартует в `server.ts`; опрашивает активные `cron_tasks` → `ChatService.handleUserMessage` → `notification_chat_id`.)* ⚠️ Таблица `cron_tasks` уже есть (`schema.ts:109`: `scheduled_at`/`is_active`/`notification_chat_id` + индекс `idx_cron_tasks_scheduled`) — **миграция не нужна**. Добавить раннер-петлю (`node-cron`/`setInterval` с инъектируемыми часами) в always-on процессе: опрашивает созревшие активные `cron_tasks` → зовёт `ChatService.handleUserMessage` (`app.ts:36` — заявленная точка входа «for the cron scheduler») → уведомляет в `notification_chat_id`. *Tests: scheduler (инъектируемые часы). Миграция: нет.*
- [ ] ~~**C3. Notification-inbox (новая таблица).**~~ **Свёрнуто в C2 + backlog.** Уведомления по расписанию закрываются `cron_tasks.notification_chat_id` (C2) — отдельная таблица не нужна. Полноценный inbox внешних *ad-hoc* событий (по мотивам `sendNotificationSignal`) вынесен в backlog: нет конкретного источника таких событий сейчас — завести, когда появится реальный триггер.

### Фаза 4 — Watch / позже

- [ ] **D1. Working-memory (schema) для стабильного профиля.** zod-профиль (имя/город/предпочтения/устойчивые инструкции). Запись — **только через `MemoryService.save`** (sensitivity/sanitize/dedup/cap); родной `updateWorkingMemory` не пускать в стор напрямую. Может поглотить часть onboarding-extraction.
- [ ] **D2. Observational Memory (пилот thread-scoped).** Кандидат на замену `sessions.summary` — нативно, **без RAG**. Блокер: resource-scope (кросс-сессия на юзера) experimental + фоновые LLM-вызовы вне бюджета watchdog. Ревизит, когда resource-scope доедет до GA.

---

## Риски и как снимаем

- **Класс Agent владеет циклом/стримом.** → Снимаем спайком S1 (go/no-go). Если DI/тесты-без-сети/стрим не выживают — откат к hand-rolled `LlmService` для оркестратора.
- **DI / тесты без сети.** → Динамический Agent (`instructions`/`model`/`tools` как функции от runtimeContext) + mock-модель в тестах.
- **Таймаут модели у Agent.** → У Mastra нет встроенного таймаута; сохраняем наш `AbortSignal`-watchdog поверх.
- **Маршрутизация теперь — суждение агента.** → B4 (eval-харнесс) делаем рано как регрессионную сетку.
- **Миграционная дисциплина.** → Новая таблица `pending_confirmation` (C1) — в drizzle + `npm run db:generate`; не отдаём схему Mastra-снапшотам. (`cron_tasks` уже существует — миграция под C2 не нужна.)
- **Стоимость хода.** → Старые вызовы (router + synthesizer) сменяются на дешёвый пред-проход (A3) + тул-шаги оркестратора. На single-intent ходах ≈ нейтрально (пред-проход + оркестратор ≈ router + 1 скил); явный выигрыш на мульти-интенте (уходит вызов синтезатора). Не «чистый выигрыш везде».

## Commit Plan

Чекпоинты (conventional commits, перед каждым в `backend/`: `npm run typecheck` + `npm test` зелёные; миграция сгенерирована при изменении схемы; секреты не в коде/логах):

1. **После S1–S2** — `chore(spike): PoC агента-оркестратора и оффлайн-скорера`
2. **После A1–A4** — `feat(agent): каталог скилов, load_skill, пред-проход, агент-оркестратор`
3. **После A5–A8** — `refactor(chat): один агент-оркестратор вместо router+synthesizer`
4. **После B1–B4** — `feat(agent): guardrails-процессоры, stream-статусы, abort в тулзы, eval-харнесс`
5. **После C1–C2** — `feat(agent): tool-approval и раннер запланированных задач`

> Фаза 4 (D1/D2) — отдельными вехами по мере дозревания фич Mastra.
