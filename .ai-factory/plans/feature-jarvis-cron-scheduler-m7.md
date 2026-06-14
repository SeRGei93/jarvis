# План реализации: jarvis — Cron-планировщик (Milestone 7)

Branch: `feature/jarvis-cron-scheduler-m7`
Created: 2026-06-14
Источник: пункт **Milestone 7** `.ai-factory/ROADMAP.md` («Cron-планировщик — node-cron, исполнитель задач, нотификации пользователю»)

> Цель: оживить уже существующую CRUD-инфраструктуру cron-задач (таблица `cron_tasks` из M1,
> инструменты `task_*` из M5) — добавить **исполнитель**, который по расписанию находит готовые
> задачи, прогоняет их `prompt` через тот же chat-пайплайн, что и живой диалог
> (`ChatService.handleUserMessage`), и доставляет результат пользователю через `Messenger` (M6).
> Всё в **едином процессе** (бот + cron + один event loop — зафиксированное решение ROADMAP §2).
> Референс для порта — Go-проект **`/Users/serg/GolandProjects/avocado-ai`**
> (`internal/infrastructure/scheduler/`), остаётся нетронутым до переключения (M10).

## Структура (monorepo)
Все пути вида `src/...` ниже читаются как **`jarvis/backend/src/...`**. Frontend (Mini App) — M8, не трогаем. Новый код живёт в `src/scheduler/` (зарезервировано в `ARCHITECTURE.md`: «scheduler/ [M7]»).

## Roadmap Linkage
- **Milestone:** `7. Cron-планировщик`
- **Rationale:** план целиком реализует M7 ROADMAP — node-cron-исполнитель (poll-модель), запуск задач через chat-пайплайн, нотификации через `Messenger`. CRUD задач (`task_create/list/get/update/delete/toggle`), таблица `cron_tasks` с `notification_chat_id`, валидация расписаний (cron-parser, min 1ч) и интерфейс доставки `Messenger` уже готовы в M1/M5/M6 — M7 добавляет ровно недостающее звено: исполнение по времени. Завершение Task 4 закрывает milestone 7.

## Settings
- Testing: **yes** (unit на чистые правила расписания/нотификации; integration на libSQL temp-DB harness + фейк-`runTask`/фейк-`Notifier` + фиксированный `now` — без сети)
- Logging: **verbose** (pino, детальные DEBUG: тики планировщика, выбор due-задач, запуск; уровень из `LOG_LEVEL`; **тело `prompt`, текст результата, PII и секреты — НЕ логируем**, `redact`)
- Docs: **yes** (обязательный чекпоинт `/aif-docs` при завершении)

## Объём
Покрывается **Milestone 7**:
- **Чистые правила** (`scheduler/schedule.ts`) — предикаты типа задачи (`now`/`once`/recurring), вычисление следующего запуска (cron-parser), due-проверка, `shouldNotify` (маркеры NO_CHANGES/NO_RESULT), константы тиков/порогов.
- **Исполнитель** (`scheduler/executor.ts`) — выборка due-задач из `cron_tasks`, запуск `prompt` через `handleUserMessage` (полный пайплайн: promptguard → контекст → память → роутер → скилы → синтез) с watchdog-таймаутом и panic-guard, запись `last_run_*`, деактивация одноразовых, доставка результата через `Notifier` по `shouldNotify`.
- **Драйвер** (`scheduler/scheduler.ts`) — два node-cron-тика (recurring/`once` — раз в минуту; `now` — раз в 5с), overlap-guard, `start()`/`stop()`.
- **Сборка** (`server.ts`) — старт планировщика в едином процессе после бота (best-effort), `scheduler.stop()` в `shutdown()`.

