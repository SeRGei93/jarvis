# Файловый источник скилов и промтов (drop таблиц, defaults + volume)

**Branch:** `feature/file-backed-skills-prompts`
**Created:** 2026-06-15
**Type:** refactor / architecture
**Base:** ветвить от `feature/web-search-native-backend` (M11) или от `main` после его мёржа — план трогает те же файлы, что и M11 (`seed/*`, `seed.ts`, `registry`, `admin`).

## Settings
- **Testing:** yes — vitest, инъекция `fs`/временные каталоги (репозитории, populate, атомарная запись, hot-reload, валидация frontmatter)
- **Logging:** verbose (DEBUG) — чтение/запись файлов, populate, hot-reload, инвалидация кэша (без секретов, pino)
- **Docs:** yes — обязательный чекпоинт `/aif-docs` на завершении

## Roadmap Linkage
- **Milestone:** "M12 — файловый источник скилов/промтов (drop таблиц skills/prompts, defaults + volume)"
- **Rationale:** Новый объём после M11. Меняет модель хранения: скилы и промты — единый файловый источник правды (репо-дефолты + персистентный стор на томе), без таблиц `skills`/`prompts`. Майлстоун M12 добавить в ROADMAP через `/aif-roadmap` (этот командой владеет планировщик только plan-файлами).

## Решение (из обсуждения — Вариант 1)
- **Оркестратор НЕ вводим.** Текущий пайплайн `route → параллельные суб-агенты → synthesizer` и роутер остаются без изменений. Меняется только источник определений скилов/промтов.
- **Файлы = источник правды** (не БД). БД можно полностью пересоздать — миграция данных не нужна.
- **Дефолты в репо** (версионируются, code-review): `backend/skills/<skill>/SKILL.md`, `backend/prompts/*.md` (переезд из `backend/seed/`).
- **Рантайм-стор на томе** `./data` (в контейнере `/data`): `SKILLS_DIR=/data/skills`, `PROMPTS_DIR=/data/prompts`. На старте: если стор пуст → скопировать дефолты (**populate-if-empty**); дальше приложение читает и **пишет** именно стор. Правки из админки переживают редеплой.
- **`backend/seed/` удаляется целиком**: данные `config.yaml` (settings/models/plans) переезжают в **код-сид** (`src/db/seed-data.ts`); skills/prompts становятся файловым стором. `settings`/`models`/`subscriptionPlans` остаются в БД (это конфиг, не скилы).

## Целевая структура
```
backend/
  skills/<skill>/SKILL.md        # репо-дефолты скилов (было seed/skills)
  prompts/*.md                   # репо-дефолты промтов (было seed/prompts)
  src/
    config/env.ts                # + SKILLS_DIR, PROMPTS_DIR
    content/
      paths.ts                   # DEFAULTS_SKILLS_DIR/DEFAULTS_PROMPTS_DIR + store-пути из env
      store.ts                   # ensurePopulated() + atomicWrite() + parseFrontmatter()
      skill-repository.ts        # file-backed CRUD скилов (кэш + hot-reload)
      prompt-repository.ts       # file-backed get/upsert промтов
    db/
      seed-data.ts               # код-сид settings/models/plans (было config.yaml)
      seed.ts                    # только settings/models/plans; seedSkills/seedPrompts удалены
      schema.ts                  # без таблиц skills/prompts
data/skills, data/prompts        # рантайм-стор (том; в .gitignore)
```

## Tasks

### Фаза 1 — Окружение и код-сид настроек
- [x] **#1** Env + пути: в `EnvSchema` (`src/config/env.ts`) добавить `SKILLS_DIR` (default `./data/skills`) и `PROMPTS_DIR` (default `./data/prompts`); в `docker-compose.yaml` и `docker-compose.local.yml` для `app` → `SKILLS_DIR=/data/skills`, `PROMPTS_DIR=/data/prompts`. Создать `src/content/paths.ts`: `DEFAULTS_SKILLS_DIR`/`DEFAULTS_PROMPTS_DIR` (через `fileURLToPath` на `backend/skills`,`backend/prompts`) и геттеры стора из `env`. `data/` уже в `.gitignore` — проверить, добавить `data/skills`,`data/prompts` при необходимости. *(blockedBy —)*
- [x] **#2** Код-сид настроек: перенести данные `backend/seed/config.yaml` в типизированный `src/db/seed-data.ts` (роли моделей, список моделей, таймауты, `agent.*`, планы, `telegram.allowed_users=[]`); `seed.ts` берёт данные из модуля, убрать `loadSeedConfig()` и YAML-чтение. *(blockedBy —)*

