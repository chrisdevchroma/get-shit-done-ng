'use strict';

/**
 * Unit tests for the shared type-alias resolver (type-alias.cjs).
 */

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { resolveTmpDir, cleanup } = require('./helpers.cjs');
const { DEFAULT_TYPE_ALIASES, resolveTypeAlias, readTypeAliases } = require('../gsd-ng/bin/lib/type-alias.cjs');

describe('DEFAULT_TYPE_ALIASES', () => {
  test('is frozen', () => {
    assert.ok(Object.isFrozen(DEFAULT_TYPE_ALIASES));
  });

  test('deep-equals expected map', () => {
    assert.deepStrictEqual(DEFAULT_TYPE_ALIASES, {
      feat: 'feature',
      fix: 'bugfix',
      chore: 'chore',
      refactor: 'refactor',
    });
  });
});

describe('resolveTypeAlias', () => {
  test("resolveTypeAlias('feat') === 'feature' (default)", () => {
    assert.strictEqual(resolveTypeAlias('feat'), 'feature');
  });

  test("resolveTypeAlias('fix') === 'bugfix' (default)", () => {
    assert.strictEqual(resolveTypeAlias('fix'), 'bugfix');
  });

  test("resolveTypeAlias('docs') === 'docs' (unknown type returns itself)", () => {
    assert.strictEqual(resolveTypeAlias('docs'), 'docs');
  });

  test("resolveTypeAlias('feat', { feat: 'feature-x' }) === 'feature-x' (override layered over defaults)", () => {
    assert.strictEqual(resolveTypeAlias('feat', { feat: 'feature-x' }), 'feature-x');
  });

  test("resolveTypeAlias('fix', { feat: 'feature-x' }) === 'bugfix' (partial override keeps other defaults)", () => {
    assert.strictEqual(resolveTypeAlias('fix', { feat: 'feature-x' }), 'bugfix');
  });
});

describe('readTypeAliases', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(resolveTmpDir(), 'gsd-type-alias-test-'));
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('readTypeAliases(<dir with no config>) === null (no throw)', () => {
    const result = readTypeAliases(tmpDir);
    assert.strictEqual(result, null);
  });

  test('readTypeAliases(<dir with .planning/config.json git.type_aliases>) === that map', () => {
    const planningDir = path.join(tmpDir, '.planning');
    fs.mkdirSync(planningDir, { recursive: true });
    const customAliases = { feat: 'feature-branch', fix: 'hotfix' };
    fs.writeFileSync(
      path.join(planningDir, 'config.json'),
      JSON.stringify({ git: { type_aliases: customAliases } }),
      'utf-8',
    );
    const result = readTypeAliases(tmpDir);
    assert.deepStrictEqual(result, customAliases);
  });

  test('readTypeAliases with config.json lacking git section returns null', () => {
    const planningDir = path.join(tmpDir, '.planning');
    fs.mkdirSync(planningDir, { recursive: true });
    fs.writeFileSync(
      path.join(planningDir, 'config.json'),
      JSON.stringify({ branching_strategy: 'phase' }),
      'utf-8',
    );
    const result = readTypeAliases(tmpDir);
    assert.strictEqual(result, null);
  });
});
