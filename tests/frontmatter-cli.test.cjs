/**
 * GSD Tools Tests - frontmatter CLI integration
 *
 * Integration tests for the 4 frontmatter subcommands (get, set, merge, validate)
 * exercised through gsd-tools.cjs via execSync.
 *
 * Each test creates its own temp file, runs the CLI command, asserts output,
 * and cleans up in afterEach (per-test cleanup with individual temp files).
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { runGsdTools, resolveTmpDir } = require('./helpers.cjs');

// Track temp files for cleanup
let tempFiles = [];

function writeTempFile(content) {
  const tmpFile = path.join(resolveTmpDir(), `gsd-fm-test-${Date.now()}-${Math.random().toString(36).slice(2)}.md`);
  fs.writeFileSync(tmpFile, content, 'utf-8');
  tempFiles.push(tmpFile);
  return tmpFile;
}

afterEach(() => {
  for (const f of tempFiles) {
    try { fs.unlinkSync(f); } catch { /* already cleaned */ }
  }
  tempFiles = [];
});

// ─── frontmatter get ────────────────────────────────────────────────────────

describe('frontmatter get', () => {
  test('returns all fields as JSON', () => {
    const file = writeTempFile('---\nphase: 01\nplan: 01\ntype: execute\n---\nbody text');
    const result = runGsdTools(`frontmatter get ${file} --json`);
    assert.ok(result.success, `Command failed: ${result.error}`);
    const parsed = JSON.parse(result.output);
    assert.strictEqual(parsed.phase, '01');
    assert.strictEqual(parsed.plan, '01');
    assert.strictEqual(parsed.type, 'execute');
  });

  test('returns specific field with --field', () => {
    const file = writeTempFile('---\nphase: 01\nplan: 02\ntype: tdd\n---\nbody');
    const result = runGsdTools(`frontmatter get ${file} --field phase --json`);
    assert.ok(result.success, `Command failed: ${result.error}`);
    const parsed = JSON.parse(result.output);
    assert.strictEqual(parsed.phase, '01');
  });

  test('returns error for missing field', () => {
    const file = writeTempFile('---\nphase: 01\n---\n');
    const result = runGsdTools(`frontmatter get ${file} --field nonexistent --json`);
    // The command succeeds (exit 0) but returns an error object in JSON
    assert.ok(result.success, 'Command should exit 0');
    const parsed = JSON.parse(result.output);
    assert.ok(parsed.error, 'Should have error field');
    assert.ok(parsed.error.includes('Field not found'), 'Error should mention "Field not found"');
  });

  test('returns error for missing file', () => {
    const result = runGsdTools('frontmatter get /nonexistent/path/file.md --json');
    assert.ok(result.success, 'Command should exit 0 with error JSON');
    const parsed = JSON.parse(result.output);
    assert.ok(parsed.error, 'Should have error field');
  });

  test('handles file with no frontmatter', () => {
    const file = writeTempFile('Plain text with no frontmatter delimiters.');
    const result = runGsdTools(`frontmatter get ${file} --json`);
    assert.ok(result.success, `Command failed: ${result.error}`);
    const parsed = JSON.parse(result.output);
    assert.deepStrictEqual(parsed, {}, 'Should return empty object for no frontmatter');
  });
});

// ─── frontmatter set ────────────────────────────────────────────────────────

