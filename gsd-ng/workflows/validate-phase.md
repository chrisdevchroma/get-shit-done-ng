<purpose>
Audit Nyquist validation gaps for a completed phase. Generate missing tests. Update VALIDATION.md.
</purpose>

@~/.claude/gsd-ng/references/ask-user-question.md

<required_reading>
@~/.claude/gsd-ng/references/ui-brand.md
@~/.claude/gsd-ng/references/nyquist-evidence-tiers.md
</required_reading>

<process>

## 0. Initialize

```bash
INIT=$(node "$HOME/.claude/gsd-ng/bin/gsd-tools.cjs" init phase-op "${PHASE_ARG}")
if ! node "$HOME/.claude/gsd-ng/bin/gsd-tools.cjs" guard init-valid "$INIT" 2>/dev/null; then
  INIT=$(node "$HOME/.claude/gsd-ng/bin/gsd-tools.cjs" init phase-op "${PHASE_ARG}")
  if ! node "$HOME/.claude/gsd-ng/bin/gsd-tools.cjs" guard init-valid "$INIT"; then
    echo "Error: init failed twice. Check gsd-tools installation."
    exit 1
  fi
fi
```

Parse: `phase_dir`, `phase_number`, `phase_name`, `phase_slug`, `padded_phase`.

Parse `$ARGUMENTS` for the `--batch` flag. `--batch` selects the non-interactive path
described at Step 4b; without it the workflow runs interactively.

```bash
AUDITOR_MODEL=$(node "$HOME/.claude/gsd-ng/bin/gsd-tools.cjs" resolve-model gsd-nyquist-auditor)
NYQUIST_CFG=$(node "$HOME/.claude/gsd-ng/bin/gsd-tools.cjs" config-get workflow.nyquist_validation)
```

If `NYQUIST_CFG` is `false`: exit with "Nyquist validation is disabled. Enable via {{COMMAND_PREFIX}}settings."

Display banner: `GSD > VALIDATE PHASE {N}: {name}`

## 1. Detect Input State

```bash
VALIDATION_FILE=$(ls "${PHASE_DIR}"/*-VALIDATION.md 2>/dev/null | head -1)
SUMMARY_FILES=$(ls "${PHASE_DIR}"/*-SUMMARY.md 2>/dev/null)
```

- **State A** (`VALIDATION_FILE` non-empty): Audit existing
- **State B** (`VALIDATION_FILE` empty, `SUMMARY_FILES` non-empty): Reconstruct from artifacts
- **State C** (`SUMMARY_FILES` empty): Exit — "Phase {N} not executed. Run {{COMMAND_PREFIX}}execute-phase {N} first."

## 2. Discovery

### 2a. Read Phase Artifacts

Read all PLAN and SUMMARY files. Extract: task lists, requirement IDs, key-files changed, verify blocks.

### 2b. Build Requirement-to-Task Map

Per task: `{ task_id, plan_id, wave, requirement_ids, has_automated_command }`

### 2c. Detect Test Infrastructure

State A: Parse from existing VALIDATION.md Test Infrastructure table.
State B: Filesystem scan:

```bash
find . -name "pytest.ini" -o -name "jest.config.*" -o -name "vitest.config.*" -o -name "pyproject.toml" 2>/dev/null | head -10
find . \( -name "*.test.*" -o -name "*.spec.*" -o -name "test_*" \) -not -path "*/node_modules/*" 2>/dev/null | head -40
```

### 2d. Cross-Reference

Match each requirement to existing tests by filename, imports, test descriptions. Record: requirement → test_file → status.

## 3. Gap Analysis

Classify each requirement against the tiers in
`~/.claude/gsd-ng/references/nyquist-evidence-tiers.md` — TIER-A executable, TIER-M grep
contract, or manual-only. A row is only COVERED under the tier it actually meets.

| Status | Criteria |
|--------|----------|
| COVERED | Evidence exists under an admissible tier, targets behavior, runs green |
| PARTIAL | Evidence exists but is failing, incomplete, or fails a TIER-M clause |
| MISSING | No evidence found |

A TIER-M contract missing its discrimination self-test is PARTIAL, not COVERED. It is a green
light wired to nothing, and recording it as covered is how a phase certifies work nobody
checked.

Build: `{ task_id, requirement, gap_type, tier, suggested_test_path, suggested_command }`

No gaps → skip to Step 6 and take the PROMOTED path.

## 4. Gap Plan

### 4a. Interactive (default)

Call {{USER_QUESTION_TOOL}} with the gap table and options:

1. "Fix all gaps" → Step 5
2. "Skip — mark manual-only" → add to Manual-Only, Step 6
3. "Cancel" → exit

**What this prompt is for, because the batch design follows from it.** Of the three options
only the second is consequential: it converts an unmet requirement into a permanent documented
exemption. The prompt is a **waiver authorization**, not a progress confirmation. Answering it
on the user's behalf defeats the gate, and answering it that way across a backfill would turn
every pending row in the repository into an exemption in a single unattended run — the exact
failure this gate exists to prevent, executed at scale.

