---
name: skill_name
description: One-line description of what this skill does.
allowed-tools: tool1 tool2 tool3
model: model:name-version
temperature: 0.4
routable: true  # Set to false only if skill is called by other skills, not directly by users
---

You are a [role description]. [Brief explanation of skill purpose and capabilities].

<!-- The system prompt already injects these globally — do NOT repeat them in a skill:
     • SOUL — persona, "respond in the user's language", regional defaults (BYN, Minsk, Беларусь)
     • INTEGRITY — tool-first, facts/URLs from tools only, verify before citing (shown when the skill has tools)
     • FORMAT — Telegram markdown house style (tables/lists/blockquote/highlight)
     • [USER CONTEXT] / [KNOWLEDGE ABOUT USER] / [CONVERSATION SUMMARY] context blocks
     A skill carries only its OWN domain knowledge (slugs, tool params, sources) and output shape. -->

## [CRITICAL RULES SECTION]
<!-- Optional: Only include if skill has strict validation requirements -->
<!-- Example: URL validation for research/kufar/monitoring skills -->

**[MAIN RULE STATEMENT]**

1. **Rule 1** → [consequence/requirement]
2. **Rule 2** → [consequence/requirement]
...

## AVAILABLE TOOLS

<!-- Document all tools listed in allowed-tools metadata -->

### 1. tool_name
[Brief description of what the tool does]
**Params:** `param1` (required, type/range), `param2` (optional, default value)

### 2. another_tool
[Brief description]
**Params:** `param1` (required), `param2` (optional, range: X-Y)

**Note:** [Common parameter notes, e.g., "Use `count` not `limit`", "Timeout defaults to 30s"]

## WORKFLOW

1. **Step 1** — [action and purpose]
2. **Step 2** — [action and purpose]
3. **Step 3** — [action and purpose]
...

## TOOL USAGE LIMITS

<!-- Optional: Only if skill uses tools with quotas/limits -->

| Tool | Max Calls | Notes |
|------|-----------|-------|
| tool1 | N | [Constraint explanation] |
| tool2 | M | [Constraint explanation] |
| **Total tools** | **X** | [Balance/distribution guidance] |
| **Response length** | **Y chars** | [Conciseness guidance] |

## CONTENT RULES

<!-- Skill-specific only. Do NOT add "respond in user's language" or a generic
     "use [KNOWLEDGE ABOUT USER]" — those are global. Add a personalization bullet
     ONLY when the skill uses the user's context in a specific way (e.g. news ranks
     items by the user's profession; weather defaults to the user's city). -->
- **Rule category 1:** [Specific guideline]
- **Structure:** [Expected output structure, e.g., "Intro → findings → conclusions"]

## ERROR HANDLING

<!-- MANDATORY: Every skill must have error handling guidance -->

- **Scenario 1:** [Action to take, e.g., "Tool call fails → explain why, suggest alternative"]
- **Scenario 2:** [Action to take, e.g., "No results found → broaden criteria, try different approach"]
- **Scenario 3:** [Action to take, e.g., "Invalid input → ask user for clarification"]
- **Timeout:** [Action if tool times out, e.g., "If tool timeout → discard, try next source"]

## RESPONSE FORMAT

### Structure
- [Part 1 name and purpose]
- [Part 2 name and purpose]
- [Part 3 name and purpose]

### Summary Section
<!-- Language-adaptive summary guidance -->
End with a summary section (adapt to user's language):
- Russian: **Итоги** or **Выводы**
- English: **Summary** or **Conclusions**
- Other: Use appropriate equivalent

[Guidance on what summary should contain, e.g., "Synthesize findings and answer 'So what?'"]

### Format Template
<!-- Show exact format using markdown -->
```
**[Headline or Key Point]**
[Brief explanation (1-2 sentences)]
[Date/Time/Source if applicable]
[Link](https://example.com) <!-- Only if verified -->
```

### Example Output
<!-- MANDATORY: Provide at least one complete realistic example -->
```
[Complete example showing:
- Proper structure
- Tone and style
- Language usage
- All required elements]

**[Summary Section Title]**
[Summary text demonstrating synthesis and insights]
```

## BEFORE SENDING
<!-- Rarely needed. ONE short sentence, only where a cheap model genuinely needs an
     anchor (e.g. URL verification). NOT a multi-item checklist, and never restate
     the global INTEGRITY rules. Most skills omit this section entirely. -->

[One short anchor, e.g. "Drop any link you did not open with fetch_url."]

---

## Template Notes (Remove before using)

### When to Include Each Section:
- **CRITICAL RULES:** Only if skill has strict validation (URL verification, data integrity, etc.)
- **TOOL USAGE LIMITS:** Only if skill uses tools with quotas
- **BEFORE SENDING:** Rarely — one line, only where a cheap model needs a verification nudge

### Design Principles:
1. **Don't repeat global prompts** - SOUL/INTEGRITY/FORMAT and the [USER CONTEXT]/[KNOWLEDGE ABOUT USER]/[CONVERSATION SUMMARY] blocks are injected automatically. Carry only the skill's own domain knowledge and output shape.
2. **No duplication** - State each rule once
3. **Critical info first** - Most important rules at top
4. **One example is plenty** - Don't pile on 4-6 near-identical examples
5. **Checklists are a last resort** - Modern models follow stated rules. At most a ONE-line "Before sending" anchor, only where a cheap model needs it. No multi-item self-evaluation checklists (they were written for weak models).
6. **Error handling** - Cover the common failure modes briefly
7. **Tool docs complete** - Parameters, ranges, types documented (this IS the valuable domain knowledge — keep it)

### Common Mistakes to Avoid:
- ❌ Repeating global rules (respond-in-language, facts/URLs-from-tools, format house-style) — they're injected
- ❌ Multi-item SELF-EVALUATION / FINAL CHECKLIST sections — they were for weak models
- ❌ Vague error handling ("handle errors gracefully")
- ❌ Mixing Russian and English in instructions (examples in Russian OK)
- ❌ Emoji in professional sections (🚫 ⚠️ etc.)
- ❌ Tables in narrative format - use markdown tables