**НЕ входит (следующие заходы / задокументированные расхождения с Go):**
- **KG-дедуп инструменты** `search_nodes`/`create_entities` для recurring-мониторинга **НЕ портируем** — MCP-сервер `memory` (knowledge-graph) убран (консолидация памяти, ROADMAP §5/§9). Recurring-мониторинг опирается на встроенную память + историю сессии. Маркер `NO_CHANGES` и `shouldNotify` сохраняем.
- **Отдельная синтетическая сессия на задачу** (Go: `chatID = -now.UnixNano()`) **не вводим** — M7 прогоняет задачу против сессии чата `notificationChatId`. Следствие: вывод задачи попадает в основную историю диалога пользователя. Приемлемо для напоминаний/мониторинга; при «зашумлении» — пересмотреть в отдельном заходе.
- **Per-user timezone** в интерпретации cron — не вводим: используем тот же парсер без `tz`, что и `validateSchedule` (серверное время). `users.timezone` существует, но в M5-валидации не используется → паритет сохраняем.
- **M8** — управление расписанием/интервалами из админки (Hono + Mini App). Интервалы тиков в M7 — константы (паритет с Go 60с/5с), без нового ключа настроек.
- **Re-wiring безопасности/лимитов** — `promptguard.validateUserMessage`, rate-limit gate и запись usage **уже внутри** `runChat`. Исполнитель НЕ дублирует их: зовёт `handleUserMessage`, проверяет `result.rejected`.

---

## Ключевые решения и константы (паритет с Go, верифицировано по коду)

| Параметр | Значение | Источник |
|---|---|---|
| Модель планирования | **poll БД**, НЕ регистрация cron-entry на задачу | Go `cron_scheduler.go` (два тикера) |
| Тик recurring + `once` | **раз в минуту** `* * * * *` | Go `"0 * * * * *"` |
| Тик immediate (`now`) | **каждые 5с** `*/5 * * * * *` | Go `"*/5 * * * * *"` |
| Выборка immediate | `is_active AND schedule='now' AND last_run_at IS NULL` | Go `ListPendingImmediateTasks` |
| Выборка scheduled | `is_active AND schedule != 'now'` → фильтр due | Go `ListActiveTasks` + `shouldRunTask` |
| Due recurring | `cronNext(schedule, lastRunAt ?? createdAt) <= now` | Go `schedule.Next(lastRunAt)` |
| Due once | `scheduledAt != null AND scheduledAt <= now` | Go `IsOneTime()` |
| Запуск задачи | `handleUserMessage(userId, notificationChatId, prompt)` — полный пайплайн | Go `TaskExecutor.Execute` (LLM, не статика) |
| Деактивация | `now`/`once` → `is_active=false` **на успехе**; recurring — никогда | Go lifecycle |
| Ретрай при ошибке | `once` остаётся active (повтор каждую минуту); `now` фактически single-shot (last_run_at set) | Go (error оставляет active) |
| Доставка | `Notifier.sendMessage(notificationChatId, result.text)` | Go `messenger.SendMessage` |
| Подавление нотификации | `shouldNotify`: immediate всегда; recurring/once — нет, если пусто/<20 симв./маркер NO_CHANGES | Go `ShouldNotify` |
| Порог короткого результата | **20** символов | Go `entity/cron_task.go` |
| Min интервал cron | **1ч** — валидируется при СОЗДАНИИ (M5, `tools/tasks.ts:25` priv); планировщик не перепроверяет | Go `validateMinimumInterval` |
| Watchdog на задачу | лёгкий backstop `llm_request + 30с` поверх внутренних таймаутов `runChat` (`llm_request` 300с + `llm_activity` 30с) | Go outer 3мин / inner 120с |
| Overlap-guard тика | нативный **node-cron `noOverlap: true`** (v4) — ручной флаг не нужен | усиление над Go |
| Дедуп задачи | task-в-полёте пропускается (`Set` в executor) | усиление над Go |

