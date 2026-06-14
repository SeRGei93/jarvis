# План реализации: jarvis — Telegram-бот (Milestone 6)

Branch: `feature/jarvis-telegram-bot-m6`
Created: 2026-06-14 · Refined: 2026-06-14 (`/aif-improve`, верификация по коду M0–M5)
Источник: пункт **Milestone 6** `.ai-factory/ROADMAP.md` («Telegram-бот»)

> Цель: дать готовой диалоговой петле (M0–M5) реальный канал — Telegram-бот на **grammY**.
> Входящие сообщения (текст и голос) попадают в `ChatService.handleUserMessage`, ответ
> стримится обратно троттлингом `editMessageText`, форматируется в Telegram-MarkdownV2 и
> при необходимости режется по лимиту 4096. Плюс slash-команды, голос→speech и `messenger`
> для будущих cron-нотификаций (M7). Референс для порта — Go-проект
> **`/Users/serg/GolandProjects/avocado-ai`** (`internal/infrastructure/telegram`), остаётся
> нетронутым до переключения (M10).

## Структура (monorepo)
Все пути вида `src/...` ниже читаются как **`jarvis/backend/src/...`**. Frontend (Mini App) — M8, не трогаем. Новый код живёт в `src/telegram/` (зарезервировано в `ARCHITECTURE.md`: «[M6] bot, stream, format, voice, messenger»).

## Roadmap Linkage
- **Milestone:** `6. Telegram-бот`
- **Rationale:** план целиком реализует M6 ROADMAP — grammY (polling + опц. webhook), троттлинг-стриминг `editMessageText`, markdown→MarkdownV2, голос→speech, команды и `messenger` для нотификаций. Чат-петля (роутинг, синтез, promptguard, rate-limit, usage, память) уже готова в M0–M5 — M6 только подключает транспорт. Завершение плана закрывает milestone 6.

## Settings
- Testing: **yes** (unit на format/split/stream-throttle/identity/voice-guard/commands; интеграционные на libSQL + фейк grammY-`Api` и фейк `ChatService`/`SpeechService` — без сети)
- Logging: **verbose** (pino, детальные DEBUG; уровень из `LOG_LEVEL`; **токен бота, тела сообщений и транскрипты — НЕ логируем**, `redact`; PII пользователя не пишем)
- Docs: **yes** (обязательный чекпоинт `/aif-docs` при завершении)

## Объём
Покрывается **Milestone 6**:
- **Транспорт grammY** — `Bot(token)`, polling по умолчанию (+ опц. webhook по env), allowlist по `settings.getAllowedUsers()` (пустой список = пускаем всех, неавторизованных молча игнорируем — паритет с Go), single-process (тот же event loop, что health-сервер).
- **Идентичность** — get-or-create `users` + `user_channels` (`provider='telegram'`, `external_id=<tg id>`) на первом контакте; это явно зона Telegram-слоя (см. комментарий в `services/conversation-context.ts`, `loadContext` бросает, если пользователя нет).
- **Стриминг** — throttled `editMessageText` взамен Go-`SendMessageDraft`: курсор ` ▌`, троттл ~1с, guard 3800 символов, guard незакрытой ссылки, финальная отправка полного MarkdownV2 со сплитом.
- **Форматирование** — markdown→Telegram-MarkdownV2 (порт goldmark-логики на `marked`-токенайзере) + разбиение по 4096 рун (окно поиска 500: `\n\n`→`\n`→` `→жёсткий рез); fallback на plain-text при ошибке парсинга.
- **Голос** — скачивание voice (`getFile`+download-link, таймаут), guard 30с, `SpeechService.transcribe(Uint8Array,"audio/ogg")`, далее тот же пайплайн, что и текст.
- **Команды** — `/start /help /new /me /tasks /usage /about /reset_onboarding` (паритет с Go); вспомогательный `startNewSession` (чистит историю треда + session-память).
- **Messenger** — лёгкий интерфейс `sendMessage(chatId,text)` / `sendTyping(chatId)` поверх `bot.api` для нотификаций (потребитель — cron M7); typing-loop с переотправкой каждые 4с.
- **Интеграция** — старт бота в `server.ts` после `createChatService` (best-effort, только при наличии `TELEGRAM_BOT_TOKEN`), `bot.stop()` в `shutdown()`; инстанцирование `SpeechService` и `Messenger`.

