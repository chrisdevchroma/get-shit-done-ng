<purpose>
Manually sync GSD planning state with external issue trackers. Runs both outbound (GSD -> tracker) and inbound (tracker -> GSD) reconciliation. Outbound closes/comments issues for completed work. Inbound detects mismatches (externally closed issues still pending in GSD).
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

Parse JSON for `platform`, `cli_installed`, `cli_install_url`.

If `platform` is null or `cli_installed` is false:
```
Issue tracker sync requires a platform CLI tool.

Platform detected: {platform || 'none'}
CLI installed: {cli_installed}
{If cli_install_url: "Install: {cli_install_url}"}

Configure platform via {{COMMAND_PREFIX}}settings or install the CLI tool.
```
Exit.
</step>

<step name="check_config">
Check issue tracker configuration:

```bash
AUTO_SYNC=$(node "$HOME/.claude/gsd-ng/bin/gsd-tools.cjs" config-get issue_tracker.auto_sync --default "true")
```

Read `issue_tracker.default_action` and `issue_tracker.comment_style` too. Display current config.
</step>

<step name="list_refs">
Scan for external references:

```bash
REFS=$(node "$HOME/.claude/gsd-ng/bin/gsd-tools.cjs" issue-list-refs)
```

If `count` is 0:
```
No external issue references found in REQUIREMENTS.md or todo frontmatter.

Add references using the `external_ref` field:
- REQUIREMENTS.md traceability table: `| REQ-01 | Phase 1 | Complete | github:#42 |`
- Todo frontmatter: `external_ref: github:#42`

Import external issues: {{COMMAND_PREFIX}}import-issues
```
Exit.

Display found refs in a table:
```
External Issue References:

| Source | Reference | Platform | Issue |
|--------|-----------|----------|-------|
| REQUIREMENTS.md | github:#42 | github | #42 |
| todos/pending/fix-auth.md | github:#198 | github | #198 |
```
</step>

<step name="run_sync">
Execute sync:

```bash
SYNC=$(node "$HOME/.claude/gsd-ng/bin/gsd-tools.cjs" issue-sync)
```

Parse JSON for `synced`, `conflicts`, `skipped`.

Display outbound results:
```
## Outbound Sync (GSD -> Tracker)

| Issue | Action | Result |
|-------|--------|--------|
| github:#42 | close | success |
| github:#198 | comment | success |

Synced: {N} | Skipped: {M}
```

If conflicts exist, display and prompt for each:
```
## Inbound Conflicts

| Issue | External State | GSD State | Mismatch |
|-------|---------------|-----------|----------|
| github:#42 | closed | pending | External issue closed but GSD todo still pending |
```

For each conflict, use {{USER_QUESTION_TOOL}}:
- header: "Conflict Resolution"
- question: "Issue {ref} is closed externally but pending in GSD. What to do?"
- options:
  - "Mark GSD todo as done" — move the GSD todo to done
  - "Reopen external issue" — use CLI to reopen the external issue
  - "Ignore" — leave both states as-is
</step>

<step name="security_awareness">
After sync completes, check stderr output for `[security]` warnings.
If present, inform the user:
"Security scan detected suspicious content in synced issues. Details logged to {{CONFIG_DIR}}/logs/security-events.log. Run {{COMMAND_PREFIX}}health to review."
</step>

<step name="summary">
Display final summary:
```
## Sync Complete

Outbound: {N} synced
Inbound: {M} conflicts resolved
Skipped: {K} (no action needed)
```
</step>

</process>

<success_criteria>
- [ ] Platform detected and CLI available
- [ ] External refs scanned from REQUIREMENTS.md and todos
- [ ] Outbound sync executed for completed work
- [ ] Inbound conflicts presented to user with resolution options
- [ ] Sync results displayed
</success_criteria>
