'use strict';

// Lint that rejects assertions guarded by a catch clause which discards the
// AssertionError. Such a test cannot fail: node:assert throws, the catch
// absorbs the throw, and the test reports ok regardless of the assertion's
// outcome.
//
// A catch is treated as deliberate when it rethrows, asserts on the caught
// error, or calls a fail/skip helper. A catch that only assigns from the
// error and continues is a swallow.
//
// Matching is brace-aware over a copy of the source in which comment,
// string, template-text and regex-literal content has been replaced by
// spaces, so a brace or the word `throw` inside a literal cannot influence
// the result. Offsets and newlines are preserved, so indices map back to
// original line numbers.

const fs = require('fs');
const path = require('path');
const { test, describe } = require('node:test');
const assert = require('node:assert');

const REPO_ROOT = path.join(__dirname, '..');
const SCAN_DIRS = ['tests', 'hooks', 'bin', 'gsd-ng/bin', 'scripts'];

const REGEX_PRECEDING_CHARS = new Set([
  '=',
  '(',
  ',',
  ':',
  '[',
  '!',
  '&',
  '|',
  '?',
  '{',
  '}',
  ';',
  '+',
  '-',
  '*',
  '%',
  '~',
  '^',
  '<',
  '>',
  '',
]);

const REGEX_PRECEDING_WORDS = new Set([
  'return',
  'typeof',
  'case',
  'in',
  'of',
  'do',
  'else',
  'void',
  'delete',
  'throw',
  'new',
  'yield',
  'await',
]);

