#!/usr/bin/env node

/**
 * GSD Tools — CLI utility for GSD workflow operations
 *
 * Replaces repetitive inline bash patterns across ~50 GSD command/workflow/agent files.
 * Centralizes: config parsing, model resolution, phase lookup, git commits, summary verification.
 *
 * Usage: node gsd-tools.cjs <command> [args] [--json]
 *
 * Atomic Commands:
 *   state load                         Load project config + state
 *   state json                         Output STATE.md frontmatter as JSON
 *   state update <field> <value>       Update a STATE.md field
 *   state get [section]                Get STATE.md content or section
 *   state patch --field val ...        Batch update STATE.md fields
 *   resolve-model <agent-type>         Get model for agent based on profile
 *   resolve-effort <agent-type>        Get effort for agent based on profile
 *   sync-agents [--agents-dir <path>]  Re-sync effort: frontmatter into agent files
 *   find-phase <phase>                 Find phase directory by number
 *   commit <message> [--files f1 f2]   Commit planning docs
 *   verify-summary <path>              Verify a SUMMARY.md file
 *   generate-slug <text>               Convert text to URL-safe slug
 *   current-timestamp [format]         Get timestamp (full|date|filename)
 *   list-todos [area]                  Count and enumerate pending todos
 *   recurring-due                      List recurring todos past their interval
 *   verify-path-exists <path>          Check file/directory existence
 *   config-ensure-section              Initialize .planning/config.json
 *   history-digest                     Aggregate all SUMMARY.md data
 *   summary-extract <path> [--fields]  Extract structured data from SUMMARY.md
 *   state-snapshot                     Structured parse of STATE.md
 *   phase-plan-index <phase>           Index plans with waves and status
 *   detect-platform [remote]            Detect git hosting platform from remote URL
 *                                      Returns: platform, source, cli, cli_installed
 *   detect-workspace                   Detect workspace topology (submodule/monorepo/standalone)
 *                                      Returns: type, signal
 *   discover-test-command              Discover test command(s) for this project
 *                                      Returns: [{dir, command}] array (empty if none found)
 *   version-bump                       Bump project version per configured scheme
 *     [--level major|minor|patch]       Override auto-derived bump level
 *     [--scheme semver|calver|date]     Override configured scheme
 *     [--snapshot]                      Append +{hash} to VERSION file only
 *   generate-changelog <version>       Generate CHANGELOG.md entries from SUMMARY.md files
 *     [--date <date>]                  Override date (iso8601, default: today)
 *   generate-allowlist                 Generate .claude/settings.json permissions
 *                                      from static template + config-derived entries
 *   divergence                          Show upstream/branch drift and manage triage
 *     [--refresh]                       Fetch from upstream/remote first
 *     [--init]                          Create/update DIVERGENCE.md inventory
 *     [--triage <hash>]                 Update a commit's triage status
 *     [--branch <name>]                 Track branch instead of upstream
 *     [--base <ref>]                    Base ref for branch mode (default: git.target_branch or main)
 *     [--remote <name>]                 Remote name for upstream mode (default: upstream)
 *     [--remote-branch <branch>]        Remote branch for upstream mode (default: main)
 *   pingpong-check [--window N]         Detect agent oscillation in recent commits
 *   update [--dry-run]                Check for and install GSD updates
 *     [--local]                        Force local install path
 *     [--global]                       Force global install path
 *   cleanup [--dry-run]               Archive phase dirs from completed milestones
 *   breakout-check --plan {id}         Detect files modified outside plan scope
 *     --declared-files f1,f2,f3
 *   websearch <query>                  Search web via Brave API (if configured)
 *     [--limit N] [--freshness day|week|month]
 *
 * Phase Operations:
 *   phase next-decimal <phase>         Calculate next decimal phase number
 *   phase add <description>            Append new phase to roadmap + create dir
 *   phase insert <after> <description> Insert decimal phase after existing
 *   phase remove <phase> [--force]     Remove phase, renumber all subsequent
 *   phase complete <phase>             Mark phase done, update state + roadmap
 *
 * Roadmap Operations:
 *   roadmap get-phase <phase>          Extract phase section from ROADMAP.md
 *   roadmap analyze                    Full roadmap parse with disk status
 *   roadmap update-plan-progress <N>   Update progress table row from disk (PLAN vs SUMMARY counts)
 *
 * Requirements Operations:
 *   requirements mark-complete <ids>   Mark requirement IDs as complete in REQUIREMENTS.md
 *                                      Accepts: comma-sep, space-sep, or bracket-wrapped IDs
 *
 * Milestone Operations:
 *   milestone complete <version>       Archive milestone, create MILESTONES.md
 *     [--name <name>]
 *     [--archive-phases]               Move phase dirs to milestones/vX.Y-phases/
 *
 * Validation:
 *   validate consistency               Check phase numbering, disk/roadmap sync
 *   validate health [--repair]         Check .planning/ integrity, optionally repair
 *
 * Progress:
 *   progress [json|table|bar]          Render progress in various formats
 *
 * Todos:
 *   todo complete <filename>           Move todo from pending to completed
 *
 * Scaffolding:
 *   scaffold context --phase <N>       Create CONTEXT.md template
 *   scaffold uat --phase <N>           Create UAT.md template
 *   scaffold verification --phase <N>  Create VERIFICATION.md template
 *   scaffold phase-dir --phase <N>     Create phase directory
 *     --name <name>
 *
 * Frontmatter CRUD:
 *   frontmatter get <file> [--field k] Extract frontmatter as JSON
 *   frontmatter set <file> --field k   Update single frontmatter field
 *     --value jsonVal
 *   frontmatter merge <file>           Merge JSON into frontmatter
 *     --data '{json}'
 *   frontmatter validate <file>        Validate required fields
 *     --schema plan|summary|verification
 *   frontmatter array-append <file>    Dedupe-append value to a YAML array field
 *     --field k --value v              (coerces missing/scalar/array; idempotent)
 *
 * Verification Suite:
 *   verify plan-structure <file>       Check PLAN.md structure + tasks
 *   verify phase-completeness <phase>  Check all plans have summaries
 *   verify references <file>           Check @-refs + paths resolve
 *   verify commits <h1> [h2] ...      Batch verify commit hashes
 *   verify artifacts <plan-file>       Check must_haves.artifacts
 *   verify key-links <plan-file>       Check must_haves.key_links
 *
 * Template Fill:
 *   template fill summary --phase N    Create pre-filled SUMMARY.md
 *     [--plan M] [--name "..."]
 *     [--fields '{json}']
 *   template fill plan --phase N       Create pre-filled PLAN.md
 *     [--plan M] [--type execute|tdd]
 *     [--wave N] [--fields '{json}']
 *   template fill verification         Create pre-filled VERIFICATION.md
 *     --phase N [--fields '{json}']
 *
 * State Progression:
 *   state advance-plan                 Increment plan counter
 *   state record-metric --phase N      Record execution metrics
 *     --plan M --duration Xmin
 *     [--tasks N] [--files N]
 *   state update-progress              Recalculate progress bar
 *   state add-decision --summary "..."  Add decision to STATE.md
 *     [--phase N] [--rationale "..."]
 *     [--summary-file path] [--rationale-file path]
 *   state add-blocker --text "..."     Add blocker
 *     [--text-file path]
 *   state resolve-blocker --text "..." Remove blocker
 *   state record-session               Update session continuity
 *     --stopped-at "..."
 *     [--resume-file path]
 *   state begin-phase --phase N --name S --plans C  Update STATE.md for new phase start
 *   state adjust-quick-table          Add Status column to Quick Tasks table if missing
 *
 * Compound Commands (workflow-specific initialization):
 *   init execute-phase <phase>         All context for execute-phase workflow
 *   init plan-phase <phase>            All context for plan-phase workflow
 *   init new-project                   All context for new-project workflow
 *   init new-milestone                 All context for new-milestone workflow
 *   init quick [--verify] <description>  All context for quick workflow
 *   init resume                        All context for resume-project workflow
 *   init verify-work <phase>           All context for verify-work workflow
 *   init phase-op <phase>              Generic phase operation context
 *   init todos [area]                  All context for todo workflows
 *   init milestone-op                  All context for milestone operations
 *   init map-codebase                  All context for map-codebase workflow
 *   init progress                      All context for progress workflow
 *   init-get <json> <field>            Extract field from init JSON as plain string
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const {
  error,
  output: coreOutput,
  setFileOutput,
  setJsonMode,
} = require('./lib/core.cjs');
const state = require('./lib/state.cjs');
const phase = require('./lib/phase.cjs');
const roadmap = require('./lib/roadmap.cjs');
const verify = require('./lib/verify.cjs');
const config = require('./lib/config.cjs');
const template = require('./lib/template.cjs');
const milestone = require('./lib/milestone.cjs');
const commands = require('./lib/commands.cjs');
const init = require('./lib/init.cjs');
const frontmatter = require('./lib/frontmatter.cjs');
const workspace = require('./lib/workspace.cjs');
const guard = require('./lib/guard.cjs');
const testBaseline = require('./lib/test-baseline.cjs');
const effortSync = require('./lib/effort-sync.cjs');
const { resolveTypeAlias, readTypeAliases } = require('./lib/type-alias.cjs');

// ─── Command Registry (for typo detection) ────────────────────────────────────

const ALL_COMMANDS = [
  'state',
  'resolve-model',
  'resolve-effort',
  'sync-agents',
  'find-phase',
  'commit',
  'verify-summary',
  'template',
  'frontmatter',
  'verify',
  'generate-slug',
  'current-timestamp',
  'list-todos',
  'recurring-due',
  'staleness-check',
  'verify-path-exists',
  'config-ensure-section',
  'config-set',
  'config-set-model-profile',
  'config-get',
  'init-get',
  'history-digest',
  'phases',
  'roadmap',
  'requirements',
  'phase',
  'milestone',
  'validate',
  'progress',
  'stats',
  'todo',
  'update',
  'scaffold',
  'init',
  'phase-plan-index',
  'state-snapshot',
  'summary-extract',
  'detect-platform',
  'detect-workspace',
  'discover-test-command',
  'websearch',
  'squash',
  'version-bump',
  'generate-changelog',
  'generate-allowlist',
  'resolve-type-alias',
  'issue-import',
  'issue-sync',
  'issue-list-refs',
  'divergence',
  'pingpong-check',
  'breakout-check',
  'cleanup',
  'help',
  'guard',
  'test',
];

// ─── Subcommand Registry (for fuzzy subcommand matching) ─────────────────────

const SUBCOMMANDS = {
  state: [
    'load',
    'json',
    'update',
    'get',
    'patch',
    'advance-plan',
    'record-metric',
    'update-progress',
    'add-decision',
    'add-blocker',
    'resolve-blocker',
    'record-session',
    'begin-phase',
    'adjust-quick-table',
    'rebuild-frontmatter',
  ],
  template: ['select', 'fill'],
  frontmatter: ['get', 'set', 'merge', 'validate', 'array-append'],
  verify: [
    'plan-structure',
    'phase-completeness',
    'references',
    'commits',
    'artifacts',
    'key-links',
  ],
  phases: ['list'],
  roadmap: ['get-phase', 'analyze', 'update-plan-progress', 'add-phase'],
  requirements: ['mark-complete'],
  phase: ['next-decimal', 'add', 'insert', 'remove', 'complete'],
  milestone: ['complete'],
  validate: ['consistency', 'health'],
  todo: ['complete', 'list-by-phase', 'scan-phase-linked'],
  init: [
    'execute-phase',
    'plan-phase',
    'new-project',
    'new-milestone',
    'quick',
    'resume',
    'verify-work',
    'phase-op',
    'todos',
    'milestone-op',
    'map-codebase',
    'progress',
  ],
  guard: ['sync-chain', 'init-valid'],
  test: ['capture-baseline', 'compare-baseline'],
};

// ─── Arg Validation Layer ─────────────────────────────────────────────────────

/**
 * ARG_SCHEMAS[command][subcommand] = { positional: { min, max }, flags: string[] }
 *
 * Defines the expected argument shape for every compound command subcommand.
 * Used by validateArgs() to catch creative misuse patterns before
 * they reach the handler.
 *
 * positional.min: minimum positional (non-flag) args required
 * positional.max: maximum positional args allowed (null = unlimited)
 * flags: whitelist of known --flags for this subcommand
 */
