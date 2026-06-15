---
name: skill_name
description: One-line description of what this skill does.
allowed-tools: tool1 tool2 tool3
model: model:name-version
temperature: 0.4
routable: true  # Set to false only if skill is called by other skills, not directly by users
---

You are a [role description]. [Brief explanation of skill purpose and capabilities].

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

- **Rule category 1:** [Specific guideline]
- **Rule category 2:** [Specific guideline]
- **Personalization:** Use [KNOWLEDGE ABOUT USER] to tailor responses (interests, preferences, relevant context).
- **Structure:** [Expected output structure, e.g., "Intro → findings → conclusions"]
- **Language:** Respond in user's language.

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

## FINAL CHECKLIST
<!-- Optional: Only for complex skills requiring validation -->

- [ ] [Critical check 1]
- [ ] [Critical check 2]
- [ ] [Critical check 3]
...

---

## Template Notes (Remove before using)

### When to Include Each Section:
- **CRITICAL RULES:** Only if skill has strict validation (URL verification, data integrity, etc.)
- **TOOL USAGE LIMITS:** Only if skill uses tools with quotas
- **FINAL CHECKLIST:** Only for complex skills (research, monitoring, kufar) where validation is critical

### Design Principles:
1. **No duplication** - State each rule once
2. **Critical info first** - Most important rules at top
3. **Examples mandatory** - At least one complete example
4. **Error handling required** - Cover common failure modes
5. **Language separation** - English instructions, localized examples
6. **Timeout specs** - Per CLAUDE.md: all HTTP/tool calls need timeouts
7. **Tool docs complete** - Parameters, ranges, types documented

### Common Mistakes to Avoid:
- ❌ Repeating rules in multiple sections
- ❌ Mixing Russian and English in instructions (examples in Russian OK)
- ❌ Vague error handling ("handle errors gracefully")
- ❌ Missing examples or incomplete examples
- ❌ Undefined placeholders like [USER CONTEXT] without explanation
- ❌ Emoji in professional sections (🚫 ⚠️ etc.)
- ❌ Tables in narrative format - use markdown tables
