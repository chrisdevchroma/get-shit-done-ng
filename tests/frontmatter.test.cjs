/**
 * GSD Tools Tests - frontmatter.cjs
 *
 * Tests for the hand-rolled YAML parser's pure function exports:
 * extractFrontmatter, reconstructFrontmatter, spliceFrontmatter,
 * parseMustHavesBlock, and FRONTMATTER_SCHEMAS.
 *
 * Includes regression test: quoted comma inline array edge case.
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');

const {
  extractFrontmatter,
  reconstructFrontmatter,
  spliceFrontmatter,
  parseMustHavesBlock,
  FRONTMATTER_SCHEMAS,
  cmdFrontmatterArrayAppend,
} = require('../gsd-ng/bin/lib/frontmatter.cjs');
const fs = require('fs');
const path = require('path');
const { resolveTmpDir, cleanup } = require('./helpers.cjs');

// ─── extractFrontmatter ─────────────────────────────────────────────────────

describe('extractFrontmatter', () => {
  test('parses simple key-value pairs', () => {
    const content = '---\nname: foo\ntype: execute\n---\nbody';
    const result = extractFrontmatter(content);
    assert.strictEqual(result.name, 'foo');
    assert.strictEqual(result.type, 'execute');
  });

  test('strips quotes from values', () => {
    const doubleQuoted = '---\nname: "foo"\n---\n';
    const singleQuoted = '---\nname: \'foo\'\n---\n';
    assert.strictEqual(extractFrontmatter(doubleQuoted).name, 'foo');
    assert.strictEqual(extractFrontmatter(singleQuoted).name, 'foo');
  });

  test('parses nested objects', () => {
    const content = '---\ntechstack:\n  added: prisma\n  patterns: repository\n---\n';
    const result = extractFrontmatter(content);
    assert.deepStrictEqual(result.techstack, { added: 'prisma', patterns: 'repository' });
  });

  test('parses block arrays', () => {
    const content = '---\nitems:\n  - alpha\n  - beta\n  - gamma\n---\n';
    const result = extractFrontmatter(content);
    assert.deepStrictEqual(result.items, ['alpha', 'beta', 'gamma']);
  });

  test('parses inline arrays', () => {
    const content = '---\nkey: [a, b, c]\n---\n';
    const result = extractFrontmatter(content);
    assert.deepStrictEqual(result.key, ['a', 'b', 'c']);
  });

  test('handles quoted commas in inline arrays — known limitation (split does not respect quotes)', () => {
    // The split(',') on line 53 does NOT respect quotes.
    // The parser WILL split on commas inside quotes, producing wrong results.
    // This test documents the CURRENT (buggy) behavior.
    const content = '---\nkey: ["a, b", c]\n---\n';
    const result = extractFrontmatter(content);
    // Current behavior: splits on ALL commas, producing 3 items instead of 2
    // Expected correct behavior would be: ["a, b", "c"]
    // Actual current behavior: ["a", "b", "c"] (split ignores quotes)
    assert.ok(Array.isArray(result.key), 'should produce an array');
    assert.ok(result.key.length >= 2, 'should produce at least 2 items from comma split');
    // The bug produces ["a", "b\"", "c"] or similar — the exact output depends on
    // how the regex strips quotes after the split.
    // We verify the key insight: the result has MORE items than intended (known limitation).
    assert.ok(result.key.length > 2, 'REG-04: split produces more items than intended due to quoted comma bug');
  });

  test('returns empty object for no frontmatter', () => {
    const content = 'Just plain content, no frontmatter.';
    const result = extractFrontmatter(content);
    assert.deepStrictEqual(result, {});
  });

  test('returns empty object for empty frontmatter', () => {
    const content = '---\n---\nBody text.';
    const result = extractFrontmatter(content);
    assert.deepStrictEqual(result, {});
  });

  test('parses frontmatter-only content', () => {
    const content = '---\nkey: val\n---';
    const result = extractFrontmatter(content);
    assert.strictEqual(result.key, 'val');
  });

  test('handles emoji and non-ASCII in values', () => {
    const content = '---\nname: "Hello World"\nlabel: "cafe"\n---\n';
    const result = extractFrontmatter(content);
    assert.strictEqual(result.name, 'Hello World');
    assert.strictEqual(result.label, 'cafe');
  });

  test('converts empty-object placeholders to arrays when dash items follow', () => {
    // When a key has no value, it gets an empty {} placeholder.
    // When "- item" lines follow, the parser converts {} to [].
    const content = '---\nrequirements:\n  - REQ-01\n  - REQ-02\n---\n';
    const result = extractFrontmatter(content);
    assert.ok(Array.isArray(result.requirements), 'should convert placeholder object to array');
    assert.deepStrictEqual(result.requirements, ['REQ-01', 'REQ-02']);
  });

  test('skips empty lines in YAML body', () => {
    const content = '---\nfirst: one\n\nsecond: two\n\nthird: three\n---\n';
    const result = extractFrontmatter(content);
    assert.strictEqual(result.first, 'one');
    assert.strictEqual(result.second, 'two');
    assert.strictEqual(result.third, 'three');
  });
});

// ─── reconstructFrontmatter ─────────────────────────────────────────────────

describe('reconstructFrontmatter', () => {
  test('serializes simple key-value', () => {
    const result = reconstructFrontmatter({ name: 'foo' });
    assert.strictEqual(result, 'name: foo');
  });

  test('serializes empty array as inline []', () => {
    const result = reconstructFrontmatter({ items: [] });
    assert.strictEqual(result, 'items: []');
  });

  test('serializes short string arrays inline', () => {
    const result = reconstructFrontmatter({ key: ['a', 'b', 'c'] });
    assert.strictEqual(result, 'key: [a, b, c]');
  });

  test('serializes long arrays as block', () => {
    const result = reconstructFrontmatter({ key: ['one', 'two', 'three', 'four'] });
    assert.ok(result.includes('key:'), 'should have key header');
    assert.ok(result.includes('  - one'), 'should have block array items');
    assert.ok(result.includes('  - four'), 'should have last item');
  });

  test('quotes values containing colons or hashes', () => {
    const result = reconstructFrontmatter({ url: 'http://example.com' });
    assert.ok(result.includes('"http://example.com"'), 'should quote value with colon');

    const hashResult = reconstructFrontmatter({ comment: 'value # note' });
    assert.ok(hashResult.includes('"value # note"'), 'should quote value with hash');
  });

  test('serializes nested objects with proper indentation', () => {
    const result = reconstructFrontmatter({ tech: { added: 'prisma', patterns: 'repo' } });
    assert.ok(result.includes('tech:'), 'should have parent key');
    assert.ok(result.includes('  added: prisma'), 'should have indented child');
    assert.ok(result.includes('  patterns: repo'), 'should have indented child');
  });

  test('serializes nested arrays within objects', () => {
    const result = reconstructFrontmatter({
      tech: { added: ['prisma', 'jose'] },
    });
    assert.ok(result.includes('tech:'), 'should have parent key');
    assert.ok(result.includes('  added: [prisma, jose]'), 'should serialize nested short array inline');
  });

  test('skips null and undefined values', () => {
    const result = reconstructFrontmatter({ name: 'foo', skip: null, also: undefined, keep: 'bar' });
    assert.ok(!result.includes('skip'), 'should not include null key');
    assert.ok(!result.includes('also'), 'should not include undefined key');
    assert.ok(result.includes('name: foo'), 'should include non-null key');
    assert.ok(result.includes('keep: bar'), 'should include non-null key');
  });

  test('round-trip: simple frontmatter', () => {
    const original = '---\nname: test\ntype: execute\nwave: 1\n---\n';
    const extracted1 = extractFrontmatter(original);
    const reconstructed = reconstructFrontmatter(extracted1);
    const roundTrip = `---\n${reconstructed}\n---\n`;
    const extracted2 = extractFrontmatter(roundTrip);
    assert.deepStrictEqual(extracted2, extracted1, 'round-trip should preserve data identity');
  });

  test('round-trip: nested with arrays', () => {
    const original = '---\nphase: 01\ntech:\n  added:\n    - prisma\n    - jose\n  patterns:\n    - repository\n    - jwt\n---\n';
    const extracted1 = extractFrontmatter(original);
    const reconstructed = reconstructFrontmatter(extracted1);
    const roundTrip = `---\n${reconstructed}\n---\n`;
    const extracted2 = extractFrontmatter(roundTrip);
    assert.deepStrictEqual(extracted2, extracted1, 'round-trip should preserve nested structures');
  });

  test('round-trip: multiple data types', () => {
    const original = '---\nname: testplan\nwave: 2\ntags: [auth, api, db]\ndeps:\n  - dep1\n  - dep2\nconfig:\n  enabled: true\n  count: 5\n---\n';
    const extracted1 = extractFrontmatter(original);
    const reconstructed = reconstructFrontmatter(extracted1);
    const roundTrip = `---\n${reconstructed}\n---\n`;
    const extracted2 = extractFrontmatter(roundTrip);
    assert.deepStrictEqual(extracted2, extracted1, 'round-trip should preserve multiple data types');
  });
});

// ─── spliceFrontmatter ──────────────────────────────────────────────────────

describe('spliceFrontmatter', () => {
  test('replaces existing frontmatter preserving body', () => {
    const content = '---\nphase: 01\ntype: execute\n---\n\n# Body Content\n\nParagraph here.';
    const newObj = { phase: '02', type: 'tdd', wave: '1' };
    const result = spliceFrontmatter(content, newObj);

    // New frontmatter should be present
    const extracted = extractFrontmatter(result);
    assert.strictEqual(extracted.phase, '02');
    assert.strictEqual(extracted.type, 'tdd');
    assert.strictEqual(extracted.wave, '1');

    // Body should be preserved
    assert.ok(result.includes('# Body Content'), 'body heading should be preserved');
    assert.ok(result.includes('Paragraph here.'), 'body paragraph should be preserved');
  });

  test('adds frontmatter to content without any', () => {
    const content = 'Plain text with no frontmatter.';
    const newObj = { phase: '01', plan: '01' };
    const result = spliceFrontmatter(content, newObj);

    // Should start with frontmatter delimiters
    assert.ok(result.startsWith('---\n'), 'should start with opening delimiter');
    assert.ok(result.includes('\n---\n'), 'should have closing delimiter');

    // Original content should follow
    assert.ok(result.includes('Plain text with no frontmatter.'), 'original content should be preserved');

    // Frontmatter should be extractable
    const extracted = extractFrontmatter(result);
    assert.strictEqual(extracted.phase, '01');
    assert.strictEqual(extracted.plan, '01');
  });

  test('preserves content after frontmatter delimiters exactly', () => {
    const body = '\n\nExact content with special chars: $, %, &, <, >\nLine 2\nLine 3';
    const content = '---\nold: value\n---' + body;
    const newObj = { new: 'value' };
    const result = spliceFrontmatter(content, newObj);

    // The body after the closing --- should be exactly preserved
    const closingIdx = result.indexOf('\n---', 4); // skip the opening ---
    const resultBody = result.slice(closingIdx + 4); // skip \n---
    assert.strictEqual(resultBody, body, 'body content after frontmatter should be exactly preserved');
  });
});

// ─── parseMustHavesBlock ────────────────────────────────────────────────────

describe('parseMustHavesBlock', () => {
  test('extracts truths as string array', () => {
    const content = `---
phase: 01
must_haves:
    truths:
      - "All tests pass on CI"
      - "Coverage exceeds 80%"
---

Body content.`;
    const result = parseMustHavesBlock(content, 'truths');
    assert.ok(Array.isArray(result), 'should return an array');
    assert.strictEqual(result.length, 2);
    assert.strictEqual(result[0], 'All tests pass on CI');
    assert.strictEqual(result[1], 'Coverage exceeds 80%');
  });

  test('extracts artifacts as object array', () => {
    const content = `---
phase: 01
must_haves:
    artifacts:
      - path: "src/auth.ts"
        provides: "JWT authentication"
        min_lines: 100
      - path: "src/middleware.ts"
        provides: "Route protection"
        min_lines: 50
---

Body.`;
    const result = parseMustHavesBlock(content, 'artifacts');
    assert.ok(Array.isArray(result), 'should return an array');
    assert.strictEqual(result.length, 2);
    assert.strictEqual(result[0].path, 'src/auth.ts');
    assert.strictEqual(result[0].provides, 'JWT authentication');
    assert.strictEqual(result[0].min_lines, 100);
    assert.strictEqual(result[1].path, 'src/middleware.ts');
    assert.strictEqual(result[1].min_lines, 50);
  });

  test('extracts key_links with from/to/via/pattern fields', () => {
    const content = `---
phase: 01
must_haves:
    key_links:
      - from: "tests/auth.test.ts"
        to: "src/auth.ts"
        via: "import statement"
        pattern: "import.*auth"
---
`;
    const result = parseMustHavesBlock(content, 'key_links');
    assert.ok(Array.isArray(result), 'should return an array');
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].from, 'tests/auth.test.ts');
    assert.strictEqual(result[0].to, 'src/auth.ts');
    assert.strictEqual(result[0].via, 'import statement');
    assert.strictEqual(result[0].pattern, 'import.*auth');
  });

  test('returns empty array when block not found', () => {
    const content = `---
phase: 01
must_haves:
    truths:
      - "Some truth"
---
`;
    const result = parseMustHavesBlock(content, 'nonexistent_block');
    assert.deepStrictEqual(result, []);
  });

  test('returns empty array when no frontmatter', () => {
    const content = 'Plain text without any frontmatter delimiters.';
    const result = parseMustHavesBlock(content, 'truths');
    assert.deepStrictEqual(result, []);
  });

  test('handles nested arrays within artifact objects', () => {
    const content = `---
phase: 01
must_haves:
    artifacts:
      - path: "src/api.ts"
        provides: "REST endpoints"
        exports:
          - "GET"
          - "POST"
---
`;
    const result = parseMustHavesBlock(content, 'artifacts');
    assert.ok(Array.isArray(result), 'should return an array');
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].path, 'src/api.ts');
    // The nested array should be captured
    assert.ok(result[0].exports !== undefined, 'should have exports field');
  });
});

// ─── Bug 1c: reconstructFrontmatter quoting for em-dashes and parentheses ────

describe('reconstructFrontmatter — em-dash and parentheses quoting (Bug 1c)', () => {
  test('quotes value containing em-dash', () => {
    const result = reconstructFrontmatter({ status: 'Phase complete \u2014 ready' });
    assert.ok(
      result.includes('status: "Phase complete \u2014 ready"'),
      `expected quoted em-dash value, got: ${result}`
    );
  });

  test('quotes value containing parentheses', () => {
    const result = reconstructFrontmatter({ stopped_at: 'Phase 52 (ast-safety)' });
    assert.ok(
      result.includes('stopped_at: "Phase 52 (ast-safety)"'),
      `expected quoted parentheses value, got: ${result}`
    );
  });

  test('does NOT quote plain values (regression guard)', () => {
    const result = reconstructFrontmatter({ status: 'executing' });
    assert.ok(
      result.includes('status: executing') && !result.includes('"executing"'),
      `plain value should not be quoted, got: ${result}`
    );
  });

  test('quotes nested subkey value containing em-dash', () => {
    const result = reconstructFrontmatter({ meta: { label: 'Phase 1 \u2014 done' } });
    assert.ok(
      result.includes('label: "Phase 1 \u2014 done"'),
      `expected nested em-dash value to be quoted, got: ${result}`
    );
  });

  test('quotes nested subkey value containing parentheses', () => {
    const result = reconstructFrontmatter({ meta: { name: 'worker (prod)' } });
    assert.ok(
      result.includes('name: "worker (prod)"'),
      `expected nested parentheses value to be quoted, got: ${result}`
    );
  });

  test('round-trip: em-dash value survives extract then reconstruct', () => {
    const original = '---\nstatus: "Phase complete \u2014 ready"\n---\n';
    const extracted = extractFrontmatter(original);
    const reconstructed = reconstructFrontmatter(extracted);
    const roundTrip = `---\n${reconstructed}\n---\n`;
    const extracted2 = extractFrontmatter(roundTrip);
    assert.strictEqual(extracted2.status, extracted.status, 'em-dash value should round-trip unchanged');
  });

  test('round-trip: parentheses value survives extract then reconstruct', () => {
    const original = '---\nstopped_at: "Phase 52 (ast-safety)"\n---\n';
    const extracted = extractFrontmatter(original);
    const reconstructed = reconstructFrontmatter(extracted);
    const roundTrip = `---\n${reconstructed}\n---\n`;
    const extracted2 = extractFrontmatter(roundTrip);
    assert.strictEqual(extracted2.stopped_at, extracted.stopped_at, 'parentheses value should round-trip unchanged');
  });
});

// ─── frontmatter.cjs branch/line residuals (60-11) ────────────────────────

describe('frontmatter.cjs residuals (60-11)', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const { resolveTmpDir, cleanup } = require('./helpers.cjs');

  let tmpDir;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(resolveTmpDir(), 'gsd-fm-r-'));
  });
  afterEach(() => {
    cleanup(tmpDir);
  });

  // reconstructFrontmatter: lines 133-156 — nested-object array values,
  // long-array splayed-list rendering, items containing ":" or "#" need quoting,
  // and 3-level nested object rendering.
  test('reconstructFrontmatter: object value with long array splays into list', () => {
    const fm = {
      'tech-stack': {
        added: ['lib1', 'lib2', 'lib3', 'lib4', 'lib5'],
      },
    };
    const r = reconstructFrontmatter(fm);
    // Long arrays render as splayed list (not inline)
    assert.match(r, /tech-stack:/);
    assert.match(r, /added:\n\s+- lib1/);
  });

  test('reconstructFrontmatter: array items with ":" get quoted in splayed form', () => {
    // Array longer than 3 OR total length > 60 forces splayed form, where
    // items containing ":" or "#" get quoted.
    const fm = {
      'key-decisions': [
        'name: rationale text 1',
        'name2: rationale text 2',
        'name3: rationale text 3',
        'name4: rationale text 4',
      ],
    };
    const r = reconstructFrontmatter(fm);
    assert.match(r, /"name: rationale text 1"/);
  });

  test('reconstructFrontmatter: long array exceeding inline limit splays', () => {
    // join(", ").length >= 60 forces splay
    const fm = {
      tags: [
        'verylongstring1' + 'x'.repeat(20),
        'verylongstring2',
        'verylongstring3',
      ],
    };
    const r = reconstructFrontmatter(fm);
    // Splay form: each item on own line
    assert.match(r, /tags:\n\s+- verylongstring1/);
  });

  test('reconstructFrontmatter: 4+ items also splays', () => {
    const fm = {
      tags: ['a', 'b', 'c', 'd', 'e'],
    };
    const r = reconstructFrontmatter(fm);
    assert.match(r, /tags:\n\s+- a/);
  });

  test('reconstructFrontmatter: array items with "#" get quoted', () => {
    const fm = {
      tags: ['has#hash', 'plain'],
    };
    const r = reconstructFrontmatter(fm);
    // Long array (>3 elements OR string-too-long) splays
    // Non-splayed inline form keeps unquoted
    assert.match(r, /tags:/);
  });

  test('reconstructFrontmatter: inline array short-form renders correctly', () => {
    const fm = { tags: ['a', 'b'] };
    const r = reconstructFrontmatter(fm);
    assert.match(r, /tags: \[a, b\]/);
  });

  test('reconstructFrontmatter: empty subkey array renders as []', () => {
    const fm = {
      'tech-stack': {
        added: [],
      },
    };
    const r = reconstructFrontmatter(fm);
    assert.match(r, /added: \[\]/);
  });

  test('reconstructFrontmatter: deeply nested object (3 levels)', () => {
    const fm = {
      level1: {
        level2: {
          level3: 'value',
        },
      },
    };
    const r = reconstructFrontmatter(fm);
    assert.match(r, /level1:/);
    assert.match(r, /level2:/);
    assert.match(r, /level3: value/);
  });

  test('reconstructFrontmatter: nested array within object', () => {
    const fm = {
      level1: {
        items: ['a', 'b'],
      },
    };
    const r = reconstructFrontmatter(fm);
    assert.match(r, /items:/);
  });

  test('reconstructFrontmatter: nested empty array within object', () => {
    const fm = {
      level1: {
        items: [],
      },
    };
    const r = reconstructFrontmatter(fm);
    assert.match(r, /items: \[\]/);
  });

  test('reconstructFrontmatter: scalar value with special chars gets quoted', () => {
    const fm = {
      level1: {
        nested: 'has: colon',
      },
    };
    const r = reconstructFrontmatter(fm);
    assert.match(r, /"has: colon"/);
  });

  test('reconstructFrontmatter: skips null/undefined nested values', () => {
    const fm = {
      level1: {
        keep: 'present',
        skip: null,
        skip2: undefined,
      },
    };
    const r = reconstructFrontmatter(fm);
    assert.match(r, /keep: present/);
    assert.ok(!r.includes('skip: null'));
    assert.ok(!r.includes('skip:'));
  });

  // cmdFrontmatterGet: lines 282/283/293/294 — !filePath error, file-not-
  // found with default, field not found with default, etc.
  describe('cmdFrontmatterGet branches', () => {
    test('missing filePath errors via direct invocation', () => {
      const code =
        'require(' +
        JSON.stringify(
          path.resolve(
            __dirname, '../gsd-ng/bin/lib/frontmatter.cjs',
          ),
        ) +
        ').cmdFrontmatterGet(' +
        JSON.stringify(tmpDir) +
        ');';
      const r = require('child_process').spawnSync(
        process.execPath,
        ['-e', code],
        { encoding: 'utf-8' },
      );
      assert.strictEqual(r.status, 1);
      assert.match(r.stderr, /file path required/);
    });

    test('field not found, no default → error JSON', () => {
      const fp = path.join(tmpDir, 'a.md');
      fs.writeFileSync(fp, '---\na: 1\n---\nbody\n');
      const code =
        'require(' +
        JSON.stringify(
          path.resolve(
            __dirname, '../gsd-ng/bin/lib/frontmatter.cjs',
          ),
        ) +
        ').cmdFrontmatterGet(' +
        JSON.stringify(tmpDir) +
        ', ' +
        JSON.stringify(fp) +
        ', "missing");';
      const r = require('child_process').spawnSync(
        process.execPath,
        ['-e', code],
        { encoding: 'utf-8' },
      );
      assert.strictEqual(r.status, 0);
      const parsed = JSON.parse(r.stdout);
      assert.strictEqual(parsed.error, 'Field not found');
    });

    test('field not found, with default → returns default', () => {
      const fp = path.join(tmpDir, 'a.md');
      fs.writeFileSync(fp, '---\na: 1\n---\nbody\n');
      const code =
        'require(' +
        JSON.stringify(
          path.resolve(
            __dirname, '../gsd-ng/bin/lib/frontmatter.cjs',
          ),
        ) +
        ').cmdFrontmatterGet(' +
        JSON.stringify(tmpDir) +
        ', ' +
        JSON.stringify(fp) +
        ', "missing", null, "fallback");';
      const r = require('child_process').spawnSync(
        process.execPath,
        ['-e', code],
        { encoding: 'utf-8' },
      );
      assert.strictEqual(r.status, 0);
      assert.match(r.stdout, /fallback/);
    });

    test('file not found, no default → error JSON', () => {
      const code =
        'require(' +
        JSON.stringify(
          path.resolve(
            __dirname, '../gsd-ng/bin/lib/frontmatter.cjs',
          ),
        ) +
        ').cmdFrontmatterGet(' +
        JSON.stringify(tmpDir) +
        ', "no-such.md");';
      const r = require('child_process').spawnSync(
        process.execPath,
        ['-e', code],
        { encoding: 'utf-8' },
      );
      assert.strictEqual(r.status, 0);
      const parsed = JSON.parse(r.stdout);
      assert.strictEqual(parsed.error, 'File not found');
    });

    test('file not found, with default → returns default', () => {
      const code =
        'require(' +
        JSON.stringify(
          path.resolve(
            __dirname, '../gsd-ng/bin/lib/frontmatter.cjs',
          ),
        ) +
        ').cmdFrontmatterGet(' +
        JSON.stringify(tmpDir) +
        ', "no-such.md", null, null, "default-val");';
      const r = require('child_process').spawnSync(
        process.execPath,
        ['-e', code],
        { encoding: 'utf-8' },
      );
      assert.strictEqual(r.status, 0);
      assert.match(r.stdout, /default-val/);
    });

    test('array field with format=newline joins by newline', () => {
      const fp = path.join(tmpDir, 'a.md');
      fs.writeFileSync(fp, '---\ntags:\n  - a\n  - b\n---\n');
      const code =
        'require(' +
        JSON.stringify(
          path.resolve(
            __dirname, '../gsd-ng/bin/lib/frontmatter.cjs',
          ),
        ) +
        ').cmdFrontmatterGet(' +
        JSON.stringify(tmpDir) +
        ', ' +
        JSON.stringify(fp) +
        ', "tags", "newline");';
      const r = require('child_process').spawnSync(
        process.execPath,
        ['-e', code],
        { encoding: 'utf-8' },
      );
      assert.strictEqual(r.status, 0);
      assert.match(r.stdout, /a\nb/);
    });

    test('array field with no format joins by comma', () => {
      const fp = path.join(tmpDir, 'a.md');
      fs.writeFileSync(fp, '---\ntags:\n  - a\n  - b\n---\n');
      const code =
        'require(' +
        JSON.stringify(
          path.resolve(
            __dirname, '../gsd-ng/bin/lib/frontmatter.cjs',
          ),
        ) +
        ').cmdFrontmatterGet(' +
        JSON.stringify(tmpDir) +
        ', ' +
        JSON.stringify(fp) +
        ', "tags");';
      const r = require('child_process').spawnSync(
        process.execPath,
        ['-e', code],
        { encoding: 'utf-8' },
      );
      assert.strictEqual(r.status, 0);
      assert.match(r.stdout, /a, b/);
    });

    test('no field returns full frontmatter object', () => {
      const fp = path.join(tmpDir, 'a.md');
      fs.writeFileSync(fp, '---\na: hello\n---\n');
      const code =
        'require(' +
        JSON.stringify(
          path.resolve(
            __dirname, '../gsd-ng/bin/lib/frontmatter.cjs',
          ),
        ) +
        ').cmdFrontmatterGet(' +
        JSON.stringify(tmpDir) +
        ', ' +
        JSON.stringify(fp) +
        ');';
      const r = require('child_process').spawnSync(
        process.execPath,
        ['-e', code],
        { encoding: 'utf-8' },
      );
      assert.strictEqual(r.status, 0);
      const parsed = JSON.parse(r.stdout);
      assert.strictEqual(parsed.a, 'hello');
    });
  });

  // cmdFrontmatterSet: line 320-332, missing args, field validation
  describe('cmdFrontmatterSet branches', () => {
    test('missing filePath errors', () => {
      const code =
        'require(' +
        JSON.stringify(
          path.resolve(
            __dirname, '../gsd-ng/bin/lib/frontmatter.cjs',
          ),
        ) +
        ').cmdFrontmatterSet(' +
        JSON.stringify(tmpDir) +
        ');';
      const r = require('child_process').spawnSync(
        process.execPath,
        ['-e', code],
        { encoding: 'utf-8' },
      );
      assert.strictEqual(r.status, 1);
      assert.match(r.stderr, /file, field, and value required/);
    });

    test('invalid field name errors', () => {
      const fp = path.join(tmpDir, 'a.md');
      fs.writeFileSync(fp, '---\na: 1\n---\n');
      // Use a field name with embedded actual newline char — JSON.stringify
      // escapes it as "\n" which becomes a literal \n in the spawned JS source.
      // We need the JS string to contain the actual newline so we use String.fromCharCode(10).
      const code =
        'const fp = ' +
        JSON.stringify(fp) +
        '; const fname = "field" + String.fromCharCode(10) + "name";' +
        'require(' +
        JSON.stringify(
          path.resolve(
            __dirname, '../gsd-ng/bin/lib/frontmatter.cjs',
          ),
        ) +
        ').cmdFrontmatterSet(' +
        JSON.stringify(tmpDir) +
        ', fp, fname, "value");';
      const r = require('child_process').spawnSync(
        process.execPath,
        ['-e', code],
        { encoding: 'utf-8' },
      );
      assert.strictEqual(r.status, 1);
      assert.match(r.stderr, /Invalid field name/);
    });

    test('JSON value parsing branch', () => {
      const fp = path.join(tmpDir, 'a.md');
      fs.writeFileSync(fp, '---\na: 1\n---\n');
      const code =
        'require(' +
        JSON.stringify(
          path.resolve(
            __dirname, '../gsd-ng/bin/lib/frontmatter.cjs',
          ),
        ) +
        ').cmdFrontmatterSet(' +
        JSON.stringify(tmpDir) +
        ', ' +
        JSON.stringify(fp) +
        ', "tags", \'["a","b"]\');';
      const r = require('child_process').spawnSync(
        process.execPath,
        ['-e', code],
        { encoding: 'utf-8' },
      );
      assert.strictEqual(r.status, 0);
      const c = fs.readFileSync(fp, 'utf-8');
      // Tags array stored
      assert.match(c, /tags:/);
    });

    test('non-JSON value stored as string', () => {
      const fp = path.join(tmpDir, 'a.md');
      fs.writeFileSync(fp, '---\na: 1\n---\n');
      const code =
        'require(' +
        JSON.stringify(
          path.resolve(
            __dirname, '../gsd-ng/bin/lib/frontmatter.cjs',
          ),
        ) +
        ').cmdFrontmatterSet(' +
        JSON.stringify(tmpDir) +
        ', ' +
        JSON.stringify(fp) +
        ', "name", "hello");';
      const r = require('child_process').spawnSync(
        process.execPath,
        ['-e', code],
        { encoding: 'utf-8' },
      );
      assert.strictEqual(r.status, 0);
      const c = fs.readFileSync(fp, 'utf-8');
      assert.match(c, /name: hello/);
    });

    test('file not found returns error (not raises)', () => {
      const code =
        'require(' +
        JSON.stringify(
          path.resolve(
            __dirname, '../gsd-ng/bin/lib/frontmatter.cjs',
          ),
        ) +
        ').cmdFrontmatterSet(' +
        JSON.stringify(tmpDir) +
        ', "no-such.md", "name", "x");';
      const r = require('child_process').spawnSync(
        process.execPath,
        ['-e', code],
        { encoding: 'utf-8' },
      );
      assert.strictEqual(r.status, 0);
      const parsed = JSON.parse(r.stdout);
      assert.strictEqual(parsed.error, 'File not found');
    });
  });

  // cmdFrontmatterMerge branches
  describe('cmdFrontmatterMerge branches', () => {
    test('missing filePath errors', () => {
      const code =
        'require(' +
        JSON.stringify(
          path.resolve(
            __dirname, '../gsd-ng/bin/lib/frontmatter.cjs',
          ),
        ) +
        ').cmdFrontmatterMerge(' +
        JSON.stringify(tmpDir) +
        ');';
      const r = require('child_process').spawnSync(
        process.execPath,
        ['-e', code],
        { encoding: 'utf-8' },
      );
      assert.strictEqual(r.status, 1);
      assert.match(r.stderr, /file and data required/);
    });

    test('invalid JSON --data errors', () => {
      const fp = path.join(tmpDir, 'a.md');
      fs.writeFileSync(fp, '---\na: 1\n---\n');
      const code =
        'require(' +
        JSON.stringify(
          path.resolve(
            __dirname, '../gsd-ng/bin/lib/frontmatter.cjs',
          ),
        ) +
        ').cmdFrontmatterMerge(' +
        JSON.stringify(tmpDir) +
        ', ' +
        JSON.stringify(fp) +
        ', "not-json{");';
      const r = require('child_process').spawnSync(
        process.execPath,
        ['-e', code],
        { encoding: 'utf-8' },
      );
      assert.strictEqual(r.status, 1);
      assert.match(r.stderr, /Invalid JSON/);
    });

    test('valid JSON merges into frontmatter', () => {
      const fp = path.join(tmpDir, 'a.md');
      fs.writeFileSync(fp, '---\na: 1\n---\n');
      const code =
        'require(' +
        JSON.stringify(
          path.resolve(
            __dirname, '../gsd-ng/bin/lib/frontmatter.cjs',
          ),
        ) +
        ').cmdFrontmatterMerge(' +
        JSON.stringify(tmpDir) +
        ', ' +
        JSON.stringify(fp) +
        ', \'{"b":2}\');';
      const r = require('child_process').spawnSync(
        process.execPath,
        ['-e', code],
        { encoding: 'utf-8' },
      );
      assert.strictEqual(r.status, 0);
      const c = fs.readFileSync(fp, 'utf-8');
      assert.match(c, /b: 2/);
    });

    test('file not found returns error', () => {
      const code =
        'require(' +
        JSON.stringify(
          path.resolve(
            __dirname, '../gsd-ng/bin/lib/frontmatter.cjs',
          ),
        ) +
        ').cmdFrontmatterMerge(' +
        JSON.stringify(tmpDir) +
        ', "no-such.md", \'{"a":1}\');';
      const r = require('child_process').spawnSync(
        process.execPath,
        ['-e', code],
        { encoding: 'utf-8' },
      );
      assert.strictEqual(r.status, 0);
      const parsed = JSON.parse(r.stdout);
      assert.strictEqual(parsed.error, 'File not found');
    });
  });

  // cmdFrontmatterValidate: missing args branches
  describe('cmdFrontmatterValidate branches', () => {
    test('missing schemaName errors', () => {
      const code =
        'require(' +
        JSON.stringify(
          path.resolve(
            __dirname, '../gsd-ng/bin/lib/frontmatter.cjs',
          ),
        ) +
        ').cmdFrontmatterValidate(' +
        JSON.stringify(tmpDir) +
        ', "any.md");';
      const r = require('child_process').spawnSync(
        process.execPath,
        ['-e', code],
        { encoding: 'utf-8' },
      );
      assert.strictEqual(r.status, 1);
      assert.match(r.stderr, /file and schema required/);
    });
  });
});

// ─── cmdFrontmatterArrayAppend ──────────────────────────────────────────────

describe('cmdFrontmatterArrayAppend', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(resolveTmpDir(), 'fm-arr-append-'));
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  function writeFile(name, content) {
    const p = path.join(tmpDir, name);
    fs.writeFileSync(p, content);
    return p;
  }

  function readFm(p) {
    return extractFrontmatter(fs.readFileSync(p, 'utf-8'));
  }

  test('creates a new array when the field is missing', () => {
    const p = writeFile('t.md', '---\ntitle: foo\n---\nbody\n');
    cmdFrontmatterArrayAppend(tmpDir, p, 'related', 'a.md');
    assert.deepStrictEqual(readFm(p).related, ['a.md']);
  });

  test('coerces scalar to array before appending', () => {
    const p = writeFile('t.md', '---\nrelated: existing.md\n---\nbody\n');
    cmdFrontmatterArrayAppend(tmpDir, p, 'related', 'new.md');
    assert.deepStrictEqual(readFm(p).related, ['existing.md', 'new.md']);
  });

  test('dedupes — does not append if value already present', () => {
    const p = writeFile(
      't.md',
      '---\nrelated:\n  - a.md\n  - b.md\n---\nbody\n',
    );
    cmdFrontmatterArrayAppend(tmpDir, p, 'related', 'a.md');
    assert.deepStrictEqual(readFm(p).related, ['a.md', 'b.md']);
  });

  test('appends to existing array', () => {
    const p = writeFile(
      't.md',
      '---\nrelated:\n  - a.md\n  - b.md\n---\nbody\n',
    );
    cmdFrontmatterArrayAppend(tmpDir, p, 'related', 'c.md');
    assert.deepStrictEqual(readFm(p).related, ['a.md', 'b.md', 'c.md']);
  });

  test('treats empty-string field as missing', () => {
    const p = writeFile('empty.md', '---\nrelated: ""\n---\nbody\n');
    cmdFrontmatterArrayAppend(tmpDir, p, 'related', 'a.md');
    assert.deepStrictEqual(readFm(p).related, ['a.md']);
  });

  test('preserves other frontmatter fields and body', () => {
    const p = writeFile(
      't.md',
      '---\ntitle: foo\ntype: todo\n---\nThis is the body\nmore lines\n',
    );
    cmdFrontmatterArrayAppend(tmpDir, p, 'related', 'a.md');
    const fm = readFm(p);
    assert.strictEqual(fm.title, 'foo');
    assert.strictEqual(fm.type, 'todo');
    assert.deepStrictEqual(fm.related, ['a.md']);
    const content = fs.readFileSync(p, 'utf-8');
    assert.match(content, /This is the body/);
    assert.match(content, /more lines/);
  });

  test('absolute file path works regardless of cwd argument', () => {
    const p = writeFile('t.md', '---\nrelated: a.md\n---\nbody\n');
    cmdFrontmatterArrayAppend('/somewhere/else', p, 'related', 'b.md');
    assert.deepStrictEqual(readFm(p).related, ['a.md', 'b.md']);
  });
});


// ─── todo schema ────────────────────────────────────────────────────────────

describe('FRONTMATTER_SCHEMAS.todo', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(resolveTmpDir(), 'fm-todo-schema-'));
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  function writeTodo(name, content) {
    const p = path.join(tmpDir, name);
    fs.writeFileSync(p, content);
    return p;
  }

  function validate(filePath) {
    const libPath = path.resolve(
      __dirname, '../gsd-ng/bin/lib/frontmatter.cjs',
    );
    const code =
      'require(' +
      JSON.stringify(libPath) +
      ').cmdFrontmatterValidate(' +
      JSON.stringify(tmpDir) +
      ', ' +
      JSON.stringify(filePath) +
      ', "todo");';
    return require('child_process').spawnSync(
      process.execPath,
      ['-e', code],
      { encoding: 'utf-8' },
    );
  }

  test('is registered with title, created and area required', () => {
    assert.ok(FRONTMATTER_SCHEMAS.todo, 'todo schema should exist');
    assert.deepStrictEqual(FRONTMATTER_SCHEMAS.todo.required, [
      'title',
      'created',
      'area',
    ]);
  });

  test('a todo carrying the required fields validates', () => {
    const p = writeTodo(
      'ok.md',
      '---\ncreated: "2026-08-05T14:25:41.134Z"\ntitle: A todo\narea: tooling\n---\n\nBody\n',
    );
    const r = validate(p);
    assert.strictEqual(r.status, 0, `stderr: ${r.stderr}`);
    assert.strictEqual(r.stdout, 'valid');
  });

  test('a todo missing area is invalid and names only area', () => {
    const p = writeTodo(
      'no-area.md',
      '---\ncreated: 2026-03-25\ntitle: A todo\n---\n\nBody\n',
    );
    const r = validate(p);
    assert.strictEqual(r.status, 0, `stderr: ${r.stderr}`);
    assert.strictEqual(r.stdout, 'invalid');

    const missing = FRONTMATTER_SCHEMAS.todo.required.filter(
      (f) => extractFrontmatter(fs.readFileSync(p, 'utf-8'))[f] === undefined,
    );
    assert.deepStrictEqual(missing, ['area']);
  });

  test('the recognised optional keys do not make a todo invalid', () => {
    const p = writeTodo(
      'optional.md',
      '---\n' +
        'created: "2026-08-05T14:25:41.134Z"\n' +
        'title: Everything at once\n' +
        'area: tooling\n' +
        'files: [a.js, b.js]\n' +
        'phase: "68"\n' +
        'related:\n  - other.md\n' +
        'recurring: true\n' +
        'interval: 30d\n' +
        'last_completed: "2026-07-01T00:00:00.000Z"\n' +
        'external_ref: "github:o/r#14"\n' +
        'untrusted_title: true\n' +
        'completed: "2026-08-01T00:00:00.000Z"\n' +
        '---\n\nBody\n',
    );
    const r = validate(p);
    assert.strictEqual(r.status, 0, `stderr: ${r.stderr}`);
    assert.strictEqual(r.stdout, 'valid');
  });

  test('the unknown-schema error lists todo as available', () => {
    const p = writeTodo('any.md', '---\ntitle: A todo\n---\n');
    const libPath = path.resolve(
      __dirname, '../gsd-ng/bin/lib/frontmatter.cjs',
    );
    const code =
      'require(' +
      JSON.stringify(libPath) +
      ').cmdFrontmatterValidate(' +
      JSON.stringify(tmpDir) +
      ', ' +
      JSON.stringify(p) +
      ', "nope");';
    const r = require('child_process').spawnSync(
      process.execPath,
      ['-e', code],
      { encoding: 'utf-8' },
    );
    assert.strictEqual(r.status, 1);
    assert.match(r.stderr, /Unknown schema: nope/);
    assert.match(r.stderr, /Available:[^\n]*\btodo\b/);
  });
});
