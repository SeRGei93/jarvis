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
  images?: { data: Uint8Array; mediaType: string; width?: number; height?: number }[],
): Promise<{ text: string; skills: string[]; rejected: boolean; confirmations?: {...}[] }>
```

`onText` receives the accumulated answer on every token, so the Telegram layer can throttle its streaming draft. `onTool` surfaces live tool activity ("🔎 searching…"). `rejected: true` means promptguard (or the vision-capability gate) blocked the message and no model was called. `confirmations` lists any risky-tool approvals the turn requested (see [Tool approval](#tool-approval-risky-tools)). `images` carries the current turn's image bytes (Telegram photos/documents) — see [Images (vision)](#images-vision).

## The turn, step by step

```
text ─▶ promptguard ─▶ loadContext ─▶ rate-limit ─▶ history + memories ─▶ pre-pass ─▶ orchestrator.stream
                                                                          (primary)      │  load_skill ⇄ skill tools
              confirmations ◀── persist (user + assistant) ◀── record usage ◀───────────┘
                                                  │
                                        onboarding auto-complete
```

1. **promptguard** — `validateUserMessage(text)` normalizes the text (Unicode NFKC + strip zero-width/control chars) then checks length + injection. On failure the workflow returns the canned `userMessage` and stops (no model call). See [Security](#guardrails). Image-only messages (no caption) skip this text check; empty text **without** images is still rejected.
2. **conversation-context** — `loadContext(...)` loads the `User`, gets-or-creates the `Session`, loads the optional `BotIdentity`, and resolves the Mastra thread / resource ids.
3. **rate-limit** — `RateLimitService.checkAndConsume(userId)` enforces the hourly plan window. Un-onboarded users are bypassed; over the limit the turn is rejected. See [Configuration](configuration.md#plans-rate-limit-and-usage).
4. **history + previousSkills** — `getRecentMessages(...)` reads the last `agent.max_history` messages; `derivePreviousSkills(...)` collects skill tags from prior assistant turns (newest-first). `MediaService.hydrate(recent)` re-attaches a bounded set of historical images as bytes, so a text-only follow-up ("что было на фото?") still counts as a multimodal turn for model selection. The current user message is persisted **after** the turn model resolves (so a vision-capability refusal leaves no history row), storing only image refs (`{id, mediaType}`) plus the text.
5. **memories + prompts** — `MemoryService.loadRelevant(userId)` returns the user's long-term facts (capped at 50, loaded whole — no vector/RAG, M13); the SOUL/FORMAT/INTEGRITY bodies load from the file-backed prompt store via `SkillService`.
6. **pre-pass** — `PrimarySkillSelector.selectPrimary(...)` picks ONE primary skill. With a `model_roles.decision` model configured it first asks the **decision layer** (`DecisionService.choose`) — one typed System One call over the routable catalog, argmax over probabilities, ~$0.000003 and no generation. Anything unusable (role empty, non-OpenRouter ref, refusal, error, unknown skill id) falls through to the cheap `roles.router` `generateObject` classification. If the user is not onboarded, `onboarding` is forced (no model call). `resolveTurnConfig(...)` then resolves the turn's model (session override → primary skill's model → `roles.default`; turns carrying images — current **or** hydrated from history — prefer `model_roles.vision` when set), temperature, and reasoning. For image-bearing turns a cache-only capability check (`ModelsCatalog.supportsVision`) refuses a message with new images when the catalog positively says the model cannot take images; a text-only follow-up with history images instead drops those historical parts, so a non-vision turn model keeps working. An unknown (cold/expired) catalog never blocks.
7. **orchestrator** — `Orchestrator.run(...)` streams one agent turn (see [The orchestrator](#the-orchestrator)). Any failure degrades to a user-facing fallback instead of throwing.
8. **record usage** — `UsageService.recordUsage(userId, cost)` accumulates the turn's cost + request count.
9. **persist** — the assistant reply is saved to Mastra Memory, tagged with the primary skill.
10. **rolling summary** — best-effort: history beyond `agent.max_history` is folded into the per-session summary (`sessions.summary`). Uses the `roles.synthesizer || roles.default` model.
11. **opportunistic memory** — best-effort, onboarded users only, gated by `agent.auto_memory`: `FactExtractor` saves durable facts mentioned in passing, routed through `MemoryService.save`.
12. **onboarding auto-complete** — once the message count reaches `4`, `ProfileExtractor.applyOnboarding(...)` fills empty user fields, marks the user onboarded, and upserts the bot identity.
13. **confirmations** — pending risky-tool confirmations created this turn are returned in `confirmations` for the UI to render approve/decline buttons (see [Tool approval](#tool-approval-risky-tools)).

## Images (vision)

An incoming Telegram photo or image document becomes a normal multimodal turn — there is **no separate vision agent**:

```
bytes ─▶ MediaService.saveMany ─▶ refs in content.metadata.images
      └▶ orchestrator (current user message: image parts + text)
