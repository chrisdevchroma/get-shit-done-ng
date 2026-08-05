---
name: gsd:import-issues
description: Import external issues from GitHub/GitLab/Forgejo/Gitea as GSD todos
argument-hint: [issue number]
allowed-tools:
  - Read
  - Write
  - Bash
  - AskUserQuestion
---


<objective>
Import external issues from connected issue trackers as GSD todos with external_ref frontmatter.

Routes to the import-issue workflow which handles:
- Platform detection and CLI availability check
- Single issue import by number
- Bulk import filtered by label and/or milestone
- Todo creation with external_ref field populated
- Optional comment posted on imported external issue
</objective>

<execution_context>
@~/.claude/gsd-ng/workflows/import-issue.md
</execution_context>

<context>
Arguments: $ARGUMENTS (optional issue number for quick single import)
</context>

<tool_usage>
CRITICAL: You MUST use the {{USER_QUESTION_TOOL}} tool for ALL user choices in this workflow. NEVER output plain-text menus, lettered lists (a/b/c), or numbered option lists. Every decision point requires a real {{USER_QUESTION_TOOL}} tool call with the questions parameter.

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
**Follow the import-issue workflow** from `@~/.claude/gsd-ng/workflows/import-issue.md`.

The workflow handles all logic including:
1. Platform and CLI detection
2. Import mode selection (single or bulk)
3. Issue fetching from external tracker
4. Todo creation with external_ref frontmatter
5. Optional tracking comment on external issue
6. Import results summary
</process>
