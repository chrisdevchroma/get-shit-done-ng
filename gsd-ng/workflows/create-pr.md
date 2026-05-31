<purpose>
Create a pull request or merge request from GSD work. For phase / milestone /
quick-task entry points: creates a team-facing review branch (squashed),
pushes it, and opens a PR/MR via the appropriate platform CLI. For the
`none` branching strategy: opens PR directly from current branch.

This is the bridge between GSD's internal work and team-facing code review.
</purpose>

<required_reading>
Read STATE.md and config.json before any operation.
@~/.claude/gsd-ng/references/planning-config.md
@references/security-untrusted-content.md
</required_reading>

<process>

<step name="load_context" priority="first">
Load execution context for the phase:

```bash
# Accept phase or quick-task slug argument, or detect from current branch/state
PHASE_ARG="${ARGUMENTS%% *}"
if [ -z "$PHASE_ARG" ]; then
  # Try to detect phase from STATE.md current position
  PHASE_ARG=$(grep -oP 'Phase:\s*\K\d+' .planning/STATE.md 2>/dev/null | head -1)
fi

# Detect quick-task slug shape: YYMMDD-XXX- (6 digits, hyphen, 3 alnum, hyphen, ...)
# Quick-task slugs match ^[0-9]{6}-[a-z0-9]{3}- ; phase numbers (e.g. 58) do not.
IS_QUICK_TASK=false
QUICK_SLUG=""
QUICK_DIR=""
QUICK_SUMMARY=""
ONE_LINER=""

if [[ "$PHASE_ARG" =~ ^[0-9]{6}-[a-z0-9]{3}- ]]; then
  IS_QUICK_TASK=true
  QUICK_SLUG="$PHASE_ARG"
  QUICK_DIR=".planning/quick/${QUICK_SLUG}"
  # Quick task SUMMARY filename convention: <slug>-SUMMARY.md inside the quick dir
  QUICK_SUMMARY="${QUICK_DIR}/${QUICK_SLUG}-SUMMARY.md"
  if [ ! -f "$QUICK_SUMMARY" ]; then
    # Fallback: some older quick tasks may use SUMMARY.md (no slug prefix)
    if [ -f "${QUICK_DIR}/SUMMARY.md" ]; then
      QUICK_SUMMARY="${QUICK_DIR}/SUMMARY.md"
    else
      echo "Error: Quick-task summary not found at ${QUICK_DIR}/${QUICK_SLUG}-SUMMARY.md or ${QUICK_DIR}/SUMMARY.md"
      exit 1
    fi
  fi
  ONE_LINER=$(node "$HOME/.claude/gsd-ng/bin/gsd-tools.cjs" summary-extract "$QUICK_SUMMARY" --fields one_liner --default "" --pick one_liner)
  if [ -z "$ONE_LINER" ]; then
    echo "Note: No one_liner extracted from $QUICK_SUMMARY — using slug as title."
    ONE_LINER="$QUICK_SLUG"
  fi
fi

if [ "$IS_QUICK_TASK" = "true" ]; then
  # Quick-task path: skip init execute-phase (it would crash on non-numeric arg).
  # Use git-context for submodule routing — it calls resolveGitContext directly.
  INIT=$(node "$HOME/.claude/gsd-ng/bin/gsd-tools.cjs" git-context 2>/dev/null || echo '{}')
  # Remap git-context fields to the submodule_* naming that the routing block below expects.
  # git-context returns: is_submodule, git_cwd, remote, remote_url, ambiguous, target_branch, platform, cli, cli_installed, cli_install_url
  INIT=$(node -e "
    try {
      const c = JSON.parse(process.argv[1]);
      const out = Object.assign({}, c, {
        submodule_is_active: c.is_submodule || false,
        submodule_git_cwd: c.git_cwd || '.',
        submodule_remote: c.remote || 'origin',
        submodule_remote_url: c.remote_url || '',
        submodule_target_branch: c.target_branch || 'main',
        submodule_ambiguous: c.ambiguous || false,
        branching_strategy: 'quick',
        review_branch_template: '',
        pr_draft: c.pr_draft !== undefined ? c.pr_draft : true,
      });
      process.stdout.write(JSON.stringify(out));
    } catch(e) { process.stdout.write('{}'); }
  " "$INIT")
  # Phase-specific fields are not used in the quick-task path:
  BRANCHING_STRATEGY="quick"
  BRANCH_NAME=""
  REVIEW_BRANCH_TEMPLATE=""
  PHASE_NUMBER=""
  PHASE_NAME=""
  PHASE_SLUG=""
  PHASE_DIR_NAME=""
else
  # Phase path (existing behavior — verbatim).
  INIT=$(node "$HOME/.claude/gsd-ng/bin/gsd-tools.cjs" init execute-phase "${PHASE_ARG}")
  if ! node "$HOME/.claude/gsd-ng/bin/gsd-tools.cjs" guard init-valid "$INIT" 2>/dev/null; then
    INIT=$(node "$HOME/.claude/gsd-ng/bin/gsd-tools.cjs" init execute-phase "${PHASE_ARG}")
    if ! node "$HOME/.claude/gsd-ng/bin/gsd-tools.cjs" guard init-valid "$INIT"; then
      echo "Error: init failed twice. Check gsd-tools installation."
      exit 1
    fi
  fi
  # Extract phase fields (existing behavior).
  BRANCHING_STRATEGY=$(node "$HOME/.claude/gsd-ng/bin/gsd-tools.cjs" init-get "$INIT" branching_strategy 2>/dev/null)
  BRANCH_NAME=$(node "$HOME/.claude/gsd-ng/bin/gsd-tools.cjs" init-get "$INIT" branch_name 2>/dev/null)
  REVIEW_BRANCH_TEMPLATE=$(node "$HOME/.claude/gsd-ng/bin/gsd-tools.cjs" init-get "$INIT" review_branch_template 2>/dev/null)
  PHASE_NUMBER=$(node "$HOME/.claude/gsd-ng/bin/gsd-tools.cjs" init-get "$INIT" phase_number 2>/dev/null)
  PHASE_NAME=$(node "$HOME/.claude/gsd-ng/bin/gsd-tools.cjs" init-get "$INIT" phase_name 2>/dev/null)
  PHASE_SLUG=$(node "$HOME/.claude/gsd-ng/bin/gsd-tools.cjs" init-get "$INIT" phase_slug 2>/dev/null)
  PHASE_DIR=$(node "$HOME/.claude/gsd-ng/bin/gsd-tools.cjs" init-get "$INIT" phase_dir 2>/dev/null)
  PHASE_DIR_NAME=$(basename "$PHASE_DIR" 2>/dev/null)
fi
```

