# Implementation Plan: Входящие изображения (vision) в Telegram-боте

Branch: feature/telegram-image-vision
Created: 2026-11-06

## Settings
- Testing: yes
- Logging: verbose
- Docs: yes (обязательный docs-чекпойнт в конце)

## Roadmap Linkage
Milestone: "none"
Rationale: Skipped by user.

## Research Context
Source: `.ai-factory/RESEARCH.md` (Active Summary)

Активный summary в RESEARCH.md относится к другому бэклогу (надёжность агента / news / промпты) и для этой фичи не используется. Из него берутся только общие стек-инварианты, релевантные реализации:

- ESM/NodeNext — относительные импорты с `.js`.
- Всё внешнее инъектируется (`fetchFn`, `SettingsService`, `ModelFactory`, часы) → unit-тесты без сети.
- На каждый LLM/HTTP-вызов — timeout/watchdog; ошибки не должны ломать ход.
- Без секретов в логах; `file_id`/URL с токеном бота не логировать.

## Design Decisions

1. **Один мультимодальный контракт до агента.** `handleUserMessage` получает необязательный `images: ImageInput[]`; оркестратор собирает AI SDK `ImagePart` (`{ type: "image", image: Uint8Array, mediaType }`). Никаких отдельных vision-агентов.
2. **Байты — на диск, ссылки — в историю.** В `mastra_messages.content.metadata.images` хранятся только `{ id, mediaType, width?, height? }`. `getRecentMessages` читает весь тред на каждом ходу, поэтому base64 в истории недопустим.
3. **Re-attach ограничен.** В контекст повторно попадают картинки только из последних `VISION_HISTORY_USER_MESSAGES = 2` user-сообщений, максимум `VISION_HISTORY_MAX_IMAGES = 4` картинки и `VISION_HISTORY_MAX_BYTES = 12 MB`. Это закрывает follow-up «а что на фото?», не раздувая стоимость каждого хода.
4. **Роль `vision`.** При наличии картинок модель хода = `roles.vision || session.model || skill.model || roles.default`. Если каталог OpenRouter уже загружен и достоверно говорит, что модель не принимает `image`, — понятный отказ до вызова модели (не после). Холодный каталог никогда не блокирует.
5. **Image-only сообщение.** Пустая подпись заменяется внутренним плейсхолдером `[изображение]` (нужен pre-pass'у, summary, onboarding и истории). Promptguard для пустого текста не вызывается; rate limit применяется как обычно.
6. **Telegram-скоуп.** `message:photo` (берём самый крупный размер ≤ 10 MB) + `message:document` с `image/jpeg|png|webp|gif` + `message:animation` с `image/gif` (обычные GIF приходят как animation, а не document). Альбомы (media groups) не агрегируются: каждое фото обрабатывается как отдельное сообщение. HEIC/AVIF и прочее — дружелюбный отказ без скачивания файла.
7. **Ретеншн.** Файлы старше 7 дней удаляются best-effort на старте процесса (`MEDIA_RETENTION_DAYS`). `/new` медиа не чистит — это делает prune.
8. **Безопасность.** Картинка — untrusted-ввод: она не исполняется, но текст на картинке может быть prompt-injection. Пользователь — доверенный (личный бот), поэтому отдельного OCR-фильтра не добавляем; фиксируем риск в доках. Файлы лежат локально в `MEDIA_DIR`, имя = sha256, path-traversal исключён строгим regex на id.

## Commit Plan
- **Commit 1** (after tasks 1–2): `feat(media): add file-backed image store and Telegram image downloader`
- **Commit 2** (after tasks 3–5): `feat(chat): carry images through the chat pipeline into the orchestrator`
- **Commit 3** (after tasks 6–7): `feat(models): add vision model role and image-capability detection`
- **Commit 4** (after tasks 8–9): `feat(telegram): handle photos and image documents`
- **Commit 5** (after task 10): `docs: document inbound image support`

## Tasks

### Phase 1: Медиа-фундамент

- [ ] **Task 1: `MEDIA_DIR` + `MediaService` (файловый store картинок)**
  - **Files:** `backend/src/config/env.ts`, `backend/src/domain/entities.ts`, `backend/src/services/media-service.ts` (new), `backend/test/services/media-service.test.ts` (new), `backend/.env.example`.
  - **Что сделать:**
    - В `env.ts` добавить `MEDIA_DIR: z.string().min(1).default("./data/media")` рядом с `SKILLS_DIR`/`PROMPTS_DIR`; в `backend/.env.example` — строку `MEDIA_DIR=./data/media` с комментарием.
    - В `domain/entities.ts` объявить `StoredImageRef = z.object({ id, mediaType, width?, height? })` + тип (единый источник правды; `media-service` импортирует тип оттуда, дубликата не создавать). **Здесь же** добавить в `Message` поле `images: z.array(StoredImageRef).optional()` — `hydrate` читает его уже в этой задаче, поэтому объявление не переносится в Task 3.
    - Создать `services/media-service.ts`:
      - Типы: `ImageInput { data: Uint8Array; mediaType: string; width?: number; height?: number }`, `LoadedImage { data: Uint8Array; mediaType: string }`, `AgentMessage { role: MessageRole; text: string; images?: LoadedImage[] }` (+ импорт `StoredImageRef` из `domain/entities`).
      - Константы: `MAX_IMAGE_BYTES = 10 * 1024 * 1024`, `MAX_IMAGES_PER_TURN = 4`, `SUPPORTED_IMAGE_MIMES` (`image/jpeg`, `image/png`, `image/webp`, `image/gif`), `VISION_HISTORY_USER_MESSAGES = 2`, `VISION_HISTORY_MAX_IMAGES = 4`, `VISION_HISTORY_MAX_BYTES = 12 * 1024 * 1024`, `MEDIA_RETENTION_DAYS = 7`, `MEDIA_ID_RE = /^[a-f0-9]{64}\.(jpg|png|webp|gif)$/`.
      - `class MediaService { constructor(opts?: { dir?: string; now?: () => number }) }` — `dir` по умолчанию `env.MEDIA_DIR` (инъекция для тестов).
      - `save(input: ImageInput): Promise<StoredImageRef>` — sha256 от байтов, расширение по mime, путь `dir/<hash[0..2]>/<hash>.<ext>`; `mkdir -p`; запись атомарная (`*.tmp` + `rename`). Если файл уже есть — dedupe (не перезаписывать), но **обновить mtime** через `utimes(path, now)`: иначе `prune` удалит только что повторно отправленную старую картинку.
      - `saveMany(inputs: ImageInput[], max = MAX_IMAGES_PER_TURN): Promise<StoredImageRef[]>` — отсечь лишние с `warn`, сохранить последовательно, вернуть refs в исходном порядке. Ошибку I/O одного файла ловить, `warn` и продолжать: один сбой диска не должен срывать весь ход. Возвращаются только успешно сохранённые refs.
      - `load(ref: StoredImageRef): Promise<LoadedImage | null>` — валидировать `id` через `MEDIA_ID_RE`, читать по shard-пути `dir/<id.slice(0,2)>/<id>` (именно так пишет `save`), best-effort, `null` + `warn`, если файла нет.
      - `hydrate(messages: Message[], opts?: { maxMessages?: number; maxImages?: number; maxBytes?: number }): Promise<AgentMessage[]>` — пройти с конца, собрать картинки только из user-сообщений (не более 2 сообщений), уложиться в лимиты, вернуть сообщения с `images`; порядок сохранить хронологическим. Перед чтением проверять `stat.size`: файл, который не влезает в оставшийся `maxBytes`, пропускать без чтения.
      - `prune(maxAgeDays = MEDIA_RETENTION_DAYS): Promise<number>` — рекурсивный обход `dir`, удалить файлы старше порога по `mtime`; никогда не бросать наружу.
    - Не импортировать `content/*` и `db/*`: сервис зависит только от `config/env`, `domain/entities`, `pkg/logger`.
  - **Logging (verbose):** `debug` на save (hash prefix, bytes, mediaType), dedupe-hit; `debug` на load miss; `info` на prune (`{deleted, ms, dir}`); `warn` на любую ошибку I/O и prune. `dir` логировать можно, содержимое — нет.
  - **Tests:** round-trip save→load; dedupe одного sha256; dedupe обновляет `mtime` (старый файл после повторного `save` переживает `prune`); `saveMany` продолжает после ошибки одного файла; отказ `load` на `../../etc/passwd` и на невалидный id; prune удаляет старый файл и не трогает свежий; `hydrate` берёт только последние 2 user-сообщения, соблюдает кап по числу и байтам, не читает файл, превышающий остаток бюджета, сохраняет порядок; `save` не пишет при превышении `MAX_IMAGE_BYTES`.
  - **Acceptance:** `npm test -- media-service` зелёный; временная папка создаётся через `mkdtemp` и чистится в `afterEach`.

- [ ] **Task 2: Telegram-загрузчик изображений + общий `fetchTelegramFile`**
  - **Files:** `backend/src/telegram/files.ts` (new), `backend/src/telegram/image.ts` (new), `backend/src/telegram/voice.ts`, `backend/test/telegram/image.test.ts` (new), `backend/test/telegram/voice.test.ts`.
  - **Что сделать:**
    - `files.ts`: вынести из `voice.ts` `FetchLike` и `fetchTelegramFile(api, token, fileId, { fetchFn, timeoutMs, maxBytes }) → { data: Uint8Array; filePath: string }`. Внутри: `api.getFile(fileId)` → проверка `file_path` → `https://api.telegram.org/file/bot<token>/<file_path>` → `AbortSignal.timeout` → проверка `res.ok`, `arrayBuffer().byteLength ≤ maxBytes`. URL с токеном не логировать. Ошибки — `TelegramReplyError` с русским текстом.
    - `voice.ts` перевести на `fetchTelegramFile` (реэкспортировать `FetchLike` из `files.ts`, чтобы не ломать импорты `bot.ts`/тестов), поведение и тексты ошибок сохранить.
    - `image.ts`:
      - `pickLargestPhoto(sizes: { file_id: string; file_size?: number; width: number; height: number }[], maxBytes?)` — самый крупный размер, который влезает в лимит; если все больше — последний (Telegram сам сжимает) и warn.
      - `inferImageMime(filePathOrName?: string, hint?: string)` — по расширению `.jpg/.jpeg/.png/.webp/.gif`; неизвестное → `undefined`.
      - `downloadTelegramImage(api, token, fileId, { fetchFn, mimeHint?, maxBytes? }) → { data: Uint8Array; mediaType: string }` — качает, проверяет mime по белому списку `SUPPORTED_IMAGE_MIMES`, размер.
      - Экспортировать `MAX_IMAGE_BYTES` (или импортировать из `media-service`, чтобы не дублировать; предпочтительно импорт из `services/media-service.ts` — telegram уже зависит от services).
  - **Logging:** `debug` — выбранный размер/bytes/mime; `warn` — отказ по размеру/mime/HTTP, без `file_id` и без URL.
  - **Tests:** выбор самого крупного размера; fallback при отсутствии `file_size`; ошибка `getFile` без `file_path` → `TelegramReplyError`; HTTP 500 и таймаут → `TelegramReplyError`; превышение `maxBytes`; `inferImageMime` для всех поддерживаемых расширений и для `.heic` → `undefined`; voice-тесты остаются зелёными после рефакторинга.
  - **Depends on:** Task 1.
  - **Acceptance:** `npm test -- telegram/image telegram/voice` зелёный.

### Phase 2: Мультимодальный чат-пайплайн

- [ ] **Task 3: Ссылки на изображения в истории**
  - **Files:** `backend/src/mastra/memory/history.ts`, `backend/test/mastra/history.test.ts`.
  - **Что сделать:**
    - `Message.images` уже объявлен в Task 1; здесь только использовать его в persistence. `history.ts::buildDbMessage` принимает `images?: StoredImageRef[]` и пишет их в `content.metadata.images` (рядом с `skill`), `parts` остаются текстовыми; `content` — текст.
    - `saveUserMessage(memory, threadId, resourceId, text, images?)` — расширить сигнатуру (обратная совместимость: параметр опциональный).
    - `extractImages(content)` — читает `content.metadata?.images`, валидирует форму (id/mediaType — строки), игнорирует мусор.
    - `getRecentMessages` заполняет `images` у сообщений; text-only путь не меняется.
  - **Logging:** `debug` при save с картинками `{threadId, role, images: n}`; `warn`, если metadata.images битая (не массив) — но не падать.
  - **Tests:** save user с 2 refs → `getRecentMessages` возвращает те же refs; assistant-сообщение без refs; старые сообщения без metadata читаются как раньше; битая metadata не ломает чтение.
  - **Depends on:** Task 1 (тип `StoredImageRef` и поле `Message.images` уже объявлены в `entities.ts`).
  - **Acceptance:** `npm test -- mastra/history` зелёный.

- [ ] **Task 4: Контракт `handleUserMessage(..., images)` и изменения `runChat`**
  - **Files:** `backend/src/app.ts`, `backend/src/mastra/workflows/chat.ts`, `backend/src/telegram/commands.ts`, `backend/test/mastra/chat.test.ts` (new/extend).
  - **Что сделать:**
    - `ChatService.handleUserMessage(userId, chatId, text, onText?, onTool?, images?: ImageInput[])`; `ChatInput.images?: ImageInput[]`; в `ChatDeps` добавить `media: MediaService`.
    - `app.ts`: `const media = new MediaService();` и положить в `deps`.
    - `commands.ts::ChatHandler` — добавить необязательный 6-й параметр (только тип).
    - `runChat`:
      1. `const hasImages = !!input.images?.length; const textForModel = text.trim() || (hasImages ? "[изображение]" : text)`.
      2. promptguard: валидировать только при непустом `text`; при image-only — пропустить (rate limit остаётся).
      3. Прочитать `recent` (уже есть) и **гидрировать** картинки: `const hydrated = await deps.media.hydrate(recent)`.
      4. Сохранять user-сообщение **после** резолва turn-модели (чтобы отказ по vision не оставлял мусор в истории): `const refs = await deps.media.saveMany(input.images)`; `saveUserMessage(..., textForModel, refs)`. Ошибку `saveMany` ловить (`warn` + `refs = []`): текущие байты всё равно уйдут в модель, ход не должен падать из-за сбоя диска.
      5. В pre-pass передавать `userMessage: textForModel`.
      6. В `orchestrator.run` передать `history: hydrated`, `userMessage: textForModel`, `userImages` — текущие байты из `input.images` (структурно `LoadedImage`; диск повторно не читать; в историю они уже сохранены как refs).
      7. `FactExtractor` / onboarding / `allMessages` используют `textForModel`; `FactExtractor` **не вызывать**, когда исходный `text.trim() === ""` (image-only), иначе в долговременную память попадёт факт про плейсхолдер.
    - В `test/mastra/chat.test.ts` обновить `makeDeps`: `ChatDeps` теперь требует `media`, поэтому создать `MediaService` с временной папкой (`mkdtemp`) и чистить её в `afterEach`; иначе все существующие тесты `runChat` упадут на `deps.media.hydrate`.
  - **Logging:** `info` в начале хода `{userId, hasImages, images: n}`; `debug` — сохранённые refs, гидрированные картинки, плейсхолдер; `warn` — превышение капа, отказ promptguard (как сейчас), ошибка `saveMany`.
  - **Tests:** image-only сообщение доходит до оркестратора с `userMessage = "[изображение]"` и `userImages` длиной 1; caption валидируется promptguard'ом (injection → rejected, модель не вызвана); images сохраняются в историю только при успешном turn-резолве; `hydrate` вызывается и его результат уходит в `history`; сбой `saveMany` не срывает ход; для image-only `FactExtractor` не вызывается; text-only путь не изменился.
  - **Depends on:** Tasks 1, 3.
  - **Acceptance:** `npm test -- mastra/chat` зелёный; `makeDeps` использует temp-dir `MediaService`.

- [ ] **Task 5: Мультимодальные `ModelMessage` в оркестраторе**
  - **Files:** `backend/src/mastra/agents/orchestrator.ts`, `backend/src/mastra/workflows/chat.ts`, `backend/test/mastra/orchestrator.test.ts`.
  - **Что сделать:**
    - В `OrchestratorRunContext`: `history: AgentMessage[]` (из `services/media-service`), `userImages?: LoadedImage[]`.
    - Сборка сообщений: без картинок — строка (как сейчас); с картинками — `content: [{ type: "image", image: img.data, mediaType: img.mediaType }, ..., { type: "text", text }]` (image parts первыми, текст последним — так стабильнее для провайдеров). Для истории — то же самое, если `m.images?.length`.
    - Сохранить `stripLeakedToolCalls`, watchdog, cost, gating — без изменений.
  - **Logging:** `debug` `{model, imageParts: n, messages: n}` на старте; предупреждение, если картинка есть, а модель — не vision (это проверит Task 7, здесь только лог).
  - **Tests:** в `orchestrator.test.ts` через `MockLanguageModelV3` проверить, что в `doStreamCalls.at(-1).prompt` последнее user-сообщение содержит `image` part с `Uint8Array` и `mediaType`, и что text part содержит подпись; text-only ход по-прежнему отправляет строку; история с refs превращается в image parts.
  - **Depends on:** Task 4.
  - **Acceptance:** `npm test -- mastra/orchestrator` зелёный, включая новый тест на image parts.

### Phase 3: Модель и роль `vision`

- [ ] **Task 6: `supportsVision` в каталоге OpenRouter**
  - **Files:** `backend/src/services/models-catalog.ts`, `backend/test/services/models-catalog.test.ts`, `frontend/src/lib/types.ts`.
  - **Что сделать:**
    - В `OpenRouterModel` добавить `architecture?: { input_modalities?: unknown }`.
    - `CatalogRow.supportsVision: boolean` — `true`, если массив `input_modalities` содержит `"image"`. Не забыть добавить `supportsVision: false` во все записи `DECISION_MODELS` (поле обязательное).
    - `toCatalogRow` заполняет флаг (отсутствие `architecture` → `false`).
    - Метод `ModelsCatalog.supportsVision(ref: string): Promise<boolean | undefined>`: **только чтение кэша, без сети**. Добавить cache-only `peekOpenRouterCatalog()` (или `cachedSupportsVision()`), который смотрит на `this.cached` и не вызывает `getOpenRouterCatalog()`/`refresh()`: иначе первый ход с картинкой после рестарта ждёт до 15 с сетевого таймаута. Холодный/просроченный кэш → `undefined` (не блокировать); при желании — фоновый `void getOpenRouterCatalog()` без `await`.
    - Нормализовать ref как `parseModelRef` (`backend/src/mastra/models.ts:17-22`): bare id → openrouter, снять `openrouter:`; если точного id нет — попробовать без последнего `:<suffix>` (например, `:nitro`). Иначе гейт молча не сработает для валидных ролей.
    - Для не-openrouter провайдеров — `undefined`.
    - Frontend `CatalogRow` — добавить `supportsVision: boolean` (для Task 7).
  - **Logging:** `debug` при запросе `supportsVision` (ref, результат); без спама на каждый каталог-запрос.
  - **Tests:** парсинг `architecture.input_modalities` (`["text","image"]` → true, `["text"]` → false, отсутствует → false); `supportsVision()` возвращает `undefined` на холодном кэше **без сетевого вызова**, `false` для известной текстовой модели, `true` для мультимодальной модели из фикстуры; bare-ref и `:nitro` нормализуются; обновить точные ожидания `toCatalogRow` (`toEqual` с полным объектом и `Object.keys(...).sort()`) — иначе тест сломается на новом поле.
  - **Acceptance:** `npm test -- services/models-catalog` зелёный.

- [ ] **Task 7: Роль модели `vision` и гейт возможностей**
  - **Files:** `backend/src/config/settings-keys.ts`, `backend/src/db/seed-data.ts`, `backend/src/mastra/agents/primary-skill.ts`, `backend/src/mastra/workflows/chat.ts`, `backend/src/admin/api/models.ts`, `frontend/src/lib/types.ts`, `frontend/src/screens/ModelsScreen.tsx`, `backend/test/mastra/primary-skill.test.ts`, `backend/test/db/seed.test.ts`, `backend/test/admin/models.test.ts`.
  - **Что сделать:**
    - `ModelRoles` (backend + frontend): `vision?: string`.
    - `resolveTurnConfig(skill, { sessionModel, defaultModel, defaultTemperature, visionModel?, hasImages? })`: при `hasImages` модель = `visionModel?.trim() || sessionModel || skill.model || defaultModel`; иначе как сейчас.
    - `runChat`: `const roles = await deps.settings.getModelRoles()` уже есть; передать `visionModel: roles.vision` и `hasImages`. Если `hasImages`:
      - `const capable = await deps.modelsCatalog.supportsVision(turn.model)`;
      - `capable === false` → `log.warn` + вернуть `{ text: VISION_UNSUPPORTED_REPLY, skills: [], rejected: true }` до сохранения сообщения и вызова модели. `VISION_UNSUPPORTED_REPLY = "Не могу обработать изображение: выбранная модель не поддерживает картинки. Напишите текстом или укажите vision-модель в настройках."`
      - `undefined` (холодный каталог/неизвестный ref) → продолжить.
    - **Дефолт/апгрейд:** добавить `vision` в `SEED_MODEL_ROLES` (`backend/src/db/seed-data.ts`) с каталожно-проверенной мультимодальной моделью (например, `openrouter:google/gemini-3-flash-preview` — проверить `architecture.input_modalities` в живом каталоге). Учесть, что `seedSettings` использует `onConflictDoNothing`: уже засеянные БД роль не получат — добавить в Task 10 явный шаг апгрейда/подсказку в admin. Если сознательно оставляем opt-in, вместо seed задокументировать это и обновить smoke-тест.
    - Admin `models.ts`: добавить `vision` в `ROLE_KEYS`, `rolesSchema`, нормализацию `roles`; при известном каталоге и `supportsVision === false` для роли `vision` — `warnings.push(...)`, не ошибка. Для `undefined` предупреждение не добавлять.
    - Frontend `ModelsScreen.tsx`: поле роли «Изображения (vision)» с описанием («модель для ходов с картинками; пусто = модель хода»), `EMPTY_ROLES.vision = ""`, колонка «Vision» в таблице каталога (✅/—), обновить комментарий «6 slots» → «7 slots».
  - **Logging:** `info` при override `{requested: turnModel, effective: visionModel, role: "vision"}`; `warn` при capability-отказе `{model}`.
  - **Tests:** `resolveTurnConfig` с картинками и пустой/заполненной vision-ролью; без картинок vision игнорируется; `runChat` возвращает `VISION_UNSUPPORTED_REPLY`, если `supportsVision === false`, и не зовёт оркестратор; при `undefined` — продолжает; admin PUT `/roles` принимает `vision` и отдаёт warning для текстовой модели; seed содержит `vision` (или тест явного opt-in); fresh-seed ход с картинкой не отклоняется capability-гейтом.
  - **Depends on:** Tasks 4, 6.
  - **Acceptance:** `npm test -- primary-skill` + admin/seed-тесты зелёные; `cd frontend && npm run build` проходит.

### Phase 4: Telegram-транспорт и wiring

- [ ] **Task 8: Обработчики `message:photo`, `message:document` и `message:animation`**
  - **Files:** `backend/src/telegram/bot.ts`, `backend/test/telegram/bot.test.ts`, `backend/test/telegram/bot-integration.test.ts`.
  - **Что сделать:**
    - `processImage(rt, tgUser, chatId, source: { kind: "photo"; sizes } | { kind: "document"; fileId; mimeType?; fileName?; fileSize? }, caption, draftId)`:
      - `resolveTelegramUser` → **сразу включить typing loop** (download может занять секунды, как в `processVoice`) → проверить MIME/размер по hint'у → `downloadTelegramImage` (Task 2) → остановить typing → `chat.handleUserMessage(userId, chatId, caption.trim(), onText, onTool, [{ data, mediaType }])` → finalize через существующий `streamReply` (расширить `streamReply` необязательным `images`).
      - Для `document` проверять `mime_type`/`file_name`/`file_size` **до** скачивания: поддерживаемые `image/jpeg|png|webp|gif` → качать; `image/heic`, `image/avif` и прочие `image/*` → дружелюбный отказ без загрузки; файл больше `MAX_IMAGE_BYTES` → отказ без загрузки.
    - `bot.on("message:photo")`: `ctx.message.photo`, caption `ctx.message.caption ?? ""`, `update_id` как draftId, затем `sendConfirmations`.
    - `bot.on("message:document")`: если `mime_type`/`file_name` даёт поддерживаемый image-MIME → `processImage`; если `image/*`, но не поддерживается → `UNSUPPORTED_IMAGE_REPLY`; иначе — `UNSUPPORTED_REPLY` (не проваливаться в общий `bot.on("message")`, чтобы не отправить два ответа).
    - `bot.on("message:animation")`: Telegram присылает обычные GIF как `animation`, а не `document`; обрабатывать `image/gif` через `processImage`, остальные анимации — `UNSUPPORTED_REPLY`. Зарегистрировать до общего `bot.on("message")`.
    - `UNSUPPORTED_REPLY`: «Я пока не умею обрабатывать этот тип контента. Отправьте текстовое сообщение, голосовое или фото.»; `UNSUPPORTED_IMAGE_REPLY`: «Этот формат изображения не поддерживается. Отправьте JPEG, PNG, WebP или GIF.»
    - Ошибки скачивания — `TelegramReplyError`, их ловит `bot.catch` (как voice).
  - **Logging:** `info` `{tgUser, kind, bytes, mediaType}` без `file_id`; `warn` на отказ/ошибку скачивания; `debug` — caption length.
  - **Tests:** фото → `handleUserMessage` получает 6-й аргумент с `Uint8Array` и `image/jpeg`, caption прокинут; фото без caption → `""`; image-документ (`image/png`) → картинка; `application/pdf` → `UNSUPPORTED_REPLY`; `image/heic` → `UNSUPPORTED_IMAGE_REPLY` **без** `getFile`/download; `message:animation` с `image/gif` → картинка; ошибка `getFile` → `TelegramReplyError` (не generic); photo-update через `bot.handleUpdate` доходит до `ChatHandler` (bot-integration, middleware/ordering); существующие voice/text тесты не сломаны.
  - **Depends on:** Tasks 2, 4.
  - **Acceptance:** `npm test -- telegram/bot` зелёный.

- [ ] **Task 9: Composition root, boot-prune, деплой-обвязка**
  - **Files:** `backend/src/server.ts`, `docker-compose.yaml`, `.env.example`, `backend/.env.example`, `docs/deployment.md`.
  - **Что сделать:**
    - `server.ts`: после инициализации чата вызвать `void media.prune().catch(...)` (или через `ChatService.deps.media`) — best-effort, не блокирует старт; `info` с количеством удалённых файлов.
    - `docker-compose.yaml`: `MEDIA_DIR: /data/media`; обновить комментарий про persistent volume (`./data/db/media`).
    - `.env.example` / `backend/.env.example`: `MEDIA_DIR` с дефолтом и пояснением (7-дневный ретеншн).
    - `docs/deployment.md`: добавить `media/` в раскладку `./data`.
  - **Logging:** `info` старт prune `{dir, retentionDays}` и результат; `warn` на ошибку prune.
  - **Tests:** нет новых unit-тестов (prune покрыт Task 1); проверить, что `server.ts` не падает без `TELEGRAM_BOT_TOKEN` (существующее поведение).
  - **Depends on:** Tasks 1, 4.
  - **Acceptance:** `npm run typecheck`; `docker compose config` валиден (если доступен docker).

### Phase 5: Документация

- [ ] **Task 10: Документация (обязательный чекпойнт)**
  - **Files:** `docs/telegram.md`, `docs/chat-pipeline.md`, `docs/configuration.md`, `docs/architecture.md`, `docs/admin.md`, `AGENTS.md`, `README.md`, `docs/deployment.md` (если не закрыто в Task 9).
  - **Что сделать:**
    - `docs/telegram.md`: в «Message flow» — Photo, Image document и GIF/animation; лимиты (10 MB, mime-список, альбомы = отдельные сообщения); обновить строку «Other» (бот теперь принимает и фото); в «File map» — `image.ts`, `files.ts`, `services/media-service.ts`.
    - `docs/chat-pipeline.md`: обновить сигнатуру `handleUserMessage` (6-й аргумент `images`); шаг 1 — promptguard пропускается для image-only; шаг 3/4 — `textForModel` плейсхолдер, `saveUserMessage` после резолва модели; новый раздел «Images (vision)»: путь байтов, история-refs, re-attach-капы, роль `vision`, capability-гейт, стоимость/лимиты.
    - `docs/configuration.md`: строка `MEDIA_DIR` в env-таблице; `vision` в форме `model_roles`; пункт про `model_roles.vision` в списке влияния на пайплайн; шаг апгрейда для уже засеянных БД (роль `vision` не появляется из-за `onConflictDoNothing`).
    - `docs/architecture.md`: `services/media-service` в layout; в dependency rules — `telegram → services`, `mastra/workflows → services/media-service`.
    - `docs/admin.md`: «Models (6 role slots)» → 7, описание роли vision и колонки Vision в каталоге.
    - `README.md`: в описании Telegram-бота — фото и image-документы (строки со списком возможностей и таблицей документации).
    - `AGENTS.md`: строки структуры (`telegram` — image/files; `services` — media-service) и docs-таблица (telegram/chat-pipeline уже есть — проверить формулировки).
    - Никаких изменений ROADMAP (по решению пользователя).
  - **Logging:** только документация.
  - **Depends on:** Tasks 1–9.
  - **Acceptance:** все перечисленные файлы обновлены; примеры команд/путей совпадают с кодом; `docs/admin.md` и `README.md` не описывают старое поведение.

## Verification

```bash
cd backend
npm run typecheck
npm test
```

```bash
cd frontend
npm run build   # менялись types + ModelsScreen
```

Ручной smoke (опционально, если есть `TELEGRAM_BOT_TOKEN`):

1. `npm run dev` → отправить фото с подписью «что здесь?» → ответ описывает картинку.
2. Отправить фото без подписи → ответ осмысленный, в логах `textForModel="[изображение]"`.
3. Следующим сообщением «а что на фото?» → модель отвечает по картинке (re-attach из истории).
4. Отправить `image/png` как файл → работает; `application/pdf` → `UNSUPPORTED_REPLY`; `image/heic` → `UNSUPPORTED_IMAGE_REPLY` без скачивания; GIF → работает через `message:animation`.
5. Проверить `./data/media/<xx>/<hash>.jpg` и что повторная отправка того же файла не создаёт дубль.
6. Задать `model_roles.vision` пустым и `default` = текстовая модель → дружелюбный отказ, без падения.
7. Перезапустить сервис → старые картинки всё ещё читаются из `MEDIA_DIR` (пока не истёк prune).

## Risks & Mitigations

| Риск | Митигация |
|------|-----------|
| Mastra/AI SDK теряет `ImagePart` при конвертации `ModelMessage` | В `@mastra/core` 1.79 есть `message-list/prompt/image-utils` + `attachments-to-parts` (Uint8Array → data URI), так что поддержка нативная; unit-тест в Task 5 всё равно проверяет `doStreamCalls.at(-1).prompt`. Если часть потеряется — передавать content parts напрямую в `agent.stream` |
| Рост стоимости vision-токенов | re-attach ≤ 4 картинок / 12 MB и только 2 последних user-сообщения; в логах — `imageParts` |
| Раздувание `mastra_messages` | в истории только `{id, mediaType}`; байты на диске |
| Диск растёт бесконтрольно | sha256-дедуп + prune 7 дней на старте |
| Модель хода без vision (скил с текстовой моделью) | роль `vision` + capability-гейт по каталогу; холодный каталог не блокирует |
| Prompt injection текстом на картинке | пользователь доверенный; promptguard не парсит пиксели — риск зафиксирован в docs; при необходимости позже добавить OCR-скан |
| Альбом из 10 фото = 10 ходов | осознанный скоуп MVP; в доках отметить, агрегация — отдельная задача |
| `file_id`/URL с токеном в логах | логируем только размеры/mime; URL не логируется (как в voice) |

## Out of Scope

- Агрегация media groups (альбомов) в один ход.
- Генерация/редактирование изображений (исходящие картинки) — это M18.
- OCR-фильтр prompt-injection по содержимому картинки.
- HEIC/AVIF и видео.
- Автоматическая очистка медиа по `/new` (покрывается prune).
