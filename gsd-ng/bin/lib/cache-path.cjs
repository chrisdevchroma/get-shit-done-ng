'use strict';
// Shared between hooks/gsd-check-update.js (writer) and hooks/gsd-statusline.js (reader)
// — DO NOT inline; both require this so cache paths can never drift.

const fs = require('fs');
const path = require('path');

const CACHE_FILENAME = 'gsd-update-check.json';

/**
 * Detect the GSD config directory for a given base directory.
 * Returns the variant dir (e.g. <base>/.claude) when an install is present,
 * or null when no install is found under this base.
 *
 * Variant order (same as gsd-check-update.js detectConfigDir):
 *   1. env.CLAUDE_CONFIG_DIR with gsd-ng/VERSION present
 *   2. <base>/.claude/gsd-ng/VERSION
 *   3. <base>/.github/gsd-ng/VERSION
 *   4. <base>/.copilot/gsd-ng/VERSION
 *
 * Unlike the hook's private copy, this version returns null on miss
 * so callers can distinguish "install present" from "fallback path".
 *
 * @param {string} baseDir - Directory to probe
 * @param {object} [env] - Environment object (defaults to process.env)
 * @returns {string|null}
 */
function detectConfigDir(baseDir, env) {
  const e = env || process.env;
  // Env override takes absolute top precedence (only when VERSION is present there too)
  const envDir = e.CLAUDE_CONFIG_DIR;
  if (envDir && fs.existsSync(path.join(envDir, 'gsd-ng', 'VERSION'))) {
    return envDir;
  }
  // Claude Code local: .claude/gsd-ng/VERSION
  if (fs.existsSync(path.join(baseDir, '.claude', 'gsd-ng', 'VERSION'))) {
    return path.join(baseDir, '.claude');
  }
  // Copilot local: .github/gsd-ng/VERSION
  if (fs.existsSync(path.join(baseDir, '.github', 'gsd-ng', 'VERSION'))) {
    return path.join(baseDir, '.github');
  }
  // Copilot global: .copilot/gsd-ng/VERSION
  if (fs.existsSync(path.join(baseDir, '.copilot', 'gsd-ng', 'VERSION'))) {
    return path.join(baseDir, '.copilot');
  }
  return null;
}

/**
 * Resolve the cache DIRECTORY for gsd-update-check.json using
 * local-before-global precedence:
 *
 *   1. env.CLAUDE_CONFIG_DIR with gsd-ng/VERSION → join(envDir, 'cache')
 *   2. Local install under cwd → join(localConfigDir, 'cache')   [local wins]
 *   3. Global install under homeDir → join(globalConfigDir, 'cache')
 *   4. Fallback → join(env.CLAUDE_CONFIG_DIR || join(homeDir, '.claude'), 'cache')
 *
 * @param {object} opts
 * @param {string} opts.cwd     - Current working / project directory
 * @param {string} opts.homeDir - User home directory
 * @param {object} [opts.env]   - Environment object (defaults to process.env)
 * @returns {string} Absolute path to the cache directory
 */
function resolveUpdateCacheDir({ cwd, homeDir, env }) {
  const e = env || process.env;

  // 1. Env override with VERSION present
  const envDir = e.CLAUDE_CONFIG_DIR;
  if (envDir && fs.existsSync(path.join(envDir, 'gsd-ng', 'VERSION'))) {
    return path.join(envDir, 'cache');
  }

  // 2. Local install (project dir)
  const localConfig = detectConfigDir(cwd, e);
  if (localConfig) {
    return path.join(localConfig, 'cache');
  }

  // 3. Global install (home dir) — only check base variants, NOT env (already handled)
  // We need to probe homeDir variants directly (no env re-check to avoid double-counting).
  if (fs.existsSync(path.join(homeDir, '.claude', 'gsd-ng', 'VERSION'))) {
    return path.join(homeDir, '.claude', 'cache');
  }
  if (fs.existsSync(path.join(homeDir, '.github', 'gsd-ng', 'VERSION'))) {
    return path.join(homeDir, '.github', 'cache');
  }
  if (fs.existsSync(path.join(homeDir, '.copilot', 'gsd-ng', 'VERSION'))) {
    return path.join(homeDir, '.copilot', 'cache');
  }

  // 4. Fallback (no install found anywhere)
  const fallbackBase = envDir || path.join(homeDir, '.claude');
  return path.join(fallbackBase, 'cache');
}

/**
 * Resolve the absolute path to gsd-update-check.json using local-before-global
 * precedence. Both the writer (gsd-check-update.js) and the reader
 * (gsd-statusline.js) must call this so their cache paths cannot drift.
 *
 * @param {object} opts
 * @param {string} opts.cwd     - Current working / project directory
 * @param {string} opts.homeDir - User home directory
 * @param {object} [opts.env]   - Environment object (defaults to process.env)
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
