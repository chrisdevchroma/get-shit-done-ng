'use strict';

/**
 * Per-CLI subcommand mappings. Each CLI gets granular subcommand patterns
 * instead of blanket Bash(cli *) wildcards.
 *
 * Subcommand narrowing per platform:
 *   - gh repo:   view, list, clone, fork, create, sync, set-default (excludes delete, rename, edit, archive, etc.)
 *   - gh label:  list, create, clone                                (excludes delete, edit)
 *   - glab:      mirrors gh minus missing verbs (no sync/set-default; no label clone)
 *   - fj:        mirrors gh minus missing verbs (no repo list; NO label subcommand exists at all — corrects historical drift)
 *   - tea:       mirrors gh minus missing verbs (no repo view, no repo clone; retains 'repos'/'labels' plural aliases)
 *
 * Existing users keep their broader Bash(<cli> repo *) / Bash(<cli> label *) entries
 * until the manifest migration mechanism delivers granular narrowing.
 *
 * Multi-word entries (e.g. 'repo view') are emitted by getPlatformCliPatterns
 * as literal Bash(gh repo view *) / Bash(gh repo view) permission rules — the
 * template literal handles multi-word tokens via string substitution with no
 * splitting or quoting.
 *
 * NOT allowlisted: gh api, glab api (fall through to prompting),
 *                  gh extension (arbitrary code execution risk),
 *                  ssh-key, gpg-key, config (account-modifying),
 *                  any repo/label delete/rename/edit/archive verb.
 */
const CLI_SUBCOMMANDS = {
  gh: [
    'pr',
    'issue',
    'release',
    'workflow',
    'auth',
    'search',
    'run',
    'status',
    'repo view',
    'repo list',
    'repo clone',
    'repo fork',
    'repo create',
    'repo sync',
    'repo set-default',
    'label list',
    'label create',
    'label clone',
  ],
  glab: [
    'mr',
    'issue',
    'release',
    'ci',
    'auth',
    'repo view',
    'repo list',
    'repo clone',
    'repo fork',
    'repo create',
    'label list',
    'label create',
  ],
  fj: [
    'pr',
    'issue',
    'release',
    'actions',
    'auth',
    'repo view',
    'repo clone',
    'repo fork',
    'repo create',
    // NOTE: fj has no 'label' subcommand — intentionally empty (no label support in this CLI)
  ],
  tea: [
    'pr',
    'pulls',
    'issue',
    'issues',
    'release',
    'releases',
    'login',
    'actions',
    'repo list',
    'repo create',
    'repo fork',
    'label list',
    'label create',
    'repos',
    'labels', // retained plural aliases (broad) — candidate to narrow when manifest migration lands
  ],
};

/**
 * Get granular permission patterns for a platform CLI.
 * Returns both glob form Bash(cli sub *) and exact form Bash(cli sub)
 * so that zero-arg commands are also covered.
 *
 * @param {string} cli - CLI binary name: 'gh', 'glab', 'fj', or 'tea'
 * @returns {string[]} Array of Bash() permission patterns
 */
function getPlatformCliPatterns(cli) {
  const subs = CLI_SUBCOMMANDS[cli];
  if (!subs) return [];
  const patterns = [];
  for (const sub of subs) {
    patterns.push(`Bash(${cli} ${sub} *)`);
    patterns.push(`Bash(${cli} ${sub})`);
  }
  return patterns;
}

/**
 * Get all granular patterns for all platform CLIs.
 * @returns {{ [cli: string]: string[] }}
 */
function getAllPlatformCliPatterns() {
  const result = {};
  for (const cli of Object.keys(CLI_SUBCOMMANDS)) {
    result[cli] = getPlatformCliPatterns(cli);
  }
  return result;
}

/**
 * Platform name to CLI binary mapping.
 * Matches PLATFORM_CLI in commands.cjs.
 */
const PLATFORM_TO_CLI = {
  github: 'gh',
  gitlab: 'glab',
  forgejo: 'fj',
  gitea: 'tea',
};

/**
 * RW_FORMS — canonical Read/Edit/Write permission forms — both bare and glob.
 * Exported as a frozen Set so install.js and commands.cjs can strip these
 * from template entries before injecting the platform-appropriate form.
 * Single source of truth for Read/Edit/Write permission forms.
 */
const RW_FORMS = Object.freeze(
  new Set(['Edit', 'Write', 'Read', 'Edit(*)', 'Write(*)', 'Read(*)']),
);