Extract from init JSON (phase path); quick-task path sets these inline above:
- `BRANCHING_STRATEGY` ← `branching_strategy`
- `BRANCH_NAME` ← `branch_name` (GSD work branch)
- `REVIEW_BRANCH_TEMPLATE` ← `review_branch_template`
- `PR_DRAFT` ← `pr_draft`
- `PHASE_NUMBER` ← `phase_number`
- `PHASE_NAME` ← `phase_name`
- `PHASE_SLUG` ← `phase_slug`
- `PHASE_DIR_NAME` ← basename of `phase_dir`

Resolve submodule-aware git routing from $INIT:

```bash
# Read submodule fields from $INIT
IS_SUBMODULE=$(node -e "try{const c=JSON.parse(process.argv[1]);process.stdout.write(String(c.submodule_is_active||false))}catch{process.stdout.write('false')}" "$INIT")
GIT_CWD=$(node -e "try{const c=JSON.parse(process.argv[1]);process.stdout.write(c.submodule_git_cwd||'.')}catch{process.stdout.write('.')}" "$INIT")
PUSH_REMOTE=$(node "$HOME/.claude/gsd-ng/bin/gsd-tools.cjs" init-get "$INIT" remote 2>/dev/null)
PUSH_TARGET=$(node "$HOME/.claude/gsd-ng/bin/gsd-tools.cjs" init-get "$INIT" target_branch 2>/dev/null); if [ -z "$PUSH_TARGET" ]; then PUSH_TARGET="main"; fi
AMBIGUOUS=$(node -e "try{const c=JSON.parse(process.argv[1]);process.stdout.write(String(c.submodule_ambiguous||false))}catch{process.stdout.write('false')}" "$INIT")
SUBMODULE_REMOTE_URL=$(node -e "try{const c=JSON.parse(process.argv[1]);process.stdout.write(c.submodule_remote_url||'')}catch{process.stdout.write('')}" "$INIT")

# Platform: read from $INIT (per-submodule override applies), fall back to detect-platform
PLATFORM=$(node "$HOME/.claude/gsd-ng/bin/gsd-tools.cjs" init-get "$INIT" platform 2>/dev/null)
if [ -z "$PLATFORM" ]; then
  PLATFORM=$(node "$HOME/.claude/gsd-ng/bin/gsd-tools.cjs" detect-platform --field platform)
fi
CLI=$(node "$HOME/.claude/gsd-ng/bin/gsd-tools.cjs" detect-platform --field cli)
CLI_INSTALLED=$(node "$HOME/.claude/gsd-ng/bin/gsd-tools.cjs" detect-platform --field cli_installed)
CLI_INSTALL_URL=$(node "$HOME/.claude/gsd-ng/bin/gsd-tools.cjs" detect-platform --field cli_install_url)
```

