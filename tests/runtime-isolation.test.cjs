'use strict';

/**
 * One runtime's install stays inside that runtime's own directories.
 *
 * The property has two halves, and they are asserted separately because
 * conflating them yields a test that passes for the wrong reason:
 *
 *   1. Filesystem — installing for runtime R creates no path belonging to
 *      another runtime, under the home directory or the project. This holds
 *      today; these tests exist so it keeps holding.
 *   2. Content — no file shipped into R's install names another runtime's
 *      config directory followed by a path segment GSD or the runtime owns.
 *      This was violated: an installed OpenCode tree carried executable
 *      `node "…/.claude/gsd-ng/bin/gsd-tools.cjs"` commands pointing at a
 *      directory that does not exist in an OpenCode install.
 *
 * The gate runs against the installed tree rather than the source, because the
 * source names Claude's directories on purpose and the installer rewrites them.
 * Only the shipped form can be judged.
 *
 * Installs come from `runIsolatedInstall`, which keeps HOME and the project
 * directory apart. Under a shared one, a project-relative path and a
 * home-relative path resolve to the same place, and the strongest assertion
 * here — that every shipped tool path exists — could not fail.
 *
 * Everything runtime-shaped is derived from the registry, so a fourth runtime
 * is covered with no edit to this file.
 */

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { RUNTIMES } = require('../gsd-ng/bin/lib/template-processor.cjs');
const {
  runIsolatedInstall,
  runIsolatedUninstall,
} = require('./install-harness.cjs');
const { resolveTmpDir, cleanup, cleanupSubdir } = require('./helpers.cjs');

const BASE_TMPDIR = resolveTmpDir();

// ── what belongs to whom ─────────────────────────────────────────────────────

/** Every config-home directory name in the registry, global and local. */
function allConfigDirNames(runtimes) {
  return [
    ...new Set(
      Object.values(runtimes)
        .flatMap((r) => [r.configHome.globalDirName, r.configHome.localDirName])
        .filter(Boolean),
    ),
  ];
}

/** The config-home directory names that do not belong to `runtime`. */
function foreignDirNames(runtime, runtimes = RUNTIMES) {
  const spec = (runtimes[runtime] || {}).configHome || {};
  const own = new Set([spec.globalDirName, spec.localDirName].filter(Boolean));
  return allConfigDirNames(runtimes).filter((name) => !own.has(name));
}

/**
 * The path segments GSD or a runtime owns underneath a config home.
 *
 * The detector flags `<foreign dir>/<segment>` and never a bare `<foreign dir>`.
 * A bare ban would be wrong: `.github` is Copilot's local config home and also
 * an ordinary GitHub repository directory, so `.github/workflows/ci.yml` and
 * `.github/PULL_REQUEST_TEMPLATE.md` are correct content that must not be
 * flagged. Five installed files name `.github` that way today.
 */
const OWNED_SEGMENTS = [
  'gsd-ng',
  'memory',
  'logs',
  'skills',
  'cache',
  'settings.json',
  'gsd-local-patches',
];

function foreignPathPattern(dirName) {
  const escape = (s) => s.replace(/\./g, '\\.');
  return new RegExp(
    '(?<![A-Za-z0-9])' +
      escape(dirName) +
      '/(?:' +
      OWNED_SEGMENTS.map(escape).join('|') +
      ')(?![A-Za-z0-9])',
    'g',
  );
}

/**
 * `line :: match` for every foreign config-home path in `content`.
 *
 * The leading boundary is what keeps `api.github.com` out: a directory name
 * preceded by an alphanumeric is part of a longer token, not a path segment.
 */
function foreignOffenders(content, runtime, runtimes = RUNTIMES) {
  const hits = [];
  const lines = content.split('\n');
  for (const dirName of foreignDirNames(runtime, runtimes)) {
    const re = foreignPathPattern(dirName);
    lines.forEach((line, index) => {
      re.lastIndex = 0;
      let match;
      while ((match = re.exec(line)) !== null) {
        hits.push(`${index + 1} :: ${match[0]}`);
      }
    });
  }
  return hits;
}

/** Relpaths whose directory structure names a foreign config home. */
function foreignPathHits(relpaths, runtime, runtimes = RUNTIMES) {
  const foreign = new Set(foreignDirNames(runtime, runtimes));
  return relpaths.filter((rel) => rel.split('/').some((seg) => foreign.has(seg)));
}

/** Relpaths whose basename is one of `names`. */
function basenameHits(relpaths, names) {
  return relpaths.filter((rel) => names.includes(path.basename(rel)));
}

/** Every file relpath under `dir`, recursive, forward-slashed and sorted. */
function walkFiles(dir, base = dir, acc = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) walkFiles(abs, base, acc);
    else acc.push(path.relative(base, abs).split(path.sep).join('/'));
  }
  return acc.sort();
}

function readFilesUnder(dir, predicate) {
  return walkFiles(dir)
    .filter(predicate)
    .map((rel) => ({ rel, content: fs.readFileSync(path.join(dir, rel), 'utf8') }));
}

const isMarkdown = (rel) => rel.endsWith('.md');
const isScript = (rel) => rel.endsWith('.cjs') || rel.endsWith('.js');

// ── installs, made once and read many times ──────────────────────────────────
//
// Every test below reads its tree and writes nothing into it, so one install
// per runtime and scope serves all of them. Each still gets its own temp dir;
// they are removed together once the file's tests have finished.

const INSTALLS = new Map();
const TEMP_DIRS = [];

function installOnce(runtime, scope) {
  const key = `${runtime}-${scope}`;
  if (!INSTALLS.has(key)) {
    const tmpDir = fs.mkdtempSync(path.join(BASE_TMPDIR, `gsd-isolation-${key}-`));
    TEMP_DIRS.push(tmpDir);
    INSTALLS.set(key, { tmpDir, ...runIsolatedInstall(tmpDir, { runtime, scope }) });
  }
  return INSTALLS.get(key);
}

after(() => {
  for (const tmpDir of TEMP_DIRS) cleanup(tmpDir);
});

// ── filesystem isolation, one test per direction ─────────────────────────────

/**
 * Assert that nothing anywhere under the install's temp dir — home and project
 * both — belongs to another runtime.
 *
 * The same check is then fed a fabricated relpath, so a run that finds nothing
 * has still shown it can find something. A filesystem assertion no fixture can
 * fail is not a gate.
 */
