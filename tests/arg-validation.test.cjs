/**
 * GSD Tools Tests - Arg Validation
 *
 * Tests for ARG_SCHEMAS registry and validateArgs() pre-dispatch validation.
 * Covers: flag in positional slot, equals syntax, count validation, unknown flags,
 * no-regression tests for valid commands, and schema coverage for all 14 namespaces.
 *
 * Tests: flag in positional slot, equals syntax, count validation, unknown flags, schema coverage
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { runGsdTools, createTempProject, cleanup, TOOLS_PATH } = require('./helpers.cjs');

// ─── Flag in Positional Slot ─────────────────────────────────────────────────

describe('arg validation - flag in positional slot', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('init phase-op --phase 40 rejects with positional arg expected error', () => {
    // --phase 40 where a bare positional is expected: flag-value pair consumes 40,
    // leaving 0 positionals satisfied — "Positional argument expected, got --phase"
    const result = runGsdTools('init phase-op --phase 40', tmpDir);
    assert.strictEqual(result.success, false, 'Should exit non-zero');
    assert.ok(
      result.error.includes('Positional argument expected'),
      `Expected "Positional argument expected" in stderr, got: ${result.error}`
    );
    assert.ok(
      result.error.includes('Usage:'),
      `Expected "Usage:" in stderr, got: ${result.error}`
    );
  });
});

// ─── Equals Syntax ───────────────────────────────────────────────────────────

describe('arg validation - equals syntax', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('init phase-op phase=40 rejects with equals syntax error', () => {
    const result = runGsdTools('init phase-op phase=40', tmpDir);
    assert.strictEqual(result.success, false, 'Should exit non-zero');
    assert.ok(
      result.error.includes('='),
      `Expected "=" in stderr, got: ${result.error}`
    );
    assert.ok(
      result.error.includes("positional args don't use '=' syntax"),
      `Expected "positional args don't use '=' syntax" in stderr, got: ${result.error}`
    );
  });
});

// ─── Count Validation ────────────────────────────────────────────────────────

describe('arg validation - count validation', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('init phase-op (no positional arg) rejects with too few arguments error', () => {
    const result = runGsdTools('init phase-op', tmpDir);
    assert.strictEqual(result.success, false, 'Should exit non-zero');
    assert.ok(
      result.error.includes('Too few arguments'),
      `Expected "Too few arguments" in stderr, got: ${result.error}`
    );
  });

  test('init phase-op 40 extra rejects with too many arguments error', () => {
    const result = runGsdTools('init phase-op 40 extra', tmpDir);
    assert.strictEqual(result.success, false, 'Should exit non-zero');
    assert.ok(
      result.error.includes('Too many arguments'),
      `Expected "Too many arguments" in stderr, got: ${result.error}`
    );
  });
});

// ─── Unknown Flag ────────────────────────────────────────────────────────────

describe('arg validation - unknown flag', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('phases list --nonexistent rejects with unknown flag error', () => {
    // phases list has known flags (--type, --phase, --include-archived)
    // so an unrecognized flag produces "Unknown flag" not "Positional argument expected"
    const result = runGsdTools('phases list --nonexistent', tmpDir);
    assert.strictEqual(result.success, false, 'Should exit non-zero');
    assert.ok(
      result.error.includes('Unknown flag'),
      `Expected "Unknown flag" in stderr, got: ${result.error}`
    );
  });

  test('detect-workspace --bogus rejects with unknown flag error (top-level _self schema)', () => {
    const result = runGsdTools('detect-workspace --bogus', tmpDir);
    assert.strictEqual(result.success, false, 'Should exit non-zero');
    assert.ok(
      result.error.includes('Unknown flag'),
      `Expected "Unknown flag" in stderr, got: ${result.error}`
    );
  });
});

// ─── No Regression ───────────────────────────────────────────────────────────

describe('arg validation - no regression', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('init phase-op 40 still succeeds (valid usage)', () => {
    const result = runGsdTools('init phase-op 40', tmpDir);
    assert.strictEqual(result.success, true, `Should succeed with valid phase arg, got error: ${result.error}`);
  });

  test('state load still succeeds (zero-positional command)', () => {
    // Write a minimal STATE.md for state load to succeed
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      '---\ncurrent_phase: 1\n---\n# Project State\n'
    );
    const result = runGsdTools('state load', tmpDir);
    assert.strictEqual(result.success, true, `Should succeed with state load, got error: ${result.error}`);
  });

  test('detect-workspace --field still succeeds (top-level with known flag)', () => {
    const result = runGsdTools('detect-workspace --field type', tmpDir);
    // detect-workspace should succeed (it detects current workspace)
    assert.strictEqual(result.success, true, `Should succeed with valid flag, got error: ${result.error}`);
  });

  test('roadmap get-phase 44 still succeeds (one positional command)', () => {
    // Write a minimal ROADMAP.md for roadmap get-phase to succeed
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      '# Roadmap\n\n## Phase 44\n\nTest phase.\n'
    );
    const result = runGsdTools('roadmap get-phase 44', tmpDir);
    assert.strictEqual(result.success, true, `Should succeed with roadmap get-phase 44, got error: ${result.error}`);
  });
});

// ─── ARG_SCHEMAS Coverage ────────────────────────────────────────────────────

describe('ARG_SCHEMAS coverage', () => {
  test('ARG_SCHEMAS exists in gsd-tools.cjs source', () => {
    const source = fs.readFileSync(TOOLS_PATH, 'utf-8');
    assert.ok(
      source.includes('const ARG_SCHEMAS'),
      'gsd-tools.cjs should define const ARG_SCHEMAS'
    );
  });

  test('ARG_SCHEMAS contains all 14 compound command namespaces', () => {
    const source = fs.readFileSync(TOOLS_PATH, 'utf-8');
    // Extract the ARG_SCHEMAS object from source by requiring the module
    // We verify by checking key presence in the source text
    const expectedNamespaces = [
      'state', 'template', 'frontmatter', 'verify', 'phases',
      'roadmap', 'requirements', 'phase', 'milestone', 'validate',
      'todo', 'init', 'guard', 'test',
    ];
    // Check that each namespace appears in the ARG_SCHEMAS block
    // (between 'const ARG_SCHEMAS' and 'function validateArgs')
    const schemasStart = source.indexOf('const ARG_SCHEMAS');
    const schemasEnd = source.indexOf('function validateArgs');
    assert.ok(schemasStart !== -1, 'ARG_SCHEMAS should be defined');
    assert.ok(schemasEnd !== -1, 'validateArgs should be defined');
    const schemasBlock = source.slice(schemasStart, schemasEnd);
    for (const ns of expectedNamespaces) {
      assert.ok(
        schemasBlock.includes(`${ns}:`),
        `ARG_SCHEMAS should contain namespace '${ns}', not found in schemas block`
      );
    }
  });

  test('ARG_SCHEMAS contains _self entries for top-level commands', () => {
    const source = fs.readFileSync(TOOLS_PATH, 'utf-8');
    const schemasStart = source.indexOf('const ARG_SCHEMAS');
    const schemasEnd = source.indexOf('function validateArgs');
    assert.ok(schemasStart !== -1 && schemasEnd !== -1, 'ARG_SCHEMAS and validateArgs should exist');
    const schemasBlock = source.slice(schemasStart, schemasEnd);
    // Verify _self entries exist for key top-level commands
    const topLevelCommands = [
      'commit', 'detect-workspace', 'git-context', 'squash',
      'version-bump', 'cleanup', 'update',
    ];
    for (const cmd of topLevelCommands) {
      // Accept both quoted ('commit': ...) and unquoted (commit: ...) key forms.
      // Prettier removes unnecessary quotes from valid JS identifiers, so both are valid.
      const quotedForm = `'${cmd}'`;
      const unquotedForm = new RegExp(`(?:^|[,{\\s])${cmd.replace(/-/g, '\\-')}\\s*:`);
      assert.ok(
        schemasBlock.includes(quotedForm) || unquotedForm.test(schemasBlock),
        `ARG_SCHEMAS should contain top-level command '${cmd}' with _self schema`
      );
    }
    // Verify _self keys exist
    const selfCount = (schemasBlock.match(/_self:/g) || []).length;
    assert.ok(
      selfCount >= 22,
      `Expected at least 22 _self entries in ARG_SCHEMAS, got ${selfCount}`
    );
  });

  test('validateArgs function exists in gsd-tools.cjs source', () => {
    const source = fs.readFileSync(TOOLS_PATH, 'utf-8');
    assert.ok(
      source.includes('function validateArgs'),
      'gsd-tools.cjs should define function validateArgs'
    );
  });

  test('validateArgs called in all compound + top-level command case blocks', () => {
    const source = fs.readFileSync(TOOLS_PATH, 'utf-8');
    // Count call sites: pattern is validateArgs('commandname'
    const callMatches = (source.match(/validateArgs\('[a-z]/g) || []).length;
    assert.ok(
      callMatches >= 36,
      `Expected at least 36 validateArgs call sites (14 compound + 22 top-level), got ${callMatches}`
    );
  });
});
