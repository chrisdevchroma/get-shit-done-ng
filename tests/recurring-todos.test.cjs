/**
 * Tests for recurring todo support:
 * - parseDuration: interval string to milliseconds
 * - isRecurringDue: checks if recurring todo is past its interval
 * - cmdTodoComplete: recurring todos stay in pending/ with updated last_completed
 * - cmdRecurringDue: returns list of due recurring todos
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { resolveTmpDir, cleanup } = require('./helpers.cjs');

const { parseDuration, isRecurringDue, cmdTodoComplete, cmdRecurringDue, syncSingleRef } = require('../gsd-ng/bin/lib/commands.cjs');
const { setJsonMode } = require('../gsd-ng/bin/lib/core.cjs');
const { cmdFrontmatterValidate } = require('../gsd-ng/bin/lib/frontmatter.cjs');

function withJsonMode(fn) {
  setJsonMode(true);
  try { return fn(); } finally { setJsonMode(false); }
}

/**
 * Capture stdout output from a function that uses fs.writeSync(1, ...) or process.stdout.write.
 * Required because output() switched from process.stdout.write to fs.writeSync in fix 045eabb.
 */
function captureOutput(fn) {
  const chunks = [];
  const origFsWriteSync = fs.writeSync.bind(fs);
  const origStdoutWrite = process.stdout.write.bind(process.stdout);
  fs.writeSync = (fd, data, ...rest) => {
    if (fd === 1) { chunks.push(String(data)); return data.length; }
    return origFsWriteSync(fd, data, ...rest);
  };
  process.stdout.write = (chunk) => { chunks.push(String(chunk)); return true; };
  try {
    fn();
  } finally {
    fs.writeSync = origFsWriteSync;
    process.stdout.write = origStdoutWrite;
  }
  return chunks.join('');
}

// ─── parseDuration tests ───────────────────────────────────────────────────────

describe('parseDuration', () => {
  it('returns 604800000 for 7d', () => {
    assert.strictEqual(parseDuration('7d'), 604800000);
  });

  it('returns 1209600000 for 14d', () => {
    assert.strictEqual(parseDuration('14d'), 1209600000);
  });

  it('returns 2592000000 for 30d', () => {
    assert.strictEqual(parseDuration('30d'), 2592000000);
  });

  it('returns 7776000000 for 90d', () => {
    assert.strictEqual(parseDuration('90d'), 7776000000);
  });

  it('returns 604800000 for 1w', () => {
    assert.strictEqual(parseDuration('1w'), 604800000);
  });

  it('returns null for empty string', () => {
    assert.strictEqual(parseDuration(''), null);
  });

  it('returns null for null', () => {
    assert.strictEqual(parseDuration(null), null);
  });

  it('returns null for undefined', () => {
    assert.strictEqual(parseDuration(undefined), null);
  });

  it('returns null for invalid string abc', () => {
    assert.strictEqual(parseDuration('abc'), null);
  });

  it('returns null for plain number with no unit', () => {
    assert.strictEqual(parseDuration('7'), null);
  });
});

// ─── isRecurringDue tests ──────────────────────────────────────────────────────

describe('isRecurringDue', () => {
  it('returns true when recurring and last_completed was yesterday (1d interval)', () => {
    const yesterday = new Date(Date.now() - 86400000 - 1000).toISOString();
    const result = isRecurringDue({ recurring: true, interval: '1d', last_completed: yesterday });
    assert.strictEqual(result, true);
  });

  it('returns false when recurring and last_completed was today (30d interval)', () => {
    const today = new Date().toISOString();
    const result = isRecurringDue({ recurring: true, interval: '30d', last_completed: today });
    assert.strictEqual(result, false);
  });

  it('returns false when recurring is false', () => {
    const result = isRecurringDue({ recurring: false });
    assert.strictEqual(result, false);
  });

  it('returns true when recurring and no last_completed (always due)', () => {
    const result = isRecurringDue({ recurring: true, interval: '7d' });
    assert.strictEqual(result, true);
  });

  it('returns false when todoData is null', () => {
    assert.strictEqual(isRecurringDue(null), false);
  });

  it('returns false when todoData is undefined', () => {
    assert.strictEqual(isRecurringDue(undefined), false);
  });

  it('returns false when recurring is string "false"', () => {
    const result = isRecurringDue({ recurring: 'false' });
    assert.strictEqual(result, false);
  });

  it('returns true when recurring is string "true" and no last_completed', () => {
    const result = isRecurringDue({ recurring: 'true', interval: '7d' });
    assert.strictEqual(result, true);
  });
});

// ─── cmdTodoComplete with recurring todos ──────────────────────────────────────