Use `$PUSH_REMOTE`, `$PUSH_TARGET`, and `$GIT_CWD` for all git and platform operations below instead of `$REMOTE` and `$TARGET_BRANCH`.

**Ambiguous check:** If `$AMBIGUOUS` is `"true"`, tell the user: "Multiple submodules have changes. Cannot determine target repo for PR. Commit to only one submodule, or specify manually." Then stop — do not proceed with PR creation.

Parse flags:
- `--draft` / `--no-draft`: Override `pr_draft` config
- `--auto`: Non-interactive mode (use defaults, no prompts)
- `--type {type}`: Override branch type (feat, fix, chore, refactor)
- `--title "..."`: Override PR title

```bash
# Flag parsing
PR_DRAFT=$(node "$HOME/.claude/gsd-ng/bin/gsd-tools.cjs" init-get "$INIT" pr_draft 2>/dev/null)

if [[ "$ARGUMENTS" == *"--draft"* ]] && [[ "$ARGUMENTS" != *"--no-draft"* ]]; then
  PR_DRAFT="true"
fi
if [[ "$ARGUMENTS" == *"--no-draft"* ]]; then
  PR_DRAFT="false"
fi
AUTO_MODE=false
if [[ "$ARGUMENTS" == *"--auto"* ]]; then
  AUTO_MODE=true
fi
```
</step>

<step name="detect_platform">
Platform, CLI, and CLI availability are already extracted from the detect-platform calls above (`$PLATFORM`, `$CLI`, `$CLI_INSTALLED`, `$CLI_INSTALL_URL`). No additional call is needed.

**If `$PLATFORM` is empty:**

Warn the user: "Could not detect git hosting platform from remote URL. Set platform manually: `node gsd-tools.cjs config-set git.platform github`. Supported: github, gitlab, forgejo, gitea." Stop — return without creating PR.

**If `$CLI_INSTALLED` is `"false"`:**

Warn the user: "{CLI} CLI not found. Install from {CLI_INSTALL_URL} to enable PR creation. Do NOT use raw API calls as a workaround — install the CLI tool." Stop — return without creating PR.
</step>

<step name="validate_target_branch">
Verify the target branch exists on the remote before attempting PR creation:

```bash
if ! git -C "$GIT_CWD" ls-remote --heads "$PUSH_REMOTE" "$PUSH_TARGET" | grep -q "$PUSH_TARGET"; then
  echo "Error: Target branch '$PUSH_TARGET' not found on remote '$PUSH_REMOTE'."
  echo "Available branches:"
  git -C "$GIT_CWD" ls-remote --heads "$PUSH_REMOTE" | head -10
  if [ "$IS_SUBMODULE" = "true" ]; then
    echo "Set target branch: node gsd-tools.cjs config-set git.submodule.target_branch {branch}"
  else
    echo "Set target branch: node gsd-tools.cjs config-set git.target_branch {branch}"
  fi
  exit 1
fi
```

Fail early with clear message if target branch doesn't exist on remote.
</step>

<step name="handle_none_strategy">
**If `branching_strategy` is `"none"`:**

No review branch, no squash. Open PR directly from current branch.

