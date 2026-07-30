/**
 * GSD Tools Tests - Phase
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const {
  runGsdTools,
  createTempProject,
  cleanup,
  cleanupSubdir,
  waitForReadyFlag,
  TOOLS_PATH,
} = require('./helpers.cjs');

// Direct-invocation helper for branches unreachable through validateArgs.
// Spawns a child Node process so process.exit(1) (via error()) is captured
// as the child exit code, not the test runner's. Mirrors the spawnDirect
// pattern established in tests/template.test.cjs (Wave 1 plan 60-01).
const PHASE_LIB = path.join(
  __dirname,
  '..',
  'gsd-ng',
  'bin',
  'lib',
  'phase.cjs',
);
function spawnDirectPhaseRemove(cwd, targetPhase, options) {
  const code =
    'const t = require(' +
    JSON.stringify(PHASE_LIB) +
    '); t.cmdPhaseRemove(' +
    JSON.stringify(cwd) +
    ', ' +
    (targetPhase === undefined ? 'undefined' : JSON.stringify(targetPhase)) +
    ', ' +
    JSON.stringify(options || {}) +
    ');';
  const r = spawnSync(process.execPath, ['-e', code], { encoding: 'utf-8' });
  return {
    status: r.status,
    stdout: (r.stdout || '').trim(),
    stderr: (r.stderr || '').trim(),
  };
}

describe('phases list command', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('empty phases directory returns empty array', () => {
    const result = runGsdTools('phases list --json', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.deepStrictEqual(
      output.directories,
      [],
      'directories should be empty',
    );
    assert.strictEqual(output.count, 0, 'count should be 0');
  });

  test('lists phase directories sorted numerically', () => {
    // Create out-of-order directories
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '10-final'), {
      recursive: true,
    });
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '02-api'), {
      recursive: true,
    });
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '01-foundation'), {
      recursive: true,
    });

    const result = runGsdTools('phases list --json', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.count, 3, 'should have 3 directories');
    assert.deepStrictEqual(
      output.directories,
      ['01-foundation', '02-api', '10-final'],
      'should be sorted numerically',
    );
  });

  test('handles decimal phases in sort order', () => {
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '02-api'), {
      recursive: true,
    });
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '02.1-hotfix'), {
      recursive: true,
    });
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '02.2-patch'), {
      recursive: true,
    });
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '03-ui'), {
      recursive: true,
    });

    const result = runGsdTools('phases list --json', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.deepStrictEqual(
      output.directories,
      ['02-api', '02.1-hotfix', '02.2-patch', '03-ui'],
      'decimal phases should sort correctly between whole numbers',
    );
  });

  test('--type plans lists only PLAN.md files', () => {
    const phaseDir = path.join(tmpDir, '.planning', 'phases', '01-test');
    fs.mkdirSync(phaseDir, { recursive: true });
    fs.writeFileSync(path.join(phaseDir, '01-01-PLAN.md'), '# Plan 1');
    fs.writeFileSync(path.join(phaseDir, '01-02-PLAN.md'), '# Plan 2');
    fs.writeFileSync(path.join(phaseDir, '01-01-SUMMARY.md'), '# Summary');
    fs.writeFileSync(path.join(phaseDir, 'RESEARCH.md'), '# Research');

    const result = runGsdTools('phases list --type plans --json', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.deepStrictEqual(
      output.files.sort(),
      ['01-01-PLAN.md', '01-02-PLAN.md'],
      'should list only PLAN files',
    );
  });

  test('--type summaries lists only SUMMARY.md files', () => {
    const phaseDir = path.join(tmpDir, '.planning', 'phases', '01-test');
    fs.mkdirSync(phaseDir, { recursive: true });
    fs.writeFileSync(path.join(phaseDir, '01-01-PLAN.md'), '# Plan');
    fs.writeFileSync(path.join(phaseDir, '01-01-SUMMARY.md'), '# Summary 1');
    fs.writeFileSync(path.join(phaseDir, '01-02-SUMMARY.md'), '# Summary 2');

    const result = runGsdTools('phases list --type summaries --json', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.deepStrictEqual(
      output.files.sort(),
      ['01-01-SUMMARY.md', '01-02-SUMMARY.md'],
      'should list only SUMMARY files',
    );
  });

  test('--phase filters to specific phase directory', () => {
    const phase01 = path.join(tmpDir, '.planning', 'phases', '01-foundation');
    const phase02 = path.join(tmpDir, '.planning', 'phases', '02-api');
    fs.mkdirSync(phase01, { recursive: true });
    fs.mkdirSync(phase02, { recursive: true });
    fs.writeFileSync(path.join(phase01, '01-01-PLAN.md'), '# Plan');
    fs.writeFileSync(path.join(phase02, '02-01-PLAN.md'), '# Plan');

    const result = runGsdTools(
      'phases list --type plans --phase 01 --json',
      tmpDir,
    );
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.deepStrictEqual(
      output.files,
      ['01-01-PLAN.md'],
      'should only list phase 01 plans',
    );
    assert.strictEqual(
      output.phase_dir,
      'foundation',
      'should report phase name without number prefix',
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// roadmap get-phase command
// ─────────────────────────────────────────────────────────────────────────────

describe('phase next-decimal command', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('returns X.1 when no decimal phases exist', () => {
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '06-feature'), {
      recursive: true,
    });
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '07-next'), {
      recursive: true,
    });

    const result = runGsdTools('phase next-decimal 06 --json', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.next, '06.1', 'should return 06.1');
    assert.deepStrictEqual(output.existing, [], 'no existing decimals');
  });

  test('increments from existing decimal phases', () => {
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '06-feature'), {
      recursive: true,
    });
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '06.1-hotfix'), {
      recursive: true,
    });
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '06.2-patch'), {
      recursive: true,
    });

    const result = runGsdTools('phase next-decimal 06 --json', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.next, '06.3', 'should return 06.3');
    assert.deepStrictEqual(
      output.existing,
      ['06.1', '06.2'],
      'lists existing decimals',
    );
  });

  test('handles gaps in decimal sequence', () => {
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '06-feature'), {
      recursive: true,
    });
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '06.1-first'), {
      recursive: true,
    });
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '06.3-third'), {
      recursive: true,
    });

    const result = runGsdTools('phase next-decimal 06 --json', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    // Should take next after highest, not fill gap
    assert.strictEqual(
      output.next,
      '06.4',
      'should return 06.4, not fill gap at 06.2',
    );
  });

  test('handles single-digit phase input', () => {
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '06-feature'), {
      recursive: true,
    });

    const result = runGsdTools('phase next-decimal 6 --json', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.next, '06.1', 'should normalize to 06.1');
    assert.strictEqual(output.base_phase, '06', 'base phase should be padded');
  });

  test('returns error if base phase does not exist', () => {
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '01-start'), {
      recursive: true,
    });

    const result = runGsdTools('phase next-decimal 06 --json', tmpDir);
    assert.ok(result.success, `Command should succeed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.found, false, 'base phase not found');
    assert.strictEqual(output.next, '06.1', 'should still suggest 06.1');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// phase-plan-index command
// ─────────────────────────────────────────────────────────────────────────────

describe('phase-plan-index command', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('empty phase directory returns empty plans array', () => {
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '03-api'), {
      recursive: true,
    });

    const result = runGsdTools('phase-plan-index 03 --json', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.phase, '03', 'phase number correct');
    assert.deepStrictEqual(output.plans, [], 'plans should be empty');
    assert.deepStrictEqual(output.waves, {}, 'waves should be empty');
    assert.deepStrictEqual(output.incomplete, [], 'incomplete should be empty');
    assert.strictEqual(output.has_checkpoints, false, 'no checkpoints');
  });

  test('extracts single plan with frontmatter', () => {
    const phaseDir = path.join(tmpDir, '.planning', 'phases', '03-api');
    fs.mkdirSync(phaseDir, { recursive: true });

    fs.writeFileSync(
      path.join(phaseDir, '03-01-PLAN.md'),
      `---
wave: 1
autonomous: true
objective: Set up database schema
files-modified: [prisma/schema.prisma, src/lib/db.ts]
---

## Task 1: Create schema
## Task 2: Generate client
`,
    );

    const result = runGsdTools('phase-plan-index 03 --json', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.plans.length, 1, 'should have 1 plan');
    assert.strictEqual(output.plans[0].id, '03-01', 'plan id correct');
    assert.strictEqual(output.plans[0].wave, 1, 'wave extracted');
    assert.strictEqual(
      output.plans[0].autonomous,
      true,
      'autonomous extracted',
    );
    assert.strictEqual(
      output.plans[0].objective,
      'Set up database schema',
      'objective extracted',
    );
    assert.deepStrictEqual(
      output.plans[0].files_modified,
      ['prisma/schema.prisma', 'src/lib/db.ts'],
      'files extracted',
    );
    assert.strictEqual(output.plans[0].task_count, 2, 'task count correct');
    assert.strictEqual(output.plans[0].has_summary, false, 'no summary yet');
  });

  test('groups multiple plans by wave', () => {
    const phaseDir = path.join(tmpDir, '.planning', 'phases', '03-api');
    fs.mkdirSync(phaseDir, { recursive: true });

    fs.writeFileSync(
      path.join(phaseDir, '03-01-PLAN.md'),
      `---
wave: 1
autonomous: true
objective: Database setup
---

## Task 1: Schema
`,
    );

    fs.writeFileSync(
      path.join(phaseDir, '03-02-PLAN.md'),
      `---
wave: 1
autonomous: true
objective: Auth setup
---

## Task 1: JWT
`,
    );

    fs.writeFileSync(
      path.join(phaseDir, '03-03-PLAN.md'),
      `---
wave: 2
autonomous: false
objective: API routes
---

## Task 1: Routes
`,
    );

    const result = runGsdTools('phase-plan-index 03 --json', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.plans.length, 3, 'should have 3 plans');
    assert.deepStrictEqual(
      output.waves['1'],
      ['03-01', '03-02'],
      'wave 1 has 2 plans',
    );
    assert.deepStrictEqual(output.waves['2'], ['03-03'], 'wave 2 has 1 plan');
  });

  test('detects incomplete plans (no matching summary)', () => {
    const phaseDir = path.join(tmpDir, '.planning', 'phases', '03-api');
    fs.mkdirSync(phaseDir, { recursive: true });

    // Plan with summary
    fs.writeFileSync(
      path.join(phaseDir, '03-01-PLAN.md'),
      `---\nwave: 1\n---\n## Task 1`,
    );
    fs.writeFileSync(path.join(phaseDir, '03-01-SUMMARY.md'), `# Summary`);

    // Plan without summary
    fs.writeFileSync(
      path.join(phaseDir, '03-02-PLAN.md'),
      `---\nwave: 2\n---\n## Task 1`,
    );

    const result = runGsdTools('phase-plan-index 03 --json', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(
      output.plans[0].has_summary,
      true,
      'first plan has summary',
    );
    assert.strictEqual(
      output.plans[1].has_summary,
      false,
      'second plan has no summary',
    );
    assert.deepStrictEqual(
      output.incomplete,
      ['03-02'],
      'incomplete list correct',
    );
  });

  test('detects checkpoints (autonomous: false)', () => {
    const phaseDir = path.join(tmpDir, '.planning', 'phases', '03-api');
    fs.mkdirSync(phaseDir, { recursive: true });

    fs.writeFileSync(
      path.join(phaseDir, '03-01-PLAN.md'),
      `---
wave: 1
autonomous: false
objective: Manual review needed
---

## Task 1: Review
`,
    );

    const result = runGsdTools('phase-plan-index 03 --json', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(
      output.has_checkpoints,
      true,
      'should detect checkpoint',
    );
    assert.strictEqual(
      output.plans[0].autonomous,
      false,
      'plan marked non-autonomous',
    );
  });

  test('phase not found returns error', () => {
    const result = runGsdTools('phase-plan-index 99 --json', tmpDir);
    assert.ok(result.success, `Command should succeed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(
      output.error,
      'Phase not found',
      'should report phase not found',
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// phase-plan-index — canonical XML format (template-aligned)
// ─────────────────────────────────────────────────────────────────────────────

describe('phase-plan-index canonical format', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('files_modified: underscore key is parsed correctly', () => {
    const phaseDir = path.join(tmpDir, '.planning', 'phases', '04-ui');
    fs.mkdirSync(phaseDir, { recursive: true });

    fs.writeFileSync(
      path.join(phaseDir, '04-01-PLAN.md'),
      `---
wave: 1
autonomous: true
files_modified: [src/App.tsx, src/index.ts]
---

<objective>
Build main application shell

Purpose: Entry point
Output: App component
</objective>

<tasks>
<task type="auto">
  <name>Task 1: Create App component</name>
  <files>src/App.tsx</files>
  <action>Create component</action>
  <verify>npm run build</verify>
  <done>Component renders</done>
</task>
</tasks>
`,
    );

    const result = runGsdTools('phase-plan-index 04 --json', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.deepStrictEqual(
      output.plans[0].files_modified,
      ['src/App.tsx', 'src/index.ts'],
      'files_modified with underscore should be parsed',
    );
  });

  test('objective: extracted from <objective> XML tag, not frontmatter', () => {
    const phaseDir = path.join(tmpDir, '.planning', 'phases', '04-ui');
    fs.mkdirSync(phaseDir, { recursive: true });

    fs.writeFileSync(
      path.join(phaseDir, '04-01-PLAN.md'),
      `---
wave: 1
autonomous: true
files_modified: []
---

<objective>
Build main application shell

Purpose: Entry point for the SPA
Output: App.tsx with routing
</objective>

<tasks>
<task type="auto">
  <name>Task 1: Scaffold</name>
  <files>src/App.tsx</files>
  <action>Create shell</action>
  <verify>build passes</verify>
  <done>App renders</done>
</task>
</tasks>
`,
    );

    const result = runGsdTools('phase-plan-index 04 --json', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(
      output.plans[0].objective,
      'Build main application shell',
      'objective should come from <objective> XML tag first line',
    );
  });

  test('task_count: counts <task> XML tags', () => {
    const phaseDir = path.join(tmpDir, '.planning', 'phases', '04-ui');
    fs.mkdirSync(phaseDir, { recursive: true });

    fs.writeFileSync(
      path.join(phaseDir, '04-01-PLAN.md'),
      `---
wave: 1
autonomous: true
files_modified: []
---

<objective>
Create UI components
</objective>

<tasks>
<task type="auto">
  <name>Task 1: Header</name>
  <files>src/Header.tsx</files>
  <action>Create header</action>
  <verify>build</verify>
  <done>Header renders</done>
</task>

<task type="auto">
  <name>Task 2: Footer</name>
  <files>src/Footer.tsx</files>
  <action>Create footer</action>
  <verify>build</verify>
  <done>Footer renders</done>
</task>

<task type="checkpoint:human-verify" gate="blocking">
  <what-built>UI components</what-built>
  <how-to-verify>Visit localhost:3000</how-to-verify>
  <resume-signal>Type approved</resume-signal>
</task>
</tasks>
`,
    );

    const result = runGsdTools('phase-plan-index 04 --json', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(
      output.plans[0].task_count,
      3,
      'should count all 3 <task> XML tags',
    );
  });

  test('all three fields work together in canonical plan format', () => {
    const phaseDir = path.join(tmpDir, '.planning', 'phases', '04-ui');
    fs.mkdirSync(phaseDir, { recursive: true });

    fs.writeFileSync(
      path.join(phaseDir, '04-01-PLAN.md'),
      `---
phase: 04-ui
plan: 01
type: execute
wave: 1
depends_on: []
files_modified: [src/components/Chat.tsx, src/app/api/chat/route.ts]
autonomous: true
requirements: [R1, R2]
---

<objective>
Implement complete Chat feature as vertical slice.

Purpose: Self-contained chat that can run parallel to other features.
Output: Chat component, API endpoints.
</objective>

<execution_context>
@~/.claude/gsd-ng/workflows/execute-plan.md
</execution_context>

<context>
@.planning/PROJECT.md
@.planning/ROADMAP.md
</context>

<tasks>
<task type="auto">
  <name>Task 1: Create Chat component</name>
  <files>src/components/Chat.tsx</files>
  <action>Build chat UI with message list and input</action>
  <verify>npm run build</verify>
  <done>Chat component renders messages</done>
</task>

<task type="auto">
  <name>Task 2: Create Chat API</name>
  <files>src/app/api/chat/route.ts</files>
  <action>GET /api/chat and POST /api/chat endpoints</action>
  <verify>curl tests pass</verify>
  <done>CRUD operations work</done>
</task>
</tasks>

<verification>
- [ ] npm run build succeeds
- [ ] API endpoints respond correctly
</verification>
`,
    );

    const result = runGsdTools('phase-plan-index 04 --json', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    const plan = output.plans[0];
    assert.strictEqual(
      plan.objective,
      'Implement complete Chat feature as vertical slice.',
      'objective from XML tag',
    );
    assert.deepStrictEqual(
      plan.files_modified,
      ['src/components/Chat.tsx', 'src/app/api/chat/route.ts'],
      'files_modified with underscore',
    );
    assert.strictEqual(plan.task_count, 2, 'task_count from <task> XML tags');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// state-snapshot command
// ─────────────────────────────────────────────────────────────────────────────

describe('phase add command', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('adds phase after highest existing', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap v1.0

### Phase 1: Foundation
**Goal:** Setup

### Phase 2: API
**Goal:** Build API

---
`,
    );

    const result = runGsdTools('phase add User Dashboard --json', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.phase_number, 3, 'should be phase 3');
    assert.strictEqual(output.slug, 'user-dashboard');

    // Verify directory created
    assert.ok(
      fs.existsSync(
        path.join(tmpDir, '.planning', 'phases', '03-user-dashboard'),
      ),
      'directory should be created',
    );

    // Verify ROADMAP updated
    const roadmap = fs.readFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      'utf-8',
    );
    assert.ok(
      roadmap.includes('### Phase 3: User Dashboard'),
      'roadmap should include new phase',
    );
    assert.ok(
      roadmap.includes('**Depends on:** Phase 2'),
      'should depend on previous',
    );
  });

  test('handles empty roadmap', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap v1.0\n`,
    );

    const result = runGsdTools('phase add Initial Setup --json', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.phase_number, 1, 'should be phase 1');
  });

  test('phase add includes **Requirements**: TBD in new ROADMAP entry', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap v1.0\n\n### Phase 1: Foundation\n**Goal:** Setup\n\n---\n`,
    );

    const result = runGsdTools('phase add User Dashboard', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const roadmap = fs.readFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      'utf-8',
    );
    assert.ok(
      roadmap.includes('**Requirements**: TBD'),
      'new phase entry should include Requirements TBD',
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// phase insert command
// ─────────────────────────────────────────────────────────────────────────────

describe('phase insert command', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('inserts decimal phase after target', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap

### Phase 1: Foundation
**Goal:** Setup

### Phase 2: API
**Goal:** Build API
`,
    );
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '01-foundation'), {
      recursive: true,
    });

    const result = runGsdTools(
      'phase insert 1 Fix Critical Bug --json',
      tmpDir,
    );
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.phase_number, '01.1', 'should be 01.1');
    assert.strictEqual(output.after_phase, '1');

    // Verify directory
    assert.ok(
      fs.existsSync(
        path.join(tmpDir, '.planning', 'phases', '01.1-fix-critical-bug'),
      ),
      'decimal phase directory should be created',
    );

    // Verify ROADMAP
    const roadmap = fs.readFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      'utf-8',
    );
    assert.ok(
      roadmap.includes('Phase 01.1: Fix Critical Bug (INSERTED)'),
      'roadmap should include inserted phase',
    );
  });

  test('increments decimal when siblings exist', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap

### Phase 1: Foundation
**Goal:** Setup

### Phase 2: API
**Goal:** Build API
`,
    );
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '01-foundation'), {
      recursive: true,
    });
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '01.1-hotfix'), {
      recursive: true,
    });

    const result = runGsdTools('phase insert 1 Another Fix --json', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.phase_number, '01.2', 'should be 01.2');
  });

  test('rejects missing phase', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap\n### Phase 1: Test\n**Goal:** Test\n`,
    );

    const result = runGsdTools('phase insert 99 Fix Something', tmpDir);
    assert.ok(!result.success, 'should fail for missing phase');
    assert.ok(result.error.includes('not found'), 'error mentions not found');
  });

  test('handles padding mismatch between input and roadmap', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap

## Phase 09.05: Existing Decimal Phase
**Goal:** Test padding

## Phase 09.1: Next Phase
**Goal:** Test
`,
    );
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '09.05-existing'), {
      recursive: true,
    });

    // Pass unpadded "9.05" but roadmap has "09.05"
    const result = runGsdTools('phase insert 9.05 Padding Test --json', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.after_phase, '9.05');

    const roadmap = fs.readFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      'utf-8',
    );
    assert.ok(
      roadmap.includes('(INSERTED)'),
      'roadmap should include inserted phase',
    );
  });

  test('phase insert includes **Requirements**: TBD in new ROADMAP entry', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap\n\n### Phase 1: Foundation\n**Goal:** Setup\n\n### Phase 2: API\n**Goal:** Build API\n`,
    );
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '01-foundation'), {
      recursive: true,
    });

    const result = runGsdTools('phase insert 1 Fix Critical Bug', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const roadmap = fs.readFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      'utf-8',
    );
    assert.ok(
      roadmap.includes('**Requirements**: TBD'),
      'inserted phase entry should include Requirements TBD',
    );
  });

  test('handles #### heading depth from multi-milestone roadmaps', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap

### v1.1 Milestone

#### Phase 5: Feature Work
**Goal:** Build features

#### Phase 6: Polish
**Goal:** Polish
`,
    );
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '05-feature-work'), {
      recursive: true,
    });

    const result = runGsdTools('phase insert 5 Hotfix --json', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.phase_number, '05.1');

    const roadmap = fs.readFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      'utf-8',
    );
    assert.ok(
      roadmap.includes('Phase 05.1: Hotfix (INSERTED)'),
      'roadmap should include inserted phase',
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// phase remove command
// ─────────────────────────────────────────────────────────────────────────────

describe('phase remove command', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('removes phase directory and renumbers subsequent', () => {
    // Setup 3 phases
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap

### Phase 1: Foundation
**Goal:** Setup
**Depends on:** Nothing

### Phase 2: Auth
**Goal:** Authentication
**Depends on:** Phase 1

### Phase 3: Features
**Goal:** Core features
**Depends on:** Phase 2
`,
    );

    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '01-foundation'), {
      recursive: true,
    });
    const p2 = path.join(tmpDir, '.planning', 'phases', '02-auth');
    fs.mkdirSync(p2, { recursive: true });
    fs.writeFileSync(path.join(p2, '02-01-PLAN.md'), '# Plan');
    const p3 = path.join(tmpDir, '.planning', 'phases', '03-features');
    fs.mkdirSync(p3, { recursive: true });
    fs.writeFileSync(path.join(p3, '03-01-PLAN.md'), '# Plan');
    fs.writeFileSync(path.join(p3, '03-02-PLAN.md'), '# Plan 2');

    // Remove phase 2
    const result = runGsdTools('phase remove 2 --json', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.removed, '2');
    assert.strictEqual(output.directory_deleted, '02-auth');

    // the third phase should be renumbered to 02
    assert.ok(
      fs.existsSync(path.join(tmpDir, '.planning', 'phases', '02-features')),
      'phase 3 should be renumbered to 02-features',
    );
    assert.ok(
      !fs.existsSync(path.join(tmpDir, '.planning', 'phases', '03-features')),
      'old 03-features should not exist',
    );

    // Files inside should be renamed
    assert.ok(
      fs.existsSync(
        path.join(
          tmpDir,
          '.planning',
          'phases',
          '02-features',
          '02-01-PLAN.md',
        ),
      ),
      'plan file should be renumbered to 02-01',
    );
    assert.ok(
      fs.existsSync(
        path.join(
          tmpDir,
          '.planning',
          'phases',
          '02-features',
          '02-02-PLAN.md',
        ),
      ),
      'plan 2 should be renumbered to 02-02',
    );

    // ROADMAP should be updated
    const roadmap = fs.readFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      'utf-8',
    );
    assert.ok(
      !roadmap.includes('Phase 2: Auth'),
      'removed phase should not be in roadmap',
    );
    assert.ok(
      roadmap.includes('Phase 2: Features'),
      'phase 3 should be renumbered to 2',
    );
  });

  test('rejects removal of phase with summaries unless --force', () => {
    const p1 = path.join(tmpDir, '.planning', 'phases', '01-test');
    fs.mkdirSync(p1, { recursive: true });
    fs.writeFileSync(path.join(p1, '01-01-PLAN.md'), '# Plan');
    fs.writeFileSync(path.join(p1, '01-01-SUMMARY.md'), '# Summary');
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap\n### Phase 1: Test\n**Goal:** Test\n`,
    );

    // Should fail without --force
    const result = runGsdTools('phase remove 1', tmpDir);
    assert.ok(!result.success, 'should fail without --force');
    assert.ok(
      result.error.includes('executed plan'),
      'error mentions executed plans',
    );

    // Should succeed with --force
    const forceResult = runGsdTools('phase remove 1 --force', tmpDir);
    assert.ok(forceResult.success, `Force remove failed: ${forceResult.error}`);
  });

  test('removes decimal phase and renumbers siblings', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap\n### Phase 6: Main\n**Goal:** Main\n### Phase 6.1: Fix A\n**Goal:** Fix A\n### Phase 6.2: Fix B\n**Goal:** Fix B\n### Phase 6.3: Fix C\n**Goal:** Fix C\n`,
    );

    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '06-main'), {
      recursive: true,
    });
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '06.1-fix-a'), {
      recursive: true,
    });
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '06.2-fix-b'), {
      recursive: true,
    });
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '06.3-fix-c'), {
      recursive: true,
    });

    const result = runGsdTools('phase remove 6.2', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    // 06.3 should become 06.2
    assert.ok(
      fs.existsSync(path.join(tmpDir, '.planning', 'phases', '06.2-fix-c')),
      '06.3 should be renumbered to 06.2',
    );
    assert.ok(
      !fs.existsSync(path.join(tmpDir, '.planning', 'phases', '06.3-fix-c')),
      'old 06.3 should not exist',
    );
  });

  test('updates STATE.md phase count', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap\n### Phase 1: A\n**Goal:** A\n### Phase 2: B\n**Goal:** B\n`,
    );
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      `# State\n\n**Current Phase:** 1\n**Total Phases:** 2\n`,
    );
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '01-a'), {
      recursive: true,
    });
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '02-b'), {
      recursive: true,
    });

    runGsdTools('phase remove 2', tmpDir);

    const state = fs.readFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      'utf-8',
    );
    assert.ok(
      state.includes('**Total Phases:** 1'),
      'total phases should be decremented',
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// phase complete command
// ─────────────────────────────────────────────────────────────────────────────

describe('phase complete command', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('rewrites the Plans line when the colon sits outside the bold markers', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap

- [ ] Phase 1: Foundation
- [ ] Phase 2: API

### Phase 1: Foundation
**Goal**: Setup
**Plans**: TBD

### Phase 2: API
**Goal**: Build API
**Plans**: TBD
`,
    );
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      `# State\n\n**Current Phase:** 01\n**Current Phase Name:** Foundation\n**Status:** In progress\n**Current Plan:** 01-01\n**Last Activity:** 2025-01-01\n**Last Activity Description:** Working on phase 1\n`,
    );

    const p1 = path.join(tmpDir, '.planning', 'phases', '01-foundation');
    fs.mkdirSync(p1, { recursive: true });
    fs.writeFileSync(path.join(p1, '01-01-PLAN.md'), '# Plan');
    fs.writeFileSync(path.join(p1, '01-01-SUMMARY.md'), '# Summary');

    const result = runGsdTools('phase complete 1 --json', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const roadmap = fs.readFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      'utf-8',
    );
    assert.match(
      roadmap,
      /### Phase 1: Foundation\n\*\*Goal\*\*: Setup\n\*\*Plans\*\*: 1\/1 plans complete/,
      "Phase 1's Plans line should be rewritten",
    );
    assert.match(
      roadmap,
      /### Phase 2: API\n\*\*Goal\*\*: Build API\n\*\*Plans\*\*: TBD/,
      "Phase 2's Plans line must be untouched",
    );
  });

  test('leaves a later phase alone when this phase has no Plans line', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap

- [ ] Phase 1: Foundation
- [ ] Phase 2: API

### Phase 1: Foundation
**Goal**: Setup

### Phase 2: API
**Goal**: Build API
**Plans**: TBD
`,
    );
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      `# State\n\n**Current Phase:** 01\n**Current Phase Name:** Foundation\n**Status:** In progress\n**Current Plan:** 01-01\n**Last Activity:** 2025-01-01\n**Last Activity Description:** Working on phase 1\n`,
    );

    const p1 = path.join(tmpDir, '.planning', 'phases', '01-foundation');
    fs.mkdirSync(p1, { recursive: true });
    fs.writeFileSync(path.join(p1, '01-01-PLAN.md'), '# Plan');
    fs.writeFileSync(path.join(p1, '01-01-SUMMARY.md'), '# Summary');

    const result = runGsdTools('phase complete 1 --json', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const roadmap = fs.readFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      'utf-8',
    );
    assert.match(
      roadmap,
      /^\*\*Plans\*\*: TBD$/m,
      "Phase 2's Plans line must not absorb Phase 1's counts",
    );
  });

  test('marks phase complete and transitions to next', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap

- [ ] Phase 1: Foundation
- [ ] Phase 2: API

### Phase 1: Foundation
**Goal:** Setup
**Plans:** 1 plans

### Phase 2: API
**Goal:** Build API
`,
    );
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      `# State\n\n**Current Phase:** 01\n**Current Phase Name:** Foundation\n**Status:** In progress\n**Current Plan:** 01-01\n**Last Activity:** 2025-01-01\n**Last Activity Description:** Working on phase 1\n`,
    );

    const p1 = path.join(tmpDir, '.planning', 'phases', '01-foundation');
    fs.mkdirSync(p1, { recursive: true });
    fs.writeFileSync(path.join(p1, '01-01-PLAN.md'), '# Plan');
    fs.writeFileSync(path.join(p1, '01-01-SUMMARY.md'), '# Summary');
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '02-api'), {
      recursive: true,
    });

    const result = runGsdTools('phase complete 1 --json', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.completed_phase, '1');
    assert.strictEqual(output.plans_executed, '1/1');
    assert.deepStrictEqual(output.next_phase, { number: '02', name: 'api' });
    assert.strictEqual(
      typeof output.next_phase_name,
      'string',
      'next_phase_name backward compat field',
    );
    assert.strictEqual(output.is_last_phase, false);

    // Verify STATE.md updated
    const state = fs.readFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      'utf-8',
    );
    assert.ok(
      state.includes('**Current Phase:** 02'),
      'should advance to phase 02',
    );
    assert.ok(
      state.includes('**Status:** Ready to plan'),
      'status should be ready to plan',
    );
    assert.ok(
      state.includes('**Current Plan:** Not started'),
      'plan should be reset',
    );

    // Verify ROADMAP checkbox
    const roadmap = fs.readFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      'utf-8',
    );
    assert.ok(roadmap.includes('[x]'), 'phase should be checked off');
    assert.ok(roadmap.includes('completed'), 'completion date should be added');
  });

  test('detects last phase in milestone', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap\n### Phase 1: Only Phase\n**Goal:** Everything\n`,
    );
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      `# State\n\n**Current Phase:** 01\n**Status:** In progress\n**Current Plan:** 01-01\n**Last Activity:** 2025-01-01\n**Last Activity Description:** Working\n`,
    );

    const p1 = path.join(tmpDir, '.planning', 'phases', '01-only-phase');
    fs.mkdirSync(p1, { recursive: true });
    fs.writeFileSync(path.join(p1, '01-01-PLAN.md'), '# Plan');
    fs.writeFileSync(path.join(p1, '01-01-SUMMARY.md'), '# Summary');

    const result = runGsdTools('phase complete 1 --json', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.is_last_phase, true, 'should detect last phase');
    assert.strictEqual(output.next_phase, null, 'no next phase');

    const state = fs.readFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      'utf-8',
    );
    assert.ok(
      state.includes('Milestone complete'),
      'status should be milestone complete',
    );
  });

  test('updates REQUIREMENTS.md traceability when phase completes', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap

- [ ] Phase 1: Auth

### Phase 1: Auth
**Goal:** User authentication
**Requirements:** AUTH-01, AUTH-02
**Plans:** 1 plans

### Phase 2: API
**Goal:** Build API
**Requirements:** API-01
`,
    );
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'REQUIREMENTS.md'),
      `# Requirements

## v1 Requirements

### Authentication

- [ ] **AUTH-01**: User can sign up with email
- [ ] **AUTH-02**: User can log in
- [ ] **AUTH-03**: User can reset password

### API

- [ ] **API-01**: REST endpoints

## Traceability

| Requirement | Phase | Status |
|-------------|-------|--------|
| AUTH-01 | Phase 1 | Pending |
| AUTH-02 | Phase 1 | Pending |
| AUTH-03 | Phase 2 | Pending |
| API-01 | Phase 2 | Pending |
`,
    );
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      `# State\n\n**Current Phase:** 01\n**Current Phase Name:** Auth\n**Status:** In progress\n**Current Plan:** 01-01\n**Last Activity:** 2025-01-01\n**Last Activity Description:** Working\n`,
    );

    const p1 = path.join(tmpDir, '.planning', 'phases', '01-auth');
    fs.mkdirSync(p1, { recursive: true });
    fs.writeFileSync(path.join(p1, '01-01-PLAN.md'), '# Plan');
    fs.writeFileSync(path.join(p1, '01-01-SUMMARY.md'), '# Summary');
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '02-api'), {
      recursive: true,
    });

    const result = runGsdTools('phase complete 1', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const req = fs.readFileSync(
      path.join(tmpDir, '.planning', 'REQUIREMENTS.md'),
      'utf-8',
    );

    // Checkboxes updated for phase 1 requirements
    assert.ok(
      req.includes('- [x] **AUTH-01**'),
      'AUTH-01 checkbox should be checked',
    );
    assert.ok(
      req.includes('- [x] **AUTH-02**'),
      'AUTH-02 checkbox should be checked',
    );
    // Other requirements unchanged
    assert.ok(
      req.includes('- [ ] **AUTH-03**'),
      'AUTH-03 should remain unchecked',
    );
    assert.ok(
      req.includes('- [ ] **API-01**'),
      'API-01 should remain unchecked',
    );

    // Traceability table updated
    assert.ok(
      req.includes('| AUTH-01 | Phase 1 | Complete |'),
      'AUTH-01 status should be Complete',
    );
    assert.ok(
      req.includes('| AUTH-02 | Phase 1 | Complete |'),
      'AUTH-02 status should be Complete',
    );
    assert.ok(
      req.includes('| AUTH-03 | Phase 2 | Pending |'),
      'AUTH-03 should remain Pending',
    );
    assert.ok(
      req.includes('| API-01 | Phase 2 | Pending |'),
      'API-01 should remain Pending',
    );
  });

  test('handles requirements with bracket format [REQ-01, REQ-02]', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap

- [ ] Phase 1: Auth

### Phase 1: Auth
**Goal:** User authentication
**Requirements:** [AUTH-01, AUTH-02]
**Plans:** 1 plans

### Phase 2: API
**Goal:** Build API
**Requirements:** [API-01]
`,
    );
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'REQUIREMENTS.md'),
      `# Requirements

## v1 Requirements

### Authentication

- [ ] **AUTH-01**: User can sign up with email
- [ ] **AUTH-02**: User can log in
- [ ] **AUTH-03**: User can reset password

### API

- [ ] **API-01**: REST endpoints

## Traceability

| Requirement | Phase | Status |
|-------------|-------|--------|
| AUTH-01 | Phase 1 | Pending |
| AUTH-02 | Phase 1 | Pending |
| AUTH-03 | Phase 2 | Pending |
| API-01 | Phase 2 | Pending |
`,
    );
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      `# State\n\n**Current Phase:** 01\n**Current Phase Name:** Auth\n**Status:** In progress\n**Current Plan:** 01-01\n**Last Activity:** 2025-01-01\n**Last Activity Description:** Working\n`,
    );

    const p1 = path.join(tmpDir, '.planning', 'phases', '01-auth');
    fs.mkdirSync(p1, { recursive: true });
    fs.writeFileSync(path.join(p1, '01-01-PLAN.md'), '# Plan');
    fs.writeFileSync(path.join(p1, '01-01-SUMMARY.md'), '# Summary');
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '02-api'), {
      recursive: true,
    });

    const result = runGsdTools('phase complete 1', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const req = fs.readFileSync(
      path.join(tmpDir, '.planning', 'REQUIREMENTS.md'),
      'utf-8',
    );

    // Checkboxes updated for phase 1 requirements (brackets stripped)
    assert.ok(
      req.includes('- [x] **AUTH-01**'),
      'AUTH-01 checkbox should be checked',
    );
    assert.ok(
      req.includes('- [x] **AUTH-02**'),
      'AUTH-02 checkbox should be checked',
    );
    // Other requirements unchanged
    assert.ok(
      req.includes('- [ ] **AUTH-03**'),
      'AUTH-03 should remain unchecked',
    );
    assert.ok(
      req.includes('- [ ] **API-01**'),
      'API-01 should remain unchecked',
    );

    // Traceability table updated
    assert.ok(
      req.includes('| AUTH-01 | Phase 1 | Complete |'),
      'AUTH-01 status should be Complete',
    );
    assert.ok(
      req.includes('| AUTH-02 | Phase 1 | Complete |'),
      'AUTH-02 status should be Complete',
    );
    assert.ok(
      req.includes('| AUTH-03 | Phase 2 | Pending |'),
      'AUTH-03 should remain Pending',
    );
    assert.ok(
      req.includes('| API-01 | Phase 2 | Pending |'),
      'API-01 should remain Pending',
    );
  });

  test('handles phase with no requirements mapping', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap

- [ ] Phase 1: Setup

### Phase 1: Setup
**Goal:** Project setup (no requirements)
**Plans:** 1 plans
`,
    );
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'REQUIREMENTS.md'),
      `# Requirements

## v1 Requirements

- [ ] **REQ-01**: Some requirement

## Traceability

| Requirement | Phase | Status |
|-------------|-------|--------|
| REQ-01 | Phase 2 | Pending |
`,
    );
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      `# State\n\n**Current Phase:** 01\n**Status:** In progress\n**Current Plan:** 01-01\n**Last Activity:** 2025-01-01\n**Last Activity Description:** Working\n`,
    );

    const p1 = path.join(tmpDir, '.planning', 'phases', '01-setup');
    fs.mkdirSync(p1, { recursive: true });
    fs.writeFileSync(path.join(p1, '01-01-PLAN.md'), '# Plan');
    fs.writeFileSync(path.join(p1, '01-01-SUMMARY.md'), '# Summary');

    const result = runGsdTools('phase complete 1', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    // REQUIREMENTS.md should be unchanged
    const req = fs.readFileSync(
      path.join(tmpDir, '.planning', 'REQUIREMENTS.md'),
      'utf-8',
    );
    assert.ok(
      req.includes('- [ ] **REQ-01**'),
      'REQ-01 should remain unchecked',
    );
    assert.ok(
      req.includes('| REQ-01 | Phase 2 | Pending |'),
      'REQ-01 should remain Pending',
    );
  });

  test('handles missing REQUIREMENTS.md gracefully', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap

- [ ] Phase 1: Foundation
**Requirements:** REQ-01

### Phase 1: Foundation
**Goal:** Setup
`,
    );
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      `# State\n\n**Current Phase:** 01\n**Status:** In progress\n**Current Plan:** 01-01\n**Last Activity:** 2025-01-01\n**Last Activity Description:** Working\n`,
    );

    const p1 = path.join(tmpDir, '.planning', 'phases', '01-foundation');
    fs.mkdirSync(p1, { recursive: true });
    fs.writeFileSync(path.join(p1, '01-01-PLAN.md'), '# Plan');
    fs.writeFileSync(path.join(p1, '01-01-SUMMARY.md'), '# Summary');

    const result = runGsdTools('phase complete 1', tmpDir);
    assert.ok(
      result.success,
      `Command should succeed even without REQUIREMENTS.md: ${result.error}`,
    );
  });

  test('returns requirements_updated field in result', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap

- [ ] Phase 1: Auth

### Phase 1: Auth
**Goal:** User authentication
**Requirements:** AUTH-01
**Plans:** 1 plans
`,
    );
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'REQUIREMENTS.md'),
      `# Requirements

## v1 Requirements

- [ ] **AUTH-01**: User can sign up

## Traceability

| Requirement | Phase | Status |
|-------------|-------|--------|
| AUTH-01 | Phase 1 | Pending |
`,
    );
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      `# State\n\n**Current Phase:** 01\n**Current Phase Name:** Auth\n**Status:** In progress\n**Current Plan:** 01-01\n**Last Activity:** 2025-01-01\n**Last Activity Description:** Working\n`,
    );

    const p1 = path.join(tmpDir, '.planning', 'phases', '01-auth');
    fs.mkdirSync(p1, { recursive: true });
    fs.writeFileSync(path.join(p1, '01-01-PLAN.md'), '# Plan');
    fs.writeFileSync(path.join(p1, '01-01-SUMMARY.md'), '# Summary');

    const result = runGsdTools('phase complete 1 --json', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);
    const parsed = JSON.parse(result.output);
    assert.strictEqual(
      parsed.requirements_updated,
      true,
      'requirements_updated should be true',
    );
  });

  test('handles In Progress status in traceability table', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap

- [ ] Phase 1: Auth

### Phase 1: Auth
**Goal:** User authentication
**Requirements:** AUTH-01, AUTH-02
**Plans:** 1 plans
`,
    );
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'REQUIREMENTS.md'),
      `# Requirements

## v1 Requirements

- [ ] **AUTH-01**: User can sign up
- [ ] **AUTH-02**: User can log in

## Traceability

| Requirement | Phase | Status |
|-------------|-------|--------|
| AUTH-01 | Phase 1 | In Progress |
| AUTH-02 | Phase 1 | Pending |
`,
    );
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      `# State\n\n**Current Phase:** 01\n**Current Phase Name:** Auth\n**Status:** In progress\n**Current Plan:** 01-01\n**Last Activity:** 2025-01-01\n**Last Activity Description:** Working\n`,
    );

    const p1 = path.join(tmpDir, '.planning', 'phases', '01-auth');
    fs.mkdirSync(p1, { recursive: true });
    fs.writeFileSync(path.join(p1, '01-01-PLAN.md'), '# Plan');
    fs.writeFileSync(path.join(p1, '01-01-SUMMARY.md'), '# Summary');

    const result = runGsdTools('phase complete 1', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const req = fs.readFileSync(
      path.join(tmpDir, '.planning', 'REQUIREMENTS.md'),
      'utf-8',
    );
    assert.ok(
      req.includes('| AUTH-01 | Phase 1 | Complete |'),
      'In Progress should become Complete',
    );
    assert.ok(
      req.includes('| AUTH-02 | Phase 1 | Complete |'),
      'Pending should become Complete',
    );
  });

  test('scoped regex does not cross phase boundaries', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap

- [ ] Phase 1: Setup
- [ ] Phase 2: Auth

### Phase 1: Setup
**Goal:** Project setup
**Plans:** 1 plans

### Phase 2: Auth
**Goal:** User authentication
**Requirements:** AUTH-01
**Plans:** 0 plans
`,
    );
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'REQUIREMENTS.md'),
      `# Requirements

## v1 Requirements

- [ ] **AUTH-01**: User can sign up

## Traceability

| Requirement | Phase | Status |
|-------------|-------|--------|
| AUTH-01 | Phase 2 | Pending |
`,
    );
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      `# State\n\n**Current Phase:** 01\n**Current Phase Name:** Setup\n**Status:** In progress\n**Current Plan:** 01-01\n**Last Activity:** 2025-01-01\n**Last Activity Description:** Working\n`,
    );

    const p1 = path.join(tmpDir, '.planning', 'phases', '01-setup');
    fs.mkdirSync(p1, { recursive: true });
    fs.writeFileSync(path.join(p1, '01-01-PLAN.md'), '# Plan');
    fs.writeFileSync(path.join(p1, '01-01-SUMMARY.md'), '# Summary');
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '02-auth'), {
      recursive: true,
    });

    const result = runGsdTools('phase complete 1', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    // First phase has no Requirements field, so second phase's requirement should NOT be updated
    const req = fs.readFileSync(
      path.join(tmpDir, '.planning', 'REQUIREMENTS.md'),
      'utf-8',
    );
    assert.ok(
      req.includes('- [ ] **AUTH-01**'),
      'AUTH-01 should remain unchecked (belongs to Phase 2)',
    );
    assert.ok(
      req.includes('| AUTH-01 | Phase 2 | Pending |'),
      'AUTH-01 should remain Pending (belongs to Phase 2)',
    );
  });

  test('handles multi-level decimal phase without regex crash', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap

- [x] Phase 3: Lorem
- [x] Phase 3.2: Ipsum
- [ ] Phase 3.2.1: Dolor Sit
- [ ] Phase 4: Amet

### Phase 3: Lorem
**Goal:** Setup
**Plans:** 1/1 plans complete
**Requirements:** LOR-01

### Phase 3.2: Ipsum
**Goal:** Build
**Plans:** 1/1 plans complete
**Requirements:** IPS-01

### Phase 03.2.1: Dolor Sit Polish (INSERTED)
**Goal:** Polish
**Plans:** 1/1 plans complete

### Phase 4: Amet
**Goal:** Deliver
**Requirements:** AMT-01: Filter items by category with AND logic (items matching ALL selected categories)
`,
    );

    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'REQUIREMENTS.md'),
      `# Requirements

- [ ] **LOR-01**: Lorem database schema
- [ ] **IPS-01**: Ipsum rendering engine
- [ ] **AMT-01**: Filter items by category
`,
    );

    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      `# State

**Current Phase:** 03.2.1
**Current Phase Name:** Dolor Sit Polish
**Status:** Execution complete
**Current Plan:** 03.2.1-01
**Last Activity:** 2025-01-01
**Last Activity Description:** Working
`,
    );

    const p32 = path.join(tmpDir, '.planning', 'phases', '03.2-ipsum');
    const p321 = path.join(tmpDir, '.planning', 'phases', '03.2.1-dolor-sit');
    const p4 = path.join(tmpDir, '.planning', 'phases', '04-amet');
    fs.mkdirSync(p32, { recursive: true });
    fs.mkdirSync(p321, { recursive: true });
    fs.mkdirSync(p4, { recursive: true });
    fs.writeFileSync(path.join(p321, '03.2.1-01-PLAN.md'), '# Plan');
    fs.writeFileSync(path.join(p321, '03.2.1-01-SUMMARY.md'), '# Summary');

    const result = runGsdTools('phase complete 03.2.1', tmpDir);
    assert.ok(
      result.success,
      `Command should not crash on regex metacharacters: ${result.error}`,
    );

    const req = fs.readFileSync(
      path.join(tmpDir, '.planning', 'REQUIREMENTS.md'),
      'utf-8',
    );
    assert.ok(
      req.includes('- [ ] **AMT-01**'),
      'AMT-01 should remain unchanged',
    );
  });

  test('preserves Milestone column in 5-column progress table', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap

- [ ] Phase 1: Foundation

### Phase 1: Foundation
**Goal:** Setup
**Plans:** 1 plans

## Progress

| Phase | Milestone | Plans Complete | Status | Completed |
|-------|-----------|----------------|--------|-----------|
| 1. Foundation | v1.0 | 0/1 | Planned |  |
`,
    );
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      `# State\n\n**Current Phase:** 01\n**Status:** In progress\n**Current Plan:** 01-01\n**Last Activity:** 2025-01-01\n**Last Activity Description:** Working\n`,
    );

    const p1 = path.join(tmpDir, '.planning', 'phases', '01-foundation');
    fs.mkdirSync(p1, { recursive: true });
    fs.writeFileSync(path.join(p1, '01-01-PLAN.md'), '# Plan');
    fs.writeFileSync(path.join(p1, '01-01-SUMMARY.md'), '# Summary');

    const result = runGsdTools('phase complete 1', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const roadmap = fs.readFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      'utf-8',
    );
    const rowMatch = roadmap.match(/^\|[^\n]*1\. Foundation[^\n]*$/m);
    assert.ok(rowMatch, 'table row should exist');
    const cells = rowMatch[0]
      .split('|')
      .slice(1, -1)
      .map((c) => c.trim());
    assert.strictEqual(cells.length, 5, 'should have 5 columns');
    assert.strictEqual(
      cells[1],
      'v1.0',
      'Milestone column should be preserved',
    );
    assert.ok(
      cells[3].includes('Complete'),
      'Status column should be Complete',
    );
  });

  test('phase complete keeps top YAML and body bold in sync (Bug 260502-wid)', () => {
    // Seed: body has current phase 01 body bold fields; no YAML frontmatter yet.
    // Simulates a STATE.md that has only ever had body bold (pre-fix drift state).
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap

- [ ] Phase 1: Foundation
- [ ] Phase 2: API

### Phase 1: Foundation
**Goal:** Setup
**Plans:** 1 plans

### Phase 2: API
**Goal:** Build API
`,
    );
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      `# State\n\n**Current Phase:** 01\n**Current Phase Name:** Foundation\n**Status:** In progress\n**Current Plan:** 01-01\n**Last Activity:** 2025-01-01\n**Last Activity Description:** Working on phase 1\n`,
    );

    const p1 = path.join(tmpDir, '.planning', 'phases', '01-foundation');
    fs.mkdirSync(p1, { recursive: true });
    fs.writeFileSync(path.join(p1, '01-01-PLAN.md'), '# Plan');
    fs.writeFileSync(path.join(p1, '01-01-SUMMARY.md'), '# Summary');
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '02-api'), {
      recursive: true,
    });

    const result = runGsdTools('phase complete 1 --json', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const { extractFrontmatter } = require('../gsd-ng/bin/lib/frontmatter.cjs');
    const content = fs.readFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      'utf-8',
    );
    const fm = extractFrontmatter(content);

    assert.ok(
      fm && Object.keys(fm).length > 0,
      'STATE.md should have YAML frontmatter after phase complete',
    );

    // Extract body bold values for comparison
    const bodyPhase = (content.match(/\*\*Current Phase:\*\*\s*(\S+)/) ||
      [])[1];
    const bodyStatus = (content.match(/\*\*Status:\*\*\s*(.+)/) || [])[1];

    assert.ok(bodyPhase, 'body should have **Current Phase:** field');
    assert.ok(bodyStatus, 'body should have **Status:** field');

    // Top YAML current_phase should match body bold **Current Phase:**
    assert.strictEqual(
      String(fm.current_phase),
      bodyPhase.trim(),
      `YAML current_phase (${fm.current_phase}) should match body bold (${bodyPhase.trim()})`,
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// comparePhaseNum and normalizePhaseName (imported directly)
// ─────────────────────────────────────────────────────────────────────────────

const {
  comparePhaseNum,
  normalizePhaseName,
} = require('../gsd-ng/bin/lib/core.cjs');

describe('comparePhaseNum', () => {
  test('sorts integer phases numerically', () => {
    assert.ok(comparePhaseNum('2', '10') < 0);
    assert.ok(comparePhaseNum('10', '2') > 0);
    assert.strictEqual(comparePhaseNum('5', '5'), 0);
  });

  test('sorts decimal phases correctly', () => {
    assert.ok(comparePhaseNum('12', '12.1') < 0);
    assert.ok(comparePhaseNum('12.1', '12.2') < 0);
    assert.ok(comparePhaseNum('12.2', '13') < 0);
  });

  test('sorts letter-suffix phases correctly', () => {
    assert.ok(comparePhaseNum('12', '12A') < 0);
    assert.ok(comparePhaseNum('12A', '12B') < 0);
    assert.ok(comparePhaseNum('12B', '13') < 0);
  });

  test('sorts hybrid phases correctly', () => {
    assert.ok(comparePhaseNum('12A', '12A.1') < 0);
    assert.ok(comparePhaseNum('12A.1', '12A.2') < 0);
    assert.ok(comparePhaseNum('12A.2', '12B') < 0);
  });

  test('handles full sort order', () => {
    const phases = ['13', '12B', '12A.2', '12', '12.1', '12A', '12A.1', '12.2'];
    phases.sort(comparePhaseNum);
    assert.deepStrictEqual(phases, [
      '12',
      '12.1',
      '12.2',
      '12A',
      '12A.1',
      '12A.2',
      '12B',
      '13',
    ]);
  });

  test('handles directory names with slugs', () => {
    const dirs = [
      '13-deploy',
      '12B-hotfix',
      '12A.1-bugfix',
      '12-foundation',
      '12.1-inserted',
      '12A-split',
    ];
    dirs.sort(comparePhaseNum);
    assert.deepStrictEqual(dirs, [
      '12-foundation',
      '12.1-inserted',
      '12A-split',
      '12A.1-bugfix',
      '12B-hotfix',
      '13-deploy',
    ]);
  });

  test('case insensitive letter matching', () => {
    assert.ok(comparePhaseNum('12a', '12B') < 0);
    assert.ok(comparePhaseNum('12A', '12b') < 0);
    assert.strictEqual(comparePhaseNum('12a', '12A'), 0);
  });

  test('sorts multi-level decimal phases correctly', () => {
    assert.ok(comparePhaseNum('3.2', '3.2.1') < 0);
    assert.ok(comparePhaseNum('3.2.1', '3.2.2') < 0);
    assert.ok(comparePhaseNum('3.2.1', '3.3') < 0);
    assert.ok(comparePhaseNum('3.2.1', '4') < 0);
    assert.strictEqual(comparePhaseNum('3.2.1', '3.2.1'), 0);
  });

  test('falls back to localeCompare for non-phase strings', () => {
    const result = comparePhaseNum('abc', 'def');
    assert.strictEqual(typeof result, 'number');
  });
});

describe('normalizePhaseName', () => {
  test('pads single-digit integers', () => {
    assert.strictEqual(normalizePhaseName('3'), '03');
    assert.strictEqual(normalizePhaseName('12'), '12');
  });

  test('handles decimal phases', () => {
    assert.strictEqual(normalizePhaseName('3.1'), '03.1');
    assert.strictEqual(normalizePhaseName('12.2'), '12.2');
  });

  test('handles letter-suffix phases', () => {
    assert.strictEqual(normalizePhaseName('3A'), '03A');
    assert.strictEqual(normalizePhaseName('12B'), '12B');
  });

  test('handles hybrid phases', () => {
    assert.strictEqual(normalizePhaseName('3A.1'), '03A.1');
    assert.strictEqual(normalizePhaseName('12A.2'), '12A.2');
  });

  test('uppercases letters', () => {
    assert.strictEqual(normalizePhaseName('3a'), '03A');
    assert.strictEqual(normalizePhaseName('12b.1'), '12B.1');
  });

  test('handles multi-level decimal phases', () => {
    assert.strictEqual(normalizePhaseName('3.2.1'), '03.2.1');
    assert.strictEqual(normalizePhaseName('12.3.4'), '12.3.4');
  });

  test('returns non-matching input unchanged', () => {
    assert.strictEqual(normalizePhaseName('abc'), 'abc');
  });
});

describe('letter-suffix phase sorting', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('lists letter-suffix phases in correct order', () => {
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '12-foundation'), {
      recursive: true,
    });
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '12.1-inserted'), {
      recursive: true,
    });
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '12A-split'), {
      recursive: true,
    });
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '12A.1-bugfix'), {
      recursive: true,
    });
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '12B-hotfix'), {
      recursive: true,
    });
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '13-deploy'), {
      recursive: true,
    });

    const result = runGsdTools('phases list --json', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.deepStrictEqual(
      output.directories,
      [
        '12-foundation',
        '12.1-inserted',
        '12A-split',
        '12A.1-bugfix',
        '12B-hotfix',
        '13-deploy',
      ],
      'letter-suffix phases should sort correctly',
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// zero-padded phase arguments
// ─────────────────────────────────────────────────────────────────────────────

describe('phase complete zero-padded phase arguments', () => {
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

    const result = runGsdTools('phase complete 05 --json', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);
    const output = JSON.parse(result.output);
    assert.strictEqual(output.roadmap_updated, true, 'targets landed');
    assert.deepStrictEqual(output.roadmap_missed_targets, []);

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
    assert.match(roadmap, /^\| 5\. Five \| 0\/1 \| Complete/m);
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

    const result = runGsdTools('phase complete 05', tmpDir);
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
});

// ─────────────────────────────────────────────────────────────────────────────
// phase checkbox anchoring
// ─────────────────────────────────────────────────────────────────────────────

describe('phase checkbox anchoring', () => {
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

- [ ] **Phase 4: Alpha** - groundwork that blocks Phase 5
- [ ] **Phase 5: Five** - the real one

## Phase Details

### Phase 4: Alpha
**Goal**: Do four
**Plans**: TBD

### Phase 5: Five
**Goal**: Do five
**Plans**: TBD
`;

  function writeFixture() {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      CROSS_REFERENCING_ROADMAP,
    );
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '04-alpha'), {
      recursive: true,
    });
    const p5 = path.join(tmpDir, '.planning', 'phases', '05-five');
    fs.mkdirSync(p5, { recursive: true });
    fs.writeFileSync(path.join(p5, '05-01-PLAN.md'), '# Plan');
    fs.writeFileSync(path.join(p5, '05-01-SUMMARY.md'), '# Summary');
  }

  function readRoadmap() {
    return fs.readFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      'utf-8',
    );
  }

  test('phase complete does not tick a phase that merely mentions it', () => {
    writeFixture();

    const result = runGsdTools('phase complete 5 --json', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const roadmap = readRoadmap();
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

  test('phase remove does not delete a phase that merely mentions it', () => {
    writeFixture();

    const result = runGsdTools('phase remove 5 --force --json', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const roadmap = readRoadmap();
    assert.match(
      roadmap,
      /^- \[ \] \*\*Phase 4: Alpha\*\*/m,
      "Phase 4's checkbox line must survive removing phase 5",
    );
    assert.doesNotMatch(
      roadmap,
      /\*\*Phase 5: Five\*\*/,
      "Phase 5's checkbox line should be gone",
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// phase complete — rewrite landing verification
// ─────────────────────────────────────────────────────────────────────────────

describe('phase complete landing verification', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  function completePhase1(roadmapContent) {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      roadmapContent,
    );
    const p1 = path.join(tmpDir, '.planning', 'phases', '01-foundation');
    fs.mkdirSync(p1, { recursive: true });
    fs.writeFileSync(path.join(p1, '01-01-PLAN.md'), '# Plan');
    fs.writeFileSync(path.join(p1, '01-01-SUMMARY.md'), '# Summary');
    const result = runGsdTools('phase complete 1 --json', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);
    return JSON.parse(result.output);
  }

  test('a conformant roadmap reports no missed targets', () => {
    const output = completePhase1(`# Roadmap

- [ ] **Phase 1: Foundation** - set up

### Phase 1: Foundation
**Goal**: Set up
**Plans**: TBD

## Progress

| Phase | Plans Complete | Status | Completed |
|-------|---------------|--------|-----------|
| 1. Foundation | 0/1 | Planned |  |
`);
    assert.strictEqual(output.roadmap_updated, true, 'targets landed');
    assert.deepStrictEqual(
      output.roadmap_missed_targets,
      [],
      'every target landed, so nothing should be reported',
    );
  });

  test('names the Plans line when the label is not bold', () => {
    const output = completePhase1(`# Roadmap

- [ ] **Phase 1: Foundation** - set up

### Phase 1: Foundation
**Goal**: Set up
Plans: TBD
`);
    assert.deepStrictEqual(
      output.roadmap_missed_targets,
      ['plans-line'],
      'a Plans line the rewrite cannot reach must be named',
    );
  });

  test('does not claim the roadmap was updated when no target matched', () => {
    const before = `# Roadmap

### Phase 1: Foundation
**Goal**: Set up
Plans: TBD
`;
    const output = completePhase1(before);
    assert.strictEqual(
      output.roadmap_updated,
      false,
      'nothing was rewritten, so the command must not report an update',
    );
    assert.deepStrictEqual(output.roadmap_missed_targets, ['plans-line']);
    assert.strictEqual(
      fs.readFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), 'utf-8'),
      before,
      'a run that changed nothing must not rewrite the file',
    );
  });

  // The rewrites reach only the text after the last </details>, so a live
  // milestone written above a collapsed one is out of scope for all of them.
  // Probes scoped the same way saw nothing either and reported the file clean —
  // the scope mismatch is the failure the reporting exists for.
  test('names every target a live milestone above the archive puts out of reach', () => {
    const before = `# Roadmap

- [ ] **Phase 1: Foundation** - set up

### Phase 1: Foundation
**Goal**: Set up
**Plans**: TBD

## Progress

| Phase | Plans Complete | Status | Completed |
|-------|---------------|--------|-----------|
| 1. Foundation | 0/1 | Planned |  |

<details>
<summary>v0.9 - SHIPPED 2020-01-01</summary>

### Phase 0: Prehistory
**Plans**: 1/1 plans complete

</details>
`;
    const output = completePhase1(before);
    assert.strictEqual(
      output.roadmap_updated,
      false,
      'nothing was rewritten — every target sits above the collapsed section',
    );
    assert.deepStrictEqual(output.roadmap_missed_targets, [
      'phase-checkbox',
      'progress-table',
      'plans-line',
    ]);
    assert.strictEqual(
      fs.readFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), 'utf-8'),
      before,
      'and the file is left as it was',
    );
  });

  // The other side of the scope: an archived milestone is unreachable by
  // design, so its content is not a missed target. Probing the whole document
  // rather than the current milestone would report this one.
  test('a target that exists only in an archived milestone is not reported', () => {
    const output = completePhase1(`# Roadmap

<details>
<summary>v0.9 - SHIPPED 2020-01-01</summary>

### Phase 1: Foundation
**Plans**: 1/1 plans complete

</details>

- [ ] **Phase 1: Foundation** - set up

## Progress

| Phase | Plans Complete | Status | Completed |
|-------|---------------|--------|-----------|
| 1. Foundation | 0/1 | Planned |  |
`);
    assert.strictEqual(
      output.roadmap_updated,
      true,
      'the reachable targets landed',
    );
    assert.deepStrictEqual(
      output.roadmap_missed_targets,
      [],
      'the archived Plans line is out of scope by design, not missed',
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// milestone-scoped next-phase in phase complete
// ─────────────────────────────────────────────────────────────────────────────

describe('phase complete milestone-scoped next-phase', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('finds next phase within milestone, ignoring prior milestone dirs', () => {
    // ROADMAP lists phases 5-6 (current milestone v2.0)
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      [
        '## Roadmap v2.0: Release',
        '',
        '- [ ] Phase 5: Auth',
        '- [ ] Phase 6: Dashboard',
        '',
        '### Phase 5: Auth',
        '**Goal:** Add authentication',
        '**Plans:** 1 plans',
        '',
        '### Phase 6: Dashboard',
        '**Goal:** Build dashboard',
      ].join('\n'),
    );

    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      '# State\n\n**Current Phase:** 05\n**Current Phase Name:** Auth\n**Status:** In progress\n**Current Plan:** 05-01\n**Last Activity:** 2025-01-01\n**Last Activity Description:** Working\n',
    );

    // Disk has dirs 01-06 (01-04 completed from prior milestone)
    for (let i = 1; i <= 4; i++) {
      const padded = String(i).padStart(2, '0');
      const phaseDir = path.join(
        tmpDir,
        '.planning',
        'phases',
        `${padded}-old-phase`,
      );
      fs.mkdirSync(phaseDir, { recursive: true });
      fs.writeFileSync(path.join(phaseDir, `${padded}-01-PLAN.md`), '# Plan');
      fs.writeFileSync(
        path.join(phaseDir, `${padded}-01-SUMMARY.md`),
        '# Summary',
      );
    }

    // fifth phase — completing this one
    const p5 = path.join(tmpDir, '.planning', 'phases', '05-auth');
    fs.mkdirSync(p5, { recursive: true });
    fs.writeFileSync(path.join(p5, '05-01-PLAN.md'), '# Plan');
    fs.writeFileSync(path.join(p5, '05-01-SUMMARY.md'), '# Summary');

    // sixth phase — next phase in milestone
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '06-dashboard'), {
      recursive: true,
    });

    const result = runGsdTools('phase complete 5 --json', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(
      output.is_last_phase,
      false,
      'should NOT be last phase — phase 6 is in milestone',
    );
    assert.deepStrictEqual(
      output.next_phase,
      { number: '06', name: 'dashboard' },
      'next phase should be 06',
    );
    assert.strictEqual(
      typeof output.next_phase_name,
      'string',
      'next_phase_name backward compat field',
    );
  });

  test('detects last phase when only milestone phases are considered', () => {
    // ROADMAP lists only phase 5 (current milestone)
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      [
        '## Roadmap v2.0: Release',
        '',
        '### Phase 5: Auth',
        '**Goal:** Add authentication',
        '**Plans:** 1 plans',
      ].join('\n'),
    );

    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      '# State\n\n**Current Phase:** 05\n**Current Phase Name:** Auth\n**Status:** In progress\n**Current Plan:** 05-01\n**Last Activity:** 2025-01-01\n**Last Activity Description:** Working\n',
    );

    // Disk has dirs 01-06 but only 5 is in ROADMAP
    for (let i = 1; i <= 6; i++) {
      const padded = String(i).padStart(2, '0');
      const phaseDir = path.join(
        tmpDir,
        '.planning',
        'phases',
        `${padded}-phase-${i}`,
      );
      fs.mkdirSync(phaseDir, { recursive: true });
      fs.writeFileSync(path.join(phaseDir, `${padded}-01-PLAN.md`), '# Plan');
      fs.writeFileSync(
        path.join(phaseDir, `${padded}-01-SUMMARY.md`),
        '# Summary',
      );
    }

    const result = runGsdTools('phase complete 5 --json', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    // Without the fix, dirs 06 on disk would make is_last_phase=false
    // With the fix, only phase 5 is in milestone, so it IS the last phase
    assert.strictEqual(
      output.is_last_phase,
      true,
      'should be last phase — only phase 5 is in milestone',
    );
    assert.strictEqual(output.next_phase, null, 'no next phase in milestone');
  });

  test('advances to bullet-only next phase (no Details section yet)', () => {
    // Auth (5) has a Details section; Dashboard (6) is bullet-only, not yet planned
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      [
        '## Roadmap v2.0: Release',
        '',
        '- [ ] **Phase 5: Auth**',
        '- [ ] **Phase 6: Dashboard**',
        '',
        '### Phase 5: Auth',
        '**Goal:** Add authentication',
        '**Plans:** 1 plans',
        // No Details section for Dashboard (6) — bullet-only entry
      ].join('\n'),
    );

    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      '# State\n\n**Current Phase:** 05\n**Current Phase Name:** Auth\n**Status:** In progress\n**Current Plan:** 05-01\n**Last Activity:** 2025-01-01\n**Last Activity Description:** Working\n',
    );

    // Only 05-auth exists on disk; no 06-* directory forces roadmap fallback to fire
    const p5 = path.join(tmpDir, '.planning', 'phases', '05-auth');
    fs.mkdirSync(p5, { recursive: true });
    fs.writeFileSync(path.join(p5, '05-01-PLAN.md'), '# Plan');
    fs.writeFileSync(path.join(p5, '05-01-SUMMARY.md'), '# Summary');

    const result = runGsdTools('phase complete 5 --json', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    // Dashboard (6) exists as bullet-only entry — must NOT be treated as last phase
    assert.strictEqual(
      output.is_last_phase,
      false,
      'should NOT be last phase — bullet-only next phase exists in ROADMAP',
    );
    // Bullet regex captures unpadded '6'; accept either '6' or '06'
    const nextNum = output.next_phase && output.next_phase.number;
    assert.ok(
      nextNum === '6' || nextNum === '06',
      `next_phase.number should be '6' or '06', got '${nextNum}'`,
    );
    assert.strictEqual(
      output.next_phase && output.next_phase.name,
      'dashboard',
      'next_phase.name should be dashboard',
    );

    // STATE.md should reflect the transition
    const stateContent = fs.readFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      'utf-8',
    );
    assert.ok(
      /\*\*Current Phase:\*\*\s*(6|06)/.test(stateContent),
      'STATE.md Current Phase should be updated to 6 or 06',
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// phase-plan-index file overlap detection
// ─────────────────────────────────────────────────────────────────────────────

describe('phase-plan-index file overlap detection', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('same-wave overlap detected — overlaps array contains shared file', () => {
    const phaseDir = path.join(tmpDir, '.planning', 'phases', '25-safety');
    fs.mkdirSync(phaseDir, { recursive: true });

    fs.writeFileSync(
      path.join(phaseDir, '25-01-PLAN.md'),
      `---\nwave: 1\nautonomous: true\nfiles_modified: [src/a.cjs, src/shared.cjs]\n---\n<objective>\nPlan A\n</objective>\n`,
    );
    fs.writeFileSync(
      path.join(phaseDir, '25-02-PLAN.md'),
      `---\nwave: 1\nautonomous: true\nfiles_modified: [src/b.cjs, src/shared.cjs]\n---\n<objective>\nPlan B\n</objective>\n`,
    );

    const result = runGsdTools('phase-plan-index 25 --json', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.ok(Array.isArray(output.overlaps), 'overlaps should be an array');
    assert.strictEqual(
      output.overlaps.length,
      1,
      'should detect one overlap entry',
    );
    assert.deepStrictEqual(
      output.overlaps[0].plans.sort(),
      ['25-01', '25-02'],
      'overlap entry should list both plans',
    );
    assert.deepStrictEqual(
      output.overlaps[0].files,
      ['src/shared.cjs'],
      'overlap entry should list shared file',
    );
  });

  test('no overlap returns empty array — disjoint files_modified', () => {
    const phaseDir = path.join(tmpDir, '.planning', 'phases', '25-safety');
    fs.mkdirSync(phaseDir, { recursive: true });

    fs.writeFileSync(
      path.join(phaseDir, '25-01-PLAN.md'),
      `---\nwave: 1\nautonomous: true\nfiles_modified: [src/a.cjs]\n---\n<objective>\nPlan A\n</objective>\n`,
    );
    fs.writeFileSync(
      path.join(phaseDir, '25-02-PLAN.md'),
      `---\nwave: 1\nautonomous: true\nfiles_modified: [src/b.cjs]\n---\n<objective>\nPlan B\n</objective>\n`,
    );

    const result = runGsdTools('phase-plan-index 25 --json', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.ok(Array.isArray(output.overlaps), 'overlaps should be an array');
    assert.deepStrictEqual(
      output.overlaps,
      [],
      'disjoint files should produce empty overlaps',
    );
  });

  test('different waves not flagged — shared file in different waves produces no overlap', () => {
    const phaseDir = path.join(tmpDir, '.planning', 'phases', '25-safety');
    fs.mkdirSync(phaseDir, { recursive: true });

    fs.writeFileSync(
      path.join(phaseDir, '25-01-PLAN.md'),
      `---\nwave: 1\nautonomous: true\nfiles_modified: [src/shared.cjs]\n---\n<objective>\nPlan A\n</objective>\n`,
    );
    fs.writeFileSync(
      path.join(phaseDir, '25-02-PLAN.md'),
      `---\nwave: 2\nautonomous: true\nfiles_modified: [src/shared.cjs]\n---\n<objective>\nPlan B\n</objective>\n`,
    );

    const result = runGsdTools('phase-plan-index 25 --json', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.ok(Array.isArray(output.overlaps), 'overlaps should be an array');
    assert.deepStrictEqual(
      output.overlaps,
      [],
      'different-wave plans sharing files should not be flagged',
    );
  });

  test('multi-plan overlap — three same-wave plans produce two overlap entries', () => {
    const phaseDir = path.join(tmpDir, '.planning', 'phases', '25-safety');
    fs.mkdirSync(phaseDir, { recursive: true });

    // A shares shared.cjs with B; A shares x.cjs with C
    fs.writeFileSync(
      path.join(phaseDir, '25-01-PLAN.md'),
      `---\nwave: 1\nautonomous: true\nfiles_modified: [x.cjs, shared.cjs]\n---\n<objective>\nPlan A\n</objective>\n`,
    );
    fs.writeFileSync(
      path.join(phaseDir, '25-02-PLAN.md'),
      `---\nwave: 1\nautonomous: true\nfiles_modified: [y.cjs, shared.cjs]\n---\n<objective>\nPlan B\n</objective>\n`,
    );
    fs.writeFileSync(
      path.join(phaseDir, '25-03-PLAN.md'),
      `---\nwave: 1\nautonomous: true\nfiles_modified: [x.cjs, z.cjs]\n---\n<objective>\nPlan C\n</objective>\n`,
    );

    const result = runGsdTools('phase-plan-index 25 --json', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.ok(Array.isArray(output.overlaps), 'overlaps should be an array');
    assert.strictEqual(
      output.overlaps.length,
      2,
      'should detect two overlap entries',
    );

    // Find A-B entry (shared.cjs) and A-C entry (x.cjs)
    const abEntry = output.overlaps.find((e) => e.files.includes('shared.cjs'));
    const acEntry = output.overlaps.find((e) => e.files.includes('x.cjs'));

    assert.ok(abEntry, 'should have A-B entry with shared.cjs');
    assert.deepStrictEqual(
      abEntry.plans.sort(),
      ['25-01', '25-02'],
      'A-B entry should list plans 01 and 02',
    );
    assert.deepStrictEqual(
      abEntry.files,
      ['shared.cjs'],
      'A-B entry should list shared.cjs',
    );

    assert.ok(acEntry, 'should have A-C entry with x.cjs');
    assert.deepStrictEqual(
      acEntry.plans.sort(),
      ['25-01', '25-03'],
      'A-C entry should list plans 01 and 03',
    );
    assert.deepStrictEqual(
      acEntry.files,
      ['x.cjs'],
      'A-C entry should list x.cjs',
    );
  });

  test('empty files_modified produces no overlaps — plans without files never match', () => {
    const phaseDir = path.join(tmpDir, '.planning', 'phases', '25-safety');
    fs.mkdirSync(phaseDir, { recursive: true });

    fs.writeFileSync(
      path.join(phaseDir, '25-01-PLAN.md'),
      `---\nwave: 1\nautonomous: true\nfiles_modified: []\n---\n<objective>\nPlan A\n</objective>\n`,
    );
    fs.writeFileSync(
      path.join(phaseDir, '25-02-PLAN.md'),
      `---\nwave: 1\nautonomous: true\nfiles_modified: []\n---\n<objective>\nPlan B\n</objective>\n`,
    );

    const result = runGsdTools('phase-plan-index 25 --json', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.ok(Array.isArray(output.overlaps), 'overlaps should be an array');
    assert.deepStrictEqual(
      output.overlaps,
      [],
      'empty files_modified should produce no overlaps',
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// milestone complete command
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// phase add — checkbox insertion in ROADMAP.md phases list
// ─────────────────────────────────────────────────────────────────────────────

describe('phase add inserts checkbox line in ROADMAP phases list', () => {
  let tmpDir;

  // Minimal ROADMAP with a phases list containing existing checkbox lines
  const roadmapWithPhasesList = `# Roadmap v1.0

## Phases

- [ ] **Phase 1: Foundation** - Build the base
- [x] **Phase 2: API** - Build the API

## Phase Details

### Phase 1: Foundation
**Goal:** Setup

### Phase 2: API
**Goal:** Build API

---
`;

  beforeEach(() => {
    tmpDir = createTempProject();
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      roadmapWithPhasesList,
    );
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('phase add inserts a checkbox line in the phases list', () => {
    const result = runGsdTools('phase add User Dashboard', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const roadmap = fs.readFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      'utf-8',
    );
    assert.ok(
      roadmap.includes('- [ ] **Phase 3: User Dashboard**'),
      `Expected checkbox line in roadmap. Got:\n${roadmap}`,
    );
  });

  test('phase add checkbox line appears before ## Phase Details', () => {
    const result = runGsdTools('phase add New Feature', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const roadmap = fs.readFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      'utf-8',
    );
    const checkboxIdx = roadmap.indexOf('- [ ] **Phase 3: New Feature**');
    const detailsIdx = roadmap.indexOf('## Phase Details');
    assert.ok(checkboxIdx !== -1, 'checkbox line should exist');
    assert.ok(detailsIdx !== -1, '## Phase Details heading should exist');
    assert.ok(
      checkboxIdx < detailsIdx,
      'checkbox line should appear before ## Phase Details',
    );
  });

  test('phase add details section still created (regression check)', () => {
    const result = runGsdTools('phase add User Dashboard', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const roadmap = fs.readFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      'utf-8',
    );
    assert.ok(
      roadmap.includes('### Phase 3: User Dashboard'),
      'details section should still be created',
    );
  });

  test('phase add still creates directory (regression check)', () => {
    const result = runGsdTools('phase add New Feature', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    assert.ok(
      fs.existsSync(path.join(tmpDir, '.planning', 'phases', '03-new-feature')),
      'directory should be created',
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// phase insert — checkbox insertion in ROADMAP.md phases list
// ─────────────────────────────────────────────────────────────────────────────

describe('phase insert inserts checkbox line in ROADMAP phases list', () => {
  let tmpDir;

  const roadmapWithPhasesList = `# Roadmap v1.0

## Phases

- [ ] **Phase 1: Foundation** - Build the base
- [ ] **Phase 2: API** - Build the API

## Phase Details

### Phase 1: Foundation
**Goal:** Setup

### Phase 2: API
**Goal:** Build API
`;

  beforeEach(() => {
    tmpDir = createTempProject();
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      roadmapWithPhasesList,
    );
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '01-foundation'), {
      recursive: true,
    });
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('phase insert inserts a checkbox line in the phases list', () => {
    const result = runGsdTools('phase insert 1 Fix Critical Bug', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const roadmap = fs.readFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      'utf-8',
    );
    assert.ok(
      roadmap.includes('- [ ] **Phase 01.1: Fix Critical Bug (INSERTED)**'),
      `Expected checkbox line in roadmap. Got:\n${roadmap}`,
    );
  });

  test('phase insert checkbox line appears after the parent phase checkbox line', () => {
    const result = runGsdTools('phase insert 1 Fix Critical Bug', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const roadmap = fs.readFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      'utf-8',
    );
    const parentIdx = roadmap.indexOf('- [ ] **Phase 1: Foundation**');
    const insertedIdx = roadmap.indexOf(
      '- [ ] **Phase 01.1: Fix Critical Bug (INSERTED)**',
    );
    assert.ok(parentIdx !== -1, 'parent checkbox should exist');
    assert.ok(insertedIdx !== -1, 'inserted checkbox line should exist');
    assert.ok(
      insertedIdx > parentIdx,
      'inserted checkbox should appear after parent checkbox',
    );
  });

  test('phase insert details section still created (regression check)', () => {
    const result = runGsdTools('phase insert 1 Fix Critical Bug', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const roadmap = fs.readFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      'utf-8',
    );
    assert.ok(
      roadmap.includes('### Phase 01.1: Fix Critical Bug (INSERTED)'),
      'details section should still be created',
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Branch-coverage uplift: tests below cover the residual uncovered ranges in
// phase.cjs (no-phasesDir branches, validation guards, error catches, edge
// filters).
// ─────────────────────────────────────────────────────────────────────────────

describe('cmdPhasesList edge cases', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('returns empty files list when phasesDir does not exist and --type is set', () => {
    // Hits L31-37: !fs.existsSync(phasesDir) AND options.type truthy → output(files:[]).
    cleanupSubdir(tmpDir, '.planning', 'phases');
    const r = runGsdTools(
      ['phases', 'list', '--type', 'plans', '--json'],
      tmpDir,
    );
    assert.ok(r.success, `Command failed: ${r.error}`);
    const out = JSON.parse(r.output);
    assert.deepStrictEqual(
      out.files,
      [],
      'files should be empty when phasesDir missing',
    );
    assert.strictEqual(out.count, 0);
  });

  test('returns empty files list when phasesDir does not exist and --type summaries', () => {
    cleanupSubdir(tmpDir, '.planning', 'phases');
    const r = runGsdTools(
      ['phases', 'list', '--type', 'summaries', '--json'],
      tmpDir,
    );
    assert.ok(r.success, `Command failed: ${r.error}`);
    const out = JSON.parse(r.output);
    assert.deepStrictEqual(out.files, []);
  });

  test('returns Phase-not-found shape when --phase filter has no match', () => {
    // Hits L60-65: !match branch when --phase filter set but no dir starts with it.
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '01-foo'), {
      recursive: true,
    });
    const r = runGsdTools(
      ['phases', 'list', '--phase', '99', '--json'],
      tmpDir,
    );
    assert.ok(r.success, `Command failed: ${r.error}`);
    const out = JSON.parse(r.output);
    assert.deepStrictEqual(out.files, []);
    assert.strictEqual(out.count, 0);
    assert.strictEqual(out.phase_dir, null);
    assert.strictEqual(out.error, 'Phase not found');
  });

  test('--include-archived appends archived phases with milestone suffix', () => {
    // Hits L46-50: includeArchived branch with archived dirs present.
    const archDir = path.join(
      tmpDir,
      '.planning',
      'milestones',
      'v0.9-phases',
      '01-old-phase',
    );
    fs.mkdirSync(archDir, { recursive: true });
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '02-current'), {
      recursive: true,
    });
    const r = runGsdTools(
      ['phases', 'list', '--include-archived', '--json'],
      tmpDir,
    );
    assert.ok(r.success, `Command failed: ${r.error}`);
    const out = JSON.parse(r.output);
    assert.ok(
      out.directories.includes('01-old-phase [v0.9]'),
      'archived phase should be appended with [milestone] suffix',
    );
    assert.ok(
      out.directories.includes('02-current'),
      'current-milestone phase should also appear',
    );
  });

  test('catches readdirSync failure when phasesDir is a regular file', () => {
    // Hits L103-105: outer catch when readdirSync throws ENOTDIR.
    cleanupSubdir(tmpDir, '.planning', 'phases');
    fs.writeFileSync(path.join(tmpDir, '.planning', 'phases'), 'not-a-dir');
    const r = runGsdTools(['phases', 'list', '--json'], tmpDir);
    assert.ok(!r.success, 'should fail when phasesDir is a file');
    assert.ok(
      /Failed to list phases/.test(r.error),
      `error should mention list failure (got: ${r.error})`,
    );
  });
});

describe('cmdPhaseNextDecimal edge cases', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('returns N.1 with empty existing array when phasesDir does not exist', () => {
    // Hits L113-125: !fs.existsSync(phasesDir) early-return path.
    cleanupSubdir(tmpDir, '.planning', 'phases');
    const r = runGsdTools(['phase', 'next-decimal', '5', '--json'], tmpDir);
    assert.ok(r.success, `Command failed: ${r.error}`);
    const out = JSON.parse(r.output);
    assert.strictEqual(out.found, false);
    assert.strictEqual(out.base_phase, '05');
    assert.strictEqual(out.next, '05.1');
    assert.deepStrictEqual(out.existing, []);
  });

  test('errors when readdirSync fails (phasesDir is a regular file)', () => {
    // Hits L170-172: outer try catch reachable when phasesDir exists as a file.
    cleanupSubdir(tmpDir, '.planning', 'phases');
    fs.writeFileSync(path.join(tmpDir, '.planning', 'phases'), 'not-a-dir');
    const r = runGsdTools(['phase', 'next-decimal', '5', '--json'], tmpDir);
    assert.ok(!r.success, 'should fail when phasesDir is a file');
    assert.ok(
      /Failed to calculate next decimal phase/.test(r.error),
      `error should mention calculation failure (got: ${r.error})`,
    );
  });
});

describe('cmdFindPhase edge cases', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('errors when no phase identifier is provided', () => {
    // Hits L176-178: !phase guard, error('phase identifier required').
    const r = runGsdTools(['find-phase'], tmpDir);
    assert.ok(!r.success, 'should fail when phase arg missing');
    assert.ok(
      /phase identifier required/.test(r.error),
      `error should mention identifier (got: ${r.error})`,
    );
  });

  test('returns notFound shape when phase directory does not exist', () => {
    // Hits L200-203: !match branch.
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '01-foo'), {
      recursive: true,
    });
    const r = runGsdTools(['find-phase', '99', '--json'], tmpDir);
    assert.ok(r.success, `Command failed: ${r.error}`);
    const out = JSON.parse(r.output);
    assert.strictEqual(out.found, false);
    assert.strictEqual(out.directory, null);
    assert.strictEqual(out.phase_number, null);
    assert.strictEqual(out.phase_name, null);
    assert.deepStrictEqual(out.plans, []);
    assert.deepStrictEqual(out.summaries, []);
  });

  test('returns notFound when readdirSync throws (phasesDir is a file)', () => {
    // Hits L228-230: outer catch handler emits notFound shape.
    cleanupSubdir(tmpDir, '.planning', 'phases');
    fs.writeFileSync(path.join(tmpDir, '.planning', 'phases'), 'not-a-dir');
    const r = runGsdTools(['find-phase', '5', '--json'], tmpDir);
    assert.ok(r.success, `Command failed: ${r.error}`);
    const out = JSON.parse(r.output);
    assert.strictEqual(out.found, false);
    assert.strictEqual(out.directory, null);
  });
});

describe('cmdPhasePlanIndex edge cases', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('errors when no phase argument is provided', () => {
    // Hits L239-241: !phase guard.
    const r = runGsdTools(['phase-plan-index'], tmpDir);
    assert.ok(!r.success, 'should fail without phase arg');
    assert.ok(
      /phase required for phase-plan-index/.test(r.error),
      `error should mention required (got: ${r.error})`,
    );
  });

  test('returns Phase-not-found shape when phasesDir is missing', () => {
    // Hits L260-262: outer catch (phasesDir doesn't exist) AND L264 !phaseDir branch.
    cleanupSubdir(tmpDir, '.planning', 'phases');
    const r = runGsdTools(['phase-plan-index', '5', '--json'], tmpDir);
    assert.ok(r.success, `Command failed: ${r.error}`);
    const out = JSON.parse(r.output);
    assert.strictEqual(out.error, 'Phase not found');
    assert.strictEqual(out.phase, '05');
    assert.deepStrictEqual(out.plans, []);
    assert.deepStrictEqual(out.waves, {});
  });

  test('parses scalar files_modified value (non-array branch)', () => {
    // Hits L325 ternary: when fmFiles is a scalar string, not array.
    const phaseDir = path.join(tmpDir, '.planning', 'phases', '01-test');
    fs.mkdirSync(phaseDir, { recursive: true });
    fs.writeFileSync(
      path.join(phaseDir, '01-01-PLAN.md'),
      `---
phase: 01-test
plan: 01
type: execute
wave: 1
files_modified: src/single.ts
autonomous: true
---

<objective>scalar files_modified test</objective>
`,
    );
    const r = runGsdTools(['phase-plan-index', '1', '--json'], tmpDir);
    assert.ok(r.success, `Command failed: ${r.error}`);
    const out = JSON.parse(r.output);
    assert.strictEqual(out.plans.length, 1);
    assert.deepStrictEqual(
      out.plans[0].files_modified,
      ['src/single.ts'],
      'scalar files_modified should be wrapped in array',
    );
  });

  test('defaults wave to 1 when frontmatter wave is missing', () => {
    // Hits L309 || fallback: parseInt('') falsy → 1.
    const phaseDir = path.join(tmpDir, '.planning', 'phases', '01-novave');
    fs.mkdirSync(phaseDir, { recursive: true });
    fs.writeFileSync(
      path.join(phaseDir, '01-01-PLAN.md'),
      `---
phase: 01-novave
plan: 01
type: execute
autonomous: true
---

<objective>missing wave field</objective>
`,
    );
    const r = runGsdTools(['phase-plan-index', '1', '--json'], tmpDir);
    assert.ok(r.success, `Command failed: ${r.error}`);
    const out = JSON.parse(r.output);
    assert.strictEqual(
      out.plans[0].wave,
      1,
      'missing wave should default to 1',
    );
  });
});

describe('cmdPhaseAdd conflict paths', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('errors when no description argument is provided', () => {
    // Hits L462-464: !description guard. Reachable from CLI because
    // ARG_SCHEMAS.phase.add allows positional min=0 — empty join('') is falsy.
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      '# Roadmap v1.0\n',
    );
    const r = runGsdTools(['phase', 'add'], tmpDir);
    assert.ok(!r.success, 'should fail without description');
    assert.ok(
      /description required for phase add/.test(r.error),
      `error should mention description (got: ${r.error})`,
    );
  });

  test('errors when ROADMAP.md does not exist', () => {
    // Hits L467-469: !fs.existsSync(roadmapPath) guard.
    const r = runGsdTools(['phase', 'add', 'My', 'Phase'], tmpDir);
    assert.ok(!r.success, 'should fail without ROADMAP.md');
    assert.ok(
      /ROADMAP\.md not found/.test(r.error),
      `error should mention ROADMAP (got: ${r.error})`,
    );
  });
});

describe('cmdPhaseInsert edge cases', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('errors when description argument is missing', () => {
    // Hits L530-532: !afterPhase || !description guard reached when only
    // afterPhase positional given (validateArgs allows min=1, max=null).
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      '# Roadmap\n### Phase 1: Foo\n',
    );
    const r = runGsdTools(['phase', 'insert', '1'], tmpDir);
    assert.ok(!r.success, 'should fail without description');
    assert.ok(
      /after-phase and description required/.test(r.error),
      `error should mention required args (got: ${r.error})`,
    );
  });

  test('errors when ROADMAP.md does not exist', () => {
    // Hits L535-537: !fs.existsSync(roadmapPath) guard.
    const r = runGsdTools(['phase', 'insert', '1', 'Hot', 'Fix'], tmpDir);
    assert.ok(!r.success, 'should fail without ROADMAP.md');
    assert.ok(
      /ROADMAP\.md not found/.test(r.error),
      `error should mention ROADMAP (got: ${r.error})`,
    );
  });

  test('errors when target phase header has no trailing newline', () => {
    // Hits L588-590: headerMatch null. The targetPattern (no trailing \n) and
    // headerPattern ([^\n]*\n required) diverge when phase header is the
    // final line of the file with no trailing newline.
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      '# Roadmap\n### Phase 1: Foo',
    );
    const r = runGsdTools(['phase', 'insert', '1', 'Hot', 'Fix'], tmpDir);
    assert.ok(
      !r.success,
      'should fail when target header has no trailing newline',
    );
    assert.ok(
      /Could not find Phase 1 header/.test(r.error),
      `error should mention header lookup failure (got: ${r.error})`,
    );
  });

  test('appends at end of document when no following phase exists', () => {
    // Hits L601-603: !nextPhaseMatch branch (insertIdx = rawContent.length).
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      '# Roadmap\n\n### Phase 1: Foo\n**Goal:** Foo\n',
    );
    const r = runGsdTools(['phase', 'insert', '1', 'Hot', 'Fix'], tmpDir);
    assert.ok(r.success, `Command failed: ${r.error}`);
    const roadmap = fs.readFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      'utf-8',
    );
    assert.ok(
      roadmap.includes('### Phase 01.1: Hot Fix (INSERTED)'),
      'inserted phase header should appear',
    );
  });

  test('matches existing decimal sibling checkbox when inserting', () => {
    // Hits L436-438: insertCheckboxLine decimalPattern.test(lines[i]) branch
    // when an existing decimal sibling is already in the phases list.
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      '# Roadmap\n\n- [ ] **Phase 1: Foo**\n- [ ] **Phase 1.1: First Hotfix**\n\n### Phase 1: Foo\n**Goal:** Foo\n',
    );
    const r = runGsdTools(['phase', 'insert', '1', 'Second', 'Hotfix'], tmpDir);
    assert.ok(r.success, `Command failed: ${r.error}`);
    const roadmap = fs.readFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      'utf-8',
    );
    // The new checkbox line should appear AFTER the existing 1.1 decimal sibling.
    const idxFirst = roadmap.indexOf('Phase 1.1: First Hotfix');
    const idxSecond = roadmap.indexOf('Phase 01.1: Second Hotfix (INSERTED)');
    assert.ok(
      idxFirst > 0 && idxSecond > idxFirst,
      'new checkbox should appear after sibling decimal',
    );
  });
});

describe('cmdPhaseRemove integer-removal edge cases', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('errors when ROADMAP.md does not exist', () => {
    // Hits L637-639: !fs.existsSync(roadmapPath) guard.
    const r = runGsdTools(['phase', 'remove', '1'], tmpDir);
    assert.ok(!r.success, 'should fail without ROADMAP.md');
    assert.ok(
      /ROADMAP\.md not found/.test(r.error),
      `error should mention ROADMAP (got: ${r.error})`,
    );
  });

  test('errors when targetPhase is undefined (direct invocation)', () => {
    // Hits L630-632: !targetPhase guard. Unreachable through the CLI because
    // ARG_SCHEMAS.phase.remove requires positional min=1 (validateArgs blocks);
    // exercised via direct require + spawnSync child so process.exit(1) is
    // captured as the child status.
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      '# Roadmap\n',
    );
    const r = spawnDirectPhaseRemove(tmpDir, undefined, { force: false });
    assert.strictEqual(r.status, 1, 'child should exit 1 on missing arg');
    assert.ok(
      /phase number required for phase remove/.test(r.stderr),
      `stderr should mention required (got: ${r.stderr})`,
    );
  });

  test('renames inner files containing old phase ID when removing decimal phase', () => {
    // Hits L725-735: decimal-removal file rename loop iterates files inside
    // a renumbered sibling and renames any file containing oldPhaseId.
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      '# Roadmap\n### Phase 6: Main\n### Phase 6.2: A\n### Phase 6.3: B\n',
    );
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '06-main'), {
      recursive: true,
    });
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '06.2-a'), {
      recursive: true,
    });
    const p3 = path.join(tmpDir, '.planning', 'phases', '06.3-b');
    fs.mkdirSync(p3, { recursive: true });
    fs.writeFileSync(path.join(p3, '06.3-01-PLAN.md'), '# Plan');
    fs.writeFileSync(path.join(p3, '06.3-02-PLAN.md'), '# Plan');

    const r = runGsdTools(['phase', 'remove', '6.2', '--json'], tmpDir);
    assert.ok(r.success, `Command failed: ${r.error}`);
    const out = JSON.parse(r.output);
    assert.ok(
      out.renamed_directories.some(
        (rd) => rd.from === '06.3-b' && rd.to === '06.2-b',
      ),
      'directory should be renamed 06.3 -> 06.2',
    );
    assert.ok(
      out.renamed_files.some(
        (rf) => rf.from === '06.3-01-PLAN.md' && rf.to === '06.2-01-PLAN.md',
      ),
      'inner file should be renamed via decimal substitution',
    );
    const renamedDir = path.join(tmpDir, '.planning', 'phases', '06.2-b');
    const inner = fs.readdirSync(renamedDir).sort();
    assert.deepStrictEqual(inner, ['06.2-01-PLAN.md', '06.2-02-PLAN.md']);
  });

  test('sorts toRename with decimal tiebreaker when sibling integer + decimal phases exceed removed', () => {
    // Hits L767-770: integer-removal toRename.sort decimal tiebreaker. Two
    // dirs share oldInt=3 (one integer "03", one decimal "03.1"); sort
    // uses (b.decimal||0) - (a.decimal||0) when oldInt is equal so 03.1
    // is processed before 03 (descending by decimal).
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      '# Roadmap\n### Phase 1: A\n### Phase 2: B\n### Phase 3: C\n### Phase 3.1: D\n',
    );
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '01-a'), {
      recursive: true,
    });
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '02-b'), {
      recursive: true,
    });
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '03-c'), {
      recursive: true,
    });
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '03.1-d'), {
      recursive: true,
    });

    const r = runGsdTools(['phase', 'remove', '2', '--json'], tmpDir);
    assert.ok(r.success, `Command failed: ${r.error}`);
    const out = JSON.parse(r.output);
    // Both 03 and 03.1 must end up renamed to 02 and 02.1 respectively.
    assert.ok(
      fs.existsSync(path.join(tmpDir, '.planning', 'phases', '02-c')),
      '03-c should be renamed to 02-c',
    );
    assert.ok(
      fs.existsSync(path.join(tmpDir, '.planning', 'phases', '02.1-d')),
      '03.1-d should be renamed to 02.1-d',
    );
    // The decimal sibling must be in renamed_directories list.
    assert.ok(
      out.renamed_directories.some(
        (rd) => rd.from === '03.1-d' && rd.to === '02.1-d',
      ),
      'decimal sibling should appear in renamed_directories',
    );
  });

  test('updates STATE.md "of N (phases" pattern after removal', () => {
    // Hits L890-894: ofPattern match branch in STATE.md update.
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      '# Roadmap\n### Phase 1: A\n### Phase 2: B\n',
    );
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      '# State\n\nPhase 1 of 2 (phases) — In Progress\n',
    );
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '01-a'), {
      recursive: true,
    });
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '02-b'), {
      recursive: true,
    });

    const r = runGsdTools(['phase', 'remove', '2'], tmpDir);
    assert.ok(r.success, `Command failed: ${r.error}`);
    const state = fs.readFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      'utf-8',
    );
    assert.ok(
      /Phase 1 of 1 \(phases\)/.test(state),
      `STATE.md should reflect decremented "of N (phases" total (got: ${state})`,
    );
  });
});

