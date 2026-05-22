'use strict';
// Unit tests for GitHub Releases fallback helper functions in gsd-check-update.js
// GitHub fallback for update detection when npm registry is unavailable

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');
const { resolveTmpDir } = require('./helpers.cjs');

// Set GSD_TEST_MODE before requiring the hook so it exports utilities and skips hook execution
process.env.GSD_TEST_MODE = '1';
const {
  compareSemVer,
  normalizeTag,
  isSnapshot,
  parseChannel,
  buildChildSource,
} = require('../hooks/gsd-check-update.js');

// ── semver-utils shared module ────────────────────────────────────────────────

const semverUtils = require('../gsd-ng/bin/lib/semver-utils.cjs');

describe('semver-utils shared module', () => {
  // Module shape
  test('exports all four named functions', () => {
    assert.strictEqual(
      typeof semverUtils.compareSemVer,
      'function',
      'compareSemVer must be exported',
    );
    assert.strictEqual(
      typeof semverUtils.normalizeTag,
      'function',
      'normalizeTag must be exported',
    );
    assert.strictEqual(
      typeof semverUtils.isSnapshot,
      'function',
      'isSnapshot must be exported',
    );
    assert.strictEqual(
      typeof semverUtils.parseChannel,
      'function',
      'parseChannel must be exported',
    );
  });

  // parseChannel
  test("parseChannel: '1.0.0-dev.9' returns 'dev'", () => {
    assert.strictEqual(semverUtils.parseChannel('1.0.0-dev.9'), 'dev');
  });
  test("parseChannel: '1.0.0-rc.1' returns 'rc'", () => {
    assert.strictEqual(semverUtils.parseChannel('1.0.0-rc.1'), 'rc');
  });
  test("parseChannel: '1.0.0-beta.0' returns 'beta'", () => {
    assert.strictEqual(semverUtils.parseChannel('1.0.0-beta.0'), 'beta');
  });
  test("parseChannel: '1.0.0' returns null", () => {
    assert.strictEqual(semverUtils.parseChannel('1.0.0'), null);
  });
  test("parseChannel: '1.0.0+abc' returns null (build metadata is not prerelease)", () => {
    assert.strictEqual(semverUtils.parseChannel('1.0.0+abc'), null);
  });
  test("parseChannel: '1.0.0-dev.9+abc1234' returns 'dev' (strips build metadata first)", () => {
    assert.strictEqual(semverUtils.parseChannel('1.0.0-dev.9+abc1234'), 'dev');
  });

  // parseChannel — charset guard
  test('parseChannel: command-substitution payload returns null (not the metacharacters)', () => {
    assert.strictEqual(
      semverUtils.parseChannel('1.0.0-x$(touch /tmp/pwned)y'),
      null,
    );
  });
  test('parseChannel: semicolon/space payload returns null', () => {
    assert.strictEqual(semverUtils.parseChannel('1.0.0-a;rm /'), null);
  });
  test('parseChannel: backtick payload returns null', () => {
    assert.strictEqual(semverUtils.parseChannel('1.0.0-`id`'), null);
  });
  test("parseChannel: purely-numeric prerelease ('1.0.0-1') returns null (not a dist-tag)", () => {
    assert.strictEqual(semverUtils.parseChannel('1.0.0-1'), null);
  });
  test("parseChannel: 'canary2' (letter-led alphanumeric) is accepted", () => {
    assert.strictEqual(semverUtils.parseChannel('1.0.0-canary2.3'), 'canary2');
  });

  // selectLatestForChannel
  test('selectLatestForChannel: picks highest §11 version on the channel', () => {
    const tags = ['1.0.0-dev.3', '1.0.0-dev.10', '1.0.0-dev.9'];
    assert.strictEqual(
      semverUtils.selectLatestForChannel(tags, 'dev'),
      '1.0.0-dev.10',
    );
  });
  test('selectLatestForChannel: exact channel match — never cross-matches a longer channel', () => {
    const tags = ['1.0.0-dev.1', '1.0.0-devnext.5'];
    assert.strictEqual(
      semverUtils.selectLatestForChannel(tags, 'dev'),
      '1.0.0-dev.1',
    );
  });
  test('selectLatestForChannel: ignores stable and other-channel tags', () => {
    const tags = ['1.0.0', '1.0.0-rc.1', '0.9.0-dev.2', '1.0.0-dev.4'];
    assert.strictEqual(
      semverUtils.selectLatestForChannel(tags, 'dev'),
      '1.0.0-dev.4',
    );
  });
  test('selectLatestForChannel: returns null when no tag matches the channel', () => {
    assert.strictEqual(
      semverUtils.selectLatestForChannel(['1.0.0', '1.0.0-rc.1'], 'dev'),
      null,
    );
  });
  test('selectLatestForChannel: returns null for empty array, missing channel, or non-array', () => {
    assert.strictEqual(semverUtils.selectLatestForChannel([], 'dev'), null);
    assert.strictEqual(
      semverUtils.selectLatestForChannel(['1.0.0-dev.1'], null),
      null,
    );
    assert.strictEqual(semverUtils.selectLatestForChannel(null, 'dev'), null);
  });
  test('selectLatestForChannel: skips garbage entries that are not semver', () => {
    const tags = ['', 'not-a-version', '1.0.0-dev.2'];
    assert.strictEqual(
      semverUtils.selectLatestForChannel(tags, 'dev'),
      '1.0.0-dev.2',
    );
  });

  // compareSemVer §11 — mirror A1-A9 from commands.test.cjs
  test('compareSemVer §11: 1.0.0-dev.7 < 1.0.0-dev.8', () => {
    assert.ok(semverUtils.compareSemVer('1.0.0-dev.7', '1.0.0-dev.8') < 0);
  });
  test('compareSemVer §11: equal prerelease returns 0', () => {
    assert.strictEqual(
      semverUtils.compareSemVer('1.0.0-dev.9', '1.0.0-dev.9'),
      0,
    );
  });
  test('compareSemVer §11: release > prerelease', () => {
    assert.ok(semverUtils.compareSemVer('1.0.0', '1.0.0-dev.9') > 0);
  });
  test('compareSemVer §11: fewer prerelease ids < more ids', () => {
    assert.ok(semverUtils.compareSemVer('1.0.0-dev', '1.0.0-dev.1') < 0);
  });
  test('compareSemVer §11: numeric < alphanumeric identifier', () => {
    assert.ok(semverUtils.compareSemVer('1.0.0-1', '1.0.0-alpha') < 0);
  });
  test('compareSemVer §11: alphanumeric > numeric identifier (symmetric)', () => {
    assert.ok(semverUtils.compareSemVer('1.0.0-alpha', '1.0.0-1') > 0);
  });
  test('compareSemVer §11: +build metadata ignored', () => {
    assert.strictEqual(semverUtils.compareSemVer('1.0.0+abc', '1.0.0'), 0);
  });
  test('compareSemVer §11: plain semver regression 1.0.0 > 0.9.9', () => {
    assert.ok(semverUtils.compareSemVer('1.0.0', '0.9.9') > 0);
  });
  test('compareSemVer §11: plain semver regression 1.0.0 < 1.0.1', () => {
    assert.ok(semverUtils.compareSemVer('1.0.0', '1.0.1') < 0);
  });
  test('compareSemVer §11: plain semver regression 1.2.3 === 1.2.3', () => {
    assert.strictEqual(semverUtils.compareSemVer('1.2.3', '1.2.3'), 0);
  });
  test('compareSemVer §11: v-prefix stripped (v1.0.0 vs 1.0.0)', () => {
    assert.strictEqual(semverUtils.compareSemVer('v1.0.0', '1.0.0'), 0);
  });
  test('compareSemVer §11: 1.0.0+abc === 1.0.0', () => {
    assert.strictEqual(semverUtils.compareSemVer('1.0.0+abc', '1.0.0'), 0);
  });

  // normalizeTag
  test("normalizeTag: 'v1.0.0' → '1.0.0'", () => {
    assert.strictEqual(semverUtils.normalizeTag('v1.0.0'), '1.0.0');
  });
  test("normalizeTag: '1.0.0' → '1.0.0'", () => {
    assert.strictEqual(semverUtils.normalizeTag('1.0.0'), '1.0.0');
  });
  test("normalizeTag: 'v2.3.1-dev.7' → '2.3.1-dev.7'", () => {
    assert.strictEqual(semverUtils.normalizeTag('v2.3.1-dev.7'), '2.3.1-dev.7');
  });

  // isSnapshot
  test("isSnapshot: '1.0.0+abc' → true", () => {
    assert.strictEqual(semverUtils.isSnapshot('1.0.0+abc'), true);
  });
  test("isSnapshot: '1.0.0' → false", () => {
    assert.strictEqual(semverUtils.isSnapshot('1.0.0'), false);
  });
  test("isSnapshot: '1.0.0-dev.9' → false (prerelease dash is not a snapshot)", () => {
    assert.strictEqual(semverUtils.isSnapshot('1.0.0-dev.9'), false);
  });

  // commands.cjs sanity: compareSemVer is still exported and behaves identically
  test('commands.cjs: compareSemVer re-exported from semver-utils, contract unchanged', () => {
    const {
      compareSemVer: cmdCompare,
    } = require('../gsd-ng/bin/lib/commands.cjs');
    assert.strictEqual(typeof cmdCompare, 'function');
    assert.strictEqual(cmdCompare('1.0.0-dev.9', '1.0.0-dev.9'), 0);
    assert.ok(cmdCompare('1.0.0-dev.3', '1.0.0-dev.9') < 0);
    assert.ok(cmdCompare('1.0.0', '1.0.0-dev.9') > 0);
  });
});

