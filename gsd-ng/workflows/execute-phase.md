<purpose>
Execute all plans in a phase using wave-based parallel execution. Orchestrator stays lean — delegates plan execution to subagents.
</purpose>

<core_principle>
Orchestrator coordinates, not executes. Each subagent loads the full execute-plan context. Orchestrator: discover plans → analyze deps → group waves → spawn agents → handle checkpoints → collect results.
</core_principle>

<required_reading>
Read STATE.md before any operation to load project context.
</required_reading>

<process>

<step name="initialize" priority="first">
Load all context in one call:

```bash
INIT=$(node "$HOME/.claude/gsd-ng/bin/gsd-tools.cjs" init execute-phase "${PHASE_ARG}")
if ! node "$HOME/.claude/gsd-ng/bin/gsd-tools.cjs" guard init-valid "$INIT" 2>/dev/null; then
  INIT=$(node "$HOME/.claude/gsd-ng/bin/gsd-tools.cjs" init execute-phase "${PHASE_ARG}")
  if ! node "$HOME/.claude/gsd-ng/bin/gsd-tools.cjs" guard init-valid "$INIT"; then
    echo "Error: init failed twice. Check gsd-tools installation."
    exit 1
  fi
fi
```

Parse JSON for: `executor_model`, `verifier_model`, `commit_docs`, `parallelization`, `branching_strategy`, `branch_name`, `target_branch`, `auto_push`, `remote`, `review_branch_template`, `pr_draft`, `platform`, `phase_found`, `phase_dir`, `phase_number`, `phase_name`, `phase_slug`, `plans`, `incomplete_plans`, `plan_count`, `incomplete_count`, `state_exists`, `roadmap_exists`, `phase_req_ids`.

Store as shell variables: `BRANCHING_STRATEGY`, `BRANCH_NAME`, `TARGET_BRANCH`, `AUTO_PUSH`, `REMOTE`.

**If `phase_found` is false:** Error — phase directory not found.
**If `plan_count` is 0:** Error — no plans found in phase.
**If `state_exists` is false but `.planning/` exists:** Offer reconstruct or continue.

When `parallelization` is false, plans within a wave execute sequentially.

