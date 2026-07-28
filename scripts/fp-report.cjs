#!/usr/bin/env node
'use strict';

/**
 * False-Positive Report — measures detector firing on benign content
 *
 * Reuses the scanner in gsd-ng/bin/lib/security.cjs. No duplicate pattern
 * definitions, no duplicate thresholds.
 *
 * Two corpora are walked:
 *
 *   repo_walk  — the directories of this repository whose contents become
 *                agent context. Real content, thin on planning prose.
 *
 *   gsd_prose  — tests/fixtures/security-coverage/gsd-prose-benign.jsonl, a
 *                hand-authored corpus of planning prose that describes detector
 *                behaviour. Every entry is benign by construction.
 *
 * Run it after adding or widening a rule, before choosing that rule's tier:
 *
 *   npm run fp:report
 *
 * Always exits 0. This is a measurement instrument, not a gate — the gate is
 * tests/security-fp-corpus.test.cjs, which compares these same numbers against
 * the committed budget in tests/fixtures/security-coverage/fp-budget.json.
 *
 * This module is required by that test, so the report and the gate can never
 * drift onto different corpora.
 */

const fs = require('fs');
const path = require('path');

const {
  scanForInjection,
  ENTROPY_PARAMS,
  shannonEntropy,
  stripFencedCodeBlocks,
} = require('../gsd-ng/bin/lib/security.cjs');

// Repository root, resolved from this file. scripts/ sits directly beneath it,
// so one level up is the root and nothing here can reach outside the package.
const REPO_ROOT = path.join(__dirname, '..');

const GSD_PROSE_PATH = path.join(
  REPO_ROOT,
  'tests',
  'fixtures',
  'security-coverage',
  'gsd-prose-benign.jsonl',
);

// Directories whose contents become agent context, plus the top-level prose
// files. Mirrors the intent of SCAN_PATHS in ci-security-scan.cjs: measure
// false positives over the same material the CI gate inspects.
const WALK_ROOTS = [
  'gsd-ng',
  'agents',
  'commands',
  'hooks',
  'docs',
  'scripts',
  '.github',
];

const WALK_EXTENSIONS = ['.md', '.cjs', '.js', '.json', '.yml', '.yaml'];

const SKIP_DIRS = new Set(['node_modules', '.git', 'coverage']);

/**
 * Paths that must never enter the repository walk.
 *
 * tests/fixtures/security-coverage/ holds the detector's own corpora: vendored
 * attack samples, and the hand-authored benign corpus whose entries are written
 * to trip rules on purpose. Both would turn the walk baseline into noise.
 *
 * The walk roots above already exclude tests/, but relying on that would let a
 * future root addition silently widen the corpus. The predicate is asserted
 * directly by the test suite.
 *
 * @param {string} rel - repository-relative path, forward slashes
 * @returns {boolean}
 */
function isExcludedFromWalk(rel) {
  const p = rel.split(path.sep).join('/');
  if (p.startsWith('tests/')) return true;
  if (p.startsWith('benchmarks/')) return true;
  if (p.endsWith('.jsonl')) return true;
  return false;
}

/**
 * Recursively collect scannable files beneath one walk root.
 *
 * @param {string} absDir
 * @param {string[]} out
 */