// ── compareSemVer ─────────────────────────────────────────────────────────────

test('compareSemVer: 1.9.0 < 1.10.0 (minor version numeric comparison)', () => {
  const result = compareSemVer('1.9.0', '1.10.0');
  assert.ok(
    result < 0,
    `expected compareSemVer('1.9.0', '1.10.0') < 0, got ${result}`,
  );
});

test('compareSemVer: 2.0.0 > 1.9.9 (major version increment)', () => {
  const result = compareSemVer('2.0.0', '1.9.9');
  assert.ok(
    result > 0,
    `expected compareSemVer('2.0.0', '1.9.9') > 0, got ${result}`,
  );
});

test('compareSemVer: 1.0.0 === 1.0.0 (equal versions)', () => {
  const result = compareSemVer('1.0.0', '1.0.0');
  assert.strictEqual(
    result,
    0,
    `expected compareSemVer('1.0.0', '1.0.0') === 0, got ${result}`,
  );
});

test('compareSemVer: 0.0.1 < 0.0.2 (patch version increment)', () => {
  const result = compareSemVer('0.0.1', '0.0.2');
  assert.ok(
    result < 0,
    `expected compareSemVer('0.0.1', '0.0.2') < 0, got ${result}`,
  );
});

test('compareSemVer: strips +build metadata before comparing', () => {
  // 1.0.0+abc should equal 1.0.0 for version comparison purposes
  const result = compareSemVer('1.0.0+abc1234', '1.0.0');
  assert.strictEqual(
    result,
    0,
    `expected compareSemVer('1.0.0+abc1234', '1.0.0') === 0, got ${result}`,
  );
});

