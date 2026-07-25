#!/usr/bin/env node
// Per-file coverage gate. Reads coverage/coverage-summary.json (produced by
// c8 --reporter=json-summary) and asserts each file under gsd-ng/bin/lib/
// independently meets the configured thresholds. The default floor is the
// strict 95/90/80 (lines/branches/functions) ratchet established by the
// coverage uplift work; FLOORS keys override the default for specific files
// where a documented exception applies.
'use strict';

const fs = require('fs');
const path = require('path');

const FLOORS = {
  default: { lines: 95, branches: 90, functions: 80 },
};

const summaryPath = path.join('coverage', 'coverage-summary.json');
if (!fs.existsSync(summaryPath)) {
  console.error('coverage gate: coverage-summary.json missing at', summaryPath);
  process.exit(2);
}

const summary = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
const cwd = process.cwd();

let failed = 0;
let checked = 0;
for (const absPath of Object.keys(summary)) {
  if (absPath === 'total') continue;
  if (!absPath.includes('/gsd-ng/bin/lib/')) continue;
  const rel = path.relative(cwd, absPath);
  const floor = FLOORS[rel] || FLOORS.default;
  const lines = summary[absPath].lines.pct;
  const branches = summary[absPath].branches.pct;
  const functions = summary[absPath].functions.pct;
  const fail =
    lines < floor.lines ||
    branches < floor.branches ||
    functions < floor.functions;
  if (fail) {
    console.error(
      `FAIL ${rel}: lines=${lines}/${floor.lines} branches=${branches}/${floor.branches} functions=${functions}/${floor.functions}`,
    );
    failed++;
  }
  checked++;
}

if (failed > 0) {
  console.error(`coverage gate: ${failed}/${checked} files failed thresholds`);
  process.exit(1);
}
console.log(`coverage gate: ${checked}/${checked} files passed`);
