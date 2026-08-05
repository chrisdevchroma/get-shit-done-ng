'use strict';

/**
 * Spawning the real installer, shared by every test that needs an install tree.
 *
 * Two variants, and the difference between them is load-bearing:
 *
 *   - `runInstall` puts HOME and the working directory in the same place, which
 *     is what the install-tree capture wants: one directory to normalise out of the
 *     hashed bytes.
 *   - `runIsolatedInstall` keeps them apart. A path written as project-relative
 *     and a path written as home-relative resolve to the same place under the
 *     first variant, so an assertion that a shipped path exists cannot fail
 *     there no matter how wrong the path is. Anything checking the *contents*
 *     of an install has to use this one.
 *
 * Not named `*.test.cjs`, so the runner does not pick it up as a test file.
 */

const assert = require('node:assert/strict');
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const { RUNTIMES } = require('../gsd-ng/bin/lib/template-processor.cjs');

const INSTALLER = path.resolve(__dirname, '..', 'bin', 'install.js');

/**
 * Where each runtime lands when the installer is pointed at a temp dir by env
 * var. A map rather than a chain of runtime-name comparisons, so a fourth
 * runtime is one row and no branch.
 */
const TARGET_DIR_NAMES = {
  claude: { global: 'cfg-claude', local: '.claude' },
  copilot: { global: 'cfg-copilot', local: '.github' },
  opencode: { global: 'cfg-opencode', local: '.opencode' },
};

function targetDirFor(tmpDir, runtime, scope) {
  const names = TARGET_DIR_NAMES[runtime] || TARGET_DIR_NAMES.claude;
  return path.join(tmpDir, scope === 'global' ? names.global : names.local);
}

function installerArgs(runtime, scope) {
  return [
    INSTALLER,
    '--runtime',
    runtime,
    scope === 'global' ? '--global' : '--local',
    '--no-seed-permissions-config',
    '--no-seed-sandbox-config',
  ];
}

function assertInstalled(result, runtime, scope, targetDir) {
  assert.equal(
    result.status,
    0,
    `installer must exit 0 for ${runtime} ${scope}\nstderr: ${result.stderr || ''}\nstdout: ${result.stdout || ''}`,
  );
  assert.ok(fs.existsSync(targetDir), `install target must exist: ${targetDir}`);
}

/**
 * Install into a clean temp dir and return the directory the install landed in.
 *
 * tmpDir doubles as HOME and as the working directory, and carries no planning
 * config, so nothing outside it is read or written.
 */
function runInstall(tmpDir, { runtime, scope }) {
  const result = spawnSync(process.execPath, installerArgs(runtime, scope), {
    encoding: 'utf8',
    timeout: 60000,
    cwd: tmpDir,
    env: {
      ...process.env,
      HOME: tmpDir,
      CLAUDE_CONFIG_DIR: path.join(tmpDir, 'cfg-claude'),
      COPILOT_CONFIG_DIR: path.join(tmpDir, 'cfg-copilot'),
      OPENCODE_CONFIG_DIR: path.join(tmpDir, 'cfg-opencode'),
      CLAUDE_PROJECT_DIR: undefined,
      GSD_TEST_FORCE_PLATFORM: 'linux',
    },
  });

  const targetDir = targetDirFor(tmpDir, runtime, scope);
  assertInstalled(result, runtime, scope, targetDir);
  return targetDir;
}

/**
 * Where an install lands when nothing overrides the runtime's own defaults:
 * the config home spec, read the same way the installer reads it, with `~`
 * expanded against the supplied home rather than the real one.
 */
function defaultTargetDir(runtime, scope, home, proj) {
  const spec = (RUNTIMES[runtime] || RUNTIMES.claude).configHome;
  if (scope !== 'global') return path.join(proj, spec.localDirName);
  if (spec.xdg) {
    return path.join(spec.xdg.fallback.replace(/^~/, home), spec.xdg.suffix);
  }
  return path.join(home, spec.globalDirName);
}

/**
 * The environment an isolated run gets: one home, and every config-home
 * override cleared so each runtime lands on its documented default.
 */
function isolatedEnv(home) {
  return {
    ...process.env,
    HOME: home,
    CLAUDE_CONFIG_DIR: undefined,
    COPILOT_CONFIG_DIR: undefined,
    OPENCODE_CONFIG_DIR: undefined,
    XDG_CONFIG_HOME: undefined,
    CLAUDE_PROJECT_DIR: undefined,
    GSD_TEST_FORCE_PLATFORM: 'linux',
  };
}

/** The home and project pair an isolated run uses, created if absent. */
function isolatedPair(tmpDir) {
  const home = path.join(tmpDir, 'home');
  const proj = path.join(tmpDir, 'proj');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(proj, { recursive: true });
  assert.notEqual(home, proj, 'home and project must be different directories');
  return { home, proj };
}

/**
 * Install with the home directory and the project directory deliberately
 * distinct, and with every config-home override cleared so each runtime lands
 * on its documented default.
 *
 * @returns {{targetDir: string, home: string, proj: string}}
 */
function runIsolatedInstall(tmpDir, { runtime, scope }) {
  const { home, proj } = isolatedPair(tmpDir);

  const result = spawnSync(process.execPath, installerArgs(runtime, scope), {
    encoding: 'utf8',
    timeout: 60000,
    cwd: proj,
    env: isolatedEnv(home),
  });

  const targetDir = defaultTargetDir(runtime, scope, home, proj);
  assertInstalled(result, runtime, scope, targetDir);
  return { targetDir, home, proj };
}

/**
 * Uninstall the same way `runIsolatedInstall` installs: run from the project
 * directory, with the same home and the same cleared overrides, so the
 * uninstall resolves exactly what the install wrote.
 *
 * @returns {{result: object, home: string, proj: string}}
 */
function runIsolatedUninstall(tmpDir, { runtime, scope }) {
  const { home, proj } = isolatedPair(tmpDir);

  const result = spawnSync(
    process.execPath,
    [
      INSTALLER,
      '--runtime',
      runtime,
      scope === 'global' ? '--global' : '--local',
      '--uninstall',
    ],
    {
      encoding: 'utf8',
      timeout: 60000,
      cwd: proj,
      env: isolatedEnv(home),
    },
  );

  assert.equal(
    result.status,
    0,
    `uninstaller must exit 0 for ${runtime} ${scope}\nstderr: ${result.stderr || ''}\nstdout: ${result.stdout || ''}`,
  );
  return { result, home, proj };
}

module.exports = {
  INSTALLER,
  targetDirFor,
  runInstall,
  runIsolatedInstall,
  runIsolatedUninstall,
};
