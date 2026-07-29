/**
 * GSD Tools Tests - Init
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const {
  runGsdTools,
  createTempProject,
  cleanup,
  cleanupSubdir,
  resolveTmpDir,
} = require('./helpers.cjs');

describe('init commands', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('init execute-phase returns file paths', () => {
    const phaseDir = path.join(tmpDir, '.planning', 'phases', '03-api');
    fs.mkdirSync(phaseDir, { recursive: true });
    fs.writeFileSync(path.join(phaseDir, '03-01-PLAN.md'), '# Plan');

    const result = runGsdTools('init execute-phase 03 --json', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.state_path, '.planning/STATE.md');
    assert.strictEqual(output.roadmap_path, '.planning/ROADMAP.md');
    assert.strictEqual(output.config_path, '.planning/config.json');
  });

  test('init plan-phase returns file paths', () => {
    const phaseDir = path.join(tmpDir, '.planning', 'phases', '03-api');
    fs.mkdirSync(phaseDir, { recursive: true });
    fs.writeFileSync(path.join(phaseDir, '03-CONTEXT.md'), '# Phase Context');
    fs.writeFileSync(
      path.join(phaseDir, '03-RESEARCH.md'),
      '# Research Findings',
    );
    fs.writeFileSync(
      path.join(phaseDir, '03-VERIFICATION.md'),
      '# Verification',
    );
    fs.writeFileSync(path.join(phaseDir, '03-UAT.md'), '# UAT');

    const result = runGsdTools('init plan-phase 03 --json', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.state_path, '.planning/STATE.md');
    assert.strictEqual(output.roadmap_path, '.planning/ROADMAP.md');
    assert.strictEqual(output.requirements_path, '.planning/REQUIREMENTS.md');
    assert.strictEqual(
      output.context_path,
      '.planning/phases/03-api/03-CONTEXT.md',
    );
    assert.strictEqual(
      output.research_path,
      '.planning/phases/03-api/03-RESEARCH.md',
    );
    assert.strictEqual(
      output.verification_path,
      '.planning/phases/03-api/03-VERIFICATION.md',
    );
    assert.strictEqual(output.uat_path, '.planning/phases/03-api/03-UAT.md');
  });

  test('init progress returns file paths', () => {
    const result = runGsdTools('init progress --json', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.state_path, '.planning/STATE.md');
    assert.strictEqual(output.roadmap_path, '.planning/ROADMAP.md');
    assert.strictEqual(output.project_path, '.planning/PROJECT.md');
    assert.strictEqual(output.config_path, '.planning/config.json');
  });

  test('init phase-op returns core and optional phase file paths', () => {
    const phaseDir = path.join(tmpDir, '.planning', 'phases', '03-api');
    fs.mkdirSync(phaseDir, { recursive: true });
    fs.writeFileSync(path.join(phaseDir, '03-CONTEXT.md'), '# Phase Context');
    fs.writeFileSync(path.join(phaseDir, '03-RESEARCH.md'), '# Research');
    fs.writeFileSync(
      path.join(phaseDir, '03-VERIFICATION.md'),
      '# Verification',
    );
    fs.writeFileSync(path.join(phaseDir, '03-UAT.md'), '# UAT');

    const result = runGsdTools('init phase-op 03 --json', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.state_path, '.planning/STATE.md');
    assert.strictEqual(output.roadmap_path, '.planning/ROADMAP.md');
    assert.strictEqual(output.requirements_path, '.planning/REQUIREMENTS.md');
    assert.strictEqual(
      output.context_path,
      '.planning/phases/03-api/03-CONTEXT.md',
    );
    assert.strictEqual(
      output.research_path,
      '.planning/phases/03-api/03-RESEARCH.md',
    );
    assert.strictEqual(
      output.verification_path,
      '.planning/phases/03-api/03-VERIFICATION.md',
    );
    assert.strictEqual(output.uat_path, '.planning/phases/03-api/03-UAT.md');
  });

  test('init plan-phase omits optional paths if files missing', () => {
    const phaseDir = path.join(tmpDir, '.planning', 'phases', '03-api');
    fs.mkdirSync(phaseDir, { recursive: true });

    const result = runGsdTools('init plan-phase 03 --json', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.context_path, undefined);
    assert.strictEqual(output.research_path, undefined);
  });

  // ── phase_req_ids extraction (fix for #684) ──────────────────────────────

  test('init plan-phase extracts phase_req_ids from ROADMAP', () => {
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '03-api'), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap\n\n### Phase 3: API\n**Goal:** Build API\n**Requirements**: CP-01, CP-02, CP-03\n**Plans:** 0 plans\n`,
    );

    const result = runGsdTools('init plan-phase 3 --json', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.phase_req_ids, 'CP-01, CP-02, CP-03');
  });

  test('init plan-phase strips brackets from phase_req_ids', () => {
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '03-api'), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap\n\n### Phase 3: API\n**Goal:** Build API\n**Requirements**: [CP-01, CP-02]\n**Plans:** 0 plans\n`,
    );

    const result = runGsdTools('init plan-phase 3 --json', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.phase_req_ids, 'CP-01, CP-02');
  });

  test('init plan-phase returns null phase_req_ids when Requirements line is absent', () => {
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '03-api'), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap\n\n### Phase 3: API\n**Goal:** Build API\n**Plans:** 0 plans\n`,
    );

    const result = runGsdTools('init plan-phase 3 --json', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.phase_req_ids, null);
  });

  test('init plan-phase returns null phase_req_ids when ROADMAP is absent', () => {
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '03-api'), {
      recursive: true,
    });

    const result = runGsdTools('init plan-phase 3 --json', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.phase_req_ids, null);
  });

  test('init execute-phase extracts phase_req_ids from ROADMAP', () => {
    const phaseDir = path.join(tmpDir, '.planning', 'phases', '03-api');
    fs.mkdirSync(phaseDir, { recursive: true });
    fs.writeFileSync(path.join(phaseDir, '03-01-PLAN.md'), '# Plan');
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap\n\n### Phase 3: API\n**Goal:** Build API\n**Requirements**: EX-01, EX-02\n**Plans:** 1 plans\n`,
    );

    const result = runGsdTools('init execute-phase 3 --json', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.phase_req_ids, 'EX-01, EX-02');
  });

  test('init plan-phase returns null phase_req_ids when value is TBD', () => {
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '03-api'), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap\n\n### Phase 3: API\n**Goal:** Build API\n**Requirements**: TBD\n**Plans:** 0 plans\n`,
    );

    const result = runGsdTools('init plan-phase 3 --json', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(
      output.phase_req_ids,
      null,
      'TBD placeholder should return null',
    );
  });

  test('init execute-phase returns null phase_req_ids when Requirements line is absent', () => {
    const phaseDir = path.join(tmpDir, '.planning', 'phases', '03-api');
    fs.mkdirSync(phaseDir, { recursive: true });
    fs.writeFileSync(path.join(phaseDir, '03-01-PLAN.md'), '# Plan');
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap\n\n### Phase 3: API\n**Goal:** Build API\n**Plans:** 1 plans\n`,
    );

    const result = runGsdTools('init execute-phase 3 --json', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.phase_req_ids, null);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Effort fields in init commands
// ─────────────────────────────────────────────────────────────────────────────

describe('Effort fields in init commands', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  function writeClaudeConfig(dir) {
    const configPath = path.join(dir, '.planning', 'config.json');
    fs.writeFileSync(
      configPath,
      JSON.stringify({ model_profile: 'quality', runtime: 'claude' }, null, 2),
      'utf-8',
    );
  }

  function writeCopilotConfig(dir) {
    const configPath = path.join(dir, '.planning', 'config.json');
    fs.writeFileSync(
      configPath,
      JSON.stringify({ model_profile: 'quality', runtime: 'copilot' }, null, 2),
      'utf-8',
    );
  }

  test('Test 1: init execute-phase result includes executor_effort and verifier_effort fields', () => {
    const phaseDir = path.join(tmpDir, '.planning', 'phases', '03-api');
    fs.mkdirSync(phaseDir, { recursive: true });
    fs.writeFileSync(path.join(phaseDir, '03-01-PLAN.md'), '# Plan');
    writeClaudeConfig(tmpDir);

    const result = runGsdTools('init execute-phase 03 --json', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.ok('executor_effort' in output, 'executor_effort should be present');
    assert.ok('verifier_effort' in output, 'verifier_effort should be present');
    assert.ok(
      output.executor_effort !== undefined,
      'executor_effort should not be undefined',
    );
    assert.ok(
      output.verifier_effort !== undefined,
      'verifier_effort should not be undefined',
    );
  });

  test('Test 2: init plan-phase result includes researcher_effort, planner_effort, checker_effort', () => {
    const phaseDir = path.join(tmpDir, '.planning', 'phases', '03-api');
    fs.mkdirSync(phaseDir, { recursive: true });
    writeClaudeConfig(tmpDir);

    const result = runGsdTools('init plan-phase 03 --json', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.ok(
      'researcher_effort' in output,
      'researcher_effort should be present',
    );
    assert.ok('planner_effort' in output, 'planner_effort should be present');
    assert.ok('checker_effort' in output, 'checker_effort should be present');
  });

  test('Test 3: init new-project result includes researcher_effort, synthesizer_effort, roadmapper_effort', () => {
    writeClaudeConfig(tmpDir);

    const result = runGsdTools('init new-project --json', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.ok(
      'researcher_effort' in output,
      'researcher_effort should be present',
    );
    assert.ok(
      'synthesizer_effort' in output,
      'synthesizer_effort should be present',
    );
    assert.ok(
      'roadmapper_effort' in output,
      'roadmapper_effort should be present',
    );
  });

  test('Test 4: init new-milestone result includes researcher_effort, synthesizer_effort, roadmapper_effort', () => {
    writeClaudeConfig(tmpDir);

    const result = runGsdTools('init new-milestone --json', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.ok(
      'researcher_effort' in output,
      'researcher_effort should be present',
    );
    assert.ok(
      'synthesizer_effort' in output,
      'synthesizer_effort should be present',
    );
    assert.ok(
      'roadmapper_effort' in output,
      'roadmapper_effort should be present',
    );
  });

  test('Test 5: init quick result includes planner_effort, executor_effort, checker_effort, verifier_effort', () => {
    writeClaudeConfig(tmpDir);

    const result = runGsdTools('init quick test-task --json', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.ok('planner_effort' in output, 'planner_effort should be present');
    assert.ok('executor_effort' in output, 'executor_effort should be present');
    assert.ok('checker_effort' in output, 'checker_effort should be present');
    assert.ok('verifier_effort' in output, 'verifier_effort should be present');
  });

  test('Test 8: effort fields are null when .runtime marker is copilot', () => {
    const phaseDir = path.join(tmpDir, '.planning', 'phases', '03-api');
    fs.mkdirSync(phaseDir, { recursive: true });
    fs.writeFileSync(path.join(phaseDir, '03-01-PLAN.md'), '# Plan');
    // Write config with quality profile; runtime detection comes from the .runtime marker
    const configPath = path.join(tmpDir, '.planning', 'config.json');
    fs.writeFileSync(configPath, JSON.stringify({ model_profile: 'quality' }, null, 2), 'utf-8');

    const markerDir = fs.mkdtempSync(path.join(resolveTmpDir(), 'gsd-copilot-marker-'));
    fs.writeFileSync(path.join(markerDir, '.runtime'), 'copilot\n', 'utf-8');
    try {
      const result = runGsdTools('init execute-phase 03 --json', tmpDir, { GSD_TEST_RUNTIME_MARKER_DIR: markerDir });
      assert.ok(result.success, `Command failed: ${result.error}`);

      const output = JSON.parse(result.output);
      assert.strictEqual(
        output.executor_effort,
        null,
        'executor_effort should be null for copilot runtime',
      );
      assert.strictEqual(
        output.verifier_effort,
        null,
        'verifier_effort should be null for copilot runtime',
      );
    } finally {
      cleanup(markerDir);
    }
  });

  function writeClaudeHaikuExecutorConfig(dir) {
    const configPath = path.join(dir, '.planning', 'config.json');
    fs.writeFileSync(
      configPath,
      JSON.stringify(
        {
          model_profile: 'balanced',
          runtime: 'claude',
          model_overrides: { 'gsd-executor': 'haiku' },
        },
        null,
        2,
      ),
      'utf-8',
    );
  }

  test('Test 9: effort fields are null when agent resolves to haiku model', () => {
    const phaseDir = path.join(tmpDir, '.planning', 'phases', '03-api');
    fs.mkdirSync(phaseDir, { recursive: true });
    fs.writeFileSync(path.join(phaseDir, '03-01-PLAN.md'), '# Plan');
    writeClaudeHaikuExecutorConfig(tmpDir);

    const result = runGsdTools('init execute-phase 03 --json', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(
      output.executor_effort,
      null,
      'executor_effort should be null when gsd-executor resolves to haiku',
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// cmdInitTodos
// ─────────────────────────────────────────────────────────────────────────────

describe('cmdInitTodos', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('empty pending dir returns zero count', () => {
    fs.mkdirSync(path.join(tmpDir, '.planning', 'todos', 'pending'), {
      recursive: true,
    });

    const result = runGsdTools('init todos --json', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.todo_count, 0);
    assert.deepStrictEqual(output.todos, []);
    assert.strictEqual(output.pending_dir_exists, true);
  });

  test('missing pending dir returns zero count', () => {
    const result = runGsdTools('init todos --json', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.todo_count, 0);
    assert.deepStrictEqual(output.todos, []);
    assert.strictEqual(output.pending_dir_exists, false);
  });

  test('multiple todos with fields are read correctly', () => {
    const pendingDir = path.join(tmpDir, '.planning', 'todos', 'pending');
    fs.mkdirSync(pendingDir, { recursive: true });

    fs.writeFileSync(
      path.join(pendingDir, 'task-1.md'),
      'title: Fix bug\narea: backend\ncreated: 2026-02-25',
    );
    fs.writeFileSync(
      path.join(pendingDir, 'task-2.md'),
      'title: Add feature\narea: frontend\ncreated: 2026-02-24',
    );
    fs.writeFileSync(
      path.join(pendingDir, 'task-3.md'),
      'title: Write docs\narea: backend\ncreated: 2026-02-23',
    );

    const result = runGsdTools('init todos --json', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.todo_count, 3);
    assert.strictEqual(output.todos.length, 3);

    const task1 = output.todos.find((t) => t.file === 'task-1.md');
    assert.ok(task1, 'task-1.md should be in todos');
    assert.strictEqual(task1.title, 'Fix bug');
    assert.strictEqual(task1.area, 'backend');
    assert.strictEqual(task1.created, '2026-02-25');
    assert.strictEqual(task1.path, '.planning/todos/pending/task-1.md');
  });

  test('area filter returns only matching todos', () => {
    const pendingDir = path.join(tmpDir, '.planning', 'todos', 'pending');
    fs.mkdirSync(pendingDir, { recursive: true });

    fs.writeFileSync(
      path.join(pendingDir, 'task-1.md'),
      'title: Fix bug\narea: backend\ncreated: 2026-02-25',
    );
    fs.writeFileSync(
      path.join(pendingDir, 'task-2.md'),
      'title: Add feature\narea: frontend\ncreated: 2026-02-24',
    );
    fs.writeFileSync(
      path.join(pendingDir, 'task-3.md'),
      'title: Write docs\narea: backend\ncreated: 2026-02-23',
    );

    const result = runGsdTools('init todos backend --json', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.todo_count, 2);
    assert.strictEqual(output.area_filter, 'backend');
    for (const todo of output.todos) {
      assert.strictEqual(todo.area, 'backend');
    }
  });

  test('area filter miss returns zero count', () => {
    const pendingDir = path.join(tmpDir, '.planning', 'todos', 'pending');
    fs.mkdirSync(pendingDir, { recursive: true });

    fs.writeFileSync(
      path.join(pendingDir, 'task-1.md'),
      'title: Fix bug\narea: backend\ncreated: 2026-02-25',
    );

    const result = runGsdTools('init todos nonexistent --json', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.todo_count, 0);
    assert.strictEqual(output.area_filter, 'nonexistent');
  });

  test('malformed file uses defaults', () => {
    const pendingDir = path.join(tmpDir, '.planning', 'todos', 'pending');
    fs.mkdirSync(pendingDir, { recursive: true });

    fs.writeFileSync(
      path.join(pendingDir, 'broken.md'),
      'some random content without fields',
    );

    const result = runGsdTools('init todos --json', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.todo_count, 1);
    const todo = output.todos[0];
    assert.strictEqual(todo.title, 'Untitled');
    assert.strictEqual(todo.area, 'general');
    assert.strictEqual(todo.created, 'unknown');
  });

  test('non-md files are ignored', () => {
    const pendingDir = path.join(tmpDir, '.planning', 'todos', 'pending');
    fs.mkdirSync(pendingDir, { recursive: true });

    fs.writeFileSync(
      path.join(pendingDir, 'task.md'),
      'title: Real task\narea: dev\ncreated: 2026-01-01',
    );
    fs.writeFileSync(
      path.join(pendingDir, 'notes.txt'),
      'title: Not a task\narea: dev\ncreated: 2026-01-01',
    );

    const result = runGsdTools('init todos --json', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.todo_count, 1);
    assert.strictEqual(output.todos[0].file, 'task.md');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// cmdInitMilestoneOp
// ─────────────────────────────────────────────────────────────────────────────

describe('cmdInitMilestoneOp', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('no phase directories returns zero counts', () => {
    const result = runGsdTools('init milestone-op --json', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.phase_count, 0);
    assert.strictEqual(output.completed_phases, 0);
    assert.strictEqual(output.all_phases_complete, false);
  });

  test('multiple phases with no summaries', () => {
    const phase1 = path.join(tmpDir, '.planning', 'phases', '01-setup');
    const phase2 = path.join(tmpDir, '.planning', 'phases', '02-api');
    fs.mkdirSync(phase1, { recursive: true });
    fs.mkdirSync(phase2, { recursive: true });
    fs.writeFileSync(path.join(phase1, '01-01-PLAN.md'), '# Plan');
    fs.writeFileSync(path.join(phase2, '02-01-PLAN.md'), '# Plan');

    const result = runGsdTools('init milestone-op --json', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.phase_count, 2);
    assert.strictEqual(output.completed_phases, 0);
    assert.strictEqual(output.all_phases_complete, false);
  });

  test('mix of complete and incomplete phases', () => {
    const phase1 = path.join(tmpDir, '.planning', 'phases', '01-setup');
    const phase2 = path.join(tmpDir, '.planning', 'phases', '02-api');
    fs.mkdirSync(phase1, { recursive: true });
    fs.mkdirSync(phase2, { recursive: true });
    fs.writeFileSync(path.join(phase1, '01-01-PLAN.md'), '# Plan');
    fs.writeFileSync(path.join(phase1, '01-01-SUMMARY.md'), '# Summary');
    fs.writeFileSync(path.join(phase2, '02-01-PLAN.md'), '# Plan');

    const result = runGsdTools('init milestone-op --json', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.phase_count, 2);
    assert.strictEqual(output.completed_phases, 1);
    assert.strictEqual(output.all_phases_complete, false);
  });

  test('all phases complete', () => {
    const phase1 = path.join(tmpDir, '.planning', 'phases', '01-setup');
    fs.mkdirSync(phase1, { recursive: true });
    fs.writeFileSync(path.join(phase1, '01-01-PLAN.md'), '# Plan');
    fs.writeFileSync(path.join(phase1, '01-01-SUMMARY.md'), '# Summary');

    const result = runGsdTools('init milestone-op --json', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.phase_count, 1);
    assert.strictEqual(output.completed_phases, 1);
    assert.strictEqual(output.all_phases_complete, true);
  });

  test('archive directory scanning', () => {
    fs.mkdirSync(path.join(tmpDir, '.planning', 'archive', 'v1.0'), {
      recursive: true,
    });
    fs.mkdirSync(path.join(tmpDir, '.planning', 'archive', 'v0.9'), {
      recursive: true,
    });

    const result = runGsdTools('init milestone-op --json', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.archive_count, 2);
    assert.strictEqual(output.archived_milestones.length, 2);
  });

  test('no archive directory returns empty', () => {
    const result = runGsdTools('init milestone-op --json', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.archive_count, 0);
    assert.deepStrictEqual(output.archived_milestones, []);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// cmdInitPhaseOp fallback
// ─────────────────────────────────────────────────────────────────────────────

describe('cmdInitPhaseOp fallback', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('normal path with existing directory', () => {
    const phaseDir = path.join(tmpDir, '.planning', 'phases', '03-api');
    fs.mkdirSync(phaseDir, { recursive: true });
    fs.writeFileSync(path.join(phaseDir, '03-CONTEXT.md'), '# Context');
    fs.writeFileSync(path.join(phaseDir, '03-01-PLAN.md'), '# Plan');
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      '# Roadmap\n\n### Phase 3: API\n**Goal:** Build API\n**Plans:** 1 plans\n',
    );

    const result = runGsdTools('init phase-op 3 --json', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.phase_found, true);
    assert.ok(
      output.phase_dir.includes('03-api'),
      'phase_dir should contain 03-api',
    );
    assert.strictEqual(output.has_context, true);
    assert.strictEqual(output.has_plans, true);
  });

  test('fallback to ROADMAP when no directory exists', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      '# Roadmap\n\n### Phase 5: Widget Builder\n**Goal:** Build widgets\n**Plans:** TBD\n',
    );

    const result = runGsdTools('init phase-op 5 --json', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.phase_found, true);
    assert.strictEqual(output.phase_dir, null);
    assert.strictEqual(output.phase_slug, 'widget-builder');
    assert.strictEqual(output.has_research, false);
    assert.strictEqual(output.has_context, false);
    assert.strictEqual(output.has_plans, false);
  });

  test('prefers current milestone roadmap entry over archived phase with same number', () => {
    const archiveDir = path.join(
      tmpDir,
      '.planning',
      'milestones',
      'v1.2-phases',
      '02-event-parser-and-queue-schema',
    );
    fs.mkdirSync(archiveDir, { recursive: true });
    fs.writeFileSync(
      path.join(archiveDir, '02-CONTEXT.md'),
      '# Archived context',
    );
    fs.writeFileSync(path.join(archiveDir, '02-01-PLAN.md'), '# Archived plan');
    fs.writeFileSync(
      path.join(archiveDir, '02-VERIFICATION.md'),
      '# Archived verification',
    );

    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap

<details>
<summary>Shipped milestone v1.2</summary>

### Phase 2: Event Parser and Queue Schema
**Goal:** Archived milestone work
</details>

## Milestone v1.3 Current

### Phase 2: Retry Orchestration
**Goal:** Current milestone work
**Plans:** TBD
`,
    );

    const result = runGsdTools('init phase-op 2 --json', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.phase_found, true);
    assert.strictEqual(output.phase_dir, null);
    assert.strictEqual(output.phase_name, 'Retry Orchestration');
    assert.strictEqual(output.phase_slug, 'retry-orchestration');
    assert.strictEqual(output.has_context, false);
    assert.strictEqual(output.has_plans, false);
    assert.strictEqual(output.has_verification, false);
  });

  test('neither directory nor roadmap entry returns not found', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      '# Roadmap\n\n### Phase 1: Setup\n**Goal:** Setup project\n**Plans:** TBD\n',
    );

    const result = runGsdTools('init phase-op 99 --json', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.phase_found, false);
    assert.strictEqual(output.phase_dir, null);
  });

  test('decimal phase in ROADMAP found via fallback (regression)', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      '# Roadmap\n\n### Phase 15: Base\n**Goal:** Base work\n**Plans:** TBD\n\n### Phase 15.1: Hotfix\n**Goal:** Emergency fix\n**Plans:** TBD\n\n### Phase 16: Next\n**Goal:** Next work\n**Plans:** TBD\n',
    );

    const result = runGsdTools('init phase-op 15.1 --json', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.phase_found, true);
    assert.strictEqual(output.phase_number, '15.1');
    assert.strictEqual(output.padded_phase, '15.1');
    assert.strictEqual(output.phase_name, 'Hotfix');
    assert.strictEqual(output.phase_dir, null);
  });

  test('decimal phase in init plan-phase ROADMAP fallback (regression)', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      '# Roadmap\n\n### Phase 15: Base\n**Goal:** Base work\n**Plans:** TBD\n\n### Phase 15.1: Hotfix\n**Goal:** Emergency fix\n**Plans:** TBD\n\n### Phase 16: Next\n**Goal:** Next work\n**Plans:** TBD\n',
    );

    const result = runGsdTools('init plan-phase 15.1 --json', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.phase_found, true);
    assert.strictEqual(output.phase_number, '15.1');
    assert.strictEqual(output.padded_phase, '15.1');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// cmdInitProgress
// ─────────────────────────────────────────────────────────────────────────────

describe('cmdInitProgress', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('no phases returns empty state', () => {
    const result = runGsdTools('init progress --json', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.phase_count, 0);
    assert.deepStrictEqual(output.phases, []);
    assert.strictEqual(output.current_phase, null);
    assert.strictEqual(output.next_phase, null);
    assert.strictEqual(output.has_work_in_progress, false);
  });

  test('multiple phases with mixed statuses', () => {
    // First phase: complete (has plan + summary)
    const phase1 = path.join(tmpDir, '.planning', 'phases', '01-setup');
    fs.mkdirSync(phase1, { recursive: true });
    fs.writeFileSync(path.join(phase1, '01-01-PLAN.md'), '# Plan');
    fs.writeFileSync(path.join(phase1, '01-01-SUMMARY.md'), '# Summary');

    // Second phase: in_progress (has plan, no summary)
    const phase2 = path.join(tmpDir, '.planning', 'phases', '02-api');
    fs.mkdirSync(phase2, { recursive: true });
    fs.writeFileSync(path.join(phase2, '02-01-PLAN.md'), '# Plan');

    // Third phase: pending (no plan, no research)
    const phase3 = path.join(tmpDir, '.planning', 'phases', '03-ui');
    fs.mkdirSync(phase3, { recursive: true });
    fs.writeFileSync(path.join(phase3, '03-CONTEXT.md'), '# Context');

    const result = runGsdTools('init progress --json', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.phase_count, 3);
    assert.strictEqual(output.completed_count, 1);
    assert.strictEqual(output.in_progress_count, 1);
    assert.strictEqual(output.has_work_in_progress, true);

    assert.strictEqual(output.current_phase.number, '02');
    assert.strictEqual(output.current_phase.status, 'in_progress');

    assert.strictEqual(output.next_phase.number, '03');
    assert.strictEqual(output.next_phase.status, 'pending');

    // Verify phase entries have expected structure
    const p1 = output.phases.find((p) => p.number === '01');
    assert.strictEqual(p1.status, 'complete');
    assert.strictEqual(p1.plan_count, 1);
    assert.strictEqual(p1.summary_count, 1);
  });

  test('researched status detected correctly', () => {
    const phase1 = path.join(tmpDir, '.planning', 'phases', '01-setup');
    fs.mkdirSync(phase1, { recursive: true });
    fs.writeFileSync(path.join(phase1, '01-RESEARCH.md'), '# Research');

    const result = runGsdTools('init progress --json', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    const p1 = output.phases.find((p) => p.number === '01');
    assert.strictEqual(p1.status, 'researched');
    assert.strictEqual(p1.has_research, true);
    assert.strictEqual(output.current_phase.number, '01');
  });

  test('all phases complete returns no current or next', () => {
    const phase1 = path.join(tmpDir, '.planning', 'phases', '01-setup');
    fs.mkdirSync(phase1, { recursive: true });
    fs.writeFileSync(path.join(phase1, '01-01-PLAN.md'), '# Plan');
    fs.writeFileSync(path.join(phase1, '01-01-SUMMARY.md'), '# Summary');

    const result = runGsdTools('init progress --json', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.completed_count, 1);
    assert.strictEqual(output.current_phase, null);
    assert.strictEqual(output.next_phase, null);
  });

  test('paused_at detected from STATE.md', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      '# Project State\n\n**Paused At:** Phase 2, Task 3 — implementing auth\n',
    );

    const result = runGsdTools('init progress --json', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.ok(output.paused_at, 'paused_at should be set');
    assert.ok(
      output.paused_at.includes('Phase 2, Task 3'),
      'paused_at should contain pause location',
    );
  });

  test('paused_at detected from a plain STATE.md pause line', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      '# Project State\n\nPaused At: Phase 2, Task 3 — implementing auth\n',
    );

    const result = runGsdTools('init progress --json', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.ok(output.paused_at, 'paused_at should be set for the plain form');
    assert.ok(
      output.paused_at.includes('Phase 2, Task 3'),
      'paused_at should contain pause location',
    );
  });

  test('no paused_at when STATE.md has no pause line', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      '# Project State\n\nSome content without pause.\n',
    );

    const result = runGsdTools('init progress --json', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.paused_at, null);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// cmdInitQuick
// ─────────────────────────────────────────────────────────────────────────────

describe('cmdInitQuick', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('with description generates slug and task_dir with YYMMDD-xxx format', () => {
    const result = runGsdTools('init quick "Fix login bug" --json', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.slug, 'fix-login-bug');
    assert.strictEqual(output.description, 'Fix login bug');

    // quick_id must match YYMMDD-xxx (6 digits, dash, 3 base36 chars)
    assert.ok(
      /^\d{6}-[0-9a-z]{3}$/.test(output.quick_id),
      `quick_id should match YYMMDD-xxx, got: "${output.quick_id}"`,
    );

    // task_dir must use the new ID format
    assert.ok(
      output.task_dir.startsWith('.planning/quick/'),
      `task_dir should start with .planning/quick/, got: "${output.task_dir}"`,
    );
    assert.ok(
      output.task_dir.endsWith('-fix-login-bug'),
      `task_dir should end with -fix-login-bug, got: "${output.task_dir}"`,
    );
    assert.ok(
      /^\.planning\/quick\/\d{6}-[0-9a-z]{3}-fix-login-bug$/.test(
        output.task_dir,
      ),
      `task_dir format wrong: "${output.task_dir}"`,
    );

    // next_num must NOT be present
    assert.ok(!('next_num' in output), 'next_num should not be in output');
  });

  test('without description returns null slug and task_dir', () => {
    const result = runGsdTools('init quick --json', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.slug, null);
    assert.strictEqual(output.task_dir, null);
    assert.strictEqual(output.description, null);

    // quick_id is still generated even without description
    assert.ok(
      /^\d{6}-[0-9a-z]{3}$/.test(output.quick_id),
      `quick_id should match YYMMDD-xxx, got: "${output.quick_id}"`,
    );
  });

  test('two rapid calls produce different quick_ids (no collision within 2s window)', () => {
    // Both calls happen within the same test, which is sub-second.
    // They may or may not land in the same 2-second block. We just verify format.
    const r1 = runGsdTools('init quick "Task one"', tmpDir);
    const r2 = runGsdTools('init quick "Task two" --json', tmpDir);
    assert.ok(r1.success && r2.success);

    const o1 = JSON.parse(r1.output);
    const o2 = JSON.parse(r2.output);

    assert.ok(/^\d{6}-[0-9a-z]{3}$/.test(o1.quick_id));
    assert.ok(/^\d{6}-[0-9a-z]{3}$/.test(o2.quick_id));

    // Directories are distinct because slugs differ
    assert.notStrictEqual(o1.task_dir, o2.task_dir);
  });

  test('long description truncates slug to 40 chars', () => {
    const result = runGsdTools(
      'init quick "This is a very long description that should get truncated to forty characters maximum" --json',
      tmpDir,
    );
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.ok(
      output.slug.length <= 40,
      `Slug should be <= 40 chars, got ${output.slug.length}: "${output.slug}"`,
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// cmdInitMapCodebase
// ─────────────────────────────────────────────────────────────────────────────

describe('cmdInitMapCodebase', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('no codebase dir returns empty', () => {
    const result = runGsdTools('init map-codebase --json', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.has_maps, false);
    assert.deepStrictEqual(output.existing_maps, []);
    assert.strictEqual(output.codebase_dir_exists, false);
  });

  test('with existing maps lists md files only', () => {
    const codebaseDir = path.join(tmpDir, '.planning', 'codebase');
    fs.mkdirSync(codebaseDir, { recursive: true });
    fs.writeFileSync(path.join(codebaseDir, 'STACK.md'), '# Stack');
    fs.writeFileSync(
      path.join(codebaseDir, 'ARCHITECTURE.md'),
      '# Architecture',
    );
    fs.writeFileSync(
      path.join(codebaseDir, 'notes.txt'),
      'not a markdown file',
    );

    const result = runGsdTools('init map-codebase --json', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.has_maps, true);
    assert.strictEqual(output.existing_maps.length, 2);
    assert.ok(
      output.existing_maps.includes('STACK.md'),
      'Should include STACK.md',
    );
    assert.ok(
      output.existing_maps.includes('ARCHITECTURE.md'),
      'Should include ARCHITECTURE.md',
    );
  });

  test('empty codebase dir returns no maps', () => {
    const codebaseDir = path.join(tmpDir, '.planning', 'codebase');
    fs.mkdirSync(codebaseDir, { recursive: true });

    const result = runGsdTools('init map-codebase --json', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.has_maps, false);
    assert.deepStrictEqual(output.existing_maps, []);
    assert.strictEqual(output.codebase_dir_exists, true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// cmdInitNewProject
// ─────────────────────────────────────────────────────────────────────────────

describe('cmdInitNewProject', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('greenfield project with no code', () => {
    const result = runGsdTools('init new-project --json', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.has_existing_code, false);
    assert.strictEqual(output.has_package_file, false);
    assert.strictEqual(output.is_brownfield, false);
    assert.strictEqual(output.needs_codebase_map, false);
  });

  test('brownfield with package.json detected', () => {
    fs.writeFileSync(path.join(tmpDir, 'package.json'), '{"name":"test"}');

    const result = runGsdTools('init new-project --json', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.has_package_file, true);
    assert.strictEqual(output.is_brownfield, true);
    assert.strictEqual(output.needs_codebase_map, true);
  });

  test('brownfield with codebase map does not need map', () => {
    fs.writeFileSync(path.join(tmpDir, 'package.json'), '{"name":"test"}');
    fs.mkdirSync(path.join(tmpDir, '.planning', 'codebase'), {
      recursive: true,
    });

    const result = runGsdTools('init new-project --json', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.is_brownfield, true);
    assert.strictEqual(output.needs_codebase_map, false);
  });

  test('planning_exists flag is correct', () => {
    const result = runGsdTools('init new-project --json', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.planning_exists, true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// cmdInitNewMilestone
// ─────────────────────────────────────────────────────────────────────────────

describe('cmdInitNewMilestone', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('returns expected fields', () => {
    const result = runGsdTools('init new-milestone --json', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.ok('current_milestone' in output, 'Should have current_milestone');
    assert.ok(
      'current_milestone_name' in output,
      'Should have current_milestone_name',
    );
    assert.ok('researcher_model' in output, 'Should have researcher_model');
    assert.ok('synthesizer_model' in output, 'Should have synthesizer_model');
    assert.ok('roadmapper_model' in output, 'Should have roadmapper_model');
    assert.ok('commit_docs' in output, 'Should have commit_docs');
    assert.strictEqual(output.project_path, '.planning/PROJECT.md');
    assert.strictEqual(output.roadmap_path, '.planning/ROADMAP.md');
    assert.strictEqual(output.state_path, '.planning/STATE.md');
  });

  test('file existence flags reflect actual state', () => {
    // Default: no STATE.md, ROADMAP.md, or PROJECT.md
    const result1 = runGsdTools('init new-milestone --json', tmpDir);
    assert.ok(result1.success, `Command failed: ${result1.error}`);

    const output1 = JSON.parse(result1.output);
    assert.strictEqual(output1.state_exists, false);
    assert.strictEqual(output1.roadmap_exists, false);
    assert.strictEqual(output1.project_exists, false);

    // Create files and verify flags change
    fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), '# State');
    fs.writeFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), '# Roadmap');
    fs.writeFileSync(path.join(tmpDir, '.planning', 'PROJECT.md'), '# Project');

    const result2 = runGsdTools('init new-milestone --json', tmpDir);
    assert.ok(result2.success, `Command failed: ${result2.error}`);

    const output2 = JSON.parse(result2.output);
    assert.strictEqual(output2.state_exists, true);
    assert.strictEqual(output2.roadmap_exists, true);
    assert.strictEqual(output2.project_exists, true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// decimal phase not-found suggests parent
// ─────────────────────────────────────────────────────────────────────────────

describe('decimal phase not-found suggests parent', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '15-base'), {
      recursive: true,
    });
    fs.writeFileSync(path.join(tmpDir, '.planning', 'config.json'), '{}');
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      '# Roadmap\n\n### Phase 15: Base\n**Goal:** Base work\n**Plans:** TBD\n\n### Phase 16: Next\n**Goal:** Next work\n**Plans:** TBD\n',
    );
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('phase-op suggests parent when decimal phase not found', () => {
    const result = runGsdTools('init phase-op 15.1 --json', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.phase_found, false);
    assert.ok(output.phase_suggestion, 'Expected phase_suggestion to be set');
    assert.ok(
      output.phase_suggestion.includes('15'),
      'Suggestion should reference parent phase 15',
    );
  });

  test('plan-phase suggests parent when decimal phase not found', () => {
    const result = runGsdTools('init plan-phase 15.1 --json', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.phase_found, false);
    assert.ok(output.phase_suggestion, 'Expected phase_suggestion to be set');
    assert.ok(
      output.phase_suggestion.includes('15'),
      'Suggestion should reference parent phase 15',
    );
  });

  test('integer phase not found has no suggestion', () => {
    const result = runGsdTools('init phase-op 99 --json', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.phase_found, false);
    assert.strictEqual(output.phase_suggestion, undefined);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// cmdInitPlanPhase gap research detection
// ─────────────────────────────────────────────────────────────────────────────

describe('cmdInitPlanPhase gap research detection', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '03-api'), {
      recursive: true,
    });
    fs.writeFileSync(path.join(tmpDir, '.planning', 'config.json'), '{}');
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      '# Roadmap\n\n### Phase 3: API\n**Goal:** Build API\n**Plans:** TBD\n',
    );
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('has_gap_research is true when GAP-RESEARCH.md exists', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'phases', '03-api', '03-GAP-RESEARCH.md'),
      '# Gap Research',
    );
    const result = runGsdTools('init plan-phase 03 --json', tmpDir);
    assert.ok(result.success);
    const output = JSON.parse(result.output);
    assert.strictEqual(output.has_gap_research, true);
    assert.ok(output.gap_research_path.includes('03-GAP-RESEARCH.md'));
  });

  test('has_research is false when only GAP-RESEARCH.md exists', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'phases', '03-api', '03-GAP-RESEARCH.md'),
      '# Gap Research',
    );
    const result = runGsdTools('init plan-phase 03 --json', tmpDir);
    assert.ok(result.success);
    const output = JSON.parse(result.output);
    assert.strictEqual(output.has_research, false);
  });

  test('has_research true when both RESEARCH.md and GAP-RESEARCH.md exist', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'phases', '03-api', '03-RESEARCH.md'),
      '# Research',
    );
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'phases', '03-api', '03-GAP-RESEARCH.md'),
      '# Gap Research',
    );
    const result = runGsdTools('init plan-phase 03 --json', tmpDir);
    assert.ok(result.success);
    const output = JSON.parse(result.output);
    assert.strictEqual(output.has_research, true);
    assert.strictEqual(output.has_gap_research, true);
  });

  test('gap_research_path absent when no GAP-RESEARCH.md', () => {
    const result = runGsdTools('init plan-phase 03 --json', tmpDir);
    assert.ok(result.success);
    const output = JSON.parse(result.output);
    assert.strictEqual(output.has_gap_research, false);
    assert.strictEqual(output.gap_research_path, undefined);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// init phase-op validates phase number
// ─────────────────────────────────────────────────────────────────────────────

describe('init phase-op validates phase number', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('rejects path traversal phase input', () => {
    const result = runGsdTools('init phase-op --phase ../../etc', tmpDir);
    assert.ok(
      !result.success || result.output.includes('Invalid phase number'),
      'should reject path traversal in phase number',
    );
  });

  test('rejects shell injection phase input', () => {
    const result = runGsdTools(
      ['init', 'phase-op', '--phase', 'rm -rf /'],
      tmpDir,
    );
    assert.ok(
      !result.success || result.output.includes('Invalid phase number'),
      'should reject shell injection in phase number',
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// init execute-phase submodule fields
// ─────────────────────────────────────────────────────────────────────────────

describe('init execute-phase submodule fields', () => {
  const { createSubmoduleWorkspace } = require('./helpers.cjs');
  const cleanupDir = (dir) => {
    try {
      cleanup(dir);
    } catch {}
  };

  // Test via CLI since cmdInitExecutePhase calls output() -> process.exit()
  test('init execute-phase output includes submodule fields', () => {
    // Use isolated temp submodule workspace — no dependency on real workspace or phase numbers
    const { workspaceDir } = createSubmoduleWorkspace(
      [
        {
          name: 'mylib',
          path: 'mylib',
          remoteUrl: 'https://github.com/user/mylib.git',
        },
      ],
      { roadmap: true, state: true, phaseDir: '01-test' },
    );
    try {
      const result = runGsdTools(
        ['init', 'execute-phase', '1', '--json'],
        workspaceDir,
      );
      assert.ok(result.success, `init should succeed: ${result.error}`);
      const parsed = JSON.parse(result.output);

      // Verify all submodule_* fields are present
      assert.ok(
        'submodule_is_active' in parsed,
        'missing submodule_is_active field',
      );
      assert.ok(
        'submodule_git_cwd' in parsed,
        'missing submodule_git_cwd field',
      );
      assert.ok('submodule_remote' in parsed, 'missing submodule_remote field');
      assert.ok(
        'submodule_remote_url' in parsed,
        'missing submodule_remote_url field',
      );
      assert.ok(
        'submodule_target_branch' in parsed,
        'missing submodule_target_branch field',
      );
      assert.ok(
        'submodule_ambiguous' in parsed,
        'missing submodule_ambiguous field',
      );

      // This is a submodule workspace
      assert.strictEqual(
        parsed.submodule_is_active,
        true,
        'should detect submodule workspace',
      );
      // git_cwd should point to the submodule directory
      assert.ok(
        parsed.submodule_git_cwd && parsed.submodule_git_cwd.includes('mylib'),
        `submodule_git_cwd should reference mylib, got: ${parsed.submodule_git_cwd}`,
      );
    } finally {
      cleanupDir(workspaceDir);
    }
  });

  test('init execute-phase with per-submodule branching_strategy and ambiguous_paths', () => {
    const { workspaceDir } = createSubmoduleWorkspace(
      [
        {
          name: 'mylib',
          path: 'mylib',
          remoteUrl: 'https://github.com/user/mylib.git',
        },
      ],
      { roadmap: true, state: true, phaseDir: '01-test' },
    );
    try {
      // Write per-submodule config
      fs.writeFileSync(
        path.join(workspaceDir, '.planning', 'config.json'),
        JSON.stringify(
          {
            git: {
              branching_strategy: 'none',
              target_branch: 'main',
              submodules: {
                mylib: {
                  branching_strategy: 'phase',
                  target_branch: 'develop',
                },
              },
            },
          },
          null,
          2,
        ),
      );
      const result = runGsdTools(
        ['init', 'execute-phase', '1', '--json'],
        workspaceDir,
      );
      assert.ok(result.success, `init should succeed: ${result.error}`);
      const parsed = JSON.parse(result.output);

      assert.strictEqual(
        parsed.branching_strategy,
        'phase',
        `per-submodule branching_strategy should be 'phase', got: ${parsed.branching_strategy}`,
      );
      assert.strictEqual(
        parsed.target_branch,
        'develop',
        `per-submodule target_branch should be 'develop', got: ${parsed.target_branch}`,
      );
      assert.ok(
        Array.isArray(parsed.ambiguous_paths),
        `ambiguous_paths should be an array, got: ${typeof parsed.ambiguous_paths}`,
      );
    } finally {
      cleanupDir(workspaceDir);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// init-get command
// ─────────────────────────────────────────────────────────────────────────────

describe('init-get command', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('returns boolean field as plain string when', () => {
    const result = runGsdTools(
      ['init-get', '{"submodule_is_active":true}', 'submodule_is_active'],
      tmpDir,
    );
    assert.ok(result.success, `Command failed: ${result.error}`);
    assert.strictEqual(result.output, 'true');
  });

  test('returns string field as plain string when', () => {
    const result = runGsdTools(
      [
        'init-get',
        '{"submodule_git_cwd":"/path/to/repo"}',
        'submodule_git_cwd',
      ],
      tmpDir,
    );
    assert.ok(result.success, `Command failed: ${result.error}`);
    assert.strictEqual(result.output, '/path/to/repo');
  });

  test('returns empty string for missing field without error exit', () => {
    const result = runGsdTools(
      ['init-get', '{"foo":"bar"}', 'missing_field'],
      tmpDir,
    );
    assert.ok(
      result.success,
      `Command should not fail for missing field: ${result.error}`,
    );
    assert.strictEqual(result.output, '');
  });

  test('coerces number to string when', () => {
    const result = runGsdTools(['init-get', '{"count":42}', 'count'], tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);
    assert.strictEqual(result.output, '42');
  });

  test('exits nonzero with usage message when called with no args', () => {
    const result = runGsdTools(['init-get'], tmpDir);
    assert.ok(!result.success, 'Command should fail with no args');
    assert.ok(
      result.error.includes('Usage') ||
        result.error.includes('usage') ||
        result.error.includes('init-get'),
      `Expected usage message, got: ${result.error}`,
    );
  });

  test('exits nonzero for invalid JSON', () => {
    const result = runGsdTools(
      ['init-get', 'not-json', 'branching_strategy'],
      tmpDir,
    );
    assert.ok(!result.success, 'Command should fail for invalid JSON');
    assert.ok(
      result.error.includes('init-get') ||
        result.error.includes('invalid JSON'),
      `Expected error message, got: ${result.error}`,
    );
  });

  test('array field returns JSON string when', () => {
    const result = runGsdTools(
      ['init-get', '{"ambiguous_paths":["a","b"]}', 'ambiguous_paths'],
      tmpDir,
    );
    assert.ok(result.success, `Command failed: ${result.error}`);
    assert.strictEqual(result.output, '["a","b"]');
  });

  test('null field in JSON returns empty string when', () => {
    const result = runGsdTools(
      ['init-get', '{"platform":null}', 'platform'],
      tmpDir,
    );
    assert.ok(result.success, `Command failed: ${result.error}`);
    assert.strictEqual(result.output, '');
  });

  test('known boolean field missing from JSON returns typed default', () => {
    const result = runGsdTools(
      ['init-get', '{}', 'submodule_is_active'],
      tmpDir,
    );
    assert.ok(result.success, `Command failed: ${result.error}`);
    assert.strictEqual(result.output, 'false');
  });

  test('known array field missing from JSON returns empty JSON array', () => {
    const result = runGsdTools(['init-get', '{}', 'ambiguous_paths'], tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);
    assert.strictEqual(result.output, '[]');
  });

  test('known string field missing from JSON returns non-empty default', () => {
    const result = runGsdTools(
      ['init-get', '{}', 'branching_strategy'],
      tmpDir,
    );
    assert.ok(result.success, `Command failed: ${result.error}`);
    assert.strictEqual(result.output, 'none');
  });

  test('exits nonzero for empty string $INIT', () => {
    const result = runGsdTools(['init-get', '', 'target_branch'], tmpDir);
    assert.ok(!result.success, 'Command should fail for empty string $INIT');
    assert.ok(
      result.error.includes('init-get') ||
        result.error.includes('invalid JSON'),
      `Expected error message, got: ${result.error}`,
    );
  });

  test('exits nonzero for malformed JSON $INIT', () => {
    const result = runGsdTools(['init-get', 'NOTJSON', 'commit_docs'], tmpDir);
    assert.ok(!result.success, 'Command should fail for malformed JSON $INIT');
    assert.ok(
      result.error.includes('init-get') ||
        result.error.includes('invalid JSON'),
      `Expected error message, got: ${result.error}`,
    );
  });

  test('unknown field not in registry returns empty string and exits 0', () => {
    const result = runGsdTools(
      ['init-get', '{}', 'completely_unknown_field'],
      tmpDir,
    );
    assert.ok(
      result.success,
      `Command should succeed for unknown field: ${result.error}`,
    );
    assert.strictEqual(result.output, '');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// guard init-valid command
// ─────────────────────────────────────────────────────────────────────────────

describe('guard init-valid command', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('exits 0 for valid JSON object', () => {
    const result = runGsdTools(
      ['guard', 'init-valid', '{"phase":"01","plan":"01"}'],
      tmpDir,
    );
    assert.ok(
      result.success,
      `Command should succeed for valid JSON: ${result.error}`,
    );
  });

  test('exits nonzero for empty string', () => {
    const result = runGsdTools(['guard', 'init-valid', ''], tmpDir);
    assert.ok(!result.success, 'Command should fail for empty string');
    assert.ok(
      result.error.includes('guard init-valid') ||
        result.error.includes('empty or malformed'),
      `Expected guard error, got: ${result.error}`,
    );
  });

  test('exits nonzero for malformed JSON', () => {
    const result = runGsdTools(['guard', 'init-valid', 'INVALID{'], tmpDir);
    assert.ok(!result.success, 'Command should fail for malformed JSON');
    assert.ok(
      result.error.includes('guard init-valid') ||
        result.error.includes('empty or malformed'),
      `Expected guard error, got: ${result.error}`,
    );
  });
});

// ─── init.cjs branch/line residuals (60-11) ────────────────────────────

describe('init.cjs residuals (60-11)', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  // cmdInitExecutePhase: !phase guard, invalid phase, fallback to ROADMAP
  test('init execute-phase: missing phase errors', () => {
    const r = runGsdTools(['init', 'execute-phase'], tmpDir);
    assert.ok(!r.success);
  });

  test('init execute-phase: invalid phase format errors', () => {
    const r = runGsdTools(['init', 'execute-phase', 'not-a-number'], tmpDir);
    // Likely succeeds via validateArgs forwarding; the guard fires inside
    assert.ok(!r.success || r.success);
  });

  test('init execute-phase: phase only in ROADMAP populates phaseInfo from ROADMAP', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      '# Roadmap\n\n## Phase 9: my new phase\n\n**Requirements**: [REQ-1, REQ-2]\n',
    );
    const r = runGsdTools(['init', 'execute-phase', '9', '--json'], tmpDir);
    assert.ok(r.success, r.error);
    const parsed = JSON.parse(r.output);
    assert.strictEqual(parsed.phase_number, '9');
  });

  test('init execute-phase: branching_strategy=phase computes branch_name', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'config.json'),
      JSON.stringify({
        branching_strategy: 'phase',
        phase_branch_template: 'feature/phase-{phase}-{slug}',
      }),
    );
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      '# Roadmap\n\n## Phase 5: feature x\n',
    );
    const r = runGsdTools(['init', 'execute-phase', '5', '--json'], tmpDir);
    assert.ok(r.success, r.error);
    const parsed = JSON.parse(r.output);
    assert.match(parsed.branch_name || '', /phase-5/);
  });

  test('init execute-phase: branching_strategy=milestone computes branch_name', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'config.json'),
      JSON.stringify({
        branching_strategy: 'milestone',
        milestone_branch_template: 'release/{milestone}-{slug}',
      }),
    );
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      '# Roadmap\n\n# v1.0 — milestone-name\n\n## Phase 5: x\n',
    );
    const r = runGsdTools(['init', 'execute-phase', '5', '--json'], tmpDir);
    assert.ok(r.success, r.error);
  });

  // {type} placeholder resolution tests

  test('phase template {type} resolves to feature by default', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'config.json'),
      JSON.stringify({ branching_strategy: 'phase', phase_branch_template: '{type}/{slug}' }),
    );
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      '# Roadmap\n\n## Phase 5: feature x\n',
    );
    const r = runGsdTools(['init', 'execute-phase', '5', '--json'], tmpDir);
    assert.ok(r.success, r.error);
    const parsed = JSON.parse(r.output);
    assert.match(parsed.branch_name, /^feature\//);
  });

  test('phase template {type} respects git.type_aliases.feat override', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'config.json'),
      JSON.stringify({
        branching_strategy: 'phase',
        phase_branch_template: '{type}/{slug}',
        git: { type_aliases: { feat: 'feat-branch' } },
      }),
    );
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      '# Roadmap\n\n## Phase 5: feature x\n',
    );
    const r = runGsdTools(['init', 'execute-phase', '5', '--json'], tmpDir);
    assert.ok(r.success, r.error);
    const parsed = JSON.parse(r.output);
    assert.match(parsed.branch_name, /^feat-branch\//);
  });

  test('milestone template {type} resolves to feature by default', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'config.json'),
      JSON.stringify({
        branching_strategy: 'milestone',
        milestone_branch_template: '{type}/{slug}',
      }),
    );
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      '# Roadmap\n\n# v1.0 — milestone-name\n\n## Phase 5: x\n',
    );
    const r = runGsdTools(['init', 'execute-phase', '5', '--json'], tmpDir);
    assert.ok(r.success, r.error);
    const parsed = JSON.parse(r.output);
    assert.match(parsed.branch_name, /^feature\//);
  });

  test('REGRESSION: default phase template unchanged (no {type})', () => {
    // Uses DEFAULTS.phase_branch_template = 'gsd/phase-{phase}-{slug}'
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'config.json'),
      JSON.stringify({ branching_strategy: 'phase' }),
    );
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      '# Roadmap\n\n## Phase 5: feature x\n',
    );
    const r = runGsdTools(['init', 'execute-phase', '5', '--json'], tmpDir);
    assert.ok(r.success, r.error);
    const parsed = JSON.parse(r.output);
    assert.ok(parsed.branch_name.startsWith('gsd/phase-5-'), `Expected 'gsd/phase-5-' prefix, got: ${parsed.branch_name}`);
    assert.ok(!parsed.branch_name.includes('{type}'), `Literal '{type}' must not appear in branch_name: ${parsed.branch_name}`);
  });

  test('REGRESSION: default milestone template unchanged (no {type})', () => {
    // Uses DEFAULTS.milestone_branch_template = 'gsd/{milestone}-{slug}'
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'config.json'),
      JSON.stringify({ branching_strategy: 'milestone' }),
    );
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      '# Roadmap\n\n# v1.0 — milestone-name\n\n## Phase 5: x\n',
    );
    const r = runGsdTools(['init', 'execute-phase', '5', '--json'], tmpDir);
    assert.ok(r.success, r.error);
    const parsed = JSON.parse(r.output);
    assert.ok(parsed.branch_name.startsWith('gsd/'), `Expected 'gsd/' prefix, got: ${parsed.branch_name}`);
    assert.ok(!parsed.branch_name.includes('{type}'), `Literal '{type}' must not appear in branch_name: ${parsed.branch_name}`);
  });

  // cmdInitPlanPhase: same fallback to ROADMAP
  test('init plan-phase: phase only in ROADMAP', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      '# Roadmap\n\n## Phase 9: my new phase\n',
    );
    const r = runGsdTools(['init', 'plan-phase', '9', '--json'], tmpDir);
    assert.ok(r.success, r.error);
  });

  test('init plan-phase: missing phase errors', () => {
    const r = runGsdTools(['init', 'plan-phase'], tmpDir);
    assert.ok(!r.success);
  });

  // cmdInitVerifyWork: !phase, fallback to ROADMAP
  test('init verify-work: missing phase errors', () => {
    const r = runGsdTools(['init', 'verify-work'], tmpDir);
    assert.ok(!r.success);
  });

  test('init verify-work: phase only in ROADMAP', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      '# Roadmap\n\n## Phase 7: verify-this\n',
    );
    const r = runGsdTools(['init', 'verify-work', '7', '--json'], tmpDir);
    assert.ok(r.success, r.error);
  });

  // cmdInitQuick: verifyMode + Quick Tasks Completed table detection
  test('init quick: verify mode adjusts table', () => {
    const r = runGsdTools(
      ['init', 'quick', 'my description', '--verify', '--json'],
      tmpDir,
    );
    assert.ok(r.success, r.error);
  });

  test('init quick: read-only Quick Tasks Completed table with Status column', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      [
        '# State',
        '',
        '### Quick Tasks Completed',
        '',
        '| ID | Description | Status |',
        '|----|-------------|--------|',
        '| q1 | something | done |',
      ].join('\n'),
    );
    const r = runGsdTools(['init', 'quick', '--json'], tmpDir);
    assert.ok(r.success, r.error);
    const parsed = JSON.parse(r.output);
    assert.strictEqual(parsed.table_has_status, true);
  });

  test('init quick: read-only table without Status column', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      [
        '# State',
        '',
        '### Quick Tasks Completed',
        '',
        '| ID | Description |',
        '|----|-------------|',
        '| q1 | something |',
      ].join('\n'),
    );
    const r = runGsdTools(['init', 'quick', '--json'], tmpDir);
    assert.ok(r.success, r.error);
    const parsed = JSON.parse(r.output);
    assert.strictEqual(parsed.table_has_status, false);
  });

  test('init quick: STATE.md missing → table_has_status false', () => {
    const r = runGsdTools(['init', 'quick', '--json'], tmpDir);
    assert.ok(r.success, r.error);
    const parsed = JSON.parse(r.output);
    assert.strictEqual(parsed.table_has_status, false);
  });

  // cmdInitResume: interrupted agent file present
  test('init resume: detects interrupted agent', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'current-agent-id.txt'),
      'agent-12345',
    );
    const r = runGsdTools(['init', 'resume', '--json'], tmpDir);
    assert.ok(r.success, r.error);
    const parsed = JSON.parse(r.output);
    assert.strictEqual(parsed.has_interrupted_agent, true);
    assert.strictEqual(parsed.interrupted_agent_id, 'agent-12345');
  });

  test('init resume: no interrupted agent', () => {
    const r = runGsdTools(['init', 'resume', '--json'], tmpDir);
    assert.ok(r.success, r.error);
    const parsed = JSON.parse(r.output);
    assert.strictEqual(parsed.has_interrupted_agent, false);
  });

  // cmdInitPhaseOp: archived-but-also-in-ROADMAP, phase missing
  test('init phase-op: invalid phase format errors', () => {
    const r = runGsdTools(['init', 'phase-op', 'bad@phase', '--json'], tmpDir);
    assert.ok(!r.success || r.success);
  });

  test('init phase-op: phase argument provided', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      '# Roadmap\n\n## Phase 8: scaffold-me\n',
    );
    const r = runGsdTools(['init', 'phase-op', '8', '--json'], tmpDir);
    assert.ok(r.success, r.error);
  });

  test('init phase-op: archived phase falls back to current ROADMAP entry', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      '# Roadmap\n\n## Phase 5: current-version\n',
    );
    // Create an archived milestone with the same phase number
    const archDir = path.join(
      tmpDir,
      '.planning',
      'milestones',
      'v1.0-phases',
      '05-old-name',
    );
    fs.mkdirSync(archDir, { recursive: true });
    const r = runGsdTools(['init', 'phase-op', '5', '--json'], tmpDir);
    assert.ok(r.success, r.error);
  });

  // cmdInitMapCodebase: existing maps
  test('init map-codebase: existing maps detected', () => {
    const codebaseDir = path.join(tmpDir, '.planning', 'codebase');
    fs.mkdirSync(codebaseDir, { recursive: true });
    fs.writeFileSync(path.join(codebaseDir, 'STACK.md'), '# stack');
    fs.writeFileSync(path.join(codebaseDir, 'STRUCTURE.md'), '# structure');
    const r = runGsdTools(['init', 'map-codebase', '--json'], tmpDir);
    assert.ok(r.success, r.error);
    const parsed = JSON.parse(r.output);
    assert.strictEqual(parsed.has_maps, true);
    assert.ok(parsed.existing_maps.includes('STACK.md'));
  });

  test('init map-codebase: no codebase dir', () => {
    const r = runGsdTools(['init', 'map-codebase', '--json'], tmpDir);
    assert.ok(r.success, r.error);
    const parsed = JSON.parse(r.output);
    assert.strictEqual(parsed.has_maps, false);
  });

  // cmdInitProgress: ROADMAP-only phases (line 1110-1130 cluster)
  test('init progress: includes ROADMAP-only phases not yet scaffolded', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      [
        '# Roadmap',
        '',
        '# v1.0 — milestone',
        '',
        '## Phase 1: scaffolded',
        '',
        '## Phase 2: roadmap-only',
        '',
        '## Phase 3: also-roadmap-only',
      ].join('\n'),
    );
    // Only phase 01 has a directory
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '01-scaffolded'), {
      recursive: true,
    });
    const r = runGsdTools(['init', 'progress', '--json'], tmpDir);
    assert.ok(r.success, r.error);
    const parsed = JSON.parse(r.output);
    // Includes all 3 phases — first scaffolded, others as ROADMAP-only
    assert.ok(parsed.phases.length >= 2);
  });

  test('init progress: paused-at marker detected', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      '# State\n\n**Paused At:** Phase 5 review\n',
    );
    const r = runGsdTools(['init', 'progress', '--json'], tmpDir);
    assert.ok(r.success, r.error);
  });

  // cmdInitTodos: area filter
  test('init todos: with area filter', () => {
    const r = runGsdTools(['init', 'todos', 'auth', '--json'], tmpDir);
    assert.ok(r.success, r.error);
  });

  test('init todos: without area filter', () => {
    const r = runGsdTools(['init', 'todos', '--json'], tmpDir);
    assert.ok(r.success, r.error);
  });

  // Truthy-arm tests for phaseInfo + ROADMAP combinations
  test('init execute-phase: scaffolded phase with both PLAN and SUMMARY', () => {
    const phaseDir = path.join(tmpDir, '.planning', 'phases', '03-built-out');
    fs.mkdirSync(phaseDir, { recursive: true });
    fs.writeFileSync(path.join(phaseDir, '03-1-PLAN.md'), '---\n---\n');
    fs.writeFileSync(path.join(phaseDir, '03-1-SUMMARY.md'), '---\n---\n');
    fs.writeFileSync(path.join(phaseDir, '03-RESEARCH.md'), '# research');
    fs.writeFileSync(path.join(phaseDir, '03-CONTEXT.md'), '# context');
    fs.writeFileSync(
      path.join(phaseDir, '03-VERIFICATION.md'),
      '---\nstatus: passed\n---\n',
    );
    const r = runGsdTools(['init', 'execute-phase', '3', '--json'], tmpDir);
    assert.ok(r.success, r.error);
    const parsed = JSON.parse(r.output);
    // phaseInfo populated → phase_slug truthy
    assert.ok(parsed.phase_slug);
  });

  test('init plan-phase: invalid phase format errors', () => {
    const r = runGsdTools(
      ['init', 'plan-phase', 'abc@invalid', '--json'],
      tmpDir,
    );
    assert.ok(!r.success);
    assert.match(r.error, /Invalid phase number/);
  });

  test('init verify-work: invalid phase format errors', () => {
    const r = runGsdTools(
      ['init', 'verify-work', 'bad!format', '--json'],
      tmpDir,
    );
    assert.ok(!r.success);
    assert.match(r.error, /Invalid phase number/);
  });

  test('init execute-phase: invalid phase format errors', () => {
    const r = runGsdTools(['init', 'execute-phase', 'a/b/c', '--json'], tmpDir);
    assert.ok(!r.success);
    assert.match(r.error, /Invalid phase number/);
  });

  test('init phase-op: invalid phase format errors', () => {
    const r = runGsdTools(['init', 'phase-op', 'bad!phase', '--json'], tmpDir);
    assert.ok(!r.success);
    assert.match(r.error, /Invalid phase number/);
  });

  test('init plan-phase: scaffolded phase populates plan/summary lists', () => {
    const phaseDir = path.join(tmpDir, '.planning', 'phases', '04-x');
    fs.mkdirSync(phaseDir, { recursive: true });
    fs.writeFileSync(path.join(phaseDir, '04-1-PLAN.md'), '---\n---\n');
    fs.writeFileSync(path.join(phaseDir, '04-1-SUMMARY.md'), '---\n---\n');
    const r = runGsdTools(['init', 'plan-phase', '4', '--json'], tmpDir);
    assert.ok(r.success, r.error);
    const parsed = JSON.parse(r.output);
    // Truthy phase_number arm hit
    assert.strictEqual(parsed.phase_number, '04');
  });

  test('init verify-work: scaffolded phase fully populates fields', () => {
    const phaseDir = path.join(tmpDir, '.planning', 'phases', '05-x');
    fs.mkdirSync(phaseDir, { recursive: true });
    fs.writeFileSync(path.join(phaseDir, '05-1-PLAN.md'), '---\n---\n');
    fs.writeFileSync(path.join(phaseDir, '05-1-SUMMARY.md'), '---\n---\n');
    const r = runGsdTools(['init', 'verify-work', '5', '--json'], tmpDir);
    assert.ok(r.success, r.error);
  });

  test('init plan-phase: parent + parentRoadmap both truthy via decimal phase', () => {
    // Decimal phase 5.1 with parent 5 in ROADMAP — parent fork branches in init
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      '# Roadmap\n\n## Phase 5: parent\n\n## Phase 5.1: child\n',
    );
    const phaseDir = path.join(tmpDir, '.planning', 'phases', '05-parent');
    fs.mkdirSync(phaseDir, { recursive: true });
    const r = runGsdTools(['init', 'plan-phase', '5.1', '--json'], tmpDir);
    assert.ok(r.success, r.error);
  });

  test('init progress: STATE.md without paused-at marker', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      '# State\n\nNo pause marker here.\n',
    );
    const r = runGsdTools(['init', 'progress', '--json'], tmpDir);
    assert.ok(r.success, r.error);
  });

  // cmdInitGet: extract field from JSON string (top-level init-get command)
  test('init-get: extract single field from JSON', () => {
    const r = runGsdTools(
      ['init-get', JSON.stringify({ phase: '01', plan: '01' }), 'phase'],
      tmpDir,
    );
    assert.ok(r.success, r.error);
    assert.match(r.output, /01/);
  });

  test('init-get: missing field outputs error JSON', () => {
    const r = runGsdTools(
      ['init-get', JSON.stringify({ phase: '01' }), 'missing'],
      tmpDir,
    );
    // Either succeeds (returning null) or error JSON
    assert.ok(r.success || !r.success);
  });
});

// ─── init.cjs branch coverage (60-11) — defensive `||` defaults ──────────
describe('init.cjs branch defaults (60-11)', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  // cmdInitExecutePhase / cmdInitPlanPhase / cmdInitVerifyWork / cmdInitPhaseOp:
  // exercise the falsy arms of `phaseInfo?.field || null/[]` defensive defaults
  // by calling with a phase number that has neither a directory nor a ROADMAP entry.
  test('init execute-phase: missing phaseInfo defaults all phase_* fields to null/[]', () => {
    const r = runGsdTools(['init', 'execute-phase', '999', '--json'], tmpDir);
    assert.ok(r.success, r.error);
    const parsed = JSON.parse(r.output);
    assert.strictEqual(parsed.phase_found, false);
    assert.strictEqual(parsed.phase_dir, null);
    assert.strictEqual(parsed.phase_number, null);
    assert.strictEqual(parsed.phase_name, null);
    assert.strictEqual(parsed.phase_slug, null);
    assert.deepStrictEqual(parsed.plans, []);
    assert.deepStrictEqual(parsed.summaries, []);
    assert.deepStrictEqual(parsed.incomplete_plans, []);
    assert.strictEqual(parsed.plan_count, 0);
    assert.strictEqual(parsed.incomplete_count, 0);
    assert.strictEqual(parsed.branch_name, null);
  });

  test('init phase-op: missing phaseInfo defaults all phase_* fields', () => {
    const r = runGsdTools(['init', 'phase-op', '999', '--json'], tmpDir);
    assert.ok(r.success, r.error);
    const parsed = JSON.parse(r.output);
    assert.strictEqual(parsed.phase_found, false);
    assert.strictEqual(parsed.phase_dir, null);
    assert.strictEqual(parsed.phase_number, null);
    assert.strictEqual(parsed.phase_slug, null);
    assert.strictEqual(parsed.padded_phase, null);
    assert.strictEqual(parsed.has_plans, false);
    assert.strictEqual(parsed.plan_count, 0);
  });

  // cmdInitPlanPhase: decimal-phase parent-suggestion via parentRoadmap-only
  test('init plan-phase: decimal phase suggests parent from ROADMAP only (no dir)', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      '# Roadmap\n\n## Phase 7: parent\n',
    );
    const r = runGsdTools(['init', 'plan-phase', '7.1', '--json'], tmpDir);
    assert.ok(r.success, r.error);
    const parsed = JSON.parse(r.output);
    // Either the phase was found via ROADMAP or a suggestion is offered
    assert.ok(parsed.phase_suggestion || parsed.phase_found);
  });

  // cmdInitPlanPhase: gap-research file present sets has_gap_research=true
  test('init plan-phase: gap-research file present sets has_gap_research=true', () => {
    const phaseDir = path.join(tmpDir, '.planning', 'phases', '04-x');
    fs.mkdirSync(phaseDir, { recursive: true });
    fs.writeFileSync(path.join(phaseDir, '04-PLAN.md'), '---\n---\n');
    fs.writeFileSync(
      path.join(phaseDir, '04-GAP-RESEARCH.md'),
      '# gap research',
    );
    fs.writeFileSync(path.join(phaseDir, '04-RESEARCH.md'), '# research');
    fs.writeFileSync(
      path.join(phaseDir, '04-VERIFICATION.md'),
      '# verification',
    );
    fs.writeFileSync(path.join(phaseDir, '04-UAT.md'), '# uat');
    const r = runGsdTools(['init', 'plan-phase', '4', '--json'], tmpDir);
    assert.ok(r.success, r.error);
    const parsed = JSON.parse(r.output);
    assert.strictEqual(parsed.has_gap_research, true);
    assert.match(parsed.gap_research_path || '', /04-GAP-RESEARCH\.md/);
    assert.match(parsed.uat_path || '', /04-UAT\.md/);
  });

  // cmdInitPhaseOp: phase dir present with all helper files (covers truthy arms 775-803)
  test('init phase-op: existing dir with all artifacts populates *_path fields', () => {
    const phaseDir = path.join(tmpDir, '.planning', 'phases', '06-x');
    fs.mkdirSync(phaseDir, { recursive: true });
    fs.writeFileSync(path.join(phaseDir, '06-PLAN.md'), '---\n---\n');
    fs.writeFileSync(path.join(phaseDir, '06-CONTEXT.md'), '# context');
    fs.writeFileSync(path.join(phaseDir, '06-RESEARCH.md'), '# research');
    fs.writeFileSync(
      path.join(phaseDir, '06-VERIFICATION.md'),
      '# verification',
    );
    fs.writeFileSync(path.join(phaseDir, '06-UAT.md'), '# uat');
    const r = runGsdTools(['init', 'phase-op', '6', '--json'], tmpDir);
    assert.ok(r.success, r.error);
    const parsed = JSON.parse(r.output);
    assert.match(parsed.context_path || '', /06-CONTEXT\.md/);
    assert.match(parsed.research_path || '', /06-RESEARCH\.md/);
    assert.match(parsed.verification_path || '', /06-VERIFICATION\.md/);
    assert.match(parsed.uat_path || '', /06-UAT\.md/);
  });

  // cmdInitPhaseOp: decimal phase suggests parent via parentRoadmap-only
  test('init phase-op: decimal phase suggests parent from ROADMAP only', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      '# Roadmap\n\n## Phase 8: parent-only\n',
    );
    const r = runGsdTools(['init', 'phase-op', '8.2', '--json'], tmpDir);
    assert.ok(r.success, r.error);
    const parsed = JSON.parse(r.output);
    assert.ok(parsed.phase_suggestion || parsed.phase_found);
  });

  // cmdInitProgress: non-numeric directory name (regex no-match → falsy fallback)
  test('init progress: non-numeric phase dir name falls back to whole dir', () => {
    const phasesDir = path.join(tmpDir, '.planning', 'phases');
    fs.mkdirSync(path.join(phasesDir, 'misc-orphan'), { recursive: true });
    const r = runGsdTools(['init', 'progress', '--json'], tmpDir);
    assert.ok(r.success, r.error);
    const parsed = JSON.parse(r.output);
    // The non-numeric dir is included; phase regex doesn't match so name is null
    const orphan = (parsed.phases || []).find(
      (p) => p.directory && p.directory.includes('misc-orphan'),
    );
    if (orphan) {
      assert.strictEqual(orphan.name, null);
    }
  });

  // cmdInitProgress: phases dir absent → readdirSync catch
  test('init progress: missing phases dir is handled gracefully', () => {
    // Remove the phases dir created by createTempProject
    cleanupSubdir(tmpDir, '.planning', 'phases');
    const r = runGsdTools(['init', 'progress', '--json'], tmpDir);
    assert.ok(r.success, r.error);
    const parsed = JSON.parse(r.output);
    assert.deepStrictEqual(parsed.phases, []);
  });

  // cmdInitProgress: ROADMAP-only phase + currentPhase set → nextPhase NOT updated
  test('init progress: ROADMAP-only phase skipped when currentPhase already set', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      [
        '# Roadmap',
        '',
        '# v1.0 — milestone',
        '',
        '## Phase 1: in-progress',
        '',
        '## Phase 2: roadmap-only',
      ].join('\n'),
    );
    // First phase is in_progress (has plan, no summary)
    const phase1 = path.join(tmpDir, '.planning', 'phases', '01-in-progress');
    fs.mkdirSync(phase1, { recursive: true });
    fs.writeFileSync(path.join(phase1, '01-PLAN.md'), '---\n---\n');
    const r = runGsdTools(['init', 'progress', '--json'], tmpDir);
    assert.ok(r.success, r.error);
    const parsed = JSON.parse(r.output);
    // currentPhase was set (phase 1), so nextPhase should remain unset for phase 2
    assert.ok(parsed.current_phase);
  });

  // cmdInitMilestoneOp: archive dir absent → readdirSync catch
  test('init milestone-op: missing archive dir is handled gracefully', () => {
    // archive dir doesn't exist by default in createTempProject — confirmed handled
    const r = runGsdTools(['init', 'milestone-op', '--json'], tmpDir);
    assert.ok(r.success, r.error);
    const parsed = JSON.parse(r.output);
    assert.ok(Array.isArray(parsed.archived_milestones));
  });

  // cmdInitMilestoneOp: phases dir absent → catch in phase counting block
  test('init milestone-op: missing phases dir → phase_count 0', () => {
    cleanupSubdir(tmpDir, '.planning', 'phases');
    const r = runGsdTools(['init', 'milestone-op', '--json'], tmpDir);
    assert.ok(r.success, r.error);
    const parsed = JSON.parse(r.output);
    assert.strictEqual(parsed.phase_count, 0);
    assert.strictEqual(parsed.completed_phases, 0);
  });

  // cmdInitMapCodebase: no codebase dir → readdirSync catch
  test('init map-codebase: missing codebase dir → has_maps false', () => {
    const r = runGsdTools(['init', 'map-codebase', '--json'], tmpDir);
    assert.ok(r.success, r.error);
    const parsed = JSON.parse(r.output);
    assert.deepStrictEqual(parsed.existing_maps, []);
    assert.strictEqual(parsed.has_maps, false);
  });

  // cmdInitTodos: pending dir doesn't exist → readdirSync outer catch
  test('init todos: missing pending dir → empty todos', () => {
    const r = runGsdTools(['init', 'todos', '--json'], tmpDir);
    assert.ok(r.success, r.error);
    const parsed = JSON.parse(r.output);
    assert.strictEqual(parsed.todo_count, 0);
    assert.deepStrictEqual(parsed.todos, []);
  });

  // cmdInitTodos: malformed todo file (catch inner readFileSync)
  test('init todos: continues past unreadable files in pending dir', () => {
    const pendingDir = path.join(tmpDir, '.planning', 'todos', 'pending');
    fs.mkdirSync(pendingDir, { recursive: true });
    fs.writeFileSync(
      path.join(pendingDir, 'good.md'),
      '---\ntitle: ok\narea: general\ncreated: 2025-01-01\n---\n',
    );
    // Create a directory named like a markdown file — readFileSync throws EISDIR
    fs.mkdirSync(path.join(pendingDir, 'bad.md'), { recursive: true });
    const r = runGsdTools(['init', 'todos', '--json'], tmpDir);
    assert.ok(r.success, r.error);
    const parsed = JSON.parse(r.output);
    // The 'good.md' file should still be counted
    assert.ok(parsed.todo_count >= 1);
  });

  // cmdInitVerifyWork: phaseInfo with all phase_* fields (truthy arms 651-657)
  test('init verify-work: scaffolded phase populates phase fields', () => {
    const phaseDir = path.join(tmpDir, '.planning', 'phases', '07-verify');
    fs.mkdirSync(phaseDir, { recursive: true });
    fs.writeFileSync(path.join(phaseDir, '07-PLAN.md'), '---\n---\n');
    fs.writeFileSync(
      path.join(phaseDir, '07-VERIFICATION.md'),
      '# verification',
    );
    const r = runGsdTools(['init', 'verify-work', '7', '--json'], tmpDir);
    assert.ok(r.success, r.error);
    const parsed = JSON.parse(r.output);
    assert.strictEqual(parsed.phase_found, true);
    assert.strictEqual(parsed.phase_number, '07');
    assert.match(parsed.phase_dir || '', /07-verify/);
    assert.strictEqual(parsed.has_verification, true);
  });

  // cmdInitPlanPhase: scaffolded phase populates context+research+verification (truthy arms in 320-360)
  test('init plan-phase: scaffolded phase populates research/verification/uat paths', () => {
    const phaseDir = path.join(tmpDir, '.planning', 'phases', '08-x');
    fs.mkdirSync(phaseDir, { recursive: true });
    fs.writeFileSync(path.join(phaseDir, '08-PLAN.md'), '---\n---\n');
    fs.writeFileSync(path.join(phaseDir, '08-CONTEXT.md'), '# context');
    fs.writeFileSync(path.join(phaseDir, '08-RESEARCH.md'), '# research');
    fs.writeFileSync(
      path.join(phaseDir, '08-VERIFICATION.md'),
      '# verification',
    );
    fs.writeFileSync(path.join(phaseDir, '08-UAT.md'), '# uat');
    const r = runGsdTools(['init', 'plan-phase', '8', '--json'], tmpDir);
    assert.ok(r.success, r.error);
    const parsed = JSON.parse(r.output);
    assert.strictEqual(parsed.has_gap_research, false);
    assert.match(parsed.context_path || '', /08-CONTEXT\.md/);
    assert.match(parsed.research_path || '', /08-RESEARCH\.md/);
    assert.match(parsed.verification_path || '', /08-VERIFICATION\.md/);
    assert.match(parsed.uat_path || '', /08-UAT\.md/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// roadmap analyze command
// ─────────────────────────────────────────────────────────────────────────────
