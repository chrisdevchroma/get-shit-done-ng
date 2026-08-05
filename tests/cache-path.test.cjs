'use strict';
// Unit tests for gsd-ng/gsd-ng/bin/lib/cache-path.cjs
// Proves local-before-global cache path precedence for the update-check cache.
// Writer (gsd-check-update.js) and reader (gsd-statusline.js) both use this
// helper so the cache path is derived identically and can never drift.
//
// SCOPE: this file requires the module from the source tree, where self-location
// finds no VERSION file and no runtime marker and so returns null. Every
// resolution here therefore exercises the not-installed path, and the precedence
// tests are named for it. An installed engine resolves its own config home
// first, ahead of the override variable and both probes; that ordering is
// asserted from real install trees in tests/runtime-isolation.test.cjs
// (the SELFFIRST tests). The precondition test below pins the null, because if
// it ever stopped holding this whole file would silently start covering the
// other branch without a single name changing.

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

// ── Precondition: the module under test is not installed ─────────────────────
// Asserted directly rather than left implied by the tests that depend on it.
// S1 in the self-location suite below states the same null as part of that
// helper's own contract; this one states it as the precondition of the
// precedence tests that follow, which is what their names now claim.
test('P: the module under test runs from the source tree, so it cannot self-locate', () => {
  const {
    selfLocatedConfigHome,
    selfLocatedRuntime,
  } = require('../gsd-ng/bin/lib/cache-path.cjs');

  const resolved = require.resolve('../gsd-ng/bin/lib/cache-path.cjs');
  assert.strictEqual(
    resolved,
    path.join(__dirname, '..', 'gsd-ng', 'bin', 'lib', 'cache-path.cjs'),
    'these tests must exercise the repository copy, not an installed one',
  );
  assert.strictEqual(
    selfLocatedConfigHome(),
    null,
    'a self-located config home would make every precedence test below cover a different branch',
  );
  assert.strictEqual(selfLocatedRuntime(), null);
});

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
// Not-installed only. An installed global engine resolves its own config home
// and never reaches this probe — see the SELFFIRST tests in runtime-isolation.
test('B: local wins when BOTH project and home have .claude/gsd-ng/VERSION and the engine is not installed (source tree)', () => {
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
// "Top" here means top of the not-installed ordering. An installed engine puts
// its own config home above the override variable.
test('E: CLAUDE_CONFIG_DIR with VERSION beats a local project install when the engine is not installed (source tree)', () => {
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
// Which override variable is honoured depends on the runtime the caller is
// installed under; a caller that is not installed has none to read, and falls
// back to the historical variable this test pins.
test('G: detectConfigDir returns CLAUDE_CONFIG_DIR when it holds gsd-ng/VERSION and the caller is not installed (source tree)', () => {
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

// ── Self-location: the install answers for itself ────────────────────────────
// An installed engine sits at <config home>/gsd-ng/bin/lib, so it can resolve
// its own config home without probing anyone else's. Every other test in this
// file runs the module from the source tree, where that resolution must fail —
// so the null case is asserted first and directly.
describe('self-location', () => {
  const {
    selfLocatedConfigHome,
    selfLocatedRuntime,
  } = require('../gsd-ng/bin/lib/cache-path.cjs');

  const LIB_DIR = path.join(__dirname, '..', 'gsd-ng', 'bin', 'lib');

  /**
   * The base as the copied module will report it. require() resolves symlinks,
   * so __dirname inside the copy is the real path — on macOS the temp root is
   * /var/folders/... symlinked to /private/var/folders/..., and comparing the
   * unresolved base against a self-located home fails there while passing on
   * Linux, where the temp root is not a symlink.
   */
  function realBase(base) {
    return fs.realpathSync(base);
  }

  /**
   * Reproduce an installed layout: the module and the registry it requires,
   * copied under <base>/gsd-ng/bin/lib with the VERSION file and the .runtime
   * marker beside them. require() resolves __dirname against the copy, so the
   * copy answers exactly as an installed engine does.
   */
  function fakeInstall(base, { runtime, version = '1.2.3' }) {
    const destLib = path.join(base, 'gsd-ng', 'bin', 'lib');
    fs.mkdirSync(destLib, { recursive: true });
    for (const name of ['cache-path.cjs', 'template-processor.cjs']) {
      fs.copyFileSync(path.join(LIB_DIR, name), path.join(destLib, name));
    }
    fs.writeFileSync(path.join(base, 'gsd-ng', 'VERSION'), version, 'utf8');
    if (runtime !== null) {
      fs.writeFileSync(path.join(base, 'gsd-ng', '.runtime'), runtime, 'utf8');
    }
    return require(path.join(destLib, 'cache-path.cjs'));
  }

  test('S1: from the source tree there is no config home and no runtime', () => {
    assert.strictEqual(selfLocatedConfigHome(), null);
    assert.strictEqual(selfLocatedRuntime(), null);
  });

  test('S2: from an installed tree the module resolves its own config home', () => {
    const home = createTempProject();
    try {
      const installed = fakeInstall(home, { runtime: 'opencode' });
      assert.strictEqual(installed.selfLocatedConfigHome(), realBase(home));
      assert.strictEqual(installed.selfLocatedRuntime(), 'opencode');
    } finally {
      cleanup(home);
    }
  });

  test('S3: a VERSION file with no marker beside it is not an install', () => {
    const home = createTempProject();
    try {
      const installed = fakeInstall(home, { runtime: null });
      assert.strictEqual(
        installed.selfLocatedConfigHome(),
        null,
        'both files are required, or the source tree would self-locate',
      );
      assert.strictEqual(installed.selfLocatedRuntime(), null);
    } finally {
      cleanup(home);
    }
  });

  test('S4: a marker naming a prototype member is not a runtime', () => {
    const home = createTempProject();
    try {
      const installed = fakeInstall(home, { runtime: 'constructor' });
      assert.strictEqual(
        installed.selfLocatedRuntime(),
        null,
        'the marker must be validated as an own property of the registry',
      );
    } finally {
      cleanup(home);
    }
  });

  test('S5: an install resolves its own cache dir, not a coexisting one', () => {
    const home = createTempProject();
    const project = createTempProject();
    const other = createTempProject();
    try {
      const installed = fakeInstall(home, { runtime: 'opencode' });
      // Every other resolution path points somewhere else: a local install in
      // the working directory, and an override variable holding a third tree.
      seedInstall(project, '.claude');
      seedInstall(other, '.claude');
      const result = installed.resolveUpdateCacheDir({
        cwd: project,
        homeDir: other,
        env: { CLAUDE_CONFIG_DIR: path.join(other, '.claude') },
      });
      assert.strictEqual(result, path.join(realBase(home), 'cache'));
    } finally {
      cleanup(home);
      cleanup(project);
      cleanup(other);
    }
  });

  test("S6: the override variable is the installed runtime's own, not another one", () => {
    const home = createTempProject();
    const project = createTempProject();
    const claudeTree = createTempProject();
    const opencodeTree = createTempProject();
    try {
      const installed = fakeInstall(home, { runtime: 'opencode' });
      seedInstall(claudeTree, '.claude');
      fs.mkdirSync(path.join(opencodeTree, 'gsd-ng'), { recursive: true });
      fs.writeFileSync(
        path.join(opencodeTree, 'gsd-ng', 'VERSION'),
        '3.0.0',
        'utf8',
      );

      assert.strictEqual(
        installed.detectConfigDir(project, {
          CLAUDE_CONFIG_DIR: path.join(claudeTree, '.claude'),
        }),
        null,
        'an override belonging to another runtime must be ignored',
      );
      assert.strictEqual(
        installed.detectConfigDir(project, {
          OPENCODE_CONFIG_DIR: opencodeTree,
        }),
        opencodeTree,
      );
    } finally {
      cleanup(home);
      cleanup(project);
      cleanup(claudeTree);
      cleanup(opencodeTree);
    }
  });

  test('S7: a claude install still honours its own historical override', () => {
    const home = createTempProject();
    const project = createTempProject();
    const claudeTree = createTempProject();
    try {
      const installed = fakeInstall(home, { runtime: 'claude' });
      seedInstall(claudeTree, '.claude');
      assert.strictEqual(
        installed.detectConfigDir(project, {
          CLAUDE_CONFIG_DIR: path.join(claudeTree, '.claude'),
        }),
        path.join(claudeTree, '.claude'),
      );
    } finally {
      cleanup(home);
      cleanup(project);
      cleanup(claudeTree);
    }
  });

  test('S8: both helpers are exported', () => {
    assert.strictEqual(typeof selfLocatedConfigHome, 'function');
    assert.strictEqual(typeof selfLocatedRuntime, 'function');
  });
});

// ── Registry-derived probe list ──────────────────────────────────────────────
describe('config-dir probe list follows the runtime registry', () => {
  const { RUNTIMES } = require('../gsd-ng/bin/lib/template-processor.cjs');
  const { CONFIG_DIR_VARIANTS } = require('../gsd-ng/bin/lib/cache-path.cjs');

  test('D1: an opencode install under the project is found', () => {
    const project = createTempProject();
    const home = createTempProject();
    try {
      seedInstall(project, '.opencode');
      const result = resolveUpdateCacheDir({ cwd: project, homeDir: home, env: {} });
      assert.strictEqual(result, path.join(project, '.opencode', 'cache'));
    } finally {
      cleanup(project);
      cleanup(home);
    }
  });

  // The global home is resolved from each runtime's configHome spec, so an
  // opencode global install lives under the XDG base, never at <home>/.opencode.
  test('D2: an opencode install under the home dir is found', () => {
    const project = createTempProject();
    const home = createTempProject();
    try {
      seedInstall(path.join(home, '.config'), 'opencode');
      const result = resolveUpdateCacheDir({ cwd: project, homeDir: home, env: {} });
      assert.strictEqual(result, path.join(home, '.config', 'opencode', 'cache'));
    } finally {
      cleanup(project);
      cleanup(home);
    }
  });

  test('D3: the existing three variants are still probed, claude first', () => {
    assert.strictEqual(CONFIG_DIR_VARIANTS[0], '.claude');
    for (const variant of ['.claude', '.github', '.copilot']) {
      assert.ok(
        CONFIG_DIR_VARIANTS.includes(variant),
        `${variant} must stay probed or an existing install loses its cache`
      );
    }
  });

  test('D4: the list is exactly the registry-derived set, so a fourth runtime needs no edit here', () => {
    const expected = new Set(['.claude']);
    for (const runtime of Object.values(RUNTIMES)) {
      expected.add(runtime.configHome.localDirName);
      if (runtime.configHome.globalDirName) {
        expected.add(runtime.configHome.globalDirName);
      }
    }
    assert.deepStrictEqual(
      [...CONFIG_DIR_VARIANTS].sort(),
      [...expected].sort(),
      'probe list and registry must move together'
    );
  });

  test('D5: probe order is stable across calls and follows the registry, claude first', () => {
    const { CONFIG_DIR_VARIANTS: again } = require('../gsd-ng/bin/lib/cache-path.cjs');
    assert.deepStrictEqual([...again], [...CONFIG_DIR_VARIANTS]);

    // D4 pins which names are probed; this pins the order they are probed in.
    // Derived from the registry rather than listed, so a runtime added there is
    // covered with no edit here — only a reordering fails.
    const expected = [];
    for (const name of ['.claude'].concat(
      ...Object.keys(RUNTIMES).map((runtime) => [
        RUNTIMES[runtime].configHome.localDirName,
        RUNTIMES[runtime].configHome.globalDirName,
      ])
    )) {
      if (name && !expected.includes(name)) expected.push(name);
    }
    assert.ok(expected.length > 1, 'the registry must contribute more than the claude default');
    assert.deepStrictEqual([...CONFIG_DIR_VARIANTS], expected);
  });
});

// ── Global config homes outside the home dir ─────────────────────────────────
// An opencode global install lives at $OPENCODE_CONFIG_DIR, else
// $XDG_CONFIG_HOME/opencode, else ~/.config/opencode. None of those is
// reachable by joining a config-dir name onto the home dir.
describe('global config home comes from the runtime configHome spec', () => {
  const { globalConfigDirCandidates } = require('../gsd-ng/bin/lib/cache-path.cjs');

  // Seed <base>/gsd-ng/VERSION — base is the config home itself, not a parent.
  function seedConfigHome(base, version = '1.0.0-dev.1') {
    fs.mkdirSync(path.join(base, 'gsd-ng'), { recursive: true });
    fs.writeFileSync(path.join(base, 'gsd-ng', 'VERSION'), version, 'utf8');
  }

  test('E1: OPENCODE_CONFIG_DIR holding an install wins', () => {
    const project = createTempProject();
    const home = createTempProject();
    const configHome = createTempProject();
    try {
      seedConfigHome(configHome);
      const result = resolveUpdateCacheDir({
        cwd: project,
        homeDir: home,
        env: { OPENCODE_CONFIG_DIR: configHome },
      });
      assert.strictEqual(result, path.join(configHome, 'cache'));
    } finally {
      cleanup(project);
      cleanup(home);
      cleanup(configHome);
    }
  });

  test('E2: XDG_CONFIG_HOME/opencode is used when OPENCODE_CONFIG_DIR is unset', () => {
    const project = createTempProject();
    const home = createTempProject();
    const xdg = createTempProject();
    try {
      seedConfigHome(path.join(xdg, 'opencode'));
      const result = resolveUpdateCacheDir({
        cwd: project,
        homeDir: home,
        env: { XDG_CONFIG_HOME: xdg },
      });
      assert.strictEqual(result, path.join(xdg, 'opencode', 'cache'));
    } finally {
      cleanup(project);
      cleanup(home);
      cleanup(xdg);
    }
  });

  test('E3: with both env vars unset the XDG fallback under the home dir is used', () => {
    const project = createTempProject();
    const home = createTempProject();
    try {
      seedConfigHome(path.join(home, '.config', 'opencode'));
      const result = resolveUpdateCacheDir({ cwd: project, homeDir: home, env: {} });
      assert.strictEqual(result, path.join(home, '.config', 'opencode', 'cache'));
    } finally {
      cleanup(project);
      cleanup(home);
    }
  });

  test('E4: an opencode-only install never resolves under the claude config dir', () => {
    const project = createTempProject();
    const home = createTempProject();
    const xdg = createTempProject();
    try {
      // Only opencode is installed — nothing under the home dir at all.
      seedConfigHome(path.join(xdg, 'opencode'));
      const result = resolveUpdateCacheDir({
        cwd: project,
        homeDir: home,
        env: { XDG_CONFIG_HOME: xdg },
      });
      assert.ok(
        !result.split(path.sep).includes('.claude'),
        `cache must not fall back to the claude config dir, got: ${result}`,
      );
      assert.ok(
        !result.startsWith(home),
        `cache must not land under the home dir, got: ${result}`,
      );
      assert.strictEqual(result, path.join(xdg, 'opencode', 'cache'));
    } finally {
      cleanup(project);
      cleanup(home);
      cleanup(xdg);
    }
  });

  test('E5: a claude global install still wins when XDG is set but holds no install', () => {
    const project = createTempProject();
    const home = createTempProject();
    const xdg = createTempProject();
    try {
      seedInstall(home, '.claude');
      const result = resolveUpdateCacheDir({
        cwd: project,
        homeDir: home,
        env: { XDG_CONFIG_HOME: xdg },
      });
      assert.strictEqual(result, path.join(home, '.claude', 'cache'));
    } finally {
      cleanup(project);
      cleanup(home);
      cleanup(xdg);
    }
  });

  test('E6: a local install still beats a global opencode install when the engine is not installed (source tree)', () => {
    const project = createTempProject();
    const home = createTempProject();
    const xdg = createTempProject();
    try {
      seedInstall(project, '.opencode');
      seedConfigHome(path.join(xdg, 'opencode'));
      const result = resolveUpdateCacheDir({
        cwd: project,
        homeDir: home,
        env: { XDG_CONFIG_HOME: xdg },
      });
      assert.strictEqual(result, path.join(project, '.opencode', 'cache'));
    } finally {
      cleanup(project);
      cleanup(home);
      cleanup(xdg);
    }
  });

  test('E7: the candidate list is claude-first and one entry per runtime', () => {
    const { RUNTIMES } = require('../gsd-ng/bin/lib/template-processor.cjs');
    const home = '/home/tester';
    const candidates = globalConfigDirCandidates({}, home);
    assert.strictEqual(candidates[0], path.join(home, '.claude'),
      'an existing claude install must still hit on the first probe');
    assert.strictEqual(candidates.length, Object.keys(RUNTIMES).length,
      'every registered runtime contributes exactly one candidate');
    assert.ok(
      candidates.includes(path.join(home, '.config', 'opencode')),
      `XDG fallback candidate missing from ${JSON.stringify(candidates)}`,
    );
  });

  test('E9: probe order follows the registry, not a name filter', () => {
    const { RUNTIMES } = require('../gsd-ng/bin/lib/template-processor.cjs');
    const home = '/home/tester';
    const first = Object.keys(RUNTIMES)[0];
    const spec = RUNTIMES[first].configHome;
    const candidates = globalConfigDirCandidates({}, home);
    assert.strictEqual(
      candidates[0],
      spec.globalDirName ? path.join(home, spec.globalDirName)
        : path.join(home, spec.xdg.fallback.replace('~/', ''), spec.xdg.suffix),
      'the first candidate must be the first registered runtime, whichever that is'
    );
    assert.strictEqual(candidates.length, Object.keys(RUNTIMES).length,
      'one candidate per registered runtime, no duplicates and no drops');
  });

  test('E8: an override variable with a leading tilde expands against homeDir', () => {
    const home = '/home/tester';
    const candidates = globalConfigDirCandidates({ OPENCODE_CONFIG_DIR: '~/oc' }, home);
    assert.ok(
      candidates.includes(path.join(home, 'oc')),
      `tilde must expand against homeDir, got ${JSON.stringify(candidates)}`,
    );
  });
});

// ── AGREE: every derivation of a runtime's global config dir answers alike ────
// Three call paths ask "where is runtime R's global config directory": the
// installer's absolute resolver, its home-relative form, and the probe list
// this module builds. They now share one derivation, and these tests fail if
// any pair stops agreeing — asserting equality between them rather than against
// fixed strings, because a fixed-string test passes throughout a divergence.
describe('AGREE: global config dir derivations', () => {
  const os = require('os');
  const {
    globalConfigDirFor,
    globalConfigDirCandidates,
  } = require('../gsd-ng/bin/lib/cache-path.cjs');
  const { getGlobalDir, globalHomeRelative } = require('../bin/install.js');
  const { RUNTIMES } = require('../gsd-ng/bin/lib/template-processor.cjs');

  const RUNTIME_NAMES = Object.keys(RUNTIMES);

  // Every variable any registry row can be steered by, derived so a fourth
  // runtime's variable is saved and restored without an edit here.
  const ENV_KEYS = [
    ...new Set(
      Object.values(RUNTIMES)
        .flatMap((rt) => [
          rt.configHome.envVar,
          rt.configHome.xdg && rt.configHome.xdg.varName,
        ])
        .filter(Boolean),
    ),
  ];

  // The resolvers read process.env live, so swap the registry's variables in
  // place and put every one of them back afterwards.
  function withEnv(overrides, fn) {
    const saved = {};
    for (const key of ENV_KEYS) {
      saved[key] = process.env[key];
      if (Object.prototype.hasOwnProperty.call(overrides, key)) {
        process.env[key] = overrides[key];
      } else {
        delete process.env[key];
      }
    }
    try {
      return fn();
    } finally {
      for (const key of ENV_KEYS) {
        if (saved[key] === undefined) delete process.env[key];
        else process.env[key] = saved[key];
      }
    }
  }

  test('AGREE-01: getGlobalDir matches the shared derivation with no override', () => {
    withEnv({}, () => {
      for (const rt of RUNTIME_NAMES) {
        assert.strictEqual(
          getGlobalDir(rt),
          globalConfigDirFor(rt, process.env, os.homedir()),
          `${rt}: the installer's absolute resolver must not diverge from the shared derivation`,
        );
      }
    });
  });

  test("AGREE-02: they still match with the runtime's own override variable set", () => {
    for (const rt of RUNTIME_NAMES) {
      const envVar = RUNTIMES[rt].configHome.envVar;
      if (!envVar) continue;
      const target = path.join(os.homedir(), `gsd-agree-${rt}`);
      withEnv({ [envVar]: target }, () => {
        assert.strictEqual(
          getGlobalDir(rt),
          globalConfigDirFor(rt, process.env, os.homedir()),
          `${rt}: ${envVar} must move both derivations together`,
        );
        assert.strictEqual(getGlobalDir(rt), target, `${rt}: ${envVar} must win`);
      });
    }
  });

  test('AGREE-03: they still match with an XDG base set, for every runtime declaring one', () => {
    let covered = 0;
    for (const rt of RUNTIME_NAMES) {
      const xdg = RUNTIMES[rt].configHome.xdg;
      if (!xdg) continue;
      covered += 1;
      const base = path.join(os.homedir(), 'gsd-agree-xdg');
      withEnv({ [xdg.varName]: base }, () => {
        assert.strictEqual(
          getGlobalDir(rt),
          globalConfigDirFor(rt, process.env, os.homedir()),
          `${rt}: ${xdg.varName} must move both derivations together`,
        );
      });
    }
    assert.ok(covered > 0, 'at least one registry row must declare an xdg block');
  });

  test('AGREE-04: the home-relative form resolves to the same directory', () => {
    const cases = [{}].concat(
      RUNTIME_NAMES.map((rt) => {
        const envVar = RUNTIMES[rt].configHome.envVar;
        return envVar
          ? { [envVar]: path.join(os.homedir(), `gsd-agree-rel-${rt}`) }
          : {};
      }),
    );
    for (const overrides of cases) {
      withEnv(overrides, () => {
        for (const rt of RUNTIME_NAMES) {
          const absolute = globalConfigDirFor(rt, process.env, os.homedir());
          if (!absolute) continue;
          assert.strictEqual(
            path.resolve(os.homedir(), globalHomeRelative(rt)),
            absolute,
            `${rt}: the home-relative form must resolve to the absolute one (env ${JSON.stringify(overrides)})`,
          );
        }
      });
    }
  });

  test('AGREE-05: the probe list carries each runtime derived directory', () => {
    const home = '/home/tester';
    const envs = [
      {},
      { XDG_CONFIG_HOME: '/home/tester/xdg' },
      ...RUNTIME_NAMES.map((rt) => {
        const envVar = RUNTIMES[rt].configHome.envVar;
        return envVar ? { [envVar]: `/home/tester/probe-${rt}` } : {};
      }),
    ];
    for (const env of envs) {
      const candidates = globalConfigDirCandidates(env, home);
      for (const rt of RUNTIME_NAMES) {
        const expected = globalConfigDirFor(rt, env, home);
        if (!expected) continue;
        assert.ok(
          candidates.includes(expected),
          `${rt}: ${expected} missing from ${JSON.stringify(candidates)} (env ${JSON.stringify(env)})`,
        );
      }
    }
  });
});

// ── Seam-driven self-location ────────────────────────────────────────────────
// The fakeInstall tests above prove the real __dirname resolution by copying the
// module into a staged tree and requiring the copy. That exercises the module,
// but the copy lives outside the path glob the coverage run measures, so those
// branches read as unreached on the source file. These tests drive the same
// branches on the source module through the moduleDir seam, which production
// callers never pass.
describe('T: self-location driven through the test seam', () => {
  const {
    selfLocatedConfigHome,
    selfLocatedRuntime,
    globalConfigDirFor,
    resolveUpdateCacheDir,
  } = require('../gsd-ng/bin/lib/cache-path.cjs');

  // Stage <base>/gsd-ng/{VERSION,.runtime} and return the dir a module would sit
  // in three levels below it, without copying any module there.
  function stage(base, { runtime = 'opencode', version = '1.0.0-dev.1' } = {}) {
    const engine = path.join(base, 'gsd-ng');
    fs.mkdirSync(path.join(engine, 'bin', 'lib'), { recursive: true });
    fs.writeFileSync(path.join(engine, 'VERSION'), version, 'utf8');
    if (runtime !== null) {
      fs.writeFileSync(path.join(engine, '.runtime'), runtime, 'utf8');
    }
    return path.join(engine, 'bin', 'lib');
  }

  test('T1: a staged install resolves its own config home and runtime', () => {
    const home = createTempProject();
    try {
      const moduleDir = stage(home, { runtime: 'opencode' });
      assert.strictEqual(selfLocatedConfigHome(moduleDir), home);
      assert.strictEqual(selfLocatedRuntime(moduleDir), 'opencode');
    } finally {
      cleanup(home);
    }
  });

  test('T2: VERSION without a marker beside it is not an install', () => {
    const home = createTempProject();
    try {
      const moduleDir = stage(home, { runtime: null });
      assert.strictEqual(selfLocatedConfigHome(moduleDir), null);
      assert.strictEqual(selfLocatedRuntime(moduleDir), null);
    } finally {
      cleanup(home);
    }
  });

  test('T3: a marker naming a prototype member is not a runtime', () => {
    const home = createTempProject();
    try {
      const moduleDir = stage(home, { runtime: 'constructor' });
      assert.strictEqual(selfLocatedRuntime(moduleDir), null);
    } finally {
      cleanup(home);
    }
  });

  test('T4: an unreadable marker degrades to null rather than throwing', () => {
    const home = createTempProject();
    try {
      const moduleDir = stage(home, { runtime: 'opencode' });
      // Replace the marker with a directory so readFileSync throws EISDIR.
      const marker = path.join(home, 'gsd-ng', '.runtime');
      fs.unlinkSync(marker);
      fs.mkdirSync(marker);
      assert.strictEqual(selfLocatedConfigHome(moduleDir), home);
      assert.strictEqual(selfLocatedRuntime(moduleDir), null);
    } finally {
      cleanup(home);
    }
  });

  test('T5: a staged install resolves its own cache dir ahead of every probe', () => {
    const home = createTempProject();
    const project = createTempProject();
    try {
      const moduleDir = stage(home, { runtime: 'opencode' });
      seedInstall(project, '.claude');
      assert.strictEqual(
        resolveUpdateCacheDir({
          cwd: project,
          homeDir: project,
          env: { CLAUDE_CONFIG_DIR: project },
          moduleDir,
        }),
        path.join(home, 'cache'),
      );
    } finally {
      cleanup(home);
      cleanup(project);
    }
  });

  test('T6: an unknown runtime is rejected by name, not silently defaulted', () => {
    assert.throws(
      () => globalConfigDirFor('zed', {}, '/home/nobody'),
      (err) => err.name === 'UnknownRuntimeError',
    );
    assert.throws(
      () => globalConfigDirFor('constructor', {}, '/home/nobody'),
      (err) => err.name === 'UnknownRuntimeError',
      'a prototype member must not resolve to a runtime',
    );
  });

  test('T7: with no install anywhere the last resort is the majority runtime', () => {
    const empty = createTempProject();
    try {
      assert.strictEqual(
        resolveUpdateCacheDir({ cwd: empty, homeDir: empty, env: {} }),
        path.join(empty, '.claude', 'cache'),
      );
    } finally {
      cleanup(empty);
    }
  });
});