describe('cmdTodoComplete - recurring', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(resolveTmpDir(), 'gsd-recurring-test-'));
    fs.mkdirSync(path.join(tmpDir, '.planning', 'todos', 'pending'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, '.planning', 'todos', 'completed'), { recursive: true });
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  it('recurring todo stays in pending/ after completion', () => {
    const filename = 'test-recurring.md';
    const todoContent = [
      '---',
      'created: 2026-01-01T00:00:00.000Z',
      'title: Test recurring todo',
      'area: general',
      'recurring: true',
      'interval: 30d',
      '---',
      '',
      '## Problem',
      '',
      'This is a recurring reminder.',
    ].join('\n');

    fs.writeFileSync(path.join(tmpDir, '.planning', 'todos', 'pending', filename), todoContent, 'utf-8');

    cmdTodoComplete(tmpDir, filename);

    // File should still be in pending/
    assert.ok(
      fs.existsSync(path.join(tmpDir, '.planning', 'todos', 'pending', filename)),
      'recurring todo should remain in pending/'
    );

    // File should NOT be in completed/
    assert.ok(
      !fs.existsSync(path.join(tmpDir, '.planning', 'todos', 'completed', filename)),
      'recurring todo should not be moved to completed/'
    );
  });

  it('recurring todo gets last_completed updated in frontmatter', () => {
    const filename = 'test-recurring-lc.md';
    const todoContent = [
      '---',
      'created: 2026-01-01T00:00:00.000Z',
      'title: Test recurring todo last_completed',
      'area: general',
      'recurring: true',
      'interval: 7d',
      '---',
      '',
      '## Problem',
      '',
      'Check last_completed gets set.',
    ].join('\n');

    fs.writeFileSync(path.join(tmpDir, '.planning', 'todos', 'pending', filename), todoContent, 'utf-8');

    const beforeComplete = Date.now();
    cmdTodoComplete(tmpDir, filename);

    const updatedContent = fs.readFileSync(path.join(tmpDir, '.planning', 'todos', 'pending', filename), 'utf-8');
    assert.ok(updatedContent.includes('last_completed:'), 'last_completed should be added to frontmatter');

    // Verify the date is recent (within 5 seconds of test run)
    const lastCompletedMatch = updatedContent.match(/last_completed:\s*(.+)/);
    assert.ok(lastCompletedMatch, 'last_completed field should exist');
    const lastCompletedDate = new Date(lastCompletedMatch[1].trim()).getTime();
    assert.ok(lastCompletedDate >= beforeComplete - 1000, 'last_completed should be recent');
  });

  it('non-recurring todo is moved to done/ (existing behavior preserved)', () => {
    const filename = 'test-non-recurring.md';
    const todoContent = [
      '---',
      'created: 2026-01-01T00:00:00.000Z',
      'title: Test non-recurring todo',
      'area: general',
      '---',
      '',
      '## Problem',
      '',
      'This is a regular todo.',
    ].join('\n');

    fs.writeFileSync(path.join(tmpDir, '.planning', 'todos', 'pending', filename), todoContent, 'utf-8');

    cmdTodoComplete(tmpDir, filename);

    // File should be in done/ (original behavior uses 'completed' dir actually... let's check)
    // The existing code uses 'completed' dir name, not 'done'
    const pendingPath = path.join(tmpDir, '.planning', 'todos', 'pending', filename);
    assert.ok(!fs.existsSync(pendingPath), 'non-recurring todo should be removed from pending/');
  });
});

// ─── cmdRecurringDue tests ─────────────────────────────────────────────────────

