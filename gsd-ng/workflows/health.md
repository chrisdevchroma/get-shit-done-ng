<purpose>
Validate `.planning/` directory integrity and report actionable issues. Checks for missing files, invalid configurations, inconsistent state, and orphaned plans. Optionally repairs auto-fixable issues.
</purpose>

<required_reading>
Read all files referenced by the invoking prompt's execution_context before starting.
</required_reading>

<process>

<step name="parse_args">
**Parse arguments:**

Check if `--repair` flag is present in the command arguments.

```
REPAIR_FLAG=""
if arguments contain "--repair"; then
  REPAIR_FLAG="--repair"
fi
```
</step>

<step name="run_health_check">
**Run health validation:**

```bash
node "$HOME/.claude/gsd-ng/bin/gsd-tools.cjs" validate health $REPAIR_FLAG
```

Parse JSON output:
- `status`: "healthy" | "degraded" | "broken"
- `errors[]`: Critical issues (code, message, fix, repairable)
- `warnings[]`: Non-critical issues
- `info[]`: Informational notes
- `repairable_count`: Number of auto-fixable issues
- `repairs_performed[]`: Actions taken if --repair was used
</step>

<step name="format_output">
**Format and display results:**

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 GSD Health Check
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Status: HEALTHY | DEGRADED | BROKEN
Errors: N | Warnings: N | Info: N
```

**If repairs were performed:**
```
## Repairs Performed

- ✓ config.json: Created with defaults
- ✓ STATE.md: Regenerated from roadmap
```

**If errors exist:**
```
## Errors

- [E001] config.json: JSON parse error at line 5
  Fix: Run {{COMMAND_PREFIX}}health --repair to reset to defaults

- [E002] PROJECT.md not found
  Fix: Run {{COMMAND_PREFIX}}new-project to create
```

**If warnings exist:**
```
## Warnings

- [W001] STATE.md references phase 5, but only phases 1-3 exist
  Fix: Run {{COMMAND_PREFIX}}health --repair to regenerate

- [W005] Phase directory "1-setup" doesn't follow NN-name format
  Fix: Rename to match pattern (e.g., 01-setup)
```

**If info exists:**
```
## Info

- [I001] 02-implementation/02-01-PLAN.md has no SUMMARY.md
  Note: May be in progress
```

**Footer (if repairable issues exist and --repair was NOT used):**
```
---
N issues can be auto-repaired. Run: {{COMMAND_PREFIX}}health --repair
```
</step>

<step name="offer_repair">
**If repairable issues exist and --repair was NOT used:**

Ask user if they want to run repairs:

```
Would you like to run {{COMMAND_PREFIX}}health --repair to fix N issues automatically?
```

If yes, re-run with --repair flag and display results.
</step>

<step name="verify_repairs">
**If repairs were performed:**

Re-run health check without --repair to confirm issues are resolved:

```bash
node "$HOME/.claude/gsd-ng/bin/gsd-tools.cjs" validate health
```

Report final status.
</step>

</process>

<error_codes>

| Code | Severity | Description | Repairable |
|------|----------|-------------|------------|
| E001 | error | .planning/ directory not found | No |
| E002 | error | PROJECT.md not found | No |
| E003 | error | ROADMAP.md not found | No |
| E004 | error | STATE.md not found | Yes |
| E005 | error | config.json parse error | Yes |
| E010 | error | CWD is the home directory — the check would read the wrong .planning/ directory | No |
| W001 | warning | PROJECT.md missing required section | No |
| W002 | warning | STATE.md references invalid phase | Yes |
| W003 | warning | config.json not found | Yes |
| W004 | warning | config.json invalid field value | No |
| W005 | warning | Phase directory naming mismatch | No |
| W006 | warning | Phase in ROADMAP but no directory | No |
| W007 | warning | Phase on disk but not in ROADMAP | No |
| W008 | warning | config.json: workflow.nyquist_validation absent (defaults to enabled but agents may skip) | Yes |
| W009 | warning | Phase has Validation Architecture in RESEARCH.md but no VALIDATION.md | No |
| W010 | warning | `{{PROJECT_RULES_FILE}}` not found — agents missing project instructions | Yes |
| W011 | warning | Memory files not referenced in `{{PROJECT_RULES_FILE}}` | Yes |
| W012 | warning | `{{PROJECT_RULES_FILE}}` references non-existent memory files | Yes |
| W013 | warning | MEMORY.md out of sync with {{MEMORY_DIR}} contents | Yes |
| W014 | warning | Workspace topology detected but no structural memory seeded | No |
| W017 | warning | Todo references a phase that does not exist in ROADMAP.md | Yes |
| W018 | warning | Phase is complete but pending todos still reference it | Yes |
| W019 | warning | REQUIREMENTS.md: a requirement is ticked off but its traceability row still reads Planned | No |
| W020 | warning | security-events.log records high-confidence injection events | No |
| W021 | warning | Todo has a `related:` reference that exists in neither pending/ nor completed/ | Yes |
| W022 | warning | Asymmetric related link — a todo references another that does not reference it back | Yes |
| W023 | warning | ROADMAP.md contradicts itself: plan-count header vs plan list, a details section or checklist entry without its counterpart, or a repeated phase number | No |
| W024 | warning | STATE.md contradicts itself: an in-flight status over a finished, verified phase, or a Velocity block disagreeing with the metrics table | No |
| W025 | warning | STATE.md missing fields its template declares | No |
| I001 | info | Plan without SUMMARY (may be in progress) | No |
| I010 | info | The resolved CWD, reported alongside E010 | No |

E010 and I010 come from the home-directory guard, which returns before any other check
runs — a report carrying them carries nothing else.

W015 and W016 are named only in comments inside the issue-tracker link check, which
accepts `addIssue` and never calls it, so neither code can be raised today.

</error_codes>

<repair_actions>

| Action | Effect | Risk |
|--------|--------|------|
| createConfig | Create config.json with defaults | None |
| resetConfig | Delete + recreate config.json | Loses custom settings |
| regenerateState | Create STATE.md from ROADMAP structure | Loses session history |
| addNyquistKey | Add workflow.nyquist_validation: true to config.json | None — matches existing default |
| writeCLAUDEmd | Create `{{PROJECT_RULES_FILE}}` with Memories section from {{MEMORY_DIR}} | None — generates from existing files |
| syncCLAUDEmdMemories | Update `{{PROJECT_RULES_FILE}}` Memories section to match {{MEMORY_DIR}} | Replaces Memories section in-place |
| syncMemoryMd | Regenerate {{MEMORY_DIR}}MEMORY.md from {{MEMORY_DIR}} files | Overwrites MEMORY.md |

**Not repairable (too risky):**
- PROJECT.md, ROADMAP.md content
- Phase directory renaming
- Orphaned plan cleanup
- Topology drift (W014) — complex; suggests running {{COMMAND_PREFIX}}seed-memories manually

</repair_actions>
