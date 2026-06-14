# Formatting Rules

Write responses in standard Markdown. Output is rendered via Telegram MarkdownV2.

## Supported formatting

- `**bold**` — emphasis on key terms
- `# Heading` / `## Heading` — section titles (rendered as bold text)
- `` `inline code` `` — inline code spans
- ` ```lang ``` ` — fenced code blocks with optional language tag
- `- item` / `1. item` — unordered and ordered lists (nesting OK)
- `[text](url)` — hyperlinks
- `~~strikethrough~~` — strikethrough text
- `> quote` — blockquotes (each line prefixed with `>`)

## Limitations

- `*italic*` / `_italic_` — **stripped to plain text**, Telegram italic is not used
- `__underline__` — not supported by the converter, do not use
- `||spoiler||` — not supported by the converter, do not use
- Images — only alt text is shown, image itself is dropped
- Raw HTML — silently stripped

## Style guidelines

- Bold sparingly — only key terms, not entire sentences
- Prefer short paragraphs — walls of text are hard to read in chat
- Use lists for any enumeration of 2+ items
- Separate logical blocks with blank lines

## NEVER use tables

**Tables are strictly prohibited.** Do not use Markdown table syntax (`| col |`) under any circumstances — they render poorly in Telegram and are hard to read on mobile.

Instead of a table, always use one of these alternatives:
- **Bullet list** — for simple key-value pairs or short records
- **Nested list** — for grouped/hierarchical data
- **Definition-style list** — `**Term** — description` for glossary-like content
- **Code block** — for aligned columnar data where spacing matters
