<planning_config>

Configuration options for `.planning/` directory behavior.

<config_schema>
```json
"planning": {
  "commit_docs": true,
  "search_gitignored": false
},
"git": {
  "branching_strategy": "none",
  "phase_branch_template": "gsd/phase-{phase}-{slug}",
  "milestone_branch_template": "gsd/{milestone}-{slug}",
  "target_branch": "main",
  "auto_push": false,
  "remote": "origin",
  "review_branch_template": "{type}/{phase}-{slug}",
  "pr_draft": true,
  "platform": null,
  "type_aliases": {
    "feat": "feature",
    "fix": "bugfix",
    "chore": "chore",
    "refactor": "refactor"
  },
  "commit_format": "gsd",
  "commit_template": null,
  "versioning_scheme": "semver"
}
```

| Option | Default | Description |
|--------|---------|-------------|
| `commit_docs` | `true` | Whether to commit planning artifacts to git |
| `search_gitignored` | `false` | Add `--no-ignore` to broad rg searches |
| `git.branching_strategy` | `"none"` | Git branching approach: `"none"`, `"phase"`, or `"milestone"` |
| `git.phase_branch_template` | `"gsd/phase-{phase}-{slug}"` | Branch template for phase strategy |
| `git.milestone_branch_template` | `"gsd/{milestone}-{slug}"` | Branch template for milestone strategy |
| `git.target_branch` | `"main"` | Default merge target for PRs and branch creation |
| `git.auto_push` | `false` | Push work branch to remote after phase completion |
| `git.remote` | `"origin"` | Remote name for push/PR operations |
| `git.review_branch_template` | `"{type}/{phase}-{slug}"` | Template for team-facing review branches |
| `git.pr_draft` | `true` | Create PRs as drafts by default |
| `git.platform` | `null` | Override platform auto-detection |
| `git.commit_format` | `"gsd"` | Commit message preset: gsd, conventional, issue-first, custom |
| `git.commit_template` | `null` | Custom template string (when commit_format is custom) |
| `git.versioning_scheme` | `"semver"` | Version scheme: semver, calver, date |
</config_schema>

<commit_docs_behavior>

**When `commit_docs: true` (default):**
- Planning files committed normally
- SUMMARY.md, STATE.md, ROADMAP.md tracked in git
- Full history of planning decisions preserved

**When `commit_docs: false`:**
- Skip all `git add`/`git commit` for `.planning/` files
- User must add `.planning/` to `.gitignore`
- Useful for: OSS contributions, client projects, keeping planning private

**Using gsd-tools.cjs (preferred):**

```bash
# Commit with automatic commit_docs + gitignore checks:
node "$HOME/.claude/gsd-ng/bin/gsd-tools.cjs" commit "docs: update state" --files .planning/STATE.md

# Load config via state load (returns JSON):
INIT=$(node "$HOME/.claude/gsd-ng/bin/gsd-tools.cjs" state load)
# commit_docs is available in the JSON output

# Or use init commands which include commit_docs:
INIT=$(node "$HOME/.claude/gsd-ng/bin/gsd-tools.cjs" init execute-phase "1")
# commit_docs is included in all init command outputs
```

**Auto-detection:** If `.planning/` is gitignored, `commit_docs` is automatically `false` regardless of config.json. This prevents git errors when users have `.planning/` in `.gitignore`.

**Commit via CLI (handles checks automatically):**

```bash
node "$HOME/.claude/gsd-ng/bin/gsd-tools.cjs" commit "docs: update state" --files .planning/STATE.md
```

The CLI checks `commit_docs` config and gitignore status internally — no manual conditionals needed.

</commit_docs_behavior>

<workflow_config>

**Workflow Toggles:**

Boolean toggles that gate optional steps in GSD workflows. Set to `false` to disable. Defaults preserve current behavior — adding the key is opt-out.

| Option | Default | Description |
|--------|---------|-------------|
| `workflow.research` | `true` | Spawn researcher subagent during `plan-phase` |
| `workflow.plan_check` | `true` | Spawn plan checker during `plan-phase` |
| `workflow.verifier` | `true` | Spawn verifier subagent during `execute-phase` |
| `workflow.nyquist_validation` | `true` | Validation-architecture research during `plan-phase` |
| `workflow.ui_phase` | `true` | Enable UI design + audit features (master toggle for `{{COMMAND_PREFIX}}ui-phase` and `{{COMMAND_PREFIX}}ui-review`) |
| `workflow.node_repair` | `true` | Auto-attempt RETRY/DECOMPOSE/PRUNE on verification failure during `execute-plan` |
| `workflow.node_repair_budget` | `2` | Max repair attempts per failing task before ESCALATE |
| `workflow.incremental_remap` | `true` | Auto-update codebase docs after phase completion via `gsd-incremental-mapper` agents. Set `false` to skip — useful when codebase docs are intentionally manual or when phase work doesn't touch documented modules. |
| `workflow.auto_advance` | `false` | Auto-chain phases without user confirmation (yolo mode) |