**НЕ входит (следующие заходы):**
- **M7** — Cron-планировщик: M6 даёт только `messenger` (интерфейс отправки); фактический запуск задач и нотификации по расписанию — M7.
- **M8** — Админка (Hono-API + Mini App): полноценный webhook-роутинг и admin-эндпоинты. В M6 webhook — минимальный, на node-http health-сервере, по умолчанию выключен (polling).
- **Re-wiring безопасности/лимитов** — `promptguard.validateUserMessage`, rate-limit gate и запись usage **уже внутри** `runChat` (M4–M5). Бот их НЕ дублирует: вызывает `handleUserMessage`, проверяет `result.rejected`, показывает `result.text`.

---

## Ключевые решения и константы (паритет с Go, верифицировано по коду)

| Параметр | Значение | Источник |
|---|---|---|
| Транспорт | grammY, polling по умолчанию | Go: go-telegram/bot, polling |
| Allowlist | `settings.getAllowedUsers()`; пустой = все; неавторизованных молча дропаем | `bot.go::authorize` |
| Курсор стрима | ` ▌` | `stream.go:streamCursor` |
| Троттл стрима | **~1000мс** (`editMessageText`) | ROADMAP §6.2/§10.7 (Go draft = 200мс) |
| Guard длины стрима | **3800** символов (стоп-апдейты до 4096) | `stream.go:streamMaxPlainText` |
| Guard незакрытой ссылки | пропуск чанка при висящем `[` / `](` | `stream.go` |
| Лимит сообщения / окно сплита | **4096** рун / поиск назад **500** | `sender.go`, `split.go` |
| Порядок разбиения | `\n\n` → `\n` → ` ` → жёсткий рез | `split.go` |
| Typing-индикатор | сразу + переотправка каждые **4с** | `sender.go:StartTypingLoop` |
| Голос: max длительность | **30с** | `bot.go:handleVoiceMessage` |
| Голос: download timeout | **60с** | `bot.go:handleVoiceMessage` |
| Голос: MIME | `audio/ogg` | `bot.go:handleVoiceMessage` |
| Команды | `/start /help /new /me /tasks /usage /about /reset_onboarding` | `bot.go`, `commands.go` |
| Ошибка пайплайна | «Произошла ошибка при обработке сообщения. Попробуйте позже.» | `bot.go:sendErrorMessage` |
| Ошибка команды | «Ошибка выполнения команды. Попробуйте позже.» | `commands.go` |

