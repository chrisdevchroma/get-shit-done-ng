<purpose>
List all pending todos, allow selection, load full context for the selected todo, and route to appropriate action.
</purpose>

@~/.claude/gsd-ng/references/ask-user-question.md

<required_reading>
Read all files referenced by the invoking prompt's execution_context before starting.
</required_reading>

<process>

<step name="gather_todos">
Gather todo data from CLI:

```bash
AREA_FILTER=""
if [[ -n "$ARGUMENTS" ]]; then AREA_FILTER="$ARGUMENTS"; fi
TODOS_JSON=$(node "$HOME/.claude/gsd-ng/bin/gsd-tools.cjs" list-todos $AREA_FILTER)
RECURRING_JSON=$(node "$HOME/.claude/gsd-ng/bin/gsd-tools.cjs" recurring-due)
PENDING_DIR=".planning/todos/pending"
```

Parse `TODOS_JSON`: extract `count` and `todos` array.

If `count` is 0 and recurring count is 0:
```
No pending todos.

Todos are captured during work sessions with {{COMMAND_PREFIX}}add-todo.

---

Would you like to:

1. Continue with current phase ({{COMMAND_PREFIX}}progress)
2. Add a todo now ({{COMMAND_PREFIX}}add-todo)
```
Exit.
</step>

<step name="display_todos">
If recurring count > 0, display the recurring reminders table first:

```
## Recurring Reminders Due

The following recurring todos are past their interval and need attention:

| # | Title | Interval | Last Completed |
|---|-------|----------|----------------|
| 1 | {title} | {interval} | {last_completed} |

These todos will NOT be archived when completed — they will reset and resurface after their interval.

---
```

Then display the pending list from TODOS_JSON as a numbered list:
```
Pending Todos:

1. {title} ({area}, {relative_age})
2. {title} ({area}, {relative_age})

---

Reply with a number to view details, or:
- `{{COMMAND_PREFIX}}check-todos [area]` to filter by area
- `q` to exit
```
</step>

<step name="handle_selection">
Wait for user to reply with a number.

If valid: load selected todo, proceed.
If invalid: "Invalid selection. Reply with a number (1-[N]) or `q` to exit."
</step>

<step name="load_context">
Read the todo file completely. Display:

```
## [title]

**Area:** [area]
**Created:** [date] ([relative time] ago)
**Files:** [list or "None"]

### Problem
[problem section content]

### Solution
[solution section content]
```

If `files` field has entries, read and briefly summarize each.

**UI rendering note:** The {{USER_QUESTION_TOOL}} dialog that follows (offer_actions) can occlude preceding text in the Claude Code UI when the preceding text is long. If the Problem or Solution content is more than ~4-5 lines, truncate to a 2-3 sentence summary rather than reproducing the full text. The user already knows what the todo is — keep the display concise.
</step>

<step name="check_roadmap">
Check for roadmap (can use init progress or directly check file existence):

If `.planning/ROADMAP.md` exists:
1. Check if todo's area matches an upcoming phase
2. Check if todo's files overlap with a phase's scope
3. Note any match for action options
</step>

<step name="offer_actions">
**Analyze todo content to recommend a workflow:**

Examine the todo's title and description for routing signals:
- Bug-like language (`fix`, `broken`, `error`, `bug`, `crash`, `fails`, `exception`, `regression`) → recommend Debug
- Small scope language (`add`, `update`, `change`, `rename`, `move`, `tweak`, `adjust`, `remove`) → recommend Quick
- Large scope, multi-file, or architectural language (`refactor`, `redesign`, `migrate`, `implement`, `create`, `build`) → recommend Plan as phase

Mark the recommended option by placing it FIRST in the options list and appending "(Recommended)" to its label text.

**Check context usage for launch warnings:**

```bash
# Read context percentage from statusline bridge file
SESSION_ID=$(echo "$ARGUMENTS" | grep -oP '(?<=session_id=)\S+' 2>/dev/null || echo "")
CONTEXT_PCT=0
if [[ -n "$SESSION_ID" ]]; then
  BRIDGE_FILE="/tmp/claude-ctx-${SESSION_ID}.json"
  if [[ -f "$BRIDGE_FILE" ]]; then
    CONTEXT_PCT=$(node -e "try{const d=JSON.parse(require('fs').readFileSync('$BRIDGE_FILE','utf-8'));console.log(100-(d.remaining_percentage||100))}catch{console.log(0)}")
  fi
fi
```

Note: `CONTEXT_PCT` represents used percentage (0-100). If bridge file unavailable, default to 0 (no warning).

**Present routing options:**

**If todo maps to a roadmap phase:**

Use {{USER_QUESTION_TOOL}}:
- header: "Action"
- question: "This todo relates to Phase [N]: [name]. What would you like to do?"
- options (always show ALL, place recommended option FIRST):
  - "Debug this[(Recommended) if recommended]" — "Investigate and fix via {{COMMAND_PREFIX}}debug"
  - "Handle as quick task[(Recommended) if recommended]" — "Small ad-hoc fix via {{COMMAND_PREFIX}}quick"
  - "Plan as phase[(Recommended) if recommended]" — "Create planned work via {{COMMAND_PREFIX}}plan-phase"
  - "Work on it now" — "Start working immediately (existing behavior)"
  - "Add to phase plan" — "Include when planning Phase [N]"
  - "Brainstorm approach" — "Think through before deciding"
  - "Put it back" — "Return to list"