describe('frontmatter set', () => {
  test('updates existing field', () => {
    const file = writeTempFile('---\nphase: 01\ntype: execute\n---\nbody');
    const result = runGsdTools(`frontmatter set ${file} --field phase --value "02"`);
    assert.ok(result.success, `Command failed: ${result.error}`);

    // Read back and verify
    const content = fs.readFileSync(file, 'utf-8');
    const { extractFrontmatter } = require('../gsd-ng/bin/lib/frontmatter.cjs');
    const fm = extractFrontmatter(content);
    assert.strictEqual(fm.phase, '02');
  });

  test('adds new field', () => {
    const file = writeTempFile('---\nphase: 01\n---\nbody');
    const result = runGsdTools(`frontmatter set ${file} --field status --value "active"`);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const content = fs.readFileSync(file, 'utf-8');
    const { extractFrontmatter } = require('../gsd-ng/bin/lib/frontmatter.cjs');
    const fm = extractFrontmatter(content);
    assert.strictEqual(fm.status, 'active');
  });

  test('handles JSON array value', () => {
    const file = writeTempFile('---\nphase: 01\n---\nbody');
    const result = runGsdTools(['frontmatter', 'set', file, '--field', 'tags', '--value', '["a","b"]']);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const content = fs.readFileSync(file, 'utf-8');
    const { extractFrontmatter } = require('../gsd-ng/bin/lib/frontmatter.cjs');
    const fm = extractFrontmatter(content);
    assert.ok(Array.isArray(fm.tags), 'tags should be an array');
    assert.deepStrictEqual(fm.tags, ['a', 'b']);
  });

  test('returns error for missing file', () => {
    const result = runGsdTools('frontmatter set /nonexistent/file.md --field phase --value "01" --json');
    assert.ok(result.success, 'Command should exit 0 with error JSON');
    const parsed = JSON.parse(result.output);
    assert.ok(parsed.error, 'Should have error field');
  });

  test('preserves body content after set', () => {
    const bodyText = '\n\n# My Heading\n\nSome paragraph with special chars: $, %, &.';
    const file = writeTempFile('---\nphase: 01\n---' + bodyText);
    runGsdTools(`frontmatter set ${file} --field phase --value "02"`);

    const content = fs.readFileSync(file, 'utf-8');
    assert.ok(content.includes('# My Heading'), 'heading should be preserved');
    assert.ok(content.includes('Some paragraph with special chars: $, %, &.'), 'body content should be preserved');
  });
});

// ─── frontmatter merge ──────────────────────────────────────────────────────

describe('frontmatter merge', () => {
  test('merges multiple fields into frontmatter', () => {
    const file = writeTempFile('---\nphase: 01\n---\nbody');
    const result = runGsdTools(['frontmatter', 'merge', file, '--data', '{"plan":"02","type":"tdd"}']);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const content = fs.readFileSync(file, 'utf-8');
    const { extractFrontmatter } = require('../gsd-ng/bin/lib/frontmatter.cjs');
    const fm = extractFrontmatter(content);
    assert.strictEqual(fm.phase, '01', 'original field should be preserved');
    assert.strictEqual(fm.plan, '02', 'merged field should be present');
    assert.strictEqual(fm.type, 'tdd', 'merged field should be present');
  });

  test('overwrites existing fields on conflict', () => {
    const file = writeTempFile('---\nphase: 01\ntype: execute\n---\nbody');
    const result = runGsdTools(['frontmatter', 'merge', file, '--data', '{"phase":"02"}']);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const content = fs.readFileSync(file, 'utf-8');
    const { extractFrontmatter } = require('../gsd-ng/bin/lib/frontmatter.cjs');
    const fm = extractFrontmatter(content);
    assert.strictEqual(fm.phase, '02', 'conflicting field should be overwritten');
    assert.strictEqual(fm.type, 'execute', 'non-conflicting field should be preserved');
  });

  test('returns error for missing file', () => {
    const result = runGsdTools(`frontmatter merge /nonexistent/file.md --data '{"phase":"01"}' --json`);
    assert.ok(result.success, 'Command should exit 0 with error JSON');
    const parsed = JSON.parse(result.output);
    assert.ok(parsed.error, 'Should have error field');
  });

  test('returns error for invalid JSON data', () => {
    const file = writeTempFile('---\nphase: 01\n---\nbody');
    const result = runGsdTools(`frontmatter merge ${file} --data 'not json'`);
    // cmdFrontmatterMerge calls error() which exits with code 1
    assert.ok(!result.success, 'Command should fail with non-zero exit code');
    assert.ok(result.error.includes('Invalid JSON'), 'Error should mention invalid JSON');
  });
});

// ─── frontmatter validate ───────────────────────────────────────────────────