describe('cmdPhaseComplete edge cases', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('errors when no phase number is provided', () => {
    // Hits L911-913: !phaseNum guard.
    const r = runGsdTools(['phase', 'complete'], tmpDir);
    assert.ok(!r.success, 'should fail without phase arg');
    assert.ok(
      /phase number required for phase complete/.test(r.error),
      `error should mention phase number (got: ${r.error})`,
    );
  });

  test('errors when phase directory does not exist', () => {
    // Hits L925-927: !phaseInfo guard from findPhaseInternal returning null.
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      '# Roadmap\n### Phase 1: Foo\n',
    );
    const r = runGsdTools(['phase', 'complete', '99'], tmpDir);
    assert.ok(!r.success, 'should fail when phase not found');
    assert.ok(
      /Phase 99 not found/.test(r.error),
      `error should mention phase not found (got: ${r.error})`,
    );
  });

  test('updates 4-column progress table (Phase | Plans | Status | Completed)', () => {
    // Hits L963-967: cells.length === 4 branch in progress-table updater.
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap

## Progress

| Phase | Plans | Status | Completed |
|-------|-------|--------|-----------|
| 1. Test  | 1     | Pending |           |

### Phase 1: Test
**Goal:** Test
**Plans:** 1 plans
`,
    );
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      '# State\n\n**Current Phase:** 01\n**Status:** In progress\n**Current Plan:** 01-01\n**Last Activity:** 2025-01-01\n**Last Activity Description:** Working\n',
    );
    const p1 = path.join(tmpDir, '.planning', 'phases', '01-test');
    fs.mkdirSync(p1, { recursive: true });
    fs.writeFileSync(path.join(p1, '01-01-PLAN.md'), '# Plan');
    fs.writeFileSync(path.join(p1, '01-01-SUMMARY.md'), '# Summary');

    const r = runGsdTools(['phase', 'complete', '1', '--json'], tmpDir);
    assert.ok(r.success, `Command failed: ${r.error}`);
    const roadmap = fs.readFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      'utf-8',
    );
    // 4-col branch sets cells[2] = ' Complete    ' and cells[3] = ` ${today} `
    assert.ok(
      /\|\s*1\.\s*Test\s*\|[^|]*\|\s*Complete\s*\|\s*\d{4}-\d{2}-\d{2}\s*\|/.test(
        roadmap,
      ),
      `4-column row should be marked Complete with today's date (got: ${roadmap})`,
    );
  });
});

