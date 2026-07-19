'use strict';

// Lint for comments and test/describe names that cite context belonging
// outside the code (pull-request numbers, review-round markers, incident
// history in test-name suffixes).
//
// Rationale (from project guidance): code comments describe invariants
// and subtle constraints. Task-local context belongs in commit messages
// and pull-request descriptions, where it's versioned alongside the
// change but doesn't rot as the codebase evolves. A future reader should
// understand WHAT the code guarantees from the comment, not HOW it got
// that way.
//
// Detection is narrow and high-precision by design. PR/round references
// are flagged only in comment text (not in test-name prose, which often
// legitimately describes test input data). Test-name parenthetical
// suffixes are inspected for regression / PR-number / post-X / pre-X
// markers — the specific shape that collects incident history.

const fs = require('fs');
const path = require('path');
const { test, describe } = require('node:test');
const assert = require('node:assert');
const { resolveTmpDir } = require('./helpers.cjs');

const REPO_ROOT = path.join(__dirname, '..');

// Directory roots scanned recursively. Every `.cjs` / `.js` file below
// any of these (at any depth) gets linted.
const SCAN_DIRS = ['tests', 'hooks', 'bin', 'gsd-ng/bin', 'scripts'];

function listCodeFiles() {
  const seen = new Set();
  for (const dir of SCAN_DIRS) {
    const abs = path.join(REPO_ROOT, dir);
    let entries;
    try { entries = fs.readdirSync(abs, { recursive: true, withFileTypes: true }); }
    catch { continue; }
    for (const e of entries) {
      if (!e.isFile()) continue;
      if (!/\.(cjs|js)$/.test(e.name)) continue;
      const parent = e.parentPath || e.path || abs;
      seen.add(path.relative(REPO_ROOT, path.join(parent, e.name)));
    }
  }
  return [...seen].sort();
}

