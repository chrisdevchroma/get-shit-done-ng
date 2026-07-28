/**
 * GSD Tools Tests - Dispatcher
 *
 * Tests for gsd-tools.cjs dispatch routing and error paths.
 * Covers: no-command, unknown command, unknown subcommands for every command group,
 * --cwd parsing, and previously untouched routing branches.
 *
 * Tests: dispatch routing, unknown commands, --cwd parsing, error paths
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { runGsdTools, createTempProject, cleanup } = require('./helpers.cjs');

// ─── Dispatcher Error Paths ──────────────────────────────────────────────────

describe('dispatcher error paths', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  // No command
  test('no-command invocation prints usage and exits non-zero', () => {
    const result = runGsdTools('', tmpDir);
    assert.strictEqual(result.success, false, 'Should exit non-zero');
    assert.ok(result.error.includes('Usage:'), `Expected "Usage:" in stderr, got: ${result.error}`);
  });

  // Unknown command
  test('unknown command produces clear error and exits non-zero', () => {
    const result = runGsdTools('nonexistent-cmd', tmpDir);
    assert.strictEqual(result.success, false, 'Should exit non-zero');
    assert.ok(result.error.includes('Unknown command'), `Expected "Unknown command" in stderr, got: ${result.error}`);
  });

  // --cwd= form with valid directory
  test('--cwd= form overrides working directory', () => {
    // Create STATE.md in tmpDir so state load can find it
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      '# Project State\n\n## Current Position\n\nPhase: 1 of 1 (Test)\n'
    );
    const result = runGsdTools(`--cwd=${tmpDir} state load`, process.cwd());
    assert.strictEqual(result.success, true, `Should succeed with --cwd=, got: ${result.error}`);
  });

  // --cwd= with empty value
  test('--cwd= with empty value produces error', () => {
    const result = runGsdTools('--cwd= state load', tmpDir);
    assert.strictEqual(result.success, false, 'Should exit non-zero');
    assert.ok(result.error.includes('Missing value for --cwd'), `Expected "Missing value for --cwd" in stderr, got: ${result.error}`);
  });

  // --cwd with nonexistent path
  test('--cwd with invalid path produces error', () => {
    const result = runGsdTools('--cwd /nonexistent/path/xyz state load', tmpDir);
    assert.strictEqual(result.success, false, 'Should exit non-zero');
    assert.ok(result.error.includes('Invalid --cwd'), `Expected "Invalid --cwd" in stderr, got: ${result.error}`);
  });

  // Unknown subcommand: template
  test('template unknown subcommand errors', () => {
    const result = runGsdTools('template bogus', tmpDir);
    assert.strictEqual(result.success, false, 'Should exit non-zero');
    assert.ok(result.error.includes('Unknown template subcommand'), `Expected "Unknown template subcommand" in stderr, got: ${result.error}`);
  });

  // Unknown subcommand: frontmatter
  test('frontmatter unknown subcommand errors', () => {
    const result = runGsdTools('frontmatter bogus file.md', tmpDir);
    assert.strictEqual(result.success, false, 'Should exit non-zero');
    assert.ok(result.error.includes('Unknown frontmatter subcommand'), `Expected "Unknown frontmatter subcommand" in stderr, got: ${result.error}`);
  });

  // Unknown subcommand: verify
  test('verify unknown subcommand errors', () => {
    const result = runGsdTools('verify bogus', tmpDir);
    assert.strictEqual(result.success, false, 'Should exit non-zero');
    assert.ok(result.error.includes('Unknown verify subcommand'), `Expected "Unknown verify subcommand" in stderr, got: ${result.error}`);
  });

  // Unknown subcommand: phases
  test('phases unknown subcommand errors', () => {
    const result = runGsdTools('phases bogus', tmpDir);
    assert.strictEqual(result.success, false, 'Should exit non-zero');
    assert.ok(result.error.includes('Unknown phases subcommand'), `Expected "Unknown phases subcommand" in stderr, got: ${result.error}`);
  });

  // Unknown subcommand: roadmap
  test('roadmap unknown subcommand errors', () => {
    const result = runGsdTools('roadmap bogus', tmpDir);
    assert.strictEqual(result.success, false, 'Should exit non-zero');
    assert.ok(result.error.includes('Unknown roadmap subcommand'), `Expected "Unknown roadmap subcommand" in stderr, got: ${result.error}`);
  });

  // Unknown subcommand: requirements
  test('requirements unknown subcommand errors', () => {
    const result = runGsdTools('requirements bogus', tmpDir);
    assert.strictEqual(result.success, false, 'Should exit non-zero');
    assert.ok(result.error.includes('Unknown requirements subcommand'), `Expected "Unknown requirements subcommand" in stderr, got: ${result.error}`);
  });

  // Unknown subcommand: phase
  test('phase unknown subcommand errors', () => {
    const result = runGsdTools('phase bogus', tmpDir);
    assert.strictEqual(result.success, false, 'Should exit non-zero');
    assert.ok(result.error.includes('Unknown phase subcommand'), `Expected "Unknown phase subcommand" in stderr, got: ${result.error}`);
  });

  // Unknown subcommand: milestone
  test('milestone unknown subcommand errors', () => {
    const result = runGsdTools('milestone bogus', tmpDir);
    assert.strictEqual(result.success, false, 'Should exit non-zero');
    assert.ok(result.error.includes('Unknown milestone subcommand'), `Expected "Unknown milestone subcommand" in stderr, got: ${result.error}`);
  });

  // Unknown subcommand: validate
  test('validate unknown subcommand errors', () => {
    const result = runGsdTools('validate bogus', tmpDir);
    assert.strictEqual(result.success, false, 'Should exit non-zero');
    assert.ok(result.error.includes('Unknown validate subcommand'), `Expected "Unknown validate subcommand" in stderr, got: ${result.error}`);
  });

  // Unknown subcommand: todo
  test('todo unknown subcommand errors', () => {
    const result = runGsdTools('todo bogus', tmpDir);
    assert.strictEqual(result.success, false, 'Should exit non-zero');
    assert.ok(result.error.includes('Unknown todo subcommand'), `Expected "Unknown todo subcommand" in stderr, got: ${result.error}`);
  });

  // Unknown subcommand: init
  test('init unknown workflow errors', () => {
    const result = runGsdTools('init bogus', tmpDir);
    assert.strictEqual(result.success, false, 'Should exit non-zero');
    assert.ok(result.error.includes('Unknown init workflow'), `Expected "Unknown init workflow" in stderr, got: ${result.error}`);
  });
});

// ─── Flag-style argument parsing ─────────────────────────────────────────────

describe('flag-style argument parsing', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('--generate-slug flag style executes generate-slug and emits info hint to stderr', () => {
    const result = runGsdTools(['--generate-slug', 'test feature name'], tmpDir);
    assert.strictEqual(result.success, true, `--generate-slug flag failed: ${result.error}`);
    // The info hint goes to stderr which runGsdTools captures in error field on success
    // We verify the command ran by checking output is a slug string
    assert.ok(result.output.length > 0, `Expected slug output, got empty`);
  });

  test('--generate-slug emits [info] hint to stderr', () => {
    // Use execFileSync directly to capture stderr on success
    const { execFileSync } = require('child_process');
    const path = require('path');
    const TOOLS_PATH = path.join(__dirname, '..', 'gsd-ng', 'bin', 'gsd-tools.cjs');
    let stderr = '';
    try {
      execFileSync(process.execPath, [TOOLS_PATH, '--generate-slug', 'hello world'], {
        cwd: tmpDir,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      stderr = err.stderr || '';
    }
    // Also try capturing stderr on success via a wrapper
    const { spawnSync } = require('child_process');
    const spawnResult = spawnSync(process.execPath, [TOOLS_PATH, '--generate-slug', 'hello world'], {
      cwd: tmpDir,
      encoding: 'utf-8',
    });
    assert.strictEqual(spawnResult.status, 0, `Expected exit 0, got: ${spawnResult.stderr}`);
    assert.ok(
      spawnResult.stderr.includes('[info]') && spawnResult.stderr.includes('--generate-slug'),
      `Expected [info] hint about --generate-slug in stderr, got: ${spawnResult.stderr}`
    );
  });
});

// ─── Typo detection ───────────────────────────────────────────────────────────

describe('typo detection', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('phaes typo suggests phase', () => {
    const result = runGsdTools('phaes', tmpDir);
    assert.strictEqual(result.success, false, 'Typo command should fail');
    assert.ok(
      result.error.includes('Did you mean') && result.error.includes('phase'),
      `Expected "Did you mean: phase" in error, got: ${result.error}`
    );
  });

  test('commt typo suggests commit', () => {
    const result = runGsdTools('commt', tmpDir);
    assert.strictEqual(result.success, false, 'Typo command should fail');
    assert.ok(
      result.error.includes('Did you mean') && result.error.includes('commit'),
      `Expected "Did you mean: commit" in error, got: ${result.error}`
    );
  });

  test('xyznonexistent shows Available commands list', () => {
    const result = runGsdTools('xyznonexistent', tmpDir);
    assert.strictEqual(result.success, false, 'Unknown command should fail');
    assert.ok(
      result.error.includes('Available commands'),
      `Expected "Available commands" in error, got: ${result.error}`
    );
  });
});

// ─── Roadmap add-phase alias ──────────────────────────────────────────────────

describe('roadmap add-phase alias', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
    const fs = require('fs');
    const path = require('path');
    // Create ROADMAP.md needed by phase add
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      '# Roadmap\n\n## Milestone: v1.0 Test\n\n## Progress\n\n| Phase | Plans | Status | Date |\n|-------|-------|--------|------|\n'
    );
    // Create STATE.md needed by phase add
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      '# Project State\n\n## Current Position\n\nPhase: 0 of 0 (none) — Not Started\nPlan: none\nStatus: empty\n\nProgress: [] 0%\n\n## Session Continuity\n\nLast session: 2026-01-01\nStopped at: None\nResume file: None\n\n## Decisions\n\nNone yet.\n'
    );
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('roadmap add-phase redirects to phase add and succeeds', () => {
    const result = runGsdTools(['roadmap', 'add-phase', 'Test Feature Phase'], tmpDir);
    assert.strictEqual(result.success, true, `roadmap add-phase failed: ${result.error}`);
  });
});

// ─── Guard sync-chain command ─────────────────────────────────────────────────

describe('guard sync-chain command', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
    // Create a config.json so setConfigValue has something to write to
    const fs = require('fs');
    const path = require('path');
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'config.json'),
      JSON.stringify({ workflow: { _auto_chain_active: true } }, null, 2)
    );
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('guard sync-chain with --auto flag preserves _auto_chain_active', () => {
    const result = runGsdTools(['guard', 'sync-chain', '--auto --phase 37'], tmpDir);
    assert.strictEqual(result.success, true, `guard sync-chain --auto failed: ${result.error}`);
    const parsed = JSON.parse(result.output);
    assert.strictEqual(parsed.synced, true, 'synced should be true');
    assert.strictEqual(parsed.had_auto, true, 'had_auto should be true when --auto present');
  });

  test('guard sync-chain without --auto clears _auto_chain_active', () => {
    const result = runGsdTools(['guard', 'sync-chain', '--phase 37'], tmpDir);
    assert.strictEqual(result.success, true, `guard sync-chain without --auto failed: ${result.error}`);
    const parsed = JSON.parse(result.output);
    assert.strictEqual(parsed.synced, true, 'synced should be true');
    assert.strictEqual(parsed.had_auto, false, 'had_auto should be false when --auto absent');
    // Verify the config was actually updated
    const fs = require('fs');
    const path = require('path');
    const config = JSON.parse(fs.readFileSync(path.join(tmpDir, '.planning', 'config.json'), 'utf-8'));
    assert.strictEqual(config.workflow._auto_chain_active, false, '_auto_chain_active should be cleared to false');
  });

  test('guard sync-chain with empty args clears _auto_chain_active', () => {
    const result = runGsdTools(['guard', 'sync-chain', ''], tmpDir);
    assert.strictEqual(result.success, true, `guard sync-chain empty failed: ${result.error}`);
    const parsed = JSON.parse(result.output);
    assert.strictEqual(parsed.had_auto, false, 'had_auto should be false for empty args');
  });

  test('guard sync-chain with --auto-advance does NOT treat as --auto', () => {
    const result = runGsdTools(['guard', 'sync-chain', '--auto-advance'], tmpDir);
    assert.strictEqual(result.success, true, `guard sync-chain --auto-advance failed: ${result.error}`);
    const parsed = JSON.parse(result.output);
    assert.strictEqual(parsed.had_auto, false, 'had_auto should be false for --auto-advance (not an exact --auto token)');
  });
});

// ─── Dispatcher Routing Branches ─────────────────────────────────────────────

describe('dispatcher routing branches', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  // find-phase
  test('find-phase locates phase directory by number', () => {
    const phaseDir = path.join(tmpDir, '.planning', 'phases', '01-test-phase');
    fs.mkdirSync(phaseDir, { recursive: true });

    const result = runGsdTools('find-phase 01', tmpDir);
    assert.strictEqual(result.success, true, `find-phase failed: ${result.error}`);
    assert.ok(result.output.includes('01-test-phase'), `Expected output to contain "01-test-phase", got: ${result.output}`);
  });

  // init resume
  test('init resume returns valid JSON', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      '# Project State\n\n## Current Position\n\nPhase: 1 of 1 (Test)\nPlan: 01-01 complete\nStatus: Ready\nLast activity: 2026-01-01\n\nProgress: [##########] 100%\n\n## Session Continuity\n\nLast session: 2026-01-01\nStopped at: Test\nResume file: None\n'
    );

    const result = runGsdTools('init resume', tmpDir);
    assert.strictEqual(result.success, true, `init resume failed: ${result.error}`);
    const parsed = JSON.parse(result.output);
    assert.ok(typeof parsed === 'object', 'Output should be valid JSON object');
  });

  // init verify-work
  test('init verify-work returns valid JSON', () => {
    // Create STATE.md
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      '# Project State\n\n## Current Position\n\nPhase: 1 of 1 (Test)\nPlan: 01-01 complete\nStatus: Ready\nLast activity: 2026-01-01\n\nProgress: [##########] 100%\n\n## Session Continuity\n\nLast session: 2026-01-01\nStopped at: Test\nResume file: None\n'
    );

    // Create ROADMAP.md with phase section
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      '# Roadmap\n\n## Milestone: v1.0 Test\n\n### Phase 1: Test Phase\n**Goal**: Test goal\n**Depends on**: None\n**Requirements**: TEST-01\n**Success Criteria**:\n  1. Tests pass\n**Plans**: 1 plan\nPlans:\n- [x] 01-01-PLAN.md\n\n## Progress\n\n| Phase | Plans | Status | Date |\n|-------|-------|--------|------|\n| 1 | 1/1 | Complete | 2026-01-01 |\n'
    );

    // Create phase dir
    const phaseDir = path.join(tmpDir, '.planning', 'phases', '01-test');
    fs.mkdirSync(phaseDir, { recursive: true });

    const result = runGsdTools('init verify-work 01', tmpDir);
    assert.strictEqual(result.success, true, `init verify-work failed: ${result.error}`);
    const parsed = JSON.parse(result.output);
    assert.ok(typeof parsed === 'object', 'Output should be valid JSON object');
  });

  // roadmap update-plan-progress
  test('roadmap update-plan-progress updates phase progress', () => {
    // Create ROADMAP.md with progress table
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      '# Roadmap\n\n## Milestone: v1.0 Test\n\n### Phase 1: Test Phase\n**Goal**: Test goal\n**Depends on**: None\n**Requirements**: TEST-01\n**Success Criteria**:\n  1. Tests pass\n**Plans**: 1 plan\nPlans:\n- [ ] 01-01-PLAN.md\n\n## Progress\n\n| Phase | Plans | Status | Date |\n|-------|-------|--------|------|\n| 1 | 0/1 | Not Started | - |\n'
    );

    // Create phase dir with PLAN and SUMMARY
    const phaseDir = path.join(tmpDir, '.planning', 'phases', '01-test-phase');
    fs.mkdirSync(phaseDir, { recursive: true });
    fs.writeFileSync(
      path.join(phaseDir, '01-01-PLAN.md'),
      '---\nphase: 01-test-phase\nplan: "01"\n---\n\n# Plan\n'
    );
    fs.writeFileSync(
      path.join(phaseDir, '01-01-SUMMARY.md'),
      '---\nphase: 01-test-phase\nplan: "01"\n---\n\n# Summary\n'
    );

    const result = runGsdTools('roadmap update-plan-progress 1', tmpDir);
    assert.strictEqual(result.success, true, `roadmap update-plan-progress failed: ${result.error}`);
  });

  // state (no subcommand) — default load
  test('state with no subcommand calls cmdStateLoad', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      '# Project State\n\n## Current Position\n\nPhase: 1 of 1 (Test)\nPlan: 01-01 complete\nStatus: Ready\nLast activity: 2026-01-01\n\nProgress: [##########] 100%\n\n## Session Continuity\n\nLast session: 2026-01-01\nStopped at: Test\nResume file: None\n'
    );

    const result = runGsdTools('state', tmpDir);
    assert.strictEqual(result.success, true, `state load failed: ${result.error}`);
    const parsed = JSON.parse(result.output);
    assert.ok(typeof parsed === 'object', 'Output should be valid JSON object');
  });

  // summary-extract
  test('summary-extract parses SUMMARY.md frontmatter', () => {
    const phaseDir = path.join(tmpDir, '.planning', 'phases', '01-test');
    fs.mkdirSync(phaseDir, { recursive: true });

    const summaryContent = `---
phase: 01-test
plan: "01"
subsystem: testing
tags: [node, test]
duration: 5min
completed: "2026-01-01"
key-decisions:
  - "Used node:test"
requirements-completed: [TEST-01]
---

# Phase 1 Plan 01: Test Summary

**Tests added for core module**
`;

    const summaryPath = path.join(phaseDir, '01-01-SUMMARY.md');
    fs.writeFileSync(summaryPath, summaryContent);

    // Use relative path from tmpDir
    const result = runGsdTools(`summary-extract .planning/phases/01-test/01-01-SUMMARY.md`, tmpDir);
    assert.strictEqual(result.success, true, `summary-extract failed: ${result.error}`);
    const parsed = JSON.parse(result.output);
    assert.ok(typeof parsed === 'object', 'Output should be valid JSON object');
    assert.strictEqual(parsed.path, '.planning/phases/01-test/01-01-SUMMARY.md', 'Path should match input');
    assert.deepStrictEqual(parsed.requirements_completed, ['TEST-01'], 'requirements_completed should contain TEST-01');
  });
});

// ─── sync-agents command ──────────────────────────────────────────────────────

describe('sync-agents command', () => {
  let tmpDir;
  const { createTempProjectWithAgents } = require('./helpers.cjs');
  afterEach(() => { if (tmpDir) cleanup(tmpDir); });

  test('EFFSYNC-CLI-01: sync-agents writes effort: frontmatter, prints clean summary on stdout, restart notice on stderr', () => {
    tmpDir = createTempProjectWithAgents(['gsd-planner'], {
      config: { runtime: 'claude', model_profile: 'quality' },
    });
    const result = runGsdTools(['sync-agents'], tmpDir);
    assert.ok(result.success, `command failed: ${result.error}`);
    const planner = fs.readFileSync(path.join(tmpDir, '.claude/agents/gsd-planner.md'), 'utf-8');
    assert.match(planner, /^effort: xhigh$/m);
    // Stdout: clean summary, no restart notice substring
    assert.ok(
      result.output.includes('Synced 1 agent'),
      `expected 'Synced 1 agent' in stdout: ${result.output}`
    );
    assert.ok(
      !result.output.includes('Restart Claude Code'),
      `restart notice should NOT appear in stdout (one-voice consistency): ${result.output}`
    );
    // Stderr: restart notice
    assert.ok(
      result.stderr.includes('Restart Claude Code to apply effort changes.'),
      `restart notice missing from stderr: ${result.stderr}`
    );
  });

  test('EFFSYNC-CLI-02: sync-agents reports "already in sync" on second run, no restart notice on stderr', () => {
    tmpDir = createTempProjectWithAgents(['gsd-planner'], {
      config: { runtime: 'claude', model_profile: 'quality' },
    });
    runGsdTools(['sync-agents'], tmpDir);
    const second = runGsdTools(['sync-agents'], tmpDir);
    assert.ok(second.success);
    assert.ok(
      second.output.includes('already in sync') || second.output.includes('Synced 0'),
      `expected idempotent confirmation: ${second.output}`
    );
    assert.ok(
      !second.stderr.includes('Restart Claude Code'),
      `restart notice should NOT appear on idempotent run: ${second.stderr}`
    );
  });
});

// ─── todo unknown-subcommand error messaging ─────────────────────────────────

describe('todo unknown subcommand error messaging', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('F-SKILL-HINT: todo unknown subcommand error does not redirect to /gsd:add-todo', () => {
    const result = runGsdTools('todo unknown-sub', tmpDir);
    assert.strictEqual(result.success, false, 'Should exit non-zero');
    assert.ok(
      !result.error.includes('/gsd:add-todo'),
      `F-SKILL-HINT: 'todo add' is a real subcommand — the error must not send CLI users to the skill, got: ${result.error}`,
    );
  });

  test('F-SKILL-HINT: todo unknown subcommand still shows Available list', () => {
    const result = runGsdTools('todo unknown-sub', tmpDir);
    assert.strictEqual(result.success, false, 'Should exit non-zero');
    assert.ok(
      result.error.includes('Available:'),
      `Expected "Available:" in stderr, got: ${result.error}`,
    );
  });
});

// ─── did-you-mean namespace scoping ──────────────────────────────────────────

describe('did-you-mean suggestions scoped to current namespace', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('F-DYM-SCOPE: todo typo suggests same-namespace subcommand, not cross-namespace', () => {
    // "compleet" is a typo for "complete" (in todo namespace)
    const result = runGsdTools('todo compleet', tmpDir);
    assert.strictEqual(result.success, false, 'Should exit non-zero');
    // Should suggest "complete" (same-namespace)
    assert.ok(
      result.error.includes('complete'),
      `F-DYM-SCOPE: Expected same-namespace suggestion "complete" in stderr, got: ${result.error}`,
    );
    // Must NOT suggest anything from the phase namespace
    assert.ok(
      !result.error.includes('phase '),
      `F-DYM-SCOPE: Must not suggest cross-namespace "phase ..." in stderr, got: ${result.error}`,
    );
  });

  test('F-DYM-SCOPE: todo add does not suggest phase add', () => {
    // "add" is not in the todo namespace; fuzzy matching against phase namespace must not fire
    const result = runGsdTools('todo add', tmpDir);
    assert.strictEqual(result.success, false, 'Should exit non-zero');
    assert.ok(
      !result.error.includes('phase add'),
      `F-DYM-SCOPE: Must not suggest "phase add" when user types "todo add", got: ${result.error}`,
    );
  });
});
