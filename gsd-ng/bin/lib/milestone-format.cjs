/**
 * Milestone format — the shape of a MILESTONES.md entry.
 *
 * `milestone complete` writes entries through formatMilestoneHeading and
 * `cleanup` reads them back through parseCompletedMilestones. Both sides go
 * through this module so the writer and the reader cannot drift apart.
 *
 * Canonical form (also documented in templates/milestone.md):
 *
 *   ## v1.0 Foundation (Shipped: 2026-07-24)
 *
 * Two legacy forms stay readable, since hand-maintained files use them:
 *
 *   - [x] **v1.0 — Foundation** — initial release
 *   | v1.0 | Foundation | Complete |
 */

const SHIPPED_LABEL = 'Shipped';

const HEADING_PATTERN = /^#{1,6}[ \t]*(v[\d.]+)\b([^\n]*)$/i;
const LIST_PATTERN = /^-\s*\[x\]\s*\*\*(v[\d.]+)([^*]*)(?:\*\*)?/i;
const TABLE_PATTERN = /^\|\s*(v[\d.]+)\s*\|([^|]+)\|\s*Complete\s*\|/i;
const COMPLETED_MARKER = /shipped|complete/i;

function formatMilestoneHeading(version, name, date) {
  return `## ${version} ${name} (${SHIPPED_LABEL}: ${date})`;
}

function cleanName(raw, version) {
  const name = (raw || '')
    .replace(/\([^)]*\)\s*$/, '')
    .replace(/^[\s—–-]+/, '')
    .replace(/[\s—–-]+$/, '')
    .trim();
  return name && name !== version ? name : null;
}

function parseEntryLine(line) {
  const heading = HEADING_PATTERN.exec(line);
  if (heading && COMPLETED_MARKER.test(heading[2])) {
    return { version: heading[1], name: cleanName(heading[2], heading[1]) };
  }

  const list = LIST_PATTERN.exec(line);
  if (list) {
    return { version: list[1], name: cleanName(list[2], list[1]) };
  }

  const table = TABLE_PATTERN.exec(line);
  if (table) {
    return { version: table[1], name: cleanName(table[2], table[1]) };
  }

  return null;
}

/**
 * Extract completed milestones from MILESTONES.md content.
 *
 * @param {string} content - MILESTONES.md content
 * @returns {Array<{version: string, name: string|null}>} one entry per version,
 *   deduped on version, in document order
 */
function parseCompletedMilestones(content) {
  const entries = [];
  const byVersion = new Map();

  for (const line of String(content || '').split('\n')) {
    const entry = parseEntryLine(line.trim());
    if (!entry) continue;
    const known = byVersion.get(entry.version);
    if (known) {
      if (!known.name) known.name = entry.name;
      continue;
    }
    byVersion.set(entry.version, entry);
    entries.push(entry);
  }

  return entries;
}

module.exports = {
  SHIPPED_LABEL,
  formatMilestoneHeading,
  parseCompletedMilestones,
};