### 4b. `--batch` — the non-interactive path

Under `--batch` the {{USER_QUESTION_TOOL}} gate is skipped. The run makes zero calls to it, at
this step and at every other.

Batch mode takes the "fix all gaps" branch (Step 5) for everything the auditor can close. For
everything it cannot close, it **defers instead of waiving**: the row goes to the adjudication
queue at Step 5b and the phase stays uncompliant until a human rules on it.

**Batch mode never waives, and never promotes on a judgement call.** State the invariant
plainly because a test asserts it:

> Batch mode may write the compliance flag true **only** on the all-rows-green path. Any path
> involving a judgement call routes to the queue.

Three terminal states per phase, never two:

| Outcome | Frontmatter | Condition |
|---------|-------------|-----------|
| **PROMOTED** | flag true + audit trail | every row green under an admissible tier; no judgement required |
| **HELD** | flag false + reason | gaps remain and the auditor could not close them; no judgement required |
| **QUEUED** | flag false + queue refs | a waiver decision is required, and only a human may make it |

HELD and QUEUED are distinct on purpose. HELD is a mechanical shortfall a later run can close
on its own. QUEUED is a question, and the run has no standing to answer it.

## 5. Spawn gsd-nyquist-auditor

```bash
WORKSPACE_TYPE=$(node "$HOME/.claude/gsd-ng/bin/gsd-tools.cjs" detect-workspace --field type)
WORKSPACE_JSON=$(node "$HOME/.claude/gsd-ng/bin/gsd-tools.cjs" detect-workspace)
SUBMODULE_PATHS=$(node -e "try{const w=JSON.parse(process.argv[1]);const p=w.submodule_paths||[];process.stdout.write(p.join(', ')||'none')}catch{process.stdout.write('none')}" "$WORKSPACE_JSON")
PROJECT_ROOT="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
```

```
Task(
  prompt="Read ~/.claude/agents/gsd-nyquist-auditor.md for instructions.

<files_to_read>{PLAN, SUMMARY, impl files, VALIDATION.md}</files_to_read>

<workspace_context>
Workspace type: {WORKSPACE_TYPE}
Project root: {PROJECT_ROOT}
Submodule paths: {SUBMODULE_PATHS}

CRITICAL: Always commit to the source location. Your working directory is {PROJECT_ROOT}.
If workspace type is 'submodule', source code lives in the submodule directories listed above.
Do NOT modify deployed copies (e.g., {{CONFIG_DIR}}/gsd-ng/) — always edit source first.
</workspace_context>

<gaps>{gap list}</gaps>
<test_infrastructure>{framework, config, commands}</test_infrastructure>
<constraints>Never modify impl files. Max 3 debug iterations. Escalate impl bugs.
TIER-M contracts must satisfy all four clauses in
~/.claude/gsd-ng/references/nyquist-evidence-tiers.md; one missing a discrimination self-test
is an unfilled gap.</constraints>",
  subagent_type="gsd-nyquist-auditor",
  model="{AUDITOR_MODEL}",
  description="Fill validation gaps for Phase {N}"
)
```

Handle return:

| Return | Interactive | `--batch` |
|--------|-------------|-----------|
| `## GAPS FILLED` | record tests + map updates, Step 6 | same |
| `## PARTIAL` | record resolved, move escalated to manual-only, Step 6 | record resolved, escalated rows → Step 5b, Step 6 |
| `## ESCALATE` | move all to manual-only, Step 6 | all rows → Step 5b, Step 6 |

The difference is the whole point of the flag. Moving a row to Manual-Only is the waiver the
interactive prompt authorizes; unattended, that authorization does not exist, so the row is
recorded as unresolved instead.

## 5b. The deferred adjudication queue

Applies under `--batch` only. Append every unresolved row to `.planning/nyquist-adjudication.md`,
creating the file with this header if absent:

```markdown
# Nyquist Adjudication Queue

> Rows a batch validation run could not close without a waiver decision. Append-only.
> Reviewed by a human in one pass; nothing here is resolved by a machine.

| Phase | Row | Requirement | Gap type | What the auditor attempted | Proposed disposition |
|-------|-----|-------------|----------|----------------------------|----------------------|
```

One row per unresolved item, carrying the auditor's account of what it tried, why it stopped,
and what it would propose. A queue entry a human cannot adjudicate without re-deriving the
phase is not a deferral, it is a deferred cost.

Batch runs **append**. Nothing in batch mode removes, edits or resolves a row here.

