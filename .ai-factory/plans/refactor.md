# План: Надёжность агента, «память контекста» и калибровка промптов

**Branch:** `refactor` · **Создан:** 2026-06-17
**Источник:** `/aif-explore` → `.ai-factory/RESEARCH.md` (сессия 2026-06-17)

## Settings

- **Testing:** да — unit-тесты в существующем стиле (vitest + инъекции, без сети)
- **Logging:** verbose — подробные DEBUG-логи через pino child-логгеры; WARN/ERROR на сбоях LLM/таймаутах
- **Docs:** да — обязательный docs-чекпоинт на завершении (правки доков идут через `/aif-docs`)

## Roadmap Linkage

- **Milestone:** none
- **Rationale:** Подходящей открытой вехи нет (открыта только M9 «Деплой», не про это). Кандидат на новую веху **M14 — «Надёжность и память агента»**; оформить через `/aif-roadmap` отдельно.

## Research Context (Active Summary)

**Topic:** Повысить надёжность агента и качество «памяти контекста»; откалибровать промпты скилов под выросший тир моделей; убрать фактические ошибки и дрейф доков.

**Goal:** Агент дольше и полнее помнит контекст диалога и реже теряет факты о пользователе; промпты дешевле и чище без потери дисциплины на flash-моделях; доки и self-описание соответствуют коду.

**Constraints:**
- Скилы крутятся на **flash/дешёвых** моделях → защитные «якоря» (особенно проверка URL) не срезать подчистую.
- **Доменное знание** в скилах (slugs 103.by, city-slugs gismeteo, шаблоны таблиц, параметры тулзов) НЕ трогаем — режем дубли с глобальными промптами и чек-листы.
- ESM/NodeNext (`.js`), инъектируемость (тесты без сети), watchdog/timeout на каждый LLM/HTTP-вызов, миграция при изменении схемы.
- Отход от Go-паритета допустим (прецедент M13), фиксируется в `CLAUDE.md`.

**Ключевые находки:** окно истории жёсткие 15 сообщений без сжатия (`history.ts`); мульти-скил суб-агенты работают без истории (`skill-agent.ts:123`); долгосрочная память пишется только по явной команде; промпты содержат доменное знание (беречь) + защитные леса под слабые модели (резать); дрейф: `about` говорит «Go», `ARCHITECTURE/DESCRIPTION` описывают удалённый в M13 вектор/RAG; категории `reflection`/`strategy` читаются, но никем не пишутся.

> **Важно по ожиданиям:** надёжность и «память» растут от **Фазы 1**; чистка промптов (Фаза 2) — про стоимость/поддержку, не про надёжность. На flash-моделях часть «лесов» реально работает — режем аккуратно.

---

## Tasks

### Фаза 1 — Память и контекст (высокий рычаг)

- [x] **T1. Поднять max_history 15 → 50.** `seed-data.ts` (SEED_AGENT). ⚠️ Два knob'а: `app.ts:68` `lastMessages` — на старте (не hot-reload); реальный контекст собирает per-turn слайс в `getRecentMessages` (`chat.ts:106`) — его и достаточно поднять. На существующих БД — через админку (`SettingsScreen.tsx`/`PUT /settings/agent`). Делит файлы settings с T5. *Tests: `seed.test.ts`, `settings.test.ts`. Logging: verbose.*
- [x] **T2. Схема + `RollingSummaryService`.** Миграция `sessions.summary`/`summary_msg_count` (`0002_*`, `cd backend && npm run db:generate`) + расширить zod `Session` (`entities.ts:55`), иначе `Session.parse` срежет поля. Инъектируемый `SummarizeFn`, fold, watchdog/timeout, fail-open. Суммаризатор — переиспользовать роль `synthesizer`/`default` (новую роль НЕ заводить). *Tests: `schema.test.ts` + новый `rolling-summary.test.ts`. Logging: verbose.*
- [x] **T3. Подключить summary в `prompt-builder` + `chat`.** Секция `[CONVERSATION SUMMARY]` в system/sub-agent/synthesizer; `conversation-context` отдаёт `session.summary` (зависит от zod-правки T2); best-effort апдейт после хода (как `recordUsage`). *blockedBy T2. Tests: `prompt-builder.test.ts`, `chat.test.ts`. Logging: verbose.*
- [x] **T4. История диалога мульти-скил суб-агентам.** `skill-agent.ts:123`: `[{user}]` → `[...ctx.history, {user}]`; прокинуть summary в sub-agent prompt. *blockedBy T3. Tests: `skill-agent.test.ts`. Logging: verbose.*
- [x] **T5. Оппортунистическое сохранение фактов.** `fact-extractor.ts` (консервативно), маршрут через `MemoryService.save`; best-effort в `chat.ts` для onboarded; обновить parity в `CLAUDE.md`. Тумблер `auto_memory` — ПОЛНЫЙ набор точек: `settings-keys`/`defaultAgent`/seed/admin zod (`.default(true)`)/фронт `types.ts`+`SettingsScreen.tsx`; `getAgent()` не мёржит дефолты → `undefined` трактовать как ON. Учесть стоимость (+1 LLM-вызов/ход — гейт?) и usage. *blockedBy T3. Tests: новый `fact-extractor.test.ts`, `chat.test.ts`, `admin/settings.test.ts`. Logging: verbose.*