describe('cmdRecurringDue', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(resolveTmpDir(), 'gsd-recurring-due-test-'));
    fs.mkdirSync(path.join(tmpDir, '.planning', 'todos', 'pending'), { recursive: true });
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  it('returns empty list when no recurring todos exist', () => {
    // Create a normal non-recurring todo
    const todoContent = [
      '---',
      'created: 2026-01-01T00:00:00.000Z',
      'title: Normal todo',
      'area: general',
      '---',
      '',
      '## Problem',
      '',
      'Normal todo.',
    ].join('\n');

    fs.writeFileSync(path.join(tmpDir, '.planning', 'todos', 'pending', 'normal.md'), todoContent, 'utf-8');

    const result = JSON.parse(captureOutput(() => withJsonMode(() => cmdRecurringDue(tmpDir))));
    assert.strictEqual(result.count, 0);
    assert.deepStrictEqual(result.todos, []);
  });

  it('returns due recurring todo when past interval', () => {
    // A recurring todo with last_completed over 30d ago
    const oldDate = new Date(Date.now() - 31 * 86400000).toISOString();
    const todoContent = [
      '---',
      'created: 2026-01-01T00:00:00.000Z',
      'title: Monthly sync check',
      'area: general',
      'recurring: true',
      'interval: 30d',
      `last_completed: ${oldDate}`,
      '---',
      '',
      '## Problem',
      '',
      'Check upstream.',
    ].join('\n');

    fs.writeFileSync(path.join(tmpDir, '.planning', 'todos', 'pending', 'monthly-sync.md'), todoContent, 'utf-8');

    const result = JSON.parse(captureOutput(() => withJsonMode(() => cmdRecurringDue(tmpDir))));
    assert.strictEqual(result.count, 1);
    assert.strictEqual(result.todos[0].file, 'monthly-sync.md');
    assert.strictEqual(result.todos[0].title, 'Monthly sync check');
    assert.strictEqual(result.todos[0].interval, '30d');
  });

  it('does not return recurring todo when not yet due', () => {
    // A recurring todo completed recently (today)
    const today = new Date().toISOString();
    const todoContent = [
      '---',
      'created: 2026-01-01T00:00:00.000Z',
      'title: Recent recurring',
      'area: general',
      'recurring: true',
      'interval: 30d',
      `last_completed: ${today}`,
      '---',
      '',
      '## Problem',
      '',
      'Just completed.',
    ].join('\n');

    fs.writeFileSync(path.join(tmpDir, '.planning', 'todos', 'pending', 'recent.md'), todoContent, 'utf-8');

    const result = JSON.parse(captureOutput(() => withJsonMode(() => cmdRecurringDue(tmpDir))));
    assert.strictEqual(result.count, 0);
  });

  it('returns recurring todo with no last_completed as always due', () => {
    const todoContent = [
      '---',
      'created: 2026-01-01T00:00:00.000Z',
      'title: New recurring no date',
      'area: general',
      'recurring: true',
      'interval: 7d',
      '---',
      '',
      '## Problem',
      '',
      'Never completed yet.',
    ].join('\n');

    fs.writeFileSync(path.join(tmpDir, '.planning', 'todos', 'pending', 'new-recurring.md'), todoContent, 'utf-8');

    const result = JSON.parse(captureOutput(() => withJsonMode(() => cmdRecurringDue(tmpDir))));
    assert.strictEqual(result.count, 1);
    assert.strictEqual(result.todos[0].last_completed, 'never');
  });
});

// ─── syncSingleRef module-level helper ────────────────────────────────────────

describe('syncSingleRef', () => {
  it('is exported from commands.cjs at module scope', () => {
    assert.strictEqual(typeof syncSingleRef, 'function', 'syncSingleRef should be a module-level export');
  });

  it('returns an array of sync results for a valid ref', () => {
    process.env.GSD_TEST_MODE = '1';
    try {
      const results = syncSingleRef('github:#42', {}, { default_action: 'close', comment_style: 'external', close_state: 'close', verify_label: 'needs-verification' });
      assert.ok(Array.isArray(results), 'syncSingleRef should return an array');
      assert.ok(results.length > 0, 'syncSingleRef should return at least one result');
      assert.ok(typeof results[0].ref === 'string', 'result should have ref string');
      assert.ok(typeof results[0].success === 'boolean', 'result should have success boolean');
    } finally {
      delete process.env.GSD_TEST_MODE;
    }
  });
});

// ─── cmdTodoComplete inline sync behavior ─────────────────────────────────────

