---
name: gsd:sync-issues
description: Manually sync GSD planning state with external issue trackers
argument-hint: [phase]
allowed-tools:
  - Read
  - Bash
  - AskUserQuestion
---


<objective>
Sync GSD planning state with external issue trackers (GitHub, GitLab, Forgejo, Gitea).

Routes to the sync-issues workflow which handles:
- Platform detection and CLI availability check
- Scanning REQUIREMENTS.md and todo frontmatter for external_ref fields
- Outbound sync: close/comment external issues for completed GSD work
- Inbound reconciliation: flag mismatches where external issues are closed but GSD todos are still pending
- Conflict resolution prompts (never auto-resolves)
</objective>

<execution_context>
@~/.claude/gsd-ng/workflows/sync-issues.md
</execution_context>

<context>
Arguments: $ARGUMENTS (optional phase filter)
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
**Follow the sync-issues workflow** from `@~/.claude/gsd-ng/workflows/sync-issues.md`.

The workflow handles all logic including:
1. Platform and CLI detection
2. Config loading (auto_sync, default_action, comment_style)
3. External ref scanning
4. Outbound sync execution
5. Inbound conflict detection and user prompting
6. Results summary
</process>
