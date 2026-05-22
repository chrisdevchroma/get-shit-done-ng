// §11-compliant semver utilities shared between bin/lib/commands.cjs (/gsd:update) and hooks/gsd-check-update.js (SessionStart update check). DO NOT duplicate — require this module.
'use strict';

/**
 * Compare two semver strings. Implements semver §11 precedence:
 * release > prerelease, identifier-by-identifier compare.
 * @returns {number} 1 if a > b, -1 if a < b, 0 if equal
 */
function compareSemVer(a, b) {
  const stripBuild = (v) => String(v).replace(/^v/, '').split('+')[0];
  const [coreA, preA] = stripBuild(a).split(/-(.+)/);
  const [coreB, preB] = stripBuild(b).split(/-(.+)/);

  const pa = coreA.split('.').map(Number);
  const pb = coreB.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) > (pb[i] || 0)) return 1;
    if ((pa[i] || 0) < (pb[i] || 0)) return -1;
  }

  // §11: a version with a prerelease has lower precedence than one without.
  if (!preA && !preB) return 0;
  if (!preA) return 1;
  if (!preB) return -1;

  const idsA = preA.split('.');
  const idsB = preB.split('.');
  const n = Math.min(idsA.length, idsB.length);
  for (let i = 0; i < n; i++) {
    const aId = idsA[i];
    const bId = idsB[i];
    const aNum = /^\d+$/.test(aId);
    const bNum = /^\d+$/.test(bId);
    if (aNum && bNum) {
      const dA = Number(aId);
      const dB = Number(bId);
      if (dA > dB) return 1;
      if (dA < dB) return -1;
    } else if (aNum && !bNum) {
      return -1; // numeric identifiers always have lower precedence than alphanumeric
    } else if (!aNum && bNum) {
      return 1;
    } else {
      if (aId > bId) return 1;
      if (aId < bId) return -1;
    }
  }
  if (idsA.length < idsB.length) return -1; // tie-break by identifier count
  if (idsA.length > idsB.length) return 1;
  return 0;
}

/**
 * Normalize a git tag to a plain semver string (strips leading 'v').
 * @param {string} tag
 * @returns {string}
 */
function normalizeTag(tag) {
  return String(tag).startsWith('v') ? String(tag).slice(1) : String(tag);
}

/**
 * Returns true if the version string contains build metadata ('+...').
 * A prerelease dash is NOT a snapshot — only '+' denotes a snapshot.
 * @param {string} version
 * @returns {boolean}
 */
function isSnapshot(version) {
  return String(version).includes('+');
}

/**
 * Extract the prerelease channel label from a version string.
 * Returns e.g. 'dev' for '1.0.0-dev.9', 'rc' for '1.0.0-rc.1', null for '1.0.0'.
 * Build metadata ('+...') is stripped before splitting.
 * @param {string} version
 * @returns {string|null}
 */
function parseChannel(version) {
  const core = String(version).split('+')[0];
  if (!core.includes('-')) return null;
  const channel = core.split('-')[1].split('.')[0] || null;
  // callers interpolate the channel into a shell command; restrict to the npm dist-tag charset
  if (!channel || !/^[A-Za-z][A-Za-z0-9]*$/.test(channel)) return null;
  return channel;
}

/**
 * Highest §11-precedence version on a given prerelease channel, or null.
 * @param {string[]} tags - candidate version strings (already 'v'-stripped)
 * @param {string} channel
 * @returns {string|null}
 */
function selectLatestForChannel(tags, channel) {
  if (!Array.isArray(tags) || !channel) return null;
  const matching = tags
    .filter((t) => t && /^\d+\.\d+\.\d+/.test(t) && parseChannel(t) === channel)
    .sort((a, b) => compareSemVer(b, a)); // descending
  return matching.length ? matching[0] : null;
}

module.exports = {
  compareSemVer,
  normalizeTag,
  isSnapshot,
  parseChannel,
  selectLatestForChannel,
};