describe('frontmatter validate', () => {
  test('reports valid for complete plan frontmatter', () => {
    const content = `---
phase: 01
plan: 01
type: execute
wave: 1
depends_on: []
files_modified: [src/auth.ts]
autonomous: true
must_haves:
  truths:
    - "All tests pass"
---
body`;
    const file = writeTempFile(content);
    const result = runGsdTools(`frontmatter validate ${file} --schema plan --json`);
    assert.ok(result.success, `Command failed: ${result.error}`);
    const parsed = JSON.parse(result.output);
    assert.strictEqual(parsed.valid, true, 'Should be valid');
    assert.deepStrictEqual(parsed.missing, [], 'No fields should be missing');
    assert.strictEqual(parsed.schema, 'plan');
  });

  test('reports invalid with missing fields', () => {
    const file = writeTempFile('---\nphase: 01\n---\nbody');
    const result = runGsdTools(`frontmatter validate ${file} --schema plan --json`);
    assert.ok(result.success, `Command failed: ${result.error}`);
    const parsed = JSON.parse(result.output);
    assert.strictEqual(parsed.valid, false, 'Should be invalid');
    assert.ok(parsed.missing.length > 0, 'Should have missing fields');
    // plan schema requires: phase, plan, type, wave, depends_on, files_modified, autonomous, must_haves
    // phase is present, so 7 should be missing
    assert.strictEqual(parsed.missing.length, 7, 'Should have 7 missing required fields');
    assert.ok(parsed.missing.includes('plan'), 'plan should be in missing');
    assert.ok(parsed.missing.includes('type'), 'type should be in missing');
    assert.ok(parsed.missing.includes('must_haves'), 'must_haves should be in missing');
  });

  test('validates against summary schema', () => {
    const content = `---
phase: 01
plan: 01
subsystem: testing
tags: [unit-tests, yaml]
duration: 5min
completed: 2026-02-25
---
body`;
    const file = writeTempFile(content);
    const result = runGsdTools(`frontmatter validate ${file} --schema summary --json`);
    assert.ok(result.success, `Command failed: ${result.error}`);
    const parsed = JSON.parse(result.output);
    assert.strictEqual(parsed.valid, true, 'Should be valid for summary schema');
    assert.strictEqual(parsed.schema, 'summary');
  });

  test('validates against verification schema', () => {
    const content = `---
phase: 01
verified: 2026-02-25
status: passed
score: 5/5
---
body`;
    const file = writeTempFile(content);
    const result = runGsdTools(`frontmatter validate ${file} --schema verification --json`);
    assert.ok(result.success, `Command failed: ${result.error}`);
    const parsed = JSON.parse(result.output);
    assert.strictEqual(parsed.valid, true, 'Should be valid for verification schema');
    assert.strictEqual(parsed.schema, 'verification');
  });

  test('returns error for unknown schema', () => {
    const file = writeTempFile('---\nphase: 01\n---\n');
    const result = runGsdTools(`frontmatter validate ${file} --schema unknown`);
    // cmdFrontmatterValidate calls error() which exits with code 1
    assert.ok(!result.success, 'Command should fail with non-zero exit code');
    assert.ok(result.error.includes('Unknown schema'), 'Error should mention unknown schema');
  });

  test('returns error for missing file', () => {
    const result = runGsdTools('frontmatter validate /nonexistent/file.md --schema plan --json');
    assert.ok(result.success, 'Command should exit 0 with error JSON');
    const parsed = JSON.parse(result.output);
    assert.ok(parsed.error, 'Should have error field');
  });
});

// ─── frontmatter get --format newline ───────────────────────────────────────

describe('frontmatter get --format newline', () => {
  test('outputs array values one per line with --format newline', () => {
    const file = writeTempFile('---\ntags:\n  - alpha\n  - beta\n  - gamma\n---\nbody');
    const result = runGsdTools(`frontmatter get ${file} --field tags --format newline`);
    assert.ok(result.success, `Command failed: ${result.error}`);
    assert.strictEqual(result.output, 'alpha\nbeta\ngamma');
  });

  test('passes scalar through unchanged with --format newline', () => {
    const file = writeTempFile('---\ntitle: My Title\n---\nbody');
    const result = runGsdTools(`frontmatter get ${file} --field title --format newline`);
    assert.ok(result.success, `Command failed: ${result.error}`);
    assert.strictEqual(result.output, 'My Title');
  });

  test('comma-separated output without --format flag is backward compatible', () => {
    const file = writeTempFile('---\ntags:\n  - alpha\n  - beta\n  - gamma\n---\nbody');
    const result = runGsdTools(`frontmatter get ${file} --field tags`);
    assert.ok(result.success, `Command failed: ${result.error}`);
    assert.strictEqual(result.output, 'alpha, beta, gamma');
  });

  test('returns JSON object with --format newline and --json', () => {
    const file = writeTempFile('---\ntags:\n  - alpha\n  - beta\n  - gamma\n---\nbody');
    const result = runGsdTools(`frontmatter get ${file} --field tags --format newline --json`);
    assert.ok(result.success, `Command failed: ${result.error}`);
    const parsed = JSON.parse(result.output);
    assert.deepStrictEqual(parsed, { tags: ['alpha', 'beta', 'gamma'] });
  });
});

