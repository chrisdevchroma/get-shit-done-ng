<purpose>
Interactive configuration of GSD workflow agents (research, plan_check, verifier) and model profile selection via multi-question prompt. Updates .planning/config.json with user preferences. Optionally saves settings as global defaults (~/.gsd/defaults.json) for future projects.
</purpose>

@~/.claude/gsd-ng/references/ask-user-question.md

<required_reading>
Read all files referenced by the invoking prompt's execution_context before starting.
</required_reading>

<process>

<step name="ensure_and_load_config">
Ensure config exists and load current state:

```bash
node "$HOME/.claude/gsd-ng/bin/gsd-tools.cjs" config-ensure-section
INIT=$(node "$HOME/.claude/gsd-ng/bin/gsd-tools.cjs" state load)
if ! node "$HOME/.claude/gsd-ng/bin/gsd-tools.cjs" guard init-valid "$INIT" 2>/dev/null; then
  INIT=$(node "$HOME/.claude/gsd-ng/bin/gsd-tools.cjs" state load)
  if ! node "$HOME/.claude/gsd-ng/bin/gsd-tools.cjs" guard init-valid "$INIT"; then
    echo "Error: init failed twice. Check gsd-tools installation."
    exit 1
  fi
fi
```

Creates `.planning/config.json` with defaults if missing and loads current config values.
</step>

<step name="read_current">
```bash
cat .planning/config.json
```

Parse current values (default to `true` if not present):
- `workflow.research` — spawn researcher during plan-phase
- `workflow.plan_check` — spawn plan checker during plan-phase
- `workflow.verifier` — spawn verifier during execute-phase
- `workflow.nyquist_validation` — validation architecture research during plan-phase (default: true if absent)
- `workflow.ui_phase` — enable UI design + audit features (master toggle for {{COMMAND_PREFIX}}ui-phase and {{COMMAND_PREFIX}}ui-review; default: true if absent)
- `workflow.incremental_remap` — auto-update codebase docs after phase completion via gsd-incremental-mapper (default: true if absent)
- `model_profile` — which model each agent uses (default: `balanced`)
- `git.branching_strategy` — branching approach (default: `"none"`)
- `git.target_branch` — default merge target for PRs (default: `"main"`)
- `git.auto_push` — auto-push work branch after phase (default: `false`)
- `git.pr_draft` — create PRs as drafts by default (default: `true`)
- `git.platform` — git hosting platform override (default: `null` = auto-detect)
- `git.commit_format` -- commit message preset (default: `"gsd"`)
- `git.versioning_scheme` -- version scheme (default: `"semver"`)
- `issue_tracker.auto_sync` — auto-sync on phase/todo completion (default: true)
- `issue_tracker.default_action` — action on completion: close or comment (default: close)
- `issue_tracker.comment_style` — external (no GSD internals) or verbose (default: external)
- `issue_tracker.close_state` — close transition mode: `close` (default), `verify` (label only), `verify_then_close` (label + close)
- `issue_tracker.verify_label` — label to apply in verify modes (default: `needs-verification`)
</step>

<step name="present_settings">
Use {{USER_QUESTION_TOOL}} with current values pre-selected:

