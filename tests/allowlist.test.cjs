'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const {
  getPlatformCliPatterns,
  getAllPlatformCliPatterns,
  getReadEditWriteAllowRules,
  CLI_SUBCOMMANDS,
  PLATFORM_TO_CLI,
  RW_FORMS,
  normalizePermissionRules,
  findUnmatchedPathRules,
} = require(path.resolve(__dirname, '..', 'gsd-ng', 'bin', 'lib', 'allowlist.cjs'));

// ── getPlatformCliPatterns('gh') returns patterns for all 18 narrowed subcommands (post-54.1) ──

describe('ALLOW-01: getPlatformCliPatterns(gh) returns patterns for all 18 narrowed subcommands (post-54.1)', () => {
  test('returns 36 patterns (2 per subcommand x 18 subcommands: 8 single-token + 7 repo two-token + 3 label two-token)', () => {
    const patterns = getPlatformCliPatterns('gh');
    assert.strictEqual(patterns.length, 36, 'Expected 36 patterns (2 per subcommand x 18 subcommands)');
  });

  test('includes Bash(gh pr *) and Bash(gh pr)', () => {
    const patterns = getPlatformCliPatterns('gh');
    assert.ok(patterns.includes('Bash(gh pr *)'), 'Missing Bash(gh pr *)');
    assert.ok(patterns.includes('Bash(gh pr)'), 'Missing Bash(gh pr)');
  });

  test('includes Bash(gh issue *) and Bash(gh issue)', () => {
    const patterns = getPlatformCliPatterns('gh');
    assert.ok(patterns.includes('Bash(gh issue *)'), 'Missing Bash(gh issue *)');
    assert.ok(patterns.includes('Bash(gh issue)'), 'Missing Bash(gh issue)');
  });

  test('includes Bash(gh release *) and Bash(gh release)', () => {
    const patterns = getPlatformCliPatterns('gh');
    assert.ok(patterns.includes('Bash(gh release *)'), 'Missing Bash(gh release *)');
    assert.ok(patterns.includes('Bash(gh release)'), 'Missing Bash(gh release)');
  });

  test('includes Bash(gh workflow *) and Bash(gh workflow)', () => {
    const patterns = getPlatformCliPatterns('gh');
    assert.ok(patterns.includes('Bash(gh workflow *)'), 'Missing Bash(gh workflow *)');
    assert.ok(patterns.includes('Bash(gh workflow)'), 'Missing Bash(gh workflow)');
  });

  test('includes Bash(gh auth *) and Bash(gh auth)', () => {
    const patterns = getPlatformCliPatterns('gh');
    assert.ok(patterns.includes('Bash(gh auth *)'), 'Missing Bash(gh auth *)');
    assert.ok(patterns.includes('Bash(gh auth)'), 'Missing Bash(gh auth)');
  });

  test('includes Bash(gh search *) and Bash(gh search)', () => {
    const patterns = getPlatformCliPatterns('gh');
    assert.ok(patterns.includes('Bash(gh search *)'), 'Missing Bash(gh search *)');
    assert.ok(patterns.includes('Bash(gh search)'), 'Missing Bash(gh search)');
  });

  test('includes Bash(gh run *) and Bash(gh run)', () => {
    const patterns = getPlatformCliPatterns('gh');
    assert.ok(patterns.includes('Bash(gh run *)'), 'Missing Bash(gh run *)');
    assert.ok(patterns.includes('Bash(gh run)'), 'Missing Bash(gh run)');
  });

  test('includes Bash(gh status *) and Bash(gh status)', () => {
    const patterns = getPlatformCliPatterns('gh');
    assert.ok(patterns.includes('Bash(gh status *)'), 'Missing Bash(gh status *)');
    assert.ok(patterns.includes('Bash(gh status)'), 'Missing Bash(gh status)');
  });
});

// ── getPlatformCliPatterns('gh') does NOT include api or extension ──

describe('ALLOW-02: getPlatformCliPatterns(gh) does NOT include api or extension', () => {
  test('does not include Bash(gh api *)', () => {
    const patterns = getPlatformCliPatterns('gh');
    assert.ok(!patterns.includes('Bash(gh api *)'), 'Must NOT include Bash(gh api *)');
  });

  test('does not include Bash(gh api)', () => {
    const patterns = getPlatformCliPatterns('gh');
    assert.ok(!patterns.includes('Bash(gh api)'), 'Must NOT include Bash(gh api)');
  });

  test('does not include Bash(gh extension *)', () => {
    const patterns = getPlatformCliPatterns('gh');
    assert.ok(!patterns.includes('Bash(gh extension *)'), 'Must NOT include Bash(gh extension *)');
  });
});

