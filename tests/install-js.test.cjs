'use strict';
const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const crypto = require('crypto');

const INSTALLER = path.resolve(__dirname, '..', 'bin', 'install.js');

const { RUNTIMES } = require('../gsd-ng/bin/lib/template-processor.cjs');
const {
  normalizePermissionRules,
  findUnmatchedPathRules,
} = require('../gsd-ng/bin/lib/allowlist.cjs');

// Resolve a writable temp base — sandbox sets TMPDIR=/tmp/claude which may not exist on disk
const { resolveTmpDir, cleanup, cleanupSubdir } = require('./helpers.cjs');
const BASE_TMPDIR = resolveTmpDir();

const HAS_GH = spawnSync('gh', ['--version'], { timeout: 5000 }).status === 0;
const NO_GH_SKIP =
  'gh is not on PATH — the installer seeds no gh patterns to assert on';

// ── global install uses tilde paths, not absolute home dir ──────────

test('TILDE-01: install.js global install uses tilde paths in workflow files (no PII leak)', () => {
  const tmpDir = fs.mkdtempSync(path.join(BASE_TMPDIR, 'gsd-js-tilde-'));
  try {
    const result = spawnSync(
      process.execPath,
      [INSTALLER, '--runtime', 'claude', '--global'],
      {
        encoding: 'utf8',
        timeout: 15000,
        cwd: tmpDir,
        env: Object.assign({}, process.env, {
          HOME: os.homedir(),
          CLAUDE_CONFIG_DIR: path.join(tmpDir, '.claude'),
        }),
      },
    );

    assert.strictEqual(
      result.status,
      0,
      'install.js --global must exit 0 (TILDE-01)\nstderr: ' +
        (result.stderr || ''),
    );

    const workflowsDir = path.join(tmpDir, '.claude', 'gsd-ng', 'workflows');
    const files = fs.readdirSync(workflowsDir).filter((f) => f.endsWith('.md'));
    assert.ok(files.length > 0, 'workflows dir must contain .md files');

    // Global install must not bake absolute home dir paths (containing username) into files
    const homeDir = os.homedir();
    const badFiles = [];
    for (const fname of files) {
      const content = fs.readFileSync(path.join(workflowsDir, fname), 'utf8');
      // Check for raw absolute home path (not $HOME or ~) — this would be a PII leak
      if (content.includes(homeDir + '/')) {
        badFiles.push(fname);
      }
    }

    assert.ok(
      badFiles.length === 0,
      'install.js global install must not produce absolute home dir paths in workflow files (TILDE-01).\n' +
        'Offending files: ' +
        badFiles.join(', ') +
        '\n' +
        'Home dir: ' +
        homeDir,
    );
  } finally {
    cleanup(tmpDir);
  }
});

// ── banner shows Mode: Uninstall in uninstall mode ──────────────

test('UNINSTALL-01: install.js --uninstall shows Mode: Uninstall indicator in output', () => {
  const tmpDir = fs.mkdtempSync(path.join(BASE_TMPDIR, 'gsd-js-uninstall-'));
  try {
    const result = spawnSync(
      process.execPath,
      [INSTALLER, '--runtime', 'claude', '--global', '--uninstall'],
      {
        encoding: 'utf8',
        timeout: 15000,
        cwd: tmpDir,
        env: Object.assign({}, process.env, {
          HOME: os.homedir(),
          CLAUDE_CONFIG_DIR: path.join(tmpDir, '.claude'),
        }),
      },
    );

    // Uninstall may exit 0 even if directory doesn't exist
    const output = result.stdout || '';
    assert.ok(
      output.includes('Mode: Uninstall'),
      'install.js --uninstall must show "Mode: Uninstall" in output (UNINSTALL-01).\n' +
        'Actual stdout: ' +
        output.slice(0, 500),
    );
  } finally {
    cleanup(tmpDir);
  }
});

// ── local install produces $CLAUDE_PROJECT_DIR paths, not $HOME ──────

test('PATH-03: install.js local install uses $CLAUDE_PROJECT_DIR in workflow bash blocks', () => {
  const tmpDir = fs.mkdtempSync(path.join(BASE_TMPDIR, 'gsd-js-path-local-'));
  try {
    const result = spawnSync(
      process.execPath,
      [INSTALLER, '--runtime', 'claude', '--local'],
      {
        encoding: 'utf8',
        timeout: 15000,
        cwd: tmpDir,
        env: Object.assign({}, process.env, { HOME: os.homedir() }),
      },
    );

    // Non-interactive: exit 0 expected
    assert.strictEqual(
      result.status,
      0,
      'install.js --local must exit 0 (PATH-03)\nstderr: ' +
        (result.stderr || ''),
    );

    const workflowsDir = path.join(tmpDir, '.claude', 'gsd-ng', 'workflows');
    const files = fs.readdirSync(workflowsDir).filter((f) => f.endsWith('.md'));
    assert.ok(files.length > 0, 'workflows dir must contain .md files');

    let badPathFound = false;
    let goodPathFound = false;
    const badFiles = [];
    for (const fname of files) {
      const content = fs.readFileSync(path.join(workflowsDir, fname), 'utf8');
      // Must NOT contain raw $HOME/.claude/ or ~/.claude/ in installed files
      if (
        content.includes('$HOME/.claude/') ||
        content.includes('~/.claude/')
      ) {
        badPathFound = true;
        badFiles.push(fname);
      }
      // Must produce fallback chain path in at least one file
      // New pattern: "${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}/.claude/"
      if (content.includes('${CLAUDE_PROJECT_DIR:-$(git rev-parse')) {
        goodPathFound = true;
      }
    }

    assert.ok(
      !badPathFound,
      'install.js local install must not produce $HOME/.claude/ or ~/.claude/ in workflow files (PATH-03).\n' +
        'Offending files: ' +
        badFiles.join(', '),
    );
    assert.ok(
      goodPathFound,
      'install.js local install must produce fallback chain ${CLAUDE_PROJECT_DIR:-$(git rev-parse...)}/.claude/ in workflow files (PATH-03)',
    );
  } finally {
    cleanup(tmpDir);
  }
});

// ── local install must not produce ./.claude/ relative paths ─────────

test('PATH-04: install.js local install must not produce ./.claude/ paths in bash code blocks', () => {
  const tmpDir = fs.mkdtempSync(path.join(BASE_TMPDIR, 'gsd-js-no-rel-'));
  try {
    const result = spawnSync(
      process.execPath,
      [INSTALLER, '--runtime', 'claude', '--local'],
      {
        encoding: 'utf8',
        timeout: 15000,
        cwd: tmpDir,
        env: Object.assign({}, process.env, { HOME: os.homedir() }),
      },
    );
    assert.strictEqual(result.status, 0, 'install.js --local must exit 0');

    const workflowsDir = path.join(tmpDir, '.claude', 'gsd-ng', 'workflows');
    const files = fs.readdirSync(workflowsDir).filter((f) => f.endsWith('.md'));

    // Look specifically for ./.claude/ in bash code blocks (the regression pattern)
    // The pattern node "./.claude/ is what broke before the fix
    const relativePathPattern = /node\s+"\.\/\.claude\//;
    const badFiles = [];
    for (const fname of files) {
      const content = fs.readFileSync(path.join(workflowsDir, fname), 'utf8');
      if (relativePathPattern.test(content)) {
        badFiles.push(fname);
      }
    }

    assert.ok(
      badFiles.length === 0,
      'install.js local install must not produce node "./.claude/ references in workflow files (PATH-04).\n' +
        'Offending files: ' +
        badFiles.join(', '),
    );
  } finally {
    cleanup(tmpDir);
  }
});

// ── settings-sandbox.json template contains Agent(*), glob Edit(*)/Read(*),
//            no unmatched path forms, no deny rules, subshell builtins.
//
//            Template uses glob macOS forms (Edit(*), Read(*)). install.js
//            down-converts to bare forms on Linux via getReadEditWriteAllowRules().
//            The template allow list is canonicalised, not left per-platform.
//
//            Write(*) is excluded. It is an unmatched path form:
//            file permission checks consult only Edit(path)/Read(path), so Write(*)
//            never matches, and since CC v2.1.210 it emits a startup warning on
//            every macOS/Windows install. Edit(*) already governs every built-in
//            file-editing tool, so the Write tool stays allowed. The two-sided
//            contract is now: glob Edit(*)/Read(*) present, bare forms absent, and
//            NO entry anywhere in the allow list in an unmatched Tool(path) form.

test('PERM-06: settings-sandbox.json template contains Agent(*), glob Edit(*)/Read(*), no unmatched path forms, excludes bare Edit/Write/Read, no deny rules, subshell builtins', () => {
  const templatePath = path.resolve(
    __dirname,
    '..',
    'gsd-ng',
    'templates',
    'settings-sandbox.json',
  );
  const template = JSON.parse(fs.readFileSync(templatePath, 'utf8'));
  const allow = template.permissions.allow;
  assert.ok(allow.includes('Agent(*)'), 'template must include Agent(*)');
  // Template ships canonical macOS form; install.js down-converts to bare on Linux.
  assert.ok(
    allow.includes('Edit(*)'),
    'template must include canonical Edit(*) (down-converted to bare Edit on Linux at install time)',
  );
  assert.ok(
    !allow.includes('Write(*)'),
    'template must NOT include Write(*) — an unmatched path form that never fires and ' +
      'emits a CC >= 2.1.210 startup warning. Edit(*) already covers the Write tool.',
  );
  assert.ok(
    allow.includes('Read(*)'),
    'template must include canonical Read(*) (down-converted to bare Read on Linux at install time)',
  );
  // Whole-list guard: no allow entry may use an unmatched Tool(path) form.
  const unmatchedAllow = findUnmatchedPathRules(allow);
  assert.deepStrictEqual(
    unmatchedAllow,
    [],
    'template.permissions.allow must contain no unmatched Tool(path) rules — ' +
      'use Edit(<path>) for Write/NotebookEdit and Read(<path>) for Glob. Offending entries: ' +
      unmatchedAllow.join(', '),
  );
  // Two-sided contract: bare forms must NOT be present in the template
  assert.ok(
    !allow.includes('Edit'),
    'template must NOT include bare Edit — use Edit(*)',
  );
  assert.ok(
    !allow.includes('Write'),
    'template must NOT include bare Write — Edit(*) covers the Write tool',
  );
  assert.ok(
    !allow.includes('Read'),
    'template must NOT include bare Read — use Read(*)',
  );
  // Deny rules dropped (the tool ships allow rules only)
  assert.strictEqual(
    template.permissions.deny,
    undefined,
    'template must NOT have permissions.deny section (deny rules dropped in Phase 52)',
  );

  // Verify new subshell builtins were added (Bug 9 fix)
  assert.ok(
    allow.includes('Bash(basename *)'),
    'template must include Bash(basename *)',
  );
  assert.ok(
    allow.includes('Bash(dirname *)'),
    'template must include Bash(dirname *)',
  );
  assert.ok(allow.includes('Bash(cut *)'), 'template must include Bash(cut *)');
  assert.ok(allow.includes('Bash(tee *)'), 'template must include Bash(tee *)');
  assert.ok(
    allow.includes('Bash(uniq *)'),
    'template must include Bash(uniq *)',
  );
  assert.ok(allow.includes('Bash(seq *)'), 'template must include Bash(seq *)');
});

// ── settings-sandbox.json allow/deny/ask must use effective forms, never Tool(<path>) ──
//
//            Claude Code's file permission checks match only Edit(path) and
//            Read(path) rules. A Write(path), NotebookEdit(path) or Glob(path)
//            rule is accepted by the parser but never matched — it reads as
//            policy, never fires, and (CC >= 2.1.210) costs a startup warning.
//            One Edit(path) entry governs every file-editing tool, so Edit(path)
//            is the effective spelling; Read(path) replaces Glob(path).
//
//            This covers ALL THREE seeded sections — the startup warning fires
//            for allow, deny and ask alike, and install.js runs each of them
//            through normalizePermissionRules(). The assertion keeps
//            the template itself honest so the mistake is caught at source rather
//            than repaired at install time. It also rejects the Edit/Write *pair*
//            shape — the Write half is decoration, not defence.
//
//            A BARE tool-name rule (e.g. deny 'Write') is NOT flagged: it matches
//            the tool everywhere and emits no warning, so it is a valid construct.

test('PERM-09: settings-sandbox.json allow/deny/ask rules use effective forms, never an unmatched Tool(path) form', () => {
  const templatePath = path.resolve(
    __dirname,
    '..',
    'gsd-ng',
    'templates',
    'settings-sandbox.json',
  );
  const template = JSON.parse(fs.readFileSync(templatePath, 'utf8'));

  for (const section of ['allow', 'deny', 'ask']) {
    const entries = template.permissions[section] ?? [];
    assert.ok(
      Array.isArray(entries),
      `template.permissions.${section} must be an array when present (PERM-09)`,
    );

    const unmatched = findUnmatchedPathRules(entries);
    assert.deepStrictEqual(
      unmatched,
      [],
      `template.permissions.${section} must not contain unmatched Tool(path) rules — they are ` +
        'never matched by the file permission engine and warn at startup. Use Edit(<path>) for ' +
        'Write/NotebookEdit and Read(<path>) for Glob (and keep Read(<path>) alongside Edit(<path>) ' +
        'for secrets). Offending entries: ' +
        unmatched.join(', ') +
        ' (PERM-09)',
    );

    // Normalisation must be a no-op on a correctly authored template — proves the
    // shipped list is already in the form install.js would seed.
    assert.deepStrictEqual(
      normalizePermissionRules(entries),
      entries,
      `template.permissions.${section} must already be in normalised form ` +
        '(no unmatched path rules, no duplicates) (PERM-09)',
    );
  }
});

// ── install seeds granular platform CLI patterns, not blanket wildcards ──

test('PERM-07: local install seeds granular gh subcommand patterns (not blanket Bash(gh *))', (t) => {
  const tmpDir = fs.mkdtempSync(path.join(BASE_TMPDIR, 'gsd-js-perm07-'));
  try {
    const result = spawnSync(
      process.execPath,
      [INSTALLER, '--runtime', 'claude', '--local'],
      {
        encoding: 'utf8',
        timeout: 15000,
        cwd: tmpDir,
        env: Object.assign({}, process.env, { HOME: os.homedir() }),
      },
    );
    assert.strictEqual(
      result.status,
      0,
      'install must exit 0 (PERM-07)\nstderr: ' + (result.stderr || ''),
    );

    const settingsPath = path.join(tmpDir, '.claude', 'settings.json');
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    const allow = settings.permissions.allow;

    assert.ok(
      !allow.includes('Bash(gh *)'),
      'must NOT include blanket Bash(gh *) (PERM-07)',
    );
    assert.ok(
      !allow.includes('Bash(gh api *)'),
      'must NOT include Bash(gh api *) (PERM-07)',
    );
    assert.ok(
      !allow.includes('Bash(gh extension *)'),
      'must NOT include Bash(gh extension *) (PERM-07)',
    );

    if (!HAS_GH) {
      t.skip(NO_GH_SKIP);
      return;
    }

    assert.ok(
      allow.includes('Bash(gh pr *)'),
      'must include Bash(gh pr *) when gh is installed (PERM-07)',
    );
    assert.ok(
      allow.includes('Bash(gh pr)'),
      'must include Bash(gh pr) when gh is installed (PERM-07)',
    );
    assert.ok(
      allow.includes('Bash(gh issue *)'),
      'must include Bash(gh issue *) when gh is installed (PERM-07)',
    );
  } finally {
    cleanup(tmpDir);
  }
});

// ── settings-sandbox.json template ships ask rules for protected-branch
//            pushes and admin merges (2026-05-01 incident response).
//
//            Background: On 2026-05-01 Claude bypassed develop's GitHub branch
//            protection (admin-role token had bypass capability) and pushed
//            work directly to develop, then opened a wrong-target PR.
//            Recovery required force-pushing develop back.
//
//            Fix: Layer-3 local guardrails. Claude Code's permission precedence
//            is `deny > ask > allow`, so these `ask` patterns override the
//            broad `Bash(git *)` allow rule and force a confirmation prompt
//            before any push to a protected branch lands.

const PERM_08_EXPECTED_ASK = [
  'Bash(git push * main*)',
  'Bash(git push * master*)',
  'Bash(git push * develop*)',
  'Bash(git -C * push * main*)',
  'Bash(git -C * push * master*)',
  'Bash(git -C * push * develop*)',
  'Bash(gh pr merge *--admin*)',
];

test('PERM-08: settings-sandbox.json template ships protected-branch ask rules (template shape)', () => {
  const templatePath = path.resolve(
    __dirname,
    '..',
    'gsd-ng',
    'templates',
    'settings-sandbox.json',
  );
  const template = JSON.parse(fs.readFileSync(templatePath, 'utf8'));
  assert.ok(
    Array.isArray(template.permissions.ask),
    'template.permissions.ask must be an array (PERM-08)',
  );
  assert.strictEqual(
    template.permissions.ask.length,
    PERM_08_EXPECTED_ASK.length,
    `template.permissions.ask must have exactly ${PERM_08_EXPECTED_ASK.length} entries (PERM-08) — catches accidental additions/removals`,
  );
  for (const pattern of PERM_08_EXPECTED_ASK) {
    assert.ok(
      template.permissions.ask.includes(pattern),
      `template.permissions.ask must include ${pattern} (PERM-08)`,
    );
  }
});

test('PERM-08: local install propagates protected-branch ask rules into .claude/settings.json (round-trip)', () => {
  const tmpDir = fs.mkdtempSync(path.join(BASE_TMPDIR, 'gsd-js-perm08-'));
  try {
    const result = spawnSync(
      process.execPath,
      [INSTALLER, '--runtime', 'claude', '--local'],
      {
        encoding: 'utf8',
        timeout: 15000,
        cwd: tmpDir,
        env: Object.assign({}, process.env, { HOME: os.homedir() }),
      },
    );
    assert.strictEqual(
      result.status,
      0,
      'install.js --local must exit 0 (PERM-08)\nstderr: ' +
        (result.stderr || ''),
    );

    const settingsPath = path.join(tmpDir, '.claude', 'settings.json');
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    assert.ok(
      Array.isArray(settings.permissions.ask),
      'settings.permissions.ask must be an array after install (PERM-08)',
    );
    for (const pattern of PERM_08_EXPECTED_ASK) {
      assert.ok(
        settings.permissions.ask.includes(pattern),
        `settings.permissions.ask must include ${pattern} after install (PERM-08)`,
      );
    }
  } finally {
    cleanup(tmpDir);
  }
});

// ── local install seeds permissions.allow with template entries ──────

test('PERM-01: local install seeds permissions.allow with template entries (Bash(node *) and Agent(*))', () => {
  const tmpDir = fs.mkdtempSync(path.join(BASE_TMPDIR, 'gsd-js-perm01-'));
  try {
    const result = spawnSync(
      process.execPath,
      [INSTALLER, '--runtime', 'claude', '--local'],
      {
        encoding: 'utf8',
        timeout: 15000,
        cwd: tmpDir,
        env: Object.assign({}, process.env, { HOME: os.homedir() }),
      },
    );
    assert.strictEqual(
      result.status,
      0,
      'install.js --local must exit 0 (PERM-01)\nstderr: ' +
        (result.stderr || ''),
    );

    const settingsPath = path.join(tmpDir, '.claude', 'settings.json');
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    assert.ok(
      Array.isArray(settings.permissions.allow),
      'settings.permissions.allow must be an array (PERM-01)',
    );
    assert.ok(
      settings.permissions.allow.includes('Bash(node *)'),
      'permissions.allow must include Bash(node *) (PERM-01)',
    );
    assert.ok(
      settings.permissions.allow.includes('Agent(*)'),
      'permissions.allow must include Agent(*) (PERM-01)',
    );
    // Sandbox is default-on: verify sandbox settings are seeded by default
    assert.strictEqual(
      settings.sandbox && settings.sandbox.enabled,
      true,
      'sandbox.enabled must be true by default (PERM-01)',
    );
    assert.strictEqual(
      settings.sandbox && settings.sandbox.autoAllowBashIfSandboxed,
      true,
      'sandbox.autoAllowBashIfSandboxed must be true by default (PERM-01)',
    );
  } finally {
    cleanup(tmpDir);
  }
});

// ── running --local install twice produces no duplicate entries ──────

test('PERM-02: running --local install twice produces no duplicate entries in permissions.allow', () => {
  const tmpDir = fs.mkdtempSync(path.join(BASE_TMPDIR, 'gsd-js-perm02-'));
  try {
    const runInstall = () =>
      spawnSync(
        process.execPath,
        [INSTALLER, '--runtime', 'claude', '--local'],
        {
          encoding: 'utf8',
          timeout: 15000,
          cwd: tmpDir,
          env: Object.assign({}, process.env, { HOME: os.homedir() }),
        },
      );
    const r1 = runInstall();
    assert.strictEqual(
      r1.status,
      0,
      'first install must exit 0 (PERM-02)\nstderr: ' + (r1.stderr || ''),
    );
    const r2 = runInstall();
    assert.strictEqual(
      r2.status,
      0,
      'second install must exit 0 (PERM-02)\nstderr: ' + (r2.stderr || ''),
    );

    const settingsPath = path.join(tmpDir, '.claude', 'settings.json');
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    const allow = settings.permissions.allow;

    const agentCount = allow.filter((e) => e === 'Agent(*)').length;
    assert.strictEqual(
      agentCount,
      1,
      'Agent(*) must appear exactly once after two installs (PERM-02)',
    );

    // Verify idempotency: no duplicate entries after two installs
    // (length may exceed template length when platform CLIs like gh are installed)
    const uniqueEntries = new Set(allow);
    assert.strictEqual(
      uniqueEntries.size,
      allow.length,
      'permissions.allow must have no duplicate entries after two installs (PERM-02)',
    );
  } finally {
    cleanup(tmpDir);
  }
});

// ── --no-seed-permissions-config does NOT create permissions.allow ───

test('PERM-03: --local --no-seed-permissions-config does not create permissions.allow in settings.json', () => {
  const tmpDir = fs.mkdtempSync(path.join(BASE_TMPDIR, 'gsd-js-perm03-'));
  try {
    const result = spawnSync(
      process.execPath,
      [
        INSTALLER,
        '--runtime',
        'claude',
        '--local',
        '--no-seed-permissions-config',
      ],
      {
        encoding: 'utf8',
        timeout: 15000,
        cwd: tmpDir,
        env: Object.assign({}, process.env, { HOME: os.homedir() }),
      },
    );
    assert.strictEqual(
      result.status,
      0,
      'install.js --local --no-seed-permissions-config must exit 0 (PERM-03)\nstderr: ' +
        (result.stderr || ''),
    );

    const settingsPath = path.join(tmpDir, '.claude', 'settings.json');
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    const hasAllow =
      settings.permissions !== undefined &&
      settings.permissions.allow !== undefined;
    assert.ok(
      !hasAllow,
      'permissions.allow must not exist when --no-seed-permissions-config is used (PERM-03)',
    );
  } finally {
    cleanup(tmpDir);
  }
});

// ── --no-seed-sandbox-config suppresses sandbox settings seeding ────

test('PERM-04: --local --no-seed-sandbox-config suppresses sandbox settings seeding', () => {
  const tmpDir = fs.mkdtempSync(path.join(BASE_TMPDIR, 'gsd-js-perm04-'));
  try {
    const result = spawnSync(
      process.execPath,
      [INSTALLER, '--runtime', 'claude', '--local', '--no-seed-sandbox-config'],
      {
        encoding: 'utf8',
        timeout: 15000,
        cwd: tmpDir,
        env: Object.assign({}, process.env, { HOME: os.homedir() }),
      },
    );
    assert.strictEqual(
      result.status,
      0,
      'install.js --local --no-seed-sandbox-config must exit 0 (PERM-04)\nstderr: ' +
        (result.stderr || ''),
    );

    const settingsPath = path.join(tmpDir, '.claude', 'settings.json');
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    // Sandbox seeding should be suppressed when --no-seed-sandbox-config is used
    const sandboxEnabled =
      settings.sandbox !== undefined && settings.sandbox.enabled !== undefined;
    assert.ok(
      !sandboxEnabled,
      'sandbox.enabled must not be set when --no-seed-sandbox-config is used (PERM-04)',
    );
  } finally {
    cleanup(tmpDir);
  }
});

// ── uninstall removes template entries but preserves custom entries ──

test('PERM-05: uninstall removes template-sourced entries from permissions.allow but preserves custom user entries', () => {
  const tmpDir = fs.mkdtempSync(path.join(BASE_TMPDIR, 'gsd-js-perm05-'));
  try {
    // First install
    const installResult = spawnSync(
      process.execPath,
      [INSTALLER, '--runtime', 'claude', '--local'],
      {
        encoding: 'utf8',
        timeout: 15000,
        cwd: tmpDir,
        env: Object.assign({}, process.env, { HOME: os.homedir() }),
      },
    );
    assert.strictEqual(
      installResult.status,
      0,
      'initial install must exit 0 (PERM-05)\nstderr: ' +
        (installResult.stderr || ''),
    );

    // Add a custom entry
    const settingsPath = path.join(tmpDir, '.claude', 'settings.json');
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    settings.permissions.allow.push('Bash(my-custom-tool *)');
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));

    // Uninstall
    const uninstallResult = spawnSync(
      process.execPath,
      [INSTALLER, '--runtime', 'claude', '--local', '--uninstall'],
      {
        encoding: 'utf8',
        timeout: 15000,
        cwd: tmpDir,
        env: Object.assign({}, process.env, { HOME: os.homedir() }),
      },
    );
    assert.strictEqual(
      uninstallResult.status,
      0,
      'uninstall must exit 0 (PERM-05)\nstderr: ' +
        (uninstallResult.stderr || ''),
    );

    // Check settings after uninstall
    const settingsAfter = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    const allowAfter = settingsAfter.permissions.allow;
    assert.ok(
      allowAfter.includes('Bash(my-custom-tool *)'),
      'custom entry must be preserved after uninstall (PERM-05)',
    );
    assert.ok(
      !allowAfter.includes('Agent(*)'),
      'Agent(*) must be removed after uninstall (PERM-05)',
    );
    assert.ok(
      !allowAfter.includes('Bash(node *)'),
      'Bash(node *) must be removed after uninstall (PERM-05)',
    );
  } finally {
    cleanup(tmpDir);
  }
});

// ── --no-seed-sandbox-config still seeds permissions.allow ───────────

test('SAND-01: --local --no-seed-sandbox-config still seeds permissions.allow', () => {
  const tmpDir = fs.mkdtempSync(path.join(BASE_TMPDIR, 'gsd-js-sand01-'));
  try {
    const result = spawnSync(
      process.execPath,
      [INSTALLER, '--runtime', 'claude', '--local', '--no-seed-sandbox-config'],
      {
        encoding: 'utf8',
        timeout: 15000,
        cwd: tmpDir,
        env: Object.assign({}, process.env, { HOME: os.homedir() }),
      },
    );
    assert.strictEqual(
      result.status,
      0,
      'install.js --local --no-seed-sandbox-config must exit 0 (SAND-01)\nstderr: ' +
        (result.stderr || ''),
    );

    const settingsPath = path.join(tmpDir, '.claude', 'settings.json');
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));

    // Permissions should still be seeded even when sandbox config is suppressed
    assert.ok(
      Array.isArray(settings.permissions && settings.permissions.allow),
      'permissions.allow must be seeded even when --no-seed-sandbox-config is used (SAND-01)',
    );
    assert.ok(
      settings.permissions.allow.includes('Bash(node *)'),
      'permissions.allow must include Bash(node *) (SAND-01)',
    );
    assert.ok(
      settings.permissions.allow.includes('Agent(*)'),
      'permissions.allow must include Agent(*) (SAND-01)',
    );

    // Sandbox settings must NOT be seeded
    const sandboxEnabled =
      settings.sandbox !== undefined && settings.sandbox.enabled !== undefined;
    assert.ok(
      !sandboxEnabled,
      'sandbox.enabled must not be set when --no-seed-sandbox-config is used (SAND-01)',
    );
  } finally {
    cleanup(tmpDir);
  }
});

// ── --local without --runtime exits non-zero ──────────────────────

test('RUNTIME-01: --local without --runtime exits non-zero with helpful error', () => {
  const tmpDir = fs.mkdtempSync(path.join(BASE_TMPDIR, 'gsd-js-rt01-'));
  try {
    const result = spawnSync(process.execPath, [INSTALLER, '--local'], {
      encoding: 'utf8',
      timeout: 15000,
      cwd: tmpDir,
      env: Object.assign({}, process.env, { HOME: os.homedir() }),
    });
    assert.notStrictEqual(
      result.status,
      0,
      '--local without --runtime must exit non-zero (RUNTIME-01)',
    );
    const output = (result.stderr || '') + (result.stdout || '');
    assert.ok(
      output.includes('Error: --runtime required'),
      'must show "Error: --runtime required" message (RUNTIME-01)\nActual output: ' +
        output.slice(0, 500),
    );
  } finally {
    cleanup(tmpDir);
  }
});

// ── --global without --runtime exits non-zero ─────────────────────

test('RUNTIME-02: --global without --runtime exits non-zero with helpful error', () => {
  const tmpDir = fs.mkdtempSync(path.join(BASE_TMPDIR, 'gsd-js-rt02-'));
  try {
    const result = spawnSync(process.execPath, [INSTALLER, '--global'], {
      encoding: 'utf8',
      timeout: 15000,
      cwd: tmpDir,
      env: Object.assign({}, process.env, {
        HOME: os.homedir(),
        CLAUDE_CONFIG_DIR: path.join(tmpDir, '.claude'),
      }),
    });
    assert.notStrictEqual(
      result.status,
      0,
      '--global without --runtime must exit non-zero (RUNTIME-02)',
    );
    const output = (result.stderr || '') + (result.stdout || '');
    assert.ok(
      output.includes('Error: --runtime required'),
      'must show "Error: --runtime required" message (RUNTIME-02)\nActual output: ' +
        output.slice(0, 500),
    );
  } finally {
    cleanup(tmpDir);
  }
});

// ── --uninstall without --runtime exits non-zero ──────────────────

test('RUNTIME-03: --uninstall --local without --runtime exits non-zero', () => {
  const tmpDir = fs.mkdtempSync(path.join(BASE_TMPDIR, 'gsd-js-rt03-'));
  try {
    const result = spawnSync(
      process.execPath,
      [INSTALLER, '--local', '--uninstall'],
      {
        encoding: 'utf8',
        timeout: 15000,
        cwd: tmpDir,
        env: Object.assign({}, process.env, { HOME: os.homedir() }),
      },
    );
    assert.notStrictEqual(
      result.status,
      0,
      '--uninstall without --runtime must exit non-zero (RUNTIME-03)',
    );
    const output = (result.stderr || '') + (result.stdout || '');
    assert.ok(
      output.includes('Error: --runtime required'),
      'must show "Error: --runtime required" message (RUNTIME-03)\nActual output: ' +
        output.slice(0, 500),
    );
  } finally {
    cleanup(tmpDir);
  }
});

// ── --local --copilot creates skills/gsd-*/SKILL.md ──────────────

test('COPILOT-01: --local --copilot creates skills/gsd-*/SKILL.md from commands', () => {
  const tmpDir = fs.mkdtempSync(path.join(BASE_TMPDIR, 'gsd-js-copilot-'));
  try {
    const result = spawnSync(
      process.execPath,
      [INSTALLER, '--runtime', 'copilot', '--local'],
      {
        encoding: 'utf8',
        timeout: 15000,
        cwd: tmpDir,
        env: Object.assign({}, process.env, { HOME: os.homedir() }),
      },
    );

    assert.strictEqual(
      result.status,
      0,
      'install.js --runtime copilot --local must exit 0 (COPILOT-01)\nstderr: ' +
        (result.stderr || ''),
    );

    const skillsDir = path.join(tmpDir, '.github', 'skills');
    assert.ok(
      fs.existsSync(skillsDir),
      '.github/skills/ directory must exist (COPILOT-01)',
    );

    const skillDirs = fs
      .readdirSync(skillsDir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && e.name.startsWith('gsd-'));
    assert.ok(
      skillDirs.length > 0,
      'at least one gsd-* subdirectory must exist under skills/ (COPILOT-01)',
    );

    for (const skillDir of skillDirs) {
      const skillMd = path.join(skillsDir, skillDir.name, 'SKILL.md');
      assert.ok(
        fs.existsSync(skillMd),
        `skills/${skillDir.name}/SKILL.md must exist (COPILOT-01)`,
      );
    }
  } finally {
    cleanup(tmpDir);
  }
});

// ── --local --copilot creates agents/gsd-*.agent.md ──────────────

test('COPILOT-02: --local --copilot creates agents/gsd-*.agent.md files', () => {
  const tmpDir = fs.mkdtempSync(path.join(BASE_TMPDIR, 'gsd-js-copilot-'));
  try {
    const result = spawnSync(
      process.execPath,
      [INSTALLER, '--runtime', 'copilot', '--local'],
      {
        encoding: 'utf8',
        timeout: 15000,
        cwd: tmpDir,
        env: Object.assign({}, process.env, { HOME: os.homedir() }),
      },
    );

    assert.strictEqual(
      result.status,
      0,
      'install.js --runtime copilot --local must exit 0 (COPILOT-02)\nstderr: ' +
        (result.stderr || ''),
    );

    const agentsDir = path.join(tmpDir, '.github', 'agents');
    assert.ok(
      fs.existsSync(agentsDir),
      '.github/agents/ directory must exist (COPILOT-02)',
    );

    const agentFiles = fs
      .readdirSync(agentsDir)
      .filter((f) => f.startsWith('gsd-') && f.endsWith('.agent.md'));
    assert.ok(
      agentFiles.length > 0,
      'at least one gsd-*.agent.md file must exist (COPILOT-02)',
    );
  } finally {
    cleanup(tmpDir);
  }
});

// ── --local --copilot generates copilot-instructions.md ───────────

test('COPILOT-03: --local --copilot generates copilot-instructions.md with GSD markers', () => {
  const tmpDir = fs.mkdtempSync(path.join(BASE_TMPDIR, 'gsd-js-copilot-'));
  try {
    const result = spawnSync(
      process.execPath,
      [INSTALLER, '--runtime', 'copilot', '--local'],
      {
        encoding: 'utf8',
        timeout: 15000,
        cwd: tmpDir,
        env: Object.assign({}, process.env, { HOME: os.homedir() }),
      },
    );

    assert.strictEqual(
      result.status,
      0,
      'install.js --runtime copilot --local must exit 0 (COPILOT-03)\nstderr: ' +
        (result.stderr || ''),
    );

    const instructionsPath = path.join(
      tmpDir,
      '.github',
      'copilot-instructions.md',
    );
    assert.ok(
      fs.existsSync(instructionsPath),
      '.github/copilot-instructions.md must exist (COPILOT-03)',
    );

    const content = fs.readFileSync(instructionsPath, 'utf8');
    assert.ok(
      content.includes('<!-- GSD Configuration'),
      'copilot-instructions.md must contain GSD open marker (COPILOT-03)',
    );
    assert.ok(
      content.includes('<!-- /GSD Configuration -->'),
      'copilot-instructions.md must contain GSD close marker (COPILOT-03)',
    );
  } finally {
    cleanup(tmpDir);
  }
});

// ── --local --copilot does NOT create settings.json ───────────────

test('COPILOT-04: --local --copilot does NOT create settings.json', () => {
  const tmpDir = fs.mkdtempSync(path.join(BASE_TMPDIR, 'gsd-js-copilot-'));
  try {
    const result = spawnSync(
      process.execPath,
      [INSTALLER, '--runtime', 'copilot', '--local'],
      {
        encoding: 'utf8',
        timeout: 15000,
        cwd: tmpDir,
        env: Object.assign({}, process.env, { HOME: os.homedir() }),
      },
    );

    assert.strictEqual(
      result.status,
      0,
      'install.js --runtime copilot --local must exit 0 (COPILOT-04)\nstderr: ' +
        (result.stderr || ''),
    );

    const settingsPath = path.join(tmpDir, '.github', 'settings.json');
    assert.ok(
      !fs.existsSync(settingsPath),
      '.github/settings.json must NOT exist for Copilot install (COPILOT-04)',
    );
  } finally {
    cleanup(tmpDir);
  }
});