```bash
if [ "$BRANCHING_STRATEGY" = "none" ]; then
  CURRENT_BRANCH=$(git -C "$GIT_CWD" branch --show-current)
  HEAD_BRANCH="$CURRENT_BRANCH"
  # Skip to build_pr_description — no review branch needed
fi
```

For none strategy: skip `determine_type`, `create_review_branch`, and `push_review_branch` steps.
Skip to `build_pr_description` step. The PR will be opened from the current branch against `$PUSH_TARGET`.
</step>

<step name="determine_type">
Determine the branch type for the review branch naming.

```bash
if [ "$IS_QUICK_TASK" = "true" ]; then
  # Quick-task type inference: keyword match against the SUMMARY one_liner.
  # Fall back to feat when no keyword matches.
  if [[ "$ONE_LINER" =~ fix|bug|patch ]]; then
    TYPE="fix"
  elif [[ "$ONE_LINER" =~ refactor|clean|migrate ]]; then
    TYPE="refactor"
  elif [[ "$ONE_LINER" =~ chore|config|setup ]]; then
    TYPE="chore"
  else
    TYPE="feat"
  fi
  # --type flag override (shared with phase path)
  if [[ "$ARGUMENTS" =~ --type[[:space:]]+([a-z]+) ]]; then
    TYPE="${BASH_REMATCH[1]}"
  fi
  TYPE_ALIAS=$(node "$HOME/.claude/gsd-ng/bin/gsd-tools.cjs" resolve-type-alias "${TYPE}")
else
  # Phase path: read phase goal from ROADMAP.md and infer type.

  # **In `--auto` mode:** Default to `feature` when ambiguous.

  # **In interactive mode:**

  # Read phase goal from ROADMAP.md. Infer type:
  # - Goal contains "fix", "bug", "patch" -> suggest `fix` (branch prefix: `bugfix`)
  # - Goal contains "refactor", "clean", "migrate" -> suggest `refactor`
  # - Goal contains "chore", "config", "setup" -> suggest `chore`
  # - Otherwise -> suggest `feat` (branch prefix: `feature`)

  # If `--type` flag provided, use that directly.

  # Ask user to confirm or override (in interactive mode only):
  #   Branch type for review branch: {suggested_type} (branch prefix: {alias})
  #   Override? (enter to accept, or type: feat/fix/chore/refactor)

  # Map the short type to its branch prefix alias using resolve-type-alias
  # e.g., TYPE=feat -> TYPE_ALIAS=feature
  TYPE_ALIAS=$(node "$HOME/.claude/gsd-ng/bin/gsd-tools.cjs" resolve-type-alias "${TYPE:-feat}")
fi
```

Map the type to its alias for the branch name.
</step>

<step name="create_review_branch">
**For phase/milestone strategies only.**

Compute review branch name:
```bash
if [ "$IS_QUICK_TASK" = "true" ]; then
  # Quick-task review branch: {type_alias}/{slug}
  REVIEW_BRANCH="${TYPE_ALIAS}/${QUICK_SLUG}"
else
  # Phase path: expand template (default: "{type}/{phase}-{slug}")
  REVIEW_BRANCH=$(echo "$REVIEW_BRANCH_TEMPLATE" | \
    sed "s/{type}/$TYPE_ALIAS/g" | \
    sed "s/{phase}/$PHASE_NUMBER/g" | \
    sed "s/{slug}/$PHASE_SLUG/g")
fi
```

Save the current work branch for later:
```bash
CURRENT_BRANCH=$(git -C "$GIT_CWD" branch --show-current)
```

**Collision guard:** If the review branch name matches the current work branch, handle per mode to prevent data loss from `reset --hard`:
```bash
if [ "$REVIEW_BRANCH" = "$CURRENT_BRANCH" ]; then
  if [ "$AUTO_MODE" = "true" ]; then
    # Auto-suffix: append -2, -3, etc. until unique
    SUFFIX=2
    while [ "$REVIEW_BRANCH-$SUFFIX" = "$CURRENT_BRANCH" ] || git show-ref --verify --quiet "refs/heads/$REVIEW_BRANCH-$SUFFIX" 2>/dev/null; do
      SUFFIX=$((SUFFIX + 1))
    done
    REVIEW_BRANCH="$REVIEW_BRANCH-$SUFFIX"
    echo "Auto-suffixed review branch to '$REVIEW_BRANCH' to avoid collision with work branch."
  else
    echo "Error: review branch '$REVIEW_BRANCH' is the same as work branch '$CURRENT_BRANCH'."
    echo "This would destroy uncommitted work via 'git reset --hard'."
    echo "Fix: set a distinct review_branch_template in config.json."
    echo "  Example: node \"\$HOME/.claude/gsd-ng/bin/gsd-tools.cjs\" config-set git.review_branch_template 'review/{phase}-{slug}'"
    exit 1
  fi
fi
```