const ASSERTION_RE = /\bassert\b\s*[.(]|\bexpect\s*\(/g;
const HANDLED_RE = /\bthrow\b|\bassert\b\s*[.(]|\bexpect\s*\(|\b\w*fail\s*\(|\.skip\s*\(/;

function isWordChar(c) {
  return c !== undefined && /[A-Za-z0-9_$]/.test(c);
}

function blankNonCode(src) {
  const out = src.split('');
  const n = src.length;
  const wipe = (a, b) => {
    for (let k = a; k < b && k < n; k++) if (out[k] !== '\n') out[k] = ' ';
  };

  let i = 0;
  let mode = 'code';
  let depth = 0;
  const interpolations = [];
  let prevSig = '';
  let prevWord = '';

  while (i < n) {
    const c = src[i];

    if (mode === 'template') {
      if (c === '\\') {
        wipe(i, i + 2);
        i += 2;
        continue;
      }
      if (c === '`') {
        mode = 'code';
        prevSig = '`';
        prevWord = '';
        i++;
        continue;
      }
      if (c === '$' && src[i + 1] === '{') {
        interpolations.push(depth);
        depth++;
        mode = 'code';
        prevSig = '{';
        prevWord = '';
        i += 2;
        continue;
      }
      if (c !== '\n') out[i] = ' ';
      i++;
      continue;
    }

    if (c === '/' && src[i + 1] === '/') {
      let j = src.indexOf('\n', i);
      if (j === -1) j = n;
      wipe(i, j);
      i = j;
      continue;
    }

    if (c === '/' && src[i + 1] === '*') {
      let j = src.indexOf('*/', i + 2);
      j = j === -1 ? n : j + 2;
      wipe(i, j);
      i = j;
      continue;
    }

    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < n) {
        if (src[j] === '\\') {
          j += 2;
          continue;
        }
        if (src[j] === c || src[j] === '\n') break;
        j++;
      }
      wipe(i + 1, j);
      i = j + 1;
      prevSig = c;
      prevWord = '';
      continue;
    }

    if (c === '`') {
      mode = 'template';
      i++;
      continue;
    }

    if (
      c === '/' &&
      (REGEX_PRECEDING_CHARS.has(prevSig) || REGEX_PRECEDING_WORDS.has(prevWord))
    ) {
      let j = i + 1;
      let inClass = false;
      let closed = false;
      while (j < n && src[j] !== '\n') {
        if (src[j] === '\\') {
          j += 2;
          continue;
        }
        if (src[j] === '[') inClass = true;
        else if (src[j] === ']') inClass = false;
        else if (src[j] === '/' && !inClass) {
          closed = true;
          break;
        }
        j++;
      }
      if (closed) {
        wipe(i + 1, j);
        i = j + 1;
        prevSig = '/';
        prevWord = '';
        continue;
      }
    }

    if (isWordChar(c)) {
      let j = i;
      while (j < n && isWordChar(src[j])) j++;
      prevWord = src.slice(i, j);
      prevSig = src[j - 1];
      i = j;
      continue;
    }

    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (interpolations.length && depth === interpolations[interpolations.length - 1]) {
        interpolations.pop();
        mode = 'template';
        i++;
        continue;
      }
    }

    if (!/\s/.test(c)) {
      prevSig = c;
      prevWord = '';
    }
    i++;
  }

  return out.join('');
}

function matchForward(s, open) {
  let d = 0;
  for (let i = open; i < s.length; i++) {
    if (s[i] === '{') d++;
    else if (s[i] === '}') {
      d--;
      if (d === 0) return i;
    }
  }
  return -1;
}

function matchBackward(s, close) {
  let d = 0;
  for (let i = close; i >= 0; i--) {
    if (s[i] === '}') d++;
    else if (s[i] === '{') {
      d--;
      if (d === 0) return i;
    }
  }
  return -1;
}

function prevSignificant(s, from) {
  for (let i = from; i >= 0; i--) {
    if (!/\s/.test(s[i])) return { char: s[i], index: i };
  }
  return { char: '', index: -1 };
}

function lineOf(src, index) {
  let line = 1;
  for (let i = 0; i < index && i < src.length; i++) if (src[i] === '\n') line++;
  return line;
}

function countAssertions(code) {
  const matches = code.match(ASSERTION_RE);
  return matches ? matches.length : 0;
}

function findSwallowedAssertions(source) {
  if (typeof source !== 'string' || source.length === 0) return [];
  const code = blankNonCode(source);
  const violations = [];
  const catchRe = /\bcatch\b/g;
  let m;

  while ((m = catchRe.exec(code))) {
    if (isWordChar(code[m.index - 1])) continue;
    const before = prevSignificant(code, m.index - 1);
    if (before.char !== '}') continue;

    let k = m.index + 5;
    while (k < code.length && /\s/.test(code[k])) k++;
    if (code[k] === '(') {
      let d = 0;
      while (k < code.length) {
        if (code[k] === '(') d++;
        else if (code[k] === ')') {
          d--;
          if (d === 0) {
            k++;
            break;
          }
        }
        k++;
      }
      while (k < code.length && /\s/.test(code[k])) k++;
    }
    if (code[k] !== '{') continue;

    const catchClose = matchForward(code, k);
    if (catchClose === -1) continue;
    const catchBody = code.slice(k + 1, catchClose);
    if (HANDLED_RE.test(catchBody)) continue;

    const tryOpen = matchBackward(code, before.index);
    if (tryOpen === -1) continue;
    const beforeTry = prevSignificant(code, tryOpen - 1);
    if (code.slice(Math.max(0, beforeTry.index - 2), beforeTry.index + 1) !== 'try') continue;

    const tryBody = code.slice(tryOpen + 1, before.index);
    const assertions = countAssertions(tryBody);
    if (assertions === 0) continue;

    violations.push({
      tryLine: lineOf(source, tryOpen),
      catchLine: lineOf(source, m.index),
      assertions,
      catchSnippet: source
        .slice(k + 1, catchClose)
        .trim()
        .replace(/\s+/g, ' ')
        .slice(0, 80),
    });
  }

  return violations;
}

function listCodeFiles() {
  const seen = new Set();
  for (const dir of SCAN_DIRS) {
    const abs = path.join(REPO_ROOT, dir);
    let entries;
    try {
      entries = fs.readdirSync(abs, { recursive: true, withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!e.isFile()) continue;
      if (!/\.(cjs|js)$/.test(e.name)) continue;
      const parent = e.parentPath || e.path || abs;
      seen.add(path.relative(REPO_ROOT, path.join(parent, e.name)));
    }
  }
  return [...seen].sort();
}

describe('swallowed-assertion detector', () => {
  test('flags an assertion guarded by an empty catch', () => {
    const src = [
      'test("x", () => {',
      '  try {',
      '    assert.ok(danger());',
      '  } catch {}',
      '});',
    ].join('\n');
    const found = findSwallowedAssertions(src);
    assert.strictEqual(found.length, 1);
    assert.strictEqual(found[0].assertions, 1);
    assert.strictEqual(found[0].catchLine, 4);
  });

  test('flags the swallow-into-variable shape (catch assigns from err)', () => {
    const src = [
      'let output = "";',
      'try {',
      '  output = execSync(cmd).toString();',
      '  assert.ok(!output.includes("rm -rf /"));',
      '} catch (err) {',
      '  output = err.stdout ? err.stdout.toString() : "";',
      '}',
    ].join('\n');
    const found = findSwallowedAssertions(src);
    assert.strictEqual(found.length, 1);
    assert.strictEqual(found[0].assertions, 1);
  });

  test('does not flag a catch that rethrows', () => {
    const src = [
      'try {',
      '  assert.ok(x);',
      '} catch (err) {',
      '  cleanup();',
      '  throw err;',
      '}',
    ].join('\n');
    assert.deepStrictEqual(findSwallowedAssertions(src), []);
  });

  test('does not flag a conditional rethrow of AssertionError', () => {
    const src = [
      'try {',
      '  assert.ok(x);',
      '} catch (err) {',
      '  if (err instanceof assert.AssertionError) throw err;',
      '}',
    ].join('\n');
    assert.deepStrictEqual(findSwallowedAssertions(src), []);
  });

  test('does not flag a catch containing no assertion in its try (teardown case)', () => {
    const src = ['try {', '  server.close();', '  fs.unlinkSync(sock);', '} catch {}'].join('\n');
    assert.deepStrictEqual(findSwallowedAssertions(src), []);
  });

  test('does not flag a catch that asserts on the caught error', () => {
    const src = [
      'try {',
      '  assert.ok(parse(bad));',
      '} catch (err) {',
      '  assert.match(err.message, /invalid/);',
      '}',
    ].join('\n');
    assert.deepStrictEqual(findSwallowedAssertions(src), []);
  });

  test('does not flag try/finally with no catch', () => {
    const src = [
      'try {',
      '  assert.strictEqual(a, b);',
      '} finally {',
      '  fs.unlinkSync(tmp);',
      '}',
    ].join('\n');
    assert.deepStrictEqual(findSwallowedAssertions(src), []);
  });

  test('does not flag promise .catch() handlers', () => {
    const src = ['run().catch((err) => {', '  logged = err;', '});'].join('\n');
    assert.deepStrictEqual(findSwallowedAssertions(src), []);
  });

  test('braces inside string literals are not miscounted', () => {
    const src = [
      'try {',
      '  const s = "} catch {";',
      '  fs.writeFileSync(p, s);',
      '} catch {}',
      'try {',
      '  assert.ok(x);',
      '} catch (err) {',
      '  throw err;',
      '}',
    ].join('\n');
    assert.deepStrictEqual(findSwallowedAssertions(src), []);
  });

  test('braces inside template literals and interpolations are not miscounted', () => {
    const src = [
      'try {',
      '  const t = `prefix } catch { ${obj.k} suffix`;',
      '  use(t);',
      '} catch {}',
      'try {',
      '  assert.ok(y);',
      '} catch (err) {',
      '  throw err;',
      '}',
    ].join('\n');
    assert.deepStrictEqual(findSwallowedAssertions(src), []);
  });

  test('nested template interpolation containing a template is handled', () => {
    const src = [
      'try {',
      '  const t = `a ${cond ? `x } y` : "}"} b`;',
      '  assert.ok(t);',
      '} catch {}',
    ].join('\n');
    const found = findSwallowedAssertions(src);
    assert.strictEqual(found.length, 1);
    assert.strictEqual(found[0].assertions, 1);
  });

  test('braces inside regex literals are not miscounted', () => {
    const src = [
      'try {',
      '  const re = /\\{[^}]*}/g;',
      '  assert.ok(re.test(s));',
      '} catch {}',
    ].join('\n');
    const found = findSwallowedAssertions(src);
    assert.strictEqual(found.length, 1);
  });

  test('division is not mistaken for a regex literal', () => {
    const src = [
      'try {',
      '  const ratio = total / count;',
      '  assert.ok(ratio > 0);',
      '} catch {}',
    ].join('\n');
    assert.strictEqual(findSwallowedAssertions(src).length, 1);
  });

  test('assert mentioned only in a comment or string does not count', () => {
    const src = [
      'try {',
      '  // assert.ok(x) used to live here',
      '  const msg = "assert.ok(y)";',
      '  send(msg);',
      '} catch {}',
    ].join('\n');
    assert.deepStrictEqual(findSwallowedAssertions(src), []);
  });

  test('throw appearing only in a string does not count as a rethrow', () => {
    const src = [
      'try {',
      '  assert.ok(x);',
      '} catch (err) {',
      '  log("throw");',
      '}',
    ].join('\n');
    assert.strictEqual(findSwallowedAssertions(src).length, 1);
  });

  test('reports every violation in a file, not just the first', () => {
    const src = [
      'try { assert.ok(a); } catch {}',
      'try { assert.ok(b); } catch (e) { seen = e; }',
    ].join('\n');
    const found = findSwallowedAssertions(src);
    assert.strictEqual(found.length, 2);
    assert.deepStrictEqual(
      found.map((v) => v.catchLine),
      [1, 2],
    );
  });

  test('counts multiple assertions inside one swallowing try', () => {
    const src = [
      'try {',
      '  assert.ok(a);',
      '  assert.strictEqual(b, c);',
      '  assert(d);',
      '} catch {}',
    ].join('\n');
    assert.strictEqual(findSwallowedAssertions(src)[0].assertions, 3);
  });

  test('tolerates empty and non-string input', () => {
    assert.deepStrictEqual(findSwallowedAssertions(''), []);
    assert.deepStrictEqual(findSwallowedAssertions(null), []);
    assert.deepStrictEqual(findSwallowedAssertions(undefined), []);
  });

  test('blankNonCode preserves length and line count', () => {
    const src = 'const a = "x{y}z"; // } catch {\nconst b = `t}`;\n';
    const blanked = blankNonCode(src);
    assert.strictEqual(blanked.length, src.length);
    assert.strictEqual(blanked.split('\n').length, src.split('\n').length);
  });
});

describe('swallowed-assertion scan of repository sources', () => {
  const files = listCodeFiles();

  test('file discovery returns a non-empty set covering every scanned dir', () => {
    assert.ok(files.length > 0, 'no source files discovered — scanner would be a no-op');
    for (const dir of SCAN_DIRS) {
      const abs = path.join(REPO_ROOT, dir);
      if (!fs.existsSync(abs)) continue;
      assert.ok(
        files.some((f) => f.startsWith(dir + path.sep)),
        `no files discovered under ${dir}`,
      );
    }
  });

  test('discovered file count matches the test files present on disk', () => {
    const onDisk = fs
      .readdirSync(path.join(REPO_ROOT, 'tests'))
      .filter((f) => f.endsWith('.test.cjs'));
    const discovered = files.filter(
      (f) => f.startsWith('tests' + path.sep) && f.endsWith('.test.cjs'),
    );
    assert.ok(onDisk.length > 0);
    for (const name of onDisk) {
      assert.ok(
        discovered.includes(path.join('tests', name)),
        `${name} present on disk but not discovered by the scanner`,
      );
    }
  });

  test('every discovered file is readable and scanned (no silent skips)', () => {
    let scanned = 0;
    const unreadable = [];
    for (const rel of files) {
      let source;
      try {
        source = fs.readFileSync(path.join(REPO_ROOT, rel), 'utf-8');
      } catch (err) {
        unreadable.push(`${rel}: ${err.message}`);
        continue;
      }
      assert.strictEqual(typeof source, 'string');
      findSwallowedAssertions(source);
      scanned++;
    }
    assert.deepStrictEqual(unreadable, [], 'files could not be read: ' + unreadable.join(', '));
    assert.strictEqual(scanned, files.length);
    assert.ok(scanned > 0);
  });

  test('no assertion is guarded by a swallowing catch', () => {
    const violations = [];
    for (const rel of files) {
      const source = fs.readFileSync(path.join(REPO_ROOT, rel), 'utf-8');
      for (const v of findSwallowedAssertions(source)) {
        violations.push(
          `${rel}:${v.tryLine} — try block holds ${v.assertions} assertion(s); ` +
            `catch at line ${v.catchLine} does not rethrow: {${v.catchSnippet}}`,
        );
      }
    }
    assert.deepStrictEqual(
      violations,
      [],
      'Assertions cannot fail because an enclosing catch discards the AssertionError:\n' +
        violations.join('\n'),
    );
  });
});

module.exports = {
  blankNonCode,
  findSwallowedAssertions,
  listCodeFiles,
};