// ── --local --copilot does NOT seed permissions or sandbox ────────

test('COPILOT-05: --local --copilot does NOT seed permissions or sandbox settings', () => {
  const tmpDir = fs.mkdtempSync(path.join(BASE_TMPDIR, 'gsd-js-copilot-'));
  try {
    const result = spawnSync(
      process.execPath,
      [INSTALLER, '--runtime', 'copilot', '--local'],
      {
        encoding: 'utf8',
        timeout: 15000,
        cwd: tmpDir,
        env: Object.assign({}, process.env, { HOME: os.homedir() }),
      },
    );

    assert.strictEqual(
      result.status,
      0,
      'install.js --runtime copilot --local must exit 0 (COPILOT-05)\nstderr: ' +
        (result.stderr || ''),
    );

    const githubDir = path.join(tmpDir, '.github');

    // No settings.json anywhere in .github/
    const settingsPath = path.join(githubDir, 'settings.json');
    assert.ok(
      !fs.existsSync(settingsPath),
      'No settings.json must exist in .github/ for Copilot install (COPILOT-05)',
    );

    function walkDir(dir) {
      if (!fs.existsSync(dir)) return [];
      const results = [];
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          results.push(...walkDir(fullPath));
        } else if (entry.isFile() && entry.name.endsWith('.json')) {
          results.push(fullPath);
        }
      }
      return results;
    }

    // gsd-ng/ is the engine payload, copied verbatim on every runtime. Its
    // templates are the installer's own input — the file permissions are seeded
    // FROM on Claude — not configuration Copilot ever reads. Seeding means
    // writing permissions into a config the agent consumes, so only the files
    // outside the payload are in scope here.
    const payloadDir = path.join(githubDir, 'gsd-ng');
    const consumed = walkDir(githubDir).filter(
      (f) => !f.startsWith(payloadDir + path.sep),
    );
    assert.ok(
      consumed.length > 0,
      'expected at least one consumed .json file under .github/ to inspect (COPILOT-05)',
    );
    for (const jsonFile of consumed) {
      let data;
      try {
        data = JSON.parse(fs.readFileSync(jsonFile, 'utf8'));
      } catch (err) {
        assert.fail(
          `${jsonFile} must be valid JSON in a Copilot install (COPILOT-05): ${err.message}`,
        );
      }
      assert.ok(
        data.permissions === undefined,
        `${jsonFile} must not contain "permissions" key in Copilot install (COPILOT-05)`,
      );
    }

    // The payload template is passed through untouched, not seeded into.
    const sandboxTemplate = path.join(
      payloadDir,
      'templates',
      'settings-sandbox.json',
    );
    assert.ok(
      fs.existsSync(sandboxTemplate),
      'the sandbox template ships as engine payload on Copilot too (COPILOT-05)',
    );
    assert.strictEqual(
      fs.readFileSync(sandboxTemplate, 'utf8'),
      fs.readFileSync(
        path.resolve(__dirname, '..', 'gsd-ng', 'templates', 'settings-sandbox.json'),
        'utf8',
      ),
      'the Copilot install must copy the sandbox template byte-for-byte from source, ' +
        'never merge or seed into it (COPILOT-05)',
    );

    // The contrast that gives "does not seed" its meaning: the same flags on
    // Claude do produce a permissions-bearing settings.json.
    const claudeDir = fs.mkdtempSync(path.join(BASE_TMPDIR, 'gsd-js-copilot-ref-'));
    try {
      const ref = spawnSync(
        process.execPath,
        [INSTALLER, '--runtime', 'claude', '--local'],
        {
          encoding: 'utf8',
          timeout: 15000,
          cwd: claudeDir,
          env: Object.assign({}, process.env, { HOME: os.homedir() }),
        },
      );
      assert.strictEqual(
        ref.status,
        0,
        'reference Claude install must exit 0 (COPILOT-05)\nstderr: ' +
          (ref.stderr || ''),
      );
      const refSettings = JSON.parse(
        fs.readFileSync(path.join(claudeDir, '.claude', 'settings.json'), 'utf8'),
      );
      assert.ok(
        refSettings.permissions &&
          Array.isArray(refSettings.permissions.allow) &&
          refSettings.permissions.allow.length > 0,
        'the Claude runtime must seed permissions.allow — otherwise the Copilot ' +
          'assertions above are vacuous (COPILOT-05)',
      );
    } finally {
      cleanup(claudeDir);
    }
  } finally {
    cleanup(tmpDir);
  }
});

// ── --local --copilot --uninstall removes GSD artifacts ───────────

test('COPILOT-06: --local --copilot --uninstall removes GSD skills, agents, and cleans copilot-instructions.md', () => {
  const tmpDir = fs.mkdtempSync(path.join(BASE_TMPDIR, 'gsd-js-copilot-'));
  try {
    // First: install
    const installResult = spawnSync(
      process.execPath,
      [INSTALLER, '--runtime', 'copilot', '--local'],
      {
        encoding: 'utf8',
        timeout: 15000,
        cwd: tmpDir,
        env: Object.assign({}, process.env, { HOME: os.homedir() }),
      },
    );
    assert.strictEqual(
      installResult.status,
      0,
      'install must exit 0 (COPILOT-06)\nstderr: ' +
        (installResult.stderr || ''),
    );

    // Then: uninstall
    const uninstallResult = spawnSync(
      process.execPath,
      [INSTALLER, '--runtime', 'copilot', '--local', '--uninstall'],
      {
        encoding: 'utf8',
        timeout: 15000,
        cwd: tmpDir,
        env: Object.assign({}, process.env, { HOME: os.homedir() }),
      },
    );
    assert.strictEqual(
      uninstallResult.status,
      0,
      'uninstall must exit 0 (COPILOT-06)\nstderr: ' +
        (uninstallResult.stderr || ''),
    );

    const githubDir = path.join(tmpDir, '.github');

    // No gsd-* directories under skills/
    const skillsDir = path.join(githubDir, 'skills');
    if (fs.existsSync(skillsDir)) {
      const remainingSkills = fs
        .readdirSync(skillsDir, { withFileTypes: true })
        .filter((e) => e.isDirectory() && e.name.startsWith('gsd-'));
      assert.strictEqual(
        remainingSkills.length,
        0,
        'no gsd-* skill directories should remain after uninstall (COPILOT-06)',
      );
    }

    // No gsd-*.agent.md files under agents/
    const agentsDir = path.join(githubDir, 'agents');
    if (fs.existsSync(agentsDir)) {
      const remainingAgents = fs
        .readdirSync(agentsDir)
        .filter((f) => f.startsWith('gsd-') && f.endsWith('.agent.md'));
      assert.strictEqual(
        remainingAgents.length,
        0,
        'no gsd-*.agent.md files should remain after uninstall (COPILOT-06)',
      );
    }

    // copilot-instructions.md either deleted or stripped of GSD markers
    const instructionsPath = path.join(githubDir, 'copilot-instructions.md');
    if (fs.existsSync(instructionsPath)) {
      const content = fs.readFileSync(instructionsPath, 'utf8');
      assert.ok(
        !content.includes('<!-- GSD Configuration'),
        'copilot-instructions.md must not contain GSD markers after uninstall (COPILOT-06)',
      );
    }

    // gsd-ng/ directory removed
    const gsdNgDir = path.join(githubDir, 'gsd-ng');
    assert.ok(
      !fs.existsSync(gsdNgDir),
      'gsd-ng/ directory must be removed after uninstall (COPILOT-06)',
    );
  } finally {
    cleanup(tmpDir);
  }
});

// ── no leaked ~/.claude/ paths in Copilot installed content ───────

test('COPILOT-07: --local --copilot installed files contain no ~/.claude/ or .claude/ path references', () => {
  const tmpDir = fs.mkdtempSync(path.join(BASE_TMPDIR, 'gsd-js-copilot-'));
  try {
    const result = spawnSync(
      process.execPath,
      [INSTALLER, '--runtime', 'copilot', '--local'],
      {
        encoding: 'utf8',
        timeout: 15000,
        cwd: tmpDir,
        env: Object.assign({}, process.env, { HOME: os.homedir() }),
      },
    );

    assert.strictEqual(
      result.status,
      0,
      'install.js --runtime copilot --local must exit 0 (COPILOT-07)\nstderr: ' +
        (result.stderr || ''),
    );

    // Walk all .md files recursively under .github/
    function walkMdFiles(dir) {
      if (!fs.existsSync(dir)) return [];
      const results = [];
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          results.push(...walkMdFiles(fullPath));
        } else if (entry.isFile() && entry.name.endsWith('.md')) {
          results.push(fullPath);
        }
      }
      return results;
    }

    const githubDir = path.join(tmpDir, '.github');
    const mdFiles = walkMdFiles(githubDir);
    assert.ok(
      mdFiles.length > 0,
      'must have installed .md files to check (COPILOT-07)',
    );

    const badFiles = [];
    for (const mdFile of mdFiles) {
      const content = fs.readFileSync(mdFile, 'utf8');
      // Check for raw ~/.claude/ paths (not .github/ or .copilot/ which are correct)
      if (
        content.includes('~/.claude/') ||
        content.includes('$HOME/.claude/') ||
        content.includes('./.claude/')
      ) {
        badFiles.push(path.relative(tmpDir, mdFile));
      }
    }

    assert.ok(
      badFiles.length === 0,
      'installed Copilot files must not contain ~/.claude/ or .claude/ paths (COPILOT-07).\n' +
        'Offending files: ' +
        badFiles.join(', '),
    );
  } finally {
    cleanup(tmpDir);
  }
});

// ── --runtime copilot flag works for non-interactive install ──────

test('COPILOT-08: --local --runtime copilot selects Copilot runtime', () => {
  const tmpDir = fs.mkdtempSync(path.join(BASE_TMPDIR, 'gsd-js-copilot-'));
  try {
    const result = spawnSync(
      process.execPath,
      [INSTALLER, '--local', '--runtime', 'copilot'],
      {
        encoding: 'utf8',
        timeout: 15000,
        cwd: tmpDir,
        env: Object.assign({}, process.env, { HOME: os.homedir() }),
      },
    );

    assert.strictEqual(
      result.status,
      0,
      'install.js --local --runtime copilot must exit 0 (COPILOT-08)\nstderr: ' +
        (result.stderr || ''),
    );

    // .github/ directory must exist (Copilot runtime selected)
    const githubDir = path.join(tmpDir, '.github');
    assert.ok(
      fs.existsSync(githubDir),
      '.github/ directory must exist when --runtime copilot is used (COPILOT-08)',
    );

    // skills/ directory must exist under .github/
    const skillsDir = path.join(githubDir, 'skills');
    assert.ok(
      fs.existsSync(skillsDir),
      '.github/skills/ directory must exist (COPILOT-08)',
    );

    // .claude/ directory must NOT exist (wrong runtime)
    const claudeDir = path.join(tmpDir, '.claude');
    assert.ok(
      !fs.existsSync(claudeDir),
      '.claude/ directory must NOT exist when --runtime copilot is used (COPILOT-08)',
    );
  } finally {
    cleanup(tmpDir);
  }
});

// ── hooks/gsd-hooks.json written on Copilot local install ─────────

test('COPILOT-09: --local --runtime copilot writes hooks/gsd-hooks.json with sessionStart hook', () => {
  const tmpDir = fs.mkdtempSync(path.join(BASE_TMPDIR, 'gsd-js-cop09-'));
  try {
    const result = spawnSync(
      process.execPath,
      [INSTALLER, '--local', '--runtime', 'copilot'],
      {
        encoding: 'utf8',
        timeout: 15000,
        cwd: tmpDir,
        env: Object.assign({}, process.env, { HOME: os.homedir() }),
      },
    );
    assert.strictEqual(
      result.status,
      0,
      'install must exit 0 (COPILOT-09)\nstderr: ' + (result.stderr || ''),
    );

    const hooksFile = path.join(tmpDir, '.github', 'hooks', 'gsd-hooks.json');
    assert.ok(
      fs.existsSync(hooksFile),
      '.github/hooks/gsd-hooks.json must exist after Copilot install (COPILOT-09)',
    );

    const content = JSON.parse(fs.readFileSync(hooksFile, 'utf8'));
    assert.strictEqual(
      content.version,
      1,
      'hooks file must have version: 1 (COPILOT-09)',
    );
    assert.ok(
      Array.isArray(content.hooks.sessionStart),
      'hooks.sessionStart must be an array (COPILOT-09)',
    );
    assert.ok(
      content.hooks.sessionStart.length > 0,
      'sessionStart must have at least one hook entry (COPILOT-09)',
    );
    assert.ok(
      content.hooks.sessionStart[0].bash.includes('gsd-check-update'),
      'sessionStart hook bash command must reference gsd-check-update (COPILOT-09)',
    );
  } finally {
    cleanup(tmpDir);
  }
});

// ── claude local install creates bash-safety-hook.cjs in hooks dir ──

test('BASH-HOOK-01: claude local install creates bash-safety-hook.cjs in hooks directory', () => {
  const tmpDir = fs.mkdtempSync(path.join(BASE_TMPDIR, 'gsd-bh-01-'));
  try {
    const result = spawnSync(
      process.execPath,
      [INSTALLER, '--runtime', 'claude', '--local'],
      {
        encoding: 'utf8',
        timeout: 15000,
        cwd: tmpDir,
        env: Object.assign({}, process.env, { HOME: os.homedir() }),
      },
    );
    assert.strictEqual(
      result.status,
      0,
      'install.js --runtime claude --local must exit 0 (BASH-HOOK-01)\nstderr: ' +
        (result.stderr || ''),
    );
    const hookPath = path.join(
      tmpDir,
      '.claude',
      'hooks',
      'bash-safety-hook.cjs',
    );
    assert.ok(
      fs.existsSync(hookPath),
      'hooks/bash-safety-hook.cjs must exist after claude local install (BASH-HOOK-01)',
    );
    const content = fs.readFileSync(hookPath, 'utf8');
    assert.ok(
      content.startsWith('#!/usr/bin/env node'),
      'bash-safety-hook.cjs must start with #!/usr/bin/env node shebang (BASH-HOOK-01)',
    );
  } finally {
    cleanup(tmpDir);
  }
});

test('BASH-HOOK-01b: a hooks/ file the claude layout does not declare is not installed', () => {
  const tmpDir = fs.mkdtempSync(path.join(BASE_TMPDIR, 'gsd-bh-01b-'));
  try {
    const result = spawnSync(
      process.execPath,
      [INSTALLER, '--runtime', 'claude', '--local'],
      {
        encoding: 'utf8',
        timeout: 15000,
        cwd: tmpDir,
        env: Object.assign({}, process.env, { HOME: os.homedir() }),
      },
    );
    assert.strictEqual(
      result.status,
      0,
      'install.js --runtime claude --local must exit 0 (BASH-HOOK-01b)\nstderr: ' +
        (result.stderr || ''),
    );

    // The opencode plugin ships from hooks/ because that directory is packaged,
    // not because every runtime installs it. It is an ESM module for a runtime
    // whose hook surface claude does not have.
    const source = path.join(__dirname, '..', 'hooks', 'gsd-opencode-plugin.js');
    assert.ok(fs.existsSync(source), 'the source file this asserts about must exist');
    assert.ok(
      !fs.existsSync(
        path.join(tmpDir, '.claude', 'hooks', 'gsd-opencode-plugin.js'),
      ),
      'a hooks/ file outside the claude layout must not reach .claude/hooks (BASH-HOOK-01b)',
    );

    const manifest = JSON.parse(
      fs.readFileSync(
        path.join(tmpDir, '.claude', 'gsd-file-manifest.json'),
        'utf8',
      ),
    );
    assert.ok(
      !manifest.installed_hooks.includes('gsd-opencode-plugin.js'),
      'an uninstalled file must not be recorded as installed (BASH-HOOK-01b)',
    );
  } finally {
    cleanup(tmpDir);
  }
});

// ── claude local install wires bash-safety-hook into settings.json ──

test('BASH-HOOK-02: claude local install wires bash-safety-hook into settings.json PreToolUse', () => {
  const tmpDir = fs.mkdtempSync(path.join(BASE_TMPDIR, 'gsd-bh-02-'));
  try {
    const result = spawnSync(
      process.execPath,
      [INSTALLER, '--runtime', 'claude', '--local'],
      {
        encoding: 'utf8',
        timeout: 15000,
        cwd: tmpDir,
        env: Object.assign({}, process.env, { HOME: os.homedir() }),
      },
    );
    assert.strictEqual(
      result.status,
      0,
      'install.js --runtime claude --local must exit 0 (BASH-HOOK-02)\nstderr: ' +
        (result.stderr || ''),
    );
    const settingsPath = path.join(tmpDir, '.claude', 'settings.json');
    assert.ok(
      fs.existsSync(settingsPath),
      'settings.json must exist after claude local install (BASH-HOOK-02)',
    );
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    const preToolUse = settings.hooks && settings.hooks.PreToolUse;
    assert.ok(
      Array.isArray(preToolUse),
      'settings.json must have hooks.PreToolUse array (BASH-HOOK-02)',
    );
    const bashSafetyEntry = preToolUse.find(
      (entry) =>
        entry.hooks &&
        entry.hooks.some(
          (h) => h.command && h.command.includes('bash-safety-hook.cjs'),
        ),
    );
    assert.ok(
      bashSafetyEntry !== undefined,
      'settings.json PreToolUse must contain an entry with bash-safety-hook.cjs (BASH-HOOK-02)',
    );
    assert.strictEqual(
      bashSafetyEntry.matcher,
      'Bash',
      'bash-safety-hook entry must have matcher: "Bash" (BASH-HOOK-02)',
    );
  } finally {
    cleanup(tmpDir);
  }
});

// ── idempotent — re-running does not duplicate hook in PreToolUse ──

test('BASH-HOOK-03: idempotent — re-running install does not duplicate bash-safety-hook in PreToolUse', () => {
  const tmpDir = fs.mkdtempSync(path.join(BASE_TMPDIR, 'gsd-bh-03-'));
  try {
    const runInstall = () =>
      spawnSync(
        process.execPath,
        [INSTALLER, '--runtime', 'claude', '--local'],
        {
          encoding: 'utf8',
          timeout: 15000,
          cwd: tmpDir,
          env: Object.assign({}, process.env, { HOME: os.homedir() }),
        },
      );
    const r1 = runInstall();
    assert.strictEqual(
      r1.status,
      0,
      'First install must exit 0 (BASH-HOOK-03)',
    );
    const r2 = runInstall();
    assert.strictEqual(
      r2.status,
      0,
      'Second install must exit 0 (BASH-HOOK-03)',
    );
    const settingsPath = path.join(tmpDir, '.claude', 'settings.json');
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    const preToolUse = settings.hooks && settings.hooks.PreToolUse;
    const bashSafetyEntries = (preToolUse || []).filter(
      (entry) =>
        entry.hooks &&
        entry.hooks.some(
          (h) => h.command && h.command.includes('bash-safety-hook.cjs'),
        ),
    );
    assert.strictEqual(
      bashSafetyEntries.length,
      1,
      'bash-safety-hook.cjs must appear exactly once in PreToolUse after two installs (BASH-HOOK-03). ' +
        'Found: ' +
        bashSafetyEntries.length +
        ' entries',
    );
  } finally {
    cleanup(tmpDir);
  }
});

// ── copilot install does NOT wire bash-safety-hook into settings.json ──

test('BASH-HOOK-04: copilot local install does NOT wire bash-safety-hook into settings.json', () => {
  const tmpDir = fs.mkdtempSync(path.join(BASE_TMPDIR, 'gsd-bh-04-'));
  try {
    const result = spawnSync(
      process.execPath,
      [INSTALLER, '--runtime', 'copilot', '--local'],
      {
        encoding: 'utf8',
        timeout: 15000,
        cwd: tmpDir,
        env: Object.assign({}, process.env, { HOME: os.homedir() }),
      },
    );
    assert.strictEqual(
      result.status,
      0,
      'install.js --runtime copilot --local must exit 0 (BASH-HOOK-04)\nstderr: ' +
        (result.stderr || ''),
    );
    const settingsPath = path.join(tmpDir, '.github', 'settings.json');
    if (fs.existsSync(settingsPath)) {
      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      const preToolUse = (settings.hooks && settings.hooks.PreToolUse) || [];
      const hasBashSafety = preToolUse.some(
        (entry) =>
          entry.hooks &&
          entry.hooks.some(
            (h) => h.command && h.command.includes('bash-safety-hook.cjs'),
          ),
      );
      assert.ok(
        !hasBashSafety,
        'copilot settings.json must NOT contain bash-safety-hook.cjs in PreToolUse (BASH-HOOK-04)',
      );
    }
    // Guardrail: hook file must not exist in Copilot target (future runtime safety)
    const hookFilePath = path.join(
      tmpDir,
      '.github',
      'hooks',
      'bash-safety-hook.cjs',
    );
    assert.ok(
      !fs.existsSync(hookFilePath),
      'bash-safety-hook.cjs must NOT exist in Copilot hooks dir (BASH-HOOK-04)',
    );
  } finally {
    cleanup(tmpDir);
  }
});

// ── anti-heredoc instruction present in agent-shared-context.md ──

test('BASH-HOOK-05: anti-heredoc instruction present in agent-shared-context.md after claude install', () => {
  const tmpDir = fs.mkdtempSync(path.join(BASE_TMPDIR, 'gsd-bh-05-'));
  try {
    const result = spawnSync(
      process.execPath,
      [INSTALLER, '--runtime', 'claude', '--local'],
      {
        encoding: 'utf8',
        timeout: 15000,
        cwd: tmpDir,
        env: Object.assign({}, process.env, { HOME: os.homedir() }),
      },
    );
    assert.strictEqual(
      result.status,
      0,
      'install.js --runtime claude --local must exit 0 (BASH-HOOK-05)\nstderr: ' +
        (result.stderr || ''),
    );
    const agentCtxPath = path.join(
      tmpDir,
      '.claude',
      'gsd-ng',
      'references',
      'agent-shared-context.md',
    );
    assert.ok(
      fs.existsSync(agentCtxPath),
      'agent-shared-context.md must exist after claude local install (BASH-HOOK-05)',
    );
    const content = fs.readFileSync(agentCtxPath, 'utf8');
    assert.ok(
      content.includes('ALWAYS use the Write tool'),
      'agent-shared-context.md must contain anti-heredoc instruction (BASH-HOOK-05)',
    );
    assert.ok(
      !content.includes('GSD — AST Safety Rules'),
      'agent-shared-context.md must NOT contain AST Safety Rules markers (BASH-HOOK-05)',
    );
  } finally {
    cleanup(tmpDir);
  }
});

// ── copilot install ALSO has anti-heredoc in agent-shared-context.md ──

test('BASH-HOOK-06: copilot local install ALSO has anti-heredoc instruction in agent-shared-context.md', () => {
  const tmpDir = fs.mkdtempSync(path.join(BASE_TMPDIR, 'gsd-bh-06-'));
  try {
    const result = spawnSync(
      process.execPath,
      [INSTALLER, '--runtime', 'copilot', '--local'],
      {
        encoding: 'utf8',
        timeout: 15000,
        cwd: tmpDir,
        env: Object.assign({}, process.env, { HOME: os.homedir() }),
      },
    );
    assert.strictEqual(
      result.status,
      0,
      'install.js --runtime copilot --local must exit 0 (BASH-HOOK-06)\nstderr: ' +
        (result.stderr || ''),
    );
    const agentCtxPath = path.join(
      tmpDir,
      '.github',
      'gsd-ng',
      'references',
      'agent-shared-context.md',
    );
    assert.ok(
      fs.existsSync(agentCtxPath),
      'agent-shared-context.md must exist after copilot local install (BASH-HOOK-06)',
    );
    const content = fs.readFileSync(agentCtxPath, 'utf8');
    assert.ok(
      content.includes('ALWAYS use the Write tool'),
      'agent-shared-context.md must contain anti-heredoc instruction for copilot runtime too (BASH-HOOK-06)',
    );
  } finally {
    cleanup(tmpDir);
  }
});

// ── anti-heredoc not duplicated on re-install ──────────────────

test('BASH-HOOK-07: anti-heredoc not duplicated on re-install of claude local', () => {
  const tmpDir = fs.mkdtempSync(path.join(BASE_TMPDIR, 'gsd-bh-07-'));
  try {
    const runInstall = () =>
      spawnSync(
        process.execPath,
        [INSTALLER, '--runtime', 'claude', '--local'],
        {
          encoding: 'utf8',
          timeout: 15000,
          cwd: tmpDir,
          env: Object.assign({}, process.env, { HOME: os.homedir() }),
        },
      );
    assert.strictEqual(
      runInstall().status,
      0,
      'First install must exit 0 (BASH-HOOK-07)',
    );
    assert.strictEqual(
      runInstall().status,
      0,
      'Second install must exit 0 (BASH-HOOK-07)',
    );
    const agentCtxPath = path.join(
      tmpDir,
      '.claude',
      'gsd-ng',
      'references',
      'agent-shared-context.md',
    );
    const content = fs.readFileSync(agentCtxPath, 'utf8');
    const occurrences = (content.match(/ALWAYS use the Write tool/g) || [])
      .length;
    assert.strictEqual(
      occurrences,
      1,
      '"ALWAYS use the Write tool" must appear exactly once after two installs (BASH-HOOK-07). Found: ' +
        occurrences,
    );
  } finally {
    cleanup(tmpDir);
  }
});

// ── SKILL.md name: fields must not contain colon character ────────

test('COPILOT-10: all SKILL.md name: fields must use gsd- prefix, not gsd: (no colons)', () => {
  const tmpDir = fs.mkdtempSync(path.join(BASE_TMPDIR, 'gsd-js-cop10-'));
  try {
    const result = spawnSync(
      process.execPath,
      [INSTALLER, '--local', '--runtime', 'copilot'],
      {
        encoding: 'utf8',
        timeout: 15000,
        cwd: tmpDir,
        env: Object.assign({}, process.env, { HOME: os.homedir() }),
      },
    );
    assert.strictEqual(
      result.status,
      0,
      'install must exit 0 (COPILOT-10)\nstderr: ' + (result.stderr || ''),
    );

    const skillsDir = path.join(tmpDir, '.github', 'skills');
    assert.ok(
      fs.existsSync(skillsDir),
      '.github/skills/ must exist (COPILOT-10)',
    );

    const skillDirs = fs
      .readdirSync(skillsDir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && e.name.startsWith('gsd-'));
    assert.ok(
      skillDirs.length > 0,
      'at least one gsd-* skill dir must exist (COPILOT-10)',
    );

    const offending = [];
    for (const skillDir of skillDirs) {
      const skillMd = path.join(skillsDir, skillDir.name, 'SKILL.md');
      if (!fs.existsSync(skillMd)) continue;
      const content = fs.readFileSync(skillMd, 'utf8');
      // Extract name: line from frontmatter
      const nameMatch = content.match(/^name:\s*(.+)$/m);
      if (nameMatch && nameMatch[1].includes(':')) {
        offending.push(
          `${skillDir.name}/SKILL.md → name: ${nameMatch[1].trim()}`,
        );
      }
    }

    assert.strictEqual(
      offending.length,
      0,
      'SKILL.md name: fields must not contain colons (COPILOT-10).\n' +
        'Offending files:\n' +
        offending.map((s) => '  ' + s).join('\n'),
    );
  } finally {
    cleanup(tmpDir);
  }
});

// ── copilot install writes snapshot VERSION (not verbatim copy) ───────

test('SVN-01: --runtime copilot --local writes .github/gsd-ng/VERSION with resolved version', () => {
  const tmpDir = fs.mkdtempSync(path.join(BASE_TMPDIR, 'gsd-svn-01-'));
  try {
    const result = spawnSync(
      process.execPath,
      [INSTALLER, '--runtime', 'copilot', '--local'],
      {
        encoding: 'utf8',
        timeout: 15000,
        cwd: tmpDir,
        env: Object.assign({}, process.env, { HOME: os.homedir() }),
      },
    );
    assert.strictEqual(
      result.status,
      0,
      'install.js --runtime copilot --local must exit 0 (SVN-01)\nstderr: ' +
        (result.stderr || ''),
    );

    const versionPath = path.join(tmpDir, '.github', 'gsd-ng', 'VERSION');
    assert.ok(
      fs.existsSync(versionPath),
      '.github/gsd-ng/VERSION must exist after copilot install (SVN-01)',
    );

    const versionContent = fs.readFileSync(versionPath, 'utf8').trim();
    const pkg = require('../package.json');
    // Accept both clean version (tagged release) and snapshot version+hash (dev checkout).
    const snapshotRegex = new RegExp(
      '^' + pkg.version.replace(/[.+]/g, '\\$&') + '(\\+[0-9a-f]{7,})?$',
    );
    assert.ok(
      snapshotRegex.test(versionContent),
      'copilot VERSION must match ' +
        snapshotRegex +
        ' (SVN-01). Got: ' +
        JSON.stringify(versionContent),
    );
  } finally {
    cleanup(tmpDir);
  }
});

// ── banner output prints resolved (snapshot-aware) version ────────────

