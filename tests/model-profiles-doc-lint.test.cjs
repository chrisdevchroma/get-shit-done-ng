'use strict';

// Lint keeping the profile tables in `gsd-ng/references/claude-model-profiles.md`
// in sync with MODEL_PROFILES / EFFORT_PROFILES in `gsd-ng/bin/lib/model-profiles.cjs`.
//
// The reference doc is what agents and users read; the constants are what the
// engine resolves. They are two copies of one mapping, so a drift means the
// documented profile and the applied profile disagree with nothing to catch it.
//
// Structure follows the other lints here: a synthetic-input self-test proves the
// table parser detects misalignment, then the real-doc tests assert zero drift.

const fs = require('fs');
const path = require('path');
const { test, describe } = require('node:test');
const assert = require('node:assert');

const {
  MODEL_PROFILES,
  EFFORT_PROFILES,
} = require('../gsd-ng/bin/lib/model-profiles.cjs');

const REPO_ROOT = path.join(__dirname, '..');
const DOC_PATH = 'gsd-ng/references/claude-model-profiles.md';
const EXPECTED_HEADER = ['Agent', '`quality`', '`balanced`', '`budget`'];

// Parses the first pipe table after `heading`. Returns
// [{ agent, quality, balanced, budget, line }] in document order.
// Throws when the heading is missing, no table follows it, or the header row
// is not the expected four columns — a silent misparse would make this lint
// pass vacuously.
function parseProfileTable(content, heading) {
  const lines = content.split('\n');
  const headingIndex = lines.findIndex((l) => l.trim() === heading);
  if (headingIndex === -1) {
    throw new Error(`heading not found: ${heading}`);
  }

  let i = headingIndex + 1;
  while (i < lines.length && !lines[i].trim().startsWith('|')) {
    if (lines[i].trim().startsWith('#')) {
      throw new Error(`no table between ${heading} and the next heading`);
    }
    i++;
  }
  if (i >= lines.length) {
    throw new Error(`no table after heading: ${heading}`);
  }

  const cells = (line) =>
    line
      .trim()
      .replace(/^\|/, '')
      .replace(/\|$/, '')
      .split('|')
      .map((c) => c.trim());

  const header = cells(lines[i]);
  assert.deepStrictEqual(
    header,
    EXPECTED_HEADER,
    `${heading}: unexpected table header — the parser reads columns positionally, ` +
      `so a reordered or renamed header must fail loudly rather than compare the wrong values`,
  );

  const rows = [];
  for (let j = i + 2; j < lines.length; j++) {
    if (!lines[j].trim().startsWith('|')) break;
    const [agent, quality, balanced, budget] = cells(lines[j]);
    rows.push({ agent, quality, balanced, budget, line: j + 1 });
  }
  return rows;
}

// Renders a constants map as the row shape parseProfileTable returns, so the
// two sides compare as plain data.
function constantsAsRows(profiles) {
  return Object.entries(profiles).map(([agent, p]) => ({
    agent,
    quality: p.quality,
    balanced: p.balanced,
    budget: p.budget,
  }));
}

function assertTableMatches(rows, profiles, constantName) {
  const expected = constantsAsRows(profiles);
  const actual = rows.map(({ agent, quality, balanced, budget }) => ({
    agent,
    quality,
    balanced,
    budget,
  }));

  const docAgents = actual.map((r) => r.agent);
  const codeAgents = expected.map((r) => r.agent);
  assert.deepStrictEqual(
    docAgents,
    codeAgents,
    `${DOC_PATH} lists different agents (or a different order) than ${constantName}\n` +
      `doc:  ${docAgents.join(', ')}\ncode: ${codeAgents.join(', ')}`,
  );

  for (let i = 0; i < expected.length; i++) {
    assert.deepStrictEqual(
      actual[i],
      expected[i],
      `${DOC_PATH}:${rows[i].line} disagrees with ${constantName} for ${expected[i].agent}\n` +
        `doc:  ${JSON.stringify(actual[i])}\ncode: ${JSON.stringify(expected[i])}`,
    );
  }
}

describe('model-profiles doc sync lint', () => {
  const content = fs.readFileSync(path.join(REPO_ROOT, DOC_PATH), 'utf-8');

  test('self-test: parser reports the values it reads, per row', () => {
    const synthetic = [
      '## Profile Definitions',
      '',
      '| Agent | `quality` | `balanced` | `budget` |',
      '|-------|-----------|------------|----------|',
      '| gsd-planner | opus | opus | sonnet |',
      '| gsd-verifier | opus | sonnet | haiku |',
      '',
      'trailing prose',
    ].join('\n');
    const rows = parseProfileTable(synthetic, '## Profile Definitions');
    assert.strictEqual(rows.length, 2);
    assert.deepStrictEqual(
      rows.map((r) => [r.agent, r.quality, r.balanced, r.budget]),
      [
        ['gsd-planner', 'opus', 'opus', 'sonnet'],
        ['gsd-verifier', 'opus', 'sonnet', 'haiku'],
      ],
    );
  });

  test('self-test: a drifted table fails the comparison', () => {
    const drifted = [
      '## Profile Definitions',
      '| Agent | `quality` | `balanced` | `budget` |',
      '|-------|-----------|------------|----------|',
      '| gsd-planner | haiku | opus | sonnet |',
    ].join('\n');
    const rows = parseProfileTable(drifted, '## Profile Definitions');
    assert.throws(
      () =>
        assertTableMatches(
          rows,
          { 'gsd-planner': { quality: 'opus', balanced: 'opus', budget: 'sonnet' } },
          'MODEL_PROFILES',
        ),
      /disagrees with MODEL_PROFILES/,
    );
  });

  test('self-test: a renamed header column fails rather than misparsing', () => {
    const renamed = [
      '## Profile Definitions',
      '| Agent | `cheap` | `balanced` | `budget` |',
      '|-------|---------|------------|----------|',
      '| gsd-planner | opus | opus | sonnet |',
    ].join('\n');
    assert.throws(() => parseProfileTable(renamed, '## Profile Definitions'), {
      message: /unexpected table header/,
    });
  });

  test('model table matches MODEL_PROFILES', () => {
    const rows = parseProfileTable(content, '## Profile Definitions');
    assertTableMatches(rows, MODEL_PROFILES, 'MODEL_PROFILES');
  });

  test('effort table matches EFFORT_PROFILES', () => {
    const rows = parseProfileTable(content, '### Effort Profile Definitions');
    assertTableMatches(rows, EFFORT_PROFILES, 'EFFORT_PROFILES');
  });
});