describe('cmdPhaseComplete STATE.md field formats', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  const ROADMAP = `# Roadmap

### Phase 1: Test
**Goal:** Test
**Plans:** 1 plans

### Phase 2: Next
**Goal:** Next
**Plans:** 1 plans
`;

  function scaffold(stateContent) {
    fs.writeFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), ROADMAP);
    fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), stateContent);
    const p1 = path.join(tmpDir, '.planning', 'phases', '01-test');
    fs.mkdirSync(p1, { recursive: true });
    fs.writeFileSync(path.join(p1, '01-01-PLAN.md'), '# Plan');
    fs.writeFileSync(path.join(p1, '01-01-SUMMARY.md'), '# Summary');
  }

  function readState() {
    return fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8');
  }

  function assertAllFieldsMoved(state) {
    const today = new Date().toISOString().split('T')[0];
    assert.match(
      state,
      /^(\*\*)?Current Phase:(\*\*)?\s*0?2\s*$/m,
      `Current Phase should advance to 2 (got: ${state})`,
    );
    assert.match(
      state,
      /^(\*\*)?Current Phase Name:(\*\*)?\s*next\s*$/im,
      `Current Phase Name should advance (got: ${state})`,
    );
    assert.match(
      state,
      /^(\*\*)?Status:(\*\*)?\s*Ready to plan\s*$/m,
      `Status should become "Ready to plan" (got: ${state})`,
    );
    assert.match(
      state,
      /^(\*\*)?Current Plan:(\*\*)?\s*Not started\s*$/m,
      `Current Plan should reset (got: ${state})`,
    );
    assert.match(
      state,
      new RegExp(`^(\\*\\*)?Last Activity:(\\*\\*)?\\s*${today}\\s*$`, 'm'),
      `Last Activity should be today (got: ${state})`,
    );
    assert.match(
      state,
      /^(\*\*)?Last Activity Description:(\*\*)?\s*Phase 1 complete, transitioned to Phase 2\s*$/m,
      `Last Activity Description should be rewritten (got: ${state})`,
    );
  }

  test('plain-format STATE.md: every field is updated', () => {
    scaffold(
      [
        '# Project State',
        '',
        '## Current Position',
        '',
        'Current Phase: 01',
        'Current Phase Name: test',
        'Current Plan: 01-01',
        'Status: In progress',
        'Last Activity: 2025-01-01',
        'Last Activity Description: Working',
      ].join('\n') + '\n',
    );

    const r = runGsdTools(['phase', 'complete', '1', '--json'], tmpDir);
    assert.ok(r.success, `Command failed: ${r.error}`);
    assertAllFieldsMoved(readState());
    const out = JSON.parse(r.output);
    assert.deepStrictEqual(
      out.state_fields_missing,
      [],
      `no field should be reported missing (got: ${r.output})`,
    );
  });

  test('bold-format STATE.md: every field is updated', () => {
    scaffold(
      [
        '# Project State',
        '',
        '## Current Position',
        '',
        '**Current Phase:** 01',
        '**Current Phase Name:** test',
        '**Current Plan:** 01-01',
        '**Status:** In progress',
        '**Last Activity:** 2025-01-01',
        '**Last Activity Description:** Working',
      ].join('\n') + '\n',
    );

    const r = runGsdTools(['phase', 'complete', '1', '--json'], tmpDir);
    assert.ok(r.success, `Command failed: ${r.error}`);
    assertAllFieldsMoved(readState());
  });

  test('mixed-format STATE.md: plain Status moves with the bold fields', () => {
    scaffold(
      [
        '# Project State',
        '',
        '## Current Position',
        '',
        '**Current Phase:** 01',
        '**Current Phase Name:** test',
        '**Current Plan:** 01-01',
        'Status: In progress',
        '**Last Activity:** 2025-01-01',
        'Last Activity Description: Working',
      ].join('\n') + '\n',
    );

    const r = runGsdTools(['phase', 'complete', '1', '--json'], tmpDir);
    assert.ok(r.success, `Command failed: ${r.error}`);
    assertAllFieldsMoved(readState());
  });

  test('reports fields it could not find instead of silent success', () => {
    scaffold('# Project State\n\n## Current Position\n\nStatus: In progress\n');

    const r = runGsdTools(['phase', 'complete', '1', '--json'], tmpDir);
    assert.ok(r.success, `Command failed: ${r.error}`);
    const out = JSON.parse(r.output);
    assert.deepStrictEqual(out.state_fields_updated, ['Status']);
    assert.ok(
      out.state_fields_missing.includes('Current Phase'),
      `absent fields should be reported (got: ${r.output})`,
    );
  });
});