function assertNoForeignPaths(runtime, scope, forbiddenBasenames) {
  const { tmpDir } = installOnce(runtime, scope);
  const relpaths = walkFiles(tmpDir);

  assert.ok(relpaths.length > 50, `install must produce a real tree, saw ${relpaths.length}`);
  assert.deepStrictEqual(
    foreignPathHits(relpaths, runtime),
    [],
    `${runtime} ${scope}: install created a path under another runtime's config home`,
  );
  assert.deepStrictEqual(
    basenameHits(relpaths, forbiddenBasenames),
    [],
    `${runtime} ${scope}: install created a file another runtime owns`,
  );

  const fabricated = ['home', foreignDirNames(runtime)[0], 'gsd-ng', 'VERSION'].join('/');
  assert.deepStrictEqual(
    foreignPathHits([...relpaths, fabricated], runtime),
    [fabricated],
    'the segment check must report a foreign path when one is present',
  );
  assert.deepStrictEqual(
    basenameHits([...relpaths, `home/${forbiddenBasenames[0]}`], forbiddenBasenames),
    [`home/${forbiddenBasenames[0]}`],
    'the basename check must report a foreign file when one is present',
  );
}

test('ISOLATION-01: an opencode global install creates no claude, copilot or github path', () => {
  assertNoForeignPaths('opencode', 'global', ['CLAUDE.md', 'copilot-instructions.md']);

  const { targetDir, proj } = installOnce('opencode', 'global');
  assert.ok(fs.existsSync(path.join(targetDir, 'gsd-ng', 'VERSION')));
  assert.ok(fs.existsSync(path.join(targetDir, 'opencode.json')));
  assert.ok(
    !fs.existsSync(path.join(proj, 'AGENTS.md')),
    'a global install has no project, so it writes no project rules file',
  );
});

test('ISOLATION-02: a claude global install creates no opencode, copilot or github path', () => {
  assertNoForeignPaths('claude', 'global', [
    'AGENTS.md',
    'opencode.json',
    'copilot-instructions.md',
  ]);

  const { targetDir } = installOnce('claude', 'global');
  assert.ok(fs.existsSync(path.join(targetDir, 'gsd-ng', 'VERSION')));
  assert.ok(fs.existsSync(path.join(targetDir, 'commands', 'gsd')));
});

test('ISOLATION-03: an opencode local install creates no claude, copilot or github path', () => {
  assertNoForeignPaths('opencode', 'local', ['CLAUDE.md', 'copilot-instructions.md']);

  const { targetDir, proj } = installOnce('opencode', 'local');
  assert.ok(fs.existsSync(path.join(targetDir, 'gsd-ng', 'VERSION')));
  assert.ok(fs.existsSync(path.join(targetDir, 'opencode.json')));
  assert.ok(fs.existsSync(path.join(proj, 'AGENTS.md')));
});

test('ISOLATION-04: a claude local install creates no opencode, copilot or github path', () => {
  assertNoForeignPaths('claude', 'local', [
    'AGENTS.md',
    'opencode.json',
    'copilot-instructions.md',
  ]);

  const { targetDir } = installOnce('claude', 'local');
  assert.ok(fs.existsSync(path.join(targetDir, 'gsd-ng', 'VERSION')));
  assert.ok(fs.existsSync(path.join(targetDir, 'commands', 'gsd')));
});

// ── content isolation ────────────────────────────────────────────────────────

function assertNoForeignContent(runtime, scope) {
  const { targetDir } = installOnce(runtime, scope);
  const files = readFilesUnder(targetDir, isMarkdown);
  assert.ok(files.length > 20, `expected a populated tree, saw ${files.length} .md files`);

  const offenders = [];
  for (const { rel, content } of files) {
    for (const hit of foreignOffenders(content, runtime)) offenders.push(`${rel}:${hit}`);
  }
  assert.deepStrictEqual(
    offenders,
    [],
    `${runtime} ${scope}: shipped content names another runtime's config home:\n  ` +
      offenders.join('\n  '),
  );
}

test('ISOLATION-05: no .md shipped into an opencode install names a foreign config dir', () => {
  assertNoForeignContent('opencode', 'global');
});

test('ISOLATION-06: no .md shipped into a claude install names a foreign config dir', () => {
  assertNoForeignContent('claude', 'global');
});

test('ISOLATION-07: no .md shipped into a copilot install names a foreign config dir', () => {
  assertNoForeignContent('copilot', 'global');
});

// ── every shipped tool path exists ───────────────────────────────────────────

const GSD_TOOLS_INVOCATION = /node\s+"([^"]*gsd-tools\.cjs)"/g;

/** Every distinct `node "<path>/gsd-tools.cjs"` string in a tree's .md files. */
function shippedToolPaths(targetDir) {
  const found = new Set();
  for (const { content } of readFilesUnder(targetDir, isMarkdown)) {
    GSD_TOOLS_INVOCATION.lastIndex = 0;
    let match;
    while ((match = GSD_TOOLS_INVOCATION.exec(content)) !== null) found.add(match[1]);
  }
  return [...found].sort();
}

/**
 * Resolve a shipped path against the anchor its form declares.
 *
 * `$HOME` and `~` are the home directory; a `${VAR:-fallback}` prefix is the
 * project-directory expression the installer writes for local installs; a bare
 * relative path is what a local install of a non-source runtime produces, and
 * its anchor is the project root the workflow runs in.
 */
function resolveShippedPath(raw, home, proj) {
  if (raw.startsWith('$HOME/')) return path.join(home, raw.slice('$HOME/'.length));
  if (raw.startsWith('~/')) return path.join(home, raw.slice(2));
  const projectExpr = raw.match(/^\$\{[A-Za-z_][A-Za-z0-9_]*:-[^}]*\}\/(.*)$/);
  if (projectExpr) return path.join(proj, projectExpr[1]);
  if (path.isAbsolute(raw)) return raw;
  return path.join(proj, raw);
}

test('ISOLATION-08: every gsd-tools invocation shipped into an install resolves to a file that exists', () => {
  const unresolvable = [];
  let checked = 0;

  for (const runtime of ['opencode', 'claude']) {
    for (const scope of ['global', 'local']) {
      const { targetDir, home, proj } = installOnce(runtime, scope);
      assert.notEqual(home, proj, 'home and project must be distinct for this to be a test');

      const paths = shippedToolPaths(targetDir);
      assert.ok(paths.length > 0, `${runtime} ${scope}: no tool invocation found to check`);
      for (const raw of paths) {
        checked += 1;
        const resolved = resolveShippedPath(raw, home, proj);
        if (!fs.existsSync(resolved)) {
          unresolvable.push(`${runtime} ${scope} :: ${raw} -> ${resolved}`);
        }
      }
    }
  }

  assert.ok(checked >= 4, `expected at least one path per tree, checked ${checked}`);
  assert.deepStrictEqual(
    unresolvable,
    [],
    'shipped tool paths that do not exist in the install:\n  ' + unresolvable.join('\n  '),
  );
});