const ARG_SCHEMAS = {
  state: {
    load: { positional: { min: 0, max: 0 }, flags: [] },
    json: { positional: { min: 0, max: 0 }, flags: [] },
    update: { positional: { min: 2, max: 2 }, flags: [] },
    get: { positional: { min: 0, max: 1 }, flags: [] },
    // 'patch' omitted: takes dynamic --key value pairs, any flag is valid
    'advance-plan': { positional: { min: 0, max: 0 }, flags: [] },
    'record-metric': {
      positional: { min: 0, max: 0 },
      flags: ['--phase', '--plan', '--duration', '--tasks', '--files'],
    },
    'update-progress': { positional: { min: 0, max: 0 }, flags: [] },
    'add-decision': {
      positional: { min: 0, max: 0 },
      flags: [
        '--phase',
        '--summary',
        '--summary-file',
        '--rationale',
        '--rationale-file',
      ],
    },
    'add-blocker': {
      positional: { min: 0, max: 0 },
      flags: ['--text', '--text-file'],
    },
    'resolve-blocker': { positional: { min: 0, max: 0 }, flags: ['--text'] },
    'record-session': {
      positional: { min: 0, max: 0 },
      flags: ['--stopped-at', '--resume-file'],
    },
    'begin-phase': {
      positional: { min: 0, max: 0 },
      flags: ['--phase', '--name', '--plans'],
    },
    'adjust-quick-table': { positional: { min: 0, max: 0 }, flags: [] },
  },
  template: {
    select: { positional: { min: 0, max: 1 }, flags: [] },
    fill: {
      positional: { min: 1, max: 1 },
      flags: ['--phase', '--plan', '--name', '--type', '--wave', '--fields'],
    },
  },
  frontmatter: {
    get: {
      positional: { min: 1, max: 1 },
      flags: ['--field', '--format', '--default'],
    },
    set: { positional: { min: 1, max: 1 }, flags: ['--field', '--value'] },
    merge: { positional: { min: 1, max: 1 }, flags: ['--data'] },
    validate: { positional: { min: 1, max: 1 }, flags: ['--schema'] },
    'array-append': {
      positional: { min: 1, max: 1 },
      flags: ['--field', '--value'],
    },
  },
  verify: {
    'plan-structure': { positional: { min: 1, max: 1 }, flags: [] },
    'phase-completeness': { positional: { min: 0, max: 1 }, flags: [] },
    references: { positional: { min: 0, max: 1 }, flags: [] },
    commits: { positional: { min: 0, max: null }, flags: [] },
    artifacts: { positional: { min: 1, max: 1 }, flags: [] },
    'key-links': { positional: { min: 1, max: 1 }, flags: [] },
  },
  phases: {
    list: {
      positional: { min: 0, max: 0 },
      flags: ['--type', '--phase', '--include-archived'],
    },
  },
  roadmap: {
    'get-phase': { positional: { min: 1, max: 1 }, flags: ['--default'] },
    analyze: { positional: { min: 0, max: 0 }, flags: ['--current'] },
    'update-plan-progress': { positional: { min: 1, max: 1 }, flags: [] },
    'add-phase': { positional: { min: 0, max: null }, flags: [] },
  },
  requirements: {
    'mark-complete': { positional: { min: 1, max: null }, flags: [] },
  },
  phase: {
    'next-decimal': { positional: { min: 1, max: 1 }, flags: [] },
    add: { positional: { min: 0, max: null }, flags: [] },
    insert: { positional: { min: 1, max: null }, flags: [] },
    remove: { positional: { min: 1, max: 1 }, flags: ['--force'] },
    complete: { positional: { min: 0, max: 1 }, flags: [] },
  },
  milestone: {
    // max: null because --name can be followed by multi-word values (e.g. --name MVP Foundation)
    complete: {
      positional: { min: 0, max: null },
      flags: ['--name', '--archive-phases'],
    },
  },
  validate: {
    consistency: { positional: { min: 0, max: 0 }, flags: [] },
    health: { positional: { min: 0, max: 0 }, flags: ['--repair'] },
  },
  todo: {
    complete: { positional: { min: 1, max: 1 }, flags: [] },
    'list-by-phase': { positional: { min: 1, max: 1 }, flags: [] },
    'scan-phase-linked': { positional: { min: 1, max: 1 }, flags: [] },
  },
  init: {
    'execute-phase': { positional: { min: 1, max: 1 }, flags: [] },
    'plan-phase': { positional: { min: 1, max: 1 }, flags: [] },
    'new-project': { positional: { min: 0, max: 0 }, flags: [] },
    'new-milestone': { positional: { min: 0, max: 0 }, flags: [] },
    quick: { positional: { min: 0, max: null }, flags: ['--verify'] },
    resume: { positional: { min: 0, max: 0 }, flags: [] },
    'verify-work': { positional: { min: 1, max: 1 }, flags: [] },
    'phase-op': { positional: { min: 1, max: 1 }, flags: [] },
    todos: { positional: { min: 0, max: 1 }, flags: [] },
    'milestone-op': { positional: { min: 0, max: 0 }, flags: [] },
    'map-codebase': { positional: { min: 0, max: 0 }, flags: [] },
    progress: { positional: { min: 0, max: 0 }, flags: [] },
  },
  guard: {
    // sync-chain omitted: takes a raw freeform arguments string, not discrete flags
    'init-valid': { positional: { min: 1, max: 1 }, flags: [] },
  },
  test: {
    'capture-baseline': { positional: { min: 2, max: 2 }, flags: [] },
    'compare-baseline': { positional: { min: 2, max: 2 }, flags: [] },
  },
  // ─── Top-level commands with flags (_self schema convention) ─────────────
  // Only command-specific flags; global flags (--json, --file, --pick, --cwd)
  // are already stripped before dispatch.
  commit: {
    _self: { positional: { min: 0, max: null }, flags: ['--amend', '--files'] },
  },
  'verify-summary': {
    _self: { positional: { min: 1, max: 1 }, flags: ['--check-count'] },
  },
  'staleness-check': {
    _self: { positional: { min: 0, max: 0 }, flags: ['--count'] },
  },
  'sync-agents': {
    _self: { positional: { min: 0, max: 0 }, flags: ['--agents-dir'] },
  },
  'config-get': {
    _self: { positional: { min: 1, max: 1 }, flags: ['--default'] },
  },
  update: {
    _self: {
      positional: { min: 0, max: 0 },
      flags: ['--dry-run', '--local', '--global'],
    },
  },
  scaffold: {
    _self: { positional: { min: 1, max: null }, flags: ['--phase', '--name'] },
  },
  'state-snapshot': {
    _self: { positional: { min: 0, max: 0 }, flags: ['--current'] },
  },
  'summary-extract': {
    _self: { positional: { min: 1, max: 1 }, flags: ['--fields', '--default'] },
  },
  'detect-platform': {
    _self: { positional: { min: 0, max: 1 }, flags: ['--field'] },
  },
  'detect-workspace': {
    _self: { positional: { min: 0, max: 0 }, flags: ['--field'] },
  },
  'git-context': {
    _self: { positional: { min: 0, max: 0 }, flags: ['--field'] },
  },
  'ssh-check': {
    _self: { positional: { min: 0, max: 1 }, flags: ['--field'] },
  },
  websearch: {
    _self: {
      positional: { min: 1, max: null },
      flags: ['--limit', '--freshness'],
    },
  },
  squash: {
    _self: {
      positional: { min: 0, max: 1 },
      flags: [
        '--list-backup-tags',
        '--dry-run',
        '--allow-stable',
        '--strategy',
      ],
    },
  },
  'version-bump': {
    _self: {
      positional: { min: 0, max: 0 },
      flags: ['--level', '--scheme', '--snapshot', '--field'],
    },
  },
  'generate-changelog': {
    _self: { positional: { min: 1, max: 1 }, flags: ['--date'] },
  },
  'issue-import': {
    _self: { positional: { min: 2, max: 2 }, flags: ['--repo'] },
  },
  'issue-sync': {
    _self: { positional: { min: 0, max: 1 }, flags: ['--auto'] },
  },
  divergence: {
    _self: {
      positional: { min: 0, max: 0 },
      flags: [
        '--refresh',
        '--init',
        '--triage',
        '--status',
        '--reason',
        '--branch',
        '--base',
        '--remote',
        '--remote-branch',
      ],
    },
  },
  'pingpong-check': {
    _self: { positional: { min: 0, max: 0 }, flags: ['--window'] },
  },
  'breakout-check': {
    _self: {
      positional: { min: 0, max: 0 },
      flags: ['--plan', '--declared-files'],
    },
  },
  cleanup: { _self: { positional: { min: 0, max: 0 }, flags: ['--dry-run'] } },
};

