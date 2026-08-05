// Shared between hooks/gsd-check-update.js (writer) and hooks/gsd-statusline.js (reader). DO NOT duplicate — require this module so the two cache paths can never drift.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { RUNTIMES } = require('./template-processor.cjs');

const CACHE_FILENAME = 'gsd-update-check.json';

// Every config dir name any runtime installs into, local and global, claude
// first so an existing install hits on the first probe. Derived rather than
// listed: a runtime added to the registry is discovered here with no edit.
const CONFIG_DIR_VARIANTS = Object.freeze(
  [
    ...new Set(
      ['.claude'].concat(
        ...Object.values(RUNTIMES).map((runtime) => [
          runtime.configHome.localDirName,
          runtime.configHome.globalDirName,
        ]),
      ),
    ),
  ].filter(Boolean),
);

// Probe order for whole config homes: the registry's own declaration order,
// which puts claude first, so an existing claude install still hits on the
// first probe. Own keys only, so a prototype name can never enter the list.
const RUNTIME_PROBE_ORDER = Object.freeze(Object.keys(RUNTIMES));

/**
 * The config home this module is installed under, or null when it is not
 * running from an installed tree.
 *
 * An installed engine sits at `<config home>/gsd-ng/bin/lib`, so the config
 * home is three levels up and carries the engine's VERSION file with the
 * `.runtime` marker beside it. Both must be present: in the source tree
 * neither is, so self-location fails cleanly there and every caller below
 * falls through to the probes, which is the behaviour the source-tree tests
 * depend on.
 *
 * `moduleDir` exists so tests can stage a directory shaped like an install and
 * drive both outcomes in-process. Production callers pass nothing; the installed
 * copies that exercise the found-path for real run in spawned processes, whose
 * coverage is not attributed back to this file.
 *
 * @param {string} [moduleDir] - defaults to this module's own directory
 * @returns {string|null}
 */
function selfLocatedConfigHome(moduleDir) {
  try {
    const candidate = path.join(moduleDir || __dirname, '..', '..', '..');
    const engineDir = path.join(candidate, 'gsd-ng');
    if (
      fs.existsSync(path.join(engineDir, 'VERSION')) &&
      fs.existsSync(path.join(engineDir, '.runtime'))
    ) {
      return candidate;
    }
  } catch {
    // A session hook requires this module, so an unreadable path degrades to
    // "not installed here" rather than throwing.
  }
  return null;
}

/**
 * The runtime this module's install belongs to, or null when it is not running
 * from an install or the marker names a runtime the registry does not carry.
 *
 * Own-property check rather than a truthy index: a marker reading `constructor`
 * would otherwise resolve to a prototype member and pass for a runtime name.
 *
 * @param {string} [moduleDir] - forwarded to selfLocatedConfigHome, for tests
 * @returns {string|null}
 */
function selfLocatedRuntime(moduleDir) {
  const home = selfLocatedConfigHome(moduleDir);
  if (!home) return null;
  try {
    const value = fs
      .readFileSync(path.join(home, 'gsd-ng', '.runtime'), 'utf-8')
      .trim();
    return Object.prototype.hasOwnProperty.call(RUNTIMES, value) ? value : null;
  } catch {
    return null;
  }
}

/**
 * Expand a leading `~/` against the supplied home dir.
 * @param {string} dir
 * @param {string} homeDir
 * @returns {string}
 */
function expandHome(dir, homeDir) {
  return dir && dir.startsWith('~/') ? path.join(homeDir, dir.slice(2)) : dir;
}

/**
 * One runtime's absolute global config directory, from its registry spec.
 *
 * This is the single derivation of that answer: the installer's own resolvers
 * call it rather than repeating the precedence, so a change to how a config
 * home is derived cannot land in one copy and miss another.
 *
 * Precedence, straight off the spec: the runtime's own override variable, then
 * an XDG base plus suffix, then a home-relative directory name. A spec
 * declaring none of the three has no global directory and yields null rather
 * than a path built from an undefined segment.
 *
 * Own-property check rather than a truthy index: `constructor` and other
 * prototype names would otherwise pass for a runtime and resolve to a member
 * with no configHome.
 *
 * @param {string} runtime
 * @param {object} [env] - defaults to process.env
 * @param {string} [homeDir] - defaults to os.homedir()
 * @returns {string|null}
 */
function globalConfigDirFor(runtime, env, homeDir) {
  if (!Object.prototype.hasOwnProperty.call(RUNTIMES, runtime)) {
    const err = new Error(`Unknown runtime: ${String(runtime)}`);
    err.name = 'UnknownRuntimeError';
    throw err;
  }
  const e = env || process.env;
  const home = homeDir || os.homedir();
  const spec = RUNTIMES[runtime].configHome;
  if (spec.envVar && e[spec.envVar]) {
    return expandHome(e[spec.envVar], home);
  }
  if (spec.xdg) {
    return path.join(
      expandHome(e[spec.xdg.varName] || spec.xdg.fallback, home),
      spec.xdg.suffix,
    );
  }
  if (spec.globalDirName) {
    return path.join(home, spec.globalDirName);
  }
  return null;
}