**Why a file and not a checkpoint.** Under `workflow.auto_advance` a `checkpoint:decision`
auto-selects its first option — see `~/.claude/gsd-ng/references/checkpoints-core.md`,
"Auto-mode bypasses verification/decision checkpoints". Expressing the waiver as a checkpoint
would therefore let auto-advance answer the single question the entire gate exists to ask, and
it would do so silently, once per phase. A file cannot be auto-answered. The human reviews the
accumulated queue once, at the end of the run.

## 6. Generate/Update VALIDATION.md

**The promotion rule, and it is the same on both branches.** Step 6 used to say "update
frontmatter" without stating when the flag may be written, so only the no-gaps path had a rule
at all. The rule, in full:

A phase is promoted when **both** hold:

1. Every row in the Per-Task Verification Map is green under TIER-A or TIER-M, per
   `~/.claude/gsd-ng/references/nyquist-evidence-tiers.md`.
2. Every remaining Manual-Only entry carries a dated justification and a named human owner.

Write `manual_only_count: N` and the `evidence_tiers` breakdown alongside the flag, so the
claim decomposes. Promotion with `manual_only_count: 14` is visibly weaker than promotion with
`0`, and publishing the number is what stops the aggregate from hiding the difference.

Promote through the CLI. Never hand-edit the frontmatter field:

```bash
node "$HOME/.claude/gsd-ng/bin/gsd-tools.cjs" frontmatter set \
  "${VALIDATION_FILE}" --field nyquist_compliant --value true
```

If either condition fails, leave the flag alone and record the reason: HELD when the shortfall
is mechanical, QUEUED when Step 5b has rows for this phase.

**State B (create):**

1. Read template from `~/.claude/gsd-ng/templates/VALIDATION.md`
2. Fill: frontmatter (including `manual_only_count` and `evidence_tiers`), Test Infrastructure, Per-Task Map, Manual-Only, Sign-Off
3. Write to `${PHASE_DIR}/${PADDED_PHASE}-VALIDATION.md`
4. Append the `## Validation Audit {date}` trail below. **Mandatory on creation, not only on update** — a reconstructed file with no trail is indistinguishable from the forged flags this gate exists to catch, and health check W027 reports a promoted phase without a trail as an error. A State B path that omitted the trail would manufacture a fresh W027 violation on every file it wrote.
5. Apply the promotion rule above

**State A (update):**

1. Update Per-Task Map statuses, add escalated rows to Manual-Only (interactive) or to Step 5b (batch)
2. Update frontmatter counts: `manual_only_count`, `evidence_tiers`
3. Append the `## Validation Audit {date}` trail below — every run appends, including a run that changed nothing, because "the gate ran and found nothing to do" and "the gate never ran" are otherwise the same file
4. Apply the promotion rule above

**The audit trail, appended on every run:**

```markdown
## Validation Audit {date}
| Metric | Count |
|--------|-------|
| Gaps found | {N} |
| Resolved | {M} |
| Escalated | {K} |
| Outcome | PROMOTED / HELD / QUEUED |
| Queued for adjudication | {Q} |
| Manual-only | {manual_only_count} |
```

## 7. Commit

```bash
git add {test_files}
git commit -m "test(phase-${PHASE}): add Nyquist validation tests"

node "$HOME/.claude/gsd-ng/bin/gsd-tools.cjs" commit "docs(phase-${PHASE}): add/update validation strategy"
```

Under `--batch`, `.planning/nyquist-adjudication.md` is committed with the validation file.

## 8. Results + Routing

**Compliant:**
```
GSD > PHASE {N} IS NYQUIST-COMPLIANT
All requirements have automated verification.
Manual-only: {manual_only_count}
▶ Next: {{COMMAND_PREFIX}}audit-milestone
```

**Partial:**
```
GSD > PHASE {N} VALIDATED (PARTIAL)
{M} automated, {K} manual-only.
▶ Retry: {{COMMAND_PREFIX}}validate-phase {N}
```

**Queued (batch):**
```
GSD > PHASE {N} QUEUED FOR ADJUDICATION
{Q} rows need a human waiver decision — not compliant.
▶ Review: .planning/nyquist-adjudication.md
```

Display `/clear` reminder.

</process>

<success_criteria>
- [ ] Nyquist config checked (exit if disabled)
- [ ] `--batch` parsed; under it the question tool is never called
- [ ] Input state detected (A/B/C)
- [ ] State C exits cleanly
- [ ] PLAN/SUMMARY files read, requirement map built
- [ ] Test infrastructure detected
- [ ] Gaps classified (COVERED/PARTIAL/MISSING) against the evidence tiers
- [ ] User gate with gap table (interactive), or the deferral path (batch)
- [ ] Auditor spawned with complete context
- [ ] All three return formats handled on both branches
- [ ] Unresolved batch rows appended to the adjudication queue, never resolved by the run
- [ ] VALIDATION.md created or updated, with the audit trail appended in State A and State B alike
- [ ] Promotion made through `gsd-tools frontmatter set`, never by hand
- [ ] Test files committed separately
- [ ] Results with routing presented
</success_criteria>
