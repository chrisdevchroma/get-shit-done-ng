<purpose>
Import external issues from GitHub/GitLab/Forgejo/Gitea as GSD todos. Supports both single issue import and bulk import filtered by label or milestone.
</purpose>

@~/.claude/gsd-ng/references/ask-user-question.md

<required_reading>
Read all files referenced by the invoking prompt's execution_context before starting.
@references/security-untrusted-content.md
</required_reading>

<process>

<step name="detect_platform">
Detect configured platform:

```bash
PLATFORM=$(node "$HOME/.claude/gsd-ng/bin/gsd-tools.cjs" detect-platform)
```

Parse JSON. If platform unavailable or CLI not installed, display warning and exit (same as sync-issues):
```
Issue tracker import requires a platform CLI tool.

Platform detected: {platform || 'none'}
CLI installed: {cli_installed}
{If cli_install_url: "Install: {cli_install_url}"}

Configure platform via {{COMMAND_PREFIX}}settings or install the CLI tool.
```
</step>

<step name="choose_mode">
Use {{USER_QUESTION_TOOL}}:
- header: "Import Mode"
- question: "How would you like to import issues?"
- options:
  - "Single issue" — import one issue by number
  - "Bulk import" — filter by label and/or milestone
</step>

<step name="single_import">
If single issue mode:

Ask for issue number:
- "Enter the issue number to import (e.g., 42):"

```bash
RESULT=$(node "$HOME/.claude/gsd-ng/bin/gsd-tools.cjs" issue-import {platform} {number})
IMPORT_EXIT=$?
```

If `IMPORT_EXIT` is non-zero and the output contains `[SECURITY]`, proceed to the `security_gate` step before displaying results. Otherwise, parse JSON for `imported`, `todo_file`, `title`, `external_ref`, `commented`.

Display result (on success):
```
Imported: {title}
Todo file: {todo_file}
External ref: {external_ref}
Comment posted: {yes/no}
```
</step>

<step name="security_gate">
If the import command failed with a `[SECURITY]` error:

1. Display the error message to the user — it contains the detected pattern details
2. Use {{USER_QUESTION_TOOL}} to present the Rule of Two gate:
   ```json
   {
     "questions": [{
       "question": "High-confidence injection pattern detected in imported issue content. The detected patterns are shown above. How would you like to proceed?",
       "header": "Security",
       "multiSelect": false,
       "options": [
         { "label": "Review and override", "description": "Re-run import with --force-unsafe to bypass security check" },
         { "label": "Cancel import", "description": "Abort — do not import this issue" }
       ]
     }]
   }
   ```
3. If user selects "Review and override": re-run the import command with `--force-unsafe` flag appended
4. If user selects "Cancel import": stop workflow and inform user

If the import succeeded (no security error), proceed to next step.
</step>

<step name="bulk_import">
If bulk import mode:

Ask for filters:
- "Filter by label (leave empty for all):"
- "Filter by milestone (leave empty for all):"
- "Maximum issues to import (default: 50):"

List matching issues first using the platform CLI directly:
```bash
# For GitHub:
gh issue list --json number,title,state,labels --label "{label}" --milestone "{milestone}" --limit {limit}
# For GitLab:
glab issue list --label "{label}" --milestone "{milestone}" --per-page {limit} --output json
# For Forgejo/Gitea:
fj issue list --label "{label}" --milestone "{milestone}" --limit {limit}
```

Display matching issues as a numbered list. Use {{USER_QUESTION_TOOL}} to confirm:
- header: "Import Confirmation"
- question: "Import these {N} issues as GSD todos?"
- options:
  - "Yes, import all" — import all listed issues
  - "Select specific issues" — enter comma-separated issue numbers to import
  - "Cancel" — abort import

For each selected issue, call:
```bash
node "$HOME/.claude/gsd-ng/bin/gsd-tools.cjs" issue-import {platform} {number}
```

If any import fails with `[SECURITY]`, pause bulk import and present the `security_gate` step for that issue. User may choose "Review and override" (re-run with `--force-unsafe`) or "Cancel import" to skip that issue and continue with the rest.

Collect results and display summary.
</step>

<step name="summary">
```
## Import Complete

Imported: {N} issues as GSD todos
Skipped: {M}

| # | Title | Todo File | External Ref |
|---|-------|-----------|-------------|
| 1 | Fix auth | 2026-03-18-fix-auth.md | github:#42 |

Next: {{COMMAND_PREFIX}}check-todos to review imported items
```
</step>

</process>

<success_criteria>
- [ ] Platform detected and CLI available
- [ ] Single or bulk import mode selected
- [ ] Issues fetched from external tracker
- [ ] Todos created with external_ref frontmatter
- [ ] Import results displayed
</success_criteria>