**Расхождения с Go / опоры на готовое (верифицировано по коду M0–M5):**
- **`handleUserMessage(userId, chatId, text, onText?)` → `ChatResult { text, skills, rejected }`** (`app.ts`). Голос НЕ принимает — бот сам транскрибирует и шлёт `text`. `onText: StreamCallback = (accumulatedText) => void` (`mastra/llm.ts`) отдаёт **накопленный** текст, не дельту → стример сам считает дельту (`delta = acc.slice(prev.length)`). *(Task 2, 7)*
- **`SendMessageDraft` (Bot API 9.3) → `editMessageText`** (в grammY черновиков нет). Курсор-черновик уходит (приемлемо, ROADMAP §10.7). Троттл поднимаем 200мс→~1с: правка существующего сообщения у Telegram жёстче лимитируется, чем draft. Возможны 429 — обрабатываем мягко (пропуск/ретрай чанка; опц. `@grammyjs/auto-retry` для финальной отправки, не для каждого тика). *(Task 2)*
- **Безопасность/лимиты/usage уже внутри `runChat`** (`workflows/chat.ts`): `validateUserMessage` (шаг 1), `rateLimit.checkAndConsume` (шаг 2a), `usage.recordUsage` (шаг 6a). При отказе `result.rejected=true`, `result.text` = готовое русское сообщение. Бот НЕ дублирует gate — всегда показывает `result.text`. Если `onText` ни разу не вызван (rejected) — стример просто финализирует `result.text`. *(Task 7)*
- **Идентичность — зона Telegram-слоя.** `loadContext(db, settings, userId, chatId)` бросает, если `users` нет; get-or-create `users`+`user_channels` по комментарию в `conversation-context.ts:28` делает M6. Схема готова (M1): `user_channels {id, userId FK, provider, externalId, createdAt}`, `UNIQUE(provider, externalId)`. Бот: lookup по `(provider='telegram', external_id)` → если нет, insert `users`+`user_channels` → передаёт `users.id` как `userId`. **Новых миграций M6 не требует.** *(Task 3)*
- **`SpeechService` НЕ преднастроен** в `createChatService` — бот инстанцирует сам: `new SpeechService(modelFactory, settings)`, `transcribe(audio: Uint8Array, mimeType): Promise<string>` (`mastra/speech.ts`; роль `roles.speech`→`roles.default`). `ModelFactory` — из `mastra/models.ts`, `settings` — `chatService.deps.settings`. *(Task 4, 8)*
- **`/new` — у Mastra Memory НЕТ delete-API** (проверено: `history.ts` даёт только `createThread`/`saveMessages`/`recall`). Поэтому «очистка истории» = **ротация thread-id** (`rotateThread` пишет свежий `sessions.threadId`; `resolveThreadId` читает его первым → новый ход видит пустой тред, старые `mastra_messages` осиротевшие, но невидимы). Session-память чистим новым `MemoryService.deleteSessionMemories(userId, sessionId)` (строки `scope='session'` **+ векторы**) — в сервисе есть только `delete(userId, memoryId)` одной записи. Долговременные факты не трогаем — паритет с Go `StartNewSession`. *(Task 5)*
- **Стриминг — PLAIN на лету, MarkdownV2 на финале.** `editMessageText` во время стрима без `parse_mode` (сырой markdown LLM при MarkdownV2 почти всегда не парсится), конвертация+`parse_mode:"MarkdownV2"`+сплит — только в `finalize`, с retry без parse_mode при ошибке. *(Task 2)*
- **`/usage` — `getDailyUsage` на ОДНУ дату.** Для N дней добавляем `UsageService.getUsageSince(userId, sinceDate)` (одна агрегирующая выборка вместо 30 вызовов). WELCOME для `/start` — `skills.getPrompt("WELCOME")` (её нет в `getCorePrompts`). *(Task 5)*
- **`TelegramReplyError`** — аналога Go `promptguard.UserMessenger` нет (`validateUserMessage` возвращает объект, не бросает). Заводим маленький `class TelegramReplyError extends Error { userMessage }` для пользовательских ошибок voice/команд; `bot.catch` различает его и generic-ошибку. *(Task 4, 7)*
- **Webhook — минимально в M6.** `server.ts` — голый `node:http` health-сервер; Hono приходит в M8. Реализуем polling полностью; webhook — опц. `webhookCallback(bot,"http")` под env-флагом, без хардненинга. Валидация секрет-токена и полноценный роутинг — `TODO[M8]`. *(Task 8)*
- **`/tasks` и `/usage` — без LLM.** Логика tasks-инструментов живёт в замыканиях `buildTaskTools(ctx)` (не standalone), поэтому команда читает/удаляет `cron_tasks` напрямую через drizzle со скоупом `userId`. `/usage [days]` — через `UsageService.getDailyUsage(userId, date)` по диапазону дат (агрегируем суммой; дефолт 30, max 365). *(Task 5)*
- **grammY уже в зависимостях** (`grammy ^1.43.0`). **Новая npm-зависимость — `marked`** (токенайзер markdown, JS-аналог goldmark; разбор → обход токенов → эмиссия MarkdownV2). Telegram-MarkdownV2-эскейпинг реализуем поверх токенов (grammY не эскейпит за нас). *(Task 1)*
- **`TELEGRAM_BOT_TOKEN` уже в `env.ts`/`.env.example`** (optional, required in prod). Webhook добавляем как опц. env (`TELEGRAM_USE_WEBHOOK`/`TELEGRAM_WEBHOOK_URL`/секрет) — по умолчанию polling. Бот стартует только при наличии токена (best-effort, как `createChatService`). **У репозитория нет git-remote** — это нормально, на план не влияет. *(Task 8)*
- **`server.ts` — точка входа.** `createChatService(...)` уже best-effort заполняет модульный `export let chatService`; `shutdown()` уже зовёт `chatService?.close()`. Бот стартуем после резолва `createChatService`, `bot.stop()` дописываем в тот же `shutdown()`. Один процесс, один event loop, второй порт не нужен. *(Task 8)*
- **Настройки/таймауты** читаем через `settings.getTimeouts()` (`{llm_request, http_client, llm_activity}`, Go-duration строки) + `parseGoDuration(s)→мс`; `settings.refreshIfStale()` для hot-reload allowlist. *(Task 3, 8)*

