# Changelog

All notable changes to gsd-ng will be documented in this file.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Changed

- Permission rules are now normalized before being seeded into a user's `settings.json`, and the installer no longer emits a form Claude Code cannot match. Claude Code's file permission checks consult only `Edit(<path>)` and `Read(<path>)` rules; a `Write(<path>)`, `NotebookEdit(<path>)` or `Glob(<path>)` rule parses fine but is never matched, and since CC 2.1.210 each one also draws a startup warning — for `allow`, `deny` and `ask` alike. Such a rule is dead weight twice over: it reads as policy, never fires, and costs the user a warning on every launch. A new `normalizePermissionRules` helper in `bin/lib/allowlist.cjs` rewrites each unmatched form to its effective spelling (`Edit(<path>)` for the file-editing tools, `Read(<path>)` for `Glob`) and de-dups the result, and `install.js` now runs *all three* sections through it rather than only `deny`. The de-dup is what neutralizes the `Edit(.env)` + `Write(.env)` *pair* shape an earlier plan proposed — the redundant half collapses into the real rule instead of surviving as decoration. A **bare** tool-name rule such as `Write` is deliberately left alone: with no path it matches the tool everywhere and draws no warning, so it is a working construct, and rewriting one would silently change a correct rule's meaning. `Read(<path>)` is likewise untouched, being a separate and genuinely enforced rule that should stay alongside `Edit(<path>)` for secrets.
- The concrete bug this fixes: macOS and Windows installs were seeding `Write(*)` into `permissions.allow`, so every such install running CC 2.1.210 or later drew a startup warning for a rule that never did anything. `getReadEditWriteAllowRules` now returns `['Edit(*)', 'Read(*)']` off Linux, and `Write(*)` is gone from `templates/settings-sandbox.json`. The grant is moved, not withdrawn — one `Edit(*)` rule already governs every built-in file-editing tool, the Write tool included. Linux is untouched and still receives bare `Edit`, `Write`, `Read`: bare forms are the existing workaround for the Linux glob handling in claude-code#16170 and #6881, and because a bare rule is effective and warning-free there was no reason to disturb the one platform with a documented history of permission-engine quirks. A companion `findUnmatchedPathRules` backs assertions that fail the build if an unmatched form is ever authored into the template, or reaches a seeded `settings.json` on any platform — catching the mistake at source and at the point it would ship, rather than relying on the installer to repair it.
- Known limitation: this governs only what GSD *seeds*. The allow/deny/ask sync is union-only, so a pre-existing unmatched rule in a user's own `settings.json` — a hand-written `Write(.env)` deny, say — is left exactly as it is: neither rewritten nor reported. Such a rule will keep drawing its startup warning, and a `Write(<path>)` deny in particular will keep reading as protection it does not provide. Repairing rules GSD did not write is deferred to the manifest migration mechanism, alongside the other in-place settings rewrites.

### Fixed

- A phase's plan counter no longer stalls when more than one plan finishes at a time. `state advance-plan` read `Current Plan`, added one, and wrote the result back — correct only if plans complete strictly one after another, which is not how `/gsd:execute-phase` runs them. Waves are parallel by design, so N executors finishing together each read the *same* stored value before any of them writes, and all N write that value plus one. A five-plan wave advanced the counter by one. The symptom is that STATE.md points at a plan that was finished long ago, and everything reading it inherits the error: `/gsd:progress` and `/gsd:resume-work` route to already-completed work, and the position shown on resume is quietly wrong rather than obviously broken — nothing errors, so the drift is only noticed when someone re-executes a plan that already has a SUMMARY. It went unseen because a phase whose waves each hold exactly one plan behaves correctly, and the workaround was a per-phase instruction telling executors to call `update-progress` instead — a footgun avoidable only by remembering to avoid it.

  The position is now derived rather than incremented. `advance-plan` counts `*-SUMMARY.md` files in the current phase directory the way `update-progress` already counts them, and sets `Current Plan` to that count plus one — the caller writes its own SUMMARY before invoking this, so the count includes the plan just completed. Every concurrent caller reads the same disk state and computes the same answer, which makes the outcome independent of who wins the write race; it also makes a repeat call a no-op, so an executor retried after a failure can no longer skip a plan. Last-plan detection moved to the same footing: the phase is complete once the SUMMARY count reaches `Total Plans in Phase`, so a wave that finishes the phase reports `Phase complete — ready for verification` from every executor in it rather than from whichever one happened to hold the final increment. The phase is located from `Current Phase`, falling back to the prefix of a compound `Current Plan` such as `64-02`.

  Both STATE.md dialects and every stored plan format are preserved, since the derived number is rendered into the shape already on disk: `02-08` becomes `02-09`, `08` becomes `09`, bare `8` becomes `9`, and the compound `Plan: 2 of 6 in current phase` line keeps its wording. Where the phase directory cannot be found — no `.planning/phases` entry for the current phase, or a project not laid out that way — the command falls back to the previous in-place increment rather than failing, and `--json` now reports `derived_from_disk` and `completed_plans` so a caller can tell which path ran.

  One related hazard is *not* addressed here and is worth naming: `advance-plan` still rewrites STATE.md as a whole-file read-modify-write, so a concurrent `add-decision` or `add-blocker` landing inside that window can still be lost. That is a narrower race than the counter — it needs two writes to interleave, rather than being guaranteed on every parallel wave — and closing it properly means serializing all STATE.md writers behind a lock, not patching one command.