**If no roadmap match:**

Use {{USER_QUESTION_TOOL}}:
- header: "Action"
- question: "What would you like to do with this todo?"
- options (always show ALL, place recommended option FIRST):
  - "Debug this[(Recommended) if recommended]" — "Investigate and fix via {{COMMAND_PREFIX}}debug"
  - "Handle as quick task[(Recommended) if recommended]" — "Small ad-hoc fix via {{COMMAND_PREFIX}}quick"
  - "Plan as phase[(Recommended) if recommended]" — "Create planned work via {{COMMAND_PREFIX}}plan-phase"
  - "Work on it now" — "Start working immediately (existing behavior)"
  - "Create a phase" — "Add as new roadmap phase via {{COMMAND_PREFIX}}add-phase"
  - "Brainstorm approach" — "Think through before deciding"
  - "Put it back" — "Return to list"

**Handle routing selection (new options):**

If user selects "Debug this", "Handle as quick task", or "Plan as phase":

Determine the command and compose the launch instruction:
- Debug: `{{COMMAND_PREFIX}}debug --todo-file {filename} {todo title}`
- Quick: `{{COMMAND_PREFIX}}quick --todo-file {filename} {todo title}`
- Plan as phase: `{{COMMAND_PREFIX}}plan-phase` (todo becomes phase scope)

Display in "Next Up" style:

```
---
## Next Up

`{command}`

*`/clear` first → fresh context window*
```

Then add context-aware launch option:

If `CONTEXT_PCT` < 40:
```
Launch now? (Current context: {CONTEXT_PCT}% used)
```

If `CONTEXT_PCT` between 40-70:
```
Launch now? (Current context: {CONTEXT_PCT}% used — consider /clear for a fresh session)
```

If `CONTEXT_PCT` between 70-85:
```
Launch now? (Current context: {CONTEXT_PCT}% used — recommended: /clear first, or switch to Opus/higher context model for best results)
```

If `CONTEXT_PCT` > 85:
```
Launch now? (Current context: {CONTEXT_PCT}% used — strongly recommended: /clear first, or switch to Opus/higher context model. Quality degrades significantly above 85%.)
```

Use {{USER_QUESTION_TOOL}}:
- header: "Launch"
- question: "{context-aware message from above}"
- options:
  - "Launch now" — "Start in current session"
  - "I'll /clear first" — "Exit — I'll run the command after /clear"

If user selects "Launch now": Invoke the workflow using Task tool (for debug/quick) or display the command.
If user selects "I'll /clear first": Acknowledge and exit. Do NOT reprint the command (it is already shown in the Next Up block above).

**Existing options (Work on it now, Add to phase plan, Brainstorm, Put it back, Create a phase):**

Handle exactly as before — no changes to existing behavior.
</step>

<step name="execute_action">
**Work on it now:**

Complete the todo using gsd-tools, which handles both recurring and non-recurring cases:

```bash
node "$HOME/.claude/gsd-ng/bin/gsd-tools.cjs" todo complete "[filename]"
```

For **recurring todos** (those with `recurring: true` in frontmatter): the file stays in `pending/` with `last_completed` updated — it will resurface automatically after its interval. No manual archiving or git tracking needed.

For **non-recurring todos**: the file is moved to `completed/` as before.

Update STATE.md todo count.

Note: External issue sync happens automatically via `cmdTodoComplete` when the todo has an `external_ref` — no workflow-level sync needed.

Present problem/solution context. Begin work or ask how to proceed.

**Add to phase plan:**
Note todo reference in phase planning notes. Keep in pending. Return to list or exit.

**Create a phase:**
Display: `{{COMMAND_PREFIX}}add-phase [description from todo]`
Keep in pending. User runs command in fresh context.

**Brainstorm approach:**
Keep in pending. Start discussion about problem and approaches.

**Put it back:**
Return to display_todos step.
</step>

<step name="update_state">
After any action that changes todo count:

Re-run `list-todos` to get updated count, then update STATE.md "### Pending Todos" section if exists.
</step>

<step name="git_commit">
If todo was completed (non-recurring moved to completed/, or recurring reset):

For **non-recurring todos** (moved to completed/):
```bash
git rm --cached .planning/todos/pending/[filename] 2>/dev/null || true
node "$HOME/.claude/gsd-ng/bin/gsd-tools.cjs" commit "docs: start work on todo - [title]" --files .planning/todos/completed/[filename] .planning/STATE.md
```

For **recurring todos** (updated in pending/):
```bash
node "$HOME/.claude/gsd-ng/bin/gsd-tools.cjs" commit "docs: reset recurring todo - [title]" --files .planning/todos/pending/[filename] .planning/STATE.md
```

Tool respects `commit_docs` config and gitignore automatically.

Confirm: "Committed: docs: start work on todo - [title]"
</step>

</process>

<success_criteria>
- [ ] All pending todos listed with title, area, age
- [ ] Area filter applied if specified
- [ ] Selected todo's full context loaded
- [ ] Roadmap context checked for phase match
- [ ] Appropriate actions offered
- [ ] Selected action executed
- [ ] STATE.md updated if todo count changed
- [ ] Changes committed to git (if todo moved to done/)
</success_criteria>