---

## Commit Plan
- **Commit 1** (задачи 1–2): `feat(telegram): markdown→MarkdownV2 форматтер + троттлинг editMessageText`
- **Commit 2** (задачи 3–4): `feat(telegram): идентичность user/channel + голос→speech`
- **Commit 3** (задачи 5–6): `feat(telegram): команды бота + messenger для нотификаций`
- **Commit 4** (задачи 7–8): `feat(telegram): сборка grammY-бота и старт в едином процессе` (завершает M6)

---

## Tasks (8)

### Фаза 6a — Формат и стриминг (ядро доставки)
- [x] **Task 1**: `telegram/format.ts` — порт markdown→Telegram-MarkdownV2 (новая зависимость `marked`: лексер → обход токенов → эмиссия). Конверсии: `**bold**`→`*bold*`, заголовки→bold, inline/fenced code сохраняем (язык тоже), `[t](url)` с эскейпом скобок url, bare `https://`→кликабельная ссылка, списки→`•`/`1\.` с вложенностью, таблицы→plain с bold-заголовком, blockquote `>`, `~~s~~`→`~s~`, raw HTML — пропускаем, картинки — alt. Эскейп спецсимволов MarkdownV2 на текстовых сегментах; схлопывание `\n\n\n+`→`\n\n`. Экспорт `toTelegramMarkdown(md): string` и `splitMessage(text, limit=4096): string[]` (окно 500: `\n\n`→`\n`→` `→жёсткий рез). Флаг/функция plain-fallback. **Логи:** DEBUG (длина входа/число чанков сплита); без тел сообщений. **Тесты:** unit на каждую конверсию, эскейпинг, сплит на границе и многосегментный.
- [x] **Task 2**: `telegram/stream.ts` — троттл-стример поверх grammY `Api`. `createStreamer(api, chatId)` → `{ onText(accumulated), finalize(fullText) }` + приём stop-typing callback. `onText` диффит дельту из НАКОПЛЕННОГО текста, копит полный. **ВАЖНО: во время стрима шлём PLAIN без `parse_mode`** (сырой markdown LLM при MarkdownV2 почти всегда не парсится — отсюда вечный fallback) + курсор ` ▌`; MarkdownV2 применяется **только** в `finalize`. Правила: первый чанк отправляет сообщение, далее `editMessageText`; троттл ~1000мс (skip если рано или текст не изменился); skip если >3800; skip при висящей незакрытой ссылке (`[`/`](`); стоп typing на первом успешном чанке (через переданный callback). `finalize`: `toTelegramMarkdown`+`splitMessage` с `parse_mode:"MarkdownV2"`, правка первого сообщения без курсора, остальные части — новыми сообщениями; на ошибке парсинга — ретрай того же вызова без `parse_mode` (plain). **Логи:** DEBUG (число edit-тиков, размер финала, число частей), WARN (отказ edit/parse-fallback); тела не логируем. **Тесты:** unit с фейк-`Api` (троттл-пропуски, guard 3800, незакрытая ссылка, дельта из накопленного, финал со сплитом, parse-fallback, стоп typing на первом чанке). *(depends on 1)*
<!-- Commit checkpoint: tasks 1-2 -->

