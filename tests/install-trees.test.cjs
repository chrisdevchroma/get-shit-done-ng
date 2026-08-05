'use strict';

/**
 * Byte-level record of what the installer produces, per runtime and scope.
 *
 * Each recorded tree under tests/fixtures/install-trees/ maps every installed
 * file's relative path to the sha256 of its normalised bytes. The trees were
 * captured against untouched main, before the installer's runtime selection
 * was reworked, so a later change that alters claude or copilot output shows
 * up here as a named list of paths instead of as silence.
 *
 * The rule for changing a recorded tree: regenerate it in the same commit as
 * the change that alters the output, list every changed path in that work's
 * summary, and justify each one. A regeneration with no stated reason is the
 * failure mode this file exists to prevent.
 *
 * Regenerate with:
 *   INSTALL_TREE_REGENERATE=1 node --test tests/install-trees.test.cjs
 *
 * Normalisation applied before hashing, one entry per known source of
 * run-to-run variance:
 *   - gsd-file-manifest.json carries a wall-clock timestamp, replaced with a
 *     fixed string.
 *   - gsd-ng/VERSION carries a build-metadata suffix on dev checkouts, which
 *     is stripped back to the base version.
 *   - a global claude install bakes its absolute target path into the
 *     settings.json hook commands, so the temp dir path is replaced with a
 *     token.
 *   - line endings are folded to newline-only before hashing.
 *
 * Permission and sandbox seeding are switched off by installer flag rather
 * than normalised away: seeding shells out to whichever forge tools are on
 * PATH and reads the working directory's planning config, and neither is
 * stable across machines.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { resolveTmpDir, cleanup } = require('./helpers.cjs');
const { targetDirFor, runInstall } = require('./install-harness.cjs');

const TREE_DIR = path.join(__dirname, 'fixtures', 'install-trees');
const BASE_TMPDIR = resolveTmpDir();

const MANIFEST_RELPATH = 'gsd-file-manifest.json';
const VERSION_RELPATH = 'gsd-ng/VERSION';
const TIMESTAMP_PLACEHOLDER = 'RECORDED';
const VERSION_HASH_PLACEHOLDER = 'RECORDED_VERSION_HASH';
const TMPDIR_PLACEHOLDER = '<RECORDED_TMPDIR>';
const EMPTY_DIFF = { changed: [], added: [], removed: [] };

const REGENERATE = Boolean(process.env.INSTALL_TREE_REGENERATE);

// ── tree capture ─────────────────────────────────────────────────────────────

function listRelPaths(dir, base, acc) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) listRelPaths(abs, base, acc);
    else if (entry.isFile()) acc.push(path.relative(base, abs).split(path.sep).join('/'));
  }
  return acc;
}

function normalizeContent(relpath, buf, replacePaths) {
  // A file with a null byte is not text; hash it exactly as it landed.
  if (buf.includes(0)) return buf;

  let text = buf.toString('utf8').replace(/\r\n/g, '\n');

  if (relpath === MANIFEST_RELPATH) {
    const parsed = JSON.parse(text);
    parsed.timestamp = TIMESTAMP_PLACEHOLDER;
    // The manifest records the same build-metadata-suffixed version as
    // gsd-ng/VERSION, and on a dev checkout that suffix is the current commit
    // sha — so without the same strip applied below, every commit invalidates
    // all four recorded trees and the tripwire reports nothing but itself. The
    // manifest's own hash of gsd-ng/VERSION carries the suffix too and cannot
    // be recomputed here, so it is replaced outright; that file is captured as
    // its own tree entry, stripped, and a real version change still shows there.
    if (typeof parsed.version === 'string') {
      parsed.version = parsed.version.split('+')[0];
    }
    if (parsed.files && typeof parsed.files[VERSION_RELPATH] === 'string') {
      parsed.files[VERSION_RELPATH] = VERSION_HASH_PLACEHOLDER;
    }
    text = JSON.stringify(parsed, null, 2);
  }

  if (relpath === VERSION_RELPATH) {
    text = text.split('+')[0];
  }

  for (const abs of replacePaths) {
    text = text.split(abs).join(TMPDIR_PLACEHOLDER);
  }

  return Buffer.from(text, 'utf8');
}

/**
 * Walk targetDir and return a sorted { relpath: sha256 } map of normalised
 * file contents.
 *
 * @param {string} targetDir - installed tree root
 * @param {object} [opts]
 * @param {string[]} [opts.replacePaths] - absolute paths replaced with a fixed
 *   token wherever they appear in file text, so a tree captured in one temp dir
 *   compares equal to the same tree captured in another
 */
function captureTree(targetDir, opts = {}) {
  // Longest first, so a path that is a prefix of another cannot shadow it.
  const replacePaths = [...new Set((opts.replacePaths || []).filter(Boolean))].sort(
    (a, b) => b.length - a.length,
  );

  const tree = {};
  for (const rel of listRelPaths(targetDir, targetDir, []).sort()) {
    const buf = fs.readFileSync(path.join(targetDir, rel));
    tree[rel] = crypto
      .createHash('sha256')
      .update(normalizeContent(rel, buf, replacePaths))
      .digest('hex');
  }
  return tree;
}

// ── comparison ───────────────────────────────────────────────────────────────

/**
 * Compare two { relpath: sha256 } maps.
 *
 * @returns {{changed: string[], added: string[], removed: string[]}} sorted
 *   relpaths: present in both with a different hash, present only in actual,
 *   present only in expected
 */