### Фаза 2 — Файловые сторы
- [x] **#3** `src/content/store.ts`: `ensurePopulated()` — если каталог стора отсутствует/пуст, рекурсивно скопировать дефолты из репо (идемпотентно, DEBUG-лог сколько скопировано); `atomicWrite(path, data)` (запись в `*.tmp` + `rename`); вынести `parseFrontmatter()` из `seed.ts` сюда (общий парсер). *(blockedBy #1)*
- [x] **#4** `src/content/skill-repository.ts`: file-backed `list()/getByName()/upsert(skill)/delete(name)` поверх `SKILLS_DIR`; парсинг `SKILL.md` (frontmatter+тело → доменный `Skill`, без числового `id` — ключ `name`), кэш + hot-reload (сверка mtime при чтении и/или `fs.watch` с фолбэком на mtime-поллинг); валидация frontmatter при `upsert` (битый файл при `list` — skip + WARN, не роняет выдачу); запись через `atomicWrite`. **+ `serializeSkill(skill) → SKILL.md` (обратная к parse): круговой round-trip всех полей — `allowedTools` массив↔space-string, `reasoning` tri-state, `temperature` число, `routable`, `metadata`↔неизвестные frontmatter-ключи (напр. `max-turns`); тест parse↔serialize↔parse.** *(blockedBy #3)*
- [x] **#5** `src/content/prompt-repository.ts`: file-backed `get(key)/upsert(key,body)/list()` поверх `PROMPTS_DIR` (файлы `KEY.md`, ключи `SOUL/FORMAT/INTEGRITY/SYNTHESIZER/WELCOME/MONITORING`); кэш + hot-reload; запись через `atomicWrite`. *(blockedBy #3)*

### Фаза 3 — Интеграция с сервисами
- [x] **#6** `SkillService` (`src/services/skill-service.ts`): переключить на `SkillRepository`+`PromptRepository` вместо чтения из БД; **сохранить точный публичный интерфейс** — `getAllSkills()`, `getRoutableSkills()`, `getSkillByName()`, `getPrompt()`, `getCorePrompts()`, `derivePreviousSkills`, `invalidate()` — чтобы потребители не менялись: `chat.ts`, роутер, scheduler `getPrompt("MONITORING")`, telegram `getPrompt("WELCOME")`, `buildSkillAgent`. *(blockedBy #4, #5)*
- [x] **#6a** Boot-populate: вызвать `ensurePopulated()` в `src/server.ts main()` ДО `createChatService()` (await). **Важно:** `runSeed` на старте НЕ вызывается (это отдельный CLI/entrypoint), а `app.ts` читает скилы уже в `getRoutableSkills()` — значит стор обязан быть заполнен до конструирования `SkillService`. Убедиться, что `createChatService` больше не зависит от таблиц skills/prompts. *(blockedBy #6)*
- [x] **#7** `src/mastra/tools/skill-ref.ts`: `defaultSkillsRoot()` → `SKILLS_DIR` из env (не `SEED_DIR`); убрать импорт `SEED_DIR`; `references/scripts/assets` теперь рядом со скилом в сторе. *(blockedBy #4)*

### Фаза 4 — Снос таблиц БД
- [x] **#8** Drizzle: удалить таблицы `skills` и `prompts` из `src/db/schema.ts` и связанные типы/импорты; `npm run db:generate` (чистая миграция — БД пересоздаётся); из `seed.ts` убрать `seedSkills`/`seedPrompts` (остаются только settings/models/plans). *(blockedBy #6, #7)*

### Фаза 5 — Админка
- [x] **#9** Admin API `src/admin/api/skills.ts` (строки ~149–298) и `prompts.ts` (~32–79): сейчас они **обходят `SkillService` и ходят в БД напрямую** (`db.select/insert/update/delete` по `skillsTable`/`promptsTable`). Заменить ВСЕ прямые запросы на вызовы репозиториев (запись в файлы стора атомарно + валидация), инвалидация кэша. HTTP-контракт уже **name/key-адресный** (`PUT /skills/:name`, `PUT /prompts/:key`) → **фронт НЕ трогаем** (подтверждено: `SkillsScreen`/`PromptsScreen` адресуют по name/key, имя immutable при edit). *(blockedBy #6)*

### Фаза 6 — Файлы и деплой
- [x] **#10** Переезд каталогов и образ: `git mv backend/seed/skills backend/skills`, `git mv backend/seed/prompts backend/prompts`, удалить `backend/seed/` (config.yaml уже перенесён в #2). `Dockerfile`: вместо `COPY backend/seed ./seed` → `COPY backend/skills ./skills` + `COPY backend/prompts ./prompts`; populate в стор на старте (через `ensurePopulated()` в коде на boot — предпочтительно — или шаг в `deploy/docker-entrypoint.sh`). Том `/data` уже смонтирован. *(blockedBy #2, #8, #6a)*

