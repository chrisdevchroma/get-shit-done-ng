/**
 * GSD Tools Tests - Roadmap
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const {
  runGsdTools,
  createTempProject,
  createTempGitProject,
  cleanup,
  resolveTmpDir,
} = require('./helpers.cjs');

describe('roadmap get-phase command', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('extracts phase section from ROADMAP.md', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap v1.0

## Phases

### Phase 1: Foundation
**Goal:** Set up project infrastructure
**Plans:** 2 plans

Some description here.

### Phase 2: API
**Goal:** Build REST API
**Plans:** 3 plans
`,
    );

    const result = runGsdTools('roadmap get-phase 1 --json', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.found, true, 'phase should be found');
    assert.strictEqual(output.phase_number, '1', 'phase number correct');
    assert.strictEqual(output.phase_name, 'Foundation', 'phase name extracted');
    assert.strictEqual(
      output.goal,
      'Set up project infrastructure',
      'goal extracted',
    );
  });

  test('returns not found for missing phase', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap v1.0

### Phase 1: Foundation
**Goal:** Set up project
`,
    );

    const result = runGsdTools('roadmap get-phase 5 --json', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.found, false, 'phase should not be found');
  });

  test('handles decimal phase numbers', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap

### Phase 2: Main
**Goal:** Main work

### Phase 2.1: Hotfix
**Goal:** Emergency fix
`,
    );

    const result = runGsdTools('roadmap get-phase 2.1 --json', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.found, true, 'decimal phase should be found');
    assert.strictEqual(output.phase_name, 'Hotfix', 'phase name correct');
    assert.strictEqual(output.goal, 'Emergency fix', 'goal extracted');
  });

  test('extracts full section content', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap

### Phase 1: Setup
**Goal:** Initialize everything

This phase covers:
- Database setup
- Auth configuration
- CI/CD pipeline

### Phase 2: Build
**Goal:** Build features
`,
    );

    const result = runGsdTools('roadmap get-phase 1 --json', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.ok(
      output.section.includes('Database setup'),
      'section includes description',
    );
    assert.ok(
      output.section.includes('CI/CD pipeline'),
      'section includes all bullets',
    );
    assert.ok(
      !output.section.includes('Phase 2'),
      'section does not include next phase',
    );
  });

  test('handles missing ROADMAP.md gracefully', () => {
    const result = runGsdTools('roadmap get-phase 1 --json', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.found, false, 'should return not found');
    assert.strictEqual(
      output.error,
      'ROADMAP.md not found',
      'should explain why',
    );
  });

  test('accepts ## phase headers (two hashes)', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap v1.0

## Phase 1: Foundation
**Goal:** Set up project infrastructure
**Plans:** 2 plans

## Phase 2: API
**Goal:** Build REST API
`,
    );

    const result = runGsdTools('roadmap get-phase 1 --json', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(
      output.found,
      true,
      'phase with ## header should be found',
    );
    assert.strictEqual(output.phase_name, 'Foundation', 'phase name extracted');
    assert.strictEqual(
      output.goal,
      'Set up project infrastructure',
      'goal extracted',
    );
  });

  test('detects malformed ROADMAP with summary list but no detail sections', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap v1.0

## Phases

- [ ] **Phase 1: Foundation** - Set up project
- [ ] **Phase 2: API** - Build REST API
`,
    );

    const result = runGsdTools('roadmap get-phase 1 --json', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.found, false, 'phase should not be found');
    assert.strictEqual(
      output.error,
      'malformed_roadmap',
      'should identify malformed roadmap',
    );
    assert.ok(output.message.includes('missing'), 'should explain the issue');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// roadmap get-phase depends_on and source_todos fields
// ─────────────────────────────────────────────────────────────────────────────

describe('roadmap get-phase depends_on and source_todos', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('returns depends_on when Depends on line is present', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap

### Phase 1: Foundation
**Goal:** Set up project infrastructure
**Depends on:** Phase 44

### Phase 2: Build
**Goal:** Build features
`,
    );

    const result = runGsdTools('roadmap get-phase 1 --json', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.found, true, 'phase should be found');
    assert.strictEqual(
      output.depends_on,
      'Phase 44',
      'depends_on should be extracted',
    );
  });

  test('returns depends_on as null when no Depends on line is present', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap

### Phase 1: Foundation
**Goal:** Set up project infrastructure

### Phase 2: Build
**Goal:** Build features
`,
    );

    const result = runGsdTools('roadmap get-phase 1 --json', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.found, true, 'phase should be found');
    assert.strictEqual(
      output.depends_on,
      null,
      'depends_on should be null when absent',
    );
  });

  test('returns source_todos when Source Todos line is present', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap

### Phase 1: Foundation
**Goal:** Set up project infrastructure
**Source Todos**: \`2026-03-29-discuss-phase-parent-phase-gap-detection.md\`

### Phase 2: Build
**Goal:** Build features
`,
    );

    const result = runGsdTools('roadmap get-phase 1 --json', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.found, true, 'phase should be found');
    assert.ok(
      output.source_todos !== null && output.source_todos !== undefined,
      'source_todos should not be null',
    );
    assert.ok(
      output.source_todos.includes(
        '2026-03-29-discuss-phase-parent-phase-gap-detection.md',
      ),
      `source_todos should contain the filename, got: ${output.source_todos}`,
    );
  });

  test('returns source_todos as null when no Source Todos line is present', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap

### Phase 1: Foundation
**Goal:** Set up project infrastructure

### Phase 2: Build
**Goal:** Build features
`,
    );

    const result = runGsdTools('roadmap get-phase 1 --json', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.found, true, 'phase should be found');
    assert.strictEqual(
      output.source_todos,
      null,
      'source_todos should be null when absent',
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// phase next-decimal command
// ─────────────────────────────────────────────────────────────────────────────

describe('roadmap analyze command', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('missing ROADMAP.md returns error', () => {
    const result = runGsdTools('roadmap analyze --json', tmpDir);
    assert.ok(result.success, `Command should succeed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.error, 'ROADMAP.md not found');
  });

  test('parses phases with goals and disk status', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap v1.0

### Phase 1: Foundation
**Goal:** Set up infrastructure

### Phase 2: Authentication
**Goal:** Add user auth

### Phase 3: Features
**Goal:** Build core features
`,
    );

    // Create phase dirs with varying completion
    const p1 = path.join(tmpDir, '.planning', 'phases', '01-foundation');
    fs.mkdirSync(p1, { recursive: true });
    fs.writeFileSync(path.join(p1, '01-01-PLAN.md'), '# Plan');
    fs.writeFileSync(path.join(p1, '01-01-SUMMARY.md'), '# Summary');

    const p2 = path.join(tmpDir, '.planning', 'phases', '02-authentication');
    fs.mkdirSync(p2, { recursive: true });
    fs.writeFileSync(path.join(p2, '02-01-PLAN.md'), '# Plan');

    const result = runGsdTools('roadmap analyze --json', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.phase_count, 3, 'should find 3 phases');
    assert.ok(
      output.phases[0].disk_status.startsWith('complete'),
      'phase 1 complete',
    );
    assert.strictEqual(
      output.phases[1].disk_status,
      'planned',
      'phase 2 planned',
    );
    assert.strictEqual(
      output.phases[2].disk_status,
      'no_directory',
      'phase 3 no directory',
    );
    assert.strictEqual(output.completed_phases, 1, '1 phase complete');
    assert.strictEqual(output.total_plans, 2, '2 total plans');
    assert.strictEqual(output.total_summaries, 1, '1 total summary');
    assert.strictEqual(output.progress_percent, 50, '50% complete');
    assert.strictEqual(output.current_phase, '2', 'current phase is 2');
  });

  test('extracts goals and dependencies', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap

### Phase 1: Setup
**Goal:** Initialize project
**Depends on:** Nothing

### Phase 2: Build
**Goal:** Build features
**Depends on:** Phase 1
`,
    );

    const result = runGsdTools('roadmap analyze --json', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.phases[0].goal, 'Initialize project');
    assert.strictEqual(output.phases[0].depends_on, 'Nothing');
    assert.strictEqual(output.phases[1].goal, 'Build features');
    assert.strictEqual(output.phases[1].depends_on, 'Phase 1');
  });

  test('next_phase is an object with number and name properties', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap v1.0

## Phases

- [x] **Phase 1: Foundation** - Setup
- [ ] **Phase 2: API** - Build endpoints

### Phase 1: Foundation
**Goal:** Set up project infrastructure

### Phase 2: API
**Goal:** Build REST API
`,
    );

    const p1 = path.join(tmpDir, '.planning', 'phases', '01-foundation');
    fs.mkdirSync(p1, { recursive: true });
    fs.writeFileSync(path.join(p1, '01-01-PLAN.md'), '# Plan 1');
    fs.writeFileSync(path.join(p1, '01-01-SUMMARY.md'), '# Summary 1');

    const result = runGsdTools('roadmap analyze --json', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.ok(output.next_phase !== null, 'next_phase should not be null');
    assert.strictEqual(
      typeof output.next_phase,
      'object',
      'next_phase should be an object',
    );
    assert.strictEqual(
      output.next_phase.number,
      '2',
      'next_phase.number should be "2"',
    );
    assert.strictEqual(
      output.next_phase.name,
      'API',
      'next_phase.name should be "API"',
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// roadmap analyze disk status variants
// ─────────────────────────────────────────────────────────────────────────────

describe('roadmap analyze disk status variants', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('returns researched status for phase dir with only RESEARCH.md', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap

### Phase 1: Exploration
**Goal:** Research the domain
`,
    );

    const p1 = path.join(tmpDir, '.planning', 'phases', '01-exploration');
    fs.mkdirSync(p1, { recursive: true });
    fs.writeFileSync(path.join(p1, '01-RESEARCH.md'), '# Research notes');

    const result = runGsdTools('roadmap analyze --json', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(
      output.phases[0].disk_status,
      'researched',
      'disk_status should be researched',
    );
    assert.strictEqual(
      output.phases[0].has_research,
      true,
      'has_research should be true',
    );
  });

  test('returns discussed status for phase dir with only CONTEXT.md', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap

### Phase 1: Discussion
**Goal:** Gather context
`,
    );

    const p1 = path.join(tmpDir, '.planning', 'phases', '01-discussion');
    fs.mkdirSync(p1, { recursive: true });
    fs.writeFileSync(path.join(p1, '01-CONTEXT.md'), '# Context notes');

    const result = runGsdTools('roadmap analyze --json', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(
      output.phases[0].disk_status,
      'discussed',
      'disk_status should be discussed',
    );
    assert.strictEqual(
      output.phases[0].has_context,
      true,
      'has_context should be true',
    );
  });

  test('returns empty status for phase dir with no recognized files', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap

### Phase 1: Empty
**Goal:** Nothing yet
`,
    );

    const p1 = path.join(tmpDir, '.planning', 'phases', '01-empty');
    fs.mkdirSync(p1, { recursive: true });

    const result = runGsdTools('roadmap analyze --json', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(
      output.phases[0].disk_status,
      'empty',
      'disk_status should be empty',
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// roadmap analyze milestone extraction
// ─────────────────────────────────────────────────────────────────────────────

describe('roadmap analyze milestone extraction', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('extracts milestone headings and version numbers', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap

## v1.0 Test Infrastructure

### Phase 1: Foundation
**Goal:** Set up base

## v1.1 Coverage Hardening

### Phase 2: Coverage
**Goal:** Add coverage
`,
    );

    const result = runGsdTools('roadmap analyze --json', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.ok(
      Array.isArray(output.milestones),
      'milestones should be an array',
    );
    assert.strictEqual(output.milestones.length, 2, 'should find 2 milestones');
    assert.strictEqual(
      output.milestones[0].version,
      'v1.0',
      'first milestone version',
    );
    assert.ok(
      output.milestones[0].heading.includes('v1.0'),
      'first milestone heading contains v1.0',
    );
    assert.strictEqual(
      output.milestones[1].version,
      'v1.1',
      'second milestone version',
    );
    assert.ok(
      output.milestones[1].heading.includes('v1.1'),
      'second milestone heading contains v1.1',
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// roadmap analyze missing phase details
// ─────────────────────────────────────────────────────────────────────────────

describe('roadmap analyze missing phase details', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('detects checklist-only phases missing detail sections', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap

- [ ] **Phase 1: Foundation** - Set up project
- [ ] **Phase 2: API** - Build REST API

### Phase 2: API
**Goal:** Build REST API
`,
    );

    const result = runGsdTools('roadmap analyze --json', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.ok(
      Array.isArray(output.missing_phase_details),
      'missing_phase_details should be an array',
    );
    assert.ok(
      output.missing_phase_details.includes('1'),
      'phase 1 should be in missing details',
    );
    assert.ok(
      !output.missing_phase_details.includes('2'),
      'phase 2 should not be in missing details',
    );
  });

  test('returns null when all checklist phases have detail sections', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap

- [ ] **Phase 1: Foundation** - Set up project
- [ ] **Phase 2: API** - Build REST API

### Phase 1: Foundation
**Goal:** Set up project

### Phase 2: API
**Goal:** Build REST API
`,
    );

    const result = runGsdTools('roadmap analyze --json', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(
      output.missing_phase_details,
      null,
      'missing_phase_details should be null',
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// roadmap get-phase success criteria
// ─────────────────────────────────────────────────────────────────────────────

describe('roadmap get-phase success criteria', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('extracts success_criteria array from phase section', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap

### Phase 1: Test
**Goal:** Test goal
**Success Criteria** (what must be TRUE):
  1. First criterion
  2. Second criterion
  3. Third criterion

### Phase 2: Other
**Goal:** Other goal
`,
    );

    const result = runGsdTools('roadmap get-phase 1 --json', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.found, true, 'phase should be found');
    assert.ok(
      Array.isArray(output.success_criteria),
      'success_criteria should be an array',
    );
    assert.strictEqual(
      output.success_criteria.length,
      3,
      'should have 3 criteria',
    );
    assert.ok(
      output.success_criteria[0].includes('First criterion'),
      'first criterion matches',
    );
    assert.ok(
      output.success_criteria[1].includes('Second criterion'),
      'second criterion matches',
    );
    assert.ok(
      output.success_criteria[2].includes('Third criterion'),
      'third criterion matches',
    );
  });

  test('parses fields when the colon sits outside the bold markers', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap

### Phase 1: Test
**Goal**: Deliver the thing
**Depends on**: Phase 0
**Source Todos**: todo-a.md
**Success Criteria** (what must be TRUE):
  1. Thing works
**Plans**: TBD
`,
    );

    const result = runGsdTools('roadmap get-phase 1 --json', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.goal, 'Deliver the thing', 'goal parses');
    assert.strictEqual(output.depends_on, 'Phase 0', 'depends_on parses');
    assert.strictEqual(output.source_todos, 'todo-a.md', 'source_todos parses');
    assert.deepStrictEqual(
      output.success_criteria,
      ['Thing works'],
      'success_criteria parses',
    );
  });

  test('parses success criteria when the colon sits inside the bold markers', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap

### Phase 1: Test
**Goal:** Legacy goal
**Success Criteria:**
  1. Legacy works
`,
    );

    const result = runGsdTools('roadmap get-phase 1 --json', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.goal, 'Legacy goal', 'goal parses');
    assert.deepStrictEqual(
      output.success_criteria,
      ['Legacy works'],
      'success_criteria parses',
    );
  });

  test('returns empty array when no success criteria present', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap

### Phase 1: Simple
**Goal:** No criteria here
`,
    );

    const result = runGsdTools('roadmap get-phase 1 --json', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.found, true, 'phase should be found');
    assert.ok(
      Array.isArray(output.success_criteria),
      'success_criteria should be an array',
    );
    assert.strictEqual(
      output.success_criteria.length,
      0,
      'should have empty criteria',
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// roadmap update-plan-progress command
// ─────────────────────────────────────────────────────────────────────────────

describe('roadmap update-plan-progress command', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('missing phase number returns error', () => {
    const result = runGsdTools('roadmap update-plan-progress', tmpDir);
    assert.strictEqual(
      result.success,
      false,
      'should fail without phase number',
    );
    // Arg validation layer fires before the handler, producing a "Too few arguments" error
    const hasError =
      result.error.includes('Too few arguments') ||
      result.error.includes('phase number required');
    assert.ok(
      hasError,
      `error should mention missing phase number, got: ${result.error}`,
    );
  });

  test('nonexistent phase returns error', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap

### Phase 1: Test
**Goal:** Test goal
`,
    );

    const result = runGsdTools('roadmap update-plan-progress 99', tmpDir);
    assert.strictEqual(
      result.success,
      false,
      'should fail for nonexistent phase',
    );
    assert.ok(
      result.error.includes('not found'),
      'error should mention not found',
    );
  });

  test('no plans found returns updated false', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap

### Phase 1: Test
**Goal:** Test goal
`,
    );

    // Create phase dir with only a context file (no plans)
    const p1 = path.join(tmpDir, '.planning', 'phases', '01-test');
    fs.mkdirSync(p1, { recursive: true });
    fs.writeFileSync(path.join(p1, '01-CONTEXT.md'), '# Context');

    const result = runGsdTools('roadmap update-plan-progress 1 --json', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.updated, false, 'should not update');
    assert.ok(
      output.reason.includes('No plans'),
      'reason should mention no plans',
    );
    assert.strictEqual(output.plan_count, 0, 'plan_count should be 0');
  });

  test('updates progress for partial completion', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap

### Phase 1: Test
**Goal:** Test goal
**Plans:** TBD

## Progress

| Phase | Milestone | Plans Complete | Status | Completed |
|-------|-----------|----------------|--------|-----------|
| 1. Test | v1.0 | 0/2 | Planned | - |
`,
    );

    // Create phase dir with 2 plans, 1 summary
    const p1 = path.join(tmpDir, '.planning', 'phases', '01-test');
    fs.mkdirSync(p1, { recursive: true });
    fs.writeFileSync(path.join(p1, '01-01-PLAN.md'), '# Plan 1');
    fs.writeFileSync(path.join(p1, '01-02-PLAN.md'), '# Plan 2');
    fs.writeFileSync(path.join(p1, '01-01-SUMMARY.md'), '# Summary 1');

    const result = runGsdTools('roadmap update-plan-progress 1 --json', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.updated, true, 'should update');
    assert.strictEqual(output.plan_count, 2, 'plan_count should be 2');
    assert.strictEqual(output.summary_count, 1, 'summary_count should be 1');
    assert.strictEqual(
      output.status,
      'In Progress',
      'status should be In Progress',
    );
    assert.strictEqual(output.complete, false, 'should not be complete');

    // Verify file was actually modified
    const roadmapContent = fs.readFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      'utf-8',
    );
    assert.ok(
      roadmapContent.includes('1/2'),
      'roadmap should contain updated plan count',
    );
  });

  test('updates progress and checks checkbox on completion', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap

- [ ] **Phase 1: Test** - description

### Phase 1: Test
**Goal:** Test goal
**Plans:** TBD

## Progress

| Phase | Milestone | Plans Complete | Status | Completed |
|-------|-----------|----------------|--------|-----------|
| 1. Test | v1.0 | 0/1 | Planned | - |
`,
    );

    // Create phase dir with 1 plan, 1 summary (complete)
    const p1 = path.join(tmpDir, '.planning', 'phases', '01-test');
    fs.mkdirSync(p1, { recursive: true });
    fs.writeFileSync(path.join(p1, '01-01-PLAN.md'), '# Plan 1');
    fs.writeFileSync(path.join(p1, '01-01-SUMMARY.md'), '# Summary 1');

    const result = runGsdTools('roadmap update-plan-progress 1 --json', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.updated, true, 'should update');
    assert.strictEqual(output.complete, true, 'should be complete');
    assert.strictEqual(output.status, 'Complete', 'status should be Complete');

    // Verify file was actually modified
    const roadmapContent = fs.readFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      'utf-8',
    );
    assert.ok(roadmapContent.includes('[x]'), 'checkbox should be checked');
    assert.ok(
      roadmapContent.includes('completed'),
      'should contain completion date text',
    );
    assert.ok(
      roadmapContent.includes('1/1'),
      'roadmap should contain updated plan count',
    );
  });

  test('missing ROADMAP.md returns updated false', () => {
    // Create phase dir with plans and summaries but NO ROADMAP.md
    const p1 = path.join(tmpDir, '.planning', 'phases', '01-test');
    fs.mkdirSync(p1, { recursive: true });
    fs.writeFileSync(path.join(p1, '01-01-PLAN.md'), '# Plan 1');
    fs.writeFileSync(path.join(p1, '01-01-SUMMARY.md'), '# Summary 1');

    const result = runGsdTools('roadmap update-plan-progress 1 --json', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.updated, false, 'should not update');
    assert.ok(
      output.reason.includes('ROADMAP.md not found'),
      'reason should mention missing ROADMAP.md',
    );
  });

  test('updates the Plans line when the colon sits outside the bold markers', () => {
    const roadmapContent = `# Roadmap

### Phase 50: Build
**Goal**: Build stuff
**Plans**: TBD

## Progress

| Phase | Plans Complete | Status | Completed |
|-------|---------------|--------|-----------|
| 50. Build | 0/1 | Planned |  |
`;
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      roadmapContent,
    );

    const p50 = path.join(tmpDir, '.planning', 'phases', '50-build');
    fs.mkdirSync(p50, { recursive: true });
    fs.writeFileSync(path.join(p50, '50-01-PLAN.md'), '# Plan');
    fs.writeFileSync(path.join(p50, '50-01-SUMMARY.md'), '# Summary');

    const result = runGsdTools('roadmap update-plan-progress 50', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const roadmap = fs.readFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      'utf-8',
    );
    assert.match(
      roadmap,
      /^\*\*Plans\*\*: 1\/1 plans complete$/m,
      'Plans line should be rewritten and keep its colon placement',
    );
  });

  test('leaves a later phase alone when this phase has no Plans line', () => {
    const roadmapContent = `# Roadmap

### Phase 50: Build
**Goal**: Build stuff

### Phase 51: Next
**Goal**: Next stuff
**Plans**: TBD
`;
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      roadmapContent,
    );

    const p50 = path.join(tmpDir, '.planning', 'phases', '50-build');
    fs.mkdirSync(p50, { recursive: true });
    fs.writeFileSync(path.join(p50, '50-01-PLAN.md'), '# Plan');
    fs.writeFileSync(path.join(p50, '50-01-SUMMARY.md'), '# Summary');

    const result = runGsdTools('roadmap update-plan-progress 50', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const roadmap = fs.readFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      'utf-8',
    );
    assert.match(
      roadmap,
      /^\*\*Plans\*\*: TBD$/m,
      "Phase 51's Plans line must not absorb Phase 50's counts",
    );
  });

  test('does not match a longer phase number that appears first', () => {
    const roadmapContent = `# Roadmap

### Phase 50: Fifty
**Goal**: Fifty stuff
**Plans**: TBD-FIFTY

### Phase 5: Five
**Goal**: Five stuff
**Plans**: TBD-FIVE
`;
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      roadmapContent,
    );

    const p5 = path.join(tmpDir, '.planning', 'phases', '05-five');
    fs.mkdirSync(p5, { recursive: true });
    fs.writeFileSync(path.join(p5, '05-01-PLAN.md'), '# Plan');
    fs.writeFileSync(path.join(p5, '05-01-SUMMARY.md'), '# Summary');

    const result = runGsdTools('roadmap update-plan-progress 5', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const roadmap = fs.readFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      'utf-8',
    );
    assert.match(
      roadmap,
      /^\*\*Plans\*\*: TBD-FIFTY$/m,
      "Phase 50's Plans line must not absorb Phase 5's counts",
    );
    assert.match(
      roadmap,
      /^\*\*Plans\*\*: 1\/1 plans complete$/m,
      "Phase 5's Plans line should be rewritten",
    );
  });

  test('does not match a decimal child phase that appears first', () => {
    const roadmapContent = `# Roadmap

### Phase 5.10: Child
**Goal**: Child stuff
**Plans**: TBD-CHILD

### Phase 5.1: Target
**Goal**: Target stuff
**Plans**: TBD-TARGET
`;
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      roadmapContent,
    );

    const p = path.join(tmpDir, '.planning', 'phases', '05.1-target');
    fs.mkdirSync(p, { recursive: true });
    fs.writeFileSync(path.join(p, '05.1-01-PLAN.md'), '# Plan');
    fs.writeFileSync(path.join(p, '05.1-01-SUMMARY.md'), '# Summary');

    const result = runGsdTools('roadmap update-plan-progress 5.1', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const roadmap = fs.readFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      'utf-8',
    );
    assert.match(
      roadmap,
      /^\*\*Plans\*\*: TBD-CHILD$/m,
      "Phase 5.10's Plans line must not absorb Phase 5.1's counts",
    );
  });

  test('preserves Milestone column in 5-column progress table', () => {
    const roadmapContent = `# Roadmap

### Phase 50: Build
**Goal:** Build stuff
**Plans:** 1 plans

## Progress

| Phase | Milestone | Plans Complete | Status | Completed |
|-------|-----------|----------------|--------|-----------|
| 50. Build | v2.0 | 0/1 | Planned |  |
`;
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      roadmapContent,
    );

    const p50 = path.join(tmpDir, '.planning', 'phases', '50-build');
    fs.mkdirSync(p50, { recursive: true });
    fs.writeFileSync(path.join(p50, '50-01-PLAN.md'), '# Plan');
    fs.writeFileSync(path.join(p50, '50-01-SUMMARY.md'), '# Summary');

    const result = runGsdTools('roadmap update-plan-progress 50', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const roadmap = fs.readFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      'utf-8',
    );
    const rowMatch = roadmap.match(/^\|[^\n]*50\. Build[^\n]*$/m);
    assert.ok(rowMatch, 'table row should exist');
    const cells = rowMatch[0]
      .split('|')
      .slice(1, -1)
      .map((c) => c.trim());
    assert.strictEqual(cells.length, 5, 'should have 5 columns');
    assert.strictEqual(
      cells[1],
      'v2.0',
      'Milestone column should be preserved',
    );
    assert.ok(
      cells[3].includes('Complete'),
      'Status column should show Complete',
    );
  });

  test('marks completed plan checkboxes', () => {
    const roadmapContent = `# Roadmap

- [ ] Phase 50: Build
  - [ ] 50-01-PLAN.md
  - [ ] 50-02-PLAN.md

### Phase 50: Build
**Goal:** Build stuff
**Plans:** 2 plans

## Progress

| Phase | Plans Complete | Status | Completed |
|-------|---------------|--------|-----------|
| 50. Build | 0/2 | Planned |  |
`;
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      roadmapContent,
    );

    const p50 = path.join(tmpDir, '.planning', 'phases', '50-build');
    fs.mkdirSync(p50, { recursive: true });
    fs.writeFileSync(path.join(p50, '50-01-PLAN.md'), '# Plan 1');
    fs.writeFileSync(path.join(p50, '50-02-PLAN.md'), '# Plan 2');
    // Only plan 1 has a summary (completed)
    fs.writeFileSync(path.join(p50, '50-01-SUMMARY.md'), '# Summary 1');

    const result = runGsdTools('roadmap update-plan-progress 50', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const roadmap = fs.readFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      'utf-8',
    );
    assert.ok(
      roadmap.includes('[x] 50-01-PLAN.md') || roadmap.includes('[x] 50-01'),
      'completed plan checkbox should be marked',
    );
    assert.ok(
      roadmap.includes('[ ] 50-02-PLAN.md') || roadmap.includes('[ ] 50-02'),
      'incomplete plan checkbox should remain unchecked',
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// roadmap update-plan-progress — rewrite landing verification
// ─────────────────────────────────────────────────────────────────────────────

describe('roadmap update-plan-progress landing verification', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  function completePhase50(roadmapContent) {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      roadmapContent,
    );
    const p50 = path.join(tmpDir, '.planning', 'phases', '50-build');
    fs.mkdirSync(p50, { recursive: true });
    fs.writeFileSync(path.join(p50, '50-01-PLAN.md'), '# Plan');
    fs.writeFileSync(path.join(p50, '50-01-SUMMARY.md'), '# Summary');
    const result = runGsdTools('roadmap update-plan-progress 50 --json', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);
    return JSON.parse(result.output);
  }

  test('a conformant roadmap reports no missed targets', () => {
    const output = completePhase50(`# Roadmap

- [ ] **Phase 50: Build** - build stuff

### Phase 50: Build
**Goal**: Build stuff
**Plans**: TBD

## Progress

| Phase | Plans Complete | Status | Completed |
|-------|---------------|--------|-----------|
| 50. Build | 0/1 | Planned |  |
`);
    assert.strictEqual(output.updated, true, 'should update');
    assert.deepStrictEqual(
      output.missed_targets,
      [],
      'every target landed, so nothing should be reported',
    );
  });

  test('names the Plans line when the label is not bold', () => {
    const output = completePhase50(`# Roadmap

### Phase 50: Build
**Goal**: Build stuff
Plans: TBD

## Progress

| Phase | Plans Complete | Status | Completed |
|-------|---------------|--------|-----------|
| 50. Build | 0/1 | Planned |  |
`);
    assert.deepStrictEqual(
      output.missed_targets,
      ['plans-line'],
      'a Plans line the rewrite cannot reach must be named',
    );
  });

  test('does not claim success when no target matched', () => {
    const before = `# Roadmap

### Phase 50: Build
**Goal**: Build stuff
Plans: TBD
`;
    const output = completePhase50(before);
    assert.strictEqual(
      output.updated,
      false,
      'nothing was rewritten, so the command must not report an update',
    );
    assert.deepStrictEqual(output.missed_targets, ['plans-line']);
    assert.strictEqual(
      fs.readFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), 'utf-8'),
      before,
      'a run that changed nothing must not rewrite the file',
    );
  });

  test('a phase with no Plans line at all is not reported as missed', () => {
    const output = completePhase50(`# Roadmap

### Phase 50: Build
**Goal**: Build stuff

## Progress

| Phase | Plans Complete | Status | Completed |
|-------|---------------|--------|-----------|
| 50. Build | 0/1 | Planned |  |
`);
    assert.strictEqual(output.updated, true, 'the table row still landed');
    assert.deepStrictEqual(
      output.missed_targets,
      [],
      'an absent Plans line is not a missed target',
    );
  });

  test('an already-ticked checkbox is not reported as missed', () => {
    const output = completePhase50(`# Roadmap

- [x] **Phase 50: Build** - build stuff

### Phase 50: Build
**Goal**: Build stuff
**Plans**: TBD
`);
    assert.deepStrictEqual(
      output.missed_targets,
      [],
      're-running against a ticked checkbox must stay silent',
    );
  });

  test('a roadmap with no progress table is not reported as missed', () => {
    const output = completePhase50(`# Roadmap

### Phase 50: Build
**Goal**: Build stuff
**Plans**: TBD
`);
    assert.strictEqual(output.updated, true, 'the Plans line landed');
    assert.deepStrictEqual(
      output.missed_targets,
      [],
      'an absent progress table is not a missed target',
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// zero-padded phase arguments
// ─────────────────────────────────────────────────────────────────────────────

describe('roadmap zero-padded phase arguments', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  function seedPhase5() {
    const p5 = path.join(tmpDir, '.planning', 'phases', '05-five');
    fs.mkdirSync(p5, { recursive: true });
    fs.writeFileSync(path.join(p5, '05-01-PLAN.md'), '# Plan');
    fs.writeFileSync(path.join(p5, '05-01-SUMMARY.md'), '# Summary');
  }

  test('a padded argument rewrites the same targets as a bare one', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap

- [ ] **Phase 5: Five** - the real one

### Phase 5: Five
**Goal**: Do five
**Plans**: TBD

## Progress

| Phase | Plans Complete | Status | Completed |
|-------|---------------|--------|-----------|
| 5. Five | 0/1 | Planned |  |
`,
    );
    seedPhase5();

    const result = runGsdTools('roadmap update-plan-progress 05 --json', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);
    const output = JSON.parse(result.output);
    assert.strictEqual(output.updated, true, 'should update');
    assert.deepStrictEqual(output.missed_targets, [], 'every target landed');

    const roadmap = fs.readFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      'utf-8',
    );
    assert.match(
      roadmap,
      /^\*\*Plans\*\*: 1\/1 plans complete$/m,
      'the detail section must agree with the progress table',
    );
    assert.match(roadmap, /^- \[x\] \*\*Phase 5: Five\*\*/m);
    assert.match(roadmap, /^\| 5\. Five \| 1\/1 \| Complete/m);
  });

  test('a padded argument still rejects a longer phase number', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap

### Phase 50: Fifty
**Goal**: Fifty stuff
**Plans**: TBD-FIFTY

### Phase 5: Five
**Goal**: Five stuff
**Plans**: TBD-FIVE
`,
    );
    seedPhase5();

    const result = runGsdTools('roadmap update-plan-progress 05', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const roadmap = fs.readFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      'utf-8',
    );
    assert.match(
      roadmap,
      /^\*\*Plans\*\*: TBD-FIFTY$/m,
      "the longer phase's Plans line must be left alone",
    );
    assert.match(roadmap, /^\*\*Plans\*\*: 1\/1 plans complete$/m);
  });

  test('get-phase resolves a padded argument', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap

### Phase 5: Five
**Goal:** Do five
**Plans:** TBD
`,
    );

    const result = runGsdTools('roadmap get-phase 05 --json', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);
    const output = JSON.parse(result.output);
    assert.strictEqual(output.found, true, 'padded argument should resolve');
    assert.strictEqual(output.phase_name, 'Five');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// phase checkbox anchoring
