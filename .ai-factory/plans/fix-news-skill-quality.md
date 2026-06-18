# План: качество news-скилла (универсальные новости)

**Тип:** fix / enhancement
**Ветка:** `feature/telegram-access-requests` (работаем в текущей ветке — решение пользователя)
**Базовая ветка:** `main`
**Дата:** 2026-06-18 · уточнён `/aif-improve`
**Источник:** `.ai-factory/RESEARCH.md` → сессия `2026-06-18 14:03` (диагностика + live-тест SearXNG)

## Состояние git

Работаем в текущей ветке `feature/telegram-access-requests` (на ней висит готовая, но не закоммиченная работа M17 — отдельный concern; коммитить новости отдельными коммитами, не смешивать с M17).

⚠️ **Нюанс discovery:** имя ветки маппится на `feature-telegram-access-requests.md` (план M17), а не на этот файл. Поэтому `/aif-implement`, `/aif-verify` и т.п. запускать с явным таргетом:
`/aif-implement @.ai-factory/plans/fix-news-skill-quality.md`.

## Settings

- **Testing:** yes — обновить `search.test.ts` (+ кейс `global→wt-wt`), `prompt-builder.test.ts`; добавить eval-сценарий.
- **Logging:** verbose (DEBUG). Запросы к SearXNG уже логируют `{region,language,engines}` (`search.ts:193`) — сохранить.
- **Docs:** yes — mandatory docs-checkpoint в конце (через `/aif-docs`). Затронуты `docs/configuration.md` / `docs/telegram.md` при необходимости.

## Roadmap Linkage

- **Milestone:** none (кандидат: **M18 — Универсальные новости / качество news-скилла**).
- **Rationale:** Линковку решает `/aif-roadmap` (этот скилл роадмап не правит). Работа — самостоятельный fix поверх M11 (web-search) и M15 (оркестратор).

## Research Context (срез, news-only)

Кейс «посмотри новости про утренний удар по москве»: новости **реальны** (крупнейшая за 2 года атака БПЛА на Москву 18.06.2026 — RBC/Lenta/Kommersant/RTVI), но бот отвечает плохо. Четыре бага и их корни:

- **№1 нет поиска на 1-м ходу** → дешёвая `roles.default` (news `model:""`, коммит `d44a985`) не держит «tool-first» + конфликт промпта `load_skill`-first vs active-skill.
- **№2 только белорусские источники** → `news` = «analyst for Belarus»; `search_news` только РБ-сайты; `web_search` дефолт region `ru-by`. **Live-доказано:** `ru-BY` → sb.by/charter97/райгазеты; `ru-RU` → РБК/BBC/Lenta/Kommersant.
- **№3 флип-флоп между ходами** → tool-результаты не персистятся в историю (кросс-скилльный, **вне scope**, см. ниже).
- **№4 отрицание реального как «дезинформации»** → тонкий/смещённый грунт + `markUntrusted`/over-skeptic рамка + дешёвая модель с приором.

**Live SearXNG:** не блокируется (HTTP 200, json ок, `limiter:false`), но `yandex` битый (`parsing error`), `brave`/`bing news` rate-limit; рабочие — `google`, `bing`, `google news`. Дефолт `google,yandex` = де-факто один google.

**Вне scope (осознанно):** баг №3 (флип-флоп) лечится персистом «грунта» тулов между ходами — кросс-скилльный пункт **A1** (см. ниже). Здесь лишь смягчается лучшей моделью (B4) + атрибуцией (C1).

**NB про RESEARCH.md:** его `Active Summary` — более широкий объединённый бэклог, но память/промпты/гигиена из него **уже в M14/M15**; этот план — только реально открытый news-подмножество. Почистить Active Summary стоит через `/aif-explore`.

## Tasks

### Фаза B — SearXNG-дефолты + универсальный скилл

