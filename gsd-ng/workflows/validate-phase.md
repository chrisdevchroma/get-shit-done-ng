<purpose>
Audit Nyquist validation gaps for a completed phase. Generate missing tests. Update VALIDATION.md.
</purpose>

@~/.claude/gsd-ng/references/ask-user-question.md

<required_reading>
@~/.claude/gsd-ng/references/ui-brand.md
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

Classify each requirement:

| Status | Criteria |
|--------|----------|
| COVERED | Test exists, targets behavior, runs green |
| PARTIAL | Test exists, failing or incomplete |
| MISSING | No test found |

Build: `{ task_id, requirement, gap_type, suggested_test_path, suggested_command }`

No gaps → skip to Step 6, set `nyquist_compliant: true`.

## 4. Present Gap Plan

Call {{USER_QUESTION_TOOL}} with gap table and options:
1. "Fix all gaps" → Step 5
2. "Skip — mark manual-only" → add to Manual-Only, Step 6
3. "Cancel" → exit

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
<constraints>Never modify impl files. Max 3 debug iterations. Escalate impl bugs.</constraints>",
  subagent_type="gsd-nyquist-auditor",
  model="{AUDITOR_MODEL}",
  description="Fill validation gaps for Phase {N}"
)
```

Handle return:
- `## GAPS FILLED` → record tests + map updates, Step 6
- `## PARTIAL` → record resolved, move escalated to manual-only, Step 6
- `## ESCALATE` → move all to manual-only, Step 6

## 6. Generate/Update VALIDATION.md

**State B (create):**
1. Read template from `~/.claude/gsd-ng/templates/VALIDATION.md`
2. Fill: frontmatter, Test Infrastructure, Per-Task Map, Manual-Only, Sign-Off
3. Write to `${PHASE_DIR}/${PADDED_PHASE}-VALIDATION.md`

**State A (update):**
1. Update Per-Task Map statuses, add escalated to Manual-Only, update frontmatter
2. Append audit trail:

```markdown
## Validation Audit {date}
| Metric | Count |
|--------|-------|
| Gaps found | {N} |
| Resolved | {M} |
| Escalated | {K} |
```

## 7. Commit

```bash
git add {test_files}
git commit -m "test(phase-${PHASE}): add Nyquist validation tests"

node "$HOME/.claude/gsd-ng/bin/gsd-tools.cjs" commit "docs(phase-${PHASE}): add/update validation strategy"
```

## 8. Results + Routing

**Compliant:**
```
GSD > PHASE {N} IS NYQUIST-COMPLIANT
All requirements have automated verification.
▶ Next: {{COMMAND_PREFIX}}audit-milestone
```

**Partial:**
```
GSD > PHASE {N} VALIDATED (PARTIAL)
{M} automated, {K} manual-only.
▶ Retry: {{COMMAND_PREFIX}}validate-phase {N}
```

Display `/clear` reminder.

</process>

<success_criteria>
- [ ] Nyquist config checked (exit if disabled)
- [ ] Input state detected (A/B/C)
- [ ] State C exits cleanly
- [ ] PLAN/SUMMARY files read, requirement map built
- [ ] Test infrastructure detected
- [ ] Gaps classified (COVERED/PARTIAL/MISSING)
- [ ] User gate with gap table
- [ ] Auditor spawned with complete context
- [ ] All three return formats handled
- [ ] VALIDATION.md created or updated
- [ ] Test files committed separately
- [ ] Results with routing presented
</success_criteria>