// ── getPlatformCliPatterns('tea') returns patterns for both canonical and alias forms ──

describe('ALLOW-03: getPlatformCliPatterns(tea) returns patterns for canonical and alias forms', () => {
  test('includes Bash(tea pr *) canonical form', () => {
    const patterns = getPlatformCliPatterns('tea');
    assert.ok(patterns.includes('Bash(tea pr *)'), 'Missing Bash(tea pr *)');
    assert.ok(patterns.includes('Bash(tea pr)'), 'Missing Bash(tea pr)');
  });

  test('includes Bash(tea pulls *) alias form', () => {
    const patterns = getPlatformCliPatterns('tea');
    assert.ok(patterns.includes('Bash(tea pulls *)'), 'Missing Bash(tea pulls *)');
    assert.ok(patterns.includes('Bash(tea pulls)'), 'Missing Bash(tea pulls)');
  });

  test('includes Bash(tea issue *) canonical form', () => {
    const patterns = getPlatformCliPatterns('tea');
    assert.ok(patterns.includes('Bash(tea issue *)'), 'Missing Bash(tea issue *)');
  });

  test('includes Bash(tea issues *) alias form', () => {
    const patterns = getPlatformCliPatterns('tea');
    assert.ok(patterns.includes('Bash(tea issues *)'), 'Missing Bash(tea issues *)');
  });

  test('includes Bash(tea release *) canonical form', () => {
    const patterns = getPlatformCliPatterns('tea');
    assert.ok(patterns.includes('Bash(tea release *)'), 'Missing Bash(tea release *)');
  });

  test('includes Bash(tea releases *) alias form', () => {
    const patterns = getPlatformCliPatterns('tea');
    assert.ok(patterns.includes('Bash(tea releases *)'), 'Missing Bash(tea releases *)');
  });

  test('includes narrowed two-token tea repo forms (post-54.1: no bare tea repo * — use repo list/create/fork)', () => {
    const patterns = getPlatformCliPatterns('tea');
    // bare Bash(tea repo *) is gone — narrowed to two-token verbs
    assert.ok(!patterns.includes('Bash(tea repo *)'), 'Broad Bash(tea repo *) must NOT be present post-narrowing');
    assert.ok(patterns.includes('Bash(tea repo list *)'), 'Missing Bash(tea repo list *)');
    assert.ok(patterns.includes('Bash(tea repo create *)'), 'Missing Bash(tea repo create *)');
    assert.ok(patterns.includes('Bash(tea repo fork *)'), 'Missing Bash(tea repo fork *)');
  });

  test('includes Bash(tea repos *) alias form', () => {
    const patterns = getPlatformCliPatterns('tea');
    assert.ok(patterns.includes('Bash(tea repos *)'), 'Missing Bash(tea repos *)');
  });

  test('includes Bash(tea login *) and Bash(tea login)', () => {
    const patterns = getPlatformCliPatterns('tea');
    assert.ok(patterns.includes('Bash(tea login *)'), 'Missing Bash(tea login *)');
    assert.ok(patterns.includes('Bash(tea login)'), 'Missing Bash(tea login)');
  });
});

// ── getPlatformCliPatterns('unknown') returns empty array ──

describe('ALLOW-04: getPlatformCliPatterns(unknown) returns empty array', () => {
  test('returns empty array for unknown CLI', () => {
    const patterns = getPlatformCliPatterns('unknown');
    assert.ok(Array.isArray(patterns), 'Result must be an array');
    assert.strictEqual(patterns.length, 0, 'Result must be empty for unknown CLI');
  });

  test('returns empty array for empty string', () => {
    const patterns = getPlatformCliPatterns('');
    assert.ok(Array.isArray(patterns), 'Result must be an array');
    assert.strictEqual(patterns.length, 0, 'Result must be empty for empty string');
  });
});

// ── getAllPlatformCliPatterns returns object with keys for all 4 CLIs ──

describe('ALLOW-05: getAllPlatformCliPatterns returns object with keys for all 4 CLIs', () => {
  test('returns object with gh, glab, fj, tea keys', () => {
    const all = getAllPlatformCliPatterns();
    assert.ok(typeof all === 'object' && all !== null, 'Result must be an object');
    assert.ok('gh' in all, 'Must have gh key');
    assert.ok('glab' in all, 'Must have glab key');
    assert.ok('fj' in all, 'Must have fj key');
    assert.ok('tea' in all, 'Must have tea key');
  });

  test('each value is a non-empty array of strings', () => {
    const all = getAllPlatformCliPatterns();
    for (const [cli, patterns] of Object.entries(all)) {
      assert.ok(Array.isArray(patterns), `${cli} patterns must be an array`);
      assert.ok(patterns.length > 0, `${cli} must have at least one pattern`);
    }
  });
});