**Settings UI exposure:** Most toggles surface in `{{COMMAND_PREFIX}}settings`. Internal performance/quality tweaks (`node_repair`, `node_repair_budget`) are config-only — edit `.planning/config.json` directly.

</workflow_config>

<search_behavior>

**When `search_gitignored: false` (default):**
- Standard rg behavior (respects .gitignore)
- Direct path searches work: `rg "pattern" .planning/` finds files
- Broad searches skip gitignored: `rg "pattern"` skips `.planning/`

**When `search_gitignored: true`:**
- Add `--no-ignore` to broad rg searches that should include `.planning/`
- Only needed when searching entire repo and expecting `.planning/` matches

**Note:** Most GSD operations use direct file reads or explicit paths, which work regardless of gitignore status.

</search_behavior>

<setup_uncommitted_mode>

To use uncommitted mode:

1. **Set config:**
   ```json
   "planning": {
     "commit_docs": false,
     "search_gitignored": true
   }
   ```

2. **Add to .gitignore:**
   ```
   .planning/
   ```

3. **Existing tracked files:** If `.planning/` was previously tracked:
   ```bash
   git rm -r --cached .planning/
   git commit -m "chore: stop tracking planning docs"
   ```

4. **Branch merges:** When using `branching_strategy: phase` or `milestone`, the `complete-milestone` workflow automatically strips `.planning/` files from staging before merge commits when `commit_docs: false`.

</setup_uncommitted_mode>

<branching_strategy_behavior>

**Branching Strategies:**

| Strategy | When branch created | Branch scope | Merge point |
|----------|---------------------|--------------|-------------|
| `none` | Never | N/A | N/A |
| `phase` | At `execute-phase` start | Single phase | User merges after phase |
| `milestone` | At first `execute-phase` of milestone | Entire milestone | At `complete-milestone` |

**When `git.branching_strategy: "none"` (default):**
- All work commits to current branch
- Standard GSD behavior

**When `git.branching_strategy: "phase"`:**
- `execute-phase` creates/switches to a branch before execution
- Branch name from `phase_branch_template` (e.g., `gsd/phase-03-authentication`)
- All plan commits go to that branch
- User merges branches manually after phase completion
- `complete-milestone` offers to merge all phase branches

**When `git.branching_strategy: "milestone"`:**
- First `execute-phase` of milestone creates the milestone branch
- Branch name from `milestone_branch_template` (e.g., `gsd/v1.0-mvp`)
- All phases in milestone commit to same branch
- `complete-milestone` offers to merge milestone branch to main

**Template variables:**

| Variable | Available in | Description |
|----------|--------------|-------------|
| `{phase}` | phase_branch_template | Zero-padded phase number (e.g., "03") |
| `{slug}` | Both | Lowercase, hyphenated name |
| `{milestone}` | milestone_branch_template | Milestone version (e.g., "v1.0") |

**Checking the config:**

Use `init execute-phase` which returns all config as JSON:
```bash
INIT=$(node "$HOME/.claude/gsd-ng/bin/gsd-tools.cjs" init execute-phase "1")
# JSON output includes: branching_strategy, phase_branch_template, milestone_branch_template
```

Or use `state load` for the config values:
```bash
INIT=$(node "$HOME/.claude/gsd-ng/bin/gsd-tools.cjs" state load)
# Parse branching_strategy, phase_branch_template, milestone_branch_template from JSON
```

**Branch creation:**

```bash
# For phase strategy
if [ "$BRANCHING_STRATEGY" = "phase" ]; then
  PHASE_SLUG=$(echo "$PHASE_NAME" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9]/-/g' | sed 's/--*/-/g' | sed 's/^-//;s/-$//')
  BRANCH_NAME=$(echo "$PHASE_BRANCH_TEMPLATE" | sed "s/{phase}/$PADDED_PHASE/g" | sed "s/{slug}/$PHASE_SLUG/g")
  git checkout -b "$BRANCH_NAME" 2>/dev/null || git checkout "$BRANCH_NAME"
fi

# For milestone strategy
if [ "$BRANCHING_STRATEGY" = "milestone" ]; then
  MILESTONE_SLUG=$(echo "$MILESTONE_NAME" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9]/-/g' | sed 's/--*/-/g' | sed 's/^-//;s/-$//')
  BRANCH_NAME=$(echo "$MILESTONE_BRANCH_TEMPLATE" | sed "s/{milestone}/$MILESTONE_VERSION/g" | sed "s/{slug}/$MILESTONE_SLUG/g")
  git checkout -b "$BRANCH_NAME" 2>/dev/null || git checkout "$BRANCH_NAME"
fi
```