// Extract the portion of a line that's "comment context" — text after
// `//` — and the portion inside test('...') / describe('...') quotes.
// Returns { comment, testName }, either may be null.
function commentContext(line) {
  const out = { comment: null, testName: null };
  const slashIdx = line.indexOf('//');
  if (slashIdx !== -1 && !isInsideString(line, slashIdx)) {
    out.comment = line.slice(slashIdx + 2);
  }
  const testMatch = /^\s*(?:test|describe|it)\s*\(\s*(['"`])((?:[^'"`\\]|\\.)*)\1/.exec(line);
  if (testMatch) out.testName = testMatch[2];
  return out;
}

// Rough check: is position `idx` inside a single/double-quote string?
// Not a full parser — looks at the substring before `idx` for unmatched
// quotes, ignoring escaped quotes. Good enough for the common cases.
function isInsideString(line, idx) {
  const before = line.slice(0, idx);
  let sq = 0, dq = 0, bt = 0;
  for (let i = 0; i < before.length; i++) {
    const c = before[i];
    if (c === '\\') { i++; continue; }
    if (c === "'" && dq === 0 && bt === 0) sq ^= 1;
    else if (c === '"' && sq === 0 && bt === 0) dq ^= 1;
    else if (c === '`' && sq === 0 && dq === 0) bt ^= 1;
  }
  return sq !== 0 || dq !== 0 || bt !== 0;
}

// Detector: PR / pull-request references in comments.
// Accepts both "pull request #N" and hyphenated "pull-request #N".
// Intentionally NOT checked against test names — test prose often
// describes input data that contains the literal phrase. PR refs in
// test-name parenthetical suffixes are caught by the incident-marker
// detector below.
function findPRReference(line) {
  const ctx = commentContext(line);
  if (!ctx.comment) return null;
  const m = /\b(?:PR|pull[- ]request)\s*#?\d+\b/i.exec(ctx.comment);
  if (m) return "PR reference '" + m[0] + "' — PR context belongs in commit messages / PR descriptions, not in code";
  return null;
}

// Detector: review-round references in comments.
// Same scoping rationale as findPRReference.
function findRoundReference(line) {
  const ctx = commentContext(line);
  if (!ctx.comment) return null;
  const m = /\b(?:round[- ]?\d+|review round)\b/i.exec(ctx.comment);
  if (m) return "Review-round reference '" + m[0] + "' — review history belongs in commit messages, not in code";
  return null;
}

// Detector: incident-history marker inside a parenthetical suffix of a
// test / describe name.
//
// Flags specific *incidents* (PR numbers, post-X / pre-X state markers)
// but NOT *category labels* like `(regression)`, `(regression check)`,
// `(regression guard)`. The latter describe the test's purpose (guards
// a known class from recurring) — that's invariant information worth
// preserving. `(PR #X regression)` is still caught because the PR
// number is what's rotting, not the word "regression".
function findTestNameIncidentMarker(line) {
  const ctx = commentContext(line);
  if (!ctx.testName) return null;
  const parens = /\(([^)]+)\)/g;
  let m;
  while ((m = parens.exec(ctx.testName)) !== null) {
    const inside = m[1];
    if (/\bPR\s*#?\d+\b/i.test(inside)) {
      return "Test name contains '(" + inside + ")' — PR reference belongs in commit message, not test name";
    }
    if (/\b(?:post|pre)-[a-z][a-z0-9_-]*\b/i.test(inside)) {
      return "Test name contains '(" + inside + ")' — describe the current invariant, not its relation to a previous state";
    }
  }
  return null;
}

// Detector: phase / plan references in comments.
// Phase and plan numbers are task-local context — they belong in commit
// messages and PR descriptions, not in code where they rot as work
// progresses. Catches `Phase N`, `Phase N.N`, `Plan N`, `Plan N-N`,
// `Plan N.N` (capital P, ASCII space, digit). Lowercase variants and
// substrings are exempt by design.
//
// Exempt: lines tagged with `BACKWARD COMPAT`, `INVARIANT`, or `LOCKED:`
// (load-bearing references where the citation is part of the contract).
// Opt out per-line with `// hygiene-allow: phase-ref` plus a rationale.
function findPhaseReference(line) {
  const ctx = commentContext(line);
  if (!ctx.comment) return null;
  if (/BACKWARD COMPAT|INVARIANT|LOCKED:/.test(line)) return null;
  if (/hygiene-allow:\s*phase-ref/.test(line)) return null;
  const m = /\b(?:Phase|Plan) \d+(?:[-.]\d+)?\b/.exec(ctx.comment);
  if (m) return "Phase/plan reference '" + m[0] + "' — phase and plan numbers belong in commit messages, not in code";
  return null;
}

// Detector: requirement-ID references in comments.
// Matches the pattern \b[A-Z]{2,}\d*-[A-Z0-9]+\b (uppercase prefix, optional digits,
// dash, uppercase/digit suffix — e.g. requirement labels, ticket IDs, etc.).
// Same exemption + opt-out rules as findPhaseReference.
function findRequirementIdReference(line) {
  const ctx = commentContext(line);
  if (!ctx.comment) return null;
  if (/BACKWARD COMPAT|INVARIANT|LOCKED:/.test(line)) return null;
  if (/hygiene-allow:\s*phase-ref/.test(line)) return null;
  const m = /\b[A-Z]{2,}\d*-[A-Z0-9]+\b/.exec(ctx.comment);
  if (m) return "Requirement ID reference '" + m[0] + "' — requirement IDs belong in commit messages, not in code";
  return null;
}

// Detector: planning-document filenames cited in comments.
// `findPhaseReference` catches the prose form, but not the filename form,
// which is what people actually write. These rot at the same rate — the cited file gets archived by cleanup
// or renumbered by an insert — and the citation then points at nothing.
//
// Gated on a preceding citation verb so that code legitimately documenting the
// filename format it parses is not flagged: a bare pattern description is not
// a citation, `see <file>` is.
//
// Same exemption + opt-out rules as findPhaseReference.
function findPlanningDocCitation(line) {
  const ctx = commentContext(line);
  if (!ctx.comment) return null;
  if (/BACKWARD COMPAT|INVARIANT|LOCKED:/.test(line)) return null;
  if (/hygiene-allow:\s*phase-ref/.test(line)) return null;
  const m =
    /\b(?:see|per|from|in|documented in|proposed in|\u00a7)\s+\S*\b\d+(?:\.\d+)?(?:-\d+)?-(?:PLAN|SUMMARY|VERIFICATION|RESEARCH|CONTEXT|UAT|MILESTONE-AUDIT)\.md\b/i.exec(
      ctx.comment,
    );
  if (m)
    return (
      "Planning-document citation '" +
      m[0].trim() +
      "' — planning filenames rot as phases are archived or renumbered; cite the reasoning, not the document"
    );
  return null;
}

const DETECTORS = [
  { name: 'PR reference', fn: findPRReference, realCodeScan: true },
  { name: 'Review-round reference', fn: findRoundReference, realCodeScan: true },
  { name: 'Test-name incident marker', fn: findTestNameIncidentMarker, realCodeScan: true },
  { name: 'Phase reference', fn: findPhaseReference, realCodeScan: true },
  { name: 'Requirement ID reference', fn: findRequirementIdReference, realCodeScan: true },
  { name: 'Planning-document citation', fn: findPlanningDocCitation, realCodeScan: true },
];

// Walk a file and extract the portion of each line that falls inside a
// /* ... */ block comment. Returns Map<lineIndex, text>. Maintains
// cross-line state so multi-line block comments (JSDoc-style /** ... */)
// are handled correctly. Skips `/*` occurrences inside strings.
function extractBlockCommentText(content) {
  const lines = content.split('\n');
  const result = new Map();
  let inBlock = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let buf = '';
    let pos = 0;
    while (pos < line.length) {
      if (inBlock) {
        const end = line.indexOf('*/', pos);
        if (end === -1) {
          buf += line.slice(pos);
          pos = line.length;
        } else {
          buf += line.slice(pos, end);
          pos = end + 2;
          inBlock = false;
        }
      } else {
        const starIdx = line.indexOf('/*', pos);
        if (starIdx === -1) break;
        if (isInsideString(line, starIdx)) { pos = starIdx + 2; continue; }
        pos = starIdx + 2;
        inBlock = true;
      }
    }
    if (buf) result.set(i, buf);
  }
  return result;
}

function lintFile(abs, { onlyRealCodeScan = false } = {}) {
  const content = fs.readFileSync(abs, 'utf8');
  const lines = content.split('\n');
  const blockMap = extractBlockCommentText(content);
  const violations = [];
  const detectors = onlyRealCodeScan ? DETECTORS.filter(d => d.realCodeScan !== false) : DETECTORS;
  for (let i = 0; i < lines.length; i++) {
    // Enrich the line with any block-comment text on this line so
    // detectors (which use line-comment extraction) also see /* ... */
    // content. Append as a trailing // suffix; commentContext finds
    // the first // and takes everything after it.
    const block = blockMap.get(i);
    const forDetectors = block ? lines[i] + ' //BLOCK ' + block : lines[i];
    for (const { name, fn } of detectors) {
      const reason = fn(forDetectors);
      if (reason) violations.push({ line: i + 1, detector: name, reason, text: lines[i].trim() });
    }
  }
  return violations;
}

// ────────────────────────────────────────────────────────────────────────
// Self-tests: detectors must catch synthetic violations.
// ────────────────────────────────────────────────────────────────────────

describe('comment-hygiene detectors', () => {
  test('findPRReference catches PR #N in comments', () => {
    assert.ok(findPRReference('  // fix for PR #37'));
    assert.ok(findPRReference('// added in pull request 12'));
    assert.ok(findPRReference('// regression from PR42'));
  });

  test('findPRReference accepts hyphenated "pull-request"', () => {
    assert.ok(findPRReference('// fix for pull-request #42'));
    assert.ok(findPRReference('// see Pull-Request 12 for context'));
  });

  test('findPRReference ignores PR references inside test-name prose', () => {
    // Test names often describe input data that happens to contain the
    // literal phrase. Only the incident-marker detector flags PR refs
    // in test-name parenthetical suffixes.
    assert.equal(findPRReference("  test('parses PR from Merge pull request #5678', () => {});"), null);
  });

  test('findPRReference ignores PR references inside non-comment strings', () => {
    assert.equal(findPRReference('const url = "https://github.com/foo/bar/pull/123";'), null);
  });

  test('findPRReference ignores "PRimary" / "uPRead" false-positive prefixes', () => {
    assert.equal(findPRReference('// PRimary key'), null);
    assert.equal(findPRReference('// aPRopos the thing'), null);
  });

  test('findRoundReference catches round-N and review-round phrasings', () => {
    assert.ok(findRoundReference('// round-2 fix'));
    assert.ok(findRoundReference('// from review round 3'));
    assert.ok(findRoundReference('// updated in round 1'));
  });

  test('findRoundReference ignores non-review-round uses', () => {
    assert.equal(findRoundReference('// round to two decimals'), null);
    assert.equal(findRoundReference('// perform one round of hashing'), null);
  });

  test('findTestNameIncidentMarker detects PR-number and post-X / pre-X markers in parentheticals', () => {
    assert.ok(findTestNameIncidentMarker("  test('bypass (PR #37 regression)', () => {});"));
    assert.ok(findTestNameIncidentMarker("  test('bypass (post-reorder)', () => {});"));
    assert.ok(findTestNameIncidentMarker("  test('bypass (pre-fix)', () => {});"));
  });

  test('findTestNameIncidentMarker allows regression category labels', () => {
    // (regression) / (regression check) / (regression guard) are category
    // labels describing the test's purpose — preserving them helps future
    // maintainers understand why the test exists and why it shouldn't be
    // reorganized away. Only specific incident citations (PR numbers,
    // post-X / pre-X markers) are rotting; plain "regression" is not.
    assert.equal(findTestNameIncidentMarker("  test('bypass (regression)', () => {});"), null);
    assert.equal(findTestNameIncidentMarker("  test('phase add still creates dir (regression check)', () => {});"), null);
    assert.equal(findTestNameIncidentMarker("  test('does NOT quote plain values (regression guard)', () => {});"), null);
  });

  test('findTestNameIncidentMarker ignores other legitimate parentheticals', () => {
    assert.equal(findTestNameIncidentMarker("  test('handles null (edge case)', () => {});"), null);
    assert.equal(findTestNameIncidentMarker("  test('foo (mirror of bar)', () => {});"), null);
    assert.equal(findTestNameIncidentMarker("  test('bypass (not auto-approved)', () => {});"), null);
  });

  test('findTestNameIncidentMarker does not trigger on regression outside parens', () => {
    // "regression" plainly in the test title (not in a parenthetical
    // suffix) is allowed — it describes what the test is protecting
    // against, not the incident.
    assert.equal(findTestNameIncidentMarker("  test('regression test for bypass', () => {});"), null);
  });

  test('extractBlockCommentText captures single-line block comments', () => {
    const content = 'const x = 5; /* PR #42 fix */\nconst y = 6;';
    const map = extractBlockCommentText(content);
    assert.ok(map.get(0));
    assert.match(map.get(0), /PR #42/);
    assert.equal(map.get(1), undefined);
  });

  test('extractBlockCommentText captures multi-line JSDoc blocks', () => {
    const content = '/**\n * PR #42 context here\n * more text\n */\nconst x = 5;';
    const map = extractBlockCommentText(content);
    // Each line of the block (0, 1, 2, 3) should have some captured content.
    assert.match(map.get(1), /PR #42/);
    assert.ok(map.has(2));
  });

  test('extractBlockCommentText ignores /* inside strings', () => {
    const content = 'const s = "/* not a comment */";';
    const map = extractBlockCommentText(content);
    assert.equal(map.get(0), undefined);
  });

  test('isInsideString detects unclosed single/double quotes', () => {
    assert.equal(isInsideString('const x = "foo //', 17), true);
    assert.equal(isInsideString('const x = "foo"; //', 17), false);
    assert.equal(isInsideString("const x = 'bar //", 15), true);
  });

  test('commentContext extracts // tail and test() quoted name', () => {
    const c1 = commentContext("  // hello world");
    assert.equal(c1.comment, ' hello world');
    const c2 = commentContext("  test('my name', () => {});");
    assert.equal(c2.testName, 'my name');
    const c3 = commentContext("  describe('suite A', () => {});");
    assert.equal(c3.testName, 'suite A');
  });

  // ── findPhaseReference self-tests ────────────────────────────────────
  test('findPhaseReference catches Phase N in line comments', () => {
    assert.ok(findPhaseReference('  // fix for Phase 50'));
    assert.ok(findPhaseReference('// updated in Phase 54.1'));
    assert.ok(findPhaseReference('// Phase 38 evolution: see docs'));
  });

  test('findPhaseReference violation message includes matched phrase and rationale', () => {
    const msg = findPhaseReference('// fix for Phase 50');
    assert.match(msg, /Phase 50/);
    assert.match(msg, /phase and plan numbers belong in commit messages/);
  });

  test('findPhaseReference catches Plan N and Plan N-N references', () => {
    assert.ok(findPhaseReference('// see Plan 60 for rationale'));
    assert.ok(findPhaseReference('// see Plan 60-10 SUMMARY for rationale'));
    assert.ok(findPhaseReference('// rolled into Plan 4.2'));
  });

  test('findPhaseReference ignores lowercase "phase" / "plan" prefix', () => {
    assert.equal(findPhaseReference('// fix for phase 50'), null);
    assert.equal(findPhaseReference('// test plan covers it'), null);
  });

  test('findPhaseReference ignores phase identifier in code (not in comment)', () => {
    assert.equal(findPhaseReference('const phase50Pattern = /foo/;'), null);
  });

  test('findPhaseReference ignores Phase inside a string literal (no comment)', () => {
    assert.equal(findPhaseReference('const url = "Phase 50 cool";'), null);
  });

  test('findPhaseReference ignores PhaseRunner (no digit, no space)', () => {
    assert.equal(findPhaseReference('// PhaseRunner handles transitions'), null);
  });

  test('findPhaseReference exempts BACKWARD COMPAT lines', () => {
    assert.equal(findPhaseReference(' * BACKWARD COMPAT: This array is unchanged from Phase 31'), null);
  });

  test('findPhaseReference exempts INVARIANT lines', () => {
    assert.equal(findPhaseReference('// some doc INVARIANT: must hold from Phase 12 onward'), null);
  });

  test('findPhaseReference exempts LOCKED: lines', () => {
    assert.equal(findPhaseReference('// LOCKED: matches Phase 7 contract'), null);
  });

  test('findPhaseReference respects hygiene-allow opt-out marker', () => {
    assert.equal(findPhaseReference('// Phase 50 context // hygiene-allow: phase-ref (rationale)'), null);
  });

  test('findPhaseReference catches Phase N in block comments via lintFile', () => {
    const tmpPath = path.join(resolveTmpDir(), 'comment-hygiene-test-' + Date.now() + '.cjs');
    fs.writeFileSync(tmpPath, '\'use strict\';\n/** Phase 50 fix applied here */\nmodule.exports = {};\n');
    const violations = lintFile(tmpPath);
    fs.unlinkSync(tmpPath);
    assert.ok(violations.some(v => v.detector === 'Phase reference'),
      'Expected a Phase reference violation from block comment; got: ' + JSON.stringify(violations));
  });

  // ── findPlanningDocCitation self-tests ────────────────────────────────
  test('findPlanningDocCitation catches a cited plan file', () => {
    assert.ok(findPlanningDocCitation('// the shape proposed in 36.1-01-PLAN.md:92-97'));
  });

  test('findPlanningDocCitation catches see/per/from citation verbs', () => {
    assert.ok(findPlanningDocCitation('// see 54-CONTEXT.md for the rationale'));
    assert.ok(findPlanningDocCitation('// per 62-VERIFICATION.md the gate holds'));
    assert.ok(findPlanningDocCitation('// carried from 50-RESEARCH.md'));
  });

  test('findPlanningDocCitation ignores a filename format being documented', () => {
    // The false-positive class the citation-verb gate exists for: code that
    // parses these filenames must be able to describe their shape.
    assert.equal(findPlanningDocCitation('// matches NN-NN-PLAN.md and NN-SUMMARY.md'), null);
    assert.equal(findPlanningDocCitation('// e.g. 01-01-PLAN.md'), null);
  });

  test('findPlanningDocCitation ignores code and honors the opt-out', () => {
    assert.equal(findPlanningDocCitation("const f = '01-01-PLAN.md';"), null);
    assert.equal(
      findPlanningDocCitation('// see 54-CONTEXT.md // hygiene-allow: phase-ref load-bearing'),
      null,
    );
  });

  // ── findRequirementIdReference self-tests ─────────────────────────────
  test('findRequirementIdReference catches SEC50-MULTILANG in comments', () => {
    assert.ok(findRequirementIdReference('// SEC50-MULTILANG entrypoint'));
  });

  test('findRequirementIdReference catches various requirement ID shapes', () => {
    assert.ok(findRequirementIdReference('// SEC40-TIER tier handling'));
    assert.ok(findRequirementIdReference('// ALLOW-21 narrowing'));
    assert.ok(findRequirementIdReference('// EFF-01 mapping'));
    assert.ok(findRequirementIdReference('// REL43-09 no regression'));
    assert.ok(findRequirementIdReference('// PERM-06 contract'));
    assert.ok(findRequirementIdReference('// RV-04 follow-up'));
  });

  test('findRequirementIdReference violation message includes matched ID and rationale', () => {
    const msg = findRequirementIdReference('// SEC50-MULTILANG entrypoint');
    assert.match(msg, /SEC50-MULTILANG/);
    assert.match(msg, /requirement IDs belong in commit messages/);
  });

  test('findRequirementIdReference ignores underscore-separated identifier in code', () => {
    assert.equal(findRequirementIdReference('const SEC50_THRESHOLD = 5;'), null);
  });

  test('findRequirementIdReference ignores lowercase tail (AB-cd)', () => {
    assert.equal(findRequirementIdReference('// AB-cd lower tail'), null);
  });

  test('findRequirementIdReference ignores single-letter prefix (X-1)', () => {
    assert.equal(findRequirementIdReference('// X-1 single letter'), null);
  });

  test('findRequirementIdReference ignores PR reference shape (not a requirement ID)', () => {
    assert.equal(findRequirementIdReference('// fixed in PR #37'), null);
  });

  test('findRequirementIdReference exempts BACKWARD COMPAT lines', () => {
    assert.equal(findRequirementIdReference(' * BACKWARD COMPAT: keeps SEC40-TIER tier in place'), null);
  });

  test('findRequirementIdReference respects hygiene-allow opt-out marker', () => {
    assert.equal(findRequirementIdReference('// SEC50-MULTILANG entrypoint // hygiene-allow: phase-ref (load-bearing)'), null);
  });
});

// ────────────────────────────────────────────────────────────────────────
// Real-code tests: every scanned code file must have zero violations.
// ────────────────────────────────────────────────────────────────────────

describe('comment-hygiene real code', () => {
  const files = listCodeFiles();

  test('at least one file was scanned (sanity)', () => {
    assert.ok(files.length > 0, 'listCodeFiles() returned no files — scan directories may be misconfigured');
  });

  test('listCodeFiles() recurses into nested directories', () => {
    // tests/e2e/smoke.test.cjs should be covered via recursive scan from
    // the `tests` root. If the scan stops recursing, nested test files
    // would silently escape the lint.
    assert.ok(files.some(f => /^tests\/[^/]+\/.+\.(cjs|js)$/.test(f)),
      'listCodeFiles() should include at least one nested file like tests/<sub>/*.cjs — got: ' + files.slice(0, 5).join(', '));
  });

  for (const rel of files) {
    test(rel + ' has zero comment-hygiene violations', () => {
      const violations = lintFile(path.join(REPO_ROOT, rel), { onlyRealCodeScan: true });
      const formatted = violations.map(v =>
        '  ' + rel + ':' + v.line + ' [' + v.detector + '] ' + v.reason + '\n    line: ' + v.text
      ).join('\n');
      assert.equal(violations.length, 0,
        violations.length + ' violation(s) in ' + rel + ':\n' + formatted);
    });
  }
});

// ── CHANGELOG.md hygiene ────────────────────────────────────────────────────
//
// CHANGELOG.md ships in the npm tarball and is the most user-facing
// release-notes surface in the project. Internal phase numbers and
// uppercase requirement-ID labels mean nothing to npm consumers and are
// even less appropriate here than in code comments — those descriptors
// belong in commit messages and PR descriptions, not in user-visible
// release notes. The exact patterns flagged are defined by the regex
// constants below.
//
// Scope: this scan applies the same regexes used for code-comment
// hygiene to every line of CHANGELOG.md (the whole line is meaningful
// in markdown — no comment-context extraction needed). Lines with the
// existing hygiene-allow opt-out marker or BACKWARD COMPAT / INVARIANT /
// LOCKED: tags are exempted to keep parity with the code-comment lint.

const CHANGELOG_PATH = path.join(REPO_ROOT, 'CHANGELOG.md');
const CHANGELOG_PHASE_RE = /\bPhase \d+(\.\d+)?\b/;
const CHANGELOG_REQ_ID_RE = /\b[A-Z]{2,}\d*-[A-Z0-9]+\b/;
const CHANGELOG_EXEMPT_RE = /BACKWARD COMPAT|INVARIANT|LOCKED:|hygiene-allow:\s*phase-ref/;

describe('CHANGELOG.md user-facing hygiene', () => {
  test('CHANGELOG.md exists', () => {
    assert.ok(fs.existsSync(CHANGELOG_PATH), 'CHANGELOG.md must be present');
  });

  test('CHANGELOG.md has no phase references in user-facing text', () => {
    const lines = fs.readFileSync(CHANGELOG_PATH, 'utf8').split('\n');
    const violations = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (CHANGELOG_EXEMPT_RE.test(line)) continue;
      const m = CHANGELOG_PHASE_RE.exec(line);
      if (m) violations.push({ line: i + 1, match: m[0], text: line });
    }
    const formatted = violations.map(v =>
      '  CHANGELOG.md:' + v.line + " phase reference '" + v.match + "'\n    line: " + v.text
    ).join('\n');
    assert.equal(violations.length, 0,
      violations.length + ' phase reference(s) in CHANGELOG.md (use user-facing language; phase numbers belong in commits/PRs):\n' + formatted);
  });

  test('CHANGELOG.md has no requirement-ID references in user-facing text', () => {
    const lines = fs.readFileSync(CHANGELOG_PATH, 'utf8').split('\n');
    const violations = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (CHANGELOG_EXEMPT_RE.test(line)) continue;
      const m = CHANGELOG_REQ_ID_RE.exec(line);
      if (m) violations.push({ line: i + 1, match: m[0], text: line });
    }
    const formatted = violations.map(v =>
      '  CHANGELOG.md:' + v.line + " requirement-ID reference '" + v.match + "'\n    line: " + v.text
    ).join('\n');
    assert.equal(violations.length, 0,
      violations.length + ' requirement-ID reference(s) in CHANGELOG.md (use user-facing language; IDs belong in commits/PRs):\n' + formatted);
  });
});

module.exports = {
  commentContext,
  isInsideString,
  extractBlockCommentText,
  findPRReference,
  findRoundReference,
  findTestNameIncidentMarker,
  findPhaseReference,
  findRequirementIdReference,
  lintFile,
  listCodeFiles,
};