// ── normalizeTag ──────────────────────────────────────────────────────────────

test('normalizeTag: strips v prefix from GitHub tag', () => {
  const result = normalizeTag('v1.0.0');
  assert.strictEqual(
    result,
    '1.0.0',
    `expected normalizeTag('v1.0.0') === '1.0.0', got ${result}`,
  );
});

test('normalizeTag: leaves plain semver unchanged', () => {
  const result = normalizeTag('1.0.0');
  assert.strictEqual(
    result,
    '1.0.0',
    `expected normalizeTag('1.0.0') === '1.0.0', got ${result}`,
  );
});

test('normalizeTag: strips v from pre-release tag', () => {
  const result = normalizeTag('v2.3.1');
  assert.strictEqual(
    result,
    '2.3.1',
    `expected normalizeTag('v2.3.1') === '2.3.1', got ${result}`,
  );
});

// ── isSnapshot ────────────────────────────────────────────────────────────────

test('isSnapshot: detects + build metadata in version', () => {
  const result = isSnapshot('1.0.0+abc1234');
  assert.strictEqual(
    result,
    true,
    `expected isSnapshot('1.0.0+abc1234') === true, got ${result}`,
  );
});

test('isSnapshot: returns false for clean semver version', () => {
  const result = isSnapshot('1.0.0');
  assert.strictEqual(
    result,
    false,
    `expected isSnapshot('1.0.0') === false, got ${result}`,
  );
});