function collectFiles(absDir, out) {
  let dirents;
  try {
    dirents = fs.readdirSync(absDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const d of dirents) {
    if (d.isDirectory()) {
      if (SKIP_DIRS.has(d.name)) continue;
      collectFiles(path.join(absDir, d.name), out);
      continue;
    }
    if (!d.isFile()) continue;
    if (!WALK_EXTENSIONS.includes(path.extname(d.name))) continue;
    const abs = path.join(absDir, d.name);
    const rel = path.relative(REPO_ROOT, abs).split(path.sep).join('/');
    if (isExcludedFromWalk(rel)) continue;
    out.push({ ref: rel, abs });
  }
}

/**
 * Every file in the repository walk, as { ref, abs, content }.
 * @returns {Array<{ref: string, abs: string, content: string}>}
 */
function walkRepoFiles() {
  const found = [];
  for (const root of WALK_ROOTS) {
    collectFiles(path.join(REPO_ROOT, root), found);
  }
  // Top-level prose files (AGENTS.md, CLAUDE.md, README.md, ...).
  for (const name of fs.readdirSync(REPO_ROOT)) {
    if (path.extname(name) !== '.md') continue;
    const abs = path.join(REPO_ROOT, name);
    if (!fs.statSync(abs).isFile()) continue;
    if (isExcludedFromWalk(name)) continue;
    found.push({ ref: name, abs });
  }
  return found.map((f) => ({
    ...f,
    content: fs.readFileSync(f.abs, 'utf8'),
  }));
}

/** @returns {object[]} parsed entries of the GSD-prose corpus */
function loadGsdProse() {
  const raw = fs.readFileSync(GSD_PROSE_PATH, 'utf8').trim();
  if (!raw) return [];
  return raw.split('\n').map((line, i) => {
    try {
      return JSON.parse(line);
    } catch (e) {
      throw new Error(`gsd-prose-benign.jsonl line ${i + 1}: ${e.message}`);
    }
  });
}

// A scan result entry is a rule identifier, then a colon, then a description,
// optionally suffixed with an evasion marker. Entropy findings and the Unicode
// advisories carry no identifier and are handled separately.
const RULE_ENTRY = /^([A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+):\s/;

/**
 * Rule IDs tripped by a scan result, across both tiers.
 * @param {{blocked: string[], findings: string[]}} result
 * @returns {string[]}
 */
function patternRuleIds(result) {
  const ids = [];
  for (const entry of [...result.blocked, ...result.findings]) {
    const m = RULE_ENTRY.exec(String(entry));
    if (m) ids.push(m[1]);
  }
  return [...new Set(ids)];
}

const ENTROPY_ENTRY = /^\[entropy\].*H=([0-9.]+), offset (\d+)-(\d+)/;

/**
 * Entropy segments reported by a scan result.
 * @param {{findings: string[]}} result
 * @returns {Array<{H: number, start: number, end: number}>}
 */
function entropySegments(result) {
  const out = [];
  for (const entry of result.findings) {
    const m = ENTROPY_ENTRY.exec(String(entry));
    if (m) {
      out.push({
        H: Number(m[1]),
        start: Number(m[2]),
        end: Number(m[3]),
      });
    }
  }
  return out;
}

/**
 * Peak entropy over every window alignment, not only the STEP-aligned windows
 * the detector samples, so the value cannot move when surrounding bytes shift.
 *
 * Content shorter than one window is scored whole, matching the detector.
 * Partial tail windows of longer content are excluded: their length varies with
 * total content length, which is the same instability. That is a one-sided gap
 * against the detector, recorded under `_entropy_metric` in fp-budget.json.
 *
 * Shares the detector's window constants and its short-content scoring; the
 * long-content path computes entropy inline to keep the walk O(1) per step.
 *
 * @param {string} content
 * @returns {{max_H: number, start: number, end: number}|null}
 */
function peakEntropyAnyAlignment(content) {
  const { WINDOW, MIN_SEGMENT } = ENTROPY_PARAMS;
  const scannable = stripFencedCodeBlocks(content);
  if (scannable.length < MIN_SEGMENT) return null;

  if (scannable.length < WINDOW) {
    return {
      max_H: shannonEntropy(scannable),
      start: 0,
      end: scannable.length,
    };
  }

  // H = log2(N) - (1/N) * sum(c * log2 c) for a fixed window size N, so the sum
  // is all that has to be carried between positions — O(1) per step.
  const term = (c) => (c > 0 ? c * Math.log2(c) : 0);
  const logN = Math.log2(WINDOW);
  const counts = new Map();
  let running = 0;
  const bump = (ch, delta) => {
    const before = counts.get(ch) || 0;
    const after = before + delta;
    running -= term(before);
    running += term(after);
    if (after === 0) counts.delete(ch);
    else counts.set(ch, after);
  };

  // Rescore a candidate from the exact integer counts, in sorted order: the
  // running sum carries step-count-dependent rounding, which is the same
  // byte-offset sensitivity this function exists to remove.
  const exactH = () =>
    logN -
    [...counts.values()].sort((a, b) => a - b).reduce((s, c) => s + term(c), 0) /
      WINDOW;

  for (let i = 0; i < WINDOW; i++) bump(scannable[i], 1);

  let best = { max_H: exactH(), start: 0, end: WINDOW };

  for (let i = WINDOW; i < scannable.length; i++) {
    bump(scannable[i - WINDOW], -1);
    bump(scannable[i], 1);
    if (logN - running / WINDOW > best.max_H - 1e-9) {
      const H = exactH();
      if (H > best.max_H) {
        best = { max_H: H, start: i - WINDOW + 1, end: i + 1 };
      }
    }
  }
  return best;
}

/**
 * Measure one corpus.
 *
 * Every item is scanned twice: once with entropy off, isolating pattern hits,
 * and once with entropy on, isolating the statistical signal.
 *
 * @param {Array<{ref: string, content: string}>} items
 * @returns {object} measurement
 */
function measureCorpus(items) {
  const patternFp = {};
  const entropyItems = [];
  let maxH = 0;

  for (const item of items) {
    const patternOnly = scanForInjection(item.content, {
      external: true,
      entropy: false,
    });
    for (const ruleId of patternRuleIds(patternOnly)) {
      if (!patternFp[ruleId]) patternFp[ruleId] = { count: 0, examples: [] };
      patternFp[ruleId].count += 1;
      if (patternFp[ruleId].examples.length < 3) {
        patternFp[ruleId].examples.push(item.ref);
      }
    }

    const peak = peakEntropyAnyAlignment(item.content);
    if (peak && peak.max_H > ENTROPY_PARAMS.THRESHOLD) {
      maxH = Math.max(maxH, peak.max_H);
      entropyItems.push({
        ref: item.ref,
        max_H: peak.max_H,
        segments: [`${peak.start}-${peak.end}`],
      });
    }
  }

  return {
    items,
    itemCount: items.length,
    patternFp,
    entropy: {
      count: entropyItems.length,
      max_H: maxH,
      items: entropyItems,
    },
  };
}

function measureRepoWalk() {
  return measureCorpus(walkRepoFiles());
}

function measureGsdProse() {
  return measureCorpus(
    loadGsdProse().map((e) => ({ ref: e.id, content: e.text, entry: e })),
  );
}

// ─── Report ──────────────────────────────────────────────────────────────────

function printCorpus(title, unit, measured) {
  console.log('');
  console.log(title);
  console.log('='.repeat(title.length));
  console.log(`${unit} scanned: ${measured.itemCount}`);
  console.log('');

  const rows = Object.entries(measured.patternFp).sort(
    (a, b) => b[1].count - a[1].count || a[0].localeCompare(b[0]),
  );

  if (rows.length === 0) {
    console.log(`  no rule fired on any of the ${measured.itemCount} ${unit}`);
  } else {
    const idWidth = Math.max(7, ...rows.map((r) => r[0].length));
    console.log(
      `  ${'rule'.padEnd(idWidth)}  ${unit.padStart(7)}  example`,
    );
    console.log(`  ${'-'.repeat(idWidth)}  ${'-'.repeat(7)}  ${'-'.repeat(40)}`);
    for (const [ruleId, data] of rows) {
      console.log(
        `  ${ruleId.padEnd(idWidth)}  ${String(data.count).padStart(7)}  ${data.examples[0] || ''}`,
      );
    }
    const total = rows.reduce((s, r) => s + r[1].count, 0);
    console.log('');
    console.log(`  ${rows.length} distinct rules, ${total} hits`);
  }

  console.log('');
  console.log(
    `  entropy: ${measured.entropy.count}/${measured.itemCount} ${unit} flagged` +
      (measured.entropy.count
        ? `, max H=${measured.entropy.max_H.toFixed(2)} (threshold 5.5, margin ${(measured.entropy.max_H - 5.5).toFixed(2)})`
        : ''),
  );
  for (const item of measured.entropy.items.slice(0, 5)) {
    console.log(
      `    ${item.ref}  H=${item.max_H.toFixed(2)}  offsets ${item.segments.join(', ')}`,
    );
  }
  if (measured.entropy.items.length > 5) {
    console.log(`    ... and ${measured.entropy.items.length - 5} more`);
  }
}

function main() {
  console.log('False-positive report — detector firing on benign content');
  console.log('Generated:', new Date().toISOString());
  console.log(
    '\nEvery item below is benign. A hit is a false positive by definition.',
  );

  printCorpus('Corpus A — repository walk', 'files', measureRepoWalk());
  printCorpus('Corpus B — GSD-prose corpus', 'entries', measureGsdProse());

  console.log('');
  console.log(
    'Budget: tests/fixtures/security-coverage/fp-budget.json (enforced by tests/security-fp-corpus.test.cjs)',
  );
  console.log('');
}

if (require.main === module) {
  main();
}

module.exports = {
  REPO_ROOT,
  GSD_PROSE_PATH,
  WALK_ROOTS,
  WALK_EXTENSIONS,
  isExcludedFromWalk,
  walkRepoFiles,
  loadGsdProse,
  patternRuleIds,
  entropySegments,
  peakEntropyAnyAlignment,
  measureCorpus,
  measureRepoWalk,
  measureGsdProse,
};
