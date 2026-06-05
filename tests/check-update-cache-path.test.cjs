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