// ─────────────────────────────────────────────────────────────────────────────

describe('roadmap phase checkbox anchoring', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  // The cross-referencing entry comes first on purpose: it is the earlier
  // match, which wins when the pattern is allowed to start mid-line.
  const CROSS_REFERENCING_ROADMAP = `# Roadmap

- [ ] **Phase 4: Alpha** - groundwork that blocks Phase 5 and Phase 6
- [ ] **Phase 5: Five** - the real one

## Phase Details

### Phase 4: Alpha
**Goal**: Do four
**Plans**: TBD

### Phase 5: Five
**Goal**: Do five
**Plans**: TBD
`;

  function completePhase5(roadmapContent) {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      roadmapContent,
    );
    const p5 = path.join(tmpDir, '.planning', 'phases', '05-five');
    fs.mkdirSync(p5, { recursive: true });
    fs.writeFileSync(path.join(p5, '05-01-PLAN.md'), '# Plan');
    fs.writeFileSync(path.join(p5, '05-01-SUMMARY.md'), '# Summary');
    const result = runGsdTools('roadmap update-plan-progress 5 --json', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);
    return {
      output: JSON.parse(result.output),
      roadmap: fs.readFileSync(
        path.join(tmpDir, '.planning', 'ROADMAP.md'),
        'utf-8',
      ),
    };
  }

  test('completing a phase does not tick a phase that merely mentions it', () => {
    const { roadmap } = completePhase5(CROSS_REFERENCING_ROADMAP);
    assert.match(
      roadmap,
      /^- \[ \] \*\*Phase 4: Alpha\*\*/m,
      "Phase 4's checkbox must stay unticked",
    );
    assert.match(
      roadmap,
      /^- \[x\] \*\*Phase 5: Five\*\*/m,
      "Phase 5's checkbox is the one that should be ticked",
    );
  });

  test('reading a checkbox does not read a phase that merely mentions it', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      CROSS_REFERENCING_ROADMAP.replace(
        '- [ ] **Phase 4: Alpha**',
        '- [x] **Phase 4: Alpha**',
      ),
    );

    const result = runGsdTools('roadmap analyze --json', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);
    const output = JSON.parse(result.output);

    const four = output.phases.find((p) => p.number === '4');
    const five = output.phases.find((p) => p.number === '5');
    assert.strictEqual(four.roadmap_complete, true, 'phase 4 is ticked');
    assert.strictEqual(
      five.roadmap_complete,
      false,
      "phase 5 must not inherit phase 4's checkbox state",
    );
  });

  // The supported prefixes between the checkbox and the word `Phase` are
  // nothing and `**`, which is everything the templates and the roadmapper
  // emit. Anything else is deliberately unsupported and reported as a missed
  // target rather than silently matching a neighbouring phase.
  test('ticks the bold checkbox form', () => {
    const { roadmap } = completePhase5(`# Roadmap

- [ ] **Phase 5: Five** - the real one

### Phase 5: Five
**Goal**: Do five
**Plans**: TBD
`);
    assert.match(roadmap, /^- \[x\] \*\*Phase 5: Five\*\*/m);
  });

  test('ticks the bare checkbox form', () => {
    const { roadmap } = completePhase5(`# Roadmap

- [ ] Phase 5: Five - the real one

### Phase 5: Five
**Goal**: Do five
**Plans**: TBD
`);
    assert.match(roadmap, /^- \[x\] Phase 5: Five/m);
  });

  test('reports an unsupported checkbox prefix instead of ticking it', () => {
    const { output, roadmap } = completePhase5(`# Roadmap

- [ ] [WIP] Phase 5: Five - the real one

### Phase 5: Five
**Goal**: Do five
**Plans**: TBD
`);
    assert.match(
      roadmap,
      /^- \[ \] \[WIP\] Phase 5: Five/m,
      'an unsupported prefix is not matched',
    );
    assert.deepStrictEqual(
      output.missed_targets,
      ['phase-checkbox'],
      'and the drop is reported rather than silent',
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// roadmap analyze --current filtering
// ─────────────────────────────────────────────────────────────────────────────

describe('roadmap analyze --current filtering', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('--current filters to current phase only', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      `---
gsd_state_version: 1.0
milestone: test
current_phase: 2
current_plan: Not started
status: testing
---

# Project State
`,
    );

    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap

## Milestone: test

- [x] **Phase 1: Foundation** (completed)
- [ ] **Phase 2: Features**
- [ ] **Phase 3: Polish**

## Phase Details

### Phase 1: Foundation
**Goal**: Set up base
**Requirements**: NONE

### Phase 2: Features
**Goal**: Build features
**Requirements**: NONE

### Phase 3: Polish
**Goal**: Final polish
**Requirements**: NONE
`,
    );

    // Create phase dirs for disk status detection
    const p1 = path.join(tmpDir, '.planning', 'phases', '01-foundation');
    fs.mkdirSync(p1, { recursive: true });
    fs.writeFileSync(path.join(p1, '01-01-PLAN.md'), '# Plan');
    fs.writeFileSync(path.join(p1, '01-01-SUMMARY.md'), '# Summary');

    const p2 = path.join(tmpDir, '.planning', 'phases', '02-features');
    fs.mkdirSync(p2, { recursive: true });

    const result = runGsdTools(
      ['roadmap', 'analyze', '--current', '--json'],
      tmpDir,
    );
    assert.ok(result.success, `Command should succeed: ${result.error}`);

    const output = JSON.parse(result.output);
    // When filtered by current phase (2), only phase 2 should be in phases array
    assert.strictEqual(
      output.phases.length,
      1,
      'should return only 1 phase (current phase)',
    );
    assert.ok(
      output.phases[0].number === '2' || output.phases[0].name === 'Features',
      `phase should be phase 2 / Features, got: ${JSON.stringify(output.phases[0])}`,
    );
  });

  test('--current with no current_phase in STATE.md returns full roadmap', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      `---
gsd_state_version: 1.0
milestone: test
current_plan: Not started
status: testing
---

# Project State
`,
    );

    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap

### Phase 1: Foundation
**Goal**: Set up base

### Phase 2: Features
**Goal**: Build features

### Phase 3: Polish
**Goal**: Final polish
`,
    );

    const result = runGsdTools(
      ['roadmap', 'analyze', '--current', '--json'],
      tmpDir,
    );
    assert.ok(result.success, `Command should succeed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(
      output.phase_count,
      3,
      'should return all 3 phases when no current_phase in frontmatter',
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Format contract tests — lineage and D10/D11 chain
// ─────────────────────────────────────────────────────────────────────────────

describe('format contract tests — lineage and D10/D11 chain', () => {
  // Helper: count balanced tags
  function tagsBalanced(content, tagName) {
    const openCount = (content.match(new RegExp(`<${tagName}>`, 'g')) || [])
      .length;
    const closeCount = (content.match(new RegExp(`</${tagName}>`, 'g')) || [])
      .length;
    return openCount === closeCount && openCount > 0;
  }

  // D10 file path regex from CONTEXT.md locked decision
  const D10_REGEX = /[\w./\-]+\.\w{1,5}/g;

  test('detects balanced <lineage> tags', () => {
    const content = '<lineage>\n## Parent Phase\n</lineage>';
    assert.strictEqual(tagsBalanced(content, 'lineage'), true);
  });

  test('detects unbalanced <lineage> tags (missing close tag)', () => {
    const content = '<lineage>\n## Parent Phase\n'; // missing </lineage>
    assert.strictEqual(tagsBalanced(content, 'lineage'), false);
  });

  test('D10 regex extracts install.js from decision text', () => {
    const text =
      'Update installer: install.js must stop copying standalone baseline files';
    const matches = text.match(D10_REGEX);
    assert.ok(matches, 'should find matches');
    assert.ok(
      matches.includes('install.js'),
      `should contain install.js, got: ${JSON.stringify(matches)}`,
    );
  });

  test('D10 regex extracts paths with directories from decision text', () => {
    const text = 'Modify gsd-ng/bin/lib/roadmap.cjs to add depends_on field';
    const matches = text.match(D10_REGEX);
    assert.ok(matches, 'should find matches');
    assert.ok(
      matches.some((m) => m.includes('roadmap.cjs')),
      `should contain roadmap.cjs, got: ${JSON.stringify(matches)}`,
    );
  });

  test('D10 regex returns no matches for decision without file paths', () => {
    const text = 'Use depth 1 only for lineage traversal';
    const matches = text.match(D10_REGEX);
    // "1" has no extension, "depth" no extension — no file path matches expected
    assert.strictEqual(
      matches,
      null,
      `should return null, got: ${JSON.stringify(matches)}`,
    );
  });

  test('canonical ref paths are valid relative paths (no absolute, no URLs)', () => {
    const refs = [
      'gsd-ng/agents/gsd-plan-checker.md',
      '.planning/phases/44-cli/44-CONTEXT.md',
      'gsd-ng/workflows/discuss-phase.md',
    ];
    for (const ref of refs) {
      assert.ok(!path.isAbsolute(ref), `${ref} should be relative`);
      assert.ok(!ref.startsWith('http'), `${ref} should not be a URL`);
      assert.ok(ref.includes('.'), `${ref} should have a file extension`);
    }
  });

  test('Requirements regex matches **Requirements**: format (colon outside bold)', () => {
    const regex = /\*\*Requirements\*\*:\s*([^\n]+)/i;
    const section = '**Requirements**: HOOK-01, HOOK-02, HOOK-03';
    const m = section.match(regex);
    assert.ok(m, 'should match **Requirements**: format');
    assert.strictEqual(m[1].trim(), 'HOOK-01, HOOK-02, HOOK-03');
  });

  test('Requirements regex does NOT match **Requirements:** format (colon inside bold)', () => {
    const regex = /\*\*Requirements\*\*:\s*([^\n]+)/i;
    const section = '**Requirements:** HOOK-01, HOOK-02';
    const m = section.match(regex);
    assert.strictEqual(
      m,
      null,
      'should NOT match **Requirements:** (colon inside bold)',
    );
  });

  test('Requirements bracket stripping removes outer brackets', () => {
    const raw = '[REQ-01, REQ-02, REQ-03]';
    const stripped = raw
      .trim()
      .replace(/^\[(.*)\]$/, '$1')
      .trim();
    assert.strictEqual(stripped, 'REQ-01, REQ-02, REQ-03');
  });

  test('Requirements without brackets passes through unchanged', () => {
    const raw = 'HOOK-01, HOOK-02';
    const stripped = raw
      .trim()
      .replace(/^\[(.*)\]$/, '$1')
      .trim();
    assert.strictEqual(stripped, 'HOOK-01, HOOK-02');
  });

  test('createTempGitProject scaffolds CONTEXT.md when contextContent provided', () => {
    const content =
      '<lineage>\n## Parent\n</lineage>\n<decisions>\n- Use install.js\n</decisions>';
    const tmpDir = createTempGitProject({ contextContent: content });
    try {
      const ctxPath = path.join(
        tmpDir,
        '.planning',
        'phases',
        'test-phase',
        'test-CONTEXT.md',
      );
      assert.ok(fs.existsSync(ctxPath), 'test-CONTEXT.md should exist');
      assert.strictEqual(
        fs.readFileSync(ctxPath, 'utf8'),
        content,
        'content should match',
      );
    } finally {
      cleanup(tmpDir);
    }
  });
});

// ─── roadmap get-phase --default flag ───────────────────────────────────────

describe('roadmap get-phase --default flag', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('returns default value when ROADMAP.md not found', () => {
    const result = runGsdTools(
      ['roadmap', 'get-phase', '1', '--default', '{}'],
      tmpDir,
    );
    assert.ok(
      result.success,
      `Command should exit 0 with --default, got: ${result.error}`,
    );
    assert.strictEqual(
      result.output,
      '{}',
      `Expected "{}", got: ${result.output}`,
    );
  });

  test('returns default value when phase not found', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap\n\n### Phase 1: Test\n**Goal:** Test goal\n`,
    );
    const result = runGsdTools(
      ['roadmap', 'get-phase', '99', '--default', '{}'],
      tmpDir,
    );
    assert.ok(result.success, `Command should exit 0 with --default`);
    assert.strictEqual(
      result.output,
      '{}',
      `Expected "{}", got: ${result.output}`,
    );
  });

  test('returns actual phase data when phase found (default unused)', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap\n\n### Phase 1: Auth\n**Goal:** Build auth\n`,
    );
    const result = runGsdTools(
      ['roadmap', 'get-phase', '1', '--default', '{}', '--json'],
      tmpDir,
    );
    assert.ok(result.success, 'Command should succeed');
    const parsed = JSON.parse(result.output);
    assert.strictEqual(parsed.found, true, 'Should find phase 1');
  });

  test('preserves found:false when no --default and phase not found', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap\n\n### Phase 1: Test\n**Goal:** Test goal\n`,
    );
    const result = runGsdTools(
      ['roadmap', 'get-phase', '99', '--json'],
      tmpDir,
    );
    assert.ok(result.success, 'Command should exit 0');
    const parsed = JSON.parse(result.output);
    assert.strictEqual(
      parsed.found,
      false,
      'Should return found:false without --default',
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// getPhaseCompletionStatus helper — two-tier verified/unverified status
// ─────────────────────────────────────────────────────────────────────────────

describe('getPhaseCompletionStatus helper', () => {
  const { getPhaseCompletionStatus } = require('../gsd-ng/bin/lib/core.cjs');
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('3 plans 3 summaries no VERIFICATION.md returns complete (unverified)', () => {
    fs.writeFileSync(path.join(tmpDir, '01-01-PLAN.md'), '# Plan');
    fs.writeFileSync(path.join(tmpDir, '01-02-PLAN.md'), '# Plan');
    fs.writeFileSync(path.join(tmpDir, '01-03-PLAN.md'), '# Plan');
    fs.writeFileSync(path.join(tmpDir, '01-01-SUMMARY.md'), '# Summary');
    fs.writeFileSync(path.join(tmpDir, '01-02-SUMMARY.md'), '# Summary');
    fs.writeFileSync(path.join(tmpDir, '01-03-SUMMARY.md'), '# Summary');
    const result = getPhaseCompletionStatus(tmpDir);
    assert.strictEqual(result.isComplete, true, 'isComplete should be true');
    assert.strictEqual(
      result.status,
      'complete (unverified)',
      'status should be complete (unverified)',
    );
  });

  test('3 plans 3 summaries VERIFICATION.md with status: passed returns complete (verified)', () => {
    fs.writeFileSync(path.join(tmpDir, '01-01-PLAN.md'), '# Plan');
    fs.writeFileSync(path.join(tmpDir, '01-02-PLAN.md'), '# Plan');
    fs.writeFileSync(path.join(tmpDir, '01-03-PLAN.md'), '# Plan');
    fs.writeFileSync(path.join(tmpDir, '01-01-SUMMARY.md'), '# Summary');
    fs.writeFileSync(path.join(tmpDir, '01-02-SUMMARY.md'), '# Summary');
    fs.writeFileSync(path.join(tmpDir, '01-03-SUMMARY.md'), '# Summary');
    fs.writeFileSync(
      path.join(tmpDir, '01-VERIFICATION.md'),
      '---\nstatus: passed\n---\n# Verification',
    );
    const result = getPhaseCompletionStatus(tmpDir);
    assert.strictEqual(result.isComplete, true, 'isComplete should be true');
    assert.strictEqual(
      result.status,
      'complete (verified)',
      'status should be complete (verified)',
    );
  });

  test('3 plans 3 summaries VERIFICATION.md with status: gaps_found returns complete (unverified)', () => {
    fs.writeFileSync(path.join(tmpDir, '01-01-PLAN.md'), '# Plan');
    fs.writeFileSync(path.join(tmpDir, '01-02-PLAN.md'), '# Plan');
    fs.writeFileSync(path.join(tmpDir, '01-03-PLAN.md'), '# Plan');
    fs.writeFileSync(path.join(tmpDir, '01-01-SUMMARY.md'), '# Summary');
    fs.writeFileSync(path.join(tmpDir, '01-02-SUMMARY.md'), '# Summary');
    fs.writeFileSync(path.join(tmpDir, '01-03-SUMMARY.md'), '# Summary');
    fs.writeFileSync(
      path.join(tmpDir, '01-VERIFICATION.md'),
      '---\nstatus: gaps_found\n---\n# Verification',
    );
    const result = getPhaseCompletionStatus(tmpDir);
    assert.strictEqual(result.isComplete, true, 'isComplete should be true');
    assert.strictEqual(
      result.status,
      'complete (unverified)',
      'status should be complete (unverified) for non-passed',
    );
  });

  test('3 plans 2 summaries returns in_progress', () => {
    fs.writeFileSync(path.join(tmpDir, '01-01-PLAN.md'), '# Plan');
    fs.writeFileSync(path.join(tmpDir, '01-02-PLAN.md'), '# Plan');
    fs.writeFileSync(path.join(tmpDir, '01-03-PLAN.md'), '# Plan');
    fs.writeFileSync(path.join(tmpDir, '01-01-SUMMARY.md'), '# Summary');
    fs.writeFileSync(path.join(tmpDir, '01-02-SUMMARY.md'), '# Summary');
    const result = getPhaseCompletionStatus(tmpDir);
    assert.strictEqual(result.isComplete, false, 'isComplete should be false');
    assert.strictEqual(
      result.status,
      'in_progress',
      'status should be in_progress',
    );
  });

  test('0 plans returns not_started', () => {
    // tmpDir exists but has no PLAN files
    const result = getPhaseCompletionStatus(tmpDir);
    assert.strictEqual(result.isComplete, false, 'isComplete should be false');
    assert.strictEqual(
      result.status,
      'not_started',
      'status should be not_started',
    );
  });

  test('non-existent directory returns not_started', () => {
    const result = getPhaseCompletionStatus(
      path.join(resolveTmpDir(), 'gsd-nonexistent-dir-' + Date.now()),
    );
    assert.strictEqual(result.isComplete, false, 'isComplete should be false');
    assert.strictEqual(
      result.status,
      'not_started',
      'status should be not_started',
    );
  });
});

// ─── roadmap.cjs branch coverage residuals (60-11) ───────────────────────
describe('roadmap.cjs residuals (60-11)', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  // cmdRoadmapGetPhase: phase appears in summary list (-[ ] **Phase X**) but
  // detail section is missing AND a defaultValue is supplied → output default
  test('roadmap get-phase: missing detail with --default returns default', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      [
        '# Roadmap',
        '',
        '## v1.0 — milestone',
        '',
        '- [ ] **Phase 9: orphan-summary**',
        '',
      ].join('\n'),
    );
    const r = runGsdTools(
      ['roadmap', 'get-phase', '9', '--default', 'fallback-string'],
      tmpDir,
    );
    assert.ok(r.success, r.error);
    assert.match(r.output, /fallback-string/);
  });

  // cmdRoadmapGetPhase: triggers the catch path by replacing ROADMAP.md with a directory
  // (readFileSync throws EISDIR) — verifies the error wrapper at line 133-134.
  test('roadmap get-phase: ROADMAP.md is a directory triggers read error', () => {
    const roadmapPath = path.join(tmpDir, '.planning', 'ROADMAP.md');
    if (fs.existsSync(roadmapPath)) fs.rmSync(roadmapPath);
    fs.mkdirSync(roadmapPath, { recursive: true });
    const r = runGsdTools(['roadmap', 'get-phase', '1'], tmpDir);
    assert.ok(!r.success);
    assert.match(r.error, /Failed to read ROADMAP\.md/);
  });

  // cmdRoadmapAnalyze: ROADMAP marks phase complete [x] but disk shows in_progress
  // → diskStatus becomes 'complete (unverified)'.
  test('roadmap analyze: ROADMAP [x] overrides incomplete disk status', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      [
        '# Roadmap',
        '',
        '## v1.0 — milestone',
        '',
        '- [x] **Phase 5: shipped-elsewhere**',
        '',
        '#### Phase 5: shipped-elsewhere',
        '',
        '**Goal:** done outside GSD',
        '',
      ].join('\n'),
    );
    // Phase-5 disk has a PLAN but no SUMMARY — would normally be in_progress
    const phaseDir = path.join(
      tmpDir,
      '.planning',
      'phases',
      '05-shipped-elsewhere',
    );
    fs.mkdirSync(phaseDir, { recursive: true });
    fs.writeFileSync(path.join(phaseDir, '05-PLAN.md'), '---\n---\n');
    const r = runGsdTools(['roadmap', 'analyze', '--json'], tmpDir);
    assert.ok(r.success, r.error);
    const parsed = JSON.parse(r.output);
    const phase5 = (parsed.phases || []).find((p) => p.number === '5');
    assert.ok(phase5, 'phase 5 should be present in analysis');
    assert.match(phase5.disk_status || '', /complete \(unverified\)/);
  });

  // cmdRoadmapUpdatePlanProgress: missing phase argument → error path
  test('roadmap update-plan-progress: missing phase number errors', () => {
    const { spawnSync } = require('node:child_process');
    const r = spawnSync(
      process.execPath,
      [
        '-e',
        `const m = require(${JSON.stringify(path.resolve('gsd-ng/bin/lib/roadmap.cjs'))});m.cmdRoadmapUpdatePlanProgress(${JSON.stringify(tmpDir)}, '');`,
      ],
      { encoding: 'utf-8' },
    );
    assert.strictEqual(r.status, 1);
    assert.match(r.stderr, /phase number required/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The roadmap readers accept both supported checkbox forms, bare and bold.
// Pinned together so the two cannot diverge again.
// ─────────────────────────────────────────────────────────────────────────────

describe('roadmap checkbox form parity', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  const FORMS = [
    { label: 'bare', line: (n, name) => `- [ ] Phase ${n}: ${name}` },
    { label: 'bold', line: (n, name) => `- [ ] **Phase ${n}: ${name}**` },
  ];

  for (const form of FORMS) {
    test(`get-phase reports a checkbox-only phase as malformed (${form.label})`, () => {
      fs.writeFileSync(
        path.join(tmpDir, '.planning', 'ROADMAP.md'),
        ['# Roadmap v1.0', '', '## Phases', '', form.line(1, 'Foundation'), ''].join(
          '\n',
        ),
      );

      const result = runGsdTools('roadmap get-phase 1 --json', tmpDir);
      assert.ok(result.success, `Command failed: ${result.error}`);
      const output = JSON.parse(result.output);

      assert.strictEqual(
        output.error,
        'malformed_roadmap',
        `${form.label} form: the checkbox names the phase, so the missing detail ` +
          `section is what should be reported`,
      );
      assert.strictEqual(
        output.phase_name,
        'Foundation',
        `${form.label} form: the name comes off the checkbox line`,
      );
    });

    test(`analyze lists a checkbox-only phase as missing details (${form.label})`, () => {
      fs.writeFileSync(
        path.join(tmpDir, '.planning', 'ROADMAP.md'),
        [
          '# Roadmap',
          '',
          form.line(1, 'Foundation'),
          form.line(2, 'API'),
          '',
          '### Phase 2: API',
          '**Goal:** Build REST API',
          '',
        ].join('\n'),
      );

      const result = runGsdTools('roadmap analyze --json', tmpDir);
      assert.ok(result.success, `Command failed: ${result.error}`);
      const output = JSON.parse(result.output);

      assert.deepStrictEqual(
        output.missing_phase_details,
        ['1'],
        `${form.label} form: phase 1 has a checkbox and no detail section`,
      );
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// roadmap update-plan-progress — concurrent callers
// ─────────────────────────────────────────────────────────────────────────────
//
// Every executor in a wave calls update-plan-progress, and each call reads the
// whole ROADMAP.md and writes the whole file back. The values are derived from
// disk, so racers converge on a valid number — but not necessarily a current
// one: a caller that read before a sibling's summary landed writes its own count
// over the higher one, and a caller updating a different phase discards the
// sibling's row outright.
//
// Neither test waits for a race to land. The first holds the lock in the parent
// so the child's block is guaranteed, and the second releases its children from
// a flag-file barrier and asserts on the end state, which holds whether or not
// the window is hit.

describe('roadmap update-plan-progress under concurrency', () => {
  const ROADMAP_LIB = path.join(
    __dirname,
    '..',
    'gsd-ng',
    'bin',
    'lib',
    'roadmap.cjs',
  );

  const UPDATER_SRC = `
    const fs = require('fs');
    const [lib, cwd, readyFlag, goFlag, phase] = process.argv.slice(1);
    const roadmap = require(lib);
    fs.writeFileSync(readyFlag, '');
    const spin = new Int32Array(new SharedArrayBuffer(4));
    if (goFlag) { while (!fs.existsSync(goFlag)) { Atomics.wait(spin, 0, 0, 1); } }
    roadmap.cmdRoadmapUpdatePlanProgress(cwd, phase);
  `;

  let tmpDir;
  let roadmapPath;
  let flagDir;

  beforeEach(() => {
    tmpDir = createTempProject();
    roadmapPath = path.join(tmpDir, '.planning', 'ROADMAP.md');
    flagDir = fs.mkdtempSync(path.join(resolveTmpDir(), 'gsd-barrier-'));
  });

  afterEach(() => {
    cleanup(tmpDir);
    cleanup(flagDir);
  });

  function writePhase(num, name, planCount, summaryCount) {
    const dir = path.join(
      tmpDir,
      '.planning',
      'phases',
      `${String(num).padStart(2, '0')}-${name}`,
    );
    fs.mkdirSync(dir, { recursive: true });
    for (let i = 1; i <= planCount; i++) {
      const id = `${String(num).padStart(2, '0')}-${String(i).padStart(2, '0')}`;
      fs.writeFileSync(path.join(dir, `${id}-PLAN.md`), `# Plan ${id}`);
      if (i <= summaryCount) {
        fs.writeFileSync(path.join(dir, `${id}-SUMMARY.md`), `# Summary ${id}`);
      }
    }
    return dir;
  }

  function addSummary(dir, num, planIndex) {
    const id = `${String(num).padStart(2, '0')}-${String(planIndex).padStart(2, '0')}`;
    fs.writeFileSync(path.join(dir, `${id}-SUMMARY.md`), `# Summary ${id}`);
  }

  function writeRoadmap(phases) {
    const rows = phases
      .map(
        (p) => `| ${p.number}. ${p.name} | v1.0 | 0/${p.plans} | Planned | - |`,
      )
      .join('\n');
    const sections = phases
      .map(
        (p) =>
          `### Phase ${p.number}: ${p.name}\n**Goal:** Goal ${p.number}\n**Plans:** TBD\n`,
      )
      .join('\n');
    fs.writeFileSync(
      roadmapPath,
      `# Roadmap\n\n${sections}\n## Progress\n\n| Phase | Milestone | Plans Complete | Status | Completed |\n|-------|-----------|----------------|--------|-----------|\n${rows}\n`,
    );
  }

  function spawnUpdater(phase, readyFlag, goFlag) {
    const child = spawn(
      process.execPath,
      [
        '-e',
        UPDATER_SRC,
        '--',
        ROADMAP_LIB,
        tmpDir,
        readyFlag,
        goFlag || '',
        String(phase),
      ],
      { stdio: ['ignore', 'ignore', 'pipe'] },
    );
    child._stderr = '';
    child.stderr.on('data', (d) => (child._stderr += d));
    return child;
  }

  async function waitForFlag(flagPath) {
    const deadline = Date.now() + 10000;
    while (!fs.existsSync(flagPath)) {
      assert.ok(Date.now() < deadline, `child never reached ${flagPath}`);
      await new Promise((r) => setTimeout(r, 5));
    }
  }

  test('a count computed before a competing writer is not written over the current one', async () => {
    // The phase under test has three plans and one summary. A competing writer
    // — the parent, holding the lock — lands the other two summaries while the
    // child is inside the command, so the 1/3 the child would compute from its
    // own read is stale by the time it could write it.
    const phaseDir = writePhase(1, 'alpha', 3, 1);
    writeRoadmap([{ number: 1, name: 'alpha', plans: 3 }]);
    const before = fs.readFileSync(roadmapPath, 'utf-8');

    const lockPath = path.join(tmpDir, '.planning', '.ROADMAP.md.gsd-lock');
    fs.writeFileSync(
      lockPath,
      JSON.stringify({
        pid: process.pid,
        host: require('os').hostname(),
        at: new Date().toISOString(),
      }),
    );

    const readyFlag = path.join(flagDir, 'ready');
    const child = spawnUpdater(1, readyFlag, null);
    const exited = new Promise((r) => child.on('close', r));
    await waitForFlag(readyFlag);

    // The child is loaded and running the command. Give it a window far wider
    // than the read-and-rewrite it performs; the lock, not the clock, is what
    // keeps it out.
    await new Promise((r) => setTimeout(r, 500));
    assert.strictEqual(
      fs.readFileSync(roadmapPath, 'utf-8'),
      before,
      'ROADMAP.md was rewritten while another writer held the lock',
    );

    addSummary(phaseDir, 1, 2);
    addSummary(phaseDir, 1, 3);
    fs.unlinkSync(lockPath);

    const code = await exited;
    assert.strictEqual(
      code,
      0,
      `updater should succeed (stderr: ${child._stderr.trim()})`,
    );

    const after = fs.readFileSync(roadmapPath, 'utf-8');
    assert.ok(
      after.includes('3/3'),
      `ROADMAP.md should carry the current count: ${after}`,
    );
    assert.ok(
      !after.includes('1/3'),
      `ROADMAP.md should not carry the stale count: ${after}`,
    );
  });

  test('concurrent updates to different phases all survive', async () => {
    const phases = [
      { number: 1, name: 'alpha', plans: 2 },
      { number: 2, name: 'beta', plans: 2 },
      { number: 3, name: 'gamma', plans: 2 },
      { number: 4, name: 'delta', plans: 2 },
      { number: 5, name: 'epsilon', plans: 2 },
      { number: 6, name: 'zeta', plans: 2 },
    ];
    for (const p of phases) writePhase(p.number, p.name, p.plans, 1);
    writeRoadmap(phases);

    const goFlag = path.join(flagDir, 'go');
    const children = phases.map((p, i) => {
      const readyFlag = path.join(flagDir, `ready-${i}`);
      const child = spawnUpdater(p.number, readyFlag, goFlag);
      child._readyFlag = readyFlag;
      return child;
    });
    const exits = children.map((c) => new Promise((r) => c.on('close', r)));

    for (const c of children) await waitForFlag(c._readyFlag);
    fs.writeFileSync(goFlag, '');

    const codes = await Promise.all(exits);
    assert.deepStrictEqual(
      codes,
      phases.map(() => 0),
      `every updater should succeed (stderr: ${children
        .map((c) => c._stderr.trim())
        .filter(Boolean)
        .join(' | ')})`,
    );

    const after = fs.readFileSync(roadmapPath, 'utf-8');
    const lost = phases.filter(
      (p) =>
        !new RegExp(`\\|\\s*${p.number}\\. ${p.name}\\s*\\|[^\\n]*1/2`).test(
          after,
        ),
    );
    assert.deepStrictEqual(
      lost.map((p) => p.number),
      [],
      `rows reported as updated but discarded by a racing writer: ${after}`,
    );
  });
});
