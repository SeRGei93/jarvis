# Research

Updated: 2026-06-18 14:03
Status: active

## Active Summary (input for /aif-plan)
<!-- aif:active-summary:start -->
**Topic:** Объединённый бэклог «надёжность агента»: (A) контекст/память/грунт между ходами, (B) починка `news`-скилла → универсальные новости с балансом источников, (C) калибровка промптов под выросший тир моделей, (D) гигиена доков/тредов. Слиты два захода: аудит памяти/промптов (2026-06-17) + диагностика news-скилла и live-тест SearXNG (2026-06-18). Корневое пересечение: **tool-результаты и история теряются между ходами** — это и news-флип-флоп (баг №3), и общая «дырявая память контекста».

**Goal:** Агент дольше и полнее помнит контекст диалога и сохранённый «грунт» (источники/факты тулов) между ходами; новостной запрос любой тематики получает реальный веб-поиск на 1-м ходу со сбалансированными источниками (РБК/BBC/Lenta, а не райгазеты РБ) и стабильным, не переобувающимся ответом; промпты дешевле/чище без потери дисциплины на flash-моделях; доки и self-описание агента соответствуют коду.

**Constraints:**
- Стек-инварианты: ESM/NodeNext (`.js`), инъектируемость (`fetchFn`/`SettingsService`/`ModelFactory` — тесты без сети), watchdog/timeout на каждый LLM/HTTP-вызов, миграция при изменении схемы.
- Скилы крутятся на **дешёвых flash-моделях** (`deepseek-v4-flash`, `gemini-3-flash`, роутер `gpt-oss-120b`) → анти-галлюцинационные якоря (`INTEGRITY.md`: facts-from-tools, URLs-exact, verify-before-cite) **не срезать подчистую**; смягчать только трактовку «при сомнении опусти» → «атрибутируй».
- **Доменное знание** скилов (slugs 103.by, city-slugs gismeteo, шаблоны таблиц, параметры тулзов, РБ-источники `search_news`) **НЕ трогаем** — режем дубли с глобальными промптами и чек-листы; для news добавляем универсальный путь, не ломая бытовой РБ-дайджест.
- Безопасность: web-контент остаётся untrusted (delimit/strip), `userId`-скоуп памяти — не трогаем. Отход от Go-паритета допустим (прецедент M13), фиксируется в `CLAUDE.md`.

**Decisions (объединённый приоритизированный бэклог, по фазам):**

**Фаза A — Контекст / память / грунт (ВЫСОКИЙ рычаг — «надёжнее»):**
- **A1.** Персистить «грунт» тулов (источники+факты `web_search`/`fetch_url`) в историю между ходами. Сейчас оркестратор читает `tool-result` из `fullStream` только для UI-статуса и возвращает `{text}`; `saveAssistant` пишет лишь текст; `history.ts` знает роли user/assistant. → чинит news-баг №3+№4. **Самый высокий рычаг, новый пункт.**
- **A2.** `max_history` 15 → 40–60 (`seed-data.ts` SEED_AGENT) + опц. rolling-summary старого хвоста (`createConversationMemory`: сейчас `lastMessages:15, semanticRecall:false, workingMemory:false`).
- **A3.** Отдавать историю мульти-скил суб-агентам (`skill-agent.ts:123` сейчас даёт воркеру только текущее сообщение).
- **A4.** Оппортунистическое сохранение фактов (LLM-решает) поверх `remember`+онбординга; дедуп есть (`LlmDedupChecker`); пересмотр Go-паритета «no auto-extraction».

**Фаза B — News-скилл: универсальные новости + источники (ВЫСОКИЙ):**
- **B1.** `DEFAULT_REGION` `ru-by` → `ru-ru` / выводить из запроса; чинить алиас `global/world/all → ru-by` (сейчас «мир» = Беларусь!) (`config.ts:15,111-132`). → баг №2.
- **B2.** `SEARCH_ENGINES` `google,yandex` → `google,bing` (yandex битый `parsing error`, bing рабочий — убрать single-engine хрупкость) (`config.ts:101`). → баг №1-хрупкость.
- **B3.** `news` → универсальный: нейтральная персона (`SKILL.md:11`), `web_search`-first для не-РБ/тематических запросов, регион по запросу; РБ-дайджест (`search_news`) оставить как явный путь. → баг №2+№1.
- **B4.** Дать `news` явную вменяемую `model:` (сейчас `model:""` → дешёвый `roles.default`=`deepseek-v4-flash`, коммит `d44a985`). → баг №1+№4.