// ─── frontmatter writers are atomic ─────────────────────────────────────────
//
// set / merge / array-append can all be pointed at STATE.md, and all three used
// a plain writeFileSync, which truncates before it writes: a reader racing the
// write sees an empty file. Routing them through writeFileAtomic replaces the
// target by rename instead, so the old version stays whole and visible until
// the new one is complete.

describe('frontmatter writers replace the file rather than truncating it', () => {
  function assertReplacedNotTruncated(args, initial) {
    const file = writeTempFile(initial);
    const originalIno = fs.statSync(file).ino;
    // An fd opened before the write pins the old inode: after a rename it still
    // reads the whole previous file, after an in-place truncate it does not.
    const held = fs.openSync(file, 'r');
    const result = runGsdTools(args.map((a) => (a === '@file' ? file : a)));
    const heldContent = fs.readFileSync(held, 'utf-8');
    fs.closeSync(held);

    assert.ok(result.success, `Command failed: ${result.error}`);
    assert.notStrictEqual(
      fs.statSync(file).ino,
      originalIno,
      'an in-place truncating write keeps the inode; an atomic replace does not',
    );
    assert.strictEqual(
      heldContent,
      initial,
      'a reader holding the file open must still see the whole previous version',
    );
  }

  test('frontmatter set', () => {
    assertReplacedNotTruncated(
      ['frontmatter', 'set', '@file', '--field', 'status', '--value', 'active'],
      '---\nphase: 01\n---\nbody\n',
    );
  });

  test('frontmatter merge', () => {
    assertReplacedNotTruncated(
      ['frontmatter', 'merge', '@file', '--data', '{"status":"active"}'],
      '---\nphase: 01\n---\nbody\n',
    );
  });

  test('frontmatter array-append', () => {
    assertReplacedNotTruncated(
      [
        'frontmatter',
        'array-append',
        '@file',
        '--field',
        'related',
        '--value',
        'b.md',
      ],
      '---\nrelated:\n  - a.md\n---\nbody\n',
    );
  });
});

// ─── frontmatter set validates field name ────────────────────────────────────

describe('frontmatter set validates field name', () => {
  test('rejects field name with colon (YAML injection)', () => {
    const testFile = writeTempFile('---\nstatus: draft\n---\nContent\n');
    const result = runGsdTools(['frontmatter', 'set', testFile, '--field', 'bad:field', '--value', 'value']);
    assert.ok(!result.success || result.output.includes('Invalid field name'),
      'should reject field name containing colon');
  });
});

// ─── frontmatter get --default flag ─────────────────────────────────────────

describe('frontmatter get --default flag', () => {
  test('returns default value (raw) when file not found', () => {
    const result = runGsdTools('frontmatter get /nonexistent/path/missing.md --field phase --default "notfound"');
    assert.ok(result.success, 'Command should exit 0 with --default');
    assert.strictEqual(result.output, 'notfound', `Expected "notfound", got: ${result.output}`);
  });

  test('returns default value (raw) when field not found', () => {
    const file = writeTempFile('---\nphase: 01\n---\nbody');
    const result = runGsdTools(`frontmatter get ${file} --field nonexistent --default "fallback"`);
    assert.ok(result.success, 'Command should exit 0 with --default');
    assert.strictEqual(result.output, 'fallback', `Expected "fallback", got: ${result.output}`);
  });

  test('returns actual field value when field exists (default unused)', () => {
    const file = writeTempFile('---\nphase: 42\n---\nbody');
    const result = runGsdTools(`frontmatter get ${file} --field phase --default "notused"`);
    assert.ok(result.success, 'Command should succeed');
    assert.strictEqual(result.output, '42', `Expected "42", got: ${result.output}`);
  });

  test('returns default empty string when field not found', () => {
    const file = writeTempFile('---\nphase: 01\n---\nbody');
    const result = runGsdTools(`frontmatter get ${file} --field related --format newline --default ""`);
    assert.ok(result.success, 'Command should exit 0 with empty default');
    assert.strictEqual(result.output, '', `Expected empty string, got: ${result.output}`);
  });

  test('preserves error JSON when no --default flag and field not found', () => {
    const file = writeTempFile('---\nphase: 01\n---\nbody');
    const result = runGsdTools(`frontmatter get ${file} --field nonexistent --json`);
    assert.ok(result.success, 'Command should exit 0');
    const parsed = JSON.parse(result.output);
    assert.ok(parsed.error, 'Should return error object without --default');
  });
});

