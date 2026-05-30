/**
 * GSD Tools Tests - config.cjs
 *
 * CLI integration tests for config-ensure-section, config-set, and config-get
 * commands exercised through gsd-tools.cjs via execSync.
 *
 * Tests: config-set/get operations, git keys, commit keys, model profiles, effort overrides
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const {
  runGsdTools,
  createTempProject,
  cleanup,
  resolveTmpDir,
} = require('./helpers.cjs');
const {
  EFFORT_PROFILES,
  MODEL_PROFILES,
  getAgentToEffortMapForProfile,
  formatAgentToEffortMapAsTable,
} = require('../gsd-ng/bin/lib/model-profiles.cjs');

const REPO_ROOT = path.resolve(__dirname, '..');

// ─── helpers ──────────────────────────────────────────────────────────────────

function readConfig(tmpDir) {
  const configPath = path.join(tmpDir, '.planning', 'config.json');
  return JSON.parse(fs.readFileSync(configPath, 'utf-8'));
}

function writeConfig(tmpDir, obj) {
  const configPath = path.join(tmpDir, '.planning', 'config.json');
  fs.writeFileSync(configPath, JSON.stringify(obj, null, 2), 'utf-8');
}

// ─── config-ensure-section ───────────────────────────────────────────────────

describe('config-ensure-section command', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('creates config.json with expected structure and types', () => {
    const result = runGsdTools('config-ensure-section --json', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.created, true);

    const config = readConfig(tmpDir);
    // Verify structure and types — exact values may vary if ~/.gsd/defaults.json exists
    assert.strictEqual(typeof config.model_profile, 'string');
    assert.strictEqual(typeof config.commit_docs, 'boolean');
    assert.strictEqual(typeof config.parallelization, 'boolean');
    assert.strictEqual(typeof config.branching_strategy, 'string');
    assert.ok(
      config.workflow && typeof config.workflow === 'object',
      'workflow should be an object',
    );
    assert.strictEqual(typeof config.workflow.research, 'boolean');
    assert.strictEqual(typeof config.workflow.plan_check, 'boolean');
    assert.strictEqual(typeof config.workflow.verifier, 'boolean');
    assert.strictEqual(typeof config.workflow.nyquist_validation, 'boolean');
    // These hardcoded defaults are always present (may be overridden by user defaults)
    assert.ok('model_profile' in config, 'model_profile should exist');
    assert.ok('search_gitignored' in config, 'search_gitignored should exist');
  });

  test('is idempotent — returns already_exists on second call', () => {
    const first = runGsdTools('config-ensure-section --json', tmpDir);
    assert.ok(first.success, `First call failed: ${first.error}`);
    const firstOutput = JSON.parse(first.output);
    assert.strictEqual(firstOutput.created, true);

    const second = runGsdTools('config-ensure-section --json', tmpDir);
    assert.ok(second.success, `Second call failed: ${second.error}`);
    const secondOutput = JSON.parse(second.output);
    assert.strictEqual(secondOutput.created, false);
    assert.strictEqual(secondOutput.reason, 'already_exists');
  });

  // Use a temp HOME so we don't touch the real ~/.gsd/ (sandbox-safe)
  test('merges user defaults from defaults.json', () => {
    const tmpHome = fs.mkdtempSync(path.join(resolveTmpDir(), 'gsd-home-'));
    fs.mkdirSync(path.join(tmpHome, '.gsd'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpHome, '.gsd', 'defaults.json'),
      JSON.stringify({
        model_profile: 'quality',
        commit_docs: false,
      }),
      'utf-8',
    );

    try {
      const result = runGsdTools('config-ensure-section', tmpDir, {
        HOME: tmpHome,
      });
      assert.ok(result.success, `Command failed: ${result.error}`);

      const config = readConfig(tmpDir);
      assert.strictEqual(
        config.model_profile,
        'quality',
        'model_profile should be overridden',
      );
      assert.strictEqual(
        config.commit_docs,
        false,
        'commit_docs should be overridden',
      );
      assert.strictEqual(
        typeof config.branching_strategy,
        'string',
        'branching_strategy should be a string',
      );
    } finally {
      cleanup(tmpHome);
    }
  });

  // Use a temp HOME so we don't touch the real ~/.gsd/ (sandbox-safe)
  test('merges nested workflow keys from defaults.json preserving unset keys', () => {
    const tmpHome = fs.mkdtempSync(path.join(resolveTmpDir(), 'gsd-home-'));
    fs.mkdirSync(path.join(tmpHome, '.gsd'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpHome, '.gsd', 'defaults.json'),
      JSON.stringify({
        workflow: { research: false },
      }),
      'utf-8',
    );

    try {
      const result = runGsdTools('config-ensure-section', tmpDir, {
        HOME: tmpHome,
      });
      assert.ok(result.success, `Command failed: ${result.error}`);

      const config = readConfig(tmpDir);
      assert.strictEqual(
        config.workflow.research,
        false,
        'research should be overridden',
      );
      assert.strictEqual(
        typeof config.workflow.plan_check,
        'boolean',
        'plan_check should be a boolean',
      );
      assert.strictEqual(
        typeof config.workflow.verifier,
        'boolean',
        'verifier should be a boolean',
      );
    } finally {
      cleanup(tmpHome);
    }
  });
});

// ─── config-set ──────────────────────────────────────────────────────────────

describe('config-set command', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
    // Create initial config
    runGsdTools('config-ensure-section', tmpDir);
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('sets a top-level string value', () => {
    const result = runGsdTools('config-set mode interactive --json', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.updated, true);
    assert.strictEqual(output.key, 'mode');
    assert.strictEqual(output.value, 'interactive');

    const config = readConfig(tmpDir);
    assert.strictEqual(config.mode, 'interactive');
  });

  test('coerces true to boolean', () => {
    const result = runGsdTools('config-set commit_docs true', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const config = readConfig(tmpDir);
    assert.strictEqual(config.commit_docs, true);
    assert.strictEqual(typeof config.commit_docs, 'boolean');
  });

  test('coerces false to boolean', () => {
    const result = runGsdTools('config-set commit_docs false', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const config = readConfig(tmpDir);
    assert.strictEqual(config.commit_docs, false);
    assert.strictEqual(typeof config.commit_docs, 'boolean');
  });

  test('coerces numeric strings to numbers', () => {
    const result = runGsdTools('config-set granularity 42', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const config = readConfig(tmpDir);
    assert.strictEqual(config.granularity, 42);
    assert.strictEqual(typeof config.granularity, 'number');
  });

  test('preserves plain strings', () => {
    const result = runGsdTools('config-set mode hello', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const config = readConfig(tmpDir);
    assert.strictEqual(config.mode, 'hello');
    assert.strictEqual(typeof config.mode, 'string');
  });

  test('sets nested values via dot-notation', () => {
    const result = runGsdTools('config-set workflow.research false', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const config = readConfig(tmpDir);
    assert.strictEqual(config.workflow.research, false);
  });

  test('auto-creates nested objects for dot-notation', () => {
    // Start with empty config
    writeConfig(tmpDir, {});

    const result = runGsdTools('config-set workflow.research false', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const config = readConfig(tmpDir);
    assert.strictEqual(config.workflow.research, false);
    assert.strictEqual(typeof config.workflow, 'object');
  });

  test('rejects unknown config keys', () => {
    const result = runGsdTools(
      'config-set workflow.nyquist_validation_enabled false',
      tmpDir,
    );
    assert.strictEqual(result.success, false);
    assert.ok(
      result.error.includes('Unknown config key'),
      `Expected "Unknown config key" in error: ${result.error}`,
    );
  });

  test('errors when no key path provided', () => {
    const result = runGsdTools('config-set', tmpDir);
    assert.strictEqual(result.success, false);
  });

  test('rejects known invalid nyquist alias keys with a suggestion', () => {
    const result = runGsdTools(
      'config-set workflow.nyquist_validation_enabled false',
      tmpDir,
    );
    assert.strictEqual(result.success, false);
    assert.match(
      result.error,
      /Unknown config key: workflow\.nyquist_validation_enabled/,
    );
    assert.match(result.error, /workflow\.nyquist_validation/);

    const config = readConfig(tmpDir);
    assert.strictEqual(config.workflow.nyquist_validation_enabled, undefined);
    assert.strictEqual(config.workflow.nyquist_validation, true);
  });
});

// ─── git config keys ───────────────────────────────────────────────────────────

describe('Phase 13 git config keys (GIT-01)', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
    // Create initial config
    runGsdTools('config-ensure-section', tmpDir);
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('GIT-01 Test 1: config-set git.target_branch develop succeeds and writes git.target_branch', () => {
    const result = runGsdTools('config-set git.target_branch develop', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const config = readConfig(tmpDir);
    assert.strictEqual(config.git.target_branch, 'develop');
  });

  test('GIT-01 Test 2: config-set git.auto_push true succeeds and writes git.auto_push as boolean', () => {
    const result = runGsdTools('config-set git.auto_push true', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const config = readConfig(tmpDir);
    assert.strictEqual(config.git.auto_push, true);
    assert.strictEqual(typeof config.git.auto_push, 'boolean');
  });

  test('GIT-01 Test 3: config-set git.remote upstream succeeds and writes git.remote', () => {
    const result = runGsdTools('config-set git.remote upstream', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const config = readConfig(tmpDir);
    assert.strictEqual(config.git.remote, 'upstream');
  });

  test('GIT-01 Test 4: config-set git.review_branch_template succeeds and writes template string', () => {
    const result = runGsdTools(
      ['config-set', 'git.review_branch_template', '{type}/{slug}'],
      tmpDir,
    );
    assert.ok(result.success, `Command failed: ${result.error}`);

    const config = readConfig(tmpDir);
    assert.strictEqual(config.git.review_branch_template, '{type}/{slug}');
  });

  test('GIT-01 Test 5: config-set git.pr_draft false succeeds and writes git.pr_draft as boolean', () => {
    const result = runGsdTools('config-set git.pr_draft false', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const config = readConfig(tmpDir);
    assert.strictEqual(config.git.pr_draft, false);
    assert.strictEqual(typeof config.git.pr_draft, 'boolean');
  });

  test('GIT-01 Test 6: config-set git.platform gitlab succeeds and writes git.platform', () => {
    const result = runGsdTools('config-set git.platform gitlab', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const config = readConfig(tmpDir);
    assert.strictEqual(config.git.platform, 'gitlab');
  });

  test('GIT-01 Test 7: config-set git.type_aliases custom succeeds (key is registered)', () => {
    const result = runGsdTools('config-set git.type_aliases custom', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);
  });

  test('GIT-01 Test 8: init execute-phase JSON includes target_branch, auto_push, remote, review_branch_template, pr_draft, platform with defaults', () => {
    const fs = require('fs');
    const path = require('path');

    // Create a ROADMAP.md with a git-branching phase entry
    const roadmapContent = `# Milestone v2.0\n\n## Phase 13: Git Branching And Collaboration\n\n**Goal:** Add git branching support\n**Requirements:** GIT-01\n`;
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      roadmapContent,
      'utf-8',
    );

    // Create the phase directory and a dummy plan
    fs.mkdirSync(
      path.join(
        tmpDir,
        '.planning',
        'phases',
        '13-git-branching-and-collaboration',
      ),
      { recursive: true },
    );
    fs.writeFileSync(
      path.join(
        tmpDir,
        '.planning',
        'phases',
        '13-git-branching-and-collaboration',
        '13-01-PLAN.md',
      ),
      '---\nphase: 13\nplan: 01\n---\n\n# Plan\n',
      'utf-8',
    );

    const result = runGsdTools('init execute-phase 13 --json', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.ok('target_branch' in output, 'output should include target_branch');
    assert.ok('auto_push' in output, 'output should include auto_push');
    assert.ok('remote' in output, 'output should include remote');
    assert.ok(
      'review_branch_template' in output,
      'output should include review_branch_template',
    );
    assert.ok('pr_draft' in output, 'output should include pr_draft');
    assert.ok('platform' in output, 'output should include platform');
  });

  test('GIT-01 Test 9: loadConfig returns target_branch: "main" by default (verified via init output)', () => {
    const fs = require('fs');
    const path = require('path');

    const roadmapContent = `# Milestone v2.0\n\n## Phase 13: Git Branching And Collaboration\n\n**Goal:** Add git branching support\n**Requirements:** GIT-01\n`;
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      roadmapContent,
      'utf-8',
    );

    fs.mkdirSync(
      path.join(
        tmpDir,
        '.planning',
        'phases',
        '13-git-branching-and-collaboration',
      ),
      { recursive: true },
    );
    fs.writeFileSync(
      path.join(
        tmpDir,
        '.planning',
        'phases',
        '13-git-branching-and-collaboration',
        '13-01-PLAN.md',
      ),
      '---\nphase: 13\nplan: 01\n---\n\n# Plan\n',
      'utf-8',
    );

    const result = runGsdTools('init execute-phase 13 --json', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(
      output.target_branch,
      'main',
      'default target_branch should be "main"',
    );
  });

  test('GIT-01 Test 10: loadConfig returns auto_push: false by default (verified via init output)', () => {
    const fs = require('fs');
    const path = require('path');

    const roadmapContent = `# Milestone v2.0\n\n## Phase 13: Git Branching And Collaboration\n\n**Goal:** Add git branching support\n**Requirements:** GIT-01\n`;
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      roadmapContent,
      'utf-8',
    );

    fs.mkdirSync(
      path.join(
        tmpDir,
        '.planning',
        'phases',
        '13-git-branching-and-collaboration',
      ),
      { recursive: true },
    );
    fs.writeFileSync(
      path.join(
        tmpDir,
        '.planning',
        'phases',
        '13-git-branching-and-collaboration',
        '13-01-PLAN.md',
      ),
      '---\nphase: 13\nplan: 01\n---\n\n# Plan\n',
      'utf-8',
    );

    const result = runGsdTools('init execute-phase 13 --json', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(
      output.auto_push,
      false,
      'default auto_push should be false',
    );
  });

  test('GIT-01 Test 11: After config-set git.target_branch develop, init execute-phase returns target_branch: "develop"', () => {
    const fs = require('fs');
    const path = require('path');

    const roadmapContent = `# Milestone v2.0\n\n## Phase 13: Git Branching And Collaboration\n\n**Goal:** Add git branching support\n**Requirements:** GIT-01\n`;
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      roadmapContent,
      'utf-8',
    );

    fs.mkdirSync(
      path.join(
        tmpDir,
        '.planning',
        'phases',
        '13-git-branching-and-collaboration',
      ),
      { recursive: true },
    );
    fs.writeFileSync(
      path.join(
        tmpDir,
        '.planning',
        'phases',
        '13-git-branching-and-collaboration',
        '13-01-PLAN.md',
      ),
      '---\nphase: 13\nplan: 01\n---\n\n# Plan\n',
      'utf-8',
    );

    // First set the target branch
    const setResult = runGsdTools(
      'config-set git.target_branch develop',
      tmpDir,
    );
    assert.ok(setResult.success, `config-set failed: ${setResult.error}`);

    // Then verify init execute-phase returns the updated value
    const initResult = runGsdTools('init execute-phase 13 --json', tmpDir);
    assert.ok(initResult.success, `init failed: ${initResult.error}`);

    const output = JSON.parse(initResult.output);
    assert.strictEqual(
      output.target_branch,
      'develop',
      'target_branch should be "develop" after config-set',
    );
  });
});

// ─── config-get ──────────────────────────────────────────────────────────────

describe('config-get command', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
    // Create config with known values
    runGsdTools('config-ensure-section', tmpDir);
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('gets a top-level value', () => {
    const result = runGsdTools('config-get model_profile --json', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output, 'balanced');
  });

  test('gets a nested value via dot-notation', () => {
    const result = runGsdTools('config-get workflow.research --json', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output, true);
  });

  test('errors for nonexistent key', () => {
    const result = runGsdTools('config-get nonexistent_key', tmpDir);
    assert.strictEqual(result.success, false);
    assert.ok(
      result.error.includes('Unknown config key'),
      `Expected "Unknown config key" in error: ${result.error}`,
    );
  });

  test('errors for deeply nested nonexistent key', () => {
    const result = runGsdTools('config-get workflow.nonexistent', tmpDir);
    assert.strictEqual(result.success, false);
    assert.ok(
      result.error.includes('Unknown config key'),
      `Expected "Unknown config key" in error: ${result.error}`,
    );
  });

  test('errors when config.json does not exist', () => {
    const emptyTmpDir = createTempProject();
    try {
      const result = runGsdTools('config-get model_profile', emptyTmpDir);
      assert.strictEqual(result.success, false);
      assert.ok(
        result.error.includes('No config.json'),
        `Expected "No config.json" in error: ${result.error}`,
      );
    } finally {
      cleanup(emptyTmpDir);
    }
  });

  test('errors when no key path provided', () => {
    const result = runGsdTools('config-get', tmpDir);
    assert.strictEqual(result.success, false);
  });
});

// ─── commit and versioning config keys ────────────────────────────────────────

describe('git commit and versioning config keys', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
    runGsdTools('config-ensure-section', tmpDir);
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('config-set git.commit_format conventional succeeds', () => {
    const result = runGsdTools(
      'config-set git.commit_format conventional',
      tmpDir,
    );
    assert.ok(result.success, `Failed: ${result.error}`);
    const config = readConfig(tmpDir);
    assert.strictEqual(config.git.commit_format, 'conventional');
  });

  test('config-set git.commit_template with custom string', () => {
    const result = runGsdTools(
      ['config-set', 'git.commit_template', '{type}: {description}'],
      tmpDir,
    );
    assert.ok(result.success, `Failed: ${result.error}`);
    const config = readConfig(tmpDir);
    assert.strictEqual(config.git.commit_template, '{type}: {description}');
  });

  test('config-set git.versioning_scheme semver succeeds', () => {
    const result = runGsdTools(
      'config-set git.versioning_scheme semver',
      tmpDir,
    );
    assert.ok(result.success, `Failed: ${result.error}`);
    const config = readConfig(tmpDir);
    assert.strictEqual(config.git.versioning_scheme, 'semver');
  });

  test('config-get git.commit_format returns set value', () => {
    writeConfig(tmpDir, { git: { commit_format: 'issue-first' } });
    const result = runGsdTools('config-get git.commit_format --json', tmpDir);
    assert.ok(result.success, `Failed: ${result.error}`);
    assert.strictEqual(JSON.parse(result.output), 'issue-first');
  });
});

// ─── issue_tracker.verify_label config key ───────────────────────────────────

describe('issue_tracker.verify_label config key (VERIFY-01)', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
    runGsdTools('config-ensure-section', tmpDir);
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  // Test 9: config-set issue_tracker.verify_label 'reviewed' succeeds
  test('VERIFY-01 config-set issue_tracker.verify_label reviewed succeeds', () => {
    const result = runGsdTools(
      'config-set issue_tracker.verify_label reviewed',
      tmpDir,
    );
    assert.ok(result.success, `Command failed: ${result.error}`);

    const config = readConfig(tmpDir);
    assert.strictEqual(config.issue_tracker.verify_label, 'reviewed');
  });

  test('VERIFY-01 config-set issue_tracker.verify_label needs-verification succeeds', () => {
    const result = runGsdTools(
      ['config-set', 'issue_tracker.verify_label', 'needs-verification'],
      tmpDir,
    );
    assert.ok(result.success, `Command failed: ${result.error}`);

    const config = readConfig(tmpDir);
    assert.strictEqual(config.issue_tracker.verify_label, 'needs-verification');
  });
});

// ─── per-submodule config keys ────────────────────────────────────────────────

describe('Per-submodule config keys (SUBMOD-01)', () => {
  let tmpDir;
  beforeEach(() => {
    tmpDir = createTempProject();
    runGsdTools('config-ensure-section', tmpDir);
  });
  afterEach(() => {
    cleanup(tmpDir);
  });

  test('SUBMOD-01a: config-set git.submodules.mylib.target_branch is valid', () => {
    const result = runGsdTools(
      'config-set git.submodules.mylib.target_branch develop',
      tmpDir,
    );
    assert.ok(result.success, `Command failed: ${result.error}`);
    const config = readConfig(tmpDir);
    assert.strictEqual(config.git?.submodules?.mylib?.target_branch, 'develop');
  });

  test('SUBMOD-01b: config-set git.submodules.mylib.unknown_key is rejected', () => {
    const result = runGsdTools(
      'config-set git.submodules.mylib.unknown_key value',
      tmpDir,
    );
    assert.strictEqual(
      result.success,
      false,
      'Should reject unknown per-submodule key',
    );
  });

  test('SUBMOD-01c: config-set git.submodule.workspace_branch is rejected with deprecation message', () => {
    const result = runGsdTools(
      'config-set git.submodule.workspace_branch develop',
      tmpDir,
    );
    assert.strictEqual(result.success, false, 'Should reject deprecated key');
    assert.match(result.error || result.stderr || '', /deprecated/i);
  });

  test('SUBMOD-01d: config-get git.submodule.workspace_branch emits deprecation warning on stderr', () => {
    // Write the value directly so config-get has something to read
    const configPath = path.join(tmpDir, '.planning', 'config.json');
    const existing = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    existing.git = existing.git || {};
    existing.git.submodule = { workspace_branch: 'develop' };
    fs.writeFileSync(configPath, JSON.stringify(existing, null, 2));

    const result = runGsdTools(
      'config-get git.submodule.workspace_branch',
      tmpDir,
    );
    // Should succeed (returns value for migration) but stderr has warning
    assert.match(
      result.stderr || result.output || result.error || '',
      /deprecated/i,
    );
  });
});

// ─── EFFORT_PROFILES ──────────────────────────────────────────────────────────

describe('EFFORT_PROFILES', () => {
  const EXPECTED_AGENTS = [
    'gsd-planner',
    'gsd-roadmapper',
    'gsd-executor',
    'gsd-phase-researcher',
    'gsd-project-researcher',
    'gsd-research-synthesizer',
    'gsd-debugger',
    'gsd-codebase-mapper',
    'gsd-incremental-mapper',
    'gsd-verifier',
    'gsd-plan-checker',
    'gsd-integration-checker',
    'gsd-nyquist-auditor',
    'gsd-ui-researcher',
    'gsd-ui-auditor',
  ];

  test('Test 1: EFFORT_PROFILES has all 15 agent entries', () => {
    const agents = Object.keys(EFFORT_PROFILES);
    assert.strictEqual(
      agents.length,
      15,
      `Expected 15 agents, got ${agents.length}: ${agents.join(', ')}`,
    );
    for (const agent of EXPECTED_AGENTS) {
      assert.ok(agent in EFFORT_PROFILES, `Missing agent: ${agent}`);
    }
  });

  test('Test 2: EFFORT_PROFILES quality profile has correct max/high values', () => {
    assert.strictEqual(EFFORT_PROFILES['gsd-planner'].quality, 'max');
    assert.strictEqual(EFFORT_PROFILES['gsd-debugger'].quality, 'max');
    assert.strictEqual(EFFORT_PROFILES['gsd-verifier'].quality, 'max');
    assert.strictEqual(EFFORT_PROFILES['gsd-roadmapper'].quality, 'max');
    assert.strictEqual(EFFORT_PROFILES['gsd-executor'].quality, 'high');
  });

  test('Test 3: EFFORT_PROFILES balanced profile has all agents set to inherit', () => {
    for (const [agent, profiles] of Object.entries(EFFORT_PROFILES)) {
      assert.strictEqual(
        profiles.balanced,
        'inherit',
        `Expected balanced to be 'inherit' for ${agent}, got '${profiles.balanced}'`,
      );
    }
  });

  test('Test 4: EFFORT_PROFILES budget profile has correct high/medium values', () => {
    assert.strictEqual(EFFORT_PROFILES['gsd-planner'].budget, 'high');
    assert.strictEqual(EFFORT_PROFILES['gsd-executor'].budget, 'high');
    assert.strictEqual(EFFORT_PROFILES['gsd-debugger'].budget, 'high');
    assert.strictEqual(EFFORT_PROFILES['gsd-verifier'].budget, 'high');
    assert.strictEqual(EFFORT_PROFILES['gsd-codebase-mapper'].budget, 'medium');
  });

  test('Test 5: getAgentToEffortMapForProfile quality returns object with all 15 agents mapped', () => {
    const map = getAgentToEffortMapForProfile('quality');
    assert.strictEqual(typeof map, 'object');
    assert.strictEqual(Object.keys(map).length, 15);
    for (const agent of EXPECTED_AGENTS) {
      assert.ok(agent in map, `Missing agent in quality map: ${agent}`);
      assert.strictEqual(typeof map[agent], 'string');
    }
  });

  test('Test 6: getAgentToEffortMapForProfile balanced returns all values as inherit', () => {
    const map = getAgentToEffortMapForProfile('balanced');
    for (const [agent, effort] of Object.entries(map)) {
      assert.strictEqual(
        effort,
        'inherit',
        `Expected 'inherit' for ${agent}, got '${effort}'`,
      );
    }
  });

  test('Test 7: formatAgentToEffortMapAsTable produces string with Agent and Effort column headers', () => {
    const map = getAgentToEffortMapForProfile('quality');
    const table = formatAgentToEffortMapAsTable(map);
    assert.strictEqual(typeof table, 'string');
    assert.ok(table.includes('Agent'), 'Table should contain "Agent" header');
    assert.ok(table.includes('Effort'), 'Table should contain "Effort" header');
  });

  test('Test 8: VALID_PROFILES is shared — quality, balanced, budget profiles exist in EFFORT_PROFILES', () => {
    const firstAgent = EFFORT_PROFILES['gsd-planner'];
    assert.ok('quality' in firstAgent, 'quality profile should exist');
    assert.ok('balanced' in firstAgent, 'balanced profile should exist');
    assert.ok('budget' in firstAgent, 'budget profile should exist');
    assert.strictEqual(
      Object.keys(firstAgent).length,
      3,
      'Should have exactly 3 profiles',
    );
  });

  test('Test 9: EFFORT_PROFILES and MODEL_PROFILES share the same agent set (no key drift)', () => {
    const effortKeys = Object.keys(EFFORT_PROFILES).sort();
    const modelKeys = Object.keys(MODEL_PROFILES).sort();
    const effortOnly = effortKeys.filter((k) => !modelKeys.includes(k));
    const modelOnly = modelKeys.filter((k) => !effortKeys.includes(k));
    assert.deepStrictEqual(
      effortOnly,
      [],
      `Agents in EFFORT_PROFILES but missing from MODEL_PROFILES (would fall through to default 'sonnet'): ${effortOnly.join(', ')}`,
    );
    assert.deepStrictEqual(
      modelOnly,
      [],
      `Agents in MODEL_PROFILES but missing from EFFORT_PROFILES: ${modelOnly.join(', ')}`,
    );
  });
});

// ─── set-profile effort display and config-set effort_overrides ─────────────────

describe('set-profile effort display and effort_overrides config-set (EFF-04, EFF-05)', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
    runGsdTools('config-ensure-section', tmpDir);
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('Test 6: cmdConfigSetModelProfile result includes agentToEffortMap field', () => {
    const result = runGsdTools(
      'config-set-model-profile quality --json',
      tmpDir,
    );
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.ok(
      'agentToEffortMap' in output,
      'result should include agentToEffortMap',
    );
    assert.ok(
      typeof output.agentToEffortMap === 'object',
      'agentToEffortMap should be an object',
    );
    assert.ok(
      'gsd-executor' in output.agentToEffortMap,
      'agentToEffortMap should have gsd-executor key',
    );
  });

  test('Test 7: set-profile raw message includes "Effort" table header', () => {
    const result = runGsdTools('config-set-model-profile quality', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    assert.ok(
      result.output.includes('Effort'),
      `Raw output should contain "Effort" table header. Got: ${result.output.substring(0, 300)}`,
    );
  });

  test('Test 9: config-set accepts effort_overrides.gsd-executor as valid key', () => {
    const result = runGsdTools(
      'config-set effort_overrides.gsd-executor max',
      tmpDir,
    );
    assert.ok(
      result.success,
      `config-set effort_overrides.gsd-executor should succeed, got error: ${result.error}`,
    );

    const config = JSON.parse(
      require('fs').readFileSync(
        require('path').join(tmpDir, '.planning', 'config.json'),
        'utf-8',
      ),
    );
    assert.strictEqual(config.effort_overrides['gsd-executor'], 'max');
  });

  test('Test 10: config-set accepts effort_overrides.gsd-planner as valid key', () => {
    const result = runGsdTools(
      'config-set effort_overrides.gsd-planner high',
      tmpDir,
    );
    assert.ok(
      result.success,
      `config-set effort_overrides.gsd-planner should succeed, got error: ${result.error}`,
    );

    const config = JSON.parse(
      require('fs').readFileSync(
        require('path').join(tmpDir, '.planning', 'config.json'),
        'utf-8',
      ),
    );
    assert.strictEqual(config.effort_overrides['gsd-planner'], 'high');
  });

  test('Test 11: config-set rejects effort_overrides_typo.gsd-executor as invalid key', () => {
    const result = runGsdTools(
      'config-set effort_overrides_typo.gsd-executor max',
      tmpDir,
    );
    assert.strictEqual(
      result.success,
      false,
      'effort_overrides_typo.gsd-executor should be rejected as unknown config key',
    );
    assert.ok(
      result.error.includes('Unknown config key'),
      `Expected "Unknown config key" in error, got: ${result.error}`,
    );
  });

  test('Test 12: config-set accepts effort_overrides.gsd-executor xhigh', () => {
    const result = runGsdTools(
      'config-set effort_overrides.gsd-executor xhigh',
      tmpDir,
    );
    assert.ok(
      result.success,
      `config-set effort_overrides.gsd-executor xhigh should succeed, got error: ${result.error}`,
    );

    const config = JSON.parse(
      require('fs').readFileSync(
        require('path').join(tmpDir, '.planning', 'config.json'),
        'utf-8',
      ),
    );
    assert.strictEqual(config.effort_overrides['gsd-executor'], 'xhigh');
  });

  test('Test 13: config-set rejects invalid effort value (typo xhign)', () => {
    const result = runGsdTools(
      'config-set effort_overrides.gsd-executor xhign',
      tmpDir,
    );
    assert.strictEqual(
      result.success,
      false,
      'effort_overrides.gsd-executor xhign should be rejected as invalid effort value',
    );
    assert.ok(
      result.error.includes('xhign'),
      `Expected "xhign" in error, got: ${result.error}`,
    );
    assert.ok(
      result.error.includes('low, medium, high, xhigh, max, inherit'),
      `Expected valid values list in error, got: ${result.error}`,
    );
  });

  test('Test 14: config-set rejects invalid effort value (banana)', () => {
    const result = runGsdTools(
      'config-set effort_overrides.gsd-executor banana',
      tmpDir,
    );
    assert.strictEqual(
      result.success,
      false,
      'effort_overrides.gsd-executor banana should be rejected as invalid effort value',
    );
    assert.ok(
      result.error.includes('banana'),
      `Expected "banana" in error, got: ${result.error}`,
    );
    assert.ok(
      result.error.includes('low, medium, high, xhigh, max, inherit'),
      `Expected valid values list in error, got: ${result.error}`,
    );
  });
});

// ─── effort sync wiring ───────────────────────────────────────────────────────

describe('Phase 55 — effort sync wiring', () => {
  let tmpDir;
  let copilotMarkerDir;
  const { createTempProjectWithAgents } = require('./helpers.cjs');
  afterEach(() => {
    if (tmpDir) cleanup(tmpDir);
    if (copilotMarkerDir) {
      try {
        cleanup(copilotMarkerDir);
      } catch {}
      copilotMarkerDir = undefined;
    }
  });

  function makeCopilotMarkerDir() {
    const dir = fs.mkdtempSync(
      path.join(resolveTmpDir(), 'gsd-copilot-marker-'),
    );
    fs.writeFileSync(path.join(dir, '.runtime'), 'copilot\n', 'utf-8');
    return dir;
  }

  test('EFFSYNC-CONFIG-01: config-set-model-profile quality syncs agents and prints restart notice on stderr', () => {
    tmpDir = createTempProjectWithAgents(['gsd-planner', 'gsd-executor'], {
      config: { runtime: 'claude', model_profile: 'balanced' },
    });
    const result = runGsdTools(['config-set-model-profile', 'quality'], tmpDir);
    assert.ok(result.success, `command failed: ${result.error}`);
    assert.ok(
      result.stderr.includes('Restart Claude Code to apply effort changes.'),
      `restart notice missing from stderr: ${result.stderr}`,
    );
    const planner = fs.readFileSync(
      path.join(tmpDir, '.claude/agents/gsd-planner.md'),
      'utf-8',
    );
    assert.match(planner, /^effort: max$/m);
  });

  test('EFFSYNC-CONFIG-02: config-set effort_overrides.gsd-executor low syncs and prints restart notice', () => {
    tmpDir = createTempProjectWithAgents(['gsd-planner', 'gsd-executor'], {
      config: { runtime: 'claude', model_profile: 'quality' },
    });
    // First sync to baseline
    runGsdTools(['config-set-model-profile', 'quality'], tmpDir);
    const result = runGsdTools(
      ['config-set', 'effort_overrides.gsd-executor', 'low'],
      tmpDir,
    );
    assert.ok(result.success, `command failed: ${result.error}`);
    assert.ok(
      result.stderr.includes('Restart Claude Code to apply effort changes.'),
      `restart notice missing: ${result.stderr}`,
    );
    const executor = fs.readFileSync(
      path.join(tmpDir, '.claude/agents/gsd-executor.md'),
      'utf-8',
    );
    assert.match(executor, /^effort: low$/m);
  });

  test('EFFSYNC-CONFIG-03: restart notice is suppressed when no agent changed (idempotent re-set)', () => {
    tmpDir = createTempProjectWithAgents(['gsd-planner'], {
      config: { runtime: 'claude', model_profile: 'quality' },
    });
    runGsdTools(['config-set-model-profile', 'quality'], tmpDir); // baseline
    const result = runGsdTools(['config-set-model-profile', 'quality'], tmpDir); // re-set, no change
    assert.ok(result.success);
    assert.ok(
      !result.stderr.includes('Restart Claude Code'),
      `restart notice should NOT appear when no changes: stderr was: ${result.stderr}`,
    );
  });

  test('EFFSYNC-CONFIG-04: config-get model_profile is gated to defaultValue on Copilot runtime', () => {
    copilotMarkerDir = makeCopilotMarkerDir();
    tmpDir = createTempProjectWithAgents(['gsd-planner'], {
      // hand-edited copilot config that includes profile keys (the strip must hide them)
      config: {
        model_profile: 'quality',
        effort_overrides: { 'gsd-executor': 'high' },
      },
    });
    const env = { GSD_TEST_RUNTIME_MARKER_DIR: copilotMarkerDir };
    // With --default flag, Copilot consumer gets the default (key treated as not-present)
    const withDefault = runGsdTools(
      ['config-get', 'model_profile', '--default', 'balanced'],
      tmpDir,
      env,
    );
    assert.ok(
      withDefault.success,
      `expected success with --default, got: ${withDefault.error}`,
    );
    assert.match(
      withDefault.output.trim(),
      /^balanced$/,
      `expected default 'balanced', got: ${withDefault.output}`,
    );
    // Without --default, Copilot consumer gets a Key not found error
    const noDefault = runGsdTools(['config-get', 'model_profile'], tmpDir, env);
    assert.ok(
      !noDefault.success,
      `expected failure without --default, but command succeeded`,
    );
    assert.ok(
      (noDefault.stderr || noDefault.error || '').includes('Key not found'),
      `expected 'Key not found' error, got stderr=${noDefault.stderr} error=${noDefault.error}`,
    );
  });

  test('EFFSYNC-CONFIG-05: config-get model_profile returns the actual value on Claude runtime (no regression)', () => {
    tmpDir = createTempProjectWithAgents(['gsd-planner'], {
      config: { runtime: 'claude', model_profile: 'quality' },
    });
    const result = runGsdTools(['config-get', 'model_profile'], tmpDir);
    assert.ok(result.success, `expected success, got: ${result.error}`);
    assert.match(
      result.output.trim(),
      /^quality$/,
      `expected 'quality', got: ${result.output}`,
    );
  });

  test('EFFSYNC-CONFIG-06: config-get effort_overrides.gsd-executor is gated on Copilot runtime', () => {
    copilotMarkerDir = makeCopilotMarkerDir();
    tmpDir = createTempProjectWithAgents(['gsd-planner'], {
      config: { effort_overrides: { 'gsd-executor': 'high' } },
    });
    const result = runGsdTools(
      ['config-get', 'effort_overrides.gsd-executor'],
      tmpDir,
      { GSD_TEST_RUNTIME_MARKER_DIR: copilotMarkerDir },
    );
    assert.ok(
      !result.success,
      `expected failure on copilot, but command succeeded with output: ${result.output}`,
    );
    assert.ok(
      (result.stderr || result.error || '').includes('Key not found'),
      `expected 'Key not found' error, got stderr=${result.stderr} error=${result.error}`,
    );
  });

  test('EFFSYNC-CONFIG-07: config-set model_profile is rejected and points users to config-set-model-profile', () => {
    tmpDir = createTempProjectWithAgents(['gsd-planner'], {
      config: { runtime: 'claude', model_profile: 'balanced' },
    });
    const result = runGsdTools(
      ['config-set', 'model_profile', 'quality'],
      tmpDir,
    );
    assert.ok(
      !result.success,
      `expected failure, but config-set model_profile succeeded: ${result.output}`,
    );
    const msg = result.stderr || result.error || '';
    assert.ok(
      msg.includes('config-set-model-profile'),
      `error should name the correct command, got: ${msg}`,
    );
    // The key must NOT have been written (value still matches the pre-seeded profile).
    const cfg = JSON.parse(
      fs.readFileSync(path.join(tmpDir, '.planning/config.json'), 'utf-8'),
    );
    assert.strictEqual(
      cfg.model_profile,
      'balanced',
      'config must be untouched by rejected set',
    );
  });
});

// ─── branch-coverage uplift for config.cjs ───────────────────────────────────
//
// These tests target the uncovered branches enumerated in the per-file gap
// analysis: ensureConfigFile error paths, the depth->granularity migration
// in ~/.gsd/defaults.json, malformed-defaults catch, setConfigValue read/write
// failure paths, cmdConfigGet defaultValue branches (no-config / non-object
// intermediate / undefined leaf), and cmdConfigSetModelProfile validation.
//
// Most tests use OS-level file/permission manipulation in temp dirs (chmod
// to force EACCES, write a regular file at a directory path to force ENOTDIR)
// rather than mocking node:fs internals — matches the no-internal-mocking
// policy from CONTEXT.md and the helpers convention.

describe('ensureConfigFile error paths', () => {
  test('mkdirSync throws when .planning parent is read-only (EACCES)', () => {
    const tmpDir = fs.mkdtempSync(path.join(resolveTmpDir(), 'gsd-test-'));
    fs.chmodSync(tmpDir, 0o555);
    try {
      const result = runGsdTools(['config-ensure-section'], tmpDir);
      assert.strictEqual(result.success, false);
      assert.match(
        result.stderr,
        /Failed to create \.planning directory/,
        `Expected mkdirSync error in stderr, got: ${result.stderr}`,
      );
    } finally {
      fs.chmodSync(tmpDir, 0o755);
      cleanup(tmpDir);
    }
  });

  test('writeFileSync errors when .planning path exists as a regular file (ENOTDIR)', () => {
    const tmpDir = fs.mkdtempSync(path.join(resolveTmpDir(), 'gsd-test-'));
    // Place a file at the path .planning/ would occupy. fs.existsSync returns
    // true (so mkdirSync is skipped at L102), then writeFileSync fails at L162.
    fs.writeFileSync(
      path.join(tmpDir, '.planning'),
      'i am a file, not a directory',
    );
    try {
      const result = runGsdTools(['config-ensure-section'], tmpDir);
      assert.strictEqual(result.success, false);
      assert.match(
        result.stderr,
        /Failed to create config\.json/,
        `Expected writeFileSync error in stderr, got: ${result.stderr}`,
      );
    } finally {
      cleanup(tmpDir);
    }
  });
});

describe('global defaults.json depth-to-granularity migration', () => {
  test('migrates depth=standard to granularity=standard and rewrites defaults.json', () => {
    const tmpDir = createTempProject();
    // Remove the auto-created planning dir's .planning marker so ensureConfigFile creates fresh.
    fs.rmSync(path.join(tmpDir, '.planning', 'config.json'), { force: true });

    const tmpHome = fs.mkdtempSync(path.join(resolveTmpDir(), 'gsd-home-'));
    fs.mkdirSync(path.join(tmpHome, '.gsd'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpHome, '.gsd', 'defaults.json'),
      JSON.stringify({ depth: 'standard' }),
    );

    try {
      const result = runGsdTools(['config-ensure-section', '--json'], tmpDir, {
        HOME: tmpHome,
      });
      assert.ok(result.success, `Command failed: ${result.error}`);

      // defaults.json should be rewritten with granularity, depth removed.
      const after = JSON.parse(
        fs.readFileSync(path.join(tmpHome, '.gsd', 'defaults.json'), 'utf-8'),
      );
      assert.ok(
        !('depth' in after),
        'depth should be removed from defaults.json',
      );
      assert.strictEqual(after.granularity, 'standard');

      // Newly created config.json should pick up the migrated granularity value.
      const config = readConfig(tmpDir);
      assert.strictEqual(config.granularity, 'standard');
    } finally {
      cleanup(tmpDir);
      cleanup(tmpHome);
    }
  });

  test('migrates depth=quick to granularity=coarse via the value mapping', () => {
    const tmpDir = createTempProject();
    fs.rmSync(path.join(tmpDir, '.planning', 'config.json'), { force: true });

    const tmpHome = fs.mkdtempSync(path.join(resolveTmpDir(), 'gsd-home-'));
    fs.mkdirSync(path.join(tmpHome, '.gsd'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpHome, '.gsd', 'defaults.json'),
      JSON.stringify({ depth: 'quick' }),
    );

    try {
      const result = runGsdTools(['config-ensure-section', '--json'], tmpDir, {
        HOME: tmpHome,
      });
      assert.ok(result.success, `Command failed: ${result.error}`);

      const after = JSON.parse(
        fs.readFileSync(path.join(tmpHome, '.gsd', 'defaults.json'), 'utf-8'),
      );
      assert.strictEqual(
        after.granularity,
        'coarse',
        'quick should map to coarse',
      );
    } finally {
      cleanup(tmpDir);
      cleanup(tmpHome);
    }
  });

  test('preserves unknown depth value via the fallback (depthToGranularity[depth] || depth)', () => {
    const tmpDir = createTempProject();
    fs.rmSync(path.join(tmpDir, '.planning', 'config.json'), { force: true });

    const tmpHome = fs.mkdtempSync(path.join(resolveTmpDir(), 'gsd-home-'));
    fs.mkdirSync(path.join(tmpHome, '.gsd'), { recursive: true });
    // 'verbose' is not a key in {quick, standard, comprehensive} — exercises the
    // `|| userDefaults.depth` fallback when the value isn't in the migration table.
    fs.writeFileSync(
      path.join(tmpHome, '.gsd', 'defaults.json'),
      JSON.stringify({ depth: 'verbose' }),
    );

    try {
      const result = runGsdTools(['config-ensure-section', '--json'], tmpDir, {
        HOME: tmpHome,
      });
      assert.ok(result.success, `Command failed: ${result.error}`);

      const after = JSON.parse(
        fs.readFileSync(path.join(tmpHome, '.gsd', 'defaults.json'), 'utf-8'),
      );
      assert.strictEqual(
        after.granularity,
        'verbose',
        'unknown depth should pass through unchanged',
      );
    } finally {
      cleanup(tmpDir);
      cleanup(tmpHome);
    }
  });

  test('swallows write failure when migrating defaults.json on a read-only file', () => {
    const tmpDir = createTempProject();
    fs.rmSync(path.join(tmpDir, '.planning', 'config.json'), { force: true });

    const tmpHome = fs.mkdtempSync(path.join(resolveTmpDir(), 'gsd-home-'));
    const homeGsd = path.join(tmpHome, '.gsd');
    fs.mkdirSync(homeGsd, { recursive: true });
    const defaultsPath = path.join(homeGsd, 'defaults.json');
    fs.writeFileSync(defaultsPath, JSON.stringify({ depth: 'standard' }));
    // Read-only directory blocks the rewrite (writeFileSync of an existing file
    // requires write permission on the parent dir to replace via tmp+rename in
    // some node implementations; on Linux the open(O_TRUNC) needs file write
    // permission). Make the FILE read-only so writeFileSync fails inside the
    // migration's `try { fs.writeFileSync(globalDefaultsPath, ...) } catch {}`.
    fs.chmodSync(defaultsPath, 0o444);

    try {
      const result = runGsdTools(['config-ensure-section', '--json'], tmpDir, {
        HOME: tmpHome,
      });
      // Migration's catch is empty — the write failure is silently swallowed and
      // ensureConfigFile still creates config.json with the migrated value in memory.
      assert.ok(
        result.success,
        `Command should succeed despite read-only defaults.json: ${result.error}`,
      );
      const config = readConfig(tmpDir);
      assert.strictEqual(config.granularity, 'standard');
    } finally {
      fs.chmodSync(defaultsPath, 0o644);
      cleanup(tmpDir);
      cleanup(tmpHome);
    }
  });

  test('skips migration when depth and granularity are both present', () => {
    const tmpDir = createTempProject();
    fs.rmSync(path.join(tmpDir, '.planning', 'config.json'), { force: true });

    const tmpHome = fs.mkdtempSync(path.join(resolveTmpDir(), 'gsd-home-'));
    fs.mkdirSync(path.join(tmpHome, '.gsd'), { recursive: true });
    const original = { depth: 'standard', granularity: 'fine' };
    fs.writeFileSync(
      path.join(tmpHome, '.gsd', 'defaults.json'),
      JSON.stringify(original),
    );

    try {
      const result = runGsdTools(['config-ensure-section', '--json'], tmpDir, {
        HOME: tmpHome,
      });
      assert.ok(result.success, `Command failed: ${result.error}`);

      // defaults.json untouched — both keys still present.
      const after = JSON.parse(
        fs.readFileSync(path.join(tmpHome, '.gsd', 'defaults.json'), 'utf-8'),
      );
      assert.deepStrictEqual(after, original);
    } finally {
      cleanup(tmpDir);
      cleanup(tmpHome);
    }
  });

  test('falls back to defaults when global defaults.json is malformed JSON', () => {
    const tmpDir = createTempProject();
    fs.rmSync(path.join(tmpDir, '.planning', 'config.json'), { force: true });

    const tmpHome = fs.mkdtempSync(path.join(resolveTmpDir(), 'gsd-home-'));
    fs.mkdirSync(path.join(tmpHome, '.gsd'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpHome, '.gsd', 'defaults.json'),
      'NOT_VALID_JSON{{{',
    );

    try {
      const result = runGsdTools(['config-ensure-section', '--json'], tmpDir, {
        HOME: tmpHome,
      });
      assert.ok(
        result.success,
        `Command should succeed despite malformed defaults: ${result.error}`,
      );
      const config = readConfig(tmpDir);
      assert.strictEqual(
        typeof config.model_profile,
        'string',
        'should fall through to hardcoded defaults',
      );
      assert.ok(
        'workflow' in config,
        'workflow defaults should still be applied',
      );
    } finally {
      cleanup(tmpDir);
      cleanup(tmpHome);
    }
  });
});

describe('setConfigValue error paths', () => {
  test('errors when config.json is unreadable JSON', () => {
    const tmpDir = createTempProject();
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'config.json'),
      'NOT_VALID_JSON{{{',
    );
    try {
      const result = runGsdTools(['config-set', 'mode', 'interactive'], tmpDir);
      assert.strictEqual(result.success, false);
      assert.match(
        result.stderr,
        /Failed to read config\.json/,
        `Expected read-failure error, got: ${result.stderr}`,
      );
    } finally {
      cleanup(tmpDir);
    }
  });

  test('errors when writeFileSync fails on read-only config.json', () => {
    const tmpDir = createTempProject();
    runGsdTools(['config-ensure-section'], tmpDir);
    const configPath = path.join(tmpDir, '.planning', 'config.json');
    fs.chmodSync(configPath, 0o444);
    try {
      const result = runGsdTools(['config-set', 'mode', 'interactive'], tmpDir);
      assert.strictEqual(result.success, false);
      assert.match(
        result.stderr,
        /Failed to write config\.json/,
        `Expected write-failure error, got: ${result.stderr}`,
      );
    } finally {
      fs.chmodSync(configPath, 0o644);
      cleanup(tmpDir);
    }
  });

  test('creates intermediate object when nested key path traverses missing segments', () => {
    const tmpDir = createTempProject();
    // Empty config (no nested objects yet)
    writeConfig(tmpDir, {});
    try {
      const result = runGsdTools(
        ['config-set', 'workflow.research', 'false'],
        tmpDir,
      );
      assert.ok(result.success, `Command failed: ${result.error}`);
      const config = readConfig(tmpDir);
      assert.strictEqual(typeof config.workflow, 'object');
      assert.strictEqual(config.workflow.research, false);
    } finally {
      cleanup(tmpDir);
    }
  });

  test('replaces non-object intermediate when setting deeper key', () => {
    const tmpDir = createTempProject();
    // workflow is a primitive — setConfigValue should overwrite with {}.
    writeConfig(tmpDir, { workflow: 'oops' });
    try {
      const result = runGsdTools(
        ['config-set', 'workflow.research', 'true'],
        tmpDir,
      );
      assert.ok(result.success, `Command failed: ${result.error}`);
      const config = readConfig(tmpDir);
      assert.strictEqual(typeof config.workflow, 'object');
      assert.strictEqual(config.workflow.research, true);
    } finally {
      cleanup(tmpDir);
    }
  });
});

describe('cmdConfigGet defaultValue and traversal branches', () => {
  test('returns defaultValue when config.json does not exist', () => {
    const tmpDir = createTempProject();
    // No config.json at all
    try {
      const result = runGsdTools(
        ['config-get', 'mode', '--default', 'interactive'],
        tmpDir,
      );
      assert.ok(result.success, `Command failed: ${result.error}`);
      assert.strictEqual(result.output.trim(), 'interactive');
    } finally {
      cleanup(tmpDir);
    }
  });

  test('errors when corrupt config.json triggers JSON.parse catch (not the No-config re-throw)', () => {
    const tmpDir = createTempProject();
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'config.json'),
      'NOT_VALID_JSON{{{',
    );
    try {
      const result = runGsdTools(['config-get', 'mode'], tmpDir);
      assert.strictEqual(result.success, false);
      assert.match(
        result.stderr,
        /Failed to read config\.json/,
        `Expected read-failure error, got: ${result.stderr}`,
      );
    } finally {
      cleanup(tmpDir);
    }
  });

  test('returns defaultValue when intermediate key in path is a non-object primitive', () => {
    const tmpDir = createTempProject();
    writeConfig(tmpDir, { workflow: 'not-an-object' });
    try {
      const result = runGsdTools(
        ['config-get', 'workflow.research.deep', '--default', 'fallback'],
        tmpDir,
      );
      assert.ok(result.success, `Command failed: ${result.error}`);
      assert.strictEqual(result.output.trim(), 'fallback');
    } finally {
      cleanup(tmpDir);
    }
  });

  test('errors when intermediate key in path is non-object and no default is given', () => {
    const tmpDir = createTempProject();
    writeConfig(tmpDir, { workflow: 'not-an-object' });
    try {
      const result = runGsdTools(
        ['config-get', 'workflow.research.deep'],
        tmpDir,
      );
      assert.strictEqual(result.success, false);
      assert.match(
        result.stderr,
        /Unknown config key: "workflow\.research\.deep"/,
        `Expected Unknown config key error, got: ${result.stderr}`,
      );
    } finally {
      cleanup(tmpDir);
    }
  });

  test('returns defaultValue when leaf key is undefined in the existing config', () => {
    const tmpDir = createTempProject();
    writeConfig(tmpDir, { workflow: { research: true } });
    try {
      const result = runGsdTools(
        ['config-get', 'workflow.nonexistent', '--default', 'mydefault'],
        tmpDir,
      );
      assert.ok(result.success, `Command failed: ${result.error}`);
      assert.strictEqual(result.output.trim(), 'mydefault');
    } finally {
      cleanup(tmpDir);
    }
  });

  test('emits deprecation warning on stderr for git.submodule.workspace_branch (with value present)', () => {
    const tmpDir = createTempProject();
    writeConfig(tmpDir, {
      git: { submodule: { workspace_branch: 'develop' } },
    });
    try {
      const result = runGsdTools(
        ['config-get', 'git.submodule.workspace_branch'],
        tmpDir,
      );
      assert.ok(result.success, `Command failed: ${result.error}`);
      assert.match(
        result.stderr,
        /git\.submodule\.workspace_branch is deprecated/,
        `Expected deprecation warning on stderr, got: ${result.stderr}`,
      );
      assert.strictEqual(result.output.trim(), 'develop');
    } finally {
      cleanup(tmpDir);
    }
  });

  test('errors when invoked with no key path (direct invocation, bypassing CLI validateArgs)', () => {
    // validateArgs in gsd-tools.cjs blocks empty positional args before dispatch,
    // so the !keyPath guard inside cmdConfigGet is unreachable through the CLI.
    // Spawn a child that requires the lib directly and lets process.exit fire safely.
    const { spawnSync } = require('child_process');
    const libPath = path.join(
      __dirname,
      '..',
      'gsd-ng',
      'bin',
      'lib',
      'config.cjs',
    );
    const r = spawnSync(
      process.execPath,
      [
        '-e',
        `const c = require(${JSON.stringify(libPath)}); c.cmdConfigGet('/tmp/__nope__', undefined, undefined);`,
      ],
      { encoding: 'utf-8' },
    );
    assert.strictEqual(
      r.status,
      1,
      `Expected exit 1, got ${r.status}. stderr: ${r.stderr}`,
    );
    assert.match(
      r.stderr,
      /Usage: config-get <key\.path>/,
      `Expected usage error, got: ${r.stderr}`,
    );
  });
});

describe('cmdConfigGet copilot runtime profile/effort gating', () => {
  test('strips effort_overrides.* keys with --default on copilot runtime', () => {
    const tmpDir = createTempProject();
    const markerDir = fs.mkdtempSync(
      path.join(resolveTmpDir(), 'gsd-copilot-marker-'),
    );
    fs.writeFileSync(path.join(markerDir, '.runtime'), 'copilot\n', 'utf-8');
    writeConfig(tmpDir, {
      effort_overrides: { 'gsd-executor': 'high' },
    });
    try {
      const result = runGsdTools(
        ['config-get', 'effort_overrides.gsd-executor', '--default', 'medium'],
        tmpDir,
        { GSD_TEST_RUNTIME_MARKER_DIR: markerDir },
      );
      assert.ok(result.success, `Command failed: ${result.error}`);
      assert.strictEqual(result.output.trim(), 'medium');
    } finally {
      cleanup(tmpDir);
      cleanup(markerDir);
    }
  });

  test('strips model_overrides.* keys (errors without default) on copilot runtime', () => {
    const tmpDir = createTempProject();
    const markerDir = fs.mkdtempSync(
      path.join(resolveTmpDir(), 'gsd-copilot-marker-'),
    );
    fs.writeFileSync(path.join(markerDir, '.runtime'), 'copilot\n', 'utf-8');
    writeConfig(tmpDir, {
      model_overrides: { 'gsd-executor': 'opus' },
    });
    try {
      const result = runGsdTools(
        ['config-get', 'model_overrides.gsd-executor'],
        tmpDir,
        { GSD_TEST_RUNTIME_MARKER_DIR: markerDir },
      );
      assert.strictEqual(result.success, false);
      assert.match(
        result.stderr,
        /Key not found: model_overrides\.gsd-executor/,
        `Expected Key not found, got: ${result.stderr}`,
      );
    } finally {
      cleanup(tmpDir);
      cleanup(markerDir);
    }
  });
});

describe('cmdConfigSetModelProfile validation and normalization', () => {
  test('errors with usage hint when invoked with no profile (direct invocation)', () => {
    // validateArgs blocks the missing-arg case at the CLI dispatcher, so the
    // !profile guard is unreachable through gsd-tools. Spawn a child to hit it.
    const { spawnSync } = require('child_process');
    const libPath = path.join(
      __dirname,
      '..',
      'gsd-ng',
      'bin',
      'lib',
      'config.cjs',
    );
    const r = spawnSync(
      process.execPath,
      [
        '-e',
        `const c = require(${JSON.stringify(libPath)}); c.cmdConfigSetModelProfile('/tmp/__nope__', undefined);`,
      ],
      { encoding: 'utf-8' },
    );
    assert.strictEqual(
      r.status,
      1,
      `Expected exit 1, got ${r.status}. stderr: ${r.stderr}`,
    );
    assert.match(
      r.stderr,
      /Usage: config-set-model-profile/,
      `Expected usage error, got: ${r.stderr}`,
    );
  });

  test('rejects an unknown profile string with the valid-profiles list', () => {
    const tmpDir = createTempProject();
    runGsdTools(['config-ensure-section'], tmpDir);
    try {
      const result = runGsdTools(
        ['config-set-model-profile', 'invalid-profile-xyz'],
        tmpDir,
      );
      assert.strictEqual(result.success, false);
      assert.match(
        result.stderr,
        /Invalid profile 'invalid-profile-xyz'/,
        `Expected invalid-profile error, got: ${result.stderr}`,
      );
      assert.match(
        result.stderr,
        /quality, balanced, budget/,
        `Expected valid-profiles list in error, got: ${result.stderr}`,
      );
    } finally {
      cleanup(tmpDir);
    }
  });

  test('normalizes uppercase profile via toLowerCase().trim() and writes lowercase', () => {
    const tmpDir = createTempProject();
    try {
      // Mixed-case + leading space exercises both lowerCase and trim.
      const result = runGsdTools(
        ['config-set-model-profile', '  QUALITY  '],
        tmpDir,
      );
      assert.ok(result.success, `Command failed: ${result.error}`);
      const config = readConfig(tmpDir);
      assert.strictEqual(config.model_profile, 'quality');
    } finally {
      cleanup(tmpDir);
    }
  });

  test("falls back to 'balanced' previousProfile when config has no model_profile key", () => {
    const tmpDir = createTempProject();
    // Hand-write a config without model_profile so the setConfigValue read
    // returns previousValue=undefined, exercising the `previousValue || 'balanced'`
    // fallback. ensureConfigFile sees the existing file and returns early.
    writeConfig(tmpDir, { commit_docs: false });
    try {
      const result = runGsdTools(
        ['config-set-model-profile', 'quality', '--json'],
        tmpDir,
      );
      assert.ok(result.success, `Command failed: ${result.error}`);
      const out = JSON.parse(result.output);
      assert.strictEqual(out.previousProfile, 'balanced');
      // And the new profile is written through.
      const config = readConfig(tmpDir);
      assert.strictEqual(config.model_profile, 'quality');
    } finally {
      cleanup(tmpDir);
    }
  });
});

// ─── Config CRUD: workflow.ui_safety_gate legacy compatibility ──

describe('Config CRUD (workflow.ui_safety_gate legacy compatibility)', () => {
  test('config.json containing legacy workflow.ui_safety_gate is silently readable for OTHER keys', () => {
    // Setup: write a config.json with the removed key alongside a known-good key
    const tmpDir = fs.mkdtempSync(
      path.join(resolveTmpDir(), 'gsd-cfg-legacy-'),
    );
    const planningDir = path.join(tmpDir, '.planning');
    fs.mkdirSync(planningDir, { recursive: true });
    fs.writeFileSync(
      path.join(planningDir, 'config.json'),
      JSON.stringify(
        {
          mode: 'interactive',
          workflow: {
            ui_safety_gate: true, // the removed key — must be silently ignored on read
            verifier: false, // a valid key we will read
          },
        },
        null,
        2,
      ),
    );

    // Read an UNRELATED key — must succeed without error
    const result = spawnSync(
      'node',
      [
        path.join(REPO_ROOT, 'gsd-ng/bin/gsd-tools.cjs'),
        'config-get',
        'workflow.verifier',
      ],
      { cwd: tmpDir, encoding: 'utf8' },
    );

    assert.strictEqual(
      result.status,
      0,
      `config-get failed: stdout=${result.stdout} stderr=${result.stderr}`,
    );
    assert.strictEqual(
      result.stdout.trim(),
      'false',
      `Expected 'false', got '${result.stdout.trim()}'`,
    );
    assert.doesNotMatch(
      result.stderr,
      /ui_safety_gate/,
      'Reader emitted warning about ui_safety_gate — should be silent',
    );
    assert.doesNotMatch(
      result.stderr,
      /[Ww]arning|[Ee]rror|[Dd]eprecat/,
      `Reader emitted noise: ${result.stderr}`,
    );

    cleanup(tmpDir);
  });

  test('cmdConfigSet workflow.ui_safety_gate true errors with Unknown config key', () => {
    const tmpDir = fs.mkdtempSync(
      path.join(resolveTmpDir(), 'gsd-cfg-legacy-w-'),
    );
    const planningDir = path.join(tmpDir, '.planning');
    fs.mkdirSync(planningDir, { recursive: true });
    fs.writeFileSync(
      path.join(planningDir, 'config.json'),
      JSON.stringify({ mode: 'interactive' }, null, 2),
    );

    const result = spawnSync(
      'node',
      [
        path.join(REPO_ROOT, 'gsd-ng/bin/gsd-tools.cjs'),
        'config-set',
        'workflow.ui_safety_gate',
        'true',
      ],
      { cwd: tmpDir, encoding: 'utf8' },
    );

    assert.notStrictEqual(
      result.status,
      0,
      'config-set should fail for unknown key',
    );
    const combined = (result.stdout || '') + (result.stderr || '');
    assert.match(
      combined,
      /[Uu]nknown config key/,
      `Expected "Unknown config key" error, got: ${combined}`,
    );

    cleanup(tmpDir);
  });

  test('cmdConfigGet workflow.ui_safety_gate errors with Unknown config key (direct lookup)', () => {
    const tmpDir = fs.mkdtempSync(
      path.join(resolveTmpDir(), 'gsd-cfg-legacy-r-'),
    );
    const planningDir = path.join(tmpDir, '.planning');
    fs.mkdirSync(planningDir, { recursive: true });
    fs.writeFileSync(
      path.join(planningDir, 'config.json'),
      JSON.stringify(
        {
          mode: 'interactive',
          workflow: { ui_safety_gate: true, verifier: false },
        },
        null,
        2,
      ),
    );

    const result = spawnSync(
      'node',
      [
        path.join(REPO_ROOT, 'gsd-ng/bin/gsd-tools.cjs'),
        'config-get',
        'workflow.ui_safety_gate',
      ],
      { cwd: tmpDir, encoding: 'utf8' },
    );

    assert.notStrictEqual(
      result.status,
      0,
      'config-get should fail for unknown key (direct lookup)',
    );
    const combined = (result.stdout || '') + (result.stderr || '');
    assert.match(
      combined,
      /[Uu]nknown config key/,
      `Expected "Unknown config key" error, got: ${combined}`,
    );

    cleanup(tmpDir);
  });
});