// ── PLATFORM_TO_CLI maps platform names to CLI binaries ──

describe('ALLOW-06: PLATFORM_TO_CLI maps platform names to CLI binaries', () => {
  test('github maps to gh', () => {
    assert.strictEqual(PLATFORM_TO_CLI['github'], 'gh');
  });

  test('gitlab maps to glab', () => {
    assert.strictEqual(PLATFORM_TO_CLI['gitlab'], 'glab');
  });

  test('forgejo maps to fj', () => {
    assert.strictEqual(PLATFORM_TO_CLI['forgejo'], 'fj');
  });

  test('gitea maps to tea', () => {
    assert.strictEqual(PLATFORM_TO_CLI['gitea'], 'tea');
  });
});

// ── every pattern starts with 'Bash(' and ends with ')' ──

describe('ALLOW-07: every pattern starts with Bash( and ends with )', () => {
  test('all gh patterns have correct format', () => {
    const patterns = getPlatformCliPatterns('gh');
    for (const p of patterns) {
      assert.ok(p.startsWith('Bash('), `Pattern "${p}" must start with Bash(`);
      assert.ok(p.endsWith(')'), `Pattern "${p}" must end with )`);
    }
  });

  test('all glab patterns have correct format', () => {
    const patterns = getPlatformCliPatterns('glab');
    for (const p of patterns) {
      assert.ok(p.startsWith('Bash('), `Pattern "${p}" must start with Bash(`);
      assert.ok(p.endsWith(')'), `Pattern "${p}" must end with )`);
    }
  });

  test('all fj patterns have correct format', () => {
    const patterns = getPlatformCliPatterns('fj');
    for (const p of patterns) {
      assert.ok(p.startsWith('Bash('), `Pattern "${p}" must start with Bash(`);
      assert.ok(p.endsWith(')'), `Pattern "${p}" must end with )`);
    }
  });

  test('all tea patterns have correct format', () => {
    const patterns = getPlatformCliPatterns('tea');
    for (const p of patterns) {
      assert.ok(p.startsWith('Bash('), `Pattern "${p}" must start with Bash(`);
      assert.ok(p.endsWith(')'), `Pattern "${p}" must end with )`);
    }
  });

  test('getAllPlatformCliPatterns all entries have correct format', () => {
    const all = getAllPlatformCliPatterns();
    for (const [cli, patterns] of Object.entries(all)) {
      for (const p of patterns) {
        assert.ok(p.startsWith('Bash('), `${cli} pattern "${p}" must start with Bash(`);
        assert.ok(p.endsWith(')'), `${cli} pattern "${p}" must end with )`);
      }
    }
  });
});

// ── CLI_SUBCOMMANDS narrowed verbs (post-54.1) ──