- A requirement no longer reads Complete while most of its work is unstarted. Requirements were closed as a per-plan side effect: the last step of every `execute-plan` run took the finishing plan's own `requirements:` frontmatter and ran `requirements mark-complete` on it. That is fine only if each ID belongs to exactly one plan, which is not how phases are planned — several plans routinely share one requirement, each contributing a slice of it. Whichever of them finished *first* closed the ID for all of them. Under the wave-based parallel execution `/gsd:execute-phase` performs by design, "first" is not even a meaningful ordering; it is whichever subagent happened to win the race. The reported case was a 13-plan phase where all 13 declared the same consolidation requirement and the real work lived in plans 06 through 13 — the requirement was marked `[x]` and its traceability row flipped to Complete when plan 02 finished, a characterization-test plan that modified zero production files. The damage is that it is *silent and downstream*: the phase verifier and the REQUIREMENTS.md traceability table both then report a satisfied requirement, and a row marked Complete on first-plan-wins is indistinguishable from one that was genuinely verified, so the table stops being evidence of anything. It was caught at all only because that phase's executors had been explicitly told to check the flag and revert it by hand.

  Closure is now a phase-close action carried out once by `gsd-tools phase complete`, on the verifier's authority — which is how completion is judged everywhere else in GSD, `getPhaseCompletionStatus` included. The per-plan step is gone from both `execute-plan` and the `gsd-executor` agent; a plan's `requirements:` frontmatter goes back to being the declaration of intent it reads as. Two changes keep the later closure from becoming a *never*-closes bug in exchange. First, `phase complete` no longer takes its IDs solely from the ROADMAP phase section's `**Requirements:**` line, which is frequently absent — it closes the union of that line and the `requirements:` frontmatter of every PLAN.md in the phase, deduped, so the plan-declared IDs that the per-plan hook used to handle are still picked up. Second, an absent VERIFICATION.md does not block closure: verification is a qualifier, not a gate, so a project running with `workflow.verifier` off behaves exactly as before. What *does* withhold closure is a VERIFICATION.md that reports `gaps_found` or `halted` — the verifier has looked and says the goal is not met, so every ID stays Pending and the table keeps telling the truth until the gaps are closed and the verifier re-runs, at which point a repeat `phase complete` picks them up. `human_needed` is deliberately not treated as failing, since it means the automated checks all passed and `execute-phase` only reaches phase-close after the human approves. The operation is idempotent — IDs already Complete match neither the checkbox nor the traceability pattern — so re-running a phase is a no-op, and `phase complete --json` now reports `requirements_closed`, `verification_status`, and `requirements_blocked_by` so the caller can see which of these applied.

  A side effect worth naming: closing requirements once per phase also removes an unsynchronized read-modify-write on REQUIREMENTS.md. Concurrent executors in the same wave each rewrote the whole file, so one agent's edit could silently drop another's.

