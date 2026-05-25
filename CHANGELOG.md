# Changelog

All notable changes to gsd-ng will be documented in this file.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

## [1.0.0-dev.13] - 2026-05-25

### Fixed
- npm installs and updates now include `CHANGELOG.md`. Because `CHANGELOG.md` was missing from the package `files` list, the published tarball shipped no changelog, so installing or updating gsd-ng silently omitted it (and could wipe a previously installed copy). It is now packaged and installed with the rest of the project.
- The bash command-safety hook now auto-approves shell conditional tests (`[ … ]` POSIX test and `[[ … ]]` bash conditional). Previously only `test` was allowlisted, so compound commands using bracket tests — e.g. `while read t; do [ -f "$t" ] && …; done` — fell through to a manual permission prompt for an operation that has no side effects. `splitOnOperators` now tracks `[[ … ]]` conditional-keyword depth and no longer splits on `&&`/`||`/`|`/`;` that appear *inside* a `[[ … ]]` construct, so `[[ -n "$x" && -f "$t" ]]` is treated as a single sub-command instead of two broken fragments. The sandbox template gains `Bash([ *)` and `Bash([[ *)` allowlist entries; single-bracket chaining (`[ a ] && [ b ]`) and operators outside `[[ … ]]` still split as before.
- The command-safety hook now fails closed on malformed shell input instead of risking an allowlist bypass. If a command does not parse to a balanced end-state — an unterminated quote, subshell, or backtick, or a malformed `[[` conditional (unclosed, or invalidly nested) — the operator-split tracking could previously absorb the unparsed tail into a single segment that matched an allow rule, hiding a denied command (e.g. `curl`) from the deny check. Such commands are now re-split so every segment is checked independently, and a command left inside an unterminated `$()`/backtick is surfaced too. All these inputs are bash syntax errors (not executable); this is defense-in-depth hardening of the new `[[` handling.

## [1.0.0-dev.12] - 2026-05-24

### Fixed
- `/gsd:update` self-update no longer fails with `Error: --runtime required` on installs of v1.0.0-dev.11 and later; the required `--runtime` flag is now passed to the installer across all update paths (npm and GitHub-release tarball).

## [1.0.0-dev.11] - 2026-05-23

### Added
- Expanded prompt-injection detection for untrusted Markdown. The scanner now flags, as high-confidence blocks, links that use the `javascript:` scheme, links with non-safelisted `data:` URIs (only raster image types — png, jpeg, gif, webp, avif — are allowed; SVG and others are rejected), links with embedded `user:pass@` credentials, and links carrying secret-bearing query parameters (tokens, API keys, passwords, and similar). It also raises a medium-confidence advisory when a link or file reference points at a credential path such as `~/.ssh`, `~/.aws/credentials`, a `.pem`, or a `.env` file. Every detection rule now carries a stable identifier and a human-readable description, and scan results are reported as self-documenting `identifier: description` strings instead of raw regex dumps.

### Fixed
- The background update check no longer runs on every sub-agent spawn. It now only checks for a newer version during a genuine primary-session startup (with a time-based throttle as a backstop), eliminating the repeated npm-registry access prompts seen during multi-agent workflows.

## [1.0.0-dev.10] - 2026-05-23

### Security
- Hardened the prerelease channel against shell injection. The channel label is interpolated into a `npm view gsd-ng dist-tags.<channel>` `execSync` command in both `commands.cjs` and the update-check hook; a crafted `VERSION` file (e.g. a malicious project-local `.claude/gsd-ng/VERSION` read by the auto-running SessionStart hook) could smuggle shell metacharacters through. `parseChannel` in `semver-utils.cjs` now validates the channel against the npm dist-tag charset (letter-led alphanumeric) and returns `null` for anything else, neutralising both call sites. `commands.cjs` now derives its channel via the shared (guarded) `parseChannel` instead of an inline split.

### Fixed
- SessionStart update-check hook (`gsd-check-update.js`) now respects prerelease channels. The hook's child process was using a non-§11 `compareSemVer` (coerced `"0-dev"` to `NaN`), always queried `npm view gsd-ng version` (returns the `latest` dist-tag, not the user's channel), and paginated GitHub Releases unconditionally skipping prereleases for all users. Now: §11-compliant semver comparison via shared `semver-utils.cjs` module, channel-pinned `npm view gsd-ng dist-tags.<channel>` query for prerelease installs, and paginated channel-filtered GitHub Releases fallback for prerelease users (stable users keep the `/releases/latest` path). Channel tag selection is factored into a shared, unit-tested `selectLatestForChannel` helper that matches the channel exactly (`parseChannel(tag) === channel`) rather than by substring.