// ── the library exclusion, recorded rather than hidden ───────────────────────

/**
 * Foreign config-home literals surviving in an installed tree's executable
 * files, per relpath, measured on an opencode global install.
 *
 * Each is refactor-class: closing it needs a registry lookup at the call site,
 * not a substitution. `cache-path.cjs` and the hooks are the clearest case —
 * they probe every runtime's config home to find where GSD was installed, so
 * naming another runtime's directory is what they are for. Recorded here rather
 * than accepted: this table only ever shrinks, and a count that rises fails.
 *
 * The registry file is excluded, since the values there are the definitions and
 * a fourth runtime row would raise a count that means nothing.
 */
const ISOLATION_LIB_ALLOWLIST = {
  'gsd-ng/bin/gsd-tools.cjs': 3,
  'gsd-ng/bin/lib/cache-path.cjs': 2,
  'gsd-ng/bin/lib/commands.cjs': 4,
  'gsd-ng/bin/lib/config.cjs': 3,
  'gsd-ng/bin/lib/core.cjs': 1,
  'gsd-ng/bin/lib/security.cjs': 3,
  'gsd-ng/bin/lib/verify.cjs': 5,
  'gsd-ng/bin/lib/workspace.cjs': 2,
  'gsd-ng/hooks/bash-safety-hook.cjs': 10,
  'gsd-ng/hooks/gsd-check-update.js': 12,
  'plugin/gsd-core.js': 1,
};

const ISOLATION_REGISTRY_RELPATH = 'gsd-ng/bin/lib/template-processor.cjs';

function countForeignDirNames(content, runtime, runtimes = RUNTIMES) {
  let count = 0;
  for (const dirName of foreignDirNames(runtime, runtimes)) {
    const re = new RegExp(
      '(?<![A-Za-z0-9])' + dirName.replace(/\./g, '\\.') + '(?![A-Za-z0-9])',
      'g',
    );
    count += (content.match(re) || []).length;
  }
  return count;
}

test('ISOLATION-09: config-dir literals in installed non-.md files stay within the recorded allowlist', () => {
  const { targetDir } = installOnce('opencode', 'global');
  const offenders = [];
  const shrunk = [];

  for (const { rel, content } of readFilesUnder(targetDir, isScript)) {
    if (rel === ISOLATION_REGISTRY_RELPATH) continue;
    const count = countForeignDirNames(content, 'opencode');
    const allowed = ISOLATION_LIB_ALLOWLIST[rel] || 0;
    if (count > allowed) {
      offenders.push(`${rel} :: ${count} foreign config-dir literals, allowlist ${allowed}`);
    } else if (count < allowed) {
      shrunk.push(`${rel} :: ${count} < ${allowed}`);
    }
  }

  for (const line of shrunk) {
    console.log(`  note: isolation allowlist can be tightened — ${line}`);
  }
  assert.deepStrictEqual(
    offenders,
    [],
    'ISOLATION-09: foreign config-dir literals rose above the recorded allowlist. ' +
      'The allowlist only shrinks — route the new one through the runtime spec:\n  ' +
      offenders.join('\n  '),
  );
});

// ── the detector must discriminate ───────────────────────────────────────────

test('ISOLATION-10: a foreign tool invocation is flagged for the other runtime only', () => {
  const fixture =
    'INIT=$(node "$HOME/.claude/gsd-ng/bin/gsd-tools.cjs" state load 2>/dev/null)\n';
  assert.deepStrictEqual(foreignOffenders(fixture, 'opencode'), [
    '1 :: .claude/gsd-ng',
  ]);
  assert.deepStrictEqual(
    foreignOffenders(fixture, 'claude'),
    [],
    "a runtime's own config home is not foreign to it",
  );
});

test('ISOLATION-11: ordinary github paths and hostnames are not flagged', () => {
  const fixture =
    'See .github/workflows/ci.yml and .github/PULL_REQUEST_TEMPLATE.md, ' +
    'documented at api.github.com and https://cli.github.com/.\n';
  assert.deepStrictEqual(
    foreignOffenders(fixture, 'claude'),
    [],
    'a repository directory that happens to share a config-home name is correct content',
  );
});

// ── two runtimes, one home, one project ──────────────────────────────────────
//
// Everything above installs one runtime per temp dir, which is the only case in
// which "where am I installed?" cannot be answered wrongly. These install two
// under a single HOME and a single project, then drive each engine and check it
// resolved its own artifacts: its own VERSION file, its own cache directory,
// and its own override variable.
//
// The VERSION files are deliberately made to differ. Equal versions would let a
// cross-read pass by coincidence, which is how this stayed invisible.

/** Config-home overrides an engine must ignore, plus the hook's skip switches. */
const CLEARED_ENV = {
  CLAUDE_CONFIG_DIR: undefined,
  COPILOT_CONFIG_DIR: undefined,
  OPENCODE_CONFIG_DIR: undefined,
  XDG_CONFIG_HOME: undefined,
  CLAUDE_PROJECT_DIR: undefined,
  GSD_OFFLINE: undefined,
  GSD_TEST_MODE: undefined,
  GSD_SIMULATE_SANDBOX: undefined,
};

/** Newer than every doctored VERSION below, so `installed` is always reported. */
const LATEST_VERSION = '99.99.99';

const COEXIST = new Map();

/**
 * Install several runtimes into one temp dir, so they share a HOME and a
 * project, and write each one's VERSION file to the value it is keyed with.
 *
 * `runIsolatedInstall` puts home and project in fixed subdirectories of the
 * temp dir, so calling it twice with the same temp dir is what produces the
 * coexistence the rest of the suite never builds.
 *
 * Each combo is filed under its own `key`, defaulting to its runtime name. Two
 * installs of the same runtime at different scopes need distinct keys, or the
 * second would overwrite the first and the layout would silently collapse to
 * one install.
 */
function coexistOnce(key, combos) {
  if (!COEXIST.has(key)) {
    const tmpDir = fs.mkdtempSync(path.join(BASE_TMPDIR, `gsd-coexist-${key}-`));
    TEMP_DIRS.push(tmpDir);

    const installs = {};
    let home = null;
    let proj = null;
    for (const combo of combos) {
      const install = runIsolatedInstall(tmpDir, combo);
      home = install.home;
      proj = install.proj;
      fs.writeFileSync(
        path.join(install.targetDir, 'gsd-ng', 'VERSION'),
        combo.version,
        'utf8',
      );
      installs[combo.key || combo.runtime] = { ...install, version: combo.version };
    }

    assert.notEqual(home, proj, 'home and project must be distinct');
    COEXIST.set(key, { tmpDir, home, proj, installs });
  }
  return COEXIST.get(key);
}