```
{{USER_QUESTION_TOOL}}([
  {
    question: "Which model profile for agents?",
    header: "Model",
    multiSelect: false,
    options: [
      { label: "Quality", description: "Opus everywhere except verification (highest cost)" },
      { label: "Balanced (Recommended)", description: "Opus for planning, Sonnet for research/execution/verification" },
      { label: "Budget", description: "Sonnet for writing, Haiku for research/verification (lowest cost)" }
    ]
  },
  {
    question: "Spawn Plan Researcher? (researches domain before planning)",
    header: "Research",
    multiSelect: false,
    options: [
      { label: "Yes", description: "Research phase goals before planning" },
      { label: "No", description: "Skip research, plan directly" }
    ]
  },
  {
    question: "Spawn Plan Checker? (verifies plans before execution)",
    header: "Plan Check",
    multiSelect: false,
    options: [
      { label: "Yes", description: "Verify plans meet phase goals" },
      { label: "No", description: "Skip plan verification" }
    ]
  },
  {
    question: "Spawn Execution Verifier? (verifies phase completion)",
    header: "Verifier",
    multiSelect: false,
    options: [
      { label: "Yes", description: "Verify must-haves after execution" },
      { label: "No", description: "Skip post-execution verification" }
    ]
  },
  {
    question: "Auto-advance pipeline? (discuss → plan → execute automatically)",
    header: "Auto",
    multiSelect: false,
    options: [
      { label: "No (Recommended)", description: "Manual /clear + paste between stages" },
      { label: "Yes", description: "Chain stages automatically via Agent tool (same context isolation)" }
    ]
  },
  {
    question: "Enable Nyquist Validation? (researches test coverage during planning)",
    header: "Nyquist",
    multiSelect: false,
    options: [
      { label: "Yes (Recommended)", description: "Research automated test coverage during plan-phase. Adds validation requirements to plans. Blocks approval if tasks lack automated verify." },
      { label: "No", description: "Skip validation research. Good for rapid prototyping or no-test phases." }
    ]
  },
  // Note: Nyquist validation depends on research output. If research is disabled,
  // plan-phase automatically skips Nyquist steps (no RESEARCH.md to extract from).
  {
    question: "Enable UI features? (master toggle for {{COMMAND_PREFIX}}ui-phase and {{COMMAND_PREFIX}}ui-review)",
    header: "UI Phase",
    multiSelect: false,
    options: [
      { label: "Yes (Recommended)", description: "Enable UI design + audit features. {{COMMAND_PREFIX}}ui-phase generates UI-SPEC.md; {{COMMAND_PREFIX}}ui-review runs visual audits." },
      { label: "No", description: "Disable UI features. {{COMMAND_PREFIX}}ui-phase and {{COMMAND_PREFIX}}ui-review exit with a friendly disabled message. Good for backend-only projects." }
    ]
  },
  {
    question: "Enable Incremental Remap? (auto-updates codebase docs after each phase)",
    header: "Remap",
    multiSelect: false,
    options: [
      { label: "Yes (Recommended)", description: "Run gsd-incremental-mapper agents after phase completion to keep codebase docs current." },
      { label: "No", description: "Skip doc updates. Good when codebase docs are manual or phase work doesn't touch documented modules." }
    ]
  },
  {
    question: "Git branching strategy?",
    header: "Branching",
    multiSelect: false,
    options: [
      { label: "None (Recommended)", description: "Commit directly to current branch" },
      { label: "Per Phase", description: "Create branch for each phase (gsd/phase-{N}-{name})" },
      { label: "Per Milestone", description: "Create branch for entire milestone (gsd/{version}-{name})" }
    ]
  },
  {
    question: "Default target branch for PRs and merges?",
    header: "Target Branch",
    multiSelect: false,
    options: [
      { label: "main (Default)", description: "Standard main branch as merge target" },
      { label: "develop", description: "GitFlow develop branch as merge target" },
      { label: "Custom", description: "Type your branch name when prompted" }
    ]
  },
  {
    question: "Auto-push feature branch after phase completion?",
    header: "Auto Push",
    multiSelect: false,
    options: [
      { label: "No (Default)", description: "Push manually or via {{COMMAND_PREFIX}}create-pr" },
      { label: "Yes", description: "Automatically push work branch to remote after each phase" }
    ]
  },
  {
    question: "Create PRs as drafts by default?",
    header: "PR Draft",
    multiSelect: false,
    options: [
      { label: "Yes (Default)", description: "PRs created as drafts — mark ready when reviewed" },
      { label: "No", description: "PRs created as ready for review immediately" }
    ]
  },
  {
    question: "Git hosting platform? (auto-detect reads remote URL)",
    header: "Platform",
    multiSelect: false,
    options: [
      { label: "Auto-detect (Recommended)", description: "Detect from remote URL (github.com, gitlab.com, codeberg.org)" },
      { label: "Choose manually", description: "Select your platform explicitly" }
    ]
  },
  {
    question: "Enable context window warnings? (injects advisory messages when context is getting full)",
    header: "Ctx Warnings",
    multiSelect: false,
    options: [
      { label: "Yes (Recommended)", description: "Warn when context usage exceeds 65%. Helps avoid losing work." },
      { label: "No", description: "Disable warnings. Allows Claude to reach auto-compact naturally. Good for long unattended runs." }
    ]
  },
  {
    question: "Commit message format for GSD-generated commits?",
    header: "Commit Format",
    multiSelect: false,
    options: [
      { label: "GSD (Default)", description: "Phase/plan scoped: feat(14-01): description" },
      { label: "Conventional", description: "Strict Conventional Commits: feat(scope): description" },
      { label: "Issue-first", description: "Issue prefix: [#42] description (uses external_ref from requirement)" },
      { label: "Custom", description: "User-defined template from git.commit_template config key" }
    ]
  },
  {
    question: "Version numbering scheme?",
    header: "Versioning",
    multiSelect: false,
    options: [
      { label: "SemVer (Default)", description: "MAJOR.MINOR.PATCH — standard semantic versioning" },
      { label: "CalVer", description: "YYYY.MM.PATCH — calendar-based versioning" },
      { label: "Date Build", description: "MAJOR.MINOR.BUILD — auto-incrementing build number" }
    ]
  },
  {
    question: "Auto-sync issues on phase/todo completion?",
    header: "Issue Sync",
    multiSelect: false,
    options: [
      { label: "Yes (Default)", description: "Automatically close/comment external issues when GSD work completes" },
      { label: "No", description: "Manual sync only via {{COMMAND_PREFIX}}sync-issues" }
    ]
  },
  {
    question: "Default action when GSD work resolves an external issue?",
    header: "Issue Action",
    multiSelect: false,
    options: [
      { label: "Close (Default)", description: "Post resolution comment with commit/PR references, then close the issue" },
      { label: "Comment Only", description: "Post resolution comment with references but leave issue open" }
    ]
  },
  {
    question: "Comment content style for external issue updates?",
    header: "Comment Style",
    multiSelect: false,
    options: [
      { label: "External (Default)", description: "Only reference commits, PRs, branches — no GSD internals exposed" },
      { label: "Verbose", description: "Include GSD phase names, todo titles in comments" }
    ]
  }
])
```