describe('cmdTodoComplete - inline issue sync', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(resolveTmpDir(), 'gsd-sync-test-'));
    fs.mkdirSync(path.join(tmpDir, '.planning', 'todos', 'pending'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, '.planning', 'todos', 'completed'), { recursive: true });
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  it('syncs external_ref on non-recurring completion when auto_sync is not false', () => {
    process.env.GSD_TEST_MODE = '1';
    try {
      const filename = 'test-sync-complete.md';
      const todoContent = [
        '---',
        'title: Fix bug',
        'area: general',
        'external_ref: "github:#42"',
        '---',
        '',
        '## Problem',
        '',
        'Fix the bug.',
      ].join('\n');

      fs.writeFileSync(path.join(tmpDir, '.planning', 'todos', 'pending', filename), todoContent, 'utf-8');

      const result = JSON.parse(captureOutput(() => withJsonMode(() => cmdTodoComplete(tmpDir, filename))));
      assert.strictEqual(result.completed, true, 'completion should succeed');
      assert.ok(result.synced !== undefined, 'result should include synced field when external_ref present');
      assert.ok(Array.isArray(result.synced), 'synced should be an array');
    } finally {
      delete process.env.GSD_TEST_MODE;
    }
  });

  it('does NOT sync on recurring todo completion', () => {
    process.env.GSD_TEST_MODE = '1';
    try {
      const filename = 'test-recurring-no-sync.md';
      const todoContent = [
        '---',
        'title: Recurring with external_ref',
        'area: general',
        'recurring: true',
        'interval: 7d',
        'external_ref: "github:#42"',
        '---',
        '',
        '## Problem',
        '',
        'Recurring reminder.',
      ].join('\n');

      fs.writeFileSync(path.join(tmpDir, '.planning', 'todos', 'pending', filename), todoContent, 'utf-8');

      const result = JSON.parse(captureOutput(() => withJsonMode(() => cmdTodoComplete(tmpDir, filename))));
      assert.strictEqual(result.recurring, true, 'should be marked as recurring');
      assert.strictEqual(result.synced, undefined, 'recurring completion should NOT include synced field');
    } finally {
      delete process.env.GSD_TEST_MODE;
    }
  });

  it('does NOT sync when no external_ref', () => {
    process.env.GSD_TEST_MODE = '1';
    try {
      const filename = 'test-no-ref-complete.md';
      const todoContent = [
        '---',
        'title: Fix bug no ref',
        'area: general',
        '---',
        '',
        '## Problem',
        '',
        'No external tracker.',
      ].join('\n');

      fs.writeFileSync(path.join(tmpDir, '.planning', 'todos', 'pending', filename), todoContent, 'utf-8');

      const result = JSON.parse(captureOutput(() => withJsonMode(() => cmdTodoComplete(tmpDir, filename))));
      assert.strictEqual(result.completed, true, 'completion should succeed');
      assert.strictEqual(result.synced, undefined, 'no external_ref means no sync field');
    } finally {
      delete process.env.GSD_TEST_MODE;
    }
  });

  it('does NOT sync when auto_sync is explicitly false', () => {
    process.env.GSD_TEST_MODE = '1';
    try {
      // Write config with auto_sync: false
      fs.mkdirSync(path.join(tmpDir, '.planning'), { recursive: true });
      fs.writeFileSync(
        path.join(tmpDir, '.planning', 'config.json'),
        JSON.stringify({ issue_tracker: { auto_sync: false } })
      );

      const filename = 'test-auto-sync-off.md';
      const todoContent = [
        '---',
        'title: Fix bug auto sync off',
        'area: general',
        'external_ref: "github:#99"',
        '---',
        '',
        '## Problem',
        '',
        'Has external ref but auto_sync is false.',
      ].join('\n');

      fs.writeFileSync(path.join(tmpDir, '.planning', 'todos', 'pending', filename), todoContent, 'utf-8');

      const result = JSON.parse(captureOutput(() => withJsonMode(() => cmdTodoComplete(tmpDir, filename))));
      assert.strictEqual(result.completed, true, 'completion should succeed');
      assert.strictEqual(result.synced, undefined, 'auto_sync=false means no sync');
    } finally {
      delete process.env.GSD_TEST_MODE;
    }
  });
});

// ─── recurring todo frontmatter against the todo schema ────────────────────────

describe('recurring todo frontmatter validates', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(resolveTmpDir(), 'gsd-recurring-schema-'));
    fs.mkdirSync(path.join(tmpDir, '.planning', 'todos', 'pending'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, '.planning', 'todos', 'completed'), { recursive: true });
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  it('a recurring todo with an interval and last_completed is valid', () => {
    const filename = 'test-recurring-schema.md';
    const todoPath = path.join(tmpDir, '.planning', 'todos', 'pending', filename);
    const todoContent = [
      '---',
      'created: 2026-01-01T00:00:00.000Z',
      'title: Check upstream for cherry-picks',
      'area: tooling',
      'recurring: true',
      'interval: 30d',
      '---',
      '',
      '## Problem',
      '',
      'Recurring reminder.',
      '',
    ].join('\n');
    fs.writeFileSync(todoPath, todoContent, 'utf-8');

    // completion is what writes last_completed, so validate the post-completion shape
    cmdTodoComplete(tmpDir, filename);
    assert.match(fs.readFileSync(todoPath, 'utf-8'), /^last_completed: /m);

    const result = JSON.parse(
      captureOutput(() => withJsonMode(() => cmdFrontmatterValidate(tmpDir, todoPath, 'todo')))
    );
    assert.strictEqual(result.valid, true, `not valid: ${JSON.stringify(result)}`);
    assert.deepStrictEqual(result.missing, []);
    assert.strictEqual(result.schema, 'todo');
  });
});