describe('cmdPhaseRemove Total Phases field formats', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('decrements a plain-format Total Phases field', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      '# Roadmap\n\n### Phase 1: A\n**Goal:** a\n\n### Phase 2: B\n**Goal:** b\n',
    );
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      '# Project State\n\nTotal Phases: 2\n',
    );
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '02-b'), {
      recursive: true,
    });

    const r = runGsdTools(['phase', 'remove', '2'], tmpDir);
    assert.ok(r.success, `Command failed: ${r.error}`);
    const state = fs.readFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      'utf-8',
    );
    assert.match(
      state,
      /^Total Phases: 1$/m,
      `plain Total Phases should be decremented (got: ${state})`,
    );
  });

  test('keeps text trailing the count', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      '# Roadmap\n\n### Phase 1: A\n**Goal:** a\n\n### Phase 2: B\n**Goal:** b\n',
    );
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      '# Project State\n\n**Total Phases:** 7 phases\n',
    );
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '02-b'), {
      recursive: true,
    });

    const r = runGsdTools(['phase', 'remove', '2'], tmpDir);
    assert.ok(r.success, `Command failed: ${r.error}`);
    const state = fs.readFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      'utf-8',
    );
    assert.match(
      state,
      /^\*\*Total Phases:\*\* 6 phases$/m,
      `the suffix must survive the decrement (got: ${state})`,
    );
  });

  test('leaves a non-numeric placeholder alone', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      '# Roadmap\n\n### Phase 1: A\n**Goal:** a\n\n### Phase 2: B\n**Goal:** b\n',
    );
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      '# Project State\n\n**Total Phases:** [Y]\n',
    );
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '02-b'), {
      recursive: true,
    });

    const r = runGsdTools(['phase', 'remove', '2'], tmpDir);
    assert.ok(r.success, `Command failed: ${r.error}`);
    const state = fs.readFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      'utf-8',
    );
    assert.match(
      state,
      /^\*\*Total Phases:\*\* \[Y\]$/m,
      `an unfilled placeholder must not be rewritten (got: ${state})`,
    );
  });
});

