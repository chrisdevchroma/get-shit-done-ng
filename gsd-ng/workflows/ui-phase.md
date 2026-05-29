<purpose>
Spawns gsd-ui-researcher to gather design preferences and write UI-SPEC.md for a frontend phase. Inserts between discuss-phase and plan-phase in the lifecycle.

UI-SPEC.md locks spacing, typography, color, copywriting, and design system decisions before the planner creates tasks. This prevents design debt caused by ad-hoc styling decisions during execution.
</purpose>

@~/.claude/gsd-ng/references/ask-user-question.md

<required_reading>
@~/.claude/gsd-ng/references/ui-brand.md
</required_reading>

<process>

## 1. Initialize

```bash
INIT=$(node "$HOME/.claude/gsd-ng/bin/gsd-tools.cjs" init plan-phase "$PHASE")
if ! node "$HOME/.claude/gsd-ng/bin/gsd-tools.cjs" guard init-valid "$INIT" 2>/dev/null; then
  INIT=$(node "$HOME/.claude/gsd-ng/bin/gsd-tools.cjs" init plan-phase "$PHASE")
  if ! node "$HOME/.claude/gsd-ng/bin/gsd-tools.cjs" guard init-valid "$INIT"; then
    echo "Error: init failed twice. Check gsd-tools installation."
    exit 1
  fi
fi
```

Parse JSON for: `phase_dir`, `phase_number`, `phase_name`, `phase_slug`, `padded_phase`, `has_context`, `has_research`, `commit_docs`.

**File paths:** `state_path`, `roadmap_path`, `requirements_path`, `context_path`, `research_path`.

Resolve UI agent models:

```bash
UI_RESEARCHER_MODEL=$(node "$HOME/.claude/gsd-ng/bin/gsd-tools.cjs" resolve-model gsd-ui-researcher)
```

Check config:

```bash
UI_ENABLED=$(node "$HOME/.claude/gsd-ng/bin/gsd-tools.cjs" config-get workflow.ui_phase --default "true")
```

**If `UI_ENABLED` is `false`:**
```
UI features disabled — set `workflow.ui_phase: true` in `.planning/config.json` to enable.
```
Exit workflow.

**If `planning_exists` is false:** Error — run `{{COMMAND_PREFIX}}new-project` first.

## 2. Parse and Validate Phase

Extract phase number from $ARGUMENTS. If not provided, detect next unplanned phase.

```bash
PHASE_INFO=$(node "$HOME/.claude/gsd-ng/bin/gsd-tools.cjs" roadmap get-phase "${PHASE}")
```

**If `found` is false:** Error with available phases.

## 3. Check Prerequisites

**If `has_context` is false:**
```
No CONTEXT.md found for Phase {N}.
Recommended: run {{COMMAND_PREFIX}}discuss-phase {N} first to capture design preferences.
Continuing without user decisions — UI researcher will ask all questions.
```
Continue (non-blocking).

**If `has_research` is false:**
```
No RESEARCH.md found for Phase {N}.
Note: stack decisions (component library, styling approach) will be asked during UI research.
```
Continue (non-blocking).

## 4. Check Existing UI-SPEC

```bash
UI_SPEC_FILE=$(ls "${PHASE_DIR}"/*-UI-SPEC.md 2>/dev/null | head -1)
```

**If exists:** Use AskUserQuestion:
- header: "Existing UI-SPEC"
- question: "UI-SPEC.md already exists for Phase {N}. What would you like to do?"
- options:
  - "Update — re-run researcher with existing as baseline"
  - "View — display current UI-SPEC and exit"
  - "Skip — keep current UI-SPEC, proceed to verification"

If "View": display file contents, exit.
If "Skip": proceed to step 10 (final status).
If "Update": continue to step 5.

## 5. Spawn gsd-ui-researcher

Display:
```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 GSD ► UI DESIGN CONTRACT — PHASE {N}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

◆ Spawning UI researcher...
```

Build prompt:

```markdown
Read ~/.claude/agents/gsd-ui-researcher.md for instructions.

<objective>
Create UI design contract for Phase {phase_number}: {phase_name}
Answer: "What visual and interaction contracts does this phase need?"
</objective>

<files_to_read>
- {state_path} (Project State)
- {roadmap_path} (Roadmap)
- {requirements_path} (Requirements)
- {context_path} (USER DECISIONS from {{COMMAND_PREFIX}}discuss-phase)
- {research_path} (Technical Research — stack decisions)
</files_to_read>

<output>
Write to: {phase_dir}/{padded_phase}-UI-SPEC.md
Template: ~/.claude/gsd-ng/templates/UI-SPEC.md
</output>

<config>
commit_docs: {commit_docs}
phase_dir: {phase_dir}
padded_phase: {padded_phase}
</config>
```

Omit null file paths from `<files_to_read>`.

```
Task(
  prompt=ui_research_prompt,
  subagent_type="gsd-ui-researcher",
  model="{UI_RESEARCHER_MODEL}",
  description="UI Design Contract Phase {N}"
)
```

## 6. Handle Researcher Return

**If `## UI-SPEC COMPLETE`:**
Display confirmation. Continue to step 10.

**If `## UI-SPEC BLOCKED`:**
Display blocker details and options. Exit workflow.

## 10. Present Final Status

Display:
```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 GSD ► UI-SPEC READY ✓
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

**Phase {N}: {Name}** — UI design contract ready

───────────────────────────────────────────────────────────────

## ▶ Next Up

**Plan Phase {N}** — planner will use UI-SPEC.md as design context

`{{COMMAND_PREFIX}}plan-phase {N}`

<sub>`/clear` first → fresh context window</sub>

───────────────────────────────────────────────────────────────
```

## 11. Commit (if configured)

```bash
node "$HOME/.claude/gsd-ng/bin/gsd-tools.cjs" commit "docs(${padded_phase}): UI design contract" --files "${PHASE_DIR}/${PADDED_PHASE}-UI-SPEC.md"
```

## 12. Update State

```bash
node "$HOME/.claude/gsd-ng/bin/gsd-tools.cjs" state record-session \
  --stopped-at "Phase ${PHASE} UI-SPEC approved" \
  --resume-file "${PHASE_DIR}/${PADDED_PHASE}-UI-SPEC.md"
```

</process>

<success_criteria>
- [ ] Config checked (exit if ui_phase disabled)
- [ ] Phase validated against roadmap
- [ ] Prerequisites checked (CONTEXT.md, RESEARCH.md — non-blocking warnings)
- [ ] Existing UI-SPEC handled (update/view/skip)
- [ ] gsd-ui-researcher spawned with correct context and file paths
- [ ] UI-SPEC.md created in correct location
- [ ] Final status displayed with next steps
- [ ] UI-SPEC.md committed (if commit_docs enabled)
- [ ] State updated
</success_criteria>
