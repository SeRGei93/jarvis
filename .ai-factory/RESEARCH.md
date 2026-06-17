# Research

Updated: 2026-06-17 16:00
Status: active

## Active Summary (input for /aif-plan)
<!-- aif:active-summary:start -->
**Topic:** Повысить надёжность агента и качество «памяти контекста»; откалибровать промпты скилов под выросший тир моделей (писались для слабых моделей); убрать фактические ошибки и дрейф доков.

**Goal:** Агент дольше и полнее помнит контекст диалога и реже теряет факты о пользователе; промпты дешевле и чище без потери дисциплины на flash-моделях; доки и self-описание агента соответствуют реальному коду.

**Constraints:**
- Скилы крутятся на **flash/дешёвых** моделях (`deepseek-v4-flash`, `gemini-3-flash`, `qwen3.5-flash`, роутер `gpt-oss-120b`) → защитные «якоря» дисциплины (особенно проверка URL) **не срезать подчистую**.
- **Доменное знание** в скилах (slugs специальностей 103.by, city-slugs gismeteo, шаблоны таблиц вывода, параметры тулзов, региональные источники) **НЕ трогаем** — режем только дубли с глобальными промптами и чек-листы.
- Стек-инварианты: ESM/NodeNext (`.js`), инъектируемость (тесты без сети), watchdog/timeout на каждый LLM/HTTP-вызов, миграция при изменении схемы.
- Отход от Go-паритета допустим (прецедент M13), но фиксируется в `CLAUDE.md`.

**Decisions (приоритизированный бэклог):**
- **ВЫСОКИЙ рычаг — память/надёжность:**
  1. `max_history` 15 → 40–60 (`seed-data.ts` SEED_AGENT) + опц. rolling-summary старого хвоста. Сейчас `createConversationMemory`: `lastMessages:15, semanticRecall:false, workingMemory:false` — за окном всё теряется.
  2. Отдавать историю мульти-скил суб-агентам. `skill-agent.ts:123` сейчас даёт воркеру только текущее сообщение (одиночный скил историю получает, мульти — нет).
  3. Оппортунистическое сохранение фактов (LLM сам решает) поверх `remember`+онбординга; дедуп уже есть (`LlmDedupChecker`). Пересмотр Go-паритета «no auto-extraction».
- **СРЕДНИЙ — дешевле/чище (не «надёжнее»):**
  4. Вычистить дубли скилов с `INTEGRITY.md`/`SOUL.md`/`FORMAT.md` (facts-from-tools, URLs-exact, respond-in-language, use-[KNOWLEDGE]).
  5. Убрать `SELF-EVALUATION`/`FINAL CHECKLIST` на дешёвых скилах → оставить 1 короткий якорь. Калибровать многословие под тир модели скила.
- **НИЗКИЙ — гигиена:**
  6. `about/SKILL.md:161` «written in Go» → TypeScript; синхронизировать `ARCHITECTURE.md`/`DESCRIPTION.md` с M11–M13 (вектор/RAG/embeddings уже удалены); добить `/new` cleanup осиротевших тредов; разобраться с мёртвыми категориями `reflection`/`strategy` в `prompt-builder.memoryContext`.

**Open questions:**
- Rolling-summary делаем в этом же заходе или сначала просто поднять `max_history` и измерить? Что из Mastra Memory включать (`workingMemory`?).
- Насколько агрессивно оппортунистическое сохранение: порог уверенности, какие категории, как не плодить мусор.
- Один общий план или фазами (память → промпты → гигиена)?
- `getRecentMessages` читает весь тред каждый ход (помечено в коде как риск) — чинить здесь же или отдельной задачей?

**Success signals:**
- В длинном диалоге агент ссылается на сказанное >15 сообщений назад.
- Мульти-скил фоллоу-апы не теряют контекст разговора.
- Факт, сказанный без «запомни», переживает `/new` (через оппортунистическое сохранение).
- `npm run typecheck` + `npm test` зелёные; LLM-вызовы под watchdog; инъекции сохранены (сеть в тестах не нужна).
- `about` не утверждает «Go»; доки `.ai-factory` соответствуют коду.

**Next step:** `/aif-plan full` — разложить по фазам: (1–3) память/контекст, (4–5) чистка промптов, (6) гигиена.
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
<!-- aif:sessions:end -->