**Merge options at complete-milestone:**

| Option | Git command | Result |
|--------|-------------|--------|
| Squash merge (recommended) | `git merge --squash` | Single clean commit per branch |
| Merge with history | `git merge --no-ff` | Preserves all individual commits |
| Delete without merging | `git branch -D` | Discard branch work |
| Keep branches | (none) | Manual handling later |

Squash merge is recommended — keeps main branch history clean while preserving the full development history in the branch (until deleted).

**Use cases:**

| Strategy | Best for |
|----------|----------|
| `none` | Solo development, simple projects |
| `phase` | Code review per phase, granular rollback, team collaboration |
| `milestone` | Release branches, staging environments, PR per version |

</branching_strategy_behavior>

<git_collaboration_config>

**Git Collaboration Options (Phase 13):**

| Option | Default | Description |
|--------|---------|-------------|
| `git.target_branch` | `"main"` | Default merge target for PRs and branch creation |
| `git.auto_push` | `false` | Push work branch to remote after phase completion |
| `git.remote` | `"origin"` | Remote name for push/PR operations |
| `git.review_branch_template` | `"{type}/{phase}-{slug}"` | Template for team-facing review branches |
| `git.type_aliases` | `{"feat":"feature","fix":"bugfix","chore":"chore","refactor":"refactor"}` | Maps commit types to branch prefixes |
| `git.pr_template` | `null` | Path to custom PR description template (markdown with GSD variables) |
| `git.pr_draft` | `true` | Create PRs as drafts by default |
| `git.platform` | `null` | Override platform auto-detection: `"github"`, `"gitlab"`, `"forgejo"`, `"gitea"` |

**Two-Layer Branch Model:**

GSD uses a two-layer branch model for team collaboration:

1. **Work branch** (Layer 1): GSD's internal branch for atomic per-task commits. Controlled by existing `branching_strategy`, `phase_branch_template`, `milestone_branch_template`. Based from `target_branch` instead of current HEAD.

2. **Review branch** (Layer 2): Team-facing branch created by `{{COMMAND_PREFIX}}create-pr`. Named via `review_branch_template`. Contains squashed commits for clean PR history.

**Target Branch:**

The `target_branch` determines:
- Base for new work branches: `git checkout -b {work_branch} {target_branch}`
- PR target: PRs opened against this branch
- Merge target in `complete-milestone`

Per-milestone override: `{{COMMAND_PREFIX}}new-milestone --target-branch develop`

**Review Branch Template Variables:**

| Variable | Description | Example |
|----------|-------------|---------|
| `{type}` | Branch type from type_aliases | `feature`, `bugfix` |
| `{phase}` | Zero-padded phase number | `13` |
| `{slug}` | Lowercase hyphenated phase name | `git-branching` |

**Platform CLI Requirements:**

| Platform | CLI | Install |
|----------|-----|---------|
| GitHub | `gh` | `brew install gh` or github.com/cli/cli |
| GitLab | `glab` | `brew install glab` or gitlab.com/gitlab-org/cli |
| Forgejo | `fj` | forgejo.org/cli |
| Gitea | `tea` | gitea.com/gitea/tea |

If the required CLI is not installed, PR creation is disabled with a warning. Push features still work.

</git_collaboration_config>

<commit_format_config>

**Commit Format & Versioning Options (Phase 14):**

| Option | Default | Description |
|--------|---------|-------------|
| `git.commit_format` | `"gsd"` | Commit message preset: `"gsd"`, `"conventional"`, `"issue-first"`, `"custom"` |
| `git.commit_template` | `null` | Custom template string when `commit_format` is `"custom"`. Placeholders: `{type}`, `{scope}`, `{description}`, `{issue}` |
| `git.versioning_scheme` | `"semver"` | Version scheme: `"semver"`, `"calver"`, `"date"` |

**Commit Format Presets:**

| Preset | Format | Example |
|--------|--------|---------|
| `gsd` (default) | `{type}({scope}): {description}` with phase/plan prefix | `feat(14-01): add changelog generation` |
| `conventional` | Strict Conventional Commits format (message passed through) | `feat(auth): add OAuth2 login` |
| `issue-first` | `[#N] {description}` when issue ref present | `[#42] add OAuth2 login` |
| `custom` | User-defined template from `git.commit_template` | Depends on template |

**GSD-generated commits only** -- no pre-commit hook enforcement on manual git commits. GSD respects existing project git hooks (e.g., commitlint) when they are present.

**Issue reference trailers:**

When a requirement has an `external_ref` field, trailers are appended per Conventional Commits footer spec:
```
feat(auth): add OAuth2 login

Fixes #42
Closes #43
```

Blank line before trailers is required. Recognized by GitHub/GitLab for auto-closing issues.