describe('ALLOW-14+ALLOW-21+ALLOW-22: CLI_SUBCOMMANDS narrowed verbs (post-54.1)', () => {
  test('gh has 18 subcommands: 8 single-token + 7 repo two-token + 3 label two-token', () => {
    assert.strictEqual(CLI_SUBCOMMANDS.gh.length, 18);
    assert.ok(CLI_SUBCOMMANDS.gh.includes('run'));
    assert.ok(CLI_SUBCOMMANDS.gh.includes('status'));
    assert.ok(CLI_SUBCOMMANDS.gh.includes('search'));
    assert.ok(!CLI_SUBCOMMANDS.gh.includes('repo'), 'bare repo removed (narrowed)');
    assert.ok(!CLI_SUBCOMMANDS.gh.includes('label'), 'bare label removed (narrowed)');
  });
  test('glab has narrowed verbs mirroring gh minus missing', () => {
    assert.ok(!CLI_SUBCOMMANDS.glab.includes('repo'), 'glab bare repo removed');
    assert.ok(!CLI_SUBCOMMANDS.glab.includes('label'), 'glab bare label removed');
    assert.ok(CLI_SUBCOMMANDS.glab.includes('repo view'));
    assert.ok(CLI_SUBCOMMANDS.glab.includes('label create'));
    assert.ok(!CLI_SUBCOMMANDS.glab.includes('repo sync'), 'glab has no sync');
    assert.ok(!CLI_SUBCOMMANDS.glab.includes('label clone'), 'glab has no label-clone');
  });
  test('fj has no label subcommand (corrects Phase 54 ALLOW-14 drift — fj has no label CLI command)', () => {
    assert.ok(!CLI_SUBCOMMANDS.fj.includes('label'), 'fj bare label removed');
    assert.ok(!CLI_SUBCOMMANDS.fj.some(s => s.startsWith('label')), 'fj has NO label-prefixed entry of any form');
    assert.ok(!CLI_SUBCOMMANDS.fj.includes('repo list'), 'fj repo has no list verb');
    assert.ok(CLI_SUBCOMMANDS.fj.includes('repo view'));
  });
  test('tea retains plural aliases alongside narrowed two-token verbs', () => {
    assert.ok(CLI_SUBCOMMANDS.tea.includes('repos'), 'tea retains repos plural alias');
    assert.ok(CLI_SUBCOMMANDS.tea.includes('labels'), 'tea retains labels plural alias');
    assert.ok(CLI_SUBCOMMANDS.tea.includes('repo list'));
    assert.ok(CLI_SUBCOMMANDS.tea.includes('label create'));
    assert.ok(!CLI_SUBCOMMANDS.tea.includes('repo view'), 'tea has no view verb');
    assert.ok(!CLI_SUBCOMMANDS.tea.includes('repo clone'), 'tea has no clone verb');
  });
  test('gh run stays broad (Bash(gh run *) auto-approved — no narrowing to list/view/watch)', () => {
    const patterns = getPlatformCliPatterns('gh');
    assert.ok(patterns.includes('Bash(gh run *)'), 'broad Bash(gh run *) expected');
    assert.ok(!patterns.includes('Bash(gh run list *)'), 'narrow run list form must not leak in');
  });
  test('broad Bash(gh repo *) and Bash(gh label *) narrowed away (flipped from Phase 54)', () => {
    const patterns = getPlatformCliPatterns('gh');
    assert.ok(!patterns.includes('Bash(gh repo *)'), 'broad Bash(gh repo *) MUST be absent post-narrowing');
    assert.ok(!patterns.includes('Bash(gh label *)'), 'broad Bash(gh label *) MUST be absent post-narrowing');
    assert.ok(patterns.includes('Bash(gh repo view *)'), 'narrowed Bash(gh repo view *) present');
    assert.ok(patterns.includes('Bash(gh label create *)'), 'narrowed Bash(gh label create *) present');
  });
});

// ── getReadEditWriteAllowRules('linux') returns bare forms ──

describe('ALLOW-04: getReadEditWriteAllowRules(linux) returns bare forms', () => {
  test('returns [Edit, Write, Read] in that order', () => {
    assert.deepStrictEqual(getReadEditWriteAllowRules('linux'), ['Edit', 'Write', 'Read']);
  });
  // Bare Write is a working rule, not an unmatched form: a tool-name rule with
  // no path matches its tool everywhere and produces no startup warning. It is
  // kept on Linux rather than folded into bare Edit — see the function docblock.
  test('bare Write is retained on Linux and survives normalization untouched', () => {
    const rules = getReadEditWriteAllowRules('linux');
    assert.ok(rules.includes('Write'), 'Linux must keep the effective bare Write allow rule');
    assert.deepStrictEqual(normalizePermissionRules(rules), rules,
      'bare forms must pass through normalization unchanged');
    assert.deepStrictEqual(findUnmatchedPathRules(rules), [],
      'bare forms must never be reported as unmatched');
  });
});

// ── getReadEditWriteAllowRules(darwin/win32) returns glob forms, minus Write(*) ──
//
// Write(*) is an unmatched path form — file permission checks consult only
// Edit(path)/Read(path), so it never matches and (CC >= 2.1.210) costs a startup
// warning on every macOS/Windows install. Edit(*) governs every built-in
// file-editing tool, so dropping Write(*) moves the grant rather than removing it.

describe('ALLOW-05: getReadEditWriteAllowRules(darwin) returns glob forms without Write(*)', () => {
  test('darwin returns [Edit(*), Read(*)]', () => {
    assert.deepStrictEqual(getReadEditWriteAllowRules('darwin'), ['Edit(*)', 'Read(*)']);
  });
  test('win32 mirrors darwin pending CC Win32 research', () => {
    assert.deepStrictEqual(getReadEditWriteAllowRules('win32'), ['Edit(*)', 'Read(*)']);
  });
  test('unknown platform string defaults to the darwin form', () => {
    assert.deepStrictEqual(getReadEditWriteAllowRules('freebsd'), ['Edit(*)', 'Read(*)']);
  });
  test('no platform emits an unmatched path form', () => {
    for (const platform of ['linux', 'darwin', 'win32', 'freebsd']) {
      assert.deepStrictEqual(
        findUnmatchedPathRules(getReadEditWriteAllowRules(platform)), [],
        `${platform} must not emit an unmatched Tool(path) allow rule`,
      );
    }
  });
});

// ── getReadEditWriteAllowRules is pure (no I/O, fresh array each call) ──

