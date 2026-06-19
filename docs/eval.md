[← Getting Started](getting-started.md) · [Back to README](../README.md)

# Eval & Skill Test-Run

How `jarvis` is tested beyond unit tests: a **deterministic eval gate** (routing + scorer regressions, offline), a **skill test-run** you can trigger from the **admin Mini App** or the **CLI** (real model + real tools), and a **nightly LLM-judge** scaffold. All code lives in `backend/`.

There are three distinct things called "eval" here — keep them apart:

| What | Runs | Model / network | Blocking |
|------|------|-----------------|----------|
| **Deterministic eval gate** | `npm run eval` (and `npm test`) | none (offline) | ✅ yes |
| **Skill test-run** (Mini App / CLI) | on demand | real model + tools | no |
| **Nightly LLM-judge** | a future cron job | real judge model | no (scaffold) |

---

## 1. Deterministic eval gate — `npm run eval`

A **blocking regression net** for routing and the dedup/summary scorers. It feeds known `(input, output, groundTruth)` triples to deterministic scorers and asserts the scores. **No model, no network** — it is fast and runs inside `npm test` too.

- Harness: `backend/test/evals/eval.test.ts`
- Scorers: `backend/test/evals/scorers.ts` — `primarySkillChoice` (routing exact-match), `keywordCoverage` (memory/summary keyword recall), `contentSimilarity` (token-Jaccard, used as the dedup near-duplicate check)
- Routing corpus: `backend/test/evals/fixtures.ts` (`ROUTING_FIXTURES`) — RU + EN messages tagged with the skill they should route to
- Scorer shape pin: `backend/test/evals/scorer-smoke.test.ts`

```bash
cd backend
npm run eval        # just the eval suite (test/evals)
npm test            # full suite — includes the eval gate
```

It is a **routing/dedup regression net, not a model-quality test**: a fixture mislabeled by a routing change flips its score to 0 and fails the gate.

### Add a routing case

Append to `ROUTING_FIXTURES` in `backend/test/evals/fixtures.ts`:

```ts
{ id: "cars-ru-1", lang: "ru", userMessage: "найди ауди а4 на av.by", expectedSkill: "cars" },
```

The corpus assertions require ≥10 fixtures spanning ≥10 distinct skills, with both `ru` and `en` present.

---

## 2. Skill test-run (real model + real tools)

Runs **one non-streaming generation of a single skill** against a message, with that skill's tools, bounded by the `llm_request` watchdog. It behaves like the live single-skill path minus streaming and history. Shared entry point: `runSkillTest(deps, skill, message)` in `backend/src/admin/api/skills.ts` (→ `runSkillSubAgent`).

Because there is **no Telegram rich send**, the result is the model's **raw markdown** — so tool output, media markdown (`![](url)`, `Фото:` lines), tables and reasoning are visible verbatim. This makes it the go-to tool for debugging a skill or verifying tool output.

### From the admin Mini App

Skills screen → a skill's **«Тест-прогон»** modal → type a message → **Запустить**. The frontend (`frontend/src/screens/SkillsScreen.tsx`) calls:

```
POST /admin/api/skills/:name/test   { "message": "..." }  →  { text, usage: { cost } }
```

Auth is the usual `initData` HMAC + `ADMIN_USER_IDS` gate. This runs in the live process, so it uses the real DB settings, model roles and tools.

### From the CLI — `npm run skill:run`

The CLI analog of the Mini App test-run (`backend/src/cli/skill-run.ts`):

```bash
cd backend
npm run skill:run -- <skill> "<message>"

# examples
npm run skill:run -- currency "Сколько стоит доллар и евро сегодня?"
npm run skill:run -- cars "Найди на av.by Audi A4 B9 2019 дизель, покажи фото объявления"
npm run skill:run -- research "последние новости про ИИ"
```

It prints the raw answer to **stdout** and `[cost: $…]` plus progress to **stderr**. An unknown skill name lists the available skills.

**Environment.** It needs the same env as the bot: a migrated DB (`LIBSQL_URL`) with seeded settings, and a provider key (`OPENROUTER_API_KEY`). The entry script loads `.env` (repo root) *before* importing modules that read it, and never overwrites variables already set in the environment.

- **In the container / on the server** — env and the `/data` DB are already present, so it just works.
- **Locally** — point `LIBSQL_URL` at a seeded temp DB; the provider key is still read from the root `.env`:

  ```bash
  cd backend
  mkdir -p data
  LIBSQL_URL="file:./data/cli.db" npm run db:migrate
  LIBSQL_URL="file:./data/cli.db" npm run db:seed
  LIBSQL_URL="file:./data/cli.db" npm run skill:run -- cars "..."
  ```

  > A locally seeded DB carries **default** settings (e.g. the seed's default model role), not your production config.

Tool reachability still applies: `web_search` needs SearXNG (the container's `SEARXNG_URL`), while the av.by/kufar/etc. tools fetch their sites directly. The `cars` skill (av.by) therefore works locally without SearXNG.

---

## 3. Nightly LLM-judge (scaffold)

Subjective, token-costing **judge-backed** scorers (answer-relevancy, faithfulness, …) live in `backend/test/evals/nightly.ts`. It is intentionally **not** a `*.test.ts`, so vitest never picks it up and it never gates a PR.

`runNightlyEvals()` is a **scaffold**: it wires a judge scorer via `ModelFactory` (lazily, so importing the module touches no network) but currently **throws** — a real nightly runner (cron/CI) must fill in the per-fixture judge invocation and result collection before it is enabled. It is the place for model-quality evals, kept separate from the deterministic gate above.

---

## When to use which

- **Changed routing, dedup, or the summary keywords?** → `npm run eval` must stay green.
- **Built or edited a skill / tool and want to see the actual answer?** → skill test-run (CLI for the terminal, Mini App for non-developers).
- **Want graded model quality over a corpus?** → wire the nightly judge (not yet enabled).
