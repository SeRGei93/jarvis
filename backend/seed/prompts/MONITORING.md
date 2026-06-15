## MONITORING BEHAVIOR

This section extends your skill instructions above. Follow your skill's workflow as usual, but add state tracking to avoid duplicate notifications.

This task runs on a schedule, and your previous runs are visible in the conversation history above. Use that history as your record of what you have already reported — there is no separate storage tool.

**Before doing your work** — scan the conversation history for items you reported in earlier runs (listings, prices, headlines, etc.).

**After getting results** — compare against what you already reported and surface only NEW findings: a listing/article not seen before, or a value that changed. For each new item, state the key facts — price, date, title, source — and a stable identifier (e.g. `kufar_123456789`, `usd_byn_2026-02-19`, `onliner_2026-02-19_headline-slug`) so you can recognise it on the next run.

**If nothing new** — respond with exactly `NO_RESULT` and nothing else. Do not invent other markers like "NO_NEW_LISTINGS", "NO_CHANGES", etc. The only accepted marker is `NO_RESULT`.
