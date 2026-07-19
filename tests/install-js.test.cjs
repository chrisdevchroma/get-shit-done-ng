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
const { resolveTmpDir, cleanup } = require('./helpers.cjs');
const BASE_TMPDIR = resolveTmpDir();

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
//            See 54-CONTEXT.md "Template allow canonicalisation" decision.
//
//            Write(*) was REMOVED from this contract. It is an unmatched path form:
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
//            This covers ALL THREE seeded sections, not just deny — the startup
//            warning fires for allow, deny and ask alike, and install.js now runs
//            each of them through normalizePermissionRules(). The assertion keeps
//            the template itself honest so the mistake is caught at source rather
//            than repaired at install time. It also rejects the Edit/Write *pair*
//            shape proposed in 36.1-01-PLAN.md:92-97 — the Write half is
//            decoration, not defence.
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

test('PERM-07: local install seeds granular gh subcommand patterns (not blanket Bash(gh *))', () => {
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

    // gh is typically installed in CI/dev environments
    // If gh is installed, we should see granular patterns
    try {
      require('child_process').execSync('which gh', {
        stdio: 'ignore',
        timeout: 2000,
      });
      // gh is installed -- verify granular patterns
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
    } catch {
      // gh not installed -- just verify no blanket pattern leaked
      assert.ok(
        !allow.includes('Bash(gh *)'),
        'must NOT include blanket Bash(gh *) even without gh installed (PERM-07)',
      );
    }
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

    // Walk .github/ recursively — no file should contain "permissions" key
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

    const jsonFiles = walkDir(githubDir);
    for (const jsonFile of jsonFiles) {
      try {
        const data = JSON.parse(fs.readFileSync(jsonFile, 'utf8'));
        assert.ok(
          data.permissions === undefined,
          `${jsonFile} must not contain "permissions" key in Copilot install (COPILOT-05)`,
        );
      } catch {
        // JSON parse error — skip
      }
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

test('ALLOW-18: install.js seeding block uses GSD_TEST_FORCE_PLATFORM (not GSD_FORCE_PLATFORM)', () => {
  // Static code inspection: the source must not reference the old env var name
  const src = fs.readFileSync(INSTALLER, 'utf8');
  assert.ok(
    !src.includes('GSD_FORCE_PLATFORM'),
    'install.js must not reference GSD_FORCE_PLATFORM (old name) — use GSD_TEST_FORCE_PLATFORM (ALLOW-18)',
  );
  assert.ok(
    src.includes('GSD_TEST_FORCE_PLATFORM'),
    'install.js must reference GSD_TEST_FORCE_PLATFORM at least once (ALLOW-18)',
  );
});

// ── RW_FORMS imported from allowlist.cjs — no inline Set literal ──────

test('ALLOW-19: install.js imports RW_FORMS from allowlist.cjs and uses no inline rwForms Set literal', () => {
  const src = fs.readFileSync(INSTALLER, 'utf8');
  // Must import RW_FORMS in the destructure
  assert.ok(
    src.includes('RW_FORMS'),
    'install.js must import and reference RW_FORMS from allowlist.cjs (ALLOW-19)',
  );
  // Must not define an inline Set containing these canonical forms
  assert.ok(
    !src.includes("new Set(['Edit', 'Write', 'Read'"),
    'install.js must not define an inline rwForms Set literal — use imported RW_FORMS (ALLOW-19)',
  );
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

// ── syncSection uses Set.has() for O(1) membership ─────────────────

test('ALLOW-20: install.js syncSection uses Set.has() — not Array.includes() — for membership check', () => {
  const src = fs.readFileSync(INSTALLER, 'utf8');
  // New implementation: must use Set.has()
  assert.ok(
    src.includes('existingSet.has(e)'),
    'syncSection must use existingSet.has(e) for membership check (ALLOW-20)',
  );
  // Old implementation: must not use Array.includes()
  assert.ok(
    !src.includes('existing.includes(e)'),
    'syncSection must not use existing.includes(e) — replaced by Set.has() (ALLOW-20)',
  );
  // Return shape: merged and added fields must still be present
  assert.ok(
    src.includes('merged: [...existing, ...toAdd]'),
    'syncSection must keep merged: [...existing, ...toAdd] return shape (ALLOW-20)',
  );
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

    // Claude engine: gsd-planner.md must have effort: frontmatter (quality profile → max)
    const claudeAgentContent = fs.readFileSync(path.join(claudeAgentsDir, 'gsd-planner.md'), 'utf-8');
    assert.ok(
      /^effort:\s*max$/m.test(claudeAgentContent),
      `Claude agent must have effort: max after sync (${firstRuntime}-then-${secondRuntime})\nactual:\n${claudeAgentContent}`,
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

// ── --clean flag wipes managed dirs before install and produces fresh v2 manifest ──

test('CLEAN-01: --clean flag wipes managed dirs before install and produces fresh v2 manifest', () => {
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
    // Corrupt the manifest
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

  test('EFFSYNC-INSTALL-01: Claude local install writes effort: max to gsd-planner.md when profile=quality', () => {
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
      /^effort: max$/m,
      'effort: max must be in frontmatter',
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
// The end-to-end guard for the defect the unit tests only approximate: the
// installer used to seed Write(*) into permissions.allow on every macOS/Windows
// install, which CC >= 2.1.210 reports as a startup warning. Asserting on the
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

test('ALLOW-08: install.js --local on macOS writes canonical glob forms', () => {
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
    // Narrowed verbs land — gated on gh presence on host
    try {
      require('child_process').execSync('which gh', {
        stdio: 'ignore',
        timeout: 2000,
      });
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
    } catch {
      /* gh not installed — skip narrow-verb assertions */
    }
  } finally {
    cleanup(tmpDir);
  }
});

// ── install.js writes canonical forms + narrowed CLI verbs on win32 ──

test('ALLOW-16: install.js --local on win32 writes canonical glob forms and narrowed CLI verbs', () => {
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

    // Narrowed verbs land — gated on gh presence on host
    try {
      require('child_process').execSync('which gh', {
        stdio: 'ignore',
        timeout: 2000,
      });
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
    } catch {
      /* gh not installed — skip narrow-verb assertions */
    }
  } finally {
    cleanup(tmpDir);
  }
});

// ── allow section sync union preserves user entries + logs per-section count ──

test('ALLOW-09: allow-section sync preserves user entries and logs "Added N allow entries"', () => {
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
    // Narrowed-verb check — gated on gh presence
    try {
      require('child_process').execSync('which gh', {
        stdio: 'ignore',
        timeout: 2000,
      });
      const allow = settings.permissions?.allow ?? [];
      assert.ok(
        !allow.includes('Bash(gh repo *)'),
        'linux install must not land broad gh repo (narrowed)',
      );
      assert.ok(
        allow.includes('Bash(gh repo view *)') || allow.length === 0,
        'narrowed repo view lands when gh present',
      );
    } catch {
      /* gh not installed */
    }
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

// ── source seed-memories.md exists (relaxed in 49.1-01) ──
// History: plan 49-04 added a token assertion on the seed-memories source file.
// 49.1-01 relaxes this: per CONTEXT.md decision, plan 49.1-02 will rewrite the skill to use
// skill-time prose detection (no template variable). The original token assertion would then
// fail. The companion test still asserts the token in new-project.md (kept in unified flow).
// This test now only asserts source presence — a tombstone preserving the original assertion.

test('F-RULES-01: source seed-memories.md exists (assertion relaxed in 49.1-01 — skill-time detection moved to prose)', () => {
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
  // {{PROJECT_RULES_FILE}} assertion removed — file will use skill-time prose detection
  // per CONTEXT.md; the companion test covers new-project.md unified flow.
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

// no runtime-specific PROJECT_RULES_FILE literals in template-mechanical source files
test('RTAGNOSTIC-01: no PROJECT_RULES_FILE literals in template-mechanical sources', () => {
  const REPO_ROOT = path.join(__dirname, '..');
  const TEMPLATE_MECHANICAL_DIRS = [
    path.join(REPO_ROOT, 'gsd-ng', 'workflows'),
    path.join(REPO_ROOT, 'gsd-ng', 'references'),
    path.join(REPO_ROOT, 'commands', 'gsd'),
  ];

  // Banned literals derived dynamically from RUNTIMES registry — no hardcoded list.
  const BANNED_LITERALS = Object.values(RUNTIMES)
    .map((r) => r.PROJECT_RULES_FILE)
    .filter(Boolean);

  function walkMd(dir) {
    if (!fs.existsSync(dir)) return [];
    const out = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) out.push(...walkMd(full));
      else if (entry.isFile() && entry.name.endsWith('.md')) out.push(full);
    }
    return out;
  }

  const offenders = [];
  for (const dir of TEMPLATE_MECHANICAL_DIRS) {
    for (const file of walkMd(dir)) {
      const content = fs.readFileSync(file, 'utf8');
      for (const literal of BANNED_LITERALS) {
        if (content.includes(literal)) {
          offenders.push(`${path.relative(REPO_ROOT, file)} :: ${literal}`);
          break;
        }
      }
    }
  }

  assert.strictEqual(
    offenders.length,
    0,
    `RTAGNOSTIC-01: runtime-specific PROJECT_RULES_FILE literals found in template-mechanical sources:\n  ${offenders.join('\n  ')}`,
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

    // Simulate a manifest written by a pre-fix installer: raw hashes only.
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