- The installer no longer reports GSD's own agent-file rewrites as local user modifications. `.claude/gsd-file-manifest.json` recorded a plain sha256 for each deployed `agents/*.md`, but those files are rewritten by GSD itself whenever a supported config change lands: `/gsd:set-profile` and `gsd config set effort_overrides.*` both call the effort sync, which re-serialises the *entire* frontmatter block — the managed `effort:` value changes, YAML comments drop out, and values pick up canonical quoting. Any such change therefore guaranteed a hash divergence, and the next install stashed all 15 agent files into `.claude/gsd-local-patches/` and advised running `/gsd:reapply-patches` for edits the user never made. The noise was not merely cosmetic: an update that stashed 16 files, 15 of them false positives, left the one genuine local patch indistinguishable from the rest — and a warning that cries wolf 15 times out of 16 trains you to skip the time it matters. Agent entries now carry a second, normalised hash taken over the canonicalised frontmatter with the GSD-managed keys removed, plus the untouched body, and the installer consults it before calling a raw mismatch a user edit. A profile or effort-override switch is thus invisible to patch detection, while a real edit to an agent's prompt body is still detected and backed up — including when it sits in the *same* file as a config-driven frontmatter rewrite, since the body is what the normalised hash covers. The new `files_normalized` map is additive and optional, so no manifest schema bump was needed: a manifest written by an older installer carries no such map and simply keeps the previous raw-hash verdict.

  One edit is now missed, and it is worth stating plainly: because the canonicalising pass drops YAML comments, a change made *inside* a commented-out frontmatter line is normalised away and is neither reported nor backed up. Agent files ship a commented `# hooks:` block that invites that customisation, so this is reachable rather than theoretical — although uncommenting the block, which is the more likely edit, alters real keys and is still detected. A hand-set `effort:` is likewise no longer flagged, which is intended: GSD overwrites that value on the next config change or install regardless.

- The "▶ Next Up" continuation blocks no longer print raw `<sub>` tags into the terminal. The subtext line under every continuation prompt — usually `` `/clear` first → fresh context window `` — was wrapped in `<sub>…</sub>` to de-emphasize it, which works on GitHub but not where these blocks actually land: Claude Code renders GitHub-flavored markdown in a terminal, and GFM does not support inline HTML. The tag was never interpreted, so users saw the literal characters `<sub>` and `</sub>` bracketing the hint on essentially every command that ends by suggesting a next step. All 43 occurrences across 22 files are now `*italics*`, which matches the repo's existing italic convention and renders correctly in both the terminal *and* on GitHub; the swap is a pure delimiter change, preserving the inline-code backticks, the `→` arrow, and the two-space indentation at the three nested sites. One site in `agents/gsd-planner.md` that had drifted to a hyphen separator was normalized to the arrow at the same time. Guarding the fix, a new `tests/terminal-html-lint.test.cjs` bans the nine rendering-only inline tags (`sub`, `sup`, `small`, `kbd`, `mark`, `br`, `u`, `font`, `center`) across workflows, agents, and the two terminal-facing references, and `gsd-ng/references/continuation-format.md` gained a format rule stating that subtext uses italics — without it the pattern reintroduces itself the next time someone copies the continuation format. The lint deliberately does **not** ban `<details>`/`<summary>`: workflow files legitimately emit those as content written *into* ROADMAP.md, which is read on GitHub where HTML does render, and `<summary>` additionally collides with a GSD XML structural tag — so a blanket "no HTML in workflows" rule would have broken real usage. It likewise skips inline code spans and fenced blocks declaring a source-code language, so prose documenting the banned tags and JSX examples are not flagged.

- `todo add` no longer silently discards a repeated flag. Every flag in the dispatcher was read with `args.indexOf(flag)`, which finds the first occurrence and nothing else, so `todo add --title T --files "x.js" --files "y.js"` wrote a todo whose `files:` list contained only `x.js` — while the comma-separated `--files "x.js,y.js"` correctly wrote both. Repeating a list flag is a standard CLI idiom rather than a misuse, which makes this easy to reach, and the failure is the worst kind: no warning, no error, and a todo that reads as complete while quietly missing half its metadata. It is caught only by re-reading the file afterwards. That is also precisely the failure mode `todo add` was written to eliminate — the verb errors on a filename collision *naming the existing file* rather than overwriting it, on the reasoning that the hand-rolled `Write` path it replaced clobbered data without saying so; dropping a repeated flag lost data the same way, one field lower down.

  Repeated flags are now handled according to what the flag means. `--files` and `--related` are lists, so repeats **accumulate**: a new `listFlag` helper joins every occurrence into one comma-separated string before it reaches the existing `splitList`, making `--files a --files b`, `--files a,b`, and the mixed `--files a,b --files c` all produce identical frontmatter. Accumulating was preferred over erroring because it is what a user typing the flag twice already means, and it costs nothing — both idioms now work rather than one of them being legislated away. The single-value flags (`--title`, `--area`, `--phase`, `--body`, `--body-file`, `--interval`) take the other branch, since appending a second title is meaningless: a repeat is now an **error naming both conflicting values**, which is the same stance as the collision check. The boolean `--recurring` is untouched, being idempotent under repetition.

  This is deliberately scoped to `todo add` rather than applied dispatcher-wide. The `args.indexOf` idiom backs roughly seventy flags across every verb, and rewriting all of them in one pass would change argument handling for commands whose first-wins behavior may be load-bearing, with no test to say which. The two helpers (`listFlag`, `scalarFlag`, over a shared `collectFlagValues`) are written generically and documented for other verbs to adopt as they are touched, so the fix is reusable without the blast radius.