history refs ─▶ MediaService.hydrate ─▶ orchestrator (image parts, bounded)
```

- **Bytes on disk, refs in history.** `MediaService` (`src/services/media-service.ts`) writes content-addressed files (`MEDIA_DIR/<sha256[0..2]>/<sha256>.<ext>`, deduplicated by hash, atomic write) and returns `{ id, mediaType, width?, height? }`. Mastra Memory stores only those refs — never base64 — because `getRecentMessages` reads the whole thread on every turn.
- **Bounded re-attach.** Follow-ups like "а что на фото?" work because `hydrate` re-attaches images from the **last 2 user messages**, at most **4 images** and **12 MB** per turn. `stat` is checked before reading, so an oversized file never costs a full read. Because those parts ride along on later turns, a text-only follow-up is routed to the `vision` role too; if the resolved model positively cannot take images, the historical parts are dropped (logged) instead of failing the request.
- **Current turn.** The bytes go to the orchestrator directly (`userImages`), not re-read from disk. The orchestrator builds AI SDK image parts (`{ type: "image", image: Uint8Array, mediaType }`, images first, text last); Mastra converts them to file parts with data URIs for the provider. A turn is capped at 4 images for both storage and the model request.
- **Model choice.** Image-bearing turns (current message or hydrated history) use `model_roles.vision` when set, else the normal chain (session override → skill model → `roles.default`). `ModelsCatalog.supportsVision(ref)` is **cache-only**: `false` (positively text-only) → friendly refusal before storing/calling for a message with new images, or drop history images on a text follow-up; `undefined` (cold/expired catalog, non-OpenRouter ref, unknown id) → proceed.
- **Image-only messages.** An empty caption becomes the internal placeholder `[изображение]` for the pre-pass, summary, onboarding and history. `FactExtractor` is skipped (the placeholder is not a fact).
- **Limits & retention.** 10 MB per image, 4 images per turn, MIME whitelist `image/jpeg|png|webp` (GIF is deliberately unsupported); files older than 7 days are pruned best-effort on startup and every 24 h. Only files owned by the store (content-addressed images and their `*.tmp` writes) are ever deleted — a misconfigured `MEDIA_DIR` cannot turn retention into a recursive delete. A media-store failure is logged and the turn continues (the current bytes still reach the model).
- **Security.** Image pixels are not scanned: text inside a picture can be a prompt-injection vector. The bot is a trusted personal assistant, so no OCR filter is applied — treat model output derived from images as untrusted like any other model output. `file_id`/token-bearing URLs are never logged.

## The orchestrator

`src/mastra/agents/orchestrator.ts` builds ONE standalone `@mastra/core` `Agent` (not registered on a `Mastra` instance) whose `instructions`/`model`/`tools` are **functions of a per-request `RequestContext`** — values are assembled in `run()` from `SettingsService`/`SkillService`, preserving DI and DB-backed config. History/memories/summary are passed as messages we build ourselves (no `Agent.memory`).

- **Progressive skills (`load_skill`).** ALL skill tools are registered up front (AI SDK can't add tools mid-generation). The live set is gated per step via `prepareStep → activeTools`: only `load_skill`, the loaded skills' `allowed-tools`, and the always-active MCP tools are exposed. Calling `load_skill(name)` returns that skill's full `SKILL.md` instructions + reference list and adds it to the turn's loaded set, so the next step widens the active tools. The pre-pass's primary skill starts pre-loaded. Mirrors Claude Code's progressive skill model — Mastra's native `Workspace` skills were evaluated and not adopted (they load instructions but don't gate tools).
- **MCP tools.** The admin-managed HTTP MCP snapshot (`McpManager.getTools()`) is taken **once per turn** and merged into the registered set last (a built-in wins a name collision; MCP `load_skill` is dropped). MCP tool names are passed to `activeToolNames` as always-active extras, so they are callable from step 0 without loading a skill. See [MCP](mcp.md).
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
| `agents/primary-skill` | decision fast path (optional) → else cheap `roles.router` classification → ONE primary skill; forces `onboarding`, falls back to `research`; resolves the turn's model/temperature/reasoning |
| `decisions/` | `DecisionService` over Mastra `Classifier` → OpenRouter System One: `choose` / `judge` helpers, null-on-any-failure, 10 s timeout, 20 k state cap |
| `agents/orchestrator` | the single dynamic `Agent`; assembles the per-request prompt/model/tools, gates tools via `prepareStep`, streams `fullStream`, keeps the AbortSignal watchdog + post-stream strip |
| `tools/load-skill` | `load_skill(name)` tool + `activeToolNames`/`buildSkillToolMap` for the per-step gate |
| `mcp/manager` | admin-managed HTTP MCP servers: config → SDK client → discovery + per-server status |
| `confirmations/confirmation-service` | confirm-before-execute for risky tools (create / listPending / resolve) |
| `agents/skill-agent`, `agents/loop-guard` | retained for the admin skill test-run only (not the chat path) |

## History I/O

`mastra/memory/history.ts` stores conversation turns in Mastra Memory (`mastra_threads` / `mastra_messages`):

- `ensureThread(...)` — create the thread if missing.
- `saveUserMessage(..., text, images?)` / `saveAssistant(..., skill)` — persist a turn; the assistant's primary skill is stored in message metadata, a user turn's image refs in `content.metadata.images`.
- `getRecentMessages(..., limit)` — read back the last `limit` turns as domain `Message[]` (feeds `derivePreviousSkills` and `MediaService.hydrate`). Malformed image metadata is ignored, never fatal.

## See Also

- [Architecture](architecture.md) — where each module sits in the layering
- [Tools](tools.md) — every tool, `load_skill`, and tool approval
- [MCP](mcp.md) — admin-managed HTTP MCP servers
- [Configuration](configuration.md) — model roles and agent params that drive the pre-pass/orchestrator
