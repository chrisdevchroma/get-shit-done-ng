'use strict';
// Tests that gsd-check-update.js derives its cacheFile from the shared
// cache-path.cjs helper rather than hardcoding path.join(globalConfigDir, 'cache').
// Writer and reader are proved to share a single source of truth.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

// Set GSD_TEST_MODE BEFORE requiring the hook so it exports utilities
// and does NOT execute (no spawn, no stdin, no network).
process.env.GSD_TEST_MODE = '1';
const { buildChildSource } = require('../hooks/gsd-check-update.js');

const HOOK_SRC = fs.readFileSync(
  path.resolve(__dirname, '../hooks/gsd-check-update.js'),
  'utf8',
);

// ── Source-grep tests ────────────────────────────────────────────────────────

test('hook source references cache-path.cjs (uses shared helper, not inline path)', () => {
  assert.ok(
    HOOK_SRC.includes('cache-path.cjs'),
    'hook must require cache-path.cjs — proves it uses the shared helper',
  );
});

test('hook source calls resolveUpdateCacheFile or resolveUpdateCacheDir (from shared helper)', () => {
  assert.ok(
    HOOK_SRC.includes('resolveUpdateCacheFile') || HOOK_SRC.includes('resolveUpdateCacheDir'),
    'hook must call resolveUpdateCacheFile or resolveUpdateCacheDir from cache-path.cjs',
  );
});

test('hook source no longer contains path.join(globalConfigDir, "cache") (old hardcoded path removed)', () => {
  assert.ok(
    !HOOK_SRC.includes("path.join(globalConfigDir, 'cache')"),
    'hook must NOT have the old hardcoded global cache path — it was the bug being fixed',
  );
});

// ── buildChildSource embeds the passed cacheFile ─────────────────────────────

test('buildChildSource embeds the exact cacheFile path passed to it', () => {
  const localCacheFile = '/some/project/.claude/cache/gsd-update-check.json';
  const childSrc = buildChildSource({
    cacheFile: localCacheFile,
    projectVersionFile: '/some/project/.claude/gsd-ng/VERSION',
    globalVersionFile: '/home/user/.claude/gsd-ng/VERSION',
    semverUtilsPath: '/some/path/semver-utils.cjs',
    githubOwner: 'test-owner',
    githubRepo: 'test-repo',
    githubTtl: 3600,
    assetName: 'gsd-ng.tar.gz',
  });
  assert.ok(
    childSrc.includes(JSON.stringify(localCacheFile)),
    `buildChildSource must embed the exact cacheFile as a JSON string; got: ${childSrc.slice(0, 200)}`,
  );
});

test('buildChildSource with a local cache path does not embed the old global path', () => {
  const localCacheFile = '/my/local/project/.claude/cache/gsd-update-check.json';
  const globalCacheFile = '/home/user/.claude/cache/gsd-update-check.json';
  const childSrc = buildChildSource({
    cacheFile: localCacheFile,
    projectVersionFile: '/my/local/project/.claude/gsd-ng/VERSION',
    globalVersionFile: '/home/user/.claude/gsd-ng/VERSION',
    semverUtilsPath: '/some/path/semver-utils.cjs',
    githubOwner: 'test-owner',
    githubRepo: 'test-repo',
    githubTtl: 3600,
    assetName: 'gsd-ng.tar.gz',
  });
  assert.ok(
    !childSrc.includes(JSON.stringify(globalCacheFile)),
    'buildChildSource must NOT embed the old global cache path when local path is passed',
  );
});

// ── Hook detectConfigDir — behavior-preservation tests (primary path) ─────────
// These tests prove the hook's wrapper matches the OLD inline logic across all
// branches. detectConfigDir is exported under GSD_TEST_MODE (Task 2 adds the
// export). Tests are written first (RED) to enforce TDD.

const { createTempProject, cleanup } = require('./helpers.cjs');

// Helper: write a VERSION file under <base>/<variant>/gsd-ng/VERSION
function seedInstall(base, variant = '.claude') {
  const dir = path.join(base, variant, 'gsd-ng');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'VERSION'), '1.0.0', 'utf8');
}

// Destructure detectConfigDir and the test-only seam alongside existing exports.
const { detectConfigDir, _setSharedDetectConfigDir } = require('../hooks/gsd-check-update.js');

test('detectConfigDir export shape: must be a function', () => {
  assert.strictEqual(typeof detectConfigDir, 'function',
    'detectConfigDir must be exported from the hook under GSD_TEST_MODE');
});

test('detectConfigDir (env override): CLAUDE_CONFIG_DIR with VERSION wins over local .claude', () => {
  const base = createTempProject();
  const envDir = createTempProject();
  const saved = process.env.CLAUDE_CONFIG_DIR;
  try {
    seedInstall(base, '.claude');
    // Seed VERSION directly under envDir/gsd-ng/VERSION (not under a variant)
    fs.mkdirSync(path.join(envDir, 'gsd-ng'), { recursive: true });
    fs.writeFileSync(path.join(envDir, 'gsd-ng', 'VERSION'), '2.0.0', 'utf8');
    process.env.CLAUDE_CONFIG_DIR = envDir;
    assert.strictEqual(detectConfigDir(base), envDir,
      'env override must win over local .claude when it holds gsd-ng/VERSION');
  } finally {
    if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = saved;
    cleanup(base);
    cleanup(envDir);
  }
});