test('SVN-02: --runtime claude --local banner prints resolved version matching VERSION file', () => {
  const tmpDir = fs.mkdtempSync(path.join(BASE_TMPDIR, 'gsd-svn-02-'));
  try {
    const result = spawnSync(
      process.execPath,
      [INSTALLER, '--runtime', 'claude', '--local'],
      {
        encoding: 'utf8',
        timeout: 15000,
        cwd: tmpDir,
        env: Object.assign({}, process.env, { HOME: os.homedir() }),
      },
    );
    assert.strictEqual(
      result.status,
      0,
      'install.js --runtime claude --local must exit 0 (SVN-02)\nstderr: ' +
        (result.stderr || ''),
    );

    const versionPath = path.join(tmpDir, '.claude', 'gsd-ng', 'VERSION');
    assert.ok(
      fs.existsSync(versionPath),
      '.claude/gsd-ng/VERSION must exist (SVN-02)',
    );
    const versionContent = fs.readFileSync(versionPath, 'utf8').trim();

    // Banner line format: "  gsd-ng \x1b[2mv<version>\x1b[0m\n"
    // Strip ANSI and check the banner contains "gsd-ng v<versionContent>".
    const stdout = result.stdout || '';
    // Remove ANSI escape sequences for readable matching.
    const clean = stdout.replace(/\x1b\[[0-9;]*m/g, '');
    const expectedBannerFragment = 'gsd-ng v' + versionContent;
    assert.ok(
      clean.includes(expectedBannerFragment),
      'Banner must contain "' +
        expectedBannerFragment +
        '" matching VERSION file (SVN-02).\n' +
        'Stdout (ANSI-stripped, first 500 chars): ' +
        clean.slice(0, 500),
    );
  } finally {
    cleanup(tmpDir);
  }
});

// ── manifest.version matches VERSION file byte-for-byte ───────────────

test('SVN-03: --runtime claude --local writes manifest.version equal to VERSION file contents', () => {
  const tmpDir = fs.mkdtempSync(path.join(BASE_TMPDIR, 'gsd-svn-03-'));
  try {
    const result = spawnSync(
      process.execPath,
      [INSTALLER, '--runtime', 'claude', '--local'],
      {
        encoding: 'utf8',
        timeout: 15000,
        cwd: tmpDir,
        env: Object.assign({}, process.env, { HOME: os.homedir() }),
      },
    );
    assert.strictEqual(
      result.status,
      0,
      'install.js --runtime claude --local must exit 0 (SVN-03)\nstderr: ' +
        (result.stderr || ''),
    );

    const versionPath = path.join(tmpDir, '.claude', 'gsd-ng', 'VERSION');
    const manifestPath = path.join(tmpDir, '.claude', 'gsd-file-manifest.json');
    assert.ok(fs.existsSync(versionPath), 'VERSION must exist (SVN-03)');
    assert.ok(
      fs.existsSync(manifestPath),
      'gsd-file-manifest.json must exist (SVN-03)',
    );

    const versionContent = fs.readFileSync(versionPath, 'utf8');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

    assert.strictEqual(
      manifest.version,
      versionContent,
      'manifest.version must equal VERSION file contents (SVN-03). ' +
        'manifest.version=' +
        JSON.stringify(manifest.version) +
        ' VERSION=' +
        JSON.stringify(versionContent),
    );
  } finally {
    cleanup(tmpDir);
  }
});

// ── install.js writes .runtime marker into the deployed engine tree ──

test('RUNTIME-01: install.js --runtime claude writes .runtime marker containing "claude" into .claude/gsd-ng/', () => {
  const tmpDir = fs.mkdtempSync(
    path.join(BASE_TMPDIR, 'gsd-js-runtime-claude-'),
  );
  try {
    const result = spawnSync(
      process.execPath,
      [INSTALLER, '--runtime', 'claude', '--local'],
      {
        encoding: 'utf8',
        timeout: 15000,
        cwd: tmpDir,
        env: Object.assign({}, process.env, { HOME: os.homedir() }),
      },
    );

    assert.strictEqual(
      result.status,
      0,
      'install.js --local --runtime claude must exit 0 (RUNTIME-01)\nstderr: ' +
        (result.stderr || ''),
    );

    const markerPath = path.join(tmpDir, '.claude', 'gsd-ng', '.runtime');
    assert.ok(
      fs.existsSync(markerPath),
      '.claude/gsd-ng/.runtime must exist after claude install (RUNTIME-01)',
    );

    const markerContent = fs.readFileSync(markerPath, 'utf8').trim();
    assert.strictEqual(
      markerContent,
      'claude',
      '.runtime marker must contain "claude" after claude install (RUNTIME-01)',
    );
  } finally {
    cleanup(tmpDir);
  }
});

test('RUNTIME-02: install.js --runtime copilot writes .runtime marker containing "copilot" into .github/gsd-ng/', () => {
  const tmpDir = fs.mkdtempSync(
    path.join(BASE_TMPDIR, 'gsd-js-runtime-copilot-'),
  );
  try {
    const result = spawnSync(
      process.execPath,
      [INSTALLER, '--runtime', 'copilot', '--local'],
      {
        encoding: 'utf8',
        timeout: 15000,
        cwd: tmpDir,
        env: Object.assign({}, process.env, { HOME: os.homedir() }),
      },
    );

    assert.strictEqual(
      result.status,
      0,
      'install.js --local --runtime copilot must exit 0 (RUNTIME-02)\nstderr: ' +
        (result.stderr || ''),
    );

    const markerPath = path.join(tmpDir, '.github', 'gsd-ng', '.runtime');
    assert.ok(
      fs.existsSync(markerPath),
      '.github/gsd-ng/.runtime must exist after copilot install (RUNTIME-02)',
    );

    const markerContent = fs.readFileSync(markerPath, 'utf8').trim();
    assert.strictEqual(
      markerContent,
      'copilot',
      '.runtime marker must contain "copilot" after copilot install (RUNTIME-02)',
    );
  } finally {
    cleanup(tmpDir);
  }
});

// ── env var rename — GSD_TEST_FORCE_PLATFORM is the test seam ────────

test('ALLOW-18: only GSD_TEST_FORCE_PLATFORM overrides platform detection — the old GSD_FORCE_PLATFORM name is inert', () => {
  const tmpDir = fs.mkdtempSync(path.join(BASE_TMPDIR, 'gsd-allow-18-'));
  try {
    const allowFor = (label, extraEnv) => {
      const dir = path.join(tmpDir, label);
      fs.mkdirSync(dir, { recursive: true });
      const result = spawnSync(
        process.execPath,
        [INSTALLER, '--runtime', 'claude', '--local'],
        {
          encoding: 'utf8',
          timeout: 15000,
          cwd: dir,
          env: Object.assign(
            {},
            process.env,
            { HOME: os.homedir() },
            { GSD_TEST_FORCE_PLATFORM: undefined, GSD_FORCE_PLATFORM: undefined },
            extraEnv,
          ),
        },
      );
      assert.strictEqual(
        result.status,
        0,
        `install must exit 0 (${label}, ALLOW-18)\nstderr: ` +
          (result.stderr || ''),
      );
      const settings = JSON.parse(
        fs.readFileSync(path.join(dir, '.claude', 'settings.json'), 'utf8'),
      );
      return settings.permissions?.allow ?? [];
    };

    const baseline = allowFor('baseline', {});
    const forcedOldName = allowFor('old-name', {
      GSD_FORCE_PLATFORM: 'win32',
    });
    assert.deepStrictEqual(
      forcedOldName,
      baseline,
      'GSD_FORCE_PLATFORM is the retired name and must have no effect on the seeded ' +
        'allow list — only GSD_TEST_FORCE_PLATFORM is the test seam (ALLOW-18)',
    );

    const forcedNewName = allowFor('new-name', {
      GSD_TEST_FORCE_PLATFORM: 'win32',
    });
    assert.ok(
      forcedNewName.includes('Edit(*)') && !forcedNewName.includes('Write'),
      'GSD_TEST_FORCE_PLATFORM=win32 must drive platform detection: canonical glob ' +
        'forms, no bare Write (ALLOW-18)',
    );
  } finally {
    cleanup(tmpDir);
  }
});

// ── GSD_TEST_FORCE_PLATFORM seam works at runtime ─────────────────────

test('ALLOW-19: GSD_TEST_FORCE_PLATFORM env var controls platform detection in seeding block', () => {
  const tmpDir = fs.mkdtempSync(path.join(BASE_TMPDIR, 'gsd-allow19-'));
  try {
    // Install with GSD_TEST_FORCE_PLATFORM overriding to 'linux'
    const result = spawnSync(
      process.execPath,
      [INSTALLER, '--runtime', 'claude', '--local'],
      {
        encoding: 'utf8',
        timeout: 15000,
        cwd: tmpDir,
        env: Object.assign({}, process.env, {
          HOME: os.homedir(),
          GSD_TEST_FORCE_PLATFORM: 'linux',
        }),
      },
    );
    assert.strictEqual(
      result.status,
      0,
      'install.js must exit 0 when GSD_TEST_FORCE_PLATFORM=linux is set (ALLOW-19)\nstderr: ' +
        (result.stderr || ''),
    );
    // settings.json must have been seeded (permissions block present)
    const settingsPath = path.join(tmpDir, '.claude', 'settings.json');
    assert.ok(
      fs.existsSync(settingsPath),
      'settings.json must exist (ALLOW-19)',
    );
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    assert.ok(
      Array.isArray(settings.permissions && settings.permissions.allow),
      'permissions.allow must be seeded when GSD_TEST_FORCE_PLATFORM is used (ALLOW-19)',
    );
  } finally {
    cleanup(tmpDir);
  }
});

test('RUNTIME-03: install.js preserves existing config.json values and writes .runtime marker', () => {
  const tmpDir = fs.mkdtempSync(
    path.join(BASE_TMPDIR, 'gsd-js-runtime-preserve-'),
  );
  try {
    // Create .planning dir and pre-existing config.json with some values
    fs.mkdirSync(path.join(tmpDir, '.planning'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'config.json'),
      JSON.stringify({ model_profile: 'quality', commit_docs: false }, null, 2),
      'utf-8',
    );

    const result = spawnSync(
      process.execPath,
      [INSTALLER, '--runtime', 'claude', '--local'],
      {
        encoding: 'utf8',
        timeout: 15000,
        cwd: tmpDir,
        env: Object.assign({}, process.env, { HOME: os.homedir() }),
      },
    );

    assert.strictEqual(
      result.status,
      0,
      'install.js must exit 0 even when config.json already exists (RUNTIME-03)\nstderr: ' +
        (result.stderr || ''),
    );

    // Existing config.json values must be preserved (install does not touch them)
    const config = JSON.parse(
      fs.readFileSync(path.join(tmpDir, '.planning', 'config.json'), 'utf8'),
    );
    assert.strictEqual(
      config.model_profile,
      'quality',
      'existing model_profile must be preserved (RUNTIME-03)',
    );

    // .runtime marker must be written into the engine tree
    const markerPath = path.join(tmpDir, '.claude', 'gsd-ng', '.runtime');
    assert.ok(
      fs.existsSync(markerPath),
      '.claude/gsd-ng/.runtime marker must exist (RUNTIME-03)',
    );
    assert.strictEqual(
      fs.readFileSync(markerPath, 'utf8').trim(),
      'claude',
      '.runtime marker must contain "claude" (RUNTIME-03)',
    );
  } finally {
    cleanup(tmpDir);
  }
});

test('RUNTIME-04: stale config.json runtime field is left inert; .runtime marker reflects actual install runtime', () => {
  const tmpDir = fs.mkdtempSync(
    path.join(BASE_TMPDIR, 'gsd-js-runtime-update-'),
  );
  try {
    // Pre-create config.json with a stale runtime: copilot field
    fs.mkdirSync(path.join(tmpDir, '.planning'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'config.json'),
      JSON.stringify({ runtime: 'copilot' }, null, 2),
      'utf-8',
    );

    // Install with claude runtime
    const result = spawnSync(
      process.execPath,
      [INSTALLER, '--runtime', 'claude', '--local'],
      {
        encoding: 'utf8',
        timeout: 15000,
        cwd: tmpDir,
        env: Object.assign({}, process.env, { HOME: os.homedir() }),
      },
    );

    assert.strictEqual(
      result.status,
      0,
      'install.js must exit 0 (RUNTIME-04)\nstderr: ' + (result.stderr || ''),
    );

    // The .runtime marker in the engine tree reflects the actual install runtime
    const markerPath = path.join(tmpDir, '.claude', 'gsd-ng', '.runtime');
    assert.ok(
      fs.existsSync(markerPath),
      '.claude/gsd-ng/.runtime marker must exist after claude install (RUNTIME-04)',
    );
    assert.strictEqual(
      fs.readFileSync(markerPath, 'utf8').trim(),
      'claude',
      '.runtime marker must contain "claude" (RUNTIME-04)',
    );

    // The stale config.json runtime field is left untouched (no migration)
    const config = JSON.parse(
      fs.readFileSync(path.join(tmpDir, '.planning', 'config.json'), 'utf8'),
    );
    assert.strictEqual(
      config.runtime,
      'copilot',
      'stale config.json runtime field must be left inert — no migration (RUNTIME-04)',
    );
  } finally {
    cleanup(tmpDir);
  }
});

// ── dual-runtime install-order integration test ───────────────────

function runDualRuntimeTest(firstRuntime, secondRuntime) {
  const tmpDir = fs.mkdtempSync(
    path.join(BASE_TMPDIR, `gsd-js-dual-${firstRuntime}-${secondRuntime}-`),
  );
  try {
    const runInstall = (rt) =>
      spawnSync(
        process.execPath,
        [INSTALLER, '--runtime', rt, '--local'],
        {
          encoding: 'utf8',
          timeout: 15000,
          cwd: tmpDir,
          env: Object.assign({}, process.env, { HOME: os.homedir() }),
        },
      );

    // Install both runtimes in order
    const r1 = runInstall(firstRuntime);
    assert.strictEqual(
      r1.status,
      0,
      `first install (${firstRuntime}) must exit 0\nstderr: ${r1.stderr || ''}`,
    );
    const r2 = runInstall(secondRuntime);
    assert.strictEqual(
      r2.status,
      0,
      `second install (${secondRuntime}) must exit 0\nstderr: ${r2.stderr || ''}`,
    );

    // Both markers must exist with correct content
    const claudeMarker = path.join(tmpDir, '.claude', 'gsd-ng', '.runtime');
    const copilotMarker = path.join(tmpDir, '.github', 'gsd-ng', '.runtime');
    assert.ok(fs.existsSync(claudeMarker), `.claude/gsd-ng/.runtime must exist (${firstRuntime}-then-${secondRuntime})`);
    assert.ok(fs.existsSync(copilotMarker), `.github/gsd-ng/.runtime must exist (${firstRuntime}-then-${secondRuntime})`);
    assert.strictEqual(fs.readFileSync(claudeMarker, 'utf8').trim(), 'claude', `.claude marker must be "claude" (${firstRuntime}-then-${secondRuntime})`);
    assert.strictEqual(fs.readFileSync(copilotMarker, 'utf8').trim(), 'copilot', `.github marker must be "copilot" (${firstRuntime}-then-${secondRuntime})`);

    // Set up a model_profile so effort sync produces a non-null result
    fs.mkdirSync(path.join(tmpDir, '.planning'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'config.json'),
      JSON.stringify({ model_profile: 'quality' }, null, 2),
      'utf-8',
    );

    // Create a gsd-planner.md agent in Claude's agents dir
    const claudeAgentsDir = path.join(tmpDir, '.claude', 'agents');
    fs.mkdirSync(claudeAgentsDir, { recursive: true });
    fs.writeFileSync(
      path.join(claudeAgentsDir, 'gsd-planner.md'),
      '---\nmodel: claude-opus-4-5\n---\n# GSD Planner\n',
      'utf-8',
    );

    // Create a gsd-planner.md agent in Copilot's agents dir
    const copilotAgentsDir = path.join(tmpDir, '.github', 'agents');
    fs.mkdirSync(copilotAgentsDir, { recursive: true });
    fs.writeFileSync(
      path.join(copilotAgentsDir, 'gsd-planner.md'),
      '---\nmodel: claude-opus-4-5\n---\n# GSD Planner\n',
      'utf-8',
    );

    // Invoke each deployed engine's sync-agents CLI
    const claudeGsdTools = path.join(tmpDir, '.claude', 'gsd-ng', 'bin', 'gsd-tools.cjs');
    const copilotGsdTools = path.join(tmpDir, '.github', 'gsd-ng', 'bin', 'gsd-tools.cjs');

    const claudeSync = spawnSync(
      process.execPath,
      [claudeGsdTools, 'sync-agents', '--agents-dir', claudeAgentsDir],
      { encoding: 'utf8', timeout: 10000, cwd: tmpDir },
    );
    const copilotSync = spawnSync(
      process.execPath,
      [copilotGsdTools, 'sync-agents', '--agents-dir', copilotAgentsDir],
      { encoding: 'utf8', timeout: 10000, cwd: tmpDir },
    );

    assert.strictEqual(
      claudeSync.status,
      0,
      `Claude sync-agents must exit 0 (${firstRuntime}-then-${secondRuntime})\nstderr: ${claudeSync.stderr || ''}`,
    );
    assert.strictEqual(
      copilotSync.status,
      0,
      `Copilot sync-agents must exit 0 (${firstRuntime}-then-${secondRuntime})\nstderr: ${copilotSync.stderr || ''}`,
    );

    // Claude engine: gsd-planner.md must have effort: frontmatter (quality profile → xhigh)
    const claudeAgentContent = fs.readFileSync(path.join(claudeAgentsDir, 'gsd-planner.md'), 'utf-8');
    assert.ok(
      /^effort:\s*xhigh$/m.test(claudeAgentContent),
      `Claude agent must have effort: xhigh after sync (${firstRuntime}-then-${secondRuntime})\nactual:\n${claudeAgentContent}`,
    );

    // Copilot engine: gsd-planner.md must NOT have effort: frontmatter
    const copilotAgentContent = fs.readFileSync(path.join(copilotAgentsDir, 'gsd-planner.md'), 'utf-8');
    assert.ok(
      !/^effort:/m.test(copilotAgentContent),
      `Copilot agent must NOT have effort: after sync (${firstRuntime}-then-${secondRuntime})\nactual:\n${copilotAgentContent}`,
    );
  } finally {
    cleanup(tmpDir);
  }
}

test('RUNTIME-DUAL-A: claude-then-copilot install — Claude agents get effort:, Copilot agents do not, regardless of install order', () => {
  runDualRuntimeTest('claude', 'copilot');
});

test('RUNTIME-DUAL-B: copilot-then-claude install — Claude agents get effort:, Copilot agents do not, regardless of install order', () => {
  runDualRuntimeTest('copilot', 'claude');
});

// ── double-install is idempotent — no phantom local modifications ──

test('MANIFEST-STAB-01: running --local claude install twice produces no "Found N locally modified" output and no populated gsd-local-patches/', () => {
  const tmpDir = fs.mkdtempSync(path.join(BASE_TMPDIR, 'gsd-manifest-stab-'));
  try {
    const runInstall = () =>
      spawnSync(
        process.execPath,
        [INSTALLER, '--runtime', 'claude', '--local'],
        {
          encoding: 'utf8',
          timeout: 15000,
          cwd: tmpDir,
          env: Object.assign({}, process.env, { HOME: os.homedir() }),
        },
      );
    const r1 = runInstall();
    assert.strictEqual(
      r1.status,
      0,
      'first install must exit 0 (MANIFEST-STAB-01)\nstderr: ' +
        (r1.stderr || ''),
    );
    const r2 = runInstall();
    assert.strictEqual(
      r2.status,
      0,
      'second install must exit 0 (MANIFEST-STAB-01)\nstderr: ' +
        (r2.stderr || ''),
    );

    const r2Stdout = r2.stdout || '';
    assert.ok(
      !/Found \d+ locally modified GSD file/.test(r2Stdout),
      'second install must NOT report locally modified GSD files (MANIFEST-STAB-01).\n' +
        'stdout: ' +
        r2Stdout.slice(0, 2000),
    );

    // gsd-local-patches either does not exist, or contains only meta/placeholder entries.
    const patchesDir = path.join(tmpDir, '.claude', 'gsd-local-patches');
    if (fs.existsSync(patchesDir)) {
      const entries = fs
        .readdirSync(patchesDir)
        .filter((e) => e !== '.gitkeep');
      assert.strictEqual(
        entries.length,
        0,
        'gsd-local-patches/ must be empty after double install (MANIFEST-STAB-01). Entries: ' +
          entries.join(', '),
      );
    }
  } finally {
    cleanup(tmpDir);
  }
});

// ── no unresolved {{…}} tokens in deployed .md files ──

test('TEMPLATE-RESOLVE-01: after single --local claude install, no .md file under commands/gsd/ or gsd-ng/ contains {{USER_QUESTION_TOOL}} or {{PROJECT_RULES_FILE}}', () => {
  const tmpDir = fs.mkdtempSync(path.join(BASE_TMPDIR, 'gsd-tpl-resolve-'));
  try {
    const result = spawnSync(
      process.execPath,
      [INSTALLER, '--runtime', 'claude', '--local'],
      {
        encoding: 'utf8',
        timeout: 15000,
        cwd: tmpDir,
        env: Object.assign({}, process.env, { HOME: os.homedir() }),
      },
    );
    assert.strictEqual(
      result.status,
      0,
      'install must exit 0 (TEMPLATE-RESOLVE-01)\nstderr: ' +
        (result.stderr || ''),
    );

    const roots = [
      path.join(tmpDir, '.claude', 'commands', 'gsd'),
      path.join(tmpDir, '.claude', 'gsd-ng'),
    ];
    const BAD_TOKENS = [
      '{{USER_QUESTION_TOOL}}',
      '{{PROJECT_RULES_FILE}}',
      '{{COMMAND_PREFIX}}',
      '{{GSD_BLOCK_OPEN}}',
      '{{GSD_BLOCK_CLOSE}}',
      '{{MEMORY_DIR}}',
    ];

    function walk(dir, out) {
      if (!fs.existsSync(dir)) return;
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full, out);
        else if (entry.isFile() && entry.name.endsWith('.md')) out.push(full);
      }
    }

    const mdFiles = [];
    for (const root of roots) walk(root, mdFiles);
    assert.ok(
      mdFiles.length > 0,
      'expected deployed .md files to exist under commands/gsd/ and gsd-ng/ (TEMPLATE-RESOLVE-01)',
    );

    const offenders = [];
    for (const f of mdFiles) {
      const content = fs.readFileSync(f, 'utf8');
      for (const tok of BAD_TOKENS) {
        if (content.includes(tok)) {
          offenders.push(path.relative(tmpDir, f) + ' :: ' + tok);
          break;
        }
      }
    }
    assert.strictEqual(
      offenders.length,
      0,
      'unresolved template tokens found in deployed .md files (TEMPLATE-RESOLVE-01):\n' +
        offenders.slice(0, 20).join('\n'),
    );
  } finally {
    cleanup(tmpDir);
  }
});

// ── every manifest entry hashes to the on-disk file SHA256 ──

test('MANIFEST-DISK-01: after single --local claude install, gsd-file-manifest.json entries match SHA256 of deployed files', () => {
  const tmpDir = fs.mkdtempSync(path.join(BASE_TMPDIR, 'gsd-manifest-disk-'));
  try {
    const result = spawnSync(
      process.execPath,
      [INSTALLER, '--runtime', 'claude', '--local'],
      {
        encoding: 'utf8',
        timeout: 15000,
        cwd: tmpDir,
        env: Object.assign({}, process.env, { HOME: os.homedir() }),
      },
    );
    assert.strictEqual(
      result.status,
      0,
      'install must exit 0 (MANIFEST-DISK-01)\nstderr: ' +
        (result.stderr || ''),
    );

    const configDir = path.join(tmpDir, '.claude');
    const manifestPath = path.join(configDir, 'gsd-file-manifest.json');
    assert.ok(
      fs.existsSync(manifestPath),
      'gsd-file-manifest.json must exist (MANIFEST-DISK-01)',
    );

    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    assert.ok(
      manifest.files && typeof manifest.files === 'object',
      'manifest.files must be an object',
    );
    const entries = Object.entries(manifest.files);
    assert.ok(entries.length > 0, 'manifest.files must be non-empty');

    const mismatches = [];
    for (const [relPath, storedHash] of entries) {
      const full = path.join(configDir, relPath);
      if (!fs.existsSync(full)) {
        mismatches.push(relPath + ' :: MISSING_FILE');
        continue;
      }
      const actual = crypto
        .createHash('sha256')
        .update(fs.readFileSync(full))
        .digest('hex');
      if (actual !== storedHash) {
        mismatches.push(
          relPath +
            ' :: manifest=' +
            storedHash.slice(0, 12) +
            ' disk=' +
            actual.slice(0, 12),
        );
      }
    }
    assert.strictEqual(
      mismatches.length,
      0,
      'manifest hashes must match on-disk SHA256 (MANIFEST-DISK-01):\n' +
        mismatches.slice(0, 20).join('\n'),
    );
  } finally {
    cleanup(tmpDir);
  }
});

// ── writeManifest writes schema_version: 2 ──────────────────

test('MANIFEST-V2-01: writeManifest writes schema_version: 2 in fresh manifest', () => {
  const tmpDir = fs.mkdtempSync(path.join(BASE_TMPDIR, 'gsd-manifest-v2-01-'));
  try {
    const result = spawnSync(
      process.execPath,
      [INSTALLER, '--runtime', 'claude', '--local'],
      {
        encoding: 'utf8',
        timeout: 15000,
        cwd: tmpDir,
        env: Object.assign({}, process.env, { HOME: os.homedir() }),
      },
    );
    assert.strictEqual(
      result.status,
      0,
      'install must exit 0 (MANIFEST-V2-01)\nstderr: ' + (result.stderr || ''),
    );
    const manifestPath = path.join(tmpDir, '.claude', 'gsd-file-manifest.json');
    assert.ok(
      fs.existsSync(manifestPath),
      'gsd-file-manifest.json must exist (MANIFEST-V2-01)',
    );
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    assert.strictEqual(
      manifest.schema_version,
      2,
      'manifest.schema_version must be integer 2 (MANIFEST-V2-01)',
    );
  } finally {
    cleanup(tmpDir);
  }
});

// ── v1 manifest triggers migration notice and refreshes files ─

test('MANIFEST-V2-02: v1 manifest (missing schema_version) triggers migration notice and refreshes files', () => {
  const tmpDir = fs.mkdtempSync(path.join(BASE_TMPDIR, 'gsd-manifest-v2-02-'));
  try {
    const runInstall = () =>
      spawnSync(
        process.execPath,
        [INSTALLER, '--runtime', 'claude', '--local'],
        {
          encoding: 'utf8',
          timeout: 15000,
          cwd: tmpDir,
          env: Object.assign({}, process.env, { HOME: os.homedir() }),
        },
      );

    // First install — establishes v2 manifest
    const r1 = runInstall();
    assert.strictEqual(
      r1.status,
      0,
      'first install must exit 0 (MANIFEST-V2-02)\nstderr: ' +
        (r1.stderr || ''),
    );

    // Strip schema_version to simulate a v1 manifest
    const mPath = path.join(tmpDir, '.claude', 'gsd-file-manifest.json');
    const m = JSON.parse(fs.readFileSync(mPath, 'utf8'));
    delete m.schema_version;

    // Pick the first managed file from the manifest to mutate
    const managedFiles = Object.keys(m.files || {});
    assert.ok(
      managedFiles.length > 0,
      'manifest must have at least one managed file (MANIFEST-V2-02)',
    );
    const targetRelPath = managedFiles[0];
    const targetAbsPath = path.join(tmpDir, '.claude', targetRelPath);

    fs.writeFileSync(mPath, JSON.stringify(m, null, 2));
    fs.appendFileSync(targetAbsPath, '\n<!-- LOCAL EDIT MARKER -->\n');

    // Second install — should detect v1 manifest and run migration
    const r2 = runInstall();
    assert.strictEqual(
      r2.status,
      0,
      'second install must exit 0 (MANIFEST-V2-02)\nstderr: ' +
        (r2.stderr || ''),
    );

    const r2Stdout = r2.stdout || '';
    assert.match(
      r2Stdout,
      /Migrated manifest to v2 — files refreshed from source/,
      'migration notice must appear in stdout (MANIFEST-V2-02)',
    );
    assert.match(
      r2Stdout,
      /Your modifications were backed up to/,
      'backup notice must appear because file was mutated (MANIFEST-V2-02)',
    );

    // Patches dir must exist and contain the mutated file
    const patchesDir = path.join(tmpDir, '.claude', 'gsd-local-patches');
    assert.ok(
      fs.existsSync(patchesDir),
      'gsd-local-patches/ must exist after migration (MANIFEST-V2-02)',
    );

    // Fresh v2 manifest must have been written
    const m2 = JSON.parse(fs.readFileSync(mPath, 'utf8'));
    assert.strictEqual(
      m2.schema_version,
      2,
      'manifest must be re-written as v2 after migration (MANIFEST-V2-02)',
    );

    // reportLocalPatches must be suppressed — no "Local patches detected" prompt
    assert.ok(
      !r2Stdout.includes('Local patches detected'),
      'stdout must NOT contain "Local patches detected" after migration (MANIFEST-V2-02).\nstdout: ' +
        r2Stdout.slice(0, 2000),
    );
  } finally {
    cleanup(tmpDir);
  }
});

// ── migration does not run when schema_version: 2 already present ─

test('MANIFEST-V2-03: migration does not run when schema_version: 2 already present', () => {
  const tmpDir = fs.mkdtempSync(path.join(BASE_TMPDIR, 'gsd-manifest-v2-03-'));
  try {
    const runInstall = () =>
      spawnSync(
        process.execPath,
        [INSTALLER, '--runtime', 'claude', '--local'],
        {
          encoding: 'utf8',
          timeout: 15000,
          cwd: tmpDir,
          env: Object.assign({}, process.env, { HOME: os.homedir() }),
        },
      );

    // First install — writes v2 manifest
    const r1 = runInstall();
    assert.strictEqual(
      r1.status,
      0,
      'first install must exit 0 (MANIFEST-V2-03)\nstderr: ' +
        (r1.stderr || ''),
    );
    assert.ok(
      (r1.stdout || '').includes('Wrote file manifest'),
      'first install stdout must confirm manifest write (MANIFEST-V2-03)',
    );

    // Second install — manifest already at v2, no migration should run
    const r2 = runInstall();
    assert.strictEqual(
      r2.status,
      0,
      'second install must exit 0 (MANIFEST-V2-03)\nstderr: ' +
        (r2.stderr || ''),
    );
    assert.ok(
      !(r2.stdout || '').includes('Migrated manifest to v2'),
      'second install must NOT emit migration notice when schema_version: 2 is already present (MANIFEST-V2-03).\nstdout: ' +
        (r2.stdout || '').slice(0, 2000),
    );
  } finally {
    cleanup(tmpDir);
  }
});

// ── reportLocalPatches skipped after migration run ───────────

test('MANIFEST-V2-04: reportLocalPatches skipped after migration run', () => {
  const tmpDir = fs.mkdtempSync(path.join(BASE_TMPDIR, 'gsd-manifest-v2-04-'));
  try {
    const runInstall = () =>
      spawnSync(
        process.execPath,
        [INSTALLER, '--runtime', 'claude', '--local'],
        {
          encoding: 'utf8',
          timeout: 15000,
          cwd: tmpDir,
          env: Object.assign({}, process.env, { HOME: os.homedir() }),
        },
      );

    // First install
    const r1 = runInstall();
    assert.strictEqual(
      r1.status,
      0,
      'first install must exit 0 (MANIFEST-V2-04)\nstderr: ' +
        (r1.stderr || ''),
    );

    // Simulate v1 manifest and mutate a managed file
    const mPath = path.join(tmpDir, '.claude', 'gsd-file-manifest.json');
    const m = JSON.parse(fs.readFileSync(mPath, 'utf8'));
    delete m.schema_version;
    const managedFiles = Object.keys(m.files || {});
    assert.ok(
      managedFiles.length > 0,
      'manifest must have managed files (MANIFEST-V2-04)',
    );
    const targetAbsPath = path.join(tmpDir, '.claude', managedFiles[0]);
    fs.writeFileSync(mPath, JSON.stringify(m, null, 2));
    fs.appendFileSync(targetAbsPath, '\n<!-- LOCAL EDIT MARKER -->\n');

    // Second install — migration runs
    const r2 = runInstall();
    assert.strictEqual(
      r2.status,
      0,
      'second install must exit 0 (MANIFEST-V2-04)\nstderr: ' +
        (r2.stderr || ''),
    );

    // reportLocalPatches output must be suppressed
    assert.ok(
      !(r2.stdout || '').includes('Local patches detected'),
      '"Local patches detected" must NOT appear when migration ran (MANIFEST-V2-04).\nstdout: ' +
        (r2.stdout || '').slice(0, 2000),
    );
  } finally {
    cleanup(tmpDir);
  }
});

// ── --clean discards a corrupted manifest and rebuilds it to match the tree ──

test('CLEAN-01: --clean discards a corrupted manifest and writes a fresh v2 whose every entry exists on disk', () => {
  const tmpDir = fs.mkdtempSync(path.join(BASE_TMPDIR, 'gsd-clean-01-'));
  try {
    const runInstall = (extraArgs = []) =>
      spawnSync(
        process.execPath,
        [INSTALLER, '--runtime', 'claude', '--local', ...extraArgs],
        {
          encoding: 'utf8',
          timeout: 15000,
          cwd: tmpDir,
          env: Object.assign({}, process.env, { HOME: os.homedir() }),
        },
      );
    const r1 = runInstall();
    assert.strictEqual(
      r1.status,
      0,
      'first install must exit 0\nstderr: ' + (r1.stderr || ''),
    );
    const mPath = path.join(tmpDir, '.claude', 'gsd-file-manifest.json');
    fs.writeFileSync(mPath, '{"corrupted":true}');

    const r2 = runInstall(['--clean']);
    assert.strictEqual(
      r2.status,
      0,
      '--clean install must exit 0\nstderr: ' + (r2.stderr || ''),
    );

    const manifest = JSON.parse(fs.readFileSync(mPath, 'utf8'));
    assert.strictEqual(
      manifest.schema_version,
      2,
      'manifest must have schema_version: 2 after --clean install',
    );
    assert.ok(
      manifest.files && Object.keys(manifest.files).length > 0,
      'manifest.files must be non-empty after --clean install',
    );
    for (const rel of Object.keys(manifest.files)) {
      assert.ok(
        fs.existsSync(path.join(tmpDir, '.claude', rel)),
        'every file the fresh manifest records must exist on disk after --clean ' +
          '(a wipe running after the install would leave these recorded but gone): ' +
          rel,
      );
    }
  } finally {
    cleanup(tmpDir);
  }
});

// ── --clean leaves gsd-local-patches/ intact ──────────────────────

test('CLEAN-02: --clean leaves gsd-local-patches/ intact', () => {
  const tmpDir = fs.mkdtempSync(path.join(BASE_TMPDIR, 'gsd-clean-02-'));
  try {
    const runInstall = (extraArgs = []) =>
      spawnSync(
        process.execPath,
        [INSTALLER, '--runtime', 'claude', '--local', ...extraArgs],
        {
          encoding: 'utf8',
          timeout: 15000,
          cwd: tmpDir,
          env: Object.assign({}, process.env, { HOME: os.homedir() }),
        },
      );
    assert.strictEqual(runInstall().status, 0);
    const patchesDir = path.join(tmpDir, '.claude', 'gsd-local-patches');
    fs.mkdirSync(patchesDir, { recursive: true });
    const sentinelPath = path.join(patchesDir, 'sentinel.txt');
    fs.writeFileSync(sentinelPath, 'sentinel');
    const r = runInstall(['--clean']);
    assert.strictEqual(
      r.status,
      0,
      '--clean must exit 0\nstderr: ' + (r.stderr || ''),
    );
    assert.ok(fs.existsSync(sentinelPath), 'sentinel.txt must survive --clean');
    assert.strictEqual(fs.readFileSync(sentinelPath, 'utf8'), 'sentinel');
    assert.ok(
      fs.existsSync(path.join(tmpDir, '.claude', 'commands', 'gsd')),
      'commands/gsd/ must be re-installed after --clean wipe',
    );
  } finally {
    cleanup(tmpDir);
  }
});

// ── --clean skips migration even when manifest is v1 ───────────────

test('CLEAN-03: --clean skips migration even when manifest is v1 (missing schema_version)', () => {
  const tmpDir = fs.mkdtempSync(path.join(BASE_TMPDIR, 'gsd-clean-03-'));
  try {
    const runInstall = (extraArgs = []) =>
      spawnSync(
        process.execPath,
        [INSTALLER, '--runtime', 'claude', '--local', ...extraArgs],
        {
          encoding: 'utf8',
          timeout: 15000,
          cwd: tmpDir,
          env: Object.assign({}, process.env, { HOME: os.homedir() }),
        },
      );
    assert.strictEqual(runInstall().status, 0);
    // Strip schema_version to simulate v1 manifest
    const mPath = path.join(tmpDir, '.claude', 'gsd-file-manifest.json');
    const m = JSON.parse(fs.readFileSync(mPath, 'utf8'));
    delete m.schema_version;
    fs.writeFileSync(mPath, JSON.stringify(m, null, 2));
    const r = runInstall(['--clean']);
    assert.strictEqual(
      r.status,
      0,
      '--clean must exit 0\nstderr: ' + (r.stderr || ''),
    );
    assert.ok(
      !/Migrated manifest to v2/.test(r.stdout || ''),
      '--clean must NOT trigger migration notice. stdout:\n' +
        (r.stdout || '').slice(0, 1500),
    );
    const finalManifest = JSON.parse(fs.readFileSync(mPath, 'utf8'));
    assert.strictEqual(
      finalManifest.schema_version,
      2,
      'manifest must be v2 after --clean install',
    );
  } finally {
    cleanup(tmpDir);
  }
});

// ── --help output documents --clean ────────────────────────────────

test('CLEAN-04: --help output documents --clean', () => {
  const tmpDir = fs.mkdtempSync(path.join(BASE_TMPDIR, 'gsd-clean-04-'));
  try {
    const r = spawnSync(
      process.execPath,
      [INSTALLER, '--runtime', 'claude', '--help'],
      {
        encoding: 'utf8',
        timeout: 15000,
        cwd: tmpDir,
        env: Object.assign({}, process.env, { HOME: os.homedir() }),
      },
    );
    assert.strictEqual(
      r.status,
      0,
      '--help must exit 0\nstderr: ' + (r.stderr || ''),
    );
    assert.ok(
      /--clean/.test(r.stdout || ''),
      '--help must mention --clean. stdout:\n' + (r.stdout || ''),
    );
    assert.ok(
      /Wipe/.test(r.stdout || ''),
      '--help must include descriptive copy for --clean (containing "Wipe"). stdout:\n' +
        (r.stdout || ''),
    );
  } finally {
    cleanup(tmpDir);
  }
});

// ── --clean preserves user-owned content ───────────────────────────

test('CLEANEV-01: --clean preserves user-owned content on the Claude runtime', () => {
  const tmpDir = fs.mkdtempSync(path.join(BASE_TMPDIR, 'gsd-cleanev-01-'));
  try {
    const runInstall = (extraArgs = []) =>
      spawnSync(
        process.execPath,
        [INSTALLER, '--runtime', 'claude', '--local', ...extraArgs],
        {
          encoding: 'utf8',
          timeout: 15000,
          cwd: tmpDir,
          env: Object.assign({}, process.env, { HOME: os.homedir() }),
        },
      );

    const r1 = runInstall();
    assert.strictEqual(
      r1.status,
      0,
      'baseline install must exit 0\nstderr: ' + (r1.stderr || ''),
    );

    const claudeDir = path.join(tmpDir, '.claude');

    // User-owned content the wipe must never touch. Deliberately NOT gsd-prefixed:
    // gsd-*.md agents and the six named gsd hook files are deleted by design.
    const planted = [
      [path.join(claudeDir, 'agents', 'zz-user-agent.md'), 'zz-user-agent-body'],
      [path.join(claudeDir, 'hooks', 'zz-user-hook.js'), 'zz-user-hook-body'],
      [path.join(claudeDir, 'commands', 'zz-user-cmd.md'), 'zz-user-cmd-body'],
      [
        path.join(claudeDir, 'commands', 'zz-user-dir', 'nested.md'),
        'zz-user-nested-body',
      ],
      [
        path.join(claudeDir, 'gsd-local-patches', 'sentinel.txt'),
        'zz-user-patch-body',
      ],
    ];
    for (const [filePath, body] of planted) {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, body);
    }

    // Stale-wipe witness. This is the ONE path on the Claude runtime where the
    // wipe is observable: it is in the wipe's six-name hook list, but no file of
    // this name ships in the source hooks/ dir, and the ordinary install's hook
    // step only copies files in — it never deletes. So a plain reinstall leaves
    // it alone and only a real wipe removes it. Every other location the wipe
    // touches (commands/gsd, gsd-ng/, agents/gsd-*.md) is also cleared by the
    // ordinary install, so absence there would prove nothing.
    const staleWitness = path.join(claudeDir, 'hooks', 'gsd-check-update.sh');
    fs.writeFileSync(staleWitness, 'stale-gsd-owned-file');

    const settingsPath = path.join(claudeDir, 'settings.json');
    const settingsBefore = fs.existsSync(settingsPath)
      ? fs.readFileSync(settingsPath, 'utf8')
      : null;

    const r2 = runInstall(['--clean']);
    assert.strictEqual(
      r2.status,
      0,
      '--clean install must exit 0\nstderr: ' + (r2.stderr || ''),
    );

    for (const [filePath, body] of planted) {
      assert.ok(
        fs.existsSync(filePath),
        'user-owned file must survive --clean: ' + filePath,
      );
      assert.strictEqual(
        fs.readFileSync(filePath, 'utf8'),
        body,
        'user-owned file must be byte-identical after --clean: ' + filePath,
      );
    }

    if (settingsBefore !== null) {
      assert.ok(
        fs.existsSync(settingsPath),
        'settings.json must survive --clean',
      );
      assert.strictEqual(
        fs.readFileSync(settingsPath, 'utf8'),
        settingsBefore,
        'settings.json content must be unchanged by --clean',
      );
    }

    // The wipe actually ran: a stale GSD-owned file the installer never writes
    // back is gone. This is the assertion a no-op --clean fails; the refresh
    // checks below only prove that an install ran.
    assert.ok(
      !fs.existsSync(staleWitness),
      'stale GSD-owned file must be deleted by --clean: ' + staleWitness,
    );

    // The tree was reinstalled after the wipe, not merely emptied.
    assert.ok(
      fs.existsSync(path.join(claudeDir, 'commands', 'gsd')),
      'commands/gsd/ must be re-installed after --clean',
    );
    const manifest = JSON.parse(
      fs.readFileSync(path.join(claudeDir, 'gsd-file-manifest.json'), 'utf8'),
    );
    assert.strictEqual(
      manifest.schema_version,
      2,
      'manifest must be freshly written with schema_version: 2 after --clean',
    );
  } finally {
    cleanup(tmpDir);
  }
});