### Фаза 7 — Тесты
- [x] **#11a** Тест-хелпер `test/helpers/content.ts`: `tempSkillsDir(skills)` / `tempPromptsDir(prompts)` — пишут фикстурные `SKILL.md` (frontmatter+тело) и промты в `mkdtemp`-каталог, возвращают путь (+cleanup). Нужен, чтобы 6 файлов с прямыми `insert` перешли на файловые фикстуры без дублирования шаблонов. *(blockedBy #3)*
- [x] **#11** Новые тесты (vitest, временные каталоги через `mkdtemp`): `SkillRepository` (parse/cache/hot-reload/`upsert` атомарно/битый файл → skip+WARN), `PromptRepository`, `store.ensurePopulated` (populate-if-empty + идемпотентность), валидация + round-trip frontmatter. *(blockedBy #4, #5, #11a)*
- [x] **#12** Обновить существующие тесты под новый источник. **Прямые `insert(skills/prompts)` → файловые фикстуры (через #11a):** `test/app.test.ts`, `test/mastra/chat.test.ts`, `test/services/skill-service.test.ts`, `test/admin/skills.test.ts`, `test/admin/prompts.test.ts`, `test/telegram/commands.test.ts`. **`test/db/seed.test.ts`** — снять ассерты «19 скилов / 6 промтов» (теперь сидятся только settings/models/plans). **`test/mastra/skill-ref.test.ts`** — на `SKILLS_DIR`. `runSeed`-only admin-тесты (models/settings/plans/users/usage) и `config/settings.test.ts` — работают без изменений (runSeed по-прежнему сидит settings/models/plans). *(blockedBy #8, #9, #11a)*

### Фаза 8 — Безопасность, проверка, доки
- [x] **#13** Безопасность + проверка: при записи из админки валидировать имя скила/ключ промта (без `..`, абсолютных путей, выхода за стор — как в `skill-ref` containment); атомарность записи; `typecheck`+`test` зелёные; ручной smoke (свежий `/data` → populate; правка скила из админки персистит после рестарта контейнера). *(blockedBy #10, #11, #12)*
- [x] **#14** Документация (обязательный чекпоинт `/aif-docs`): `docs/configuration.md` (`SKILLS_DIR`/`PROMPTS_DIR`, файловый источник + том), `docs/architecture.md` (скилы/промты — файлы+volume, БД без `skills`/`prompts`), `docs/admin.md` (правит файлы стора), README; пометить **M12** в ROADMAP через `/aif-roadmap`. *(blockedBy #13)*

## Commit Plan
- **Commit 1** (после #1–#2): `feat(content): env dirs + code-based settings seed (drop config.yaml)`
- **Commit 2** (после #3–#5): `feat(content): file-backed skill/prompt repositories (populate, atomic write, hot-reload)`
- **Commit 3** (после #6–#7 + #6a): `refactor(skills): back SkillService + skill-ref by file repositories; populate store on boot`
- **Commit 4** (после #8): `feat(db): drop skills/prompts tables; seed only settings/models/plans`
- **Commit 5** (после #9): `feat(admin): skills/prompts CRUD writes files instead of DB`
- **Commit 6** (после #10): `chore(deploy): move seed defaults to backend/{skills,prompts}; populate store on boot`
- **Commit 7** (после #11a, #11–#14): `test+docs(content): file-store tests, verification, docs (M12)`

## Риски / заметки
- **Проверено в коде (де-риск, второй проход):** у таблиц `skills`/`prompts` **нет входящих FK** (`cron_tasks.skill_name` — обычный TEXT, не FK) → дроп чистый; обе таблицы уже **name/key-keyed** (PK `name`/`key`, числового `id` нет), домен `Skill` без `id` → файловый стор 1:1, миграции id не нужно; admin-API и фронт уже адресуют по name/key → **фронт не трогаем**.
- **Персистентность тома:** правки из админки живут, пока `/data` персистентен. Пересоздание тома → откат к репо-дефолтам (это by design; задокументировать).
- **Конкуренция записи:** jarvis single-process — ок. При масштабировании на N инстансов файловый стор потребует общего тома и блокировок (вне объёма).
- **hot-reload:** `fs.watch`/inotify ненадёжен в некоторых Docker/ФС — обязателен фолбэк на mtime-сверку при чтении.
- **Ветка:** реализовывать поверх M11 (общие файлы `seed/*`, `seed.ts`, `registry`, `admin`), иначе конфликты при мёрже.
- **БД пересоздаётся:** чистая миграция после дропа таблиц; засиженные dev-базы пересоздать (`rm data/db/*.db` + `db:migrate` + `db:seed`).