test('detectConfigDir (.claude variant): returns join(baseDir, .claude) when only .claude is seeded', () => {
  const base = createTempProject();
  const saved = process.env.CLAUDE_CONFIG_DIR;
  delete process.env.CLAUDE_CONFIG_DIR;
  try {
    seedInstall(base, '.claude');
    assert.strictEqual(detectConfigDir(base), path.join(base, '.claude'),
      'must return baseDir/.claude when that variant has gsd-ng/VERSION');
  } finally {
    if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = saved;
    cleanup(base);
  }
});

test('detectConfigDir (.github variant): returns join(baseDir, .github) when only .github is seeded', () => {
  const base = createTempProject();
  const saved = process.env.CLAUDE_CONFIG_DIR;
  delete process.env.CLAUDE_CONFIG_DIR;
  try {
    seedInstall(base, '.github');
    assert.strictEqual(detectConfigDir(base), path.join(base, '.github'),
      'must return baseDir/.github when that variant has gsd-ng/VERSION');
  } finally {
    if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = saved;
    cleanup(base);
  }
});

test('detectConfigDir (.copilot variant): returns join(baseDir, .copilot) when only .copilot is seeded', () => {
  const base = createTempProject();
  const saved = process.env.CLAUDE_CONFIG_DIR;
  delete process.env.CLAUDE_CONFIG_DIR;
  try {
    seedInstall(base, '.copilot');
    assert.strictEqual(detectConfigDir(base), path.join(base, '.copilot'),
      'must return baseDir/.copilot when that variant has gsd-ng/VERSION');
  } finally {
    if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = saved;
    cleanup(base);
  }
});

test('detectConfigDir (variant order .claude wins): .claude beats .github when both are seeded', () => {
  const base = createTempProject();
  const saved = process.env.CLAUDE_CONFIG_DIR;
  delete process.env.CLAUDE_CONFIG_DIR;
  try {
    seedInstall(base, '.claude');
    seedInstall(base, '.github');
    assert.strictEqual(detectConfigDir(base), path.join(base, '.claude'),
      '.claude must win over .github (proves shared order is honored, not duplicated)');
  } finally {
    if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = saved;
    cleanup(base);
  }
});

test('detectConfigDir (no-match fallback, env set but no VERSION): returns env dir value', () => {
  const base = createTempProject();
  const envDir = createTempProject();
  const saved = process.env.CLAUDE_CONFIG_DIR;
  try {
    // envDir has NO gsd-ng/VERSION; base has no variants seeded
    process.env.CLAUDE_CONFIG_DIR = envDir;
    assert.strictEqual(detectConfigDir(base), envDir,
      'when env dir is set but lacks VERSION and no variant matches, must return env dir (old step 6)');
  } finally {
    if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = saved;
    cleanup(base);
    cleanup(envDir);
  }
});

test('detectConfigDir (no-match fallback, env unset): returns join(baseDir, .claude)', () => {
  const base = createTempProject();
  const saved = process.env.CLAUDE_CONFIG_DIR;
  delete process.env.CLAUDE_CONFIG_DIR;
  try {
    // No env, no variants seeded
    assert.strictEqual(detectConfigDir(base), path.join(base, '.claude'),
      'when no env and no variant matches, must return join(baseDir, .claude) as default');
  } finally {
    if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = saved;
    cleanup(base);
  }
});

// ── Hook detectConfigDir — degraded no-module path test ───────────────────────
// This test pins the degraded contract when the shared module is unavailable.
// Uses the GSD_TEST_MODE-only _setSharedDetectConfigDir seam to simulate the
// no-module condition. The variant array lives ONLY in cache-path.cjs; the
// degraded path must NOT probe .github/.copilot.

test('detectConfigDir (no-module degraded fallback): returns .claude even when only .github is seeded', () => {
  const base = createTempProject();
  const saved = process.env.CLAUDE_CONFIG_DIR;
  delete process.env.CLAUDE_CONFIG_DIR;
  // Capture the real shared fn to restore after the test
  const realSharedFn = _setSharedDetectConfigDir ? null : null; // unused — see restore below
  try {
    // Seed ONLY .github — the OLD inline logic would have returned .github here.
    // The degraded path must NOT probe variants, so it must return .claude instead.
    seedInstall(base, '.github');
    // Simulate shared module unavailable
    _setSharedDetectConfigDir(null);
    assert.strictEqual(detectConfigDir(base), path.join(base, '.claude'),
      'degraded path must return baseDir/.claude (non-probing) even when .github is seeded — ' +
      'variant array must NOT appear outside cache-path.cjs');
    // Also assert env override is honoured on the degraded path
    const envDir = createTempProject();
    try {
      process.env.CLAUDE_CONFIG_DIR = envDir;
      assert.strictEqual(detectConfigDir(base), envDir,
        'degraded path must return CLAUDE_CONFIG_DIR when set, even without VERSION');
    } finally {
      cleanup(envDir);
    }
  } finally {
    // Restore the real shared detectConfigDir so subsequent tests in the process are unaffected
    const realFn = require('../gsd-ng/bin/lib/cache-path.cjs').detectConfigDir;
    _setSharedDetectConfigDir(realFn);
    if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = saved;
    cleanup(base);
  }
});
