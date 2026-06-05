'use strict';
// Unit tests for gsd-ng/gsd-ng/bin/lib/cache-path.cjs
// Proves local-before-global cache path precedence for the update-check cache.
// Writer (gsd-check-update.js) and reader (gsd-statusline.js) both use this
// helper so the cache path is derived identically and can never drift.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { createTempProject, cleanup } = require('./helpers.cjs');

const { resolveUpdateCacheFile, resolveUpdateCacheDir, detectConfigDir } =
  require('../gsd-ng/bin/lib/cache-path.cjs');

// Helper: write a VERSION file under <base>/<variant>/gsd-ng/VERSION
function seedInstall(base, variant = '.claude', version = '1.0.0-dev.1') {
  const dir = path.join(base, variant, 'gsd-ng');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'VERSION'), version, 'utf8');
}

// ── Test A: local-only ───────────────────────────────────────────────────────
test('A: local-only install — cache path under <project>/.claude/cache, NOT homeDir', () => {
  const project = createTempProject();
  const home = createTempProject();
  try {
    seedInstall(project, '.claude');
    // no install in home
    const result = resolveUpdateCacheFile({ cwd: project, homeDir: home, env: {} });
    assert.ok(
      result.startsWith(path.join(project, '.claude', 'cache')),
      `Expected cache under project dir, got: ${result}`
    );
    assert.ok(
      !result.startsWith(home),
      `Cache must NOT be under homeDir, got: ${result}`
    );
  } finally {
    cleanup(project);
    cleanup(home);
  }
});

// ── Test B: local wins over global ───────────────────────────────────────────
test('B: local wins when BOTH project and home have .claude/gsd-ng/VERSION', () => {
  const project = createTempProject();
  const home = createTempProject();
  try {
    seedInstall(project, '.claude');
    seedInstall(home, '.claude');
    const result = resolveUpdateCacheFile({ cwd: project, homeDir: home, env: {} });
    assert.ok(
      result.startsWith(path.join(project, '.claude', 'cache')),
      `Expected local cache under project, got: ${result}`
    );
    assert.ok(
      !result.startsWith(home),
      `Cache must NOT be under homeDir when local install present, got: ${result}`
    );
  } finally {
    cleanup(project);
    cleanup(home);
  }
});

// ── Test C: two projects stay isolated ───────────────────────────────────────
test('C: two distinct projects have different cache paths (no shared cache)', () => {
  const projectA = createTempProject();
  const projectB = createTempProject();
  const home = createTempProject();
  try {
    seedInstall(projectA, '.claude');
    seedInstall(projectB, '.claude');
    const pathA = resolveUpdateCacheFile({ cwd: projectA, homeDir: home, env: {} });
    const pathB = resolveUpdateCacheFile({ cwd: projectB, homeDir: home, env: {} });
    assert.notStrictEqual(pathA, pathB, 'Two different projects must produce different cache paths');
    assert.ok(pathA.startsWith(projectA), `pathA should be under projectA, got: ${pathA}`);
    assert.ok(pathB.startsWith(projectB), `pathB should be under projectB, got: ${pathB}`);
  } finally {
    cleanup(projectA);
    cleanup(projectB);
    cleanup(home);
  }
});

// ── Test D: global-only ──────────────────────────────────────────────────────
test('D: global-only install — cache path under <homeDir>/.claude/cache', () => {
  const project = createTempProject();
  const home = createTempProject();
  try {
    // no local install — only global
    seedInstall(home, '.claude');
    const result = resolveUpdateCacheFile({ cwd: project, homeDir: home, env: {} });
    assert.ok(
      result.startsWith(path.join(home, '.claude', 'cache')),
      `Expected cache under home dir, got: ${result}`
    );
  } finally {
    cleanup(project);
    cleanup(home);
  }
});

// ── Test E: env override takes top precedence ────────────────────────────────
test('E: CLAUDE_CONFIG_DIR with VERSION takes top precedence over local project install', () => {
  const project = createTempProject();
  const home = createTempProject();
  const envConfigDir = createTempProject();
  try {
    seedInstall(project, '.claude');         // local install present
    seedInstall(home, '.claude');            // global install present
    // Seed VERSION directly under envConfigDir/gsd-ng/VERSION
    const envGsdDir = path.join(envConfigDir, 'gsd-ng');
    fs.mkdirSync(envGsdDir, { recursive: true });
    fs.writeFileSync(path.join(envGsdDir, 'VERSION'), '2.0.0', 'utf8');

    const result = resolveUpdateCacheFile({
      cwd: project,
      homeDir: home,
      env: { CLAUDE_CONFIG_DIR: envConfigDir },
    });
    assert.ok(
      result.startsWith(path.join(envConfigDir, 'cache')),
      `Expected env override cache, got: ${result}`
    );
    assert.ok(
      !result.startsWith(project),
      `Must not use local project cache when CLAUDE_CONFIG_DIR overrides, got: ${result}`
    );
  } finally {
    cleanup(project);
    cleanup(home);
    cleanup(envConfigDir);
  }
});

