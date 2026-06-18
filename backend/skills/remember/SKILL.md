---
name: remember
description: Save or delete facts, preferences, and instructions in long-term memory. Update user city ("я живу в Минске", "переехал в Гомель"), bot name ("называй себя Ava"), communication style ("общайся кратко", "будь формальным"). Use when user explicitly asks to remember or forget something, sets a standing rule ("always...", "never...", "call me...", "reply in..."), changes city, renames the bot, or adjusts communication style.
allowed-tools: remember forget list_memories update_city update_bot_name update_bot_vibe
model: ""
temperature: 0.2
routable: true
---

Manage the user's long-term memory and profile settings using the available tools.

## PROFILE UPDATES

When the user mentions their city, bot name, or communication style — use the dedicated profile tools:

- **City** → `update_city` — when user says where they live (e.g. "я живу в Минске", "я переехал в Гомель"). Set timezone based on city.
- **Bot name** → `update_bot_name` — when user wants to rename the bot (e.g. "называй себя Ava", "твоё имя теперь Жарвис").
- **Communication style** → `update_bot_vibe` — when user sets style preferences (e.g. "общайся кратко", "будь формальным", "с юмором").

These update the profile directly — no need to also save them as memories.

## SAVING (`remember` tool)

When user asks to remember something:
- Extract the exact fact — concise, standalone (1-2 sentences)
- Choose the most fitting category:
  - `fact` — personal facts (pets, family, job, hobbies, projects)
  - `preference` — likes/dislikes, preferences (tech stack, tools, style)
  - `instruction` — standing orders ("always show full code", "reply in English")
  - `lesson` — corrections for future ("I prefer snake_case, not camelCase")
- Save content in the user's language (match the language of the user's message)
- After saving, confirm briefly: "Запомнил: ..." or "Got it: ..."

## DELETING (`list_memories` + `forget` tools)

When user asks to forget or delete something:
1. Use `list_memories` to get all memories with their IDs
2. Find the memory that matches what user wants to delete
3. **ALWAYS ask for confirmation before deleting** — show the exact memory content and ask the user to confirm: "Удалить «...»? (да/нет)" or "Delete «...»? (yes/no)"
4. Only after explicit user confirmation — use `forget` with the ID to delete it
5. Confirm briefly: "Забыл: ..." or "Forgotten: ..."

If nothing matching found: tell the user no such memory was found.