/**
 * Return the Read/Edit/Write allow entries appropriate for the target platform.
 *
 * - Linux → bare forms ['Edit', 'Write', 'Read']
 *   Workaround for anthropics/claude-code #16170 and #6881: the Linux
 *   permission engine mishandles certain glob-qualified permission rules
 *   (Edit(*), Write(*), Read(*)) and produces startup warnings or
 *   unexpected prompts. Bare forms are the stable Linux workaround.
 *
 * - darwin / win32 / unknown → glob forms ['Edit(*)', 'Read(*)']
 *   `Write(*)` is absent because it is an unmatched path form — see
 *   normalizePermissionRules below. Windows mirrors macOS pending CC Windows
 *   permission engine research (TODO: revisit if CC behavior is confirmed).
 *
 * Pure function — no I/O, no module state. Returns a fresh array on every
 * call so callers can mutate without leaking into shared state.
 *
 * @param {string} platform  process.platform value ('linux', 'darwin', 'win32', ...)
 * @returns {string[]}       array of permission rule strings
 */
function getReadEditWriteAllowRules(platform) {
  if (platform === 'linux') {
    return ['Edit', 'Write', 'Read'];
  }
  return ['Edit(*)', 'Read(*)'];
}

/**
 * Matches a permission rule written in one of Claude Code's *unmatched path
 * forms* — a tool name that takes no part in file permission checks, carrying
 * a non-empty path argument. Capture 1 is the tool name, capture 2 the path.
 *
 * The argument is deliberately required to be non-empty. A BARE tool-name rule
 * (`Write`, `Glob`) is a different and entirely valid construct: it matches the
 * tool everywhere and produces no warning, so it must never be rewritten or
 * reported. Only the `Tool(path)` spelling is defective.
 */
const UNMATCHED_PATH_RULE_RE = /^(Write|NotebookEdit|Glob)\((.+)\)$/;

/**
 * The effective rule each unmatched path form must be rewritten to.
 * Per the permissions docs: use `Edit(path)` in place of `Write(path)` or
 * `NotebookEdit(path)`, and `Read(path)` in place of `Glob(path)`.
 */
const UNMATCHED_PATH_RULE_TARGET = {
  Write: 'Edit',
  NotebookEdit: 'Edit',
  Glob: 'Read',
};

/**
 * Normalise a permissions list so its file-path rules actually fire.
 *
 * Claude Code's file permission checks match only `Edit(path)` and `Read(path)`
 * rules. A `Write(path)`, `NotebookEdit(path)` or `Glob(path)` rule is accepted
 * by the settings parser but never matched by those checks — and since v2.1.210
 * Claude Code warns at startup for every allow, deny *or* ask rule in one of
 * these forms. `Edit(path)` is the effective spelling for any file-editing tool
 * (one `Edit` rule governs Edit, Write and NotebookEdit alike); `Read(path)` is
 * the effective spelling for `Glob(path)`.
 *
 * Each unmatched path form is down-converted to its effective equivalent and the
 * result de-duplicated in first-seen order, which also collapses the
 * `Edit(.env)` + `Write(.env)` pair pattern into the one rule that fires.
 *
 * Two categories pass through untouched:
 *   - BARE tool-name rules (`Write`, `Read`, `Edit`, `Glob`) — notably the Linux
 *     allow forms emitted by getReadEditWriteAllowRules().
 *   - Rules for tools outside the file-permission path (`Bash(...)`,
 *     `Agent(*)`, ...). `Read(<path>)` in particular is a separate, genuinely
 *     enforced rule and must be kept alongside `Edit(<path>)` for secrets.
 *
 * Pure function — no I/O, no module state. Returns a fresh array.
 *
 * @param {string[]} entries  permission rules as authored (e.g. from a template)
 * @returns {string[]}        rules with unmatched path forms folded into effective ones
 */
function normalizePermissionRules(entries) {
  if (!Array.isArray(entries)) return [];
  const seen = new Set();
  const out = [];
  for (const entry of entries) {
    if (typeof entry !== 'string') continue;
    const match = UNMATCHED_PATH_RULE_RE.exec(entry);
    const normalized = match
      ? `${UNMATCHED_PATH_RULE_TARGET[match[1]]}(${match[2]})`
      : entry;
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

/**
 * Report which entries of a permissions list use an unmatched path form.
 *
 * Companion to normalizePermissionRules for assertion sites (template lint
 * tests, installer diagnostics) that want to *fail* on the mistake rather than
 * silently repair it. Returns the offending entries verbatim so a message can
 * quote them. Bare tool-name rules are correct and are never reported.
 *
 * @param {string[]} entries  permission rules to inspect
 * @returns {string[]}        the subset in an unmatched Tool(path) form
 */
function findUnmatchedPathRules(entries) {
  if (!Array.isArray(entries)) return [];
  return entries.filter(
    (e) => typeof e === 'string' && UNMATCHED_PATH_RULE_RE.test(e),
  );
}

module.exports = {
  CLI_SUBCOMMANDS,
  PLATFORM_TO_CLI,
  RW_FORMS,
  getPlatformCliPatterns,
  getAllPlatformCliPatterns,
  getReadEditWriteAllowRules,
  normalizePermissionRules,
  findUnmatchedPathRules,
};