## [1.0.0-dev.9] - 2026-05-17

### Fixed
- `/gsd:update` never prompted prerelease (`-dev.N`) users to upgrade, even when a newer prerelease was published. Three intertwined bugs in `commands.cjs`: `detectInstallLocation` stripped the prerelease suffix from the local `VERSION` file (so `1.0.0-dev.7+30c9587` became `1.0.0`), `cmdUpdate` queried `npm view gsd-ng version` which returns the `latest` dist-tag rather than the channel the user is on, and `compareSemVer` only compared the numeric core (so `1.0.0` and `1.0.0-dev.3` compared equal). `detectInstallLocation` now preserves the prerelease tag and drops only `+build` metadata, `cmdUpdate` picks the npm dist-tag matching the installed channel (with the previous query as a fallback) and filters GitHub Releases by channel on the fallback path, and `compareSemVer` is now semver §11 compliant — release versions beat prerelease versions, numeric identifiers compare numerically, and identifier counts break ties correctly.

## [1.0.0-dev.8] - 2026-05-15

### Fixed
- `/gsd:update` step 5 shelled out `update --{install_type}` as a literal slash-command bash block, so the placeholder was passed verbatim and `gsd-tools.cjs update` rejected the unknown flag. The same load-time semantics would also have bypassed the step-4 confirmation prompt if the flag had been valid. Step 5 now invokes the Bash tool after confirmation, substituting `install_type` from the dry-run JSON into `--local` or `--global` before the call.

## [1.0.0-dev.7] - 2026-05-14

### Fixed
- `publish.yml` uses Node 24 (npm 11) instead of Node 22 (npm 10). npm 10's CLI sends an unresolved `${NODE_AUTH_TOKEN}` placeholder as the bearer token to the npm registry and never falls back to OIDC trusted publishing, producing a misleading `404 Not Found` error.
- `bash-safety-hook.cjs` was missing from the published npm and GitHub Release tarballs — `package.json` `files` shipped `hooks/dist` but never the `.cjs` source, so installed workspaces failed the PreToolUse Bash hook with "Cannot find module" on every Bash call. `install.js` now also asserts every expected hook landed, failing the install loudly instead of silently.
- Dual-runtime installs no longer corrupt each other. The shared `.planning/config.json` `runtime` field was written by every install, so installing a second runtime into a project flipped effort-frontmatter gating for the first. The engine now detects its runtime from a per-engine `.runtime` marker written into each deployed engine tree instead.

### Changed
- Hooks are published and installed directly from `hooks/`. The `hooks/dist/` build step, `scripts/build-hooks.js`, and the `build:hooks` npm script (with its `pretest` / `prepublishOnly` / `build:tarball` / `test:coverage` call sites and the `npm ci` steps in `release.yml` / `publish.yml`) are removed — `build-hooks.js` had been a no-op file copy since the hooks became dependency-free and `esbuild` was dropped.

## [1.0.0-dev.6] - 2026-05-12

### Changed
- `prepare-release.yml` pushes branch + tag directly via the `RELEASE_PAT` secret; `release.yml` and `publish.yml` fire on the tag push.
- Dependabot opens PRs against `develop`; ecosystems `npm` and `github-actions`, weekly.

### Removed
- `esbuild` devDependency. It was never imported; `build:hooks` only copies files.

### Fixed
- `publish.yml` publish job no longer attaches `environment: release`.

## [1.0.0-dev.4] - 2026-05-10

### Added