Create or reset review branch from target_branch:
```bash
if git -C "$GIT_CWD" show-ref --verify --quiet "refs/heads/$REVIEW_BRANCH" 2>/dev/null; then
  # Review branch exists — this is an update (re-squash)
  git -C "$GIT_CWD" checkout "$REVIEW_BRANCH"
  git -C "$GIT_CWD" reset --hard "$PUSH_TARGET"
else
  git -C "$GIT_CWD" checkout -b "$REVIEW_BRANCH" "$PUSH_TARGET"
fi
```

Squash work branch onto review branch:
```bash
# Single squash of all work from the GSD work branch
git -C "$GIT_CWD" merge --squash "$CURRENT_BRANCH" 2>&1

if [ "$IS_QUICK_TASK" = "true" ]; then
  # Quick-task squash message: subject = "<type>: <one_liner>", body = SUMMARY.md content
  SQUASH_BODY=$(cat "$QUICK_SUMMARY")
  git -C "$GIT_CWD" commit -m "$(printf "%s: %s\n\n%s" "$TYPE" "$ONE_LINER" "$SQUASH_BODY")"
else
  # Phase path: build squash message from plan SUMMARYs glob
  SQUASH_MSG=""
  for summary in $(ls .planning/phases/${PHASE_DIR_NAME}/*-SUMMARY.md 2>/dev/null | sort); do
    ONE_LINER_PLAN=$(node "$HOME/.claude/gsd-ng/bin/gsd-tools.cjs" summary-extract "$summary" --fields one_liner --default "" --pick one_liner)
    if [ -n "$ONE_LINER_PLAN" ]; then
      PLAN_ID=$(basename "$summary" | sed 's/-SUMMARY.md//')
      SQUASH_MSG="${SQUASH_MSG}- ${PLAN_ID}: ${ONE_LINER_PLAN}\n"
    fi
  done

  if [ -z "$SQUASH_MSG" ]; then
    SQUASH_MSG="Phase ${PHASE_NUMBER}: ${PHASE_NAME}"
  fi

  git -C "$GIT_CWD" commit -m "$(printf "feat: Phase ${PHASE_NUMBER} - ${PHASE_NAME}\n\n${SQUASH_MSG}")"
fi
```

Set HEAD_BRANCH for PR creation:
```bash
HEAD_BRANCH="$REVIEW_BRANCH"
```
</step>

<step name="push_review_branch">
Push the review branch (or current branch for none strategy) to remote:

```bash
# For review branches, use --force-with-lease (squash rewrites history)
if [ "$BRANCHING_STRATEGY" != "none" ]; then
  PUSH_OUT=$(git -C "$GIT_CWD" push --force-with-lease -u "$PUSH_REMOTE" "$HEAD_BRANCH" 2>&1)
else
  # For none strategy, regular push with upstream tracking (safe to use -u unconditionally)
  UPSTREAM=$(git -C "$GIT_CWD" rev-parse --abbrev-ref --symbolic-full-name "@{u}" 2>/dev/null || echo "")
  if [ -n "$UPSTREAM" ]; then
    PUSH_OUT=$(git -C "$GIT_CWD" push "$PUSH_REMOTE" "$HEAD_BRANCH" 2>&1)
  else
    PUSH_OUT=$(git -C "$GIT_CWD" push -u "$PUSH_REMOTE" "$HEAD_BRANCH" 2>&1)
  fi
fi
PUSH_EXIT=$?

if [ $PUSH_EXIT -ne 0 ]; then
  echo "Error: Push failed — $PUSH_OUT"
  echo "Fix the issue and retry: {{COMMAND_PREFIX}}create-pr ${PHASE_ARG}"
  # Return to work branch before exiting
  git -C "$GIT_CWD" checkout "$CURRENT_BRANCH" 2>/dev/null || true
  exit 1
fi

if echo "$PUSH_OUT" | grep -q 'Bypassed rule violations'; then
  echo "Error: push bypassed required branch protection rules:"
  echo "$PUSH_OUT" | grep -E '(Bypassed rule violations|^remote: -)' | sed 's/^/  /'
  exit 1
fi
```

