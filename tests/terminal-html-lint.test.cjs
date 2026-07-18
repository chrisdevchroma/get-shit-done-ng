'use strict';

// Lint for rendering-only inline HTML in terminal-destined markdown.
//
// GSD workflows and agents print continuation blocks ("▶ Next Up"),
// status summaries and prompts directly into the Claude Code terminal.
// Claude Code renders GitHub-flavored markdown, which does NOT support
// inline HTML — a `<sub>…</sub>` wrapper does not de-emphasize anything,
// it just displays the literal characters `<sub>` to the user.
//
// This lint bans the tags whose ONLY purpose is visual rendering:
//
//   sub, sup, small, kbd, mark, br, u, font, center
//
// Use markdown equivalents instead — `*italics*` for subtext (see
// gsd-ng/references/continuation-format.md, "Format Rules" rule 7), a
// blank line for a break, `**bold**` for emphasis. Those render
// correctly in BOTH the terminal and on GitHub.
//
// Deliberately NOT banned:
//
//   * `<details>` / `<summary>` — workflow files legitimately contain
//     these as content written INTO files that are viewed on GitHub
//     (ROADMAP.md collapsible sections), where HTML does render. And
//     `<summary>` additionally collides with a GSD XML structural tag.
//     A naive "no HTML in workflows" rule would break real usage; this
//     exclusion is the central design constraint of the lint.
//   * GSD XML structural tags (`<objective>`, `<config-check>`, …) —
//     these are prompt scaffolding, never rendered output.
//
// Two exemptions keep the detector from firing on text that is displayed
// literally by design rather than rendered:
//
//   1. Inline code spans (`` `<br>` ``) — prose that *documents* the
//      banned tags, e.g. the rule in continuation-format.md itself.
//   2. Fenced blocks declaring a source-code language (```jsx, ```tsx,
//      ```html, …) — JSX/HTML examples are code, not terminal output.
//      Bare ``` and ```markdown / ```bash / ```text fences ARE linted:
//      that is exactly where the continuation templates live.
//
// Structure mirrors docs-grep-lint.test.cjs: synthetic-input self-tests
// prove the detector catches what it claims to and spares what it must,
// then real-doc tests assert zero violations. A regression in the
// detector would silently let real bugs through, so the self-tests are
// load-bearing.

const fs = require('fs');
const path = require('path');
const { test, describe } = require('node:test');
const assert = require('node:assert');

const REPO_ROOT = path.join(__dirname, '..');

// Rendering-only inline tags. Everything here has a markdown equivalent.
const BANNED_TAGS = ['sub', 'sup', 'small', 'kbd', 'mark', 'br', 'u', 'font', 'center'];

// Fence languages whose contents are source code, where angle-bracket
// syntax is legitimate and never reaches the terminal as markdown.
const CODE_FENCE_LANGUAGES = new Set([
  'jsx', 'tsx', 'js', 'javascript', 'mjs', 'cjs',
  'ts', 'typescript',
  'html', 'htm', 'vue', 'svelte', 'astro', 'php',
]);

// Terminal-destined markdown. Directories are expanded at run time so
// that a newly added workflow is linted automatically — the whole point
// of the rule is stopping the pattern from being reintroduced by a copy
// of an existing workflow.
const LINTED_DIRS = [
  'gsd-ng/workflows',
  'agents',
];

const LINTED_EXTRA_FILES = [
  'gsd-ng/references/continuation-format.md',
  'gsd-ng/references/ui-brand.md',
];

// Out of scope: templates/ and README.md/CHANGELOG.md/docs/ are read on
// GitHub where HTML renders; tests/ contains path placeholders such as
// `tests/<sub>/*.cjs` that are not tags at all.
function collectLintedFiles() {
  const files = [];
  for (const dir of LINTED_DIRS) {
    const abs = path.join(REPO_ROOT, dir);
    if (!fs.existsSync(abs)) continue;
    for (const name of fs.readdirSync(abs).sort()) {
      if (name.endsWith('.md')) files.push(dir + '/' + name);
    }
  }
  for (const rel of LINTED_EXTRA_FILES) {
    if (fs.existsSync(path.join(REPO_ROOT, rel))) files.push(rel);
  }
  return files;
}