**REQUIRED — Sync chain flag with intent.** If user invoked manually (no `--auto`), clear the ephemeral chain flag from any previous interrupted `--auto` chain. This prevents stale `_auto_chain_active: true` from causing unwanted auto-advance. This does NOT touch `workflow.auto_advance` (the user's persistent settings preference). You MUST execute this bash block before any config reads:
```bash
node "$HOME/.claude/gsd-ng/bin/gsd-tools.cjs" guard sync-chain "$ARGUMENTS" 2>/dev/null
```
</step>

<step name="handle_branching">
Check `branching_strategy` from init:

**"none":** Skip, continue on current branch.

**Submodule-aware routing:** Before performing any git branch operations, extract submodule context from `$INIT` (already loaded in the initialize step):

```bash
SUBMODULE_IS_ACTIVE=$(node "$HOME/.claude/gsd-ng/bin/gsd-tools.cjs" init-get "$INIT" submodule_is_active 2>/dev/null)
SUBMODULE_GIT_CWD=$(node "$HOME/.claude/gsd-ng/bin/gsd-tools.cjs" init-get "$INIT" submodule_git_cwd 2>/dev/null)
SUBMODULE_TARGET_BRANCH=$(node "$HOME/.claude/gsd-ng/bin/gsd-tools.cjs" init-get "$INIT" submodule_target_branch 2>/dev/null)
SUBMODULE_AMBIGUOUS=$(node "$HOME/.claude/gsd-ng/bin/gsd-tools.cjs" init-get "$INIT" submodule_ambiguous 2>/dev/null)
```

**Ambiguity guard:** If `$SUBMODULE_AMBIGUOUS` is `"true"`, multiple submodules have changes and branching cannot be reliably routed. Ask the user to select which submodule(s) to branch:

```bash
if [ "$SUBMODULE_AMBIGUOUS" = "true" ]; then
  AMBIGUOUS_PATHS=$(node "$HOME/.claude/gsd-ng/bin/gsd-tools.cjs" init-get "$INIT" ambiguous_paths 2>/dev/null)
  AMBIGUOUS_COUNT=$(echo "$AMBIGUOUS_PATHS" | jq 'length' 2>/dev/null || echo 0)
  if [ "$AMBIGUOUS_COUNT" -le 2 ] && [ "$AMBIGUOUS_COUNT" -gt 0 ]; then
    PATH1=$(echo "$AMBIGUOUS_PATHS" | jq -r '.[0] // ""' 2>/dev/null)
    PATH2=$(echo "$AMBIGUOUS_PATHS" | jq -r '.[1] // ""' 2>/dev/null)
    AskUserQuestion(
      question="Multiple submodules have changes. Which submodule(s) should be branched?",
      options=["$PATH1", "$PATH2", "All of them", "Skip branching"]
    )
    # If user selects a specific path or "All of them": loop gitcmd over selected paths to create/checkout branch
    # If "Skip branching": continue on current branch
  else
    # 3+ ambiguous paths: text list + binary choice
    echo "Multiple submodules have changes:"
    echo "$AMBIGUOUS_PATHS" | jq -r '.[] | "  - " + .' 2>/dev/null
    AskUserQuestion(
      question="Multiple submodules have uncommitted changes. How should branching proceed?",
      options=["Branch all of them", "Skip branching"]
    )
    # If "Branch all of them": loop gitcmd over all paths in AMBIGUOUS_PATHS
    # If "Skip branching": continue on current branch
  fi
fi
```

**Routing helper and effective target branch:** Define a shell function to route git commands to the correct repository:

```bash
if [ "$SUBMODULE_IS_ACTIVE" = "true" ] && [ "$SUBMODULE_AMBIGUOUS" != "true" ] && [ -n "$SUBMODULE_GIT_CWD" ]; then
  gitcmd() { git -C "$SUBMODULE_GIT_CWD" "$@"; }
  EFFECTIVE_TARGET_BRANCH="$SUBMODULE_TARGET_BRANCH"
else
  gitcmd() { git "$@"; }
  EFFECTIVE_TARGET_BRANCH="$TARGET_BRANCH"
fi
```


**"phase":** Use pre-computed `branch_name` from init. Base from `EFFECTIVE_TARGET_BRANCH`:

```bash
# Base new work branch from effective target branch (not current HEAD)
gitcmd checkout -b "$BRANCH_NAME" "$EFFECTIVE_TARGET_BRANCH" 2>/dev/null || gitcmd checkout "$BRANCH_NAME"
```

**"milestone":** Use pre-computed `branch_name` from init. If branch already exists (subsequent phases), just checkout. If new (first phase of milestone), create from `EFFECTIVE_TARGET_BRANCH`:

```bash
if gitcmd show-ref --verify --quiet "refs/heads/$BRANCH_NAME" 2>/dev/null; then
  # Milestone branch already exists (not first phase) — just switch to it
  gitcmd checkout "$BRANCH_NAME"
else
  # First phase of milestone — create from effective target branch
  gitcmd checkout -b "$BRANCH_NAME" "$EFFECTIVE_TARGET_BRANCH"
fi
```

All subsequent commits go to this branch.
</step>

<step name="validate_phase">
From init JSON: `phase_dir`, `plan_count`, `incomplete_count`.

Report: "Found {plan_count} plans in {phase_dir} ({incomplete_count} incomplete)"

**Update STATE.md for phase start:**
```bash
node "$HOME/.claude/gsd-ng/bin/gsd-tools.cjs" state begin-phase --phase "${PHASE_NUMBER}" --name "${PHASE_NAME}" --plans "${PLAN_COUNT}"
```
This updates Status, Last Activity, Current focus, Current Position, and plan counts in STATE.md so frontmatter and body text reflect the active phase immediately.
</step>

<step name="capture_test_baseline">
Discover test commands via CLI and capture per-directory baselines. Supports standalone, submodule, and monorepo workspaces.

```bash
# Discover test commands (config override or workspace-aware auto-detect)
DISCOVERED=$(node "$HOME/.claude/gsd-ng/bin/gsd-tools.cjs" discover-test-command)

ENTRY_COUNT=$(node -e "console.log(JSON.parse(process.argv[1]).length)" "$DISCOVERED")
if [[ "$ENTRY_COUNT" -eq 0 ]]; then
  echo "No test command found — skipping test baseline capture"
fi

if [[ "$ENTRY_COUNT" -gt 0 ]]; then
  BASELINE_FILE="${PHASE_DIR}/${PHASE_NUMBER}-test-baseline.json"
  echo "Capturing test baselines for $ENTRY_COUNT directory(ies)..."

  node "${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}/.claude/gsd-ng/bin/gsd-tools.cjs" test capture-baseline "$DISCOVERED" "$BASELINE_FILE"
fi
```

Store `$DISCOVERED`, `$ENTRY_COUNT`, and `$BASELINE_FILE` for use in the pre-UAT step.
</step>

<step name="discover_and_group_plans">
Load plan inventory with wave grouping in one call:

```bash
PLAN_INDEX=$(node "$HOME/.claude/gsd-ng/bin/gsd-tools.cjs" phase-plan-index "${PHASE_NUMBER}")
```

Parse JSON for: `phase`, `plans[]` (each with `id`, `wave`, `autonomous`, `objective`, `files_modified`, `task_count`, `has_summary`), `waves` (map of wave number → plan IDs), `incomplete`, `has_checkpoints`.

**File-overlap check:** If `PLAN_INDEX` JSON contains a non-empty `overlaps` array, log a warning for each entry:
```
WARNING: Same-wave file overlap detected — {overlap.plans[0]} and {overlap.plans[1]} share: {overlap.files.join(', ')}
These plans may cause Edit conflicts or Write overwrites during parallel execution.
Consider re-planning with {{COMMAND_PREFIX}}plan-phase to separate into sequential waves.
```
Continue execution (advisory-only, not blocking) — the planner should have prevented this, so runtime overlap is informational.

**Filtering:** Skip plans where `has_summary: true`. If `--gaps-only`: also skip non-gap_closure plans. If all filtered: "No matching incomplete plans" → exit.

Report:
```
## Execution Plan

**Phase {X}: {Name}** — {total_plans} plans across {wave_count} waves

| Wave | Plans | What it builds |
|------|-------|----------------|
| 1 | 01-01, 01-02 | {from plan objectives, 3-8 words} |
| 2 | 01-03 | ... |
```
</step>

<step name="execute_waves">
Execute each wave in sequence. Within a wave: parallel if `PARALLELIZATION=true`, sequential if `false`.

**For each wave:**

1. **Describe what's being built (BEFORE spawning):**

   Read each plan's `<objective>`. Extract what's being built and why.

   ```
   ---
   ## Wave {N}

   **{Plan ID}: {Plan Name}**
   {2-3 sentences: what this builds, technical approach, why it matters}

   Spawning {count} agent(s)...
   ---
   ```

   - Bad: "Executing terrain generation plan"
   - Good: "Procedural terrain generator using Perlin noise — creates height maps, biome zones, and collision meshes. Required before vehicle physics can interact with ground."

2. **Spawn executor agents:**

   Pass paths only — executors read files themselves with their fresh 200k context.
   This keeps orchestrator context lean (~10-15%).

   Resolve workspace topology for agent context injection:
   ```bash
   WORKSPACE_TYPE=$(node "${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}/.claude/gsd-ng/bin/gsd-tools.cjs" detect-workspace --field type)
   WORKSPACE_JSON=$(node "${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}/.claude/gsd-ng/bin/gsd-tools.cjs" detect-workspace)
   SUBMODULE_PATHS=$(node -e "try{const w=JSON.parse(process.argv[1]);const p=w.submodule_paths||[];process.stdout.write(p.join(', ')||'none')}catch{process.stdout.write('none')}" "$WORKSPACE_JSON")
   PROJECT_ROOT="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
   ```

   ```
   Task(
     subagent_type="gsd-executor",
     model="{executor_model}",
     prompt="
       <objective>
       Execute plan {plan_number} of phase {phase_number}-{phase_name}.
       Commit each task atomically. Create SUMMARY.md. Update STATE.md and ROADMAP.md.
       </objective>

       <execution_context>
       @~/.claude/gsd-ng/workflows/execute-plan.md
       @~/.claude/gsd-ng/templates/summary.md
       @~/.claude/gsd-ng/references/checkpoints-core.md
       @~/.claude/gsd-ng/references/tdd.md
       </execution_context>

       <workspace_context>
       Workspace type: {WORKSPACE_TYPE}
       Project root: {PROJECT_ROOT}
       Submodule paths: {SUBMODULE_PATHS}

       CRITICAL: Always commit to the source location. Your working directory is {PROJECT_ROOT}.
       If workspace type is 'submodule', source code lives in the submodule directories listed above.
       Do NOT modify deployed copies (e.g., .claude/gsd-ng/) — always edit source first.
       </workspace_context>

       <files_to_read>
       Read these files at execution start using the Read tool:
       - {phase_dir}/{plan_file} (Plan)
       - .planning/STATE.md (State)
       - .planning/config.json (Config, if exists)
       - ./{{PROJECT_RULES_FILE}} (Project instructions, if exists — follow project-specific guidelines and coding conventions)
       - .claude/skills/ or .agents/skills/ (Project skills, if either exists — list skills, read SKILL.md for each, follow relevant rules during implementation)
       </files_to_read>

       <success_criteria>
       - [ ] All tasks executed
       - [ ] Each task committed individually
       - [ ] SUMMARY.md created in plan directory
       - [ ] STATE.md updated with position and decisions
       - [ ] ROADMAP.md updated with plan progress (via `roadmap update-plan-progress`)
       </success_criteria>
     "
   )
   ```

3. **Wait for all agents in wave to complete.**

4. **Report completion — spot-check claims first:**

   For each SUMMARY.md:
   - Verify first 2 files from `key-files.created` exist on disk
   - Check `git log --oneline --all --grep="{phase}-{plan}"` returns ≥1 commit
   - Check for `## Self-Check: FAILED` marker
   - **Breakout check** — compare committed files against plan's `files_modified`:
     ```bash
     PLAN_FILE="{phase_dir}/{plan_file}"
     FILES_MODIFIED=$(node "${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}/.claude/gsd-ng/bin/gsd-tools.cjs" frontmatter get "$PLAN_FILE" --field files_modified 2>/dev/null)

     if [[ -n "$FILES_MODIFIED" ]]; then
       BREAKOUT_RESULT=$(node "${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}/.claude/gsd-ng/bin/gsd-tools.cjs" breakout-check --plan "{phase}-{plan}" --declared-files "$FILES_MODIFIED" 2>/dev/null)
     fi
     ```
     - If `BREAKOUT_RESULT` is `warning`: log in wave completion output — "Note: executor modified files outside declared scope: {list}". Continue execution.
     - If `BREAKOUT_RESULT` is `halt`: present AskUserQuestion (breakout scope escalation) to user:
       - Question: "Executor modified {N} files outside declared plan scope. How should we proceed?"
       - Options: "Continue" (proceed to next wave), "Investigate first" (pause — review changes before next wave), "Rollback this plan" (revert plan commits and mark failed)
     - If `ok`: silent — no output needed.

   If ANY spot-check fails: report which plan failed, route to failure handler — ask "Retry plan?" or "Continue with remaining waves?"

   If pass:
   ```
   ---
   ## Wave {N} Complete

   **{Plan ID}: {Plan Name}**
   {What was built — from SUMMARY.md}
   {Notable deviations, if any}

   {If more waves: what this enables for next wave}
   ---
   ```

   - Bad: "Wave 2 complete. Proceeding to Wave 3."
   - Good: "Terrain system complete — 3 biome types, height-based texturing, physics collision meshes. Vehicle physics (Wave 3) can now reference ground surfaces."

5. **Handle failures:**

   **Known Claude Code bug (classifyHandoffIfNeeded):** If an agent reports "failed" with error containing `classifyHandoffIfNeeded is not defined`, this is a Claude Code runtime bug — not a GSD or agent issue. The error fires in the completion handler AFTER all tool calls finish. In this case: run the same spot-checks as step 4 (SUMMARY.md exists, git commits present, no Self-Check: FAILED). If spot-checks PASS → treat as **successful**. If spot-checks FAIL → treat as real failure below.

   For real failures: report which plan failed → ask "Continue?" or "Stop?" → if continue, dependent plans may also fail. If stop, partial completion report.

6. **Execute checkpoint plans between waves** — see `<checkpoint_handling>`.

7. **Proceed to next wave.**
</step>

<step name="checkpoint_handling">
Plans with `autonomous: false` require user interaction.

**Auto-mode checkpoint handling:**

Read auto-advance config (chain flag + user preference):
```bash
AUTO_CHAIN=$(node "$HOME/.claude/gsd-ng/bin/gsd-tools.cjs" config-get workflow._auto_chain_active --default "false")
AUTO_CFG=$(node "$HOME/.claude/gsd-ng/bin/gsd-tools.cjs" config-get workflow.auto_advance --default "false")
```

When executor returns a checkpoint AND (`AUTO_CHAIN` is `"true"` OR `AUTO_CFG` is `"true"`):
- **human-verify** → Auto-spawn continuation agent with `{user_response}` = `"approved"`. Log `⚡ Auto-approved checkpoint`.
- **decision** → Auto-spawn continuation agent with `{user_response}` = first option from checkpoint details. Log `⚡ Auto-selected: [option]`.
- **human-action** → Present to user (existing behavior below). Auth gates cannot be automated.

**Standard flow (not auto-mode, or human-action type):**

1. Spawn agent for checkpoint plan
2. Agent runs until checkpoint task or auth gate → returns structured state
3. Agent return includes: completed tasks table, current task + blocker, checkpoint type/details, what's awaited
4. **Present to user:**
   ```
   ## Checkpoint: [Type]

   **Plan:** 03-03 Dashboard Layout
   **Progress:** 2/3 tasks complete

   [Checkpoint Details from agent return]
   [Awaiting section from agent return]
   ```
5. User responds: "approved"/"done" | issue description | decision selection
6. **Spawn continuation agent (NOT resume)** using continuation-prompt.md template:
   - `{completed_tasks_table}`: From checkpoint return
   - `{resume_task_number}` + `{resume_task_name}`: Current task
   - `{user_response}`: What user provided
   - `{resume_instructions}`: Based on checkpoint type
7. Continuation agent verifies previous commits, continues from resume point
8. Repeat until plan completes or user stops

**Why fresh agent, not resume:** Resume relies on internal serialization that breaks with parallel tool calls. Fresh agents with explicit state are more reliable.

**Checkpoints in parallel waves:** Agent pauses and returns while other parallel agents may complete. Present checkpoint, spawn continuation, wait for all before next wave.
</step>

<step name="aggregate_results">
After all waves:

```markdown
## Phase {X}: {Name} Execution Complete

**Waves:** {N} | **Plans:** {M}/{total} complete

| Wave | Plans | Status |
|------|-------|--------|
| 1 | plan-01, plan-02 | ✓ Complete |
| CP | plan-03 | ✓ Verified |
| 2 | plan-04 | ✓ Complete |

### Plan Details
1. **03-01**: [one-liner from SUMMARY.md]
2. **03-02**: [one-liner from SUMMARY.md]

### Issues Encountered
[Aggregate from SUMMARYs, or "None"]
```

**Post-phase push (when configured):**

Read from init JSON: `auto_push`, `branch_name`, `branching_strategy`.

```bash
# Only push if auto_push is enabled and we're on a GSD-managed branch
if [ "$AUTO_PUSH" = "true" ] && [ "$BRANCHING_STRATEGY" != "none" ] && [ -n "$BRANCH_NAME" ]; then

  # Route push to correct repository
  if [ "$SUBMODULE_IS_ACTIVE" = "true" ] && [ "$SUBMODULE_AMBIGUOUS" != "true" ] && [ -n "$SUBMODULE_GIT_CWD" ]; then
    GIT_CWD="${SUBMODULE_GIT_CWD}"
    PUSH_REMOTE=$(node "$HOME/.claude/gsd-ng/bin/gsd-tools.cjs" init-get "$INIT" submodule_remote 2>/dev/null)
    SUBMODULE_REMOTE_URL=$(node "$HOME/.claude/gsd-ng/bin/gsd-tools.cjs" init-get "$INIT" submodule_remote_url 2>/dev/null)
  else
    GIT_CWD="."
    PUSH_REMOTE=$(node "$HOME/.claude/gsd-ng/bin/gsd-tools.cjs" init-get "$INIT" remote 2>/dev/null)
    SUBMODULE_REMOTE_URL=""
  fi
  AMBIGUOUS="${SUBMODULE_AMBIGUOUS}"
```

**Ambiguous check:** If `$AMBIGUOUS` is `"true"`, warn the user that multiple submodules have changes — extract `ambiguous_paths` from `$INIT` and list them. Skip the push. Do not proceed.

**SSH pre-push check:**

```bash
  SSH_CHECK=$(node "$HOME/.claude/gsd-ng/bin/gsd-tools.cjs" config-get git.ssh_check --default true)
  if [ "$SSH_CHECK" = "true" ] && [ -n "$SUBMODULE_REMOTE_URL" ]; then
    SSH_STATUS=$(node "$HOME/.claude/gsd-ng/bin/gsd-tools.cjs" ssh-check "$SUBMODULE_REMOTE_URL" --field status)
    if [ "$SSH_STATUS" != "ok" ] && [ "$SSH_STATUS" != "not_required" ]; then
      SSH_MSG=$(node "$HOME/.claude/gsd-ng/bin/gsd-tools.cjs" ssh-check "$SUBMODULE_REMOTE_URL" --field message)
      echo "WARNING: SSH check failed — $SSH_MSG"
      # Also check for SSH signing
      GPG_FORMAT=$(git -C "$GIT_CWD" config gpg.format 2>/dev/null || echo "")
      if [ "$GPG_FORMAT" = "ssh" ]; then
        echo "NOTE: gpg.format=ssh detected — your signing key also needs to be loaded in the SSH agent."
      fi
    fi
  fi
```

```bash
  echo "Pushing $BRANCH_NAME to $PUSH_REMOTE..."

  # Push with upstream tracking (safe to use -u unconditionally — git ignores it when upstream exists)
  PUSH_OUT=$(git -C "$GIT_CWD" push -u "$PUSH_REMOTE" "$BRANCH_NAME" 2>&1)
  PUSH_EXIT=$?

  if [ $PUSH_EXIT -ne 0 ]; then
    echo "Warning: Push to $PUSH_REMOTE failed: $PUSH_OUT"
    echo "Local commits are safe. Push manually: git -C \"$GIT_CWD\" push -u $PUSH_REMOTE $BRANCH_NAME"
  else
    echo "Pushed $BRANCH_NAME to $PUSH_REMOTE"
  fi
fi
```
</step>

<step name="close_parent_artifacts">
**For decimal/polish phases only (X.Y pattern):** Close the feedback loop by resolving parent UAT and debug artifacts.

**Skip if** phase number has no decimal (e.g., `3`, `04`) — only applies to gap-closure phases like `4.1`, `03.1`.

**1. Detect decimal phase and derive parent:**
```bash
# Check if phase_number contains a decimal
if [[ "$PHASE_NUMBER" == *.* ]]; then
  PARENT_PHASE="${PHASE_NUMBER%%.*}"
fi
```

**2. Find parent UAT file:**
```bash
PARENT_INFO=$(node "$HOME/.claude/gsd-ng/bin/gsd-tools.cjs" find-phase "${PARENT_PHASE}")
# Extract directory from PARENT_INFO JSON, then find UAT file in that directory
```

**If no parent UAT found:** Skip this step (gap-closure may have been triggered by VERIFICATION.md instead).

**3. Update UAT gap statuses:**

Read the parent UAT file's `## Gaps` section. For each gap entry with `status: failed`:
- Update to `status: resolved`

**4. Update UAT frontmatter:**

If all gaps now have `status: resolved`:
- Update frontmatter `status: diagnosed` → `status: resolved`
- Update frontmatter `updated:` timestamp

**5. Resolve referenced debug sessions:**

For each gap that has a `debug_session:` field:
- Read the debug session file
- Update frontmatter `status:` → `resolved`
- Update frontmatter `updated:` timestamp
- Move to resolved directory:
```bash
mkdir -p .planning/debug/resolved
mv .planning/debug/{slug}.md .planning/debug/resolved/
```

**6. Commit updated artifacts:**
```bash
node "$HOME/.claude/gsd-ng/bin/gsd-tools.cjs" commit "docs(phase-${PARENT_PHASE}): resolve UAT gaps and debug sessions after ${PHASE_NUMBER} gap closure" --files .planning/phases/*${PARENT_PHASE}*/*-UAT.md .planning/debug/resolved/*.md
```
</step>

<step name="run_pre_uat_tests">
Re-run discovered test commands after executor agents complete. Display results in GSD banner format. Triage new failures vs pre-existing.

Skip this step entirely if `$ENTRY_COUNT` is 0 (no test commands were discovered).

```bash
if [[ "$ENTRY_COUNT" -gt 0 ]]; then
  node "${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}/.claude/gsd-ng/bin/gsd-tools.cjs" test compare-baseline "$DISCOVERED" "$BASELINE_FILE"
fi
```

**Triage decision (only when new failures detected):**

Parse `NEW_FAILURES` from the node output above. If `NEW_FAILURES=true`:

```
AskUserQuestion(
  header: "Test Triage",
  question: "Tests failed after execution. How should these failures be handled?",
  multiSelect: false,
  options: [
    { label: "Regressions — create gaps", description: "These are new breakages from this phase. Add to VERIFICATION.md as gaps for closure." },
    { label: "Expected breakage", description: "Intentional — will be fixed in a later plan or todo. Create tracking todo." },
    { label: "Continue anyway", description: "Proceed to verification. Verifier will assess independently." }
  ]
)
```

If user selects "Regressions": Note the test failures for the verifier. The verifier's VERIFICATION.md will include these as gaps.

If user selects "Expected breakage": Offer to create a todo tracking the expected breakage.

If user selects "Continue anyway": Proceed normally to verify_phase_goal.

If `NEW_FAILURES=false`: pre-existing failures only — do NOT prompt, proceed to verify_phase_goal.
</step>

<step name="verify_phase_goal">
Verify phase achieved its GOAL, not just completed tasks.

```
Task(
  prompt="Verify phase {phase_number} goal achievement.
Phase directory: {phase_dir}
Phase goal: {goal from ROADMAP.md}
Phase requirement IDs: {phase_req_ids}
Check must_haves against actual codebase.
Cross-reference requirement IDs from PLAN frontmatter against REQUIREMENTS.md — every ID MUST be accounted for.
Create VERIFICATION.md.",
  subagent_type="gsd-verifier",
  model="{verifier_model}"
)
```

Read status:
```bash
grep "^status:" "$PHASE_DIR"/*-VERIFICATION.md | cut -d: -f2 | tr -d ' '
```

| Status | Action |
|--------|--------|
| `passed` | → update_roadmap |
| `human_needed` | Present items for human testing, get approval or feedback |
| `gaps_found` | Present gap summary, offer `{{COMMAND_PREFIX}}plan-phase {phase} --gaps` |

**If human_needed:**
```
## ✓ Phase {X}: {Name} — Human Verification Required

All automated checks passed. {N} items need human testing:

{From VERIFICATION.md human_verification section}

"approved" → continue | Report issues → gap closure
```

**If gaps_found:**
```
## ⚠ Phase {X}: {Name} — Gaps Found

**Score:** {N}/{M} must-haves verified
**Report:** {phase_dir}/{phase_num}-VERIFICATION.md

### What's Missing
{Gap summaries from VERIFICATION.md}

---
## ▶ Next Up

`{{COMMAND_PREFIX}}plan-phase {X} --gaps`

*`/clear` first → fresh context window*

Also: `cat {phase_dir}/{phase_num}-VERIFICATION.md` — full report
Also: `{{COMMAND_PREFIX}}verify-work {X}` — manual testing first
```

Gap closure cycle: `{{COMMAND_PREFIX}}plan-phase {X} --gaps` reads VERIFICATION.md → creates gap plans with `gap_closure: true` → user runs `{{COMMAND_PREFIX}}execute-phase {X} --gaps-only` → verifier re-runs.
</step>

<step name="update_roadmap">
**Mark phase complete and update all tracking files:**

```bash
COMPLETION=$(node "$HOME/.claude/gsd-ng/bin/gsd-tools.cjs" phase complete "${PHASE_NUMBER}")
```

The CLI handles:
- Marking phase checkbox `[x]` with completion date
- Updating Progress table (Status → Complete, date)
- Updating plan count to final
- Advancing STATE.md to next phase
- Closing REQUIREMENTS.md checkboxes and traceability rows for this phase

**Requirement closure happens here and only here** — not per-plan. `phase complete`
takes the union of the ROADMAP phase section's `**Requirements:**` line and the
`requirements:` frontmatter of every PLAN.md in the phase, then closes them
*unless* VERIFICATION.md reports `gaps_found` or `halted`, in which case they stay
Pending until gaps are closed and the verifier re-runs.

Closure is scoped to this phase. An ID the REQUIREMENTS.md traceability table
assigns to a *different* phase is never closed here, however the plan frontmatter
declares it — closing it would make the table assert that unstarted work is done.
Such IDs come back in `requirements_other_phase`, and IDs missing from the table
entirely come back in `requirements_unmapped`.

Extract from result: `next_phase`, `next_phase_name`, `is_last_phase`,
`requirements_closed`, `requirements_blocked_by`, `requirements_other_phase`,
`requirements_unmapped`.

**Report both discrepancy lists to the user** if non-empty. `requirements_other_phase`
means a plan believed it delivered a requirement the roadmap owes to another phase
— either the plan overreached or the traceability table is wrong, and a human must
decide which. `requirements_unmapped` means the traceability table has a coverage
gap that roadmap or milestone-gap planning should fill.

```bash
node "$HOME/.claude/gsd-ng/bin/gsd-tools.cjs" commit "docs(phase-{X}): complete phase execution" --files .planning/ROADMAP.md .planning/STATE.md .planning/REQUIREMENTS.md {phase_dir}/*-VERIFICATION.md
```
</step>

<step name="auto_sync_issues">
After phase completion is committed, check for external issue auto-sync:

```bash
AUTO_SYNC=$(node "$HOME/.claude/gsd-ng/bin/gsd-tools.cjs" config-get issue_tracker.auto_sync --default true)
```

If `AUTO_SYNC` is `"true"` (string comparison — config-get returns raw string):

```bash
SYNC_RESULT=$(node "$HOME/.claude/gsd-ng/bin/gsd-tools.cjs" issue-sync "${PHASE_NUMBER}" --auto 2>/dev/null)
```

Parse SYNC_RESULT JSON. If `synced` array has entries, display:
```
## Issue Tracker Sync

| Issue | Action | Result |
|-------|--------|--------|
| {ref} | {action} | {success ? 'synced' : 'failed'} |

{N} external issues updated.
```

If `synced` is empty or SYNC_RESULT is empty/failed, display nothing (silent pass-through). Auto-sync should never block phase completion — errors are logged but execution continues.

If `AUTO_SYNC` is `"false"`: skip entirely, no output.
</step>

<step name="incremental_remap">

```bash
INCREMENTAL_REMAP=$(node "$HOME/.claude/gsd-ng/bin/gsd-tools.cjs" config-get workflow.incremental_remap --default "true")
```

If `[ "$INCREMENTAL_REMAP" != "true" ]`: skip this step silently and proceed to `offer_next`.

If `[ "$INCREMENTAL_REMAP" = "true" ]` (default): After phase completion is committed, trigger incremental codebase re-mapping if codebase docs exist:

```bash
STALE_COUNT=$(node "$HOME/.claude/gsd-ng/bin/gsd-tools.cjs" staleness-check --count)
```

If STALE_COUNT is 0: skip silently (no stale docs, nothing to update).

If STALE_COUNT > 0:

```
{STALE_COUNT} codebase doc(s) have changes since last mapping. Running incremental update...
```

Fetch the full stale doc list:
```bash
STALE_JSON=$(node "$HOME/.claude/gsd-ng/bin/gsd-tools.cjs" staleness-check)
```

For each stale doc in the `stale` array from STALE_JSON, spawn a `gsd-incremental-mapper` agent:

```
Task(
  subagent_type="gsd-incremental-mapper",
  model="{executor_model}",
  run_in_background=true,
  description="Incremental update: {doc_name}",
  prompt="Update .planning/codebase/{doc_name} based on changes since last map.

Changed files: {changed_files_list}

Run: git diff --stat {last_mapped_commit}..HEAD -- {changed_files_as_args}

Read the existing doc, update only sections affected by the changed files, preserve all other sections verbatim. Update last_mapped_commit to current HEAD."
)
```

Wait for all mapper agents to complete. Report results:

```
Incremental codebase mapping: {completed}/{total} docs updated.
```

If any mapper failed, log but do not block phase completion.

Commit updated codebase docs:
```bash
node "$HOME/.claude/gsd-ng/bin/gsd-tools.cjs" commit "docs: incremental codebase remap after phase ${PHASE_NUMBER}" --files .planning/codebase/*.md
```
</step>

<step name="offer_next">

**Exception:** If `gaps_found`, the `verify_phase_goal` step already presents the gap-closure path (`{{COMMAND_PREFIX}}plan-phase {X} --gaps`). No additional routing needed — skip auto-advance.

**No-transition check (spawned by auto-advance chain):**

Parse `--no-transition` flag from $ARGUMENTS.

**If `--no-transition` flag present:**

Execute-phase was spawned by plan-phase's auto-advance. Do NOT run transition.md.
After verification passes and roadmap is updated, return completion status to parent:

```
## PHASE COMPLETE

Phase: ${PHASE_NUMBER} - ${PHASE_NAME}
Plans: ${completed_count}/${total_count}
Verification: {Passed | Gaps Found}

[Include aggregate_results output]
```

STOP. Do not proceed to auto-advance or transition.

**Create PR suggestion (when applicable):**

If `branching_strategy` is not `"none"` AND push succeeded (or `auto_push` is enabled):
```
---
**Create a PR:** `{{COMMAND_PREFIX}}create-pr {phase}` — squash work into review branch and open PR
---
```

**If `--no-transition` flag is NOT present:**

**Auto-advance detection:**

1. Parse `--auto` flag from $ARGUMENTS
2. Read both the chain flag and user preference (chain flag already synced in init step):
   ```bash
   AUTO_CHAIN=$(node "$HOME/.claude/gsd-ng/bin/gsd-tools.cjs" config-get workflow._auto_chain_active --default "false")
   AUTO_CFG=$(node "$HOME/.claude/gsd-ng/bin/gsd-tools.cjs" config-get workflow.auto_advance --default "false")
   ```

**If `--auto` flag present OR `AUTO_CHAIN` is true OR `AUTO_CFG` is true (AND verification passed with no gaps):**

```
╔══════════════════════════════════════════╗
║  AUTO-ADVANCING → TRANSITION             ║
║  Phase {X} verified, continuing chain    ║
╚══════════════════════════════════════════╝
```

Execute the transition workflow inline (do NOT use Task — orchestrator context is ~10-15%, transition needs phase completion data already in context):

Read and follow `~/.claude/gsd-ng/workflows/transition.md`, passing through the `--auto` flag so it propagates to the next phase invocation.

**If none of `--auto`, `AUTO_CHAIN`, or `AUTO_CFG` is true:**

**STOP. Do not auto-advance. Do not execute transition. Do not plan next phase. Present options to the user and wait.**

```
## ✓ Phase {X}: {Name} Complete

{{COMMAND_PREFIX}}progress — see updated roadmap
{{COMMAND_PREFIX}}discuss-phase {next} — discuss next phase before planning
{{COMMAND_PREFIX}}plan-phase {next} — plan next phase
{{COMMAND_PREFIX}}execute-phase {next} — execute next phase
```
</step>

<step name="close_origin_todo">
**Origin todo closure (only when phase was started from a todo).**

Check if the phase was started with a `--todo-file` argument:

```bash
ORIGIN_TODO_FILE=""
if [[ "$ARGUMENTS" == *"--todo-file "* ]]; then
  ORIGIN_TODO_FILE=$(echo "$ARGUMENTS" | sed -n 's/.*--todo-file \([^ ]*\).*/\1/p')
fi
```

**Defensive guard:** If the todo file no longer exists in pending/ (e.g., executor already moved it), clear the variable and skip closure.

```bash
if [[ -n "$ORIGIN_TODO_FILE" ]] && [[ ! -f ".planning/todos/pending/$ORIGIN_TODO_FILE" ]]; then
  echo "[warn] Origin todo already moved from pending/: $ORIGIN_TODO_FILE — skipping closure"
  ORIGIN_TODO_FILE=""
fi
```

Skip if `$ORIGIN_TODO_FILE` is empty or if the phase status is NOT `passed` (verification must have passed).

```bash
ORIGIN_TODO_TITLE=""
if [[ -n "$ORIGIN_TODO_FILE" ]]; then
  ORIGIN_TODO_TITLE=$(grep '^title:' ".planning/todos/pending/$ORIGIN_TODO_FILE" 2>/dev/null | sed 's/^title:\s*//')
fi
```

**Verification gate:** Only offer closure when the VERIFICATION.md status is `passed`. If status is `gaps_found` or `halted`, do NOT offer closure — the todo's work is not complete.

```bash
VERIFY_STATUS=$(grep "^status:" "$PHASE_DIR"/*-VERIFICATION.md 2>/dev/null | tail -1 | cut -d: -f2 | tr -d ' ')
```

If `$VERIFY_STATUS` is `passed` AND `$ORIGIN_TODO_FILE` is set:

**Auto mode:**
```bash
AUTO_CFG=$(node "$HOME/.claude/gsd-ng/bin/gsd-tools.cjs" config-get workflow._auto_chain_active --default false)
```

If auto: close todo, log `[auto] Closed todo: $ORIGIN_TODO_TITLE`.
```bash
node "$HOME/.claude/gsd-ng/bin/gsd-tools.cjs" todo complete "$ORIGIN_TODO_FILE"
node "$HOME/.claude/gsd-ng/bin/gsd-tools.cjs" commit "docs: close todo after phase completion" --files .planning/todos/completed/$ORIGIN_TODO_FILE .planning/todos/pending/$ORIGIN_TODO_FILE
```

**Interactive mode:**
```
AskUserQuestion(
  header: "Close Todo?",
  question: "This phase was started from todo '$ORIGIN_TODO_TITLE'. Phase verification passed. Close it?",
  multiSelect: false,
  options: [
    { label: "Yes, close it", description: "Mark todo as complete" },
    { label: "No, keep open", description: "Leave in pending for further work" }
  ]
)
```

If confirmed:
```bash
node "$HOME/.claude/gsd-ng/bin/gsd-tools.cjs" todo complete "$ORIGIN_TODO_FILE"
node "$HOME/.claude/gsd-ng/bin/gsd-tools.cjs" commit "docs: close todo after phase completion" --files .planning/todos/completed/$ORIGIN_TODO_FILE .planning/todos/pending/$ORIGIN_TODO_FILE
```

**Phase-linked todo scan (after handling --todo-file):**

Scan pending todos for `phase:` frontmatter matching the current phase number. Only fire if `$VERIFY_STATUS` is `passed`.

```bash
if [[ "$VERIFY_STATUS" == "passed" ]]; then
  PHASE_LINKED=""
  PENDING_DIR=".planning/todos/pending"
  if [[ -d "$PENDING_DIR" ]]; then
    for TODO_FILE in "$PENDING_DIR"/*.md; do
      [[ -f "$TODO_FILE" ]] || continue
      TODO_PHASE=$(node "$HOME/.claude/gsd-ng/bin/gsd-tools.cjs" frontmatter get "$TODO_FILE" --field phase --default "")
      if [[ "$(echo "$TODO_PHASE" | tr -d '[:space:]')" == "${PHASE_NUMBER}" ]]; then
        TODO_BASENAME=$(basename "$TODO_FILE")
        TODO_TITLE=$(grep '^title:' "$TODO_FILE" 2>/dev/null | sed 's/^title:\s*//' | tr -d '"')
        PHASE_LINKED="${PHASE_LINKED}${TODO_BASENAME}|${TODO_TITLE}\n"
      fi
    done
  fi
fi
```

If `$PHASE_LINKED` is non-empty (at least one phase-linked todo found):

**Auto mode:**
```bash
AUTO_CFG=$(node "$HOME/.claude/gsd-ng/bin/gsd-tools.cjs" config-get workflow._auto_chain_active --default false)
```

If auto: for each phase-linked todo, close it and commit:
```bash
# For each TODO_BASENAME in PHASE_LINKED:
node "$HOME/.claude/gsd-ng/bin/gsd-tools.cjs" todo complete "$TODO_BASENAME"
node "$HOME/.claude/gsd-ng/bin/gsd-tools.cjs" commit "docs: close phase-linked todo after phase ${PHASE_NUMBER} completion" --files ".planning/todos/completed/$TODO_BASENAME" ".planning/todos/pending/$TODO_BASENAME"
```
Log: `[auto] Closed phase-linked todo: $TODO_TITLE`

**Interactive mode:**
```
AskUserQuestion(
  header: "Phase Todos",
  question: "These pending todos are linked to Phase ${PHASE_NUMBER}. Phase verification passed. Close them?",
  multiSelect: true,
  options: [
    { label: "[todo-filename-1]", description: "[todo-title-1]" },
    ...
    { label: "Keep all open", description: "Leave all in pending" }
  ]
)
```

For each selected todo (not "Keep all open"):
```bash
node "$HOME/.claude/gsd-ng/bin/gsd-tools.cjs" todo complete "$SELECTED_BASENAME"
node "$HOME/.claude/gsd-ng/bin/gsd-tools.cjs" commit "docs: close phase-linked todo after phase ${PHASE_NUMBER} completion" --files ".planning/todos/completed/$SELECTED_BASENAME" ".planning/todos/pending/$SELECTED_BASENAME"
```

Note: `todo complete` triggers inline issue-sync automatically (from Plan 01) — no additional sync code needed here.

**Related Todos scan (after phase-linked scan):**

Fire when `$VERIFY_STATUS` is `passed` AND `$ORIGIN_TODO_FILE` is set. The origin todo may now be in completed/ (just closed above), so check both locations.

**Step 1 — Read outbound links from origin todo:**
```bash
RELATED_OUTBOUND=""
if [[ -n "$ORIGIN_TODO_FILE" ]] && [[ "$VERIFY_STATUS" == "passed" ]]; then
  # Origin todo may have been moved to completed/ in the closure step above
  ORIGIN_PATH=".planning/todos/pending/$ORIGIN_TODO_FILE"
  if [[ ! -f "$ORIGIN_PATH" ]]; then
    ORIGIN_PATH=".planning/todos/completed/$ORIGIN_TODO_FILE"
  fi
  RELATED_OUTBOUND=$(node "$HOME/.claude/gsd-ng/bin/gsd-tools.cjs" frontmatter get "$ORIGIN_PATH" --field related --format newline --default "")
  if [[ "$RELATED_OUTBOUND" == "null" ]]; then RELATED_OUTBOUND=""; fi
fi
```

**Step 2 — Scan all pending todos for inbound links to origin:**
```bash
RELATED_INBOUND=""
PENDING_DIR=".planning/todos/pending"
if [[ -d "$PENDING_DIR" ]] && [[ -n "$ORIGIN_TODO_FILE" ]] && [[ "$VERIFY_STATUS" == "passed" ]]; then
  for TODO_FILE in "$PENDING_DIR"/*.md; do
    [[ -f "$TODO_FILE" ]] || continue
    TODO_BASENAME=$(basename "$TODO_FILE")
    # Skip the origin todo itself
    [[ "$TODO_BASENAME" == "$ORIGIN_TODO_FILE" ]] && continue
    if node "$HOME/.claude/gsd-ng/bin/gsd-tools.cjs" frontmatter get "$TODO_FILE" --field related --format newline 2>/dev/null | grep -qFx "$ORIGIN_TODO_FILE"; then
      RELATED_INBOUND="${RELATED_INBOUND}${TODO_BASENAME}\n"
    fi
  done
fi
```

**Step 3 — Deduplicate and filter (only pending/ files):**
```bash
RELATED_ALL=""
if [[ -n "$RELATED_OUTBOUND" ]] || [[ -n "$RELATED_INBOUND" ]]; then
  # Combine outbound + inbound, deduplicate, filter to files still in pending/
  RELATED_ALL=$(printf "%s\n%s" "$RELATED_OUTBOUND" "$RELATED_INBOUND" | sort -u | while read -r REL_FILE; do
    [[ -z "$REL_FILE" ]] && continue
    [[ "$REL_FILE" == "$ORIGIN_TODO_FILE" ]] && continue
    if [[ -f ".planning/todos/pending/$REL_FILE" ]]; then
      echo "$REL_FILE"
    fi
  done)
fi
```

**Step 4 — Present for closure (auto or interactive):**

If `$RELATED_ALL` is non-empty:

**Auto mode:**
```bash
if [[ "$AUTO_CFG" == "true" ]]; then
  printf '%s\n' "$RELATED_ALL" | while IFS= read -r REL_TODO; do
    [[ -z "$REL_TODO" ]] && continue
    REL_TITLE=$(grep '^title:' ".planning/todos/pending/$REL_TODO" 2>/dev/null | sed 's/^title:\s*//' | tr -d '"')
    node "$HOME/.claude/gsd-ng/bin/gsd-tools.cjs" todo complete "$REL_TODO"
    node "$HOME/.claude/gsd-ng/bin/gsd-tools.cjs" commit "docs: close related todo after phase completion" --files ".planning/todos/completed/$REL_TODO" ".planning/todos/pending/$REL_TODO"
    echo "[auto] Closed related todo: $REL_TITLE"
  done
fi
```

**Interactive mode** — build options list and use AskUserQuestion:
```
AskUserQuestion(
  header: "Related Todos",
  question: "Closing '$ORIGIN_TODO_TITLE' — these todos are linked via related:. Close them too?",
  multiSelect: true,
  options: [
    { label: "[rel-filename-1]", description: "[rel-title-1]" },
    ...
    { label: "Keep all open", description: "Leave all in pending" }
  ]
)
```

For each selected todo (not "Keep all open"):
```bash
node "$HOME/.claude/gsd-ng/bin/gsd-tools.cjs" todo complete "$SELECTED_REL"
node "$HOME/.claude/gsd-ng/bin/gsd-tools.cjs" commit "docs: close related todo after phase completion" --files ".planning/todos/completed/$SELECTED_REL" ".planning/todos/pending/$SELECTED_REL"
```

Note: `todo complete` triggers inline issue-sync automatically — no additional sync code needed.
</step>

</process>

<context_efficiency>
Orchestrator: ~10-15% context. Subagents: fresh 200k each. No polling (Task blocks). No context bleed.
</context_efficiency>

<failure_handling>
- **classifyHandoffIfNeeded false failure:** Agent reports "failed" but error is `classifyHandoffIfNeeded is not defined` → Claude Code bug, not GSD. Spot-check (SUMMARY exists, commits present) → if pass, treat as success
- **Agent fails mid-plan:** Missing SUMMARY.md → report, ask user how to proceed
- **Dependency chain breaks:** Wave 1 fails → Wave 2 dependents likely fail → user chooses attempt or skip
- **All agents in wave fail:** Systemic issue → stop, report for investigation
- **Checkpoint unresolvable:** "Skip this plan?" or "Abort phase execution?" → record partial progress in STATE.md
</failure_handling>

<resumption>
Re-run `{{COMMAND_PREFIX}}execute-phase {phase}` → discover_plans finds completed SUMMARYs → skips them → resumes from first incomplete plan → continues wave execution.

STATE.md tracks: last completed plan, current wave, pending checkpoints.
</resumption>
