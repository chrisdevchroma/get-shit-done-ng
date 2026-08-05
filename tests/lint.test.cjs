'use strict';
/**
 * Structural lint rules for the test suite and production code.
 *
 * These are not behavioural tests — they enforce code conventions that
 * prevent copy-paste drift and helper bypass. Each rule runs as a fast
 * file-scan; failures name the exact line so fixes are unambiguous.
 *
 * Adding a new rule here keeps it discoverable and keeps domain test files
 * (roadmap.test.cjs, guardrail.test.cjs, etc.) focused on behaviour.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

// ── helpers ──────────────────────────────────────────────────────────────────

// Collect all *.test.cjs files except this one.
function testFiles() {
  const self = path.basename(__filename);
  return fs.readdirSync(__dirname)
    .filter(f => f.endsWith('.test.cjs') && f !== self)
    .map(f => ({ name: f, src: fs.readFileSync(path.join(__dirname, f), 'utf-8') }));
}

// ── Rule 1: no .tmpdir() call in test files — use resolveTmpDir from helpers ──
//
// Catches both `os.tmpdir()` and aliased forms like `osMod.tmpdir()`.
// install-js.test.cjs is excluded — it legitimately passes HOME=os.homedir()
// to subprocess env overrides (not for temp directory resolution).

describe('lint: no .tmpdir() call in test files (use resolveTmpDir from helpers.cjs)', () => {
  const EXCLUDED = ['install-js.test.cjs'];
  test('no test file calls .tmpdir() directly (including aliased require("os"))', () => {
    const violations = [];
    for (const { name, src } of testFiles()) {
      if (EXCLUDED.includes(name)) continue;
      src.split('\n').forEach((line, i) => {
        if (line.includes('.tmpdir()') && !line.trim().startsWith('//')) {
          violations.push(`${name}:${i + 1}: ${line.trim()}`);
        }
      });
    }
    assert.deepStrictEqual(violations, [],
      `Direct .tmpdir() usage found (use resolveTmpDir() from helpers.cjs instead):\n${violations.join('\n')}`
    );
  });
});

// ── Rule 2: no inline redeclaration of helpers.cjs exports ───────────────────

describe('lint: no inline redeclaration of helpers.cjs exports in test files', () => {
  // Catches copy-paste of cleanup() or resolveTmpDir() instead of importing from helpers.cjs.
  // Note: local helpers that *use* these (e.g. makeTmpDir returning {tmpDir, cleanup}) are fine.
  // `exclude` rules out legitimate forms like `const cleanup = require(...)`.
  const forbidden = [
    { pattern: 'function cleanup(', hint: 'import cleanup from helpers.cjs' },
    { pattern: 'function resolveTmpDir(', hint: 'import resolveTmpDir from helpers.cjs' },
    { pattern: 'const cleanup = ', hint: 'import cleanup from helpers.cjs', exclude: 'require(' },
    { pattern: 'const resolveTmpDir = ', hint: 'import resolveTmpDir from helpers.cjs', exclude: 'require(' },
  ];

  for (const { pattern, hint, exclude } of forbidden) {
    test(`no test file declares \`${pattern.trim()}\` (${hint})`, () => {
      const violations = [];
      for (const { name, src } of testFiles()) {
        src.split('\n').forEach((line, i) => {
          if (
            line.includes(pattern) &&
            (!exclude || !line.includes(exclude)) &&
            !line.trim().startsWith('//')
          ) {
            violations.push(`${name}:${i + 1}: ${line.trim()}`);
          }
        });
      }
      assert.deepStrictEqual(violations, [],
        `Inline redeclaration of helper found:\n${violations.join('\n')}`
      );
    });
  }
});

// ── Rule 3: no bare recursive dir deletion — use cleanup/cleanupSubdir ────────

describe('lint: no bare recursive dir deletion in test files (use cleanup/cleanupSubdir from helpers.cjs)', () => {
  test('no test file calls fs.rmSync or fs.rmdirSync with recursive:true directly', () => {
    const violations = [];
    for (const { name, src } of testFiles()) {
      src.split('\n').forEach((line, i) => {
        if (
          (line.includes('fs.rmSync(') || line.includes('fs.rmdirSync(')) &&
          line.includes('recursive: true') &&
          !line.trim().startsWith('//')
        ) {
          violations.push(`${name}:${i + 1}: ${line.trim()}`);
        }
      });
    }
    assert.deepStrictEqual(violations, [],
      `Bare recursive dir deletion found (use cleanup() or cleanupSubdir() from helpers.cjs instead):\n${violations.join('\n')}`
    );
  });
});

// ── Rule 4: no bare roadmapContent.replace() in roadmap.cjs ──────────────────

describe('lint: no bare roadmapContent.replace() in roadmap.cjs', () => {
  test('no bare roadmapContent.replace() outside replaceInCurrentMilestone', () => {
    const roadmapSource = fs.readFileSync(
      path.join(__dirname, '..', 'gsd-ng', 'bin', 'lib', 'roadmap.cjs'), 'utf-8'
    );
    const violations = [];
    roadmapSource.split('\n').forEach((line, i) => {
      if (
        line.includes('roadmapContent.replace(') &&
        !line.includes('replaceInCurrentMilestone') &&
        !line.trim().startsWith('//')
      ) {
        violations.push(`roadmap.cjs:${i + 1}: ${line.trim()}`);
      }
    });
    assert.deepStrictEqual(violations, [],
      `Bare roadmapContent.replace() found (use replaceInCurrentMilestone instead):\n${violations.join('\n')}`
    );
  });
});

// ── Rule 5: no bare roadmapContent.replace() in cmdPhaseComplete (phase.cjs) ──
//
// cmdPhaseRemove legitimately uses roadmapContent.replace() for low-level
// mutations; cmdPhaseComplete must go through replaceInCurrentMilestone.
// Scope the check to cmdPhaseComplete by scanning from its declaration line
// to the next top-level `function` declaration (or EOF) — no brace-counting
// needed, so string/template-literal braces can't fool it.

describe('lint: no bare roadmapContent.replace() in cmdPhaseComplete (phase.cjs)', () => {
  test('cmdPhaseComplete uses replaceInCurrentMilestone for all roadmap mutations', () => {
    const phaseSource = fs.readFileSync(
      path.join(__dirname, '..', 'gsd-ng', 'bin', 'lib', 'phase.cjs'), 'utf-8'
    );
    const lines = phaseSource.split('\n');
    const fnStartIdx = lines.findIndex(l => l.startsWith('function cmdPhaseComplete('));
    assert.ok(fnStartIdx !== -1, 'cmdPhaseComplete must exist in phase.cjs');
    const fnEndIdx = lines.findIndex((l, i) => i > fnStartIdx && /^function \w/.test(l));
    const fnLines = lines.slice(fnStartIdx, fnEndIdx === -1 ? lines.length : fnEndIdx);
    const violations = [];
    fnLines.forEach((line, i) => {
      if (
        line.includes('roadmapContent.replace(') &&
        !line.includes('replaceInCurrentMilestone') &&
        !line.trim().startsWith('//')
      ) {
        violations.push(`phase.cjs:${fnStartIdx + i + 1}: ${line.trim()}`);
      }
    });
    assert.deepStrictEqual(violations, [],
      `Bare roadmapContent.replace() found in cmdPhaseComplete (use replaceInCurrentMilestone instead):\n${violations.join('\n')}`
    );
  });
});

// ── Rule 6: no dead require('os') import in test files ───────────────────────
//
// A test file that imports `os` but never calls any `os.*()` method has a
// stale import. The permitted use of `os` in test files is `os.homedir()` in
// install-js.test.cjs (for HOME= subprocess env overrides) — all other temp-dir
// access must go through `resolveTmpDir()` from helpers.cjs.
//
// Detection: file contains require('os') AND contains no `os.` method call
// (i.e. no match for /\bos\.\w+\s*\(/ outside comments).

describe('lint: no dead require("os") import in test files', () => {
  // install-js.test.cjs legitimately uses os.homedir() — exclude from this rule.
  const EXCLUDED = ['install-js.test.cjs'];

  test('no test file imports os without calling any os.method()', () => {
    const violations = [];
    for (const { name, src } of testFiles()) {
      if (EXCLUDED.includes(name)) continue;

      // Detect `const os = require('os')` or `const os = require("os")` (non-destructured)
      // Destructured imports like `const { homedir } = require('os')` are fine — caller uses the
      // destructured binding directly (homedir(), not os.homedir()).
      const hasNonDestructuredOsImport =
        /\bconst\s+os\s*=\s*require\s*\(\s*['"]os['"]\s*\)/.test(src);
      if (!hasNonDestructuredOsImport) continue;

      const lines = src.split('\n');
      const hasOsMethodCall = lines.some(
        (line) =>
          !line.trim().startsWith('//') && /\bos\.\w+\s*\(/.test(line),
      );
      if (!hasOsMethodCall) {
        violations.push(`${name}: imports 'os' as namespace (const os = require('os')) but never calls os.method() — remove dead import or use destructured import`);
      }
    }
    assert.deepStrictEqual(violations, [],
      `Dead require('os') namespace import found (remove it or use const { method } = require('os') if needed):\n${violations.join('\n')}`
    );
  });
});

// ── Rule 7: no hardcoded /tmp/ base in temp-dir creation calls ───────────────
//
// When creating real temp directories (mkdtempSync, mkdirSync, path.join used
// as a base for test dirs) the /tmp/ path must come from resolveTmpDir(), not
// be hardcoded. This rule specifically targets the pattern:
//   path.join('/tmp/', ...) | mkdtempSync('/tmp/...')
//
// Note: /tmp/ as test *data* (e.g. a file_path field in a JSON payload, or as a
// hypothetical path argument to a pure function) is fine and NOT flagged here.
// The distinction: only lines where /tmp/ appears as argument to path.join() or
// mkdtempSync() directly are violations.

describe('lint: no hardcoded /tmp/ in path.join() or mkdtempSync() calls', () => {
  test('no test file passes a hardcoded /tmp/ literal to path.join() or mkdtempSync()', () => {
    const violations = [];
    for (const { name, src } of testFiles()) {
      src.split('\n').forEach((line, i) => {
        const trimmed = line.trim();
        // Skip comments and assertion lines (assert.* calls may compare against /tmp/ values as test data)
        if (trimmed.startsWith('//') || /\bassert\./.test(trimmed)) return;
        // Flag lines that pass /tmp/ as first arg to path.join() or mkdtempSync()
        if (
          /path\.join\(\s*['"`]\/tmp\//.test(line) ||
          /mkdtempSync\(\s*['"`]\/tmp\//.test(line)
        ) {
          violations.push(`${name}:${i + 1}: ${trimmed}`);
        }
      });
    }
    assert.deepStrictEqual(violations, [],
      `Hardcoded /tmp/ in path.join()/mkdtempSync() found (use path.join(resolveTmpDir(), ...) instead):\n${violations.join('\n')}`
    );
  });
});

// ── Rule 8: no direct target_branch read off a config object ─────────────────
//
// loadConfig() normalizes the `git` block onto the top level, so a loaded
// config has `target_branch` and never `git.target_branch`. A reader that
// reaches for the nested path gets `undefined` and silently falls through to
// its own fallback — the failure is invisible because a plausible branch name
// still comes out. resolveTargetBranch() in core.cjs is the only supported
// reader; it accepts both shapes and applies one precedence order.
//
// Detection: any read of `target_branch` off any receiver in shipped bin/
// sources. Object-literal keys (`target_branch: value`) and assignments to
// result objects are writes, not reads, and are not flagged.
//
// This rule is a tripwire, not a proof. It is line-oriented, so it cannot see
// multi-line syntax: a destructure split across lines
// (`const {\n  target_branch,\n} = loadConfig(cwd)`) or a property access
// broken after the receiver both slip past — and those are shapes prettier
// produces on its own past 80 columns. Treat a green Rule 8 as "no obvious
// re-introduction", not as "no reader exists". Catching the rest needs an AST
// pass rather than a regex.

describe('lint: no direct target_branch read off a config object (use resolveTargetBranch)', () => {
  // Recursively collect shipped .cjs sources under gsd-ng/bin/.
  function binSources(dir, acc = []) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) binSources(full, acc);
      else if (entry.name.endsWith('.cjs')) acc.push(full);
    }
    return acc;
  }

  const BIN_DIR = path.join(__dirname, '..', 'gsd-ng', 'bin');

  // Flag any read of `target_branch` off any receiver. A receiver-name
  // allowlist is the wrong shape for this rule: `\bconfig\w*` misses the
  // mid-word `parsedConfig.target_branch` and every `cfg`-style abbreviation,
  // which is exactly the drift the rule exists to stop. So the detector
  // subtracts what is provably not a config read, then flags the remainder.
  //
  // The scan and its self-test share this one function on purpose — a detector
  // whose tests exercise a second copy of the logic is the same class of bug
  // this rule was written to catch.
  function readsTargetBranch(line) {
    // Bracket access is checked against the raw line: the string-literal strip
    // below would eat the quoted key and hide `config['target_branch']`.
    if (/\[\s*['"`]target_branch['"`]\s*\]/.test(line)) return true;

    const probe = line
      // Template literals first — they may embed quotes (`'${base}' … `), so
      // the quote-delimited pass below cannot span them.
      .replace(/`[^`]*target_branch[^`]*`/g, '')
      // String literals — key allowlists such as `'git.target_branch'`.
      .replace(/(['"])[^'"]*target_branch[^'"]*\1/g, '')
      // Reads of an already-resolved git context or of the defaults table.
      .replace(/\b(?:gitCtx|DEFAULTS|defaults)\s*\??\.\s*target_branch/g, '')
      // Assignment targets — `result.target_branch = …` is a write, not a read.
      .replace(/\w\s*\??\.\s*target_branch\s*=(?!=)/g, '');

    return (
      /(?:\w|\])\s*\??\.\s*target_branch/.test(probe) ||
      /\{[^}]*\btarget_branch\b[^}]*\}\s*=/.test(probe)
    );
  }

  test('resolveTargetBranch is the only reader of target_branch in bin/', () => {
    const violations = [];
    for (const file of binSources(BIN_DIR)) {
      const rel = path.relative(BIN_DIR, file);
      const lines = fs.readFileSync(file, 'utf-8').split('\n');

      // The helper itself legitimately reads both shapes — skip its body. End
      // the skip at the function's own closing brace (top-level declarations
      // close at column 0), never at "whatever declaration comes next": keying
      // it to the next `function` exempts the entire rest of the file the
      // moment the helper is moved last or the next declaration becomes a
      // const-arrow.
      let skipFrom = -1;
      let skipTo = -1;
      const helperIdx = lines.findIndex(l =>
        l.startsWith('function resolveTargetBranch(')
      );
      if (helperIdx !== -1) {
        skipFrom = helperIdx;
        const close = lines.findIndex((l, i) => i > helperIdx && l === '}');
        assert.notStrictEqual(
          close, -1,
          `${rel}: resolveTargetBranch has no column-0 closing brace; the Rule 8 skip range cannot be bounded`
        );
        skipTo = close + 1;
      }

      lines.forEach((line, i) => {
        if (i >= skipFrom && i < skipTo) return;
        const trimmed = line.trim();
        if (
          trimmed.startsWith('//') ||
          trimmed.startsWith('*') ||
          trimmed.startsWith('/*')
        ) return;
        if (readsTargetBranch(line)) {
          violations.push(`${rel}:${i + 1}: ${trimmed}`);
        }
      });
    }
    assert.deepStrictEqual(violations, [],
      `Direct target_branch read found (use resolveTargetBranch() from core.cjs instead):\n${violations.join('\n')}`
    );
  });

  // Self-test: the detector must actually catch the nested-read shape,
  // otherwise the rule above passes vacuously.
  test('detector flags every read shape, whatever the receiver is named', () => {
    const flags = readsTargetBranch;

    // The nested read that returns undefined off a loaded config.
    assert.ok(flags('const base = opts.base || config.git?.target_branch;'));
    assert.ok(flags('config.git && config.git.target_branch'));
    assert.ok(flags('const targetBranch = config.target_branch || "main";'));
    assert.ok(flags('let t = configSubmodule.target_branch || null;'));
    // Receivers a name-allowlist would miss.
    assert.ok(flags('const t = parsedConfig.target_branch;'));
    assert.ok(flags('const t = cfg.target_branch;'));
    assert.ok(flags('const t = opts.target_branch;'));
    // Non-dotted access shapes.
    assert.ok(flags("const t = config['target_branch'];"));
    assert.ok(flags('const { target_branch } = config;'));
    assert.ok(flags('const { remote, target_branch } = loadConfig(cwd);'));

    // Writes are not reads.
    assert.ok(!flags('    target_branch: targetBranch,'));
    assert.ok(!flags('  target_branch: null,'));
    assert.ok(!flags('  target_branch: resolveTargetBranch(config),'));
    // Reads of an already-resolved context or the defaults table.
    assert.ok(!flags('result.target_branch = gitCtx.target_branch;'));
    assert.ok(!flags('  target_branch: DEFAULTS.target_branch,'));
    assert.ok(!flags('        fallback: defaults.target_branch,'));
    // A string literal naming the key is an allowlist entry, not a read.
    assert.ok(!flags("  'git.target_branch',"));
    // An equality comparison is still a read.
    assert.ok(flags("if (config.target_branch === 'main') {"));
  });
});

// ── Rule 9: a doc that invokes a command reporting missed rewrite targets ─────
//    must name the field
//
// `phase complete`, `phase remove` and `roadmap update-plan-progress` each
// report the ROADMAP.md rewrites that had a target and could not reach it. The
// report is worth nothing unless the caller reads it: the field was added with
// only remove-phase.md updated, so a miss under execute-phase.md — the workflow
// that runs phase completion for every project — was invisible to the operator.

describe('lint: docs invoking a missed-target command surface the field', () => {
  // Commands whose JSON result carries a missed-target list.
  const REPORTING = ['phase complete', 'phase remove', 'roadmap update-plan-progress'];

  // Field names by command: `roadmap update-plan-progress` reports
  // `missed_targets`, the phase commands `roadmap_missed_targets`. Naming
  // either satisfies the rule — the substring is shared.
  const FIELD = 'missed_targets';

  function docSources(dir, acc = []) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) docSources(full, acc);
      else if (entry.name.endsWith('.md')) acc.push(full);
    }
    return acc;
  }

  // Invocations, not mentions: prose about "phase complete" is not a call site.
  // Keyed on the dispatcher path so a fenced `node …/gsd-tools.cjs phase
  // complete "${X}"` is found however the result is captured.
  function invocationsIn(src) {
    const found = [];
    src.split('\n').forEach((line, i) => {
      for (const cmd of REPORTING) {
        if (new RegExp('gsd-tools\\.cjs"?\\s+' + cmd + '(?:\\s|$)').test(line)) {
          found.push({ line: i + 1, cmd });
        }
      }
    });
    return found;
  }

  // Docs that invoke a reporting command without naming the field.
  function unsurfaced(docs) {
    const violations = [];
    for (const { name, src } of docs) {
      if (src.includes(FIELD)) continue;
      for (const hit of invocationsIn(src)) {
        violations.push(`${name}:${hit.line}: ${hit.cmd}`);
      }
    }
    return violations;
  }

  test('every invocation site documents the missed-target field', () => {
    const ROOT = path.join(__dirname, '..');
    const docs = [];
    for (const dir of ['agents', 'commands', 'gsd-ng']) {
      for (const file of docSources(path.join(ROOT, dir))) {
        docs.push({
          name: path.relative(ROOT, file),
          src: fs.readFileSync(file, 'utf-8'),
        });
      }
    }
    // Anti-vacuity: the walk must actually find the call sites, or the
    // assertion below passes because it examined nothing.
    const invoking = docs.filter(d => invocationsIn(d.src).length > 0);
    assert.ok(invoking.length >= 5,
      `expected the doc walk to find the known invocation sites, found ${invoking.length}`
    );

    assert.deepStrictEqual(unsurfaced(docs), [],
      `A doc invokes a command that reports missed rewrite targets without naming ${FIELD}:\n${unsurfaced(docs).join('\n')}`
    );
  });

  test('detector flags an invocation whose doc never names the field', () => {
    const invocation = 'RESULT=$(node "$HOME/.claude/gsd-ng/bin/gsd-tools.cjs" phase complete "${X}")';
    assert.deepStrictEqual(
      unsurfaced([{ name: 'silent.md', src: `# Doc\n\n${invocation}\n\nExtract: next_phase.\n` }]),
      ['silent.md:3: phase complete']
    );
    assert.deepStrictEqual(
      unsurfaced([{ name: 'loud.md', src: `# Doc\n\n${invocation}\n\nExtract: roadmap_missed_targets.\n` }]),
      []
    );
    // Prose is not an invocation.
    assert.deepStrictEqual(
      unsurfaced([{ name: 'prose.md', src: '# Doc\n\nBasic updates are handled by `phase complete`.\n' }]),
      []
    );
    // Every reporting command is covered, and the plan-progress field name too.
    assert.deepStrictEqual(
      unsurfaced([{ name: 'p.md', src: 'node gsd-tools.cjs roadmap update-plan-progress "${P}"\n' }]),
      ['p.md:1: roadmap update-plan-progress']
    );
    assert.deepStrictEqual(
      unsurfaced([{
        name: 'p.md',
        src: 'node gsd-tools.cjs roadmap update-plan-progress "${P}"\nReport missed_targets.\n',
      }]),
      []
    );
    assert.deepStrictEqual(
      unsurfaced([{ name: 'r.md', src: 'node gsd-tools.cjs phase remove "${P}"\n' }]),
      ['r.md:1: phase remove']
    );
  });
});

// ── Rule 10: create-pr.md resolves the CLI from the same repo as the platform ─
//
// A bare `detect-platform` call runs against the workspace root. In a submodule
// workspace that is a different repository from the one the PR is pushed to, so
// the CLI name, its installed flag and its install URL must come from $INIT —
// which carries the submodule-resolved values. A bare call may remain as the
// empty-value fallback, but it may not be the first assignment.

describe('lint: create-pr.md resolves the CLI from the same repo as the platform', () => {
  const FIELDS = [
    ['CLI', 'cli'],
    ['CLI_INSTALLED', 'cli_installed'],
    ['CLI_INSTALL_URL', 'cli_install_url'],
  ];

  const source = () =>
    fs.readFileSync(
      path.join(__dirname, '..', 'gsd-ng', 'workflows', 'create-pr.md'),
      'utf-8'
    );

  test('the first CLI assignment reads from $INIT, not from detect-platform', () => {
    const lines = source().split('\n');
    // `^CLI=` does not match `CLI_INSTALLED=`, so this is the CLI lookup alone.
    // The fallback assignments live inside the `if` and are indented, so the
    // first column-0 assignment is the one that decides which repo answers.
    const first = lines.find(l => /^CLI=/.test(l));
    assert.ok(first, 'CLI is never assigned at column 0 in create-pr.md');
    assert.match(
      first,
      /init-get "\$INIT" cli\b/,
      'first CLI assignment must read $INIT (submodule-resolved), got: ' + first
    );
  });

  test('each of the three CLI values has an $INIT read', () => {
    const lines = source().split('\n');
    for (const [v, field] of FIELDS) {
      const read = lines.find(l =>
        new RegExp('^\\s*' + v + '=.*init-get "\\$INIT" ' + field + '\\b').test(l)
      );
      assert.ok(
        read,
        v +
          ' is never assigned from `init-get "$INIT" ' +
          field +
          '` — a bare detect-platform call resolves the workspace root, not the submodule'
      );
    }
  });
});

// ── Rule: health.md's code table matches the codes runHealth can raise ────────
//
// The table exists so a user reading unfamiliar health output can look a code
// up. A code that fires with no row sends them to the source; a row for a code
// that cannot fire misleads the same way. Both directions are checked.
//
// Codes reach a report two ways: through `addIssue(severity, code, ...)`, and
// through the home-directory guard, which builds its own report literal and
// returns before addIssue exists. W015 and W016 are named only in comments
// inside a check that accepts `addIssue` and ends `void addIssue;` — they are
// deliberately absent from both sides and are excluded here.

describe('lint: health.md documents exactly the codes runHealth can raise', () => {
  const STUB_ONLY = new Set(['W015', 'W016']);

  const verifySrc = () =>
    fs.readFileSync(
      path.join(__dirname, '..', 'gsd-ng', 'bin', 'lib', 'verify.cjs'),
      'utf-8'
    );

  const healthDoc = () =>
    fs.readFileSync(
      path.join(__dirname, '..', 'gsd-ng', 'workflows', 'health.md'),
      'utf-8'
    );

  // Every code the source can put in a report, with the severity it carries.
  function raisedCodes() {
    const src = verifySrc();
    const found = new Map();

    // addIssue(severity, code, ...) — the call spans lines, so match across them.
    const viaAddIssue = /addIssue\(\s*'([a-z]+)'\s*,\s*'([EWI]\d{3})'/g;
    let m;
    while ((m = viaAddIssue.exec(src))) found.set(m[2], m[1]);

    // The home-directory guard writes its own report: errors: [{ code: 'E010' }]
    // and info: [{ code: 'I010' }]. Attribute severity from the array it sits in.
    const guard = src.slice(src.indexOf('function runHealth'));
    const guardEnd = guard.indexOf('planningPaths(cwd)');
    const guardBody = guardEnd === -1 ? guard : guard.slice(0, guardEnd);
    for (const [key, severity] of [
      ['errors', 'error'],
      ['warnings', 'warning'],
      ['info', 'info'],
    ]) {
      const at = guardBody.indexOf(key + ':');
      if (at === -1) continue;
      const segment = guardBody.slice(at, guardBody.indexOf('\n    ]', at) + 1 || undefined);
      const codes = segment.match(/code: '([EWI]\d{3})'/g) || [];
      for (const c of codes) found.set(c.match(/[EWI]\d{3}/)[0], severity);
    }

    for (const c of STUB_ONLY) found.delete(c);
    return found;
  }

  // Every code the table lists, with the severity column it claims.
  function documentedCodes() {
    const rows = healthDoc().split('\n')
      .filter(l => /^\|\s*[EWI]\d{3}\s*\|/.test(l));
    const found = new Map();
    for (const row of rows) {
      const cells = row.split('|').map(c => c.trim());
      found.set(cells[1], cells[2]);
    }
    return found;
  }

  test('every code runHealth can raise has a row', () => {
    const documented = documentedCodes();
    const missing = [...raisedCodes().keys()].filter(c => !documented.has(c));
    assert.deepEqual(
      missing,
      [],
      'health.md has no row for: ' + missing.join(', ')
    );
  });

  test('every documented code can actually be raised', () => {
    const raised = raisedCodes();
    const phantom = [...documentedCodes().keys()].filter(c => !raised.has(c));
    assert.deepEqual(
      phantom,
      [],
      'health.md documents codes verify.cjs never raises: ' + phantom.join(', ')
    );
  });

  test('the severity column matches the severity the source assigns', () => {
    const raised = raisedCodes();
    const wrong = [];
    for (const [code, severity] of documentedCodes()) {
      if (raised.has(code) && raised.get(code) !== severity) {
        wrong.push(code + ' documented as ' + severity + ', raised as ' + raised.get(code));
      }
    }
    assert.deepEqual(wrong, [], wrong.join('; '));
  });
});