/**
 * Validate command arguments against ARG_SCHEMAS before dispatch.
 *
 * Catches: flag in positional slot, =-syntax, too-few/many positionals,
 * unknown flags. Exits with a helpful error message on any violation.
 *
 * @param {string} command - Top-level command name (e.g. 'init')
 * @param {string|null} subcommand - Subcommand name (e.g. 'phase-op'), or null for top-level commands
 * @param {string[]} remainingArgs - args after command/subcommand, after global flag stripping
 */
function validateArgs(command, subcommand, remainingArgs) {
  const lookupKey = subcommand || '_self';
  const schema = ARG_SCHEMAS[command]?.[lookupKey];
  if (!schema) return; // No schema = permissive (safe default for unknown subcommands)

  const cmdLabel = subcommand ? `${command} ${subcommand}` : command;
  const usageHint = `Usage: ${cmdLabel}${schema.positional.min > 0 ? ' <arg>' + (schema.positional.max === null || schema.positional.max > 1 ? ' ...' : '') : ''}`;

  // 1. Equals syntax detection (e.g. phase=40 instead of 40)
  for (const arg of remainingArgs) {
    if (arg && !arg.startsWith('--') && /^[a-zA-Z][\w-]*=/.test(arg)) {
      error(
        `'${arg}' looks like a key=value assignment — positional args don't use '=' syntax.\n` +
          `${usageHint}`,
      );
    }
  }

  // 2. Count positional args, accounting for flag-value pairs.
  //    Any --flag followed by a non-flag value is treated as a flag-value pair;
  //    the value is consumed by the flag and NOT counted as a positional.
  //    This applies to both known flags (--field value) and unknown flags (--phase 40).
  const flagValueConsumed = new Set();
  for (let i = 0; i < remainingArgs.length; i++) {
    const arg = remainingArgs[i];
    if (arg && arg.startsWith('--')) {
      const next = remainingArgs[i + 1];
      if (next && !next.startsWith('--')) {
        flagValueConsumed.add(i + 1); // The next arg is consumed as this flag's value
        i++; // Skip the value on the next iteration
      }
    }
  }
  const actualPositionals = remainingArgs.filter(
    (a, i) => a && !a.startsWith('--') && !flagValueConsumed.has(i),
  );

  // 3. Flag handling: distinguish "flag where positional expected" vs "unknown flag"
  //    - If positional requirements are NOT met and schema accepts no flags:
  //      a --flag in place of a positional gets "Positional argument expected"
  //    - Otherwise (positionals are satisfied, or schema has known flags):
  //      an unrecognized --flag gets "Unknown flag"
  for (const arg of remainingArgs) {
    if (arg && arg.startsWith('--') && !schema.flags.includes(arg)) {
      const positionalsSatisfied =
        actualPositionals.length >= schema.positional.min;
      if (!positionalsSatisfied && schema.flags.length === 0) {
        // User passed a flag where a positional was required and no flags are valid
        error(
          `Positional argument expected, got '${arg}'.\n` +
            `${usageHint}\n` +
            `Example: ${cmdLabel}${schema.positional.min > 0 ? ' 40' : ''}`,
        );
      } else {
        // Unknown flag (positionals satisfied, or schema has some known flags)
        const suggestion =
          schema.flags.length > 0
            ? (() => {
                // Simple closest-match by character overlap (good enough for small flag sets)
                let best = null;
                let bestScore = -1;
                for (const f of schema.flags) {
                  const shorter = arg.length < f.length ? arg : f;
                  const longer = arg.length >= f.length ? arg : f;
                  let score = 0;
                  for (let i = 0; i < shorter.length; i++) {
                    if (longer.includes(shorter[i])) score++;
                  }
                  if (score > bestScore) {
                    bestScore = score;
                    best = f;
                  }
                }
                return bestScore > 2 ? ` Did you mean '${best}'?` : '';
              })()
            : '';
        const knownList =
          schema.flags.length > 0 ? schema.flags.join(', ') : 'none';
        error(
          `Unknown flag '${arg}' for '${cmdLabel}'.${suggestion} Known flags: ${knownList}`,
        );
      }
    }
  }

  // 4. Count validation — positionals already computed above
  if (actualPositionals.length < schema.positional.min) {
    error(
      `Too few arguments for '${cmdLabel}': expected at least ${schema.positional.min}, got ${actualPositionals.length}.\n` +
        `${usageHint}`,
    );
  }
  if (
    schema.positional.max !== null &&
    actualPositionals.length > schema.positional.max
  ) {
    error(
      `Too many arguments for '${cmdLabel}': expected at most ${schema.positional.max}, got ${actualPositionals.length}.\n` +
        `${usageHint}`,
    );
  }
}

// ─── Levenshtein Distance (for typo detection) ────────────────────────────────

