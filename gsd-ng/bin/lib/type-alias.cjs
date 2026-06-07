'use strict';

/**
 * Shared type-alias resolver.
 *
 * Single source of truth for the commit-type → branch-prefix alias map.
 * Consumed by both init.cjs and gsd-tools.cjs (resolve-type-alias command)
 * so the two cannot drift.
 *
 * This module intentionally has zero internal imports (only Node.js built-ins)
 * to avoid circular dependencies — mirrors defaults.cjs's self-containment.
 */

const fs = require('fs');
const path = require('path');

// Frozen default map — mirrors the inline map that used to live in gsd-tools.cjs
// resolve-type-alias case.
const DEFAULT_TYPE_ALIASES = Object.freeze({
  feat: 'feature',
  fix: 'bugfix',
  chore: 'chore',
  refactor: 'refactor',
});

/**
 * Resolve a short commit type to its branch prefix.
 *
 * @param {string} type - Short commit type (e.g. 'feat', 'fix').
 * @param {object|null|undefined} overrides - Partial map (e.g. git.type_aliases)
 *   layered over defaults. Pass null or omit to use defaults only.
 * @returns {string} Resolved branch prefix; falls back to the type string itself
 *   for unknown types (preserves current behavior).
 */
function resolveTypeAlias(type, overrides) {
  const aliases = { ...DEFAULT_TYPE_ALIASES, ...(overrides || {}) };
  return aliases[type] !== undefined ? aliases[type] : type;
}

/**
 * Read git.type_aliases from .planning/config.json.
 *
 * loadConfig() (core.cjs) returns a flat object and does NOT surface type_aliases.
 * This helper does a raw JSON read of the config file to retrieve the nested
 * git.type_aliases map — the same read that used to be inlined in gsd-tools.cjs.
 *
 * @param {string} cwd - Project root directory.
 * @returns {object|null} The type_aliases override map, or null if absent or on error.
 *   Never throws.
 */
function readTypeAliases(cwd) {
  try {
    const cfg = JSON.parse(
      fs.readFileSync(path.join(cwd, '.planning', 'config.json'), 'utf-8'),
    );
    return (cfg.git && cfg.git.type_aliases) || null;
  } catch {
    return null;
  }
}

module.exports = { DEFAULT_TYPE_ALIASES, resolveTypeAlias, readTypeAliases };
