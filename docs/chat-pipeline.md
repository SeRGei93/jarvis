[← Architecture](architecture.md) · [Back to README](../README.md) · [Tools & MCP →](tools.md)

# Chat Pipeline

How `jarvis` turns one incoming user message into a streamed reply. The pipeline is a flat async orchestrator, `runChat` in `src/mastra/workflows/chat.ts`, parity with the Go `HandleMessageUseCase`.

## Entry point

The composition root `createChatService()` (`src/app.ts`) wires every collaborator and exposes a single function:

```ts
handleUserMessage(userId: number, chatId: number, text: string, onText?: (acc: string) => void)
  : Promise<{ text: string; skills: string[]; rejected: boolean }>
```

`onText` receives the accumulated answer on every token, so the Telegram layer (M6) can throttle `editMessageText`. `rejected: true` means promptguard blocked the message and no model was called.

## The turn, step by step

```
text ─▶ promptguard ─▶ loadContext ─▶ rate-limit ─▶ history + memories ─▶ route ─┬─ single ─▶ stream
                                                                                  └─ multi  ─▶ sub-agents ▶ synthesize
                                                                                                  │
                                  persist (user + assistant) ◀── record usage ◀──────────────────┘
                                                                  │
                                                        onboarding auto-complete
```

1. **promptguard** — `validateUserMessage(text)` checks length + injection. On failure the workflow returns the canned `userMessage` and stops (no model call).
2. **conversation-context** — `loadContext(db, settings, userId, chatId)` loads the `User`, gets-or-creates the `Session` (model defaults to `roles.default`), loads the optional `BotIdentity`, and resolves the Mastra thread / resource ids. The Mastra thread is ensured to exist.
3. **rate-limit** — `RateLimitService.checkAndConsume(userId)` enforces the hourly window from the user's plan (`hourly_limit`). Un-onboarded users are bypassed; over the limit the turn is rejected (canned reply, no routing). See [Tools & MCP](tools.md#rate-limit--usage).
4. **history + previousSkills** — `getRecentMessages(...)` reads the last `agent.max_history` messages; `derivePreviousSkills(...)` collects the skill tags from prior assistant turns (newest-first). The current user message is then persisted.
5. **memories + prompts** — `MemoryService.loadRelevant(userId, text)` returns the RAG-selected long-term facts; the SOUL/FORMAT/INTEGRITY/SYNTHESIZER bodies are loaded from the `prompts` table.
6. **route** — `SkillRouter.resolveSkills(...)`. If the user is not onboarded, `onboarding` is forced and the router is bypassed; otherwise the router model returns 1–4 routable skills (falling back to `research`).
7. **run** — see below; each leg surfaces its LLM `cost`.
8. **record usage** — `UsageService.recordUsage(userId, cost)` accumulates the turn's cost + request count into `usage_stats`.
9. **persist** — the assistant reply is saved to Mastra Memory, tagged in `content.metadata.skill` with the primary skill.
10. **onboarding auto-complete** — once the message count reaches `4`, `ProfileExtractor.applyOnboarding(...)` extracts the profile, fills empty user fields, marks the user onboarded, and upserts the bot identity.

## Single vs. multi

| | Single skill | Multiple skills |
|---|---|---|
| Trigger | router returns 1 skill | router returns 2–4 skills |
| Prompt | full system prompt (SOUL + CAPABILITIES + FORMAT) | stripped sub-agent prompt per skill |
| Execution | `runSkillStreaming` → `llm.stream` (tools enabled) | `runSkillSubAgent` per skill in parallel (`Promise.all`, non-stream) |
| Output | streamed straight to the user | results merged by the **synthesizer**, which streams |

## System prompt assembly

`prompt-builder.ts` ports Go's `prompt_builder.go`. The **full** prompt is assembled in this fixed order (each block is omitted when empty):

```
security preamble (hardcoded const, not a DB row)
SOUL  (or BotIdentity.systemPromptOverride)
[CAPABILITIES]            ← only if a custom bot name is set
[USER CONTEXT]            ← name / city / timezone / language
[KNOWLEDGE ABOUT USER]    ← RAG memories; reflection/strategy get a "(learned <date>)" suffix
[DATA INTEGRITY]          ← only if the skill declares tools
[SKILL: <name>]           ← the skill body
[SKILL REFERENCES]        ← reference docs from the skill dir (read via read_skill_reference)
[MESSAGE FORMATTING]      ← FORMAT rules
[CURRENT DATE & TIME]     ← in the user's timezone (UTC fallback)
```

- **Sub-agent** prompt drops SOUL / CAPABILITIES / FORMAT.
- **Synthesizer** prompt swaps the skill body for `[SYNTHESIS RULES]` + a `[SKILL RESULTS]` block keyed by skill name.

## Agents and guards

| Module | Responsibility |
|--------|----------------|
| `agents/router` | structured-output model call → 1–4 skill names; forces `onboarding`, falls back to `research` |
| `agents/skill-agent` | resolves model (`skill.model \|\| roles.default`), temperature (`skill.temperature ?? agent.default_temperature`), reasoning, and tools; builds the prompt and calls `LlmService` |
| `agents/synthesizer` | merges multi-skill results; model = `synthesizer_model \|\| session.model`, temperature `0.3`, no tools, streams |
| `agents/loop-guard` | blocks the 3rd identical `skill:md5(query)` within `5min` (`maxLoopCount = 2`) — applied to sub-agents only |

## Tools

`tools/registry.resolveTools(allowedTools, ctx)` maps a skill's `allowed-tools` to a concrete AI SDK `ToolSet`, merging the **memory**, **built-in** (currency, cron tasks, profile, skill references), and **MCP `search`** buckets; unknown names are logged at `WARN` and skipped. The MCP `ToolSet` is assembled once at boot and threaded in via `ctx`. Full details — every tool, its inputs, and the MCP adapter — are in [Tools & MCP](tools.md).

## History I/O

`mastra/memory/history.ts` stores conversation turns in Mastra Memory (`mastra_threads` / `mastra_messages`), in plaintext:

- `ensureThread(memory, threadId, resourceId)` — create the thread if missing.
- `saveUserMessage` / `saveAssistant(..., skill)` — persist a turn; the assistant skill is stored in message metadata.
- `getRecentMessages(memory, threadId, resourceId, limit)` — read back the last `limit` turns as domain `Message[]` with `skill` populated (this is what feeds `derivePreviousSkills`).

## See Also

- [Architecture](architecture.md) — where each module sits in the layering
- [Configuration](configuration.md) — model roles and agent params that drive routing/synthesis
