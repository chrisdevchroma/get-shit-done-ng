'use strict';
// False-positive corpus regression suite (Plan 64-02)
//
// Measures how often the injection detector fires on content that is benign by
// construction, and fails when that count RISES above a committed budget.
//
// Two corpora, because one alone would be misleading:
//
//   Corpus A — a walk of this repository. Real content, but thin on the kind of
//   planning prose where the false positives were actually measured.
//
//   Corpus B — tests/fixtures/security-coverage/gsd-prose-benign.jsonl, a
//   hand-authored corpus of GSD-shaped planning prose. The measurement that
//   motivated this suite was taken over a workspace .planning/ directory, which
//   is not part of this repository and does not exist in a fresh clone. Corpus B
//   reproduces those patterns somewhere the suite can reach them; without it,
//   this file would freeze a near-zero number and prove nothing.
//
// The measurement helpers live in scripts/fp-report.cjs so that the suite and
// the human-facing report walk identical corpora.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { scanForInjection } = require('../gsd-ng/bin/lib/security.cjs');
const fp = require('../scripts/fp-report.cjs');

const BUDGET_PATH = path.join(
  __dirname,
  'fixtures',
  'security-coverage',
  'fp-budget.json',
);

const budget = JSON.parse(fs.readFileSync(BUDGET_PATH, 'utf8'));

// The seven rule families measured over a real .planning/ corpus, in descending
// order of how many files each one tripped. Corpus B must cover all of them.
//
// This list lives here rather than in scripts/fp-report.cjs on purpose: scripts/
// is inside the CI scanner's own scan scope and is not block-exempt, so naming
// these rules there would make the scanner fail its own repository. tests/ is
// outside scan scope precisely because it holds rule-tripping text.
const MEASURED_FAMILIES = [
  'INSTR-OVERRIDE-GENERAL',
  'INSTR-OVERRIDE-IGNORE',
  'JAILBREAK-EXPLICIT',
  'HIDDEN-TAG-SYSTEM',
  'CTX-RESET-NEW-INSTR',
  'AUTHORITY-ROLE-CLAIM',
  'ROLEPLAY-DAN-VARIANT',
];

// Measured once; every assertion below reads these.
const repoWalk = fp.measureRepoWalk();
const gsdProse = fp.measureGsdProse();

// ── Corpus shape ─────────────────────────────────────────────────────────────

describe('FP corpus: shape and reachability', () => {
  test('the repository walk found a non-trivial number of files', () => {
    assert.ok(
      repoWalk.itemCount > 100,
      `repo walk found only ${repoWalk.itemCount} files — the walk roots are probably wrong`,
    );
  });

  test('the GSD-prose corpus is loaded and every entry is benign', () => {
    assert.ok(
      gsdProse.itemCount >= 40,
      `gsd-prose corpus has ${gsdProse.itemCount} entries, expected at least 40`,
    );
    for (const e of fp.loadGsdProse()) {
      assert.equal(
        e.expected_label,
        0,
        `${e.id}: corpus must contain only benign entries`,
      );
    }
  });

  test('all seven measured rule families are represented, 3+ entries each', () => {
    const families = {};
    for (const e of fp.loadGsdProse()) {
      if (!e.rule_family) continue;
      families[e.rule_family] = (families[e.rule_family] || 0) + 1;
    }
    for (const fam of MEASURED_FAMILIES) {
      assert.ok(
        (families[fam] || 0) >= 3,
        `${fam}: ${families[fam] || 0} entries, expected at least 3`,
      );
    }
  });

  test('every family entry actually trips the family it declares', () => {
    for (const e of fp.loadGsdProse()) {
      if (!e.rule_family) continue;
      const hits = fp.patternRuleIds(
        scanForInjection(e.text, { external: true, entropy: false }),
      );
      assert.ok(
        hits.includes(e.rule_family),
        `${e.id}: declares ${e.rule_family} but tripped [${hits.join(', ')}] — broken fixture`,
      );
    }
  });

  test('attack and rule-tripping fixtures are excluded from the repository walk', () => {
    // These files exist to contain rule-tripping text. Walking them would
    // inflate the baseline into meaninglessness, so the exclusion is asserted
    // rather than left to the happenstance of which directories are walked.
    const mustExclude = [
      'tests/fixtures/security-coverage/gsd-prose-benign.jsonl',
      'tests/fixtures/security-coverage/deepset-injection-sample.jsonl',
      'tests/fixtures/security-coverage/lakera-gandalf-sample.jsonl',
      'tests/fixtures/security-coverage/garak-promptinject-sample.jsonl',
      'tests/fixtures/security-coverage/multilang-patterns.jsonl',
      'tests/fixtures/security-coverage/homoglyph-patterns.jsonl',
    ];
    for (const rel of mustExclude) {
      assert.ok(
        fp.isExcludedFromWalk(rel),
        `${rel} must be excluded from the repository walk`,
      );
    }
    const walked = new Set(repoWalk.items.map((i) => i.ref));
    for (const rel of mustExclude) {
      assert.ok(!walked.has(rel), `${rel} leaked into the repository walk`);
    }
  });
});