// Remove inline code spans so that prose documenting a banned tag
// (`` `<br>` ``) is not itself flagged. Handles double-backtick spans
// first so their contents can include a lone backtick.
function stripInlineCode(line) {
  return line.replace(/``[^`]*``/g, '').replace(/`[^`]*`/g, '');
}

// Detect a banned rendering-only tag on a line. Returns string reason or
// null.
//
// The tag name must be followed by `>`, `/`, or whitespace, so GSD XML
// tags that merely START with a banned name (`<sub-agent>`, `<mark-done>`)
// are NOT flagged.
function findBannedTag(line) {
  const stripped = stripInlineCode(line);
  const re = new RegExp('</?(' + BANNED_TAGS.join('|') + ')(?:\\s[^>]*)?/?>', 'i');
  const m = re.exec(stripped);
  if (!m) return null;
  return (
    "rendering-only inline HTML '" + m[0] + "' in terminal-destined markdown — " +
    'Claude Code renders GFM without inline HTML, so the tag displays literally. ' +
    'Use markdown instead (`*italics*` for subtext, a blank line for a break)'
  );
}

// Walk a file, skipping fenced blocks that declare a source-code
// language. Returns [{ line, reason, text }] with 1-indexed line numbers.
function lintContent(content) {
  const violations = [];
  const lines = content.split('\n');
  let fenceLang = null; // null = outside a fence
  let inFence = false;

  for (let i = 0; i < lines.length; i++) {
    const fenceMatch = /^\s*```+\s*([A-Za-z0-9+#_.-]*)/.exec(lines[i]);
    if (fenceMatch) {
      if (!inFence) {
        inFence = true;
        fenceLang = fenceMatch[1].toLowerCase();
        continue;
      }
      // A fence line while inside a fence closes it. (Nested fences in
      // GSD docs are written as literal content, not real nesting.)
      inFence = false;
      fenceLang = null;
      continue;
    }
    if (inFence && CODE_FENCE_LANGUAGES.has(fenceLang)) continue;

    const reason = findBannedTag(lines[i]);
    if (reason) violations.push({ line: i + 1, reason, text: lines[i].trim() });
  }
  return violations;
}

// ────────────────────────────────────────────────────────────────────────
// Self-tests: synthetic inputs with known violations prove the detector
// works. If it regresses, the real-doc tests below would silently pass
// even on broken docs — these guard against that.
// ────────────────────────────────────────────────────────────────────────

describe('terminal-html-lint detector', () => {
  test('findBannedTag catches every banned rendering-only tag', () => {
    for (const tag of BANNED_TAGS) {
      assert.ok(findBannedTag('<' + tag + '>text</' + tag + '>'),
        'expected <' + tag + '> to be flagged');
      assert.ok(findBannedTag('</' + tag + '>'),
        'expected closing </' + tag + '> to be flagged');
    }
  });

  test('findBannedTag catches the real-world regression it exists for', () => {
    assert.ok(findBannedTag('<sub>`/clear` first → fresh context window</sub>'));
    assert.ok(findBannedTag('  <sub>`/clear` first → fresh context window</sub>'));
  });

  test('findBannedTag catches self-closing and attributed forms', () => {
    assert.ok(findBannedTag('line one<br>line two'));
    assert.ok(findBannedTag('line one<br/>line two'));
    assert.ok(findBannedTag('line one<br />line two'));
    assert.ok(findBannedTag('<font color="red">warning</font>'));
    assert.ok(findBannedTag('<CENTER>shouty</CENTER>'));
  });

  test('findBannedTag does NOT ban <details> / <summary>', () => {
    // Workflow files write these into ROADMAP.md, which is read on
    // GitHub where HTML renders. <summary> is also a GSD XML tag.
    // This exclusion is the whole design constraint of the lint.
    assert.equal(findBannedTag('<details>'), null);
    assert.equal(findBannedTag('<summary>Phase 2 detail</summary>'), null);
    assert.equal(findBannedTag('</details>'), null);
  });

  test('findBannedTag does NOT flag GSD XML structural tags', () => {
    assert.equal(findBannedTag('<objective>'), null);
    assert.equal(findBannedTag('<config-check>'), null);
    assert.equal(findBannedTag('<untrusted-content>'), null);
  });

  test('findBannedTag does NOT flag tags merely prefixed by a banned name', () => {
    // `\b` after the tag name would wrongly match these — the detector
    // requires `>`, `/` or whitespace immediately after the name.
    assert.equal(findBannedTag('<sub-agent>'), null);
    assert.equal(findBannedTag('<mark-done>'), null);
    assert.equal(findBannedTag('<username>'), null);
    assert.equal(findBannedTag('</sub-agent>'), null);
  });

  test('findBannedTag ignores banned tags inside inline code spans', () => {
    // Prose that documents the banned tags must not trip the lint —
    // continuation-format.md rule 7 does exactly this.
    assert.equal(findBannedTag('use `*italics*`, never `<sub>` or `<br>`'), null);
    assert.equal(findBannedTag('``a `<br>` tag``'), null);
    // …but a bare tag alongside inline code is still caught.
    assert.ok(findBannedTag('`/clear` first <sub>hint</sub>'));
  });

  test('findBannedTag ignores markdown italics (the approved replacement)', () => {
    assert.equal(findBannedTag('*`/clear` first → fresh context window*'), null);
    assert.equal(findBannedTag('  *Final plan in Phase 2*'), null);
  });

  test('lintContent skips fenced blocks declaring a code language', () => {
    const content = [
      '# Heading',              // 1
      '```jsx',                 // 2
      '  return <div><br/></div>;', // 3 — JSX example, not terminal output
      '```',                    // 4
      '```html',                // 5
      '<small>x</small>',       // 6
      '```',                    // 7
    ].join('\n');
    assert.deepEqual(lintContent(content), []);
  });

  test('lintContent DOES lint bare, markdown and bash fences', () => {
    // The continuation templates live in bare and ```markdown fences —
    // skipping those would make the whole lint a no-op.
    const bare = ['```', '<sub>hint</sub>', '```'].join('\n');
    const md = ['```markdown', '<sub>hint</sub>', '```'].join('\n');
    const sh = ['```bash', 'echo "<br>"', '```'].join('\n');
    assert.equal(lintContent(bare).length, 1);
    assert.equal(lintContent(md).length, 1);
    assert.equal(lintContent(sh).length, 1);
  });

  test('lintContent reports correct 1-indexed line numbers', () => {
    const content = [
      '# Heading',        // 1
      '',                 // 2
      '## ▶ Next Up',     // 3
      '<sub>hint</sub>',  // 4
    ].join('\n');
    const violations = lintContent(content);
    assert.equal(violations.length, 1);
    assert.equal(violations[0].line, 4);
  });

  test('lintContent resumes linting after a code fence closes', () => {
    const content = [
      '```jsx',            // 1
      '<br/>',             // 2 — skipped
      '```',               // 3
      '<sub>hint</sub>',   // 4 — must still be caught
    ].join('\n');
    const violations = lintContent(content);
    assert.equal(violations.length, 1);
    assert.equal(violations[0].line, 4);
  });

  test('collectLintedFiles finds the in-scope files and excludes the rest', () => {
    // A broken collector would lint nothing and pass vacuously.
    const files = collectLintedFiles();
    assert.ok(files.length > 20, 'expected >20 linted files, got ' + files.length);
    assert.ok(files.includes('gsd-ng/workflows/progress.md'));
    assert.ok(files.includes('gsd-ng/references/continuation-format.md'));
    assert.ok(files.includes('gsd-ng/references/ui-brand.md'));
    assert.ok(files.some(f => f.startsWith('agents/')));
    // Out-of-scope trees must never be picked up.
    assert.ok(!files.some(f => f.startsWith('templates/')));
    assert.ok(!files.some(f => f.startsWith('tests/')));
    assert.ok(!files.some(f => f.startsWith('docs/')));
    assert.ok(!files.includes('README.md'));
    assert.ok(!files.includes('CHANGELOG.md'));
  });
});

// ────────────────────────────────────────────────────────────────────────
// Real-doc tests: every terminal-destined file must have zero violations.
// ────────────────────────────────────────────────────────────────────────

describe('terminal-html-lint real docs', () => {
  for (const rel of collectLintedFiles()) {
    test(rel + ' has no rendering-only inline HTML', () => {
      const content = fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
      const violations = lintContent(content);
      const formatted = violations.map(v =>
        '  ' + rel + ':' + v.line + ' ' + v.reason + '\n    line: ' + v.text
      ).join('\n');
      assert.equal(violations.length, 0,
        violations.length + ' violation(s) in ' + rel + ':\n' + formatted);
    });
  }
});

module.exports = {
  BANNED_TAGS,
  collectLintedFiles,
  stripInlineCode,
  findBannedTag,
  lintContent,
};
