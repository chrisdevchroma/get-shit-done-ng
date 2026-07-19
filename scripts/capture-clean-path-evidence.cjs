#!/usr/bin/env node
// Captures reproducible evidence for the installer manifest/clean-path tests.
//
// Runs the roster of installer-path tests, records the VERBATIM stdout plus
// environment provenance to a .log, and a machine-readable per-test roster to
// a .json.
//
// Anti-manufacture contract: this script records what happened, it never
// asserts what should have happened. It refuses to emit artifacts at all
// unless every roster entry is present in the capture AND every one of them
// passed. An empty or partial run exits non-zero and writes nothing, so a
// green artifact cannot be produced from a run that did not happen.
//
// Usage:
//   node scripts/capture-clean-path-evidence.cjs [--out-dir <path>] [--test-file <path>]
//
// Env:
//   GSD_EVIDENCE_SANDBOX = enabled | disabled   (default: unknown)
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..');

// --- roster: the single source of truth ------------------------------------
// Every test id that must appear in the capture. The test-name pattern below
// is DERIVED from this list, so the roster cannot drift out of sync with the
// command that produces the output.
const ROSTER = [
  'MANIFEST-STAB-01',
  'MANIFEST-DISK-01',
  'MANIFEST-V2-01',
  'MANIFEST-V2-02',
  'MANIFEST-V2-03',
  'MANIFEST-V2-04',
  'CLEAN-01',
  'CLEAN-02',
  'CLEAN-03',
  'CLEAN-04',
  'CLEANEV-01',
  'CLEANEV-02',
  'CLEANEV-03',
];

const ARTIFACT_BASENAME = '63-clean-path-evidence';
const DEFAULT_OUT_DIR = path.join(
  REPO_ROOT,
  '..',
  '.planning',
  'phases',
  '63-installer-clean-path-hardening',
);
const DEFAULT_TEST_FILE = 'tests/install-js.test.cjs';

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function parseArgs(argv) {
  const opts = { outDir: DEFAULT_OUT_DIR, testFile: DEFAULT_TEST_FILE };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--out-dir' && argv[i + 1]) {
      opts.outDir = argv[++i];
    } else if (argv[i] === '--test-file' && argv[i + 1]) {
      opts.testFile = argv[++i];
    } else {
      console.error(`Unknown argument: ${argv[i]}`);
      process.exit(2);
    }
  }
  return opts;
}

function git(args) {
  const r = spawnSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : 'unknown';
}

function fail(message) {
  console.error(`CAPTURE FAILED: ${message}`);
  console.error('No artifacts were written.');
  process.exit(1);
}

function main() {
  const opts = parseArgs(process.argv.slice(2));

  const pattern = `^(${ROSTER.map(escapeRegex).join('|')})`;
  const testArgs = ['--test', '--test-name-pattern', pattern, opts.testFile];
  const command = `node --test --test-name-pattern="${pattern}" ${opts.testFile}`;

  const run = spawnSync(process.execPath, testArgs, {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: 300000,
    maxBuffer: 64 * 1024 * 1024,
  });

  if (run.error) {
    fail(`could not run the test command: ${run.error.message}`);
  }

  const stdout = run.stdout || '';

  const results = [];
  const seen = new Map();
  for (const line of stdout.split('\n')) {
    const m = /^\s*(not ok|ok) \d+ - (.+)$/.exec(line);
    if (!m) continue;
    const status = m[1] === 'ok' ? 'pass' : 'fail';
    const name = m[2].replace(/\s+#\s+(SKIP|TODO).*$/i, '').trim();
    const testId = name.split(':')[0].trim();
    if (!ROSTER.includes(testId)) continue;
    if (seen.has(testId)) continue;
    seen.set(testId, status);
    results.push({ test_id: testId, test: name, status });
  }

  const totals = {};
  for (const key of ['tests', 'pass', 'fail']) {
    const m = new RegExp(`^# ${key} (\\d+)$`, 'm').exec(stdout);
    if (!m) {
      fail(
        `the capture has no "# ${key}" summary line — the run did not complete`,
      );
    }
    totals[key] = Number(m[1]);
  }

  const missing = ROSTER.filter((id) => !seen.has(id));
  if (missing.length > 0) {
    for (const id of missing) {
      console.error(`MISSING FROM CAPTURE: ${id}`);
    }
    console.error('--- captured output ---');
    console.error(stdout);
    fail(
      `${missing.length} of ${ROSTER.length} roster tests did not appear in the capture`,
    );
  }

  const red = results.filter((r) => r.status !== 'pass');
  if (red.length > 0) {
    for (const r of red) {
      console.error(`NOT OK: ${r.test}`);
    }
    console.error('--- captured output ---');
    console.error(stdout);
    fail(`${red.length} roster test(s) failed`);
  }

  if (totals.fail !== 0) {
    console.error('--- captured output ---');
    console.error(stdout);
    fail(`the run reported "# fail ${totals.fail}"`);
  }

  if (totals.tests !== ROSTER.length) {
    fail(
      `the run reported "# tests ${totals.tests}" but the roster has ${ROSTER.length} entries`,
    );
  }

  if (run.status !== 0) {
    fail(`the test command exited ${run.status}`);
  }

  const pkg = JSON.parse(
    fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'),
  );
  const provenance = {
    captured: new Date().toISOString(),
    git_sha: git(['rev-parse', 'HEAD']),
    git_branch: git(['rev-parse', '--abbrev-ref', 'HEAD']),
    version: pkg.version,
    node: process.version,
    platform: `${process.platform} ${os.release()}`,
    sandbox: process.env.GSD_EVIDENCE_SANDBOX || 'unknown',
    command,
  };

  fs.mkdirSync(opts.outDir, { recursive: true });

  const header = [
    '# Installer clean-path evidence',
    '#',
    `# captured  : ${provenance.captured}`,
    `# git_sha   : ${provenance.git_sha}`,
    `# git_branch: ${provenance.git_branch}`,
    `# version   : ${provenance.version}`,
    `# node      : ${provenance.node}`,
    `# platform  : ${provenance.platform}`,
    `# sandbox   : ${provenance.sandbox}`,
    `# command   : ${provenance.command}`,
    '#',
    `# Regenerate: node scripts/capture-clean-path-evidence.cjs --out-dir <dir>`,
    '',
    '--- VERBATIM TAP OUTPUT ---',
    '',
  ].join('\n');

  const logPath = path.join(opts.outDir, `${ARTIFACT_BASENAME}.log`);
  fs.writeFileSync(logPath, header + stdout);

  const jsonPath = path.join(opts.outDir, `${ARTIFACT_BASENAME}.json`);
  const json = {
    ...provenance,
    exit_code: run.status,
    totals,
    results,
  };
  fs.writeFileSync(jsonPath, JSON.stringify(json, null, 2) + '\n');

  console.log(`Wrote ${logPath}`);
  console.log(`Wrote ${jsonPath}`);
  console.log(
    `tests ${totals.tests} / pass ${totals.pass} / fail ${totals.fail}`,
  );
  process.exit(0);
}

main();
