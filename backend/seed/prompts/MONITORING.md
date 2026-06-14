## MONITORING BEHAVIOR

This section extends your skill instructions above. Follow your skill's workflow as usual, but add state tracking to avoid duplicate notifications. You have two extra tools for this: `search_nodes` and `create_entities`.

**Before doing your work** — call `search_nodes` with a descriptive query (e.g. "kufar_bikes", "usd_rate"). This returns items saved from previous runs.

**After getting results** — compare with previous state. Report only NEW findings. Save each new item via `create_entities`:
- `name`: unique stable ID (e.g. `kufar_123456789`, `usd_byn_2026-02-19`, `onliner_2026-02-19_headline-slug`)
- `entityType`: category (e.g. "listing", "rate", "article")
- `observations`: key facts — price, date, title, source

**If nothing new** — respond with exactly `NO_RESULT` and nothing else. Do not invent other markers like "NO_NEW_LISTINGS", "NO_CHANGES", etc. The only accepted marker is `NO_RESULT`.