**Versioning Schemes:**

| Scheme | Format | Bump behavior |
|--------|--------|---------------|
| `semver` (default) | `MAJOR.MINOR.PATCH` | Standard SemVer: breaking=major, feat=minor, fix=patch |
| `calver` | `YYYY.MM.PATCH` | Year.Month from current date, patch increments within month |
| `date` | `MAJOR.MINOR.BUILD` | Chrome-style: BUILD auto-increments each release |

Snapshot builds append `+{short_hash}` (e.g., `1.2.3+abc1234`) per SemVer 2.0.0 build metadata spec. The `+hash` suffix is written to `VERSION` file only (not `package.json` -- npm rejects build metadata).

</commit_format_config>

<submodule_git_config>

### Submodule-Aware Git Operations

When the workspace contains git submodules (`.gitmodules` exists), GSD automatically routes git push, PR creation, and branch operations to the correct repository.

#### Schema: `git.submodules.<name>`

Per-submodule settings live under `git.submodules.<name>` (plural) where `<name>` is the **directory basename** of the submodule (e.g. for path `libs/anvil`, use `anvil`). Per-submodule keys are merged **over** the global `git.*` block — global values are the fallback, per-submodule values take precedence.

#### Supported per-submodule keys

All keys from the `git.*` global scope are also valid per-submodule. The validated allowlist is:

| Key | Default (from global `git.*`) | Description |
|-----|-------------------------------|-------------|
| `target_branch` | `"main"` | Override the integration branch for submodule PRs |
| `branching_strategy` | `"none"` | Branch strategy: `none`, `phase`, `milestone` |
| `phase_branch_template` | `"gsd/phase-{phase}-{slug}"` | Template for phase branches |
| `milestone_branch_template` | `"gsd/{milestone}-{slug}"` | Template for milestone branches |
| `review_branch_template` | `null` | Template for review/PR branches (e.g. `"{type}/{slug}"`) — see note below |
| `remote` | `"origin"` | Git remote name for push/PR operations |
| `auto_push` | `false` | Automatically push branch before PR creation |
| `platform` | (auto-detected) | Force platform: `github`, `gitlab`, `forgejo`, `gitea` |
| `pr_template` | `null` | Path to PR body template file |
| `pr_draft` | `true` | Create PR as draft |
| `commit_format` | `"gsd"` | Commit message format |
| `commit_template` | `null` | Path to commit message template |
| `versioning_scheme` | `"semver"` | Versioning scheme |
| `type_aliases` | `null` | Conventional commit type aliases map |
| `ssh_check` | `true` | Verify SSH key before push |

> **Note:** `review_branch_template` and `type_aliases` are the two exceptions in the submodule path — when unset they resolve to `null` rather than the global `git.*` default (unlike `phase_branch_template`/`milestone_branch_template`, which do fall back to their built-in defaults). Set them explicitly per submodule if you need non-default review-branch naming or type aliases.

#### Example configuration

```json
{
  "git": {
    "target_branch": "main",
    "auto_push": false,
    "submodules": {
      "anvil": {
        "target_branch": "develop",
        "platform": "forgejo",
        "review_branch_template": "{type}/{slug}",
        "pr_draft": true
      },
      "gsd-ng": {
        "platform": "github",
        "target_branch": "develop",
        "branching_strategy": "phase",
        "review_branch_template": "{type}/{slug}"
      }
    }
  }
}
```

#### Resolution order

1. **Auto-detection:** `git-context` inspects `git diff` to identify which submodule has changes
2. **Remote resolution:** Uses the submodule's own configured `remote` (default `origin`), not the workspace remote
3. **Target branch:** Reads from `git.submodules.<name>.target_branch` (merged over global `git.target_branch`), falls back to git tracking info, then `main`
4. **Platform detection:** Per-submodule `platform` key (when set) is passed directly to `detect-platform`, bypassing the inner `loadConfig` that would otherwise look inside the submodule directory (which has no `.planning/`). If `platform` is not set, URL-based auto-detection from the submodule's remote URL is used.

#### Platform and self-hosted hosts

> **Self-hosted caveat:** `detect-platform` auto-detects platform only for known public hosts: `github.com`, `gitlab.com`, `codeberg.org`, `gitea.com`. Any self-hosted instance (e.g. `git.example.com`, `git.company.internal`) **will NOT be auto-detected** — its URL does not match the host map. You **must** set `platform` explicitly in the submodule config.

Example for a self-hosted Forgejo instance:

```json
"submodules": {
  "myproject": {
    "platform": "forgejo"
  }
}
```

**Multi-submodule workspaces:** If multiple submodules have uncommitted changes, GSD surfaces the ambiguity and asks the user to resolve before continuing with push or PR creation.

</submodule_git_config>

</planning_config>