If user selected "Choose manually" for Platform, present a follow-up question:

```
{{USER_QUESTION_TOOL}}([
  {
    question: "Which git hosting platform?",
    header: "Platform",
    multiSelect: false,
    options: [
      { label: "GitHub", description: "Uses gh CLI" },
      { label: "GitLab", description: "Uses glab CLI" },
      { label: "Forgejo", description: "Uses fj CLI" },
      { label: "Gitea", description: "Uses tea CLI" }
    ]
  }
])
```

If user selected "Auto-detect (Recommended)", run platform detection:
```bash
PLATFORM_RESULT=$(node "$HOME/.claude/gsd-ng/bin/gsd-tools.cjs" detect-platform --json 2>/dev/null)
```
Extract the `platform` field from the JSON result. Store it for display in the confirmation table as `"Auto-detect ({detected_platform})"` or `"Auto-detect (not detected)"` if null. Config stores `platform: null` (auto-detect uses runtime detection, config only stores manual overrides).

Present close_state question:

```
{{USER_QUESTION_TOOL}}([
  {
    question: "Close transition mode (issue_tracker.close_state) when GSD resolves an external issue?",
    header: "Close State",
    multiSelect: false,
    options: [
      { label: "Close (Default)", description: "Comment and close the issue immediately" },
      { label: "Verify", description: "Apply verify label and leave open for manual sign-off" },
      { label: "Verify then Close", description: "Apply verify label and close (reviewer can reopen)" }
    ]
  }
])
```

If user selected "Verify" or "Verify then Close", present follow-up:

```
{{USER_QUESTION_TOOL}}([
  {
    question: "Label to apply in verify modes (issue_tracker.verify_label)?",
    header: "Verify Label",
    multiSelect: false,
    options: [
      { label: "needs-verification (Default)", description: "Standard verification label; auto-created if it doesn't exist on the platform" },
      { label: "Custom", description: "Type your label name when prompted" }
    ]
  }
])
```

If user selected "Close" for close_state, skip the verify_label question entirely (use default "needs-verification" in config).
</step>