**Расхождения с Go / опоры на готовое (верифицировано по коду M1/M5/M6):**
- **Таблица `cron_tasks` готова (M1).** Колонки: `id, user_id, session_id, name, description, prompt, skill_name, schedule, scheduled_at, is_active, last_run_at, last_run_status, last_run_error, notification_chat_id, created_at, updated_at` (`db/schema.ts:104`). Индексы `user/session/active/scheduled`. **Нет `next_run_at`** — due вычисляем на лету из `schedule` + `last_run_at`/`scheduled_at`. **Новых миграций M7 не требует.** *(Task 1, 2)*
- **Три режима в поле `schedule`** (паритет с M5 `validateSchedule`, `tools/tasks.ts:37`): `"now"` (immediate), `"once"` (+ `scheduled_at`), иначе 5-польный cron. Валидация при создании уже есть (cron-parser, min 1ч). *(Task 1)*
- **`notification_chat_id` уже заполняется** при создании задачи (`tools/tasks.ts:204`, `= ctx.chatId`). Это точный Telegram chat_id для доставки — **JOIN не нужен**. Если `null` (старые/битые) — пропуск + WARN (паритет Go). *(Task 2)*
- **`handleUserMessage(userId, chatId, text, onText?)` → `ChatResult { text, skills, rejected }`** (`app.ts:32`, JSDoc прямо называет cron вторым потребителем: «Single entry point for M6 (Telegram) and the cron scheduler»). Исполнитель зовёт **без `onText`** (стрим не нужен), берёт `result.text`. *(Task 2)*
- **`Messenger.sendMessage(chatId, text)`** (`telegram/messenger.ts:36`) — конвертация в MarkdownV2 + сплит 4096 + plain-fallback уже внутри. Исполнитель видит его как структурный `Notifier { sendMessage(chatId, text) }` (инъекция; Messenger импортируется только в `server.ts`). *(Task 2, 4)*
- **`node-cron@4.2.1` установлен, но не импортирован нигде** (`package.json`). M7 — первый потребитель. API v4 (проверено по `dist/.../scheduled-task.d.ts`): **CommonJS** (`import cron from "node-cron"`), `cron.schedule(expr, fn, opts?)` → `ScheduledTask` (`.start()/.stop()`, авто-старт), 6-польные секунды, **встроенный `noOverlap`** + события `execution:overlap/missed` → ручной overlap-флаг не пишем. `cron-parser@^5.5.0` уже используется в `tools/tasks.ts`. *(Task 3)*
- **Побочки `handleUserMessage` для cron-прогона (проверено по `chat.ts`, осознанная упрощёнка M7 vs отдельный процесс/сессия в Go):** прогон (1) **тратит часовой rate-limit** пользователя (`chat.ts:101`) и пишет usage (`chat.ts:218`) — фоновые задачи делят бюджет с живым чатом; при лимите `result.rejected=true` → задача в error, без нотификации; (2) **пишет синтетические user+assistant в историю** чата `notificationChatId` (`chat.ts:113/225`) — вывод задачи виден в живом диалоге; (3) может **двигать онбординг** к порогу @4 (`chat.ts:233`). Сбой генерации → `FALLBACK_REPLY`, `rejected:false` (`chat.ts:238`) → уйдёт нотификацией. **Риск конкуренции:** `now`-задача может выстрелить (тик 5с) одновременно с живым ходом на той же сессии — в Go этого не было (отдельная сессия). Все пункты — задокументированные ограничения, не блокёры M7. *(Task 2)*
- **`server.ts` — единый процесс.** `createChatService(...).then(svc => { chatService = svc; bot = await startBot(svc) })`; `shutdown()` уже зовёт `bot?.stop()` + `chatService?.close()` + `libsql.close()`. Планировщик стартуем после бота (нужен `bot.api` для `Messenger`), `scheduler.stop()` дописываем в тот же `shutdown()`. Один event loop, второй порт/бинарь не нужен (Go был отдельным `cmd/cron` — расхождение). *(Task 4)*
- **`MONITORING`-промпт** уже сидится (ключ есть среди `SOUL/FORMAT/INTEGRITY/SYNTHESIZER/WELCOME/MONITORING`). Для recurring-задач — преамбула `getMonitoringPrompt()` + `\n\n` + `task.prompt` (конвенция NO_CHANGES без изменения сигнатуры пайплайна). *(Task 2)*
- **`rejected`-результат.** `runChat` сам гейтит promptguard/rate-limit/usage; при отказе `result.rejected=true`. Для фоновой задачи НЕ слать пользователю текст отказа — пишем `last_run_status='error'`, не уведомляем. *(Task 2)*
- **Таймауты** читаем через `settings.getTimeouts()` + `parseGoDuration` (модульный экспорт `config/settings.ts:20`). Watchdog задачи = `llm_request + 30с` (внешний guard поверх внутреннего пайплайна, чтобы не резать легитимные длинные прогоны). *(Task 2)*

---

## Commit Plan
- **Commit 1** (задачи 1–2): `feat(scheduler): правила расписания + исполнитель due-задач через chat-пайплайн`
- **Commit 2** (задачи 3–4): `feat(scheduler): node-cron драйвер и старт в едином процессе` (завершает M7)

