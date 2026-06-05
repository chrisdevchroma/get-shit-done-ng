// Shared between hooks/gsd-check-update.js (writer) and hooks/gsd-statusline.js (reader). DO NOT duplicate — require this module so the two cache paths can never drift.
'use strict';

const fs = require('fs');
const path = require('path');

const CACHE_FILENAME = 'gsd-update-check.json';

/**
 * Detect the GSD config dir under baseDir (CLAUDE_CONFIG_DIR, then .claude/.github/.copilot).
 * Returns null when no install is present — unlike the hooks' private copy, which falls
 * back to a default path. The null lets callers distinguish "install present" from "absent".
 * @param {string} baseDir
 * @param {object} [env]
 * @returns {string|null}
 */
function detectConfigDir(baseDir, env) {
  const e = env || process.env;
  const envDir = e.CLAUDE_CONFIG_DIR;
  if (envDir && fs.existsSync(path.join(envDir, 'gsd-ng', 'VERSION'))) {
    return envDir;
  }
  for (const variant of ['.claude', '.github', '.copilot']) {
    if (fs.existsSync(path.join(baseDir, variant, 'gsd-ng', 'VERSION'))) {
      return path.join(baseDir, variant);
    }
  }
  return null;
}

/**
 * Resolve the cache directory with local-before-global precedence:
 * CLAUDE_CONFIG_DIR > local install under cwd > global install under homeDir > default.
 * @param {object} opts
 * @param {string} opts.cwd
 * @param {string} opts.homeDir
 * @param {object} [opts.env]
 * @returns {string}
 */
function resolveUpdateCacheDir({ cwd, homeDir, env }) {
  const e = env || process.env;

  const envDir = e.CLAUDE_CONFIG_DIR;
  if (envDir && fs.existsSync(path.join(envDir, 'gsd-ng', 'VERSION'))) {
    return path.join(envDir, 'cache');
  }

  const localConfig = detectConfigDir(cwd, e);
  if (localConfig) {
    return path.join(localConfig, 'cache');
  }

  // Probe homeDir variants directly — passing e to detectConfigDir would re-check the env dir.
  for (const variant of ['.claude', '.github', '.copilot']) {
    if (fs.existsSync(path.join(homeDir, variant, 'gsd-ng', 'VERSION'))) {
      return path.join(homeDir, variant, 'cache');
    }
  }

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
  detectConfigDir,
  resolveUpdateCacheDir,
  resolveUpdateCacheFile,
};