<step name="update_config">
Merge new settings into existing config.json:

```json
{
  ...existing_config,
  "model_profile": "quality" | "balanced" | "budget",
  "workflow": {
    "research": true/false,
    "plan_check": true/false,
    "verifier": true/false,
    "auto_advance": true/false,
    "nyquist_validation": true/false,
    "ui_phase": true/false,
    "incremental_remap": true/false
  },
  "git": {
    "branching_strategy": "none" | "phase" | "milestone",
    "target_branch": "main" | "develop" | custom,
    "auto_push": true/false,
    "pr_draft": true/false,
    "platform": null | "github" | "gitlab" | "forgejo" | "gitea"
  },
  "issue_tracker": {
    "auto_sync": true/false,
    "default_action": "close" | "comment",
    "comment_style": "external" | "verbose",
    "close_state": "close" | "verify" | "verify_then_close",
    "verify_label": "needs-verification"
  },
  "hooks": {
    "context_warnings": true/false
  }
}
```

Write updated config to `.planning/config.json`.
</step>

<step name="save_as_defaults">
Ask whether to save these settings as global defaults for future projects:

```
{{USER_QUESTION_TOOL}}([
  {
    question: "Save these as default settings for all new projects?",
    header: "Defaults",
    multiSelect: false,
    options: [
      { label: "Yes", description: "New projects start with these settings (saved to ~/.gsd/defaults.json)" },
      { label: "No", description: "Only apply to this project" }
    ]
  }
])
```

If "Yes": write the same config object to `~/.gsd/defaults.json`:

```bash
mkdir -p ~/.gsd
```

Write `~/.gsd/defaults.json` with:
```json
{
  "mode": <current>,
  "granularity": <current>,
  "model_profile": <current>,
  "commit_docs": <current>,
  "parallelization": <current>,
  "branching_strategy": <current>,
  "workflow": {
    "research": <current>,
    "plan_check": <current>,
    "verifier": <current>,
    "auto_advance": <current>,
    "nyquist_validation": <current>,
    "ui_phase": <current>
  }
}
```
</step>

<step name="confirm">
Display:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 GSD ► SETTINGS UPDATED
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

| Setting              | Value |
|----------------------|-------|
| Model Profile        | {quality/balanced/budget} |
| Plan Researcher      | {On/Off} |
| Plan Checker         | {On/Off} |
| Execution Verifier   | {On/Off} |
| Auto-Advance         | {On/Off} |
| Nyquist Validation   | {On/Off} |
| UI Phase             | {On/Off} |
| Incremental Remap    | {On/Off} |
| Git Branching        | {None/Per Phase/Per Milestone} |
| Target Branch        | {main/develop/custom} |
| Auto Push            | {On/Off} |
| PR Draft Default     | {On/Off} |
| Platform             | {Auto-detect (GitHub)/GitHub/GitLab/Forgejo/Gitea} |
| Issue Auto-Sync      | {On/Off} |
| Issue Default Action  | {Close/Comment} |
| Comment Style        | {External/Verbose} |
| Close State          | {Close/Verify/Verify then Close} |
| Verify Label         | {needs-verification/custom} |
| Context Warnings     | {On/Off} |
| Saved as Defaults    | {Yes/No} |

These settings apply to future {{COMMAND_PREFIX}}plan-phase and {{COMMAND_PREFIX}}execute-phase runs.

Quick commands:
- {{COMMAND_PREFIX}}set-profile <profile> — switch model profile
- {{COMMAND_PREFIX}}plan-phase --research — force research
- {{COMMAND_PREFIX}}plan-phase --skip-research — skip research
- {{COMMAND_PREFIX}}plan-phase --skip-verify — skip plan check
```
</step>

</process>

<success_criteria>
- [ ] Current config read
- [ ] User presented with 19 settings (profile + 8 workflow toggles + git branching + target branch + auto push + PR draft + platform + 4 issue_tracker settings + context warnings), plus conditional platform follow-up and conditional verify_label
- [ ] Config updated with model_profile, workflow, and git sections
- [ ] User offered to save as global defaults (~/.gsd/defaults.json)
- [ ] Changes confirmed to user
</success_criteria>