### Фаза 6b — Идентичность, голос, команды
- [x] **Task 3**: `telegram/identity.ts` — `resolveTelegramUser(db, tg: {id, name?, ...}): Promise<{ userId: number; created: boolean }>`: lookup `user_channels` по `(provider='telegram', external_id=String(tg.id))`; если нет — insert `users` (имя из tg) + insert `user_channels` (одной транзакцией, идемпотентно к гонке через `UNIQUE(provider, external_id)`); вернуть `users.id`. Скоуп/идемпотентность обязательны (повторный контакт не плодит строки). Хелпер для hot-reload allowlist: `settings.refreshIfStale()` перед чтением `getAllowedUsers()` в боте. **Логи:** INFO (создан новый пользователь — без PII, только id), DEBUG (резолв существующего). **Тесты:** integration (libSQL) — первый контакт создаёт user+channel, повторный возвращает тот же id, гонка/дубликат не падает.
- [x] **Task 4**: `telegram/voice.ts` — `transcribeVoice(api, speech, fileId, duration, token): Promise<string>`: guard `duration>30` → бросаем `TelegramReplyError` с русским user-message; `api.getFile(fileId)` → строим URL `https://api.telegram.org/file/bot<token>/<file_path>` (**нужен bot-токен**, не только `getFile`) → HTTP GET с таймаутом 60с (AbortController, `fetchFn` инъектируемый) → `Uint8Array`; `speech.transcribe(buf, "audio/ogg")`; пустой/whitespace → `TelegramReplyError` «Не удалось распознать голосовое сообщение.». **Определить общий `class TelegramReplyError extends Error { constructor(public userMessage: string) }`** (в `telegram/`, реюз в commands/`bot.catch`) — аналога Go `promptguard.UserMessenger` в проекте нет. Инстанцирование `SpeechService` — в Task 8. **Логи:** DEBUG (длительность, размер байт — без аудио/транскрипта), WARN (отказ download/транскрипции, >30с). **Тесты:** unit с фейк-`Api`+фейк-`SpeechService`+фейк-fetch: успех, >30с (`TelegramReplyError`), пустой транскрипт, таймаут download.
- [x] **Task 5**: `telegram/commands.ts` + **новые backing-методы в модулях M0–M5** (тесно связаны с командами — проверено: их в коде НЕТ). Обработчики: `/start` (WELCOME через **`deps.skills.getPrompt("WELCOME")`** — её НЕТ в `getCorePrompts`; без LLM), `/help` (статический текст), `/new` (`startNewSession`), `/me` (профиль: `users` + число `user_channels`), `/tasks` (без арг — список `cron_tasks` по `userId`; с `<ID>` — удалить СВОЮ задачу), `/usage [days]` (сумма за N дней, дефолт 30/мах 365), `/about` и `/reset_onboarding`.
  **Новые методы (в коде отсутствуют):**
  - `mastra/memory/history.ts::rotateThread(db, sessionId)` — пишет свежий `sessions.threadId` (напр. `session-${id}-${randomUUID()}`); `resolveThreadId` читает `threadId` первым → следующий ход видит пустой тред (старые `mastra_messages` осиротевшие, но невидимы — **у Mastra Memory delete-API нет**; паритет с Go `StartNewSession`).
  - `mastra/memory/memory-service.ts::deleteSessionMemories(userId, sessionId)` — удалить `memories` со `scope='session'` по сессии **+ их векторы** (как `trimPermanent`); сейчас есть только `delete(userId, memoryId)` одной записи.
  - `services/usage.ts::getUsageSince(userId, sinceDate)` — сумма `{cost,requests}` одним запросом (вместо 30 вызовов `getDailyUsage`, который на ОДНУ дату).
  `startNewSession(deps, userId, chatId)`: найти сессию по `chatId` (drizzle, read-only — НЕ через `loadContext`, чтобы не плодить сессию) → `rotateThread` + `deleteSessionMemories`; долговременные факты не трогаем. `/reset_onboarding`: минимум `users.onboarded=false`, затем «Привет!» через `handleUserMessage`. Команды читают сессию по `chatId` напрямую через drizzle. Ответы форматируются (Task 1) + сплит; единый перехват → `TelegramReplyError`/«Ошибка выполнения команды. Попробуйте позже.». Скоуп `userId` везде. **Логи:** INFO (имя команды + userId, без аргументов-PII), WARN (отказ). **Тесты:** unit/integration (libSQL) — `startNewSession` (ротация `threadId` + удаление session-памяти и векторов, permanent сохранены), `getUsageSince` агрегация, `/tasks` скоуп + запрет удаления чужой; фейк-`ChatService` для `/about`. *(depends on 1, 3)*