**Фаза C — Промпты: калибровка под тир модели (СРЕДНИЙ — «дешевле/чище»):**
- **C1.** Смягчить over-skeptic рамку (`INTEGRITY.md:5-8` + `markUntrusted` `tools/web.ts:214-219`) → атрибуция («по данным X») вместо отрицания реального. → баг №4.
- **C2.** Убрать промпт-конфликт `[SKILLS]` «зови load_skill ПЕРВЫМ» (`prompt-builder.ts:164`) против `[ACTIVE SKILL]` «уже загружено» (`:171`) для уже активного скилла. → баг №1-вторичное.
- **C3.** Вычистить дубли скилов с `INTEGRITY.md`/`SOUL.md`/`FORMAT.md` (facts-from-tools, URLs-exact, respond-in-language, use-[KNOWLEDGE]).
- **C4.** Убрать `SELF-EVALUATION`/`FINAL CHECKLIST` на дешёвых скилах → 1 короткий якорь; калибровать многословие под тир модели скила.

**Фаза D — Гигиена (НИЗКИЙ):**
- **D1.** `about/SKILL.md:161` «written in Go» → TypeScript; синхронизировать `ARCHITECTURE.md`/`DESCRIPTION.md` с M11–M13 (вектор/RAG/embeddings удалены).
- **D2.** `/new` cleanup осиротевших тредов (`history.rotateThread`); `getRecentMessages` читает весь тред каждый ход — чинить здесь или отдельной задачей.
- **D3.** Мёртвые категории `reflection`/`strategy` в `prompt-builder.memoryContext` (читаются, никем не пишутся).

**Open questions:**
- A1: сохранять полный markdown тул-результата или сжатый дайджест (источники+тезисы)? Хранить как отдельные tool-сообщения в истории vs поле сессии? Связать с A2 (rolling-summary должен сохранять «грунт», а не только текст).
- A2: rolling-summary в этом же заходе или сначала поднять `max_history` и измерить? Что из Mastra Memory включать (`workingMemory`?).
- B1: жёстко `ru-ru` дефолтом или выводить регион из запроса (Москва→ru, мир→wt-wt)? Кто выводит — модель (param `region`) или эвристика в тул-слое?
- B3: для news использовать `categories=news`+`google news` (30 рез., но без `publishedDate`) или `general`+`google,bing` (чище мейджоры, есть даты)?
- A4: порог уверенности оппортунистического сохранения, какие категории, как не плодить мусор.
- Структура реализации: фазы строго по порядку или A+B параллельно (разные области), затем C, затем D?

**Success signals:**
- Запрос «новости про X» → реальный `web_search` на 1-м ходу (логи `primary skill selected` + tool-call), без «я проверил ленты» без вызова тула.
- На гео/мировой запрос в выдаче РБК/BBC/Lenta/Kommersant, а не sb.by/charter97/райгазеты.
- Между ходами ответ не переобувается; подтверждённое событие остаётся подтверждённым; реальное не зовётся «дезинформацией» (атрибуция вместо вердикта).
- В длинном диалоге агент ссылается на сказанное >15 сообщений назад; мульти-скил фоллоу-апы не теряют контекст; факт без «запомни» переживает `/new`.
- `npm run typecheck` + `npm test` зелёные; LLM-вызовы под watchdog; инъекции сохранены; `about` не утверждает «Go»; доки `.ai-factory` соответствуют коду.

**Next step:** `/aif-plan full` по фазам A→B→C→D (A и B можно параллелить — разные области кода).
<!-- aif:active-summary:end -->