- [x] **B1 — фикс алиаса `global/world/all → wt-wt` (БЕЗ смены глобального дефолта)** (`backend/src/services/web/config.ts`, task #1)
  *Сужено `/aif-improve`:* `DEFAULT_REGION` — дефолт `web_search` для ~10 скиллов (cars/jobs/realty/leisure/health/weather/research/onboarding/currency/shopping), смена ru-by→ru-ru ухудшит белорусские поиски → **оставить `ru-by`**. Починить только сломанный алиас `REGION_ALIASES` (стр.111-115): `global/world/all` сейчас → Беларусь → заменить на `"wt-wt"`. Регион для новостей — по запросу из B3. Тест `search.test.ts`: стр.22/40 остаются `ru-by`; **добавить** кейс `global/world/all → "wt-wt"`.
- [x] **B2 — движки `google,yandex` → `google,bing`** (`config.ts:101`, task #2) — *blocked by B1 (тот же файл)*
  yandex битый, bing рабочий (live). Проверить env-override `SEARXNG_ENGINES` (`env.ts:32`) и `keep_only` (`deploy/searxng/settings.yml`, bing включён). Тестов на engines нет.
- [x] **B3 — news-скилл универсальный** (`backend/skills/news/SKILL.md`, task #3) — *blocked by B1, B2*
  Персона (стр.11) нейтральная; workflow развести: web_search-first с **обязательным** `region` для гео/мира (Россия→`ru`/`ru-ru`, мир→`wt-wt`/`world`), `search_news` — путь РБ-дайджеста; расширить док `region` (стр.17): `ru`=Россия, `wt-wt`=мир. РБ-доменное знание не удалять.
- [x] **B4 — модель для news = `gemini-3-flash-preview`** (`SKILL.md` frontmatter стр.5, task #4) — *blocked by B3*
  *Конкретно `/aif-improve`:* `model:""` → `openrouter:google/gemini-3-flash-preview` (роль synthesizer, tool-capable) или альт `openrouter:deepseek/deepseek-v3.2`. НЕ дефолтный `deepseek-v4-flash`. Сверить ref c `SEED_MODELS` (`seed-data.ts:25-33`).

### Фаза C — Промпты (turn-1 поиск + атрибуция)

- [x] **C1 — атрибуция вместо отрицания** (`SKILL.md` + `backend/src/mastra/tools/web.ts:214-219`, task #5) — *blocked by B4*
  В news-скилл: текущие события — с атрибуцией («по данным X»), свежий веб > приор, расхождения показывать. Смягчить `markUntrusted` (сохранить анти-инъекцию, убрать сигнал «недостоверно»; **кросс-скилльно** — `fetch_url` у всех, но low-risk). Глобальный `INTEGRITY.md` **не трогать**.
- [x] **C2 — убрать конфликт `load_skill`-first для активного скилла** (`backend/src/mastra/agents/prompt-builder.ts`, task #6) — *независима*
  `catalogBlock` (стр.158-167) исключает активный primary-скилл; либо `primarySkillBlock` (стр.169-172) говорит «тулзы активны, load_skill не нужен». **Тесты обязательны** (подтверждено): обновить `backend/test/mastra/prompt-builder.test.ts` (+ `orchestrator.test.ts` при необходимости).

### Фаза V — Верификация

- [x] **V — typecheck / тесты / eval / ручной прогон + регресс-чек** (task #7) — *blocked by B1-B4, C1, C2*
  В `backend/`: `npm run typecheck`, `npm test` (с обновлёнными `search.test.ts`/`prompt-builder.test.ts`), `npm run eval` (=`vitest run test/evals`) — добавить сценарий мирового новостного запроса в `backend/test/evals/`. Ручной прогон против SearXNG (:8888): поиск на 1-м ходу, источники РБК/BBC/Lenta, без «дезинформации», атрибуция. **Регресс-чек:** web_search в РБ-скиллах (cars/jobs/realty/leisure/health/weather) по-прежнему отдаёт белорусскую выдачу (DEFAULT_REGION остался `ru-by`).

## Commit Plan

| Чекпоинт | Задачи | Сообщение (conventional) |
|----------|--------|--------------------------|
| 1 | B1, B2 | `fix(web): map global/world/all region alias to wt-wt; default engines google,bing` |
| 2 | B3, B4 | `feat(skills): make news skill universal (world/RU), assign capable model` |
| 3 | C1, C2 | `fix(prompts): news attribution over denial; drop redundant load_skill for active skill` |
| 4 | V | `test(news): update region/prompt tests + world-news eval scenario` |

## Out of scope (follow-up отдельным планом)

- **A1 — персист «грунта» тулов между ходами** (кросс-скилльный, корень флип-флопа №3 и частично №4). Затрагивает `orchestrator.ts` (стрим `tool-result`), `chat.ts` (`saveAssistant`), `history.ts`. Высокий рычаг, шире news.
- **Качество пре-пасса** (`roles.router` дешёвый → возможна неверная классификация news-запроса). Кросс-скилльное (роль router), отдельно.