// ── Pattern FP against the committed budget ──────────────────────────────────

function assertAgainstBudget(corpusName, measured, budgetSection, unit) {
  const budgeted = budgetSection.pattern_fp;

  for (const [ruleId, observed] of Object.entries(measured.patternFp)) {
    const entry = budgeted[ruleId];
    assert.ok(
      entry,
      `${corpusName}: rule ${ruleId} fires on benign content (${observed.count} ${unit}, ` +
        `e.g. ${observed.examples[0]}) but has no entry in fp-budget.json. ` +
        `A new false-positive class must be measured, classified and justified before it lands.`,
    );
    assert.ok(
      observed.count <= entry[unit],
      `${corpusName}: rule ${ruleId} fired on ${observed.count} ${unit}, budget allows ${entry[unit]}. ` +
        `First offender: ${observed.examples[0]}. ` +
        `False positives on benign content may only decrease.`,
    );
    if (observed.count < entry[unit]) {
      console.log(
        `  note: ${corpusName}/${ruleId} fired ${observed.count}x, budget ${entry[unit]} — budget can be tightened`,
      );
    }
  }

  for (const [ruleId, entry] of Object.entries(budgeted)) {
    assert.ok(
      'class' in entry && 'justification' in entry,
      `${corpusName}: budget entry ${ruleId} is missing class or justification`,
    );
    assert.ok(
      ['self-referential', 'ordinary-prose'].includes(entry.class),
      `${corpusName}: budget entry ${ruleId} has unrecognised class "${entry.class}"`,
    );
  }
}

describe('FP budget: pattern hits on benign content', () => {
  test('the budget records both corpora with real measurements', () => {
    assert.ok(budget.repo_walk, 'fp-budget.json is missing repo_walk');
    assert.ok(budget.gsd_prose, 'fp-budget.json is missing gsd_prose');
    assert.ok(
      Object.keys(budget.gsd_prose.pattern_fp).length > 0,
      'gsd_prose.pattern_fp is empty — the synthetic corpus is not being scanned, ' +
        'which is the exact defect this plan exists to avoid',
    );
  });

  test('repository walk stays within budget', () => {
    assertAgainstBudget('repo_walk', repoWalk, budget.repo_walk, 'files');
  });

  test('GSD-prose corpus stays within budget', () => {
    assertAgainstBudget('gsd_prose', gsdProse, budget.gsd_prose, 'entries');
  });

  test('the ordinary-prose control group trips nothing at all', () => {
    // Hard assertion, deliberately not a budget line. A self-referential false
    // positive is a documented cost of shipping a detector that documents
    // itself. A false positive on ordinary prose is the class that reaches
    // users, and it gets no allowance.
    assert.equal(budget.gsd_prose.control_group_must_be_zero, true);
    const offenders = [];
    for (const e of fp.loadGsdProse()) {
      if (e.rule_family) continue;
      const hits = fp.patternRuleIds(
        scanForInjection(e.text, { external: true, entropy: false }),
      );
      if (hits.length) offenders.push(`${e.id} -> [${hits.join(', ')}]`);
    }
    assert.deepEqual(
      offenders,
      [],
      `control-group entries tripped patterns: ${offenders.join('; ')}`,
    );
  });
});
