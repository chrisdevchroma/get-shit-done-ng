'use strict';
// False-positive corpus regression suite
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

// ── Entropy: decision boundary and real content ──────────────────────────────
//
// The pre-existing entropy fixtures sit at H~6.0 (a repeating base64 cycle) and
// H~4.2 (one pangram repeated). Neither is anywhere near the 5.5 threshold, so
// today a change from '>' to '>=', or a threshold moved by a tenth of a bit,
// passes the suite untouched. The probes below close that gap.

const THRESHOLD = 5.5; // security.cjs — mirrored here so a drift shows up as a failure

function shannon(s) {
  const freq = {};
  for (const ch of s) freq[ch] = (freq[ch] || 0) + 1;
  let H = 0;
  for (const count of Object.values(freq)) {
    const p = count / s.length;
    H -= p * Math.log2(p);
  }
  return H;
}

// Deterministic input whose entropy is set by alphabet size: cycling n distinct
// characters over a full window approaches log2(n). The achieved H is asserted
// rather than assumed, so each fixture verifies itself.
const POOL =
  'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789+/';

function makeEntropy(alphabetSize, len = 256) {
  let out = '';
  for (let i = 0; i < len; i++) out += POOL[i % alphabetSize];
  return out;
}

function hasEntropyFinding(text) {
  return fp
    .entropySegments(scanForInjection(text, { external: true, entropy: true }))
    .length > 0;
}

const BOUNDARY_PROBES = [
  { target: 5.3, alphabet: 40, expectFlagged: false },
  { target: 5.45, alphabet: 44, expectFlagged: false },
  { target: 5.55, alphabet: 47, expectFlagged: true },
  { target: 5.7, alphabet: 52, expectFlagged: true },
];

describe('Entropy: decision-boundary probe (H = 5.3 - 5.7)', () => {
  for (const probe of BOUNDARY_PROBES) {
    test(`H ~ ${probe.target} is ${probe.expectFlagged ? 'flagged' : 'not flagged'}`, () => {
      const text = makeEntropy(probe.alphabet);
      const H = shannon(text);
      assert.ok(
        Math.abs(H - probe.target) <= 0.05,
        `fixture drifted: alphabet ${probe.alphabet} gives H=${H.toFixed(3)}, target ${probe.target} +/- 0.05`,
      );
      // Self-consistency: the probe's expectation must follow from the threshold,
      // so moving THRESHOLD alone cannot leave a stale expectation behind.
      assert.equal(
        probe.expectFlagged,
        H > THRESHOLD,
        `probe expectation disagrees with the threshold it is probing`,
      );
      assert.equal(
        hasEntropyFinding(text),
        probe.expectFlagged,
        `H=${H.toFixed(3)} against threshold ${THRESHOLD}: entropy finding should be ${probe.expectFlagged}`,
      );
    });
  }

  test('the probe brackets the threshold from both sides', () => {
    const below = BOUNDARY_PROBES.filter((p) => !p.expectFlagged);
    const above = BOUNDARY_PROBES.filter((p) => p.expectFlagged);
    assert.ok(below.length >= 2 && above.length >= 2, 'threshold not bracketed');
    const highestClean = Math.max(
      ...below.map((p) => shannon(makeEntropy(p.alphabet))),
    );
    const lowestFlagged = Math.min(
      ...above.map((p) => shannon(makeEntropy(p.alphabet))),
    );
    assert.ok(
      highestClean < THRESHOLD && lowestFlagged > THRESHOLD,
      `probe does not straddle the threshold: clean max ${highestClean.toFixed(3)}, flagged min ${lowestFlagged.toFixed(3)}`,
    );
    assert.ok(
      lowestFlagged - highestClean < 0.15,
      'probe is too coarse to detect a small threshold move',
    );
  });
});

// ── Entropy: measured against both corpora ───────────────────────────────────