STOP on push failure — cannot create PR without pushed branch.

Return to work branch after push (for phase/milestone strategies):
```bash
if [ "$BRANCHING_STRATEGY" != "none" ]; then
  git -C "$GIT_CWD" checkout "$CURRENT_BRANCH" 2>/dev/null || true
fi
```
</step>

<step name="build_pr_description">
Build PR description.

```bash
PR_BODY_FILE=$(mktemp)

if [ "$IS_QUICK_TASK" = "true" ]; then
  # Quick-task description: SUMMARY-derived. No template precedence chain
  # (a dedicated quick_pr_template config knob is deferred to a future phase).
  cat > "$PR_BODY_FILE" << QTEMPLATE
## Summary

${ONE_LINER}

$(cat "${QUICK_SUMMARY}")

## Test Plan

- [ ] Automated tests pass
- [ ] Manual verification complete

---
*Generated by GSD-NG from quick task ${QUICK_SLUG}*
QTEMPLATE

else
  # Phase path: template precedence chain — user config > repo template > GSD default.

  # 1. Check user config template
  PR_TEMPLATE_PATH=$(node "$HOME/.claude/gsd-ng/bin/gsd-tools.cjs" init-get "$INIT" pr_template 2>/dev/null)

  if [ -n "$PR_TEMPLATE_PATH" ] && [ -f "$PR_TEMPLATE_PATH" ]; then
    # User config template — copy and apply variable substitution below
    cp "$PR_TEMPLATE_PATH" "$PR_BODY_FILE"

  elif [ -f ".github/PULL_REQUEST_TEMPLATE.md" ]; then
    # GitHub repo template
    echo "(Using repo PR template from .github/PULL_REQUEST_TEMPLATE.md)"
    cp ".github/PULL_REQUEST_TEMPLATE.md" "$PR_BODY_FILE"

  elif [ -d ".gitlab/merge_request_templates" ]; then
    # GitLab repo template — use Default.md if it exists
    GITLAB_TEMPLATE=".gitlab/merge_request_templates/Default.md"
    if [ -f "$GITLAB_TEMPLATE" ]; then
      echo "(Using repo MR template from $GITLAB_TEMPLATE)"
      cp "$GITLAB_TEMPLATE" "$PR_BODY_FILE"
    fi

  else
    # GSD default professional template
    # Extract phase goal using --pick
    PHASE_OBJECTIVE=$(node "$HOME/.claude/gsd-ng/bin/gsd-tools.cjs" roadmap get-phase "${PHASE_NUMBER}" --pick goal --default "")

    # Extract plan summaries
    PLAN_SUMMARIES=""
    for summary in $(ls .planning/phases/${PHASE_DIR_NAME}/*-SUMMARY.md 2>/dev/null | sort); do
      ONE_LINER_PLAN=$(node "$HOME/.claude/gsd-ng/bin/gsd-tools.cjs" summary-extract "$summary" --fields one_liner --default "" --pick one_liner)
      if [ -n "$ONE_LINER_PLAN" ]; then
        PLAN_ID=$(basename "$summary" | sed 's/-SUMMARY.md//')
        PLAN_SUMMARIES="${PLAN_SUMMARIES}\n- **${PLAN_ID}**: ${ONE_LINER_PLAN}"
      fi
    done

    cat > "$PR_BODY_FILE" << PRTEMPLATE
## Summary

${PHASE_OBJECTIVE:-Phase ${PHASE_NUMBER}: ${PHASE_NAME}}

## Changes
${PLAN_SUMMARIES:-No plan summaries available.}

## Test Plan

- [ ] Automated tests pass
- [ ] Manual verification complete

---
*Generated by [GSD-NG](https://github.com/chrisdevchroma/gsd-ng) from phase ${PHASE_NUMBER} execution*
PRTEMPLATE
  fi

  # Apply GSD variable substitution to whichever template was selected
  sed -i \
    -e "s/{phase_name}/${PHASE_NAME}/g" \
    -e "s/{phase_number}/${PHASE_NUMBER}/g" \
    -e "s/{phase_objective}/${PHASE_OBJECTIVE:-}/g" \
    "$PR_BODY_FILE"
fi
```
</step>