## Sessions
<!-- aif:sessions:start -->
### 2026-06-15 01:11 — Изучение переноса web-search в backend
**What changed:**
- Изучены оба репозитория. Решение пользователя сменилось с «вендорить web-search как отдельный MCP-контейнер» на «встроить код web-search нативно в backend».
- Зафиксированы решения: без браузера; удалить MCP-слой; база с нуля; `web_fetch`→`fetch_url`; не переносить nesty; адаптировать и улучшать.

**Key notes:**
- Как jarvis сейчас цепляет MCP: конфиг в БД (`settings.mcp_servers`, формат stdio `{command,args,env}`); `@mastra/mcp` спавнит `npx -y mcp-remote <url>` как мост stdio↔HTTP к `host.docker.internal:3000/mcp`. После переноса всё это уходит.
- Инструменты в агент попадают per-skill через `allowed-tools`, резолвятся в `registry.ts` по «бакетам» (memory/currency/tasks/profile/skill-ref + текущий `ctx.mcpTools`). Добавляем новый бакет `web` (имена bare, как у текущих MCP-тулзов).
- Несовпадение имён (`web_fetch` vs `fetch_url`, `read_resource` как ресурс-не-тулза) при нативной реализации **исчезает** — имена контролируем сами.
- web-search реально содержит ~15 тулзов + 10 ресурсов (намного больше, чем его CLAUDE.md). Браузер нужен был только для cars.av.by и www.kufar.by (`BROWSER_DOMAINS`), и то ради анти-бота, а не рендеринга (kufar отдаёт `__NEXT_DATA__` SSR-JSON).
- Парсеры в основном чистые (HTML→data) → идеальны для unit-тестов jarvis.
- Улучшения-кандидаты: 103by 29→~4 тулзы; SSRF-guard; инъекция fetchFn; кэш в libSQL; убрать дублирующий rate-limiter; pino вместо console.error; resources→lookup-тулзы.

**Финальный набор инструментов (после решений):**
- Порт: web_search, web_search_batch, fetch_url, search_news, kufar_search, avby_search, rabota_search, transport_search, relax_search, relax_afisha, weather(подтвердить), 103by → doctor_search/clinic_search/services/pharmacy.
- Удалить: nesty_search (+ nesty-ресурсы).
- Ресурсы kufar/avby/relax → lookup-тулзы или внутреннее резолвинг.

**Skill-правки:**
- Везде `web_fetch` → `fetch_url`; `read_resource` → новые lookup-тулзы.
- realty: перенацелить (nesty мёртв) или убрать. health: на consolidated doctor_search/clinic_search. weather: оставить тулзу.

**Links (paths):**
- Источник: `/Users/serg/GolandProjects/mcp-servers/{web-search,searxng,docker-compose.yml}`
- Цель: `backend/src/{services,mastra/tools}/`, `backend/src/db/seed.ts`, `backend/seed/config.yaml`, `backend/seed/skills/*`, `docker-compose.yaml`, `docker-compose.local.yml`
- Ключевые файлы jarvis: `backend/src/mastra/mcp.ts` (удалить), `backend/src/mastra/tools/registry.ts` (новый бакет), `backend/src/config/settings-keys.ts`, `backend/src/db/seed.ts` (`searchOnly`)

### 2026-06-17 16:00 — Аудит логики, памяти и промптов
**What changed:**
- Изучён весь основной поток одного хода: `chat.ts` (runChat), `router.ts`, `prompt-builder.ts`, `conversation-context.ts`, `history.ts`, `memory-service.ts`, `dedup.ts`, `skill-agent.ts`, `profile-extractor.ts`, `seed-data.ts` + 7 скилов (health/about/automation/research/chat/weather/remember) и 6 глобальных промптов.
- Сформулирован приоритизированный бэклог (6 пунктов, 3 фазы). Пользователь принял все предложения, идём в план.

