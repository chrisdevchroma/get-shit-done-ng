<purpose>
Remove an unstarted future phase from the project roadmap, delete its directory, renumber all subsequent phases to maintain a clean linear sequence, and commit the change. The git commit serves as the historical record of removal.
</purpose>

<required_reading>
Read all files referenced by the invoking prompt's execution_context before starting.
</required_reading>

<process>

<step name="parse_arguments">
Parse the command arguments:
- Argument is the phase number to remove (integer or decimal)
- Example: `{{COMMAND_PREFIX}}remove-phase 17` → phase = 17
- Example: `{{COMMAND_PREFIX}}remove-phase 16.1` → phase = 16.1

If no argument provided:

```
ERROR: Phase number required
Usage: {{COMMAND_PREFIX}}remove-phase <phase-number>
Example: {{COMMAND_PREFIX}}remove-phase 17
```

Exit.
</step>

<step name="init_context">
Load phase operation context:

```bash
INIT=$(node "$HOME/.claude/gsd-ng/bin/gsd-tools.cjs" init phase-op "${target}")
if ! node "$HOME/.claude/gsd-ng/bin/gsd-tools.cjs" guard init-valid "$INIT" 2>/dev/null; then
  INIT=$(node "$HOME/.claude/gsd-ng/bin/gsd-tools.cjs" init phase-op "${target}")
  if ! node "$HOME/.claude/gsd-ng/bin/gsd-tools.cjs" guard init-valid "$INIT"; then
    echo "Error: init failed twice. Check gsd-tools installation."
    exit 1
  fi
fi
```

Extract: `phase_found`, `phase_dir`, `phase_number`, `commit_docs`, `roadmap_exists`.

Also read STATE.md and ROADMAP.md content for parsing current position.
</step>

<step name="validate_future_phase">
Verify the phase is a future phase (not started):

1. Compare target phase to current phase from STATE.md
2. Target must be > current phase number

If target <= current phase:

```
ERROR: Cannot remove Phase {target}

Only future phases can be removed:
- Current phase: {current}
- Phase {target} is current or completed

To abandon current work, use {{COMMAND_PREFIX}}pause-work instead.
```

Exit.
</step>

<step name="confirm_removal">
Present removal summary and confirm:

```
Removing Phase {target}: {Name}

This will:
- Delete: .planning/phases/{target}-{slug}/
- Renumber all subsequent phases
- Update: ROADMAP.md, STATE.md

Proceed? (y/n)
```

Wait for confirmation.
</step>

<step name="execute_removal">
**Delegate the entire removal operation to gsd-tools:**

```bash
RESULT=$(node "$HOME/.claude/gsd-ng/bin/gsd-tools.cjs" phase remove "${target}")
```

If the phase has executed plans (SUMMARY.md files), gsd-tools will error. Use `--force` only if the user confirms:

```bash
RESULT=$(node "$HOME/.claude/gsd-ng/bin/gsd-tools.cjs" phase remove "${target}" --force)
```

The CLI handles:
- Deleting the phase directory
- Renumbering all subsequent directories (in reverse order to avoid conflicts)
- Renaming all files inside renumbered directories (PLAN.md, SUMMARY.md, etc.)
- Updating ROADMAP.md's current milestone (removing section, renumbering phase references, updating dependencies) — archived milestone sections are never touched
- Updating STATE.md (decrementing phase count)

Extract from result: `removed`, `found`, `directory_deleted`, `renamed_directories`, `renamed_files`, `roadmap_updated`, `roadmap_landed`, `roadmap_missed_targets`, `roadmap_withheld`, `roadmap_withheld_hint`, `state_updated`.

`found` is false when the phase has no directory and the current milestone names it nowhere. Nothing was written; say so rather than reporting a removal.

`roadmap_updated` is false when no ROADMAP.md rewrite matched anything — the file was left as it was. `roadmap_landed` names the rewrites that did land (`phase-section`, `phase-checkbox`, `progress-table`, `renumber`) and `roadmap_missed_targets` names the ones that had a target and could not reach it, which means ROADMAP.md is written in a shape the rewrite does not recognise. Report those to the user; do not present the removal as clean when the list is non-empty.

`roadmap_withheld` names a rewrite that was refused rather than one that could not be reached — currently only `renumber`, which is withheld when applying it would leave two phases sharing a number. The phase directories have already been renumbered when this happens, so ROADMAP.md and `.planning/phases/` disagree until a human fixes the reference the rewrite could not reach. **Surface `roadmap_withheld_hint` verbatim** and do not present the removal as clean.

**If the removal fails partway.** The directory deletion and renumbering happen before ROADMAP.md is rewritten, and STATE.md is written last. On a failure the error names what already landed — `Already applied before this failure: ...`. Unlike `phase complete`, **re-running is not a repair**: the renumbering has already shifted what the later phases are called, so the same number now names a different phase. Reconcile `.planning/phases/` against ROADMAP.md and STATE.md, and tell the user what was left in that state. The usual cause is a lock timeout (`Timed out waiting for a lock on ...`, error code `GSD_LOCK_TIMEOUT`) — another gsd process held the file for the whole acquire budget.
</step>

<step name="commit">
Stage and commit the removal:

```bash
node "$HOME/.claude/gsd-ng/bin/gsd-tools.cjs" commit "chore: remove phase {target} ({original-phase-name})" --files .planning/
```

The commit message preserves the historical record of what was removed.
</step>

<step name="completion">
Present completion summary:

```
Phase {target} ({original-name}) removed.

Changes:
- Deleted: .planning/phases/{target}-{slug}/
- Renumbered: {N} directories and {M} files
- Updated: ROADMAP.md ({roadmap_landed}), STATE.md
- Committed: chore: remove phase {target} ({original-name})

---

## What's Next

Would you like to:
- `{{COMMAND_PREFIX}}progress` — see updated roadmap status
- Continue with current phase
- Review roadmap

---
```
</step>

</process>

<anti_patterns>

- Don't remove completed phases (have SUMMARY.md files) without --force
- Don't remove current or past phases
- Don't manually renumber — use `gsd-tools phase remove` which handles all renumbering
- Don't add "removed phase" notes to STATE.md — git commit is the record
- Don't modify completed phase directories
- Don't report a clean removal when `roadmap_missed_targets` or `roadmap_withheld` is non-empty — name the parts of ROADMAP.md that need a look
- Don't report a removal when `found` is false — nothing was removed
</anti_patterns>

<success_criteria>
Phase removal is complete when:

- [ ] Target phase validated as future/unstarted
- [ ] `gsd-tools phase remove` executed successfully
- [ ] Changes committed with descriptive message
- [ ] User informed of changes
</success_criteria>
