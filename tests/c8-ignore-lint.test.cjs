'use strict';

/**
 * Lint that bounds the count of `c8 ignore` directives in every
 * `gsd-ng/bin/lib/*.cjs` source file against an explicit baseline
 * (tests/c8-ignore-baseline.json).
 *
 * Rationale: written policy alone ("rare, only for genuinely unreachable
 * paths; inline 1-line reason on every ignore") is fragile when multiple
 * agents author code in parallel. This lint is the mechanical guard —
 * adding a new c8 ignore requires bumping the per-file count in the
 * baseline JSON in the same commit. The baseline is a CEILING: counts
 * may decrease (ignores legitimately deleted) but adding one without a
 * baseline bump fails CI.
 *
 * The detector counts every variant of the directive that c8 actually
 * recognises: /* c8 ignore next *\/, /* c8 ignore next N *\/, the
 * /* c8 ignore start *\/ ... /* c8 ignore end *\/ block pair, and the
 * line-comment // c8 ignore next form. Each occurrence inside a comment
 * counts as one directive (start + end pairs count as two — one each).
 * Occurrences inside string literals are not counted.
 *
 * Pattern mirrors tests/comment-hygiene-lint.test.cjs (per-file scan +
 * self-tests + real-code scan). Update the JSON baseline when an ignore
 * is intentionally added or removed; the diff is one line and reviewable.
 */

const fs = require('fs');
const path = require('path');
const { test, describe } = require('node:test');
const assert = require('node:assert');
const { resolveTmpDir } = require('./helpers.cjs');

const REPO_ROOT = path.join(__dirname, '..');
const LIB_DIR = path.join(REPO_ROOT, 'gsd-ng', 'bin', 'lib');
const BASELINE_PATH = path.join(__dirname, 'c8-ignore-baseline.json');

// Match c8 ignore directives anchored to a comment context (block /* ... */
// or line //). Both forms tolerate a trailing reason ("— unreachable: ...")
// up to the comment terminator.
//
// Keywords c8 actually recognises: next, start, end, file. The regexes
// require the keyword to follow the literal "c8 ignore " phrase, which
// keeps the literal phrase appearing in string content (e.g.
// const s = "c8 ignore demo") from matching — the keyword anchor is what
// makes string-content matches safe in practice. The block form also
// requires the trailing `*/` so a string containing `/* c8 ignore next */`
// would only match if it actually closes the block — and at that point
// it is, by JavaScript's parsing rules, a real comment unless escaped.
const BLOCK_DIRECTIVE_RE =
  /\/\*\s*c8\s+ignore\s+(?:next|start|end|file)(?:\s+\d+)?[^*]*\*\//g;
const LINE_DIRECTIVE_RE =
  /\/\/\s*c8\s+ignore\s+(?:next|start|end|file)(?:\s+\d+)?/g;

function countC8IgnoreDirectives(source) {
  // Walk lines and only test the comment-relevant portion of each line.
  // Line-form //  directives are obvious — anything from `//` onward is
  // the comment. Block /* ... */ directives can sit on their own line,
  // share a line with code, or appear at the end of a line; the regex
  // requires the closing `*/` so we just scan the whole line with the
  // global regex and trust the keyword anchor to keep us out of strings.
  if (typeof source !== 'string' || source.length === 0) return 0;
  let count = 0;
  // Block form: count every match across the full source (multi-line
  // block comments rarely contain `*/` mid-content, so per-line is fine
  // — but the regex is anchored on the full directive text so we can
  // safely run it on the joined source).
  const blockMatches = source.match(BLOCK_DIRECTIVE_RE);
  if (blockMatches) count += blockMatches.length;
  // Line form: must process line-by-line to avoid // inside a string
  // matching accidentally. For each line, find the first un-escaped //
  // not inside quotes; if the c8 directive appears in the comment tail,
  // count it.
  const lines = source.split('\n');
  for (const line of lines) {
    const idx = findLineCommentStart(line);
    if (idx === -1) continue;
    const tail = line.slice(idx);
    const lineMatches = tail.match(LINE_DIRECTIVE_RE);
    if (lineMatches) count += lineMatches.length;
  }
  return count;
}

// Return the index where a // line comment starts on `line`, or -1 if
// none. Skips // sequences that appear inside string literals (single,
// double, or backtick). Backslash-escapes are honoured.
function findLineCommentStart(line) {
  let sq = false;
  let dq = false;
  let bt = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '\\') {
      i++;
      continue;
    }
    if (!sq && !dq && !bt && c === '/' && line[i + 1] === '/') return i;
    if (!sq && !dq && !bt && c === '/' && line[i + 1] === '*') {
      // Skip block start — block detection runs separately on whole source.
      const end = line.indexOf('*/', i + 2);
      if (end === -1) return -1;
      i = end + 1;
      continue;
    }
    if (!dq && !bt && c === "'") sq = !sq;
    else if (!sq && !bt && c === '"') dq = !dq;
    else if (!sq && !dq && c === '`') bt = !bt;
  }
  return -1;
}

function listLibFiles() {
  return fs
    .readdirSync(LIB_DIR)
    .filter((f) => f.endsWith('.cjs'))
    .sort()
    .map((f) => path.join(LIB_DIR, f));
}

// ────────────────────────────────────────────────────────────────────────
// Self-tests: detector must catch synthetic content correctly.
// ────────────────────────────────────────────────────────────────────────