<step name="sanitize_outbound">
Before building the PR title or creating the PR, sanitize the description body:

If the PR body contains `<untrusted-content` tags (from imported issue content in phase context), these must be stripped before submission. These tags are for internal GSD agent use and should not appear in GitHub/GitLab PR descriptions.

```bash
# The agent should process the PR body text to remove wrapper tags
# Replace: <untrusted-content source="...">content</untrusted-content>
# With: content (inner text preserved, tags removed)
if grep -q '<untrusted-content' "$PR_BODY_FILE" 2>/dev/null; then
  # Strip opening tags: <untrusted-content source="...">
  # Strip closing tags: </untrusted-content>
  # Preserve everything between the tags (inner content intact)
  sed -i 's|<untrusted-content[^>]*>||g; s|</untrusted-content>||g' "$PR_BODY_FILE"
fi
```

This is a text transformation the agent performs on the PR body string before passing it to `gh pr create`. The pattern to remove is:
- Opening tag: `<untrusted-content source="...">` (any source value)
- Closing tag: `</untrusted-content>`
- Preserve everything between the tags

If no `<untrusted-content` tags are present, no action needed.

Note: `stripUntrustedWrappers()` in `bin/lib/security.cjs` implements the same logic programmatically for non-workflow code paths. This step is the agent-facing equivalent.
</step>

<step name="build_pr_title">
Determine PR title:

```bash
if [ -n "$TITLE_FLAG" ]; then
  PR_TITLE="$TITLE_FLAG"  # --title flag wins (existing behavior)
elif [ "$IS_QUICK_TASK" = "true" ]; then
  PR_TITLE="${TYPE}: ${ONE_LINER}"
else
  PR_TITLE="Phase ${PHASE_NUMBER}: ${PHASE_NAME}"
fi
```

In interactive mode (no `--auto`), ask user to confirm or edit:
```
PR title: {PR_TITLE}
Edit? (enter to accept, or type new title)
```
</step>

<step name="create_pr">
Create the PR/MR using the platform-specific CLI. The body file (`$PR_BODY_FILE`) has been sanitized of `<untrusted-content>` wrapper tags by the `sanitize_outbound` step — external systems should never receive these internal GSD tags.

```bash
# Determine draft flag / title prefix per platform:
#
#   github / gitlab: support --draft flag natively.
#
#   forgejo (fj pr create): has NO --draft flag. A PR is a draft when the title
#   is prefixed with "WIP: " — fj recognizes this prefix and marks the PR as draft.
#   Ref: https://codeberg.org/forgejo/cli (fj pr create docs).
#
#   gitea (tea pr create): tea v0.9+ supports `--type draft` to create a draft PR.
#   If you are on an older tea that does not support --type, fall back to the WIP
#   title prefix (same mechanism as forgejo) — the Gitea API accepts WIP-prefixed
#   titles as draft indicators on older versions. The current implementation uses
#   `--type draft` which requires tea >= 0.9.

DRAFT_FLAG=""
if [ "$PR_DRAFT" = "true" ]; then
  DRAFT_FLAG="--draft"
fi

# For forgejo and gitea, adjust the title to signal draft mode.
EFFECTIVE_TITLE="$PR_TITLE"
if [ "$PR_DRAFT" = "true" ]; then
  case "$PLATFORM" in
    forgejo)
      # Forgejo draft = WIP: title prefix (no --draft flag in fj CLI)
      EFFECTIVE_TITLE="WIP: $PR_TITLE"
      ;;
    gitea)
      # Gitea draft via tea --type draft (tea >= 0.9). WIP prefix is the fallback
      # for older tea versions; not prepended here since --type draft is passed below.
      ;;
  esac
fi

case "$PLATFORM" in
  github)
    PR_URL=$(gh pr create \
      --base "$PUSH_TARGET" \
      --head "$HEAD_BRANCH" \
      --title "$EFFECTIVE_TITLE" \
      --body-file "$PR_BODY_FILE" \
      $DRAFT_FLAG 2>&1)
    PR_EXIT=$?
    ;;

  gitlab)
    PR_URL=$(glab mr create \
      --target-branch "$PUSH_TARGET" \
      --source-branch "$HEAD_BRANCH" \
      --title "$EFFECTIVE_TITLE" \
      --description "$(cat "$PR_BODY_FILE")" \
      $DRAFT_FLAG 2>&1)
    PR_EXIT=$?
    ;;

  forgejo)
    # Draft mode: title is prefixed with "WIP: " above (no --draft flag in fj).
    PR_URL=$(fj pr create \
      --base "$PUSH_TARGET" \
      --head "$HEAD_BRANCH" \
      --title "$EFFECTIVE_TITLE" \
      --body "$(cat "$PR_BODY_FILE")" 2>&1)
    PR_EXIT=$?
    ;;

  gitea)
    # Draft mode: tea >= 0.9 supports --type draft. Older tea: use WIP: prefix instead.
    if [ "$PR_DRAFT" = "true" ]; then
      PR_URL=$(tea pr create \
        --base "$PUSH_TARGET" \
        --head "$HEAD_BRANCH" \
        --title "$EFFECTIVE_TITLE" \
        --description "$(cat "$PR_BODY_FILE")" \
        --type draft 2>&1)
    else
      PR_URL=$(tea pr create \
        --base "$PUSH_TARGET" \
        --head "$HEAD_BRANCH" \
        --title "$EFFECTIVE_TITLE" \
        --description "$(cat "$PR_BODY_FILE")" 2>&1)
    fi
    PR_EXIT=$?
    ;;

  *)
    echo "Error: Unknown platform '$PLATFORM'"
    PR_EXIT=1
    ;;
esac

# Cleanup temp file
rm -f "$PR_BODY_FILE"
```