- `todo complete` now accepts a todo id with or without its `.md` extension. It joined the argument straight onto the pending directory and checked for existence, so `todo complete 2026-07-18-some-slug` failed with `Todo not found: 2026-07-18-some-slug` for a todo that was sitting right there — the message named the id it was given and stopped, offering nothing to suggest that a three-character suffix was the entire problem. Since the bare slug is what appears in prose, in filenames-minus-extension, and in anything a user types from memory, the error was routinely read as "the todo is gone" rather than "add `.md`". Resolution now tries the id as given and then with `.md` appended, and when neither exists the error names every candidate it looked for and the directory it searched, so a genuine miss is distinguishable from a formatting one. The resolved on-disk basename — not the abbreviated id the caller typed — is what flows downstream, so the file written into `completed/`, the `--json` `file` field, and the recurring path's `recurring-reset:` line all report the real filename. The sibling subcommands do not share the asymmetry and needed no change: `todo list-by-phase` and `todo scan-phase-linked` take a phase number, and `todo complete` is the only verb that accepts a todo filename from the user.

- Uninstalling GSD no longer leaves its own files behind in `hooks/`. `--uninstall` removed Claude hooks by matching against six filenames written out by hand in `install.js`, and `hooks/bash-safety-hook.cjs` was not among them — so the PreToolUse bash-safety hook GSD installs on every Claude install survived both `--uninstall` and the `--clean` wipe. A user who removed GSD was left with an orphaned executable hook that nothing would ever update, clean up, or account for, still wired into `settings.json` and still running on every Bash tool call. The omission was almost certainly because the file is the one GSD hook without a `gsd-` prefix. The same audit turned up a second survivor on *both* runtimes: `gsd-file-manifest.json` was deleted by the `--clean` wipe but never by `uninstall`, so every uninstall left GSD's own bookkeeping file in the config directory. Both are now removed, and `uninstall` additionally strips the `bash-safety-hook.cjs` entry from `settings.json` — without that, fixing the deletion would have traded an orphaned hook for a dangling `PreToolUse` command pointing at a script that no longer exists.

  The hardcoded list had the inverse defect too, and it is the one worth fixing structurally: a hook renamed or retired in an earlier release matches neither the deletion list nor any currently shipped filename, so it is stranded by the wipe *and* by the install and persists forever. The list was evidence of this in itself — `gsd-check-update.sh` sat in it only to clean up an artifact of a release predating the `.js` rename, a reactive patch applied after the fact. The removal set is now derived from what GSD actually installed rather than from names typed into the source: the manifest gained an additive `installed_hooks` record of the hook files each install wrote, and the wipe removes exactly those. A retirement is therefore self-cleaning from here on — the release that stops shipping a hook still removes it, because the install that put it there recorded it — with no list to remember to update. Two fallbacks back that up: the filenames the running package ships, for installs whose manifest is absent, unreadable, or predates the record, and a small `RETIRED_GSD_HOOKS` list repurposed from the old hardcoded one, which now carries only the names retired before the manifest began recording hooks.

  `installed_hooks` is deliberately kept out of the manifest's `files` map rather than folded into it. `files` drives local-patch detection, so listing hooks there would have quietly enrolled them in modification backup — a real behavior change to what lands in `gsd-local-patches/`, arriving as a side effect of a deletion fix. Being additive, the new key needs no schema bump and is ignored by older installers. Removal remains exact-filename throughout, never a prefix or glob: the obvious-looking alternative of matching `hooks/gsd-*` the way `agents/gsd-*.md` is matched would not have covered `bash-safety-hook.cjs` at all, and would have started deleting a user's own hook if they happened to name it with a `gsd-` prefix. Renaming the file to `gsd-bash-safety-hook.cjs` was rejected on the same grounds it was tempting — it makes the glob work, but it *is* the retired-filename problem, requiring the old name to be carried for at least one release, which is exactly what the manifest record now handles generically. New tests assert the invariant nothing previously checked: after `uninstall`, no file GSD installed remains on either runtime, with `settings.json` — the runtime's own config file, which GSD merges into and strips rather than owns — the sole documented survivor.

