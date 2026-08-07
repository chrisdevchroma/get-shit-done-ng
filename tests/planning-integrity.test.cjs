/**
 * GSD Tools Tests - Planning Document Integrity Detectors
 *
 * Fixture-driven tests for the validate-health checks that catch drift between
 * planning documents:
 *
 *   W019 - a traceability row whose Status contradicts its requirement checkbox
 *   W023 - roadmap header/checklist/details disagreement, and duplicate phases
 *   W024 - STATE.md contradicting its own progress counters and metrics table
 *
 * Every test builds its own .planning/ tree in a temp dir and runs the real CLI
 * against it. Nothing here reads the repository's own planning data: a test
 * coupled to live planning content fails every time a real phase lands, which
 * makes the suite useless as a guard for exactly the drift it is meant to catch.
 */

const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert');
const {
  PLANNING_FIXTURE_DOCS,
  createPlanningFixture,
  planningCodes: codes,
  planningIssuesWithCode: withCode,
  countPlanningCode: countCode,
} = require('./helpers.cjs');

// ─── Fixture harness ──────────────────────────────────────────────────────────

const { makePlanning, cleanupAll } = createPlanningFixture();

afterEach(cleanupAll);

const { PROJECT_MD, CONSISTENT_ROADMAP, QUIET_STATE } = PLANNING_FIXTURE_DOCS;

// Assemble a REQUIREMENTS.md from checkbox lines and traceability rows.
function requirementsMd(checkboxes, rows) {
  return [
    '# Requirements: fixture',
    '',
    '## v1 Requirements',
    '',
    '### Fixture Group',
    '',
    ...checkboxes,
    '',
    '## Traceability',
    '',
    '| Requirement | Phase | Status | external_ref |',
    '|-------------|-------|--------|--------------|',
    ...rows,
    '',
  ].join('\n');
}

// A project whose only interesting file is REQUIREMENTS.md.
function traceabilityFixture(checkboxes, rows) {
  return makePlanning({
    'PROJECT.md': PROJECT_MD,
    'ROADMAP.md': CONSISTENT_ROADMAP,
    'STATE.md': QUIET_STATE,
    'REQUIREMENTS.md': requirementsMd(checkboxes, rows),
  });
}

// A project whose only interesting file is ROADMAP.md.
function roadmapFixture(roadmap) {
  return makePlanning({
    'PROJECT.md': PROJECT_MD,
    'ROADMAP.md': roadmap,
    'STATE.md': QUIET_STATE,
  });
}

// ─── W019: traceability desync ────────────────────────────────────────────────

describe('validate health W019: traceability status contradicts checkbox', () => {
  test('fires when a checked requirement still has a Planned row', () => {
    const dir = traceabilityFixture(
      ['- [x] **FOO-01**: Something that shipped'],
      ['| FOO-01 | Phase 9 | Planned | |'],
    );

    const hits = withCode(dir, 'W019');
    assert.strictEqual(hits.length, 1, `expected one W019, got ${codes(dir)}`);
    assert.ok(
      hits[0].message.includes('FOO-01'),
      `W019 message must name the offending requirement: ${hits[0].message}`,
    );
  });

  test('stays quiet on an unchecked requirement with a Planned row', () => {
    const dir = traceabilityFixture(
      ['- [ ] **BAR-01**: Something not yet built'],
      ['| BAR-01 | Phase 9 | Planned | |'],
    );

    assert.strictEqual(
      countCode(dir, 'W019'),
      0,
      'unchecked + Planned is internally consistent and must not be flagged',
    );
  });

  test('stays quiet on a desynced SEC40 row', () => {
    const dir = traceabilityFixture(
      [
        '- [x] **SEC40-01**: Hardening that shipped',
        '- [x] **SEC40-TIER**: Tiering that shipped',
      ],
      [
        '| SEC40-01 | Phase 40 | Planned | |',
        '| SEC40-TIER | Phase 40 | Planned | |',
      ],
    );

    assert.strictEqual(
      countCode(dir, 'W019'),
      0,
      'the SEC40 prefix is excluded by predicate — another phase owns those rows',
    );
  });

  test('excludes SEC40 by prefix while still flagging its neighbours', () => {
    const dir = traceabilityFixture(
      [
        '- [x] **SEC40-TIER**: Tiering that shipped',
        '- [x] **FOO-02**: Something else that shipped',
      ],
      [
        '| SEC40-TIER | Phase 40 | Planned | |',
        '| FOO-02 | Phase 9 | Planned | |',
      ],
    );

    const hits = withCode(dir, 'W019');
    assert.strictEqual(
      hits.length,
      1,
      `only the non-excluded row should fire, got ${JSON.stringify(hits)}`,
    );
    assert.ok(hits[0].message.includes('FOO-02'), hits[0].message);
    assert.ok(
      !hits[0].message.includes('SEC40'),
      `the exclusion must be a hard predicate: ${hits[0].message}`,
    );
  });

  test('stays quiet on the retirement convention', () => {
    const dir = traceabilityFixture(
      [
        '- [x] ~~**DIST-04**: Offline installer extracts the tarball~~ *Removed -- npm is the sole install path*',
      ],
      ['| DIST-04 | Phase 4 | ~~Complete~~ Removed | |'],
    );

    assert.strictEqual(
      countCode(dir, 'W019'),
      0,
      'a retired requirement is struck in both places and is not a desync',
    );
  });

  test('stays quiet on the deferral convention', () => {
    const dir = traceabilityFixture(
      [
        '- [x] ~~**WKSTRM-01**: Core workstream namespacing~~ *Deferred to v1.1*',
      ],
      ['| WKSTRM-01 | — | ~~Planned~~ Deferred | |'],
    );

    assert.strictEqual(
      countCode(dir, 'W019'),
      0,
      'a deferred requirement is struck in both places and is not a desync',
    );
  });
});