// ── uninstall leaves nothing GSD installed ─────────────────────────

// Recursively list files under `dir`, relative to it. Absent dir -> [].
function listFilesRelative(dir, base) {
  base = base || dir;
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFilesRelative(full, base));
    else out.push(path.relative(base, full).replace(/\\/g, '/'));
  }
  return out.sort();
}

// settings.json is the runtime's own config file, not a GSD artifact: GSD merges
// entries into whatever is already there and strips them again on uninstall, so
// the file surviving is the documented contract rather than a leak.
const UNINSTALL_SURVIVORS = new Set(['settings.json']);

test('UNINST-CLEAN-01: uninstall leaves no GSD-installed file behind on the Claude runtime', () => {
  const tmpDir = fs.mkdtempSync(path.join(BASE_TMPDIR, 'gsd-uninst-clean-01-'));
  try {
    const run = (extraArgs = []) =>
      spawnSync(
        process.execPath,
        [INSTALLER, '--runtime', 'claude', '--local', ...extraArgs],
        {
          encoding: 'utf8',
          timeout: 15000,
          cwd: tmpDir,
          env: Object.assign({}, process.env, { HOME: os.homedir() }),
        },
      );

    const r1 = run();
    assert.strictEqual(
      r1.status,
      0,
      'install must exit 0\nstderr: ' + (r1.stderr || ''),
    );

    const claudeDir = path.join(tmpDir, '.claude');

    // Positive control. The install ran into an empty directory, so every file
    // now present was written by GSD — the leftover set below is measured
    // against that, not against a guessed inventory. Naming two of them
    // explicitly keeps the test honest if the install stops producing them:
    // an absent file would otherwise make the removal assertion vacuous.
    const installed = listFilesRelative(claudeDir);
    assert.ok(installed.length > 0, 'install must write files into .claude');
    for (const expected of [
      'hooks/bash-safety-hook.cjs',
      'gsd-file-manifest.json',
    ]) {
      assert.ok(
        installed.includes(expected),
        'install must write ' +
          expected +
          ' for its removal to be meaningful. Installed:\n' +
          installed.join('\n'),
      );
    }

    const r2 = run(['--uninstall']);
    assert.strictEqual(
      r2.status,
      0,
      'uninstall must exit 0\nstderr: ' + (r2.stderr || ''),
    );

    const leftover = listFilesRelative(claudeDir).filter(
      (f) => !UNINSTALL_SURVIVORS.has(f),
    );
    assert.deepStrictEqual(
      leftover,
      [],
      'uninstall must remove every file GSD installed. Left behind:\n' +
        leftover.join('\n'),
    );

    // A hook file removed from disk must not keep a settings.json entry
    // pointing at it, or the runtime fails on every matching tool call.
    const settingsPath = path.join(claudeDir, 'settings.json');
    if (fs.existsSync(settingsPath)) {
      const settingsText = fs.readFileSync(settingsPath, 'utf8');
      for (const hook of [
        'bash-safety-hook.cjs',
        'gsd-guardrail.js',
        'gsd-sandbox-detect.js',
        'gsd-statusline.js',
        'gsd-check-update.js',
        'gsd-context-monitor.js',
      ]) {
        assert.ok(
          !settingsText.includes(hook),
          'settings.json must not reference removed hook ' +
            hook +
            ' after uninstall. settings.json:\n' +
            settingsText,
        );
      }
    }
  } finally {
    cleanup(tmpDir);
  }
});

test('UNINST-CLEAN-02: uninstall leaves no GSD-installed file behind on the Copilot runtime', () => {
  const tmpDir = fs.mkdtempSync(path.join(BASE_TMPDIR, 'gsd-uninst-clean-02-'));
  try {
    const run = (extraArgs = []) =>
      spawnSync(
        process.execPath,
        [INSTALLER, '--runtime', 'copilot', '--local', ...extraArgs],
        {
          encoding: 'utf8',
          timeout: 15000,
          cwd: tmpDir,
          env: Object.assign({}, process.env, { HOME: os.homedir() }),
        },
      );

    const r1 = run();
    assert.strictEqual(
      r1.status,
      0,
      'install must exit 0\nstderr: ' + (r1.stderr || ''),
    );

    const githubDir = path.join(tmpDir, '.github');
    const installed = listFilesRelative(githubDir);
    assert.ok(
      installed.includes('gsd-file-manifest.json'),
      'install must write the manifest for its removal to be meaningful',
    );
    assert.ok(
      installed.includes('hooks/gsd-hooks.json'),
      'install must write the hook descriptor for its removal to be meaningful',
    );

    const r2 = run(['--uninstall']);
    assert.strictEqual(
      r2.status,
      0,
      'uninstall must exit 0\nstderr: ' + (r2.stderr || ''),
    );

    const leftover = listFilesRelative(githubDir);
    assert.deepStrictEqual(
      leftover,
      [],
      'uninstall must remove every file GSD installed. Left behind:\n' +
        leftover.join('\n'),
    );
  } finally {
    cleanup(tmpDir);
  }
});

// ── retired hooks are removed, not stranded ────────────────────────

test('UNINST-CLEAN-03: a hook installed by an earlier release but no longer shipped is removed by --clean', () => {
  const tmpDir = fs.mkdtempSync(path.join(BASE_TMPDIR, 'gsd-uninst-clean-03-'));
  try {
    const run = (extraArgs = []) =>
      spawnSync(
        process.execPath,
        [INSTALLER, '--runtime', 'claude', '--local', ...extraArgs],
        {
          encoding: 'utf8',
          timeout: 15000,
          cwd: tmpDir,
          env: Object.assign({}, process.env, { HOME: os.homedir() }),
        },
      );

    assert.strictEqual(run().status, 0, 'baseline install must exit 0');

    const claudeDir = path.join(tmpDir, '.claude');
    const manifestPath = path.join(claudeDir, 'gsd-file-manifest.json');
    const retiredHook = path.join(claudeDir, 'hooks', 'gsd-legacy-probe.js');

    // Fixture for a hook some earlier release shipped and this one does not.
    // Its name is deliberately absent from the package's hooks/ dir, so the only
    // thing that can identify it as GSD-owned is the install's own record of
    // what it wrote.
    const plantRetiredHook = () => {
      fs.writeFileSync(retiredHook, 'retired-gsd-hook-body');
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      manifest.installed_hooks = [
        ...(manifest.installed_hooks || []),
        'gsd-legacy-probe.js',
      ];
      fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    };

    plantRetiredHook();

    // Positive control: the ordinary install copies hooks in and never deletes,
    // so a plain reinstall must leave the fixture alone. Without this, the
    // fixture's absence after --clean would not distinguish the wipe from any
    // other step in the install.
    assert.strictEqual(run().status, 0, 'control reinstall must exit 0');
    assert.ok(
      fs.existsSync(retiredHook),
      'ordinary install must not delete the retired hook — otherwise its ' +
        'absence after --clean proves nothing about the wipe',
    );

    // The control reinstall rewrote the manifest from the shipped hook set,
    // dropping the fixture's record. Re-plant so --clean sees the state a real
    // upgrade from the earlier release would present.
    plantRetiredHook();

    const r = run(['--clean']);
    assert.strictEqual(
      r.status,
      0,
      '--clean install must exit 0\nstderr: ' + (r.stderr || ''),
    );

    assert.ok(
      !fs.existsSync(retiredHook),
      'a hook recorded as installed but no longer shipped must be removed by ' +
        '--clean, not stranded: ' + retiredHook,
    );
  } finally {
    cleanup(tmpDir);
  }
});

// ── user hooks are never deletion candidates ───────────────────────

test('UNINST-CLEAN-04: uninstall preserves user hooks, including gsd-prefixed ones GSD never installed', () => {
  const tmpDir = fs.mkdtempSync(path.join(BASE_TMPDIR, 'gsd-uninst-clean-04-'));
  try {
    const run = (extraArgs = []) =>
      spawnSync(
        process.execPath,
        [INSTALLER, '--runtime', 'claude', '--local', ...extraArgs],
        {
          encoding: 'utf8',
          timeout: 15000,
          cwd: tmpDir,
          env: Object.assign({}, process.env, { HOME: os.homedir() }),
        },
      );

    assert.strictEqual(run().status, 0, 'install must exit 0');

    const claudeDir = path.join(tmpDir, '.claude');

    // The second name is the load-bearing one: it guards against widening the
    // removal set to a gsd-* glob over hooks/, which would satisfy every other
    // assertion here while quietly deleting a user's file.
    const userHooks = [
      [path.join(claudeDir, 'hooks', 'zz-user-hook.js'), 'zz-user-hook-body'],
      [
        path.join(claudeDir, 'hooks', 'gsd-user-owned-hook.js'),
        'gsd-prefixed-but-user-owned-body',
      ],
    ];
    for (const [filePath, body] of userHooks) {
      fs.writeFileSync(filePath, body);
    }

    const r = run(['--uninstall']);
    assert.strictEqual(
      r.status,
      0,
      'uninstall must exit 0\nstderr: ' + (r.stderr || ''),
    );

    for (const [filePath, body] of userHooks) {
      assert.ok(
        fs.existsSync(filePath),
        'user hook must survive uninstall: ' + filePath,
      );
      assert.strictEqual(
        fs.readFileSync(filePath, 'utf8'),
        body,
        'user hook must be byte-identical after uninstall: ' + filePath,
      );
    }
  } finally {
    cleanup(tmpDir);
  }
});

// ── --clean on the Copilot runtime ─────────────────────────────────

test('CLEANEV-02: --clean on the Copilot runtime wipes the managed tree and preserves user content', () => {
  const tmpDir = fs.mkdtempSync(path.join(BASE_TMPDIR, 'gsd-cleanev-02-'));
  try {
    const runInstall = (extraArgs = []) =>
      spawnSync(
        process.execPath,
        [INSTALLER, '--runtime', 'copilot', '--local', ...extraArgs],
        {
          encoding: 'utf8',
          timeout: 15000,
          cwd: tmpDir,
          env: Object.assign({}, process.env, { HOME: os.homedir() }),
        },
      );

    const r1 = runInstall();
    assert.strictEqual(
      r1.status,
      0,
      'baseline copilot install must exit 0\nstderr: ' + (r1.stderr || ''),
    );

    const configDir = path.join(tmpDir, '.github');

    // Copilot-side user content. Non-gsd-prefixed on purpose: the wipe deletes
    // only gsd-*.agent.md files and skills/gsd-* directories.
    const planted = [
      [path.join(configDir, 'agents', 'zz-user.agent.md'), 'zz-user-agent-body'],
      [
        path.join(configDir, 'skills', 'zz-user-skill', 'SKILL.md'),
        'zz-user-skill-body',
      ],
      [
        path.join(configDir, 'gsd-local-patches', 'sentinel.txt'),
        'zz-user-patch-body',
      ],
    ];
    for (const [filePath, body] of planted) {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, body);
    }

    // Why this LOCAL test has no stale-wipe witness: for a local Copilot
    // install every location the wipe touches is ALSO cleared by the ordinary
    // install that follows it — skills/gsd-* and agents/gsd-*.agent.md are
    // deleted by the same wildcard predicates (so even a name from an older
    // release that no longer ships is removed), gsd-ng/ is removed before it is
    // re-copied, and hooks/gsd-hooks.json is rewritten unconditionally. The
    // equivalence is real but scoped to --local: on --global the installer
    // skips the hooks step entirely, so hooks/gsd-hooks.json is wiped and never
    // written back. The global Copilot test below witnesses that.
    //
    // TRIPWIRE: if the assertion below starts failing, a plain reinstall has
    // stopped clearing stale gsd- skills and the wipe has become load-bearing
    // for local installs too. Do not delete the assertion — give this test a
    // real absence witness instead.
    const staleSkill = path.join(configDir, 'skills', 'gsd-zz-stale', 'SKILL.md');
    fs.mkdirSync(path.dirname(staleSkill), { recursive: true });
    fs.writeFileSync(staleSkill, 'stale-gsd-owned-file');

    const rPlain = runInstall();
    assert.strictEqual(
      rPlain.status,
      0,
      'plain copilot reinstall must exit 0\nstderr: ' + (rPlain.stderr || ''),
    );
    assert.ok(
      !fs.existsSync(staleSkill),
      'a plain copilot reinstall already removes stale gsd- skills, so --clean ' +
        'has no observable witness on this runtime: ' +
        staleSkill,
    );

    const r2 = runInstall(['--clean']);
    assert.strictEqual(
      r2.status,
      0,
      'copilot --clean install must exit 0\nstderr: ' + (r2.stderr || ''),
    );

    for (const [filePath, body] of planted) {
      assert.ok(
        fs.existsSync(filePath),
        'user-owned file must survive copilot --clean: ' + filePath,
      );
      assert.strictEqual(
        fs.readFileSync(filePath, 'utf8'),
        body,
        'user-owned file must be byte-identical after copilot --clean: ' +
          filePath,
      );
    }

    // Proves an install ran and the user content above survived it. It does NOT
    // prove a wipe ran — see the note above.
    assert.ok(
      fs.existsSync(path.join(configDir, 'gsd-ng')),
      'gsd-ng/ must be re-installed after copilot --clean',
    );
    const manifest = JSON.parse(
      fs.readFileSync(path.join(configDir, 'gsd-file-manifest.json'), 'utf8'),
    );
    assert.strictEqual(
      manifest.schema_version,
      2,
      'copilot manifest must be freshly written with schema_version: 2 after --clean',
    );
  } finally {
    cleanup(tmpDir);
  }
});

// ── --clean --global targets CLAUDE_CONFIG_DIR, not the real home ──

test('CLEANEV-03: --clean --global operates on CLAUDE_CONFIG_DIR and preserves user content', () => {
  const tmpDir = fs.mkdtempSync(path.join(BASE_TMPDIR, 'gsd-cleanev-03-'));
  try {
    const cfgDir = path.join(tmpDir, 'fakehome', '.claude');
    fs.mkdirSync(cfgDir, { recursive: true });

    // SAFETY: CLAUDE_CONFIG_DIR is set on EVERY invocation below. getGlobalDir
    // reads it ahead of the home directory, so the global target stays inside
    // tmpDir. A single call missing it would target the real user config dir.
    const runInstall = (extraArgs = []) =>
      spawnSync(
        process.execPath,
        [INSTALLER, '--runtime', 'claude', '--global', ...extraArgs],
        {
          encoding: 'utf8',
          timeout: 15000,
          cwd: tmpDir,
          env: Object.assign({}, process.env, {
            HOME: os.homedir(),
            CLAUDE_CONFIG_DIR: cfgDir,
          }),
        },
      );

    const r1 = runInstall();
    assert.strictEqual(
      r1.status,
      0,
      'baseline global install must exit 0\nstderr: ' + (r1.stderr || ''),
    );

    // Containment gate — must hold before any --clean run. If the redirect is
    // not honored the install landed elsewhere and this test must stop here.
    assert.ok(
      fs.existsSync(path.join(cfgDir, 'commands', 'gsd')),
      'global install must land in the redirected config dir, not the real home',
    );

    const planted = [
      [path.join(cfgDir, 'agents', 'zz-user-agent.md'), 'zz-user-agent-body'],
      [path.join(cfgDir, 'CLAUDE.md'), 'zz-user-memory-body'],
      [
        path.join(cfgDir, 'gsd-local-patches', 'sentinel.txt'),
        'zz-user-patch-body',
      ],
    ];
    for (const [filePath, body] of planted) {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, body);
    }

    // Stale-wipe witness — see the Claude local test for why this specific name
    // is the only observable one: it is in the wipe's hook list but ships in no
    // source dir, and the ordinary install never deletes from hooks/.
    const staleWitness = path.join(cfgDir, 'hooks', 'gsd-check-update.sh');
    fs.mkdirSync(path.dirname(staleWitness), { recursive: true });
    fs.writeFileSync(staleWitness, 'stale-gsd-owned-file');

    const r2 = runInstall(['--clean']);
    assert.strictEqual(
      r2.status,
      0,
      'global --clean install must exit 0\nstderr: ' + (r2.stderr || ''),
    );
    assert.ok(
      /Wiped managed tree/.test(r2.stdout || ''),
      'global --clean must report the wipe. stdout:\n' +
        (r2.stdout || '').slice(0, 1500),
    );

    for (const [filePath, body] of planted) {
      assert.ok(
        fs.existsSync(filePath),
        'user-owned file must survive global --clean: ' + filePath,
      );
      assert.strictEqual(
        fs.readFileSync(filePath, 'utf8'),
        body,
        'user-owned file must be byte-identical after global --clean: ' +
          filePath,
      );
    }

    // The wipe actually ran. The stdout line above is printed by the caller of
    // removeGsdFiles and is ungated on any deletion, so it is not evidence on
    // its own; this absence check is.
    assert.ok(
      !fs.existsSync(staleWitness),
      'stale GSD-owned file must be deleted by global --clean: ' + staleWitness,
    );

    // The tree was reinstalled after the wipe, not merely emptied.
    assert.ok(
      fs.existsSync(path.join(cfgDir, 'commands', 'gsd')),
      'commands/gsd/ must be re-installed after global --clean',
    );
    const manifest = JSON.parse(
      fs.readFileSync(path.join(cfgDir, 'gsd-file-manifest.json'), 'utf8'),
    );
    assert.strictEqual(
      manifest.schema_version,
      2,
      'global manifest must be freshly written with schema_version: 2 after --clean',
    );
  } finally {
    cleanup(tmpDir);
  }
});

// ── --clean --global on Copilot has an observable wipe witness ─────

test('CLEANEV-04: --clean --global on the Copilot runtime deletes a hook file a plain reinstall leaves behind', () => {
  const tmpDir = fs.mkdtempSync(path.join(BASE_TMPDIR, 'gsd-cleanev-04-'));
  try {
    const cfgDir = path.join(tmpDir, 'fakehome', '.copilot');
    fs.mkdirSync(cfgDir, { recursive: true });

    // SAFETY: COPILOT_CONFIG_DIR is set on EVERY invocation below. getGlobalDir
    // reads it ahead of the home directory, so the global target stays inside
    // tmpDir. A single call missing it would target the real ~/.copilot.
    const runInstall = (extraArgs = []) =>
      spawnSync(
        process.execPath,
        [INSTALLER, '--runtime', 'copilot', '--global', ...extraArgs],
        {
          encoding: 'utf8',
          timeout: 15000,
          cwd: tmpDir,
          env: Object.assign({}, process.env, {
            HOME: os.homedir(),
            COPILOT_CONFIG_DIR: cfgDir,
          }),
        },
      );

    const r1 = runInstall();
    assert.strictEqual(
      r1.status,
      0,
      'baseline global copilot install must exit 0\nstderr: ' + (r1.stderr || ''),
    );

    // Containment gate — must hold before any --clean run. If the redirect is
    // not honored the install landed elsewhere and this test must stop here.
    assert.ok(
      fs.existsSync(path.join(cfgDir, 'gsd-ng')),
      'global copilot install must land in the redirected config dir, not the real home',
    );

    // Stale-wipe witness. hooks/gsd-hooks.json is GSD-owned and is in the
    // wipe's delete list for this runtime, but the installer writes it only for
    // local installs (global Copilot hooks are unsupported by the CLI). So on
    // --global nothing recreates it and nothing else deletes it — exactly the
    // shape that makes a wipe observable. This models version drift: a file a
    // previous release wrote to a location the current release no longer
    // manages.
    const staleWitness = path.join(cfgDir, 'hooks', 'gsd-hooks.json');
    fs.mkdirSync(path.dirname(staleWitness), { recursive: true });
    fs.writeFileSync(staleWitness, 'stale-gsd-owned-file');

    // Half of the proof: the ordinary install path cannot remove it.
    const rPlain = runInstall();
    assert.strictEqual(
      rPlain.status,
      0,
      'plain global copilot reinstall must exit 0\nstderr: ' + (rPlain.stderr || ''),
    );
    assert.ok(
      fs.existsSync(staleWitness),
      'a plain global copilot reinstall must NOT remove the stale hook file — ' +
        'if it does, this witness is no longer wipe-specific and the test is ' +
        'proving nothing: ' +
        staleWitness,
    );

    // Other half: --clean does remove it. Together these show the wipe on the
    // Copilot runtime is not observationally equivalent to a plain reinstall.
    const r2 = runInstall(['--clean']);
    assert.strictEqual(
      r2.status,
      0,
      'global copilot --clean install must exit 0\nstderr: ' + (r2.stderr || ''),
    );
    assert.ok(
      !fs.existsSync(staleWitness),
      'stale GSD-owned hook file must be deleted by global copilot --clean: ' +
        staleWitness,
    );

    // The tree was reinstalled after the wipe, not merely emptied.
    assert.ok(
      fs.existsSync(path.join(cfgDir, 'gsd-ng')),
      'gsd-ng/ must be re-installed after global copilot --clean',
    );
  } finally {
    cleanup(tmpDir);
  }
});

// ── effort frontmatter sync integration tests ───────────────────────────────

describe('install.js - Phase 55 effort frontmatter sync', () => {
  let tmpDir;
  afterEach(() => {
    if (tmpDir) cleanup(tmpDir);
  });

  test('EFFSYNC-INSTALL-01: Claude local install writes effort: xhigh to gsd-planner.md when profile=quality', () => {
    tmpDir = fs.mkdtempSync(path.join(BASE_TMPDIR, 'gsd-effsync-install-'));
    // Pre-seed config so resolveEffortInternal reads a known profile during install
    const configDir = path.join(tmpDir, '.planning');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
      path.join(configDir, 'config.json'),
      JSON.stringify({
        runtime: 'claude',
        model_profile: 'quality',
      }),
    );
    const result = spawnSync(
      process.execPath,
      [
        INSTALLER,
        '--runtime',
        'claude',
        '--local',
        '--no-seed-permissions-config',
        '--no-seed-sandbox-config',
      ],
      { cwd: tmpDir, encoding: 'utf-8', timeout: 30000 },
    );
    assert.strictEqual(result.status, 0, `install failed: ${result.stderr}`);
    const plannerPath = path.join(
      tmpDir,
      '.claude',
      'agents',
      'gsd-planner.md',
    );
    assert.ok(fs.existsSync(plannerPath), 'gsd-planner.md must be installed');
    const planner = fs.readFileSync(plannerPath, 'utf-8');
    assert.match(
      planner,
      /^effort: xhigh$/m,
      'effort: xhigh must be in frontmatter',
    );
    // install.js emits the restart notice on stderr when changes occur
    assert.ok(
      result.stderr.includes('Restart Claude Code to apply effort changes.'),
      `restart notice missing from stderr: ${result.stderr}`,
    );
  });

  test('EFFSYNC-INSTALL-02: Copilot local install does NOT write effort: to any agent file', () => {
    tmpDir = fs.mkdtempSync(path.join(BASE_TMPDIR, 'gsd-effsync-copilot-'));
    const result = spawnSync(
      process.execPath,
      [INSTALLER, '--runtime', 'copilot', '--local'],
      { cwd: tmpDir, encoding: 'utf-8', timeout: 30000 },
    );
    assert.strictEqual(result.status, 0, `install failed: ${result.stderr}`);
    const agentsDir = path.join(tmpDir, '.github', 'agents');
    assert.ok(fs.existsSync(agentsDir), 'Copilot agents directory must exist');
    const files = fs
      .readdirSync(agentsDir)
      .filter((f) => f.endsWith('.agent.md'));
    for (const file of files) {
      const content = fs.readFileSync(path.join(agentsDir, file), 'utf-8');
      assert.doesNotMatch(
        content,
        /^effort:/m,
        `${file} must not contain effort:`,
      );
    }
  });

  test('EFFSYNC-INSTALL-03: Copilot local install does NOT deploy gsd-set-profile skill', () => {
    tmpDir = fs.mkdtempSync(
      path.join(BASE_TMPDIR, 'gsd-effsync-copilot-skill-'),
    );
    const result = spawnSync(
      process.execPath,
      [INSTALLER, '--runtime', 'copilot', '--local'],
      { cwd: tmpDir, encoding: 'utf-8', timeout: 30000 },
    );
    assert.strictEqual(result.status, 0, `install failed: ${result.stderr}`);
    const setProfileSkill = path.join(
      tmpDir,
      '.github',
      'skills',
      'gsd-set-profile',
      'SKILL.md',
    );
    assert.ok(
      !fs.existsSync(setProfileSkill),
      'gsd-set-profile/SKILL.md must NOT exist for Copilot install',
    );
  });
});

// ── install.js writes bare Edit/Write/Read on Linux ─────────────
// Force Linux seeding via GSD_TEST_FORCE_PLATFORM and verify bare Edit/Write/Read
// permissions are written instead of the globbed forms used on non-Linux platforms.

test('ALLOW-07: install.js --local on Linux writes bare Edit/Write/Read forms', () => {
  const tmpDir = fs.mkdtempSync(path.join(BASE_TMPDIR, 'gsd-allow-07-'));
  try {
    const result = spawnSync(
      process.execPath,
      [INSTALLER, '--runtime', 'claude', '--local'],
      {
        encoding: 'utf8',
        timeout: 15000,
        cwd: tmpDir,
        env: Object.assign({}, process.env, {
          HOME: os.homedir(),
          GSD_TEST_FORCE_PLATFORM: 'linux',
        }),
      },
    );
    assert.strictEqual(result.status, 0, `install.js failed: ${result.stderr}`);

    const settingsPath = path.join(tmpDir, '.claude', 'settings.json');
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    const allow = settings.permissions?.allow ?? [];

    assert.ok(allow.includes('Edit'), 'Linux must include bare Edit');
    // Bare Write is an effective, warning-free tool-name rule — retained on Linux.
    assert.ok(allow.includes('Write'), 'Linux must include bare Write');
    assert.ok(allow.includes('Read'), 'Linux must include bare Read');
    assert.ok(
      !allow.includes('Edit(*)'),
      'Linux must NOT include glob Edit(*)',
    );
    assert.ok(
      !allow.includes('Write(*)'),
      'Linux must NOT include glob Write(*)',
    );
    assert.ok(
      !allow.includes('Read(*)'),
      'Linux must NOT include glob Read(*)',
    );
  } finally {
    cleanup(tmpDir);
  }
});

// ── seeded settings.json carries no unmatched Tool(path) rule, on any platform ──
//
// The end-to-end guard for the defect the unit tests only approximate: seeding
// Write(*) into permissions.allow on a macOS/Windows install, which
// CC >= 2.1.210 reports as a startup warning. Asserting on the
// file install.js actually writes — across all three seeded sections and every
// platform branch — is what keeps a regression from shipping, since the template
// and the platform allow list are separate sources that both feed this output.

test('PERM-10: install.js seeds no unmatched Tool(path) rule into allow/deny/ask on any platform', () => {
  for (const platform of ['linux', 'darwin', 'win32']) {
    const tmpDir = fs.mkdtempSync(path.join(BASE_TMPDIR, `gsd-perm10-${platform}-`));
    try {
      const result = spawnSync(
        process.execPath,
        [INSTALLER, '--runtime', 'claude', '--local'],
        {
          encoding: 'utf8',
          timeout: 15000,
          cwd: tmpDir,
          env: Object.assign({}, process.env, {
            HOME: os.homedir(),
            GSD_TEST_FORCE_PLATFORM: platform,
          }),
        },
      );
      assert.strictEqual(result.status, 0, `install.js failed on ${platform}: ${result.stderr}`);

      const settings = JSON.parse(
        fs.readFileSync(path.join(tmpDir, '.claude', 'settings.json'), 'utf8'),
      );
      for (const section of ['allow', 'deny', 'ask']) {
        const entries = settings.permissions?.[section] ?? [];
        const unmatched = findUnmatchedPathRules(entries);
        assert.deepStrictEqual(
          unmatched,
          [],
          `${platform}: seeded permissions.${section} must contain no unmatched Tool(path) rule ` +
            `(never matched by the file permission engine; warns at startup on CC >= 2.1.210). ` +
            `Offending entries: ${unmatched.join(', ')}`,
        );
      }

      // The Write tool must still be granted — by the effective spelling for the
      // platform, not withdrawn. Linux keeps bare Write; macOS/Windows rely on Edit(*).
      const allow = settings.permissions?.allow ?? [];
      assert.ok(
        platform === 'linux' ? allow.includes('Write') : allow.includes('Edit(*)'),
        `${platform}: file-editing must still be allowed after dropping the unmatched form`,
      );
    } finally {
      cleanup(tmpDir);
    }
  }
});

// ── install.js writes glob Edit(*)/Read(*) on macOS (no unmatched Write(*)) ──

test('ALLOW-08: install.js --local on macOS writes canonical glob forms', (t) => {
  const tmpDir = fs.mkdtempSync(path.join(BASE_TMPDIR, 'gsd-allow-08-'));
  try {
    const result = spawnSync(
      process.execPath,
      [INSTALLER, '--runtime', 'claude', '--local'],
      {
        encoding: 'utf8',
        timeout: 15000,
        cwd: tmpDir,
        env: Object.assign({}, process.env, {
          HOME: os.homedir(),
          GSD_TEST_FORCE_PLATFORM: 'darwin',
        }),
      },
    );
    assert.strictEqual(result.status, 0, `install.js failed: ${result.stderr}`);

    const settings = JSON.parse(
      fs.readFileSync(path.join(tmpDir, '.claude', 'settings.json'), 'utf8'),
    );
    const allow = settings.permissions?.allow ?? [];
    assert.ok(allow.includes('Edit(*)'));
    assert.ok(!allow.includes('Write(*)'),
      'macOS must NOT carry Write(*) — unmatched path form; Edit(*) covers the Write tool');
    assert.ok(allow.includes('Read(*)'));
    assert.ok(!allow.includes('Edit'), 'macOS must not carry bare Edit');

    if (!HAS_GH) {
      t.skip(NO_GH_SKIP);
      return;
    }
    assert.ok(
      allow.includes('Bash(gh repo view *)'),
      'narrowed repo view must land',
    );
    assert.ok(
      allow.includes('Bash(gh label create *)'),
      'narrowed label create must land',
    );
    assert.ok(
      !allow.includes('Bash(gh repo *)'),
      'broad gh repo must NOT land (narrowed)',
    );
    assert.ok(
      !allow.includes('Bash(gh label *)'),
      'broad gh label must NOT land (narrowed)',
    );
  } finally {
    cleanup(tmpDir);
  }
});

// ── install.js writes canonical forms + narrowed CLI verbs on win32 ──

test('ALLOW-16: install.js --local on win32 writes canonical glob forms and narrowed CLI verbs', (t) => {
  const tmpDir = fs.mkdtempSync(path.join(BASE_TMPDIR, 'gsd-allow-16-'));
  try {
    const result = spawnSync(
      process.execPath,
      [INSTALLER, '--runtime', 'claude', '--local'],
      {
        encoding: 'utf8',
        timeout: 15000,
        cwd: tmpDir,
        env: Object.assign({}, process.env, {
          HOME: os.homedir(),
          GSD_TEST_FORCE_PLATFORM: 'win32',
        }),
      },
    );
    assert.strictEqual(result.status, 0, `install.js failed: ${result.stderr}`);

    const settings = JSON.parse(
      fs.readFileSync(path.join(tmpDir, '.claude', 'settings.json'), 'utf8'),
    );
    const allow = settings.permissions?.allow ?? [];

    // Canonical forms present (win32 mirrors darwin per getReadEditWriteAllowRules)
    assert.ok(
      allow.includes('Edit(*)'),
      'win32 must include canonical Edit(*)',
    );
    assert.ok(
      !allow.includes('Write(*)'),
      'win32 must NOT include Write(*) — unmatched path form; Edit(*) covers the Write tool',
    );
    assert.ok(
      allow.includes('Read(*)'),
      'win32 must include canonical Read(*)',
    );

    // Bare forms absent
    assert.ok(!allow.includes('Edit'), 'win32 must NOT carry bare Edit');
    assert.ok(!allow.includes('Write'), 'win32 must NOT carry bare Write');
    assert.ok(!allow.includes('Read'), 'win32 must NOT carry bare Read');

    if (!HAS_GH) {
      t.skip(NO_GH_SKIP);
      return;
    }
    assert.ok(
      allow.includes('Bash(gh repo view *)'),
      'narrowed repo view must land',
    );
    assert.ok(
      allow.includes('Bash(gh label create *)'),
      'narrowed label create must land',
    );
    assert.ok(
      !allow.includes('Bash(gh repo *)'),
      'broad gh repo must NOT land (narrowed)',
    );
    assert.ok(
      !allow.includes('Bash(gh label *)'),
      'broad gh label must NOT land (narrowed)',
    );
  } finally {
    cleanup(tmpDir);
  }
});

// ── allow section sync union preserves user entries + logs per-section count ──

test('ALLOW-09: allow-section sync preserves user entries and logs "Added N allow entries"', (t) => {
  const tmpDir = fs.mkdtempSync(path.join(BASE_TMPDIR, 'gsd-allow-09-'));
  try {
    const configDir = path.join(tmpDir, '.claude');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
      path.join(configDir, 'settings.json'),
      JSON.stringify(
        { permissions: { allow: ['Bash(custom-cmd *)'] } },
        null,
        2,
      ),
    );

    const result = spawnSync(
      process.execPath,
      [INSTALLER, '--runtime', 'claude', '--local'],
      {
        encoding: 'utf8',
        timeout: 15000,
        cwd: tmpDir,
        env: Object.assign({}, process.env, {
          HOME: os.homedir(),
          GSD_TEST_FORCE_PLATFORM: 'darwin',
        }),
      },
    );
    assert.strictEqual(result.status, 0, `install.js failed: ${result.stderr}`);

    const settings = JSON.parse(
      fs.readFileSync(path.join(configDir, 'settings.json'), 'utf8'),
    );
    assert.ok(
      settings.permissions.allow.includes('Bash(custom-cmd *)'),
      'user entry must be preserved',
    );
    assert.ok(
      settings.permissions.allow.includes('Bash(node *)'),
      'template entries must be added',
    );
    assert.match(
      result.stdout,
      /Added \d+ allow entries/,
      'must log per-section allow count',
    );
    const allow = settings.permissions?.allow ?? [];
    assert.ok(
      !allow.includes('Bash(gh repo *)'),
      'linux install must not land broad gh repo (narrowed)',
    );

    if (!HAS_GH) {
      t.skip(NO_GH_SKIP);
      return;
    }
    assert.ok(
      allow.includes('Bash(gh repo view *)'),
      'narrowed repo view lands when gh present',
    );
  } finally {
    cleanup(tmpDir);
  }
});

// ── deny section sync is no-op today (template has no deny block) ──

test('ALLOW-10: deny-section sync preserves user denies and does not log deny additions', () => {
  const tmpDir = fs.mkdtempSync(path.join(BASE_TMPDIR, 'gsd-allow-10-'));
  try {
    const configDir = path.join(tmpDir, '.claude');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
      path.join(configDir, 'settings.json'),
      JSON.stringify(
        { permissions: { allow: [], deny: ['Bash(user-deny *)'] } },
        null,
        2,
      ),
    );

    const result = spawnSync(
      process.execPath,
      [INSTALLER, '--runtime', 'claude', '--local'],
      {
        encoding: 'utf8',
        timeout: 15000,
        cwd: tmpDir,
        env: Object.assign({}, process.env, {
          HOME: os.homedir(),
          GSD_TEST_FORCE_PLATFORM: 'darwin',
        }),
      },
    );
    assert.strictEqual(result.status, 0);

    const settings = JSON.parse(
      fs.readFileSync(path.join(configDir, 'settings.json'), 'utf8'),
    );
    assert.ok(
      settings.permissions.deny.includes('Bash(user-deny *)'),
      'user deny must be preserved',
    );
    assert.doesNotMatch(
      result.stdout,
      /Added \d+ deny/,
      'no deny additions expected',
    );
  } finally {
    cleanup(tmpDir);
  }
});

// ── "up to date" only after all three sections return zero additions ──