// ─── the writers and the planning-document locks ────────────────────────────
//
// set / merge / array-append rewrite whatever path they are handed, from a read
// of it. Every workflow points them at a todo, and there they must stay
// lock-free — but nothing stops one being pointed at STATE.md, and an unlocked
// rewrite there discards a concurrent locked writer's append and reports
// success, which is the whole reason the other writers take the lock.

describe('frontmatter writers and the planning-document locks', () => {
  const { spawn } = require('child_process');
  const {
    createTempProject,
    cleanup,
    TOOLS_PATH,
    waitForReadyFlag,
    trackExit,
    waitForExit,
  } = require('./helpers.cjs');

  const LOCK_SIGNAL_PRELOAD = path.join(
    __dirname,
    'fixtures',
    'signal-lock-attempt.cjs',
  );

  let tmpDir;
  let statePath;
  let stateLock;
  let lockFlag;

  // `signalLockAttempt` preloads the fixture that creates lockFlag the moment the
  // child reaches its first lock. The child is the CLI and cannot announce itself,
  // and a timed window in its place has to cover node startup and module load as
  // well as the work — so a slow start observes nothing and passes.
  const runDetached = (args, opts = {}) => {
    const preload = opts.signalLockAttempt
      ? ['--require', LOCK_SIGNAL_PRELOAD]
      : [];
    const child = spawn(
      process.execPath,
      [...preload, TOOLS_PATH, ...args, '--json'],
      {
        cwd: tmpDir,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, GSD_TEST_LOCK_FLAG: lockFlag },
      },
    );
    child._out = '';
    child._err = '';
    child.stdout.on('data', (d) => (child._out += d));
    child.stderr.on('data', (d) => (child._err += d));
    return trackExit(child);
  };

  // A live pid, so the holder is never judged stale and reclaimed.
  const holdLock = (lockPath) => {
    const payload = JSON.stringify({
      pid: process.pid,
      host: require('os').hostname(),
      at: new Date().toISOString(),
    });
    fs.writeFileSync(lockPath, payload);
    return payload;
  };

  beforeEach(() => {
    tmpDir = createTempProject();
    statePath = path.join(tmpDir, '.planning', 'STATE.md');
    stateLock = path.join(tmpDir, '.planning', '.STATE.md.gsd-lock');
    lockFlag = path.join(tmpDir, 'child-at-lock');
    fs.writeFileSync(statePath, '---\nphase: 01\n---\n\n# Project State\n');
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('frontmatter set on STATE.md waits for the state lock', async () => {
    const before = fs.readFileSync(statePath, 'utf-8');
    holdLock(stateLock);

    const child = runDetached(
      [
        'frontmatter',
        'set',
        '.planning/STATE.md',
        '--field',
        'phase',
        '--value',
        '02',
      ],
      { signalLockAttempt: true },
    );

    // From here the child is loaded, dispatched and inside the acquire loop:
    // anything it does before waiting for the lock, it has already done.
    await waitForReadyFlag(lockFlag, 'the child');
    assert.strictEqual(
      fs.readFileSync(statePath, 'utf-8'),
      before,
      'STATE.md was rewritten while another writer held the lock',
    );

    // What the lock holder was in the middle of writing. Waiting for the lock and
    // then rewriting from a read taken before the wait discards all of it and
    // reports success, which is the whole failure the lock exists to stop.
    fs.writeFileSync(
      statePath,
      '---\nphase: 01\nstatus: shipped\n---\n\n# Project State\n\n## Blockers\n\nNone.\n',
    );
    fs.unlinkSync(stateLock);

    const code = await waitForExit(child, 'frontmatter set');
    assert.strictEqual(code, 0, `the write should succeed: ${child._err.trim()}`);
    const after = fs.readFileSync(statePath, 'utf-8');
    assert.match(after, /phase: 02/, 'the write should land once the lock is free');
    assert.match(
      after,
      /status: shipped/,
      'the rewrite must be built from what the lock holder left, not from a read taken before the wait',
    );
    assert.match(
      after,
      /## Blockers/,
      'the body the lock holder wrote must survive the rewrite',
    );
  });

  test('frontmatter merge on REQUIREMENTS.md waits for the requirements lock', async () => {
    const reqPath = path.join(tmpDir, '.planning', 'REQUIREMENTS.md');
    const reqLock = path.join(tmpDir, '.planning', '.REQUIREMENTS.md.gsd-lock');
    fs.writeFileSync(reqPath, '---\nversion: 1\n---\n\n# Requirements\n');
    const before = fs.readFileSync(reqPath, 'utf-8');
    holdLock(reqLock);

    const child = runDetached(
      [
        'frontmatter',
        'merge',
        '.planning/REQUIREMENTS.md',
        '--data',
        '{"status":"active"}',
      ],
      { signalLockAttempt: true },
    );

    await waitForReadyFlag(lockFlag, 'the child');
    assert.strictEqual(
      fs.readFileSync(reqPath, 'utf-8'),
      before,
      'REQUIREMENTS.md was rewritten while another writer held the lock',
    );

    fs.writeFileSync(
      reqPath,
      '---\nversion: 1\nowner: crew\n---\n\n# Requirements\n\n- [ ] REQ-02\n',
    );
    fs.unlinkSync(reqLock);

    const code = await waitForExit(child, 'frontmatter merge');
    assert.strictEqual(code, 0, `the merge should succeed: ${child._err.trim()}`);
    const after = fs.readFileSync(reqPath, 'utf-8');
    assert.match(after, /status: active/, 'the merge should land once the lock is free');
    assert.match(
      after,
      /owner: crew/,
      'the merge must be built from what the lock holder left, not from a read taken before the wait',
    );
    assert.match(
      after,
      /- \[ \] REQ-02/,
      'the body the lock holder wrote must survive the merge',
    );
  });

  test('array-append on ROADMAP.md waits for the roadmap lock', async () => {
    const roadmapPath = path.join(tmpDir, '.planning', 'ROADMAP.md');
    const roadmapLock = path.join(tmpDir, '.planning', '.ROADMAP.md.gsd-lock');
    fs.writeFileSync(roadmapPath, '---\ntags:\n  - one\n---\n\n# Roadmap\n');
    const before = fs.readFileSync(roadmapPath, 'utf-8');
    holdLock(roadmapLock);

    const child = runDetached(
      [
        'frontmatter',
        'array-append',
        '.planning/ROADMAP.md',
        '--field',
        'tags',
        '--value',
        'two',
      ],
      { signalLockAttempt: true },
    );

    await waitForReadyFlag(lockFlag, 'the child');
    assert.strictEqual(
      fs.readFileSync(roadmapPath, 'utf-8'),
      before,
      'ROADMAP.md was rewritten while another writer held the lock',
    );

    // The append the lock holder made. An append composed with it reads
    // [one, held, two]; one built from a read taken before the wait reads
    // [one, two] and the holder's entry is gone.
    fs.writeFileSync(
      roadmapPath,
      '---\ntags:\n  - one\n  - held\n---\n\n# Roadmap\n\n## Phase 2\n',
    );
    fs.unlinkSync(roadmapLock);

    const code = await waitForExit(child, 'frontmatter array-append');
    assert.strictEqual(code, 0, `the write should succeed: ${child._err.trim()}`);
    const after = fs.readFileSync(roadmapPath, 'utf-8');
    assert.match(after, /tags: \[one, held, two\]/);
    assert.match(
      after,
      /## Phase 2/,
      'the body the lock holder wrote must survive the append',
    );
  });

  test('frontmatter set on a todo takes no lock at all', async () => {
    const todoDir = path.join(tmpDir, '.planning', 'todos', 'pending');
    fs.mkdirSync(todoDir, { recursive: true });
    const todo = path.join(todoDir, 'a-todo.md');
    const todoLock = path.join(todoDir, '.a-todo.md.gsd-lock');
    fs.writeFileSync(todo, '---\narea: docs\n---\n\n## Problem\n');

    // Two locks nobody may take, both held for the whole test: the one beside the
    // todo, and the state lock, which is what a todo misclassified as STATE.md
    // would wait for. A writer that took either would spend the acquire budget
    // waiting and exit non-zero instead of writing, so the write landing at all
    // is the evidence that no lock was taken while it happened.
    const todoLockPayload = holdLock(todoLock);
    holdLock(stateLock);

    const child = runDetached([
      'frontmatter',
      'set',
      '.planning/todos/pending/a-todo.md',
      '--field',
      'area',
      '--value',
      'architecture',
    ]);
    const code = await waitForExit(child, 'frontmatter set on a todo');

    assert.strictEqual(code, 0, `the write should succeed: ${child._err.trim()}`);
    assert.match(fs.readFileSync(todo, 'utf-8'), /area: architecture/);
    assert.strictEqual(
      fs.readFileSync(todoLock, 'utf-8'),
      todoLockPayload,
      'the lock beside the todo was taken by a write that must not take one',
    );
    fs.unlinkSync(todoLock);
    fs.unlinkSync(stateLock);
  });
});