<!-- Commit checkpoint: tasks 3-4 ; tasks 5-6 -->

### Фаза 6c — Сборка: bot, messenger, server wiring
- [x] **Task 6**: `telegram/messenger.ts` — `Messenger` поверх `bot.api`: `sendMessage(chatId, text)` (формат Task 1 + сплит + plain-fallback), `sendTyping(chatId)` (`sendChatAction "typing"`), `startTypingLoop(chatId): () => void` (переотправка каждые 4с, возвращает stop). Интерфейс заточен под cron-нотификации M7 (потребитель — позже). **Логи:** DEBUG (chatId, число частей), WARN (отказ отправки). **Тесты:** unit с фейк-`Api`: сплит длинного текста, plain-fallback, старт/стоп typing-loop (фейк-таймер). *(depends on 1)*
- [x] **Task 7**: `telegram/bot.ts` — сборка grammY `Bot`: `authorize`-middleware (allowlist через `settings.getAllowedUsers()` + `refreshIfStale()`, пустой = все, неавторизованных молча `return`); **`bot.api.setMyCommands([...])` на старте** (меню команд — в Go описания брались отсюда); регистрация команд (Task 5); default-handler — `text`→идентичность (Task 3)→`startTypingLoop`→`createStreamer` (Task 2, передать stop-typing callback)→`chatService.handleUserMessage(userId, chatId, text, streamer.onText)`→`streamer.finalize(result.text)`; `voice`→`transcribeVoice` (Task 4)→тот же пайплайн; иначе «Я пока не умею обрабатывать этот тип контента…». Глобальный `bot.catch`: различать `TelegramReplyError` (показать `.userMessage`) и прочее (generic «Произошла ошибка при обработке сообщения. Попробуйте позже.»). Typing: старт loop при приёме, **стоп на первом чанке стрима** (callback в streamer). `start(): polling` / опц. webhook (Task 8). Бот НЕ дублирует gate — всегда показывает `result.text` (rejected тоже); если `onText` ни разу не вызван — `finalize(result.text)`. **Логи:** INFO (старт бота, режим polling/webhook — без токена), DEBUG (тип апдейта, userId), WARN/ERROR (catch). **Тесты:** unit/integration с фейк-`Api`+фейк-`ChatService`+фейк-`SpeechService`: текст→стрим-финал, voice→транскрипт→пайплайн, неавторизованный дропнут, unsupported-контент, `result.rejected` показывает `result.text`, `TelegramReplyError`→`userMessage`. *(depends on 2, 3, 4, 5, 6)*
- [x] **Task 8**: `server.ts` (+ `config/env.ts` webhook-поля, `.env.example`) — в `.then`, где `chatService = svc`: инстанцировать `SpeechService` **явно** — `new SpeechService(new ModelFactory(), svc.deps.settings)` (`ModelFactory` — конструктор без аргументов, как `app.ts:55`; speech НЕ в `deps`); собрать `Bot`+`Messenger` (Task 6, 7) с `svc.deps.db/settings/usage/memoryService`; стартовать бот **только при `TELEGRAM_BOT_TOKEN`** (best-effort: ошибка старта логируется, health-процесс живёт); дописать `bot.stop()` в существующий `shutdown()` (рядом с `chatService?.close()`). **Webhook — минимально:** polling по умолчанию; опц. env `TELEGRAM_USE_WEBHOOK`/`TELEGRAM_WEBHOOK_URL` → `webhookCallback(bot, "http")` смонтировать на существующий `node:http` health-сервер. **Хардненинг / валидация секрет-токена / полноценный роутинг — отложены в M8** (когда появится Hono-сервер); пометить `TODO[M8]`. Обновить `.env.example`. **Логи:** INFO (бот поднят: режим polling/webhook, наличие speech — без секретов), WARN (нет токена → бот не стартует, чат-сервис продолжает). **Тесты:** integration — фейк grammY-апдейт сквозь собранный бот → стримленный ответ (без сети); запуск без токена не роняет процесс. *(depends on 7)*
<!-- Commit checkpoint: tasks 7-8 -->