describe('ALLOW-06: getReadEditWriteAllowRules is a pure function', () => {
  test('exported as a function from allowlist.cjs', () => {
    assert.strictEqual(typeof getReadEditWriteAllowRules, 'function');
  });
  test('returns fresh array on each call (callers can mutate without leaking into module state)', () => {
    const a = getReadEditWriteAllowRules('linux');
    const b = getReadEditWriteAllowRules('linux');
    assert.deepStrictEqual(a, b);
    assert.notStrictEqual(a, b, 'Each call must return a new array instance');
  });
});

// ── gh label narrowing + glab/fj/tea mirrors ──

describe('ALLOW-21: gh label narrowed — no bare label entry; two-token verbs present', () => {
  test('gh has no bare label entry', () => {
    assert.ok(!CLI_SUBCOMMANDS.gh.includes('label'), 'gh must NOT have bare label entry — use label list/create/clone');
  });
  test('gh has label list, label create, label clone two-token entries', () => {
    assert.ok(CLI_SUBCOMMANDS.gh.includes('label list'), 'gh must include label list');
    assert.ok(CLI_SUBCOMMANDS.gh.includes('label create'), 'gh must include label create');
    assert.ok(CLI_SUBCOMMANDS.gh.includes('label clone'), 'gh must include label clone');
  });
  test('getPlatformCliPatterns(gh) includes Bash(gh label list *) and Bash(gh label create *)', () => {
    const patterns = getPlatformCliPatterns('gh');
    assert.ok(patterns.includes('Bash(gh label list *)'), 'Missing Bash(gh label list *)');
    assert.ok(patterns.includes('Bash(gh label create *)'), 'Missing Bash(gh label create *)');
    assert.ok(patterns.includes('Bash(gh label clone *)'), 'Missing Bash(gh label clone *)');
  });
  test('getPlatformCliPatterns(gh) does NOT include broad Bash(gh label *)', () => {
    const patterns = getPlatformCliPatterns('gh');
    assert.ok(!patterns.includes('Bash(gh label *)'), 'Broad Bash(gh label *) must NOT be present — narrowed to two-token verbs');
  });
  test('glab has no bare label entry; has label list and label create', () => {
    assert.ok(!CLI_SUBCOMMANDS.glab.includes('label'), 'glab must NOT have bare label entry');
    assert.ok(CLI_SUBCOMMANDS.glab.includes('label list'), 'glab must include label list');
    assert.ok(CLI_SUBCOMMANDS.glab.includes('label create'), 'glab must include label create');
  });
  test('glab does NOT have label clone (glab has no label-clone verb)', () => {
    assert.ok(!CLI_SUBCOMMANDS.glab.includes('label clone'), 'glab must NOT have label clone — glab has no label-clone verb');
  });
  test('fj has NO label entries of any form (fj has no label subcommand)', () => {
    assert.ok(!CLI_SUBCOMMANDS.fj.includes('label'), 'fj must NOT have bare label entry');
    assert.ok(!CLI_SUBCOMMANDS.fj.some(s => s.startsWith('label')), 'fj must have NO label-prefixed entries at all');
  });
  test('tea has no bare label entry; has label list and label create; retains labels plural alias', () => {
    assert.ok(!CLI_SUBCOMMANDS.tea.includes('label'), 'tea must NOT have bare label entry');
    assert.ok(CLI_SUBCOMMANDS.tea.includes('label list'), 'tea must include label list');
    assert.ok(CLI_SUBCOMMANDS.tea.includes('label create'), 'tea must include label create');
    assert.ok(CLI_SUBCOMMANDS.tea.includes('labels'), 'tea must retain labels plural alias');
  });
});

// ── gh repo narrowing + glab/fj/tea mirrors ──

