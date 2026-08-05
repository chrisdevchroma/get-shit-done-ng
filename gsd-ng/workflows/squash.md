<purpose>
Squash phase commits into clean history for code review and merge requests.
Supports three strategies: single (all commits to one), per-plan (group by plan),
and logical (user-guided grouping). Always creates backup tags before rewriting history.
</purpose>

@~/.claude/gsd-ng/references/ask-user-question.md

<required_reading>
@~/.claude/gsd-ng/references/planning-config.md
</required_reading>

<process>

<step name="parse_arguments">
Parse command arguments:
- Phase number (required unless --list-backup-tags)
- `--strategy single|per-plan|logical` (required for squash)
- `--dry-run` show plan without executing
- `--allow-stable` allow squash on main/master/develop
- `--list-backup-tags` list existing backup tags
- `--force-push` push result with --force-with-lease after squash

Parse the ARGUMENTS variable for phase number and flags.

If `--list-backup-tags`:
```bash
node "$HOME/.claude/gsd-ng/bin/gsd-tools.cjs" squash --list-backup-tags
```
Display results and STOP.
</step>

<step name="detect_phase">
Load phase context:

```bash
INIT=$(node "$HOME/.claude/gsd-ng/bin/gsd-tools.cjs" init execute-phase "${PHASE}")
if ! node "$HOME/.claude/gsd-ng/bin/gsd-tools.cjs" guard init-valid "$INIT" 2>/dev/null; then
  INIT=$(node "$HOME/.claude/gsd-ng/bin/gsd-tools.cjs" init execute-phase "${PHASE}")
  if ! node "$HOME/.claude/gsd-ng/bin/gsd-tools.cjs" guard init-valid "$INIT"; then
    echo "Error: init failed twice. Check gsd-tools installation."
    exit 1
  fi
fi
```

Extract PHASE_NUMBER, PHASE_NAME, PHASE_SLUG, TARGET_BRANCH, REMOTE from init JSON.
</step>

<step name="select_strategy">
If --strategy flag provided, use it.

Otherwise, present the three strategies with {{USER_QUESTION_TOOL}}:

```
Squash Strategy:
- **single**: All phase commits into one clean commit
- **per-plan**: Group commits by plan (one commit per plan)
- **logical**: Interactive — you choose how to group commits

Recommended: 'single' for small phases, 'per-plan' for multi-plan phases
```

{{USER_QUESTION_TOOL}} with options: "single", "per-plan", "logical"
</step>

<step name="dry_run_preview">
Always show dry run first:

```bash
PREVIEW=$(node "$HOME/.claude/gsd-ng/bin/gsd-tools.cjs" squash ${PHASE} --strategy ${STRATEGY} --dry-run)
```

Display the preview showing which commits will be grouped and what messages will be used.

For 'logical' strategy: present the commit list and ask the user to specify groupings before proceeding. Parse user groupings, then use 'single' strategy applied to each group.

Ask confirmation:
```
Ready to squash? This rewrites git history.
A backup tag will be created before any changes.
(yes / abort)
```

If "abort": STOP.
</step>

<step name="execute_squash">
Execute the squash:

```bash
RESULT=$(node "$HOME/.claude/gsd-ng/bin/gsd-tools.cjs" squash ${PHASE} --strategy ${STRATEGY} ${ALLOW_STABLE_FLAG})
```

Display the result including backup tag name.
</step>

<step name="offer_push">
If `--force-push` flag was provided, or ask:

```
Push squashed branch with --force-with-lease?
(yes / no)
```

If yes:
```bash
GIT_CWD=$(node "$HOME/.claude/gsd-ng/bin/gsd-tools.cjs" git-context --field git_cwd)
PUSH_REMOTE=$(node "$HOME/.claude/gsd-ng/bin/gsd-tools.cjs" git-context --field remote)
BRANCH=$(git -C "$GIT_CWD" branch --show-current)
git -C "$GIT_CWD" push --force-with-lease "$PUSH_REMOTE" "$BRANCH"
```
</step>

<step name="summary">
Display result:

```
GSD > SQUASH COMPLETE

Phase:    ${PHASE_NUMBER} - ${PHASE_NAME}
Strategy: ${STRATEGY}
Backup:   ${BACKUP_TAG}
Branch:   ${CURRENT_BRANCH}

Restore:  git reset --hard ${BACKUP_TAG}
Cleanup:  git tag -d ${BACKUP_TAG}
```
</step>

</process>

<success_criteria>
- [ ] Strategy selected (single, per-plan, or logical)
- [ ] Dry run preview shown before execution
- [ ] Backup tag created before any history rewrite
- [ ] Squash executed with correct strategy
- [ ] --force-with-lease used for push (never bare --force)
- [ ] Restore command displayed for safety
</success_criteria>
