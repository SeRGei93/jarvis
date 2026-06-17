[← Architecture](architecture.md) · [Back to README](../README.md) · [Tools →](tools.md)

# Chat Pipeline

How `jarvis` turns one incoming user message into a streamed reply. The pipeline is a flat async orchestrator, `runChat` in `src/mastra/workflows/chat.ts`. A single dynamic **Mastra `Agent`** (the orchestrator) answers in one voice and pulls in skills on demand — replacing the older router → N skills → synthesizer fan-out.

## Entry point

The composition root `createChatService()` (`src/app.ts`) wires every collaborator and exposes a single function:

```ts
handleUserMessage(
  userId: number,
  chatId: number,
  text: string,
  onText?: (acc: string) => void,
  onTool?: { onStart?(name): void; onFinish?(name): void },
): Promise<{ text: string; skills: string[]; rejected: boolean; confirmations?: {...}[] }>
```

`onText` receives the accumulated answer on every token, so the Telegram layer can throttle its streaming draft. `onTool` surfaces live tool activity ("🔎 searching…"). `rejected: true` means promptguard blocked the message and no model was called. `confirmations` lists any risky-tool approvals the turn requested (see [Tool approval](#tool-approval-risky-tools)).

## The turn, step by step

```
text ─▶ promptguard ─▶ loadContext ─▶ rate-limit ─▶ history + memories ─▶ pre-pass ─▶ orchestrator.stream
                                                                          (primary)      │  load_skill ⇄ skill tools
              confirmations ◀── persist (user + assistant) ◀── record usage ◀───────────┘
                                                  │
                                        onboarding auto-complete
```

1. **promptguard** — `validateUserMessage(text)` normalizes the text (Unicode NFKC + strip zero-width/control chars) then checks length + injection. On failure the workflow returns the canned `userMessage` and stops (no model call). See [Security](#guardrails).
2. **conversation-context** — `loadContext(...)` loads the `User`, gets-or-creates the `Session`, loads the optional `BotIdentity`, and resolves the Mastra thread / resource ids.
3. **rate-limit** — `RateLimitService.checkAndConsume(userId)` enforces the hourly plan window. Un-onboarded users are bypassed; over the limit the turn is rejected. See [Configuration](configuration.md#plans-rate-limit-and-usage).
4. **history + previousSkills** — `getRecentMessages(...)` reads the last `agent.max_history` messages; `derivePreviousSkills(...)` collects skill tags from prior assistant turns (newest-first). The current user message is then persisted.
5. **memories + prompts** — `MemoryService.loadRelevant(userId)` returns the user's long-term facts (capped at 50, loaded whole — no vector/RAG, M13); the SOUL/FORMAT/INTEGRITY bodies load from the file-backed prompt store via `SkillService`.
6. **pre-pass** — `PrimarySkillSelector.selectPrimary(...)` picks ONE primary skill via a cheap `roles.router` classification. If the user is not onboarded, `onboarding` is forced (no model call); an empty/unknown/failed pick falls back to `research`. `resolveTurnConfig(...)` then resolves the turn's model (session override → primary skill's model → `roles.default`), temperature, and reasoning.
7. **orchestrator** — `Orchestrator.run(...)` streams one agent turn (see [The orchestrator](#the-orchestrator)). Any failure degrades to a user-facing fallback instead of throwing.
8. **record usage** — `UsageService.recordUsage(userId, cost)` accumulates the turn's cost + request count.
9. **persist** — the assistant reply is saved to Mastra Memory, tagged with the primary skill.
10. **rolling summary** — best-effort: history beyond `agent.max_history` is folded into the per-session summary (`sessions.summary`). Uses the `roles.synthesizer || roles.default` model.
11. **opportunistic memory** — best-effort, onboarded users only, gated by `agent.auto_memory`: `FactExtractor` saves durable facts mentioned in passing, routed through `MemoryService.save`.
12. **onboarding auto-complete** — once the message count reaches `4`, `ProfileExtractor.applyOnboarding(...)` fills empty user fields, marks the user onboarded, and upserts the bot identity.
13. **confirmations** — pending risky-tool confirmations created this turn are returned in `confirmations` for the UI to render approve/decline buttons (see [Tool approval](#tool-approval-risky-tools)).

## The orchestrator

`src/mastra/agents/orchestrator.ts` builds ONE standalone `@mastra/core` `Agent` (not registered on a `Mastra` instance) whose `instructions`/`model`/`tools` are **functions of a per-request `RequestContext`** — values are assembled in `run()` from `SettingsService`/`SkillService`, preserving DI and DB-backed config. History/memories/summary are passed as messages we build ourselves (no `Agent.memory`).

- **Progressive skills (`load_skill`).** ALL skill tools are registered up front (AI SDK can't add tools mid-generation). The live set is gated per step via `prepareStep → activeTools`: only `load_skill` plus the loaded skills' `allowed-tools` are exposed. Calling `load_skill(name)` returns that skill's full `SKILL.md` instructions + reference list and adds it to the turn's loaded set, so the next step widens the active tools. The pre-pass's primary skill starts pre-loaded. Mirrors Claude Code's progressive skill model — Mastra's native `Workspace` skills were evaluated and not adopted (they load instructions but don't gate tools).
- **Streaming.** The loop drives off `agent.stream(...).fullStream`, branching on `text-delta` (→ `onText`), `tool-call` (→ `onTool.onStart`), and `tool-result` (→ `onTool.onFinish`). The watchdog resets on every chunk.
- **Watchdog / limits.** An `AbortSignal` idle watchdog (`timeouts.llm_activity`) + overall timeout (`timeouts.llm_request`) wrap the stream — Mastra has no built-in timeout. `maxSteps = 50` (an orchestrated turn does more tool steps than the old per-skill cap of 30); `maxRetries = 3`.
- **Leak cleanup.** `stripLeakedToolCalls` runs post-stream on the accumulated text (some models leak tool-call syntax into prose).

## System prompt assembly

`prompt-builder.ts` assembles the **orchestrator** prompt in this fixed order (each block omitted when empty):

```
security preamble (hardcoded const, not a DB row)
SOUL  (or BotIdentity.systemPromptOverride)
[CAPABILITIES]            ← only if a custom bot name is set
[USER CONTEXT]            ← name / city / timezone / language
[KNOWLEDGE ABOUT USER]    ← long-term facts (all, capped 50)
[CONVERSATION SUMMARY]    ← rolling summary of evicted history (when present)
[DATA INTEGRITY]          ← the orchestrator always carries tools
[SKILLS]                  ← compact catalog: "name: when to apply" + how to call load_skill
[ACTIVE SKILL: <name>]    ← the pre-pass's primary skill, pre-loaded
[SKILL REFERENCES]        ← reference docs of the pre-loaded skill
[MESSAGE FORMATTING]      ← FORMAT rules
[CURRENT DATE & TIME]     ← in the user's timezone (UTC fallback)
```

`buildSystemPrompt` / `buildSubAgentPrompt` remain for the **admin skill test-run** path (`/admin` runs a single skill via `skill-agent.ts`), which is independent of the chat orchestrator.

## Guardrails

- **Input** — `validateUserMessage` normalizes (NFKC, strips zero-width/control chars) *before* the injection-pattern check, so homoglyph / zero-width obfuscation can't slip past. No LLM.
- **Output** — `sanitizeMemoryContent` redacts PII (email / phone / card) before any memory is stored, on top of the ≤500-char cap.

## Tool approval (risky tools)

Destructive tools (`forget`, `task_delete`) don't act directly — they record a row in `pending_confirmations` (our own table, **not** Mastra suspend/resume snapshots) and return "awaiting confirmation". `runChat` surfaces new confirmations in `ChatResult.confirmations`; the Telegram layer shows ✅/❌ inline buttons (`cfm:a|d:<id>`). A button tap calls `ConfirmationService.resolve(userId, id, approved)` which runs the recorded action on approval. Resolution is scoped by `userId` and idempotent. See [Tools](tools.md#tool-approval).

## Routing safety net (evals)

`backend/test/evals/` holds a deterministic, offline eval harness (`npm run eval`): fixtures map messages → expected primary skill, scored with `createScorer` (`primarySkillChoice`, `keywordCoverage`, `contentSimilarity`) — no model/network, so it gates PRs for free. LLM-judge scorers (answer-relevancy) are a separate non-blocking nightly scaffold (`nightly.ts`).

## Agents and guards

| Module | Responsibility |
|--------|----------------|
| `agents/primary-skill` | cheap `roles.router` classification → ONE primary skill; forces `onboarding`, falls back to `research`; resolves the turn's model/temperature/reasoning |
| `agents/orchestrator` | the single dynamic `Agent`; assembles the per-request prompt/model/tools, gates tools via `prepareStep`, streams `fullStream`, keeps the AbortSignal watchdog + post-stream strip |
| `tools/load-skill` | `load_skill(name)` tool + `activeToolNames`/`buildSkillToolMap` for the per-step gate |
| `confirmations/confirmation-service` | confirm-before-execute for risky tools (create / listPending / resolve) |
| `agents/skill-agent`, `agents/loop-guard` | retained for the admin skill test-run only (not the chat path) |

## History I/O

`mastra/memory/history.ts` stores conversation turns in Mastra Memory (`mastra_threads` / `mastra_messages`):

- `ensureThread(...)` — create the thread if missing.
- `saveUserMessage` / `saveAssistant(..., skill)` — persist a turn; the assistant's primary skill is stored in message metadata.
- `getRecentMessages(..., limit)` — read back the last `limit` turns as domain `Message[]` (feeds `derivePreviousSkills`).

## See Also

- [Architecture](architecture.md) — where each module sits in the layering
- [Tools](tools.md) — every tool, `load_skill`, and tool approval
- [Configuration](configuration.md) — model roles and agent params that drive the pre-pass/orchestrator