describe('ALLOW-22: gh repo narrowed — no bare repo entry; two-token verbs present', () => {
  test('gh has no bare repo entry', () => {
    assert.ok(!CLI_SUBCOMMANDS.gh.includes('repo'), 'gh must NOT have bare repo entry — use two-token repo verbs');
  });
  test('gh has all 7 two-token repo verbs', () => {
    for (const verb of ['repo view', 'repo list', 'repo clone', 'repo fork', 'repo create', 'repo sync', 'repo set-default']) {
      assert.ok(CLI_SUBCOMMANDS.gh.includes(verb), `gh must include '${verb}'`);
    }
  });
  test('gh CLI_SUBCOMMANDS.gh.length === 18 (8 single-token + 7 repo + 3 label)', () => {
    assert.strictEqual(CLI_SUBCOMMANDS.gh.length, 18, `Expected 18 entries in CLI_SUBCOMMANDS.gh, got ${CLI_SUBCOMMANDS.gh.length}`);
  });
  test('getPlatformCliPatterns(gh) returns exactly 36 patterns (18 entries × 2 forms)', () => {
    const patterns = getPlatformCliPatterns('gh');
    assert.strictEqual(patterns.length, 36, `Expected 36 patterns for gh, got ${patterns.length}`);
  });
  test('getPlatformCliPatterns(gh) includes Bash(gh repo view *) and Bash(gh repo set-default *)', () => {
    const patterns = getPlatformCliPatterns('gh');
    assert.ok(patterns.includes('Bash(gh repo view *)'), 'Missing Bash(gh repo view *)');
    assert.ok(patterns.includes('Bash(gh repo view)'), 'Missing Bash(gh repo view)');
    assert.ok(patterns.includes('Bash(gh repo set-default *)'), 'Missing Bash(gh repo set-default *)');
  });
  test('getPlatformCliPatterns(gh) does NOT include broad Bash(gh repo *)', () => {
    const patterns = getPlatformCliPatterns('gh');
    assert.ok(!patterns.includes('Bash(gh repo *)'), 'Broad Bash(gh repo *) must NOT be present — narrowed to two-token verbs');
  });
  test('getPlatformCliPatterns handles multi-word subcommand tokens (template literal safety)', () => {
    const patterns = getPlatformCliPatterns('gh');
    assert.ok(patterns.includes('Bash(gh repo view *)'), 'Multi-word: Bash(gh repo view *) must be emitted');
    assert.ok(patterns.includes('Bash(gh repo view)'), 'Multi-word: Bash(gh repo view) must be emitted');
  });
  test('glab has no bare repo entry; has 5 two-token repo verbs (no sync/set-default)', () => {
    assert.ok(!CLI_SUBCOMMANDS.glab.includes('repo'), 'glab must NOT have bare repo entry');
    assert.ok(CLI_SUBCOMMANDS.glab.includes('repo view'), 'glab must include repo view');
    assert.ok(CLI_SUBCOMMANDS.glab.includes('repo list'), 'glab must include repo list');
    assert.ok(CLI_SUBCOMMANDS.glab.includes('repo clone'), 'glab must include repo clone');
    assert.ok(CLI_SUBCOMMANDS.glab.includes('repo fork'), 'glab must include repo fork');
    assert.ok(CLI_SUBCOMMANDS.glab.includes('repo create'), 'glab must include repo create');
    assert.ok(!CLI_SUBCOMMANDS.glab.includes('repo sync'), 'glab must NOT have repo sync (glab lacks it)');
    assert.ok(!CLI_SUBCOMMANDS.glab.includes('repo set-default'), 'glab must NOT have repo set-default (glab lacks it)');
  });
  test('fj has no bare repo entry; has 4 two-token repo verbs (no list)', () => {
    assert.ok(!CLI_SUBCOMMANDS.fj.includes('repo'), 'fj must NOT have bare repo entry');
    assert.ok(CLI_SUBCOMMANDS.fj.includes('repo view'), 'fj must include repo view');
    assert.ok(CLI_SUBCOMMANDS.fj.includes('repo clone'), 'fj must include repo clone');
    assert.ok(CLI_SUBCOMMANDS.fj.includes('repo fork'), 'fj must include repo fork');
    assert.ok(CLI_SUBCOMMANDS.fj.includes('repo create'), 'fj must include repo create');
    assert.ok(!CLI_SUBCOMMANDS.fj.includes('repo list'), 'fj must NOT have repo list (fj has no list verb)');
  });
  test('tea has no bare repo entry; has repo list/create/fork; no repo view or repo clone; retains repos alias', () => {
    assert.ok(!CLI_SUBCOMMANDS.tea.includes('repo'), 'tea must NOT have bare repo entry');
    assert.ok(CLI_SUBCOMMANDS.tea.includes('repo list'), 'tea must include repo list');
    assert.ok(CLI_SUBCOMMANDS.tea.includes('repo create'), 'tea must include repo create');
    assert.ok(CLI_SUBCOMMANDS.tea.includes('repo fork'), 'tea must include repo fork');
    assert.ok(!CLI_SUBCOMMANDS.tea.includes('repo view'), 'tea must NOT have repo view (tea has no view verb)');
    assert.ok(!CLI_SUBCOMMANDS.tea.includes('repo clone'), 'tea must NOT have repo clone (tea has no clone verb)');
    assert.ok(CLI_SUBCOMMANDS.tea.includes('repos'), 'tea must retain repos plural alias');
  });
});

// ── RW_FORMS frozen-Set export — single source of truth for canonical permission forms ──