/**
 * One global config-home candidate per registered runtime, in probe order.
 *
 * A runtime whose spec declares no global directory contributes nothing, and
 * duplicates collapse, so the list stays a probe order rather than a census.
 * @param {object} [env]
 * @param {string} homeDir
 * @returns {string[]}
 */
function globalConfigDirCandidates(env, homeDir) {
  const e = env || process.env;
  const dirs = RUNTIME_PROBE_ORDER.map((name) =>
    globalConfigDirFor(name, e, homeDir),
  ).filter(Boolean);
  return [...new Set(dirs)];
}

/**
 * The global config home holding an install, or null when none does.
 * @param {string} homeDir
 * @param {object} [env]
 * @returns {string|null}
 */
function resolveGlobalConfigDir(homeDir, env) {
  const e = env || process.env;
  for (const candidate of globalConfigDirCandidates(e, homeDir)) {
    if (fs.existsSync(path.join(candidate, 'gsd-ng', 'VERSION'))) {
      return candidate;
    }
  }
  return null;
}

/**
 * Detect the GSD config dir under baseDir (the override variable, then every
 * config dir name the runtime registry declares).
 * Returns null when no install is present — unlike the hooks' private copy, which falls
 * back to a default path. The null lets callers distinguish "install present" from "absent".
 *
 * The override variable belongs to a runtime, so an install honours the one its
 * own registry row names and ignores the rest. A caller outside an install has
 * no runtime to read from and keeps the historical variable, which is what
 * preserves back-compat for the majority runtime.
 * @param {string} baseDir
 * @param {object} [env]
 * @returns {string|null}
 */
function detectConfigDir(baseDir, env) {
  const e = env || process.env;
  const runtime = selfLocatedRuntime();
  const overrideVar = runtime
    ? RUNTIMES[runtime].configHome.envVar
    : 'CLAUDE_CONFIG_DIR';
  const envDir = overrideVar ? e[overrideVar] : null;
  if (envDir && fs.existsSync(path.join(envDir, 'gsd-ng', 'VERSION'))) {
    return envDir;
  }
  for (const variant of CONFIG_DIR_VARIANTS) {
    if (fs.existsSync(path.join(baseDir, variant, 'gsd-ng', 'VERSION'))) {
      return path.join(baseDir, variant);
    }
  }
  return null;
}

/**
 * Resolve the cache directory with local-before-global precedence:
 * own install > CLAUDE_CONFIG_DIR > local install under cwd > global install
 * under homeDir > default.
 * @param {object} opts
 * @param {string} opts.cwd
 * @param {string} opts.homeDir
 * @param {object} [opts.env]
 * @returns {string}
 */
function resolveUpdateCacheDir({ cwd, homeDir, env, moduleDir }) {
  const e = env || process.env;

  // An installed engine already knows where it lives, and nothing below should
  // override that: with a second runtime installed under the same home, every
  // probe here can find the other install first and write into its directories.
  const selfHome = selfLocatedConfigHome(moduleDir);
  if (selfHome) {
    return path.join(selfHome, 'cache');
  }

  const envDir = e.CLAUDE_CONFIG_DIR;
  if (envDir && fs.existsSync(path.join(envDir, 'gsd-ng', 'VERSION'))) {
    return path.join(envDir, 'cache');
  }

  const localConfig = detectConfigDir(cwd, e);
  if (localConfig) {
    return path.join(localConfig, 'cache');
  }

  // Probe whole global config homes, not homeDir plus a directory name: a
  // runtime can keep its global home under an XDG base instead.
  const globalConfig = resolveGlobalConfigDir(homeDir, e);
  if (globalConfig) {
    return path.join(globalConfig, 'cache');
  }

  // Last resort: no runtime could be identified, so default to the majority one.
  return path.join(envDir || path.join(homeDir, '.claude'), 'cache');
}

/**
 * Absolute path to gsd-update-check.json. See resolveUpdateCacheDir for precedence.
 * @param {object} opts
 * @param {string} opts.cwd
 * @param {string} opts.homeDir
 * @param {object} [opts.env]
 * @returns {string}
 */
function resolveUpdateCacheFile(opts) {
  return path.join(resolveUpdateCacheDir(opts), CACHE_FILENAME);
}

module.exports = {
  CONFIG_DIR_VARIANTS,
  selfLocatedConfigHome,
  selfLocatedRuntime,
  globalConfigDirFor,
  globalConfigDirCandidates,
  resolveGlobalConfigDir,
  detectConfigDir,
  resolveUpdateCacheDir,
  resolveUpdateCacheFile,
};