---

## Tasks (4)

### Фаза 7a — Чистые правила (фундамент, без IO)
- [x] **Task 1**: `scheduler/schedule.ts` — чистый модуль (без импортов mastra/config/db; cron-parser разрешён). Экспорт: предикаты `isImmediate/isOnce/isRecurring` (по полю `schedule`); `computeNextRun(schedule, from)` через `CronExpressionParser.parse(schedule, { currentDate: from }).next()` (тот же парсер/интерпретация, что `validateSchedule` — без `tz`); `isRecurringDue(t, now)` = `computeNextRun(schedule, lastRunAt ?? createdAt) <= now`; `isOnceDue(t, now)` = `scheduledAt != null && scheduledAt <= now`; `shouldNotify(t, text)` (immediate всегда; иначе false при пустом/`<20`/маркере). Константы: `RECURRING_TICK="* * * * *"`, `IMMEDIATE_TICK="*/5 * * * * *"`, `SHORT_RESULT_MIN_LEN=20`, `NO_CHANGES_MARKERS` (порт EN+RU из `entity/cron_task.go`). Принимать минимальный структурный тип `{ schedule, scheduledAt, lastRunAt, createdAt }` (drizzle-строка `cronTasks` уже в camelCase), не полный zod-`CronTask`. **`MIN_INTERVAL_MS` НЕ переиспользуем** — в `tools/tasks.ts:25` она модуль-приватная (не экспортируется) и M7 не нужна (min-интервал валидируется при создании в M5, планировщик его не перепроверяет). **Логи:** нет (чистый модуль; решения логирует executor). **Тесты:** unit на каждый предикат/`computeNextRun`/due/`shouldNotify` (включая EN- и RU-маркеры, границы).

### Фаза 7b — Исполнитель (IO: db + chat + notifier)
- [x] **Task 2**: `scheduler/executor.ts` — инъектируемые `Notifier { sendMessage(chatId,text) }`, `RunTask = (userId,chatId,text)=>Promise<ChatResult>`, `getMonitoringPrompt`, `deps { db, settings, runTask, notifier, getMonitoringPrompt, logger, now? }`. Экспорт `runImmediateTasks(deps)` (выборка `is_active AND schedule='now' AND last_run_at IS NULL`) и `runScheduledTasks(deps)` (выборка `is_active AND schedule!='now'`, фильтр due через schedule.ts). `executeOne`: пропуск+WARN при `notificationChatId==null`; task-in-flight guard (Set); для recurring — преамбула MONITORING; запуск `runTask(...)` в try/catch (ошибка/исключение не валят планировщик), обёрнутый **лёгким backstop** `Promise.race([runTask, timeout(llm_request+30с)])` — `runChat` уже держит внутренние таймауты (`llm_request` 300с + `llm_activity` 30с, проверено по chat.ts), backstop лишь страхует от непредвиденного зависания (отмены внутреннего прогона нет). **Побочки `runChat` (проверено, документируем):** каждый прогон тратит часовой rate-limit (chat.ts:101) + пишет usage (chat.ts:218), пишет синтетические user+assistant в историю чата `notificationChatId` (chat.ts:113/225), может двигать онбординг к @4 (chat.ts:233). Результат: `result.rejected` (promptguard/rate-limit, chat.ts:93/104) → НЕ слать текст отказа, status='error', не деактивировать; сбой генерации → `FALLBACK_REPLY` при `rejected:false` (chat.ts:238) → трактуем как успех, текст уйдёт нотификацией (приемлемо); иначе success → деактивация `now`/`once`, нотификация при `shouldNotify`; запись `last_run_*` одним update (даже если notify/update упал). **Логи:** DEBUG (N due, запуск id/тип/schedule, длительность), INFO (выполнена id/status/notify), WARN (нет chat_id, отказ notify/update, rejected, таймаут), ERROR (исключение). Без тел prompt/результата/PII/секретов. **Тесты:** integration (libSQL harness + фейк-runTask + фейк-notifier + фикс. now): immediate один раз→deactivate→notify; once до/после `scheduledAt`; recurring due→active+`last_run_at`, сразу повторный тик не due; ошибка runTask→status=error+active; `chat_id=null`→пропуск; `shouldNotify=false`(маркер)→без notify; `rejected`→без notify; watchdog (зависание)→error, планировщик жив; double-run guard. *(depends on 1)*
<!-- Commit checkpoint: tasks 1-2 -->

