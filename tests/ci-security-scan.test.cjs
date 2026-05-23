'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { scanForInjection } = require('../gsd-ng/bin/lib/security.cjs');

const REPO_ROOT = path.join(__dirname, '..');

test('CI-EMIT-01: scanForInjection findings feed ::error/::warning as RULE-ID: description', () => {
  // High-confidence hit → goes to blocked → rendered in ::error
  const high = scanForInjection('[click here](javascript:alert(1))');
  assert.ok(high.blocked.length > 0, 'expected a high-confidence block');
  for (const entry of high.blocked) {
    assert.ok(
      /^[A-Z][A-Z0-9-]+: .+/.test(entry),
      `blocked entry must be "RULE-ID: description", got: ${entry}`,
    );
  }
  // Confirm the specific new rule ID surfaces in the scanner-forwarded string
  assert.ok(
    high.blocked.some((b) => b.startsWith('MD-LINK-JS-SCHEME:')),
    `expected MD-LINK-JS-SCHEME in blocked, got: ${JSON.stringify(high.blocked)}`,
  );

  // Medium-confidence hit → goes to findings → rendered in ::warning
  const med = scanForInjection('exfil @~/.ssh/id_rsa');
  assert.ok(
    med.findings.some((f) => f.startsWith('AT-FILE-CREDENTIAL-PATH:')),
    `expected AT-FILE-CREDENTIAL-PATH in findings, got: ${JSON.stringify(med.findings)}`,
  );
});

test('SCAN-PATHS-01: ci-security-scan.cjs SCAN_PATHS set-equals security-scan.yml paths trigger', () => {
  // Read SCAN_PATHS from ci-security-scan.cjs
  const scanScript = fs.readFileSync(
    path.join(REPO_ROOT, 'scripts', 'ci-security-scan.cjs'),
    'utf8',
  );
  const match = scanScript.match(/const SCAN_PATHS\s*=\s*\[([^\]]+)\]/);
  assert.ok(match, 'SCAN_PATHS constant must exist in ci-security-scan.cjs');
  const scanPaths = match[1]
    .split(',')
    .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
    .filter(Boolean);

  // Read paths: trigger from security-scan.yml
  const workflowYml = fs.readFileSync(
    path.join(REPO_ROOT, '.github', 'workflows', 'security-scan.yml'),
    'utf8',
  );
  const pathsBlock = workflowYml.match(/paths:\s*\n((?:\s+-\s+.+\n?)+)/);
  assert.ok(pathsBlock, 'security-scan.yml must have a paths: trigger block');
  const workflowPaths = pathsBlock[1]
    .split('\n')
    .map((l) => l.replace(/^\s+-\s+['"]?/, '').replace(/['"]?\s*$/, ''))
    .filter(Boolean)
    .map((p) => p.replace(/\/\*\*$/, '/')); // strip /** glob suffix

  const scanSet = new Set(scanPaths);
  const workflowSet = new Set(workflowPaths);

  for (const p of workflowSet) {
    assert.ok(
      scanSet.has(p),
      `SCAN_PATHS missing '${p}' (in security-scan.yml but not SCAN_PATHS)`,
    );
  }
  for (const p of scanSet) {
    assert.ok(
      workflowSet.has(p),
      `SCAN_PATHS has '${p}' not in security-scan.yml paths:`,
    );
  }
});
