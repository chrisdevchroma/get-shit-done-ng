/**
 * GSD Tools Tests - core.cjs
 *
 * Tests for the foundational module's exports including regressions
 * for known bugs in loadConfig model_overrides and getRoadmapPhaseInternal export.
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { resolveTmpDir, cleanup, cleanupSubdir } = require('./helpers.cjs');

const {
  loadConfig,
  resolveTargetBranch,
  resolveModelInternal,
  resolveEffortInternal,
  escapeRegex,
  generateSlugInternal,
  normalizePhaseName,
  comparePhaseNum,
  safeReadFile,
  pathExistsInternal,
  getMilestoneInfo,
  getMilestonePhaseFilter,
  getRoadmapPhaseInternal,
  searchPhaseInDir,
  findPhaseInternal,
  planningPaths,
  extractCurrentMilestone,
  writeFileAtomic,
  reapStaleAtomicTempFiles,
  lockPathFor,
  acquireFileLock,
  releaseFileLock,
  withFileLock,
  phaseCheckboxLinePattern,
  phaseCheckboxName,
  parsePhaseCheckboxes,
} = require('../gsd-ng/bin/lib/core.cjs');

// ─── loadConfig ────────────────────────────────────────────────────────────────

describe('loadConfig', () => {
  let tmpDir;
  let originalCwd;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(resolveTmpDir(), 'gsd-core-test-'));
    fs.mkdirSync(path.join(tmpDir, '.planning'), { recursive: true });
    originalCwd = process.cwd();
  });

  afterEach(() => {
    process.chdir(originalCwd);
    cleanup(tmpDir);
  });

  function writeConfig(obj) {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'config.json'),
      JSON.stringify(obj, null, 2),
    );
  }

  test('returns defaults when config.json is missing', () => {
    const config = loadConfig(tmpDir);
    assert.strictEqual(config.model_profile, 'balanced');
    assert.strictEqual(config.commit_docs, true);
    assert.strictEqual(config.research, true);
    assert.strictEqual(config.plan_checker, true);
    assert.strictEqual(config.parallelization, true);
    assert.strictEqual(config.nyquist_validation, true);
  });

  test('reads model_profile from config.json', () => {
    writeConfig({ model_profile: 'quality' });
    const config = loadConfig(tmpDir);
    assert.strictEqual(config.model_profile, 'quality');
  });

  test('reads nested config keys', () => {
    writeConfig({ planning: { commit_docs: false } });
    const config = loadConfig(tmpDir);
    assert.strictEqual(config.commit_docs, false);
  });

  test('reads branching_strategy from git section', () => {
    writeConfig({ git: { branching_strategy: 'per-phase' } });
    const config = loadConfig(tmpDir);
    assert.strictEqual(config.branching_strategy, 'per-phase');
  });

  // Bug: loadConfig previously omitted model_overrides from return value
  test('returns model_overrides when present (REG-01)', () => {
    writeConfig({ model_overrides: { 'gsd-executor': 'opus' } });
    const config = loadConfig(tmpDir);
    assert.deepStrictEqual(config.model_overrides, { 'gsd-executor': 'opus' });
  });

  test('returns model_overrides as null when not in config', () => {
    writeConfig({ model_profile: 'balanced' });
    const config = loadConfig(tmpDir);
    assert.strictEqual(config.model_overrides, null);
  });

  test('returns defaults when config.json contains invalid JSON', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'config.json'),
      'not valid json {{{{',
    );
    const config = loadConfig(tmpDir);
    assert.strictEqual(config.model_profile, 'balanced');
    assert.strictEqual(config.commit_docs, true);
  });

  test('handles parallelization as boolean', () => {
    writeConfig({ parallelization: false });
    const config = loadConfig(tmpDir);
    assert.strictEqual(config.parallelization, false);
  });

  test('handles parallelization as object with enabled field', () => {
    writeConfig({ parallelization: { enabled: false } });
    const config = loadConfig(tmpDir);
    assert.strictEqual(config.parallelization, false);
  });

  test('prefers top-level keys over nested keys', () => {
    writeConfig({ commit_docs: false, planning: { commit_docs: true } });
    const config = loadConfig(tmpDir);
    assert.strictEqual(config.commit_docs, false);
  });

  // The `git` block is normalized onto the top level, so a loaded config never
  // carries it. Readers that reach for `config.git.*` get undefined and fall
  // through to their own fallback without any error surfacing.
  test('flattens the git block — loaded config exposes no git section', () => {
    writeConfig({ git: { target_branch: 'develop', remote: 'upstream' } });
    const config = loadConfig(tmpDir);
    assert.strictEqual(config.target_branch, 'develop');
    assert.strictEqual(config.remote, 'upstream');
    assert.strictEqual(
      config.git,
      undefined,
      'loaded config must not carry a nested git section',
    );
  });
});

// ─── resolveTargetBranch ──────────────────────────────────────────────────────

describe('resolveTargetBranch', () => {
  test('reads the flat key from a loaded config', () => {
    assert.strictEqual(
      resolveTargetBranch({ target_branch: 'develop' }),
      'develop',
    );
  });

  test('reads the nested key from a raw parsed config.json', () => {
    assert.strictEqual(
      resolveTargetBranch({ git: { target_branch: 'develop' } }),
      'develop',
    );
  });

  test('prefers the flat key over the nested one', () => {
    assert.strictEqual(
      resolveTargetBranch({
        target_branch: 'flat',
        git: { target_branch: 'nested' },
      }),
      'flat',
    );
  });

  test('defaults to main when nothing is configured', () => {
    assert.strictEqual(resolveTargetBranch({}), 'main');
    assert.strictEqual(resolveTargetBranch(null), 'main');
    assert.strictEqual(resolveTargetBranch(undefined), 'main');
  });

  test('treats null and empty string as unconfigured', () => {
    assert.strictEqual(resolveTargetBranch({ target_branch: null }), 'main');
    assert.strictEqual(resolveTargetBranch({ target_branch: '' }), 'main');
    assert.strictEqual(
      resolveTargetBranch({ target_branch: '', git: { target_branch: 'dev' } }),
      'dev',
    );
  });

  test('overrides win over the base config', () => {
    assert.strictEqual(
      resolveTargetBranch(
        { git: { target_branch: 'global' } },
        { overrides: { target_branch: 'per-submodule' } },
      ),
      'per-submodule',
    );
  });

  test('falls back to the base config when overrides are silent', () => {
    assert.strictEqual(
      resolveTargetBranch(
        { git: { target_branch: 'global' } },
        { overrides: { remote: 'origin' } },
      ),
      'global',
    );
  });

  test('honours an explicit null fallback for callers that resolve further', () => {
    assert.strictEqual(
      resolveTargetBranch({}, { overrides: {}, fallback: null }),
      null,
    );
  });

  test('honours a custom fallback string', () => {
    assert.strictEqual(resolveTargetBranch({}, { fallback: 'trunk' }), 'trunk');
  });
});

// ─── resolveModelInternal ──────────────────────────────────────────────────────

describe('resolveModelInternal', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(resolveTmpDir(), 'gsd-core-test-'));
    fs.mkdirSync(path.join(tmpDir, '.planning'), { recursive: true });
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  function writeConfig(obj) {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'config.json'),
      JSON.stringify(obj, null, 2),
    );
  }

  describe('model profile structural validation', () => {
    test('all known agents resolve to a valid string for each profile', () => {
      const knownAgents = [
        'gsd-planner',
        'gsd-executor',
        'gsd-phase-researcher',
        'gsd-codebase-mapper',
      ];
      const profiles = ['quality', 'balanced', 'budget'];
      const validValues = [null, 'sonnet', 'haiku', 'opus'];

      for (const profile of profiles) {
        writeConfig({ model_profile: profile });
        for (const agent of knownAgents) {
          const result = resolveModelInternal(tmpDir, agent);
          assert.ok(
            validValues.includes(result),
            `profile=${profile} agent=${agent} returned unexpected value: ${result}`,
          );
        }
      }
    });
  });

  describe('override precedence', () => {
    test('per-agent override takes precedence over profile', () => {
      writeConfig({
        model_profile: 'balanced',
        model_overrides: { 'gsd-executor': 'haiku' },
      });
      assert.strictEqual(resolveModelInternal(tmpDir, 'gsd-executor'), 'haiku');
    });

    test('opus override resolves to opus directly', () => {
      writeConfig({
        model_overrides: { 'gsd-executor': 'opus' },
      });
      assert.strictEqual(resolveModelInternal(tmpDir, 'gsd-executor'), 'opus');
    });

    test('agents not in override fall back to profile', () => {
      writeConfig({
        model_profile: 'quality',
        model_overrides: { 'gsd-executor': 'haiku' },
      });
      // gsd-planner not overridden, should use quality profile -> opus
      assert.strictEqual(resolveModelInternal(tmpDir, 'gsd-planner'), 'opus');
    });
  });

  describe('edge cases', () => {
    test('returns sonnet for unknown agent type', () => {
      writeConfig({ model_profile: 'balanced' });
      assert.strictEqual(
        resolveModelInternal(tmpDir, 'gsd-nonexistent'),
        'sonnet',
      );
    });

    test('defaults to balanced profile when model_profile missing', () => {
      writeConfig({});
      // balanced profile, gsd-planner -> opus
      assert.strictEqual(resolveModelInternal(tmpDir, 'gsd-planner'), 'opus');
    });
  });
});

// ─── escapeRegex ───────────────────────────────────────────────────────────────

describe('escapeRegex', () => {
  test('escapes dots', () => {
    assert.strictEqual(escapeRegex('file.txt'), 'file\\.txt');
  });

  test('escapes all special regex characters', () => {
    const input =
      '1.0 (alpha) [test] {ok} $100 ^start end$ a+b a*b a?b pipe|or back\\slash';
    const result = escapeRegex(input);
    // Verify each special char is escaped
    assert.ok(result.includes('\\.'));
    assert.ok(result.includes('\\('));
    assert.ok(result.includes('\\)'));
    assert.ok(result.includes('\\['));
    assert.ok(result.includes('\\]'));
    assert.ok(result.includes('\\{'));
    assert.ok(result.includes('\\}'));
    assert.ok(result.includes('\\$'));
    assert.ok(result.includes('\\^'));
    assert.ok(result.includes('\\+'));
    assert.ok(result.includes('\\*'));
    assert.ok(result.includes('\\?'));
    assert.ok(result.includes('\\|'));
    assert.ok(result.includes('\\\\'));
  });

  test('handles empty string', () => {
    assert.strictEqual(escapeRegex(''), '');
  });

  test('returns plain string unchanged', () => {
    assert.strictEqual(escapeRegex('hello'), 'hello');
  });
});

// ─── generateSlugInternal ──────────────────────────────────────────────────────

describe('generateSlugInternal', () => {
  test('converts text to lowercase kebab-case', () => {
    assert.strictEqual(generateSlugInternal('Hello World'), 'hello-world');
  });

  test('removes special characters', () => {
    assert.strictEqual(
      generateSlugInternal('core.cjs Tests!'),
      'core-cjs-tests',
    );
  });

  test('trims leading and trailing hyphens', () => {
    assert.strictEqual(generateSlugInternal('---hello---'), 'hello');
  });

  test('returns null for null input', () => {
    assert.strictEqual(generateSlugInternal(null), null);
  });

  test('returns null for empty string', () => {
    assert.strictEqual(generateSlugInternal(''), null);
  });
});

// ─── normalizePhaseName ────────────────────────────────────────────────────────

describe('normalizePhaseName', () => {
  test('pads single digit', () => {
    assert.strictEqual(normalizePhaseName('1'), '01');
  });

  test('preserves double digit', () => {
    assert.strictEqual(normalizePhaseName('12'), '12');
  });

  test('handles letter suffix', () => {
    assert.strictEqual(normalizePhaseName('1A'), '01A');
  });

  test('handles decimal phases', () => {
    assert.strictEqual(normalizePhaseName('2.1'), '02.1');
  });

  test('handles multi-level decimals', () => {
    assert.strictEqual(normalizePhaseName('1.2.3'), '01.2.3');
  });

  test('returns non-matching input unchanged', () => {
    assert.strictEqual(normalizePhaseName('abc'), 'abc');
  });
});

// ─── comparePhaseNum ───────────────────────────────────────────────────────────

describe('comparePhaseNum', () => {
  test('sorts integer phases numerically', () => {
    assert.ok(comparePhaseNum('1', '2') < 0);
    assert.ok(comparePhaseNum('10', '2') > 0);
  });

  test('sorts letter suffixes', () => {
    assert.ok(comparePhaseNum('12', '12A') < 0);
    assert.ok(comparePhaseNum('12A', '12B') < 0);
  });

  test('sorts decimal phases', () => {
    assert.ok(comparePhaseNum('2', '2.1') < 0);
    assert.ok(comparePhaseNum('2.1', '2.2') < 0);
  });

  test('handles multi-level decimals', () => {
    assert.ok(comparePhaseNum('1.1', '1.1.2') < 0);
    assert.ok(comparePhaseNum('1.1.2', '1.2') < 0);
  });

  test('returns 0 for equal phases', () => {
    assert.strictEqual(comparePhaseNum('1', '1'), 0);
    assert.strictEqual(comparePhaseNum('2.1', '2.1'), 0);
  });
});

// ─── safeReadFile ──────────────────────────────────────────────────────────────

describe('safeReadFile', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(resolveTmpDir(), 'gsd-core-test-'));
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('reads existing file', () => {
    const filePath = path.join(tmpDir, 'test.txt');
    fs.writeFileSync(filePath, 'hello world');
    assert.strictEqual(safeReadFile(filePath), 'hello world');
  });

  test('returns null for missing file', () => {
    assert.strictEqual(safeReadFile('/nonexistent/path/file.txt'), null);
  });
});

// ─── pathExistsInternal ────────────────────────────────────────────────────────

describe('pathExistsInternal', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(resolveTmpDir(), 'gsd-core-test-'));
    fs.mkdirSync(path.join(tmpDir, '.planning'), { recursive: true });
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('returns true for existing path', () => {
    assert.strictEqual(pathExistsInternal(tmpDir, '.planning'), true);
  });

  test('returns false for non-existing path', () => {
    assert.strictEqual(pathExistsInternal(tmpDir, 'nonexistent'), false);
  });

  test('handles absolute paths', () => {
    assert.strictEqual(pathExistsInternal(tmpDir, tmpDir), true);
  });
});

// ─── getMilestoneInfo ──────────────────────────────────────────────────────────

describe('getMilestoneInfo', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(resolveTmpDir(), 'gsd-core-test-'));
    fs.mkdirSync(path.join(tmpDir, '.planning'), { recursive: true });
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('extracts version and name from roadmap', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      '# Roadmap\n\n## Roadmap v1.2: My Cool Project\n\nSome content',
    );
    const info = getMilestoneInfo(tmpDir);
    assert.strictEqual(info.version, 'v1.2');
    assert.strictEqual(info.name, 'My Cool Project');
  });

  test('returns defaults when roadmap missing', () => {
    const info = getMilestoneInfo(tmpDir);
    assert.strictEqual(info.version, 'v1.0');
    assert.strictEqual(info.name, 'milestone');
  });

  test('returns active milestone when shipped milestone is collapsed in details block', () => {
    const roadmap = [
      '# Milestones',
      '',
      '| Version | Status |',
      '|---------|--------|',
      '| v0.1    | Shipped |',
      '| v0.2    | Active |',
      '',
      '<details>',
      '<summary>v0.1 — Legacy Feature Parity (Shipped)</summary>',
      '',
      '## Roadmap v0.1: Legacy Feature Parity',
      '',
      '### Phase 1: Core Setup',
      'Some content about phase 1',
      '',
      '</details>',
      '',
      '## Roadmap v0.2: Dashboard Overhaul',
      '',
      '### Phase 8: New Dashboard Layout',
      'Some content about phase 8',
    ].join('\n');
    fs.writeFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), roadmap);
    const info = getMilestoneInfo(tmpDir);
    assert.strictEqual(info.version, 'v0.2');
    assert.strictEqual(info.name, 'Dashboard Overhaul');
  });

  test('returns active milestone when multiple shipped milestones exist in details blocks', () => {
    const roadmap = [
      '# Milestones',
      '',
      '| Version | Status |',
      '|---------|--------|',
      '| v0.1    | Shipped |',
      '| v0.2    | Shipped |',
      '| v0.3    | Active |',
      '',
      '<details>',
      '<summary>v0.1 — Initial Release (Shipped)</summary>',
      '',
      '## Roadmap v0.1: Initial Release',
      '',
      '</details>',
      '',
      '<details>',
      '<summary>v0.2 — Feature Expansion (Shipped)</summary>',
      '',
      '## Roadmap v0.2: Feature Expansion',
      '',
      '</details>',
      '',
      '## Roadmap v0.3: Performance Tuning',
      '',
      '### Phase 12: Optimize Queries',
    ].join('\n');
    fs.writeFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), roadmap);
    const info = getMilestoneInfo(tmpDir);
    assert.strictEqual(info.version, 'v0.3');
    assert.strictEqual(info.name, 'Performance Tuning');
  });

  test('returns defaults when roadmap has no heading matches', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      '# Roadmap\n\nSome content without version headings',
    );
    const info = getMilestoneInfo(tmpDir);
    assert.strictEqual(info.version, 'v1.0');
    assert.strictEqual(info.name, 'milestone');
  });
});

// ─── searchPhaseInDir ──────────────────────────────────────────────────────────

describe('searchPhaseInDir', () => {
  let tmpDir;
  let phasesDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(resolveTmpDir(), 'gsd-core-test-'));
    phasesDir = path.join(tmpDir, 'phases');
    fs.mkdirSync(phasesDir, { recursive: true });
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('finds phase directory by normalized prefix', () => {
    fs.mkdirSync(path.join(phasesDir, '01-foundation'));
    const result = searchPhaseInDir(phasesDir, '.planning/phases', '01');
    assert.strictEqual(result.found, true);
    assert.strictEqual(result.phase_number, '01');
    assert.strictEqual(result.phase_name, 'foundation');
  });

  test('returns plans and summaries', () => {
    const phaseDir = path.join(phasesDir, '01-foundation');
    fs.mkdirSync(phaseDir);
    fs.writeFileSync(path.join(phaseDir, '01-01-PLAN.md'), '# Plan');
    fs.writeFileSync(path.join(phaseDir, '01-01-SUMMARY.md'), '# Summary');
    const result = searchPhaseInDir(phasesDir, '.planning/phases', '01');
    assert.ok(result.plans.includes('01-01-PLAN.md'));
    assert.ok(result.summaries.includes('01-01-SUMMARY.md'));
    assert.strictEqual(result.incomplete_plans.length, 0);
  });

  test('identifies incomplete plans', () => {
    const phaseDir = path.join(phasesDir, '01-foundation');
    fs.mkdirSync(phaseDir);
    fs.writeFileSync(path.join(phaseDir, '01-01-PLAN.md'), '# Plan 1');
    fs.writeFileSync(path.join(phaseDir, '01-02-PLAN.md'), '# Plan 2');
    fs.writeFileSync(path.join(phaseDir, '01-01-SUMMARY.md'), '# Summary 1');
    const result = searchPhaseInDir(phasesDir, '.planning/phases', '01');
    assert.strictEqual(result.incomplete_plans.length, 1);
    assert.ok(result.incomplete_plans.includes('01-02-PLAN.md'));
  });

  test('detects research and context files', () => {
    const phaseDir = path.join(phasesDir, '01-foundation');
    fs.mkdirSync(phaseDir);
    fs.writeFileSync(path.join(phaseDir, '01-RESEARCH.md'), '# Research');
    fs.writeFileSync(path.join(phaseDir, '01-CONTEXT.md'), '# Context');
    const result = searchPhaseInDir(phasesDir, '.planning/phases', '01');
    assert.strictEqual(result.has_research, true);
    assert.strictEqual(result.has_context, true);
  });

  test('returns null when phase not found', () => {
    fs.mkdirSync(path.join(phasesDir, '01-foundation'));
    const result = searchPhaseInDir(phasesDir, '.planning/phases', '99');
    assert.strictEqual(result, null);
  });

  test('generates phase_slug from directory name', () => {
    fs.mkdirSync(path.join(phasesDir, '01-core-cjs-tests'));
    const result = searchPhaseInDir(phasesDir, '.planning/phases', '01');
    assert.strictEqual(result.phase_slug, 'core-cjs-tests');
  });
});

// ─── findPhaseInternal ─────────────────────────────────────────────────────────

describe('findPhaseInternal', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(resolveTmpDir(), 'gsd-core-test-'));
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases'), { recursive: true });
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('finds phase in current phases directory', () => {
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '01-foundation'));
    const result = findPhaseInternal(tmpDir, '1');
    assert.strictEqual(result.found, true);
    assert.strictEqual(result.phase_number, '01');
  });

  test('returns null for non-existent phase', () => {
    const result = findPhaseInternal(tmpDir, '99');
    assert.strictEqual(result, null);
  });

  test('returns null for null phase', () => {
    const result = findPhaseInternal(tmpDir, null);
    assert.strictEqual(result, null);
  });

  test('searches archived milestones when not in current', () => {
    // Create archived milestone structure (no current phase match)
    const archiveDir = path.join(
      tmpDir,
      '.planning',
      'milestones',
      'v1.0-phases',
      '01-foundation',
    );
    fs.mkdirSync(archiveDir, { recursive: true });
    const result = findPhaseInternal(tmpDir, '1');
    assert.strictEqual(result.found, true);
    assert.strictEqual(result.archived, 'v1.0');
  });
});

// ─── getRoadmapPhaseInternal ───────────────────────────────────────────────────

describe('getRoadmapPhaseInternal', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(resolveTmpDir(), 'gsd-core-test-'));
    fs.mkdirSync(path.join(tmpDir, '.planning'), { recursive: true });
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  // Bug: getRoadmapPhaseInternal was missing from module.exports
  test('is exported from core.cjs (REG-02)', () => {
    assert.strictEqual(typeof getRoadmapPhaseInternal, 'function');
    // Also verify it works with a real roadmap (note: goal regex expects **Goal:** with colon inside bold)
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      '### Phase 1: Foundation\n**Goal:** Build the base\n',
    );
    const result = getRoadmapPhaseInternal(tmpDir, '1');
    assert.strictEqual(result.found, true);
    assert.strictEqual(result.phase_name, 'Foundation');
    assert.strictEqual(result.goal, 'Build the base');
  });

  test('extracts phase name and goal from roadmap', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      '### Phase 2: API Layer\n**Goal:** Create REST endpoints\n**Depends on**: Phase 1\n',
    );
    const result = getRoadmapPhaseInternal(tmpDir, '2');
    assert.strictEqual(result.phase_name, 'API Layer');
    assert.strictEqual(result.goal, 'Create REST endpoints');
  });

  test('returns goal when Goal uses colon-outside-bold format', () => {
    // **Goal**: (colon outside bold) is now supported alongside **Goal:**
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      '### Phase 1: Foundation\n**Goal**: Build the base\n',
    );
    const result = getRoadmapPhaseInternal(tmpDir, '1');
    assert.strictEqual(result.found, true);
    assert.strictEqual(result.phase_name, 'Foundation');
    assert.strictEqual(result.goal, 'Build the base');
  });

  test('returns null when roadmap missing', () => {
    const result = getRoadmapPhaseInternal(tmpDir, '1');
    assert.strictEqual(result, null);
  });

  test('returns null when phase not in roadmap', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      '### Phase 1: Foundation\n**Goal**: Build the base\n',
    );
    const result = getRoadmapPhaseInternal(tmpDir, '99');
    assert.strictEqual(result, null);
  });

  test('returns null for null phase number', () => {
    const result = getRoadmapPhaseInternal(tmpDir, null);
    assert.strictEqual(result, null);
  });

  test('extracts full section text', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      '### Phase 1: Foundation\n**Goal**: Build the base\n**Requirements**: TEST-01\nSome details here\n\n### Phase 2: API\n**Goal**: REST\n',
    );
    const result = getRoadmapPhaseInternal(tmpDir, '1');
    assert.ok(result.section.includes('Phase 1: Foundation'));
    assert.ok(result.section.includes('Some details here'));
    // Should not include next-phase content
    assert.ok(!result.section.includes('Phase 2: API'));
  });
});

// ─── getMilestonePhaseFilter ────────────────────────────────────────────────────

describe('getMilestonePhaseFilter', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(resolveTmpDir(), 'gsd-core-test-'));
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases'), { recursive: true });
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('filters directories to only current milestone phases', () => {
    // ROADMAP lists only phases 5-7
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      [
        '## Roadmap v2.0: Next Release',
        '',
        '### Phase 5: Auth',
        '**Goal:** Add authentication',
        '',
        '### Phase 6: Dashboard',
        '**Goal:** Build dashboard',
        '',
        '### Phase 7: Polish',
        '**Goal:** Final polish',
      ].join('\n'),
    );

    // Create phase dirs 1-7 on disk (leftover from previous milestones)
    for (let i = 1; i <= 7; i++) {
      const padded = String(i).padStart(2, '0');
      fs.mkdirSync(
        path.join(tmpDir, '.planning', 'phases', `${padded}-phase-${i}`),
      );
    }

    const filter = getMilestonePhaseFilter(tmpDir);

    // Only phases 5, 6, 7 should match
    assert.strictEqual(filter('05-auth'), true);
    assert.strictEqual(filter('06-dashboard'), true);
    assert.strictEqual(filter('07-polish'), true);

    // Phases 1-4 should NOT match
    assert.strictEqual(filter('01-phase-1'), false);
    assert.strictEqual(filter('02-phase-2'), false);
    assert.strictEqual(filter('03-phase-3'), false);
    assert.strictEqual(filter('04-phase-4'), false);
  });

  test('accepts every phase-shaped directory when ROADMAP.md is missing', () => {
    const filter = getMilestonePhaseFilter(tmpDir);

    assert.strictEqual(filter('01-foundation'), true);
    assert.strictEqual(filter('99-anything'), true);
    assert.strictEqual(filter('5-unpadded'), true);
    assert.strictEqual(filter('03A-sub-feature'), true);
    assert.strictEqual(filter('05.1-patch'), true);
  });

  test('accepts every phase-shaped directory when ROADMAP has no phase headings', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      '# Roadmap\n\nSome content without phases.\n',
    );

    const filter = getMilestonePhaseFilter(tmpDir);

    assert.strictEqual(filter('01-foundation'), true);
    assert.strictEqual(filter('05-api'), true);
  });

  test('rejects non-phase directories when ROADMAP.md is missing', () => {
    const filter = getMilestonePhaseFilter(tmpDir);

    for (const stray of [
      '.claude',
      'node_modules',
      '.git',
      'not-a-phase',
      '.gitkeep',
    ]) {
      assert.strictEqual(
        filter(stray),
        false,
        `${stray} must not count as a phase`,
      );
    }
  });

  test('rejects non-phase directories when ROADMAP has no phase entries', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      '# Roadmap\n\nSome content without phases.\n',
    );

    const filter = getMilestonePhaseFilter(tmpDir);

    assert.strictEqual(filter('.claude'), false);
    assert.strictEqual(filter('node_modules'), false);
    assert.strictEqual(filter('01-alpha'), true);
    assert.strictEqual(filter('02-beta'), true);
  });

  test('handles letter-suffix phases (e.g. 3A)', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      '### Phase 3A: Sub-feature\n**Goal:** Sub work\n',
    );

    const filter = getMilestonePhaseFilter(tmpDir);

    assert.strictEqual(filter('03A-sub-feature'), true);
    assert.strictEqual(filter('03-main'), false);
    assert.strictEqual(filter('04-other'), false);
  });

  test('handles decimal phases (e.g. 5.1)', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      '### Phase 5: Main\n**Goal:** Main work\n\n### Phase 5.1: Patch\n**Goal:** Patch work\n',
    );

    const filter = getMilestonePhaseFilter(tmpDir);

    assert.strictEqual(filter('05-main'), true);
    assert.strictEqual(filter('05.1-patch'), true);
    assert.strictEqual(filter('04-other'), false);
  });

  test('returns false for non-phase directory names', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      '### Phase 1: Init\n**Goal:** Start\n',
    );

    const filter = getMilestonePhaseFilter(tmpDir);

    assert.strictEqual(filter('not-a-phase'), false);
    assert.strictEqual(filter('.gitkeep'), false);
  });

  test('phaseCount reflects ROADMAP phase count', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      '### Phase 5: Auth\n### Phase 6: Dashboard\n### Phase 7: Polish\n',
    );

    const filter = getMilestonePhaseFilter(tmpDir);
    assert.strictEqual(filter.phaseCount, 3);
  });

  test('phaseCount is 0 when ROADMAP is missing', () => {
    const filter = getMilestonePhaseFilter(tmpDir);
    assert.strictEqual(filter.phaseCount, 0);
  });

  test('phaseCount is 0 when ROADMAP has no phase headings', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      '# Roadmap\n\nSome content.\n',
    );

    const filter = getMilestonePhaseFilter(tmpDir);
    assert.strictEqual(filter.phaseCount, 0);
  });

  test('recognizes phase declared as bullet entry without Details header', () => {
    // 60 is bullet-only (no Details section yet); 59 has a full Details header
    // to verify the union still works
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      [
        '## Roadmap v3.0: Quality',
        '',
        '- [ ] **Phase 59: Runtime Sweep**',
        '- [ ] **Phase 60: Test Coverage Uplift**',
        '',
        '### Phase 59: Runtime Sweep',
        '**Goal:** Sweep runtime references',
      ].join('\n'),
    );

    const filter = getMilestonePhaseFilter(tmpDir);

    // Bullet-only entry for 60 must be recognized
    assert.strictEqual(
      filter('60-test-coverage-uplift'),
      true,
      'bullet-only Phase 60 should match',
    );
    // Entry with Details header for 59 must also be recognized
    assert.strictEqual(
      filter('59-runtime-sweep'),
      true,
      'Phase 59 with Details header should still match',
    );
    // phaseCount must include both phases
    assert.ok(
      filter.phaseCount >= 2,
      `phaseCount should be >= 2, got ${filter.phaseCount}`,
    );

    // Also verify that a checked bullet (already-completed) is recognized
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      [
        '## Roadmap v3.0: Quality',
        '',
        '- [x] **Phase 60: Test Coverage Uplift**',
      ].join('\n'),
    );

    const filter2 = getMilestonePhaseFilter(tmpDir);
    assert.strictEqual(
      filter2('60-test-coverage-uplift'),
      true,
      'checked bullet Phase 60 should also match',
    );
  });
});

// ─── planningPaths ─────────────────────────────────────────────────────────────

describe('planningPaths', () => {
  test('is exported from core.cjs', () => {
    assert.strictEqual(typeof planningPaths, 'function');
  });

  test('root equals path.join(cwd, .planning)', () => {
    const result = planningPaths('/project');
    assert.strictEqual(result.root, path.join('/project', '.planning'));
  });

  test('state equals .planning/STATE.md', () => {
    const result = planningPaths('/project');
    assert.strictEqual(
      result.state,
      path.join('/project', '.planning', 'STATE.md'),
    );
  });

  test('roadmap equals .planning/ROADMAP.md', () => {
    const result = planningPaths('/project');
    assert.strictEqual(
      result.roadmap,
      path.join('/project', '.planning', 'ROADMAP.md'),
    );
  });

  test('config equals .planning/config.json', () => {
    const result = planningPaths('/project');
    assert.strictEqual(
      result.config,
      path.join('/project', '.planning', 'config.json'),
    );
  });

  test('requirements equals .planning/REQUIREMENTS.md', () => {
    const result = planningPaths('/project');
    assert.strictEqual(
      result.requirements,
      path.join('/project', '.planning', 'REQUIREMENTS.md'),
    );
  });

  test('phases equals .planning/phases', () => {
    const result = planningPaths('/project');
    assert.strictEqual(
      result.phases,
      path.join('/project', '.planning', 'phases'),
    );
  });

  test('todos equals .planning/todos', () => {
    const result = planningPaths('/project');
    assert.strictEqual(
      result.todos,
      path.join('/project', '.planning', 'todos'),
    );
  });

  test('todosPending equals .planning/todos/pending', () => {
    const result = planningPaths('/project');
    assert.strictEqual(
      result.todosPending,
      path.join('/project', '.planning', 'todos', 'pending'),
    );
  });

  test('todosCompleted equals .planning/todos/completed', () => {
    const result = planningPaths('/project');
    assert.strictEqual(
      result.todosCompleted,
      path.join('/project', '.planning', 'todos', 'completed'),
    );
  });

  test('codebase equals .planning/codebase', () => {
    const result = planningPaths('/project');
    assert.strictEqual(
      result.codebase,
      path.join('/project', '.planning', 'codebase'),
    );
  });

  test('milestones equals .planning/milestones', () => {
    const result = planningPaths('/project');
    assert.strictEqual(
      result.milestones,
      path.join('/project', '.planning', 'milestones'),
    );
  });

  test('project equals .planning/PROJECT.md', () => {
    const result = planningPaths('/project');
    assert.strictEqual(
      result.project,
      path.join('/project', '.planning', 'PROJECT.md'),
    );
  });

  test('archive equals .planning/archive', () => {
    const result = planningPaths('/project');
    assert.strictEqual(
      result.archive,
      path.join('/project', '.planning', 'archive'),
    );
  });

  test('milestonesFile equals .planning/MILESTONES.md', () => {
    const result = planningPaths('/project');
    assert.strictEqual(
      result.milestonesFile,
      path.join('/project', '.planning', 'MILESTONES.md'),
    );
  });

  test('works with different cwd values', () => {
    const a = planningPaths('/home/user/myproject');
    const b = planningPaths('/tmp/other');
    assert.strictEqual(a.root, path.join('/home/user/myproject', '.planning'));
    assert.strictEqual(b.root, path.join('/tmp/other', '.planning'));
    assert.notStrictEqual(a.root, b.root);
  });
});

// ─── extractCurrentMilestone ──────────────────────────────────────────────────

describe('extractCurrentMilestone', () => {
  test('returns full content unchanged when no details blocks present', () => {
    const content = '## v2.0\n### Phase 1\n- [ ] Task A\n';
    assert.strictEqual(extractCurrentMilestone(content), content);
  });

  test('strips a single details block (archived milestone)', () => {
    const content =
      '## v2.0\n### Phase 1\n<details><summary>v1.0</summary>\nold stuff\n</details>\n';
    const result = extractCurrentMilestone(content);
    assert.ok(!result.includes('<details>'), 'should remove details block');
    assert.ok(!result.includes('old stuff'), 'should remove archived content');
    assert.ok(
      result.includes('## v2.0'),
      'should preserve current milestone heading',
    );
  });

  test('strips multiple details blocks', () => {
    const content =
      '<details><summary>v0.9</summary>\nvery old\n</details>\n## v2.0\n### Phase 1\n<details><summary>v1.0</summary>\nold stuff\n</details>\nActive content\n';
    const result = extractCurrentMilestone(content);
    assert.ok(
      !result.includes('<details>'),
      'should remove all details blocks',
    );
    assert.ok(
      !result.includes('very old'),
      'should remove first archived content',
    );
    assert.ok(
      !result.includes('old stuff'),
      'should remove second archived content',
    );
    assert.ok(
      result.includes('Active content'),
      'should preserve active content',
    );
  });

  test('is case-insensitive for DETAILS tags', () => {
    const content =
      '## v2.0\n<DETAILS><summary>v1.0</summary>\nold stuff\n</DETAILS>\nCurrent content\n';
    const result = extractCurrentMilestone(content);
    assert.ok(
      !result.includes('<DETAILS>'),
      'should remove uppercase DETAILS block',
    );
    assert.ok(!result.includes('old stuff'), 'should remove archived content');
    assert.ok(
      result.includes('Current content'),
      'should preserve current content',
    );
  });
});

// ─── generateSlugInternal max length ─────────────────────────────────────────

describe('generateSlugInternal max length', () => {
  test('input exceeding 50 chars produces output <= 50 chars', () => {
    const longInput =
      'context-token-optimization-with-many-extra-words-that-make-it-very-long';
    const result = generateSlugInternal(longInput);
    assert.ok(
      result.length <= 50,
      `slug length ${result.length} should be <= 50`,
    );
  });

  test('short input is returned unchanged (no truncation)', () => {
    assert.strictEqual(generateSlugInternal('short'), 'short');
    assert.strictEqual(generateSlugInternal('my-feature'), 'my-feature');
  });

  test('null input still returns null', () => {
    assert.strictEqual(generateSlugInternal(null), null);
  });

  test('empty string still returns null', () => {
    assert.strictEqual(generateSlugInternal(''), null);
  });

  test('word boundary preservation — slug does not end with a partial word fragment', () => {
    // 'context-token-optimizati...' would be a mid-word cut; result should end at a hyphen boundary
    const longInput =
      'context token optimization with many extra words that push it past fifty chars';
    const result = generateSlugInternal(longInput);
    assert.ok(
      result.length <= 50,
      `slug length ${result.length} should be <= 50`,
    );
    // Should not end with a hyphen (trailing hyphen was stripped)
    assert.ok(!result.endsWith('-'), 'slug should not end with a hyphen');
  });

  test('custom maxLen parameter override works', () => {
    const input = 'this-is-a-long-description-for-feature-work';
    const result = generateSlugInternal(input, 20);
    assert.ok(
      result.length <= 20,
      `slug length ${result.length} should be <= 20 with maxLen=20`,
    );
  });

  test('exact 50-char slug is not truncated', () => {
    // Build a string that produces exactly a 50-char slug
    const input = 'abcde-fghij-klmno-pqrst-uvwxy-12345'; // 35 chars already slug-safe
    const result = generateSlugInternal(input);
    assert.strictEqual(
      result,
      input,
      'exactly-50-or-under slug should be unchanged',
    );
  });
});

// ─── output EPIPE handling ────────────────────────────────────────────────────

describe('output EPIPE handling', () => {
  test('output() function wraps fs.writeSync in try/catch for EPIPE', () => {
    // Verify the fix exists in the source code by checking the module text
    const fs_mod = require('fs');
    const path_mod = require('path');
    const coreSrc = fs_mod.readFileSync(
      path_mod.join(__dirname, '../gsd-ng/bin/lib/core.cjs'),
      'utf-8',
    );
    assert.ok(
      coreSrc.includes("if (e.code !== 'EPIPE') throw e"),
      "core.cjs output() should contain EPIPE guard: if (e.code !== 'EPIPE') throw e",
    );
  });
});

// ─── output() inline default and --file flag ─────────────────────────────────

describe('output() inline default and --file flag', () => {
  const { setFileOutput, output } = require('../gsd-ng/bin/lib/core.cjs');

  // Intercept fs.writeSync to capture what output() writes to stdout (fd 1).
  let capturedOutput;
  let origWriteSync;

  beforeEach(() => {
    capturedOutput = '';
    origWriteSync = fs.writeSync;
    fs.writeSync = (fd, data) => {
      if (fd === 1) {
        capturedOutput += data;
        return data.length;
      }
      return origWriteSync(fd, data);
    };
    // Ensure file output flag is off before each test
    setFileOutput(false);
  });

  afterEach(() => {
    fs.writeSync = origWriteSync;
    setFileOutput(false);
  });

  test('small payload writes inline JSON to stdout', () => {
    output({ hello: 'world' });
    assert.ok(
      !capturedOutput.startsWith('@file:'),
      `Expected inline JSON, got: ${capturedOutput.slice(0, 50)}`,
    );
    const parsed = JSON.parse(capturedOutput);
    assert.strictEqual(parsed.hello, 'world');
  });

  test('large payload (>50KB) writes inline JSON by default', () => {
    const bigObj = { data: 'x'.repeat(51000) };
    output(bigObj);
    assert.ok(
      !capturedOutput.startsWith('@file:'),
      `Expected inline JSON, got @file: path`,
    );
    const parsed = JSON.parse(capturedOutput);
    assert.ok(
      parsed.data.length === 51000,
      'Large payload data should be preserved',
    );
  });

  test('--file flag triggers @file: temp file output', () => {
    setFileOutput(true);
    output({ test: true });
    assert.ok(
      capturedOutput.startsWith('@file:'),
      `Expected @file: prefix, got: ${capturedOutput.slice(0, 50)}`,
    );
    const tmpPath = capturedOutput.slice(6);
    const contents = fs.readFileSync(tmpPath, 'utf-8');
    const parsed = JSON.parse(contents);
    assert.strictEqual(parsed.test, true);
    // Clean up temp file
    try {
      fs.unlinkSync(tmpPath);
    } catch {}
  });

  test('displayValue mode writes string directly', () => {
    output(null, 'display-string');
    assert.strictEqual(capturedOutput, 'display-string');
  });

  test('setFileOutput exists and is exported (setResolveOutput does NOT exist)', () => {
    const coreExports = require('../gsd-ng/bin/lib/core.cjs');
    assert.strictEqual(
      typeof coreExports.setFileOutput,
      'function',
      'setFileOutput should be exported',
    );
    assert.strictEqual(
      typeof coreExports.setResolveOutput,
      'undefined',
      'setResolveOutput should NOT be exported',
    );
  });
});

// ─── resolveEffortInternal ─────────────────────────────────────────────────────

describe('resolveEffortInternal', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(resolveTmpDir(), 'gsd-core-test-'));
    fs.mkdirSync(path.join(tmpDir, '.planning'), { recursive: true });
  });

  afterEach(() => {
    delete process.env.GSD_TEST_RUNTIME_MARKER_DIR;
    cleanup(tmpDir);
  });

  function writeConfig(obj) {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'config.json'),
      JSON.stringify(obj, null, 2),
    );
  }

  function writeRuntimeMarker(dir, value) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, '.runtime'), value + '\n', 'utf-8');
  }

  test('Test 1: returns xhigh for gsd-planner when model_profile=quality and no overrides', () => {
    writeConfig({ model_profile: 'quality' });
    const result = resolveEffortInternal(tmpDir, 'gsd-planner');
    assert.strictEqual(result, 'xhigh');
  });

  test('Test 2: returns null for gsd-planner when model_profile=balanced (inherit resolves to null)', () => {
    writeConfig({ model_profile: 'balanced' });
    const result = resolveEffortInternal(tmpDir, 'gsd-planner');
    assert.strictEqual(result, null);
  });

  test('Test 3: returns effort_overrides value when set (override takes precedence over profile)', () => {
    writeConfig({
      model_profile: 'balanced',
      effort_overrides: { 'gsd-planner': 'max' },
    });
    const result = resolveEffortInternal(tmpDir, 'gsd-planner');
    assert.strictEqual(result, 'max');
  });

  test('Test 4: returns null for effort_overrides=inherit (override set to inherit resolves to null)', () => {
    writeConfig({
      model_profile: 'quality',
      effort_overrides: { 'gsd-planner': 'inherit' },
    });
    const result = resolveEffortInternal(tmpDir, 'gsd-planner');
    assert.strictEqual(result, null);
  });

  test('Test 5: returns null for unknown agent (not in EFFORT_PROFILES)', () => {
    writeConfig({ model_profile: 'quality' });
    const result = resolveEffortInternal(tmpDir, 'gsd-nonexistent');
    assert.strictEqual(result, null);
  });

  test('Test 6: returns null when .runtime marker is copilot (non-Claude runtime suppression)', () => {
    const markerDir = path.join(tmpDir, 'marker-copilot');
    writeRuntimeMarker(markerDir, 'copilot');
    process.env.GSD_TEST_RUNTIME_MARKER_DIR = markerDir;
    writeConfig({ model_profile: 'quality' });
    const result = resolveEffortInternal(tmpDir, 'gsd-planner');
    assert.strictEqual(result, null);
  });

  test('Test 7: returns normal value when .runtime marker is claude', () => {
    const markerDir = path.join(tmpDir, 'marker-claude');
    writeRuntimeMarker(markerDir, 'claude');
    process.env.GSD_TEST_RUNTIME_MARKER_DIR = markerDir;
    writeConfig({ model_profile: 'quality' });
    const result = resolveEffortInternal(tmpDir, 'gsd-planner');
    assert.strictEqual(result, 'xhigh');
  });

  test('Test 8: returns normal value when .runtime marker is absent (backward compat, defaults to claude)', () => {
    const markerDir = path.join(tmpDir, 'marker-absent');
    fs.mkdirSync(markerDir, { recursive: true });
    process.env.GSD_TEST_RUNTIME_MARKER_DIR = markerDir;
    writeConfig({ model_profile: 'quality' });
    const result = resolveEffortInternal(tmpDir, 'gsd-planner');
    assert.strictEqual(result, 'xhigh');
  });

  // Haiku-skip tests (Tests 9-13)

  let stderrBuffer = '';
  let origWriteSync;

  function startStderrCapture() {
    stderrBuffer = '';
    origWriteSync = fs.writeSync;
    fs.writeSync = (...args) => {
      const [fd, data] = args;
      if (fd === 2) {
        stderrBuffer += String(data);
        return Buffer.isBuffer(data) ? data.length : String(data).length;
      }
      return origWriteSync(...args);
    };
  }

  function stopStderrCapture() {
    if (origWriteSync) {
      fs.writeSync = origWriteSync;
      origWriteSync = undefined;
    }
    return stderrBuffer;
  }

  // Restore fs.writeSync even if a test throws between start/stop — prevents
  // a failed assertion in one test from leaking the monkey-patch into the next.
  afterEach(() => {
    if (origWriteSync) {
      fs.writeSync = origWriteSync;
      origWriteSync = undefined;
    }
  });

  test('Test 9: returns null for haiku model from profile (budget profile, gsd-research-synthesizer)', () => {
    writeConfig({ model_profile: 'budget' });
    startStderrCapture();
    const result = resolveEffortInternal(tmpDir, 'gsd-research-synthesizer');
    const captured = stopStderrCapture();
    assert.strictEqual(
      result,
      null,
      'Expected null when resolved model is haiku (from profile)',
    );
    assert.strictEqual(
      captured,
      '',
      'No warning should emit for profile-derived haiku (no explicit override)',
    );
  });

  test('Test 10: returns null when model_overrides forces haiku (quality profile, gsd-planner)', () => {
    writeConfig({
      model_profile: 'quality',
      model_overrides: { 'gsd-planner': 'haiku' },
    });
    startStderrCapture();
    const result = resolveEffortInternal(tmpDir, 'gsd-planner');
    stopStderrCapture();
    assert.strictEqual(
      result,
      null,
      'Expected null when model_overrides forces haiku',
    );
  });

  test('Test 11: returns null AND emits warning when explicit effort_override + haiku model', () => {
    writeConfig({
      model_profile: 'quality',
      model_overrides: { 'gsd-planner': 'haiku' },
      effort_overrides: { 'gsd-planner': 'xhigh' },
    });
    startStderrCapture();
    const result = resolveEffortInternal(tmpDir, 'gsd-planner');
    const captured = stopStderrCapture();
    assert.strictEqual(
      result,
      null,
      'Expected null when effort override is ignored due to haiku model',
    );
    assert.ok(
      captured.includes('haiku'),
      `Warning should mention haiku, got: ${captured}`,
    );
    assert.ok(
      captured.includes('gsd-planner'),
      `Warning should mention gsd-planner, got: ${captured}`,
    );
  });

  test('Test 12: no warning when balanced profile (inherit effort, no explicit override)', () => {
    writeConfig({ model_profile: 'balanced' });
    startStderrCapture();
    const result = resolveEffortInternal(tmpDir, 'gsd-planner');
    const captured = stopStderrCapture();
    assert.strictEqual(
      result,
      null,
      'Expected null for balanced profile (inherit resolves to null)',
    );
    assert.strictEqual(
      captured,
      '',
      'No warning for profile-derived effort (no explicit override)',
    );
  });

  test('Test 13: profile=inherit (resolveModelInternal returns null) — no haiku skip, no crash', () => {
    writeConfig({ model_profile: 'inherit' });
    startStderrCapture();
    let result;
    assert.doesNotThrow(() => {
      result = resolveEffortInternal(tmpDir, 'gsd-planner');
    });
    const captured = stopStderrCapture();
    assert.strictEqual(result, null, 'Expected null when profile is inherit');
    assert.strictEqual(
      captured,
      '',
      'No warning when model resolves to null (not haiku)',
    );
  });

  test('Test 14: explicit override max + non-tier model — skip + warn (max needs a high-tier model)', () => {
    // 'sonnet-4-6' is a version-pinned model string, legal because model_overrides
    // is free-text. Sonnet 4.6 predates xhigh in the Sonnet tier, so max is dropped.
    writeConfig({
      model_profile: 'balanced',
      model_overrides: { 'gsd-executor': 'sonnet-4-6' },
      effort_overrides: { 'gsd-executor': 'max' },
    });
    startStderrCapture();
    const result = resolveEffortInternal(tmpDir, 'gsd-executor');
    const captured = stopStderrCapture();
    assert.strictEqual(
      result,
      null,
      'max effort dropped because sonnet-4-6 is not a high-tier model',
    );
    assert.ok(
      captured.includes('max'),
      `Warning should mention max, got: ${captured}`,
    );
    assert.ok(
      captured.includes('opus'),
      `Warning should name the required models, got: ${captured}`,
    );
    assert.ok(
      captured.includes('gsd-executor'),
      `Warning should mention agent, got: ${captured}`,
    );
  });

  test('Test 15: explicit override xhigh + non-tier model — skip + warn (xhigh needs a high-tier model)', () => {
    writeConfig({
      model_profile: 'balanced',
      model_overrides: { 'gsd-executor': 'sonnet-4-6' },
      effort_overrides: { 'gsd-executor': 'xhigh' },
    });
    startStderrCapture();
    const result = resolveEffortInternal(tmpDir, 'gsd-executor');
    const captured = stopStderrCapture();
    assert.strictEqual(
      result,
      null,
      'xhigh effort dropped because sonnet-4-6 is not a high-tier model',
    );
    assert.ok(
      captured.includes('xhigh'),
      `Warning should mention xhigh, got: ${captured}`,
    );
    assert.ok(
      captured.includes('opus'),
      `Warning should name the required models, got: ${captured}`,
    );
  });

  test('Test 16: profile-derived xhigh + non-tier model via model_overrides — silent skip, no warning', () => {
    // Quality profile gives gsd-planner effort=xhigh; force the model to a version-pinned
    // sonnet-4-6 via override. Effort is profile-derived (no effort_overrides), so the
    // skip is silent.
    writeConfig({
      model_profile: 'quality',
      model_overrides: { 'gsd-planner': 'sonnet-4-6' },
    });
    startStderrCapture();
    const result = resolveEffortInternal(tmpDir, 'gsd-planner');
    const captured = stopStderrCapture();
    assert.strictEqual(
      result,
      null,
      'profile-derived xhigh effort dropped silently for a non-tier model',
    );
    assert.strictEqual(
      captured,
      '',
      'No warning for profile-derived skip (no explicit effort override)',
    );
  });

  test('Test 17: opus model + max effort — passes through (compatible)', () => {
    writeConfig({
      model_profile: 'balanced',
      model_overrides: { 'gsd-executor': 'opus' },
      effort_overrides: { 'gsd-executor': 'max' },
    });
    startStderrCapture();
    const result = resolveEffortInternal(tmpDir, 'gsd-executor');
    const captured = stopStderrCapture();
    assert.strictEqual(result, 'max', 'max passes through when model is opus');
    assert.strictEqual(
      captured,
      '',
      'No warning when model+effort are compatible',
    );
  });

  test('Test 18: opus model + xhigh effort — passes through (compatible)', () => {
    writeConfig({
      model_profile: 'balanced',
      model_overrides: { 'gsd-executor': 'opus' },
      effort_overrides: { 'gsd-executor': 'xhigh' },
    });
    startStderrCapture();
    const result = resolveEffortInternal(tmpDir, 'gsd-executor');
    const captured = stopStderrCapture();
    assert.strictEqual(
      result,
      'xhigh',
      'xhigh passes through when model is opus',
    );
    assert.strictEqual(
      captured,
      '',
      'No warning when model+effort are compatible',
    );
  });

  test('Test 18b: fable model + xhigh/max effort — passes through (compatible)', () => {
    for (const effort of ['xhigh', 'max']) {
      writeConfig({
        model_profile: 'balanced',
        model_overrides: { 'gsd-executor': 'fable' },
        effort_overrides: { 'gsd-executor': effort },
      });
      startStderrCapture();
      const result = resolveEffortInternal(tmpDir, 'gsd-executor');
      const captured = stopStderrCapture();
      assert.strictEqual(
        result,
        effort,
        `${effort} passes through when model is fable`,
      );
      assert.strictEqual(
        captured,
        '',
        `No warning for fable + ${effort}, got: ${captured}`,
      );
    }
  });

  test('Test 18c: sonnet model + xhigh/max effort — passes through (compatible)', () => {
    // The bare `sonnet` alias resolves to Sonnet 5, which supports the full
    // low/medium/high/xhigh/max range. Effort must survive rather than being
    // stripped back to the session default.
    for (const effort of ['xhigh', 'max']) {
      writeConfig({
        model_profile: 'balanced',
        model_overrides: { 'gsd-executor': 'sonnet' },
        effort_overrides: { 'gsd-executor': effort },
      });
      startStderrCapture();
      const result = resolveEffortInternal(tmpDir, 'gsd-executor');
      const captured = stopStderrCapture();
      assert.strictEqual(
        result,
        effort,
        `${effort} passes through when model is sonnet`,
      );
      assert.strictEqual(
        captured,
        '',
        `No warning for sonnet + ${effort}, got: ${captured}`,
      );
    }
  });

  test('Test 19: profile=inherit with explicit max override — no skip (model unknown)', () => {
    writeConfig({
      model_profile: 'inherit',
      effort_overrides: { 'gsd-executor': 'max' },
    });
    startStderrCapture();
    const result = resolveEffortInternal(tmpDir, 'gsd-executor');
    const captured = stopStderrCapture();
    assert.strictEqual(
      result,
      'max',
      'max passes through when model is unknown (inherit)',
    );
    assert.strictEqual(
      captured,
      '',
      'No warning when model is unknown — cannot determine compatibility',
    );
  });
});

// ─── core.cjs branch/line residuals (60-11) ────────────────────────────────

describe('core.cjs residuals (60-11)', () => {
  let tmpDir;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(resolveTmpDir(), 'gsd-core-r-'));
  });
  afterEach(() => {
    cleanup(tmpDir);
  });

  // reapStaleTempFiles: lines 70-77, 80-81 — exercise both directory and
  // non-directory branches plus skip-if-not-stale and inner catch.
  test('reapStaleTempFiles: removes stale directories matching prefix', () => {
    const { reapStaleTempFiles } = require('../gsd-ng/bin/lib/core.cjs');
    const sysTmp = resolveTmpDir();
    const prefix = `gsd-test-reap-${Date.now()}-`;
    const staleDir = path.join(sysTmp, prefix + 'old');
    fs.mkdirSync(staleDir, { recursive: true });
    fs.writeFileSync(path.join(staleDir, 'f'), 'x');
    // Backdate mtime by 1h
    const past = Date.now() / 1000 - 3600;
    fs.utimesSync(staleDir, past, past);
    // Run reaper with maxAgeMs=1ms (ensures stale)
    reapStaleTempFiles(prefix, { maxAgeMs: 1 });
    assert.ok(!fs.existsSync(staleDir));
  });

  test('reapStaleTempFiles: removes stale files (non-directory) when dirsOnly=false', () => {
    const { reapStaleTempFiles } = require('../gsd-ng/bin/lib/core.cjs');
    const sysTmp = resolveTmpDir();
    const prefix = `gsd-test-reap-file-${Date.now()}-`;
    const staleFile = path.join(sysTmp, prefix + 'stale.txt');
    fs.writeFileSync(staleFile, 'x');
    const past = Date.now() / 1000 - 3600;
    fs.utimesSync(staleFile, past, past);
    reapStaleTempFiles(prefix, { maxAgeMs: 1, dirsOnly: false });
    assert.ok(!fs.existsSync(staleFile));
  });

  test('reapStaleTempFiles: skips non-stale entries', () => {
    const { reapStaleTempFiles } = require('../gsd-ng/bin/lib/core.cjs');
    const sysTmp = resolveTmpDir();
    const prefix = `gsd-test-reap-fresh-${Date.now()}-`;
    const freshDir = path.join(sysTmp, prefix + 'fresh');
    fs.mkdirSync(freshDir, { recursive: true });
    // Don't backdate — should be considered fresh
    reapStaleTempFiles(prefix, { maxAgeMs: 60_000 });
    assert.ok(fs.existsSync(freshDir));
    cleanupSubdir(sysTmp, prefix + 'fresh');
  });

  test('reapStaleTempFiles: dirsOnly=true skips non-directory entries', () => {
    const { reapStaleTempFiles } = require('../gsd-ng/bin/lib/core.cjs');
    const sysTmp = resolveTmpDir();
    const prefix = `gsd-test-reap-dirsonly-${Date.now()}-`;
    const staleFile = path.join(sysTmp, prefix + 'stale.txt');
    fs.writeFileSync(staleFile, 'x');
    const past = Date.now() / 1000 - 3600;
    fs.utimesSync(staleFile, past, past);
    reapStaleTempFiles(prefix, { maxAgeMs: 1, dirsOnly: true });
    // File should NOT be removed when dirsOnly=true
    assert.ok(fs.existsSync(staleFile));
    fs.unlinkSync(staleFile);
  });

  // searchPhaseInDir / findPhaseInternal catch arms (lines 452-453, 489-490)
  test('searchPhaseInDir: returns null on readdirSync error (missing dir)', () => {
    const { searchPhaseInDir } = require('../gsd-ng/bin/lib/core.cjs');
    const r = searchPhaseInDir(
      path.join(tmpDir, 'no-such-dir'),
      '.planning/phases',
      '01',
    );
    assert.strictEqual(r, null);
  });

  test('findPhaseInternal: returns null when phase not found anywhere', () => {
    const { findPhaseInternal } = require('../gsd-ng/bin/lib/core.cjs');
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases'), { recursive: true });
    const r = findPhaseInternal(tmpDir, '99');
    assert.strictEqual(r, null);
  });

  test('findPhaseInternal: searches archived milestones when current not found', () => {
    const { findPhaseInternal } = require('../gsd-ng/bin/lib/core.cjs');
    const milestonesDir = path.join(
      tmpDir,
      '.planning',
      'milestones',
      'v1.0-phases',
    );
    fs.mkdirSync(path.join(milestonesDir, '05-archived'), { recursive: true });
    fs.writeFileSync(
      path.join(milestonesDir, '05-archived', '05-1-PLAN.md'),
      '---\n---\n',
    );
    const r = findPhaseInternal(tmpDir, '5');
    assert.ok(r);
    assert.strictEqual(r.archived, 'v1.0');
  });

  test('findPhaseInternal: nullish phase returns null', () => {
    const { findPhaseInternal } = require('../gsd-ng/bin/lib/core.cjs');
    assert.strictEqual(findPhaseInternal(tmpDir, null), null);
    assert.strictEqual(findPhaseInternal(tmpDir, ''), null);
  });

  test('findPhaseInternal: missing milestonesDir returns null', () => {
    const { findPhaseInternal } = require('../gsd-ng/bin/lib/core.cjs');
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases'), { recursive: true });
    // No milestones dir at all — early return
    const r = findPhaseInternal(tmpDir, '99');
    assert.strictEqual(r, null);
  });

  // replaceInCurrentMilestone with </details> close (lines 555-558)
  test('replaceInCurrentMilestone: uses content after last </details>', () => {
    const { replaceInCurrentMilestone } = require('../gsd-ng/bin/lib/core.cjs');
    const before =
      '<details>\n## Phase 1: foo\nold\n</details>\n\n## Phase 2: bar\nold-active';
    const r = replaceInCurrentMilestone(before, /old-active/, 'new-active');
    // Replacement happens AFTER the last </details>
    assert.match(r.content, /new-active/);
    // The </details> region remains untouched
    assert.match(r.content, /old\n<\/details>/);
    assert.strictEqual(r.changed, true, 'the rewrite landed');
  });

  test('replaceInCurrentMilestone: no </details> falls back to plain replace', () => {
    const { replaceInCurrentMilestone } = require('../gsd-ng/bin/lib/core.cjs');
    const r = replaceInCurrentMilestone('plain content', /content/, 'replaced');
    assert.match(r.content, /replaced/);
    assert.strictEqual(r.changed, true, 'the rewrite landed');
  });

  test('replaceInCurrentMilestone: reports a pattern that matched nothing', () => {
    const { replaceInCurrentMilestone } = require('../gsd-ng/bin/lib/core.cjs');
    const r = replaceInCurrentMilestone('plain content', /absent/, 'replaced');
    assert.strictEqual(r.content, 'plain content', 'content is untouched');
    assert.strictEqual(r.changed, false, 'a no-match must be reported');
  });

  test('replaceInCurrentMilestone: a match inside an archived milestone is not a landing', () => {
    const { replaceInCurrentMilestone } = require('../gsd-ng/bin/lib/core.cjs');
    const before = '<details>\n**Plans**: TBD\n</details>\n\n## Phase 2: bar\n';
    const r = replaceInCurrentMilestone(before, /TBD/, 'done');
    assert.match(r.content, /\*\*Plans\*\*: TBD/, 'archive stays untouched');
    assert.strictEqual(
      r.changed,
      false,
      'a match outside the current milestone must not read as a landing',
    );
  });

  // getRoadmapPhaseInternal catch (lines 604-605)
  test('getRoadmapPhaseInternal: malformed roadmap returns null gracefully', () => {
    const { getRoadmapPhaseInternal } = require('../gsd-ng/bin/lib/core.cjs');
    fs.mkdirSync(path.join(tmpDir, '.planning'), { recursive: true });
    // Write malformed/empty roadmap — many regex branches return null
    fs.writeFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), '');
    const r = getRoadmapPhaseInternal(tmpDir, '99');
    assert.strictEqual(r, null);
  });

  // getMilestoneInfo: in-progress milestone via 🚧 marker (lines 713-717)
  test('getMilestoneInfo: parses in-progress milestone marker', () => {
    const { getMilestoneInfo } = require('../gsd-ng/bin/lib/core.cjs');
    fs.mkdirSync(path.join(tmpDir, '.planning'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      '# Roadmap\n\n- 🚧 **v2.1 Belgium** — Phases 24-28 (in progress)\n',
    );
    const info = getMilestoneInfo(tmpDir);
    assert.strictEqual(info.version, 'v2.1');
    assert.strictEqual(info.name, 'Belgium');
  });

  // getPhaseCompletionStatus catch arms (lines 806-807, 833-834)
  test('getPhaseCompletionStatus: returns not_started when phaseDir missing', () => {
    const { getPhaseCompletionStatus } = require('../gsd-ng/bin/lib/core.cjs');
    const r = getPhaseCompletionStatus(path.join(tmpDir, 'no-phase'));
    assert.strictEqual(r.isComplete, false);
    assert.strictEqual(r.status, 'not_started');
  });

  test('getPhaseCompletionStatus: complete (verified) when VERIFICATION.md status=passed', () => {
    const { getPhaseCompletionStatus } = require('../gsd-ng/bin/lib/core.cjs');
    const phaseDir = path.join(tmpDir, '01-x');
    fs.mkdirSync(phaseDir, { recursive: true });
    fs.writeFileSync(path.join(phaseDir, '01-1-PLAN.md'), '---\n---\n');
    fs.writeFileSync(path.join(phaseDir, '01-1-SUMMARY.md'), '---\n---\n');
    fs.writeFileSync(
      path.join(phaseDir, '01-VERIFICATION.md'),
      '---\nstatus: passed\n---\n',
    );
    const r = getPhaseCompletionStatus(phaseDir);
    assert.strictEqual(r.isComplete, true);
    assert.strictEqual(r.status, 'complete (verified)');
  });

  test('getPhaseCompletionStatus: complete (unverified) when no VERIFICATION.md', () => {
    const { getPhaseCompletionStatus } = require('../gsd-ng/bin/lib/core.cjs');
    const phaseDir = path.join(tmpDir, '01-x');
    fs.mkdirSync(phaseDir, { recursive: true });
    fs.writeFileSync(path.join(phaseDir, '01-1-PLAN.md'), '---\n---\n');
    fs.writeFileSync(path.join(phaseDir, '01-1-SUMMARY.md'), '---\n---\n');
    const r = getPhaseCompletionStatus(phaseDir);
    assert.strictEqual(r.isComplete, true);
    assert.strictEqual(r.status, 'complete (unverified)');
  });

  test('getPhaseCompletionStatus: in_progress when summaries < plans', () => {
    const { getPhaseCompletionStatus } = require('../gsd-ng/bin/lib/core.cjs');
    const phaseDir = path.join(tmpDir, '01-x');
    fs.mkdirSync(phaseDir, { recursive: true });
    fs.writeFileSync(path.join(phaseDir, '01-1-PLAN.md'), '---\n---\n');
    fs.writeFileSync(path.join(phaseDir, '01-2-PLAN.md'), '---\n---\n');
    fs.writeFileSync(path.join(phaseDir, '01-1-SUMMARY.md'), '---\n---\n');
    const r = getPhaseCompletionStatus(phaseDir);
    assert.strictEqual(r.status, 'in_progress');
  });

  test('getPhaseCompletionStatus: not_started when no plans', () => {
    const { getPhaseCompletionStatus } = require('../gsd-ng/bin/lib/core.cjs');
    const phaseDir = path.join(tmpDir, '01-x');
    fs.mkdirSync(phaseDir, { recursive: true });
    const r = getPhaseCompletionStatus(phaseDir);
    assert.strictEqual(r.status, 'not_started');
  });

  test('getPhaseCompletionStatus: complete (unverified) when VERIFICATION.md unreadable', () => {
    const { getPhaseCompletionStatus } = require('../gsd-ng/bin/lib/core.cjs');
    const phaseDir = path.join(tmpDir, '01-x');
    fs.mkdirSync(phaseDir, { recursive: true });
    fs.writeFileSync(path.join(phaseDir, '01-1-PLAN.md'), '---\n---\n');
    fs.writeFileSync(path.join(phaseDir, '01-1-SUMMARY.md'), '---\n---\n');
    // Create VERIFICATION.md as a directory — readFileSync throws → catch fires
    fs.mkdirSync(path.join(phaseDir, '01-VERIFICATION.md'));
    const r = getPhaseCompletionStatus(phaseDir);
    assert.strictEqual(r.isComplete, true);
    assert.strictEqual(r.status, 'complete (unverified)');
  });

  // loadConfig: depth-to-granularity migration writes the migration back
  // to disk (file mutation) — verify by re-reading the JSON.
  test('loadConfig: migrates "depth: quick" to "granularity: coarse" on disk', () => {
    fs.mkdirSync(path.join(tmpDir, '.planning'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'config.json'),
      JSON.stringify({ depth: 'quick' }),
    );
    loadConfig(tmpDir);
    const reloaded = JSON.parse(
      fs.readFileSync(path.join(tmpDir, '.planning', 'config.json'), 'utf-8'),
    );
    assert.strictEqual(reloaded.granularity, 'coarse');
    assert.ok(!('depth' in reloaded));
  });

  test('loadConfig: migrates "depth: standard" to "granularity: standard"', () => {
    fs.mkdirSync(path.join(tmpDir, '.planning'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'config.json'),
      JSON.stringify({ depth: 'standard' }),
    );
    loadConfig(tmpDir);
    const reloaded = JSON.parse(
      fs.readFileSync(path.join(tmpDir, '.planning', 'config.json'), 'utf-8'),
    );
    assert.strictEqual(reloaded.granularity, 'standard');
  });

  test('loadConfig: migrates "depth: comprehensive" to "granularity: fine"', () => {
    fs.mkdirSync(path.join(tmpDir, '.planning'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'config.json'),
      JSON.stringify({ depth: 'comprehensive' }),
    );
    loadConfig(tmpDir);
    const reloaded = JSON.parse(
      fs.readFileSync(path.join(tmpDir, '.planning', 'config.json'), 'utf-8'),
    );
    assert.strictEqual(reloaded.granularity, 'fine');
  });

  test('loadConfig: unknown depth value falls through to itself', () => {
    fs.mkdirSync(path.join(tmpDir, '.planning'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'config.json'),
      JSON.stringify({ depth: 'unknown-value' }),
    );
    loadConfig(tmpDir);
    const reloaded = JSON.parse(
      fs.readFileSync(path.join(tmpDir, '.planning', 'config.json'), 'utf-8'),
    );
    assert.strictEqual(reloaded.granularity, 'unknown-value');
  });

  test('loadConfig: depth+granularity both present skips migration', () => {
    fs.mkdirSync(path.join(tmpDir, '.planning'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'config.json'),
      JSON.stringify({ depth: 'quick', granularity: 'fine' }),
    );
    loadConfig(tmpDir);
    const reloaded = JSON.parse(
      fs.readFileSync(path.join(tmpDir, '.planning', 'config.json'), 'utf-8'),
    );
    // Granularity already set — depth NOT migrated; both kept
    assert.strictEqual(reloaded.granularity, 'fine');
    assert.strictEqual(reloaded.depth, 'quick');
  });

  // writeToTempFile: tmpdir-fallback path (109-114)
  test('output() in JSON mode with file flag writes to tmp file', () => {
    // Use spawnSync to invoke gsd-tools with --json --file flags so output()
    // takes the writeToTempFile path
    const r = require('child_process').spawnSync(
      process.execPath,
      [
        path.resolve(__dirname, '../gsd-ng/bin/gsd-tools.cjs'),
        'current-timestamp',
        '--json',
        '--file',
      ],
      { encoding: 'utf-8' },
    );
    assert.strictEqual(r.status, 0);
    // Output is "@file:/path/to/file"
    assert.match(r.stdout, /^@file:/);
    const filePath = r.stdout.trim().slice('@file:'.length);
    assert.ok(fs.existsSync(filePath));
    // Cleanup
    try {
      fs.unlinkSync(filePath);
    } catch {}
  });
});

// ─── writeFileAtomic ───────────────────────────────────────────────────────────

describe('writeFileAtomic', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(resolveTmpDir(), 'gsd-atomic-test-'));
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('writes content and replaces an existing file', () => {
    const target = path.join(tmpDir, 'STATE.md');
    writeFileAtomic(target, 'first\n');
    assert.strictEqual(fs.readFileSync(target, 'utf-8'), 'first\n');
    writeFileAtomic(target, 'second\n');
    assert.strictEqual(fs.readFileSync(target, 'utf-8'), 'second\n');
  });

  test('leaves no temp file behind', () => {
    const target = path.join(tmpDir, 'STATE.md');
    writeFileAtomic(target, 'content\n');
    assert.deepStrictEqual(fs.readdirSync(tmpDir), ['STATE.md']);
  });

  test('preserves the existing file mode', () => {
    const target = path.join(tmpDir, 'STATE.md');
    fs.writeFileSync(target, 'original\n');
    fs.chmodSync(target, 0o640);
    writeFileAtomic(target, 'replacement\n');
    assert.strictEqual(fs.statSync(target).mode & 0o777, 0o640);
  });

  // A kill between the write and the rename leaves the temp file behind. Those
  // land next to the target — in the user's .planning/ — where the os.tmpdir()
  // reaper never looked, so they accumulated forever, invisible until someone
  // listed the directory.
  test('reapStaleAtomicTempFiles collects an orphan from an interrupted write', () => {
    const orphan = path.join(tmpDir, '.STATE.md.gsd-999999.0.tmp');
    fs.writeFileSync(orphan, 'half-written\n');
    const past = Date.now() / 1000 - 7200;
    fs.utimesSync(orphan, past, past);

    const removed = reapStaleAtomicTempFiles(tmpDir);
    assert.deepStrictEqual(removed, ['.STATE.md.gsd-999999.0.tmp']);
    assert.strictEqual(fs.existsSync(orphan), false);
  });

  // Deleting a temp file a writer is still holding would turn litter into
  // corruption, so the threshold has to be far longer than any real write.
  test('reapStaleAtomicTempFiles leaves a fresh temp file alone', () => {
    const inFlight = path.join(tmpDir, '.STATE.md.gsd-999999.1.tmp');
    fs.writeFileSync(inFlight, 'being written\n');

    const removed = reapStaleAtomicTempFiles(tmpDir);
    assert.deepStrictEqual(removed, []);
    assert.strictEqual(fs.existsSync(inFlight), true);
    assert.strictEqual(
      fs.readFileSync(inFlight, 'utf-8'),
      'being written\n',
      'a live writer’s temp file must be untouched',
    );
  });

  test('reapStaleAtomicTempFiles ignores files it did not write', () => {
    const foreign = [
      path.join(tmpDir, '.STATE.md.swp'),
      path.join(tmpDir, 'notes.tmp'),
      path.join(tmpDir, '.STATE.md.999999.0.tmp'),
    ];
    const past = Date.now() / 1000 - 7200;
    for (const f of foreign) {
      fs.writeFileSync(f, 'not ours\n');
      fs.utimesSync(f, past, past);
    }

    const removed = reapStaleAtomicTempFiles(tmpDir);
    assert.deepStrictEqual(removed, []);
    for (const f of foreign) {
      assert.strictEqual(fs.existsSync(f), true, `${f} must survive`);
    }
  });

  test('an atomic write sweeps orphans in the directory it writes to', () => {
    const orphan = path.join(tmpDir, '.STATE.md.gsd-999999.2.tmp');
    fs.writeFileSync(orphan, 'half-written\n');
    const past = Date.now() / 1000 - 7200;
    fs.utimesSync(orphan, past, past);

    const target = path.join(tmpDir, 'STATE.md');
    writeFileAtomic(target, 'fresh\n');

    assert.strictEqual(fs.existsSync(orphan), false);
    assert.deepStrictEqual(fs.readdirSync(tmpDir), ['STATE.md']);
  });

  test('removes the temp file and rethrows when the rename target is a directory', () => {
    const target = path.join(tmpDir, 'STATE.md');
    fs.mkdirSync(target);
    assert.throws(() => writeFileAtomic(target, 'content\n'));
    assert.deepStrictEqual(fs.readdirSync(tmpDir), ['STATE.md']);
  });

  // The regression this exists for: fs.writeFileSync truncates before it writes,
  // so a reader racing the write sees an empty or half-written file. Parallel
  // executors rewriting STATE.md hit exactly that, and it surfaces as a field
  // parsed as undefined.
  test('a concurrent reader never observes a partial file', async () => {
    const { spawn } = require('node:child_process');
    const target = path.join(tmpDir, 'STATE.md');
    const doneFlag = path.join(tmpDir, 'done');

    const lenA = 512 * 1024;
    const lenB = 512 * 1024 + 8192;
    const contentA = 'A'.repeat(lenA - 1) + '\n';
    const contentB = 'B'.repeat(lenB - 1) + '\n';
    fs.writeFileSync(target, contentA);

    const readyFlag = path.join(tmpDir, 'ready');
    const readerSrc = `
      const fs = require('fs');
      const [target, doneFlag, readyFlag, lenA, lenB] = process.argv.slice(1);
      const a = 'A'.repeat(Number(lenA) - 1) + '\\n';
      const b = 'B'.repeat(Number(lenB) - 1) + '\\n';
      let reads = 0;
      const bad = [];
      fs.writeFileSync(readyFlag, '');
      while (!fs.existsSync(doneFlag)) {
        let c;
        try { c = fs.readFileSync(target, 'utf-8'); } catch { continue; }
        reads++;
        if (c !== a && c !== b && bad.length < 5) bad.push(c.length);
      }
      process.stdout.write(JSON.stringify({ reads, bad }));
    `;

    const reader = spawn(
      process.execPath,
      [
        '-e',
        readerSrc,
        '--',
        target,
        doneFlag,
        readyFlag,
        String(lenA),
        String(lenB),
      ],
      { stdio: ['ignore', 'pipe', 'inherit'] },
    );
    let readerOut = '';
    reader.stdout.on('data', (d) => (readerOut += d));

    // Without this the writer loop can finish before the reader process is up,
    // leaving nothing observed and nothing asserted.
    while (!fs.existsSync(readyFlag)) {
      await new Promise((r) => setTimeout(r, 5));
    }

    for (let i = 0; i < 120; i++) {
      writeFileAtomic(target, i % 2 === 0 ? contentB : contentA);
      await new Promise((r) => setImmediate(r));
    }
    fs.writeFileSync(doneFlag, '');
    await new Promise((r) => reader.on('close', r));

    const result = JSON.parse(readerOut);
    assert.ok(result.reads > 0, 'reader should have observed the file');
    assert.deepStrictEqual(
      result.bad,
      [],
      `reader observed partial content (byte lengths: ${result.bad.join(', ')})`,
    );
  });
});

// ─── withFileLock ─────────────────────────────────────────────────────────────
//
// writeFileAtomic stops a reader seeing half a file. It does nothing for a
// read-modify-write, where every concurrent writer succeeds and all but the last
// one's change is discarded. These cover the mechanism; the lost-update
// regression itself is in state.test.cjs.

describe('withFileLock', () => {
  const { spawn } = require('node:child_process');
  const CORE_LIB = path.join(
    __dirname,
    '..',
    'gsd-ng',
    'bin',
    'lib',
    'core.cjs',
  );
  let tmpDir;
  let target;

  const LOCKER_SRC = `
    const fs = require('fs');
    const [lib, target, readyFlag, markerFile] = process.argv.slice(1);
    const { withFileLock } = require(lib);
    fs.writeFileSync(readyFlag, '');
    withFileLock(target, () => { fs.writeFileSync(markerFile, ''); }, { pollMs: 5 });
  `;

  const HOLDER_SRC = `
    const fs = require('fs');
    const [lib, target, readyFlag] = process.argv.slice(1);
    const { acquireFileLock, lockPathFor } = require(lib);
    const result = acquireFileLock(lockPathFor(target));
    if (result.mode !== 'locked') { fs.writeSync(2, 'not locked: ' + result.mode); process.exit(9); }
    fs.writeFileSync(readyFlag, '');
    setInterval(() => {}, 1000);
  `;

  const EXITER_SRC = `
    const [lib, target] = process.argv.slice(1);
    const { acquireFileLock, lockPathFor } = require(lib);
    acquireFileLock(lockPathFor(target));
    process.exit(0);
  `;

  const RELEASER_SRC = `
    const [lib, target] = process.argv.slice(1);
    const { withFileLock } = require(lib);
    withFileLock(target, () => 'done');
  `;

  // Holds the lock inside its critical section until the go flag appears, so the
  // window a second process is tested against is one this test opens and closes.
  // The wait is bounded so a go flag that never arrives fails the parent's
  // assertions rather than hanging the run.
  const HOLD_UNTIL_SRC = `
    const fs = require('fs');
    const [lib, target, readyFlag, goFlag] = process.argv.slice(1);
    const { withFileLock } = require(lib);
    withFileLock(target, () => {
      fs.writeFileSync(readyFlag, String(process.pid));
      const deadline = Date.now() + 20000;
      while (!fs.existsSync(goFlag) && Date.now() < deadline) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      }
    }, { pollMs: 5 });
  `;

  function waitForFlag(flagPath) {
    const deadline = Date.now() + 10000;
    return new Promise((resolve, reject) => {
      const timer = setInterval(() => {
        if (fs.existsSync(flagPath)) {
          clearInterval(timer);
          resolve();
          return;
        }
        if (Date.now() >= deadline) {
          clearInterval(timer);
          reject(new Error('the child never started'));
        }
      }, 5);
    });
  }

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(resolveTmpDir(), 'gsd-lock-test-'));
    target = path.join(tmpDir, 'STATE.md');
    fs.writeFileSync(target, 'content\n');
  });

  afterEach(() => {
    releaseFileLock(lockPathFor(target));
    cleanup(tmpDir);
  });

  test('runs the body and leaves no lock file behind', () => {
    const seen = withFileLock(target, () => fs.readFileSync(target, 'utf-8'));
    assert.strictEqual(seen, 'content\n');
    assert.deepStrictEqual(fs.readdirSync(tmpDir), ['STATE.md']);
  });

  test('releases the lock when the body throws', () => {
    assert.throws(() => {
      withFileLock(target, () => {
        throw new Error('boom');
      });
    }, /boom/);
    assert.strictEqual(fs.existsSync(lockPathFor(target)), false);
  });

  test('a nested acquire does not deadlock against itself', () => {
    // A locked command calling another locked command is one process waiting for
    // a lock it already holds. Without a depth count that is its whole budget.
    const order = [];
    withFileLock(
      target,
      () => {
        order.push('outer');
        withFileLock(
          target,
          () => {
            order.push('inner');
            assert.strictEqual(
              fs.existsSync(lockPathFor(target)),
              true,
              'inner body still holds the lock',
            );
          },
          { budgetMs: 200, pollMs: 5 },
        );
        assert.strictEqual(
          fs.existsSync(lockPathFor(target)),
          true,
          'the inner release must not drop the outer hold',
        );
        order.push('outer-after');
      },
      { budgetMs: 200, pollMs: 5 },
    );
    assert.deepStrictEqual(order, ['outer', 'inner', 'outer-after']);
    assert.strictEqual(fs.existsSync(lockPathFor(target)), false);
  });

  test('a second process waits for the holder instead of proceeding', async () => {
    // Deterministic by construction: this process holds the lock for a window it
    // controls, and the child announces readiness before it tries to take it, so
    // the absence of the marker is evidence of exclusion rather than of a child
    // that had not started.
    const readyFlag = path.join(tmpDir, 'ready');
    const marker = path.join(tmpDir, 'marker');
    const acquired = acquireFileLock(lockPathFor(target));
    assert.strictEqual(acquired.mode, 'locked');

    const child = spawn(
      process.execPath,
      ['-e', LOCKER_SRC, '--', CORE_LIB, target, readyFlag, marker],
      { stdio: ['ignore', 'ignore', 'pipe'] },
    );
    let stderr = '';
    child.stderr.on('data', (d) => (stderr += d));

    await waitForFlag(readyFlag);
    await new Promise((r) => setTimeout(r, 300));
    const enteredWhileHeld = fs.existsSync(marker);

    releaseFileLock(lockPathFor(target));
    const code = await new Promise((r) => child.on('close', r));

    assert.strictEqual(
      enteredWhileHeld,
      false,
      'the child entered the critical section while the lock was held',
    );
    assert.strictEqual(code, 0, `child exited ${code}: ${stderr}`);
    assert.strictEqual(
      fs.existsSync(marker),
      true,
      'the child should proceed once the lock is released',
    );
  });

  test('a live foreign holder times out loudly rather than being clobbered', () => {
    // pid of this process, which is alive and is not registered as a holder in
    // this module's depth map — the shape of a real second GSD process.
    fs.writeFileSync(
      lockPathFor(target),
      JSON.stringify({
        pid: process.pid,
        host: require('os').hostname(),
        at: new Date().toISOString(),
      }),
    );

    let caught;
    try {
      withFileLock(target, () => 'never', {
        budgetMs: 100,
        pollMs: 10,
        staleMs: 60000,
      });
    } catch (err) {
      caught = err;
    }

    assert.ok(caught, 'expected a lock timeout');
    assert.strictEqual(caught.code, 'GSD_LOCK_TIMEOUT');
    assert.strictEqual(caught.holder.pid, process.pid);
    assert.match(caught.message, new RegExp(`pid ${process.pid}`));
    assert.match(caught.message, /STATE\.md/);
  });

  test('a holder that no longer exists is stolen at once', async () => {
    // A pid that has certainly exited: spawn a process and wait for its close.
    const corpse = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
    const deadPid = corpse.pid;
    await new Promise((r) => corpse.on('close', r));

    fs.writeFileSync(
      lockPathFor(target),
      JSON.stringify({
        pid: deadPid,
        host: require('os').hostname(),
        at: new Date().toISOString(),
      }),
    );

    // Budget far below the staleness threshold, so only the liveness check can
    // explain success — a crashed holder must not cost a wait.
    const ran = withFileLock(target, () => 'ran', {
      budgetMs: 500,
      pollMs: 10,
      staleMs: 60 * 60 * 1000,
    });
    assert.strictEqual(ran, 'ran');
    assert.strictEqual(fs.existsSync(lockPathFor(target)), false);
  });

  test('a lock older than the staleness threshold is stolen', () => {
    const lockPath = lockPathFor(target);
    // Payload pid is alive, so staleness is the only thing that can release it —
    // the live-holder threshold, lowered here to the same value as the other one.
    fs.writeFileSync(
      lockPath,
      JSON.stringify({
        pid: process.pid,
        host: require('os').hostname(),
        at: new Date().toISOString(),
      }),
    );
    const longAgo = new Date(Date.now() - 60 * 60 * 1000);
    fs.utimesSync(lockPath, longAgo, longAgo);

    const ran = withFileLock(target, () => 'ran', {
      budgetMs: 500,
      pollMs: 10,
      staleMs: 1000,
      liveStaleMs: 1000,
    });
    assert.strictEqual(ran, 'ran');
    assert.strictEqual(fs.existsSync(lockPath), false);
  });

  test('an unidentifiable holder is waited for, not stolen', () => {
    // A process killed between creating the lock and writing its payload leaves
    // a lock nothing can be liveness-checked against. Stealing on that basis
    // would treat every fresh lock as abandoned, so the age is all that counts.
    fs.writeFileSync(lockPathFor(target), '');

    let caught;
    try {
      withFileLock(target, () => 'never', {
        budgetMs: 100,
        pollMs: 10,
        staleMs: 60000,
      });
    } catch (err) {
      caught = err;
    }

    assert.ok(caught, 'expected a lock timeout');
    assert.strictEqual(caught.code, 'GSD_LOCK_TIMEOUT');
    assert.strictEqual(caught.holder, null);
    assert.match(caught.message, /unidentified process/);
  });

  test('an unidentifiable holder is still stolen once it is stale', () => {
    const lockPath = lockPathFor(target);
    fs.writeFileSync(lockPath, 'not json');
    const longAgo = new Date(Date.now() - 60 * 60 * 1000);
    fs.utimesSync(lockPath, longAgo, longAgo);

    const ran = withFileLock(target, () => 'ran', {
      budgetMs: 500,
      pollMs: 10,
      staleMs: 1000,
    });
    assert.strictEqual(ran, 'ran');
  });

  test('a holder on another host is judged by age, not by pid', () => {
    // A pid from another machine says nothing about a process on this one, and
    // on a shared filesystem it could collide with a live local pid.
    const lockPath = lockPathFor(target);
    const payload = JSON.stringify({
      pid: process.pid,
      host: 'some-other-host',
      at: new Date().toISOString(),
    });

    fs.writeFileSync(lockPath, payload);
    assert.throws(
      () =>
        withFileLock(target, () => 'never', {
          budgetMs: 100,
          pollMs: 10,
          staleMs: 60000,
        }),
      /some-other-host/,
      'a fresh foreign-host lock must be waited for',
    );

    const longAgo = new Date(Date.now() - 60 * 60 * 1000);
    fs.utimesSync(lockPath, longAgo, longAgo);
    const ran = withFileLock(target, () => 'ran', {
      budgetMs: 500,
      pollMs: 10,
      staleMs: 1000,
    });
    assert.strictEqual(ran, 'ran');
  });

  test('a live holder on this host is not stolen from by age', () => {
    // The staleness threshold backstops the cases where liveness cannot be
    // established. When the payload names a running process on this host it can,
    // so age is not evidence of abandonment: stealing on it put two processes
    // inside the section at once and left each one unlinking the other's lock.
    const lockPath = lockPathFor(target);
    fs.writeFileSync(
      lockPath,
      JSON.stringify({
        pid: process.pid,
        host: require('os').hostname(),
        at: new Date().toISOString(),
      }),
    );
    const recently = new Date(Date.now() - 30 * 1000);
    fs.utimesSync(lockPath, recently, recently);

    let caught;
    try {
      withFileLock(target, () => 'never', {
        budgetMs: 200,
        pollMs: 10,
        staleMs: 1000,
      });
    } catch (err) {
      caught = err;
    }

    assert.ok(caught, 'expected a lock timeout rather than a steal');
    assert.strictEqual(caught.code, 'GSD_LOCK_TIMEOUT');
    assert.strictEqual(fs.existsSync(lockPath), true);
  });

  test('a live holder is reclaimed once its lock outlives any plausible section', () => {
    // The pid in an abandoned lock can be recycled onto an unrelated live
    // process, which would otherwise make the lock immortal. The live-holder
    // backstop is far above any real section but still finite.
    const lockPath = lockPathFor(target);
    fs.writeFileSync(
      lockPath,
      JSON.stringify({
        pid: process.pid,
        host: require('os').hostname(),
        at: new Date().toISOString(),
      }),
    );
    const longAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    fs.utimesSync(lockPath, longAgo, longAgo);

    const ran = withFileLock(target, () => 'ran', {
      budgetMs: 2000,
      pollMs: 10,
      staleMs: 1000,
    });
    assert.strictEqual(ran, 'ran');
    assert.strictEqual(fs.existsSync(lockPath), false);
  });

  test('a holder does not unlink a lock it no longer owns', () => {
    // Release used to unlink whatever lock file was at the path, so a holder
    // that had been stolen from deleted the thief's lock and left the section
    // unguarded for a third process.
    const lockPath = lockPathFor(target);
    const acquired = acquireFileLock(lockPath);
    assert.strictEqual(acquired.mode, 'locked');

    fs.unlinkSync(lockPath);
    fs.writeFileSync(
      lockPath,
      JSON.stringify({ pid: 999999, host: 'thief', at: 'later' }),
    );
    const thiefIno = fs.statSync(lockPath).ino;

    const originalWrite = process.stderr.write;
    const chunks = [];
    process.stderr.write = (chunk) => {
      chunks.push(String(chunk));
      return true;
    };
    let removed;
    try {
      removed = releaseFileLock(lockPath);
    } finally {
      process.stderr.write = originalWrite;
    }

    assert.strictEqual(removed, false);
    assert.strictEqual(fs.existsSync(lockPath), true);
    assert.strictEqual(fs.statSync(lockPath).ino, thiefIno);
    assert.match(chunks.join(''), /lock on STATE\.md was taken over/);
  });

  test('a holder does not unlink a replacement that reused the inode', () => {
    // CI caught this where a local run could not: the allocator handed the
    // replacement the inode the original had just freed, so a dev+ino check
    // read the thief's lock as our own and deleted it. Rewriting in place
    // reproduces that on any filesystem.
    const lockPath = lockPathFor(target);
    const acquired = acquireFileLock(lockPath);
    assert.strictEqual(acquired.mode, 'locked');
    const ourIno = fs.statSync(lockPath).ino;

    // No token in the replacement, which is the shape that defeated both the
    // inode check and a token check that fell back to the inode when the file
    // on disk carried none.
    fs.writeFileSync(
      lockPath,
      JSON.stringify({ pid: 999999, host: 'thief', at: 'later' }),
    );
    assert.strictEqual(
      fs.statSync(lockPath).ino,
      ourIno,
      'an in-place rewrite must keep the inode for this test to mean anything',
    );

    const originalWrite = process.stderr.write;
    const chunks = [];
    process.stderr.write = (chunk) => {
      chunks.push(String(chunk));
      return true;
    };
    let removed;
    try {
      removed = releaseFileLock(lockPath);
    } finally {
      process.stderr.write = originalWrite;
    }

    assert.strictEqual(removed, false);
    assert.strictEqual(fs.existsSync(lockPath), true);
    assert.match(chunks.join(''), /lock on STATE\.md was taken over/);
  });

  test('a section outlasting the staleness threshold keeps a second process out', async () => {
    // The window is opened and closed by this test: the child announces that it
    // is inside its section, and only leaves it once the go flag is written,
    // which happens after the second acquire has already returned.
    const readyFlag = path.join(tmpDir, 'ready');
    const goFlag = path.join(tmpDir, 'go');
    const lockPath = lockPathFor(target);

    const child = spawn(
      process.execPath,
      ['-e', HOLD_UNTIL_SRC, '--', CORE_LIB, target, readyFlag, goFlag],
      { stdio: ['ignore', 'ignore', 'pipe'] },
    );
    let stderr = '';
    child.stderr.on('data', (d) => (stderr += d));

    await waitForFlag(readyFlag);
    const heldIno = fs.statSync(lockPath).ino;

    let caught;
    try {
      withFileLock(target, () => 'entered', {
        budgetMs: 600,
        pollMs: 10,
        staleMs: 200,
      });
    } catch (err) {
      caught = err;
    }
    const inoDuringHold = fs.existsSync(lockPath)
      ? fs.statSync(lockPath).ino
      : null;

    fs.writeFileSync(goFlag, '');
    const code = await new Promise((r) => child.on('close', r));

    assert.ok(
      caught,
      'the second process entered a section the child was still inside',
    );
    assert.strictEqual(caught.code, 'GSD_LOCK_TIMEOUT');
    assert.strictEqual(
      inoDuringHold,
      heldIno,
      "the holder's lock file was replaced while it was inside its section",
    );
    assert.strictEqual(code, 0, `child exited ${code}: ${stderr}`);
    assert.strictEqual(
      fs.existsSync(lockPath),
      false,
      'the holder should remove its own lock on the way out',
    );
  });

  test('a foreign-host lock dated in the future is reclaimed at once', () => {
    // Clock skew between hosts sharing a .planning/ is what the host check
    // exists for, and it puts an mtime ahead of this host's clock. A negative
    // age can never exceed the threshold, so judging that lock by age alone
    // wedged every write on the file for as long as the file was there.
    const lockPath = lockPathFor(target);
    fs.writeFileSync(
      lockPath,
      JSON.stringify({
        pid: 999999,
        host: 'some-other-host',
        at: new Date().toISOString(),
      }),
    );
    const ahead = new Date(Date.now() + 2 * 60 * 1000);
    fs.utimesSync(lockPath, ahead, ahead);

    const startedAt = Date.now();
    const ran = withFileLock(target, () => 'ran', {
      budgetMs: 2000,
      pollMs: 10,
      staleMs: 1000,
    });
    const elapsed = Date.now() - startedAt;

    assert.strictEqual(ran, 'ran');
    assert.strictEqual(fs.existsSync(lockPath), false);
    assert.ok(
      elapsed < 1000,
      `reclaiming a future-dated lock must not cost a wait (took ${elapsed}ms)`,
    );
  });

  test('a lock a fraction ahead of the clock is still waited for', () => {
    // mtimeMs is sub-millisecond and Date.now() is truncated to whole
    // milliseconds, so a lock written this instant reads as a fraction of a
    // millisecond ahead of the clock nearly every time. Without slack, treating
    // an mtime in the future as stale makes every lock whose holder cannot be
    // liveness-checked stealable the moment it appears. 200ms stands in for that
    // fraction and for any small clock adjustment.
    const lockPath = lockPathFor(target);
    fs.writeFileSync(lockPath, '');
    const slightlyAhead = new Date(Date.now() + 200);
    fs.utimesSync(lockPath, slightlyAhead, slightlyAhead);

    let caught;
    try {
      withFileLock(target, () => 'entered', {
        budgetMs: 100,
        pollMs: 10,
        staleMs: 60000,
      });
    } catch (err) {
      caught = err;
    }

    assert.ok(caught, 'a lock barely ahead of the clock must not be stolen');
    assert.strictEqual(caught.code, 'GSD_LOCK_TIMEOUT');
    assert.strictEqual(fs.existsSync(lockPath), true);
  });

  test('a directory left at the lock path is cleared rather than waited out', () => {
    // unlinkSync cannot remove a directory, and the steal swallows the failure,
    // so junk at the lock path failed every write on the file indefinitely.
    const lockPath = lockPathFor(target);
    fs.mkdirSync(lockPath);
    const longAgo = new Date(Date.now() - 60 * 60 * 1000);
    fs.utimesSync(lockPath, longAgo, longAgo);

    const ran = withFileLock(target, () => 'ran', {
      budgetMs: 2000,
      pollMs: 10,
      staleMs: 1000,
    });
    assert.strictEqual(ran, 'ran');
    assert.strictEqual(fs.existsSync(lockPath), false);
  });

  test('a lock that cannot be created runs the body unserialised', () => {
    // Read-only tree, no permission, missing directory: refusing to write would
    // be worse than the lost update the lock exists to prevent.
    const unreachable = path.join(tmpDir, 'missing', 'STATE.md');
    const ran = withFileLock(unreachable, () => 'ran', {
      budgetMs: 100,
      pollMs: 10,
    });
    assert.strictEqual(ran, 'ran');
    assert.strictEqual(fs.existsSync(path.join(tmpDir, 'missing')), false);
  });

  test('a lock left by a hard-killed process needs no manual cleanup', async () => {
    const readyFlag = path.join(tmpDir, 'ready');
    const child = spawn(
      process.execPath,
      ['-e', HOLDER_SRC, '--', CORE_LIB, target, readyFlag],
      { stdio: ['ignore', 'ignore', 'pipe'] },
    );
    let stderr = '';
    child.stderr.on('data', (d) => (stderr += d));
    await waitForFlag(readyFlag);

    const lockPath = lockPathFor(target);
    assert.strictEqual(
      fs.existsSync(lockPath),
      true,
      `the child should hold the lock: ${stderr}`,
    );

    child.kill('SIGKILL');
    await new Promise((r) => child.on('close', r));
    assert.strictEqual(
      fs.existsSync(lockPath),
      true,
      'SIGKILL cannot run a release, so the lock file must still be there',
    );

    const ran = withFileLock(target, () => 'ran', {
      budgetMs: 500,
      pollMs: 10,
      staleMs: 60 * 60 * 1000,
    });
    assert.strictEqual(ran, 'ran');
    assert.strictEqual(fs.existsSync(lockPath), false);
  });

  // Ctrl-C is the ordinary way a command ends early, and process.on('exit') does
  // not run for signal termination: the lock outlived the process and the next
  // command had to wait out the staleness threshold behind a holder that was
  // already gone.
  async function assertSignalReleasesLock(signal) {
    const readyFlag = path.join(tmpDir, `ready-${signal}`);
    const child = spawn(
      process.execPath,
      ['-e', HOLDER_SRC, '--', CORE_LIB, target, readyFlag],
      { stdio: ['ignore', 'ignore', 'pipe'] },
    );
    let stderr = '';
    child.stderr.on('data', (d) => (stderr += d));
    await waitForFlag(readyFlag);

    const lockPath = lockPathFor(target);
    assert.strictEqual(
      fs.existsSync(lockPath),
      true,
      `the child should hold the lock: ${stderr}`,
    );

    child.kill(signal);
    const ended = await new Promise((r) =>
      child.on('close', (code, sig) => r({ code, sig })),
    );

    assert.strictEqual(
      fs.existsSync(lockPath),
      false,
      `${signal} left the lock behind`,
    );
    assert.strictEqual(
      ended.sig,
      signal,
      `${signal} must still end the process by that signal, got code ${ended.code}`,
    );
  }

  test('SIGINT releases the lock', async () => {
    await assertSignalReleasesLock('SIGINT');
  });

  test('SIGTERM releases the lock', async () => {
    await assertSignalReleasesLock('SIGTERM');
  });

  test('SIGHUP releases the lock', async () => {
    await assertSignalReleasesLock('SIGHUP');
  });

  test('a command that has finished with the lock still exits on its own', async () => {
    // The signal handlers are installed on first acquire. A handler that kept
    // the event loop referenced would hang every command that takes a lock.
    const child = spawn(
      process.execPath,
      ['-e', RELEASER_SRC, '--', CORE_LIB, target],
      { stdio: ['ignore', 'ignore', 'pipe'] },
    );
    let stderr = '';
    child.stderr.on('data', (d) => (stderr += d));
    const killer = setTimeout(() => child.kill('SIGKILL'), 5000);
    const ended = await new Promise((r) =>
      child.on('close', (code, sig) => r({ code, sig })),
    );
    clearTimeout(killer);

    assert.strictEqual(
      ended.sig,
      null,
      'the child had to be killed: something is holding the event loop open',
    );
    assert.strictEqual(ended.code, 0, `child exited ${ended.code}: ${stderr}`);
    assert.strictEqual(fs.existsSync(lockPathFor(target)), false);
  });

  test('a lock held at process exit is released by the exit hook', async () => {
    const child = spawn(
      process.execPath,
      ['-e', EXITER_SRC, '--', CORE_LIB, target],
      { stdio: ['ignore', 'ignore', 'pipe'] },
    );
    let stderr = '';
    child.stderr.on('data', (d) => (stderr += d));
    const code = await new Promise((r) => child.on('close', r));

    assert.strictEqual(code, 0, `child exited ${code}: ${stderr}`);
    assert.strictEqual(
      fs.existsSync(lockPathFor(target)),
      false,
      'process.exit inside a locked command must not leak the lock',
    );
  });
});

// ─── Phase checkbox readers ───────────────────────────────────────────────────
//
// Bare and bold are the two supported roadmap forms. Every reader shares one
// pattern so a form cannot be supported by the rewriters and invisible to the
// readers, which is how `phase complete` came to skip an outstanding phase.

describe('parsePhaseCheckboxes', () => {
  test('reads the bare form', () => {
    const entries = parsePhaseCheckboxes(
      '- [ ] Phase 1: Alpha\n- [x] Phase 2: Beta\n',
    );
    assert.deepStrictEqual(
      entries.map((e) => ({ num: e.num, name: e.name, checked: e.checked })),
      [
        { num: '1', name: 'Alpha', checked: false },
        { num: '2', name: 'Beta', checked: true },
      ],
    );
  });

  test('reads the bold form', () => {
    const entries = parsePhaseCheckboxes(
      '- [ ] **Phase 1: Alpha**\n- [x] **Phase 2: Beta**\n',
    );
    assert.deepStrictEqual(
      entries.map((e) => ({ num: e.num, name: e.name, checked: e.checked })),
      [
        { num: '1', name: 'Alpha', checked: false },
        { num: '2', name: 'Beta', checked: true },
      ],
    );
  });

  test('reads zero-padded, lettered and decimal numbers', () => {
    const entries = parsePhaseCheckboxes(
      ['- [ ] Phase 06: Six', '- [ ] Phase 6.1: Six One', '- [ ] **Phase 12A: Twelve A**'].join(
        '\n',
      ),
    );
    assert.deepStrictEqual(
      entries.map((e) => e.num),
      ['06', '6.1', '12A'],
    );
  });

  test('drops the completed suffix from the name', () => {
    const entries = parsePhaseCheckboxes(
      '- [x] Phase 3: Gamma (completed 2026-07-30)\n',
    );
    assert.deepStrictEqual(entries.map((e) => e.name), ['Gamma']);
  });

  test('ignores a mid-line phase mention', () => {
    const entries = parsePhaseCheckboxes(
      '- [ ] Ship the thing that Phase 4: needed\n',
    );
    assert.deepStrictEqual(entries, []);
  });

  test('reports a numbered checkbox with no title as nameless', () => {
    const entries = parsePhaseCheckboxes('- [ ] Phase 9\n');
    assert.deepStrictEqual(
      entries.map((e) => ({ num: e.num, name: e.name })),
      [{ num: '9', name: null }],
    );
  });

  test('reads the milestone rollover shape without its trailing metadata', () => {
    // What complete-milestone writes on every rollover. The bare form has no
    // closing delimiter, so the name used to run to the end of the line and
    // reached next_phase_name, which is slugified.
    const entries = parsePhaseCheckboxes(
      [
        '- [x] Phase 5: Security Audit (1 plan) — completed 2026-02-01',
        '- [x] Phase 6: Hardening (2/2 plans) — completed 2026-02-03',
        '- [ ] Phase 7: Hardening (2 plans)',
      ].join('\n'),
    );
    assert.deepStrictEqual(
      entries.map((e) => e.name),
      ['Security Audit', 'Hardening', 'Hardening'],
    );
  });

  test('reads an indented checkbox', () => {
    // Nesting a phase list under its milestone is ordinary markdown, and the
    // rewriters tick an indented entry, so a reader that skips one disagrees
    // with the writer about which phases exist.
    const entries = parsePhaseCheckboxes(
      '  - [ ] Phase 1: Alpha\n\t- [x] **Phase 2: Beta**\n',
    );
    assert.deepStrictEqual(
      entries.map((e) => ({ num: e.num, name: e.name, checked: e.checked })),
      [
        { num: '1', name: 'Alpha', checked: false },
        { num: '2', name: 'Beta', checked: true },
      ],
    );
  });

  test('takes a colonless entry as a phase, as the rewriters do', () => {
    // Deliberate: the colon is optional here because it is optional in the
    // pattern the four rewriters share, and a line they will tick has to be a
    // line the readers can see. The cost is that a checklist item opening with a
    // phase number reads as an entry for that phase.
    const entries = parsePhaseCheckboxes(
      '- [ ] Phase 4 needs review\n- [x] Phase 5 - Polish\n',
    );
    assert.deepStrictEqual(
      entries.map((e) => ({ num: e.num, name: e.name })),
      [
        { num: '4', name: 'needs review' },
        { num: '5', name: 'Polish' },
      ],
    );
  });
});

describe('phaseCheckboxLinePattern', () => {
  test('narrowed to a phase, tolerates padding and rejects a longer number', () => {
    const re = new RegExp(phaseCheckboxLinePattern(1), 'im');
    assert.ok(re.test('- [ ] Phase 01: Alpha'), 'padded form must match');
    assert.ok(re.test('- [ ] **Phase 1: Alpha**'), 'bold form must match');
    assert.strictEqual(
      re.test('- [ ] Phase 12: Twelve'),
      false,
      'phase 1 must not match phase 12',
    );
    assert.strictEqual(
      re.test('- [ ] Phase 1.1: One One'),
      false,
      'phase 1 must not match its own decimal without withDecimals',
    );
  });

  test('withDecimals also matches the phase decimals', () => {
    const re = new RegExp(phaseCheckboxLinePattern(36, { withDecimals: true }), 'im');
    assert.ok(re.test('- [ ] **Phase 36: Base**'), 'the parent must match');
    assert.ok(re.test('- [ ] Phase 36.2: Second'), 'a decimal must match');
    assert.strictEqual(
      re.test('- [ ] Phase 360: Far'),
      false,
      'a longer number must not match',
    );
  });
});

describe('phaseCheckboxName', () => {
  test('strips bold markers, suffixes and whitespace', () => {
    assert.strictEqual(phaseCheckboxName('Alpha**'), 'Alpha');
    assert.strictEqual(phaseCheckboxName('  Beta  '), 'Beta');
    assert.strictEqual(
      phaseCheckboxName('Gamma (completed 2026-07-30)'),
      'Gamma',
    );
    assert.strictEqual(phaseCheckboxName('Delta (INSERTED)'), 'Delta');
  });

  test('stops at the closing bold markers', () => {
    assert.strictEqual(
      phaseCheckboxName('Foundation** - Set up project'),
      'Foundation',
    );
    assert.strictEqual(phaseCheckboxName('** Alpha'), 'Alpha');
  });

  test('keeps a trailing parenthetical that is part of the name', () => {
    assert.strictEqual(phaseCheckboxName('Auth (JWT)'), 'Auth (JWT)');
    assert.strictEqual(
      phaseCheckboxName('Security Audit (external review)'),
      'Security Audit (external review)',
    );
  });

  test('cuts the bare form at its separator and drops the roadmap metadata', () => {
    assert.strictEqual(
      phaseCheckboxName('Security Audit (1 plan) — completed 2026-02-01'),
      'Security Audit',
    );
    assert.strictEqual(
      phaseCheckboxName('Foundation (2/2 plans) - completed 2026-02-01'),
      'Foundation',
    );
    assert.strictEqual(
      phaseCheckboxName('Polish (1 plan) (completed 2026-02-01)'),
      'Polish',
    );
    assert.strictEqual(phaseCheckboxName('Hardening ([N] plans)'), 'Hardening');
    assert.strictEqual(phaseCheckboxName('Alpha – a description'), 'Alpha');
    assert.strictEqual(phaseCheckboxName('- Polish'), 'Polish');
  });

  test('returns null for an empty name', () => {
    assert.strictEqual(phaseCheckboxName('**'), null);
  });
});

describe('getMilestonePhaseFilter checkbox forms', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(resolveTmpDir(), 'gsd-core-test-'));
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases'), { recursive: true });
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  for (const form of [
    { label: 'bare', line: '- [ ] Phase 7: Seven' },
    { label: 'bold', line: '- [ ] **Phase 7: Seven**' },
  ]) {
    test(`accepts a checkbox-only phase directory (${form.label})`, () => {
      fs.writeFileSync(
        path.join(tmpDir, '.planning', 'ROADMAP.md'),
        ['# Roadmap', '', '## Roadmap v0.1: Current', '', form.line, '', '### Phase 8: Eight', ''].join(
          '\n',
        ),
      );
      const filter = getMilestonePhaseFilter(tmpDir);
      assert.strictEqual(
        filter('07-seven'),
        true,
        `${form.label} form: the checkbox declares phase 7 in this milestone`,
      );
      assert.strictEqual(filter('08-eight'), true, 'the header declares phase 8');
      assert.strictEqual(filter('09-nine'), false, 'phase 9 is not declared');
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Lock ordering
// ─────────────────────────────────────────────────────────────────────────────
//
// Two locks exist, on ROADMAP.md and on STATE.md, and two commands hold the
// first across the second: phase remove and phase complete both mutate the
// roadmap and then the state. That nesting is safe only while it is one way, so
// the ordering is ROADMAP.md outer, STATE.md inner, everywhere.
//
// What keeps it that way is the require graph rather than discipline: state.cjs
// is below phase.cjs and roadmap.cjs, so nothing inside the STATE.md section can
// reach a roadmap-lock acquisition. These assertions are that direction, so a
// change that adds the reverse edge fails here rather than deadlocking a user's
// project.
//
// The analysis is a call graph over the shipped sources, not a text match. Its
// predecessor searched one file for a literal `withRoadmapLock(` indented under
// a `withStateLock(`, and checked state.cjs's *direct* requires: a roadmap
// acquisition one helper call away was invisible to it, in any file, and so was
// a require edge added through frontmatter.cjs or security.cjs. Both of those
// are the change the guard exists to catch.
//
// Two properties, and the analysis feeding them is exercised on synthetic
// sources below so it cannot pass by finding nothing:
//
//   1. no module that acquires the STATE.md lock may *reach* a module that
//      acquires the ROADMAP.md lock, transitively through requires;
//   2. no state-lock section may call a function that reaches a ROADMAP.md
//      acquisition, however many hops away that acquisition is.
//
// Property 1 excepts a module from itself — phase.cjs takes both, in that order
// — which is what property 2 covers.

describe('lock ordering', () => {
  const BIN_DIR = path.join(__dirname, '..', 'gsd-ng', 'bin');
  const LIB_DIR = path.join(BIN_DIR, 'lib');
  const STATE_LOCK = 'withStateLock';
  const ROADMAP_LOCK = 'withRoadmapLock';

  // Top-level declarations, by name and body. Prettier keeps every shipped
  // source's top-level declaration at column 0 and everything inside it
  // indented, so a chunk runs from its declaration to the next column-0 line
  // that is not a closing bracket — no brace matching, which regex literals
  // like `#{2,4}` would defeat.
  function topLevelFunctions(source) {
    const declaration =
      /^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)|^const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\(|function)/;
    const lines = source.split('\n');
    const chunks = [];
    let current = null;
    for (let i = 0; i < lines.length; i++) {
      const match = lines[i].match(declaration);
      if (match) {
        if (current) chunks.push(current);
        current = { name: match[1] || match[2], line: i + 1, body: [] };
        continue;
      }
      if (!current) continue;
      if (/^\S/.test(lines[i]) && !/^[)}\];]/.test(lines[i])) {
        chunks.push(current);
        current = null;
        continue;
      }
      current.body.push(lines[i]);
    }
    if (current) chunks.push(current);
    return chunks.map((c) => ({ ...c, body: c.body.join('\n') }));
  }

  function calledNames(text) {
    return new Set([...text.matchAll(/\b([A-Za-z_$][\w$]*)\s*\(/g)].map((m) => m[1]));
  }

  function localRequires(source) {
    return [...source.matchAll(/require\('\.\/([\w.-]+\.cjs)'\)/g)].map(
      (m) => m[1],
    );
  }

  /**
   * Lock analysis over a `{ moduleName: source }` map.
   *
   * `reaching` is the fixpoint of function names whose call may end in a
   * ROADMAP.md acquisition. `lockers` are the modules holding such a function,
   * excluding the lock's own definition. `hosts` are the modules that acquire
   * the STATE.md lock.
   */
  function analyseLockOrdering(sources) {
    const names = Object.keys(sources);
    const functions = [];
    for (const name of names) {
      for (const fn of topLevelFunctions(sources[name])) {
        functions.push({ module: name, ...fn, calls: calledNames(fn.body) });
      }
    }

    const reaching = new Set([ROADMAP_LOCK]);
    for (let changed = true; changed; ) {
      changed = false;
      for (const fn of functions) {
        if (reaching.has(fn.name)) continue;
        for (const call of fn.calls) {
          if (reaching.has(call)) {
            reaching.add(fn.name);
            changed = true;
            break;
          }
        }
      }
    }

    // A function whose own name is the lock is its definition, not a caller.
    const acquires = (fn, lock, set) =>
      fn.name !== lock && [...fn.calls].some((call) => set.has(call));
    const lockers = new Set(
      functions
        .filter((fn) => acquires(fn, ROADMAP_LOCK, reaching))
        .map((fn) => fn.module),
    );
    const hosts = new Set(
      functions
        .filter((fn) => acquires(fn, STATE_LOCK, new Set([STATE_LOCK])))
        .map((fn) => fn.module),
    );

    // Property 1: a host's transitive requires hold no other locker.
    const closureViolations = [];
    for (const host of hosts) {
      const parent = new Map([[host, null]]);
      const queue = [host];
      while (queue.length > 0) {
        const module = queue.shift();
        for (const dep of localRequires(sources[module] || '')) {
          if (parent.has(dep) || !(dep in sources)) continue;
          parent.set(dep, module);
          queue.push(dep);
        }
      }
      for (const module of parent.keys()) {
        if (module === host || !lockers.has(module)) continue;
        const chain = [];
        for (let at = module; at !== null; at = parent.get(at)) chain.unshift(at);
        closureViolations.push(chain.join(' -> '));
      }
    }

    // Property 2: no state-lock section calls a function that reaches an
    // acquisition. Indentation stands in for block nesting — a state
    // acquisition opens a region that ends at the first later line indented no
    // further than it — but what is looked for inside is every name in
    // `reaching`, not one literal.
    const nestingViolations = [];
    for (const host of hosts) {
      const lines = sources[host].split('\n');
      let stateIndent = null;
      for (let i = 0; i < lines.length; i++) {
        const indent = lines[i].search(/\S/);
        if (indent === -1) continue;
        if (stateIndent !== null && indent <= stateIndent) stateIndent = null;
        if (lines[i].includes(`${STATE_LOCK}(`)) {
          stateIndent = indent;
          continue;
        }
        if (stateIndent === null) continue;
        for (const call of calledNames(lines[i])) {
          if (reaching.has(call)) {
            nestingViolations.push(`${host}:${i + 1}: ${call}`);
            break;
          }
        }
      }
    }

    return { reaching, lockers, hosts, closureViolations, nestingViolations };
  }

  // Every shipped source that can hold a lock call site, keyed the way its
  // requires name it. The dispatcher is included because it calls the commands
  // that take the roadmap lock, so the reaching set is the real one.
  function shippedSources() {
    const sources = {};
    for (const name of fs.readdirSync(LIB_DIR)) {
      if (name.endsWith('.cjs')) {
        sources[name] = fs.readFileSync(path.join(LIB_DIR, name), 'utf-8');
      }
    }
    sources['gsd-tools.cjs'] = fs.readFileSync(
      path.join(BIN_DIR, 'gsd-tools.cjs'),
      'utf-8',
    );
    return sources;
  }

  test('no STATE.md lock holder can reach a ROADMAP.md lock holder', () => {
    const { closureViolations } = analyseLockOrdering(shippedSources());
    assert.deepStrictEqual(
      closureViolations,
      [],
      'a module that takes the STATE.md lock requires its way to one that takes ' +
        'the ROADMAP.md lock — the order is roadmap outer, state inner, and this ' +
        'edge makes the reverse reachable:\n' +
        closureViolations.join('\n'),
    );
  });

  test('no STATE.md section calls its way to a ROADMAP.md acquisition', () => {
    const { nestingViolations } = analyseLockOrdering(shippedSources());
    assert.deepStrictEqual(
      nestingViolations,
      [],
      'a STATE.md lock section reaches a ROADMAP.md acquisition:\n' +
        nestingViolations.join('\n'),
    );
  });

  // Both assertions above are satisfied by an analysis that finds nothing at
  // all. This is what says it found the real thing.
  test('the analysis sees every lock holder in the shipped sources', () => {
    const { hosts, lockers, reaching } = analyseLockOrdering(shippedSources());
    assert.deepStrictEqual(
      [...hosts].sort(),
      ['milestone.cjs', 'phase.cjs', 'state.cjs', 'verify.cjs'],
      'the modules that acquire the STATE.md lock',
    );
    assert.deepStrictEqual(
      [...lockers].sort(),
      ['gsd-tools.cjs', 'phase.cjs', 'roadmap.cjs'],
      'the modules that acquire the ROADMAP.md lock',
    );
    for (const command of [
      'cmdPhaseAdd',
      'cmdPhaseComplete',
      'cmdPhaseInsert',
      'cmdPhaseRemove',
      'cmdRoadmapUpdatePlanProgress',
    ]) {
      assert.ok(
        reaching.has(command),
        `${command} takes the ROADMAP.md lock and the analysis must know it`,
      );
    }
  });

  test('the analysis flags an acquisition reached through a helper', () => {
    // The shape the indentation match could not see: the section calls a
    // helper, and the helper takes the lock.
    const { nestingViolations } = analyseLockOrdering({
      'state.cjs': ['function withStateLock(cwd, fn) {', '  return fn();', '}'].join(
        '\n',
      ),
      'phase.cjs': [
        "const { withRoadmapLock } = require('./core.cjs');",
        "const { withStateLock } = require('./state.cjs');",
        'function takesRoadmap(cwd) {',
        '  return withRoadmapLock(cwd, () => {});',
        '}',
        'function bad(cwd) {',
        '  return withStateLock(cwd, () => {',
        '    takesRoadmap(cwd);',
        '  });',
        '}',
      ].join('\n'),
      'core.cjs': ['function withRoadmapLock(cwd, fn) {', '  return fn();', '}'].join(
        '\n',
      ),
    });
    assert.deepStrictEqual(nestingViolations, ['phase.cjs:8: takesRoadmap']);
  });

  test('the analysis flags a require edge added two modules away', () => {
    // The shape the direct-require check could not see: state.cjs reaches the
    // roadmap lock through frontmatter.cjs.
    const { closureViolations, nestingViolations } = analyseLockOrdering({
      'state.cjs': [
        "const { helper } = require('./frontmatter.cjs');",
        'function withStateLock(cwd, fn) {',
        '  return fn();',
        '}',
        'function cmdState(cwd) {',
        '  return withStateLock(cwd, () => {',
        '    helper(cwd);',
        '  });',
        '}',
      ].join('\n'),
      'frontmatter.cjs': [
        "const { withRoadmapLock } = require('./roadmap.cjs');",
        'function helper(cwd) {',
        '  return withRoadmapLock(cwd, () => {});',
        '}',
      ].join('\n'),
      'roadmap.cjs': [
        'function withRoadmapLock(cwd, fn) {',
        '  return fn();',
        '}',
      ].join('\n'),
    });
    assert.deepStrictEqual(closureViolations, [
      'state.cjs -> frontmatter.cjs',
    ]);
    assert.deepStrictEqual(nestingViolations, ['state.cjs:7: helper']);
  });

  test('the analysis accepts the supported order', () => {
    const { closureViolations, nestingViolations } = analyseLockOrdering({
      'state.cjs': ['function withStateLock(cwd, fn) {', '  return fn();', '}'].join(
        '\n',
      ),
      'core.cjs': ['function withRoadmapLock(cwd, fn) {', '  return fn();', '}'].join(
        '\n',
      ),
      'phase.cjs': [
        "const { withRoadmapLock } = require('./core.cjs');",
        "const { withStateLock } = require('./state.cjs');",
        'function good(cwd) {',
        '  return withRoadmapLock(cwd, () => {',
        '    withStateLock(cwd, () => {});',
        '  });',
        '}',
        'function alsoGood(cwd) {',
        '  withStateLock(cwd, () => {});',
        '  withRoadmapLock(cwd, () => {});',
        '}',
      ].join('\n'),
    });
    assert.deepStrictEqual(closureViolations, []);
    assert.deepStrictEqual(nestingViolations, []);
  });
});