#### Hooks & permissions
- Bash safety hook hardening — wrapper-bypass guard: `env`, `timeout`, `xargs`, `nohup`, `exec`, `nice`, `ionice`, `chrt`, `taskset`, `flock`, `stdbuf` invocations now have their wrapped command extracted and checked independently against allow/deny — allowlisting `Bash(env *)` no longer silently approves arbitrary wrapped commands. Handles non-canonical invocation forms (`/usr/bin/env`, `"env"`), shell-quoted assignment values (`FOO="a b"`, `FOO=a\ b`, `FOO="a\" b"`), GNU long-option `=` forms, combined short flags, and flock's `-c <shell-string>` form.
- Bash-hook coverage expansion — broader CLI/argv pattern support and workaround walker triggers
- Sandbox template additions (`Bash(cd:*)`, `Bash(env:*)`, `Bash(timeout:*)`, `Bash(xargs:*)`) required by the wrapper-bypass guard for legitimate compound and wrapper invocations
- Protected-branch ask rules in sandbox template — `Bash(git push * <branch>*)` and `Bash(git -C * push * <branch>*)` for `main`/`master`/`develop` now route to the user prompt instead of auto-approving; `gh pr merge *--admin*` likewise gated
- AST safety hook with rule modernization, shared rule templates, and install-time injection
- Allowlist hardening rework:
  - `RW_FORMS` frozen-Set export in `allowlist.cjs`; `install.js` and `commands.cjs` consume this canonical source for bare/glob Edit/Write/Read permission forms
  - `getReadEditWriteAllowRules(platform)` pure function down-converts to bare `Edit/Write/Read` on Linux (workaround for claude-code #16170/#6881) and keeps canonical `Edit(*)/Write(*)/Read(*)` on macOS
  - `CLI_SUBCOMMANDS` narrowed from blanket `cli repo *` / `cli label *` patterns to explicit two-token verb entries (`view`, `list`, `clone`, `fork`, `create`, etc.) across `gh/glab/fj/tea` — destructive verbs (`delete`, `rename`, `edit`, `archive`) now fall through to prompting
  - `fj` no longer has `label` permission patterns (the `fj` CLI has no `label` subcommand)
  - `install.js` permission seeding split into independent `allow`/`deny`/`ask` section handlers (`deny`/`ask` infrastructure-ready for future template entries)
  - `generate-allowlist --platform <linux|darwin>` accepts explicit platform flag; output is set-equal to `install.js --local` seeding per platform

#### Security
- Multi-language prompt-injection defense — Unicode TR39 confusable normalization (NFKC) in `scanForInjection`, homoglyph evasion logging fields, multi-language injection pattern coverage across 10 languages, context-reset and authority-claim pattern families, roleplay family with dataset coverage assertions and override generalization
- Initial security hardening with prompt-injection defense — input validation, security-event logging, untrusted-content wrapping
- SECURITY.md with responsible disclosure policy

#### Profiles, effort, and runtimes
- Claude-only profile system — model-profile resolution scoped to the Claude runtime, with effort frontmatter injection per agent
- Per-subagent effort tier — agents inherit effort from the active gsd profile, with frontmatter override
- xhigh effort tier (Opus 4.7, 1M context); skip effort frontmatter for haiku models (claude-haiku-4-5 doesn't accept the `effort` field)
- Runtime-agnostic content sweep — workflow templates and references purged of runtime-specific assumptions; `RUNTIMES` registry extended with `COMMAND_PREFIX`, `GSD_BLOCK_OPEN`/`GSD_BLOCK_CLOSE`, `MEMORY_DIR` keys

#### Installer
- `install.js --clean` flag — debugging / fresh-state reset wipes the GSD-managed tree before install
- Installer manifest migration — file manifest tracks all installed files; uninstall is precise instead of pattern-matching
- Manifest records post-substitution hashes — reinstalls no longer falsely report "local patches" on files that were merely templated at install time
- Snapshot version unification across banner, both runtime trees, and the manifest (`+hash` build metadata in VERSION on non-tag commits, auto-detected)

#### Workflows & CLI
- Quick-task support in `/gsd:create-pr` — open PRs from quick tasks with SUMMARY-derived title and description
- CLI output refactor and workflow bash simplification — fewer external-tool dependencies, consistent stderr/stdout discipline
- CLI argument validation (`--flag` parsing, typo suggestions) and snapshot commands
- Discuss-phase gap detection and plan-checker coverage improvements
- E2E smoke test suite, dynamic UID fix, `--current` filter tests
- Related-todo frontmatter tags with health checks, `--format newline` flag for `frontmatter get`, automated repair handlers
- `--field` extraction, SSH check, ambiguous fallback, UID fix in init; `create-pr` / `execute-phase` / `squash` refactored to use `$INIT` fields
- Submodule-aware git operations: workspace topology detection, per-submodule config, `EFFECTIVE_TARGET_BRANCH` routing for push/PR/branch handling
- Content optimization: 3-tier reference splits, shared ask-user-question and agent-shared-context references, philosophy condensation, behavioral benchmark tasks
- Install-time templating engine (`fillBetweenMarkers`) and AskUserQuestion first-turn injection
- `defaults.cjs` and `template-processor.cjs` with shared AST safety injection
- `init-get` CLI command with `gsd-tools` dispatch, replacing all `node -e` one-liners
- `init-valid` guard with self-recovery block across 26 workflows
- `frontmatter array-append <file> --field <k> --value <v>` CLI subcommand — dedupe-aware append into a YAML array field with scalar/missing/array coercion. Replaces the hand-rolled `frontmatter get` + inline `node -e` (JSON.parse + Array coerce + dedupe + re-emit) + `frontmatter set` pattern at three call sites in `add-todo.md` and `discuss-phase.md` (related-todo bidirectional link sync)

#### CI / release infrastructure
- Release pipeline hardening, CI guardrails, and supply chain security — SHA-pinned third-party actions, OIDC trusted publisher, build attestations, validate-release.sh gating tag-vs-package-version drift, prepare-release workflow that bumps version + stamps CHANGELOG + tags atomically
- Cross-platform test matrix on PRs (ubuntu/macos × node 22/24)
- Prettier formatting gate in CI — PRs blocked on unformatted code
- Per-file coverage gate — `scripts/coverage-gate.cjs` wired into `npm run test:coverage` enforces ≥95% line / ≥90% branch / ≥80% function coverage on every `bin/lib/*.cjs` (replacing the previous aggregate `--lines 70` floor). New `tests/c8-ignore-baseline.json` + `tests/c8-ignore-lint.test.cjs` cap c8-ignore directives at the current count so future code can't silently widen the exemption. Coverage uplifts shipped across all `bin/lib/*.cjs` modules to clear the new gate.
- Branch protection rulesets for main and develop (squash-only, PR required), tag protection for `v*` and `gsd/*`
- VERSIONING.md documenting release strategy

#### Documentation
- `CONTRIBUTING.md` at repo root — repo layout, test commands, hook-debug pointer, commit-message conventions, issue / security reporting
- `docs/bash-safety-hook.md` updates — new "Wrapper-bypass guard" section documenting `WRAPPER_COMMANDS` + `extractWrappedCommand` behavior (env / timeout / xargs / nohup / exec / nice / ionice / chrt / taskset / flock / stdbuf); new "Debugging a denial" section with `GSD_HOOK_DEBUG=1` + `GSD_DISABLE_BASH_HOOK=1` env-var pointers; stale-test-count line removed

### Changed
- `install.js` permission seeding now emits one log line per section (`Added N allow entries`, `Added N deny rules`, `Added N ask entries`) instead of a single combined `Seeded N permissions` line. The no-op path (`Permissions already up to date`) is unchanged. Any downstream tooling that screen-scrapes installer output will need to adapt.
- Template `settings-sandbox.json` now ships canonical `Edit(*)/Write(*)/Read(*)` forms; `install.js` down-converts to bare `Edit/Write/Read` on Linux at install time via `getReadEditWriteAllowRules`. Existing user installs keep their previous forms until a future `--clean` migration.
- Windows (`win32`) currently ships canonical glob RW forms (same as macOS) pending Claude Code Windows permission-engine validation. If Windows users hit Linux-style permission warnings, this will be revisited.
- Replace `jq` with `--pick` / `init-get` where cleaner — fewer external-tool dependencies in workflows
- First-turn-rule template wording — removed "output ONLY" ambiguity that was producing inconsistent agent behaviour
- Deduplicated AST safety rules into single template
- Wired `defaults.cjs` into config, core, init, verify, workspace modules
- Removed stale Windows references and guards
- `prepare-release.yml` workflow now creates a release branch + tag and opens an auto-merging PR into the target branch, instead of pushing the release commit and tag directly. Direct push was blocked by the `pull_request` rule on `develop`/`main` rulesets on user-owned forks (where the `github-actions` integration can't be added as a bypass actor).
- `release.yml` and `publish.yml` now support `workflow_dispatch` with a `tag` input alongside the existing tag-push trigger. `prepare-release.yml` chains them explicitly via `gh workflow run` after the tag push — tags pushed by `GITHUB_TOKEN` don't trigger downstream workflows (anti-loop protection), so an explicit dispatch is required to keep the end-to-end release pipeline automated.

### Removed
- `install.js --config-dir` / `-c` CLI flag — custom config directories are still supported via the `CLAUDE_CONFIG_DIR` / `COPILOT_CONFIG_DIR` environment variables. Users with `--config-dir` in install scripts must switch to the env-var form.
- First-turn-rule workaround removed — superseded by the install-time templating engine
- Stability research content removed — moved to a dedicated repository to keep gsd-ng tight

### Fixed
- Bypass-rule push detection in `/gsd:create-pr` — pushes that succeed only because the user's token bypasses branch protection now hard-stop with a clear error instead of silently creating the PR
- STATE.md YAML/body sync + harden gsd-executor todo-closure boundary
- Bullet-only phase detection in `cmdPhaseComplete` and `getMilestonePhaseFilter`
- `summary-extract` one-liner now sourced from the body bold line (single source of truth)
- Manifest unification eliminates ghost local-patches on reinstall
- CLI state bug fixes — initialization race conditions, stale state propagation
- Bug-batch fixes (~30 small fixes across two waves):
  - Release-pipeline workflows: SHA-pin `actions/github-script@v7` and other untrusted actions, switch actionlint installer to `$HOME/.local/bin`, quote `$GITHUB_PATH` in installers (SC2086), fix unpinned `setup-node`
  - Benchmark coverage gaps: add tests for `filterTasks`, `buildAtRefMatrix`, `compareResults`; remove dead `os` imports and `/tmp` hardcodes
  - Installer/templating: add input-type guard to `processTemplate` for null/undefined context, route `captureBaseline` progress to stderr, emit warning when `compareBaseline` cannot parse the baseline file
  - Workflow consistency: unified project-rules generation across Claude/Copilot via the project-rules-file placeholder; per-runtime command-prefix and memory-directory placeholders consistently substituted at install time
  - `add-todo` UX: add skill-hint message and scope did-you-mean suggestions to the same namespace
  - Submodule operation: prefer superproject `.planning/` when `gsd-tools` is invoked inside a submodule
- Debug session false positive and create-pr collision guard
- `PUSH_TARGET` and `PR_TEMPLATE_PATH` resolution in create-pr workflow
- Triple guard on `EFFECTIVE_TARGET_BRANCH` block
- Ambiguous path handling in `init execute-phase` and `milestone-op` output
- Orphaned closing tags and empty headings in checkpoint reference files

## [1.0.0-dev.3] - 2026-03-28

### Fixed
- GitHub Release workflow creates release as draft first, then publishes (workaround for immutable release tag constraint)

## [1.0.0-dev.2] - 2026-03-28

### Fixed
- Added `npm install -g npm@latest` to publish workflow for OIDC token support

## [1.0.0-dev.1] - 2026-03-28

### Added
- Security module — input validation and injection prevention across state and config operations
- Path consolidation — centralized planning path helper replacing 98 inline calls
- Multi-runtime support — Copilot CLI as second runtime alongside Claude Code, with content conversion engine and E2E tests
- Sandbox permission seeding — automatic safe permissions on install, cleanup on uninstall
- Divergence tracking — upstream fork comparison with configurable remote
- Benchmark harness — synthetic fixture project, 15 task definitions, structural and LLM-as-judge evaluators
- CLI improvements — subcommand suggestions, flag-style args, typo detection, guard routing
- Quick mode flags — `--verify` and `--all` for quick task workflow
- Hook integration test harness with schema validation
- Sandbox adaptation — graceful handling of blocked tool calls
- Tarball distribution — offline installer, build script, GitHub Actions release workflow
- 24 upstream cherry-picks through v1.22.4

### Changed
- Source directory and npm package renamed to gsd-ng
- Installer banner with NG block art
- Fork ownership updated

### Fixed
- Hook output format compliance across all hooks
- EPIPE crash and slug max length in CLI
- Command injection in `isGitIgnored`
- 5 pre-existing test failures in dispatcher and state