---

## Граф зависимостей (порядок выполнения)
```
Фаза A:  1 → 2
Фаза B:  3 ;  4 ;  (1,3) → 5        (3,4 независимы; 5 поверх 1+3)
Фаза C:  (1) → 6 ;  {2,3,4,5,6} → 7 → 8
```
Готовое из M0–M5 (зависимости, не задачи): `app.ts::handleUserMessage`/`ChatResult`/`StreamCallback`, `workflows/chat.ts` (promptguard+rate-limit+usage внутри), `services/conversation-context.ts::loadContext`, `mastra/memory/history.ts` (`threadIdForSession`/`resolveThreadId`), `mastra/memory/memory-service.ts` (session-scope), `services/usage.ts::UsageService`, `mastra/speech.ts::SpeechService`, `mastra/models.ts::ModelFactory`, `config/settings.ts` (`getAllowedUsers`/`getTimeouts`/`parseGoDuration`/`refreshIfStale`), `config/env.ts` (`TELEGRAM_BOT_TOKEN`), `db/schema.ts` (`users`/`user_channels`/`sessions`/`cron_tasks`/`memories`), `server.ts` (`chatService`/`shutdown`). Схема БД готова — **новых миграций M6 не требует**. Новая npm-зависимость: `marked` (grammy уже есть).

## Артефакт-результат
По завершении: бот в Telegram отвечает на текст и голос. Текст идёт в `handleUserMessage`, ответ стримится `editMessageText` (троттл ~1с, курсор `▌`), на финале форматируется в MarkdownV2 и режется по 4096; при ошибке парсинга — plain-fallback. Голос (≤30с) скачивается и транскрибируется через `SpeechService`, дальше — тот же пайплайн. Работают команды `/start /help /new /me /tasks /usage /about /reset_onboarding` (скоуп `userId`, без дублирования gate). Новый Telegram-пользователь автоматически заводится в `users`+`user_channels`. Allowlist из настроек отсекает чужих. `messenger` готов под cron-нотификации (M7). Бот живёт в одном процессе с health-сервером, стартует только при наличии токена и корректно останавливается на shutdown. Паритет с Go-ботом (минус draft-курсор, заменённый троттлингом `editMessageText`).
