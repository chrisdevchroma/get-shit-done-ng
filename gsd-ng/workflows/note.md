<purpose>
Zero-friction idea capture. One Write call, one confirmation line. No questions, no prompts.
Runs inline — no Task, no {{USER_QUESTION_TOOL}}. Capture and list use no Bash; promote shells out to
`gsd-tools todo add` so the promoted todo matches every other todo on disk.
</purpose>

<required_reading>
Read all files referenced by the invoking prompt's execution_context before starting.
</required_reading>

<process>

<step name="storage_format">
**Note storage format.**

Notes are stored as individual markdown files:

- **Project scope**: `.planning/notes/{YYYY-MM-DD}-{slug}.md` — used when `.planning/` exists in cwd
- **Global scope**: `~/.claude/notes/{YYYY-MM-DD}-{slug}.md` — fallback when no `.planning/`, or when `--global` flag is present

Each note file:

```markdown
---
date: "YYYY-MM-DD HH:mm"
promoted: false
---

{note text verbatim}
```

**`--global` flag**: Strip `--global` from anywhere in `$ARGUMENTS` before parsing. When present, force global scope regardless of whether `.planning/` exists.

**Important**: Do NOT create `.planning/` if it doesn't exist. Fall back to global scope silently.
</step>

<step name="parse_subcommand">
**Parse subcommand from $ARGUMENTS (after stripping --global).**

| Condition | Subcommand |
|-----------|------------|
| Arguments are exactly `list` (case-insensitive) | **list** |
| Arguments are exactly `promote <N>` where N is a number | **promote** |
| Arguments are empty (no text at all) | **list** |
| Anything else | **append** (the text IS the note) |

**Critical**: `list` is only a subcommand when it's the ENTIRE argument. `{{COMMAND_PREFIX}}note list of groceries` saves a note with text "list of groceries". Same for `promote` — only a subcommand when followed by exactly one number.
</step>

<step name="append">
**Subcommand: append — create a timestamped note file.**

1. Determine scope (project or global) per storage format above
2. Ensure the notes directory exists (`.planning/notes/` or `~/.claude/notes/`)
3. Generate slug: first ~4 meaningful words of the note text, lowercase, hyphen-separated (strip articles/prepositions from the start)
4. Generate filename: `{YYYY-MM-DD}-{slug}.md`
   - If a file with that name already exists, append `-2`, `-3`, etc.
5. Write the file with frontmatter and note text (see storage format)
6. Confirm with exactly one line: `Noted ({scope}): {note text}`
   - Where `{scope}` is "project" or "global"

**Constraints:**
- **Never modify the note text** — capture verbatim, including typos
- **Never ask questions** — just write and confirm
- **Timestamp format**: Use local time, `YYYY-MM-DD HH:mm` (24-hour, no seconds)
</step>

<step name="list">
**Subcommand: list — show notes from both scopes.**

1. Glob `.planning/notes/*.md` (if directory exists) — project notes
2. Glob `~/.claude/notes/*.md` (if directory exists) — global notes
3. For each file, read frontmatter to get `date` and `promoted` status
4. Exclude files where `promoted: true` from active counts (but still show them, dimmed)
5. Sort by date, number all active entries sequentially starting at 1
6. If total active entries > 20, show only the last 10 with a note about how many were omitted

**Display format:**

```
Notes:

Project (.planning/notes/):
  1. [2026-02-08 14:32] refactor the hook system to support async validators
  2. [promoted] [2026-02-08 14:40] add rate limiting to the API endpoints
  3. [2026-02-08 15:10] consider adding a --dry-run flag to build

Global (~/.claude/notes/):
  4. [2026-02-08 10:00] cross-project idea about shared config

{count} active note(s). Use `{{COMMAND_PREFIX}}note promote <N>` to convert to a todo.
```

If a scope has no directory or no entries, show: `(no notes)`
</step>

<step name="promote">
**Subcommand: promote — convert a note into a todo.**

1. Run the **list** logic to build the numbered index (both scopes)
2. Find entry N from the numbered list
3. If N is invalid or refers to an already-promoted note, tell the user and stop
4. **Requires `.planning/` directory** — if it doesn't exist, warn: "Todos require a GSD project. Run `{{COMMAND_PREFIX}}new-project` to initialize one."
5. Extract the note text from the source file (body after frontmatter)
6. Write the todo body to a temp file:

```markdown
## Goal

{note text}

## Context

Promoted from quick note captured on {original date}.

## Acceptance Criteria

- [ ] {primary criterion derived from note text}
```

7. Create the todo. `todo add` creates `.planning/todos/pending/` if needed, derives the `YYYY-MM-DD-{slug}.md` filename, and writes the canonical `created`/`title`/`area` frontmatter:

```bash
TODO_FILE=$(node "$HOME/.claude/gsd-ng/bin/gsd-tools.cjs" todo add \
  --title "{note text}" --area general --body-file /tmp/note-promote-body.md --pick file)
```

If a todo with the same slug already exists for today, `todo add` errors rather than overwriting — report the collision and stop.

8. Mark the source note file as promoted: update its frontmatter to `promoted: true`
9. Confirm: `Promoted note {N} to todo {TODO_FILE}: {note text}`
</step>

</process>

<edge_cases>
1. **"list" as note text**: `{{COMMAND_PREFIX}}note list of things` saves note "list of things" (subcommand only when `list` is the entire arg)
2. **No `.planning/`**: Falls back to global `~/.claude/notes/` — works in any directory
3. **Promote without project**: Warns that todos require `.planning/`, suggests `{{COMMAND_PREFIX}}new-project`
4. **Large files**: `list` shows last 10 when >20 active entries
5. **Duplicate slugs**: Append `-2`, `-3` etc. to filename if slug already used on same date
6. **`--global` position**: Stripped from anywhere — `--global my idea` and `my idea --global` both save "my idea" globally
7. **Promote already-promoted**: Tell user "Note {N} is already promoted" and stop
8. **Empty note text after stripping flags**: Treat as `list` subcommand
</edge_cases>

<success_criteria>
- [ ] Append: Note file written with correct frontmatter and verbatim text
- [ ] Append: No questions asked — instant capture
- [ ] List: Both scopes shown with sequential numbering
- [ ] List: Promoted notes shown but dimmed
- [ ] Promote: Todo created with correct format
- [ ] Promote: Source note marked as promoted
- [ ] Global fallback: Works when no `.planning/` exists
</success_criteria>
