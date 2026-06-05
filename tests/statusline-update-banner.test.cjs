'use strict';
// Tests for renderUpdateBanner in gsd-statusline.js.
// Proves the reader uses the shared cache-path.cjs helper and suppresses the
// banner on cache.installed vs live VERSION mismatch (post-update gap guard).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { createTempProject, cleanup } = require('./helpers.cjs');

const { renderUpdateBanner } = require('../hooks/gsd-statusline.js');

// Helper: write a VERSION file under <base>/<variant>/gsd-ng/VERSION
function seedInstall(base, version, variant = '.claude') {
  const dir = path.join(base, variant, 'gsd-ng');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'VERSION'), version, 'utf8');
}

// Helper: write the update-check cache under <base>/<variant>/cache/gsd-update-check.json
function seedCache(base, data, variant = '.claude') {
  const cacheDir = path.join(base, variant, 'cache');
  fs.mkdirSync(cacheDir, { recursive: true });
  fs.writeFileSync(
    path.join(cacheDir, 'gsd-update-check.json'),
    JSON.stringify(data),
    'utf8',
  );
}

// ── Banner shown ─────────────────────────────────────────────────────────────
test('banner shown: local install, cache {update_available:true, installed matches live VERSION}', () => {
  const project = createTempProject();
  const home = createTempProject();
  try {
    const version = '1.0.0-dev.5';
    seedInstall(project, version);
    seedCache(project, { update_available: true, installed: version, latest: '1.0.0-dev.6' });
    const result = renderUpdateBanner({
      cwd: project,
      homeDir: home,
      env: {},
      fs,
    });
    assert.ok(result.includes('⬆'), `Expected banner with ⬆, got: ${JSON.stringify(result)}`);
    assert.ok(
      result.includes('/gsd:update'),
      `Expected /gsd:update in banner, got: ${JSON.stringify(result)}`,
    );
  } finally {
    cleanup(project);
    cleanup(home);
  }
});

// ── Banner suppressed on VERSION mismatch (post-update gap) ──────────────────
test('banner suppressed: cache.installed mismatches live VERSION', () => {
  const project = createTempProject();
  const home = createTempProject();
  try {
    const liveVersion = '1.0.0-dev.6';
    const cachedInstalled = '1.0.0-dev.5'; // stale — update was installed
    seedInstall(project, liveVersion);
    seedCache(project, {
      update_available: true,
      installed: cachedInstalled,
      latest: '1.0.0-dev.6',
    });
    const result = renderUpdateBanner({
      cwd: project,
      homeDir: home,
      env: {},
      fs,
    });
    assert.strictEqual(result, '', `Banner must be suppressed on version mismatch, got: ${JSON.stringify(result)}`);
  } finally {
    cleanup(project);
    cleanup(home);
  }
});

// ── Banner suppressed when update_available is false ────────────────────────
test('banner suppressed: update_available is false', () => {
  const project = createTempProject();
  const home = createTempProject();
  try {
    const version = '1.0.0-dev.5';
    seedInstall(project, version);
    seedCache(project, { update_available: false, installed: version, latest: version });
    const result = renderUpdateBanner({
      cwd: project,
      homeDir: home,
      env: {},
      fs,
    });
    assert.strictEqual(result, '', `Banner must be empty when update_available is false, got: ${JSON.stringify(result)}`);
  } finally {
    cleanup(project);
    cleanup(home);
  }
});

// ── No cache file → no banner, no crash ─────────────────────────────────────
test('no cache file → returns empty string, no crash', () => {
  const project = createTempProject();
  const home = createTempProject();
  try {
    seedInstall(project, '1.0.0-dev.5');
    // no cache file
    const result = renderUpdateBanner({
      cwd: project,
      homeDir: home,
      env: {},
      fs,
    });
    assert.strictEqual(result, '', `Banner must be empty when no cache exists, got: ${JSON.stringify(result)}`);
  } finally {
    cleanup(project);
    cleanup(home);
  }
});

// ── Reads LOCAL cache, not global ────────────────────────────────────────────
test('reader uses LOCAL cache, not global — different contents, local wins', () => {
  const project = createTempProject();
  const home = createTempProject();
  try {
    const version = '1.0.0-dev.5';
    seedInstall(project, version);
    seedInstall(home, version);
    // Local cache: update_available=true, installed matches
    seedCache(project, { update_available: true, installed: version, latest: '1.0.0-dev.6' });
    // Global cache: update_available=false (different)
    seedCache(home, { update_available: false, installed: version, latest: version });
    const result = renderUpdateBanner({
      cwd: project,
      homeDir: home,
      env: {},
      fs,
    });
    // Reader must use LOCAL cache (update_available=true) → banner shown
    assert.ok(
      result.includes('⬆'),
      `Reader must use local cache (update_available=true), got: ${JSON.stringify(result)}`,
    );
  } finally {
    cleanup(project);
    cleanup(home);
  }
});
