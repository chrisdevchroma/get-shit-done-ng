'use strict';

/**
 * Contracts for the nyquist validation gate.
 *
 * The gate's failure mode is silent. A compliance flag that nothing writes, a
 * flag written at planning time by the very thing it certifies, and evidence
 * rows citing test files that are absent from the tree all look identical to a
 * passing suite, because nothing asserts any of it. These contracts therefore
 * land before the repairs and are expected to be red until each repair arrives.
 *
 * Structure — and the rule this file is itself the worked example of. A
 * markdown assertion counts as evidence only when it carries all three of:
 *
 *   1. a required-content arm — the behavior is present, at a named anchor
 *   2. a forbidden-content arm — the shape being removed is gone, and the
 *      wrong-fix shape never appears
 *   3. a discrimination self-test — the pattern is run against a synthetic
 *      counterfactual it MUST reject, and a forbidden-content pattern against
 *      a synthetic instance it MUST catch
 *
 * Clause 3 is the load-bearing one. Without it a typo'd regex passes green
 * forever and the contract is decorative: a green light wired to nothing. The
 * counterfactuals live in one map so the self-tests read as a block and cannot
 * be dropped quietly, one at a time.
 *
 * The health-check contracts drive the real CLI against temp .planning/ trees.
 * Grepping the checker's own source for its new condition would be the same
 * inadmissible evidence this file exists to rule out.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert');
const {
  PLANNING_FIXTURE_DOCS,
  createPlanningFixture,
  planningHealth,
  planningCodes,
  planningIssuesWithCode,
  countPlanningCode,
} = require('./helpers.cjs');

const REPO_ROOT = path.join(__dirname, '..');
const readDoc = (rel) => fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');

const EXECUTE_PHASE = readDoc('gsd-ng/workflows/execute-phase.md');
const PLAN_PHASE = readDoc('gsd-ng/workflows/plan-phase.md');
const VALIDATE_PHASE = readDoc('gsd-ng/workflows/validate-phase.md');
const VALIDATE_COMMAND = readDoc('commands/gsd/validate-phase.md');
const PLANNER_AGENT = readDoc('agents/gsd-planner.md');
const EVIDENCE_TIERS_REF = readDoc('gsd-ng/references/nyquist-evidence-tiers.md');
const VALIDATION_TEMPLATE = readDoc('gsd-ng/templates/VALIDATION.md');

// The routing edge belongs in the phase-completion region, not anywhere in a
// 1100-line workflow. Anchoring here is what stops a stray mention elsewhere
// from satisfying the contract.
const COMPLETION_MARKER = '## PHASE COMPLETE';
const COMPLETION_REGION = EXECUTE_PHASE.slice(
  EXECUTE_PHASE.indexOf(COMPLETION_MARKER),
);

// ─── Counterfactuals ─────────────────────────────────────────────────────────
//
// Synthetic documents the patterns are measured against. Each required-content
// pattern must accept the shape that has the behavior and reject the shape that
// merely resembles it; each forbidden-content pattern must catch its own
// anti-pattern and leave the correct form alone.

const COUNTERFACTUALS = {
  // Names the workflow in prose without invoking it. A routing pattern that
  // accepts this is matching a word, not an edge.
  passingMention:
    'Validation is covered elsewhere; see the validate-phase notes for how the audit trail is shaped.',

  // Invokes it on no condition at all.
  ungatedRouting:
    'After the roadmap is updated, always run `{{COMMAND_PREFIX}}validate-phase {X}`.',

  // Invokes it behind the gate, naming the canonical config key and the status
  // that opens it.
  gatedRouting: [
    'Read the VERIFICATION.md status. If it is `passed` and',
    '`workflow.nyquist_validation` is true:',
    '',
    '`{{COMMAND_PREFIX}}validate-phase {X}`',
    '',
    'Otherwise skip validation and present the options below.',
  ].join('\n'),

  // The coupling being removed, written twice — a counting pattern must report
  // 2 here, and a first-match check would report 1 and call the job done.
  researchCoupling: [
    'Skip if `nyquist_validation_enabled` is false OR `research_enabled` is false.',
    'Skip if `nyquist_validation_enabled` is false OR `research_enabled` is false.',
  ].join('\n\n'),

  // The decoupled form: the nyquist toggle still gates, the research clause is
  // gone. Decoupling must not turn the write unconditional.
  decoupledSkip: 'Skip if `nyquist_validation_enabled` is false.',

  // Batch mode pointed straight at the waiver branch — the failure this phase
  // exists to prevent, executed unattended across every phase at once.
  batchAutoWaive:
    'Under `--batch`, answer the gap prompt with "Skip — mark manual-only" and continue.',

  // Batch mode deferring instead of waiving.
  batchDefers: [
    'Under `--batch` the {{USER_QUESTION_TOOL}} gate is skipped.',
    'Batch mode never waives and never promotes on a judgement call: each',
    'unresolved row is appended to `.planning/nyquist-adjudication.md` and the',
    'phase stays `false` until a human adjudicates the queue.',
  ].join('\n'),

  // A planner instructed to certify its own output.
  plannerSelfCert:
    'Set `nyquist_compliant: true` in the VALIDATION.md frontmatter when the plan is written.',

  // The prohibition that replaces it.
  plannerProhibition:
    'Never write `nyquist_compliant: true`. Only validate-phase promotes the flag, and only against an audit trail.',

  // Promotion conditioned on a judgement the run made for itself. The words are
  // reassuring and the property is gone — this is the shape the invariant has to
  // exclude, not an obviously broken one.
  judgementPromotes:
    'Batch mode may write the compliance flag true once the run has judged the remaining rows acceptable.',

  // The invariant as stated: one condition, and it needs no judgement.
  invariantStated: [
    'Batch mode may write the compliance flag true **only** on the all-rows-green path.',
    'Any path involving a judgement call routes to the queue.',
  ].join('\n'),

  // A tier definition with the first two clauses and neither the self-test nor
  // the exclusion list. Everything it says is true; what it omits is the tier.
  tierWithoutSelfTest: [
    'TIER-M — a grep contract over markdown is admissible evidence when it has',
    'a required-content assertion and a forbidden-content assertion against the',
    'file it names.',
  ].join('\n'),

  // The sign-off checklist item the template used to ship. An unanchored count
  // over the tree reads this blank checkbox as a promotion.
  templateSignOffLiteral: '- [ ] `nyquist_compliant: true` set in frontmatter',

  // The prohibition with no reason attached. A rule whose cost is visible and
  // whose reason is not is the kind that gets optimized away.
  plannerRuleWithoutReason:
    'Never write `nyquist_compliant: true`. Only validate-phase promotes the flag.',

  // Step 6 with the trail mandated on update and silently absent from creation.
  // A whole-file search for the trail passes against this; only a search
  // anchored inside each state's section catches it.
  trailOnUpdateOnly: [
    '**State B (create):**',
    '',
    '1. Read the template',
    '2. Write the file',
    '',
    '**State A (update):**',
    '',
    '1. Update the map',
    '2. Append the `## Validation Audit {date}` trail below',
    '',
    '**The audit trail, appended on every run:**',
  ].join('\n'),

  // A rewrite of the validation workflow that dropped the auditor spawn and the
  // audit-trail template along with the sections around them.
  strippedWorkflow: [
    '## 3. Gap Analysis',
    '',
    'Classify each requirement.',
    '',
    '## 4. Generate/Update VALIDATION.md',
    '',
    'Fill frontmatter and the per-task map.',
    '',
  ].join('\n'),
};

// ─── Region helpers ──────────────────────────────────────────────────────────

// Slices of `text` centred on each match of `anchor`. Contracts use these to
// assert two things co-occur, rather than that both appear somewhere in a long
// document — "the file mentions X and also mentions Y" is the weak form this
// file exists to rule out.
function regionsAround(text, anchor, radius = 600) {
  const flags = anchor.flags.includes('g') ? anchor.flags : anchor.flags + 'g';
  const re = new RegExp(anchor.source, flags);
  const out = [];
  let m;
  while ((m = re.exec(text)) !== null) {
    out.push(
      text.slice(
        Math.max(0, m.index - radius),
        m.index + m[0].length + radius,
      ),
    );
    if (m[0].length === 0) re.lastIndex++;
  }
  return out;
}

// `pattern` must be non-global: a stateful regex reused across regions skips
// matches and turns a real failure into a pass.
function someRegion(text, anchor, pattern, radius) {
  assert.ok(!pattern.flags.includes('g'), 'co-occurrence pattern must not be global');
  return regionsAround(text, anchor, radius).some((r) => pattern.test(r));
}

// The slice between two literal markers. Contracts on a document that has two
// parallel branches must assert inside each branch: a requirement satisfied
// once, in the branch that already had it, reads as satisfied everywhere when
// the search is whole-file.
function sectionBetween(text, startMarker, endMarker) {
  const start = text.indexOf(startMarker);
  const end = text.indexOf(endMarker);
  assert.ok(start !== -1, `section start marker missing: ${startMarker}`);
  assert.ok(end !== -1, `section end marker missing: ${endMarker}`);
  assert.ok(
    start < end,
    `section markers out of order — ${startMarker} must precede ${endMarker}`,
  );
  return text.slice(start, end);
}

// ─── Routing edge ────────────────────────────────────────────────────────────

const VALIDATE_ANCHOR = /validate-phase/g;
const ROUTES_TO_VALIDATE = /\{\{COMMAND_PREFIX\}\}validate-phase\b/;
const CANONICAL_CONFIG_KEY = /workflow\.nyquist_validation(?!_enabled)\b/;
const LEGACY_CONFIG_ALIAS = /nyquist_validation_enabled/;
const VERIFICATION_STATUS = /VERIFICATION/;
const PASSED_STATUS = /\bpassed\b/;
const UNGATED_ROUTING =
  /(?:always|unconditionally|regardless of[^\n]{0,40})[^\n]{0,80}validate-phase/i;

describe('nyquist gate: execute-phase routes into validation', () => {
  test('the completion region invokes the validation command', () => {
    assert.ok(
      EXECUTE_PHASE.includes(COMPLETION_MARKER),
      'the completion marker itself is the anchor these contracts hang on',
    );
    assert.match(
      COMPLETION_REGION,
      ROUTES_TO_VALIDATE,
      `the phase-completion region (everything after "${COMPLETION_MARKER}") must invoke the validation command, not merely mention it`,
    );
  });

  test('the routing reads the canonical config key, not the legacy alias', () => {
    assert.ok(
      someRegion(COMPLETION_REGION, VALIDATE_ANCHOR, CANONICAL_CONFIG_KEY),
      'the routing must read workflow.nyquist_validation next to the invocation',
    );
    assert.doesNotMatch(
      EXECUTE_PHASE,
      LEGACY_CONFIG_ALIAS,
      'the legacy alias must not be what execute-phase reads',
    );
  });

  test('the routing is gated on verification having passed', () => {
    assert.ok(
      someRegion(COMPLETION_REGION, VALIDATE_ANCHOR, VERIFICATION_STATUS),
      'the routing must name the verification report it keys off',
    );
    assert.ok(
      someRegion(COMPLETION_REGION, VALIDATE_ANCHOR, PASSED_STATUS),
      'the routing must key off the passed status',
    );
    assert.doesNotMatch(
      EXECUTE_PHASE,
      UNGATED_ROUTING,
      'an unconditional invocation would run validation on failed phases too',
    );
  });

  test('the routing patterns discriminate', () => {
    assert.doesNotMatch(
      COUNTERFACTUALS.passingMention,
      ROUTES_TO_VALIDATE,
      'prose naming the workflow is not a routing edge',
    );
    assert.match(
      COUNTERFACTUALS.gatedRouting,
      ROUTES_TO_VALIDATE,
      'the pattern must accept a real invocation, or it can never go green',
    );
    assert.match(
      COUNTERFACTUALS.ungatedRouting,
      UNGATED_ROUTING,
      'the forbidden-content pattern must catch its own anti-pattern',
    );
    assert.doesNotMatch(
      COUNTERFACTUALS.gatedRouting,
      UNGATED_ROUTING,
      'a gated invocation must not read as an unconditional one',
    );
    assert.match(COUNTERFACTUALS.gatedRouting, CANONICAL_CONFIG_KEY);
    assert.doesNotMatch(
      'read workflow.nyquist_validation_enabled from config',
      CANONICAL_CONFIG_KEY,
      'the canonical-key pattern must reject the legacy alias',
    );
  });
});

// ─── Research decoupling ─────────────────────────────────────────────────────

const RESEARCH_COUPLED_SKIP =
  /Skip if `nyquist_validation_enabled` is false OR `research_enabled` is false/g;
const NYQUIST_ONLY_SKIP =
  /Skip if `nyquist_validation_enabled` is false(?! OR)/g;
const SKIP_ENTIRELY = 'skip validation-strategy creation entirely';

function countMatches(text, pattern) {
  return [...text.matchAll(pattern)].length;
}

describe('nyquist gate: validation strategy is decoupled from research', () => {
  test('neither skip condition still conditions on research being enabled', () => {
    assert.strictEqual(
      countMatches(PLAN_PHASE, RESEARCH_COUPLED_SKIP),
      0,
      'the coupling appears at both the create step and the verify step — fixing one leaves the other passing vacuously',
    );
  });

  test('the escape hatch that skips validation strategy entirely is gone', () => {
    assert.ok(
      !PLAN_PHASE.includes(SKIP_ENTIRELY),
      `plan-phase must not contain the literal "${SKIP_ENTIRELY}"`,
    );
  });

  test('both skip conditions still honor the nyquist toggle', () => {
    assert.ok(
      countMatches(PLAN_PHASE, NYQUIST_ONLY_SKIP) >= 2,
      'decoupling from research must not make the validation write unconditional — both sites keep a toggle-only skip',
    );
  });

  test('the decoupling patterns count rather than stop at the first match', () => {
    assert.strictEqual(
      countMatches(COUNTERFACTUALS.researchCoupling, RESEARCH_COUPLED_SKIP),
      2,
      'the forbidden-content pattern must see both occurrences, not just the first',
    );
    assert.strictEqual(
      countMatches(COUNTERFACTUALS.decoupledSkip, RESEARCH_COUPLED_SKIP),
      0,
      'the decoupled form must not read as the coupled one',
    );
    assert.strictEqual(
      countMatches(COUNTERFACTUALS.researchCoupling, NYQUIST_ONLY_SKIP),
      0,
      'a toggle-only pattern that also accepts the coupled form proves nothing',
    );
    assert.strictEqual(
      countMatches(COUNTERFACTUALS.decoupledSkip, NYQUIST_ONLY_SKIP),
      1,
    );
  });
});

// ─── Batch mode ──────────────────────────────────────────────────────────────

const BATCH_ANCHOR = /--batch/g;
const BATCH_FLAG = /`--batch`/;
const QUESTION_TOOL = /\{\{USER_QUESTION_TOOL\}\}|AskUserQuestion/;
const GATE_SKIPPED = /\b(?:skipped|skip|bypass|not called|no prompt)\b/i;
const ADJUDICATION_QUEUE = /\.planning\/nyquist-adjudication\.md/;
const NEVER_WAIVES =
  /(?:never|must not|may not|does not)[^\n]{0,80}(?:waives?|auto-?waive|promotes?)/i;
const BATCH_AUTO_WAIVES =
  /batch[^\n]{0,120}(?:Skip [—-] mark manual-only|auto-?waive|automatically waive)/i;

describe('nyquist gate: batch mode runs unattended without waiving', () => {
  test('the workflow documents a non-interactive flag', () => {
    assert.match(
      VALIDATE_PHASE,
      BATCH_FLAG,
      'validate-phase must document a batch flag — 83 phases is 83 modal prompts otherwise',
    );
  });

  test('batch mode skips the user gate', () => {
    assert.ok(
      someRegion(VALIDATE_PHASE, BATCH_ANCHOR, QUESTION_TOOL),
      'the batch documentation must say what happens to the question gate',
    );
    assert.ok(
      someRegion(VALIDATE_PHASE, BATCH_ANCHOR, GATE_SKIPPED),
      'the batch documentation must state the gate is skipped, not auto-answered',
    );
  });

  test('batch mode never auto-waives', () => {
    assert.match(
      VALIDATE_PHASE,
      ADJUDICATION_QUEUE,
      'unresolved rows must route to a deferred adjudication queue',
    );
    assert.ok(
      someRegion(VALIDATE_PHASE, BATCH_ANCHOR, NEVER_WAIVES),
      'the workflow must state outright that batch mode never waives and never promotes on judgement',
    );
    assert.doesNotMatch(
      VALIDATE_PHASE,
      BATCH_AUTO_WAIVES,
      'nothing may route batch mode at the manual-only waiver branch — that launders every pending row into an exemption in one unattended run',
    );
  });

  test('the command surface documents the flag', () => {
    assert.match(
      VALIDATE_COMMAND,
      /--batch/,
      'the flag must appear on the command that takes the arguments',
    );
  });

  test('the batch patterns discriminate', () => {
    assert.match(COUNTERFACTUALS.batchDefers, BATCH_FLAG);
    assert.match(COUNTERFACTUALS.batchDefers, QUESTION_TOOL);
    assert.match(COUNTERFACTUALS.batchDefers, GATE_SKIPPED);
    assert.match(COUNTERFACTUALS.batchDefers, ADJUDICATION_QUEUE);
    assert.match(
      COUNTERFACTUALS.batchDefers,
      NEVER_WAIVES,
      'the required-content pattern must accept the deferring form',
    );
    assert.match(
      COUNTERFACTUALS.batchAutoWaive,
      BATCH_AUTO_WAIVES,
      'the forbidden-content pattern must catch a batch run pointed at the waiver branch',
    );
    assert.doesNotMatch(
      COUNTERFACTUALS.batchDefers,
      BATCH_AUTO_WAIVES,
      'deferring must not read as waiving',
    );
    assert.doesNotMatch(
      COUNTERFACTUALS.batchAutoWaive,
      NEVER_WAIVES,
      'a waiving batch mode must not satisfy the never-waives arm',
    );
  });
});

// ─── Planner self-certification ──────────────────────────────────────────────

const PROHIBITION =
  /(?:never|must not|may not|do not|forbidden)[^\n]{0,160}nyquist_compliant/i;
const SETS_COMPLIANT_TRUE = /nyquist_compliant:?\s*`?\s*true/i;
const NEGATED = /\b(?:never|not|no|don't|forbidden|only|prohibited)\b/i;

// Lines instructing that the compliance flag be set true with nothing negating
// the instruction. The prohibition itself quotes the string it bans, so a bare
// occurrence count would flag the fix as the defect.
function unnegatedComplianceDirectives(text) {
  return text
    .split('\n')
    .filter((line) => SETS_COMPLIANT_TRUE.test(line) && !NEGATED.test(line));
}

describe('nyquist gate: the planner may not certify its own output', () => {
  test('the planner carries an explicit prohibition', () => {
    assert.match(
      PLANNER_AGENT,
      PROHIBITION,
      'the planner must be told in so many words not to write the compliance flag true',
    );
  });

  test('nothing tells the planner to set the flag true', () => {
    assert.deepStrictEqual(
      unnegatedComplianceDirectives(PLANNER_AGENT),
      [],
      'only the validation workflow promotes the flag, and only against an audit trail',
    );
  });

  test('the prohibition patterns discriminate', () => {
    assert.match(
      COUNTERFACTUALS.plannerProhibition,
      PROHIBITION,
      'the required-content pattern must accept a real prohibition',
    );
    assert.doesNotMatch(
      COUNTERFACTUALS.plannerSelfCert,
      PROHIBITION,
      'an instruction to self-certify must not read as a prohibition',
    );
    assert.deepStrictEqual(
      unnegatedComplianceDirectives(COUNTERFACTUALS.plannerProhibition),
      [],
      'quoting the banned string inside the ban is not an instruction',
    );
    assert.strictEqual(
      unnegatedComplianceDirectives(COUNTERFACTUALS.plannerSelfCert).length,
      1,
      'the detector must catch a plain instruction to self-certify',
    );
  });
});

// ─── The never-promote-on-judgement invariant ────────────────────────────────
//
// Batch mode not calling the question tool is the easy half. The half that
// erodes is the property underneath it: a run that cannot ask is under pressure
// to decide, and deciding is exactly what it has no standing to do.

const PROMOTE_ONLY_ON_GREEN =
  /may (?:write|promote)[^\n]{0,80}\bonly\b[^\n]{0,80}(?:all-rows-green|all rows green|every row green|no-judgement)/i;
const JUDGEMENT_ROUTES_AWAY =
  /judge?ment[^\n]{0,60}(?:routes? to|goes to|is queued|defer)/i;

describe('nyquist gate: promotion never rests on a judgement the run made', () => {
  test('the workflow states the invariant, not merely the flag', () => {
    assert.match(
      VALIDATE_PHASE,
      PROMOTE_ONLY_ON_GREEN,
      'the one path on which an unattended run may promote must be named, or every path is arguable',
    );
    assert.match(
      VALIDATE_PHASE,
      JUDGEMENT_ROUTES_AWAY,
      'the workflow must say where a judgement call goes instead',
    );
  });

  test('nothing pairs the batch flag with the waiver branch', () => {
    assert.doesNotMatch(
      VALIDATE_PHASE,
      BATCH_AUTO_WAIVES,
      'the waiver branch is the one option the interactive prompt exists to authorize — an unattended run may not take it',
    );
  });

  test('the invariant patterns discriminate', () => {
    assert.match(COUNTERFACTUALS.invariantStated, PROMOTE_ONLY_ON_GREEN);
    assert.match(COUNTERFACTUALS.invariantStated, JUDGEMENT_ROUTES_AWAY);
    assert.doesNotMatch(
      COUNTERFACTUALS.judgementPromotes,
      PROMOTE_ONLY_ON_GREEN,
      'promotion after the run judged the rows acceptable must not read as the invariant',
    );
    assert.doesNotMatch(
      COUNTERFACTUALS.judgementPromotes,
      JUDGEMENT_ROUTES_AWAY,
      'judging rows is not routing them away',
    );
  });
});

// ─── The evidence tiers ──────────────────────────────────────────────────────
//
// A tier that quietly widens is worse than no tier: it relabels the same
// unverified rows as verified ones. The four clauses and the exclusion list are
// what stop the widening, so both are asserted by name.

const TIER_CLAUSES = {
  'required-content': /required-content/i,
  'forbidden-content': /forbidden-content/i,
  'discrimination self-test': /discrimination self-test/i,
  'resolvable subject': /git ls-tree HEAD/,
};
const ALL_FOUR_REQUIRED = /all four/i;
const THREE_IS_NOT_A_PASS = /three of four is not a pass/i;
const EXISTS_SYNC_INADMISSIBLE = /fs\.existsSync[^\n]{0,60}\balone\b/i;

describe('nyquist gate: the evidence tier is written down and bounded', () => {
  test('all four clauses are named', () => {
    for (const [name, pattern] of Object.entries(TIER_CLAUSES)) {
      assert.match(
        EVIDENCE_TIERS_REF,
        pattern,
        `clause "${name}" must be stated — a tier missing a clause is a tier without it`,
      );
    }
    assert.match(
      EVIDENCE_TIERS_REF,
      ALL_FOUR_REQUIRED,
      'the clauses must be required together, not offered as a menu',
    );
    assert.match(
      EVIDENCE_TIERS_REF,
      THREE_IS_NOT_A_PASS,
      'the near-miss case is the one that gets argued, so it is stated outright',
    );
  });

  test('the exclusion list keeps existence checks out', () => {
    assert.match(
      EVIDENCE_TIERS_REF,
      EXISTS_SYNC_INADMISSIBLE,
      'an existence check is the cheapest thing that looks like a test — dropping it from the list is how the tier widens',
    );
  });

  test('the tier patterns discriminate', () => {
    assert.match(COUNTERFACTUALS.tierWithoutSelfTest, TIER_CLAUSES['required-content']);
    assert.match(COUNTERFACTUALS.tierWithoutSelfTest, TIER_CLAUSES['forbidden-content']);
    assert.doesNotMatch(
      COUNTERFACTUALS.tierWithoutSelfTest,
      TIER_CLAUSES['discrimination self-test'],
      'two clauses stated well must not satisfy a check for the third',
    );
    assert.doesNotMatch(
      COUNTERFACTUALS.tierWithoutSelfTest,
      EXISTS_SYNC_INADMISSIBLE,
      'a definition with no exclusion list must fail the exclusion check',
    );
    assert.doesNotMatch(
      'the helper calls fs.existsSync before reading the file',
      EXISTS_SYNC_INADMISSIBLE,
      'incidental prose naming the call is not a ruling on it',
    );
  });
});

// ─── The template's frontmatter surface ──────────────────────────────────────

const FLAG_AUTHORED_FALSE = /^nyquist_compliant: false$/m;
const PROMOTED_LITERAL = /nyquist_compliant:\s*true/;
const MANUAL_ONLY_COUNT = /^manual_only_count:/m;
const EVIDENCE_TIERS_FIELD = /^evidence_tiers:/m;
const TIER_M_DOCUMENTED = /`TIER-M`/;

describe('nyquist gate: the template ships a decomposable claim', () => {
  test('the compliance claim decomposes', () => {
    assert.match(
      VALIDATION_TEMPLATE,
      MANUAL_ONLY_COUNT,
      'compliance stays honest by staying measurable — the carve-out count is published',
    );
    assert.match(VALIDATION_TEMPLATE, EVIDENCE_TIERS_FIELD);
    assert.match(
      VALIDATION_TEMPLATE,
      TIER_M_DOCUMENTED,
      'a row cannot record a tier the template does not document',
    );
    assert.match(
      VALIDATION_TEMPLATE,
      FLAG_AUTHORED_FALSE,
      'the file is authored uncompliant; only the validation run promotes it',
    );
  });

  test('the body ships no bare promoted literal', () => {
    assert.doesNotMatch(
      VALIDATION_TEMPLATE,
      PROMOTED_LITERAL,
      'the sign-off checklist item made an unanchored count over the tree report roughly four times the real number, and it misled an audit before it was found',
    );
  });

  test('the literal pattern discriminates', () => {
    assert.match(
      COUNTERFACTUALS.templateSignOffLiteral,
      PROMOTED_LITERAL,
      'the pattern must catch the checklist form, which is where it actually appeared',
    );
    assert.doesNotMatch(
      '- [ ] Compliance flag promoted by validate-phase (never set by hand)',
      PROMOTED_LITERAL,
      'the reworded item must not read as the literal it replaced',
    );
  });
});

// ─── The audit trail, per state ──────────────────────────────────────────────
//
// Its universal absence is the single artifact that proved the gate had stopped
// running, and a promoted phase without one is now an error. Mandating it on
// update alone would have the reconstruction path manufacture a fresh violation
// on every file it wrote — so each state is asserted inside its own section.

const STATE_B_START = '**State B (create):**';
const STATE_A_START = '**State A (update):**';
const TRAIL_SECTION_START = '**The audit trail, appended on every run:**';
const TRAIL_MANDATE = /Append the `## Validation Audit \{date\}` trail/;

describe('nyquist gate: the audit trail is mandated on both states', () => {
  test('state B, the creation path, appends a trail', () => {
    const stateB = sectionBetween(VALIDATE_PHASE, STATE_B_START, STATE_A_START);
    assert.match(
      stateB,
      TRAIL_MANDATE,
      'a reconstructed file with no trail is indistinguishable from a forged flag, and reports as one',
    );
  });

  test('state A, the update path, appends a trail', () => {
    const stateA = sectionBetween(VALIDATE_PHASE, STATE_A_START, TRAIL_SECTION_START);
    assert.match(
      stateA,
      TRAIL_MANDATE,
      'a run that changed nothing and a run that never happened are otherwise the same file',
    );
  });

  test('the section anchoring is what makes the pair meaningful', () => {
    const cf = COUNTERFACTUALS.trailOnUpdateOnly;
    assert.match(
      cf,
      TRAIL_MANDATE,
      'a whole-file search passes against a document that mandates the trail on one branch only',
    );
    assert.doesNotMatch(
      sectionBetween(cf, STATE_B_START, STATE_A_START),
      TRAIL_MANDATE,
      'anchored inside the creation branch, the same document fails — this is the entire difference',
    );
    assert.match(
      sectionBetween(cf, STATE_A_START, TRAIL_SECTION_START),
      TRAIL_MANDATE,
      'and the branch that does mandate it still passes, so the anchoring is not just stricter everywhere',
    );
  });
});

// ─── The planner prohibition carries its reason ──────────────────────────────

const PROHIBITION_REASON =
  /(?:cannot have verified anything|nothing has been built yet)/i;
const PROMOTING_AUTHORITY = /validate-phase[^\n]{0,80}promote|promote[^\n]{0,80}validate-phase/i;

describe('nyquist gate: the planner prohibition is stated with its reason', () => {
  test('the rule names why, and names who may promote instead', () => {
    assert.match(
      PLANNER_AGENT,
      PROHIBITION_REASON,
      'a rule whose cost is visible and whose reason is not is the kind that gets optimized away',
    );
    assert.match(
      PLANNER_AGENT,
      PROMOTING_AUTHORITY,
      'a prohibition with no named alternative reads as an oversight to route around',
    );
  });

  test('the reason pattern discriminates', () => {
    assert.doesNotMatch(
      COUNTERFACTUALS.plannerRuleWithoutReason,
      PROHIBITION_REASON,
      'the bare rule must not satisfy a check for the reason',
    );
    assert.match(
      COUNTERFACTUALS.plannerRuleWithoutReason,
      PROMOTING_AUTHORITY,
      'the authority arm must accept the bare rule, or it is testing the reason twice',
    );
    assert.match(
      COUNTERFACTUALS.plannerProhibition,
      PROMOTING_AUTHORITY,
      'and must accept the other stated form too',
    );
  });
});

// ─── Over-deletion guard ─────────────────────────────────────────────────────
//
// The repairs downstream rewrite large parts of the validation workflow. These
// two sections are what a rewrite is most likely to drop, and the audit trail
// is the single artifact whose absence proved the gate had stopped running.

const AUDITOR_SPAWN = /^##[^\n]*Spawn gsd-nyquist-auditor/m;
const AUDIT_TRAIL_TEMPLATE = /^## Validation Audit \{date\}/m;

describe('nyquist gate: the validation workflow keeps its auditor and audit trail', () => {
  test('the auditor spawn section survives', () => {
    assert.match(VALIDATE_PHASE, AUDITOR_SPAWN);
  });

  test('the audit-trail template survives', () => {
    assert.match(VALIDATE_PHASE, AUDIT_TRAIL_TEMPLATE);
  });

  test('the over-deletion patterns discriminate', () => {
    assert.doesNotMatch(
      COUNTERFACTUALS.strippedWorkflow,
      AUDITOR_SPAWN,
      'a rewrite that dropped the auditor must fail this guard',
    );
    assert.doesNotMatch(
      COUNTERFACTUALS.strippedWorkflow,
      AUDIT_TRAIL_TEMPLATE,
      'a rewrite that dropped the audit trail must fail this guard',
    );
  });
});

// ─── Health-check fixtures ───────────────────────────────────────────────────
//
// The three checks below are conditions, not strings, so they are driven
// against real .planning/ trees in temp dirs. Nothing here reads the
// repository's own planning data — the suite has to pass in a fresh clone, and
// a detector coupled to live planning content stops guarding the moment real
// work lands.

const { makePlanning, cleanupAll } = createPlanningFixture();

afterEach(cleanupAll);

const { PROJECT_MD, CONSISTENT_ROADMAP, QUIET_STATE } = PLANNING_FIXTURE_DOCS;

const BASE_DOCS = {
  'PROJECT.md': PROJECT_MD,
  'ROADMAP.md': CONSISTENT_ROADMAP,
  'STATE.md': QUIET_STATE,
};

function writeInto(dir, rel, body) {
  const abs = path.join(dir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, body);
}

// Give a fixture a HEAD to resolve evidence against, then drop in whatever must
// exist on disk without being in the tree. A file present only as an untracked
// local artifact is not evidence anyone else can reproduce, so the two cases
// have to be distinguishable in a fixture.
function commitTree(dir, { tracked = {}, untracked = {} } = {}) {
  for (const [rel, body] of Object.entries(tracked)) writeInto(dir, rel, body);
  const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
  git('init', '-q');
  git('config', 'user.email', 'test@test.com');
  git('config', 'user.name', 'Test');
  git('config', 'commit.gpgsign', 'false');
  git('add', '-A');
  git('commit', '-q', '-m', 'fixture');
  for (const [rel, body] of Object.entries(untracked)) writeInto(dir, rel, body);
  return dir;
}

const VALIDATION_MAP_HEADER = [
  '## Per-Task Verification Map',
  '',
  '| Task ID | Plan | Wave | Requirement | Test Type | Automated Command | File Exists | Status |',
  '|---------|------|------|-------------|-----------|-------------------|-------------|--------|',
];

// The template ships this literal as a sign-off checklist item, which is why a
// naive count over the string returns four times the real number of promoted
// phases. A check that anchors inside the frontmatter block is immune; one that
// does not is wrong on every file that carries the template's sign-off.
const SIGN_OFF_CHECKLIST = [
  '## Validation Sign-Off',
  '',
  '- [ ] All tasks have `<automated>` verify or Wave 0 dependencies',
  '- [ ] `nyquist_compliant: true` set in frontmatter',
  '',
  '**Approval:** pending',
  '',
];

const AUDIT_TRAIL = [
  '## Validation Audit 2026-01-01',
  '',
  '| Metric | Count |',
  '|--------|-------|',
  '| Gaps found | 0 |',
  '| Resolved | 0 |',
  '| Escalated | 0 |',
  '',
];

function validationMd({
  compliant = false,
  rows = [],
  sections = [],
  fields = [],
} = {}) {
  return [
    '---',
    'phase: 1',
    'slug: alpha',
    'status: draft',
    `nyquist_compliant: ${compliant}`,
    ...fields,
    'wave_0_complete: false',
    'created: 2026-01-01',
    '---',
    '',
    '# Validation Strategy',
    '',
    ...VALIDATION_MAP_HEADER,
    ...rows,
    '',
    ...sections,
  ].join('\n');
}

const mapRow = (requirement, command, type = 'unit') =>
  `| 01-01-01 | 01 | 1 | ${requirement} | ${type} | ${command} | ✅ | ✅ green |`;

// ─── Executed phase with no validation strategy ──────────────────────────────

const VALIDATION_ARCHITECTURE_RESEARCH = [
  '# Research',
  '',
  '## Validation Architecture',
  '',
  'Test infrastructure notes.',
  '',
].join('\n');

describe('validate health W009: an executed phase carries a validation strategy', () => {
  test('fires on a phase with a plan and a summary and no validation strategy', () => {
    const dir = makePlanning({
      ...BASE_DOCS,
      'phases/02-beta/02-01-PLAN.md': '# Plan\n',
      'phases/02-beta/02-01-SUMMARY.md': '# Summary\n',
    });

    const hits = planningIssuesWithCode(dir, 'W009');
    assert.ok(
      hits.length >= 1,
      `an executed phase with no validation strategy is the shape that actually occurs, got ${planningCodes(dir)}`,
    );
    assert.ok(
      hits.some((h) => h.message.includes('02-beta')),
      `the message must name the phase directory: ${JSON.stringify(hits)}`,
    );
  });

  test('stays quiet on a planned phase that has not executed yet', () => {
    const dir = makePlanning({
      ...BASE_DOCS,
      'phases/02-beta/02-01-PLAN.md': '# Plan\n',
    });

    assert.strictEqual(
      countPlanningCode(dir, 'W009'),
      0,
      'a freshly planned phase has nothing to validate yet — without this arm the check trips on every new phase and gets muted within a week',
    );
  });

  test('still fires on the older shape it already caught', () => {
    const dir = makePlanning({
      ...BASE_DOCS,
      'phases/02-beta/02-RESEARCH.md': VALIDATION_ARCHITECTURE_RESEARCH,
      'phases/02-beta/02-01-PLAN.md': '# Plan\n',
    });

    assert.ok(
      countPlanningCode(dir, 'W009') >= 1,
      'widening the check must not narrow it — research naming a validation architecture with no strategy file still counts',
    );
  });
});

// ─── Phantom evidence ────────────────────────────────────────────────────────

describe('validate health W026: cited test files resolve in the tree', () => {
  test('fires on a row citing a test file that does not exist', () => {
    const dir = commitTree(
      makePlanning({
        ...BASE_DOCS,
        'phases/01-alpha/01-VALIDATION.md': validationMd({
          rows: [mapRow('REQ-GHOST', '`node --test tests/does-not-exist.test.cjs`')],
        }),
      }),
    );

    const hits = planningIssuesWithCode(dir, 'W026');
    assert.ok(
      hits.length >= 1,
      `a row naming a green test that does not exist is a false negative in the release-readiness signal, got ${planningCodes(dir)}`,
    );
    assert.ok(
      hits.some((h) => h.message.includes('REQ-GHOST')),
      `the message must name the row's requirement: ${JSON.stringify(hits)}`,
    );
    assert.ok(
      hits.some((h) => h.message.includes('tests/does-not-exist.test.cjs')),
      `the message must name the missing path: ${JSON.stringify(hits)}`,
    );
  });

  test('stays quiet when the cited test file is in the tree', () => {
    const dir = commitTree(
      makePlanning({
        ...BASE_DOCS,
        'phases/01-alpha/01-VALIDATION.md': validationMd({
          rows: [mapRow('REQ-REAL', '`node --test tests/real.test.cjs`')],
        }),
      }),
      { tracked: { 'tests/real.test.cjs': "require('node:test');\n" } },
    );

    assert.strictEqual(
      countPlanningCode(dir, 'W026'),
      0,
      'evidence that resolves is not a defect',
    );
  });

  test('stays quiet on rows that cite no test file at all', () => {
    const dir = commitTree(
      makePlanning({
        ...BASE_DOCS,
        'phases/01-alpha/01-VALIDATION.md': validationMd({
          rows: [
            mapRow('REQ-MANUAL', '—', 'manual'),
            mapRow('REQ-ANCHOR', 'workflows/validate-phase.md#validation-audit', 'manual'),
          ],
        }),
      }),
    );

    assert.strictEqual(
      countPlanningCode(dir, 'W026'),
      0,
      'a row that correctly claims nothing must not be punished — the check is about test-file citations, not about every path a row mentions',
    );
  });

  test('fires when the cited file exists only as an untracked local artifact', () => {
    const dir = commitTree(
      makePlanning({
        ...BASE_DOCS,
        'phases/01-alpha/01-VALIDATION.md': validationMd({
          rows: [mapRow('REQ-LOCAL', '`node --test tests/untracked.test.cjs`')],
        }),
      }),
      { untracked: { 'tests/untracked.test.cjs': "require('node:test');\n" } },
    );

    assert.ok(
      fs.existsSync(path.join(dir, 'tests', 'untracked.test.cjs')),
      'the fixture must actually put the file on disk, or the case is untested',
    );
    const hits = planningIssuesWithCode(dir, 'W026');
    assert.ok(
      hits.length >= 1,
      `resolution is against git ls-tree HEAD, not the working directory — a file nobody else can check out is not reproducible evidence, got ${planningCodes(dir)}`,
    );
    assert.ok(
      hits.some((h) => h.message.includes('tests/untracked.test.cjs')),
      `the message must name the unreachable path: ${JSON.stringify(hits)}`,
    );
  });
});

// ─── Forged compliance flag ──────────────────────────────────────────────────

describe('validate health W027: a promoted phase carries an audit trail', () => {
  test('fires as an error on a promoted phase with no audit trail', () => {
    const dir = makePlanning({
      ...BASE_DOCS,
      'phases/01-alpha/01-VALIDATION.md': validationMd({
        compliant: true,
        rows: [mapRow('REQ-ONE', '`node --test tests/real.test.cjs`')],
        sections: SIGN_OFF_CHECKLIST,
      }),
    });

    const report = planningHealth(dir);
    const errors = (report.errors || []).filter((i) => i.code === 'W027');
    assert.ok(
      errors.length >= 1,
      `a claim of release readiness with no evidence behind it is an error, not untidiness — got errors ${JSON.stringify(report.errors)} warnings ${JSON.stringify(report.warnings)}`,
    );
    assert.ok(
      errors.some((e) => e.message.includes('01-alpha')),
      `the message must name the phase directory: ${JSON.stringify(errors)}`,
    );
    assert.strictEqual(
      (report.warnings || []).filter((i) => i.code === 'W027').length,
      0,
      'the severity is part of the contract — a warning is dismissible and this is not',
    );
  });

  test('stays quiet on a promoted phase that has an audit trail', () => {
    const dir = makePlanning({
      ...BASE_DOCS,
      'phases/01-alpha/01-VALIDATION.md': validationMd({
        compliant: true,
        rows: [mapRow('REQ-ONE', '`node --test tests/real.test.cjs`')],
        sections: [...AUDIT_TRAIL, ...SIGN_OFF_CHECKLIST],
      }),
    });

    assert.strictEqual(
      countPlanningCode(dir, 'W027'),
      0,
      'a flag earned against a dated audit trail is the shape the check exists to permit',
    );
  });

  test('stays quiet on an audited phase that was correctly not promoted', () => {
    const dir = makePlanning({
      ...BASE_DOCS,
      'phases/01-alpha/01-VALIDATION.md': validationMd({
        compliant: false,
        rows: [mapRow('REQ-ONE', '`node --test tests/real.test.cjs`')],
        sections: [...AUDIT_TRAIL, ...SIGN_OFF_CHECKLIST],
      }),
    });

    assert.strictEqual(
      countPlanningCode(dir, 'W027'),
      0,
      'validated, gaps found, correctly left unpromoted — the check measures evidence, not optimism, and a naive implementation flags exactly the one phase that behaved correctly',
    );
  });

  test('stays quiet when the promoted string appears only in the sign-off checklist', () => {
    const dir = makePlanning({
      ...BASE_DOCS,
      'phases/01-alpha/01-VALIDATION.md': validationMd({
        compliant: false,
        rows: [mapRow('REQ-ONE', '`node --test tests/real.test.cjs`')],
        sections: SIGN_OFF_CHECKLIST,
      }),
    });

    const body = fs.readFileSync(
      path.join(dir, '.planning', 'phases', '01-alpha', '01-VALIDATION.md'),
      'utf8',
    );
    assert.ok(
      body.includes('`nyquist_compliant: true` set in frontmatter'),
      'the fixture must actually carry the checklist line, or the case is untested',
    );
    assert.strictEqual(
      countPlanningCode(dir, 'W027'),
      0,
      'the check must anchor on the frontmatter block — an unanchored match reads the sign-off checklist as a promotion and reports four times the real count',
    );
  });
});

// ─── The standing compliance census ──────────────────────────────────────────
//
// The ratio is the measurement whose absence let the gate decay: every forgery
// was individually invisible and the aggregate was never computed at all. What
// makes it worth publishing is that it decomposes — a census that reported one
// number would be quoted as if the evidence behind it were uniform.

const TIER_FIELDS = [
  'manual_only_count: 2',
  'evidence_tiers: { automated: 7, tier_m: 3, manual: 2 }',
];
// What `gsd-tools frontmatter set` leaves behind when it promotes a phase: the
// flow mapping comes back as a quoted scalar. A reader that accepts only the
// template's shape reports zeros for precisely the phases the gate promoted.
const QUOTED_TIER_FIELDS = [
  'manual_only_count: "1"',
  'evidence_tiers: "{ automated: 4, tier_m: 1, manual: 1 }"',
];

const compliantMd = (fields = []) =>
  validationMd({
    compliant: true,
    fields,
    rows: [mapRow('REQ-ONE', '`node --test tests/real.test.cjs`')],
    sections: [...AUDIT_TRAIL, ...SIGN_OFF_CHECKLIST],
  });

describe('validate health: the compliance census decomposes', () => {
  test('compliant, forged and held are counted apart', () => {
    const dir = makePlanning({
      ...BASE_DOCS,
      'phases/01-alpha/01-VALIDATION.md': compliantMd(),
      'phases/02-beta/02-VALIDATION.md': validationMd({
        compliant: true,
        rows: [mapRow('REQ-TWO', '`node --test tests/real.test.cjs`')],
        sections: SIGN_OFF_CHECKLIST,
      }),
      'phases/03-gamma/03-VALIDATION.md': validationMd({
        rows: [mapRow('REQ-THREE', '`node --test tests/real.test.cjs`')],
        sections: [...AUDIT_TRAIL, ...SIGN_OFF_CHECKLIST],
      }),
    });

    const { nyquist } = planningHealth(dir);
    assert.deepStrictEqual(
      {
        total: nyquist.total,
        compliant: nyquist.compliant,
        forged: nyquist.forged,
        held: nyquist.held,
      },
      { total: 3, compliant: 1, forged: 1, held: 1 },
      'a promoted phase with no audit trail is neither compliant nor an honest hold — folding it into either bucket is how the ratio stopped meaning anything',
    );
    assert.strictEqual(
      nyquist.compliant + nyquist.forged + nyquist.held,
      nyquist.total,
      'the three states must partition the population, or the ratio is unreadable',
    );
  });

  test('the split sums what the compliant phases declare, and says how many did', () => {
    const dir = makePlanning({
      ...BASE_DOCS,
      'phases/01-alpha/01-VALIDATION.md': compliantMd(TIER_FIELDS),
      'phases/02-beta/02-VALIDATION.md': compliantMd(),
      'phases/03-gamma/03-VALIDATION.md': validationMd({
        fields: TIER_FIELDS,
        rows: [mapRow('REQ-HELD', '`node --test tests/real.test.cjs`')],
        sections: [...AUDIT_TRAIL, ...SIGN_OFF_CHECKLIST],
      }),
    });

    const { nyquist } = planningHealth(dir);
    assert.deepStrictEqual(
      nyquist.evidence_tiers,
      { tier_a: 7, tier_m: 3, manual: 2 },
      'the third phase declares the same numbers and is held — evidence that has not been accepted is not evidence the census may quote',
    );
    assert.strictEqual(nyquist.manual_only_count, 2);
    assert.strictEqual(
      nyquist.compliant,
      2,
      'the fixture must have two compliant phases, or the qualifier below is measuring nothing',
    );
    assert.strictEqual(
      nyquist.tiers_declared_by,
      1,
      'one of the two declared a split; publishing the ratio without that is how a sum over some phases gets read as a census of all of them',
    );
  });

  test('a promoted phase declaring nothing contributes zeros, not noise', () => {
    const dir = makePlanning({
      ...BASE_DOCS,
      'phases/01-alpha/01-VALIDATION.md': compliantMd(),
    });

    const { nyquist } = planningHealth(dir);
    assert.strictEqual(nyquist.compliant, 1);
    assert.deepStrictEqual(nyquist.evidence_tiers, {
      tier_a: 0,
      tier_m: 0,
      manual: 0,
    });
    assert.strictEqual(nyquist.manual_only_count, 0);
    assert.strictEqual(
      nyquist.tiers_declared_by,
      0,
      'the field postdates the phases that earned the flag first — an absent declaration is zero declared, not zero evidence',
    );
  });

  test('the quoted rewrite the promotion path leaves behind is read too', () => {
    const dir = makePlanning({
      ...BASE_DOCS,
      'phases/01-alpha/01-VALIDATION.md': compliantMd(QUOTED_TIER_FIELDS),
    });

    const { nyquist } = planningHealth(dir);
    assert.deepStrictEqual(
      nyquist.evidence_tiers,
      { tier_a: 4, tier_m: 1, manual: 1 },
      'the field survives in two shapes and only one of them is the template — a reader that accepts one reports zeros for every phase the gate has actually promoted',
    );
    assert.strictEqual(nyquist.manual_only_count, 1);
    assert.strictEqual(nyquist.tiers_declared_by, 1);
  });

  test('the census is reported on a tree with nothing to count', () => {
    const dir = makePlanning({ ...BASE_DOCS });

    const { nyquist } = planningHealth(dir);
    assert.deepStrictEqual(
      nyquist,
      {
        total: 0,
        compliant: 0,
        forged: 0,
        held: 0,
        manual_only_count: 0,
        evidence_tiers: { tier_a: 0, tier_m: 0, manual: 0 },
        tiers_declared_by: 0,
      },
      'a signal shown only when it looks interesting is the same silence with extra steps — 0/0 is a reading, not an absence',
    );
  });
});

// ─── The rot guard, over the live planning tree ──────────────────────────────
//
// Everything above builds its own .planning/ tree in a temp dir, on purpose.
// This section does the opposite and reads the repository's real one, also on
// purpose: it is a repo-state guard, not a unit test. **Do not delete it for
// consistency with the convention around it** — the convention is right for a
// detector, and wrong for the one assertion whose whole subject is the state of
// this repository's own planning documents.
//
// What it guards. Twelve phases carried `nyquist_compliant: true` with nothing
// recording the flag ever being earned, the earliest for the better part of a
// year, and every one of them would have failed this assertion on the day it
// landed. Nothing measured it, so nothing said so. The assertion costs a
// directory walk.
//
// Two limits, stated rather than implied:
//
//   - The planning tree lives in the workspace above this submodule, so a bare
//     clone of this repository has none and the sweep skips. In CI it is inert.
//     What guards a consumer's tree is health check W027, which runs against
//     whatever `.planning/` the CLI is pointed at; this is the dogfooding half,
//     and it fires on `cd gsd-ng && npm test` — the command this workspace runs
//     constantly.
//   - The predicates are written out here rather than imported from verify.cjs.
//     A contract that asks the checker whether the checker is right cannot fail
//     when the checker is wrong, which is the case that matters.

function findPlanningRoot(start) {
  let dir = path.resolve(start);
  for (;;) {
    const candidate = path.join(dir, '.planning');
    if (fs.existsSync(path.join(candidate, 'phases'))) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

const PLANNING_ROOT = findPlanningRoot(REPO_ROOT);
const NO_LIVE_TREE =
  'no .planning/phases tree above the repository — the guard is inert in a bare clone, and W027 covers the consumer case';

// Anchored inside the frontmatter block. Validation files carry the literal
// `nyquist_compliant: true` in their sign-off checklist, so an unanchored match
// reads a blank checkbox as a promotion and returns roughly four times the real
// number. That miscount has already misled one audit of this tree.
const LIVE_FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---/;
const LIVE_PROMOTED_FLAG = /^nyquist_compliant:\s*true\s*$/m;
const LIVE_AUDIT_TRAIL = /^## Validation Audit\b/m;

const isPromoted = (body) => {
  const fm = String(body).match(LIVE_FRONTMATTER);
  return fm ? LIVE_PROMOTED_FLAG.test(fm[1]) : false;
};
const hasAuditTrail = (body) => LIVE_AUDIT_TRAIL.test(String(body));

function liveValidationFiles(planningRoot) {
  const phasesDir = path.join(planningRoot, 'phases');
  const found = [];
  for (const entry of fs.readdirSync(phasesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const phaseDir = path.join(phasesDir, entry.name);
    for (const file of fs.readdirSync(phaseDir)) {
      if (file.endsWith('-VALIDATION.md')) {
        found.push(path.join(phaseDir, file));
      }
    }
  }
  return found;
}

describe('nyquist rot guard: no compliance flag in the tree stands without an audit trail', () => {
  test(
    'every promoted phase carries a "## Validation Audit" section',
    { skip: PLANNING_ROOT ? false : NO_LIVE_TREE },
    () => {
      const forged = [];
      for (const file of liveValidationFiles(PLANNING_ROOT)) {
        const body = fs.readFileSync(file, 'utf8');
        if (isPromoted(body) && !hasAuditTrail(body)) {
          forged.push(path.relative(PLANNING_ROOT, file));
        }
      }
      assert.deepStrictEqual(
        forged,
        [],
        `a phase claiming compliance with no record of earning it is a false statement about release readiness: ${forged.join(', ')} — run the validation gate and let it promote the flag against evidence, or set the field back to false`,
      );
    },
  );

  test(
    'the sweep is looking at something',
    { skip: PLANNING_ROOT ? false : NO_LIVE_TREE },
    () => {
      const files = liveValidationFiles(PLANNING_ROOT);
      assert.ok(
        files.length > 0,
        'no VALIDATION.md was found at all — the walk is pointed at the wrong directory and the guard above is vacuous',
      );
      const promoted = files.filter((f) =>
        isPromoted(fs.readFileSync(f, 'utf8')),
      );
      assert.ok(
        promoted.length > 0,
        'no promoted phase was found — a mis-anchored pattern matches nothing and passes the guard above green forever, which is exactly the decorative-contract failure this file rules out elsewhere',
      );
    },
  );

  test('the promotion predicate discriminates', () => {
    const earned = validationMd({
      compliant: true,
      rows: [mapRow('REQ-ONE', '`node --test tests/real.test.cjs`')],
      sections: [...AUDIT_TRAIL, ...SIGN_OFF_CHECKLIST],
    });
    const forged = validationMd({
      compliant: true,
      rows: [mapRow('REQ-ONE', '`node --test tests/real.test.cjs`')],
      sections: SIGN_OFF_CHECKLIST,
    });
    const checklistOnly = validationMd({
      compliant: false,
      rows: [mapRow('REQ-ONE', '`node --test tests/real.test.cjs`')],
      sections: SIGN_OFF_CHECKLIST,
    });

    assert.ok(isPromoted(earned), 'a frontmatter flag reading true is a promotion');
    assert.ok(isPromoted(forged), 'the trail is a separate question from the flag');
    assert.ok(
      checklistOnly.includes('`nyquist_compliant: true` set in frontmatter'),
      'the counterfactual must actually carry the checklist line, or the case is untested',
    );
    assert.ok(
      !isPromoted(checklistOnly),
      'an unticked sign-off box is not a promotion — reading it as one is the miscount that returns four times the real number',
    );

    assert.ok(hasAuditTrail(earned), 'the dated trail is what the guard accepts');
    assert.ok(
      !hasAuditTrail(forged),
      'a file with a flag and no trail must fail the trail check, or the guard passes on the only shape it exists to catch',
    );
    assert.ok(
      !hasAuditTrail('Discussion of the ## Validation Audit section follows.\n'),
      'prose naming the heading is not the heading — the check is anchored to the start of a line',
    );
  });
});