test('ALLOW-11: second install logs "Permissions already up to date" (no per-section adds)', () => {
  const tmpDir = fs.mkdtempSync(path.join(BASE_TMPDIR, 'gsd-allow-11-'));
  try {
    const configDir = path.join(tmpDir, '.claude');
    const spawn = () =>
      spawnSync(
        process.execPath,
        [INSTALLER, '--runtime', 'claude', '--local'],
        {
          encoding: 'utf8',
          timeout: 15000,
          cwd: tmpDir,
          env: Object.assign({}, process.env, {
            HOME: os.homedir(),
            GSD_TEST_FORCE_PLATFORM: 'darwin',
          }),
        },
      );
    const first = spawn();
    assert.strictEqual(first.status, 0);
    const second = spawn();
    assert.strictEqual(second.status, 0);
    assert.match(second.stdout, /Permissions already up to date/);
    assert.doesNotMatch(second.stdout, /Added \d+ allow entries/);
  } finally {
    cleanup(tmpDir);
  }
});

// ── seed-memories resolves the project rules file per runtime ──

test('F-RULES-01: seed-memories.md uses {{PROJECT_RULES_FILE}} and installs resolved per runtime', () => {
  const seedMemoriesSrc = path.resolve(
    __dirname,
    '..',
    'commands',
    'gsd',
    'seed-memories.md',
  );
  assert.ok(
    fs.existsSync(seedMemoriesSrc),
    'commands/gsd/seed-memories.md must exist in source (F-RULES-01)',
  );
  assert.ok(
    fs.readFileSync(seedMemoriesSrc, 'utf8').includes('{{PROJECT_RULES_FILE}}'),
    'seed-memories.md source must use {{PROJECT_RULES_FILE}} rather than a hardcoded rules ' +
      'file name, so the same source serves every runtime (F-RULES-01)',
  );

  const tmpDir = fs.mkdtempSync(path.join(BASE_TMPDIR, 'gsd-f-rules-01-'));
  try {
    const install = (runtime) => {
      const dir = path.join(tmpDir, runtime);
      fs.mkdirSync(dir, { recursive: true });
      const result = spawnSync(
        process.execPath,
        [INSTALLER, '--runtime', runtime, '--local'],
        {
          encoding: 'utf8',
          timeout: 15000,
          cwd: dir,
          env: Object.assign({}, process.env, { HOME: os.homedir() }),
        },
      );
      assert.strictEqual(
        result.status,
        0,
        `${runtime} install must exit 0 (F-RULES-01)\nstderr: ` +
          (result.stderr || ''),
      );
      return dir;
    };

    const claudeSeed = fs.readFileSync(
      path.join(
        install('claude'),
        '.claude',
        'commands',
        'gsd',
        'seed-memories.md',
      ),
      'utf8',
    );
    assert.ok(
      claudeSeed.includes('CLAUDE.md'),
      'claude install must resolve {{PROJECT_RULES_FILE}} to CLAUDE.md (F-RULES-01)',
    );
    assert.ok(
      !claudeSeed.includes('copilot-instructions.md'),
      'claude install must not carry the copilot rules file path (F-RULES-01)',
    );

    const copilotSeed = fs.readFileSync(
      path.join(
        install('copilot'),
        '.github',
        'skills',
        'gsd-seed-memories',
        'SKILL.md',
      ),
      'utf8',
    );
    assert.ok(
      copilotSeed.includes('.github/copilot-instructions.md'),
      'copilot install must resolve {{PROJECT_RULES_FILE}} to .github/copilot-instructions.md (F-RULES-01)',
    );
    assert.ok(
      !copilotSeed.includes('CLAUDE.md'),
      'copilot install must not carry the claude rules file path (F-RULES-01)',
    );
  } finally {
    cleanup(tmpDir);
  }
});

test('F-RULES-02: source new-project.md workflow uses {{PROJECT_RULES_FILE}} in Step 9', () => {
  const newProjectSrc = path.resolve(
    __dirname,
    '..',
    'gsd-ng',
    'workflows',
    'new-project.md',
  );
  assert.ok(
    fs.existsSync(newProjectSrc),
    'gsd-ng/workflows/new-project.md must exist in source (F-RULES-02)',
  );
  const content = fs.readFileSync(newProjectSrc, 'utf8');
  assert.ok(
    content.includes('{{PROJECT_RULES_FILE}}'),
    'new-project.md source must use {{PROJECT_RULES_FILE}} in Step 9 (F-RULES-02).\n' +
      'Fix: update new-project.md Step 9 to detect runtime and write dynamic content into {{PROJECT_RULES_FILE}}.',
  );
});

// ── registry-derived literal lint ───────────────────────────────────────────
//
// A runtime-specific literal in the content layer is a leak: it ships the wrong
// command syntax, tool name or rules-file path to every runtime that is not the
// one it was written for. The banned set is derived from the registry, so a
// fourth runtime extends it with no edit here.
//
// The matching rule is per key, because the values have different shapes and a
// single rule is unusable across them. Each row records the measurement that
// justifies its shape — those numbers are the reason, not decoration.

const RTAGNOSTIC_ROOT = path.join(__dirname, '..');

/** Directories whose .md content is swept, walked recursively. */
const RTAGNOSTIC_SCAN_DIRS = [
  ['gsd-ng', 'workflows'],
  ['gsd-ng', 'references'],
  ['gsd-ng', 'templates'],
  ['commands', 'gsd'],
  ['agents'],
];

/**
 * Content with its runtime-conditional blocks removed.
 *
 * A literal inside `<!-- ONLY:opencode -->` is scoped to opencode by
 * construction and reaches no other runtime, which is the whole point of the
 * marker. Scanning it would force a placeholder into the one place a plain
 * literal is provably correct.
 */
function rtagnosticStripOnlyBlocks(content) {
  return content.replace(
    /<!-- ONLY:\w+ -->[\s\S]*?<!-- \/ONLY:\w+ -->/g,
    '',
  );
}

/** The command names `commands/gsd/` actually ships, without the .md. */
function rtagnosticCommandBasenames() {
  return fs
    .readdirSync(path.join(RTAGNOSTIC_ROOT, 'commands', 'gsd'))
    .filter((f) => f.endsWith('.md'))
    .map((f) => path.basename(f, '.md'));
}

const RTAGNOSTIC_KEY_POLICIES = [
  {
    key: 'PROJECT_RULES_FILE',
    // Plain substring. The values are file names distinctive enough to carry no
    // false positives: measured 0 across the scanned tree.
    literals: (values) => values,
  },
  {
    key: 'COMMAND_PREFIX',
    // The cross-product of every prefix value and every real command basename,
    // never the bare prefix. Banning `/gsd-` alone flags 1070 occurrences in the
    // content layer (419 `/gsd-ng`, 350 `/gsd-tools`, the rest ordinary paths);
    // the cross-product flags 0 of them and stays self-maintaining, because the
    // basenames are read from the shipped command directory at test time.
    literals: (values) => {
      const names = rtagnosticCommandBasenames();
      return values.flatMap((prefix) => names.map((name) => prefix + name));
    },
  },
  {
    key: 'USER_QUESTION_TOOL',
    // Skip any value that is an ordinary lowercase word: `question` occurs 291
    // times in workflows alone as English, and `ask_user` reads as prose too.
    // What survives the filter is `AskUserQuestion`, which is the one that
    // matters and carries no false positives.
    literals: (values) => values.filter((v) => !/^[a-z_]+$/.test(v)),
  },
];

/** Every banned literal, tagged with the registry key it came from. */
function rtagnosticBannedLiterals(runtimes) {
  const banned = [];
  for (const policy of RTAGNOSTIC_KEY_POLICIES) {
    const values = [
      ...new Set(
        Object.values(runtimes)
          .map((r) => r[policy.key])
          .filter(Boolean),
      ),
    ];
    for (const literal of policy.literals(values)) {
      banned.push({ key: policy.key, literal });
    }
  }
  return banned;
}

/**
 * Content with its frontmatter tool declarations removed.
 *
 * `tools:` and `allowed-tools:` are inputs to the agent and command converters,
 * which look each name up in a map keyed by the Claude tool name. A placeholder
 * there would miss the map and the tool would be dropped, so the plain name is
 * correct and stays — 28 occurrences across the shipped commands.
 */
function rtagnosticStripToolDeclarations(content) {
  const match = content.match(/^---\n([\s\S]*?)\n---\n/);
  if (!match) return content;
  const stripped = match[1].replace(
    /^(allowed-)?tools:.*(?:\n[ \t]+-[ \t]*\S+[ \t]*)*$/gm,
    '',
  );
  return '---\n' + stripped + '\n---\n' + content.slice(match[0].length);
}

/** `relpath :: literal` for every banned literal present in the given content. */
function rtagnosticOffenders(files, banned) {
  const offenders = [];
  for (const { rel, content } of files) {
    const scanned = rtagnosticStripToolDeclarations(
      rtagnosticStripOnlyBlocks(content),
    );
    for (const { literal } of banned) {
      if (scanned.includes(literal)) offenders.push(`${rel} :: ${literal}`);
    }
  }
  return offenders;
}

function rtagnosticWalkMd(dir) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...rtagnosticWalkMd(full));
    else if (entry.isFile() && entry.name.endsWith('.md')) out.push(full);
  }
  return out;
}

function rtagnosticScannedFiles() {
  const files = [];
  for (const segments of RTAGNOSTIC_SCAN_DIRS) {
    for (const abs of rtagnosticWalkMd(path.join(RTAGNOSTIC_ROOT, ...segments))) {
      files.push({
        rel: path.relative(RTAGNOSTIC_ROOT, abs).split(path.sep).join('/'),
        content: fs.readFileSync(abs, 'utf8'),
      });
    }
  }
  return files;
}

// ── config-home directory literals in the engine's own library ──────────────
//
// A separate detector, because `PROJECT_RULES_FILE` matching never sees these:
// the leak is a bare `.claude` path segment, not a file name. Scoped to the
// library because that is where the remaining ones live; the registry file
// itself is excluded, since the values there are the definitions.

const RTAGNOSTIC_LIB_DIR = path.join(RTAGNOSTIC_ROOT, 'gsd-ng', 'bin', 'lib');
const RTAGNOSTIC_REGISTRY_FILE = 'template-processor.cjs';

/**
 * Config-home literals surviving in the library, per file.
 *
 * Each is a refactor-class leak: closing it needs a registry lookup at the call
 * site, not a substitution, and these files execute from the source tree during
 * the test run so a template placeholder in a string literal would be valid
 * syntax and wrong behaviour. Recorded here rather than accepted — this table
 * only ever shrinks, and a count that rises fails the lint.
 */
const RTAGNOSTIC_CONFIG_DIR_ALLOWLIST = {
  'gsd-ng/bin/lib/cache-path.cjs': 2,
  'gsd-ng/bin/lib/commands.cjs': 4,
  'gsd-ng/bin/lib/config.cjs': 3,
  'gsd-ng/bin/lib/core.cjs': 1,
  'gsd-ng/bin/lib/security.cjs': 4,
  'gsd-ng/bin/lib/verify.cjs': 5,
  'gsd-ng/bin/lib/workspace.cjs': 2,
};

/** Config-home directory names, from every runtime's configHome spec. */
function rtagnosticConfigDirLiterals(runtimes) {
  return [
    ...new Set(
      Object.values(runtimes)
        .flatMap((r) => [
          r.configHome.globalDirName,
          r.configHome.localDirName,
        ])
        .filter(Boolean),
    ),
  ];
}

/**
 * Count config-home literals in `content`.
 *
 * The boundaries are what keep `api.github.com` and `cli.github.com` out: a
 * literal preceded or followed by an alphanumeric is part of a longer token,
 * not a path segment.
 */
function rtagnosticCountConfigDirs(content, literals) {
  let count = 0;
  for (const literal of literals) {
    const re = new RegExp(
      '(?<![A-Za-z0-9])' + literal.replace(/\./g, '\\.') + '(?![A-Za-z0-9])',
      'g',
    );
    count += (content.match(re) || []).length;
  }
  return count;
}

// ── synthetic self-tests: the detectors must discriminate ───────────────────

test('RTAGNOSTIC-02: content naming a real command with a runtime prefix is flagged', () => {
  const banned = rtagnosticBannedLiterals(RUNTIMES);
  const offenders = rtagnosticOffenders(
    [{ rel: 'synthetic.md', content: 'Run /gsd:plan-phase to continue.' }],
    banned,
  );
  assert.deepStrictEqual(offenders, ['synthetic.md :: /gsd:plan-phase']);
});

test('RTAGNOSTIC-03: content naming the claude question tool is flagged', () => {
  const banned = rtagnosticBannedLiterals(RUNTIMES);
  const offenders = rtagnosticOffenders(
    [{ rel: 'synthetic.md', content: 'Use AskUserQuestion for each choice.' }],
    banned,
  );
  assert.deepStrictEqual(offenders, ['synthetic.md :: AskUserQuestion']);
});

test('RTAGNOSTIC-04: content naming a runtime rules file is flagged', () => {
  const banned = rtagnosticBannedLiterals(RUNTIMES);
  const offenders = rtagnosticOffenders(
    [{ rel: 'synthetic.md', content: 'Read AGENTS.md before editing.' }],
    banned,
  );
  assert.deepStrictEqual(offenders, ['synthetic.md :: AGENTS.md']);
});

test('RTAGNOSTIC-05: engine and tool paths sharing the prefix are not flagged', () => {
  const banned = rtagnosticBannedLiterals(RUNTIMES);
  const offenders = rtagnosticOffenders(
    [
      {
        rel: 'synthetic.md',
        content:
          'Load .claude/gsd-ng/workflows/do.md and run node .claude/gsd-ng/bin/gsd-tools.cjs; ' +
          'the payload lives under /gsd-ng and the CLI under /gsd-tools.',
      },
    ],
    banned,
  );
  assert.deepStrictEqual(
    offenders,
    [],
    'a bare-prefix ban would flag every /gsd-ng and /gsd-tools path in the tree',
  );
});

test('RTAGNOSTIC-06: the ordinary word "question" is not flagged', () => {
  const banned = rtagnosticBannedLiterals(RUNTIMES);
  const offenders = rtagnosticOffenders(
    [
      {
        rel: 'synthetic.md',
        content:
          'Ask the question that decides it, then ask_user for a follow-up question.',
      },
    ],
    banned,
  );
  assert.deepStrictEqual(
    offenders,
    [],
    'lowercase tool values are ordinary English and carry no ban',
  );
});

test('RTAGNOSTIC-07: a literal inside an ONLY block is not flagged', () => {
  const banned = rtagnosticBannedLiterals(RUNTIMES);
  const offenders = rtagnosticOffenders(
    [
      {
        rel: 'synthetic.md',
        content:
          '<!-- ONLY:opencode -->\nUse /gsd-plan-phase.\n<!-- /ONLY:opencode -->\n',
      },
    ],
    banned,
  );
  assert.deepStrictEqual(
    offenders,
    [],
    'a runtime-conditional block is the one place a plain literal is correct',
  );
});

test('RTAGNOSTIC-12: a tool name in allowed-tools: frontmatter is not flagged, in the body it is', () => {
  const banned = rtagnosticBannedLiterals(RUNTIMES);
  const frontmatterOnly =
    '---\nallowed-tools:\n  - Read\n  - AskUserQuestion\n---\n\nBody prose.\n';
  assert.deepStrictEqual(
    rtagnosticOffenders([{ rel: 'synthetic.md', content: frontmatterOnly }], banned),
    [],
    'the converters key on the Claude tool name, so the declaration must survive',
  );

  const alsoInBody = frontmatterOnly + '\nUse AskUserQuestion for each.\n';
  assert.deepStrictEqual(
    rtagnosticOffenders([{ rel: 'synthetic.md', content: alsoInBody }], banned),
    ['synthetic.md :: AskUserQuestion'],
    'the same name in prose is still a leak',
  );
});

test('RTAGNOSTIC-08: a bare config-home literal in a library fixture is counted', () => {
  const literals = rtagnosticConfigDirLiterals(RUNTIMES);
  assert.strictEqual(
    rtagnosticCountConfigDirs(
      "const dir = path.join(cwd, '.claude', 'agents');",
      literals,
    ),
    1,
  );
});

test('RTAGNOSTIC-09: a github hostname is not counted as a config-home literal', () => {
  const literals = rtagnosticConfigDirLiterals(RUNTIMES);
  assert.strictEqual(
    rtagnosticCountConfigDirs(
      "hostname: 'api.github.com', docs: 'https://cli.github.com/'",
      literals,
    ),
    0,
  );
});

test('RTAGNOSTIC-10: a fourth runtime extends the banned set with no edit here', () => {
  const before = rtagnosticBannedLiterals(RUNTIMES).map((b) => b.literal);
  const extended = {
    ...RUNTIMES,
    fictional: {
      PROJECT_RULES_FILE: 'FICTIONAL.md',
      USER_QUESTION_TOOL: 'AskTheHuman',
      COMMAND_PREFIX: '/fic-',
    },
  };
  const after = rtagnosticBannedLiterals(extended).map((b) => b.literal);
  assert.ok(after.includes('FICTIONAL.md'));
  assert.ok(after.includes('AskTheHuman'));
  assert.ok(after.includes('/fic-plan-phase'));
  assert.ok(
    after.length > before.length,
    'a new registry row must widen the banned set on its own',
  );
});

// ── the real tree ───────────────────────────────────────────────────────────

test('RTAGNOSTIC-01: no runtime-specific literals in the swept content layer', () => {
  const offenders = rtagnosticOffenders(
    rtagnosticScannedFiles(),
    rtagnosticBannedLiterals(RUNTIMES),
  );
  assert.deepStrictEqual(
    offenders,
    [],
    `RTAGNOSTIC-01: runtime-specific literals found in the content layer:\n  ${offenders.join('\n  ')}`,
  );
});

test('RTAGNOSTIC-11: config-home literals in the library stay within the recorded allowlist', () => {
  const literals = rtagnosticConfigDirLiterals(RUNTIMES);
  const offenders = [];
  const shrunk = [];
  for (const name of fs.readdirSync(RTAGNOSTIC_LIB_DIR).sort()) {
    if (!name.endsWith('.cjs') || name === RTAGNOSTIC_REGISTRY_FILE) continue;
    const rel = `gsd-ng/bin/lib/${name}`;
    const count = rtagnosticCountConfigDirs(
      fs.readFileSync(path.join(RTAGNOSTIC_LIB_DIR, name), 'utf8'),
      literals,
    );
    const allowed = RTAGNOSTIC_CONFIG_DIR_ALLOWLIST[rel] || 0;
    if (count > allowed) {
      offenders.push(`${rel} :: ${count} config-home literals, allowlist ${allowed}`);
    } else if (count < allowed) {
      shrunk.push(`${rel} :: ${count} < ${allowed}`);
    }
  }
  for (const line of shrunk) {
    console.log(`  note: config-home allowlist can be tightened — ${line}`);
  }
  assert.deepStrictEqual(
    offenders,
    [],
    'RTAGNOSTIC-11: config-home literals rose above the recorded allowlist. ' +
      'The allowlist only shrinks — route the new one through the runtime spec:\n  ' +
      offenders.join('\n  '),
  );
});

// runtime-comparison prose must survive Copilot conversion intact
test('COPILOT-RT: runtime-comparison prose survives Copilot conversion intact', () => {
  const { convertClaudeToCopilotContent } = require('../bin/install.js');
  const input =
    'Updates both the project rules file (`CLAUDE.md` for Claude, ' +
    '`.github/copilot-instructions.md` for Copilot).';
  const output = convertClaudeToCopilotContent(input, false);
  assert.ok(
    output.includes('`CLAUDE.md` for Claude'),
    `COPILOT-RT: expected '\`CLAUDE.md\` for Claude' to survive verbatim, got: ${output}`,
  );
  assert.ok(
    output.includes('`.github/copilot-instructions.md` for Copilot'),
    `COPILOT-RT: expected '\`.github/copilot-instructions.md\` for Copilot' to survive verbatim, got: ${output}`,
  );
});

// ── GSD's own agent-frontmatter sync is not a "local modification" ──

function runLocalInstall(tmpDir) {
  return spawnSync(process.execPath, [INSTALLER, '--runtime', 'claude', '--local'], {
    encoding: 'utf8',
    timeout: 15000,
    cwd: tmpDir,
    env: Object.assign({}, process.env, { HOME: os.homedir() }),
  });
}

// Reproduces what /gsd:set-profile and `config-set effort_overrides.*` do to the
// deployed agent files: write a profile, then run the real sync helper.
function applyProfileSync(tmpDir, profile) {
  const {
    syncAgentEffortFrontmatter,
  } = require('../gsd-ng/bin/lib/effort-sync.cjs');
  fs.mkdirSync(path.join(tmpDir, '.planning'), { recursive: true });
  fs.writeFileSync(
    path.join(tmpDir, '.planning', 'config.json'),
    JSON.stringify({ model_profile: profile }),
  );
  return syncAgentEffortFrontmatter(
    tmpDir,
    path.join(tmpDir, '.claude', 'agents'),
  );
}

test('MANIFEST-SYNC-01: agent files rewritten by GSD\'s own effort sync are NOT reported as locally modified', () => {
  const tmpDir = fs.mkdtempSync(path.join(BASE_TMPDIR, 'gsd-manifest-sync-01-'));
  try {
    const r1 = runLocalInstall(tmpDir);
    assert.strictEqual(
      r1.status,
      0,
      'first install must exit 0 (MANIFEST-SYNC-01)\nstderr: ' + (r1.stderr || ''),
    );

    const synced = applyProfileSync(tmpDir, 'quality');
    assert.ok(
      synced.changes.length > 0,
      'profile switch must rewrite at least one agent file, else the test proves nothing (MANIFEST-SYNC-01)',
    );

    const r2 = runLocalInstall(tmpDir);
    assert.strictEqual(
      r2.status,
      0,
      'second install must exit 0 (MANIFEST-SYNC-01)\nstderr: ' + (r2.stderr || ''),
    );

    const r2Stdout = r2.stdout || '';
    assert.ok(
      !/Found \d+ locally modified GSD file/.test(r2Stdout),
      'config-driven effort frontmatter must NOT be reported as a local modification (MANIFEST-SYNC-01).\n' +
        'stdout: ' +
        r2Stdout.slice(0, 2000),
    );

    const patchesDir = path.join(tmpDir, '.claude', 'gsd-local-patches');
    if (fs.existsSync(patchesDir)) {
      const entries = fs.readdirSync(patchesDir).filter((e) => e !== '.gitkeep');
      assert.strictEqual(
        entries.length,
        0,
        'gsd-local-patches/ must stay empty after a profile switch (MANIFEST-SYNC-01). Entries: ' +
          entries.join(', '),
      );
    }
  } finally {
    cleanup(tmpDir);
  }
});

test('MANIFEST-SYNC-02: a real body edit is still detected when GSD also rewrote the same file\'s frontmatter', () => {
  const tmpDir = fs.mkdtempSync(path.join(BASE_TMPDIR, 'gsd-manifest-sync-02-'));
  try {
    const r1 = runLocalInstall(tmpDir);
    assert.strictEqual(
      r1.status,
      0,
      'first install must exit 0 (MANIFEST-SYNC-02)\nstderr: ' + (r1.stderr || ''),
    );

    // Hand-edit the body of ONE agent, then let GSD's sync rewrite the managed
    // frontmatter of ALL of them on top. Only the hand-edited one is a patch.
    const editedAgent = path.join(tmpDir, '.claude', 'agents', 'gsd-planner.md');
    const marker = '<!-- local body edit -->';
    fs.appendFileSync(editedAgent, '\n' + marker + '\n');
    applyProfileSync(tmpDir, 'quality');

    const r2 = runLocalInstall(tmpDir);
    assert.strictEqual(
      r2.status,
      0,
      'second install must exit 0 (MANIFEST-SYNC-02)\nstderr: ' + (r2.stderr || ''),
    );

    const r2Stdout = r2.stdout || '';
    assert.ok(
      /Found 1 locally modified GSD file/.test(r2Stdout),
      'exactly one file (the hand-edited agent) must be reported (MANIFEST-SYNC-02).\n' +
        'stdout: ' +
        r2Stdout.slice(0, 2000),
    );

    const backup = path.join(
      tmpDir,
      '.claude',
      'gsd-local-patches',
      'agents',
      'gsd-planner.md',
    );
    assert.ok(
      fs.existsSync(backup),
      'hand-edited agent must be backed up to gsd-local-patches/ (MANIFEST-SYNC-02)',
    );
    assert.ok(
      fs.readFileSync(backup, 'utf8').includes(marker),
      'the backed-up copy must retain the user body edit (MANIFEST-SYNC-02)',
    );

    const meta = JSON.parse(
      fs.readFileSync(
        path.join(tmpDir, '.claude', 'gsd-local-patches', 'backup-meta.json'),
        'utf8',
      ),
    );
    assert.deepStrictEqual(
      meta.files,
      ['agents/gsd-planner.md'],
      'backup-meta.json must list only the hand-edited agent (MANIFEST-SYNC-02)',
    );
  } finally {
    cleanup(tmpDir);
  }
});

test('MANIFEST-SYNC-03: manifest without files_normalized falls back to raw-hash comparison', () => {
  const tmpDir = fs.mkdtempSync(path.join(BASE_TMPDIR, 'gsd-manifest-sync-03-'));
  try {
    const r1 = runLocalInstall(tmpDir);
    assert.strictEqual(
      r1.status,
      0,
      'first install must exit 0 (MANIFEST-SYNC-03)\nstderr: ' + (r1.stderr || ''),
    );

    // Simulate a manifest written before files_normalized existed: raw hashes only.
    const manifestPath = path.join(tmpDir, '.claude', 'gsd-file-manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    assert.ok(
      manifest.files_normalized &&
        manifest.files_normalized['agents/gsd-planner.md'],
      'fresh manifest must carry a normalized hash for agent files (MANIFEST-SYNC-03)',
    );
    delete manifest.files_normalized;
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

    applyProfileSync(tmpDir, 'quality');

    const r2 = runLocalInstall(tmpDir);
    assert.strictEqual(
      r2.status,
      0,
      'second install must exit 0 (MANIFEST-SYNC-03)\nstderr: ' + (r2.stderr || ''),
    );
    assert.ok(
      /Found \d+ locally modified GSD file/.test(r2.stdout || ''),
      'legacy manifest must keep the old raw-hash verdict rather than silently trusting the file (MANIFEST-SYNC-03).\n' +
        'stdout: ' +
        (r2.stdout || '').slice(0, 2000),
    );
  } finally {
    cleanup(tmpDir);
  }
});

// ── uninstall prunes GSD hooks without taking co-located user hooks ──

function runUninstallIn(tmpDir) {
  return spawnSync(
    process.execPath,
    [INSTALLER, '--runtime', 'claude', '--local', '--uninstall'],
    {
      encoding: 'utf8',
      timeout: 15000,
      cwd: tmpDir,
      env: Object.assign({}, process.env, { HOME: os.homedir() }),
    },
  );
}

const USER_HOOK = 'node /home/me/my-own-pretooluse-hook.js';

test('HOOKENTRY-01: uninstall keeps a user command sharing a PreToolUse entry with a GSD hook', () => {
  const tmpDir = fs.mkdtempSync(path.join(BASE_TMPDIR, 'gsd-hookentry-01-'));
  try {
    seedSettings(
      tmpDir,
      JSON.stringify(
        {
          hooks: {
            PreToolUse: [
              {
                matcher: 'Bash',
                hooks: [
                  { type: 'command', command: 'node /x/gsd-guardrail.js' },
                  { type: 'command', command: USER_HOOK },
                ],
              },
              {
                matcher: 'Write',
                hooks: [
                  { type: 'command', command: 'node /x/gsd-sandbox-detect.js' },
                ],
              },
            ],
          },
        },
        null,
        2,
      ) + '\n',
    );

    const r = runUninstallIn(tmpDir);
    assert.strictEqual(
      r.status,
      0,
      'uninstall must exit 0\nstderr: ' + (r.stderr || ''),
    );

    const after = JSON.parse(readSettingsFile(tmpDir));
    const entries = (after.hooks && after.hooks.PreToolUse) || [];
    const commands = entries.flatMap((e) =>
      (e.hooks || []).map((h) => h.command),
    );

    assert.ok(
      commands.includes(USER_HOOK),
      'a user command co-located with a GSD hook must survive uninstall (HOOKENTRY-01).\n' +
        'Remaining PreToolUse: ' +
        JSON.stringify(entries),
    );
    assert.ok(
      !commands.some((c) => c.includes('gsd-guardrail')),
      'the GSD hook must still be removed from the shared entry (HOOKENTRY-01)',
    );
    // The Write entry held nothing but a GSD hook, so it must go entirely
    // rather than linger as an entry with an empty hooks array.
    assert.ok(
      !commands.some((c) => c.includes('gsd-sandbox-detect')),
      'a GSD-only entry must still be removed (HOOKENTRY-01)',
    );
    assert.strictEqual(
      entries.length,
      1,
      'the emptied entry must be dropped, not left with an empty hooks array (HOOKENTRY-01).\n' +
        'Remaining: ' +
        JSON.stringify(entries),
    );
  } finally {
    cleanup(tmpDir);
  }
});

test('HOOKENTRY-02: uninstall keeps user commands sharing SessionStart and PostToolUse entries', () => {
  const tmpDir = fs.mkdtempSync(path.join(BASE_TMPDIR, 'gsd-hookentry-02-'));
  try {
    seedSettings(
      tmpDir,
      JSON.stringify(
        {
          hooks: {
            SessionStart: [
              {
                hooks: [
                  { type: 'command', command: 'node /x/gsd-check-update.js' },
                  { type: 'command', command: 'node /home/me/session-hook.js' },
                ],
              },
            ],
            PostToolUse: [
              {
                matcher: 'Edit',
                hooks: [
                  {
                    type: 'command',
                    command: 'node /x/gsd-context-monitor.js',
                  },
                  { type: 'command', command: 'node /home/me/post-hook.js' },
                ],
              },
            ],
          },
        },
        null,
        2,
      ) + '\n',
    );

    const r = runUninstallIn(tmpDir);
    assert.strictEqual(
      r.status,
      0,
      'uninstall must exit 0\nstderr: ' + (r.stderr || ''),
    );

    const after = JSON.parse(readSettingsFile(tmpDir));
    const commandsFor = (event) =>
      ((after.hooks && after.hooks[event]) || []).flatMap((e) =>
        (e.hooks || []).map((h) => h.command),
      );

    assert.ok(
      commandsFor('SessionStart').includes('node /home/me/session-hook.js'),
      'user SessionStart command must survive uninstall (HOOKENTRY-02).\nGot: ' +
        JSON.stringify(commandsFor('SessionStart')),
    );
    assert.ok(
      !commandsFor('SessionStart').some((c) => c.includes('gsd-check-update')),
      'GSD SessionStart hook must be removed (HOOKENTRY-02)',
    );
    assert.ok(
      commandsFor('PostToolUse').includes('node /home/me/post-hook.js'),
      'user PostToolUse command must survive uninstall (HOOKENTRY-02).\nGot: ' +
        JSON.stringify(commandsFor('PostToolUse')),
    );
    assert.ok(
      !commandsFor('PostToolUse').some((c) => c.includes('gsd-context-monitor')),
      'GSD PostToolUse hook must be removed (HOOKENTRY-02)',
    );
  } finally {
    cleanup(tmpDir);
  }
});

test('HOOKENTRY-03: an event left with no entries is removed, not left as an empty array', () => {
  const tmpDir = fs.mkdtempSync(path.join(BASE_TMPDIR, 'gsd-hookentry-03-'));
  try {
    seedSettings(
      tmpDir,
      JSON.stringify(
        {
          hooks: {
            PreToolUse: [
              {
                matcher: 'Bash',
                hooks: [
                  { type: 'command', command: 'node /x/gsd-guardrail.js' },
                ],
              },
            ],
          },
        },
        null,
        2,
      ) + '\n',
    );

    const r = runUninstallIn(tmpDir);
    assert.strictEqual(
      r.status,
      0,
      'uninstall must exit 0\nstderr: ' + (r.stderr || ''),
    );

    const after = JSON.parse(readSettingsFile(tmpDir));
    assert.ok(
      !(after.hooks && 'PreToolUse' in after.hooks),
      'an event with nothing left in it must be deleted, not left as [] (HOOKENTRY-03).\n' +
        'Got hooks: ' +
        JSON.stringify(after.hooks),
    );
  } finally {
    cleanup(tmpDir);
  }
});

// ── an unreadable settings.json must never be silently replaced ──

function readSettingsFile(tmpDir) {
  return fs.readFileSync(
    path.join(tmpDir, '.claude', 'settings.json'),
    'utf8',
  );
}

function seedSettings(tmpDir, body) {
  const settingsPath = path.join(tmpDir, '.claude', 'settings.json');
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, body);
  return settingsPath;
}

test('SETTINGS-01: JSONC settings.json keeps model/env/permissions and the original is backed up', () => {
  const tmpDir = fs.mkdtempSync(path.join(BASE_TMPDIR, 'gsd-settings-01-'));
  try {
    // A comment and a trailing comma — strict JSON.parse rejects both, and this
    // is what settings authors demonstrably hand-write.
    const original = [
      '{',
      '  // my preferred model',
      '  "model": "opus",',
      '  "env": { "MY_VAR": "my-value" },',
      '  "permissions": {',
      '    "allow": ["Bash(my-tool:*)"],',
      '  },',
      '}',
      '',
    ].join('\n');
    seedSettings(tmpDir, original);

    const r = runInstallIn(tmpDir, 'claude');
    assert.strictEqual(
      r.status,
      0,
      'install over a JSONC settings.json must exit 0\nstderr: ' +
        (r.stderr || ''),
    );

    const after = JSON.parse(readSettingsFile(tmpDir));
    assert.strictEqual(
      after.model,
      'opus',
      'user model must survive install over JSONC settings (SETTINGS-01)',
    );
    assert.deepStrictEqual(
      after.env,
      { MY_VAR: 'my-value' },
      'user env must survive install over JSONC settings (SETTINGS-01)',
    );
    assert.ok(
      Array.isArray(after.permissions && after.permissions.allow) &&
        after.permissions.allow.includes('Bash(my-tool:*)'),
      'user permissions.allow entry must survive install over JSONC settings (SETTINGS-01).\n' +
        'Got: ' +
        JSON.stringify(after.permissions),
    );

    // Recovery path: the write is a reformat that drops their comments, so the
    // original text must still exist somewhere on disk.
    const backups = fs
      .readdirSync(path.join(tmpDir, '.claude'))
      .filter((f) => f.startsWith('settings.json.gsd-backup'));
    assert.strictEqual(
      backups.length,
      1,
      'exactly one backup of the original settings.json must be written (SETTINGS-01). Found: ' +
        JSON.stringify(backups),
    );
    assert.strictEqual(
      fs.readFileSync(path.join(tmpDir, '.claude', backups[0]), 'utf8'),
      original,
      'the backup must be the byte-identical original, comments included (SETTINGS-01)',
    );
    assert.ok(
      /settings\.json/.test(r.stdout || '') &&
        /backed up|backup/i.test(r.stdout || ''),
      'the reformat must be reported, not silent (SETTINGS-01).\nstdout: ' +
        (r.stdout || '').slice(0, 2000),
    );
  } finally {
    cleanup(tmpDir);
  }
});

test('SETTINGS-02: an unrecoverable settings.json is refused, not overwritten', () => {
  const tmpDir = fs.mkdtempSync(path.join(BASE_TMPDIR, 'gsd-settings-02-'));
  try {
    const original = '{ "model": "opus", "env": { "MY_VAR": "my-value" }';
    seedSettings(tmpDir, original);

    const r = runInstallIn(tmpDir, 'claude');
    assert.notStrictEqual(
      r.status,
      0,
      'install must refuse rather than proceed over an unparseable settings.json (SETTINGS-02).\n' +
        'stdout: ' +
        (r.stdout || '').slice(0, 2000),
    );
    assert.strictEqual(
      readSettingsFile(tmpDir),
      original,
      'an unparseable settings.json must be left byte-identical (SETTINGS-02)',
    );
    const message = (r.stderr || '') + (r.stdout || '');
    assert.ok(
      /settings\.json/.test(message),
      'the refusal must name the offending file (SETTINGS-02).\nOutput: ' +
        message.slice(0, 2000),
    );
  } finally {
    cleanup(tmpDir);
  }
});