function compareTrees(expected, actual) {
  const changed = [];
  const added = [];
  const removed = [];

  for (const rel of Object.keys(expected).sort()) {
    if (!Object.prototype.hasOwnProperty.call(actual, rel)) removed.push(rel);
    else if (expected[rel] !== actual[rel]) changed.push(rel);
  }
  for (const rel of Object.keys(actual).sort()) {
    if (!Object.prototype.hasOwnProperty.call(expected, rel)) added.push(rel);
  }

  return { changed, added, removed };
}

function formatDiff(label, diff) {
  const lines = [`${label}: install tree does not match the recorded tree`];
  for (const rel of diff.changed) lines.push(`  changed: ${rel}`);
  for (const rel of diff.added) lines.push(`  added:   ${rel}`);
  for (const rel of diff.removed) lines.push(`  removed: ${rel}`);
  lines.push(
    'If the change is intended, regenerate the recorded tree in the same commit and justify each path.',
  );
  return lines.join('\n');
}

// ── running the real installer ───────────────────────────────────────────────

function captureInstall(runtime, scope) {
  const tmpDir = fs.mkdtempSync(path.join(BASE_TMPDIR, `gsd-install-tree-${runtime}-${scope}-`));
  try {
    const targetDir = runInstall(tmpDir, { runtime, scope });
    return captureTree(targetDir, { replacePaths: [tmpDir, fs.realpathSync(tmpDir)] });
  } finally {
    cleanup(tmpDir);
  }
}

// ── synthetic self-tests: the comparator must discriminate ───────────────────

test('TREE-01: compareTrees reports a file whose hash changed', () => {
  const before = { 'a.md': 'aa', 'b/c.js': 'bb' };
  const after = { 'a.md': 'aa', 'b/c.js': 'cc' };
  assert.deepEqual(compareTrees(before, after), {
    changed: ['b/c.js'],
    added: [],
    removed: [],
  });
});

test('TREE-02: compareTrees reports a file present only after the change as added', () => {
  const before = { 'a.md': 'aa' };
  const after = { 'a.md': 'aa', 'new/file.json': 'dd' };
  assert.deepEqual(compareTrees(before, after), {
    changed: [],
    added: ['new/file.json'],
    removed: [],
  });
});

test('TREE-03: compareTrees reports a file present only before the change as removed', () => {
  const before = { 'a.md': 'aa', 'gone.js': 'ee' };
  const after = { 'a.md': 'aa' };
  assert.deepEqual(compareTrees(before, after), {
    changed: [],
    added: [],
    removed: ['gone.js'],
  });
});

test('TREE-04: compareTrees reports nothing for identical trees', () => {
  const tree = { 'a.md': 'aa', 'b/c.js': 'bb' };
  assert.deepEqual(compareTrees(tree, { ...tree }), EMPTY_DIFF);
});

test('TREE-05: formatDiff names every changed, added and removed path', () => {
  const message = formatDiff('claude local', {
    changed: ['one.md'],
    added: ['two.md'],
    removed: ['three.md'],
  });
  assert.match(message, /one\.md/);
  assert.match(message, /two\.md/);
  assert.match(message, /three\.md/);
});

// ── the installer is byte-stable across runs ─────────────────────────────────

test('TREE-06: two claude local installs into separate temp dirs produce identical trees', () => {
  const first = fs.mkdtempSync(path.join(BASE_TMPDIR, 'gsd-install-tree-stable-a-'));
  const second = fs.mkdtempSync(path.join(BASE_TMPDIR, 'gsd-install-tree-stable-b-'));
  try {
    const treeA = captureTree(runInstall(first, { runtime: 'claude', scope: 'local' }), {
      replacePaths: [first, fs.realpathSync(first)],
    });
    const treeB = captureTree(runInstall(second, { runtime: 'claude', scope: 'local' }), {
      replacePaths: [second, fs.realpathSync(second)],
    });

    assert.ok(Object.keys(treeA).length > 50, 'captured tree must not be near-empty');
    const diff = compareTrees(treeA, treeB);
    assert.deepEqual(diff, EMPTY_DIFF, formatDiff('claude local repeat install', diff));
    assert.deepStrictEqual(treeA, treeB);
  } finally {
    cleanup(first);
    cleanup(second);
  }
});

// ── the recorded trees ───────────────────────────────────────────────────────

const TREE_CASES = [
  { id: 'TREE-07', runtime: 'claude', scope: 'global' },
  { id: 'TREE-08', runtime: 'claude', scope: 'local' },
  { id: 'TREE-09', runtime: 'copilot', scope: 'global' },
  { id: 'TREE-10', runtime: 'copilot', scope: 'local' },
];

for (const { id, runtime, scope } of TREE_CASES) {
  test(`${id}: ${runtime} ${scope} install matches the recorded tree`, () => {
    const actual = captureInstall(runtime, scope);
    const treePath = path.join(TREE_DIR, `${runtime}-${scope}.json`);

    if (REGENERATE) {
      fs.mkdirSync(TREE_DIR, { recursive: true });
      fs.writeFileSync(treePath, JSON.stringify(actual, null, 2) + '\n');
      return;
    }

    assert.ok(
      fs.existsSync(treePath),
      `no recorded tree at ${treePath} — regenerate with INSTALL_TREE_REGENERATE=1`,
    );
    const recorded = JSON.parse(fs.readFileSync(treePath, 'utf8'));
    const diff = compareTrees(recorded, actual);
    assert.deepEqual(diff, EMPTY_DIFF, formatDiff(`${runtime} ${scope}`, diff));
  });
}

module.exports = { captureTree, compareTrees, formatDiff, runInstall, targetDirFor };
