'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');
const { resolveTmpDir, cleanup } = require('./helpers.cjs');

const GSD_TOOLS = path.join(__dirname, '..', 'gsd-ng', 'bin', 'gsd-tools.cjs');

test('test-baseline lib module', async (t) => {
  await t.test('exports captureBaseline function', () => {
    const mod = require('../gsd-ng/bin/lib/test-baseline.cjs');
    assert.equal(
      typeof mod.captureBaseline,
      'function',
      'captureBaseline should be a function',
    );
  });

  await t.test('exports compareBaseline function', () => {
    const mod = require('../gsd-ng/bin/lib/test-baseline.cjs');
    assert.equal(
      typeof mod.compareBaseline,
      'function',
      'compareBaseline should be a function',
    );
  });

  await t.test(
    'gsd-tools test capture-baseline with no args produces Too few arguments error',
    () => {
      let output = '';
      let exited = false;
      try {
        execSync(`node "${GSD_TOOLS}" test capture-baseline`, {
          encoding: 'utf-8',
          stdio: ['pipe', 'pipe', 'pipe'],
        });
      } catch (err) {
        exited = true;
        output = (err.stdout || '') + (err.stderr || '');
      }
      assert.ok(exited, 'should have exited with error');
      assert.ok(
        output.includes('Too few arguments'),
        `expected "Too few arguments" in output, got: ${output}`,
      );
    },
  );

  await t.test('gsd-tools test with unknown subcommand produces error', () => {
    let output = '';
    let exited = false;
    try {
      execSync(`node "${GSD_TOOLS}" test unknown-subcmd arg1 arg2`, {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      exited = true;
      output = (err.stdout || '') + (err.stderr || '');
    }
    assert.ok(exited, 'should have exited with error');
    assert.ok(
      output.includes('Unknown test subcommand') ||
        output.includes('unknown-subcmd'),
      `expected error for unknown subcommand, got: ${output}`,
    );
  });

  await t.test(
    'F-002: captureBaseline progress output goes to stderr, not stdout',
    () => {
      const tmpBase = resolveTmpDir();
      const tmpDir = fs.mkdtempSync(path.join(tmpBase, 'gsd-baseline-test-'));
      try {
        const outputFile = path.join(tmpDir, 'baseline.json');
        const {
          captureBaseline,
        } = require('../gsd-ng/bin/lib/test-baseline.cjs');
        const originalStdoutWrite = process.stdout.write.bind(process.stdout);
        const originalStderrWrite = process.stderr.write.bind(process.stderr);
        const stdoutChunks = [];
        const stderrChunks = [];
        process.stdout.write = (chunk) => {
          stdoutChunks.push(String(chunk));
          return true;
        };
        process.stderr.write = (chunk) => {
          stderrChunks.push(String(chunk));
          return true;
        };
        try {
          captureBaseline(
            JSON.stringify([{ dir: '.', command: 'echo test' }]),
            outputFile,
          );
        } finally {
          process.stdout.write = originalStdoutWrite;
          process.stderr.write = originalStderrWrite;
        }
        const stdoutOutput = stdoutChunks.join('');
        const stderrOutput = stderrChunks.join('');
        assert.ok(
          stderrOutput.includes('.: passing'),
          `captureBaseline must report per-entry progress on stderr, got: ${stderrOutput}`,
        );
        assert.ok(
          !stdoutOutput.includes(': passing') &&
            !stdoutOutput.includes(': failing'),
          `captureBaseline should not write progress to stdout, got: ${stdoutOutput}`,
        );
      } finally {
        cleanup(tmpDir);
      }
    },
  );

  // F-001: corrupt baseline file should produce a stderr warning
  await t.test(
    'F-001: compareBaseline emits stderr warning when baseline file is corrupt JSON',
    () => {
      const tmpBase = resolveTmpDir();
      const tmpDir = fs.mkdtempSync(path.join(tmpBase, 'gsd-baseline-test-'));
      try {
        const corruptFile = path.join(tmpDir, 'corrupt-baseline.json');
        fs.writeFileSync(corruptFile, 'NOT_VALID_JSON{{{', 'utf-8');
        const {
          compareBaseline,
        } = require('../gsd-ng/bin/lib/test-baseline.cjs');
        // Intercept stderr to verify warning is emitted
        const originalWrite = process.stderr.write.bind(process.stderr);
        const stderrChunks = [];
        process.stderr.write = (chunk) => {
          stderrChunks.push(String(chunk));
          return true;
        };
        try {
          compareBaseline(
            JSON.stringify([{ dir: '.', command: 'echo ok' }]),
            corruptFile,
          );
        } finally {
          process.stderr.write = originalWrite;
        }
        const stderrOutput = stderrChunks.join('');
        assert.ok(
          stderrOutput.includes('corrupt') ||
            stderrOutput.includes('baseline') ||
            stderrOutput.includes('parse'),
          `Expected a stderr warning about corrupt baseline file, got: ${stderrOutput}`,
        );
      } finally {
        cleanup(tmpDir);
      }
    },
  );
});

// Branch-coverage extensions for catch blocks, countDiff display variants, and
// the hasNewFailure path. Source: gsd-ng/bin/lib/test-baseline.cjs lines
// 38-41 (captureBaseline catch), 96-99 (compareBaseline catch), 116-119
// (countDiff ternary), 195-220 (display block — three branches), 224-230
// (hasNewFailure true path).
test('test-baseline branch coverage', async (t) => {
  const {
    captureBaseline,
    compareBaseline,
  } = require('../gsd-ng/bin/lib/test-baseline.cjs');

  // ---- captureBaseline catch (lines 39-41) ----

  await t.test(
    'captureBaseline catches non-zero exit and records err.status as exit_code',
    () => {
      const tmpDir = fs.mkdtempSync(
        path.join(resolveTmpDir(), 'gsd-baseline-catch-'),
      );
      try {
        const outputFile = path.join(tmpDir, 'baseline.json');
        // Suppress stderr progress lines from captureBaseline ("  .: failing (pre-existing)")
        const origStderr = process.stderr.write.bind(process.stderr);
        process.stderr.write = () => true;
        try {
          captureBaseline(
            JSON.stringify([
              {
                dir: '.',
                command: 'sh -c "echo on-stdout; echo on-stderr 1>&2; exit 7"',
              },
            ]),
            outputFile,
          );
        } finally {
          process.stderr.write = origStderr;
        }
        const baselines = JSON.parse(fs.readFileSync(outputFile, 'utf-8'));
        assert.equal(
          baselines['.'].exit_code,
          7,
          'exit_code should reflect err.status from execSync failure',
        );
      } finally {
        cleanup(tmpDir);
      }
    },
  );

  await t.test(
    'captureBaseline falls back to exit_code 1 when err.status is null (signal-killed)',
    () => {
      const tmpDir = fs.mkdtempSync(
        path.join(resolveTmpDir(), 'gsd-baseline-fallback-'),
      );
      try {
        const outputFile = path.join(tmpDir, 'baseline.json');
        const origStderr = process.stderr.write.bind(process.stderr);
        process.stderr.write = () => true;
        try {
          // A self-SIGKILL'd shell makes execSync throw with err.status === null
          // and err.signal === 'SIGKILL'. The `err.status || 1` fallback at line 39
          // is the only path that produces exit_code === 1 in this case.
          captureBaseline(
            JSON.stringify([{ dir: '.', command: 'sh -c "kill -9 $$"' }]),
            outputFile,
          );
        } finally {
          process.stderr.write = origStderr;
        }
        const baselines = JSON.parse(fs.readFileSync(outputFile, 'utf-8'));
        assert.equal(
          baselines['.'].exit_code,
          1,
          'exit_code should fall back to 1 when err.status is null',
        );
      } finally {
        cleanup(tmpDir);
      }
    },
  );

  // ---- compareBaseline catch (lines 97-99) ----

  await t.test(
    'compareBaseline catches command failure and records post status as fail',
    () => {
      const tmpDir = fs.mkdtempSync(
        path.join(resolveTmpDir(), 'gsd-compare-catch-'),
      );
      try {
        const baselineFile = path.join(tmpDir, 'baseline.json');
        // Pre-build a baseline saying the dir was passing (so we can also exercise hasNewFailure later)
        fs.writeFileSync(
          baselineFile,
          JSON.stringify({
            '.': {
              captured: '2026-01-01T00:00:00Z',
              command: 'true',
              exit_code: 0,
              tests: null,
              pass: null,
              fail: null,
            },
          }),
        );
        const stdoutChunks = [];
        const origStdout = process.stdout.write.bind(process.stdout);
        process.stdout.write = (c) => {
          stdoutChunks.push(String(c));
          return true;
        };
        try {
          compareBaseline(
            JSON.stringify([{ dir: '.', command: 'sh -c "exit 3"' }]),
            baselineFile,
          );
        } finally {
          process.stdout.write = origStdout;
        }
        const out = stdoutChunks.join('');
        assert.match(
          out,
          /✗ fail/,
          'Pre-UAT column should render "✗ fail" glyph for failed run',
        );
      } finally {
        cleanup(tmpDir);
      }
    },
  );

  // ---- countDiff > 0 branch (lines 197-206) ----

  await t.test(
    'compareBaseline emits "(+N)" when post-run reports more tests than baseline',
    () => {
      const tmpDir = fs.mkdtempSync(
        path.join(resolveTmpDir(), 'gsd-compare-plus-'),
      );
      try {
        const baselineFile = path.join(tmpDir, 'baseline.json');
        fs.writeFileSync(
          baselineFile,
          JSON.stringify({
            '.': {
              captured: '2026-01-01T00:00:00Z',
              command: 'sh -c "printf \\"# tests 5\\n\\""',
              exit_code: 0,
              tests: 5,
              pass: 5,
              fail: 0,
            },
          }),
        );
        const chunks = [];
        const orig = process.stdout.write.bind(process.stdout);
        process.stdout.write = (c) => {
          chunks.push(String(c));
          return true;
        };
        try {
          compareBaseline(
            JSON.stringify([{ dir: '.', command: 'printf "# tests 8\\n"' }]),
            baselineFile,
          );
        } finally {
          process.stdout.write = orig;
        }
        const out = chunks.join('');
        assert.match(
          out,
          /Tests: 5 → 8 \(\+3\)/,
          `expected "Tests: 5 → 8 (+3)" line, got: ${out}`,
        );
      } finally {
        cleanup(tmpDir);
      }
    },
  );

  // ---- countDiff < 0 branch (lines 207-216) ----

  await t.test(
    'compareBaseline emits "count dropped" warning when post-run reports fewer tests',
    () => {
      const tmpDir = fs.mkdtempSync(
        path.join(resolveTmpDir(), 'gsd-compare-drop-'),
      );
      try {
        const baselineFile = path.join(tmpDir, 'baseline.json');
        fs.writeFileSync(
          baselineFile,
          JSON.stringify({
            '.': {
              captured: '2026-01-01T00:00:00Z',
              command: 'echo seed',
              exit_code: 0,
              tests: 10,
              pass: 10,
              fail: 0,
            },
          }),
        );
        const chunks = [];
        const orig = process.stdout.write.bind(process.stdout);
        process.stdout.write = (c) => {
          chunks.push(String(c));
          return true;
        };
        try {
          compareBaseline(
            JSON.stringify([{ dir: '.', command: 'printf "# tests 7\\n"' }]),
            baselineFile,
          );
        } finally {
          process.stdout.write = orig;
        }
        const out = chunks.join('');
        assert.match(
          out,
          /Tests: 10 → 7 \(-3 ⚠ count dropped\)/,
          `expected drop warning, got: ${out}`,
        );
      } finally {
        cleanup(tmpDir);
      }
    },
  );

  // ---- countDiff === 0 branch (lines 218 — implicit no-op) ----

  await t.test(
    'compareBaseline emits no test-count line when counts are equal',
    () => {
      const tmpDir = fs.mkdtempSync(
        path.join(resolveTmpDir(), 'gsd-compare-equal-'),
      );
      try {
        const baselineFile = path.join(tmpDir, 'baseline.json');
        fs.writeFileSync(
          baselineFile,
          JSON.stringify({
            '.': {
              captured: '2026-01-01T00:00:00Z',
              command: 'echo seed',
              exit_code: 0,
              tests: 4,
              pass: 4,
              fail: 0,
            },
          }),
        );
        const chunks = [];
        const orig = process.stdout.write.bind(process.stdout);
        process.stdout.write = (c) => {
          chunks.push(String(c));
          return true;
        };
        try {
          compareBaseline(
            JSON.stringify([{ dir: '.', command: 'printf "# tests 4\\n"' }]),
            baselineFile,
          );
        } finally {
          process.stdout.write = orig;
        }
        const out = chunks.join('');
        assert.doesNotMatch(
          out,
          /Tests: \d+ → \d+/,
          `expected no Tests-N→M line for equal counts, got: ${out}`,
        );
      } finally {
        cleanup(tmpDir);
      }
    },
  );

  // ---- countDiff null branch (line 117 — ternary false side) ----

  await t.test(
    'compareBaseline emits no test-count line when post-run TAP count is absent',
    () => {
      const tmpDir = fs.mkdtempSync(
        path.join(resolveTmpDir(), 'gsd-compare-null-'),
      );
      try {
        const baselineFile = path.join(tmpDir, 'baseline.json');
        // Baseline has tests=5, but post-run output below contains no "# tests N" line,
        // so postTests will parse as null → countDiff null → display block skipped.
        fs.writeFileSync(
          baselineFile,
          JSON.stringify({
            '.': {
              captured: '2026-01-01T00:00:00Z',
              command: 'echo seed',
              exit_code: 0,
              tests: 5,
              pass: 5,
              fail: 0,
            },
          }),
        );
        const chunks = [];
        const orig = process.stdout.write.bind(process.stdout);
        process.stdout.write = (c) => {
          chunks.push(String(c));
          return true;
        };
        try {
          compareBaseline(
            JSON.stringify([{ dir: '.', command: 'echo no-tap-here' }]),
            baselineFile,
          );
        } finally {
          process.stdout.write = orig;
        }
        const out = chunks.join('');
        assert.doesNotMatch(
          out,
          /Tests: \d+ →/,
          `expected no test-count line when post-run lacks TAP, got: ${out}`,
        );
      } finally {
        cleanup(tmpDir);
      }
    },
  );

  // ---- hasNewFailure true branch (lines 224-230) ----

  await t.test(
    'compareBaseline reports NEW_FAILURES=true when baseline pass becomes post-run fail',
    () => {
      const tmpDir = fs.mkdtempSync(
        path.join(resolveTmpDir(), 'gsd-compare-newfail-'),
      );
      try {
        const baselineFile = path.join(tmpDir, 'baseline.json');
        fs.writeFileSync(
          baselineFile,
          JSON.stringify({
            '.': {
              captured: '2026-01-01T00:00:00Z',
              command: 'true',
              exit_code: 0,
              tests: null,
              pass: null,
              fail: null,
            },
          }),
        );
        const chunks = [];
        const orig = process.stdout.write.bind(process.stdout);
        process.stdout.write = (c) => {
          chunks.push(String(c));
          return true;
        };
        try {
          compareBaseline(
            JSON.stringify([
              { dir: '.', command: 'sh -c "echo regression-output; exit 1"' },
            ]),
            baselineFile,
          );
        } finally {
          process.stdout.write = orig;
        }
        const out = chunks.join('');
        assert.match(
          out,
          /NEW_FAILURES=true/,
          `expected NEW_FAILURES=true, got: ${out}`,
        );
        assert.match(
          out,
          /New failure in \./,
          `expected per-dir failure detail block, got: ${out}`,
        );
        assert.match(
          out,
          /regression-output/,
          `expected captured output to be echoed in failure detail, got: ${out}`,
        );
      } finally {
        cleanup(tmpDir);
      }
    },
  );

  // ---- captureBaseline TAP-absent path (lines 50-52 falsy ternary side) ----

  await t.test(
    'captureBaseline records null tests/pass/fail when TAP summary lines are absent',
    () => {
      const tmpDir = fs.mkdtempSync(
        path.join(resolveTmpDir(), 'gsd-baseline-no-tap-'),
      );
      try {
        const outputFile = path.join(tmpDir, 'baseline.json');
        const origStderr = process.stderr.write.bind(process.stderr);
        process.stderr.write = () => true;
        try {
          captureBaseline(
            JSON.stringify([
              { dir: '.', command: 'echo plain-output-with-no-tap' },
            ]),
            outputFile,
          );
        } finally {
          process.stderr.write = origStderr;
        }
        const baselines = JSON.parse(fs.readFileSync(outputFile, 'utf-8'));
        assert.equal(baselines['.'].tests, null);
        assert.equal(baselines['.'].pass, null);
        assert.equal(baselines['.'].fail, null);
      } finally {
        cleanup(tmpDir);
      }
    },
  );

  // ---- captureBaseline + compareBaseline non-"." dir paths (lines 28 + 86 ternary RHS) ----

  await t.test(
    'captureBaseline resolves runDir under cwd when dir is not "."',
    () => {
      const tmpDir = fs.mkdtempSync(
        path.join(resolveTmpDir(), 'gsd-baseline-subdir-'),
      );
      try {
        // Create a subdir we can cd into via the test entry's `dir` field
        const subDir = path.join(tmpDir, 'subproject');
        fs.mkdirSync(subDir, { recursive: true });
        const outputFile = path.join(tmpDir, 'baseline.json');

        // captureBaseline uses process.cwd() as base — chdir to tmpDir so 'subproject'
        // resolves under it. Save and restore cwd to avoid polluting other tests.
        const prevCwd = process.cwd();
        const origStderr = process.stderr.write.bind(process.stderr);
        process.stderr.write = () => true;
        try {
          process.chdir(tmpDir);
          captureBaseline(
            JSON.stringify([
              {
                dir: 'subproject',
                command: 'printf "# tests 2\\n# pass 2\\n# fail 0\\n"',
              },
            ]),
            outputFile,
          );
        } finally {
          process.stderr.write = origStderr;
          process.chdir(prevCwd);
        }
        const baselines = JSON.parse(fs.readFileSync(outputFile, 'utf-8'));
        assert.equal(
          baselines['subproject'].tests,
          2,
          'should resolve runDir to <cwd>/subproject and capture TAP counts',
        );
        assert.equal(baselines['subproject'].exit_code, 0);
      } finally {
        cleanup(tmpDir);
      }
    },
  );

  await t.test(
    'compareBaseline resolves runDir under cwd when dir is not "."',
    () => {
      const tmpDir = fs.mkdtempSync(
        path.join(resolveTmpDir(), 'gsd-compare-subdir-'),
      );
      try {
        const subDir = path.join(tmpDir, 'subproject');
        fs.mkdirSync(subDir, { recursive: true });
        const baselineFile = path.join(tmpDir, 'baseline.json');
        fs.writeFileSync(
          baselineFile,
          JSON.stringify({
            subproject: {
              captured: '2026-01-01T00:00:00Z',
              command: 'true',
              exit_code: 0,
              tests: 2,
              pass: 2,
              fail: 0,
            },
          }),
        );

        const chunks = [];
        const origStdout = process.stdout.write.bind(process.stdout);
        process.stdout.write = (c) => {
          chunks.push(String(c));
          return true;
        };
        const prevCwd = process.cwd();
        try {
          process.chdir(tmpDir);
          compareBaseline(
            JSON.stringify([
              { dir: 'subproject', command: 'printf "# tests 2\\n"' },
            ]),
            baselineFile,
          );
        } finally {
          process.stdout.write = origStdout;
          process.chdir(prevCwd);
        }
        const out = chunks.join('');
        assert.match(
          out,
          /subproject/,
          `expected subproject row in banner, got: ${out}`,
        );
        assert.match(out, /✓ pass/, 'subproject command should pass');
      } finally {
        cleanup(tmpDir);
      }
    },
  );

  // ---- baseline-not-found "none" status (lines 105-107 + line 165 baseline glyph) ----

  await t.test(
    'compareBaseline shows "- none" baseline column when dir is missing from baseline JSON',
    () => {
      const tmpDir = fs.mkdtempSync(
        path.join(resolveTmpDir(), 'gsd-compare-none-'),
      );
      try {
        const baselineFile = path.join(tmpDir, 'baseline.json');
        // Empty baseline JSON — no entry for dir '.'
        fs.writeFileSync(baselineFile, JSON.stringify({}));
        const chunks = [];
        const origStdout = process.stdout.write.bind(process.stdout);
        process.stdout.write = (c) => {
          chunks.push(String(c));
          return true;
        };
        try {
          compareBaseline(
            JSON.stringify([{ dir: '.', command: 'true' }]),
            baselineFile,
          );
        } finally {
          process.stdout.write = origStdout;
        }
        const out = chunks.join('');
        assert.match(
          out,
          /- none/,
          `expected "- none" baseline-column glyph, got: ${out}`,
        );
      } finally {
        cleanup(tmpDir);
      }
    },
  );

  // ---- pre-existing-failures suffix (line 191 ternary truthy side) ----

  await t.test(
    'compareBaseline appends "(pre-existing failures: N)" when baseline already failed',
    () => {
      const tmpDir = fs.mkdtempSync(
        path.join(resolveTmpDir(), 'gsd-compare-pre-existing-'),
      );
      try {
        const baselineFile = path.join(tmpDir, 'baseline.json');
        // Baseline marks the dir as already failing (exit_code !== 0 and !== -1 → 'fail')
        fs.writeFileSync(
          baselineFile,
          JSON.stringify({
            '.': {
              captured: '2026-01-01T00:00:00Z',
              command: 'false',
              exit_code: 1,
              tests: null,
              pass: null,
              fail: null,
            },
          }),
        );
        const chunks = [];
        const origStdout = process.stdout.write.bind(process.stdout);
        process.stdout.write = (c) => {
          chunks.push(String(c));
          return true;
        };
        try {
          compareBaseline(
            JSON.stringify([{ dir: '.', command: 'sh -c "exit 1"' }]),
            baselineFile,
          );
        } finally {
          process.stdout.write = origStdout;
        }
        const out = chunks.join('');
        assert.match(
          out,
          /pre-existing failures: 1/,
          `expected pre-existing failures suffix, got: ${out}`,
        );
        // And NEW_FAILURES should be false because the failure isn't new
        assert.match(out, /NEW_FAILURES=false/);
      } finally {
        cleanup(tmpDir);
      }
    },
  );

  // ---- hasNewFailure false branch (line 231-233 — already covered, but pin the
  // NEW_FAILURES=false output explicitly to lock both display halves of the
  // overall summary banner) ----

  await t.test(
    'compareBaseline reports NEW_FAILURES=false when no new regressions appear',
    () => {
      const tmpDir = fs.mkdtempSync(
        path.join(resolveTmpDir(), 'gsd-compare-clean-'),
      );
      try {
        const baselineFile = path.join(tmpDir, 'baseline.json');
        fs.writeFileSync(
          baselineFile,
          JSON.stringify({
            '.': {
              captured: '2026-01-01T00:00:00Z',
              command: 'true',
              exit_code: 0,
              tests: null,
              pass: null,
              fail: null,
            },
          }),
        );
        const chunks = [];
        const orig = process.stdout.write.bind(process.stdout);
        process.stdout.write = (c) => {
          chunks.push(String(c));
          return true;
        };
        try {
          compareBaseline(
            JSON.stringify([{ dir: '.', command: 'true' }]),
            baselineFile,
          );
        } finally {
          process.stdout.write = orig;
        }
        const out = chunks.join('');
        assert.match(
          out,
          /NEW_FAILURES=false/,
          `expected NEW_FAILURES=false, got: ${out}`,
        );
      } finally {
        cleanup(tmpDir);
      }
    },
  );

  // A command killed by the timeout produces no TAP summary. Recording that as
  // a failing suite makes an unfinished run indistinguishable from a red one,
  // and a baseline that claims "already failing" suppresses new-failure
  // detection on the next comparison — silently disabling regression triage.
  await t.test(
    'a timed-out capture records unknown, never a failing baseline',
    () => {
      const tmpBase = resolveTmpDir();
      const tmpDir = fs.mkdtempSync(path.join(tmpBase, 'gsd-baseline-tmo-'));
      const prev = process.env.GSD_TEST_TIMEOUT_MS;
      try {
        process.env.GSD_TEST_TIMEOUT_MS = '50';
        const outputFile = path.join(tmpDir, 'baseline.json');
        delete require.cache[
          require.resolve('../gsd-ng/bin/lib/test-baseline.cjs')
        ];
        const {
          captureBaseline,
        } = require('../gsd-ng/bin/lib/test-baseline.cjs');

        const origErr = process.stderr.write.bind(process.stderr);
        const errChunks = [];
        process.stderr.write = (c) => {
          errChunks.push(String(c));
          return true;
        };
        try {
          captureBaseline(
            JSON.stringify([{ dir: '.', command: 'sleep 5' }]),
            outputFile,
          );
        } finally {
          process.stderr.write = origErr;
        }

        const recorded = JSON.parse(fs.readFileSync(outputFile, 'utf-8'))['.'];
        assert.equal(
          recorded.exit_code,
          -2,
          `timed-out run must record the timeout sentinel, got ${recorded.exit_code}`,
        );
        assert.notEqual(
          recorded.exit_code,
          1,
          'a timeout must not be recorded as a plain failing exit',
        );
        assert.match(
          errChunks.join(''),
          /unknown \(timed out/,
          'progress line must say the state is unknown, not "failing"',
        );
      } finally {
        if (prev === undefined) delete process.env.GSD_TEST_TIMEOUT_MS;
        else process.env.GSD_TEST_TIMEOUT_MS = prev;
        delete require.cache[
          require.resolve('../gsd-ng/bin/lib/test-baseline.cjs')
        ];
        cleanup(tmpDir);
      }
    },
  );

  // The safety property the sentinel exists for: an unknown baseline must not
  // be read as "was already failing", because that is what suppresses the
  // triage prompt and lets a real regression through as pre-existing.
  await t.test('an unknown baseline does not mask a new failure', () => {
    const tmpBase = resolveTmpDir();
    const tmpDir = fs.mkdtempSync(path.join(tmpBase, 'gsd-baseline-mask-'));
    try {
      const baselineFile = path.join(tmpDir, 'baseline.json');
      fs.writeFileSync(
        baselineFile,
        JSON.stringify({
          '.': {
            captured: '2026-01-01T00:00:00.000Z',
            command: 'false',
            exit_code: -2,
            tests: null,
            pass: null,
            fail: null,
          },
        }),
      );
      const {
        compareBaseline,
      } = require('../gsd-ng/bin/lib/test-baseline.cjs');

      const chunks = [];
      const orig = process.stdout.write.bind(process.stdout);
      process.stdout.write = (c) => {
        chunks.push(String(c));
        return true;
      };
      try {
        compareBaseline(
          JSON.stringify([{ dir: '.', command: 'false' }]),
          baselineFile,
        );
      } finally {
        process.stdout.write = orig;
      }
      const out = chunks.join('');
      assert.match(
        out,
        /NEW_FAILURES=true/,
        `an unknown baseline must fail safe, got: ${out}`,
      );
      assert.match(
        out,
        /\? unknown/,
        `baseline column must show unknown, got: ${out}`,
      );
    } finally {
      cleanup(tmpDir);
    }
  });

  // The pre-fix behaviour, pinned so it cannot return: a baseline that really
  // did observe a red suite still suppresses the prompt.
  await t.test('a genuinely failing baseline still suppresses triage', () => {
    const tmpBase = resolveTmpDir();
    const tmpDir = fs.mkdtempSync(path.join(tmpBase, 'gsd-baseline-red-'));
    try {
      const baselineFile = path.join(tmpDir, 'baseline.json');
      fs.writeFileSync(
        baselineFile,
        JSON.stringify({
          '.': {
            captured: '2026-01-01T00:00:00.000Z',
            command: 'false',
            exit_code: 1,
            tests: 10,
            pass: 9,
            fail: 1,
          },
        }),
      );
      const {
        compareBaseline,
      } = require('../gsd-ng/bin/lib/test-baseline.cjs');

      const chunks = [];
      const orig = process.stdout.write.bind(process.stdout);
      process.stdout.write = (c) => {
        chunks.push(String(c));
        return true;
      };
      try {
        compareBaseline(
          JSON.stringify([{ dir: '.', command: 'false' }]),
          baselineFile,
        );
      } finally {
        process.stdout.write = orig;
      }
      const out = chunks.join('');
      assert.match(
        out,
        /NEW_FAILURES=false/,
        `a real pre-existing failure must stay suppressed, got: ${out}`,
      );
    } finally {
      cleanup(tmpDir);
    }
  });
});
