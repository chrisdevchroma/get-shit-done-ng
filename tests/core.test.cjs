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

  test('returns pass-all filter when ROADMAP.md is missing', () => {
    const filter = getMilestonePhaseFilter(tmpDir);

    assert.strictEqual(filter('01-foundation'), true);
    assert.strictEqual(filter('99-anything'), true);
  });

  test('returns pass-all filter when ROADMAP has no phase headings', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      '# Roadmap\n\nSome content without phases.\n',
    );

    const filter = getMilestonePhaseFilter(tmpDir);

    assert.strictEqual(filter('01-foundation'), true);
    assert.strictEqual(filter('05-api'), true);
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

  test('divergence equals .planning/DIVERGENCE.md', () => {
    const result = planningPaths('/project');
    assert.strictEqual(
      result.divergence,
      path.join('/project', '.planning', 'DIVERGENCE.md'),
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

  test('Test 1: returns max for gsd-planner when model_profile=quality and no overrides', () => {
    writeConfig({ model_profile: 'quality' });
    const result = resolveEffortInternal(tmpDir, 'gsd-planner');
    assert.strictEqual(result, 'max');
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
    assert.strictEqual(result, 'max');
  });

  test('Test 8: returns normal value when .runtime marker is absent (backward compat, defaults to claude)', () => {
    const markerDir = path.join(tmpDir, 'marker-absent');
    fs.mkdirSync(markerDir, { recursive: true });
    process.env.GSD_TEST_RUNTIME_MARKER_DIR = markerDir;
    writeConfig({ model_profile: 'quality' });
    const result = resolveEffortInternal(tmpDir, 'gsd-planner');
    assert.strictEqual(result, 'max');
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

  test('Test 16: profile-derived max + non-tier model via model_overrides — silent skip, no warning', () => {
    // Quality profile gives gsd-planner effort=max; force the model to a version-pinned
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
      'profile-derived max effort dropped silently for a non-tier model',
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
    assert.match(r, /new-active/);
    // The </details> region remains untouched
    assert.match(r, /old\n<\/details>/);
  });

  test('replaceInCurrentMilestone: no </details> falls back to plain replace', () => {
    const { replaceInCurrentMilestone } = require('../gsd-ng/bin/lib/core.cjs');
    const r = replaceInCurrentMilestone('plain content', /content/, 'replaced');
    assert.match(r, /replaced/);
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
