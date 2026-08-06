---
name: gsd:validate-phase
description: Retroactively audit and fill Nyquist validation gaps for a completed phase
argument-hint: "[phase number] [--batch]"
allowed-tools:
  - Read
  - Write
  - Edit
  - Bash
  - Glob
  - Grep
  - Agent
  - AskUserQuestion
---


<objective>
Audit Nyquist validation coverage for a completed phase. Three states:
- (A) VALIDATION.md exists — audit and fill gaps
- (B) No VALIDATION.md, SUMMARY.md exists — reconstruct from artifacts
- (C) Phase not executed — exit with guidance

Output: updated VALIDATION.md + generated test files.
</objective>

<execution_context>
@~/.claude/gsd-ng/workflows/validate-phase.md
</execution_context>

<context>
Phase: $ARGUMENTS — optional, defaults to last completed phase.

`--batch` — run non-interactively. The question gate is skipped, not auto-answered: a run
without a human present has no authority to grant a waiver, so anything needing one is
appended to `.planning/nyquist-adjudication.md` and the phase is left uncompliant. Used by
unattended chains and by any run covering more phases than a person will sit through.
</context>

<tool_usage>
CRITICAL: You MUST use the {{USER_QUESTION_TOOL}} tool for ALL user choices in this workflow —
except under `--batch`, where no user is present and no choice may be made on their behalf. NEVER output plain-text menus, lettered lists (a/b/c), or numbered option lists. Every decision point requires a real {{USER_QUESTION_TOOL}} tool call with the questions parameter.

The {{USER_QUESTION_TOOL}} tool schema:
```json
{
  "questions": [
    {
      "question": "The question text",
      "header": "Short label (max 12 chars)",
      "multiSelect": false,
      "options": [
        { "label": "Option label", "description": "What this option means" }
      ]
    }
  ]
}
```

Key constraints:
- header: max 12 characters (abbreviate if needed)
- options: 2-4 items; "Other" is added automatically by the tool — do NOT add it yourself
- multiSelect: true for "select all that apply", false for "pick one"
- If user picks "Other" (free text): follow up as plain text, not another {{USER_QUESTION_TOOL}}
</tool_usage>

<process>
Execute @~/.claude/gsd-ng/workflows/validate-phase.md.
Preserve all workflow gates.
</process>