### Фаза 7c — Драйвер node-cron + жизненный цикл
- [x] **Task 3**: `scheduler/scheduler.ts` — `createScheduler(deps): { start(): void; stop(): void }`. node-cron@4.2.1 (проверено по `dist/.../scheduled-task.d.ts`): пакет **CommonJS** → `import cron from "node-cron"` + `cron.schedule(...)` (NodeNext CJS-interop); `schedule(expr, fn, opts?)` → `ScheduledTask` с `.start()/.stop()` (авто-старт); 6-польный формат с секундами поддержан; есть **встроенный `noOverlap`**. Инъекция `scheduleFn` (дефолт `cron.schedule`) для тестируемости. `start()`: два job — `IMMEDIATE_TICK`→`runImmediateTasks`, `RECURRING_TICK`→`runScheduledTasks`, оба с **`{ noOverlap: true }`** (перехлёст тика того же вида гасит сам node-cron — ручной булев флаг НЕ нужен; per-task дедуп — в executor, Task 2); каждый тик в try/catch (ERROR, не пробрасываем — планировщик не падает из таймера). `stop()`: `.stop()` обоих ScheduledTask + флаг остановки, идемпотентно. **Логи:** INFO (started/stopped, интервалы), DEBUG (tick + длительность), ERROR (исключение тика). **Тесты:** unit (фейк `scheduleFn`): ручной вызов коллбека → соответствующий executor; в options передан `noOverlap: true` и верные cron-строки; исключение тика не пробрасывается; `stop()` зовёт `.stop()` обоих и идемпотентен. (Overlap не тестируем — поведение библиотеки.) *(depends on 1, 2)*

### Фаза 7d — Сборка в едином процессе
- [x] **Task 4**: `server.ts` (+ опц. мелкий экспорт `Messenger`/`bot.api` из `telegram/bot.ts`) — в `.then`, после `bot = await startBot(svc)`: построить `notifier = new Messenger(bot.api)` (или переиспользовать созданный в `bot.ts`); `scheduler = createScheduler({ db: svc.deps.db, settings: svc.deps.settings, notifier, runTask: (u,c,t)=>svc.handleUserMessage(u,c,t), getMonitoringPrompt: ()=>svc.deps.skills.getPrompt("MONITORING"), logger })`; `scheduler.start()` **best-effort** (try/catch, WARN при сбое — health/бот живут); стартовать **только при наличии бота/токена** (нет токена → слать некуда → не поднимаем, WARN). Ссылку `scheduler` — в модульную область. В `shutdown()` дописать `scheduler?.stop()` (рядом с `bot?.stop()`, до `libsql.close()`), идемпотентно. Новых `.env`/миграций НЕ требует. **Логи:** INFO (scheduler up, интервалы), WARN (нет токена→не стартуем), ERROR (сбой старта, процесс жив). Без секретов. **Тесты:** integration (фейк `bot.api` + libSQL harness): посеять одну due-задачу → один scheduled-тик → фейк-notifier получил сообщение в нужный chat_id; старт без задач — no-op; без токена — scheduler не стартует, процесс не падает; `shutdown` зовёт `scheduler.stop()`. *(depends on 3)* — **завершает Milestone 7.**
<!-- Commit checkpoint: tasks 3-4 -->

---

## Граф зависимостей (порядок выполнения)
```
Task 1 (schedule.ts, чистые правила)
   └─> Task 2 (executor.ts: due + запуск + нотификация)
          └─> Task 3 (scheduler.ts: node-cron driver)
                 └─> Task 4 (server.ts wiring) — закрывает M7
```

## Проверка перед коммитом (в `backend/`)
- [ ] `npm run typecheck` чисто
- [ ] `npm test` зелёный (unit + integration по libSQL, без сети)
- [ ] Watchdog/таймаут на запуске каждой задачи; try/catch — планировщик не падает из тика
- [ ] Ошибки логируются (не глотаются); `last_run_error` записан и виден в `/tasks`
- [ ] Новых миграций нет (схема `cron_tasks` готова с M1) — подтвердить
- [ ] Нет секретов/PII/тел prompt/результата в логах