// Control for the JSONC test above: strict-valid settings must take the
// ordinary path — no backup file, no warning, user keys intact.
test('SETTINGS-03: a valid settings.json round-trips without a backup', () => {
  const tmpDir = fs.mkdtempSync(path.join(BASE_TMPDIR, 'gsd-settings-03-'));
  try {
    seedSettings(
      tmpDir,
      JSON.stringify(
        {
          model: 'opus',
          env: { MY_VAR: 'my-value' },
          permissions: { allow: ['Bash(my-tool:*)'] },
        },
        null,
        2,
      ) + '\n',
    );

    const r = runInstallIn(tmpDir, 'claude');
    assert.strictEqual(
      r.status,
      0,
      'install over a valid settings.json must exit 0\nstderr: ' +
        (r.stderr || ''),
    );

    const after = JSON.parse(readSettingsFile(tmpDir));
    assert.strictEqual(after.model, 'opus', 'user model must survive install');
    assert.deepStrictEqual(
      after.env,
      { MY_VAR: 'my-value' },
      'user env must survive install',
    );
    assert.ok(
      after.permissions.allow.includes('Bash(my-tool:*)'),
      'user permissions.allow entry must survive install',
    );

    const backups = fs
      .readdirSync(path.join(tmpDir, '.claude'))
      .filter((f) => f.startsWith('settings.json.gsd-backup'));
    assert.deepStrictEqual(
      backups,
      [],
      'a valid settings.json must not trigger a backup (SETTINGS-03). Found: ' +
        JSON.stringify(backups),
    );
  } finally {
    cleanup(tmpDir);
  }
});

// ── --clean must not delete through a symlinked managed directory ──

function runInstallIn(tmpDir, rt, extraArgs = []) {
  return spawnSync(
    process.execPath,
    [INSTALLER, '--runtime', rt, '--local', ...extraArgs],
    {
      encoding: 'utf8',
      timeout: 15000,
      cwd: tmpDir,
      env: Object.assign({}, process.env, { HOME: os.homedir() }),
    },
  );
}

test('SYMLINK-01: --clean does not delete gsd-* agents through a symlinked agents/ dir', () => {
  const tmpDir = fs.mkdtempSync(path.join(BASE_TMPDIR, 'gsd-symlink-01-'));
  try {
    const r1 = runInstallIn(tmpDir, 'claude');
    assert.strictEqual(
      r1.status,
      0,
      'baseline local install must exit 0\nstderr: ' + (r1.stderr || ''),
    );

    // The escape target lives OUTSIDE the managed tree entirely.
    const outside = path.join(tmpDir, 'outside-shared-agents');
    fs.mkdirSync(outside, { recursive: true });
    const victim = path.join(outside, 'gsd-shared-user-agent.md');
    fs.writeFileSync(victim, 'user-owned-shared-agent');

    const agentsDir = path.join(tmpDir, '.claude', 'agents');
    cleanupSubdir(tmpDir, '.claude', 'agents');
    fs.symlinkSync(outside, agentsDir, 'dir');

    const r2 = runInstallIn(tmpDir, 'claude', ['--clean']);
    assert.strictEqual(
      r2.status,
      0,
      '--clean install must exit 0\nstderr: ' + (r2.stderr || ''),
    );

    assert.ok(
      fs.existsSync(victim),
      'file inside a symlink target must survive --clean (SYMLINK-01): ' +
        victim +
        '\nstdout: ' +
        (r2.stdout || '').slice(0, 1500),
    );
    assert.strictEqual(
      fs.readFileSync(victim, 'utf8'),
      'user-owned-shared-agent',
      'file inside a symlink target must be byte-identical after --clean (SYMLINK-01)',
    );
    // Silence would leave the user with an unmanaged agents/ dir and no idea why.
    assert.ok(
      /Skipped .*agents.*symlinked directory/.test(r2.stdout || ''),
      'skipping a symlinked dir must be reported, not silent (SYMLINK-01).\nstdout: ' +
        (r2.stdout || '').slice(0, 1500),
    );
  } finally {
    cleanup(tmpDir);
  }
});

test('SYMLINK-02: --clean does not recursively delete gsd-* skills through a symlinked skills/ dir', () => {
  const tmpDir = fs.mkdtempSync(path.join(BASE_TMPDIR, 'gsd-symlink-02-'));
  try {
    const r1 = runInstallIn(tmpDir, 'copilot');
    assert.strictEqual(
      r1.status,
      0,
      'baseline copilot install must exit 0\nstderr: ' + (r1.stderr || ''),
    );

    const outside = path.join(tmpDir, 'outside-shared-skills');
    const victimDir = path.join(outside, 'gsd-shared-user-skill');
    fs.mkdirSync(victimDir, { recursive: true });
    const victim = path.join(victimDir, 'SKILL.md');
    fs.writeFileSync(victim, 'user-owned-shared-skill');

    const skillsDir = path.join(tmpDir, '.github', 'skills');
    cleanupSubdir(tmpDir, '.github', 'skills');
    fs.mkdirSync(path.dirname(skillsDir), { recursive: true });
    fs.symlinkSync(outside, skillsDir, 'dir');

    const r2 = runInstallIn(tmpDir, 'copilot', ['--clean']);
    assert.strictEqual(
      r2.status,
      0,
      'copilot --clean install must exit 0\nstderr: ' + (r2.stderr || ''),
    );

    assert.ok(
      fs.existsSync(victim),
      'directory tree inside a symlink target must survive --clean (SYMLINK-02): ' +
        victim +
        '\nstdout: ' +
        (r2.stdout || '').slice(0, 1500),
    );
    assert.strictEqual(
      fs.readFileSync(victim, 'utf8'),
      'user-owned-shared-skill',
      'file inside a symlink target must be byte-identical after --clean (SYMLINK-02)',
    );
  } finally {
    cleanup(tmpDir);
  }
});

// Control for the two symlink tests above: the refusal must be scoped to
// symlinks only. A real managed directory is still wiped, so a guard that
// over-refuses fails here.
test('SYMLINK-03: --clean still removes GSD-owned files from real (non-symlink) dirs', () => {
  const tmpDir = fs.mkdtempSync(path.join(BASE_TMPDIR, 'gsd-symlink-03-'));
  try {
    const r1 = runInstallIn(tmpDir, 'claude');
    assert.strictEqual(
      r1.status,
      0,
      'baseline local install must exit 0\nstderr: ' + (r1.stderr || ''),
    );

    // GSD-namespaced but shipped by no release, so only the wipe can remove it.
    const staleAgent = path.join(
      tmpDir,
      '.claude',
      'agents',
      'gsd-retired-agent.md',
    );
    fs.writeFileSync(staleAgent, 'stale-gsd-owned-agent');
    const userAgent = path.join(tmpDir, '.claude', 'agents', 'zz-user.md');
    fs.writeFileSync(userAgent, 'user-owned-agent');

    const r2 = runInstallIn(tmpDir, 'claude', ['--clean']);
    assert.strictEqual(
      r2.status,
      0,
      '--clean install must exit 0\nstderr: ' + (r2.stderr || ''),
    );

    assert.ok(
      !fs.existsSync(staleAgent),
      'stale GSD-owned agent in a real dir must still be deleted by --clean (SYMLINK-03)',
    );
    assert.strictEqual(
      fs.readFileSync(userAgent, 'utf8'),
      'user-owned-agent',
      'user agent in a real dir must survive --clean (SYMLINK-03)',
    );
  } finally {
    cleanup(tmpDir);
  }
});

// ── registry-driven path resolution ─────────────────────────────────

const {
  getGlobalDir,
  getDirName,
  getConfigDirFromHome,
  getRuntimeLabel,
} = require('../bin/install.js');

// The resolvers are pure reads of process.env, so drive them by swapping the
// four config-home variables in place rather than by spawning an installer.
const RESOLVER_ENV_KEYS = [
  'CLAUDE_CONFIG_DIR',
  'COPILOT_CONFIG_DIR',
  'OPENCODE_CONFIG_DIR',
  'XDG_CONFIG_HOME',
];

