# Доступ к боту по заявкам (approval-флоу)

**Branch:** `feature/telegram-access-requests`
**Created:** 2026-06-18
**Type:** feature

## Контекст (зачем)

На экране **Пользователи** в Mini App есть только ручной ввод Telegram user id в «Список доступа к боту». Контрол технически исправен (фронт → `PUT /admin/api/users/allowlist` → настройка `telegram_allowed_users` → гейт бота `isAuthorized`), но на практике бесполезен: админ почти никогда не знает числовой id человека. Вдобавок **пустой список = «пускать всех»** (`bot.ts:82`), то есть ограничение сейчас фактически выключено, а незнакомец, написавший боту, **молча отбрасывается** (`bot.ts:225-231`) — заявка нигде не фиксируется.

**Цель:** незнакомец пишет боту → попадает в список заявок в админке → админ одобряет → клиент получает доступ и уведомление «Доступ открыт ✅».

## Settings
- **Testing:** yes — Vitest, без сети (через DI), по harness jarvis: сервис заявок, admin API, гейт бота.
- **Logging:** verbose (DEBUG) — вход/выход record/approve/reject, INFO на создание/одобрение/отклонение заявки и применение бутстрапа; PII (name/username/текст) не логировать, только tgUserId/id (pino redact).
- **Docs:** yes — обязательный чекпоинт документации на завершении (`/aif-docs`): синхронизировать ARCHITECTURE.md (раздел про гейт/allowlist) и CLAUDE.md (инварианты доступа).

## Roadmap Linkage
- **Milestone:** "M17 — Доступ к боту по заявкам" (новый)
- **Rationale:** M0–8, 11–15 закрыты; это новый объём поверх M8 (админка) и M6 (бот) — approval-флоу выдачи доступа. Фактическое добавление пункта в ROADMAP.md — follow-up через `/aif-roadmap` (планировщик владеет только plan-файлами).

## Решения (согласованы с пользователем)

1. **Режим доступа** — новая настройка `telegram_access_mode: "open" | "approval"`.
   - `open` — старое поведение (пустой список = все; непустой = только из списка).
   - `approval` — доступ **только** из `telegram_allowed_users`; незнакомец создаёт заявку.
   - Включаем `approval` + **переносим существующих** telegram-пользователей в список (чтобы не залочить вас и Алесю) — один раз idempotent-бутстрапом на старте.
   - В UI — переключатель режима.
2. **Ответ незнакомцу:** один раз «Заявка на доступ отправлена администратору. Дождитесь одобрения 🙌» (только при создании новой заявки; повторы в статусе pending/rejected — молча).
3. **Уведомление при одобрении:** бот пишет клиенту «Доступ открыт ✅ …».

**Единый источник правды гейта** остаётся `telegram_allowed_users`. Одобрение **добавляет** tg id в этот список. Таблица `access_requests` — входящий «инбокс» + аудит.

## Целевая структура
```
backend/src/
  db/schema.ts                         # + таблица access_requests (образец pendingConfirmations)
  db/migrations/*                      # генерируется npm run db:generate
  config/settings-keys.ts              # + TelegramAccessMode + тип AccessMode
  config/settings.ts                   # + getAccessMode() (default "open")
  services/access-request-service.ts   # NEW: record/list/approve/reject + ensureAccessControlDefaults
  mastra/workflows/chat.ts             # ChatDeps + accessRequests + notify?
  app.ts                               # конструирование accessRequests в deps
  telegram/bot.ts                      # гейт-middleware approval + ответ незнакомцу + константы
  server.ts                            # ensureAccessControlDefaults + notify wiring + accessRequests в createBot
  admin/api/users.ts                   # + /access-mode, /requests (approve/reject), mode в /allowlist
frontend/src/
  screens/UsersScreen.tsx              # переключатель режима + секция «Заявки»
  lib/types.ts                         # AccessRequest, AccessMode
```

