---
name: gsd:ui-phase
description: Generate UI design contract (UI-SPEC.md) for frontend phases
argument-hint: "[phase]"
allowed-tools:
  - Read
  - Write
  - Bash
  - Glob
  - Grep
  - Agent
  - WebFetch
  - AskUserQuestion
  - mcp__context7__*
---


<objective>
Create a UI design contract (UI-SPEC.md) for a frontend phase.
Spawns gsd-ui-researcher to gather design preferences and write the contract.
Flow: Validate → Research UI → Done
</objective>

<execution_context>
@~/.claude/gsd-ng/workflows/ui-phase.md
@~/.claude/gsd-ng/references/ui-brand.md
</execution_context>

<context>
Phase number: $ARGUMENTS — optional, auto-detects next unplanned phase if omitted.
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
Execute @~/.claude/gsd-ng/workflows/ui-phase.md end-to-end.
Preserve all workflow gates.
</process>