**Key notes (находки):**
- Главная слабость «памяти контекста» — **жёсткое окно 15 сообщений без сжатия** (`history.ts` createConversationMemory). SOUL обещает помнить контекст, а кормится только хвост из 15.
- **Мульти-скил воркеры работают вслепую** — `skill-agent.ts:123` отдаёт только текущее сообщение; одиночный путь (`runSkillStreaming`) историю получает.
- **Долгосрочная память пишется только по явной команде** (`remember`+онбординг, осознанный Go-паритет). В связке с окном 15 → факты «между делом» теряются.
- Промпты содержат **два вещества**: доменное знание (НЕ трогать) и защитные леса под слабые модели (чек-листы самопроверки, дубли глобальных правил INTEGRITY/SOUL/FORMAT) — резать леса, калибруя под тир модели скила.
- Тримминг промптов даёт «дешевле/быстрее/проще», но **не «надёжнее»** — надёжность/память растут от пунктов 1–3, не от объёма промптов.
- Дрейф/ошибки: `about` говорит «написан на Go» (это TS); `ARCHITECTURE.md`/`DESCRIPTION.md` всё ещё описывают LibSQLVector/RAG/embeddings (удалены в M13); категории `reflection`/`strategy` читаются, но никем не пишутся; `/new` не удаляет старые треды (`history.rotateThread`), `getRecentMessages` читает весь тред каждый ход.
- Модели сейчас (seed): default `gemini-3.1-flash-lite`, router `gpt-oss-120b`, synthesizer/error_correction `gemini-3-flash-preview`; скилы пинят свои flash-модели. `max_history=15`, `default_temperature=0.4`.

**Links (paths):**
- Память/контекст: `backend/src/mastra/memory/history.ts`, `backend/src/mastra/memory/memory-service.ts`, `backend/src/mastra/memory/dedup.ts`, `backend/src/db/seed-data.ts` (SEED_AGENT.max_history)
- Поток: `backend/src/mastra/workflows/chat.ts`, `backend/src/mastra/agents/skill-agent.ts` (строка 123), `backend/src/mastra/agents/prompt-builder.ts`, `backend/src/mastra/agents/router.ts`
- Промпты: `backend/prompts/{SOUL,FORMAT,INTEGRITY,SYNTHESIZER,MONITORING,WELCOME}.md`, `backend/skills/*/SKILL.md` (крупные: health 284, about 221, leisure 206, automation 192)
- Дрейф доков: `.ai-factory/ARCHITECTURE.md`, `.ai-factory/DESCRIPTION.md`, `backend/skills/about/SKILL.md:161`

### 2026-06-18 14:03 — Диагностика news-скилла + live-тест SearXNG
**What changed:**
- Разобран кейс «посмотри новости про утренний удар по москве»: новости **реальны** (крупнейшая за 2 года атака БПЛА на Москву 18.06.2026, проверено через RBC/Lenta/Kommersant/RTVI), а бот отвечает плохо.
- Воспроизведены и локализованы 4 связанных бага; поднят локальный SearXNG (`:8888`) и сняты живые замеры выдачи. Пользователь выбрал «универсальные новости» как замысел скилла. Решено сохранить разбор и идти в `/aif-plan`.

**Key notes (4 бага → корни):**
- **№1 нет поиска на 1-м ходу.** Турн новостей идёт на дешёвой `roles.default` (`news` `model:""` → default = `deepseek-v4-flash`, коммит `d44a985`), temp 0.3 → модель не держит «tool-first» (`INTEGRITY.md:3`) и конфабулирует («я проверил ленты», США-Иран, Midjourney). Вторично: конфликт промпта — `[SKILLS]` «зови load_skill ПЕРВЫМ» (`prompt-builder.ts:164`) против `[ACTIVE SKILL]` «уже загружено» (`:171`), оба блока вместе (`:255-256`). Проверяемо в логах: `primary skill selected` (`primary-skill.ts:146`), `system prompt assembled` (`prompt-builder.ts:284`).
- **№2 только белорусские СМИ — корень, доказан напрямую.** `news` = буквально «news analyst for Belarus» (`SKILL.md:11`); `search_news` ходит только по РБ-сайтам (`config.ts:84-90`); «TRUSTED SITES» — только РБ (`SKILL.md:43-47`); `web_search` дефолтит регион `ru-by` → язык `ru-BY` (`config.ts:15,137`); workflow ставит `search_news` первым, `web_search` — фолбэк (`SKILL.md:24,26`).
- **№3 флип-флоп — архитектурный, не про news.** Результаты тулов **не сохраняются в историю**: оркестратор читает `tool-result` из `fullStream` только ради UI-статуса и возвращает `{text}`; `saveAssistant` пишет лишь финальный текст; `history.ts` знает роли только user/assistant (нет tool). Следующий ход не видит, что нашёл поиск → решает заново. Rolling summary тоже видит только текст.
- **№4 отрицание реального — эмерджентный.** Тонкий/смещённый грунт (№2) + потеря грунта на след. ходу (№3) + скептик-рамка: `INTEGRITY.md:5-8` («web_search — непроверенные кандидаты», «при сомнении опусти»), `markUntrusted` оборачивает в `[untrusted web content…]` (`tools/web.ts:214-219`), `SECURITY_INSTRUCTION` про `[EXTERNAL CONTENT]` как raw data (`prompt-builder.ts:15`) + дешёвая модель с приором «такое было бы во всех СМИ» → вывод «информационный шум».