## Commit Plan
- **Commit 1** (после задач #1–#2): `feat(db): таблица access_requests + настройка telegram_access_mode`
- **Commit 2** (после задач #3–#4): `feat(access): сервис заявок + проводка в ChatDeps`
- **Commit 3** (после задачи #5): `feat(bot): approval-гейт, ответ незнакомцу, перенос текущих юзеров`
- **Commit 4** (после задач #6–#7): `feat(admin): API заявок + UI (переключатель режима, инбокс заявок)` — включить пересобранный `frontend/dist`
- **Commit 5** (после задачи #8): `test(access): сервис, admin API, гейт бота`

## Tasks

### Фаза 1 — Данные и настройки
- [x] **#1** Таблица `access_requests` в `db/schema.ts` (id, tgUserId UNIQUE, name, username nullable, status default 'pending', createdAt/updatedAt/decidedAt, index по status) + `npm run db:generate` → ожидаемая миграция `0004_*` (последняя сейчас `0003`).
- [x] **#2** Настройка `telegram_access_mode`: `TelegramAccessMode` + тип `AccessMode` в `settings-keys.ts`; `getAccessMode()` (default `"open"`) в `settings.ts`.
<!-- Commit checkpoint: #1–#2 -->

### Фаза 2 — Сервис заявок
- [x] **#3** `services/access-request-service.ts` (NEW): `record` (tx select→insert `onConflictDoNothing`+re-read для гонки первого контакта, статус не сбрасывать), `listPending/list`, `approve` (статус + add в allowlist + invalidate; нет строки/не pending → `null`), `reject`, `ensureAccessControlDefaults` (бутстрап: перенос user_channels → allowlist + mode="approval"). *(blockedBy #1, #2)*
- [x] **#4** В `ChatDeps` (chat.ts) добавить `accessRequests` (required) + `notify?`; сконструировать сервис в `app.ts`. ⚠️ required-поле ломает ВСЕ полные сборки ChatDeps — в этой же задаче обновить `app.ts:80` + фикстуру `test/mastra/chat.test.ts:114` (+проверить `scheduler/wiring.test.ts:33`), иначе typecheck красный. *(blockedBy #3)*
<!-- Commit checkpoint: #3–#4 -->

### Фаза 3 — Бот
- [x] **#5** Гейт-middleware `bot.ts`: `refreshIfStale()` в начале; open → как сейчас; approval → членство в allowlist или `record()` + один ответ «заявка отправлена» + drop; константы `ACCESS_REQUESTED_MSG`/`ACCESS_GRANTED_MSG`. `server.ts`: вызвать `ensureAccessControlDefaults`, передать `accessRequests` в `createBot`, выставить `notify` после старта бота. Инвариант: админка и бот делят один `SettingsService` → `invalidate()` виден боту без рестарта. *(blockedBy #4)*
<!-- Commit checkpoint: #5 -->

### Фаза 4 — Admin API + UI
- [x] **#6** `admin/api/users.ts`: `GET /allowlist`→`{userIds, mode}`; `PUT /access-mode`; `GET /requests`; `POST /requests/:id/approve` (+`notify`, `null`→404); `POST /requests/:id/reject`. *(blockedBy #4)*
- [x] **#7** `UsersScreen.tsx`: переключатель режима + секция «Заявки» (Одобрить/Отклонить); типы в `types.ts`; `cd frontend && npm run build` (dist закоммичен → включить в коммит). *(blockedBy #6)*
<!-- Commit checkpoint: #6–#7 -->

### Фаза 5 — Тесты
- [x] **#8** Тесты: `access-request-service.test.ts` (record/approve/reject/гонка/бутстрап), дополнить `admin/users.test.ts` (фикстура deps + `accessRequests` + `notify`-шпион) и `telegram/bot*.test.ts` (`buildBot` прокинуть `accessRequests`, режим через сидинг `telegram_access_mode`); `npm run typecheck && npm test` зелёные. *(blockedBy #5, #7)*
<!-- Commit checkpoint: #8 -->

## Проверка (verification)
1. `cd backend && npm run db:generate` — появилась миграция для `access_requests`.
2. `cd backend && npm run typecheck && npm test` — зелено.
3. `cd frontend && npm run build` — прод отдаёт `frontend/dist`.
4. E2E вручную: с НЕдобавленного аккаунта написать боту → приходит «Заявка отправлена…», заявка видна в админке (Пользователи → Заявки) → «Одобрить» → клиенту приходит «Доступ открыт ✅», его id появляется в списке доступа, бот отвечает на следующее сообщение.
5. Без локаута: после бутстрапа текущие пользователи (вы, Алеся) уже в списке доступа; повторное сообщение pending/rejected-юзера не плодит дубли и не спамит ответом.