// ── Test F: copilot variant honored ─────────────────────────────────────────
test('F: project with .github/gsd-ng/VERSION → cache under <project>/.github/cache', () => {
  const project = createTempProject();
  const home = createTempProject();
  try {
    seedInstall(project, '.github');  // Copilot local variant
    // no .claude install
    const result = resolveUpdateCacheFile({ cwd: project, homeDir: home, env: {} });
    assert.ok(
      result.startsWith(path.join(project, '.github', 'cache')),
      `Expected .github cache dir, got: ${result}`
    );
  } finally {
    cleanup(project);
    cleanup(home);
  }
});

// ── Test G: detectConfigDir env-override branch ──────────────────────────────
// The statusline staleness guard calls detectConfigDir directly, so its
// CLAUDE_CONFIG_DIR branch must resolve independently of resolveUpdateCacheDir.
test('G: detectConfigDir returns CLAUDE_CONFIG_DIR when it holds gsd-ng/VERSION', () => {
  const project = createTempProject();
  const envConfigDir = createTempProject();
  try {
    seedInstall(project, '.claude');  // local install also present
    const envGsdDir = path.join(envConfigDir, 'gsd-ng');
    fs.mkdirSync(envGsdDir, { recursive: true });
    fs.writeFileSync(path.join(envGsdDir, 'VERSION'), '2.0.0', 'utf8');

    const result = detectConfigDir(project, { CLAUDE_CONFIG_DIR: envConfigDir });
    assert.strictEqual(result, envConfigDir, `Expected env dir, got: ${result}`);
  } finally {
    cleanup(project);
    cleanup(envConfigDir);
  }
});

// ── Test H: env argument defaults to process.env ─────────────────────────────
// Both functions fall back to process.env when called without an env argument.
test('H: detectConfigDir / resolveUpdateCacheDir default env to process.env', () => {
  const project = createTempProject();
  const home = createTempProject();
  const saved = process.env.CLAUDE_CONFIG_DIR;
  delete process.env.CLAUDE_CONFIG_DIR;  // neutralize ambient override
  try {
    seedInstall(project, '.claude');
    assert.strictEqual(detectConfigDir(project), path.join(project, '.claude'));
    const dir = resolveUpdateCacheDir({ cwd: project, homeDir: home });
    assert.strictEqual(dir, path.join(project, '.claude', 'cache'));
  } finally {
    if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = saved;
    cleanup(project);
    cleanup(home);
  }
});

// ── Exports shape ────────────────────────────────────────────────────────────
describe('module exports', () => {
  test('resolveUpdateCacheFile is a function', () => {
    assert.strictEqual(typeof resolveUpdateCacheFile, 'function');
  });
  test('resolveUpdateCacheDir is a function', () => {
    assert.strictEqual(typeof resolveUpdateCacheDir, 'function');
  });
  test('detectConfigDir is a function', () => {
    assert.strictEqual(typeof detectConfigDir, 'function');
  });
  test('resolveUpdateCacheFile result ends with gsd-update-check.json', () => {
    const project = createTempProject();
    const home = createTempProject();
    try {
      seedInstall(home, '.claude');
      const result = resolveUpdateCacheFile({ cwd: project, homeDir: home, env: {} });
      assert.ok(result.endsWith('gsd-update-check.json'), `Expected .json suffix, got: ${result}`);
    } finally {
      cleanup(project);
      cleanup(home);
    }
  });
  test('resolveUpdateCacheDir result is parent of resolveUpdateCacheFile result', () => {
    const home = createTempProject();
    try {
      seedInstall(home, '.claude');
      const dir = resolveUpdateCacheDir({ cwd: home, homeDir: home, env: {} });
      const file = resolveUpdateCacheFile({ cwd: home, homeDir: home, env: {} });
      assert.strictEqual(path.dirname(file), dir, 'cacheFile must be inside cacheDir');
    } finally {
      cleanup(home);
    }
  });
});