/** A claude and an opencode global install sharing one home. */
function twoGlobals() {
  return coexistOnce('globals', [
    { runtime: 'claude', scope: 'global', version: '9.9.9-claudeglobal' },
    { runtime: 'opencode', scope: 'global', version: '0.9.0' },
  ]);
}

/** A claude global install and a copilot install inside the same project. */
function globalAndLocal() {
  return coexistOnce('mixed', [
    { runtime: 'claude', scope: 'global', version: '9.9.9-claudeglobal' },
    { runtime: 'copilot', scope: 'local', version: '7.7.7-copilotonly' },
  ]);
}

function engineEnv(home, extra = {}) {
  return {
    ...process.env,
    ...CLEARED_ENV,
    HOME: home,
    GSD_TEST_HOME: home,
    ...extra,
  };
}

/** Drive one install's own engine and return its parsed update report. */
function engineUpdate(install, home, proj, extra = {}) {
  const result = spawnSync(
    process.execPath,
    [
      path.join(install.targetDir, 'gsd-ng', 'bin', 'gsd-tools.cjs'),
      'update',
      '--dry-run',
      '--json',
    ],
    {
      encoding: 'utf8',
      timeout: 60000,
      cwd: proj,
      env: engineEnv(home, {
        // No network: the comparison target is injected rather than fetched.
        GSD_UPDATE_TEST_OVERRIDES: JSON.stringify({
          latestVersion: LATEST_VERSION,
          updateSource: 'npm',
        }),
        ...extra,
      }),
    },
  );
  assert.equal(
    result.status,
    0,
    `engine must exit 0\nstderr: ${result.stderr || ''}`,
  );
  return JSON.parse(result.stdout);
}