function levenshtein(a, b) {
  const m = a.length,
    n = b.length;
  const dp = Array.from({ length: m + 1 }, (_, i) => Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      dp[i][j] =
        a[i - 1] === b[j - 1]
          ? dp[i - 1][j - 1]
          : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
  return dp[m][n];
}

// ─── Subcommand Fuzzy Matching ────────────────────────────────────────────────

/**
 * Suggest close subcommand matches for an unknown input.
 *
 * Strategy:
 * 1. Same-namespace: check SUBCOMMANDS[currentCommand] with levenshtein distance <= 2
 *    and distance < ceil(length/2) — same threshold as top-level matching.
 * 2. Cross-namespace: check all subcommands in all other namespaces using levenshtein.
 *    Format suggestions as "namespace subcommand" (e.g., "phase complete").
 * 3. Hyphenated-compound: if input contains a hyphen, try splitting it into parts
 *    and checking if any part matches a namespace and the remaining parts match a
 *    subcommand in that namespace (e.g., "complete-phase" -> "phase complete").
 *
 * @param {string} input - The unknown subcommand provided by the user
 * @param {string} currentCommand - The top-level command namespace (e.g., 'state')
 * @returns {{ sameNamespace: string[], crossNamespace: string[] }}
 */
function suggestSubcommand(input, currentCommand) {
  const sameResults = [];
  const crossResults = [];

  const distThreshold = (sub) =>
    sub.dist <= 2 && sub.dist < Math.ceil(sub.sub.length / 2);

  // 1. Same-namespace matching
  const sameSubcmds = SUBCOMMANDS[currentCommand] || [];
  for (const sub of sameSubcmds) {
    const dist = levenshtein(input, sub);
    if (dist <= 2 && dist < Math.ceil(sub.length / 2)) {
      sameResults.push({ sub, dist });
    }
  }
  sameResults.sort((a, b) => a.dist - b.dist);

  // 2. Cross-namespace matching
  const crossSeen = new Set();
  for (const [ns, subcmds] of Object.entries(SUBCOMMANDS)) {
    if (ns === currentCommand) continue;
    for (const sub of subcmds) {
      const suggestion = `${ns} ${sub}`;
      // Direct levenshtein match against the subcommand alone
      const dist = levenshtein(input, sub);
      if (
        dist <= 2 &&
        dist < Math.ceil(sub.length / 2) &&
        !crossSeen.has(suggestion)
      ) {
        crossResults.push({ suggestion, dist });
        crossSeen.add(suggestion);
      }
      // Also try matching against the full "ns subcommand" compound form (e.g., "phase complete" vs "complete-phase")
      const fullForm = `${ns}-${sub}`;
      const fullDist = levenshtein(input, fullForm);
      if (
        fullDist <= 3 &&
        fullDist < Math.ceil(fullForm.length / 2) &&
        !crossSeen.has(suggestion)
      ) {
        crossResults.push({ suggestion, dist: fullDist });
        crossSeen.add(suggestion);
      }
    }
  }

  // 3. Hyphenated-compound decomposition
  // e.g., "complete-phase" -> try namespace="phase", subcommand="complete"
  if (input.includes('-')) {
    const parts = input.split('-');
    for (let splitAt = 1; splitAt < parts.length; splitAt++) {
      const prefix = parts.slice(0, splitAt).join('-');
      const suffix = parts.slice(splitAt).join('-');
      // Try: namespace=suffix, subcommand=prefix (e.g., complete-phase -> phase namespace, complete subcommand)
      for (const [ns, subcmds] of Object.entries(SUBCOMMANDS)) {
        if (ns === currentCommand) continue;
        const nsDist = levenshtein(suffix, ns);
        if (nsDist <= 1) {
          for (const sub of subcmds) {
            const subDist = levenshtein(prefix, sub);
            if (subDist <= 2 && subDist < Math.ceil(sub.length / 2)) {
              const suggestion = `${ns} ${sub}`;
              if (!crossSeen.has(suggestion)) {
                crossResults.push({ suggestion, dist: nsDist + subDist });
                crossSeen.add(suggestion);
              }
            }
          }
        }
        // Also try: namespace=prefix, subcommand=suffix
        const nsDist2 = levenshtein(prefix, ns);
        if (nsDist2 <= 1) {
          for (const sub of subcmds) {
            const subDist = levenshtein(suffix, sub);
            if (subDist <= 2 && subDist < Math.ceil(sub.length / 2)) {
              const suggestion = `${ns} ${sub}`;
              if (!crossSeen.has(suggestion)) {
                crossResults.push({ suggestion, dist: nsDist2 + subDist });
                crossSeen.add(suggestion);
              }
            }
          }
        }
      }
    }
  }

  crossResults.sort((a, b) => a.dist - b.dist);

  return {
    sameNamespace: sameResults.map((r) => r.sub),
    crossNamespace: crossResults.map((r) => r.suggestion),
  };
}

// ─── Help ─────────────────────────────────────────────────────────────────────

function printHelp({ exitCode = 0 } = {}) {
  const src = fs.readFileSync(__filename, 'utf8');
  const match = src.match(/\/\*\*([\s\S]*?)\*\//);
  const out = exitCode !== 0 ? process.stderr : process.stdout;
  if (!match) {
    out.write('No help available.\n');
    process.exit(exitCode);
  }
  const lines = match[1]
    .split('\n')
    .map((l) => l.replace(/^\s*\*\s?/, ''))
    .filter((_, i, arr) => i > 0 || arr[i].trim());
  out.write(lines.join('\n').trim() + '\n');
  process.exit(exitCode);
}

// Module-level state for --pick field extraction.
// Capture buffer is populated by fs.writeSync/process.stdout.write interception in main().
// Original references are stored so the post-run .then() handler can restore and write.
const _pickStdoutChunks = [];
let _origFsWriteSync = null;
let _origStdoutWrite = null;

// ─── CLI Router ───────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);

  // Optional cwd override for sandboxed subagents running outside project root.
  let cwd = process.cwd();
  const cwdEqArg = args.find((arg) => arg.startsWith('--cwd='));
  const cwdIdx = args.indexOf('--cwd');
  if (cwdEqArg) {
    const value = cwdEqArg.slice('--cwd='.length).trim();
    if (!value) error('Missing value for --cwd');
    args.splice(args.indexOf(cwdEqArg), 1);
    cwd = path.resolve(value);
  } else if (cwdIdx !== -1) {
    const value = args[cwdIdx + 1];
    if (!value || value.startsWith('--')) error('Missing value for --cwd');
    args.splice(cwdIdx, 2);
    cwd = path.resolve(value);
  } else {
    // No explicit --cwd: resolve git repo root to handle worktree contexts
    try {
      const repoRoot = execSync('git rev-parse --show-toplevel', {
        cwd: process.cwd(),
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();
      // When invoked from inside a git submodule, --show-toplevel resolves to
      // the submodule root (not the superproject). Check for a superproject and
      // prefer its .planning/ if present (F-CWD fix).
      let resolvedRoot = repoRoot;
      try {
        const superRoot = execSync(
          'git rev-parse --show-superproject-working-tree',
          {
            cwd: process.cwd(),
            encoding: 'utf8',
            stdio: ['pipe', 'pipe', 'pipe'],
          },
        ).trim();
        if (superRoot && fs.existsSync(path.join(superRoot, '.planning'))) {
          resolvedRoot = superRoot;
        }
      } catch {
        // Not inside a submodule or git unavailable — keep repoRoot
      }
      // Only use git root if it has a .planning directory
      // (avoids incorrectly resolving when invoked from a non-GSD repo)
      if (fs.existsSync(path.join(resolvedRoot, '.planning'))) {
        cwd = resolvedRoot;
      }
    } catch {
      // Not a git repo or git unavailable — keep process.cwd()
    }
  }

  if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
    error(`Invalid --cwd: ${cwd}`);
  }

  const jsonIndex = args.indexOf('--json');
  if (jsonIndex !== -1) {
    setJsonMode(true);
    args.splice(jsonIndex, 1);
  }

  // --file: when present, output() writes JSON to a temp file prefixed with @file:
  // instead of inline to stdout. Opt-in for the rare case where file output is needed.
  const fileIndex = args.indexOf('--file');
  if (fileIndex !== -1) {
    setFileOutput(true);
    args.splice(fileIndex, 1);
  }

  // --pick <name>: extract a single field from JSON output (replaces jq dependency).
  // Supports dot-notation (e.g., --pick workflow.research) and bracket notation
  // for arrays (e.g., --pick directories[-1]).
  const pickIdx = args.indexOf('--pick');
  let pickField = null;
  if (pickIdx !== -1) {
    pickField = args[pickIdx + 1];
    if (!pickField || pickField.startsWith('--'))
      error('Missing value for --pick');
    args.splice(pickIdx, 2);
  }

  if (args.includes('--help') || args.includes('-h')) printHelp();

  let command = args[0];

  if (!command) printHelp({ exitCode: 1 });

  // When --pick is active, intercept stdout writes to extract a single field
  // from JSON output (replaces jq dependency). output() uses fs.writeSync(1, ...)
  // so we intercept at the fs layer; also intercept process.stdout.write for any
  // non-output() paths (printHelp, etc.).
  if (pickField) {
    setJsonMode(true); // --pick needs JSON to extract fields
    _origFsWriteSync = fs.writeSync.bind(fs);
    _origStdoutWrite = process.stdout.write.bind(process.stdout);

    fs.writeSync = function (fd, data, ...rest) {
      if (fd === 1) {
        _pickStdoutChunks.push(String(data));
        return data.length;
      }
      return _origFsWriteSync(fd, data, ...rest);
    };

    process.stdout.write = function (data) {
      _pickStdoutChunks.push(String(data));
      return true;
    };

    // Intercept process.exit to flush captured output on error paths (e.g. error())
    const origExit = process.exit.bind(process);
    process.exit = function (code) {
      fs.writeSync = _origFsWriteSync;
      process.stdout.write = _origStdoutWrite;
      process.exit = origExit;
      if (code === 0 || code === undefined) {
        const captured = _pickStdoutChunks.join('');
        let jsonStr = captured;
        if (jsonStr.startsWith('@file:')) {
          try {
            jsonStr = fs.readFileSync(jsonStr.slice(6), 'utf-8');
          } catch {
            jsonStr = captured;
          }
        }
        try {
          const obj = JSON.parse(jsonStr);
          const value = extractField(obj, pickField);
          const result =
            value === null || value === undefined ? '' : String(value);
          _origFsWriteSync(1, result);
        } catch {
          _origFsWriteSync(1, captured);
        }
      }
      origExit(code);
    };
  }

  // Flag-style argument support: --phase 36.3 -> phase 36.3
  // Allows callers to use --command style (common mistake). Emits info hint to stderr.
  if (
    command &&
    command.startsWith('--') &&
    command !== '--help' &&
    command !== '-h'
  ) {
    const flagName = command.slice(2); // strip --
    if (ALL_COMMANDS.includes(flagName)) {
      fs.writeSync(
        2,
        `[info] Interpreted --${flagName} as command '${flagName}'. Canonical usage: gsd-tools ${flagName} ${args.slice(1).join(' ')}\n`,
      );
      args[0] = flagName;
      command = flagName;
    }
    // If not a known command, fall through to switch default (typo detection handles it)
  }

  switch (command) {
    case 'state': {
      const subcommand = args[1];
      validateArgs('state', subcommand, args.slice(2));
      if (subcommand === 'json') {
        state.cmdStateJson(cwd);
      } else if (subcommand === 'update') {
        state.cmdStateUpdate(cwd, args[2], args[3]);
      } else if (subcommand === 'get') {
        state.cmdStateGet(cwd, args[2]);
      } else if (subcommand === 'patch') {
        const patches = {};
        const fieldIdx = args.indexOf('--field');
        const valueIdx = args.indexOf('--value');
        if (fieldIdx !== -1 || valueIdx !== -1) {
          // Named flag mode: --field NAME --value VALUE
          if (fieldIdx === -1 || valueIdx === -1) {
            process.stderr.write(
              JSON.stringify({
                error:
                  '--field and --value must be used together. Usage: state patch --field <name> --value <val>',
              }) + '\n',
            );
            process.exit(1);
          }
          const key = args[fieldIdx + 1];
          const val = args[valueIdx + 1];
          if (!key || key.startsWith('--') || !val) {
            process.stderr.write(
              JSON.stringify({
                error:
                  '--field and --value require arguments. Usage: state patch --field <name> --value <val>',
              }) + '\n',
            );
            process.exit(1);
          }
          patches[key] = val;
        } else {
          // Legacy positional mode: --key value pairs (strip -- prefix)
          if (args.length < 4) {
            process.stderr.write(
              JSON.stringify({
                error:
                  'state patch requires at least one field-value pair. Usage: state patch --<field> <value> OR state patch --field <name> --value <val>',
              }) + '\n',
            );
            process.exit(1);
          }
          for (let i = 2; i < args.length; i += 2) {
            const key = args[i].replace(/^--/, '');
            const value = args[i + 1];
            if (key && value !== undefined) {
              patches[key] = value;
            }
          }
        }
        if (Object.keys(patches).length === 0) {
          process.stderr.write(
            JSON.stringify({ error: 'No valid field-value pairs provided' }) +
              '\n',
          );
          process.exit(1);
        }
        state.cmdStatePatch(cwd, patches);
      } else if (subcommand === 'advance-plan') {
        state.cmdStateAdvancePlan(cwd);
      } else if (subcommand === 'record-metric') {
        const phaseIdx = args.indexOf('--phase');
        const planIdx = args.indexOf('--plan');
        const durationIdx = args.indexOf('--duration');
        const tasksIdx = args.indexOf('--tasks');
        const filesIdx = args.indexOf('--files');
        state.cmdStateRecordMetric(cwd, {
          phase: phaseIdx !== -1 ? args[phaseIdx + 1] : null,
          plan: planIdx !== -1 ? args[planIdx + 1] : null,
          duration: durationIdx !== -1 ? args[durationIdx + 1] : null,
          tasks: tasksIdx !== -1 ? args[tasksIdx + 1] : null,
          files: filesIdx !== -1 ? args[filesIdx + 1] : null,
        });
      } else if (subcommand === 'update-progress') {
        state.cmdStateUpdateProgress(cwd);
      } else if (subcommand === 'add-decision') {
        const phaseIdx = args.indexOf('--phase');
        const summaryIdx = args.indexOf('--summary');
        const summaryFileIdx = args.indexOf('--summary-file');
        const rationaleIdx = args.indexOf('--rationale');
        const rationaleFileIdx = args.indexOf('--rationale-file');
        state.cmdStateAddDecision(cwd, {
          phase: phaseIdx !== -1 ? args[phaseIdx + 1] : null,
          summary: summaryIdx !== -1 ? args[summaryIdx + 1] : null,
          summary_file: summaryFileIdx !== -1 ? args[summaryFileIdx + 1] : null,
          rationale: rationaleIdx !== -1 ? args[rationaleIdx + 1] : '',
          rationale_file:
            rationaleFileIdx !== -1 ? args[rationaleFileIdx + 1] : null,
        });
      } else if (subcommand === 'add-blocker') {
        const textIdx = args.indexOf('--text');
        const textFileIdx = args.indexOf('--text-file');
        state.cmdStateAddBlocker(cwd, {
          text: textIdx !== -1 ? args[textIdx + 1] : null,
          text_file: textFileIdx !== -1 ? args[textFileIdx + 1] : null,
        });
      } else if (subcommand === 'resolve-blocker') {
        const textIdx = args.indexOf('--text');
        state.cmdStateResolveBlocker(
          cwd,
          textIdx !== -1 ? args[textIdx + 1] : null,
        );
      } else if (subcommand === 'record-session') {
        const stoppedIdx = args.indexOf('--stopped-at');
        const resumeIdx = args.indexOf('--resume-file');
        state.cmdStateRecordSession(cwd, {
          stopped_at: stoppedIdx !== -1 ? args[stoppedIdx + 1] : null,
          resume_file: resumeIdx !== -1 ? args[resumeIdx + 1] : 'None',
        });
      } else if (subcommand === 'begin-phase') {
        const phaseIdx = args.indexOf('--phase');
        const nameIdx = args.indexOf('--name');
        const plansIdx = args.indexOf('--plans');
        state.cmdStateBeginPhase(
          cwd,
          phaseIdx !== -1 ? args[phaseIdx + 1] : null,
          nameIdx !== -1 ? args[nameIdx + 1] : null,
          plansIdx !== -1 ? parseInt(args[plansIdx + 1], 10) : null,
        );
      } else if (subcommand === 'adjust-quick-table') {
        state.cmdStateAdjustQuickTable(cwd);
      } else if (subcommand === 'rebuild-frontmatter') {
        state.cmdStateRebuildFrontmatter(cwd);
      } else if (subcommand === 'load' || !subcommand) {
        state.cmdStateLoad(cwd);
      } else {
        const suggestions = suggestSubcommand(subcommand, 'state');
        if (
          suggestions.sameNamespace.length > 0 ||
          suggestions.crossNamespace.length > 0
        ) {
          const parts = [];
          if (suggestions.sameNamespace.length > 0)
            parts.push(`state ${suggestions.sameNamespace[0]}`);
          if (suggestions.crossNamespace.length > 0)
            parts.push(...suggestions.crossNamespace.slice(0, 2));
          error(
            `Unknown state subcommand '${subcommand}'. Did you mean: ${parts.join(', ')}?\nAvailable: ${SUBCOMMANDS.state.join(', ')}`,
          );
        } else {
          error(
            `Unknown state subcommand '${subcommand}'. Available: ${SUBCOMMANDS.state.join(', ')}`,
          );
        }
      }
      break;
    }

    case 'resolve-model': {
      commands.cmdResolveModel(cwd, args[1]);
      break;
    }

    case 'resolve-effort': {
      commands.cmdResolveEffort(cwd, args[1]);
      break;
    }

    case 'sync-agents': {
      validateArgs('sync-agents', null, args.slice(1));
      // Optional --agents-dir override (default: <cwd>/.claude/agents).
      const agentsDirIdx = args.indexOf('--agents-dir');
      const customAgentsDir =
        agentsDirIdx !== -1 ? args[agentsDirIdx + 1] : null;
      const agentsDir = customAgentsDir
        ? path.resolve(customAgentsDir)
        : path.join(cwd, '.claude', 'agents');

      if (!fs.existsSync(agentsDir)) {
        coreOutput(
          {
            skipped: true,
            reason: 'agents-dir-missing',
            agentsDir,
            changes: [],
          },
          `No agents directory found at ${agentsDir} — run the installer first.`,
        );
        break;
      }

      const syncResult = effortSync.syncAgentEffortFrontmatter(cwd, agentsDir);
      const changeCount = (syncResult.changes || []).length;

      // Build a clean stdout summary — NO restart notice embedded here.
      // The restart notice goes to stderr separately so JSON-mode consumers
      // get a clean payload on stdout and the notice doesn't pollute pipelines.
      const syncSummary = syncResult.skipped
        ? 'Skipped — non-Claude runtime.'
        : changeCount === 0
          ? 'Agents already in sync.'
          : `Synced ${changeCount} agent${changeCount === 1 ? '' : 's'}.`;

      // Emit the restart notice via stderr ONLY when the helper reports real changes.
      // Matches the emission shape used by install.js and config.cjs — one voice.
      const restartNotice = effortSync.formatRestartNotice(
        syncResult.changes || [],
      );
      if (restartNotice) {
        process.stderr.write(restartNotice + '\n');
      }

      coreOutput({ ...syncResult, restartNotice }, syncSummary);
      break;
    }

    case 'find-phase': {
      phase.cmdFindPhase(cwd, args[1]);
      break;
    }

    case 'commit': {
      validateArgs('commit', null, args.slice(1));
      const amend = args.includes('--amend');
      const filesIndex = args.indexOf('--files');
      // Collect all positional args between command name and first flag,
      // then join them — handles both quoted ("multi word msg") and
      // unquoted (multi word msg) invocations from different shells
      const endIndex = filesIndex !== -1 ? filesIndex : args.length;
      const messageArgs = args
        .slice(1, endIndex)
        .filter((a) => !a.startsWith('--'));
      const message = messageArgs.join(' ') || undefined;
      const files =
        filesIndex !== -1
          ? args.slice(filesIndex + 1).filter((a) => !a.startsWith('--'))
          : [];
      commands.cmdCommit(cwd, message, files, amend);
      break;
    }

    case 'verify-summary': {
      validateArgs('verify-summary', null, args.slice(1));
      const summaryPath = args[1];
      const countIndex = args.indexOf('--check-count');
      const checkCount =
        countIndex !== -1 ? parseInt(args[countIndex + 1], 10) : 2;
      verify.cmdVerifySummary(cwd, summaryPath, checkCount);
      break;
    }

    case 'template': {
      const subcommand = args[1];
      validateArgs('template', subcommand, args.slice(2));
      if (subcommand === 'select') {
        template.cmdTemplateSelect(cwd, args[2]);
      } else if (subcommand === 'fill') {
        const templateType = args[2];
        const phaseIdx = args.indexOf('--phase');
        const planIdx = args.indexOf('--plan');
        const nameIdx = args.indexOf('--name');
        const typeIdx = args.indexOf('--type');
        const waveIdx = args.indexOf('--wave');
        const fieldsIdx = args.indexOf('--fields');
        template.cmdTemplateFill(cwd, templateType, {
          phase: phaseIdx !== -1 ? args[phaseIdx + 1] : null,
          plan: planIdx !== -1 ? args[planIdx + 1] : null,
          name: nameIdx !== -1 ? args[nameIdx + 1] : null,
          type: typeIdx !== -1 ? args[typeIdx + 1] : 'execute',
          wave: waveIdx !== -1 ? args[waveIdx + 1] : '1',
          fields: fieldsIdx !== -1 ? JSON.parse(args[fieldsIdx + 1]) : {},
        });
      } else {
        const suggestions = suggestSubcommand(subcommand, 'template');
        if (
          suggestions.sameNamespace.length > 0 ||
          suggestions.crossNamespace.length > 0
        ) {
          const parts = [];
          if (suggestions.sameNamespace.length > 0)
            parts.push(`template ${suggestions.sameNamespace[0]}`);
          if (suggestions.crossNamespace.length > 0)
            parts.push(...suggestions.crossNamespace.slice(0, 2));
          error(
            `Unknown template subcommand '${subcommand}'. Did you mean: ${parts.join(', ')}?\nAvailable: ${SUBCOMMANDS.template.join(', ')}`,
          );
        } else {
          error(
            `Unknown template subcommand '${subcommand}'. Available: ${SUBCOMMANDS.template.join(', ')}`,
          );
        }
      }
      break;
    }

    case 'frontmatter': {
      const subcommand = args[1];
      validateArgs('frontmatter', subcommand, args.slice(2));
      const file = args[2];
      if (subcommand === 'get') {
        const fieldIdx = args.indexOf('--field');
        const formatIdx = args.indexOf('--format');
        const defaultIdx = args.indexOf('--default');
        const defaultValue =
          defaultIdx !== -1 ? args[defaultIdx + 1] : undefined;
        frontmatter.cmdFrontmatterGet(
          cwd,
          file,
          fieldIdx !== -1 ? args[fieldIdx + 1] : null,
          formatIdx !== -1 ? args[formatIdx + 1] : null,
          defaultValue,
        );
      } else if (subcommand === 'set') {
        const fieldIdx = args.indexOf('--field');
        const valueIdx = args.indexOf('--value');
        frontmatter.cmdFrontmatterSet(
          cwd,
          file,
          fieldIdx !== -1 ? args[fieldIdx + 1] : null,
          valueIdx !== -1 ? args[valueIdx + 1] : undefined,
        );
      } else if (subcommand === 'merge') {
        const dataIdx = args.indexOf('--data');
        frontmatter.cmdFrontmatterMerge(
          cwd,
          file,
          dataIdx !== -1 ? args[dataIdx + 1] : null,
        );
      } else if (subcommand === 'validate') {
        const schemaIdx = args.indexOf('--schema');
        frontmatter.cmdFrontmatterValidate(
          cwd,
          file,
          schemaIdx !== -1 ? args[schemaIdx + 1] : null,
        );
      } else if (subcommand === 'array-append') {
        const fieldIdx = args.indexOf('--field');
        const valueIdx = args.indexOf('--value');
        frontmatter.cmdFrontmatterArrayAppend(
          cwd,
          file,
          fieldIdx !== -1 ? args[fieldIdx + 1] : null,
          valueIdx !== -1 ? args[valueIdx + 1] : undefined,
        );
      } else {
        const suggestions = suggestSubcommand(subcommand, 'frontmatter');
        if (
          suggestions.sameNamespace.length > 0 ||
          suggestions.crossNamespace.length > 0
        ) {
          const parts = [];
          if (suggestions.sameNamespace.length > 0)
            parts.push(`frontmatter ${suggestions.sameNamespace[0]}`);
          if (suggestions.crossNamespace.length > 0)
            parts.push(...suggestions.crossNamespace.slice(0, 2));
          error(
            `Unknown frontmatter subcommand '${subcommand}'. Did you mean: ${parts.join(', ')}?\nAvailable: ${SUBCOMMANDS.frontmatter.join(', ')}`,
          );
        } else {
          error(
            `Unknown frontmatter subcommand '${subcommand}'. Available: ${SUBCOMMANDS.frontmatter.join(', ')}`,
          );
        }
      }
      break;
    }

    case 'verify': {
      const subcommand = args[1];
      validateArgs('verify', subcommand, args.slice(2));
      if (subcommand === 'plan-structure') {
        verify.cmdVerifyPlanStructure(cwd, args[2]);
      } else if (subcommand === 'phase-completeness') {
        verify.cmdVerifyPhaseCompleteness(cwd, args[2]);
      } else if (subcommand === 'references') {
        verify.cmdVerifyReferences(cwd, args[2]);
      } else if (subcommand === 'commits') {
        verify.cmdVerifyCommits(cwd, args.slice(2));
      } else if (subcommand === 'artifacts') {
        verify.cmdVerifyArtifacts(cwd, args[2]);
      } else if (subcommand === 'key-links') {
        verify.cmdVerifyKeyLinks(cwd, args[2]);
      } else {
        const suggestions = suggestSubcommand(subcommand, 'verify');
        if (
          suggestions.sameNamespace.length > 0 ||
          suggestions.crossNamespace.length > 0
        ) {
          const parts = [];
          if (suggestions.sameNamespace.length > 0)
            parts.push(`verify ${suggestions.sameNamespace[0]}`);
          if (suggestions.crossNamespace.length > 0)
            parts.push(...suggestions.crossNamespace.slice(0, 2));
          error(
            `Unknown verify subcommand '${subcommand}'. Did you mean: ${parts.join(', ')}?\nAvailable: ${SUBCOMMANDS.verify.join(', ')}`,
          );
        } else {
          error(
            `Unknown verify subcommand '${subcommand}'. Available: ${SUBCOMMANDS.verify.join(', ')}`,
          );
        }
      }
      break;
    }

    case 'generate-slug': {
      commands.cmdGenerateSlug(args[1]);
      break;
    }

    case 'current-timestamp': {
      commands.cmdCurrentTimestamp(args[1] || 'full');
      break;
    }

    case 'list-todos': {
      commands.cmdListTodos(cwd, args[1]);
      break;
    }

    case 'recurring-due': {
      // --default accepted for consistency but recurring-due always returns valid output
      commands.cmdRecurringDue(cwd);
      break;
    }

    case 'staleness-check': {
      validateArgs('staleness-check', null, args.slice(1));
      const countFlag = args.includes('--count');
      commands.cmdStalenessCheck(cwd, countFlag);
      break;
    }

    case 'verify-path-exists': {
      commands.cmdVerifyPathExists(cwd, args[1]);
      break;
    }

    case 'config-ensure-section': {
      config.cmdConfigEnsureSection(cwd);
      break;
    }

    case 'config-set': {
      config.cmdConfigSet(cwd, args[1], args[2]);
      break;
    }

    case 'config-set-model-profile': {
      config.cmdConfigSetModelProfile(cwd, args[1]);
      break;
    }

    case 'config-get': {
      validateArgs('config-get', null, args.slice(1));
      const defaultIdx = args.indexOf('--default');
      const defaultValue = defaultIdx !== -1 ? args[defaultIdx + 1] : undefined;
      config.cmdConfigGet(cwd, args[1], defaultValue);
      break;
    }

    case 'init-get': {
      init.cmdInitGet(args[1], args[2]);
      break;
    }

    case 'history-digest': {
      commands.cmdHistoryDigest(cwd);
      break;
    }

    case 'phases': {
      const subcommand = args[1];
      validateArgs('phases', subcommand, args.slice(2));
      if (subcommand === 'list') {
        const typeIndex = args.indexOf('--type');
        const phaseIndex = args.indexOf('--phase');
        const options = {
          type: typeIndex !== -1 ? args[typeIndex + 1] : null,
          phase: phaseIndex !== -1 ? args[phaseIndex + 1] : null,
          includeArchived: args.includes('--include-archived'),
        };
        phase.cmdPhasesList(cwd, options);
      } else {
        const suggestions = suggestSubcommand(subcommand, 'phases');
        if (
          suggestions.sameNamespace.length > 0 ||
          suggestions.crossNamespace.length > 0
        ) {
          const parts = [];
          if (suggestions.sameNamespace.length > 0)
            parts.push(`phases ${suggestions.sameNamespace[0]}`);
          if (suggestions.crossNamespace.length > 0)
            parts.push(...suggestions.crossNamespace.slice(0, 2));
          error(
            `Unknown phases subcommand '${subcommand}'. Did you mean: ${parts.join(', ')}?\nAvailable: ${SUBCOMMANDS.phases.join(', ')}`,
          );
        } else {
          error(
            `Unknown phases subcommand '${subcommand}'. Available: ${SUBCOMMANDS.phases.join(', ')}`,
          );
        }
      }
      break;
    }

    case 'roadmap': {
      const subcommand = args[1];
      validateArgs('roadmap', subcommand, args.slice(2));
      if (subcommand === 'get-phase') {
        const defaultIdx = args.indexOf('--default');
        const defaultValue =
          defaultIdx !== -1 ? args[defaultIdx + 1] : undefined;
        roadmap.cmdRoadmapGetPhase(cwd, args[2], defaultValue);
      } else if (subcommand === 'analyze') {
        const analyzeCurrentFilter = args.slice(2).includes('--current');
        let analyzePhaseFilter = null;
        if (analyzeCurrentFilter) {
          const statePath = path.join(cwd, '.planning', 'STATE.md');
          try {
            const stateContent = fs.readFileSync(statePath, 'utf-8');
            const fmMatch = stateContent.match(/^---\n([\s\S]*?)\n---/);
            if (fmMatch) {
              const cpMatch = fmMatch[1].match(/^current_phase:\s*(.+)$/m);
              if (cpMatch)
                analyzePhaseFilter = cpMatch[1].trim().replace(/['"]/g, '');
            }
          } catch {}
        }
        roadmap.cmdRoadmapAnalyze(cwd, analyzePhaseFilter);
      } else if (subcommand === 'update-plan-progress') {
        roadmap.cmdRoadmapUpdatePlanProgress(cwd, args[2]);
      } else if (subcommand === 'add-phase') {
        // Alias: redirect to phase add
        phase.cmdPhaseAdd(cwd, args.slice(2).join(' '));
      } else {
        const suggestions = suggestSubcommand(subcommand, 'roadmap');
        if (
          suggestions.sameNamespace.length > 0 ||
          suggestions.crossNamespace.length > 0
        ) {
          const parts = [];
          if (suggestions.sameNamespace.length > 0)
            parts.push(`roadmap ${suggestions.sameNamespace[0]}`);
          if (suggestions.crossNamespace.length > 0)
            parts.push(...suggestions.crossNamespace.slice(0, 2));
          error(
            `Unknown roadmap subcommand '${subcommand}'. Did you mean: ${parts.join(', ')}?\nAvailable: ${SUBCOMMANDS.roadmap.join(', ')}`,
          );
        } else {
          error(
            `Unknown roadmap subcommand '${subcommand}'. Available: ${SUBCOMMANDS.roadmap.join(', ')}`,
          );
        }
      }
      break;
    }

    case 'requirements': {
      const subcommand = args[1];
      validateArgs('requirements', subcommand, args.slice(2));
      if (subcommand === 'mark-complete') {
        milestone.cmdRequirementsMarkComplete(cwd, args.slice(2));
      } else {
        const suggestions = suggestSubcommand(subcommand, 'requirements');
        if (
          suggestions.sameNamespace.length > 0 ||
          suggestions.crossNamespace.length > 0
        ) {
          const parts = [];
          if (suggestions.sameNamespace.length > 0)
            parts.push(`requirements ${suggestions.sameNamespace[0]}`);
          if (suggestions.crossNamespace.length > 0)
            parts.push(...suggestions.crossNamespace.slice(0, 2));
          error(
            `Unknown requirements subcommand '${subcommand}'. Did you mean: ${parts.join(', ')}?\nAvailable: ${SUBCOMMANDS.requirements.join(', ')}`,
          );
        } else {
          error(
            `Unknown requirements subcommand '${subcommand}'. Available: ${SUBCOMMANDS.requirements.join(', ')}`,
          );
        }
      }
      break;
    }

    case 'test': {
      const subcommand = args[1];
      validateArgs('test', subcommand, args.slice(2));
      if (subcommand === 'capture-baseline') {
        testBaseline.captureBaseline(args[2], args[3]);
      } else if (subcommand === 'compare-baseline') {
        testBaseline.compareBaseline(args[2], args[3]);
      } else {
        const suggestions = suggestSubcommand(subcommand, 'test');
        if (
          suggestions.sameNamespace.length > 0 ||
          suggestions.crossNamespace.length > 0
        ) {
          const parts = [];
          if (suggestions.sameNamespace.length > 0)
            parts.push(`test ${suggestions.sameNamespace[0]}`);
          if (suggestions.crossNamespace.length > 0)
            parts.push(...suggestions.crossNamespace.slice(0, 2));
          error(
            `Unknown test subcommand '${subcommand}'. Did you mean: ${parts.join(', ')}?\nAvailable: ${SUBCOMMANDS.test.join(', ')}`,
          );
        } else {
          error(
            `Unknown test subcommand '${subcommand}'. Available: ${SUBCOMMANDS.test.join(', ')}`,
          );
        }
      }
      break;
    }

    case 'phase': {
      const subcommand = args[1];
      validateArgs('phase', subcommand, args.slice(2));
      if (subcommand === 'next-decimal') {
        phase.cmdPhaseNextDecimal(cwd, args[2]);
      } else if (subcommand === 'add') {
        phase.cmdPhaseAdd(cwd, args.slice(2).join(' '));
      } else if (subcommand === 'insert') {
        phase.cmdPhaseInsert(cwd, args[2], args.slice(3).join(' '));
      } else if (subcommand === 'remove') {
        const forceFlag = args.includes('--force');
        phase.cmdPhaseRemove(cwd, args[2], { force: forceFlag });
      } else if (subcommand === 'complete') {
        phase.cmdPhaseComplete(cwd, args[2]);
      } else {
        const suggestions = suggestSubcommand(subcommand, 'phase');
        if (
          suggestions.sameNamespace.length > 0 ||
          suggestions.crossNamespace.length > 0
        ) {
          const parts = [];
          if (suggestions.sameNamespace.length > 0)
            parts.push(`phase ${suggestions.sameNamespace[0]}`);
          if (suggestions.crossNamespace.length > 0)
            parts.push(...suggestions.crossNamespace.slice(0, 2));
          error(
            `Unknown phase subcommand '${subcommand}'. Did you mean: ${parts.join(', ')}?\nAvailable: ${SUBCOMMANDS.phase.join(', ')}`,
          );
        } else {
          error(
            `Unknown phase subcommand '${subcommand}'. Available: ${SUBCOMMANDS.phase.join(', ')}`,
          );
        }
      }
      break;
    }

    case 'milestone': {
      const subcommand = args[1];
      validateArgs('milestone', subcommand, args.slice(2));
      if (subcommand === 'complete') {
        const nameIndex = args.indexOf('--name');
        const archivePhases = args.includes('--archive-phases');
        // Collect --name value (everything after --name until next flag or end)
        let milestoneName = null;
        if (nameIndex !== -1) {
          const nameArgs = [];
          for (let i = nameIndex + 1; i < args.length; i++) {
            if (args[i].startsWith('--')) break;
            nameArgs.push(args[i]);
          }
          milestoneName = nameArgs.join(' ') || null;
        }
        milestone.cmdMilestoneComplete(cwd, args[2], {
          name: milestoneName,
          archivePhases,
        });
      } else {
        const suggestions = suggestSubcommand(subcommand, 'milestone');
        if (
          suggestions.sameNamespace.length > 0 ||
          suggestions.crossNamespace.length > 0
        ) {
          const parts = [];
          if (suggestions.sameNamespace.length > 0)
            parts.push(`milestone ${suggestions.sameNamespace[0]}`);
          if (suggestions.crossNamespace.length > 0)
            parts.push(...suggestions.crossNamespace.slice(0, 2));
          error(
            `Unknown milestone subcommand '${subcommand}'. Did you mean: ${parts.join(', ')}?\nAvailable: ${SUBCOMMANDS.milestone.join(', ')}`,
          );
        } else {
          error(
            `Unknown milestone subcommand '${subcommand}'. Available: ${SUBCOMMANDS.milestone.join(', ')}`,
          );
        }
      }
      break;
    }

    case 'validate': {
      const subcommand = args[1];
      validateArgs('validate', subcommand, args.slice(2));
      if (subcommand === 'consistency') {
        verify.cmdValidateConsistency(cwd);
      } else if (subcommand === 'health') {
        const repairFlag = args.includes('--repair');
        verify.cmdValidateHealth(cwd, { repair: repairFlag });
      } else {
        const suggestions = suggestSubcommand(subcommand, 'validate');
        if (
          suggestions.sameNamespace.length > 0 ||
          suggestions.crossNamespace.length > 0
        ) {
          const parts = [];
          if (suggestions.sameNamespace.length > 0)
            parts.push(`validate ${suggestions.sameNamespace[0]}`);
          if (suggestions.crossNamespace.length > 0)
            parts.push(...suggestions.crossNamespace.slice(0, 2));
          error(
            `Unknown validate subcommand '${subcommand}'. Did you mean: ${parts.join(', ')}?\nAvailable: ${SUBCOMMANDS.validate.join(', ')}`,
          );
        } else {
          error(
            `Unknown validate subcommand '${subcommand}'. Available: ${SUBCOMMANDS.validate.join(', ')}`,
          );
        }
      }
      break;
    }

    case 'progress': {
      const subcommand = args[1] || 'json';
      commands.cmdProgressRender(cwd, subcommand);
      break;
    }

    case 'stats': {
      const subcommand = args[1] || 'json';
      commands.cmdStats(cwd, subcommand);
      break;
    }

    case 'todo': {
      const subcommand = args[1];
      validateArgs('todo', subcommand, args.slice(2));
      if (subcommand === 'complete') {
        commands.cmdTodoComplete(cwd, args[2]);
      } else if (subcommand === 'list-by-phase') {
        commands.cmdTodoListByPhase(cwd, args[2]);
      } else if (subcommand === 'scan-phase-linked') {
        commands.cmdTodoScanPhaseLinked(cwd, args[2]);
      } else {
        // Only use same-namespace suggestions to avoid misleading
        // cross-namespace matches (e.g. "todo add" suggesting "phase add").
        const suggestions = suggestSubcommand(subcommand, 'todo');
        // Hint users toward the /gsd:add-todo skill for create operations.
        const skillHint =
          '\nTo add a todo, use `/gsd:add-todo` (a workflow skill).';
        if (suggestions.sameNamespace.length > 0) {
          const parts = suggestions.sameNamespace
            .slice(0, 2)
            .map((s) => `todo ${s}`);
          error(
            `Unknown todo subcommand '${subcommand}'. Did you mean: ${parts.join(', ')}?\nAvailable: ${SUBCOMMANDS.todo.join(', ')}${skillHint}`,
          );
        } else {
          error(
            `Unknown todo subcommand '${subcommand}'. Available: ${SUBCOMMANDS.todo.join(', ')}${skillHint}`,
          );
        }
      }
      break;
    }

    case 'update': {
      validateArgs('update', null, args.slice(1));
      const dryRun = args.includes('--dry-run');
      const localInstall = args.includes('--local');
      const globalInstall = args.includes('--global');
      commands.cmdUpdate(cwd, {
        dryRun,
        local: localInstall,
        global: globalInstall,
      });
      break;
    }

    case 'scaffold': {
      validateArgs('scaffold', null, args.slice(1));
      const scaffoldType = args[1];
      const phaseIndex = args.indexOf('--phase');
      const nameIndex = args.indexOf('--name');
      const scaffoldOptions = {
        phase: phaseIndex !== -1 ? args[phaseIndex + 1] : null,
        name: nameIndex !== -1 ? args.slice(nameIndex + 1).join(' ') : null,
      };
      commands.cmdScaffold(cwd, scaffoldType, scaffoldOptions);
      break;
    }

    case 'init': {
      const workflow = args[1];
      validateArgs('init', workflow, args.slice(2));
      switch (workflow) {
        case 'execute-phase':
          init.cmdInitExecutePhase(cwd, args[2]);
          break;
        case 'plan-phase':
          init.cmdInitPlanPhase(cwd, args[2]);
          break;
        case 'new-project':
          init.cmdInitNewProject(cwd);
          break;
        case 'new-milestone':
          init.cmdInitNewMilestone(cwd);
          break;
        case 'quick': {
          const verifyFlagIdx = args.indexOf('--verify');
          const verifyMode = verifyFlagIdx !== -1;
          // Remove --verify from args before joining as description
          const descArgs = args
            .slice(2)
            .filter((_, i) => i + 2 !== verifyFlagIdx);
          init.cmdInitQuick(cwd, descArgs.join(' '), verifyMode);
          break;
        }
        case 'resume':
          init.cmdInitResume(cwd);
          break;
        case 'verify-work':
          init.cmdInitVerifyWork(cwd, args[2]);
          break;
        case 'phase-op':
          init.cmdInitPhaseOp(cwd, args[2]);
          break;
        case 'todos':
          init.cmdInitTodos(cwd, args[2]);
          break;
        case 'milestone-op':
          init.cmdInitMilestoneOp(cwd);
          break;
        case 'map-codebase':
          init.cmdInitMapCodebase(cwd);
          break;
        case 'progress':
          init.cmdInitProgress(cwd);
          break;
        default: {
          const suggestions = workflow
            ? suggestSubcommand(workflow, 'init')
            : { sameNamespace: [], crossNamespace: [] };
          if (
            suggestions.sameNamespace.length > 0 ||
            suggestions.crossNamespace.length > 0
          ) {
            const parts = [];
            if (suggestions.sameNamespace.length > 0)
              parts.push(`init ${suggestions.sameNamespace[0]}`);
            if (suggestions.crossNamespace.length > 0)
              parts.push(...suggestions.crossNamespace.slice(0, 2));
            error(
              `Unknown init workflow '${workflow}'. Did you mean: ${parts.join(', ')}?\nAvailable: ${SUBCOMMANDS.init.join(', ')}`,
            );
          } else {
            error(
              `Unknown init workflow '${workflow}'. Available: ${SUBCOMMANDS.init.join(', ')}`,
            );
          }
        }
      }
      break;
    }

    case 'phase-plan-index': {
      phase.cmdPhasePlanIndex(cwd, args[1]);
      break;
    }

    case 'state-snapshot': {
      validateArgs('state-snapshot', null, args.slice(1));
      const currentFilter = args.includes('--current');
      let phaseForFilter = null;
      if (currentFilter) {
        const statePath = path.join(cwd, '.planning', 'STATE.md');
        try {
          const stateContent = fs.readFileSync(statePath, 'utf-8');
          const fmMatch = stateContent.match(/^---\n([\s\S]*?)\n---/);
          if (fmMatch) {
            const cpMatch = fmMatch[1].match(/^current_phase:\s*(.+)$/m);
            if (cpMatch)
              phaseForFilter = cpMatch[1].trim().replace(/['"]/g, '');
          }
        } catch {}
      }
      state.cmdStateSnapshot(cwd, phaseForFilter);
      break;
    }

    case 'summary-extract': {
      validateArgs('summary-extract', null, args.slice(1));
      const summaryPath = args[1];
      const fieldsIndex = args.indexOf('--fields');
      const fields =
        fieldsIndex !== -1 ? args[fieldsIndex + 1].split(',') : null;
      const seDefaultIdx = args.indexOf('--default');
      const seDefaultValue =
        seDefaultIdx !== -1 ? args[seDefaultIdx + 1] : undefined;
      commands.cmdSummaryExtract(cwd, summaryPath, fields, seDefaultValue);
      break;
    }

    case 'detect-platform': {
      validateArgs('detect-platform', null, args.slice(1));
      // Support --field <name> for scalar extraction (e.g. detect-platform --field platform)
      const dpFieldIdx = args.indexOf('--field');
      const dpField = dpFieldIdx !== -1 ? args[dpFieldIdx + 1] : null;
      // Use the first non-flag positional argument as the remote name
      const dpRemoteArg = args[1] && !args[1].startsWith('--') ? args[1] : null;
      if (dpField) {
        // silent=true: returns result without calling output()/process.exit()
        const dpResult = commands.cmdDetectPlatform(cwd, dpRemoteArg, true);
        if (dpResult && dpResult[dpField] !== undefined) {
          coreOutput(dpResult[dpField]);
        }
        process.exit(0);
      }
      commands.cmdDetectPlatform(cwd, dpRemoteArg);
      break;
    }

    case 'detect-workspace': {
      validateArgs('detect-workspace', null, args.slice(1));
      // Support --field <name> for scalar extraction
      const dwFieldIdx = args.indexOf('--field');
      const dwField = dwFieldIdx !== -1 ? args[dwFieldIdx + 1] : null;
      if (dwField) {
        const dwResult = workspace.cmdDetectWorkspace(cwd, true);
        if (dwResult && dwResult[dwField] !== undefined) {
          coreOutput(dwResult[dwField]);
        }
        process.exit(0);
      }
      workspace.cmdDetectWorkspace(cwd);
      break;
    }

    case 'git-context': {
      validateArgs('git-context', null, args.slice(1));
      // Support --field <name> for scalar extraction
      const gcFieldIdx = args.indexOf('--field');
      const gcField = gcFieldIdx !== -1 ? args[gcFieldIdx + 1] : null;
      if (gcField) {
        const gcResult = workspace.cmdGitContext(cwd, true);
        if (gcResult && gcResult[gcField] !== undefined) {
          coreOutput(gcResult[gcField]);
        }
        process.exit(0);
      }
      workspace.cmdGitContext(cwd);
      break;
    }

    case 'ssh-check': {
      validateArgs('ssh-check', null, args.slice(1));
      const sshUrl = args[1] && !args[1].startsWith('--') ? args[1] : '';
      // Support --field <name> for scalar extraction
      const scFieldIdx = args.indexOf('--field');
      const scField = scFieldIdx !== -1 ? args[scFieldIdx + 1] : null;
      if (scField) {
        const scResult = workspace.cmdSshCheck(sshUrl, true);
        if (scResult && scResult[scField] !== undefined) {
          coreOutput(scResult[scField]);
        }
        process.exit(0);
      }
      workspace.cmdSshCheck(sshUrl);
      break;
    }

    case 'discover-test-command': {
      const result = commands.discoverTestCommand(cwd);
      coreOutput(result);
      break;
    }

    case 'websearch': {
      validateArgs('websearch', null, args.slice(1));
      const query = args[1];
      const limitIdx = args.indexOf('--limit');
      const freshnessIdx = args.indexOf('--freshness');
      await commands.cmdWebsearch(query, {
        limit: limitIdx !== -1 ? parseInt(args[limitIdx + 1], 10) : 10,
        freshness: freshnessIdx !== -1 ? args[freshnessIdx + 1] : null,
      });
      break;
    }

    case 'squash': {
      validateArgs('squash', null, args.slice(1));
      const listBackupTags = args.includes('--list-backup-tags');
      const phase = listBackupTags ? null : args[1];
      const dryRun = args.includes('--dry-run');
      const allowStable = args.includes('--allow-stable');
      const strategyIdx = args.indexOf('--strategy');
      const strategy = strategyIdx >= 0 ? args[strategyIdx + 1] : null;
      commands.cmdSquash(cwd, phase, {
        strategy,
        dryRun,
        allowStable,
        listBackupTags,
      });
      break;
    }

    case 'version-bump': {
      validateArgs('version-bump', null, args.slice(1));
      const levelIdx = args.indexOf('--level');
      const schemeIdx = args.indexOf('--scheme');
      const snapshot = args.includes('--snapshot');
      const vbFieldIdx = args.indexOf('--field');
      const vbField = vbFieldIdx !== -1 ? args[vbFieldIdx + 1] : null;
      if (vbField) {
        // silent=true: returns result without calling output()/process.exit()
        const vbResult = commands.cmdVersionBump(
          cwd,
          {
            level: levelIdx >= 0 ? args[levelIdx + 1] : null,
            scheme: schemeIdx >= 0 ? args[schemeIdx + 1] : null,
            snapshot,
          },
          true,
        );
        if (vbResult && vbResult[vbField] !== undefined) {
          coreOutput(vbResult[vbField]);
        }
        process.exit(0);
      }
      commands.cmdVersionBump(cwd, {
        level: levelIdx >= 0 ? args[levelIdx + 1] : null,
        scheme: schemeIdx >= 0 ? args[schemeIdx + 1] : null,
        snapshot,
      });
      break;
    }

    case 'generate-changelog': {
      validateArgs('generate-changelog', null, args.slice(1));
      const version = args[1];
      const dateIdx = args.indexOf('--date');
      commands.cmdGenerateChangelog(cwd, version, {
        date: dateIdx >= 0 ? args[dateIdx + 1] : null,
      });
      break;
    }

    case 'generate-allowlist': {
      const platformIdx = args.indexOf('--platform');
      const platformFlag = platformIdx >= 0 ? args[platformIdx + 1] : undefined;
      commands.cmdGenerateAllowlist(cwd, platformFlag || process.platform);
      break;
    }

    case 'resolve-type-alias': {
      // Resolve a short commit type to its branch prefix alias using git.type_aliases config.
      // Usage: gsd-tools resolve-type-alias feat
      const typeArg = args[1] || 'feat';
      const resolvedAlias = resolveTypeAlias(typeArg, readTypeAliases(cwd));
      coreOutput({ type: typeArg, alias: resolvedAlias }, resolvedAlias);
      break;
    }

    case 'issue-import': {
      validateArgs('issue-import', null, args.slice(1));
      const platform = args[1];
      const number = args[2];
      const repoIdx = args.indexOf('--repo');
      const repo = repoIdx >= 0 ? args[repoIdx + 1] : null;
      commands.cmdIssueImport(cwd, platform, number, repo);
      break;
    }

    case 'issue-sync': {
      validateArgs('issue-sync', null, args.slice(1));
      const phase = args[1] || null;
      const auto = args.includes('--auto');
      commands.cmdIssueSync(cwd, phase, { auto });
      break;
    }

    case 'issue-list-refs': {
      commands.cmdIssueListRefs(cwd);
      break;
    }

    case 'divergence': {
      validateArgs('divergence', null, args.slice(1));
      const refreshFlag = args.includes('--refresh');
      const initFlag = args.includes('--init');
      const triageIdx = args.indexOf('--triage');
      const statusIdx = args.indexOf('--status');
      const reasonIdx = args.indexOf('--reason');
      const branchIdx = args.indexOf('--branch');
      const baseIdx = args.indexOf('--base');
      const remoteIdx = args.indexOf('--remote');
      const remoteBranchIdx = args.indexOf('--remote-branch');
      const opts = {
        refresh: refreshFlag,
        init: initFlag,
        triage: triageIdx !== -1 ? args[triageIdx + 1] : null,
        status: statusIdx !== -1 ? args[statusIdx + 1] : null,
        reason: reasonIdx !== -1 ? args.slice(reasonIdx + 1).join(' ') : null,
        branch: branchIdx !== -1 ? args[branchIdx + 1] : null,
        base: baseIdx !== -1 ? args[baseIdx + 1] : null,
        remote: remoteIdx !== -1 ? args[remoteIdx + 1] : null,
        remoteBranch: remoteBranchIdx !== -1 ? args[remoteBranchIdx + 1] : null,
      };
      commands.cmdDivergence(cwd, opts);
      break;
    }

    case 'pingpong-check': {
      validateArgs('pingpong-check', null, args.slice(1));
      const windowIdx = args.indexOf('--window');
      commands.cmdPingpongCheck(
        cwd,
        windowIdx !== -1 ? ['--window', args[windowIdx + 1]] : [],
      );
      break;
    }

    case 'breakout-check': {
      validateArgs('breakout-check', null, args.slice(1));
      const planIdx = args.indexOf('--plan');
      const filesIdx = args.indexOf('--declared-files');
      const checkArgs = [];
      if (planIdx !== -1) {
        checkArgs.push('--plan', args[planIdx + 1]);
      }
      if (filesIdx !== -1) {
        checkArgs.push('--declared-files', args[filesIdx + 1]);
      }
      commands.cmdBreakoutCheck(cwd, checkArgs);
      break;
    }

    case 'cleanup': {
      validateArgs('cleanup', null, args.slice(1));
      const dryRun = args.includes('--dry-run');
      commands.cmdCleanup(cwd, { dryRun });
      break;
    }

    case 'help':
      commands.cmdHelp(cwd, args.slice(1));
      break;

    case '--help':
    case '-h':
      printHelp();
      break;

    case 'guard': {
      const subcommand = args[1];
      validateArgs('guard', subcommand, args.slice(2));
      if (subcommand === 'sync-chain') {
        guard.cmdGuardSyncChain(cwd, args.slice(2).join(' '));
      } else if (subcommand === 'init-valid') {
        guard.cmdGuardInitValid(args[2]);
      } else {
        const suggestions = suggestSubcommand(subcommand, 'guard');
        if (
          suggestions.sameNamespace.length > 0 ||
          suggestions.crossNamespace.length > 0
        ) {
          const parts = [];
          if (suggestions.sameNamespace.length > 0)
            parts.push(`guard ${suggestions.sameNamespace[0]}`);
          if (suggestions.crossNamespace.length > 0)
            parts.push(...suggestions.crossNamespace.slice(0, 2));
          error(
            `Unknown guard subcommand '${subcommand}'. Did you mean: ${parts.join(', ')}?\nAvailable: ${SUBCOMMANDS.guard.join(', ')}`,
          );
        } else {
          error(
            `Unknown guard subcommand '${subcommand}'. Available: ${SUBCOMMANDS.guard.join(', ')}`,
          );
        }
      }
      break;
    }

    default: {
      // Typo detection: suggest close matches using Levenshtein distance
      const candidates = ALL_COMMANDS.map((cmd) => ({
        cmd,
        dist: levenshtein(command, cmd),
      }))
        .filter((c) => c.dist <= 2 && c.dist < Math.ceil(c.cmd.length / 2))
        .sort((a, b) => a.dist - b.dist);

      if (candidates.length > 0) {
        const suggestions = candidates.map((c) => c.cmd).join(', ');
        error(`Unknown command '${command}'. Did you mean: ${suggestions}?`);
      } else {
        error(
          `Unknown command '${command}'. Available commands: ${ALL_COMMANDS.join(', ')}`,
        );
      }
    }
  }
}

/**
 * Extract a field from an object using dot-notation and bracket syntax.
 * Supports: 'field', 'parent.child', 'arr[-1]', 'arr[0]'
 */
function extractField(obj, fieldPath) {
  const parts = fieldPath.split('.');
  let current = obj;
  for (const part of parts) {
    if (current === null || current === undefined) return undefined;
    const bracketMatch = part.match(/^(.+?)\[(-?\d+)]$/);
    if (bracketMatch) {
      const key = bracketMatch[1];
      const index = parseInt(bracketMatch[2], 10);
      current = current[key];
      if (!Array.isArray(current)) return undefined;
      current = index < 0 ? current[current.length + index] : current[index];
    } else {
      current = current[part];
    }
  }
  return current;
}

// Capture pickField before main() runs so the .then() closure can access it.
// main() sets pickField as a local — we need it for the post-run extraction.
// Re-parse --pick from argv here (main() hasn't spliced it yet at module scope).
const _pickFieldForPostRun = (() => {
  const i = process.argv.indexOf('--pick');
  return i !== -1 ? process.argv[i + 1] : null;
})();

main()
  .then(() => {
    if (_pickFieldForPostRun && _pickStdoutChunks.length > 0) {
      // Normal success path: output() wrote via fs.writeSync interception; process.exit not called.
      // Restore originals first, then extract and write the requested field to real stdout.
      if (_origFsWriteSync) fs.writeSync = _origFsWriteSync;
      if (_origStdoutWrite) process.stdout.write = _origStdoutWrite;

      let captured = _pickStdoutChunks.join('');
      if (captured.startsWith('@file:')) {
        try {
          captured = fs.readFileSync(captured.slice(6), 'utf-8');
        } catch {
          /* keep as-is */
        }
      }
      try {
        const obj = JSON.parse(captured);
        const value = extractField(obj, _pickFieldForPostRun);
        const result =
          value === null || value === undefined ? '' : String(value);
        process.stdout.write(result);
      } catch {
        process.stdout.write(captured);
      }
    }
  })
  .catch((err) => {
    process.stderr.write((err && err.message) || String(err));
    process.exit(1);
  });