## [1.0.0-dev.18] - 2026-07-16

### Added

- A `todo add` verb (`gsd-tools todo add --title "…" --area "…"`), so filing a todo no longer means hand-authoring markdown. Every caller previously re-implemented the same slug + ISO timestamp + YAML frontmatter recipe, and the shape drifted as a result. The verb owns the mechanics — it derives the canonical date-prefixed `.planning/todos/pending/<date>-<slug>.md` filename, emits `created`/`title`/`area` plus optional `phase`/`files`/`related`/`recurring`/`interval`, and never authors `last_completed` (that stays `todo complete`'s job on first completion). It prints the created path by default and structured fields under the existing global `--json`. `--interval` is validated against the same `parseDuration` helper `recurring-due` already uses and is rejected without `--recurring`, since an interval alone is inert; `--area` stays free-text. Notably, a filename collision is now an **error naming the existing file rather than a silent overwrite** — a real gap, because the hand-rolled `Write` path it replaces clobbered the existing todo without warning.

### Changed

- `/gsd:add-todo` and `/gsd:note` now delegate the todo file write to `todo add` instead of hand-rolling filenames and frontmatter. The reasoning half stays in the workflows — dedup scanning, area inference, and the reverse `related:` backlink on the *existing* todo are unchanged, and the CLI does no cross-file mutation. This normalizes `/gsd:note promote`, which had drifted furthest: it invented sequential `{NNN}-{slug}` filenames and a `status`/`priority`/`source`/`theme` schema that nothing read. Promoted notes now land on the canonical date-prefixed `<date>-<slug>` filename with `created`/`title`/`area`, with the `theme` folded into `--area` and the "promoted from note" provenance carried in the body prose it already wrote. Existing `{NNN}-*.md` todos on disk are untouched and continue to list normally.
- The unknown-`todo`-subcommand error no longer redirects to `/gsd:add-todo` as the only way to add a todo. That hint fires on a CLI typo, where the correct repair is now `todo add` — which the `Available:` list advertises on its own.

### Fixed

- `resolve-effort` no longer strips the `xhigh` and `max` effort tiers from agents resolved to `fable` or `sonnet`. The model-tier compatibility gate accepted only `opus`, so an agent pointed at either model silently fell back to the session default effort — with a warning only when the effort came from an explicit `effort_overrides` entry. Both now support the same high reasoning tiers as Opus: `fable` always did, and `sonnet` gained `xhigh` when the alias moved to Sonnet 5 (the first Sonnet-tier model with it, and the recommended setting there for the hardest coding and agentic work). The gate matches on the bare aliases the harness resolves, so a version-pinned string such as `sonnet-4-6` is still correctly rejected. The warning text now names all three accepted models.

  In practice this only bit an explicit `effort_overrides` entry on a `sonnet`-resolved agent — for example `effort_overrides.gsd-executor: xhigh` under the `balanced` profile — since no profile assigns `xhigh`/`max` to an agent that resolves below the Opus tier.

## [1.0.0-dev.17] - 2026-06-07

### Added

- The `{type}` placeholder is now resolved in `phase_branch_template` and `milestone_branch_template`, not just `review_branch_template`. A user can set `phase_branch_template: "{type}/{slug}"` to match the review template and get `feature/<slug>` instead of a literal `{type}/<slug>` work branch. A new shared module `bin/lib/type-alias.cjs` holds the single commit-type → branch-prefix map (`feat→feature`, `fix→bugfix`, `chore→chore`, `refactor→refactor`), consumed by both `init.cjs` and `gsd-tools.cjs resolve-type-alias` so the two can no longer drift. Because the commit type is unknown when the work branch is created, `{type}` resolves to the alias of `feat` (`feature` by default) and honors a configured `git.type_aliases.feat` override. The default templates (`gsd/phase-{phase}-{slug}`, `gsd/{milestone}-{slug}`) contain no `{type}` and are unaffected.

### Changed

- `/gsd:create-pr` now opens the PR directly from the work branch when the resolved review branch name equals the current work branch (e.g. `phase_branch_template` and `review_branch_template` both resolve to `feature/<slug>`), supporting the "develop on the feature branch, PR from it" workflow. This replaces the previous collision guard, which errored in interactive mode or auto-suffixed `-2`/`-3` under `--auto`. The direct-PR path mirrors the `none`-strategy flow — no separate review branch, no `git reset --hard`, no squash, and no branch switch-back — so it is non-destructive. When the review branch differs from the work branch, the create/reset/squash/force-push flow is unchanged.

### Fixed

- Hardened shell robustness in the `/gsd:create-pr` workflow. The target-branch existence check no longer uses the branch name as an unanchored `grep` regex (which substring-matched sibling refs — e.g. `main` matching `maintenance` — and could misbehave on names containing regex metacharacters); it now tests whether `git ls-remote --heads` returns anything. The two SUMMARY-collection loops iterate a glob with an `[ -e ]` guard instead of parsing `ls` output, avoiding word-splitting and the literal-pattern-on-no-match hazard.

## [1.0.0-dev.16] - 2026-06-05

### Fixed

- The update-check cache is now local-first: a project with a local GSD install (`.claude/gsd-ng/VERSION` present) reads and writes its own cache under `<project>/.claude/cache/gsd-update-check.json` instead of the global `~/.claude/cache/`. When both a local and a global install exist, the local cache always wins so two projects on different versions can never poison each other's banner. A global-only install continues to use the global cache path. `CLAUDE_CONFIG_DIR` with `gsd-ng/VERSION` takes top precedence as before. Both the writer (`gsd-check-update.js`) and the reader (`gsd-statusline.js`) derive the cache path from a single shared helper (`bin/lib/cache-path.cjs`) so they can never drift.
- The statusline now suppresses the `⬆ /gsd:update` banner when `cache.installed` does not match the live local `VERSION` file. This guards the within-session gap after running `/gsd:update` before the next TTL refresh writes a new cache — the stale "update available" entry no longer shows the banner for an already-updated install.
- **Migration:** A stale global cache (`~/.claude/cache/gsd-update-check.json`) left by older versions is automatically ignored for local installs because the reader now resolves the local cache path and never reads the global one.

## [1.0.0-dev.15] - 2026-05-31

### Fixed
- Submodule-aware PR creation now detects the platform and CLI correctly. `detect-platform` accepts a per-submodule `platform` override (previously a dead config key, because config was resolved relative to the submodule directory, which has no `.planning/`); the Forgejo `fj` CLI is now probed with its `version` subcommand instead of `--version` (which `fj` rejects, producing a false "not installed"); and `/gsd:create-pr` creates draft PRs on Forgejo (`WIP:` title prefix) and Gitea (`tea pr create --type draft`). The `git.submodules.<name>.*` per-submodule config schema is documented in `references/planning-config.md`.

### Removed
- Dropped the dead `git.submodule.workspace_branch` deprecation handling. The singular `git.submodule.*` form never worked and the key controlled no behavior, so `config-set`/`config-get` no longer special-case it or print a deprecation warning — it is now treated as an ordinary unknown key.

## [1.0.0-dev.14] - 2026-05-30

### Changed
- UI functionality is now strictly additive — it never blocks, prompts, or interrupts `/gsd:plan-phase`, `/gsd:execute-phase`, or `/gsd:verify-work`. The shadcn third-party registry-safety machinery has been removed in every site it touched: the `gsd-ui-checker` agent (dropping the roster from 16 to 15 agents), the `workflow.ui_safety_gate` config key (now rejected by `gsd config set`), the plan-phase keyword-grep gate, and the `npx shadcn view`/`diff` registry-vetting steps in the UI researcher/auditor and the UI design-spec template. UI design and audit — `gsd-ui-researcher`, `gsd-ui-auditor`, and the 6-pillar visual audit — are preserved, so gsd-ng can still design and develop UI systems for web/React projects; vetting third-party registries is now recommend-but-don't-block coaching guidance rather than an enforced gate.

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