// ─── W023: roadmap integrity ──────────────────────────────────────────────────

describe('validate health W023: roadmap header, checklist and details agree', () => {
  test('fires when the plan-count header contradicts the plan checklist', () => {
    const dir = roadmapFixture(
      [
        '# Roadmap: fixture',
        '',
        '## Phases',
        '',
        '- [x] **Phase 1: Alpha** - First phase',
        '',
        '## Phase Details',
        '',
        '### Phase 1: Alpha',
        '',
        '**Goal:** Ship alpha',
        '**Plans:** 1/1 plans complete',
        '',
        'Plans:',
        '- [ ] TBD',
        '',
      ].join('\n'),
    );

    const hits = withCode(dir, 'W023');
    assert.ok(
      hits.length >= 1,
      `expected W023 for the header/checklist mismatch, got ${codes(dir)}`,
    );
  });

  test('fires when a details header has no milestone checklist entry', () => {
    const dir = roadmapFixture(
      [
        '# Roadmap: fixture',
        '',
        '## Phases',
        '',
        '- [x] **Phase 1: Alpha** - First phase',
        '',
        '## Phase Details',
        '',
        '### Phase 1: Alpha',
        '',
        '**Goal:** Ship alpha',
        '**Plans:** 1/1 plans complete',
        '',
        'Plans:',
        '- [x] 01-01-PLAN.md — Alpha work',
        '',
        '### Phase 3: Gamma',
        '',
        '**Goal:** Ship gamma',
        '**Plans:** 1/1 plans complete',
        '',
        'Plans:',
        '- [x] 03-01-PLAN.md — Gamma work',
        '',
      ].join('\n'),
    );

    const hits = withCode(dir, 'W023');
    assert.ok(
      hits.length >= 1,
      `expected W023 for the orphaned details section, got ${codes(dir)}`,
    );
    assert.ok(
      hits.some((h) => /\b3\b/.test(h.message)),
      `W023 must name the orphaned phase: ${JSON.stringify(hits)}`,
    );
  });

  test('fires when a checklist entry has no details header', () => {
    const dir = roadmapFixture(
      [
        '# Roadmap: fixture',
        '',
        '## Phases',
        '',
        '- [x] **Phase 1: Alpha** - First phase',
        '- [ ] **Phase 4: Delta** - Fourth phase',
        '',
        '## Phase Details',
        '',
        '### Phase 1: Alpha',
        '',
        '**Goal:** Ship alpha',
        '**Plans:** 1/1 plans complete',
        '',
        'Plans:',
        '- [x] 01-01-PLAN.md — Alpha work',
        '',
      ].join('\n'),
    );

    const hits = withCode(dir, 'W023');
    assert.ok(
      hits.length >= 1,
      `expected W023 for the checklist entry with no details, got ${codes(dir)}`,
    );
    assert.ok(
      hits.some((h) => /\b4\b/.test(h.message)),
      `W023 must name the undocumented phase: ${JSON.stringify(hits)}`,
    );
  });

  test('fires when the same phase number appears twice in the checklist', () => {
    const dir = roadmapFixture(
      [
        '# Roadmap: fixture',
        '',
        '## Phases',
        '',
        '- [x] **Phase 1: Alpha** - First phase',
        '- [x] **Phase 1: Alpha Redux** - Same number, different title',
        '',
        '## Phase Details',
        '',
        '### Phase 1: Alpha',
        '',
        '**Goal:** Ship alpha',
        '**Plans:** 1/1 plans complete',
        '',
        'Plans:',
        '- [x] 01-01-PLAN.md — Alpha work',
        '',
      ].join('\n'),
    );

    const hits = withCode(dir, 'W023');
    assert.ok(
      hits.length >= 1,
      `expected W023 for the duplicate phase number, got ${codes(dir)}`,
    );
  });

  test('stays quiet on a fully consistent roadmap', () => {
    const dir = roadmapFixture(CONSISTENT_ROADMAP);

    assert.strictEqual(
      countCode(dir, 'W023'),
      0,
      'a roadmap whose header, checklist and details agree must not be flagged',
    );
  });
});