Handle result:
```bash
if [ $PR_EXIT -ne 0 ]; then
  echo "Error: PR creation failed: $PR_URL"
  echo "Branch '$HEAD_BRANCH' is pushed — create PR manually at your hosting platform."
else
  echo ""
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo " GSD > PR CREATED"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo ""
  if [ "$IS_QUICK_TASK" = "true" ]; then
    echo "  Quick:  ${QUICK_SLUG}"
  else
    echo "  Phase:  ${PHASE_NUMBER} - ${PHASE_NAME}"
  fi
  echo "  Branch: ${HEAD_BRANCH} -> ${PUSH_TARGET}"
  echo "  Draft:  ${PR_DRAFT}"
  echo "  URL:    ${PR_URL}"
  echo ""
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
fi
```
</step>

<step name="detect_repo_template_notice">
If a repo template exists but was NOT used (because user config took precedence), surface a notice:

```bash
if [ -n "$PR_TEMPLATE_PATH" ]; then
  if [ -f ".github/PULL_REQUEST_TEMPLATE.md" ]; then
    echo "Note: Repo PR template exists at .github/PULL_REQUEST_TEMPLATE.md but was overridden by git.pr_template config."
  fi
  if [ -d ".gitlab/merge_request_templates" ]; then
    echo "Note: Repo MR templates exist at .gitlab/merge_request_templates/ but were overridden by git.pr_template config."
  fi
fi
```
</step>

</process>

<success_criteria>
- [ ] Platform detected from remote URL or config
- [ ] CLI availability verified (missing CLI produces clear warning, Do NOT use raw API calls as a workaround — install the CLI tool)
- [ ] Target branch validated on remote
- [ ] Review branch created and squashed from work branch (for phase/milestone strategies)
- [ ] PR description built from template precedence chain (user config > repo template > GSD default)
- [ ] PR created via platform CLI (gh pr create / glab mr create / fj pr create / tea pr create)
- [ ] Draft mode applied correctly: github/gitlab use --draft flag; forgejo prepends "WIP: " to title (no --draft flag in fj); gitea uses tea --type draft (tea >= 0.9)
- [ ] PR URL displayed to user
- [ ] Work branch restored as current branch after PR creation
- [ ] force-with-lease used for review branch re-push (squash rewrites history)
- [ ] Repo template detection with notice when overridden by user config
- [ ] Quick-task slug detected from $PHASE_ARG when matching ^[0-9]{6}-[a-z0-9]{3}- ; SUMMARY-derived squash + PR
</success_criteria>