describe('Entropy: measured false positives on benign content', () => {
  test('repository walk stays within the entropy budget', () => {
    const b = budget.repo_walk.entropy_fp;
    assert.ok(
      repoWalk.entropy.count <= b.files,
      `entropy flagged ${repoWalk.entropy.count} files, budget allows ${b.files}. ` +
        `Offenders: ${repoWalk.entropy.items.map((i) => i.ref).join(', ')}`,
    );
    assert.ok(
      b.examples.every((e) => 'ref' in e && 'max_H' in e && 'offsets' in e),
      'entropy budget examples must record ref, max_H and offsets',
    );
  });

  test('GSD-prose corpus stays within the entropy budget', () => {
    const b = budget.gsd_prose.entropy_fp;
    assert.ok(
      gsdProse.entropy.count <= b.entries,
      `entropy flagged ${gsdProse.entropy.count} entries, budget allows ${b.entries}. ` +
        `Offenders: ${gsdProse.entropy.items.map((i) => i.ref).join(', ')}`,
    );
  });

  test('the entropy-marginal entries sit in the band where real hits landed', () => {
    // Every entropy hit measured over a real .planning/ corpus fell in
    // H = 5.52 - 5.61, against a threshold of 5.5. That 0.02 - 0.11 bit margin
    // is the finding; these entries reproduce it.
    const marginal = fp
      .loadGsdProse()
      .filter((e) => e.class === 'entropy-marginal');
    assert.ok(marginal.length >= 6, `only ${marginal.length} entropy-marginal entries`);
    for (const e of marginal) {
      assert.ok(
        e.measured_H >= 5.4 && e.measured_H <= 5.65,
        `${e.id}: measured_H ${e.measured_H} outside the 5.40 - 5.65 band`,
      );
      assert.equal(
        hasEntropyFinding(e.text),
        e.measured_H > THRESHOLD,
        `${e.id}: recorded H=${e.measured_H} disagrees with the scanner's own verdict`,
      );
    }
    // The band must straddle the threshold, or it is not probing marginality.
    assert.ok(
      marginal.some((e) => e.measured_H > THRESHOLD) &&
        marginal.some((e) => e.measured_H <= THRESHOLD),
      'entropy-marginal entries all fall on one side of the threshold',
    );
  });

  test('realistic high-entropy content classes are measured, not presumed', () => {
    // Content that plausibly appears in a real repository and is NOT inside a
    // fenced code block, so stripFencedCodeBlocks offers no protection.
    // The expectation is recorded from measurement; no outcome is asserted as
    // desirable here, only as observed.
    const classes = fp
      .loadGsdProse()
      .filter((e) => e.class === 'realistic-high-entropy');
    assert.ok(classes.length >= 3, `only ${classes.length} content-class entries`);
    for (const e of classes) {
      assert.equal(
        hasEntropyFinding(e.text),
        e.trips_entropy,
        `${e.id} (${e.provenance}): recorded trips_entropy=${e.trips_entropy} but the scanner disagrees`,
      );
      // Recorded to three decimals, so the tolerance covers rounding and nothing
      // else. The value must be re-derivable from the text it claims to describe.
      const live = shannon(e.text);
      assert.ok(
        Math.abs(live - e.measured_H) < 0.005,
        `${e.id}: recorded measured_H ${e.measured_H} does not match the live measurement ${live.toFixed(3)}`,
      );
    }
    // Recorded outcome: base64 digests trip; lowercase-hex content does not.
    // Hex spans a 16-character alphabet and cannot reach 5.5 however long it is.
    const tripping = classes.filter((e) => e.trips_entropy);
    assert.ok(
      tripping.length >= 1,
      'no realistic content class trips entropy — measurement looks wrong',
    );
  });
});

// ── The advisory-tier contract ───────────────────────────────────────────────

describe('Entropy: advisory-tier contract', () => {
  test('entropy findings never reach blocked[], on any corpus or probe', () => {
    // This is what bounds the blast radius of every entropy false positive
    // above: an entropy hit can warn, but it can never hard-block an import or
    // fail CI. If this assertion ever fails, the FP numbers in fp-budget.json
    // stop being a noise budget and become an availability risk.
    const samples = [
      ...fp.walkRepoFiles().map((f) => ({ ref: f.ref, text: f.content })),
      ...fp.loadGsdProse().map((e) => ({ ref: e.id, text: e.text })),
      ...BOUNDARY_PROBES.map((p) => ({
        ref: `probe-${p.target}`,
        text: makeEntropy(p.alphabet),
      })),
    ];
    for (const s of samples) {
      const result = scanForInjection(s.text, { external: true, entropy: true });
      for (const entry of result.blocked) {
        assert.ok(
          !String(entry).startsWith('[entropy]'),
          `${s.ref}: entropy finding reached blocked[] — entropy must stay advisory`,
        );
      }
    }
  });

  test('a purely high-entropy input yields tier medium, never high', () => {
    const text = makeEntropy(62);
    const result = scanForInjection(text, { external: true, entropy: true });
    assert.ok(
      fp.entropySegments(result).length > 0,
      'fixture failed to trip entropy at all',
    );
    assert.equal(result.blocked.length, 0, 'high-entropy input must not block');
    assert.equal(result.tier, 'medium');
  });

  test('entropy can be switched off, leaving pattern results untouched', () => {
    const text = makeEntropy(62);
    const off = scanForInjection(text, { external: true, entropy: false });
    assert.equal(fp.entropySegments(off).length, 0);
    assert.equal(off.tier, 'clean');
  });
});