// ─── W024: STATE.md self-consistency ──────────────────────────────────────────

describe('validate health W024: STATE.md agrees with its own counters', () => {
  const metricsSection = (rows) =>
    [
      '## Performance Metrics',
      '',
      '**Velocity:**',
      '- Total plans completed: 2',
      '- Average duration: 1.5 min',
      '- Total execution time: 3 min',
      '',
      '**By Phase:**',
      '',
      '| Phase | Plans | Total | Avg/Plan |',
      '|-------|-------|-------|----------|',
      ...rows,
      '',
    ].join('\n');

  test('fires when status is executing but every plan is done and verified', () => {
    const dir = makePlanning({
      'PROJECT.md': PROJECT_MD,
      'ROADMAP.md': CONSISTENT_ROADMAP,
      'STATE.md': [
        '---',
        'gsd_state_version: 1.0',
        'milestone: v1.0',
        'current_phase: 1',
        'current_phase_name: alpha',
        'current_plan: 01-02',
        'status: executing',
        'progress:',
        '  total_phases: 2',
        '  completed_phases: 1',
        '  total_plans: 2',
        '  completed_plans: 2',
        '  percent: 100',
        '---',
        '',
        '# Project State',
        '',
        '## Current Position',
        '',
        '**Progress:** [██████████] 100%',
        '',
      ].join('\n'),
      'phases/01-alpha/01-01-PLAN.md': '# Plan\n',
      'phases/01-alpha/01-01-SUMMARY.md': '# Summary\n',
      'phases/01-alpha/01-02-PLAN.md': '# Plan\n',
      'phases/01-alpha/01-02-SUMMARY.md': '# Summary\n',
      'phases/01-alpha/01-VERIFICATION.md': [
        '---',
        'phase: 01-alpha',
        'verified: 2026-01-01T00:00:00Z',
        'status: passed',
        'score: 2/2 must-haves verified',
        '---',
        '',
        '# Verification',
        '',
      ].join('\n'),
    });

    const hits = withCode(dir, 'W024');
    assert.ok(
      hits.length >= 1,
      `expected W024: an executing phase with all plans done and a passed verification, got ${codes(dir)}`,
    );
  });

  test('stays quiet while plans remain outstanding', () => {
    const dir = makePlanning({
      'PROJECT.md': PROJECT_MD,
      'ROADMAP.md': CONSISTENT_ROADMAP,
      'STATE.md': [
        '---',
        'gsd_state_version: 1.0',
        'milestone: v1.0',
        'current_phase: 1',
        'current_phase_name: alpha',
        'current_plan: 01-01',
        'status: executing',
        'progress:',
        '  total_phases: 2',
        '  completed_phases: 0',
        '  total_plans: 2',
        '  completed_plans: 1',
        '  percent: 50',
        '---',
        '',
        '# Project State',
        '',
        '## Current Position',
        '',
        '**Progress:** [█████░░░░░] 50%',
        '',
      ].join('\n'),
      'phases/01-alpha/01-01-PLAN.md': '# Plan\n',
      'phases/01-alpha/01-01-SUMMARY.md': '# Summary\n',
      'phases/01-alpha/01-02-PLAN.md': '# Plan\n',
    });

    assert.strictEqual(
      countCode(dir, 'W024'),
      0,
      'executing with plans still outstanding is the normal mid-phase state',
    );
  });

  test('fires when the Velocity block contradicts the metrics table', () => {
    const dir = makePlanning({
      'PROJECT.md': PROJECT_MD,
      'ROADMAP.md': CONSISTENT_ROADMAP,
      'STATE.md':
        QUIET_STATE +
        '\n' +
        metricsSection([
          '| Phase 01 P01 | 2min | 2 tasks | 2 files |',
          '| Phase 01 P02 | 3min | 2 tasks | 1 files |',
          '| Phase 01 P03 | 1min | 1 tasks | 1 files |',
          '| Phase 02 P01 | 4min | 2 tasks | 2 files |',
          '| Phase 02 P02 | 2min | 1 tasks | 1 files |',
        ]),
    });

    const hits = withCode(dir, 'W024');
    assert.ok(
      hits.length >= 1,
      `expected W024: Velocity claims 2 plans while the table holds 5 rows, got ${codes(dir)}`,
    );
  });
});