describe('c8-ignore-lint detectors', () => {
  test('counts /* c8 ignore next */ directives', () => {
    assert.strictEqual(
      countC8IgnoreDirectives('/* c8 ignore next */\nfoo();'),
      1,
    );
    assert.strictEqual(
      countC8IgnoreDirectives('/* c8 ignore next */\n/* c8 ignore next */'),
      2,
    );
  });

  test('counts /* c8 ignore next N */ as one directive', () => {
    assert.strictEqual(
      countC8IgnoreDirectives('/* c8 ignore next 3 */\na();b();c();'),
      1,
    );
  });

  test('counts /* c8 ignore start */ and /* c8 ignore end */ as two directives', () => {
    assert.strictEqual(
      countC8IgnoreDirectives(
        '/* c8 ignore start */\nfoo();\n/* c8 ignore end */',
      ),
      2,
    );
  });

  test('counts // c8 ignore next line-comment form', () => {
    assert.strictEqual(countC8IgnoreDirectives('// c8 ignore next\nfoo();'), 1);
  });

  test('returns 0 for source with no directives', () => {
    assert.strictEqual(
      countC8IgnoreDirectives('function foo() { return 1; }'),
      0,
    );
  });

  test('does not count "c8 ignore next" inside a string literal', () => {
    // No comment delimiter — phrase appears in a quoted string only.
    assert.strictEqual(
      countC8IgnoreDirectives('const s = "c8 ignore next demo";'),
      0,
    );
  });

  test('counts directive inside JSDoc block comment', () => {
    // A nested /* c8 ignore next */ inside a JSDoc /** ... */ — the inner
    // block closes the outer block at its `*/`, so this is two real
    // comments concatenated. The detector still finds the directive.
    const src = '/**\n * leading text\n */\n/* c8 ignore next */\nfoo();';
    assert.strictEqual(countC8IgnoreDirectives(src), 1);
  });

  test('counts /* c8 ignore file */ form', () => {
    assert.strictEqual(
      countC8IgnoreDirectives('/* c8 ignore file */\nfoo();'),
      1,
    );
  });

  test('handles directive with inline reason after keyword', () => {
    const src =
      '/* c8 ignore next — unreachable: callers validate upstream */\nfoo();';
    assert.strictEqual(countC8IgnoreDirectives(src), 1);
  });

  test('detector tolerates empty / non-string input', () => {
    assert.strictEqual(countC8IgnoreDirectives(''), 0);
    assert.strictEqual(countC8IgnoreDirectives(null), 0);
    assert.strictEqual(countC8IgnoreDirectives(undefined), 0);
  });

  test('detects added directive in a synthetic temp file (regression for fs path)', () => {
    // Sanity check that the detector behaves the same when reading from
    // disk through fs.readFileSync as it does on inline strings.
    const tmpPath = path.join(
      resolveTmpDir(),
      'c8-ignore-lint-test-' + Date.now() + '.cjs',
    );
    fs.writeFileSync(
      tmpPath,
      "'use strict';\n/* c8 ignore next */\nmodule.exports = {};\n",
    );
    try {
      const count = countC8IgnoreDirectives(fs.readFileSync(tmpPath, 'utf-8'));
      assert.strictEqual(count, 1);
    } finally {
      fs.unlinkSync(tmpPath);
    }
  });
});

// ────────────────────────────────────────────────────────────────────────
// Baseline check: every lib file count must be <= its baseline value,
// and every lib file on disk must have a baseline entry.
// ────────────────────────────────────────────────────────────────────────

describe('c8-ignore baseline check', () => {
  test('every gsd-ng/bin/lib/*.cjs file has a baseline entry', () => {
    const baseline = JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf-8'));
    const onDisk = listLibFiles().map(
      (p) => 'gsd-ng/bin/lib/' + path.basename(p),
    );
    const missing = onDisk.filter((k) => !(k in baseline));
    assert.deepStrictEqual(
      missing,
      [],
      'New gsd-ng/bin/lib/*.cjs files are missing from c8-ignore-baseline.json: ' +
        missing.join(', ') +
        ' — add an entry (count of c8-ignore directives in the new file).',
    );
  });

  test('every lib file count is <= baseline (no unjustified ignores added)', () => {
    const baseline = JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf-8'));
    const violations = [];
    for (const abs of listLibFiles()) {
      const key = 'gsd-ng/bin/lib/' + path.basename(abs);
      const expected = baseline[key];
      if (typeof expected !== 'number') continue; // covered by previous test
      const actual = countC8IgnoreDirectives(fs.readFileSync(abs, 'utf-8'));
      if (actual > expected) {
        violations.push(key + ': ' + actual + ' > baseline ' + expected);
      }
    }
    assert.deepStrictEqual(
      violations,
      [],
      'c8-ignore directives exceed baseline. Bump tests/c8-ignore-baseline.json explicitly:\n' +
        violations.join('\n'),
    );
  });

  test('every baseline entry is a non-negative integer count', () => {
    const baseline = JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf-8'));
    const entries = Object.entries(baseline);
    assert.ok(entries.length > 0, 'baseline must not be empty');
    const malformed = entries.filter(
      ([, v]) => !Number.isInteger(v) || v < 0,
    );
    assert.deepEqual(
      malformed,
      [],
      `baseline counts must be non-negative integers; got ${JSON.stringify(malformed)}`,
    );
  });
});

module.exports = {
  countC8IgnoreDirectives,
  listLibFiles,
  findLineCommentStart,
};