/** The cache directory one install's own shared resolver answers with. */
function engineCacheDir(install, home, proj, extra = {}) {
  const modulePath = path.join(
    install.targetDir,
    'gsd-ng',
    'bin',
    'lib',
    'cache-path.cjs',
  );
  const script =
    `const m = require(${JSON.stringify(modulePath)});` +
    'process.stdout.write(m.resolveUpdateCacheDir({' +
    'cwd: process.cwd(), homeDir: process.env.HOME, env: process.env }));';
  const result = spawnSync(process.execPath, ['-e', script], {
    encoding: 'utf8',
    timeout: 30000,
    cwd: proj,
    env: engineEnv(home, extra),
  });
  assert.equal(
    result.status,
    0,
    `resolver must exit 0\nstderr: ${result.stderr || ''}`,
  );
  return result.stdout.trim();
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

test('COEXIST-01: with two global installs each engine reports its own version', () => {
  const { home, proj, installs } = twoGlobals();
  assert.notEqual(home, proj, 'home and project must be distinct');

  const opencode = engineUpdate(installs.opencode, home, proj);
  assert.equal(
    opencode.installed,
    installs.opencode.version,
    'the opencode engine read another install’s VERSION file',
  );

  const claude = engineUpdate(installs.claude, home, proj);
  assert.equal(claude.installed, installs.claude.version);
  assert.notEqual(
    opencode.installed,
    claude.installed,
    'the two versions must differ or this test cannot fail',
  );
});

test('COEXIST-02: the opencode update hook writes only under its own config home', () => {
  const { tmpDir, home, proj, installs } = twoGlobals();
  const ownCache = path.join(installs.opencode.targetDir, 'cache');
  const foreignCache = path.join(installs.claude.targetDir, 'cache');
  cleanupSubdir(installs.opencode.targetDir, 'cache');
  cleanupSubdir(installs.claude.targetDir, 'cache');

  // Stub the version lookup the detached child would otherwise make over the
  // network, so the write happens and can be asserted on.
  const stub = path.join(tmpDir, 'npm-view-stub.cjs');
  fs.writeFileSync(
    stub,
    `module.exports = function () { return '${LATEST_VERSION}\\n'; };\n`,
    'utf8',
  );

  const result = spawnSync(
    process.execPath,
    [path.join(installs.opencode.targetDir, 'gsd-ng', 'hooks', 'gsd-check-update.js')],
    {
      encoding: 'utf8',
      timeout: 60000,
      cwd: proj,
      input: '{"source":"startup"}',
      env: engineEnv(home, { GSD_TEST_EXEC_NPMVIEW: stub }),
    },
  );
  assert.equal(result.status, 0, `hook must exit 0\nstderr: ${result.stderr || ''}`);

  // The child is detached, so the file appears shortly after the hook returns.
  const cacheFile = path.join(ownCache, 'gsd-update-check.json');
  for (let waited = 0; waited < 10000 && !fs.existsSync(cacheFile); waited += 50) {
    sleepSync(50);
  }

  assert.equal(
    fs.existsSync(foreignCache),
    false,
    'the hook created a cache directory under another runtime’s config home',
  );
  assert.ok(fs.existsSync(cacheFile), `no cache written at ${cacheFile}`);
  assert.equal(
    JSON.parse(fs.readFileSync(cacheFile, 'utf8')).installed,
    installs.opencode.version,
    'the cache records another install’s version',
  );
});

test('COEXIST-03: a global engine ignores a foreign install inside the project', () => {
  const { home, proj, installs } = globalAndLocal();
  assert.notEqual(home, proj, 'home and project must be distinct');
  assert.ok(
    fs.existsSync(path.join(installs.copilot.targetDir, 'gsd-ng', 'VERSION')),
    'the project must carry the second install for this to be a test',
  );

  const claude = engineUpdate(installs.claude, home, proj);
  assert.equal(
    claude.installed,
    installs.claude.version,
    'the claude engine read the project install’s VERSION file',
  );
});

test('COEXIST-04: another runtime’s override variable redirects nothing', () => {
  const { home, proj, installs } = twoGlobals();
  const override = { CLAUDE_CONFIG_DIR: installs.claude.targetDir };

  assert.equal(
    engineCacheDir(installs.opencode, home, proj, override),
    path.join(installs.opencode.targetDir, 'cache'),
    'the opencode engine resolved its cache into a claude tree',
  );
  assert.equal(
    engineUpdate(installs.opencode, home, proj, override).installed,
    installs.opencode.version,
  );
});

test('COEXIST-05: a claude engine still honours its own override variable', () => {
  // The back-compat guard. It holds whether or not self-location is in place,
  // which is the point: the fix must not move a claude install that is being
  // pointed at its own config home.
  const { home, proj, installs } = twoGlobals();
  const override = { CLAUDE_CONFIG_DIR: installs.claude.targetDir };

  assert.equal(
    engineCacheDir(installs.claude, home, proj, override),
    path.join(installs.claude.targetDir, 'cache'),
  );
  assert.equal(
    engineUpdate(installs.claude, home, proj, override).installed,
    installs.claude.version,
  );
});

// ── one runtime, two scopes: which engine runs is what decides ───────────────
//
// The tests above put two different runtimes under one home. This is the other
// coexistence, and the commoner one: the same runtime installed globally and
// again inside the project. That layout used to be answered by "local wins over
// global", and it no longer is. An installed engine resolves its own config
// home ahead of the override variable and both probes, so a global engine
// standing in a project that carries its own install still answers for the
// global one. Local shadowing is unaffected, because a local install's commands
// invoke the local engine — which is what the second test here shows.
//
// This is deliberate, not a side effect: the update-check hook is registered in
// the global settings and runs the global engine, so it must report on the
// global install rather than on whichever project the session happens to sit
// in; and with two runtimes under one home, any probe-based ordering can find
// the other runtime's install first.
//
// Both installs are the same runtime, so home and project must be distinct or
// <home>/.claude and <proj>/.claude are the same directory and everything below
// passes vacuously. Asserted in each test body, the way the shipped-tool-path
// test above guards itself.

/** A claude global install and a claude local install, one home, one project. */
function sameRuntimeBothScopes() {
  return coexistOnce('sameruntime', [
    { key: 'global', runtime: 'claude', scope: 'global', version: '8.8.8-claudeglobal' },
    { key: 'local', runtime: 'claude', scope: 'local', version: '6.6.6-claudelocal' },
  ]);
}

/** The two installs must be separable, or no assertion below can fail. */
function assertDistinctTargets({ installs }) {
  assert.notEqual(
    installs.global.targetDir,
    installs.local.targetDir,
    'the two installs must be different directories',
  );
  assert.notEqual(
    installs.global.version,
    installs.local.version,
    'the two VERSION files must differ or a cross-read passes by coincidence',
  );
}

test('SELFFIRST-01: a global engine resolves its own cache dir from inside a project holding a local install', () => {
  const layout = sameRuntimeBothScopes();
  const { home, proj, installs } = layout;
  assert.notEqual(home, proj, 'home and project must be distinct');
  assertDistinctTargets(layout);
  assert.ok(
    fs.existsSync(path.join(installs.local.targetDir, 'gsd-ng', 'VERSION')),
    'the project must carry a local install for this to be a test',
  );

  assert.equal(
    engineCacheDir(installs.global, home, proj),
    path.join(installs.global.targetDir, 'cache'),
    'the global engine resolved the project install’s cache directory',
  );
});

test('SELFFIRST-02: the local engine resolves the local cache dir, so local shadowing still holds', () => {
  const layout = sameRuntimeBothScopes();
  const { home, proj, installs } = layout;
  assert.notEqual(home, proj, 'home and project must be distinct');
  assertDistinctTargets(layout);

  assert.equal(
    engineCacheDir(installs.local, home, proj),
    path.join(installs.local.targetDir, 'cache'),
    'the local engine resolved the global install’s cache directory',
  );
});

test('SELFFIRST-03: an override variable naming another valid install of the same runtime moves nothing', () => {
  const layout = sameRuntimeBothScopes();
  const { home, proj, installs } = layout;
  assert.notEqual(home, proj, 'home and project must be distinct');
  assertDistinctTargets(layout);

  // A real install, so the override is refused on precedence rather than on
  // failing its own existence check.
  const override = { CLAUDE_CONFIG_DIR: installs.local.targetDir };
  assert.ok(
    fs.existsSync(path.join(installs.local.targetDir, 'gsd-ng', 'VERSION')),
    'the override must name a directory that would otherwise be honoured',
  );

  assert.equal(
    engineCacheDir(installs.global, home, proj, override),
    path.join(installs.global.targetDir, 'cache'),
    'the override variable outranked the engine’s own location',
  );
});

test('SELFFIRST-04: each engine reports the VERSION beside it, not the other scope’s', () => {
  const layout = sameRuntimeBothScopes();
  const { home, proj, installs } = layout;
  assert.notEqual(home, proj, 'home and project must be distinct');
  assertDistinctTargets(layout);

  const globalReport = engineUpdate(installs.global, home, proj);
  const localReport = engineUpdate(installs.local, home, proj);
  assert.equal(
    globalReport.installed,
    installs.global.version,
    'the global engine read the project install’s VERSION file',
  );
  assert.equal(
    localReport.installed,
    installs.local.version,
    'the local engine read the global install’s VERSION file',
  );
});

// ── the statusline, driven from an installed tree ────────────────────────────
//
// The engine and the update-check hook are the loud half of self-location. The
// statusline is the quiet one: it renders its update banner only when the cache
// it read agrees with the VERSION of the install it belongs to, and it used to
// find that VERSION by probing the project for any runtime's config dir. With a
// second runtime installed in the project, that probe hits the other install,
// the two versions disagree and the banner silently disappears. What a user
// sees is the rendered line, so that is what these assert on rather than an
// internal resolution call.

/** A claude global install with another runtime's install inside the project. */
function claudeGlobalForeignLocal() {
  return coexistOnce('statusline', [
    { runtime: 'claude', scope: 'global', version: '9.9.9-claudeglobal' },
    { runtime: 'opencode', scope: 'local', version: '0.9.0-opencodelocal' },
  ]);
}

/**
 * One install's copy of a hook.
 *
 * Where hooks land is the runtime's own layout decision — beside the config
 * home for one, under the engine directory for another — so both are looked
 * for rather than assumed.
 */
function installedHook(install, name) {
  const candidates = [
    path.join(install.targetDir, 'hooks', name),
    path.join(install.targetDir, 'gsd-ng', 'hooks', name),
  ];
  const found = candidates.find((p) => fs.existsSync(p));
  assert.ok(
    found,
    `install must ship ${name}, looked in:\n  ${candidates.join('\n  ')}`,
  );
  return found;
}

/** Write the update-check cache one install's own resolver answers with. */
function seedUpdateCache(install, installed) {
  const cacheDir = path.join(install.targetDir, 'cache');
  fs.mkdirSync(cacheDir, { recursive: true });
  fs.writeFileSync(
    path.join(cacheDir, 'gsd-update-check.json'),
    JSON.stringify({
      update_available: true,
      installed,
      latest: LATEST_VERSION,
      checked: Math.floor(Date.now() / 1000),
      source: 'npm',
    }),
    'utf8',
  );
}

/** Drive one install's own statusline hook and return the line it printed. */
function statuslineOutput(install, home, proj, extra = {}) {
  const result = spawnSync(
    process.execPath,
    [installedHook(install, 'gsd-statusline.js')],
    {
      encoding: 'utf8',
      timeout: 30000,
      cwd: proj,
      input: JSON.stringify({
        model: { display_name: 'Test' },
        workspace: { current_dir: proj, project_dir: proj },
      }),
      env: engineEnv(home, extra),
    },
  );
  assert.equal(
    result.status,
    0,
    `statusline must exit 0\nstderr: ${result.stderr || ''}`,
  );
  return result.stdout;
}

const UPDATE_BANNER = '/gsd:update';

/** The layout must actually be a coexistence, or nothing below can fail. */
function assertForeignLocalPresent({ home, proj, installs }) {
  assert.notEqual(home, proj, 'home and project must be distinct');
  assert.ok(
    fs.existsSync(path.join(installs.opencode.targetDir, 'gsd-ng', 'VERSION')),
    'the project must carry the other install for this to be a test',
  );
  assert.notEqual(
    installs.claude.version,
    installs.opencode.version,
    'the two VERSION files must differ or a cross-read passes by coincidence',
  );
}

test('STATUSLINE-01: an installed statusline still shows its banner with another runtime installed in the project', () => {
  const layout = claudeGlobalForeignLocal();
  assertForeignLocalPresent(layout);
  const { home, proj, installs } = layout;

  seedUpdateCache(installs.claude, installs.claude.version);

  const out = statuslineOutput(installs.claude, home, proj);
  assert.ok(
    out.includes(UPDATE_BANNER),
    `the banner was suppressed by the install in the project: ${JSON.stringify(out)}`,
  );
});

test('STATUSLINE-02: a cache matching the other install’s version raises no banner', () => {
  const layout = claudeGlobalForeignLocal();
  assertForeignLocalPresent(layout);
  const { home, proj, installs } = layout;

  // The inverse of the test above, and the half a probe gets wrong in the other
  // direction: this cache agrees with the project install's VERSION and not
  // with the running install's, so a statusline reading its own answers "no".
  seedUpdateCache(installs.claude, installs.opencode.version);

  const out = statuslineOutput(installs.claude, home, proj);
  assert.equal(
    out.includes(UPDATE_BANNER),
    false,
    `the banner was raised from the other install’s VERSION: ${JSON.stringify(out)}`,
  );
});

test('STATUSLINE-03: the staleness guard still suppresses a cache the install has moved past', () => {
  const layout = claudeGlobalForeignLocal();
  assertForeignLocalPresent(layout);
  const { home, proj, installs } = layout;

  // Self-location must not become a way of skipping the comparison: a cache
  // written before an update names a version no install on disk carries, and
  // the banner has to stay down until the next refresh.
  seedUpdateCache(installs.claude, '0.0.1-superseded');

  const out = statuslineOutput(installs.claude, home, proj);
  assert.equal(
    out.includes(UPDATE_BANNER),
    false,
    `a superseded cache raised the banner: ${JSON.stringify(out)}`,
  );
});

// ── the override variable belongs to a runtime ───────────────────────────────
//
// `detectConfigDir` honours the override variable named by the install's own
// registry row. Every other installed caller answers from its own location
// before reaching that line, so replacing the scoping with a hardcoded variable
// name moves nothing they assert on — which is why this drives the function
// directly instead.

/** What one install's own detectConfigDir answers for a base directory. */
function engineDetectConfigDir(install, baseDir, home, proj, extra = {}) {
  const modulePath = path.join(
    install.targetDir,
    'gsd-ng',
    'bin',
    'lib',
    'cache-path.cjs',
  );
  const script =
    `const m = require(${JSON.stringify(modulePath)});` +
    `process.stdout.write(String(m.detectConfigDir(${JSON.stringify(baseDir)}, process.env)));`;
  const result = spawnSync(process.execPath, ['-e', script], {
    encoding: 'utf8',
    timeout: 30000,
    cwd: proj,
    env: engineEnv(home, extra),
  });
  assert.equal(
    result.status,
    0,
    `resolver must exit 0\nstderr: ${result.stderr || ''}`,
  );
  return result.stdout.trim();
}

test('OVERRIDE-01: an installed engine honours its own override variable and ignores another runtime’s', () => {
  const { home, proj, installs } = twoGlobals();
  assert.notEqual(home, proj, 'home and project must be distinct');
  assert.ok(
    fs.existsSync(path.join(installs.claude.targetDir, 'gsd-ng', 'VERSION')),
    'the foreign override must name a real install, or it is refused for not existing rather than for not belonging',
  );

  assert.equal(
    engineDetectConfigDir(installs.opencode, proj, home, proj, {
      CLAUDE_CONFIG_DIR: installs.claude.targetDir,
    }),
    'null',
    'the opencode engine was redirected by another runtime’s override variable',
  );

  assert.equal(
    engineDetectConfigDir(installs.opencode, proj, home, proj, {
      OPENCODE_CONFIG_DIR: installs.opencode.targetDir,
    }),
    installs.opencode.targetDir,
    'the opencode engine ignored its own override variable',
  );

  assert.equal(
    engineDetectConfigDir(installs.claude, proj, home, proj, {
      CLAUDE_CONFIG_DIR: installs.claude.targetDir,
    }),
    installs.claude.targetDir,
    'the claude engine stopped honouring the variable it has always honoured',
  );
});

// ── the update-check hook, driven from an installed tree ─────────────────────
//
// The statusline reads the update cache; this hook writes it. What it records in
// `installed` is the version every later comparison is made against, so a hook
// that resolves the wrong config home poisons the cache rather than misreading
// it once — the cache lives in a config home, not in a project, so a project's
// version written into a global cache is wrong in every other project too.
//
// Two properties, and a fix satisfying one while breaking the other is the
// failure mode these are shaped around:
//
//   1. Another runtime installed in the project must never be read. The hook
//      belongs to one install and reports on that one.
//   2. An install answers for itself at whichever scope it sits. The global
//      hook records the global version even standing in a project that carries
//      a local install of the same runtime, and the local hook records the
//      local one. That is the same rule as the first, not an exception to it,
//      and the section above on one runtime at two scopes explains why the
//      older "local wins over global" reading had to go.
//
// These assert on the cache file the hook writes, which is the observable the
// statusline and the engine both consume, rather than on an internal call.

/** A claude global install with an opencode install inside the project. */
function claudeGlobalOpencodeLocal() {
  return coexistOnce('updatecheck-foreign', [
    { key: 'claude', runtime: 'claude', scope: 'global', version: '9.9.9-claudeglobal' },
    { key: 'opencode', runtime: 'opencode', scope: 'local', version: '6.6.6-opencodelocal' },
  ]);
}

/** The other direction: an opencode global install, claude inside the project. */
function opencodeGlobalClaudeLocal() {
  return coexistOnce('updatecheck-reverse', [
    { key: 'opencode', runtime: 'opencode', scope: 'global', version: '5.5.5-opencodeglobal' },
    { key: 'claude', runtime: 'claude', scope: 'local', version: '4.4.4-claudelocal' },
  ]);
}

/** A claude install at both scopes, kept apart from the layout the engine tests share. */
function updateHookBothScopes() {
  return coexistOnce('updatecheck-sameruntime', [
    { key: 'global', runtime: 'claude', scope: 'global', version: '8.8.8-claudeglobal' },
    { key: 'local', runtime: 'claude', scope: 'local', version: '3.3.3-claudelocal' },
  ]);
}

/**
 * Stand in for the version lookup the detached child would make over the
 * network, so the write happens offline and can be asserted on.
 */
function npmViewStub(tmpDir) {
  const stub = path.join(tmpDir, 'npm-view-stub.cjs');
  fs.writeFileSync(
    stub,
    `module.exports = function () { return '${LATEST_VERSION}\\n'; };\n`,
    'utf8',
  );
  return stub;
}

/**
 * Run one install's own update-check hook and return the cache it wrote.
 *
 * The cache directory is cleared first: the hook only runs when the cache is
 * stale or absent, so a leftover from an earlier test would gate it out and the
 * assertion would read a stale file.
 */
function updateHookCache(install, tmpDir, home, proj, extra = {}) {
  const cacheDir = path.join(install.targetDir, 'cache');
  cleanupSubdir(install.targetDir, 'cache');

  const result = spawnSync(
    process.execPath,
    [installedHook(install, 'gsd-check-update.js')],
    {
      encoding: 'utf8',
      timeout: 60000,
      cwd: proj,
      input: '{"source":"startup"}',
      env: engineEnv(home, {
        GSD_TEST_EXEC_NPMVIEW: npmViewStub(tmpDir),
        ...extra,
      }),
    },
  );
  assert.equal(
    result.status,
    0,
    `hook must exit 0\nstderr: ${result.stderr || ''}`,
  );

  // The child is detached, so the file appears shortly after the hook returns.
  const cacheFile = path.join(cacheDir, 'gsd-update-check.json');
  for (let waited = 0; waited < 15000 && !fs.existsSync(cacheFile); waited += 50) {
    sleepSync(50);
  }
  assert.ok(fs.existsSync(cacheFile), `no cache written at ${cacheFile}`);
  return JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
}

/** The layout must really hold two installs of differing versions. */
function assertTwoInstalls(layout, keys) {
  const { home, proj, installs } = layout;
  assert.notEqual(home, proj, 'home and project must be distinct');
  for (const key of keys) {
    assert.ok(
      fs.existsSync(path.join(installs[key].targetDir, 'gsd-ng', 'VERSION')),
      `the layout must carry the ${key} install for this to be a test`,
    );
  }
  assert.notEqual(
    installs[keys[0]].targetDir,
    installs[keys[1]].targetDir,
    'the two installs must be different directories',
  );
  assert.notEqual(
    installs[keys[0]].version,
    installs[keys[1]].version,
    'the two VERSION files must differ or a cross-read passes by coincidence',
  );
}

test('CHECKUPDATE-01: an installed update hook records its own version with another runtime installed in the project', () => {
  const layout = claudeGlobalOpencodeLocal();
  assertTwoInstalls(layout, ['claude', 'opencode']);
  const { tmpDir, home, proj, installs } = layout;

  const cache = updateHookCache(installs.claude, tmpDir, home, proj);
  assert.equal(
    cache.installed,
    installs.claude.version,
    'the claude hook recorded the project install’s VERSION',
  );
});

test('CHECKUPDATE-02: the same holds in the other direction', () => {
  const layout = opencodeGlobalClaudeLocal();
  assertTwoInstalls(layout, ['opencode', 'claude']);
  const { tmpDir, home, proj, installs } = layout;

  const cache = updateHookCache(installs.opencode, tmpDir, home, proj);
  assert.equal(
    cache.installed,
    installs.opencode.version,
    'the opencode hook recorded the project install’s VERSION',
  );
});

test('CHECKUPDATE-03: each install’s hook records the VERSION beside it, at either scope', () => {
  const layout = updateHookBothScopes();
  assertTwoInstalls(layout, ['global', 'local']);
  const { tmpDir, home, proj, installs } = layout;

  // The global hook is registered in the global settings and runs from the
  // global tree, so it reports on the global install however the project it
  // happens to sit in is equipped. A local install is reported by the local
  // hook, which the local settings register — that is what shadowing is here.
  const globalCache = updateHookCache(installs.global, tmpDir, home, proj);
  assert.equal(
    globalCache.installed,
    installs.global.version,
    'the global hook recorded the project install’s VERSION',
  );

  const localCache = updateHookCache(installs.local, tmpDir, home, proj);
  assert.equal(
    localCache.installed,
    installs.local.version,
    'the local hook recorded the global install’s VERSION',
  );
});

test('CHECKUPDATE-04: a global cache written from inside a project still raises that install’s banner elsewhere', () => {
  const layout = updateHookBothScopes();
  assertTwoInstalls(layout, ['global', 'local']);
  const { tmpDir, home, proj, installs } = layout;

  // The consequence of the rule above, and the half a project-first hook gets
  // wrong: one config home holds one cache, shared by every project the install
  // is used from. A version belonging to some project written into it disagrees
  // with the running install's VERSION, and the statusline's staleness guard
  // then suppresses the banner everywhere until the cooldown expires.
  const cache = updateHookCache(installs.global, tmpDir, home, proj);
  assert.equal(cache.update_available, true, 'the stub must offer an update');

  const elsewhere = path.join(tmpDir, 'unrelated-project');
  fs.mkdirSync(elsewhere, { recursive: true });
  assert.notEqual(elsewhere, proj, 'the second directory must be a different one');

  for (const where of [proj, elsewhere]) {
    const out = statuslineOutput(installs.global, home, where);
    assert.ok(
      out.includes(UPDATE_BANNER),
      `the banner was suppressed in ${where}: ${JSON.stringify(out)}`,
    );
  }
});

test('ISOLATION-12: a fourth runtime widens the foreign set with no edit here', () => {
  const before = foreignDirNames('claude');
  const extended = {
    ...RUNTIMES,
    fictional: {
      configHome: { globalDirName: '.fictional', localDirName: '.fictional-local' },
    },
  };
  const after_ = foreignDirNames('claude', extended);

  assert.ok(after_.includes('.fictional'));
  assert.ok(after_.includes('.fictional-local'));
  assert.ok(
    after_.length > before.length,
    'a new registry row must widen the foreign set on its own',
  );
  assert.deepStrictEqual(
    foreignDirNames('fictional', extended).includes('.fictional'),
    false,
    "the new runtime's own directories must not be foreign to it",
  );
});

// ── a global install leaves the working directory alone ──────────────────────
//
// Everything above reads an install tree, and an install tree cannot show a
// file written *beside* it. A global install used to create a project rules
// file in whatever directory the installer happened to be invoked from — an
// empty one with no version control, no planning directory and no package
// manifest included — because the layout resolved that file against the
// working directory at both scopes.
//
// So the directory below is deliberately not a project. That is the condition
// the defect needed: run from inside one, the same install looks correct, which
// is why every check written before this one passed against the broken code.
//
// The comparison is a full snapshot of the directory taken before and after,
// not a lookup of one filename. A check naming the one file this defect wrote
// would say nothing about the next file to appear beside it.
//
// The local half of this property — the block merged into pre-existing user
// content, and the uninstall that strips it and hands the file back byte for
// byte — is already asserted over a real install in tests/install-js.test.cjs
// and is not repeated here.

/** Every entry under `dir`: files by content hash, directories as themselves. */
function snapshotDir(dir) {
  const snap = {};
  const walk = (abs) => {
    for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
      const full = path.join(abs, entry.name);
      const rel = path.relative(dir, full).split(path.sep).join('/');
      if (entry.isDirectory()) {
        snap[rel] = 'dir';
        walk(full);
      } else {
        snap[rel] = crypto
          .createHash('sha256')
          .update(fs.readFileSync(full))
          .digest('hex');
      }
    }
  };
  walk(dir);
  return snap;
}

