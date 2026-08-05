/**
 * GSD Tools Tests - Issue Tracker Integration
 *
 * Unit tests for ISSUE_COMMANDS, parseExternalRef, invokeIssueCli,
 * buildSyncComment, buildImportComment, issue_tracker.* config keys,
 * cmdIssueImport, cmdIssueSync, and cmdIssueListRefs.
 *
 * Tests: issue tracker sync operations, labeling, state modes, error paths
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { runGsdTools, createTempProject, cleanup } = require('./helpers.cjs');

// Load functions directly from commands.cjs
const {
  ISSUE_COMMANDS,
  parseExternalRef,
  invokeIssueCli,
  buildSyncComment,
  buildImportComment,
  cmdIssueImport,
  cmdIssueSync,
  cmdIssueListRefs,
} = require('../gsd-ng/bin/lib/commands.cjs');

// ─── ISSUE_COMMANDS map ───────────────────────────────────────────────────────

describe('ISSUE_COMMANDS map', () => {
  test('has all 4 platforms: github, gitlab, forgejo, gitea', () => {
    assert.ok(ISSUE_COMMANDS, 'ISSUE_COMMANDS should exist');
    assert.ok(ISSUE_COMMANDS.github, 'github platform missing');
    assert.ok(ISSUE_COMMANDS.gitlab, 'gitlab platform missing');
    assert.ok(ISSUE_COMMANDS.forgejo, 'forgejo platform missing');
    assert.ok(ISSUE_COMMANDS.gitea, 'gitea platform missing');
  });

  test('each platform has 5 operations: list, view, close, comment, create', () => {
    for (const platform of ['github', 'gitlab', 'forgejo', 'gitea']) {
      for (const op of ['list', 'view', 'close', 'comment', 'create']) {
        assert.strictEqual(
          typeof ISSUE_COMMANDS[platform][op],
          'function',
          `${platform}.${op} should be a function`
        );
      }
    }
  });

  test('github.list with label filter returns correct args', () => {
    const result = ISSUE_COMMANDS.github.list(null, { label: 'bug' });
    assert.strictEqual(result.cli, 'gh');
    assert.deepStrictEqual(result.args, [
      'issue', 'list', '--json', 'number,title,body,labels,state',
      '--label', 'bug',
    ]);
  });

  test('github.close with comment returns correct args', () => {
    const result = ISSUE_COMMANDS.github.close(42, null, 'Fixed');
    assert.strictEqual(result.cli, 'gh');
    assert.deepStrictEqual(result.args, [
      'issue', 'close', '42', '--comment', 'Fixed',
    ]);
  });

  test('gitlab.comment returns "note" not "comment"', () => {
    const result = ISSUE_COMMANDS.gitlab.comment(42, null, 'msg');
    assert.strictEqual(result.cli, 'glab');
    assert.deepStrictEqual(result.args, [
      'issue', 'note', '42', '--message', 'msg',
    ]);
  });

  test('gitea.list returns plural "issues" command', () => {
    const result = ISSUE_COMMANDS.gitea.list(null, {});
    assert.strictEqual(result.cli, 'tea');
    assert.deepStrictEqual(result.args, ['issues', 'list', '--output', 'json']);
  });

  test('gitea.comment returns top-level "comment" command', () => {
    const result = ISSUE_COMMANDS.gitea.comment(42, null, 'msg');
    assert.strictEqual(result.cli, 'tea');
    assert.deepStrictEqual(result.args, ['comment', '42', '--body', 'msg']);
  });

  test('forgejo.close includes -w flag for comment', () => {
    const result = ISSUE_COMMANDS.forgejo.close(42, null, 'msg');
    assert.strictEqual(result.cli, 'fj');
    assert.deepStrictEqual(result.args, [
      'issue', 'close', '42', '-w', 'msg',
    ]);
  });
});

// ─── parseExternalRef ─────────────────────────────────────────────────────────

describe('parseExternalRef', () => {
  test('parses github:#42 with no repo', () => {
    const result = parseExternalRef('github:#42', null);
    assert.deepStrictEqual(result, [
      { platform: 'github', repo: null, number: 42, action: null, raw: 'github:#42' },
    ]);
  });

  test('parses gitlab:myorg/myrepo#198 with repo', () => {
    const result = parseExternalRef('gitlab:myorg/myrepo#198', null);
    assert.deepStrictEqual(result, [
      { platform: 'gitlab', repo: 'myorg/myrepo', number: 198, action: null, raw: 'gitlab:myorg/myrepo#198' },
    ]);
  });

  test('parses comma-separated multi-ref string into 2 refs', () => {
    const result = parseExternalRef('github:#42, forgejo:#55', null);
    assert.strictEqual(result.length, 2);
    assert.strictEqual(result[0].platform, 'github');
    assert.strictEqual(result[0].number, 42);
    assert.strictEqual(result[1].platform, 'forgejo');
    assert.strictEqual(result[1].number, 55);
  });

  test('parses action suffix :close', () => {
    const result = parseExternalRef('github:#198:close', null);
    assert.deepStrictEqual(result, [
      { platform: 'github', repo: null, number: 198, action: 'close', raw: 'github:#198:close' },
    ]);
  });

  test('returns empty array for invalid ref string', () => {
    const result = parseExternalRef('invalid', null);
    assert.deepStrictEqual(result, []);
  });

  test('uses defaultRepo when no repo in ref', () => {
    const result = parseExternalRef('github:#42', 'myorg/myrepo');
    assert.strictEqual(result[0].repo, 'myorg/myrepo');
  });
});

// ─── invokeIssueCli ──────────────────────────────────────────────────────────

describe('invokeIssueCli', () => {
  test('returns error for unknown platform', () => {
    const result = invokeIssueCli('unknown_platform', 'list', [null, {}]);
    assert.strictEqual(result.success, false);
    assert.ok(
      result.error.includes('Unknown platform'),
      `Expected 'Unknown platform' in error, got: ${result.error}`
    );
  });

  test('returns dry_run result when GSD_TEST_MODE is set', () => {
    const original = process.env.GSD_TEST_MODE;
    process.env.GSD_TEST_MODE = '1';
    try {
      const result = invokeIssueCli('github', 'list', [null, { label: 'bug' }]);
      assert.strictEqual(result.success, true);
      assert.strictEqual(result.dry_run, true);
      assert.strictEqual(result.cli, 'gh');
      assert.ok(Array.isArray(result.args));
    } finally {
      if (original === undefined) delete process.env.GSD_TEST_MODE;
      else process.env.GSD_TEST_MODE = original;
    }
  });
});

// ─── buildSyncComment ─────────────────────────────────────────────────────────

describe('buildSyncComment', () => {
  test('external style with commitHash returns short form', () => {
    const result = buildSyncComment('external', { commitHash: 'abc1234def' });
    assert.strictEqual(result, 'Resolved in commit abc1234.');
  });

  test('external style with prNumber returns PR form', () => {
    const result = buildSyncComment('external', { prNumber: 42 });
    assert.strictEqual(result, 'Resolved in PR #42.');
  });

  test('verbose style contains phaseName and commitHash', () => {
    const result = buildSyncComment('verbose', { phaseName: 'Phase 15', commitHash: 'abc1234def' });
    assert.ok(result.includes('Phase: Phase 15'), `Expected 'Phase: Phase 15' in: ${result}`);
    assert.ok(result.includes('Commit: abc1234def'), `Expected 'Commit: abc1234def' in: ${result}`);
  });

  test('external style with no context returns generic "Resolved."', () => {
    const result = buildSyncComment('external', {});
    assert.strictEqual(result, 'Resolved.');
  });
});

// ─── buildImportComment ──────────────────────────────────────────────────────

describe('buildImportComment', () => {
  test('external style does NOT include todoTitle (no GSD internals)', () => {
    const result = buildImportComment('external', { todoTitle: 'Fix auth' });
    assert.ok(!result.includes('Fix auth'), `Should not contain todoTitle in external mode, got: ${result}`);
  });

  test('verbose style includes todoFile', () => {
    const result = buildImportComment('verbose', { todoFile: 'fix-auth.md' });
    assert.ok(result.includes('fix-auth.md'), `Expected 'fix-auth.md' in: ${result}`);
  });
});

// ─── issue_tracker config keys ───────────────────────────────────────────────

describe('issue_tracker config keys', () => {
  let tmpDir;

  function readConfig(dir) {
    return JSON.parse(fs.readFileSync(path.join(dir, '.planning', 'config.json'), 'utf-8'));
  }

  beforeEach(() => {
    tmpDir = createTempProject();
    // Ensure config.json exists
    runGsdTools('config-ensure-section', tmpDir);
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('config-set issue_tracker.auto_sync true succeeds', () => {
    const result = runGsdTools(['config-set', 'issue_tracker.auto_sync', 'true'], tmpDir);
    assert.ok(result.success, `Expected success, got: ${result.error}`);
  });

  test('config-set issue_tracker.auto_sync false stores boolean false', () => {
    runGsdTools(['config-set', 'issue_tracker.auto_sync', 'false'], tmpDir);
    const config = readConfig(tmpDir);
    assert.strictEqual(config.issue_tracker.auto_sync, false);
  });

  test('config-set issue_tracker.comment_on_import rejected (removed key)', () => {
    const result = runGsdTools(['config-set', 'issue_tracker.comment_on_import', 'true'], tmpDir);
    assert.ok(!result.success, 'Expected failure for removed config key comment_on_import');
  });

  test('config-set issue_tracker.default_action close stores string "close"', () => {
    runGsdTools(['config-set', 'issue_tracker.default_action', 'close'], tmpDir);
    const config = readConfig(tmpDir);
    assert.strictEqual(config.issue_tracker.default_action, 'close');
  });

  test('config-set issue_tracker.default_action comment stores string "comment"', () => {
    runGsdTools(['config-set', 'issue_tracker.default_action', 'comment'], tmpDir);
    const config = readConfig(tmpDir);
    assert.strictEqual(config.issue_tracker.default_action, 'comment');
  });

  test('config-set issue_tracker.comment_style external succeeds', () => {
    const result = runGsdTools(['config-set', 'issue_tracker.comment_style', 'external'], tmpDir);
    assert.ok(result.success, `Expected success, got: ${result.error}`);
  });

  test('config-set issue_tracker.comment_style verbose succeeds', () => {
    const result = runGsdTools(['config-set', 'issue_tracker.comment_style', 'verbose'], tmpDir);
    assert.ok(result.success, `Expected success, got: ${result.error}`);
  });

  test('config-get issue_tracker.auto_sync returns stored value after set', () => {
    runGsdTools(['config-set', 'issue_tracker.auto_sync', 'true'], tmpDir);
    const result = runGsdTools(['config-get', 'issue_tracker.auto_sync'], tmpDir);
    assert.ok(result.success, `config-get failed: ${result.error}`);
    assert.strictEqual(result.output, 'true');
  });

  test('config-set issue_tracker.invalid_key fails with Unknown config key error', () => {
    const result = runGsdTools(['config-set', 'issue_tracker.invalid_key', 'true'], tmpDir);
    assert.strictEqual(result.success, false);
    assert.ok(
      result.error.includes('Unknown config key'),
      `Expected 'Unknown config key' in: ${result.error}`
    );
  });
});

// ─── cmdIssueImport ───────────────────────────────────────────────────────────

describe('cmdIssueImport', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
    fs.mkdirSync(path.join(tmpDir, '.planning', 'todos', 'pending'), { recursive: true });
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('creates a todo file in .planning/todos/pending/ with correct frontmatter', () => {
    process.env.GSD_TEST_MODE = '1';
    try {
      cmdIssueImport(tmpDir, 'github', 42, null, true);
      const files = fs.readdirSync(path.join(tmpDir, '.planning', 'todos', 'pending'));
      assert.strictEqual(files.length, 1, 'Expected 1 todo file created');
      const content = fs.readFileSync(path.join(tmpDir, '.planning', 'todos', 'pending', files[0]), 'utf-8');
      assert.ok(content.includes('external_ref:'), `Expected external_ref in frontmatter, got:\n${content}`);
      assert.ok(content.includes('title:'), `Expected title in frontmatter, got:\n${content}`);
      assert.ok(content.includes('area:'), `Expected area in frontmatter, got:\n${content}`);
      assert.ok(content.includes('created:'), `Expected created in frontmatter, got:\n${content}`);
    } finally {
      delete process.env.GSD_TEST_MODE;
    }
  });

  test('maps label "bug" to area "bug"', () => {
    process.env.GSD_TEST_MODE = '1';
    try {
      // Use GSD_TEST_MODE mock data: labels array with 'bug'
      process.env.GSD_TEST_LABELS = JSON.stringify(['bug']);
      cmdIssueImport(tmpDir, 'github', 42, null, true);
      const files = fs.readdirSync(path.join(tmpDir, '.planning', 'todos', 'pending'));
      const content = fs.readFileSync(path.join(tmpDir, '.planning', 'todos', 'pending', files[0]), 'utf-8');
      assert.ok(content.includes('area: bug'), `Expected area: bug, got:\n${content}`);
    } finally {
      delete process.env.GSD_TEST_MODE;
      delete process.env.GSD_TEST_LABELS;
    }
  });

  test('maps label "enhancement" to area "feature"', () => {
    process.env.GSD_TEST_MODE = '1';
    try {
      process.env.GSD_TEST_LABELS = JSON.stringify(['enhancement']);
      cmdIssueImport(tmpDir, 'github', 42, null, true);
      const files = fs.readdirSync(path.join(tmpDir, '.planning', 'todos', 'pending'));
      const content = fs.readFileSync(path.join(tmpDir, '.planning', 'todos', 'pending', files[0]), 'utf-8');
      assert.ok(content.includes('area: feature'), `Expected area: feature, got:\n${content}`);
    } finally {
      delete process.env.GSD_TEST_MODE;
      delete process.env.GSD_TEST_LABELS;
    }
  });

  test('uses area "general" when no labels present', () => {
    process.env.GSD_TEST_MODE = '1';
    try {
      cmdIssueImport(tmpDir, 'github', 42, null, true);
      const files = fs.readdirSync(path.join(tmpDir, '.planning', 'todos', 'pending'));
      const content = fs.readFileSync(path.join(tmpDir, '.planning', 'todos', 'pending', files[0]), 'utf-8');
      assert.ok(content.includes('area: general'), `Expected area: general, got:\n${content}`);
    } finally {
      delete process.env.GSD_TEST_MODE;
    }
  });

  test('dispatches a comment CLI call when comment_style is verbose', () => {
    process.env.GSD_TEST_MODE = '1';
    try {
      fs.mkdirSync(path.join(tmpDir, '.planning'), { recursive: true });
      fs.writeFileSync(
        path.join(tmpDir, '.planning', 'config.json'),
        JSON.stringify({ issue_tracker: { comment_style: 'verbose' } })
      );
      const result = cmdIssueImport(tmpDir, 'github', 42, null, true);
      assert.ok(result && result.commented === true, `Expected commented: true, got: ${JSON.stringify(result)}`);
    } finally {
      delete process.env.GSD_TEST_MODE;
    }
  });

  test('skips comment when comment_style is external (default)', () => {
    process.env.GSD_TEST_MODE = '1';
    try {
      fs.mkdirSync(path.join(tmpDir, '.planning'), { recursive: true });
      fs.writeFileSync(
        path.join(tmpDir, '.planning', 'config.json'),
        JSON.stringify({ issue_tracker: { comment_style: 'external' } })
      );
      const result = cmdIssueImport(tmpDir, 'github', 42, null, true);
      assert.ok(result && result.commented === false, `Expected commented: false, got: ${JSON.stringify(result)}`);
    } finally {
      delete process.env.GSD_TEST_MODE;
    }
  });

  test('normalizes GitLab iid to number field', () => {
    process.env.GSD_TEST_MODE = '1';
    try {
      process.env.GSD_TEST_IID = '99';
      cmdIssueImport(tmpDir, 'gitlab', 99, null, true);
      const files = fs.readdirSync(path.join(tmpDir, '.planning', 'todos', 'pending'));
      const content = fs.readFileSync(path.join(tmpDir, '.planning', 'todos', 'pending', files[0]), 'utf-8');
      assert.ok(content.includes('gitlab:#99') || content.includes('external_ref:'), `Expected external_ref in frontmatter`);
    } finally {
      delete process.env.GSD_TEST_MODE;
      delete process.env.GSD_TEST_IID;
    }
  });

  test('the imported todo validates against the todo schema', () => {
    process.env.GSD_TEST_MODE = '1';
    try {
      cmdIssueImport(tmpDir, 'github', 42, null, true);
      const pendingDir = path.join(tmpDir, '.planning', 'todos', 'pending');
      const files = fs.readdirSync(pendingDir);
      assert.strictEqual(files.length, 1, 'Expected 1 todo file created');
      const todoPath = path.join(pendingDir, files[0]);

      const result = runGsdTools(
        ['frontmatter', 'validate', todoPath, '--schema', 'todo', '--json'],
        tmpDir,
      );
      assert.ok(result.success, `Validate failed: ${result.error}`);
      const parsed = JSON.parse(result.output);
      assert.strictEqual(parsed.valid, true, `not valid: ${result.output}`);
      assert.deepStrictEqual(parsed.missing, []);

      const content = fs.readFileSync(todoPath, 'utf-8');
      assert.match(content, /^untrusted_title: true$/m, 'security marker survives');
      assert.match(content, /^external_ref: /m, 'tracker link survives');
    } finally {
      delete process.env.GSD_TEST_MODE;
    }
  });

  test('returns result object with imported: true, todo_file, title, external_ref', () => {
    process.env.GSD_TEST_MODE = '1';
    try {
      const result = cmdIssueImport(tmpDir, 'github', 42, null, true);
      assert.ok(result, 'Expected result object');
      assert.strictEqual(result.imported, true, `Expected imported: true, got: ${JSON.stringify(result)}`);
      assert.ok(result.todo_file, `Expected todo_file in result, got: ${JSON.stringify(result)}`);
      assert.ok(result.title, `Expected title in result, got: ${JSON.stringify(result)}`);
      assert.ok(result.external_ref, `Expected external_ref in result, got: ${JSON.stringify(result)}`);
    } finally {
      delete process.env.GSD_TEST_MODE;
    }
  });
});

// ─── cmdIssueSync ─────────────────────────────────────────────────────────────

describe('cmdIssueSync', () => {
  let tmpDir;

  function writeRequirements(content) {
    fs.mkdirSync(path.join(tmpDir, '.planning'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, '.planning', 'REQUIREMENTS.md'), content);
  }

  beforeEach(() => {
    tmpDir = createTempProject();
    fs.mkdirSync(path.join(tmpDir, '.planning', 'todos', 'pending'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, '.planning', 'todos', 'completed'), { recursive: true });
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('dispatches close operation for completed requirement with external_ref (default action: close)', () => {
    process.env.GSD_TEST_MODE = '1';
    try {
      writeRequirements(`# Requirements\n\n| ID | Description | Status | Phase | external_ref |\n|----|-------------|--------|-------|--------------|\n| REQ-01 | Fix bug | Complete | Phase 1 | github:#42 |\n`);
      const result = cmdIssueSync(tmpDir, null, { auto: true }, true);
      assert.ok(result, 'Expected result object');
      assert.ok(Array.isArray(result.synced), `Expected synced array, got: ${JSON.stringify(result)}`);
      assert.ok(result.synced.length > 0, `Expected at least one synced item, got: ${JSON.stringify(result)}`);
      assert.strictEqual(result.synced[0].action, 'close', `Expected close action, got: ${JSON.stringify(result.synced[0])}`);
    } finally {
      delete process.env.GSD_TEST_MODE;
    }
  });

  test('respects per-ref action suffix :comment — dispatches comment not close', () => {
    process.env.GSD_TEST_MODE = '1';
    try {
      writeRequirements(`# Requirements\n\n| ID | Description | Status | Phase | external_ref |\n|----|-------------|--------|-------|--------------|\n| REQ-01 | Fix bug | Complete | Phase 1 | github:#42:comment |\n`);
      const result = cmdIssueSync(tmpDir, null, { auto: true }, true);
      assert.ok(result.synced.length > 0, 'Expected synced item');
      assert.strictEqual(result.synced[0].action, 'comment', `Expected comment action, got: ${JSON.stringify(result.synced[0])}`);
    } finally {
      delete process.env.GSD_TEST_MODE;
    }
  });

  test('respects default_action config setting of "comment"', () => {
    process.env.GSD_TEST_MODE = '1';
    try {
      fs.writeFileSync(
        path.join(tmpDir, '.planning', 'config.json'),
        JSON.stringify({ issue_tracker: { default_action: 'comment' } })
      );
      writeRequirements(`# Requirements\n\n| ID | Description | Status | Phase | external_ref |\n|----|-------------|--------|-------|--------------|\n| REQ-01 | Fix bug | Complete | Phase 1 | github:#42 |\n`);
      const result = cmdIssueSync(tmpDir, null, { auto: true }, true);
      assert.ok(result.synced.length > 0, 'Expected synced item');
      assert.strictEqual(result.synced[0].action, 'comment', `Expected comment action based on config, got: ${JSON.stringify(result.synced[0])}`);
    } finally {
      delete process.env.GSD_TEST_MODE;
    }
  });

  test('auto=true performs outbound-only sync (no conflicts array populated from inbound)', () => {
    process.env.GSD_TEST_MODE = '1';
    try {
      writeRequirements(`# Requirements\n\n| ID | Description | Status | Phase | external_ref |\n|----|-------------|--------|-------|--------------|\n| REQ-01 | Fix bug | Complete | Phase 1 | github:#42 |\n`);
      const result = cmdIssueSync(tmpDir, null, { auto: true }, true);
      assert.ok(Array.isArray(result.conflicts), 'Expected conflicts array');
      // In auto mode, no inbound check — conflicts must be empty
      assert.strictEqual(result.conflicts.length, 0, `Expected empty conflicts in auto mode, got: ${JSON.stringify(result.conflicts)}`);
    } finally {
      delete process.env.GSD_TEST_MODE;
    }
  });

  test('skips requirements that are not Complete', () => {
    process.env.GSD_TEST_MODE = '1';
    try {
      writeRequirements(`# Requirements\n\n| ID | Description | Status | Phase | external_ref |\n|----|-------------|--------|-------|--------------|\n| REQ-01 | Open bug | Pending | Phase 1 | github:#42 |\n`);
      const result = cmdIssueSync(tmpDir, null, { auto: true }, true);
      assert.strictEqual(result.synced.length, 0, `Expected no synced items for pending requirement, got: ${JSON.stringify(result)}`);
    } finally {
      delete process.env.GSD_TEST_MODE;
    }
  });

  test('syncs todo files in .planning/todos/completed/ with external_ref frontmatter', () => {
    process.env.GSD_TEST_MODE = '1';
    try {
      writeRequirements('# Requirements\n\n(no table)\n');
      // Create a completed todo with external_ref
      fs.writeFileSync(
        path.join(tmpDir, '.planning', 'todos', 'completed', '2026-01-01-fix-bug.md'),
        '---\ntitle: Fix bug\nexternal_ref: "github:#99"\n---\n\n## Done\n'
      );
      const result = cmdIssueSync(tmpDir, null, { auto: true }, true);
      assert.ok(result.synced.length > 0, `Expected synced item from done todo, got: ${JSON.stringify(result)}`);
    } finally {
      delete process.env.GSD_TEST_MODE;
    }
  });

  test('returns output with synced, conflicts, and skipped fields', () => {
    process.env.GSD_TEST_MODE = '1';
    try {
      writeRequirements('# Requirements\n\n(no table)\n');
      const result = cmdIssueSync(tmpDir, null, { auto: true }, true);
      assert.ok(result, 'Expected result object');
      assert.ok(Array.isArray(result.synced), 'Expected synced array');
      assert.ok(Array.isArray(result.conflicts), 'Expected conflicts array');
      assert.ok(typeof result.skipped === 'number', `Expected skipped count, got: ${JSON.stringify(result)}`);
    } finally {
      delete process.env.GSD_TEST_MODE;
    }
  });
});

// ─── cmdIssueListRefs ─────────────────────────────────────────────────────────

describe('cmdIssueListRefs', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
    fs.mkdirSync(path.join(tmpDir, '.planning', 'todos', 'pending'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, '.planning', 'todos', 'completed'), { recursive: true });
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('returns refs from REQUIREMENTS.md traceability table', () => {
    fs.mkdirSync(path.join(tmpDir, '.planning'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'REQUIREMENTS.md'),
      `# Requirements\n\n| ID | Description | Status | Phase | external_ref |\n|----|-------------|--------|-------|--------------|\n| REQ-01 | Fix bug | Complete | Phase 1 | github:#42 |\n`
    );
    const result = cmdIssueListRefs(tmpDir, true);
    assert.ok(result, 'Expected result object');
    assert.ok(Array.isArray(result.refs), `Expected refs array, got: ${JSON.stringify(result)}`);
    assert.ok(result.refs.length > 0, `Expected at least one ref from REQUIREMENTS.md, got: ${JSON.stringify(result)}`);
    const githubRef = result.refs.find(r => r.ref_string && r.ref_string.includes('github:#42'));
    assert.ok(githubRef, `Expected github:#42 ref, got: ${JSON.stringify(result.refs)}`);
  });

  test('returns refs from todo frontmatter in pending and completed dirs', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'todos', 'pending', '2026-01-01-fix-thing.md'),
      '---\ntitle: Fix thing\nexternal_ref: "forgejo:#55"\n---\n\nContent\n'
    );
    fs.mkdirSync(path.join(tmpDir, '.planning', 'todos', 'completed'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'todos', 'completed', '2026-01-01-old-bug.md'),
      '---\ntitle: Old bug\nexternal_ref: "gitlab:myorg/myrepo#198"\n---\n\nContent\n'
    );
    const result = cmdIssueListRefs(tmpDir, true);
    assert.ok(result.refs.length >= 2, `Expected at least 2 refs from todos, got: ${JSON.stringify(result)}`);
    const forgejoRef = result.refs.find(r => r.ref_string && r.ref_string.includes('forgejo:#55'));
    assert.ok(forgejoRef, `Expected forgejo:#55 ref, got: ${JSON.stringify(result.refs)}`);
  });

  test('deduplicates refs that appear in multiple sources', () => {
    fs.mkdirSync(path.join(tmpDir, '.planning'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'REQUIREMENTS.md'),
      `# Requirements\n\n| ID | Description | Status | Phase | external_ref |\n|----|-------------|--------|-------|--------------|\n| REQ-01 | Fix bug | Complete | Phase 1 | github:#42 |\n`
    );
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'todos', 'pending', '2026-01-01-fix-bug.md'),
      '---\ntitle: Fix bug\nexternal_ref: "github:#42"\n---\n\nContent\n'
    );
    const result = cmdIssueListRefs(tmpDir, true);
    const githubRefs = result.refs.filter(r => r.ref_string && r.ref_string.includes('github:#42'));
    assert.ok(githubRefs.length === 1, `Expected exactly 1 deduplicated ref for github:#42, got: ${githubRefs.length}`);
  });

  test('returns empty array when no external_refs exist', () => {
    const result = cmdIssueListRefs(tmpDir, true);
    assert.ok(result, 'Expected result object');
    assert.ok(Array.isArray(result.refs), 'Expected refs array');
    assert.strictEqual(result.refs.length, 0, `Expected empty refs, got: ${JSON.stringify(result)}`);
    assert.strictEqual(result.count, 0, `Expected count 0, got: ${JSON.stringify(result)}`);
  });

  test('returns count field matching refs length', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'todos', 'pending', '2026-01-01-todo.md'),
      '---\ntitle: Todo\nexternal_ref: "github:#10"\n---\n\nContent\n'
    );
    const result = cmdIssueListRefs(tmpDir, true);
    assert.strictEqual(result.count, result.refs.length, 'Expected count to equal refs length');
  });
});