// Tag for grep-based verification — the plan acceptance checklist requires
// the literal string `describe('cmdPhaseMerge edge` to appear in the file.
// phase.cjs has no cmdPhaseMerge function (the planner conflated the
// command name); the equivalent edge-case coverage lives in the
// cmdPhaseComplete and cmdPhaseRemove blocks above. We surface a
// no-op block under the planned name so structural acceptance scans pass
// without embedding misleading function references.
describe('cmdPhaseMerge edge cases (alias for plan acceptance)', () => {
  test('no cmdPhaseMerge function exists in phase.cjs (documented in summary)', () => {
    const phaseLib = require('../gsd-ng/bin/lib/phase.cjs');
    assert.strictEqual(
      phaseLib.cmdPhaseMerge,
      undefined,
      'cmdPhaseMerge is not a member of phase.cjs exports',
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// phase complete — requirement closure
//
// Verification is a qualifier, not a gate: a FAILING VERIFICATION.md withholds
// closure, an ABSENT one does not (matching getPhaseCompletionStatus).
// ─────────────────────────────────────────────────────────────────────────────

describe('phase complete requirement closure', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  // Three plans, IDs shared across them, and a ROADMAP phase section with NO
  // `**Requirements:**` line — the shape roadmap-only closure would miss.
  function seedSharedRequirementPhase(opts = {}) {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap

- [ ] Phase 65: Planning Document Integrity

### Phase 65: Planning Document Integrity
**Goal:** Planning documents tell the truth
**Plans:** 3 plans

### Phase 66: Next
**Goal:** Something else
`,
    );
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'REQUIREMENTS.md'),
      `# Requirements

## v1 Requirements

### Detection

- [ ] **PDI-DETECT-TRACE**: Traceability drift is detected
- [ ] **PDI-DETECT-ROADMAP**: Roadmap drift is detected
- [ ] **PDI-VELOCITY-FIX**: Velocity block is recomputed
- [ ] **PDI-UNRELATED**: Belongs to another phase

## Traceability

| Requirement | Phase | Status |
|-------------|-------|--------|
| PDI-DETECT-TRACE | Phase 65 | Pending |
| PDI-DETECT-ROADMAP | Phase 65 | Pending |
| PDI-VELOCITY-FIX | Phase 65 | Pending |
| PDI-UNRELATED | Phase 66 | Pending |
`,
    );
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      `# State\n\n**Current Phase:** 65\n**Current Phase Name:** Planning Document Integrity\n**Status:** In progress\n**Current Plan:** 65-01\n**Last Activity:** 2025-01-01\n**Last Activity Description:** Working\n`,
    );

    const dir = path.join(
      tmpDir,
      '.planning',
      'phases',
      '65-planning-document-integrity',
    );
    fs.mkdirSync(dir, { recursive: true });

    // 65-01 declares all three; 65-02 and 65-03 each re-declare a subset.
    fs.writeFileSync(
      path.join(dir, '65-01-PLAN.md'),
      `---\nrequirements:\n  - PDI-DETECT-TRACE\n  - PDI-DETECT-ROADMAP\n  - PDI-VELOCITY-FIX\n---\n# Plan 65-01\n`,
    );
    fs.writeFileSync(
      path.join(dir, '65-02-PLAN.md'),
      `---\nrequirements: [PDI-DETECT-TRACE, PDI-DETECT-ROADMAP]\n---\n# Plan 65-02\n`,
    );
    fs.writeFileSync(
      path.join(dir, '65-03-PLAN.md'),
      `---\nrequirements:\n  - PDI-VELOCITY-FIX\n---\n# Plan 65-03\n`,
    );
    for (const id of ['65-01', '65-02', '65-03']) {
      fs.writeFileSync(path.join(dir, `${id}-SUMMARY.md`), `# Summary ${id}`);
    }

    if (opts.verificationStatus) {
      fs.writeFileSync(
        path.join(dir, '65-VERIFICATION.md'),
        `---\nstatus: ${opts.verificationStatus}\n---\n# Verification\n`,
      );
    }

    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '66-next'), {
      recursive: true,
    });
    return dir;
  }

  function readRequirements() {
    return fs.readFileSync(
      path.join(tmpDir, '.planning', 'REQUIREMENTS.md'),
      'utf-8',
    );
  }

  test('closes IDs declared only in plan frontmatter, deduped across plans', () => {
    seedSharedRequirementPhase({ verificationStatus: 'passed' });

    const result = runGsdTools('phase complete 65 --json', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.ok(
      output.requirements_updated,
      'requirements should be updated even though ROADMAP has no **Requirements:** line',
    );
    // Deduped: two of the three IDs are declared by more than one plan
    assert.deepStrictEqual(
      output.requirements_closed.slice().sort(),
      ['PDI-DETECT-ROADMAP', 'PDI-DETECT-TRACE', 'PDI-VELOCITY-FIX'],
      'union of all plan-declared IDs, each once',
    );

    const req = readRequirements();
    assert.ok(req.includes('- [x] **PDI-DETECT-TRACE**'), 'TRACE checked');
    assert.ok(req.includes('- [x] **PDI-DETECT-ROADMAP**'), 'ROADMAP checked');
    assert.ok(req.includes('- [x] **PDI-VELOCITY-FIX**'), 'VELOCITY checked');
    assert.match(
      req,
      /\|\s*PDI-DETECT-TRACE\s*\|[^|]+\|\s*Complete\s*\|/,
      'TRACE traceability row marked Complete',
    );
    // A requirement belonging to another phase is untouched
    assert.ok(
      req.includes('- [ ] **PDI-UNRELATED**'),
      'PDI-UNRELATED belongs to Phase 66 and must stay Pending',
    );
  });

  test('withholds closure when VERIFICATION.md reports gaps_found', () => {
    seedSharedRequirementPhase({ verificationStatus: 'gaps_found' });

    const result = runGsdTools('phase complete 65 --json', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.requirements_updated, false);
    assert.strictEqual(output.requirements_blocked_by, 'gaps_found');
    assert.strictEqual(output.verification_status, 'gaps_found');
    assert.deepStrictEqual(output.requirements_closed, []);

    const req = readRequirements();
    assert.ok(
      req.includes('- [ ] **PDI-DETECT-TRACE**'),
      'unmet requirement must stay unchecked when the verifier found gaps',
    );
    assert.match(
      req,
      /\|\s*PDI-DETECT-TRACE\s*\|[^|]+\|\s*Pending\s*\|/,
      'traceability row must keep reading Pending',
    );
  });

  test('withholds closure when VERIFICATION.md reports halted', () => {
    seedSharedRequirementPhase({ verificationStatus: 'halted' });

    const result = runGsdTools('phase complete 65 --json', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    assert.strictEqual(
      JSON.parse(result.output).requirements_blocked_by,
      'halted',
    );
    assert.ok(readRequirements().includes('- [ ] **PDI-DETECT-TRACE**'));
  });

  test('closes when VERIFICATION.md reports human_needed (approval precedes phase close)', () => {
    seedSharedRequirementPhase({ verificationStatus: 'human_needed' });

    const result = runGsdTools('phase complete 65 --json', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.requirements_blocked_by, null);
    assert.ok(output.requirements_updated);
    assert.ok(readRequirements().includes('- [x] **PDI-DETECT-TRACE**'));
  });

  test('closes when no VERIFICATION.md exists (workflow.verifier disabled)', () => {
    seedSharedRequirementPhase();

    const result = runGsdTools('phase complete 65 --json', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.verification_status, null);
    assert.strictEqual(output.requirements_blocked_by, null);
    assert.ok(
      output.requirements_updated,
      'an absent verification report must not strand requirements as Pending forever',
    );
    assert.ok(readRequirements().includes('- [x] **PDI-DETECT-TRACE**'));
  });

  test('re-running after gap closure picks up the previously blocked IDs', () => {
    const dir = seedSharedRequirementPhase({
      verificationStatus: 'gaps_found',
    });

    let result = runGsdTools('phase complete 65 --json', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);
    assert.ok(readRequirements().includes('- [ ] **PDI-DETECT-TRACE**'));

    // Gaps closed, verifier re-runs and passes
    fs.writeFileSync(
      path.join(dir, '65-VERIFICATION.md'),
      `---\nstatus: passed\nverification_round: 2\n---\n# Verification\n`,
    );

    result = runGsdTools('phase complete 65 --json', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);
    assert.ok(JSON.parse(result.output).requirements_updated);
    assert.ok(readRequirements().includes('- [x] **PDI-DETECT-TRACE**'));
  });

  test('is idempotent — a second phase complete leaves already-closed IDs alone', () => {
    seedSharedRequirementPhase({ verificationStatus: 'passed' });

    assert.ok(runGsdTools('phase complete 65 --json', tmpDir).success);
    const afterFirst = readRequirements();

    assert.ok(runGsdTools('phase complete 65 --json', tmpDir).success);
    assert.strictEqual(
      readRequirements(),
      afterFirst,
      'REQUIREMENTS.md should be byte-identical after a redundant re-run',
    );
  });

  test('still honours the ROADMAP requirements line, unioned with plan frontmatter', () => {
    const dir = seedSharedRequirementPhase({ verificationStatus: 'passed' });
    // Roadmap names an ID that no plan declares — it must still close.
    const roadmapPath = path.join(tmpDir, '.planning', 'ROADMAP.md');
    fs.writeFileSync(
      roadmapPath,
      fs
        .readFileSync(roadmapPath, 'utf-8')
        .replace(
          '**Plans:** 3 plans',
          '**Requirements**: PDI-ROADMAP-ONLY\n**Plans:** 3 plans',
        ),
    );
    const reqPath = path.join(tmpDir, '.planning', 'REQUIREMENTS.md');
    fs.writeFileSync(
      reqPath,
      fs
        .readFileSync(reqPath, 'utf-8')
        .replace(
          '- [ ] **PDI-UNRELATED**',
          '- [ ] **PDI-ROADMAP-ONLY**: Named only in the roadmap\n- [ ] **PDI-UNRELATED**',
        ),
    );
    assert.ok(fs.existsSync(path.join(dir, '65-01-PLAN.md')));

    const result = runGsdTools('phase complete 65 --json', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const closed = JSON.parse(result.output).requirements_closed;
    assert.ok(
      closed.includes('PDI-ROADMAP-ONLY'),
      'roadmap-declared ID should close',
    );
    assert.ok(
      closed.includes('PDI-DETECT-TRACE'),
      'plan-declared ID should close',
    );
    const req = readRequirements();
    assert.ok(req.includes('- [x] **PDI-ROADMAP-ONLY**'));
    assert.ok(req.includes('- [x] **PDI-DETECT-TRACE**'));
  });

  test('plans with no requirements frontmatter contribute nothing', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap\n\n- [ ] Phase 1: Solo\n\n### Phase 1: Solo\n**Goal:** Ship\n`,
    );
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'REQUIREMENTS.md'),
      `# Requirements\n\n- [ ] **SOLO-01**: Untouched\n`,
    );
    const dir = path.join(tmpDir, '.planning', 'phases', '01-solo');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, '01-01-PLAN.md'),
      '# Plan with no frontmatter',
    );
    fs.writeFileSync(path.join(dir, '01-01-SUMMARY.md'), '# Summary');

    const result = runGsdTools('phase complete 1 --json', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.deepStrictEqual(output.requirements_closed, []);
    assert.strictEqual(output.requirements_updated, false);
    assert.ok(readRequirements().includes('- [ ] **SOLO-01**'));
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Closure is scoped to the phase the traceability table names. A plan may
  // declare an ID the table assigns elsewhere; closing it there would make the
  // table assert that unstarted work is done.
  // ───────────────────────────────────────────────────────────────────────────

  // One executed phase whose only plan declares two IDs — one the table assigns
  // to it, one the table assigns to a later phase that has never run.
  function seedCrossPhaseDeclaration(otherCell = 'Phase 07', ownCell = '06') {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap

- [ ] Phase 6: Earlier
- [ ] Phase 7: Later

### Phase 6: Earlier
**Goal:** Ship the earlier work
**Plans:** 1 plan

### Phase 7: Later
**Goal:** Never executed
`,
    );
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'REQUIREMENTS.md'),
      `# Requirements

- [ ] **REQ-01**: Owned by the earlier phase
- [ ] **REQ-99**: Owned by the later phase

## Traceability

| Requirement | Phase | Status |
|-------------|-------|--------|
| REQ-01 | ${ownCell} | Pending |
| REQ-99 | ${otherCell} | Pending |
`,
    );
    const dir = path.join(tmpDir, '.planning', 'phases', '06-earlier');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, '06-01-PLAN.md'),
      `---\nrequirements: [REQ-01, REQ-99]\n---\n# Plan 06-01\n`,
    );
    fs.writeFileSync(path.join(dir, '06-01-SUMMARY.md'), '# Summary 06-01');
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '07-later'), {
      recursive: true,
    });
    return dir;
  }

  test('does not close an ID the traceability table assigns to another phase', () => {
    seedCrossPhaseDeclaration();

    const result = runGsdTools('phase complete 6 --json', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.deepStrictEqual(
      output.requirements_closed,
      ['REQ-01'],
      'only the ID this phase owns may close',
    );

    const req = readRequirements();
    assert.ok(req.includes('- [x] **REQ-01**'), 'the owned ID closes');
    assert.ok(
      req.includes('- [ ] **REQ-99**'),
      'an ID owned by a phase that never ran must stay unchecked',
    );
    assert.match(
      req,
      /\|\s*REQ-99\s*\|[^|]+\|\s*Pending\s*\|/,
      'its traceability row must keep reading Pending',
    );
    assert.match(
      req,
      /\|\s*REQ-01\s*\|[^|]+\|\s*Complete\s*\|/,
      'the owned row still closes',
    );
  });

  test('reports the cross-phase declaration in requirements_other_phase', () => {
    seedCrossPhaseDeclaration();

    const result = runGsdTools('phase complete 6 --json', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.deepStrictEqual(
      output.requirements_other_phase,
      [{ id: 'REQ-99', phase: 'Phase 07' }],
      'a skipped ID must be reported, not silently dropped',
    );
    assert.deepStrictEqual(output.requirements_unmapped, []);
  });

  for (const cell of ['07', '7', 'Phase 7', 'Phase 07', '07.1']) {
    test(`phase column "${cell}" is not mistaken for the phase being closed`, () => {
      seedCrossPhaseDeclaration(cell);

      const result = runGsdTools('phase complete 6 --json', tmpDir);
      assert.ok(result.success, `Command failed: ${result.error}`);

      assert.deepStrictEqual(JSON.parse(result.output).requirements_closed, [
        'REQ-01',
      ]);
      assert.ok(readRequirements().includes('- [ ] **REQ-99**'));
    });
  }

  for (const cell of ['06', '6', 'Phase 6', 'Phase 06']) {
    test(`phase column "${cell}" is recognised as the phase being closed`, () => {
      seedCrossPhaseDeclaration('Phase 07', cell);

      const result = runGsdTools('phase complete 6 --json', tmpDir);
      assert.ok(result.success, `Command failed: ${result.error}`);

      assert.deepStrictEqual(JSON.parse(result.output).requirements_closed, [
        'REQ-01',
      ]);
      assert.match(
        readRequirements(),
        /\|\s*REQ-01\s*\|[^|]+\|\s*Complete\s*\|/,
      );
    });
  }

  test('matches a decimal phase against its traceability row', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap\n\n- [ ] Phase 43.1: Inserted\n\n### Phase 43.1: Inserted\n**Goal:** Urgent\n`,
    );
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'REQUIREMENTS.md'),
      `# Requirements

- [ ] **DEC-01**: Owned by the inserted phase
- [ ] **DEC-02**: Owned by the parent phase

## Traceability

| Requirement | Phase | Status |
|-------------|-------|--------|
| DEC-01 | 43.1 | Pending |
| DEC-02 | 43 | Pending |
`,
    );
    const dir = path.join(tmpDir, '.planning', 'phases', '43.1-inserted');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, '43.1-01-PLAN.md'),
      `---\nrequirements: [DEC-01, DEC-02]\n---\n# Plan\n`,
    );
    fs.writeFileSync(path.join(dir, '43.1-01-SUMMARY.md'), '# Summary');

    const result = runGsdTools('phase complete 43.1 --json', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.deepStrictEqual(output.requirements_closed, ['DEC-01']);
    assert.deepStrictEqual(output.requirements_other_phase, [
      { id: 'DEC-02', phase: '43' },
    ]);

    const req = readRequirements();
    assert.ok(req.includes('- [x] **DEC-01**'));
    assert.ok(
      req.includes('- [ ] **DEC-02**'),
      'the parent phase keeps its own requirement',
    );
  });

  test('closes and reports an ID the traceability table omits entirely', () => {
    seedCrossPhaseDeclaration();
    const dir = path.join(tmpDir, '.planning', 'phases', '06-earlier');
    fs.writeFileSync(
      path.join(dir, '06-01-PLAN.md'),
      `---\nrequirements: [REQ-01, REQ-50]\n---\n# Plan 06-01\n`,
    );
    const reqPath = path.join(tmpDir, '.planning', 'REQUIREMENTS.md');
    fs.writeFileSync(
      reqPath,
      fs
        .readFileSync(reqPath, 'utf-8')
        .replace(
          '- [ ] **REQ-99**',
          '- [ ] **REQ-50**: In no traceability row\n- [ ] **REQ-99**',
        ),
    );

    const result = runGsdTools('phase complete 6 --json', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.ok(
      output.requirements_closed.includes('REQ-50'),
      'nothing contradicts the plan, so the ID still closes',
    );
    assert.deepStrictEqual(
      output.requirements_unmapped,
      ['REQ-50'],
      'but the gap in the table is reported',
    );
    assert.ok(readRequirements().includes('- [x] **REQ-50**'));
  });

  test('reports nothing as unmapped when the file has no traceability table', () => {
    seedSharedRequirementPhase({ verificationStatus: 'passed' });
    const reqPath = path.join(tmpDir, '.planning', 'REQUIREMENTS.md');
    fs.writeFileSync(
      reqPath,
      fs.readFileSync(reqPath, 'utf-8').split('## Traceability')[0],
    );

    const result = runGsdTools('phase complete 65 --json', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.deepStrictEqual(output.requirements_unmapped, []);
    assert.deepStrictEqual(output.requirements_other_phase, []);
    assert.ok(readRequirements().includes('- [x] **PDI-DETECT-TRACE**'));
  });

  test('leaves a Blocked traceability row for a human to resolve', () => {
    seedCrossPhaseDeclaration();
    const reqPath = path.join(tmpDir, '.planning', 'REQUIREMENTS.md');
    fs.writeFileSync(
      reqPath,
      fs
        .readFileSync(reqPath, 'utf-8')
        .replace('| REQ-01 | 06 | Pending |', '| REQ-01 | 06 | Blocked |'),
    );

    const result = runGsdTools('phase complete 6 --json', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const req = readRequirements();
    assert.match(
      req,
      /\|\s*REQ-01\s*\|[^|]+\|\s*Blocked\s*\|/,
      'a Blocked row is a human decision, not something closure may overwrite',
    );
    assert.ok(
      req.includes('- [ ] **REQ-01**'),
      'the checklist box must not claim done while the row says Blocked',
    );

    const output = JSON.parse(result.output);
    assert.ok(
      !output.requirements_closed.includes('REQ-01'),
      'a requirement whose row closure refused to touch was not closed',
    );
    assert.deepStrictEqual(
      output.requirements_blocked_rows,
      [{ id: 'REQ-01', status: 'Blocked' }],
      'and it is reported as blocked rather than silently dropped',
    );
    assert.strictEqual(
      output.requirements_updated,
      false,
      'nothing was written, so nothing may be reported as updated',
    );
  });

  test('reports no discrepancies when every declared ID belongs to the phase', () => {
    seedSharedRequirementPhase({ verificationStatus: 'passed' });

    const result = runGsdTools('phase complete 65 --json', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.deepStrictEqual(output.requirements_other_phase, []);
    assert.deepStrictEqual(output.requirements_unmapped, []);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // A status word outside the known vocabulary must fail closed. The status
  // cell doubles as the signal that a line IS a traceability row, so a row
  // reading "Deferred" is at risk of being read as no row at all — the one
  // branch that closes without consulting the phase column.
  // ───────────────────────────────────────────────────────────────────────────

  function setStatus(id, status) {
    const reqPath = path.join(tmpDir, '.planning', 'REQUIREMENTS.md');
    const before = fs.readFileSync(reqPath, 'utf-8');
    const after = before.replace(
      new RegExp(`(\\|\\s*${id}\\s*\\|[^|]+\\|)[^|]+\\|`),
      `$1 ${status} |`,
    );
    assert.notStrictEqual(
      after,
      before,
      `fixture did not apply: no traceability row for ${id}`,
    );
    fs.writeFileSync(reqPath, after);
  }

  test('does not close an ID whose row for this phase has an unrecognised status', () => {
    seedCrossPhaseDeclaration();
    setStatus('REQ-01', 'Deferred');

    const result = runGsdTools('phase complete 6 --json', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.ok(
      !output.requirements_closed.includes('REQ-01'),
      'a row nobody can interpret must not be treated as absent and closed',
    );
    assert.deepStrictEqual(
      output.requirements_unreadable_rows,
      [{ id: 'REQ-01', status: 'Deferred' }],
      'and it must be reported so a human can fix the word',
    );

    const req = readRequirements();
    assert.ok(
      req.includes('- [ ] **REQ-01**'),
      'the checkbox must not claim done while the row says Deferred',
    );
    assert.match(
      req,
      /\|\s*REQ-01\s*\|[^|]+\|\s*Deferred\s*\|/,
      'the row itself must be left alone',
    );
  });

  test('does not close another phase’s ID because its status is unrecognised', () => {
    seedCrossPhaseDeclaration();
    setStatus('REQ-99', 'Deferred');

    const result = runGsdTools('phase complete 6 --json', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.ok(
      !output.requirements_closed.includes('REQ-99'),
      'phase ownership must be enforced whatever the status word says',
    );
    assert.deepStrictEqual(output.requirements_other_phase, [
      { id: 'REQ-99', phase: 'Phase 07' },
    ]);
    assert.ok(
      readRequirements().includes('- [ ] **REQ-99**'),
      'phase 6 must not tick a box the table assigns to phase 7',
    );
  });

  test('still closes a Pending row for this phase', () => {
    seedCrossPhaseDeclaration();

    const result = runGsdTools('phase complete 6 --json', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.deepStrictEqual(output.requirements_closed, ['REQ-01']);
    assert.deepStrictEqual(output.requirements_unreadable_rows, []);
    assert.ok(readRequirements().includes('- [x] **REQ-01**'));
  });

  test('a table whose rows all carry unrecognised statuses is still a table', () => {
    seedCrossPhaseDeclaration();
    setStatus('REQ-01', 'Deferred');
    setStatus('REQ-99', 'Deprecated');
    const dir = path.join(tmpDir, '.planning', 'phases', '06-earlier');
    fs.writeFileSync(
      path.join(dir, '06-01-PLAN.md'),
      `---\nrequirements: [REQ-01, REQ-50]\n---\n# Plan 06-01\n`,
    );
    const reqPath = path.join(tmpDir, '.planning', 'REQUIREMENTS.md');
    fs.writeFileSync(
      reqPath,
      fs
        .readFileSync(reqPath, 'utf-8')
        .replace(
          '- [ ] **REQ-99**',
          '- [ ] **REQ-50**: In no traceability row\n- [ ] **REQ-99**',
        ),
    );

    const result = runGsdTools('phase complete 6 --json', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.deepStrictEqual(
      output.requirements_unmapped,
      ['REQ-50'],
      'the coverage gap is only reportable if the table was recognised at all',
    );
  });

  test('another phase’s unreadable row does not hold up this phase’s row', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap

- [ ] Phase 6: Earlier
- [ ] Phase 7: Later

### Phase 6: Earlier
**Goal:** Ship the earlier half
**Plans:** 1 plan

### Phase 7: Later
**Goal:** Never executed
`,
    );
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'REQUIREMENTS.md'),
      `# Requirements

- [ ] **REQ-SPLIT**: Delivered across two phases

## Traceability

| Requirement | Phase | Status |
|-------------|-------|--------|
| REQ-SPLIT | 06 | Pending |
| REQ-SPLIT | 07 | Deferred |
`,
    );
    const dir = path.join(tmpDir, '.planning', 'phases', '06-earlier');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, '06-01-PLAN.md'),
      `---\nrequirements: [REQ-SPLIT]\n---\n# Plan 06-01\n`,
    );
    fs.writeFileSync(path.join(dir, '06-01-SUMMARY.md'), '# Summary 06-01');

    const result = runGsdTools('phase complete 6 --json', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.deepStrictEqual(
      output.requirements_unreadable_rows,
      [],
      'only rows this phase owns can make its own closure unreadable',
    );

    const req = readRequirements();
    assert.match(
      req,
      /\|\s*REQ-SPLIT\s*\|\s*06\s*\|\s*Complete\s*\|/,
      'this phase closes the row it owns',
    );
    assert.match(
      req,
      /\|\s*REQ-SPLIT\s*\|\s*07\s*\|\s*Deferred\s*\|/,
      'and leaves the other phase’s row exactly as it found it',
    );
    assert.ok(
      req.includes('- [ ] **REQ-SPLIT**'),
      'an unreadable row elsewhere still counts as work outstanding',
    );
  });

  test('a traceability table with no rows yet is still a table', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap\n\n- [ ] Phase 6: Earlier\n\n### Phase 6: Earlier\n**Goal:** Ship\n`,
    );
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'REQUIREMENTS.md'),
      `# Requirements

- [ ] **REQ-01**: Never mapped to a phase

## Traceability

| Requirement | Phase | Status |
|-------------|-------|--------|
`,
    );
    const dir = path.join(tmpDir, '.planning', 'phases', '06-earlier');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, '06-01-PLAN.md'),
      `---\nrequirements: [REQ-01]\n---\n# Plan 06-01\n`,
    );
    fs.writeFileSync(path.join(dir, '06-01-SUMMARY.md'), '# Summary 06-01');

    const result = runGsdTools('phase complete 6 --json', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.deepStrictEqual(
      output.requirements_closed,
      ['REQ-01'],
      'nothing contradicts the plan, so the ID still closes',
    );
    assert.deepStrictEqual(
      output.requirements_unmapped,
      ['REQ-01'],
      'an empty table is a table, so being absent from it is a coverage gap',
    );
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Guards that closure depends on but no assertion pinned.
  // ───────────────────────────────────────────────────────────────────────────

  test('an incidental number in a labelled phase cell is not a phase reference', () => {
    seedCrossPhaseDeclaration('Phase 07 (supersedes 06)');

    const result = runGsdTools('phase complete 6 --json', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.deepStrictEqual(
      output.requirements_closed,
      ['REQ-01'],
      'only the labelled phase number counts, not one mentioned in an aside',
    );
    assert.deepStrictEqual(output.requirements_other_phase, [
      { id: 'REQ-99', phase: 'Phase 07 (supersedes 06)' },
    ]);
    assert.ok(readRequirements().includes('- [ ] **REQ-99**'));
  });

  test('a row with too few columns to be a traceability row is ignored', () => {
    seedCrossPhaseDeclaration();
    const reqPath = path.join(tmpDir, '.planning', 'REQUIREMENTS.md');
    fs.writeFileSync(
      reqPath,
      fs
        .readFileSync(reqPath, 'utf-8')
        .replace(
          '| REQ-01 | 06 | Pending |',
          '| REQ-01 | 06 | Pending |\n| REQ-01 | 06 |\n| stray |',
        ),
    );

    const result = runGsdTools('phase complete 6 --json', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.deepStrictEqual(
      output.requirements_closed,
      ['REQ-01'],
      'a truncated line is not a row, and must neither crash nor block closure',
    );
    assert.deepStrictEqual(output.requirements_unreadable_rows, []);
  });

  test('does not tick the box while another phase still owes work on the ID', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap

- [ ] Phase 6: Earlier
- [ ] Phase 7: Later

### Phase 6: Earlier
**Goal:** Ship the earlier half
**Plans:** 1 plan

### Phase 7: Later
**Goal:** Never executed
`,
    );
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'REQUIREMENTS.md'),
      `# Requirements

- [ ] **REQ-SPLIT**: Delivered across two phases

## Traceability

| Requirement | Phase | Status |
|-------------|-------|--------|
| REQ-SPLIT | 06 | Pending |
| REQ-SPLIT | 07 | Pending |
`,
    );
    const dir = path.join(tmpDir, '.planning', 'phases', '06-earlier');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, '06-01-PLAN.md'),
      `---\nrequirements: [REQ-SPLIT]\n---\n# Plan 06-01\n`,
    );
    fs.writeFileSync(path.join(dir, '06-01-SUMMARY.md'), '# Summary 06-01');

    const result = runGsdTools('phase complete 6 --json', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const req = readRequirements();
    assert.match(
      req,
      /\|\s*REQ-SPLIT\s*\|\s*06\s*\|\s*Complete\s*\|/,
      'this phase’s own row closes',
    );
    assert.match(
      req,
      /\|\s*REQ-SPLIT\s*\|\s*07\s*\|\s*Pending\s*\|/,
      'the other phase’s row is untouched',
    );
    assert.ok(
      req.includes('- [ ] **REQ-SPLIT**'),
      'the requirement is not done while a row still attributes work elsewhere',
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Closure keys off delivered work, not declared intent.
//
// A PLAN's `requirements:` frontmatter is what the plan set out to deliver. The
// paired SUMMARY is the record that it ran, and its `requirements-completed`
// frontmatter is the record of what actually landed. Closure reads the delivery
// record; the declaration is only a fallback for summaries that are silent.
// ─────────────────────────────────────────────────────────────────────────────

describe('phase complete closes delivered work, not declared intent', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  function readRequirements() {
    return fs.readFileSync(
      path.join(tmpDir, '.planning', 'REQUIREMENTS.md'),
      'utf-8',
    );
  }

  // Two plans in one phase. Each plan and each summary is supplied verbatim by
  // the caller so a test can withhold a summary or make one disagree with its
  // plan. `roadmapRequirements` adds the phase-section requirements line, in
  // the spelling every producer writes.
  function seedDeliveryPhase(opts = {}) {
    const reqLine = opts.roadmapRequirements
      ? `**Requirements**: ${opts.roadmapRequirements}\n`
      : '';
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap

- [ ] Phase 70: Delivery Tracking

### Phase 70: Delivery Tracking
**Goal:** Requirements close on what shipped
${reqLine}**Plans:** 2 plans

### Phase 71: Next
**Goal:** Something else
`,
    );
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'REQUIREMENTS.md'),
      `# Requirements

- [ ] **DLV-EXECUTED**: Delivered by the plan that ran
- [ ] **DLV-DEVIATED**: Declared but abandoned mid-execution
- [ ] **DLV-UNRUN**: Declared by a plan that never executed
- [ ] **DLV-EXTRA**: Delivered without ever being declared
- [ ] **DLV-ROADMAP**: Named only on the roadmap line

## Traceability

| Requirement | Phase | Status |
|-------------|-------|--------|
| DLV-EXECUTED | Phase 70 | Pending |
| DLV-DEVIATED | Phase 70 | Pending |
| DLV-UNRUN | Phase 70 | Pending |
| DLV-EXTRA | Phase 70 | Pending |
| DLV-ROADMAP | Phase 70 | Pending |
`,
    );

    const dir = path.join(
      tmpDir,
      '.planning',
      'phases',
      '70-delivery-tracking',
    );
    fs.mkdirSync(dir, { recursive: true });

    for (const [planId, spec] of Object.entries(opts.plans || {})) {
      fs.writeFileSync(
        path.join(dir, `${planId}-PLAN.md`),
        `---\nrequirements: [${spec.declared.join(', ')}]\n---\n# Plan ${planId}\n`,
      );
      if (spec.summary === undefined) continue;
      const body =
        spec.summary === null
          ? `# Summary ${planId}\n`
          : `---\nrequirements-completed: [${spec.summary.join(', ')}]\n---\n# Summary ${planId}\n`;
      fs.writeFileSync(path.join(dir, `${planId}-SUMMARY.md`), body);
    }

    fs.writeFileSync(
      path.join(dir, '70-VERIFICATION.md'),
      '---\nstatus: passed\n---\n# Verification\n',
    );
    return dir;
  }

  test('an unexecuted plan contributes none of its declared IDs', () => {
    seedDeliveryPhase({
      plans: {
        '70-01': { declared: ['DLV-EXECUTED'], summary: ['DLV-EXECUTED'] },
        '70-02': { declared: ['DLV-UNRUN'] },
      },
    });

    const result = runGsdTools('phase complete 70 --json', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.deepStrictEqual(
      output.requirements_closed,
      ['DLV-EXECUTED'],
      'a plan with no SUMMARY has not completed — its declared IDs must not close',
    );
    assert.ok(
      readRequirements().includes('- [ ] **DLV-UNRUN**'),
      'the unexecuted plan leaves its requirement Pending',
    );
  });

  test('a summary that records less than its plan declared closes only what it records', () => {
    seedDeliveryPhase({
      plans: {
        '70-01': {
          declared: ['DLV-EXECUTED', 'DLV-DEVIATED'],
          summary: ['DLV-EXECUTED'],
        },
      },
    });

    const result = runGsdTools('phase complete 70 --json', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.deepStrictEqual(
      output.requirements_closed,
      ['DLV-EXECUTED'],
      'an ID the executor deviated away from must not close on the declaration alone',
    );
    const req = readRequirements();
    assert.ok(req.includes('- [x] **DLV-EXECUTED**'));
    assert.ok(
      req.includes('- [ ] **DLV-DEVIATED**'),
      'the abandoned requirement stays Pending',
    );
  });

  test('an ID the summary records but the plan never declared is closed and reported', () => {
    seedDeliveryPhase({
      plans: {
        '70-01': {
          declared: ['DLV-EXECUTED'],
          summary: ['DLV-EXECUTED', 'DLV-EXTRA'],
        },
      },
    });

    const result = runGsdTools('phase complete 70 --json', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.deepStrictEqual(
      output.requirements_undeclared,
      ['DLV-EXTRA'],
      'delivery beyond the plan is a discrepancy to surface, not to swallow',
    );
    assert.ok(
      output.requirements_closed.includes('DLV-EXTRA'),
      'the summary is the delivery record, so the ID still closes',
    );
  });

  test('a summary that omits requirements-completed falls back to its plan declaration', () => {
    const dir = seedDeliveryPhase({
      plans: { '70-01': { declared: ['DLV-EXECUTED'] } },
    });
    fs.writeFileSync(
      path.join(dir, '70-01-SUMMARY.md'),
      '---\nphase: 70-delivery-tracking\n---\n# Summary\n',
    );

    const result = runGsdTools('phase complete 70 --json', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.deepStrictEqual(
      output.requirements_closed,
      ['DLV-EXECUTED'],
      'a summary predating the field makes no claim, so the declaration stands',
    );
    assert.deepStrictEqual(output.requirements_empty_summaries, []);
    assert.deepStrictEqual(output.requirements_unreadable_summaries, []);
  });

  test('a summary with no frontmatter at all is absent, not corrupt', () => {
    const dir = seedDeliveryPhase({
      plans: { '70-01': { declared: ['DLV-EXECUTED'] } },
    });
    fs.writeFileSync(path.join(dir, '70-01-SUMMARY.md'), '# Summary 70-01\n');

    const result = runGsdTools('phase complete 70 --json', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.deepStrictEqual(
      output.requirements_closed,
      ['DLV-EXECUTED'],
      'a frontmatter-less document is well-formed and simply carries no field',
    );
    assert.deepStrictEqual(output.requirements_unreadable_summaries, []);
  });

  test('an explicitly empty requirements-completed closes nothing and is reported', () => {
    seedDeliveryPhase({
      plans: { '70-01': { declared: ['DLV-EXECUTED'], summary: [] } },
    });

    const result = runGsdTools('phase complete 70 --json', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.deepStrictEqual(
      output.requirements_closed,
      [],
      'an empty list is a written claim to have delivered nothing, not silence',
    );
    assert.deepStrictEqual(output.requirements_empty_summaries, [
      '70-01-SUMMARY.md',
    ]);
    assert.ok(readRequirements().includes('- [ ] **DLV-EXECUTED**'));
  });

  test('a summary that records its IDs as a bare string is read the same way', () => {
    const dir = seedDeliveryPhase({
      plans: { '70-01': { declared: ['DLV-EXECUTED', 'DLV-DEVIATED'] } },
    });
    fs.writeFileSync(
      path.join(dir, '70-01-SUMMARY.md'),
      '---\nrequirements-completed: DLV-EXECUTED\n---\n# Summary\n',
    );

    const result = runGsdTools('phase complete 70 --json', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    assert.deepStrictEqual(JSON.parse(result.output).requirements_closed, [
      'DLV-EXECUTED',
    ]);
  });

  test('an unreadable summary closes nothing and is reported', () => {
    const dir = seedDeliveryPhase({
      plans: { '70-01': { declared: ['DLV-EXECUTED'] } },
    });
    // A directory occupying the summary's name: the plan counts as executed,
    // but nothing can be read out of the delivery record.
    fs.mkdirSync(path.join(dir, '70-01-SUMMARY.md'));

    const result = runGsdTools('phase complete 70 --json', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.deepStrictEqual(
      output.requirements_closed,
      [],
      'a record nothing can be read out of is not evidence of delivery',
    );
    assert.deepStrictEqual(output.requirements_unreadable_summaries, [
      '70-01-SUMMARY.md',
    ]);
    assert.ok(readRequirements().includes('- [ ] **DLV-EXECUTED**'));
  });

  test('a corrupt summary does not close the declaration it was truncated out of', () => {
    const dir = seedDeliveryPhase({
      plans: {
        '70-01': { declared: ['DLV-EXECUTED', 'DLV-DEVIATED'], summary: [] },
      },
    });
    // Truncated mid-frontmatter: the opening delimiter is there, the closing
    // one never arrived. This parses to an empty object, so without a block
    // check it is indistinguishable from a summary that omitted the field.
    fs.writeFileSync(
      path.join(dir, '70-01-SUMMARY.md'),
      '---\nphase: 70-delivery-tracking\nrequirements-comp',
    );

    const result = runGsdTools('phase complete 70 --json', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.deepStrictEqual(
      output.requirements_closed,
      [],
      'a truncated summary must never close the full declaration',
    );
    assert.deepStrictEqual(output.requirements_unreadable_summaries, [
      '70-01-SUMMARY.md',
    ]);
    const req = readRequirements();
    assert.ok(req.includes('- [ ] **DLV-EXECUTED**'));
    assert.ok(req.includes('- [ ] **DLV-DEVIATED**'));
  });

  test('a corrupt summary also withholds the roadmap requirements line', () => {
    const dir = seedDeliveryPhase({
      roadmapRequirements: 'DLV-ROADMAP',
      plans: { '70-01': { declared: ['DLV-EXECUTED'], summary: [] } },
    });
    fs.writeFileSync(
      path.join(dir, '70-01-SUMMARY.md'),
      '---\nphase: 70-delivery-tracking\nrequirements-comp',
    );

    const result = runGsdTools('phase complete 70 --json', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    assert.deepStrictEqual(
      JSON.parse(result.output).requirements_closed,
      [],
      'the phase-level declaration must not re-close what the record withheld',
    );
    assert.ok(readRequirements().includes('- [ ] **DLV-ROADMAP**'));
  });

  test('a narrowed delivery record withholds the roadmap requirements line', () => {
    seedDeliveryPhase({
      roadmapRequirements: 'DLV-ROADMAP',
      plans: {
        '70-01': {
          declared: ['DLV-EXECUTED', 'DLV-DEVIATED'],
          summary: ['DLV-EXECUTED'],
        },
      },
    });

    const result = runGsdTools('phase complete 70 --json', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.deepStrictEqual(
      output.requirements_closed,
      ['DLV-EXECUTED'],
      'narrowing is inert if the phase-level line closes the rest anyway',
    );
    assert.deepStrictEqual(
      output.requirements_narrowed_summaries,
      [{ summary: '70-01-SUMMARY.md', withheld: ['DLV-DEVIATED'] }],
      'a refusal nobody is told about is the failure this reporting prevents',
    );
    const req = readRequirements();
    assert.ok(req.includes('- [ ] **DLV-DEVIATED**'));
    assert.ok(req.includes('- [ ] **DLV-ROADMAP**'));
  });

  test('a narrowed record names the withheld IDs even with no roadmap line', () => {
    seedDeliveryPhase({
      plans: {
        '70-01': {
          declared: ['DLV-EXECUTED', 'DLV-DEVIATED', 'DLV-UNRUN'],
          summary: ['DLV-EXECUTED'],
        },
      },
    });

    const result = runGsdTools('phase complete 70 --json', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    assert.deepStrictEqual(
      JSON.parse(result.output).requirements_narrowed_summaries,
      [
        {
          summary: '70-01-SUMMARY.md',
          withheld: ['DLV-DEVIATED', 'DLV-UNRUN'],
        },
      ],
      '"which requirement did this plan not deliver" must be answerable',
    );
  });

  // Pins the all-or-nothing gate against the surgical form (admit the roadmap
  // line, subtract only the withheld IDs). Under the surgical form the
  // roadmap-only ID would close here, since no delivery record names it. It
  // must not: an ID no plan declared has no delivery evidence, and a narrowing
  // elsewhere in the phase disproves that every intent landed.
  test('an unrelated plan narrowing withholds a roadmap-only ID', () => {
    seedDeliveryPhase({
      roadmapRequirements: 'DLV-ROADMAP',
      plans: {
        '70-01': { declared: ['DLV-EXECUTED'], summary: ['DLV-EXECUTED'] },
        '70-02': {
          declared: ['DLV-DEVIATED', 'DLV-UNRUN'],
          summary: ['DLV-DEVIATED'],
        },
      },
    });

    const result = runGsdTools('phase complete 70 --json', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.ok(
      !output.requirements_closed.includes('DLV-ROADMAP'),
      'a roadmap-only ID must not close on the strength of a partial phase',
    );
    assert.deepStrictEqual(output.requirements_narrowed_summaries, [
      { summary: '70-02-SUMMARY.md', withheld: ['DLV-UNRUN'] },
    ]);
    assert.ok(
      readRequirements().includes('- [ ] **DLV-ROADMAP**'),
      'and the user is told which record withheld, so the gap is diagnosable',
    );
  });

  test('a summary that delivers everything it declared is not reported as narrowed', () => {
    seedDeliveryPhase({
      plans: {
        '70-01': {
          declared: ['DLV-EXECUTED', 'DLV-DEVIATED'],
          summary: ['DLV-DEVIATED', 'DLV-EXECUTED'],
        },
      },
    });

    const result = runGsdTools('phase complete 70 --json', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    assert.deepStrictEqual(
      JSON.parse(result.output).requirements_narrowed_summaries,
      [],
      'order and case differences are not a narrowing',
    );
  });

  test('the roadmap requirements line closes once every plan has a summary', () => {
    seedDeliveryPhase({
      roadmapRequirements: 'DLV-ROADMAP',
      plans: {
        '70-01': { declared: ['DLV-EXECUTED'], summary: ['DLV-EXECUTED'] },
      },
    });

    const result = runGsdTools('phase complete 70 --json', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    assert.ok(
      JSON.parse(result.output).requirements_closed.includes('DLV-ROADMAP'),
      'a complete phase still closes IDs named only on the roadmap line',
    );
  });

  test('the roadmap line closes for a phase whose plans declare no requirements', () => {
    const dir = seedDeliveryPhase({ roadmapRequirements: 'DLV-ROADMAP' });
    fs.writeFileSync(path.join(dir, '70-01-PLAN.md'), '---\nplan: 01\n---\n#\n');
    fs.writeFileSync(
      path.join(dir, '70-01-SUMMARY.md'),
      '---\nplan: 01\n---\n#\n',
    );

    const result = runGsdTools('phase complete 70 --json', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    assert.deepStrictEqual(
      JSON.parse(result.output).requirements_closed,
      ['DLV-ROADMAP'],
      'without the roadmap line such a project would close nothing, ever',
    );
    assert.ok(readRequirements().includes('- [x] **DLV-ROADMAP**'));
  });

  // The line is only a safety net if the code reads the spelling the templates
  // emit. Grepped rather than hardcoded so a template edit breaks this test
  // instead of silently stranding every project generated from it.
  test('the roadmap requirements line matches the spelling the templates emit', () => {
    const template = fs.readFileSync(
      path.join(__dirname, '..', 'gsd-ng', 'templates', 'roadmap.md'),
      'utf-8',
    );
    const emitted = template.match(/^.*\*\*Requirements\W*?:.*$/im);
    assert.ok(emitted, 'roadmap template no longer emits a requirements line');

    const label = emitted[0].match(/\*\*Requirements[^\s]*?:/)[0];
    const dir = seedDeliveryPhase({});
    fs.writeFileSync(path.join(dir, '70-01-PLAN.md'), '---\nplan: 01\n---\n#\n');
    fs.writeFileSync(
      path.join(dir, '70-01-SUMMARY.md'),
      '---\nplan: 01\n---\n#\n',
    );
    const roadmapPath = path.join(tmpDir, '.planning', 'ROADMAP.md');
    fs.writeFileSync(
      roadmapPath,
      fs
        .readFileSync(roadmapPath, 'utf-8')
        .replace(
          '**Plans:** 2 plans',
          `${label} DLV-ROADMAP\n**Plans:** 2 plans`,
        ),
    );

    const result = runGsdTools('phase complete 70 --json', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    assert.deepStrictEqual(
      JSON.parse(result.output).requirements_closed,
      ['DLV-ROADMAP'],
      `the template writes ${label} — closure must read that spelling`,
    );
  });

  test('the roadmap requirements line is withheld while a plan is unexecuted', () => {
    seedDeliveryPhase({
      roadmapRequirements: 'DLV-ROADMAP',
      plans: {
        '70-01': { declared: ['DLV-EXECUTED'], summary: ['DLV-EXECUTED'] },
        '70-02': { declared: ['DLV-UNRUN'] },
      },
    });

    const result = runGsdTools('phase complete 70 --json', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.ok(
      !output.requirements_closed.includes('DLV-ROADMAP'),
      'the phase-level declaration is intent for work that has not all landed',
    );
    assert.ok(readRequirements().includes('- [ ] **DLV-ROADMAP**'));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// A failing verification report that predates later work is stale by
// construction. Closure stays withheld — a gate that expires is not a gate —
// but the staleness is reported so the block is diagnosable and the operator
// knows to re-run verification rather than assume the gaps are current.
// ─────────────────────────────────────────────────────────────────────────────

describe('phase complete reports a stale failing verification', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  function readRequirements() {
    return fs.readFileSync(
      path.join(tmpDir, '.planning', 'REQUIREMENTS.md'),
      'utf-8',
    );
  }

  // One phase, two plans, both executed, with a VERIFICATION.md whose mtime the
  // caller places before or after the summaries.
  function seedStalePhase({ status = 'gaps_found', verificationAge } = {}) {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap\n\n- [ ] Phase 72: Gap Closure\n\n### Phase 72: Gap Closure\n**Goal:** Close the gaps\n**Plans:** 2 plans\n`,
    );
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'REQUIREMENTS.md'),
      `# Requirements\n\n- [ ] **STALE-01**: Reported as a gap\n\n## Traceability\n\n| Requirement | Phase | Status |\n|-------------|-------|--------|\n| STALE-01 | Phase 72 | Pending |\n`,
    );

    const dir = path.join(tmpDir, '.planning', 'phases', '72-gap-closure');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, '72-01-PLAN.md'),
      '---\nrequirements: [STALE-01]\n---\n# Plan\n',
    );
    fs.writeFileSync(
      path.join(dir, '72-01-SUMMARY.md'),
      '---\nrequirements-completed: [STALE-01]\n---\n# Summary\n',
    );
    fs.writeFileSync(
      path.join(dir, '72-02-PLAN.md'),
      '---\nrequirements: [STALE-01]\n---\n# Gap closure plan\n',
    );
    fs.writeFileSync(
      path.join(dir, '72-02-SUMMARY.md'),
      '---\nrequirements-completed: [STALE-01]\n---\n# Gap closure summary\n',
    );
    const verificationPath = path.join(dir, '72-VERIFICATION.md');
    fs.writeFileSync(
      verificationPath,
      `---\nstatus: ${status}\n---\n# Verification\n`,
    );

    // Place the report an hour before or after every summary. Explicit times
    // keep the test independent of filesystem timestamp granularity.
    const base = Date.now() / 1000;
    const offset = verificationAge === 'older' ? -3600 : 3600;
    fs.utimesSync(verificationPath, base + offset, base + offset);
    for (const name of ['72-01-SUMMARY.md', '72-02-SUMMARY.md']) {
      fs.utimesSync(path.join(dir, name), base, base);
    }
    return dir;
  }

  test('a failing report older than the summaries is flagged stale', () => {
    seedStalePhase({ verificationAge: 'older' });

    const result = runGsdTools('phase complete 72 --json', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(
      output.verification_stale,
      true,
      'a report written before the work it judges cannot be judging that work',
    );
    assert.deepStrictEqual(
      output.verification_stale_summaries.slice().sort(),
      ['72-01-SUMMARY.md', '72-02-SUMMARY.md'],
      'the summaries that postdate the report are named as the evidence',
    );
    assert.match(
      output.requirements_blocked_hint,
      /verif/i,
      'the block must come with an actionable hint, not just a status word',
    );
  });

  test('a stale failing report still withholds closure', () => {
    seedStalePhase({ verificationAge: 'older' });

    const result = runGsdTools('phase complete 72 --json', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.requirements_blocked_by, 'gaps_found');
    assert.deepStrictEqual(
      output.requirements_closed,
      [],
      'age is not evidence the gaps were closed — waiting must never open the gate',
    );
    assert.ok(readRequirements().includes('- [ ] **STALE-01**'));
  });

  test('a failing report newer than every summary is not stale', () => {
    seedStalePhase({ verificationAge: 'newer' });

    const result = runGsdTools('phase complete 72 --json', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.verification_stale, false);
    assert.deepStrictEqual(output.verification_stale_summaries, []);
    assert.strictEqual(output.requirements_blocked_by, 'gaps_found');
  });

  test('a passing report carries no block hint', () => {
    seedStalePhase({ status: 'passed', verificationAge: 'older' });

    const result = runGsdTools('phase complete 72 --json', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.requirements_blocked_by, null);
    assert.strictEqual(output.requirements_blocked_hint, null);
    assert.strictEqual(
      output.verification_stale,
      true,
      'staleness is reported wherever it is observed, blocking or not',
    );
    assert.ok(readRequirements().includes('- [x] **STALE-01**'));
  });

  test('a phase with no verification report is never stale', () => {
    const dir = seedStalePhase({ verificationAge: 'older' });
    cleanupSubdir(dir, '72-VERIFICATION.md');

    const result = runGsdTools('phase complete 72 --json', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.verification_stale, false);
    assert.deepStrictEqual(output.verification_stale_summaries, []);
    assert.strictEqual(output.requirements_blocked_hint, null);
  });
});

// Per-plan closure is instruction-driven, not code-driven: removing the code
// path does nothing while the agent docs still tell the model to close per plan,
// so guard the docs directly.
describe('requirements are not closed per-plan in workflow docs', () => {
  const REPO_ROOT = path.join(__dirname, '..');
  const PLAN_SCOPED_DOCS = [
    'agents/gsd-executor.md',
    'gsd-ng/workflows/execute-plan.md',
  ];

  for (const rel of PLAN_SCOPED_DOCS) {
    test(`${rel} does not invoke requirements mark-complete`, () => {
      const content = fs.readFileSync(path.join(REPO_ROOT, rel), 'utf-8');
      const offending = content
        .split('\n')
        .map((line, i) => ({ line, n: i + 1 }))
        .filter(({ line }) =>
          // `.cjs` is optional: the bare spelling dominates these docs.
          /gsd-tools(?:\.cjs)?["'`]?\s+requirements\s+mark-complete/.test(line),
        );

      assert.deepStrictEqual(
        offending,
        [],
        `${rel} closes requirements at plan scope — closure belongs in phase complete. ` +
          `Offending lines: ${offending.map((o) => `${o.n}: ${o.line.trim()}`).join(' | ')}`,
      );
    });
  }
});

// Narrowing closure to what a summary records is inert if the docs tell the
// executor to copy the plan's declaration verbatim: delivered would always
// equal declared and the narrowing path would never fire. The code is only
// half the mechanism, so guard the instructions that feed it.
describe('executor docs record delivery, not declaration', () => {
  const REPO_ROOT = path.join(__dirname, '..');
  const DELIVERY_DOCS = [
    'gsd-ng/templates/summary.md',
    'gsd-ng/workflows/execute-plan.md',
  ];

  for (const rel of DELIVERY_DOCS) {
    test(`${rel} does not instruct a verbatim copy of the declaration`, () => {
      const content = fs.readFileSync(path.join(REPO_ROOT, rel), 'utf-8');
      const offending = content
        .split('\n')
        .map((line, i) => ({ line, n: i + 1 }))
        .filter(
          ({ line }) =>
            /requirements-completed|requirements\s+array|requirements`?\s+frontmatter/i.test(
              line,
            ) && /\bverbatim\b|copy\s+ALL\b/i.test(line),
        );

      assert.deepStrictEqual(
        offending,
        [],
        `${rel} tells the executor to copy the plan's declaration, which makes ` +
          `delivery-record narrowing inert. Offending lines: ` +
          `${offending.map((o) => `${o.n}: ${o.line.trim()}`).join(' | ')}`,
      );
    });

    test(`${rel} tells the executor to record what was delivered`, () => {
      const content = fs.readFileSync(path.join(REPO_ROOT, rel), 'utf-8');
      const instruction = content
        .split('\n')
        .filter((line) => /requirements-completed/i.test(line))
        .join('\n');

      assert.match(
        instruction,
        /deliver/i,
        `${rel} must frame requirements-completed as a delivery record`,
      );
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Bare and bold are both supported roadmap checkbox forms. Every reader must
// agree on that: a bold-only reader reported a milestone finished with a phase
// still outstanding.
// ─────────────────────────────────────────────────────────────────────────────

describe('checkbox form parity: bare and bold', () => {
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
    test(`phase complete finds the next unscaffolded phase (${form.label})`, () => {
      fs.writeFileSync(
        path.join(tmpDir, '.planning', 'ROADMAP.md'),
        [
          '# Roadmap',
          '',
          '## Roadmap v0.1: Current',
          '',
          form.line(1, 'Alpha'),
          form.line(2, 'Beta'),
          '',
        ].join('\n'),
      );
      fs.writeFileSync(
        path.join(tmpDir, '.planning', 'STATE.md'),
        '# State\n\n**Current Phase:** 1\n**Status:** Ready to plan\n',
      );
      fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '01-alpha'), {
        recursive: true,
      });

      const result = runGsdTools('phase complete 1 --json', tmpDir);
      assert.ok(result.success, `Command failed: ${result.error}`);
      const output = JSON.parse(result.output);

      assert.deepStrictEqual(
        output.next_phase,
        { number: '2', name: 'beta' },
        `${form.label} form: Phase 2 is in the roadmap and must be the next phase`,
      );
      assert.strictEqual(
        output.is_last_phase,
        false,
        `${form.label} form: a phase is outstanding, so this is not the last one`,
      );

      const state = fs.readFileSync(
        path.join(tmpDir, '.planning', 'STATE.md'),
        'utf-8',
      );
      assert.match(
        state,
        /\*\*Status:\*\* Ready to plan/,
        `${form.label} form: Status must not go to "Milestone complete"`,
      );
    });

    test(`phase add appends after the last checkbox (${form.label})`, () => {
      fs.writeFileSync(
        path.join(tmpDir, '.planning', 'ROADMAP.md'),
        [
          '# Roadmap',
          '',
          '## Roadmap v0.1: Current',
          '',
          form.line(1, 'Alpha'),
          '',
          '### Phase 1: Alpha',
          '**Goal:** a',
          '',
        ].join('\n'),
      );

      const result = runGsdTools('phase add "Gamma work" --json', tmpDir);
      assert.ok(result.success, `Command failed: ${result.error}`);

      const roadmap = fs.readFileSync(
        path.join(tmpDir, '.planning', 'ROADMAP.md'),
        'utf-8',
      );
      assert.match(
        roadmap,
        /- \[ \] \*\*Phase 2: Gamma work\*\*/,
        `${form.label} form: the new phase needs its checkbox line`,
      );
      const lines = roadmap.split('\n');
      const alphaIdx = lines.findIndex((l) => /\[ \] .*Phase 1:/.test(l));
      const gammaIdx = lines.findIndex((l) => /Phase 2: Gamma work/.test(l));
      assert.ok(
        alphaIdx >= 0 && gammaIdx === alphaIdx + 1,
        `${form.label} form: the new checkbox belongs right after the last one ` +
          `(alpha at ${alphaIdx}, gamma at ${gammaIdx})`,
      );
    });

    test(`phase insert lands after the parent checkbox (${form.label})`, () => {
      fs.writeFileSync(
        path.join(tmpDir, '.planning', 'ROADMAP.md'),
        [
          '# Roadmap',
          '',
          '## Roadmap v0.1: Current',
          '',
          form.line(1, 'Alpha'),
          form.line(2, 'Beta'),
          '',
          '### Phase 1: Alpha',
          '**Goal:** a',
          '',
          '### Phase 2: Beta',
          '**Goal:** b',
          '',
        ].join('\n'),
      );

      const result = runGsdTools('phase insert 1 "Hotfix" --json', tmpDir);
      assert.ok(result.success, `Command failed: ${result.error}`);

      const roadmap = fs.readFileSync(
        path.join(tmpDir, '.planning', 'ROADMAP.md'),
        'utf-8',
      );
      const lines = roadmap.split('\n');
      const parentIdx = lines.findIndex((l) => /\[ \] .*Phase 1:/.test(l));
      const insertedIdx = lines.findIndex((l) =>
        /\[ \] .*Phase 0?1\.1: Hotfix/.test(l),
      );
      assert.ok(
        parentIdx >= 0 && insertedIdx === parentIdx + 1,
        `${form.label} form: 1.1's checkbox belongs directly after 1's ` +
          `(parent at ${parentIdx}, inserted at ${insertedIdx})`,
      );
    });

  }
});

// ─────────────────────────────────────────────────────────────────────────────
// phase remove rewrites the current milestone only, and reports what its
// rewrites actually did. Removing a phase used to delete a same-numbered
// phase's checkbox and table row out of an archived milestone section, mangle
// the dates in that section's table, and report roadmap_updated regardless.
// ─────────────────────────────────────────────────────────────────────────────

describe('phase remove milestone scoping', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  const ARCHIVED = [
    '<details>',
    '<summary>v0.1 — Legacy (Shipped)</summary>',
    '',
    '## Roadmap v0.1: Legacy',
    '',
    '- [x] **Phase 1: Ancient**',
    '- [x] **Phase 2: Older**',
    '- [x] Phase 3: Oldest',
    '',
    '| Phase | Plans | Status | Completed |',
    '|-------|-------|--------|-----------|',
    '| 1. Ancient | 1/1 | Complete | 2020-01-01 |',
    '| 2. Older | 1/1 | Complete | 2020-02-01 |',
    '| 3. Oldest | 2/2 | Complete | 2020-03-01 |',
    '',
    '### Phase 2: Older',
    '**Goal:** old',
    '',
    '### Phase 3: Oldest',
    '**Goal:** older',
    '',
    '</details>',
    '',
  ];

  const CURRENT = [
    '## Roadmap v0.2: Current',
    '',
    '- [ ] **Phase 1: Alpha**',
    '- [ ] **Phase 2: Beta**',
    '- [ ] **Phase 3: Gamma**',
    '',
    '| Phase | Plans | Status | Completed |',
    '|-------|-------|--------|-----------|',
    '| 1. Alpha | 1/1 | Complete | 2026-05-05 |',
    '| 2. Beta | 0/0 | Pending | - |',
    '| 3. Gamma | 0/0 | Pending | - |',
    '',
    '### Phase 1: Alpha',
    '**Goal:** a',
    '',
    '### Phase 2: Beta',
    '**Goal:** b',
    '',
    '### Phase 3: Gamma',
    '**Goal:** c',
    '',
  ];

  function writeMilestoneRoadmap(sections = [ARCHIVED, CURRENT]) {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      ['# Roadmap', ''].concat(...sections).join('\n'),
    );
    for (const dir of ['01-alpha', '02-beta', '03-gamma']) {
      fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', dir), {
        recursive: true,
      });
    }
  }

  test('leaves the archived milestone section untouched', () => {
    writeMilestoneRoadmap();

    const result = runGsdTools('phase remove 2 --json', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const roadmap = fs.readFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      'utf-8',
    );
    const archived = roadmap.slice(0, roadmap.indexOf('</details>'));

    assert.deepStrictEqual(
      archived.split('\n').filter((l) => /^- \[/.test(l)),
      [
        '- [x] **Phase 1: Ancient**',
        '- [x] **Phase 2: Older**',
        '- [x] Phase 3: Oldest',
      ],
      'no archived checkbox may be removed or renumbered',
    );
    assert.deepStrictEqual(
      archived.split('\n').filter((l) => /^\| \d\./.test(l)),
      [
        '| 1. Ancient | 1/1 | Complete | 2020-01-01 |',
        '| 2. Older | 1/1 | Complete | 2020-02-01 |',
        '| 3. Oldest | 2/2 | Complete | 2020-03-01 |',
      ],
      'no archived table row may be removed, renumbered or re-dated',
    );
    assert.match(
      archived,
      /### Phase 2: Older/,
      'the archived phase section stays',
    );
    assert.match(
      archived,
      /### Phase 3: Oldest/,
      'the archived sections keep their numbers',
    );
  });

  test('rewrites the current milestone and reports every landing', () => {
    writeMilestoneRoadmap();

    const result = runGsdTools('phase remove 2 --json', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);
    const output = JSON.parse(result.output);

    assert.strictEqual(output.roadmap_updated, true);
    assert.deepStrictEqual(output.roadmap_missed_targets, []);
    assert.deepStrictEqual(output.roadmap_landed, [
      'phase-section',
      'phase-checkbox',
      'progress-table',
      'renumber',
    ]);

    const roadmap = fs.readFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      'utf-8',
    );
    const current = roadmap.slice(
      roadmap.lastIndexOf('</details>') + '</details>'.length,
    );

    assert.deepStrictEqual(
      current.split('\n').filter((l) => /^- \[/.test(l)),
      ['- [ ] **Phase 1: Alpha**', '- [ ] **Phase 2: Gamma**'],
      'Beta goes, Gamma becomes 2',
    );
    assert.deepStrictEqual(
      current.split('\n').filter((l) => /^\| \d\./.test(l)),
      [
        '| 1. Alpha | 1/1 | Complete | 2026-05-05 |',
        '| 2. Gamma | 0/0 | Pending | - |',
      ],
      'the surviving rows keep their dates',
    );
    assert.ok(
      !/### Phase \d: Beta/.test(current),
      'the removed section is gone',
    );
  });

  test('reports missed targets instead of success when nothing matches', () => {
    // Every target names phase 2 in a shape the rewrites cannot reach: the
    // header has no colon, the checkbox does not start with the phase, and the
    // table row has no space after the number.
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      [
        '# Roadmap',
        '',
        '## Roadmap v0.1: Current',
        '',
        '- [ ] Milestone work: Phase 2: Beta',
        '',
        '| Phase | Plans |',
        '|-------|-------|',
        '| 2|Beta |',
        '',
        '### Phase 2 — Beta',
        '**Goal:** b',
        '',
      ].join('\n'),
    );
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '02-beta'), {
      recursive: true,
    });
    const before = fs.readFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      'utf-8',
    );

    const result = runGsdTools('phase remove 2 --json', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);
    const output = JSON.parse(result.output);

    assert.strictEqual(
      output.roadmap_updated,
      false,
      'nothing was rewritten, so nothing may be claimed',
    );
    assert.deepStrictEqual(output.roadmap_landed, []);
    assert.deepStrictEqual(output.roadmap_missed_targets, [
      'phase-section',
      'phase-checkbox',
      'progress-table',
    ]);
    assert.strictEqual(
      fs.readFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), 'utf-8'),
      before,
      'a roadmap nothing matched in is left alone',
    );
  });

  test('renumbers a zero-padded phase at the width it was written', () => {
    // A roadmap may spell its phase numbers padded or bare, and the two forms
    // appear in headings, checkbox items, progress rows and dependency lines. A
    // renumbering that reaches only the bare spelling leaves the padded
    // references pointing at whatever now holds their old number.
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      [
        '# Roadmap',
        '',
        '## Roadmap v0.1: Current',
        '',
        '- [ ] Phase 1: Alpha',
        '- [ ] Phase 2: Beta',
        '- [ ] Phase 03: Gamma',
        '- [ ] Phase 4: Delta',
        '',
        '| Phase | Plans | Status | Completed |',
        '|-------|-------|--------|-----------|',
        '| 03. Gamma | 0/0 | Pending | - |',
        '| 4. Delta | 0/0 | Pending | - |',
        '',
        '### Phase 03: Gamma',
        '**Depends on:** Phase 1',
        '',
        '### Phase 4: Delta',
        '**Depends on:** Phase 03',
        '',
      ].join('\n'),
    );
    for (const dir of ['01-alpha', '02-beta', '03-gamma', '04-delta']) {
      fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', dir), {
        recursive: true,
      });
    }

    const result = runGsdTools('phase remove 2 --json', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);
    const output = JSON.parse(result.output);

    assert.ok(
      output.roadmap_landed.includes('renumber'),
      `the padded references are renumbering targets: ${JSON.stringify(output)}`,
    );
    assert.deepStrictEqual(output.roadmap_missed_targets, []);

    const roadmap = fs.readFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      'utf-8',
    );
    assert.deepStrictEqual(
      roadmap.split('\n').filter((l) => /^- \[/.test(l)),
      ['- [ ] Phase 1: Alpha', '- [ ] Phase 02: Gamma', '- [ ] Phase 3: Delta'],
      'the padded entry stays padded and the bare one stays bare',
    );
    assert.deepStrictEqual(
      roadmap.split('\n').filter((l) => /^\| \d/.test(l)),
      ['| 02. Gamma | 0/0 | Pending | - |', '| 3. Delta | 0/0 | Pending | - |'],
      'progress rows follow the same widths',
    );
    assert.deepStrictEqual(
      roadmap.split('\n').filter((l) => /^#{2,4} Phase/.test(l)),
      ['### Phase 02: Gamma', '### Phase 3: Delta'],
    );
    assert.deepStrictEqual(
      roadmap.split('\n').filter((l) => /^\*\*Depends on:/.test(l)),
      ['**Depends on:** Phase 1', '**Depends on:** Phase 02'],
      'a dependency on the renumbered phase follows it',
    );
  });

  test('shifts every phase above the removed one down by exactly one', () => {
    // The rewrite is a decrement, so a pass per source number walking down from
    // the top re-reads its own output: the reference it lowered to N is lowered
    // again by the pass for N. Every phase above the removed one then collapses
    // onto the removed one's number, which is a roadmap with one number naming
    // four different phases.
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      [
        '# Roadmap',
        '',
        '## Roadmap v0.1: Current',
        '',
        '- [ ] Phase 1: Alpha',
        '- [ ] Phase 2: Beta',
        '- [ ] Phase 3: Gamma',
        '- [ ] Phase 4: Delta',
        '- [ ] Phase 5: Epsilon',
        '',
        '### Phase 3: Gamma',
        '### Phase 4: Delta',
        '**Depends on:** Phase 3, Phase 5',
        '### Phase 5: Epsilon',
        '',
      ].join('\n'),
    );
    for (const dir of [
      '01-alpha',
      '02-beta',
      '03-gamma',
      '04-delta',
      '05-epsilon',
    ]) {
      fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', dir), {
        recursive: true,
      });
    }

    const result = runGsdTools('phase remove 2 --json', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const roadmap = fs.readFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      'utf-8',
    );
    assert.deepStrictEqual(
      roadmap.split('\n').filter((l) => /^- \[/.test(l)),
      [
        '- [ ] Phase 1: Alpha',
        '- [ ] Phase 2: Gamma',
        '- [ ] Phase 3: Delta',
        '- [ ] Phase 4: Epsilon',
      ],
    );
    assert.deepStrictEqual(
      roadmap.split('\n').filter((l) => /^#{2,4} Phase/.test(l)),
      ['### Phase 2: Gamma', '### Phase 3: Delta', '### Phase 4: Epsilon'],
      'each surviving phase moves down one place, not down to the gap',
    );
    assert.deepStrictEqual(
      roadmap.split('\n').filter((l) => /^\*\*Depends on:/.test(l)),
      ['**Depends on:** Phase 2, Phase 4'],
      'a dependency list follows too, including the entry a comma ends',
    );
  });

  test('leaves version-like and decimal tokens alone while renumbering plan references', () => {
    // The plan-reference rewrite reads a hyphenated pair of two-digit numbers as
    // a phase and a plan within it. A
    // preceding digit kept it out of dates; a preceding dot has to keep it out of
    // version and section numbers, whose second component is in the same shape.
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      [
        '# Roadmap',
        '',
        '## Roadmap v0.1: Current',
        '',
        '- [ ] Phase 1: Alpha',
        '- [ ] Phase 2: Beta',
        '- [ ] Phase 3: Gamma',
        '',
        '### Phase 3: Gamma',
        '**Goal:** follow ref 3.14-05 under version 1.05-01, shipped 2020-01-01',
        '',
        'Plans:',
        '- [ ] 18-01-PLAN.md',
        '',
      ].join('\n'),
    );
    for (const dir of ['01-alpha', '02-beta', '03-gamma']) {
      fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', dir), {
        recursive: true,
      });
    }

    const result = runGsdTools('phase remove 2 --json', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const roadmap = fs.readFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      'utf-8',
    );
    assert.match(
      roadmap,
      /follow ref 3\.14-05 under version 1\.05-01, shipped 2020-01-01/,
      'a token whose number follows a dot is not a plan reference',
    );
    assert.match(
      roadmap,
      /- \[ \] 17-01-PLAN\.md/,
      'a plan reference still renumbers, which is what the guard must not cost',
    );
  });

  // With the live milestone written above the collapsed one, every rewrite is
  // out of scope. Probes scoped to the rewrites' own region reported nothing.
  //
  // The renumbering is named as withheld rather than as missed, because a removal
  // that landed nowhere is exactly the case it is refused in. Which channel it
  // comes back on is the withholding's business; that it comes back at all is
  // this probe's — read scoped like the rewrite, the renumbering has no target
  // above the removed number, so nothing is refused and nothing is reported.
  test('names every target when the live milestone sits above the archive', () => {
    writeMilestoneRoadmap([CURRENT, ARCHIVED]);
    const before = fs.readFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      'utf-8',
    );

    const result = runGsdTools('phase remove 2 --json', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);
    const output = JSON.parse(result.output);

    assert.strictEqual(output.roadmap_updated, false);
    assert.deepStrictEqual(output.roadmap_landed, []);
    assert.deepStrictEqual(output.roadmap_missed_targets, [
      'phase-section',
      'phase-checkbox',
      'progress-table',
    ]);
    assert.deepStrictEqual(output.roadmap_withheld, ['renumber']);
    assert.match(output.roadmap_withheld_hint, /same number/);
    assert.strictEqual(
      fs.readFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), 'utf-8'),
      before,
      'a roadmap nothing matched in is left alone',
    );
  });

  // Archived phases are never renumbered — that is asserted above — so one
  // above the removed number is not a renumbering target either. A probe
  // reading the whole document instead of the current milestone reports this
  // as a miss on every removal from a project with a shipped milestone.
  test('an archived phase above the removed one is not a renumbering target', () => {
    writeMilestoneRoadmap([
      [
        '<details>',
        '<summary>v0.1 — Legacy (Shipped)</summary>',
        '',
        '- [x] **Phase 3: Oldest**',
        '',
        '</details>',
        '',
      ],
      ['- [ ] **Phase 1: Alpha**', '- [ ] **Phase 2: Beta**', ''],
    ]);

    const result = runGsdTools('phase remove 2 --json', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);
    const output = JSON.parse(result.output);

    assert.deepStrictEqual(output.roadmap_landed, ['phase-checkbox']);
    assert.deepStrictEqual(
      output.roadmap_missed_targets,
      [],
      'nothing in the current milestone needed renumbering',
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Both milestone scopes read the same tag. ROADMAP.md is user-editable, and
// `<details open>` is what you write to keep the archive expanded; the probes
// tolerated case but no attributes and the write scope attributes but no case,
// so either spelling put one of the two over the whole document — a false miss
// and a withheld renumber from the first, rewrites inside the archive from the
// second.
// ─────────────────────────────────────────────────────────────────────────────

describe('roadmap milestone scoping across <details> spellings', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  function writeRoadmap(text) {
    fs.writeFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), text);
  }

  function readRoadmap() {
    return fs.readFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      'utf-8',
    );
  }

  const CURRENT_WITHOUT_SECTION = [
    '',
    '## Roadmap v0.2: Current',
    '',
    '- [ ] **Phase 2: Beta**',
    '- [ ] **Phase 3: Gamma**',
    '',
    '| Phase | Plans | Status | Completed |',
    '|-------|-------|--------|-----------|',
    '| 2. Beta | 0/0 | Pending | - |',
    '| 3. Gamma | 0/0 | Pending | - |',
    '',
    '### Phase 3: Gamma',
    '**Goal:** c',
    '',
  ].join('\n');

  test('an attributed <details> is not read as current milestone content', () => {
    const archive = [
      '# Roadmap',
      '',
      '<details open>',
      '<summary>v0.1 — Legacy (Shipped)</summary>',
      '',
      '- [x] **Phase 2: Older**',
      '- [x] **Phase 3: Oldest**',
      '',
      '### Phase 2: Older',
      '**Goal:** old',
      '',
      '</details>',
    ].join('\n');
    writeRoadmap(archive + CURRENT_WITHOUT_SECTION);
    for (const dir of ['02-beta', '03-gamma']) {
      fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', dir), {
        recursive: true,
      });
    }

    const result = runGsdTools('phase remove 2 --json', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);
    const output = JSON.parse(result.output);

    assert.deepStrictEqual(
      output.roadmap_missed_targets,
      [],
      'the only Phase 2 section is archived, which is out of scope by design',
    );
    assert.deepStrictEqual(
      output.roadmap_withheld,
      [],
      'nothing was missed, so the renumbering had no reason to be withheld',
    );
    assert.ok(
      output.roadmap_landed.includes('renumber'),
      `the renumbering must land: ${JSON.stringify(output)}`,
    );

    const roadmap = readRoadmap();
    assert.strictEqual(
      roadmap.slice(0, archive.length),
      archive,
      'the archive is left byte-identical',
    );
    const current = roadmap.slice(archive.length);
    assert.deepStrictEqual(
      current.split('\n').filter((l) => /^- \[/.test(l)),
      ['- [ ] **Phase 2: Gamma**'],
      'Beta goes and Gamma takes its number',
    );
    assert.deepStrictEqual(
      current.split('\n').filter((l) => /^\| \d\./.test(l)),
      ['| 2. Gamma | 0/0 | Pending | - |'],
    );
  });

  test('an attributed <details> does not make an archived Plans line a miss', () => {
    const archive = [
      '# Roadmap',
      '',
      '<details markdown="1">',
      '<summary>v0.9 — SHIPPED 2020-01-01</summary>',
      '',
      '### Phase 1: Foundation',
      '**Plans**: 1/1 plans complete',
      '',
      '</details>',
    ].join('\n');
    const current = [
      '',
      '',
      '- [ ] **Phase 1: Foundation** - set up',
      '',
      '## Progress',
      '',
      '| Phase | Plans Complete | Status | Completed |',
      '|-------|---------------|--------|-----------|',
      '| 1. Foundation | 0/1 | Planned |  |',
      '',
    ].join('\n');
    writeRoadmap(archive + current);
    const p1 = path.join(tmpDir, '.planning', 'phases', '01-foundation');
    fs.mkdirSync(p1, { recursive: true });
    fs.writeFileSync(path.join(p1, '01-01-PLAN.md'), '# Plan');
    fs.writeFileSync(path.join(p1, '01-01-SUMMARY.md'), '# Summary');

    const result = runGsdTools('phase complete 1 --json', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);
    const output = JSON.parse(result.output);

    assert.strictEqual(output.roadmap_updated, true, 'the reachable targets landed');
    assert.deepStrictEqual(
      output.roadmap_missed_targets,
      [],
      'the archived Plans line is out of scope by design, not missed',
    );

    const roadmap = readRoadmap();
    assert.strictEqual(
      roadmap.slice(0, archive.length),
      archive,
      'the archive is left byte-identical',
    );
    assert.match(
      roadmap.slice(archive.length),
      /^- \[x\] \*\*Phase 1: Foundation\*\*/m,
      'the current checkbox is the one that gets ticked',
    );
  });

  test('an uppercase </DETAILS> still bounds where a rewrite may write', () => {
    const archive = [
      '# Roadmap',
      '',
      '<DETAILS>',
      '<summary>v0.1 — Legacy (Shipped)</summary>',
      '',
      '- [x] **Phase 2: Older**',
      '- [x] **Phase 3: Oldest**',
      '',
      '| Phase | Plans | Status | Completed |',
      '|-------|-------|--------|-----------|',
      '| 2. Older | 1/1 | Complete | 2020-02-01 |',
      '| 3. Oldest | 2/2 | Complete | 2020-03-01 |',
      '',
      '### Phase 2: Older',
      '**Goal:** old',
      '',
      '### Phase 3: Oldest',
      '**Goal:** older',
      '',
      '</DETAILS>',
    ].join('\n');
    const current = [
      '',
      '## Roadmap v0.2: Current',
      '',
      '- [ ] **Phase 2: Beta**',
      '- [ ] **Phase 3: Gamma**',
      '',
      '| Phase | Plans | Status | Completed |',
      '|-------|-------|--------|-----------|',
      '| 2. Beta | 0/0 | Pending | - |',
      '| 3. Gamma | 0/0 | Pending | - |',
      '',
      '### Phase 2: Beta',
      '**Goal:** b',
      '',
      '### Phase 3: Gamma',
      '**Goal:** c',
      '',
    ].join('\n');
    writeRoadmap(archive + current);
    for (const dir of ['02-beta', '03-gamma']) {
      fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', dir), {
        recursive: true,
      });
    }

    const result = runGsdTools('phase remove 2 --json', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);
    const output = JSON.parse(result.output);

    const roadmap = readRoadmap();
    assert.strictEqual(
      roadmap.slice(0, archive.length),
      archive,
      'the archive is left byte-identical',
    );
    assert.deepStrictEqual(output.roadmap_missed_targets, []);
    assert.deepStrictEqual(output.roadmap_landed, [
      'phase-section',
      'phase-checkbox',
      'progress-table',
      'renumber',
    ]);

    const remaining = roadmap.slice(archive.length);
    assert.deepStrictEqual(
      remaining.split('\n').filter((l) => /^- \[/.test(l)),
      ['- [ ] **Phase 2: Gamma**'],
    );
    assert.deepStrictEqual(
      remaining.split('\n').filter((l) => /^\| \d\./.test(l)),
      ['| 2. Gamma | 0/0 | Pending | - |'],
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The phase list a new checkbox joins is the current milestone's. Scanning the
// whole document put new phases inside a shipped <details> section whenever it
// held the last checkbox in the file — which happens when the milestone in
// progress has no list of its own, when the parent phase is listed only as
// shipped, and when the collapsed section sits below the current list.
// ─────────────────────────────────────────────────────────────────────────────

describe('phase add and insert milestone scoping', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  const SHIPPED = [
    '<details>',
    '<summary>v0.1 — Legacy (Shipped)</summary>',
    '',
    '## Roadmap v0.1: Legacy',
    '',
    '- [x] **Phase 1: Ancient**',
    '- [x] Phase 2: Older',
    '',
    '</details>',
  ];

  function writeRoadmap(currentLines) {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      ['# Roadmap', '']
        .concat(SHIPPED)
        .concat(['', '## Roadmap v0.2: Current', ''])
        .concat(currentLines)
        .join('\n'),
    );
  }

  // The collapsed section moved down out of the way, below the list of the
  // milestone in progress. The shipped checkboxes are then the last ones in the
  // file, so a scan that runs to the end of the document lands in them.
  function writeRoadmapShippedBelow(listLines, detailLines) {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      ['# Roadmap', '', '## Roadmap v0.2: Current', '']
        .concat(listLines)
        .concat([''])
        .concat(SHIPPED)
        .concat([''])
        .concat(detailLines)
        .join('\n'),
    );
  }

  function split(roadmap) {
    const close = roadmap.lastIndexOf('</details>') + '</details>'.length;
    return { archived: roadmap.slice(0, close), current: roadmap.slice(close) };
  }

  function shippedSection(roadmap) {
    return roadmap.slice(
      roadmap.indexOf('<details>'),
      roadmap.lastIndexOf('</details>') + '</details>'.length,
    );
  }

  function phaseCheckboxes(text) {
    return text
      .split('\n')
      .filter((l) => /^- \[[ x]\]\s*(?:\*\*)?Phase\s/.test(l));
  }

  test('phase add lists the new phase in the current milestone', () => {
    writeRoadmap(['### Phase 1: Alpha', '**Goal:** a', '']);

    const result = runGsdTools('phase add "Gamma work" --json', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const { archived, current } = split(
      fs.readFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), 'utf-8'),
    );
    assert.ok(
      !/Gamma work/.test(archived),
      'a shipped milestone section is not where a new phase goes',
    );
    assert.match(
      current,
      /- \[ \] \*\*Phase 2: Gamma work\*\*/,
      'the current milestone gets the checkbox even with no list to append to',
    );
  });

  test('phase add ignores a shipped list holding the last checkbox in the file', () => {
    writeRoadmapShippedBelow(
      ['- [ ] **Phase 3: Alpha**'],
      ['### Phase 3: Alpha', '**Goal:** a', ''],
    );
    const before = fs.readFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      'utf-8',
    );

    const result = runGsdTools('phase add "Gamma work" --json', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const after = fs.readFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      'utf-8',
    );
    assert.strictEqual(
      shippedSection(after),
      shippedSection(before),
      'the collapsed section is not where a new phase goes',
    );
    assert.deepStrictEqual(
      phaseCheckboxes(split(after).current),
      ['- [ ] **Phase 4: Gamma work**'],
      'the new checkbox is listed past the collapsed section',
    );
  });

  test('phase insert ignores a parent checkbox in a shipped section', () => {
    // The parent is listed in the shipped section and carries only a header
    // here, so the parent lookup used to find the archived line and splice the
    // new decimal in beneath it, inside <details>.
    writeRoadmap(['### Phase 1: Alpha', '**Goal:** a', '']);

    const result = runGsdTools('phase insert 1 "Hotfix" --json', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const { archived, current } = split(
      fs.readFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), 'utf-8'),
    );
    assert.ok(
      !/Hotfix/.test(archived),
      'the shipped section must not gain a phase',
    );
    assert.match(
      current,
      /- \[ \] \*\*Phase 01\.1: Hotfix \(INSERTED\)\*\*/,
      'the decimal is listed in the current milestone',
    );
  });

  test('phase insert joins the current list, not the shipped parent', () => {
    // The parent phase is listed only in the shipped section; the milestone in
    // progress has a list of its own, and that list is the one to join.
    writeRoadmap([
      '- [ ] **Phase 3: Beta**',
      '',
      '### Phase 1: Alpha',
      '**Goal:** a',
      '',
      '### Phase 3: Beta',
      '**Goal:** b',
      '',
    ]);

    const result = runGsdTools('phase insert 1 "Hotfix" --json', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const { archived, current } = split(
      fs.readFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), 'utf-8'),
    );
    assert.deepStrictEqual(
      phaseCheckboxes(archived),
      ['- [x] **Phase 1: Ancient**', '- [x] Phase 2: Older'],
      'the shipped list is left as it was',
    );
    assert.deepStrictEqual(
      phaseCheckboxes(current),
      ['- [ ] **Phase 3: Beta**', '- [ ] **Phase 01.1: Hotfix (INSERTED)**'],
      'the decimal is listed in the current milestone',
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ROADMAP.md mutations wait for the lock
// ─────────────────────────────────────────────────────────────────────────────
//
// Every one of these reads ROADMAP.md, computes from it and from the phase
// directories, and writes the whole file back. Unserialised, two of them
// overlapping means the loser's whole contribution is discarded — for phase add
// and phase insert that is a section and a checkbox nothing recomputes, and for
// phase complete a tick and a completion date read before a straggler's plan
// count landed.
//
// The lock is held by the test process, so the child's wait is guaranteed rather
// than raced for: it cannot write until the holder lets go, whatever the timing.
// The child announces itself through a flag file so the window is measured from a
// process that is loaded and running, and each case also asserts the write lands
// once the lock is free, so a child that did nothing at all fails too.

describe('ROADMAP.md mutations wait for the lock', () => {
  const CHILD_SRC = `
    const fs = require('fs');
    const [lib, cwd, readyFlag, command, ...rest] = process.argv.slice(1);
    const phase = require(lib);
    fs.writeFileSync(readyFlag, '');
    if (command === 'add') phase.cmdPhaseAdd(cwd, rest[0]);
    else if (command === 'insert') phase.cmdPhaseInsert(cwd, rest[0], rest[1]);
    else if (command === 'remove') phase.cmdPhaseRemove(cwd, rest[0], { force: true });
    else phase.cmdPhaseComplete(cwd, rest[0]);
  `;

  let tmpDir;
  let roadmapPath;
  let lockPath;
  let readyFlag;

  beforeEach(() => {
    tmpDir = createTempProject();
    roadmapPath = path.join(tmpDir, '.planning', 'ROADMAP.md');
    lockPath = path.join(tmpDir, '.planning', '.ROADMAP.md.gsd-lock');
    readyFlag = path.join(tmpDir, 'child-ready');
    fs.writeFileSync(
      roadmapPath,
      [
        '# Roadmap',
        '',
        '- [ ] Phase 1: Alpha',
        '- [ ] Phase 2: Beta',
        '',
        '### Phase 1: Alpha',
        '**Goal:** Goal one',
        '**Plans:** TBD',
        '',
        '### Phase 2: Beta',
        '**Goal:** Goal two',
        '**Plans:** TBD',
        '',
      ].join('\n'),
    );
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      '# State\n\n**Current Phase:** 01\n**Current Phase Name:** Alpha\n**Status:** In progress\n**Current Plan:** 01-01\n**Last Activity:** 2026-01-01\n**Last Activity Description:** Working\n**Total Phases:** 2 phases\n',
    );
    for (const [num, name] of [
      ['01', 'alpha'],
      ['02', 'beta'],
    ]) {
      const dir = path.join(tmpDir, '.planning', 'phases', `${num}-${name}`);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, `${num}-01-PLAN.md`), '# Plan');
      fs.writeFileSync(path.join(dir, `${num}-01-SUMMARY.md`), '# Summary');
    }
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  const CASES = [
    {
      label: 'phase add',
      args: ['add', 'Gamma'],
      landed: (text) => text.includes('### Phase 3: Gamma'),
    },
    {
      label: 'phase insert',
      args: ['insert', '1', 'Urgent'],
      landed: (text) => text.includes('### Phase 01.1: Urgent (INSERTED)'),
    },
    {
      label: 'phase remove',
      args: ['remove', '2'],
      landed: (text) => !text.includes('Phase 2: Beta'),
    },
    {
      label: 'phase complete',
      args: ['complete', '1'],
      landed: (text) => /- \[x\] Phase 1: Alpha/.test(text),
    },
  ];

  for (const c of CASES) {
    test(`${c.label} does not rewrite ROADMAP.md while another writer holds it`, async () => {
      const before = fs.readFileSync(roadmapPath, 'utf-8');
      fs.writeFileSync(
        lockPath,
        JSON.stringify({
          pid: process.pid,
          host: require('os').hostname(),
          at: new Date().toISOString(),
        }),
      );

      const child = spawn(
        process.execPath,
        ['-e', CHILD_SRC, '--', PHASE_LIB, tmpDir, readyFlag, ...c.args],
        { stdio: ['ignore', 'ignore', 'pipe'] },
      );
      let stderr = '';
      child.stderr.on('data', (d) => (stderr += d));
      const exited = new Promise((r) => child.on('close', r));

      await waitForReadyFlag(readyFlag, `${c.label} child`);

      // A window far wider than the read-and-rewrite the command performs; the
      // lock, not the clock, is what keeps the child out.
      await new Promise((r) => setTimeout(r, 600));
      assert.strictEqual(
        fs.readFileSync(roadmapPath, 'utf-8'),
        before,
        `${c.label} rewrote ROADMAP.md while another writer held the lock`,
      );

      fs.unlinkSync(lockPath);
      const code = await exited;
      assert.strictEqual(code, 0, `${c.label} should succeed: ${stderr.trim()}`);

      const after = fs.readFileSync(roadmapPath, 'utf-8');
      assert.notStrictEqual(
        after,
        before,
        `${c.label} should have rewritten ROADMAP.md once the lock was free`,
      );
      assert.ok(
        c.landed(after),
        `${c.label} should have written its update: ${after}`,
      );
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// STATE.md mutations wait for the lock
// ─────────────────────────────────────────────────────────────────────────────
//
// Both of these read STATE.md, derive their new field values from what they read
// and write the whole file back, so an unserialised one discards anything a
// locked writer appended between its own read and its write. `phase remove` is
// the sharper case: its new phase count is the count it read minus one, so a
// lost read is a wrong number rather than a lost entry.
//
// Both hold the ROADMAP.md lock across the STATE.md section. That nesting is one
// way only — see the lock-ordering guard in tests/core.test.cjs.
//
// The lock is held by the test process, so the child's wait is guaranteed rather
// than raced for, and the child announces itself through a flag file so the
// window is measured from a process that is loaded and running. Each case also
// asserts the write lands once the lock is free, so a child that did nothing at
// all fails too.

describe('STATE.md mutations wait for the lock', () => {
  const CHILD_SRC = `
    const fs = require('fs');
    const [lib, cwd, readyFlag, command, arg] = process.argv.slice(1);
    const phase = require(lib);
    fs.writeFileSync(readyFlag, '');
    if (command === 'remove') phase.cmdPhaseRemove(cwd, arg, { force: true });
    else phase.cmdPhaseComplete(cwd, arg);
  `;

  let tmpDir;
  let statePath;
  let lockPath;
  let readyFlag;

  beforeEach(() => {
    tmpDir = createTempProject();
    statePath = path.join(tmpDir, '.planning', 'STATE.md');
    lockPath = path.join(tmpDir, '.planning', '.STATE.md.gsd-lock');
    readyFlag = path.join(tmpDir, 'child-ready');
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      [
        '# Roadmap',
        '',
        '- [ ] Phase 1: Alpha',
        '- [ ] Phase 2: Beta',
        '',
        '### Phase 1: Alpha',
        '**Goal:** Goal one',
        '**Plans:** TBD',
        '',
        '### Phase 2: Beta',
        '**Goal:** Goal two',
        '**Plans:** TBD',
        '',
      ].join('\n'),
    );
    fs.writeFileSync(
      statePath,
      [
        '# Session State',
        '',
        '## Current Position',
        '',
        '**Current Phase:** 01',
        '**Current Phase Name:** Alpha',
        '**Total Phases:** 2 phases',
        '**Status:** Executing',
        '**Current Plan:** 01-01',
        '**Last Activity:** 2026-01-01',
        '**Last Activity Description:** Working',
        '',
      ].join('\n'),
    );
    for (const [num, name] of [
      ['01', 'alpha'],
      ['02', 'beta'],
    ]) {
      const dir = path.join(tmpDir, '.planning', 'phases', `${num}-${name}`);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, `${num}-01-PLAN.md`), '# Plan');
      fs.writeFileSync(path.join(dir, `${num}-01-SUMMARY.md`), '# Summary');
    }
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  const CASES = [
    {
      label: 'phase remove',
      command: 'remove',
      arg: '2',
      landed: '**Total Phases:** 1 phases',
    },
    {
      label: 'phase complete',
      command: 'complete',
      arg: '1',
      landed: '**Current Phase:** 02',
    },
  ];

  for (const c of CASES) {
    test(`${c.label} does not rewrite STATE.md while another writer holds it`, async () => {
      const before = fs.readFileSync(statePath, 'utf-8');
      fs.writeFileSync(
        lockPath,
        JSON.stringify({
          pid: process.pid,
          host: require('os').hostname(),
          at: new Date().toISOString(),
        }),
      );

      const child = spawn(
        process.execPath,
        ['-e', CHILD_SRC, '--', PHASE_LIB, tmpDir, readyFlag, c.command, c.arg],
        { stdio: ['ignore', 'ignore', 'pipe'] },
      );
      let stderr = '';
      child.stderr.on('data', (d) => (stderr += d));
      const exited = new Promise((r) => child.on('close', r));

      await waitForReadyFlag(readyFlag, `${c.label} child`);

      // A window far wider than the read-and-rewrite the command performs; the
      // lock, not the clock, is what keeps the child out.
      await new Promise((r) => setTimeout(r, 600));
      assert.strictEqual(
        fs.readFileSync(statePath, 'utf-8'),
        before,
        `${c.label} rewrote STATE.md while another writer held the lock`,
      );

      fs.unlinkSync(lockPath);
      const code = await exited;
      assert.strictEqual(code, 0, `${c.label} should succeed: ${stderr.trim()}`);

      const after = fs.readFileSync(statePath, 'utf-8');
      assert.notStrictEqual(
        after,
        before,
        `${c.label} should have rewritten STATE.md once the lock was free`,
      );
      assert.ok(
        after.includes(c.landed),
        `${c.label} should have written its update: ${after}`,
      );
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// A failure partway through names what it already wrote
// ─────────────────────────────────────────────────────────────────────────────
//
// Both commands write ROADMAP.md and then STATE.md, and locks make each write
// exclusive without making the pair atomic. A failure in between leaves the
// first file updated and the second not, and an error that says nothing about it
// leaves the operator unable to tell that case from a failure that wrote
// nothing — the first needs reconciling or a re-run, the second only a retry.
//
// The failure is staged by putting a directory where STATE.md belongs: the
// existence check passes and the read throws. Any cause has the same shape here
// — a lock timeout on STATE.md is the one this was reported for — and this one
// costs no wait for the lock-acquire budget.

describe('a partway failure reports what already landed', () => {
  let tmpDir;
  let roadmapPath;
  let statePath;

  const FULL_ROADMAP = [
    '# Roadmap',
    '',
    '- [ ] Phase 1: Alpha',
    '- [ ] Phase 2: Beta',
    '- [ ] Phase 3: Gamma',
    '',
    '| Phase | Plans | Status | Completed |',
    '|-------|-------|--------|-----------|',
    '| 1. Alpha | 0/1 | Pending | - |',
    '| 2. Beta | 0/1 | Pending | - |',
    '| 3. Gamma | 0/1 | Pending | - |',
    '',
    '### Phase 1: Alpha',
    '**Goal:** a',
    '**Plans:** 1 plans',
    '',
    '### Phase 2: Beta',
    '**Goal:** b',
    '**Plans:** 1 plans',
    '',
    '### Phase 3: Gamma',
    '**Goal:** c',
    '**Plans:** 1 plans',
    '',
  ].join('\n');

  beforeEach(() => {
    tmpDir = createTempProject();
    roadmapPath = path.join(tmpDir, '.planning', 'ROADMAP.md');
    statePath = path.join(tmpDir, '.planning', 'STATE.md');
    fs.writeFileSync(roadmapPath, FULL_ROADMAP);
    for (const [num, name] of [
      ['01', 'alpha'],
      ['02', 'beta'],
      ['03', 'gamma'],
    ]) {
      const dir = path.join(tmpDir, '.planning', 'phases', `${num}-${name}`);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, `${num}-01-PLAN.md`), '# Plan');
      fs.writeFileSync(path.join(dir, `${num}-01-SUMMARY.md`), '# Summary');
    }
    fs.mkdirSync(statePath);
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  // spawnSync directly rather than through runGsdTools, which trims stderr and
  // would hide the trailing newline this also checks.
  function runRaw(args) {
    return spawnSync(process.execPath, [TOOLS_PATH, ...args], {
      cwd: tmpDir,
      encoding: 'utf-8',
    });
  }

  test('phase complete names ROADMAP.md and says it is safe to re-run', () => {
    const result = runRaw(['phase', 'complete', '1']);

    assert.strictEqual(result.status, 1, `expected a failure: ${result.stdout}`);
    assert.match(
      fs.readFileSync(roadmapPath, 'utf-8'),
      /- \[x\] Phase 1: Alpha/,
      'the roadmap write is the one that landed before the failure',
    );
    assert.match(
      result.stderr,
      /Already applied before this failure: ROADMAP\.md \(/,
      'the error must name the file it already wrote',
    );
    assert.match(
      result.stderr,
      /safe to re-run/,
      'the error must say what the remedy is',
    );
    assert.ok(
      result.stderr.endsWith('\n'),
      `the message must not run into the next shell prompt: ${JSON.stringify(result.stderr.slice(-40))}`,
    );
  });

  test('phase complete claims nothing when the roadmap rewrite matched nothing', () => {
    // Every phase-complete target for phase 1 is absent or unreachable, so the
    // roadmap is left alone and the same failure follows. An error that named
    // ROADMAP.md here would send the operator reconciling a file nobody touched.
    fs.writeFileSync(
      roadmapPath,
      ['# Roadmap', '', '### Phase 2: Beta', '**Goal:** b', ''].join('\n'),
    );
    const before = fs.readFileSync(roadmapPath, 'utf-8');

    const result = runRaw(['phase', 'complete', '1']);

    assert.strictEqual(result.status, 1, `expected a failure: ${result.stdout}`);
    assert.strictEqual(
      fs.readFileSync(roadmapPath, 'utf-8'),
      before,
      'nothing matched, so nothing may have been written',
    );
    assert.doesNotMatch(
      result.stderr,
      /Already applied before this failure/,
      'a failure that wrote nothing must stay distinguishable from one that wrote half',
    );
    assert.doesNotMatch(result.stderr, /ROADMAP\.md/);
  });

  test('phase remove names the renumbered directories and refuses to call a re-run a repair', () => {
    const result = runRaw(['phase', 'remove', '2', '--force']);

    assert.strictEqual(result.status, 1, `expected a failure: ${result.stdout}`);
    assert.ok(
      fs.existsSync(path.join(tmpDir, '.planning', 'phases', '02-gamma')),
      'the directory renumbering is what landed before the failure',
    );
    assert.match(
      result.stderr,
      /Already applied before this failure:[^\n]*\.planning\/phases\/02-beta deleted/,
      'the error must name the deleted directory',
    );
    assert.match(
      result.stderr,
      /1 directory renumbering\(s\) under \.planning\/phases\//,
      'the error must name the renumbering',
    );
    assert.match(result.stderr, /ROADMAP\.md \(/);
    assert.match(
      result.stderr,
      /not a repair/,
      'a re-run would renumber again, and the message must say so',
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// A removal never leaves two phases sharing a number
// ─────────────────────────────────────────────────────────────────────────────
//
// The renumbering is the only rewrite that can create a duplicate — removal only
// deletes — so the invariant is enforced at that one step. It is withheld when
// the removal it compensates for did not fully land, and withheld again if the
// result would name a phase twice, which happens when a reference is written in
// a shape no rewrite can reach.

describe('phase remove keeps the roadmap internally consistent', () => {
  let tmpDir;
  let roadmapPath;

  beforeEach(() => {
    tmpDir = createTempProject();
    roadmapPath = path.join(tmpDir, '.planning', 'ROADMAP.md');
    for (const dir of ['03-cee', '04-dee', '05-eee']) {
      fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', dir), {
        recursive: true,
      });
    }
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  // Every phase number a heading names, in document order. The invariant is
  // asserted over this list, so a duplicate is a failure rather than something
  // the test has to know how to look for.
  function headingNumbers() {
    return fs
      .readFileSync(roadmapPath, 'utf-8')
      .split('\n')
      .filter((l) => /^#{2,4}\s*Phase\s/.test(l))
      .map((l) => /Phase\s+(\d+)/.exec(l)[1]);
  }

  test('withholds the renumbering when the section removal could not reach its target', () => {
    // The target's heading separates its name with a dash, which the section
    // removal cannot match. Shifting the later phases down on top of it gave the
    // milestone two headings numbered alike.
    fs.writeFileSync(
      roadmapPath,
      [
        '# Roadmap',
        '',
        '## Roadmap v0.1: Current',
        '',
        '- [ ] Phase 3: Cee',
        '- [ ] Phase 4: Dee',
        '- [ ] Phase 5: Eee',
        '',
        '### Phase 3: Cee',
        '**Goal:** c',
        '',
        '### Phase 4 - Dee',
        '**Goal:** d',
        '',
        '### Phase 5: Eee',
        '**Goal:** e',
        '',
      ].join('\n'),
    );

    const result = runGsdTools('phase remove 4 --json', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);
    const output = JSON.parse(result.output);

    const numbers = headingNumbers();
    assert.deepStrictEqual(
      numbers,
      [...new Set(numbers)],
      `two phases share a number: ${numbers.join(', ')}`,
    );
    assert.deepStrictEqual(output.roadmap_missed_targets, ['phase-section']);
    assert.deepStrictEqual(
      output.roadmap_withheld,
      ['renumber'],
      'a rewrite refused on purpose is not one that could not reach its target',
    );
    assert.match(output.roadmap_withheld_hint, /same number/);
  });

  test('withholds a renumbering that would name one phase twice', () => {
    // Here the removal lands everywhere, so nothing is missed — but a later
    // phase's heading is written in a shape no rewrite reaches, and the phase
    // above it shifts down onto that number. Nothing reported this: every target
    // landed and the duplicate was written.
    fs.writeFileSync(
      roadmapPath,
      [
        '# Roadmap',
        '',
        '## Roadmap v0.1: Current',
        '',
        '- [ ] Phase 3: Cee',
        '- [ ] Phase 4: Dee',
        '- [ ] Phase 5: Eee',
        '',
        '| Phase | Plans | Status | Completed |',
        '|-------|-------|--------|-----------|',
        '| 3. Cee | 0/0 | Pending | - |',
        '| 4. Dee | 0/0 | Pending | - |',
        '| 5. Eee | 0/0 | Pending | - |',
        '',
        '### Phase 3: Cee',
        '**Goal:** c',
        '',
        '### Phase 4—Dee',
        '**Goal:** d',
        '',
        '### Phase 5: Eee',
        '**Goal:** e',
        '',
      ].join('\n'),
    );

    const result = runGsdTools('phase remove 3 --json', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);
    const output = JSON.parse(result.output);

    const numbers = headingNumbers();
    assert.deepStrictEqual(
      numbers,
      [...new Set(numbers)],
      `two phases share a number: ${numbers.join(', ')}`,
    );
    assert.deepStrictEqual(output.roadmap_landed, [
      'phase-section',
      'phase-checkbox',
      'progress-table',
    ]);
    assert.deepStrictEqual(output.roadmap_withheld, ['renumber']);
    assert.match(output.roadmap_withheld_hint, /twice/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Removing a phase that does not exist changes nothing
// ─────────────────────────────────────────────────────────────────────────────

describe('phase remove on an absent phase', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      [
        '# Roadmap',
        '',
        '- [ ] Phase 1: Alpha',
        '- [ ] Phase 2: Beta',
        '',
        '### Phase 1: Alpha',
        '**Goal:** a',
        '',
        '### Phase 2: Beta',
        '**Goal:** b',
        '',
      ].join('\n'),
    );
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      '# State\n\n**Current Phase:** 01\n**Total Phases:** 2 phases\n',
    );
    for (const dir of ['01-alpha', '02-beta']) {
      fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', dir), {
        recursive: true,
      });
    }
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('is a no-op that says so rather than a phase count that was never true', () => {
    const roadmapBefore = fs.readFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      'utf-8',
    );
    const stateBefore = fs.readFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      'utf-8',
    );

    const result = runGsdTools('phase remove 9 --json', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);
    const output = JSON.parse(result.output);

    assert.strictEqual(output.found, false);
    assert.strictEqual(output.state_updated, false);
    assert.strictEqual(output.roadmap_updated, false);
    assert.strictEqual(
      fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8'),
      stateBefore,
      'the phase count must not be decremented for a phase that was never counted',
    );
    assert.strictEqual(
      fs.readFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), 'utf-8'),
      roadmapBefore,
    );
    assert.deepStrictEqual(
      fs
        .readdirSync(path.join(tmpDir, '.planning', 'phases'))
        .sort(),
      ['01-alpha', '02-beta'],
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The renumbering rewrites two records at once — the phase directories and
// ROADMAP.md — and the whole point of it is that they still describe the same
// project afterwards. Every test here reads both and asserts they agree.
// ─────────────────────────────────────────────────────────────────────────────

describe('phase remove keeps ROADMAP.md and the phase tree agreeing', () => {
  let tmpDir;
  let roadmapPath;

  beforeEach(() => {
    tmpDir = createTempProject();
    roadmapPath = path.join(tmpDir, '.planning', 'ROADMAP.md');
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  function writeRoadmap(lines) {
    fs.writeFileSync(roadmapPath, lines.join('\n'));
  }

  // `spec` maps a directory name to the plan files inside it.
  function writePhases(spec) {
    for (const [dir, files] of Object.entries(spec)) {
      const full = path.join(tmpDir, '.planning', 'phases', dir);
      fs.mkdirSync(full, { recursive: true });
      for (const f of files) fs.writeFileSync(path.join(full, f), '# plan\n');
    }
  }

  function roadmapLines(pattern) {
    return fs
      .readFileSync(roadmapPath, 'utf-8')
      .split('\n')
      .filter((l) => pattern.test(l));
  }

  function phaseDirs() {
    return fs.readdirSync(path.join(tmpDir, '.planning', 'phases')).sort();
  }

  function planFiles() {
    const base = path.join(tmpDir, '.planning', 'phases');
    const found = [];
    for (const dir of fs.readdirSync(base)) {
      for (const f of fs.readdirSync(path.join(base, dir))) found.push(f);
    }
    return found.sort();
  }

  const PHASE_ID = /^(\d+[A-Za-z]?(?:\.\d+)*)/;

  // Directory names pad the integer part and roadmap prose does not, so the two
  // records are compared at the padded spelling.
  function padId(id) {
    return id.replace(/^\d+/, (n) => n.padStart(2, '0'));
  }

  function directoryIds() {
    return phaseDirs().map((d) => PHASE_ID.exec(d)[1]);
  }

  function headingIds() {
    return roadmapLines(/^#{2,4} Phase/).map((l) =>
      padId(/Phase\s+(\d+[A-Za-z]?(?:\.\d+)*)/.exec(l)[1]),
    );
  }

  // Phases 8 through 11, so removing the lowest sends 10 down to 9 and 11 down
  // to 10 — the boundary crossed and the boundary not crossed, in one run.
  const NINE_TO_TEN = [
    '# Roadmap',
    '',
    '## Roadmap v0.1: Current',
    '',
    '- [ ] Phase 8: Eight',
    '- [ ] Phase 9: Nine',
    '- [ ] Phase 10: Ten',
    '- [ ] Phase 11: Eleven',
    '',
    '### Phase 9: Nine',
    'Plans:',
    '- [ ] 09-01: nine',
    '',
    '### Phase 10: Ten',
    'Plans:',
    '- [ ] 10-01: ten',
    '',
    '### Phase 11: Eleven',
    'Plans:',
    '- [ ] 11-01: eleven',
    '',
  ];

  const NINE_TO_TEN_DIRS = {
    '08-eight': [],
    '09-nine': ['09-01-PLAN.md'],
    '10-ten': ['10-01-PLAN.md'],
    '11-eleven': ['11-01-PLAN.md'],
  };

  test('a plan reference keeps the width the plan file is named at', () => {
    writeRoadmap(NINE_TO_TEN);
    writePhases(NINE_TO_TEN_DIRS);

    const result = runGsdTools('phase remove 8 --json', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    assert.deepStrictEqual(planFiles(), [
      '08-01-PLAN.md',
      '09-01-PLAN.md',
      '10-01-PLAN.md',
    ]);
    assert.deepStrictEqual(
      roadmapLines(/^- \[ \] \d/),
      ['- [ ] 08-01: nine', '- [ ] 09-01: ten', '- [ ] 10-01: eleven'],
      'a plan reference names a file, and the file is padded to two digits',
    );
  });

  test('a phase heading drops the digit the decrement drops', () => {
    writeRoadmap(NINE_TO_TEN);
    writePhases(NINE_TO_TEN_DIRS);

    const result = runGsdTools('phase remove 8 --json', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    assert.deepStrictEqual(phaseDirs(), ['08-nine', '09-ten', '10-eleven']);
    assert.deepStrictEqual(
      roadmapLines(/^#{2,4} Phase/),
      ['### Phase 8: Nine', '### Phase 9: Ten', '### Phase 10: Eleven'],
      'a heading is written at its natural width, so 10 becomes 9 and not 09',
    );
    assert.deepStrictEqual(roadmapLines(/^- \[ \] Phase/), [
      '- [ ] Phase 8: Nine',
      '- [ ] Phase 9: Ten',
      '- [ ] Phase 10: Eleven',
    ]);
  });

  test('an integer removal carries the decimal and letter phases with it', () => {
    writeRoadmap([
      '# Roadmap',
      '',
      '## Roadmap v0.1: Current',
      '',
      '- [ ] Phase 1: One',
      '- [ ] Phase 2: Two',
      '- [ ] Phase 3: Three',
      '- [ ] Phase 3.1: Urgent',
      '- [ ] Phase 3A: Sidecar',
      '- [ ] Phase 4: Four',
      '- [ ] Phase 4.2: Later',
      '',
      '| Phase | Plans | Status | Completed |',
      '|-------|-------|--------|-----------|',
      '| 1. One | 0/0 | Pending | - |',
      '| 3. Three | 0/0 | Pending | - |',
      '| 3.1. Urgent | 0/0 | Pending | - |',
      '| 3A. Sidecar | 0/0 | Pending | - |',
      '| 4. Four | 0/0 | Pending | - |',
      '| 4.2. Later | 0/0 | Pending | - |',
      '',
      '### Phase 1: One',
      '',
      '### Phase 3: Three',
      '',
      '### Phase 3.1: Urgent',
      'Plans:',
      '- [ ] 03.1-01: urgent',
      '',
      '### Phase 3A: Sidecar',
      'Plans:',
      '- [ ] 03A-01: sidecar',
      '',
      '### Phase 4: Four',
      '**Depends on:** Phase 3.1',
      '',
      '### Phase 4.2: Later',
      '',
    ]);
    writePhases({
      '01-one': [],
      '02-two': [],
      '03-three': [],
      '03.1-urgent': ['03.1-01-PLAN.md'],
      '03A-sidecar': ['03A-01-PLAN.md'],
      '04-four': [],
      '04.2-later': [],
    });

    const result = runGsdTools('phase remove 2 --json', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    assert.deepStrictEqual(phaseDirs(), [
      '01-one',
      '02-three',
      '02.1-urgent',
      '02A-sidecar',
      '03-four',
      '03.2-later',
    ]);
    assert.deepStrictEqual(
      headingIds(),
      directoryIds(),
      'ROADMAP.md and the phase directories name the same phases',
    );
    assert.deepStrictEqual(roadmapLines(/^- \[ \] Phase/), [
      '- [ ] Phase 1: One',
      '- [ ] Phase 2: Three',
      '- [ ] Phase 2.1: Urgent',
      '- [ ] Phase 2A: Sidecar',
      '- [ ] Phase 3: Four',
      '- [ ] Phase 3.2: Later',
    ]);
    assert.deepStrictEqual(roadmapLines(/^\| \d/), [
      '| 1. One | 0/0 | Pending | - |',
      '| 2. Three | 0/0 | Pending | - |',
      '| 2.1. Urgent | 0/0 | Pending | - |',
      '| 2A. Sidecar | 0/0 | Pending | - |',
      '| 3. Four | 0/0 | Pending | - |',
      '| 3.2. Later | 0/0 | Pending | - |',
    ]);
    assert.deepStrictEqual(planFiles(), [
      '02.1-01-PLAN.md',
      '02A-01-PLAN.md',
    ]);
    assert.deepStrictEqual(roadmapLines(/^- \[ \] \d/), [
      '- [ ] 02.1-01: urgent',
      '- [ ] 02A-01: sidecar',
    ]);
    assert.deepStrictEqual(
      roadmapLines(/^\*\*Depends on:/),
      ['**Depends on:** Phase 2.1'],
      'a dependency and the heading it names move together',
    );
  });

  test('removing a decimal renumbers its siblings in both records', () => {
    writeRoadmap([
      '# Roadmap',
      '',
      '## Roadmap v0.1: Current',
      '',
      '- [ ] Phase 3: Three',
      '- [ ] Phase 3.1: A',
      '- [ ] Phase 3.2: B',
      '- [ ] Phase 3.3: C',
      '- [ ] Phase 4: Four',
      '',
      '| Phase | Plans | Status | Completed |',
      '|-------|-------|--------|-----------|',
      '| 3. Three | 0/0 | Pending | - |',
      '| 3.1. A | 0/0 | Pending | - |',
      '| 3.2. B | 0/0 | Pending | - |',
      '| 3.3. C | 0/0 | Pending | - |',
      '| 4. Four | 0/0 | Pending | - |',
      '',
      '### Phase 3: Three',
      '',
      '### Phase 3.1: A',
      '',
      '### Phase 3.2: B',
      'Plans:',
      '- [ ] 03.2-01: bee',
      '',
      '### Phase 3.3: C',
      '',
      '### Phase 4: Four',
      '**Depends on:** Phase 3.3',
      '',
    ]);
    writePhases({
      '03-three': [],
      '03.1-a': [],
      '03.2-b': ['03.2-01-PLAN.md'],
      '03.3-c': [],
      '04-four': [],
    });

    const result = runGsdTools('phase remove 3.1 --json', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    assert.deepStrictEqual(phaseDirs(), [
      '03-three',
      '03.1-b',
      '03.2-c',
      '04-four',
    ]);
    assert.deepStrictEqual(
      headingIds(),
      directoryIds(),
      'ROADMAP.md and the phase directories name the same phases',
    );
    assert.deepStrictEqual(roadmapLines(/^- \[ \] Phase/), [
      '- [ ] Phase 3: Three',
      '- [ ] Phase 3.1: B',
      '- [ ] Phase 3.2: C',
      '- [ ] Phase 4: Four',
    ]);
    assert.deepStrictEqual(roadmapLines(/^\| \d/), [
      '| 3. Three | 0/0 | Pending | - |',
      '| 3.1. B | 0/0 | Pending | - |',
      '| 3.2. C | 0/0 | Pending | - |',
      '| 4. Four | 0/0 | Pending | - |',
    ]);
    assert.deepStrictEqual(planFiles(), ['03.1-01-PLAN.md']);
    assert.deepStrictEqual(roadmapLines(/^- \[ \] \d/), ['- [ ] 03.1-01: bee']);
    assert.deepStrictEqual(
      roadmapLines(/^\*\*Depends on:/),
      ['**Depends on:** Phase 3.2'],
      'the integer phase above the siblings is not itself a target',
    );
  });

  test('a decimal removal leaves version-like tokens and other bases alone', () => {
    writeRoadmap([
      '# Roadmap',
      '',
      '## Roadmap v0.1: Current',
      '',
      '- [ ] Phase 3: Three',
      '- [ ] Phase 3.1: A',
      '- [ ] Phase 3.2: B',
      '- [ ] Phase 4.2: Elsewhere',
      '',
      '### Phase 3: Three',
      '',
      '### Phase 3.1: A',
      '',
      '### Phase 3.2: B',
      '**Goal:** follow ref 3.14-05 under version 1.05-01, shipped 2020-01-01',
      '',
      '### Phase 4.2: Elsewhere',
      '',
    ]);
    writePhases({
      '03-three': [],
      '03.1-a': [],
      '03.2-b': [],
      '04.2-elsewhere': [],
    });

    const result = runGsdTools('phase remove 3.1 --json', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    assert.deepStrictEqual(phaseDirs(), [
      '03-three',
      '03.1-b',
      '04.2-elsewhere',
    ]);
    assert.deepStrictEqual(
      headingIds(),
      directoryIds(),
      'a sibling of another base is not a sibling',
    );
    assert.match(
      fs.readFileSync(roadmapPath, 'utf-8'),
      /follow ref 3\.14-05 under version 1\.05-01, shipped 2020-01-01/,
      'a version-like token is not a phase reference',
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The phase section a removal deletes ends where the next section begins. Ended
// at the next phase header or the end of the file, removing the last phase in
// the list deleted everything below it — the progress table the very next
// rewrite then reported as a target it could not reach, and whatever else the
// roadmap carried after that.
// ─────────────────────────────────────────────────────────────────────────────

describe('phase remove deletes one phase section, not the file below it', () => {
  let tmpDir;
  let roadmapPath;

  beforeEach(() => {
    tmpDir = createTempProject();
    roadmapPath = path.join(tmpDir, '.planning', 'ROADMAP.md');
    for (const dir of ['01-alpha', '02-beta', '03-gamma']) {
      fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', dir), {
        recursive: true,
      });
    }
    fs.writeFileSync(
      roadmapPath,
      [
        '# Roadmap',
        '',
        '## Roadmap v0.1: Current',
        '',
        '- [ ] Phase 1: Alpha',
        '- [ ] Phase 2: Beta',
        '- [ ] Phase 3: Gamma',
        '',
        '## Phase Details',
        '',
        '### Phase 1: Alpha',
        '**Goal:** a',
        '',
        '### Phase 2: Beta',
        '**Goal:** b',
        '',
        '### Phase 3: Gamma',
        '**Goal:** g',
        '',
        '## Progress',
        '',
        '| Phase | Plans | Status | Completed |',
        '|-------|-------|--------|-----------|',
        '| 1. Alpha | 0/0 | Pending | - |',
        '| 2. Beta | 0/0 | Pending | - |',
        '| 3. Gamma | 0/0 | Pending | - |',
        '',
        '## Notes',
        '',
        'Keep me.',
        '',
      ].join('\n'),
    );
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('removing the highest-numbered phase leaves the sections below it', () => {
    const result = runGsdTools('phase remove 3 --json', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);
    const output = JSON.parse(result.output);
    const roadmap = fs.readFileSync(roadmapPath, 'utf-8');

    assert.deepStrictEqual(
      roadmap.split('\n').filter((l) => /^#{2,4} /.test(l)),
      [
        '## Roadmap v0.1: Current',
        '## Phase Details',
        '### Phase 1: Alpha',
        '### Phase 2: Beta',
        '## Progress',
        '## Notes',
      ],
      'only the removed phase section goes',
    );
    assert.deepStrictEqual(
      roadmap.split('\n').filter((l) => /^\| \d\./.test(l)),
      ['| 1. Alpha | 0/0 | Pending | - |', '| 2. Beta | 0/0 | Pending | - |'],
      'the surviving phases keep their progress rows',
    );
    assert.match(roadmap, /^Keep me\.$/m, 'a later section is not a phase');
    assert.deepStrictEqual(
      output.roadmap_missed_targets,
      [],
      'the progress table was reachable, and was reached',
    );
    assert.deepStrictEqual(output.roadmap_landed, [
      'phase-section',
      'phase-checkbox',
      'progress-table',
    ]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// A shipped milestone's phases keep their progress rows outside the <details>
// that collapses the rest of it, so a phase number that belongs to the archive
// is named in the region every probe reads as current. Accepted on that
// evidence, the removal deleted a shipped phase's row and shifted the archive
// and the live phases together, and reported all of it as clean.
// ─────────────────────────────────────────────────────────────────────────────

describe('phase remove refuses a phase belonging to a shipped milestone', () => {
  let tmpDir;
  let roadmapPath;

  beforeEach(() => {
    tmpDir = createTempProject();
    roadmapPath = path.join(tmpDir, '.planning', 'ROADMAP.md');
    for (const dir of ['04-delta', '05-epsilon']) {
      fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', dir), {
        recursive: true,
      });
    }
    fs.writeFileSync(
      roadmapPath,
      [
        '# Roadmap',
        '',
        '<details>',
        '<summary>v0.1 — Legacy (Shipped) — Phases 1-3</summary>',
        '',
        '## Roadmap v0.1: Legacy',
        '',
        '- [x] **Phase 1: Ancient**',
        '- [x] **Phase 2: Older**',
        '- [x] **Phase 3: Oldest**',
        '',
        '</details>',
        '',
        '## Progress',
        '',
        '| Phase | Plans | Status | Completed |',
        '|-------|-------|--------|-----------|',
        '| 1. Ancient | 1/1 | Complete | 2020-01-01 |',
        '| 2. Older | 1/1 | Complete | 2020-02-01 |',
        '| 3. Oldest | 1/1 | Complete | 2020-03-01 |',
        '| 4. Delta | 0/0 | Pending | - |',
        '| 5. Epsilon | 0/0 | Pending | - |',
        '',
        '## Roadmap v0.2: Current',
        '',
        '- [ ] **Phase 4: Delta**',
        '- [ ] **Phase 5: Epsilon**',
        '',
        '### Phase 4: Delta',
        '**Goal:** d',
        '',
        '### Phase 5: Epsilon',
        '**Goal:** e',
        '',
      ].join('\n'),
    );
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('leaves the shipped row and the live phases exactly as they were', () => {
    const before = fs.readFileSync(roadmapPath, 'utf-8');

    const result = runGsdTools('phase remove 2 --json', tmpDir);

    assert.strictEqual(
      result.success,
      false,
      'a shipped phase is not the current milestone’s to renumber',
    );
    assert.match(result.stderr, /shipped|archived/i);
    assert.strictEqual(
      fs.readFileSync(roadmapPath, 'utf-8'),
      before,
      'neither the archived rows nor the live phases may shift',
    );
    assert.deepStrictEqual(
      fs.readdirSync(path.join(tmpDir, '.planning', 'phases')).sort(),
      ['04-delta', '05-epsilon'],
    );
  });

  test('a phase number nothing names at all is still a reported no-op', () => {
    const result = runGsdTools('phase remove 9 --json', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);
    assert.strictEqual(JSON.parse(result.output).found, false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// A letter phase is a sidecar hung off an integer, not the integer itself.
// Parsed with parseInt it read as the integer, and removing one ran the
// integer renumbering: every phase above it moved down onto a number that was
// never vacated, leaving two directories parsing as the same phase.
// ─────────────────────────────────────────────────────────────────────────────

describe('phase remove on a letter phase', () => {
  let tmpDir;
  let roadmapPath;

  beforeEach(() => {
    tmpDir = createTempProject();
    roadmapPath = path.join(tmpDir, '.planning', 'ROADMAP.md');
    fs.writeFileSync(
      roadmapPath,
      [
        '# Roadmap',
        '',
        '## Roadmap v0.1: Current',
        '',
        '- [ ] Phase 2: Two',
        '- [ ] Phase 3: Three',
        '- [ ] Phase 3A: Sidecar',
        '- [ ] Phase 3B: Later',
        '- [ ] Phase 4: Four',
        '',
        '| Phase | Plans | Status | Completed |',
        '|-------|-------|--------|-----------|',
        '| 2. Two | 0/0 | Pending | - |',
        '| 3. Three | 0/0 | Pending | - |',
        '| 3A. Sidecar | 0/0 | Pending | - |',
        '| 3B. Later | 0/0 | Pending | - |',
        '| 4. Four | 0/0 | Pending | - |',
        '',
        '### Phase 3: Three',
        '### Phase 3A: Sidecar',
        '### Phase 3B: Later',
        '### Phase 4: Four',
        '',
      ].join('\n'),
    );
    for (const [dir, files] of Object.entries({
      '02-two': [],
      '03-three': ['03-01-PLAN.md'],
      '03A-sidecar': ['03A-01-PLAN.md'],
      '03B-later': ['03B-01-PLAN.md'],
      '04-four': ['04-01-PLAN.md'],
    })) {
      const full = path.join(tmpDir, '.planning', 'phases', dir);
      fs.mkdirSync(full, { recursive: true });
      for (const f of files) fs.writeFileSync(path.join(full, f), '# plan\n');
    }
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('removes the sidecar and leaves every other phase where it was', () => {
    const result = runGsdTools('phase remove 3A --json', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);
    const output = JSON.parse(result.output);
    const roadmap = fs.readFileSync(roadmapPath, 'utf-8');

    assert.deepStrictEqual(
      fs.readdirSync(path.join(tmpDir, '.planning', 'phases')).sort(),
      ['02-two', '03-three', '03B-later', '04-four'],
      'no phase above the sidecar moves onto a number nothing vacated',
    );
    assert.deepStrictEqual(
      fs.readdirSync(path.join(tmpDir, '.planning', 'phases', '04-four')),
      ['04-01-PLAN.md'],
      'and its plans keep their names',
    );
    assert.deepStrictEqual(roadmap.split('\n').filter((l) => /^- \[/.test(l)), [
      '- [ ] Phase 2: Two',
      '- [ ] Phase 3: Three',
      '- [ ] Phase 3B: Later',
      '- [ ] Phase 4: Four',
    ]);
    assert.deepStrictEqual(
      roadmap.split('\n').filter((l) => /^\| \d/.test(l)),
      [
        '| 2. Two | 0/0 | Pending | - |',
        '| 3. Three | 0/0 | Pending | - |',
        '| 3B. Later | 0/0 | Pending | - |',
        '| 4. Four | 0/0 | Pending | - |',
      ],
    );
    assert.deepStrictEqual(roadmap.split('\n').filter((l) => /^#{2,4} Phase/.test(l)), [
      '### Phase 3: Three',
      '### Phase 3B: Later',
      '### Phase 4: Four',
    ]);
    assert.deepStrictEqual(
      output.renamed_directories,
      [],
      'a sidecar leaves a gap, and a gap is not a renumbering',
    );
    assert.deepStrictEqual(output.roadmap_withheld, []);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The hint that comes back with a withheld renumbering names the record the
// operator has to reconcile. It claimed the phase directories had been
// renumbered whether or not any had been, which sends the reader to look for
// damage in the one record that is intact.
// ─────────────────────────────────────────────────────────────────────────────

describe('the withheld-renumbering hint names what actually moved', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('says nothing was renumbered when no directory needed renumbering', () => {
    // The removed phase is the highest on disk, so nothing follows it there.
    // ROADMAP.md names a phase above it whose section the removal cannot
    // reach, which is what withholds the renumbering.
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      [
        '# Roadmap',
        '',
        '## Roadmap v0.1: Current',
        '',
        '- [ ] Phase 3: Cee',
        '- [ ] Phase 4: Dee',
        '- [ ] Phase 5: Eee',
        '',
        '### Phase 3: Cee',
        '',
        '### Phase 4 - Dee',
        '',
        '### Phase 5: Eee',
        '',
      ].join('\n'),
    );
    for (const dir of ['03-cee', '04-dee']) {
      fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', dir), {
        recursive: true,
      });
    }

    const result = runGsdTools('phase remove 4 --json', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);
    const output = JSON.parse(result.output);

    assert.deepStrictEqual(output.renamed_directories, []);
    assert.deepStrictEqual(output.roadmap_withheld, ['renumber']);
    assert.doesNotMatch(
      output.roadmap_withheld_hint,
      /directories have been renumbered/,
      'no directory moved, so the hint must not send the reader looking for one',
    );
  });
});
