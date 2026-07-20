'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..');
const SCRIPT_PATH = path.join(
  REPO_ROOT,
  'scripts',
  'capture-clean-path-evidence.cjs',
);
const capture = require(SCRIPT_PATH);

function rosteredTestIds() {
  const src = fs.readFileSync(
    path.join(REPO_ROOT, 'tests', 'install-js.test.cjs'),
    'utf8',
  );
  const ids = new Set();
  for (const m of src.matchAll(/^test\(\s*'(CLEANEV-\d+)/gm)) {
    ids.add(m[1]);
  }
  return [...ids].sort();
}

test('CLEANEV-CAP-01: the roster covers every clean-path evidence test', () => {
  // The roster drives --test-name-pattern, so an id missing here is silently
  // never captured: the artifact still reads green without ever running it.
  const defined = rosteredTestIds();
  assert.ok(defined.length > 0, 'expected CLEANEV tests in install-js.test.cjs');

  const missing = defined.filter((id) => !capture.ROSTER.includes(id));
  assert.deepEqual(
    missing,
    [],
    `evidence roster omits clean-path tests: ${missing.join(', ')}`,
  );
});

test('CLEANEV-CAP-02: the default output directory is inside this repository', () => {
  // A default that resolves outside the repo cannot work for anyone but the
  // machine it was written on.
  const rel = path.relative(REPO_ROOT, capture.DEFAULT_OUT_DIR);
  assert.ok(
    rel && !rel.startsWith('..') && !path.isAbsolute(rel),
    `DEFAULT_OUT_DIR must resolve inside the repo, got: ${capture.DEFAULT_OUT_DIR}`,
  );
});

test('CLEANEV-CAP-03: the script is reachable as an npm script', () => {
  const pkg = JSON.parse(
    fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'),
  );
  const entries = Object.values(pkg.scripts || {});
  assert.ok(
    entries.some((cmd) => cmd.includes('capture-clean-path-evidence.cjs')),
    'no npm script runs capture-clean-path-evidence.cjs',
  );
});

test('CLEANEV-CAP-04: requiring the script does not run a capture', () => {
  const src = fs.readFileSync(SCRIPT_PATH, 'utf8');
  assert.match(
    src,
    /require\.main === module/,
    'main() must be guarded so the roster can be inspected without spawning a test run',
  );
});