function withResolverEnv(overrides, fn) {
  const saved = {};
  for (const key of RESOLVER_ENV_KEYS) {
    saved[key] = process.env[key];
    const value = Object.prototype.hasOwnProperty.call(overrides, key)
      ? overrides[key]
      : undefined;
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return fn();
  } finally {
    for (const key of RESOLVER_ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

test('OPENCODE-CFG-01: OPENCODE_CONFIG_DIR overrides the opencode global dir', () => {
  withResolverEnv({ OPENCODE_CONFIG_DIR: '~/oc-override' }, () => {
    assert.strictEqual(
      getGlobalDir('opencode'),
      path.join(os.homedir(), 'oc-override'),
      'OPENCODE_CONFIG_DIR must win and have its tilde expanded (OPENCODE-CFG-01)',
    );
  });
});

test('OPENCODE-CFG-02: XDG_CONFIG_HOME drives the opencode global dir when no override is set', () => {
  const xdgBase = path.join(BASE_TMPDIR, 'xdg-config-home');
  withResolverEnv({ XDG_CONFIG_HOME: xdgBase }, () => {
    assert.strictEqual(
      getGlobalDir('opencode'),
      path.join(xdgBase, 'opencode'),
      'opencode must land under $XDG_CONFIG_HOME/opencode (OPENCODE-CFG-02)',
    );
  });
});

test('OPENCODE-CFG-03: opencode falls back to ~/.config/opencode', () => {
  withResolverEnv({}, () => {
    assert.strictEqual(
      getGlobalDir('opencode'),
      path.join(os.homedir(), '.config', 'opencode'),
      'with neither variable set opencode must use ~/.config/opencode (OPENCODE-CFG-03)',
    );
  });
});

test('OPENCODE-CFG-04: opencode local dir, config literal and label come from the registry', () => {
  assert.strictEqual(getDirName('opencode'), '.opencode');
  assert.strictEqual(getConfigDirFromHome('opencode', true), "'.opencode'");
  assert.strictEqual(getConfigDirFromHome('opencode', false), "'.opencode'");
  assert.strictEqual(getRuntimeLabel('opencode'), 'OpenCode');
});

test('RTPATH-01: claude and copilot resolve exactly as before the registry rewrite', () => {
  withResolverEnv({ CLAUDE_CONFIG_DIR: '~/cc-override' }, () => {
    assert.strictEqual(
      getGlobalDir('claude'),
      path.join(os.homedir(), 'cc-override'),
    );
  });
  withResolverEnv({ COPILOT_CONFIG_DIR: '~/co-override' }, () => {
    assert.strictEqual(
      getGlobalDir('copilot'),
      path.join(os.homedir(), 'co-override'),
    );
  });
  // An XDG value set in the ambient environment must not reach a runtime that
  // has no such spec.
  withResolverEnv({ XDG_CONFIG_HOME: path.join(BASE_TMPDIR, 'xdg-config-home') }, () => {
    assert.strictEqual(
      getGlobalDir('claude'),
      path.join(os.homedir(), '.claude'),
    );
    assert.strictEqual(
      getGlobalDir('copilot'),
      path.join(os.homedir(), '.copilot'),
    );
  });

  assert.strictEqual(getDirName('claude'), '.claude');
  assert.strictEqual(getDirName('copilot'), '.github');
  assert.strictEqual(getConfigDirFromHome('claude', true), "'.claude'");
  assert.strictEqual(getConfigDirFromHome('claude', false), "'.claude'");
  assert.strictEqual(getConfigDirFromHome('copilot', true), "'.copilot'");
  assert.strictEqual(getConfigDirFromHome('copilot', false), "'.github'");
  assert.strictEqual(getRuntimeLabel('claude'), 'Claude Code');
  assert.strictEqual(getRuntimeLabel('copilot'), 'Copilot CLI');
});

test('RTPATH-02: a runtime with no registry row still resolves without throwing', () => {
  withResolverEnv({}, () => {
    assert.strictEqual(getDirName('zed'), '.claude');
    assert.strictEqual(getConfigDirFromHome('zed', true), "'.claude'");
    assert.strictEqual(getConfigDirFromHome('zed', false), "'.claude'");
    assert.strictEqual(getGlobalDir('zed'), path.join(os.homedir(), '.claude'));
    assert.strictEqual(getRuntimeLabel('zed'), 'zed');
    assert.strictEqual(getRuntimeLabel(undefined), 'your runtime');
  });
});

// ── the home-relative form of a global config dir ────────────────────

const {
  globalHomeRelative,
  convertContent,
  convertClaudeCommandToOpencodeCommand,
} = require('../bin/install.js');

// Outside $HOME by construction, and never created on disk — the resolvers are
// pure string work.
const OUTSIDE_HOME = path.join(path.parse(os.homedir()).root, 'gsd-oc-outside');

test('GHR-01: with no override every runtime keeps its historical home-relative dir', () => {
  withResolverEnv({}, () => {
    assert.strictEqual(globalHomeRelative('claude'), '.claude');
    assert.strictEqual(globalHomeRelative('copilot'), '.copilot');
    assert.strictEqual(globalHomeRelative('opencode'), '.config/opencode');
    assert.strictEqual(globalHomeRelative('zed'), '.claude');
  });
});

test('GHR-02: an override under $HOME moves the home-relative form with it', () => {
  withResolverEnv({ OPENCODE_CONFIG_DIR: '~/oc-override' }, () => {
    assert.strictEqual(globalHomeRelative('opencode'), 'oc-override');
  });
  withResolverEnv({ CLAUDE_CONFIG_DIR: path.join(os.homedir(), 'cc', 'nested') }, () => {
    assert.strictEqual(globalHomeRelative('claude'), 'cc/nested');
  });
  withResolverEnv({ XDG_CONFIG_HOME: path.join(os.homedir(), 'xdg') }, () => {
    assert.strictEqual(globalHomeRelative('opencode'), 'xdg/opencode');
  });
});

test('GHR-03: an override outside $HOME yields the absolute path, never a $HOME concatenation', () => {
  withResolverEnv({ OPENCODE_CONFIG_DIR: OUTSIDE_HOME }, () => {
    assert.strictEqual(globalHomeRelative('opencode'), OUTSIDE_HOME);

    const converted = convertContent(
      'ref ~/.claude/gsd-ng/workflows/quick.md and $HOME/.claude/hooks/h.js',
      'opencode',
      true,
    );
    assert.ok(
      converted.includes(`${OUTSIDE_HOME}/gsd-ng/workflows/quick.md`),
      `absolute config home must replace the whole reference, got: ${converted}`,
    );
    assert.ok(
      converted.includes(`${OUTSIDE_HOME}/hooks/h.js`),
      `absolute config home must replace the $HOME form too, got: ${converted}`,
    );
    assert.ok(
      !converted.includes('$HOME/'),
      `no $HOME-prefixed concatenation may survive, got: ${converted}`,
    );
    assert.ok(
      !converted.includes('~/'),
      `no tilde-prefixed concatenation may survive, got: ${converted}`,
    );
  });
});

test('GHR-04: an opencode @ reference resolves against the same absolute dir', () => {
  withResolverEnv({ OPENCODE_CONFIG_DIR: OUTSIDE_HOME }, () => {
    // No frontmatter, so this passes the body straight through the opencode
    // content conversion the @-reference rewrite lives in.
    const converted = convertClaudeCommandToOpencodeCommand(
      'load @~/.claude/gsd-ng/workflows/quick.md now',
      true,
    );
    assert.ok(
      converted.includes(`@${OUTSIDE_HOME}/gsd-ng/workflows/quick.md`),
      `@ reference must carry the resolved dir, got: ${converted}`,
    );
  });
});

// ── the registry is the only runtime list ───────────────────────────

const { runtimeFlagHint, runtimeChoiceLines } = require('../bin/install.js');

test('OPENCODE-ARG-01: --runtime opencode passes argument validation', () => {
  const tmpDir = fs.mkdtempSync(path.join(BASE_TMPDIR, 'gsd-js-ocarg-'));
  try {
    // No --global/--local and no TTY, so this stops at the non-interactive
    // gate. Reaching that gate is the proof that validation accepted it.
    const result = spawnSync(process.execPath, [INSTALLER, '--runtime', 'opencode'], {
      encoding: 'utf8',
      timeout: 15000,
      cwd: tmpDir,
      env: Object.assign({}, process.env, { HOME: os.homedir() }),
    });
    const output = (result.stderr || '') + (result.stdout || '');
    assert.ok(
      !output.includes('Unknown runtime'),
      'opencode must not be rejected as an unknown runtime (OPENCODE-ARG-01)\nActual output: ' +
        output.slice(0, 500),
    );
    assert.ok(
      output.includes('Non-interactive terminal detected'),
      'opencode must reach the non-interactive gate (OPENCODE-ARG-01)\nActual output: ' +
        output.slice(0, 500),
    );
  } finally {
    cleanup(tmpDir);
  }
});

test('OPENCODE-ARG-02: an unknown runtime is rejected and the error names every registry runtime', () => {
  const tmpDir = fs.mkdtempSync(path.join(BASE_TMPDIR, 'gsd-js-badrt-'));
  try {
    const result = spawnSync(process.execPath, [INSTALLER, '--runtime', 'zed'], {
      encoding: 'utf8',
      timeout: 15000,
      cwd: tmpDir,
      env: Object.assign({}, process.env, { HOME: os.homedir() }),
    });
    assert.notStrictEqual(
      result.status,
      0,
      'an unknown runtime must exit non-zero (OPENCODE-ARG-02)',
    );
    const output = (result.stderr || '') + (result.stdout || '');
    for (const rt of Object.keys(RUNTIMES)) {
      assert.ok(
        output.includes(`--runtime ${rt}`),
        `the error must offer --runtime ${rt} (OPENCODE-ARG-02)\nActual output: ` +
          output.slice(0, 500),
      );
    }
  } finally {
    cleanup(tmpDir);
  }
});

test('RTLIST-01: the flag hint and the prompt choices come from the registry', () => {
  const ids = Object.keys(RUNTIMES);
  assert.strictEqual(
    runtimeFlagHint(),
    ids.map((rt) => `--runtime ${rt}`).join(' or '),
  );

  const lines = runtimeChoiceLines();
  assert.strictEqual(
    lines.length,
    ids.length,
    'one prompt choice per registry runtime (RTLIST-01)',
  );
  const plain = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');
  ids.forEach((rt, i) => {
    assert.ok(
      plain(lines[i]).includes(`${i + 1})`),
      `choice ${i + 1} must keep its number (RTLIST-01): ${plain(lines[i])}`,
    );
    assert.ok(
      plain(lines[i]).includes(RUNTIMES[rt].RUNTIME_LABEL),
      `choice ${i + 1} must carry the registry label (RTLIST-01): ${plain(lines[i])}`,
    );
  });
});

// ── removal follows the layout spec, not the runtime name ───────────

const { removeGsdFiles } = require('../bin/install.js');

function runUninstallFor(tmpDir, rt) {
  return spawnSync(
    process.execPath,
    [INSTALLER, '--runtime', rt, '--local', '--uninstall'],
    {
      encoding: 'utf8',
      timeout: 15000,
      cwd: tmpDir,
      env: Object.assign({}, process.env, { HOME: os.homedir() }),
    },
  );
}

function writeFileAt(...parts) {
  const body = parts.pop();
  const full = path.join(...parts);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, body);
  return full;
}

test('REMOVE-SPEC-01: claude uninstall removes the declared sets and nothing else', () => {
  const tmpDir = fs.mkdtempSync(path.join(BASE_TMPDIR, 'gsd-remove-spec-01-'));
  try {
    assert.strictEqual(
      runInstallIn(tmpDir, 'claude').status,
      0,
      'baseline claude install must exit 0 (REMOVE-SPEC-01)',
    );
    const target = path.join(tmpDir, '.claude');
    const userAgent = writeFileAt(target, 'agents', 'my-agent.md', 'user-agent');
    const userCommand = writeFileAt(
      target,
      'commands',
      'mine.md',
      'user-command',
    );
    const userHook = writeFileAt(target, 'hooks', 'zz-user.js', 'user-hook');

    const r = runUninstallFor(tmpDir, 'claude');
    assert.strictEqual(
      r.status,
      0,
      'uninstall must exit 0 (REMOVE-SPEC-01)\nstderr: ' + (r.stderr || ''),
    );

    assert.ok(
      !fs.existsSync(path.join(target, 'commands', 'gsd')),
      'commands/gsd/ must be gone (REMOVE-SPEC-01)',
    );
    assert.ok(
      !fs.existsSync(path.join(target, 'gsd-ng')),
      'gsd-ng/ must be gone (REMOVE-SPEC-01)',
    );
    assert.ok(
      !fs.existsSync(path.join(target, 'gsd-file-manifest.json')),
      'the manifest must be gone (REMOVE-SPEC-01)',
    );
    const agentsLeft = fs
      .readdirSync(path.join(target, 'agents'))
      .filter((f) => f.startsWith('gsd-') && f.endsWith('.md'));
    assert.deepStrictEqual(
      agentsLeft,
      [],
      'no gsd-*.md agents may survive (REMOVE-SPEC-01)',
    );
    const hooksLeft = fs
      .readdirSync(path.join(target, 'hooks'))
      .filter((f) => f !== 'zz-user.js');
    assert.deepStrictEqual(
      hooksLeft,
      [],
      'every GSD-owned hook must be gone (REMOVE-SPEC-01)',
    );

    for (const survivor of [userAgent, userCommand, userHook]) {
      assert.ok(
        fs.existsSync(survivor),
        'user file must survive a claude uninstall (REMOVE-SPEC-01): ' +
          survivor,
      );
    }
  } finally {
    cleanup(tmpDir);
  }
});

test('REMOVE-SPEC-02: copilot uninstall removes the declared sets and nothing else', () => {
  const tmpDir = fs.mkdtempSync(path.join(BASE_TMPDIR, 'gsd-remove-spec-02-'));
  try {
    assert.strictEqual(
      runInstallIn(tmpDir, 'copilot').status,
      0,
      'baseline copilot install must exit 0 (REMOVE-SPEC-02)',
    );
    const target = path.join(tmpDir, '.github');
    const userSkill = writeFileAt(
      target,
      'skills',
      'my-skill',
      'SKILL.md',
      'user-skill',
    );
    // A plain .md agent is claude-shaped, so it proves the copilot predicate
    // stayed on .agent.md instead of widening to the claude one.
    const userAgent = writeFileAt(
      target,
      'agents',
      'my.agent.md',
      'user-agent',
    );
    const claudeShapedAgent = writeFileAt(
      target,
      'agents',
      'gsd-not-copilots.md',
      'not-a-copilot-agent',
    );

    const r = runUninstallFor(tmpDir, 'copilot');
    assert.strictEqual(
      r.status,
      0,
      'uninstall must exit 0 (REMOVE-SPEC-02)\nstderr: ' + (r.stderr || ''),
    );

    assert.ok(
      !fs.existsSync(path.join(target, 'gsd-ng')),
      'gsd-ng/ must be gone (REMOVE-SPEC-02)',
    );
    assert.ok(
      !fs.existsSync(path.join(target, 'hooks', 'gsd-hooks.json')),
      'hooks/gsd-hooks.json must be gone (REMOVE-SPEC-02)',
    );
    assert.ok(
      !fs.existsSync(path.join(target, 'gsd-file-manifest.json')),
      'the manifest must be gone (REMOVE-SPEC-02)',
    );
    const skillsLeft = fs
      .readdirSync(path.join(target, 'skills'), { withFileTypes: true })
      .filter((e) => e.isDirectory() && e.name.startsWith('gsd-'));
    assert.deepStrictEqual(
      skillsLeft.map((e) => e.name),
      [],
      'no gsd-* skills may survive (REMOVE-SPEC-02)',
    );
    const agentsLeft = fs
      .readdirSync(path.join(target, 'agents'))
      .filter((f) => f.startsWith('gsd-') && f.endsWith('.agent.md'));
    assert.deepStrictEqual(
      agentsLeft,
      [],
      'no gsd-*.agent.md agents may survive (REMOVE-SPEC-02)',
    );

    for (const survivor of [userSkill, userAgent, claudeShapedAgent]) {
      assert.ok(
        fs.existsSync(survivor),
        'user file must survive a copilot uninstall (REMOVE-SPEC-02): ' +
          survivor,
      );
    }
  } finally {
    cleanup(tmpDir);
  }
});

test('REMOVE-SPEC-03: a runtime whose layout declares agent/ never gets the skills/ predicate', () => {
  const tmpDir = fs.mkdtempSync(path.join(BASE_TMPDIR, 'gsd-remove-spec-03-'));
  try {
    const target = path.join(tmpDir, '.opencode');
    // Declared by the opencode layout — must go.
    const ownAgent = writeFileAt(target, 'agent', 'gsd-x.md', 'gsd-agent');
    const ownCommand = writeFileAt(
      target,
      'command',
      'gsd-y.md',
      'gsd-command',
    );
    const engineFile = writeFileAt(target, 'gsd-ng', 'VERSION', '0.0.0');
    // Not declared by it — the copilot-shaped fall-through would take these.
    const foreignSkill = writeFileAt(
      target,
      'skills',
      'gsd-x',
      'SKILL.md',
      'foreign-skill',
    );
    const foreignAgent = writeFileAt(
      target,
      'agents',
      'gsd-z.agent.md',
      'foreign-agent',
    );
    const userAgent = writeFileAt(target, 'agent', 'keep.md', 'user-agent');

    removeGsdFiles(target, 'opencode');

    for (const gone of [ownAgent, ownCommand, engineFile]) {
      assert.ok(
        !fs.existsSync(gone),
        'a path the opencode layout declares must be removed (REMOVE-SPEC-03): ' +
          gone,
      );
    }
    for (const survivor of [foreignSkill, foreignAgent, userAgent]) {
      assert.ok(
        fs.existsSync(survivor),
        'a path the opencode layout does not declare must survive (REMOVE-SPEC-03): ' +
          survivor,
      );
    }
  } finally {
    cleanup(tmpDir);
  }
});

test('REMOVE-SPEC-04: a runtime with no registry row removes no artifacts at all', () => {
  const tmpDir = fs.mkdtempSync(path.join(BASE_TMPDIR, 'gsd-remove-spec-04-'));
  try {
    const target = path.join(tmpDir, '.zed');
    const files = [
      writeFileAt(target, 'skills', 'gsd-x', 'SKILL.md', 'skill'),
      writeFileAt(target, 'agents', 'gsd-z.agent.md', 'agent'),
      writeFileAt(target, 'commands', 'gsd', 'plan.md', 'command'),
      writeFileAt(target, 'gsd-ng', 'VERSION', '0.0.0'),
    ];

    removeGsdFiles(target, 'zed');

    for (const survivor of files) {
      assert.ok(
        fs.existsSync(survivor),
        'an unknown runtime declares no layout, so nothing may be removed for it (REMOVE-SPEC-04): ' +
          survivor,
      );
    }
  } finally {
    cleanup(tmpDir);
  }
});

test('REMOVE-SPEC-05: the symlink gate guards every enumerated directory, on every runtime', () => {
  const tmpDir = fs.mkdtempSync(path.join(BASE_TMPDIR, 'gsd-remove-spec-05-'));
  try {
    const outside = path.join(tmpDir, 'outside-shared-agents');
    const victim = writeFileAt(outside, 'gsd-x.md', 'user-owned-shared-agent');

    const target = path.join(tmpDir, '.opencode');
    fs.mkdirSync(target, { recursive: true });
    fs.symlinkSync(outside, path.join(target, 'agent'), 'dir');

    removeGsdFiles(target, 'opencode');

    assert.ok(
      fs.existsSync(victim),
      'removal must not resolve through a symlinked managed dir (REMOVE-SPEC-05)',
    );
    assert.strictEqual(
      fs.readFileSync(victim, 'utf8'),
      'user-owned-shared-agent',
      'the symlink target must be byte-identical (REMOVE-SPEC-05)',
    );
  } finally {
    cleanup(tmpDir);
  }
});

test('REMOVE-SPEC-06: uninstall counts what it removed, per runtime', () => {
  const tmpDir = fs.mkdtempSync(path.join(BASE_TMPDIR, 'gsd-remove-spec-06a-'));
  try {
    assert.strictEqual(runInstallIn(tmpDir, 'claude').status, 0);
    const target = path.join(tmpDir, '.claude');
    const agents = fs
      .readdirSync(path.join(target, 'agents'))
      .filter((f) => f.startsWith('gsd-') && f.endsWith('.md')).length;
    const hooks = fs
      .readdirSync(path.join(target, 'hooks'))
      .filter((f) => f !== '.gitkeep').length;

    const out = runUninstallFor(tmpDir, 'claude').stdout || '';
    assert.ok(agents > 0 && hooks > 0, 'fixture must have agents and hooks');
    assert.ok(
      out.includes(`Removed ${agents} GSD agents`),
      `claude uninstall must report ${agents} agents (REMOVE-SPEC-06)\nstdout: ${out}`,
    );
    assert.ok(
      out.includes(`Removed ${hooks} GSD hooks`),
      `claude uninstall must report ${hooks} hooks (REMOVE-SPEC-06)\nstdout: ${out}`,
    );
    assert.ok(
      out.includes('Removed commands/gsd/') && out.includes('Removed gsd-ng/'),
      `claude uninstall must report both owned trees (REMOVE-SPEC-06)\nstdout: ${out}`,
    );
  } finally {
    cleanup(tmpDir);
  }

  const tmpDir2 = fs.mkdtempSync(path.join(BASE_TMPDIR, 'gsd-remove-spec-06b-'));
  try {
    assert.strictEqual(runInstallIn(tmpDir2, 'copilot').status, 0);
    const target = path.join(tmpDir2, '.github');
    const skills = fs
      .readdirSync(path.join(target, 'skills'), { withFileTypes: true })
      .filter((e) => e.isDirectory() && e.name.startsWith('gsd-')).length;
    const agents = fs
      .readdirSync(path.join(target, 'agents'))
      .filter((f) => f.startsWith('gsd-') && f.endsWith('.agent.md')).length;

    const out = runUninstallFor(tmpDir2, 'copilot').stdout || '';
    assert.ok(skills > 0 && agents > 0, 'fixture must have skills and agents');
    assert.ok(
      out.includes(`Removed ${skills} GSD skills`),
      `copilot uninstall must report ${skills} skills (REMOVE-SPEC-06)\nstdout: ${out}`,
    );
    assert.ok(
      out.includes(`Removed ${agents} GSD agents`),
      `copilot uninstall must report ${agents} agents (REMOVE-SPEC-06)\nstdout: ${out}`,
    );
    assert.ok(
      out.includes('Removed hooks/gsd-hooks.json'),
      `copilot uninstall must name the hooks descriptor it removed (REMOVE-SPEC-06)\nstdout: ${out}`,
    );
  } finally {
    cleanup(tmpDir2);
  }
});

// ── the manifested set comes from the same layout spec ───────────────

function readManifest(target) {
  return JSON.parse(
    fs.readFileSync(path.join(target, 'gsd-file-manifest.json'), 'utf8'),
  );
}

test('MANIFEST-SPEC-01: a copilot manifest covers every installed skill', () => {
  const tmpDir = fs.mkdtempSync(path.join(BASE_TMPDIR, 'gsd-manifest-spec-01-'));
  try {
    assert.strictEqual(runInstallIn(tmpDir, 'copilot').status, 0);
    const target = path.join(tmpDir, '.github');
    const manifest = readManifest(target);

    const skillKeys = Object.keys(manifest.files).filter((k) =>
      k.startsWith('skills/gsd-'),
    );
    assert.ok(
      skillKeys.length > 0,
      'converted skills must be manifested, or local-patch backup cannot protect them (MANIFEST-SPEC-01)',
    );

    const onDisk = fs
      .readdirSync(path.join(target, 'skills'), { withFileTypes: true })
      .filter((e) => e.isDirectory() && e.name.startsWith('gsd-'))
      .map((e) => `skills/${e.name}/SKILL.md`);
    assert.ok(onDisk.length > 0, 'fixture must have installed skills');
    for (const rel of onDisk) {
      assert.ok(
        manifest.files[rel],
        `installed skill must be manifested (MANIFEST-SPEC-01): ${rel}`,
      );
      assert.strictEqual(
        manifest.files[rel],
        crypto
          .createHash('sha256')
          .update(fs.readFileSync(path.join(target, rel)))
          .digest('hex'),
        `manifested hash must match the installed bytes (MANIFEST-SPEC-01): ${rel}`,
      );
    }

    assert.deepStrictEqual(
      manifest.installed_hooks,
      ['gsd-hooks.json'],
      'the layout-declared hooks descriptor must be recorded (MANIFEST-SPEC-01)',
    );
  } finally {
    cleanup(tmpDir);
  }
});

test('MANIFEST-SPEC-02: a claude manifest lists exactly the three sets it listed before', () => {
  const tmpDir = fs.mkdtempSync(path.join(BASE_TMPDIR, 'gsd-manifest-spec-02-'));
  try {
    assert.strictEqual(runInstallIn(tmpDir, 'claude').status, 0);
    const target = path.join(tmpDir, '.claude');
    const manifest = readManifest(target);

    const prefixes = ['gsd-ng/', 'commands/gsd/', 'agents/gsd-'];
    const stray = Object.keys(manifest.files).filter(
      (k) => !prefixes.some((p) => k.startsWith(p)),
    );
    assert.deepStrictEqual(
      stray,
      [],
      'the claude manifest key set must not grow (MANIFEST-SPEC-02)',
    );
    for (const prefix of prefixes) {
      assert.ok(
        Object.keys(manifest.files).some((k) => k.startsWith(prefix)),
        `the claude manifest must still cover ${prefix} (MANIFEST-SPEC-02)`,
      );
    }
    for (const key of Object.keys(manifest.files_normalized)) {
      assert.ok(
        key.startsWith('agents/'),
        `only agent files carry a normalised hash (MANIFEST-SPEC-02): ${key}`,
      );
    }
  } finally {
    cleanup(tmpDir);
  }
});

test('MANIFEST-SPEC-03: a locally modified copilot skill is backed up on reinstall', () => {
  const tmpDir = fs.mkdtempSync(path.join(BASE_TMPDIR, 'gsd-manifest-spec-03-'));
  try {
    assert.strictEqual(runInstallIn(tmpDir, 'copilot').status, 0);
    const target = path.join(tmpDir, '.github');
    const skillName = fs
      .readdirSync(path.join(target, 'skills'), { withFileTypes: true })
      .filter((e) => e.isDirectory() && e.name.startsWith('gsd-'))
      .map((e) => e.name)
      .sort()[0];
    const rel = `skills/${skillName}/SKILL.md`;
    const edited =
      fs.readFileSync(path.join(target, rel), 'utf8') + '\nuser edit\n';
    fs.writeFileSync(path.join(target, rel), edited);

    const r = runInstallIn(tmpDir, 'copilot');
    assert.strictEqual(
      r.status,
      0,
      'reinstall must exit 0 (MANIFEST-SPEC-03)\nstderr: ' + (r.stderr || ''),
    );

    const backup = path.join(target, 'gsd-local-patches', rel);
    assert.ok(
      fs.existsSync(backup),
      'an edited skill must be backed up before it is overwritten (MANIFEST-SPEC-03): ' +
        backup,
    );
    assert.strictEqual(
      fs.readFileSync(backup, 'utf8'),
      edited,
      'the backup must hold the user bytes (MANIFEST-SPEC-03)',
    );
  } finally {
    cleanup(tmpDir);
  }
});

// ── converters are reached by key, and the post-pass reaches nested dirs ─────

test('CONVERTER-01: every converter a layout names is registered', () => {
  const { CONVERTERS, converterFor } = require('../bin/install.js');

  for (const key of ['identity', 'copilotCommand', 'copilotAgent']) {
    assert.strictEqual(
      typeof CONVERTERS[key],
      'function',
      `CONVERTERS must hold a writer for '${key}' (CONVERTER-01)`,
    );
    assert.strictEqual(converterFor(key), CONVERTERS[key]);
  }

  // Registered by the runtimes whose converters have landed. A key a registry
  // row names but nothing implements must stop the install rather than write
  // another runtime's paths and tool names into the tree unconverted.
  assert.throws(
    () => converterFor('nosuchConverter'),
    /nosuchConverter/,
    'an unregistered converter key must fail loudly and name itself (CONVERTER-01)',
  );
});

test('POSTPASS-01: the template post-pass resolves a variable in a nested directory', () => {
  const { resolveTemplateDir } = require('../bin/install.js');
  const {
    buildContext,
    RUNTIMES,
  } = require('../gsd-ng/bin/lib/template-processor.cjs');

  const tmpDir = fs.mkdtempSync(path.join(BASE_TMPDIR, 'gsd-postpass-01-'));
  try {
    const nested = path.join(tmpDir, 'templates', 'codebase', 'deeper');
    fs.mkdirSync(nested, { recursive: true });
    const top = path.join(tmpDir, 'templates', 'top.md');
    const deep = path.join(nested, 'nested.md');
    const skipped = path.join(nested, 'notes.txt');
    fs.writeFileSync(top, 'rules: {{PROJECT_RULES_FILE}}\n');
    fs.writeFileSync(deep, 'rules: {{PROJECT_RULES_FILE}}\n');
    fs.writeFileSync(skipped, 'rules: {{PROJECT_RULES_FILE}}\n');

    resolveTemplateDir(path.join(tmpDir, 'templates'), buildContext('claude'));

    const expected = `rules: ${RUNTIMES.claude.PROJECT_RULES_FILE}\n`;
    assert.strictEqual(fs.readFileSync(top, 'utf8'), expected);
    assert.strictEqual(
      fs.readFileSync(deep, 'utf8'),
      expected,
      'a variable in a nested directory must be resolved (POSTPASS-01)',
    );
    assert.strictEqual(
      fs.readFileSync(skipped, 'utf8'),
      'rules: {{PROJECT_RULES_FILE}}\n',
      'the extension filter must still hold (POSTPASS-01)',
    );
  } finally {
    cleanup(tmpDir);
  }
});

test('POSTPASS-02: a file with unbalanced markers is left as it was', () => {
  const { resolveTemplateDir } = require('../bin/install.js');
  const { buildContext } = require('../gsd-ng/bin/lib/template-processor.cjs');

  const tmpDir = fs.mkdtempSync(path.join(BASE_TMPDIR, 'gsd-postpass-02-'));
  try {
    const doc = path.join(tmpDir, 'doc.md');
    const original = 'example: <!-- ONLY:claude --> {{RUNTIME_LABEL}}\n';
    fs.writeFileSync(doc, original);

    resolveTemplateDir(tmpDir, buildContext('claude'));

    assert.strictEqual(
      fs.readFileSync(doc, 'utf8'),
      original,
      'documentation quoting the marker syntax is not a template (POSTPASS-02)',
    );
  } finally {
    cleanup(tmpDir);
  }
});

// ── the installer dispatches on the registry, not on runtime names ───────────

/**
 * Functions that run for every runtime and must therefore take their behaviour
 * from the RUNTIMES registry. A runtime-name comparison inside one of them is a
 * branch that the next runtime has to be threaded through by hand, which is the
 * shape this lint exists to keep out.
 */
const DISPATCH_SCOPED_FUNCTIONS = [
  'install',
  'removeGsdFiles',
  'uninstall',
  'getDirName',
  'getConfigDirFromHome',
  'getGlobalDir',
  'getRuntimeLabel',
];

/** The forms a runtime-name dispatch takes in this file. */
const DISPATCH_PATTERNS = [
  { label: "=== 'claude'", re: /===\s*['"]claude['"]/g },
  { label: "=== 'copilot'", re: /===\s*['"]copilot['"]/g },
  { label: "=== 'opencode'", re: /===\s*['"]opencode['"]/g },
  { label: "!== 'claude'", re: /!==\s*['"]claude['"]/g },
  { label: 'isClaudeCode', re: /\bisClaudeCode\b/g },
  { label: 'isClaude', re: /\bisClaude\b/g },
];

/**
 * The number of runtime-name comparisons the scoped functions are allowed to
 * still contain.
 *
 * The target is zero. This constant only ever decreases: every survivor needs a
 * reason recorded alongside the change that leaves it in, so raising it is a
 * decision someone makes deliberately rather than a way to make the lint quiet.
 */
const ALLOWED_DISPATCH_COMPARISONS = 0;

/** Advance past a single- or double-quoted string starting at `i`. */
function skipQuotedString(src, i, quote) {
  i++;
  while (i < src.length) {
    const c = src[i];
    if (c === '\\') {
      i += 2;
      continue;
    }
    if (c === quote || c === '\n') return i + 1;
    i++;
  }
  return i;
}

/** Advance past a template literal, including any `${...}` expression parts. */
function skipTemplateLiteral(src, i) {
  i++;
  while (i < src.length) {
    const c = src[i];
    if (c === '\\') {
      i += 2;
      continue;
    }
    if (c === '`') return i + 1;
    if (c === '$' && src[i + 1] === '{') {
      i += 2;
      let depth = 1;
      while (i < src.length && depth > 0) {
        const e = src[i];
        if (e === '\\') {
          i += 2;
          continue;
        }
        if (e === "'" || e === '"') {
          i = skipQuotedString(src, i, e);
          continue;
        }
        if (e === '`') {
          i = skipTemplateLiteral(src, i);
          continue;
        }
        if (e === '{') depth++;
        else if (e === '}') depth--;
        i++;
      }
      continue;
    }
    i++;
  }
  return i;
}

/**
 * The body of a top-level `function <name>(...)`, found by matching braces from
 * its opening one. Comments and string literals are skipped, so a brace inside
 * either cannot stretch the body past the function's real end. A line range
 * would rot on the next edit above it; brace matching does not.
 *
 * @returns {{start: number, end: number, text: string}|null}
 */
function extractFunctionBody(source, name) {
  const start = source.search(
    new RegExp('^function\\s+' + name + '\\s*\\(', 'm'),
  );
  if (start === -1) return null;
  const open = source.indexOf('{', start);
  if (open === -1) return null;

  let depth = 0;
  let i = open;
  while (i < source.length) {
    const c = source[i];
    const n = source[i + 1];
    if (c === '/' && n === '/') {
      const nl = source.indexOf('\n', i);
      i = nl === -1 ? source.length : nl;
      continue;
    }
    if (c === '/' && n === '*') {
      const end = source.indexOf('*/', i + 2);
      i = end === -1 ? source.length : end + 2;
      continue;
    }
    if (c === "'" || c === '"') {
      i = skipQuotedString(source, i, c);
      continue;
    }
    if (c === '`') {
      i = skipTemplateLiteral(source, i);
      continue;
    }
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) {
        return { start: open, end: i + 1, text: source.slice(open, i + 1) };
      }
    }
    i++;
  }
  return null;
}

function lineNumberAt(source, index) {
  let line = 1;
  for (let i = 0; i < index; i++) if (source[i] === '\n') line++;
  return line;
}

/**
 * Every runtime-name comparison inside the scoped functions, each with the file
 * and line it sits on so a survivor can be named rather than only counted.
 *
 * @returns {Array<{fn: string, label: string, line: number, where: string}>}
 */
function findDispatchComparisons(source, file) {
  const found = [];
  for (const name of DISPATCH_SCOPED_FUNCTIONS) {
    const body = extractFunctionBody(source, name);
    if (!body) continue;
    for (const { label, re } of DISPATCH_PATTERNS) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(body.text)) !== null) {
        const line = lineNumberAt(source, body.start + m.index);
        found.push({ fn: name, label, line, where: `${file}:${line}` });
      }
    }
  }
  return found.sort((a, b) => a.line - b.line);
}

test('DISPATCH-02: the detector reports a runtime-name comparison inside a scoped function', () => {
  const synthetic = [
    'function install(isGlobal) {',
    "  if (runtime === 'claude') {",
    '    return 1;',
    '  }',
    '  return 0;',
    '}',
  ].join('\n');

  const found = findDispatchComparisons(synthetic, 'synthetic.js');
  assert.deepStrictEqual(
    found.map((f) => `${f.where}: ${f.label}`),
    ["synthetic.js:2: === 'claude'"],
    'the detector must report the comparison with its line number (DISPATCH-02)',
  );
});

test('DISPATCH-03: the detector reports nothing for matches outside the scoped functions', () => {
  const synthetic = [
    "// dispatching on runtime === 'claude' is what this lint forbids",
    'const label = "runtime === \'claude\'";',
    'function getDirName(rt) {',
    '  return `${rt} has an unbalanced { in a template literal`;',
    '}',
    'function helper(rt) {',
    "  return rt === 'claude';",
    '}',
  ].join('\n');

  assert.deepStrictEqual(
    findDispatchComparisons(synthetic, 'synthetic.js'),
    [],
    'a comment, a string, and an unscoped function are all out of scope, and a ' +
      'brace inside a string must not stretch a scoped body past its end ' +
      '(DISPATCH-03)',
  );
});

test('DISPATCH-01: install.js dispatches on the layout spec, not on runtime names', () => {
  const source = fs.readFileSync(INSTALLER, 'utf8');

  for (const name of DISPATCH_SCOPED_FUNCTIONS) {
    assert.ok(
      extractFunctionBody(source, name) !== null,
      `the lint must still find function ${name}() in bin/install.js — if it ` +
        'was renamed, rename it in DISPATCH_SCOPED_FUNCTIONS too (DISPATCH-01)',
    );
  }

  const found = findDispatchComparisons(source, 'bin/install.js');
  assert.strictEqual(
    found.length,
    ALLOWED_DISPATCH_COMPARISONS,
    `DISPATCH-01: ${found.length} runtime-name comparison(s) in bin/install.js, ` +
      `${ALLOWED_DISPATCH_COMPARISONS} allowed:\n` +
      found.map((f) => `  ${f.where}: ${f.label}  (in ${f.fn}())`).join('\n') +
      '\nRead the behaviour off RUNTIMES[rt] instead. Raising ' +
      'ALLOWED_DISPATCH_COMPARISONS needs a recorded reason for each survivor.',
  );
});

// ── opencode command conversion ──────────────────────────────────────────────

/**
 * The frontmatter keys OpenCode's command struct declares. `name` is injected
 * by the loader from the file path, so it is not among them; everything GSD's
 * own command frontmatter carries beyond this set has no home in that struct.
 */
const OPENCODE_COMMAND_SCHEMA_KEYS = new Set([
  'description',
  'agent',
  'model',
  'variant',
  'subtask',
  'template',
]);

const COMMAND_SOURCE_DIR = path.join(__dirname, '..', 'commands', 'gsd');

/** Top-level frontmatter keys of a converted .md file, in file order. */
function frontmatterKeysOf(text) {
  const match = text.match(/^---\n([\s\S]*?)\n---\n/);
  if (!match) return [];
  return match[1]
    .split('\n')
    .filter((line) => /^[A-Za-z0-9_-]+:/.test(line))
    .map((line) => line.slice(0, line.indexOf(':')));
}

function runOpencodeInstall(tmpDir, scope) {
  return spawnSync(
    process.execPath,
    [
      INSTALLER,
      '--runtime',
      'opencode',
      scope === 'global' ? '--global' : '--local',
      '--no-seed-permissions-config',
      '--no-seed-sandbox-config',
    ],
    {
      encoding: 'utf8',
      timeout: 60000,
      cwd: tmpDir,
      env: Object.assign({}, process.env, {
        HOME: tmpDir,
        OPENCODE_CONFIG_DIR: path.join(tmpDir, 'cfg-opencode'),
      }),
    },
  );
}

/** Install for opencode and return the directory it landed in. */
function installOpencode(tmpDir, scope) {
  const result = runOpencodeInstall(tmpDir, scope);
  assert.strictEqual(
    result.status,
    0,
    `opencode ${scope} install must exit 0\n` +
      `stderr: ${result.stderr || ''}\nstdout: ${result.stdout || ''}`,
  );
  return scope === 'global'
    ? path.join(tmpDir, 'cfg-opencode')
    : path.join(tmpDir, '.opencode');
}

function installedCommandFiles(targetDir) {
  const dir = path.join(targetDir, 'command');
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.startsWith('gsd-') && f.endsWith('.md'))
    .sort();
}

test('OPENCODE-CMD-01: an opencode install writes one flat command file per source command except set-profile', () => {
  const tmpDir = fs.mkdtempSync(path.join(BASE_TMPDIR, 'gsd-oc-cmd-01-'));
  try {
    const targetDir = installOpencode(tmpDir, 'local');
    const sources = fs
      .readdirSync(COMMAND_SOURCE_DIR)
      .filter((f) => f.endsWith('.md'));
    const installed = installedCommandFiles(targetDir);

    assert.strictEqual(
      sources.length,
      41,
      'the source command count changed — update the expected installed count with it (OPENCODE-CMD-01)',
    );
    assert.strictEqual(
      installed.length,
      40,
      'an opencode install must write 40 command files, one per source command ' +
        'except the Claude-only set-profile (OPENCODE-CMD-01)\nInstalled: ' +
        installed.join(', '),
    );
    assert.ok(
      !fs.existsSync(path.join(targetDir, 'command', 'gsd')),
      'the opencode command layout is flat — no command/gsd/ directory (OPENCODE-CMD-01)',
    );
  } finally {
    cleanup(tmpDir);
  }
});

test('OPENCODE-CMD-02: set-profile is not installed for opencode', () => {
  const tmpDir = fs.mkdtempSync(path.join(BASE_TMPDIR, 'gsd-oc-cmd-02-'));
  try {
    const targetDir = installOpencode(tmpDir, 'local');
    assert.ok(
      !fs.existsSync(path.join(targetDir, 'command', 'gsd-set-profile.md')),
      'set-profile configures effort frontmatter and model profiles, both ' +
        'Claude-only — it must not reach an opencode install (OPENCODE-CMD-02)',
    );
  } finally {
    cleanup(tmpDir);
  }
});

test('OPENCODE-CMD-03: every converted command carries only keys the opencode command schema declares', () => {
  const tmpDir = fs.mkdtempSync(path.join(BASE_TMPDIR, 'gsd-oc-cmd-03-'));
  try {
    const targetDir = installOpencode(tmpDir, 'local');
    const files = installedCommandFiles(targetDir);
    assert.ok(files.length > 0, 'no converted command files to inspect');

    const offenders = [];
    const withAllowedTools = [];
    const withArgumentHint = [];
    for (const file of files) {
      const text = fs.readFileSync(path.join(targetDir, 'command', file), 'utf8');
      for (const key of frontmatterKeysOf(text)) {
        if (!OPENCODE_COMMAND_SCHEMA_KEYS.has(key)) offenders.push(`${file}: ${key}`);
        if (key === 'allowed-tools') withAllowedTools.push(file);
        if (key === 'argument-hint') withArgumentHint.push(file);
      }
    }

    assert.deepStrictEqual(
      offenders,
      [],
      'a converted command must carry no frontmatter key outside the opencode ' +
        'command struct (OPENCODE-CMD-03)',
    );
    assert.deepStrictEqual(withAllowedTools, [], 'allowed-tools has no opencode equivalent (OPENCODE-CMD-03)');
    assert.deepStrictEqual(withArgumentHint, [], 'argument-hint has no opencode equivalent (OPENCODE-CMD-03)');
  } finally {
    cleanup(tmpDir);
  }
});

test('OPENCODE-CMD-04: a converted command keeps its description, its declared agent and its body syntax', () => {
  const tmpDir = fs.mkdtempSync(path.join(BASE_TMPDIR, 'gsd-oc-cmd-04-'));
  try {
    const targetDir = installOpencode(tmpDir, 'local');
    const read = (name) =>
      fs.readFileSync(path.join(targetDir, 'command', name), 'utf8');

    const planPhase = read('gsd-plan-phase.md');
    assert.deepStrictEqual(
      frontmatterKeysOf(planPhase),
      ['description', 'agent'],
      'a source naming an agent keeps description and agent, and nothing else (OPENCODE-CMD-04)',
    );
    assert.match(planPhase, /^agent: gsd-planner$/m);

    const progress = read('gsd-progress.md');
    assert.deepStrictEqual(
      frontmatterKeysOf(progress),
      ['description'],
      'a source naming no agent keeps description alone (OPENCODE-CMD-04)',
    );

    const addTests = read('gsd-add-tests.md');
    assert.ok(
      addTests.includes('$ARGUMENTS'),
      '$ARGUMENTS is native opencode syntax and must survive verbatim (OPENCODE-CMD-04)',
    );

    // The shell-run marker itself is native opencode syntax and survives; the
    // paths inside it are rewritten to the opencode tree like any other.
    const update = read('gsd-update.md');
    const sourceUpdate = fs.readFileSync(path.join(COMMAND_SOURCE_DIR, 'update.md'), 'utf8');
    const sourceRuns = sourceUpdate.match(/!`[^`]*`/g) || [];
    const convertedRuns = update.match(/!`[^`]*`/g) || [];
    assert.ok(sourceRuns.length > 0, 'the chosen source must contain a shell-run reference');
    assert.strictEqual(
      convertedRuns.length,
      sourceRuns.length,
      '!`…` shell-run syntax must survive conversion (OPENCODE-CMD-04)',
    );
    for (const run of convertedRuns) {
      assert.ok(
        !run.includes('.claude/'),
        `a shell-run reference must point at the opencode tree: ${run} (OPENCODE-CMD-04)`,
      );
    }
  } finally {
    cleanup(tmpDir);
  }
});

test('OPENCODE-CMD-05: {{COMMAND_PREFIX}} resolves to the opencode prefix in body and frontmatter', () => {
  const tmpDir = fs.mkdtempSync(path.join(BASE_TMPDIR, 'gsd-oc-cmd-05-'));
  try {
    const targetDir = installOpencode(tmpDir, 'local');

    // Uppercase braces are registry variables; lowercase ones like {{version}}
    // are placeholders the command's own prose fills in at run time.
    for (const file of installedCommandFiles(targetDir)) {
      const text = fs.readFileSync(path.join(targetDir, 'command', file), 'utf8');
      const unresolved = text.match(/\{\{[A-Z][A-Z0-9_]*\}\}/g) || [];
      assert.deepStrictEqual(
        unresolved,
        [],
        `no registry variable may survive into a converted command: ${file} (OPENCODE-CMD-05)`,
      );
    }

    const mapCodebase = fs.readFileSync(
      path.join(targetDir, 'command', 'gsd-map-codebase.md'),
      'utf8',
    );
    assert.ok(
      mapCodebase.includes('/gsd-new-project'),
      '{{COMMAND_PREFIX}} must resolve to /gsd- in a converted body (OPENCODE-CMD-05)',
    );

    const research = fs.readFileSync(
      path.join(targetDir, 'command', 'gsd-research-phase.md'),
      'utf8',
    );
    assert.match(
      research,
      /^description: .*\/gsd-plan-phase/m,
      'a {{COMMAND_PREFIX}} inside frontmatter must resolve too (OPENCODE-CMD-05)',
    );
  } finally {
    cleanup(tmpDir);
  }
});

test('OPENCODE-CMD-06: @ references resolve without shell expansion in both scopes', () => {
  const localTmp = fs.mkdtempSync(path.join(BASE_TMPDIR, 'gsd-oc-cmd-06a-'));
  const globalTmp = fs.mkdtempSync(path.join(BASE_TMPDIR, 'gsd-oc-cmd-06b-'));
  try {
    const localDir = installOpencode(localTmp, 'local');
    const localProgress = fs.readFileSync(
      path.join(localDir, 'command', 'gsd-progress.md'),
      'utf8',
    );
    assert.ok(
      localProgress.includes('@.opencode/gsd-ng/workflows/progress.md'),
      'a local install references the workflow by project-relative path (OPENCODE-CMD-06)',
    );

    const globalDir = installOpencode(globalTmp, 'global');
    const globalProgress = fs.readFileSync(
      path.join(globalDir, 'command', 'gsd-progress.md'),
      'utf8',
    );
    assert.ok(
      globalProgress.includes('@' + path.join(globalDir, 'gsd-ng/workflows/progress.md')),
      'a global install references the workflow by resolved absolute path, since ' +
        'whether opencode expands ~ or $HOME inside an @ reference is unverified ' +
        '(OPENCODE-CMD-06)\nActual: ' +
        (globalProgress.match(/@\S*workflows\/progress\.md/) || ['none'])[0],
    );
    assert.ok(
      !/@~\//.test(globalProgress),
      'no tilde-prefixed @ reference may survive a global install (OPENCODE-CMD-06)',
    );
  } finally {
    cleanup(localTmp);
    cleanup(globalTmp);
  }
});

// ── opencode agent conversion ────────────────────────────────────────────────

const {
  convertClaudeAgentToOpencodeAgent,
  convertClaudeAgentToCopilotAgent,
} = require('../bin/install.js');

/** The seven colour literals opencode's agent schema accepts, written out. */
const OPENCODE_COLOR_LITERALS = [
  'primary',
  'secondary',
  'accent',
  'success',
  'warning',
  'error',
  'info',
];

const SAMPLE_TOOLS = ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep'];

function syntheticAgent(toolsLines, color = 'cyan') {
  return [
    '---',
    'name: gsd-sample',
    'description: A sample agent',
    ...toolsLines,
    'color: ' + color,
    '---',
    'Body text.',
    '',
  ].join('\n');
}

const INLINE_TOOLS_AGENT = syntheticAgent(['tools: ' + SAMPLE_TOOLS.join(', ')]);
const BLOCK_TOOLS_AGENT = syntheticAgent([
  'tools:',
  ...SAMPLE_TOOLS.map((t) => '  - ' + t),
]);

/** The `permission:` block of a converted agent, fences included. */
function permissionBlockOf(text) {
  const match = text.match(/^permission:\n(?:[ \t]+[a-z]+: [a-z]+\n)+/m);
  return match ? match[0] : null;
}

function installedAgentFiles(targetDir) {
  const dir = path.join(targetDir, 'agent');
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.startsWith('gsd-') && f.endsWith('.md'))
    .sort();
}

test('OPENCODE-AGT-01: every source agent installs as a subagent', () => {
  const tmpDir = fs.mkdtempSync(path.join(BASE_TMPDIR, 'gsd-oc-agt-01-'));
  try {
    const targetDir = installOpencode(tmpDir, 'local');
    const sources = fs
      .readdirSync(path.join(__dirname, '..', 'agents'))
      .filter((f) => f.startsWith('gsd-') && f.endsWith('.md'));
    const installed = installedAgentFiles(targetDir);

    assert.strictEqual(sources.length, 15, 'the source agent count changed (OPENCODE-AGT-01)');
    assert.strictEqual(
      installed.length,
      15,
      'an opencode install must write one agent file per source agent (OPENCODE-AGT-01)\n' +
        'Installed: ' +
        installed.join(', '),
    );

    const missingMode = [];
    for (const file of installed) {
      const text = fs.readFileSync(path.join(targetDir, 'agent', file), 'utf8');
      if (!/^mode: subagent$/m.test(text)) missingMode.push(file);
    }
    assert.deepStrictEqual(
      missingMode,
      [],
      'every converted agent must declare mode: subagent (OPENCODE-AGT-01)',
    );
  } finally {
    cleanup(tmpDir);
  }
});

test('OPENCODE-AGT-02: a tools block list converts to the same permission map as the inline form', () => {
  const fromInline = convertClaudeAgentToOpencodeAgent(INLINE_TOOLS_AGENT, false);
  const fromBlock = convertClaudeAgentToOpencodeAgent(BLOCK_TOOLS_AGENT, false);

  const inlineBlock = permissionBlockOf(fromInline);
  assert.ok(inlineBlock, 'the inline form must produce a permission block (OPENCODE-AGT-02)');
  assert.strictEqual(
    permissionBlockOf(fromBlock),
    inlineBlock,
    'both YAML forms of tools: must produce the identical permission map (OPENCODE-AGT-02)',
  );
  assert.strictEqual(
    fromBlock,
    fromInline,
    'the two forms describe the same agent and must convert identically (OPENCODE-AGT-02)',
  );
});

test('OPENCODE-AGT-03: the copilot converter reads the block-list form too', () => {
  const fromInline = convertClaudeAgentToCopilotAgent(INLINE_TOOLS_AGENT, false);
  const fromBlock = convertClaudeAgentToCopilotAgent(BLOCK_TOOLS_AGENT, false);

  assert.match(
    fromInline,
    /^tools: \[/m,
    'the inline form must convert to a JSON array (OPENCODE-AGT-03)',
  );
  assert.strictEqual(
    fromBlock,
    fromInline,
    'a block-list tools: must not reach copilot unconverted (OPENCODE-AGT-03)',
  );
});

test('OPENCODE-AGT-04: each Claude tool name maps to its opencode permission id', () => {
  const expectations = [
    ['Read', 'read'],
    ['Write', 'write'],
    ['Edit', 'edit'],
    ['Bash', 'bash'],
    ['Glob', 'glob'],
    ['Grep', 'grep'],
    ['WebFetch', 'webfetch'],
    ['WebSearch', 'websearch'],
    ['TodoWrite', 'todowrite'],
    ['AskUserQuestion', 'question'],
    ['Task', 'task'],
    ['Agent', 'task'],
  ];

  for (const [claudeName, opencodeId] of expectations) {
    const converted = convertClaudeAgentToOpencodeAgent(
      syntheticAgent(['tools: ' + claudeName]),
      false,
    );
    assert.strictEqual(
      permissionBlockOf(converted),
      'permission:\n  ' + opencodeId + ': allow\n',
      `${claudeName} must map to ${opencodeId} (OPENCODE-AGT-04)`,
    );
  }

  const deduped = convertClaudeAgentToOpencodeAgent(
    syntheticAgent(['tools: Task, Agent']),
    false,
  );
  assert.strictEqual(
    permissionBlockOf(deduped),
    'permission:\n  task: allow\n',
    'Task and Agent name the same opencode tool and must not be emitted twice (OPENCODE-AGT-04)',
  );
});

test('OPENCODE-AGT-05: a tool with no opencode equivalent is dropped, not passed through', () => {
  const converted = convertClaudeAgentToOpencodeAgent(
    syntheticAgent(['tools: Read, SlashCommand, mcp__context7__resolve-library-id']),
    false,
  );
  assert.strictEqual(
    permissionBlockOf(converted),
    'permission:\n  read: allow\n',
    'SlashCommand and an mcp__ tool have no opencode id and must be dropped (OPENCODE-AGT-05)',
  );
});

test('OPENCODE-AGT-06: no mcp__ tool name reaches a converted agent file', () => {
  const tmpDir = fs.mkdtempSync(path.join(BASE_TMPDIR, 'gsd-oc-agt-06-'));
  try {
    const targetDir = installOpencode(tmpDir, 'local');
    const offenders = [];
    for (const file of installedAgentFiles(targetDir)) {
      const text = fs.readFileSync(path.join(targetDir, 'agent', file), 'utf8');
      const frontmatter = (text.match(/^---\n([\s\S]*?)\n---\n/) || ['', ''])[1];
      if (frontmatter.includes('mcp__')) offenders.push(file);
    }
    assert.deepStrictEqual(
      offenders,
      [],
      'an mcp__ name has no static opencode equivalent and must not be emitted (OPENCODE-AGT-06)',
    );
  } finally {
    cleanup(tmpDir);
  }
});

test('OPENCODE-AGT-07: the colour map translates every word colour the source agents use', () => {
  assert.deepStrictEqual(RUNTIMES.opencode.COLOR_MAP, {
    cyan: 'info',
    green: 'success',
    purple: 'accent',
    blue: 'primary',
    orange: 'warning',
    yellow: 'secondary',
  });

  for (const literal of Object.values(RUNTIMES.opencode.COLOR_MAP)) {
    assert.ok(
      OPENCODE_COLOR_LITERALS.includes(literal),
      `${literal} is not one of opencode's seven colour literals (OPENCODE-AGT-07)`,
    );
  }
});

test('OPENCODE-AGT-08: a quoted hex colour survives and an unknown one falls back to a valid literal', () => {
  const hex = convertClaudeAgentToOpencodeAgent(
    syntheticAgent(['tools: Read'], '"#8B5CF6"'),
    false,
  );
  assert.match(
    hex,
    /^color: "#8B5CF6"$/m,
    'a hex colour must stay quoted — an unquoted # opens a YAML comment (OPENCODE-AGT-08)',
  );

  const unknown = convertClaudeAgentToOpencodeAgent(
    syntheticAgent(['tools: Read'], 'chartreuse'),
    false,
  );
  assert.match(
    unknown,
    /^color: info$/m,
    'a colour that is neither hex nor mapped must fall back to a valid literal (OPENCODE-AGT-08)',
  );
});

test('OPENCODE-AGT-09: a converted agent drops name: and keeps effort:', () => {
  const withEffort = [
    '---',
    'name: gsd-sample',
    'description: A sample agent',
    'tools: Read',
    'color: cyan',
    'effort: high',
    '---',
    'Body text.',
    '',
  ].join('\n');

  const converted = convertClaudeAgentToOpencodeAgent(withEffort, false);
  assert.ok(
    !/^name:/m.test(converted),
    'opencode injects the agent name from the file path (OPENCODE-AGT-09)',
  );
  assert.match(converted, /^effort: high$/m, 'effort: must survive for the effort sync (OPENCODE-AGT-09)');
  assert.match(converted, /^description: A sample agent$/m);
});

// ── the plugin and the payload it spawns ─────────────────────────────────────

/** The hook scripts the plugin's spawn target needs beside it. */
const OPENCODE_PAYLOAD_FILES = [
  'bash-safety-hook.cjs',
  'gsd-hook-stdin.cjs',
  'gsd-check-update.js',
];

test('OPENCODE-PLUG-01: an opencode install writes plugin/gsd-core.js from the plugin source', () => {
  const tmpDir = fs.mkdtempSync(path.join(BASE_TMPDIR, 'gsd-oc-plug-01-'));
  try {
    const targetDir = installOpencode(tmpDir, 'local');
    const installed = path.join(targetDir, 'plugin', 'gsd-core.js');
    assert.ok(
      fs.existsSync(installed),
      'opencode loads plugins from plugin/*.js — gsd-core.js must be there (OPENCODE-PLUG-01)',
    );
    const source = fs.readFileSync(
      path.join(__dirname, '..', 'hooks', 'gsd-opencode-plugin.js'),
      'utf8',
    );
    assert.strictEqual(
      fs.readFileSync(installed, 'utf8'),
      source,
      'the installed plugin must be the plugin source verbatim (OPENCODE-PLUG-01)',
    );
  } finally {
    cleanup(tmpDir);
  }
});

test('OPENCODE-PLUG-02: the hook payload the plugin depends on lands in the engine tree', () => {
  const tmpDir = fs.mkdtempSync(path.join(BASE_TMPDIR, 'gsd-oc-plug-02-'));
  try {
    const targetDir = installOpencode(tmpDir, 'local');
    for (const name of OPENCODE_PAYLOAD_FILES) {
      assert.ok(
        fs.existsSync(path.join(targetDir, 'gsd-ng', 'hooks', name)),
        `gsd-ng/hooks/${name} must exist after an opencode install (OPENCODE-PLUG-02)`,
      );
    }
    // gsd-check-update.js resolves its cache-path module at ../bin/lib/, which
    // only lands inside the engine copy when the payload sits under it.
    assert.ok(
      fs.existsSync(
        path.join(targetDir, 'gsd-ng', 'bin', 'lib', 'cache-path.cjs'),
      ),
      "the payload's first module-resolution candidate must exist (OPENCODE-PLUG-02)",
    );
  } finally {
    cleanup(tmpDir);
  }
});

test('OPENCODE-PLUG-03: the spawn path the plugin computes for itself resolves to a file', () => {
  const tmpDir = fs.mkdtempSync(path.join(BASE_TMPDIR, 'gsd-oc-plug-03-'));
  try {
    const targetDir = installOpencode(tmpDir, 'local');
    // Computed exactly as the plugin computes it: from its own directory, up to
    // the config home, then into the engine tree. Two correct-looking halves
    // that do not meet is the copilot defect this asserts against.
    const pluginDir = path.join(targetDir, 'plugin');
    const spawnTarget = path.join(
      pluginDir,
      '..',
      'gsd-ng',
      'hooks',
      'gsd-check-update.js',
    );
    assert.ok(
      fs.existsSync(spawnTarget),
      `the plugin's spawn target must exist: ${spawnTarget} (OPENCODE-PLUG-03)`,
    );
  } finally {
    cleanup(tmpDir);
  }
});

test('OPENCODE-PLUG-04: no CommonJS marker lands in an opencode tree', () => {
  const tmpDir = fs.mkdtempSync(path.join(BASE_TMPDIR, 'gsd-oc-plug-04-'));
  try {
    const targetDir = installOpencode(tmpDir, 'local');
    const markerPath = path.join(targetDir, 'package.json');
    if (fs.existsSync(markerPath)) {
      const marker = fs.readFileSync(markerPath, 'utf8');
      assert.ok(
        !/"type"\s*:\s*"commonjs"/.test(marker),
        'a .js plugin under a commonjs package.json is parsed as CommonJS, ' +
          "where `export` is a syntax error (OPENCODE-PLUG-04)",
      );
    }
  } finally {
    cleanup(tmpDir);
  }
});

test('OPENCODE-PLUG-05: plugin/ holds exactly one GSD file', () => {
  const tmpDir = fs.mkdtempSync(path.join(BASE_TMPDIR, 'gsd-oc-plug-05-'));
  try {
    const targetDir = installOpencode(tmpDir, 'local');
    // The plugin glob is flat, so anything else GSD dropped here would be
    // loaded as a plugin in its own right.
    assert.deepStrictEqual(
      fs.readdirSync(path.join(targetDir, 'plugin')).sort(),
      ['gsd-core.js'],
      'GSD must write one plugin file and nothing else (OPENCODE-PLUG-05)',
    );
  } finally {
    cleanup(tmpDir);
  }
});

test('OPENCODE-PLUG-06: uninstall removes gsd-core.js and leaves a user plugin alone', () => {
  const tmpDir = fs.mkdtempSync(path.join(BASE_TMPDIR, 'gsd-oc-plug-06-'));
  try {
    const targetDir = installOpencode(tmpDir, 'local');
    const userPlugin = path.join(targetDir, 'plugin', 'mine.js');
    fs.writeFileSync(userPlugin, 'export default async () => ({});\n');

    const result = spawnSync(
      process.execPath,
      [INSTALLER, '--runtime', 'opencode', '--local', '--uninstall'],
      {
        encoding: 'utf8',
        timeout: 60000,
        cwd: tmpDir,
        env: Object.assign({}, process.env, { HOME: tmpDir }),
      },
    );
    assert.strictEqual(
      result.status,
      0,
      'opencode uninstall must exit 0 (OPENCODE-PLUG-06)\nstderr: ' +
        (result.stderr || ''),
    );

    assert.ok(
      !fs.existsSync(path.join(targetDir, 'plugin', 'gsd-core.js')),
      'the GSD plugin must be removed (OPENCODE-PLUG-06)',
    );
    assert.ok(
      fs.existsSync(userPlugin),
      'a user-authored plugin must survive uninstall (OPENCODE-PLUG-06)',
    );
  } finally {
    cleanup(tmpDir);
  }
});

test('OPENCODE-PLUG-07: the manifest records the plugin filename', () => {
  const tmpDir = fs.mkdtempSync(path.join(BASE_TMPDIR, 'gsd-oc-plug-07-'));
  try {
    const targetDir = installOpencode(tmpDir, 'local');
    const manifest = JSON.parse(
      fs.readFileSync(path.join(targetDir, 'gsd-file-manifest.json'), 'utf8'),
    );
    assert.ok(
      manifest.installed_hooks.includes('gsd-core.js'),
      'a later release removes a renamed plugin from this record, not from a ' +
        'hardcoded list (OPENCODE-PLUG-07)',
    );
  } finally {
    cleanup(tmpDir);
  }
});

test('COPILOT-HOOKPATH-01: the script a copilot local install points its hook at exists', () => {
  const tmpDir = fs.mkdtempSync(path.join(BASE_TMPDIR, 'gsd-cp-hookpath-'));
  try {
    const result = spawnSync(
      process.execPath,
      [INSTALLER, '--runtime', 'copilot', '--local'],
      {
        encoding: 'utf8',
        timeout: 60000,
        cwd: tmpDir,
        env: Object.assign({}, process.env, { HOME: tmpDir }),
      },
    );
    assert.strictEqual(
      result.status,
      0,
      'copilot local install must exit 0 (COPILOT-HOOKPATH-01)\nstderr: ' +
        (result.stderr || ''),
    );

    const descriptor = JSON.parse(
      fs.readFileSync(
        path.join(tmpDir, '.github', 'hooks', 'gsd-hooks.json'),
        'utf8',
      ),
    );
    const bash = descriptor.hooks.sessionStart[0].bash;
    const named = bash.replace(/^node\s+/, '').trim();
    // cwd is '.', so the descriptor's path is resolved from the project root.
    assert.ok(
      fs.existsSync(path.join(tmpDir, named)),
      `the hook descriptor names a script that must exist: ${named} (COPILOT-HOOKPATH-01)`,
    );
    assert.ok(
      fs.existsSync(path.join(tmpDir, '.github', 'gsd-ng', 'hooks', 'gsd-hook-stdin.cjs')),
      'the update check requires the stdin reader beside it (COPILOT-HOOKPATH-01)',
    );
  } finally {
    cleanup(tmpDir);
  }
});

test('COPILOT-HOOKPATH-02: a copilot global install writes no hook payload it cannot run', () => {
  const tmpDir = fs.mkdtempSync(path.join(BASE_TMPDIR, 'gsd-cp-hookpath-g-'));
  try {
    const result = spawnSync(
      process.execPath,
      [INSTALLER, '--runtime', 'copilot', '--global'],
      {
        encoding: 'utf8',
        timeout: 60000,
        cwd: tmpDir,
        env: Object.assign({}, process.env, { HOME: tmpDir }),
      },
    );
    assert.strictEqual(
      result.status,
      0,
      'copilot global install must exit 0 (COPILOT-HOOKPATH-02)\nstderr: ' +
        (result.stderr || ''),
    );
    // Copilot supports no global hooks, so the descriptor is skipped — and the
    // payload it would have pointed at has no reason to be there either.
    assert.ok(
      !fs.existsSync(path.join(tmpDir, '.copilot', 'hooks', 'gsd-hooks.json')),
      'copilot has no global hook descriptor (COPILOT-HOOKPATH-02)',
    );
    assert.ok(
      !fs.existsSync(
        path.join(tmpDir, '.copilot', 'gsd-ng', 'hooks', 'gsd-check-update.js'),
      ),
      'no payload without a descriptor to run it (COPILOT-HOOKPATH-02)',
    );
  } finally {
    cleanup(tmpDir);
  }
});

// ── the project rules file: one merge, markers from the registry ─────────────

/**
 * A rules-file block is delimited by a matched pair of markers. The registry
 * carries both per runtime, so the merge and the strip read them from there
 * rather than from a constant naming one runtime's file.
 */
const {
  mergeProjectRules,
  stripProjectRules,
  rulesFilePath,
} = require('../bin/install.js');

const OC_OPEN = RUNTIMES.opencode.GSD_BLOCK_OPEN;
const OC_CLOSE = RUNTIMES.opencode.GSD_BLOCK_CLOSE;
const USER_PARAGRAPH =
  '# My Project\n\nThese are my own house rules. Do not touch them.\n';

/** Uninstall the given runtime from tmpDir, asserting a clean exit. */
function runUninstall(tmpDir, runtime, scope, label) {
  const result = spawnSync(
    process.execPath,
    [
      INSTALLER,
      '--runtime',
      runtime,
      scope === 'global' ? '--global' : '--local',
      '--uninstall',
    ],
    {
      encoding: 'utf8',
      timeout: 60000,
      cwd: tmpDir,
      env: Object.assign({}, process.env, {
        HOME: tmpDir,
        OPENCODE_CONFIG_DIR: path.join(tmpDir, 'cfg-opencode'),
      }),
    },
  );
  assert.strictEqual(
    result.status,
    0,
    `${runtime} ${scope} uninstall must exit 0 (${label})\nstderr: ${result.stderr || ''}`,
  );
  return result;
}

test('RULES-01: a pre-existing AGENTS.md keeps every user byte after an opencode install', () => {
  const tmpDir = fs.mkdtempSync(path.join(BASE_TMPDIR, 'gsd-rules-01-'));
  try {
    const agentsPath = path.join(tmpDir, 'AGENTS.md');
    fs.writeFileSync(agentsPath, USER_PARAGRAPH);

    installOpencode(tmpDir, 'local');

    const after = fs.readFileSync(agentsPath, 'utf8');
    assert.ok(
      after.startsWith(USER_PARAGRAPH),
      'AGENTS.md is a shared convention — the GSD block is strictly additive ' +
        `and appends after the user's content (RULES-01)\nGot:\n${after}`,
    );
    assert.ok(
      after.includes(OC_OPEN) && after.includes(OC_CLOSE),
      'the GSD block must be present after install (RULES-01)',
    );
  } finally {
    cleanup(tmpDir);
  }
});

test('RULES-02: installing opencode twice does not duplicate the GSD block', () => {
  const tmpDir = fs.mkdtempSync(path.join(BASE_TMPDIR, 'gsd-rules-02-'));
  try {
    const agentsPath = path.join(tmpDir, 'AGENTS.md');
    fs.writeFileSync(agentsPath, USER_PARAGRAPH);

    installOpencode(tmpDir, 'local');
    const first = fs.readFileSync(agentsPath, 'utf8');
    installOpencode(tmpDir, 'local');
    const second = fs.readFileSync(agentsPath, 'utf8');

    assert.strictEqual(
      second.split(OC_OPEN).length - 1,
      1,
      'the second install replaces the block between the markers rather than ' +
        `appending a second one (RULES-02)\nGot:\n${second}`,
    );
    assert.strictEqual(
      second,
      first,
      'a repeat install must be byte-stable (RULES-02)',
    );
  } finally {
    cleanup(tmpDir);
  }
});

test('RULES-03: uninstall strips the block and leaves the user content byte-identical', () => {
  const tmpDir = fs.mkdtempSync(path.join(BASE_TMPDIR, 'gsd-rules-03-'));
  try {
    const agentsPath = path.join(tmpDir, 'AGENTS.md');
    fs.writeFileSync(agentsPath, USER_PARAGRAPH);

    installOpencode(tmpDir, 'local');
    runUninstall(tmpDir, 'opencode', 'local', 'RULES-03');

    assert.ok(
      fs.existsSync(agentsPath),
      'a file that held user content must survive uninstall (RULES-03)',
    );
    assert.strictEqual(
      fs.readFileSync(agentsPath, 'utf8'),
      USER_PARAGRAPH,
      'every byte outside the markers is the user\'s (RULES-03)',
    );
  } finally {
    cleanup(tmpDir);
  }
});

test('RULES-04: uninstall deletes an AGENTS.md that held nothing but the GSD block', () => {
  const tmpDir = fs.mkdtempSync(path.join(BASE_TMPDIR, 'gsd-rules-04-'));
  try {
    const agentsPath = path.join(tmpDir, 'AGENTS.md');
    installOpencode(tmpDir, 'local');
    assert.ok(
      fs.existsSync(agentsPath),
      'the install must create AGENTS.md when none existed (RULES-04)',
    );

    runUninstall(tmpDir, 'opencode', 'local', 'RULES-04');

    assert.ok(
      !fs.existsSync(agentsPath),
      'GSD created the file and GSD was all it held, so it goes (RULES-04)',
    );
  } finally {
    cleanup(tmpDir);
  }
});

test('RULES-05: a global opencode install writes no project rules file, and its uninstall leaves a user-authored one alone', () => {
  const tmpDir = fs.mkdtempSync(path.join(BASE_TMPDIR, 'gsd-rules-05-'));
  try {
    const agentsPath = path.join(tmpDir, 'AGENTS.md');
    fs.writeFileSync(agentsPath, USER_PARAGRAPH);

    const targetDir = installOpencode(tmpDir, 'global');

    assert.strictEqual(
      fs.readFileSync(agentsPath, 'utf8'),
      USER_PARAGRAPH,
      'a global install has no project to merge into, so the file in the ' +
        'working directory is untouched (RULES-05)',
    );
    assert.ok(
      !fs.existsSync(path.join(targetDir, 'AGENTS.md')),
      'and it is not written into the config home either (RULES-05)',
    );

    runUninstall(tmpDir, 'opencode', 'global', 'RULES-05');

    assert.strictEqual(
      fs.readFileSync(agentsPath, 'utf8'),
      USER_PARAGRAPH,
      'the global install did not create it, so the global uninstall must not ' +
        'remove or rewrite it (RULES-05)',
    );
  } finally {
    cleanup(tmpDir);
  }
});

test('RULES-06: the merge refuses a runtime whose close marker is a prefix of its open marker', () => {
  const tmpDir = fs.mkdtempSync(path.join(BASE_TMPDIR, 'gsd-rules-06-'));
  try {
    const target = path.join(tmpDir, 'CLAUDE.md');
    fs.writeFileSync(target, USER_PARAGRAPH);

    // Claude's block close is the heading prefix '## ', which indexOf() finds
    // inside the open marker itself — a merge on it would corrupt the file.
    assert.throws(
      () =>
        mergeProjectRules(
          target,
          'block',
          RUNTIMES.claude.GSD_BLOCK_OPEN,
          RUNTIMES.claude.GSD_BLOCK_CLOSE,
        ),
      /not a delimiter pair/,
      'a prefix close marker must be refused, not merged on (RULES-06)',
    );
    assert.throws(
      () =>
        stripProjectRules(
          USER_PARAGRAPH,
          RUNTIMES.claude.GSD_BLOCK_OPEN,
          RUNTIMES.claude.GSD_BLOCK_CLOSE,
        ),
      /not a delimiter pair/,
      'the strip refuses the same pair for the same reason (RULES-06)',
    );
    assert.strictEqual(
      fs.readFileSync(target, 'utf8'),
      USER_PARAGRAPH,
      'the refused merge must not have written anything (RULES-06)',
    );
  } finally {
    cleanup(tmpDir);
  }
});

test('RULES-07: claude declares no rules file, so it never reaches the merge path', () => {
  assert.strictEqual(
    RUNTIMES.claude.layout.rulesFile,
    null,
    'the guard in RULES-06 is what a future rulesFile on claude would hit — ' +
      'today the layout keeps it off the path entirely (RULES-07)',
  );
  assert.strictEqual(
    rulesFilePath('claude', '/some/target'),
    null,
    'the resolver returns nothing for a runtime with no rules file (RULES-07)',
  );
});

test('RULES-08: install and uninstall resolve the rules file through the same resolver', () => {
  assert.strictEqual(
    rulesFilePath('copilot', '/target'),
    path.join('/target', 'copilot-instructions.md'),
    'copilot writes its rules file inside the install target (RULES-08)',
  );
  assert.strictEqual(
    rulesFilePath('opencode', '/target'),
    path.join(process.cwd(), 'AGENTS.md'),
    'opencode writes its rules file at the project root (RULES-08)',
  );
});

test('RULES-09: one template serves both runtimes through ONLY blocks', () => {
  const templatePath = path.join(
    __dirname,
    '..',
    'gsd-ng',
    'templates',
    'project-rules-block.md',
  );
  assert.ok(
    fs.existsSync(templatePath),
    'the rules-file block template is runtime-neutral and named for what it ' +
      'is (RULES-09)',
  );
  assert.ok(
    !fs.existsSync(
      path.join(__dirname, '..', 'gsd-ng', 'templates', 'copilot-instructions.md'),
    ),
    'the copilot-shaped template it replaced must be gone (RULES-09)',
  );

  const raw = fs.readFileSync(templatePath, 'utf8');
  assert.ok(raw.includes('ONLY:copilot'), 'copilot has its own surface (RULES-09)');
  assert.ok(raw.includes('ONLY:opencode'), 'so does opencode (RULES-09)');
});

test('RULES-10: an opencode install describes opencode surfaces, not copilot ones', () => {
  const tmpDir = fs.mkdtempSync(path.join(BASE_TMPDIR, 'gsd-rules-10-'));
  try {
    installOpencode(tmpDir, 'local');
    const content = fs.readFileSync(path.join(tmpDir, 'AGENTS.md'), 'utf8');

    for (const expected of ['command/gsd-', 'agent/gsd-', 'plugin/gsd-core.js', 'gsd-ng/workflows/']) {
      assert.ok(
        content.includes(expected),
        `the block must name ${expected} (RULES-10)\nGot:\n${content}`,
      );
    }
    assert.ok(
      !content.includes('skills/gsd-'),
      'copilot\'s skills directory has no meaning in opencode (RULES-10)',
    );
    assert.ok(
      !content.includes('ONLY:'),
      'the block is processed at merge time — no raw ONLY marker may ship into ' +
        `a user's rules file (RULES-10)\nGot:\n${content}`,
    );
    assert.ok(
      !/\{\{\w+\}\}/.test(content),
      'and no raw {{VAR}} either (RULES-10)',
    );
  } finally {
    cleanup(tmpDir);
  }
});

test('RULES-11: the copilot block text is unchanged by the template unification', () => {
  const tmpDir = fs.mkdtempSync(path.join(BASE_TMPDIR, 'gsd-rules-11-'));
  try {
    const result = spawnSync(
      process.execPath,
      [INSTALLER, '--runtime', 'copilot', '--local'],
      {
        encoding: 'utf8',
        timeout: 60000,
        cwd: tmpDir,
        env: Object.assign({}, process.env, { HOME: tmpDir }),
      },
    );
    assert.strictEqual(
      result.status,
      0,
      'copilot local install must exit 0 (RULES-11)\nstderr: ' + (result.stderr || ''),
    );

    const content = fs.readFileSync(
      path.join(tmpDir, '.github', 'copilot-instructions.md'),
      'utf8',
    );
    // The wording copilot shipped before the template was unified, verbatim.
    const expected =
      '<!-- GSD Configuration -->\n' +
      '# GSD-NG Configuration\n' +
      '\n' +
      'This project uses [GSD-NG](https://github.com/gsd-build/gsd-ng) for spec-driven development.\n' +
      '\n' +
      '## Skills\n' +
      '\n' +
      'GSD skills are available in the `skills/gsd-*/` directories. Use them by name (e.g., `gsd-new-project`, `gsd-plan-phase`).\n' +
      '\n' +
      '## Agents\n' +
      '\n' +
      'GSD agents are available in the `agents/` directory as `.agent.md` files.\n' +
      '\n' +
      '## Workflows\n' +
      '\n' +
      'The GSD workflow engine lives in `gsd-ng/workflows/`. Agents and skills reference these workflows automatically.\n' +
      '\n' +
      '## Important\n' +
      '\n' +
      '- Follow the workflow system — do not skip phases or bypass planning\n' +
      '- Use `gsd-ng/` for all GSD engine files\n' +
      '- The `.planning/` directory contains project state — read but do not manually edit\n' +
      '<!-- /GSD Configuration -->\n';
    assert.strictEqual(
      content,
      expected,
      'a differing merged output is a regression to investigate, not a recorded ' +
        'baseline to accept (RULES-11)',
    );
  } finally {
    cleanup(tmpDir);
  }
});

// ── the opencode config seed: merge-only, never destructive ──────────────────

const OC_SCHEMA = RUNTIMES.opencode.layout.configSeed.contents.$schema;
const OC_CONFIG_FILE = RUNTIMES.opencode.layout.configSeed.file;

/** Write an opencode.json into the target the given scope installs to. */
function seedExistingConfig(tmpDir, scope, text) {
  const targetDir =
    scope === 'global'
      ? path.join(tmpDir, 'cfg-opencode')
      : path.join(tmpDir, '.opencode');
  fs.mkdirSync(targetDir, { recursive: true });
  const cfgPath = path.join(targetDir, OC_CONFIG_FILE);
  fs.writeFileSync(cfgPath, text);
  return cfgPath;
}

test('SEED-01: a fresh opencode install writes the schema key and nothing else', () => {
  const tmpDir = fs.mkdtempSync(path.join(BASE_TMPDIR, 'gsd-seed-01-'));
  try {
    const targetDir = installOpencode(tmpDir, 'local');
    const raw = fs.readFileSync(path.join(targetDir, OC_CONFIG_FILE), 'utf8');

    assert.strictEqual(
      raw,
      JSON.stringify({ $schema: OC_SCHEMA }, null, 2) + '\n',
      'plugins, commands and agents all auto-load by glob, so the seed has one ' +
        'key to write (SEED-01)',
    );
  } finally {
    cleanup(tmpDir);
  }
});

test('SEED-02: a pre-existing key survives the seed untouched', () => {
  const tmpDir = fs.mkdtempSync(path.join(BASE_TMPDIR, 'gsd-seed-02-'));
  try {
    const cfgPath = seedExistingConfig(
      tmpDir,
      'local',
      JSON.stringify({ theme: 'x' }, null, 2) + '\n',
    );
    installOpencode(tmpDir, 'local');

    const parsed = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    assert.strictEqual(parsed.theme, 'x', 'the user key is the user\'s (SEED-02)');
    assert.strictEqual(parsed.$schema, OC_SCHEMA, 'and the seed key is added (SEED-02)');
  } finally {
    cleanup(tmpDir);
  }
});

test('SEED-03: a user-pinned $schema is not overwritten', () => {
  const tmpDir = fs.mkdtempSync(path.join(BASE_TMPDIR, 'gsd-seed-03-'));
  try {
    const pinned = 'https://opencode.ai/config-0.1.json';
    const cfgPath = seedExistingConfig(
      tmpDir,
      'local',
      JSON.stringify({ $schema: pinned }, null, 2) + '\n',
    );
    installOpencode(tmpDir, 'local');

    assert.strictEqual(
      JSON.parse(fs.readFileSync(cfgPath, 'utf8')).$schema,
      pinned,
      'a user pinning an older schema has a reason — only missing keys are ' +
        'added (SEED-03)',
    );
  } finally {
    cleanup(tmpDir);
  }
});

test('SEED-04: an unparseable opencode.json is left byte-identical and reported', () => {
  const tmpDir = fs.mkdtempSync(path.join(BASE_TMPDIR, 'gsd-seed-04-'));
  try {
    const malformed = '{\n  "theme": "x",\n';
    const cfgPath = seedExistingConfig(tmpDir, 'local', malformed);

    const result = runOpencodeInstall(tmpDir, 'local');
    assert.strictEqual(
      result.status,
      0,
      'a malformed config is not an install failure (SEED-04)\nstderr: ' +
        (result.stderr || ''),
    );
    assert.strictEqual(
      fs.readFileSync(cfgPath, 'utf8'),
      malformed,
      'a malformed file is far more likely mid-edit than abandoned (SEED-04)',
    );
    const output = (result.stdout || '') + (result.stderr || '');
    assert.ok(
      output.includes(OC_CONFIG_FILE),
      `the skip must name the file it skipped (SEED-04)\nGot:\n${output}`,
    );
  } finally {
    cleanup(tmpDir);
  }
});

test('SEED-05: installing twice leaves opencode.json byte-identical', () => {
  const tmpDir = fs.mkdtempSync(path.join(BASE_TMPDIR, 'gsd-seed-05-'));
  try {
    const targetDir = installOpencode(tmpDir, 'local');
    const cfgPath = path.join(targetDir, OC_CONFIG_FILE);
    const first = fs.readFileSync(cfgPath, 'utf8');

    installOpencode(tmpDir, 'local');
    assert.strictEqual(
      fs.readFileSync(cfgPath, 'utf8'),
      first,
      'every key is present on the second pass, so nothing is rewritten (SEED-05)',
    );
  } finally {
    cleanup(tmpDir);
  }
});

test('SEED-06: uninstall leaves opencode.json in place', () => {
  const tmpDir = fs.mkdtempSync(path.join(BASE_TMPDIR, 'gsd-seed-06-'));
  try {
    const targetDir = installOpencode(tmpDir, 'local');
    const cfgPath = path.join(targetDir, OC_CONFIG_FILE);
    const before = fs.readFileSync(cfgPath, 'utf8');

    runUninstall(tmpDir, 'opencode', 'local', 'SEED-06');

    assert.ok(
      fs.existsSync(cfgPath),
      'GSD added a key to the runtime\'s own config file — it does not own the ' +
        'file (SEED-06)',
    );
    assert.strictEqual(
      fs.readFileSync(cfgPath, 'utf8'),
      before,
      'and it does not edit it on the way out either (SEED-06)',
    );
  } finally {
    cleanup(tmpDir);
  }
});

// ── install/uninstall symmetry, asserted over a real tree ────────────────────

/**
 * The same tree walker the recorded install trees use. A second walker with
 * its own normalisation rules is how a test like this starts lying about what
 * it saw.
 */
const { captureTree, compareTrees } = require('./install-trees.test.cjs');

/** User-authored files that must be no worse off for GSD having been installed. */
const OC_USER_FILES = [
  ['agent', 'my-agent.md', '---\nmode: subagent\n---\n\nMine.\n'],
  ['command', 'mine.md', '---\ndescription: mine\n---\n\nMine.\n'],
  ['plugin', 'mine.js', 'export default async () => ({});\n'],
];

function opencodeTargetIn(tmpDir, scope) {
  return scope === 'global'
    ? path.join(tmpDir, 'cfg-opencode')
    : path.join(tmpDir, '.opencode');
}

/**
 * Install opencode into a fresh tmpDir and uninstall it again, returning the
 * tree diff across the whole directory — project root and config home both, so
 * a rules file left behind at the root is visible whichever scope wrote it.
 */
function opencodeRoundTrip(tmpDir, scope, { withUserFiles }) {
  const targetDir = opencodeTargetIn(tmpDir, scope);
  if (withUserFiles) {
    for (const [dir, name, body] of OC_USER_FILES) {
      fs.mkdirSync(path.join(targetDir, dir), { recursive: true });
      fs.writeFileSync(path.join(targetDir, dir, name), body);
    }
    fs.writeFileSync(path.join(tmpDir, 'AGENTS.md'), USER_PARAGRAPH);
  }

  const before = captureTree(tmpDir);
  installOpencode(tmpDir, scope);

  // An install that wrote nothing would make every diff below trivially empty.
  const during = captureTree(tmpDir);
  assert.ok(
    Object.keys(during).length > Object.keys(before).length + 100,
    'the round trip must run over a real install, not an empty tree',
  );

  runUninstall(tmpDir, 'opencode', scope, 'symmetry');
  const after = captureTree(tmpDir);

  return { diff: compareTrees(before, after), targetDir };
}

/**
 * The one path an opencode uninstall is expected to leave behind.
 *
 * `opencode.json` is the runtime's own config file: GSD adds a key to it and
 * never claims the file, so removing it on uninstall would delete a user's
 * settings. Every other path must round-trip to nothing.
 */
function seedExceptionFor(scope) {
  const dir = scope === 'global' ? 'cfg-opencode' : '.opencode';
  return `${dir}/${OC_CONFIG_FILE}`;
}

for (const scope of ['global', 'local']) {
  test(`SYMMETRY-01 (${scope}): an opencode install and uninstall round-trips an empty tree`, () => {
    const tmpDir = fs.mkdtempSync(path.join(BASE_TMPDIR, `gsd-sym-01-${scope}-`));
    try {
      const { diff } = opencodeRoundTrip(tmpDir, scope, { withUserFiles: false });
      assert.deepStrictEqual(
        diff,
        { changed: [], added: [seedExceptionFor(scope)], removed: [] },
        'the post-uninstall tree must equal the pre-install tree apart from the ' +
          'named exception (SYMMETRY-01)',
      );
    } finally {
      cleanup(tmpDir);
    }
  });

  test(`SYMMETRY-02 (${scope}): a tree of user files round-trips unchanged`, () => {
    const tmpDir = fs.mkdtempSync(path.join(BASE_TMPDIR, `gsd-sym-02-${scope}-`));
    try {
      const { diff } = opencodeRoundTrip(tmpDir, scope, { withUserFiles: true });
      assert.deepStrictEqual(
        diff,
        { changed: [], added: [seedExceptionFor(scope)], removed: [] },
        'user content in the same directories GSD writes to must survive the ' +
          'round trip byte-for-byte (SYMMETRY-02)',
      );
    } finally {
      cleanup(tmpDir);
    }
  });

  for (const [dir, name] of OC_USER_FILES) {
    test(`SYMMETRY-03 (${scope}): ${dir}/${name} survives install and uninstall`, () => {
      const tmpDir = fs.mkdtempSync(
        path.join(BASE_TMPDIR, `gsd-sym-03-${scope}-`),
      );
      try {
        const { targetDir } = opencodeRoundTrip(tmpDir, scope, {
          withUserFiles: true,
        });
        const userFile = path.join(targetDir, dir, name);
        const expected = OC_USER_FILES.find(
          (f) => f[0] === dir && f[1] === name,
        )[2];
        assert.ok(
          fs.existsSync(userFile),
          `${dir}/${name} was eaten by the round trip (SYMMETRY-03)`,
        );
        assert.strictEqual(
          fs.readFileSync(userFile, 'utf8'),
          expected,
          `${dir}/${name} came back altered (SYMMETRY-03)`,
        );
      } finally {
        cleanup(tmpDir);
      }
    });
  }

  test(`SYMMETRY-04 (${scope}): the project-root AGENTS.md comes back exactly as it was`, () => {
    const tmpDir = fs.mkdtempSync(path.join(BASE_TMPDIR, `gsd-sym-04-${scope}-`));
    try {
      opencodeRoundTrip(tmpDir, scope, { withUserFiles: true });
      assert.strictEqual(
        fs.readFileSync(path.join(tmpDir, 'AGENTS.md'), 'utf8'),
        USER_PARAGRAPH,
        'the local round trip merges into this file and must restore it byte ' +
          'for byte; the global one must never have touched it (SYMMETRY-04)',
      );
    } finally {
      cleanup(tmpDir);
    }
  });
}

// ── the {{VAR}} post-pass reaches every directory a runtime ships ────────────
//
// The post-pass is spec-driven: `layout.templatePassDirs` names the directories
// swept after an install writes them. A directory missing from that list ships
// its placeholders raw, which is exactly what copilot did — its list was empty.

const POSTPASS_REGISTRY_KEYS = Object.keys(RUNTIMES.claude).filter((k) =>
  /^[A-Z][A-Z0-9_]*$/.test(k),
);

const POSTPASS_PLACEHOLDER_RE = new RegExp(
  '\\{\\{(' + POSTPASS_REGISTRY_KEYS.join('|') + ')\\}\\}',
);

function postPassWalk(dir, base, acc) {
  if (!fs.existsSync(dir)) return acc;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) postPassWalk(abs, base, acc);
    else if (entry.isFile()) acc.push(path.relative(base, abs).split(path.sep).join('/'));
  }
  return acc;
}

/** Files under `dir` still carrying an unresolved registry-key placeholder. */
function unresolvedRegistryPlaceholders(root, dir) {
  const offenders = [];
  for (const rel of postPassWalk(path.join(root, ...dir.split('/')), root, [])) {
    const text = fs.readFileSync(path.join(root, ...rel.split('/')), 'utf8');
    const hit = text.match(POSTPASS_PLACEHOLDER_RE);
    if (hit) offenders.push(`${rel} :: ${hit[0]}`);
  }
  return offenders;
}

const POSTPASS_TARGET_DIR = {
  claude: '.claude',
  copilot: '.github',
  opencode: '.opencode',
};

const postPassInstalls = new Map();
const postPassTmpDirs = [];

process.on('exit', () => {
  for (const dir of postPassTmpDirs) cleanup(dir);
});

/** One local install per runtime, reused by every assertion below. */
function postPassInstall(runtime) {
  if (postPassInstalls.has(runtime)) return postPassInstalls.get(runtime);
  const tmpDir = fs.mkdtempSync(path.join(BASE_TMPDIR, `gsd-postpass-${runtime}-`));
  postPassTmpDirs.push(tmpDir);
  const result = spawnSync(
    process.execPath,
    [
      INSTALLER,
      '--runtime',
      runtime,
      '--local',
      '--no-seed-permissions-config',
      '--no-seed-sandbox-config',
    ],
    {
      encoding: 'utf8',
      timeout: 60000,
      cwd: tmpDir,
      env: Object.assign({}, process.env, {
        HOME: tmpDir,
        CLAUDE_CONFIG_DIR: path.join(tmpDir, 'cfg-claude'),
        COPILOT_CONFIG_DIR: path.join(tmpDir, 'cfg-copilot'),
        OPENCODE_CONFIG_DIR: path.join(tmpDir, 'cfg-opencode'),
      }),
    },
  );
  assert.strictEqual(
    result.status,
    0,
    `${runtime} install must exit 0 (POSTPASS)\nstderr: ${result.stderr || ''}`,
  );
  const targetDir = path.join(tmpDir, POSTPASS_TARGET_DIR[runtime]);
  postPassInstalls.set(runtime, targetDir);
  return targetDir;
}

test('POSTREACH-01: every runtime layout declares a non-empty post-pass directory list', () => {
  for (const [name, spec] of Object.entries(RUNTIMES)) {
    const dirs = (spec.layout || {}).templatePassDirs;
    assert.ok(
      Array.isArray(dirs) && dirs.length > 0,
      `${name}.layout.templatePassDirs must be a non-empty array — an empty list ` +
        'ships every registry placeholder raw (POSTREACH-01)',
    );
  }
  const claudeDirs = RUNTIMES.claude.layout.templatePassDirs;
  assert.ok(
    claudeDirs.includes('agents'),
    "claude's post-pass must cover agents/ (POSTREACH-01)",
  );
  assert.ok(
    claudeDirs.includes('gsd-ng/templates'),
    "claude's post-pass must cover gsd-ng/templates/ (POSTREACH-01)",
  );
});

test('POSTREACH-02: a claude install leaves no registry placeholder under agents/', () => {
  const offenders = unresolvedRegistryPlaceholders(postPassInstall('claude'), 'agents');
  assert.deepStrictEqual(
    offenders,
    [],
    `unresolved registry placeholders in a claude install's agents/ (POSTREACH-02):\n  ${offenders.join('\n  ')}`,
  );
});

test('POSTREACH-03: a claude install leaves no registry placeholder under gsd-ng/templates/', () => {
  const offenders = unresolvedRegistryPlaceholders(
    postPassInstall('claude'),
    'gsd-ng/templates',
  );
  assert.deepStrictEqual(
    offenders,
    [],
    `unresolved registry placeholders in a claude install's templates (POSTREACH-03):\n  ${offenders.join('\n  ')}`,
  );
});

test('POSTREACH-04: a copilot install leaves no {{COMMAND_PREFIX}} under gsd-ng/workflows/', () => {
  const root = postPassInstall('copilot');
  const offenders = [];
  for (const rel of postPassWalk(path.join(root, 'gsd-ng', 'workflows'), root, [])) {
    const text = fs.readFileSync(path.join(root, ...rel.split('/')), 'utf8');
    if (text.includes('{{COMMAND_PREFIX}}')) offenders.push(rel);
  }
  assert.deepStrictEqual(
    offenders,
    [],
    `copilot workflows still carry {{COMMAND_PREFIX}} (POSTREACH-04):\n  ${offenders.join('\n  ')}`,
  );
});

test('POSTREACH-05: document placeholders in gsd-ng/templates/ survive the post-pass', () => {
  for (const runtime of ['claude', 'copilot']) {
    const archive = path.join(
      postPassInstall(runtime),
      'gsd-ng',
      'templates',
      'milestone-archive.md',
    );
    const text = fs.readFileSync(archive, 'utf8');
    for (const placeholder of ['{{DATE}}', '{{PHASE}}', '{{MILESTONE_NAME}}']) {
      assert.ok(
        text.includes(placeholder),
        `${runtime}: ${placeholder} must survive the post-pass verbatim — ` +
          'processTemplate leaves unknown keys alone (POSTREACH-05)',
      );
    }
  }
});

test('POSTREACH-06: a file nested under gsd-ng/templates/codebase/ is processed', () => {
  const expected = {
    claude: RUNTIMES.claude.PROJECT_RULES_FILE,
    copilot: RUNTIMES.copilot.PROJECT_RULES_FILE,
  };
  for (const runtime of ['claude', 'copilot']) {
    const nested = path.join(
      postPassInstall(runtime),
      'gsd-ng',
      'templates',
      'codebase',
      'structure.md',
    );
    const text = fs.readFileSync(nested, 'utf8');
    assert.ok(
      text.includes(expected[runtime]),
      `${runtime}: nested template must resolve {{PROJECT_RULES_FILE}} to ` +
        `${expected[runtime]} — a flat post-pass never reaches it (POSTREACH-06)`,
    );
    assert.ok(
      !text.includes('{{PROJECT_RULES_FILE}}'),
      `${runtime}: nested template still carries the raw placeholder (POSTREACH-06)`,
    );
  }
});

test('POSTREACH-07: a file with unbalanced ONLY markers is skipped, not corrupted', () => {
  const { resolveTemplateDir } = require('../bin/install.js');
  const {
    buildContext,
  } = require('../gsd-ng/bin/lib/template-processor.cjs');
  const tmpDir = fs.mkdtempSync(path.join(BASE_TMPDIR, 'gsd-postpass-markers-'));
  try {
    const nested = path.join(tmpDir, 'deep', 'deeper');
    fs.mkdirSync(nested, { recursive: true });

    const broken = '<!-- ONLY:claude --> {{COMMAND_PREFIX}}plan-phase\n';
    const good = 'run {{COMMAND_PREFIX}}plan-phase and keep {{DATE}}\n';
    fs.writeFileSync(path.join(tmpDir, 'broken.md'), broken);
    fs.writeFileSync(path.join(nested, 'good.md'), good);

    resolveTemplateDir(tmpDir, buildContext('opencode'));

    assert.strictEqual(
      fs.readFileSync(path.join(tmpDir, 'broken.md'), 'utf8'),
      broken,
      'a file whose ONLY markers do not balance must be left byte-identical (POSTREACH-07)',
    );
    assert.strictEqual(
      fs.readFileSync(path.join(nested, 'good.md'), 'utf8'),
      'run /gsd-plan-phase and keep {{DATE}}\n',
      'recursion must reach a nested file, resolve registry keys and leave ' +
        'unknown keys alone (POSTREACH-07)',
    );
  } finally {
    cleanup(tmpDir);
  }
});

// ── the swept literals render per runtime ────────────────────────────────────
//
// The sweep replaced every `/gsd:<name>` and `AskUserQuestion` in the content
// layer with a registry placeholder. These two assertions are what prove the
// substitution changed nothing for claude and reached the other runtimes.

test('SWEEP-01: a claude install still renders the claude command prefix and tool name', () => {
  const root = postPassInstall('claude');
  const planner = fs.readFileSync(path.join(root, 'agents', 'gsd-planner.md'), 'utf8');
  assert.ok(
    planner.includes('/gsd:plan-phase'),
    'a claude install must render /gsd:plan-phase, not the raw placeholder (SWEEP-01)',
  );
  assert.ok(
    !planner.includes('{{COMMAND_PREFIX}}'),
    'a claude install must carry no raw {{COMMAND_PREFIX}} (SWEEP-01)',
  );

  const questioning = fs.readFileSync(
    path.join(root, 'gsd-ng', 'references', 'questioning.md'),
    'utf8',
  );
  assert.ok(
    questioning.includes('AskUserQuestion'),
    "a claude install must render claude's own tool name (SWEEP-01)",
  );
});

test('SWEEP-02: an opencode install renders its own command prefix and tool name', () => {
  const root = postPassInstall('opencode');
  const planner = fs.readFileSync(path.join(root, 'agent', 'gsd-planner.md'), 'utf8');
  assert.ok(
    planner.includes('/gsd-plan-phase'),
    'an opencode install must render /gsd-plan-phase in the same place (SWEEP-02)',
  );
  assert.ok(
    !planner.includes('/gsd:plan-phase'),
    "an opencode install must not carry claude's command syntax (SWEEP-02)",
  );

  const questioning = fs.readFileSync(
    path.join(root, 'gsd-ng', 'references', 'questioning.md'),
    'utf8',
  );
  assert.ok(
    !questioning.includes('AskUserQuestion'),
    'an opencode install must not name a tool it does not have (SWEEP-02)',
  );
});