describe('ALLOW-19: RW_FORMS export', () => {
  test('RW_FORMS is a Set instance', () => {
    assert.ok(RW_FORMS instanceof Set, 'RW_FORMS must be a Set instance');
  });
  test('RW_FORMS has exactly 6 entries', () => {
    assert.strictEqual(RW_FORMS.size, 6, 'RW_FORMS must contain exactly 6 entries');
  });
  test('RW_FORMS is frozen', () => {
    assert.ok(Object.isFrozen(RW_FORMS), 'RW_FORMS must be frozen');
  });
  test('RW_FORMS contains all canonical permission forms', () => {
    for (const e of ['Edit', 'Write', 'Read', 'Edit(*)', 'Write(*)', 'Read(*)']) {
      assert.ok(RW_FORMS.has(e), `RW_FORMS must contain '${e}'`);
    }
  });
  test('RW_FORMS freeze is documentation-only in Node 22+ (V8 does not throw on .add())', () => {
    // RESEARCH Pitfall 6: Object.freeze(new Set(...)) in Node 22+ / V8 does NOT throw from .add().
    // The freeze signals read-only intent; enforcement is at code-review time, not runtime.
    // Document the actual V8 behavior using a local frozen Set so we never mutate the exported
    // RW_FORMS singleton (which is shared with install.js/commands.cjs consumers and other tests).
    const frozenSet = Object.freeze(new Set(['Edit', 'Write', 'Read', 'Edit(*)', 'Write(*)', 'Read(*)']));
    assert.ok(Object.isFrozen(frozenSet), 'local documentation Set must be frozen');
    const sizeBeforeAdd = frozenSet.size;
    assert.strictEqual(sizeBeforeAdd, 6, 'local documentation Set size must be 6 before .add()');
    assert.doesNotThrow(() => { frozenSet.add('bogus'); },
      'V8 in Node 22+ does NOT throw TypeError on Object.freeze(new Set(...)).add(bogus)');
    assert.strictEqual(frozenSet.size, sizeBeforeAdd + 1,
      'documented V8 behavior: frozen Set still grows after .add()');
    assert.ok(frozenSet.has('bogus'),
      'documented V8 behavior: frozen Set still contains the newly added value');
  });
});

// ── normalizePermissionRules folds unmatched Tool(path) forms into effective ones ──
//
// Claude Code's file permission checks match only Edit(path) and Read(path).
// Write(path), NotebookEdit(path) and Glob(path) are accepted by the settings
// parser but never matched — and since v2.1.210 each one costs a startup warning,
// in allow, deny AND ask alike. Edit(path) is the effective spelling for the
// file-editing tools; Read(path) for Glob(path).
//
// The critical boundary these tests lock: a BARE tool-name rule is NOT defective.
// It matches its tool everywhere and produces no warning, so it must pass through
// untouched and must never be reported.