test('isSnapshot: returns false for version with pre-release dash (not a snapshot)', () => {
  const result = isSnapshot('1.0.0-beta.1');
  assert.strictEqual(
    result,
    false,
    `expected isSnapshot('1.0.0-beta.1') === false, got ${result}`,
  );
});

// ── all-unit-tests anchor ───────────────────────────────────────────────────────────

test('AGENT-01: all GitHub fallback unit tests present (anchor)', () => {
  // This is a structural anchor test for CI grep — confirms the full
  // unit test suite is present: SemVer comparison, tag normalization, snapshot skip.
  // When gsd-check-update.js exports these functions (Task 2), all preceding tests
  // in this file will be GREEN.
  assert.ok(
    typeof compareSemVer === 'function',
    'compareSemVer must be exported from gsd-check-update.js via GSD_TEST_MODE',
  );
  assert.ok(
    typeof normalizeTag === 'function',
    'normalizeTag must be exported from gsd-check-update.js via GSD_TEST_MODE',
  );
  assert.ok(
    typeof isSnapshot === 'function',
    'isSnapshot must be exported from gsd-check-update.js via GSD_TEST_MODE',
  );
});

// ── gsd-check-update.js — prerelease channel handling (H1-H8) ──────────────────

describe('gsd-check-update.js — prerelease channel handling', () => {
  // Resolve semverUtilsPath used by the hook (source layout)
  const semverUtilsAbsPath = path.resolve(
    __dirname,
    '../gsd-ng/bin/lib/semver-utils.cjs',
  );

  // H1: parent-scope compareSemVer is §11-compliant — no more NaN on prereleases
  test('H1: parent-scope compareSemVer(1.0.0-dev.9, 1.0.0-dev.9) === 0 (not NaN)', () => {
    const result = compareSemVer('1.0.0-dev.9', '1.0.0-dev.9');
    assert.strictEqual(result, 0);
    assert.ok(!Number.isNaN(result), 'must not be NaN');
  });

  // H2: parent-scope §11 ordering
  test('H2: parent-scope compareSemVer(1.0.0-dev.3, 1.0.0-dev.9) < 0', () => {
    assert.ok(compareSemVer('1.0.0-dev.3', '1.0.0-dev.9') < 0);
  });

  // H3: parent-scope parseChannel is exported and correct
  test("H3: parent-scope parseChannel('1.0.0-dev.9') === 'dev'", () => {
    assert.strictEqual(parseChannel('1.0.0-dev.9'), 'dev');
  });

  // H4: buildChildSource output contains channel-pinned npm view for prerelease installs
  test('H4: buildChildSource returns source with npm view gsd-ng dist-tags.<channel> for prerelease', () => {
    const src = buildChildSource({
      cacheFile: '/tmp/gsd-test-cache.json',
      projectVersionFile: '/tmp/gsd-proj-version',
      globalVersionFile: '/tmp/gsd-global-version',
      semverUtilsPath: semverUtilsAbsPath,
      githubOwner: 'chrisdevchroma',
      githubRepo: 'gsd-ng',
      githubTtl: 3600,
      assetName: 'gsd-ng.tar.gz',
    });
    assert.ok(
      src.includes('npm view gsd-ng dist-tags.'),
      'child source must contain npm view gsd-ng dist-tags.<channel>',
    );
  });

  // H5: buildChildSource branches on installedChannel for GitHub path
  test('H5: buildChildSource contains /releases?per_page=100 (prerelease path) and /releases/latest (stable path)', () => {
    const src = buildChildSource({
      cacheFile: '/tmp/gsd-test-cache.json',
      projectVersionFile: '/tmp/gsd-proj-version',
      globalVersionFile: '/tmp/gsd-global-version',
      semverUtilsPath: semverUtilsAbsPath,
      githubOwner: 'chrisdevchroma',
      githubRepo: 'gsd-ng',
      githubTtl: 3600,
      assetName: 'gsd-ng.tar.gz',
    });
    assert.ok(
      src.includes('/releases?per_page=100'),
      'child source must contain paginated releases path for prerelease channel users',
    );
    assert.ok(
      src.includes('/releases/latest'),
      'child source must contain /releases/latest for stable users',
    );
    assert.ok(
      src.includes('r.prerelease'),
      'child source must contain r.prerelease early-exit for stable path',
    );
  });

  test('H5b: child source delegates to selectLatestForChannel and has no inline indexOf channel filter', () => {
    const src = buildChildSource({
      cacheFile: '/tmp/gsd-test-cache.json',
      projectVersionFile: '/tmp/gsd-proj-version',
      globalVersionFile: '/tmp/gsd-global-version',
      semverUtilsPath: semverUtilsAbsPath,
      githubOwner: 'chrisdevchroma',
      githubRepo: 'gsd-ng',
      githubTtl: 3600,
      assetName: 'gsd-ng.tar.gz',
    });
    assert.ok(
      src.includes('selectLatestForChannel(tags, installedChannel)'),
      'child source must select the channel tag via selectLatestForChannel',
    );
    assert.ok(
      !src.includes("indexOf('-' + channel)"),
      'inline substring channel filter must be removed',
    );
  });

  // H6: end-to-end — prerelease user on dev.9, npm stub returns dev=dev.9, assert no update
  test('H6: end-to-end prerelease: installed=1.0.0-dev.9, npm dist-tags.dev=1.0.0-dev.9 → update_available=false', () => {
    const tmpDir = fs.mkdtempSync(path.join(resolveTmpDir(), 'gsd-h6-'));
    const tmpCache = path.join(tmpDir, 'cache.json');
    const tmpVersion = path.join(tmpDir, 'VERSION');
    // Stub: returns dist-tags.dev=1.0.0-dev.9, version=1.0.0-dev.3
    const stubPath = path.join(tmpDir, 'npm-stub.cjs');
    fs.writeFileSync(
      stubPath,
      `'use strict';
module.exports = function(cmd) {
  if (cmd.includes('dist-tags.dev')) return '1.0.0-dev.9';
  return '1.0.0-dev.3';
};`,
    );
    fs.writeFileSync(tmpVersion, '1.0.0-dev.9');

    const src = buildChildSource({
      cacheFile: tmpCache,
      projectVersionFile: tmpVersion,
      globalVersionFile: '/nonexistent-global',
      semverUtilsPath: semverUtilsAbsPath,
      githubOwner: 'chrisdevchroma',
      githubRepo: 'gsd-ng',
      githubTtl: 3600,
      assetName: 'gsd-ng.tar.gz',
    });

    const result = spawnSync(process.execPath, ['-e', src], {
      env: { ...process.env, GSD_TEST_EXEC_NPMVIEW: stubPath },
      timeout: 10000,
    });

    assert.strictEqual(
      result.status,
      0,
      `child exited with ${result.status}: ${result.stderr}`,
    );
    const cache = JSON.parse(fs.readFileSync(tmpCache, 'utf8'));
    assert.strictEqual(
      cache.update_available,
      false,
      'update_available must be false',
    );
    assert.strictEqual(
      cache.latest,
      '1.0.0-dev.9',
      'latest must be 1.0.0-dev.9',
    );
    assert.strictEqual(
      cache.installed,
      '1.0.0-dev.9',
      'installed must be 1.0.0-dev.9',
    );
  });

  // H7: regression — stable user, npm returns 1.0.1, assert update_available=true, no dist-tags call used
  test('H7: regression stable: installed=1.0.0, npm version=1.0.1 → update_available=true, no dist-tags call', () => {
    const tmpDir = fs.mkdtempSync(path.join(resolveTmpDir(), 'gsd-h7-'));
    const tmpCache = path.join(tmpDir, 'cache.json');
    const tmpVersion = path.join(tmpDir, 'VERSION');
    // Track which commands were called
    const stubPath = path.join(tmpDir, 'npm-stub.cjs');
    const calledPath = path.join(tmpDir, 'called.json');
    fs.writeFileSync(
      stubPath,
      `'use strict';
const fs = require('fs');
module.exports = function(cmd) {
  const called = (() => { try { return JSON.parse(fs.readFileSync(${JSON.stringify(calledPath)}, 'utf8')); } catch(e) { return []; } })();
  called.push(cmd);
  fs.writeFileSync(${JSON.stringify(calledPath)}, JSON.stringify(called));
  if (cmd.includes('dist-tags')) return ''; // should not be called
  return '1.0.1';
};`,
    );
    fs.writeFileSync(tmpVersion, '1.0.0');

    const src = buildChildSource({
      cacheFile: tmpCache,
      projectVersionFile: tmpVersion,
      globalVersionFile: '/nonexistent-global',
      semverUtilsPath: semverUtilsAbsPath,
      githubOwner: 'chrisdevchroma',
      githubRepo: 'gsd-ng',
      githubTtl: 3600,
      assetName: 'gsd-ng.tar.gz',
    });

    const result = spawnSync(process.execPath, ['-e', src], {
      env: { ...process.env, GSD_TEST_EXEC_NPMVIEW: stubPath },
      timeout: 10000,
    });

    assert.strictEqual(
      result.status,
      0,
      `child exited with ${result.status}: ${result.stderr}`,
    );
    const cache = JSON.parse(fs.readFileSync(tmpCache, 'utf8'));
    assert.strictEqual(
      cache.update_available,
      true,
      'update_available must be true',
    );
    assert.strictEqual(cache.latest, '1.0.1');
    // Verify no dist-tags call was made
    const called = JSON.parse(fs.readFileSync(calledPath, 'utf8'));
    assert.ok(
      called.every((cmd) => !cmd.includes('dist-tags')),
      `stable user must not call dist-tags; called: ${JSON.stringify(called)}`,
    );
  });

  // H8: no inline compareSemVer in the hook (factoring path taken)
  test('H8: hooks/gsd-check-update.js has 0 inline function compareSemVer declarations', () => {
    const hookSrc = fs.readFileSync(
      path.resolve(__dirname, '../hooks/gsd-check-update.js'),
      'utf8',
    );
    const matches = hookSrc.match(/function compareSemVer/g) || [];
    assert.strictEqual(
      matches.length,
      0,
      'factoring path taken: no inline compareSemVer in the hook file',
    );
  });
});