/** The markers that would make the working directory look like a project. */
const PROJECT_MARKERS = ['.git', '.planning', 'package.json'];

function assertNotAProject(dir) {
  for (const marker of PROJECT_MARKERS) {
    assert.ok(
      !fs.existsSync(path.join(dir, marker)),
      `${marker} must be absent — a working directory that is a project is the ` +
        'case that already behaved correctly',
    );
  }
}

const CWD_USER_RULES = '# House rules\n\nMine. Written before GSD existed.\n';
const CWD_USER_README = '# Not a project\n\nJust a directory.\n';

/** Write a seed file, creating whatever directory it hangs off. */
function seedFile(dir, rel, content) {
  const abs = path.join(dir, ...rel.split('/'));
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

/**
 * What a rules file looks like after a local install has merged into it: the
 * user's own lines, then a block between the markers the registry carries.
 * Only a local install's uninstall may touch that block.
 */
function mergedRulesContent(runtime) {
  const rt = RUNTIMES[runtime];
  return `${CWD_USER_RULES}\n${rt.GSD_BLOCK_OPEN}\nBlock body.\n${rt.GSD_BLOCK_CLOSE}\n`;
}

/**
 * Seed the runtime's own project rules file plus one unrelated file. The name
 * comes from the registry, so a fourth runtime is seeded with no edit here.
 */
function seedUserFiles(dir, runtime, { merged = false } = {}) {
  seedFile(
    dir,
    RUNTIMES[runtime].PROJECT_RULES_FILE,
    merged ? mergedRulesContent(runtime) : CWD_USER_RULES,
  );
  seedFile(dir, 'README.md', CWD_USER_README);
}

function freshCwdDir(label) {
  const tmpDir = fs.mkdtempSync(path.join(BASE_TMPDIR, `gsd-cwd-${label}-`));
  TEMP_DIRS.push(tmpDir);
  return tmpDir;
}

/** An empty snapshot on both sides would make any comparison vacuous. */
function assertRealInstall(targetDir) {
  assert.ok(
    Object.keys(snapshotDir(targetDir)).length > 50,
    `the install must have produced a real tree at ${targetDir}`,
  );
}

for (const runtime of Object.keys(RUNTIMES)) {
  test(`CWD-01 (${runtime}): a global install writes nothing into a working directory that is not a project`, () => {
    const tmpDir = freshCwdDir(`01-${runtime}`);
    const proj = path.join(tmpDir, 'proj');
    fs.mkdirSync(proj, { recursive: true });
    assertNotAProject(proj);

    const before = snapshotDir(proj);
    const { targetDir } = runIsolatedInstall(tmpDir, {
      runtime,
      scope: 'global',
    });
    assertRealInstall(targetDir);

    assert.deepStrictEqual(
      snapshotDir(proj),
      before,
      `${runtime}: a global install changed the directory it was run from`,
    );
  });

  test(`CWD-02 (${runtime}): a global install leaves user files in the working directory byte-identical`, () => {
    const tmpDir = freshCwdDir(`02-${runtime}`);
    const proj = path.join(tmpDir, 'proj');
    fs.mkdirSync(proj, { recursive: true });
    seedUserFiles(proj, runtime);
    assertNotAProject(proj);

    const before = snapshotDir(proj);
    const { targetDir } = runIsolatedInstall(tmpDir, {
      runtime,
      scope: 'global',
    });
    assertRealInstall(targetDir);

    assert.deepStrictEqual(
      snapshotDir(proj),
      before,
      `${runtime}: a global install has no project to merge into, so a rules ` +
        'file it finds in the working directory is the user\'s and stays as it is',
    );
  });

  test(`CWD-03 (${runtime}): a global uninstall leaves a rules file it never wrote where it found it`, () => {
    const tmpDir = freshCwdDir(`03-${runtime}`);
    const proj = path.join(tmpDir, 'proj');
    fs.mkdirSync(proj, { recursive: true });

    const { targetDir } = runIsolatedInstall(tmpDir, {
      runtime,
      scope: 'global',
    });
    assertRealInstall(targetDir);

    // Seeded with a merged block, which is what a local install into the same
    // directory would have left. It belongs to that install, not to this one.
    seedUserFiles(proj, runtime, { merged: true });
    assertNotAProject(proj);
    const before = snapshotDir(proj);

    runIsolatedUninstall(tmpDir, { runtime, scope: 'global' });

    assert.deepStrictEqual(
      snapshotDir(proj),
      before,
      `${runtime}: the global install did not write this file, so its ` +
        'uninstall must not remove or rewrite it',
    );
  });
}