### Фаза 2 — Чистка промптов (дешевле/чище)

- [x] **T6. Убрать дубли скилов с INTEGRITY/SOUL/FORMAT.** Снести из `skills/*/SKILL.md` повторы глобальных правил; сберечь доменное знание и специфичные шаблоны вывода. *Tests: typecheck/skill-loading.*
- [x] **T7. Срезать SELF-EVALUATION/FINAL CHECKLIST на дешёвых скилах.** Оставить 1 короткий якорь там, где критична проверка URL (research/health); сократить лишние примеры. *blockedBy T6.*
- [x] **T8. Обновить `_TEMPLATE.md`** под облегчённый стандарт (не повторять глобальные правила; чек-листы — опционально и кратко). *blockedBy T6, T7.*

### Фаза 3 — Гигиена

- [x] **T9. `about`: «Go» → TypeScript** (строка ~161) + сверить самоописание памяти с новым поведением. *blockedBy T1, T5 (описание памяти потребляет их результат; правка Go→TS сама по себе независима). Tests: skill-loading.*
- [x] **T10. Синхронизировать `ARCHITECTURE.md` + `DESCRIPTION.md`** с M11–M13 (убрать LibSQLVector/RAG/embeddings/dedup-0.92; нативный `web`; parity по `CLAUDE.md`).
- [x] **T11. `/new` cleanup осиротевших тредов + ограничить чтение истории.** ⚠️ У Mastra Memory нет delete API, `mastra_messages` не в drizzle-схеме → удаление = RAW SQL (`DELETE FROM mastra_messages WHERE thread_id = ?`) через libSQL-клиент, guard+лог. `getRecentMessages` — bounded чтение либо задокументировать, что rolling-summary снимает риск. *Tests: `history.test.ts`. Logging: verbose.*
- [x] **T12. Категории `reflection`/`strategy` — рефрейм:** это реальные члены энума `MemoryCategory` (`entities.ts:14-21`), не мёртвый код. Дефолт — Вариант B: подключить как писателя T5; иначе резать энум + `memory-classifier` + `prompt-builder` согласованно. *blockedBy T5. Tests: `prompt-builder.test.ts`, `memory-classifier.test.ts`.*

---

## Commit Plan

Чекпоинты каждые 3–5 задач (conventional commits):

1. **После T1–T3** — `feat(memory): расширить окно истории и добавить rolling-summary`
2. **После T4–T5** — `feat(memory): история суб-агентам + оппортунистическое сохранение фактов`
3. **После T6–T8** — `refactor(prompts): убрать дубли с глобальными, срезать чек-листы, обновить шаблон`
4. **После T9–T12** — `chore: about Go→TS, синхронизация доков, чистка тредов, reflection/strategy`

> Перед каждым коммитом (в `backend/`): `npm run typecheck` + `npm test` зелёные; миграция сгенерирована для T2; секреты не в коде/логах.