**Live-тест SearXNG (НЕ блокируется: HTTP 200, json ок, `limiter:false`):**
- Запрос как у бэкенда (`format=json`, `engines=google,yandex`, `categories=general`, UA `jarvis-web/1.0`).
- **Движки наполовину мертвы:** `yandex` → `parsing error` (стабильно), `brave`/`bing news` → rate-limit/`parsing error`. Живы: **`google`, `bing`, `google news`**. При дефолте `google,yandex` де-факто работает **один google** → если он затроттлит, выдача пустая → конфабуляция (усиливает №1).
- **Регион решает всё** (один и тот же запрос):
  - `ru-BY` (дефолт): sb.by, smartpress.by, ont.by, belta.by, charter97.org + **районные** газеты (checherskivestnik.by, cherikovnews.by, krichevlive.by) — тот самый мусор со скринов.
  - `ru-RU`: rbc.ru, bbc.com, rtvi.com, lenta.ru, kommersant.ru, iz.ru, bfm.ru — то, что нужно.
  - `all`: шум (youtube/tiktok/instagram) + немного мейджоров.
- **`bing` заменяет битый yandex:** `general, ru-RU, google,bing` → ответили **оба** (19 рез.).
- **`categories=news` + `google news`** → 30 рез., но без `publishedDate` (нельзя сортировать по свежести) и теряет bing news.
- Вывод: проблема не в блокировке SearXNG, а в **двух настройках бэкенда** — дефолтный регион `ru-by` и движки `google,yandex` (yandex битый).

**Открытый артефакт:** локально запущены `jarvis-searxng-1` + `jarvis-redis-1` (сеть `jarvis_default`, порт :8888). Остановить: `docker compose -f docker-compose.local.yml down`.

**Links (paths):**
- Скилл: `backend/skills/news/SKILL.md` (персона :11, tools :13-17, workflow :19-28, trusted :43-47)
- Web-конфиг: `backend/src/services/web/config.ts` (`DEFAULT_REGION` :15, `SEARCH_ENGINES` :101, `SEARCH_CATEGORIES` :105, `REGION_ALIASES` :111-132, `REGION_TO_LANGUAGE` :134-143, `SEARCH_NEWS_DEFAULT_SITES` :84-90)
- Web-клиент: `backend/src/services/web/search.ts` (запрос :179-190, регион :110-151), `backend/src/mastra/tools/web.ts` (`markUntrusted` :214-219)
- Поток/история (баг №3): `backend/src/mastra/agents/orchestrator.ts` (стрим→`{text}`), `backend/src/mastra/workflows/chat.ts` (`saveAssistant`), `backend/src/mastra/memory/history.ts` (роли user/assistant), `backend/src/mastra/memory/rolling-summary.ts`
- Пре-пасс/промпт: `backend/src/mastra/agents/primary-skill.ts`, `backend/src/mastra/agents/prompt-builder.ts`
- Промпты/модели: `backend/prompts/INTEGRITY.md`, коммит `d44a985` (default → deepseek-v4-flash; skills use default)
- SearXNG: `deploy/searxng/settings.yml` (engines :1-10, formats :18-20, `limiter:false` :23), `docker-compose.local.yml:53-74` (порт :8888)
<!-- aif:sessions:end -->