describe('ALLOW-23: normalizePermissionRules rewrites unmatched Tool(path) forms', () => {
  test('Write(<path>) becomes Edit(<path>)', () => {
    assert.deepStrictEqual(normalizePermissionRules(['Write(.env)']), ['Edit(.env)']);
  });

  test('bare Write passes through untouched — a tool-name rule matches everywhere and does not warn', () => {
    assert.deepStrictEqual(normalizePermissionRules(['Write']), ['Write']);
  });

  test('every bare tool-name rule passes through untouched', () => {
    const bare = ['Edit', 'Write', 'Read', 'Glob', 'NotebookEdit'];
    assert.deepStrictEqual(normalizePermissionRules(bare), bare);
  });

  test('the degenerate empty-argument form is left alone, not rewritten', () => {
    // Write() is not a path rule; rewriting it to Edit() would invent meaning.
    assert.deepStrictEqual(normalizePermissionRules(['Write()']), ['Write()']);
  });

  test('Write(*) becomes Edit(*)', () => {
    assert.deepStrictEqual(normalizePermissionRules(['Write(*)']), ['Edit(*)']);
  });

  test('NotebookEdit(<path>) becomes Edit(<path>)', () => {
    assert.deepStrictEqual(normalizePermissionRules(['NotebookEdit(docs/**)']), ['Edit(docs/**)']);
  });

  test('Glob(<path>) becomes Read(<path>)', () => {
    assert.deepStrictEqual(normalizePermissionRules(['Glob(docs/**)']), ['Read(docs/**)']);
  });

  test('glob path arguments survive the conversion intact', () => {
    assert.deepStrictEqual(normalizePermissionRules(['Write(.env.*)']), ['Edit(.env.*)']);
  });

  test('the Edit/Write pair collapses to the single effective Edit rule', () => {
    // The exact shape proposed in 36.1-01-PLAN.md:92-97 — Edit/Write pairs.
    // The Write half is decoration; de-dup must remove it, not preserve it.
    assert.deepStrictEqual(
      normalizePermissionRules(['Edit(.env)', 'Write(.env)', 'Edit(.env.*)', 'Write(.env.*)']),
      ['Edit(.env)', 'Edit(.env.*)'],
    );
  });

  test('pair collapses regardless of authoring order (Write first)', () => {
    assert.deepStrictEqual(normalizePermissionRules(['Write(.env)', 'Edit(.env)']), ['Edit(.env)']);
  });

  test('Read(<path>) passes through untouched — a separate, genuinely enforced rule', () => {
    assert.deepStrictEqual(
      normalizePermissionRules(['Read(.env)', 'Write(.env)']),
      ['Read(.env)', 'Edit(.env)'],
    );
  });

  test('Bash(...) and other non-file rules pass through untouched', () => {
    const input = ['Bash(rm -rf /*)', 'WebFetch(*)', 'Agent(*)'];
    assert.deepStrictEqual(normalizePermissionRules(input), input);
  });

  test('does not rewrite tools whose name merely contains a rewritten name', () => {
    assert.deepStrictEqual(
      normalizePermissionRules(['NotebookWrite(x)', 'Writer', 'MyGlob(x)']),
      ['NotebookWrite(x)', 'Writer', 'MyGlob(x)'],
    );
  });

  test('exact duplicates collapse', () => {
    assert.deepStrictEqual(normalizePermissionRules(['Edit(.env)', 'Edit(.env)']), ['Edit(.env)']);
  });

  test('empty list returns empty list', () => {
    assert.deepStrictEqual(normalizePermissionRules([]), []);
  });

  test('non-array input returns empty list', () => {
    assert.deepStrictEqual(normalizePermissionRules(undefined), []);
    assert.deepStrictEqual(normalizePermissionRules(null), []);
    assert.deepStrictEqual(normalizePermissionRules('Write(.env)'), []);
  });

  test('non-string members are skipped', () => {
    assert.deepStrictEqual(normalizePermissionRules(['Edit(.env)', 42, null, { a: 1 }]), ['Edit(.env)']);
  });

  test('returns a fresh array — input is not mutated', () => {
    const input = ['Write(.env)'];
    const out = normalizePermissionRules(input);
    assert.notStrictEqual(out, input, 'must return a new array instance');
    assert.deepStrictEqual(input, ['Write(.env)'], 'input must not be mutated');
  });

  test('output contains no unmatched path rule for any input', () => {
    const out = normalizePermissionRules([
      'Write(*)', 'Write(.env)', 'NotebookEdit(a)', 'Glob(b)', 'Read(.env)', 'Bash(x)',
    ]);
    assert.deepStrictEqual(findUnmatchedPathRules(out), [],
      `normalized output still has an unmatched rule: ${JSON.stringify(out)}`);
  });

  test('is idempotent', () => {
    const once = normalizePermissionRules(['Edit(.env)', 'Write(.env)', 'Glob(x)', 'Read(.env)']);
    assert.deepStrictEqual(normalizePermissionRules(once), once);
  });
});

// ── findUnmatchedPathRules reports unmatched forms for assertion sites ──

describe('ALLOW-24: findUnmatchedPathRules flags unmatched Tool(path) rules', () => {
  test('reports Write(<path>) entries verbatim', () => {
    assert.deepStrictEqual(
      findUnmatchedPathRules(['Read(.env)', 'Edit(.env)', 'Write(.env)']),
      ['Write(.env)'],
    );
  });

  test('reports Write(*), NotebookEdit(path) and Glob(path)', () => {
    assert.deepStrictEqual(
      findUnmatchedPathRules(['Write(*)', 'NotebookEdit(a)', 'Glob(b)']),
      ['Write(*)', 'NotebookEdit(a)', 'Glob(b)'],
    );
  });

  test('does NOT report bare tool-name rules — they match everywhere and do not warn', () => {
    assert.deepStrictEqual(findUnmatchedPathRules(['Write', 'Glob', 'NotebookEdit', 'Edit', 'Read']), []);
  });

  test('does not report the degenerate empty-argument form', () => {
    assert.deepStrictEqual(findUnmatchedPathRules(['Write()']), []);
  });

  test('returns empty for a correctly authored list', () => {
    assert.deepStrictEqual(findUnmatchedPathRules(['Read(.env)', 'Edit(.env)', 'Bash(curl *)']), []);
  });

  test('returns empty for empty, non-array, and non-string input', () => {
    assert.deepStrictEqual(findUnmatchedPathRules([]), []);
    assert.deepStrictEqual(findUnmatchedPathRules(undefined), []);
    assert.deepStrictEqual(findUnmatchedPathRules([1, null]), []);
  });
});
