/**
 * GSD Tools Test Helpers
 */

const assert = require('node:assert');
const { execSync, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TOOLS_PATH = path.join(__dirname, '..', 'gsd-ng', 'bin', 'gsd-tools.cjs');

/**
 * Run gsd-tools command.
 *
 * @param {string|string[]} args - Command string (shell-interpreted) or array
 *   of arguments (shell-bypassed via spawnSync, safe for JSON and dollar signs).
 * @param {string} cwd - Working directory.
 * @param {object} envOverrides - Extra env vars merged on top of process.env (default: {}).
 */
function runGsdTools(args, cwd = process.cwd(), envOverrides = {}) {
  const env = { ...process.env, ...envOverrides };
  let result;
  if (Array.isArray(args)) {
    result = spawnSync(process.execPath, [TOOLS_PATH, ...args], {
      cwd,
      encoding: 'utf-8',
      env,
    });
  } else {
    // Shell-interpreted: pass through shell so quotes and special chars are handled correctly
    result = spawnSync(`node "${TOOLS_PATH}" ${args}`, [], {
      cwd,
      encoding: 'utf-8',
      env,
      shell: true,
    });
  }
  const success = result.status === 0;
  if (success) {
    return {
      success: true,
      output: (result.stdout || '').trim(),
      stderr: (result.stderr || '').trim(),
    };
  } else {
    return {
      success: false,
      output: (result.stdout || '').trim(),
      error: (result.stderr || '').trim() || (result.error ? result.error.message : 'Unknown error'),
      stderr: (result.stderr || '').trim(),
    };
  }
}

// Resolve a writable temp base dir — os.tmpdir() may point to /tmp/claude which doesn't
// exist in the Claude Code sandbox. Fall back through known-writable candidates.
//
// The result is realpath'd. On macOS the temp root is /var/folders/... symlinked to
// /private/var/folders/..., and anything that resolves a path through require() or
// realpath reports the /private form. Comparing an unresolved base against such a
// value passes on Linux, where the temp root is not a symlink, and fails on macOS —
// so resolve once here rather than at each assertion.
function resolveTmpDir() {
  const candidates = [process.env.TMPDIR, os.tmpdir(), `/tmp/claude-${process.getuid()}`, '/tmp'].filter(Boolean);
  for (const dir of candidates) {
    try { if (fs.existsSync(dir)) return fs.realpathSync(dir); } catch {}
  }
  try { return fs.realpathSync(os.tmpdir()); } catch { return os.tmpdir(); } // last resort
}

// Create temp directory structure
function createTempProject() {
  const tmpDir = fs.mkdtempSync(path.join(resolveTmpDir(), 'gsd-test-'));
  fs.mkdirSync(path.join(tmpDir, '.planning', 'phases'), { recursive: true });
  return tmpDir;
}

// Create temp directory structure with mock .claude/agents/*.md files
//
// @param {string[]} [agentNames=['gsd-planner','gsd-executor','gsd-verifier']] - Agent names
// @param {object} [opts={}] - Options
// @param {object} [opts.config] - If provided, written to .planning/config.json
// @returns {string} tmpDir
function createTempProjectWithAgents(agentNames = ['gsd-planner', 'gsd-executor', 'gsd-verifier'], opts = {}) {
  const tmpDir = createTempProject();
  fs.mkdirSync(path.join(tmpDir, '.claude', 'agents'), { recursive: true });
  for (const name of agentNames) {
    const content = `---\nname: ${name}\ndescription: Mock agent for tests\ntools: Read, Bash\ncolor: blue\n---\n\n# ${name}\n\nMock body.\n`;
    fs.writeFileSync(path.join(tmpDir, '.claude', 'agents', `${name}.md`), content, 'utf8');
  }
  if (opts.config !== undefined) {
    fs.mkdirSync(path.join(tmpDir, '.planning'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, '.planning', 'config.json'), JSON.stringify(opts.config, null, 2), 'utf8');
  }
  return tmpDir;
}

// Create temp directory with initialized git repo and at least one commit
//
// @param {object} [opts={}] - Optional scaffolding options
// @param {string} [opts.contextContent] - If provided, writes this content to
//   .planning/phases/test-phase/test-CONTEXT.md before the initial commit.
function createTempGitProject(opts = {}) {
  const tmpDir = fs.mkdtempSync(path.join(resolveTmpDir(), 'gsd-test-'));
  fs.mkdirSync(path.join(tmpDir, '.planning', 'phases'), { recursive: true });

  execSync('git init', { cwd: tmpDir, stdio: 'pipe' });
  execSync('git config user.email "test@test.com"', { cwd: tmpDir, stdio: 'pipe' });
  execSync('git config user.name "Test"', { cwd: tmpDir, stdio: 'pipe' });
  execSync('git config commit.gpgsign false', { cwd: tmpDir, stdio: 'pipe' });

  fs.writeFileSync(
    path.join(tmpDir, '.planning', 'PROJECT.md'),
    '# Project\n\nTest project.\n'
  );

  if (opts.contextContent) {
    const phaseDir = path.join(tmpDir, '.planning', 'phases', 'test-phase');
    fs.mkdirSync(phaseDir, { recursive: true });
    fs.writeFileSync(path.join(phaseDir, 'test-CONTEXT.md'), opts.contextContent);
  }

  execSync('git add -A', { cwd: tmpDir, stdio: 'pipe' });
  execSync('git commit -m "initial commit"', { cwd: tmpDir, stdio: 'pipe' });

  return tmpDir;
}

function cleanup(tmpDir) {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// Delete a subdirectory (or any known path) inside a temp project.
// Use this instead of bare fs.rmSync(path.join(...)) so lint rules stay clean.
function cleanupSubdir(base, ...segments) {
  fs.rmSync(path.join(base, ...segments), { recursive: true, force: true });
}

/**
 * Create a submodule workspace with one or more submodule repos.
 *
 * Each submodule directory is initialized as its own git repo AND
 * registered as a gitlink in the workspace index (simulating `git submodule add`
 * without requiring a real accessible remote).
 *
 * @param {Array<{name: string, path: string, remoteUrl: string}>} submoduleDefs - Submodule definitions
 * @param {object} opts - Optional scaffolding
 * @param {boolean} opts.roadmap - If true, seed .planning/ROADMAP.md with minimal phase content
 * @param {boolean} opts.state - If true, seed .planning/STATE.md with minimal content
 * @param {string} opts.phaseDir - If provided, create this phase directory under .planning/phases/
 * @returns {{ workspaceDir: string, subDirs: string[] }}
 */
function createSubmoduleWorkspace(submoduleDefs, opts = {}) {
  // submoduleDefs = [{ name, path, remoteUrl }]
  const workspaceDir = fs.mkdtempSync(path.join(resolveTmpDir(), 'gsd-ws-test-'));
  fs.mkdirSync(path.join(workspaceDir, '.planning', 'phases'), { recursive: true });
  execSync('git init', { cwd: workspaceDir, stdio: 'pipe' });
  execSync('git config user.email "test@test.com"', { cwd: workspaceDir, stdio: 'pipe' });
  execSync('git config user.name "Test"', { cwd: workspaceDir, stdio: 'pipe' });
  execSync('git config commit.gpgsign false', { cwd: workspaceDir, stdio: 'pipe' });
  execSync('git remote add origin "https://github.com/workspace/root.git"', { cwd: workspaceDir, stdio: 'pipe' });

  // Build .gitmodules content
  let gitmodulesContent = '';
  const subDirs = [];

  for (const def of submoduleDefs) {
    const subDir = path.join(workspaceDir, def.path);
    fs.mkdirSync(subDir, { recursive: true });

    // Init submodule repo
    execSync('git init', { cwd: subDir, stdio: 'pipe' });
    execSync('git config user.email "test@test.com"', { cwd: subDir, stdio: 'pipe' });
    execSync('git config user.name "Test"', { cwd: subDir, stdio: 'pipe' });
    execSync('git config commit.gpgsign false', { cwd: subDir, stdio: 'pipe' });
    execSync(`git remote add origin "${def.remoteUrl}"`, { cwd: subDir, stdio: 'pipe' });
    fs.writeFileSync(path.join(subDir, 'README.md'), `# ${def.name}\n`);
    execSync('git add README.md', { cwd: subDir, stdio: 'pipe' });
    execSync('git commit -m "initial"', { cwd: subDir, stdio: 'pipe' });

    // Register the submodule as a gitlink in the workspace index.
    // This uses `git update-index --add --cacheinfo 160000,<sha>,<path>` to
    // create a gitlink (mode 160000) pointing to the submodule's HEAD commit.
    const subHeadResult = execSync('git rev-parse HEAD', { cwd: subDir, encoding: 'utf-8', stdio: 'pipe' }).trim();
    execSync(
      `git update-index --add --cacheinfo 160000,${subHeadResult},${def.path}`,
      { cwd: workspaceDir, stdio: 'pipe' }
    );

    gitmodulesContent += `[submodule "${def.name}"]\n\tpath = ${def.path}\n\turl = ${def.remoteUrl}\n`;
    subDirs.push(subDir);
  }

  fs.writeFileSync(path.join(workspaceDir, '.gitmodules'), gitmodulesContent);
  execSync('git add .gitmodules', { cwd: workspaceDir, stdio: 'pipe' });
  execSync('git commit -m "add submodules"', { cwd: workspaceDir, stdio: 'pipe' });

  // Optional scaffolding for init tests
  if (opts.roadmap) {
    fs.writeFileSync(
      path.join(workspaceDir, '.planning', 'ROADMAP.md'),
      '# Roadmap\n\n## Phase Details\n\n### Phase 1: Test\n**Goal:** Test phase\n**Requirements:** none\n**Depends on:** nothing\n**Plans:** 1 plans\n\nPlans:\n- [ ] 01-01-PLAN.md\n'
    );
  }
  if (opts.state) {
    fs.writeFileSync(
      path.join(workspaceDir, '.planning', 'STATE.md'),
      '---\ngsd_state_version: 1.0\nmilestone: test\ncurrent_phase: 1\ncurrent_plan: Not started\nstatus: testing\n---\n\n# Project State\n'
    );
  }
  if (opts.phaseDir) {
    const pDir = path.join(workspaceDir, '.planning', 'phases', opts.phaseDir);
    fs.mkdirSync(pDir, { recursive: true });
    fs.writeFileSync(path.join(pDir, '01-01-PLAN.md'), '---\nphase: 01-test\nplan: 01\ntype: execute\nwave: 1\ndepends_on: []\nfiles_modified: []\nautonomous: true\nrequirements: []\nmust_haves:\n  truths: []\n  artifacts: []\n  key_links: []\n---\n\n<objective>Test</objective>\n');
  }

  return { workspaceDir, subDirs };
}

/**
 * Simulate a submodule update in the workspace git (advances the gitlink).
 * Creates a new commit in the submodule and updates the workspace gitlink,
 * making the submodule path appear in `git diff --name-only HEAD`.
 *
 * @param {string} workspaceDir - Root workspace directory
 * @param {string} submodulePath - Relative path to the submodule within workspace
 */
function touchSubmodule(workspaceDir, submodulePath) {
  const subDir = path.join(workspaceDir, submodulePath);
  // Create a new commit in the submodule to advance its HEAD
  fs.writeFileSync(path.join(subDir, 'touched.txt'), String(Date.now()));
  execSync('git add touched.txt', { cwd: subDir, stdio: 'pipe' });
  execSync('git commit -m "touched"', { cwd: subDir, stdio: 'pipe' });
  // Update the workspace gitlink to point to the new commit (staged, not committed)
  const newSha = execSync('git rev-parse HEAD', { cwd: subDir, encoding: 'utf-8', stdio: 'pipe' }).trim();
  execSync(
    `git update-index --cacheinfo 160000,${newSha},${submodulePath}`,
    { cwd: workspaceDir, stdio: 'pipe' }
  );
}

/**
 * Wait for a spawned child to create its readiness flag file.
 *
 * Lock-wait tests observe a window in which a child must not have written. The
 * window has to start from a child that is loaded and running, or a slow start
 * means nothing was observed and the test passes without having tested
 * anything. Expiry asserts rather than hanging, so a child that died reports as
 * a failure instead of a timeout.
 *
 * @param {string} flagPath - File the child creates once it is ready
 * @param {string} label - How to name the child in the failure message
 * @param {number} [timeoutMs=10000] - How long to wait before failing
 */
async function waitForReadyFlag(flagPath, label, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (!fs.existsSync(flagPath)) {
    assert.ok(Date.now() < deadline, `${label} never signalled readiness`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

/**
 * Record a spawned child's exit so waitForExit can wait on it later.
 *
 * The promise has to be created at spawn time: a child that exits before anyone
 * asks about it has already emitted 'close', and a listener attached afterwards
 * never fires.
 *
 * @param {import('child_process').ChildProcess} child
 * @returns {import('child_process').ChildProcess} the same child
 */
function trackExit(child) {
  child._exited = new Promise((r) => child.on('close', r));
  return child;
}

/**
 * Wait for a tracked child to exit, failing rather than hanging.
 *
 * Nothing bounds a test in this suite — the runner passes no --test-timeout — so
 * an await on a child's exit is only as bounded as the child is. The lock-wait
 * tests are bounded today by the acquire budget, which is a property of the
 * library under test: the thing being asserted on cannot also be what guarantees
 * the assertion is reached. The default deadline sits above that budget so a
 * child legitimately waiting out a held lock still reports its own error rather
 * than being cut short here.
 *
 * @param {import('child_process').ChildProcess} child - passed through trackExit
 * @param {string} label - How to name the child in the failure message
 * @param {number} [timeoutMs=30000] - deadline, above LOCK_ACQUIRE_BUDGET_MS
 * @returns {Promise<number>} the child's exit code
 */
async function waitForExit(child, label, timeoutMs = 30000) {
  assert.ok(child._exited, `${label} was not passed through trackExit`);
  const EXPIRED = Symbol('expired');
  let timer;
  const expired = new Promise((r) => {
    timer = setTimeout(() => r(EXPIRED), timeoutMs);
  });
  const result = await Promise.race([child._exited, expired]);
  clearTimeout(timer);
  if (result === EXPIRED) child.kill('SIGKILL');
  assert.notStrictEqual(
    result,
    EXPIRED,
    `${label} had not exited ${timeoutMs}ms after it was expected to`,
  );
  return result;
}

module.exports = { runGsdTools, createTempProject, createTempProjectWithAgents, createTempGitProject, cleanup, cleanupSubdir, resolveTmpDir, TOOLS_PATH, createSubmoduleWorkspace, touchSubmodule, waitForReadyFlag, trackExit, waitForExit };
