#!/usr/bin/env node
'use strict';

/**
 * CI Security Scan — Scans PR diff for injection patterns
 *
 * Reuses security.cjs patterns. No duplicate pattern definitions.
 * Reads PR_NUMBER, GITHUB_TOKEN and GITHUB_REPOSITORY from environment.
 * Outputs GitHub Actions annotations (::error, ::warning).
 *
 * Exit code:
 *   0 — clean or warnings only
 *   1 — high-confidence detections found (blocking), or a scannable file
 *       whose content could not be retrieved (fail closed)
 *   2 — the scan did not complete (bad environment, API or runtime error)
 *
 * Both 1 and 2 block. They are distinct so the gate status can say which.
 */

const { scanForInjection } = require('../gsd-ng/bin/lib/security.cjs');

// Repository path prefixes whose contents become agent context: anything an
// agent may read as instructions (commands, agent definitions, hooks, the
// packaged runtime, workflow and script code, prose docs shipped alongside).
// Matching is a plain prefix test, so directory entries end in '/' and bare
// filenames match that file at the repository root. Root files are covered
// only by name, so every tracked root markdown file must be listed here.
//
// Deliberately NOT covered: tests/ and benchmarks/. Those hold the detector's
// own fixture corpus — files that exist precisely to contain attack strings —
// so scanning them would report the fixtures as attacks. They are not read as
// agent instructions.
//
// '.planning/' and '.claude/' are untracked in this repository but are the
// canonical agent-context locations in an installed project; they are listed
// so a change that introduces them here is covered from the first commit.
//
// This list narrows the changed files. The workflow runs on every pull request
// so that a required status is always posted.
const SCAN_PATHS = [
  '.claude/',
  '.github/',
  '.planning/',
  'agents/',
  'assets/',
  'bin/',
  'commands/',
  'docs/',
  'gsd-ng/',
  'hooks/',
  'scripts/',
  'AGENTS.md',
  'CHANGELOG.md',
  'CLAUDE.md',
  'CONTRIBUTING.md',
  'README.md',
  'SECURITY.md',
  'VERSIONING.md',
];

// Exact repository paths permitted to declare exempt regions. Being listed
// here exempts nothing on its own — it only means markers in this file are
// honoured. What is exempt is the text between them, so prose added anywhere
// else in the file blocks exactly as it would in any other file.
//
// Both entries enumerate the attack strings they exist to recognise, so they
// trip their own detector and the repository would otherwise block its own
// security work. `security-untrusted-content.md` is @-included into three
// shipped workflows, which makes it the most attractive file in the tree to
// poison; a whole-file exemption would have covered every line an attacker
// appended to it.
//
// Findings are still emitted for exempt matches — the exemption removes the
// failure, not the signal. Exact paths only (no prefixes, no globs), and the
// test suite deep-equals this array so it cannot grow unreviewed.
const REGION_EXEMPT_PATHS = [
  'gsd-ng/bin/lib/security.cjs',
  'gsd-ng/references/security-untrusted-content.md',
];

// A marker must occupy its own line, optionally wrapped in comment syntax, so
// it cannot be smuggled into the middle of a sentence.
//
// Markdown uses the link-reference form `[//]: # (…)`, which renders as
// nothing. The HTML comment form is deliberately not accepted: the dotall
// html-comment injection rule matches a whole document from a single comment
// opener, so marking the security reference up that way — or naming the
// syntax in this pattern — adds a false positive to the measured budget.
const EXEMPT_MARKER =
  /^\s*(?:\/\*|\/\/|#|\*|\[\/\/\]:\s*#\s*\()?\s*security-scan:exempt-(start|end)\s*(?:\*\/|\))?\s*$/;

// Runaway-pagination guard only. It cannot establish that the whole diff was
// retrieved: 30 pages of 100 is 3000 entries, which is exactly GitHub's own
// ceiling on the files endpoint, so the cap can never be reached before the
// API stops paginating. Completeness is established against the pull
// request's own changed_files count instead.
const MAX_FILE_PAGES = 30;

function githubHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
}

// Extract the rel="next" URL from an RFC 8288 Link header, or null when the
// current page is the last one.
function parseNextLink(linkHeader) {
  if (!linkHeader) return null;
  for (const part of String(linkHeader).split(',')) {
    const match = /^\s*<([^>]+)>\s*;\s*(.+)$/.exec(part);
    if (!match) continue;
    if (/\brel\s*=\s*"?next"?/.test(match[2])) return match[1];
  }
  return null;
}

/**
 * Fetch a pull request, for the metadata the files endpoint does not carry.
 *
 * @returns {Promise<object>} the pull request object
 */
async function fetchPullRequest(opts) {
  const { repository, prNumber, token, fetchImpl = fetch } = opts;
  const response = await fetchImpl(
    `https://api.github.com/repos/${repository}/pulls/${prNumber}`,
    { headers: githubHeaders(token) },
  );
  if (!response.ok) {
    throw new Error(
      `GitHub API error: ${response.status} ${response.statusText}`,
    );
  }
  return response.json();
}

/**
 * Fetch the complete changed-file list for a pull request, following
 * pagination to the last page. A single page caps at 100 entries; stopping
 * there would silently leave every further changed file unscanned.
 *
 * The endpoint returns at most 3000 files however many pages are requested, so
 * pagination ending is not evidence the list is complete. When
 * `expectedFileCount` is supplied, a short list is refused rather than scanned:
 * an unscannable remainder must fail the gate, not pass it quietly.
 *
 * @param {object} opts
 * @param {string} opts.repository - owner/name
 * @param {string|number} opts.prNumber
 * @param {string} opts.token
 * @param {Function} [opts.fetchImpl] - injectable fetch (tests)
 * @param {number} [opts.maxPages]
 * @param {number} [opts.expectedFileCount] - the pull request's changed_files
 * @returns {Promise<object[]>} every changed-file entry
 */
async function fetchPRFiles(opts) {
  const {
    repository,
    prNumber,
    token,
    fetchImpl = fetch,
    maxPages = MAX_FILE_PAGES,
    expectedFileCount,
  } = opts;

  const assertComplete = (all) => {
    if (Number.isInteger(expectedFileCount) && all.length < expectedFileCount) {
      throw new Error(
        `Pull request reports ${expectedFileCount} changed files but only ${all.length} could be retrieved — refusing to scan a partial diff`,
      );
    }
    return all;
  };

  let url = `https://api.github.com/repos/${repository}/pulls/${prNumber}/files?per_page=100`;
  const all = [];

  for (let page = 0; page < maxPages; page++) {
    const response = await fetchImpl(url, { headers: githubHeaders(token) });
    if (!response.ok) {
      throw new Error(
        `GitHub API error: ${response.status} ${response.statusText}`,
      );
    }
    const batch = await response.json();
    if (Array.isArray(batch)) all.push(...batch);

    const linkHeader = response.headers ? response.headers.get('link') : null;
    const next = parseNextLink(linkHeader);
    if (!next) return assertComplete(all);
    url = next;
  }

  throw new Error(
    `Pull request file list exceeded ${maxPages} pages — refusing to scan a partial diff`,
  );
}

/**
 * Fetch a changed file's full contents at the pull request head commit.
 *
 * Used when the API omits `patch` (which it does for oversized diffs and for
 * anything it classifies as binary). Reading is safe under this workflow's
 * trust model: the checkout is of the default branch and no pull request code
 * is executed — this only widens what is read.
 *
 * @returns {Promise<string|null>} decoded contents, or null when unavailable
 */
async function fetchFileContent(file, opts) {
  const { token, fetchImpl = fetch } = opts;
  if (!file || !file.contents_url) return null;

  let response;
  try {
    response = await fetchImpl(file.contents_url, {
      headers: githubHeaders(token),
    });
  } catch {
    return null;
  }
  if (!response || !response.ok) return null;

  let body;
  try {
    body = await response.json();
  } catch {
    return null;
  }
  if (!body || typeof body.content !== 'string') return null;
  if (body.encoding !== 'base64') return null;

  return Buffer.from(body.content, 'base64').toString('utf8');
}

function shouldScan(filename) {
  if (typeof filename !== 'string') return false;
  return SCAN_PATHS.some((prefix) => filename.startsWith(prefix));
}

/**
 * Rebuild the post-change file text from a unified diff hunk.
 *
 * Detector patterns join words with `\s+`, and `\s` matches a newline, so a
 * payload wrapped across lines matches in ordinary file text. In raw diff text
 * it does not: the `+` that prefixes each continuation line interrupts the
 * whitespace run. Scanning the raw patch therefore misses any payload split
 * over two added lines.
 *
 * Removed lines are dropped rather than stripped, so deleting an injection
 * does not report the deletion as the attack.
 *
 * @param {string} patch - unified diff hunk text
 * @returns {string} the added and context lines, prefixes removed
 */
function reconstructFromPatch(patch) {
  if (typeof patch !== 'string' || patch === '') return '';

  const kept = [];
  for (const line of patch.split('\n')) {
    if (line.startsWith('@@')) continue;
    if (line.startsWith('\\ ')) continue;
    if (line.startsWith('-')) continue;
    if (line.startsWith('+') || line.startsWith(' ')) {
      kept.push(line.slice(1));
      continue;
    }
    kept.push(line);
  }
  return kept.join('\n');
}

// Exact-path membership. Never a prefix or glob test — a prefix entry on a
// directory would silently cover files added to it later.
function hasExemptRegions(filename) {
  return REGION_EXEMPT_PATHS.includes(filename);
}

/**
 * Remove the text between exempt markers.
 *
 * The result is what the blocking verdict is computed against; annotations
 * still come from the full text.
 *
 * An unterminated region is treated as no exemption at all rather than as one
 * running to end of file. Otherwise a single added start marker would exempt
 * everything below it.
 *
 * @param {string} content
 * @returns {string} content with every closed exempt region removed
 */
function stripExemptRegions(content) {
  const text = String(content);
  const kept = [];
  let inside = false;

  for (const line of text.split('\n')) {
    const marker = EXEMPT_MARKER.exec(line);
    if (marker) {
      inside = marker[1] === 'start';
      continue;
    }
    if (!inside) kept.push(line);
  }

  return inside ? text : kept.join('\n');
}

function formatAnnotation(annotation) {
  return `::${annotation.level} file=${annotation.file}::${annotation.message}`;
}

/**
 * Scan a changed-file list and produce annotations plus a blocking verdict.
 * Pure apart from the injected `getContent`, so tests drive it directly.
 *
 * @param {object[]} files - changed-file entries from the pull request API
 * @param {object} [opts]
 * @param {Function} [opts.getContent] - async (file) => string|null, called
 *   only when `patch` is absent. Returning null means "could not read".
 * @returns {Promise<object>} report
 */
async function analyzePullRequestFiles(files, opts = {}) {
  const { getContent = async () => null } = opts;

  const scannable = (files || []).filter(
    (f) => f && shouldScan(f.filename) && f.status !== 'removed',
  );

  const annotations = [];
  let hasBlocking = false;
  let warningCount = 0;
  let unreadableCount = 0;
  let blobScannedCount = 0;

  for (const file of scannable) {
    // A file carrying exempt regions is read whole rather than from its diff.
    // A hunk need not include the marker lines that enclose the text it
    // changes, so the region structure is only intact in the full file.
    const regionAware = hasExemptRegions(file.filename);
    const hasPatch =
      !regionAware && typeof file.patch === 'string' && file.patch !== '';
    let content = hasPatch ? reconstructFromPatch(file.patch) : '';

    // No diff hunk. The API omits `patch` for oversized and binary-classified
    // files, so skipping here would let an attacker pad a file past the limit
    // to slip content through unscanned. Read the full blob instead, and fail
    // closed if even that is unavailable.
    if (!hasPatch) {
      const blob = await getContent(file);
      if (blob === null || blob === undefined) {
        hasBlocking = true;
        unreadableCount++;
        annotations.push({
          level: 'error',
          file: file.filename,
          message:
            'No diff content and file contents could not be retrieved — cannot verify this file, failing closed',
        });
        continue;
      }
      content = blob;
      blobScannedCount++;
    }

    const result = scanForInjection(content, { external: true });
    if (result.clean) continue;

    // Exemption is decided per pattern, not per file: a rule that still fires
    // once the exempt regions are removed is firing on unexempt text, even if
    // the same rule also matches a quoted example inside a region.
    const blockedOutsideRegions = regionAware
      ? new Set(
          scanForInjection(stripExemptRegions(content), { external: true })
            .blocked,
        )
      : null;

    for (const pattern of result.blocked) {
      const exempt =
        blockedOutsideRegions !== null && !blockedOutsideRegions.has(pattern);
      if (exempt) warningCount++;
      else hasBlocking = true;

      annotations.push({
        level: exempt ? 'warning' : 'error',
        file: file.filename,
        message: exempt
          ? `High-confidence injection pattern inside a declared exempt region (not blocking — review manually): ${pattern}`
          : `High-confidence injection pattern detected: ${pattern}`,
      });
    }

    for (const pattern of result.findings) {
      warningCount++;
      annotations.push({
        level: 'warning',
        file: file.filename,
        message: `Medium-confidence injection pattern: ${pattern}`,
      });
    }
  }

  return {
    scannable,
    annotations,
    hasBlocking,
    warningCount,
    unreadableCount,
    blobScannedCount,
  };
}

const EXIT_CLEAN = 0;
const EXIT_BLOCKED = 1;
const EXIT_INCOMPLETE = 2;

async function main(env = process.env) {
  const prNumber = env.PR_NUMBER;
  const token = env.GITHUB_TOKEN;
  const repository = env.GITHUB_REPOSITORY;

  if (!prNumber || !token || !repository) {
    console.error(
      'Missing required env vars: PR_NUMBER, GITHUB_TOKEN, GITHUB_REPOSITORY',
    );
    return EXIT_INCOMPLETE;
  }

  // A diff that cannot be retrieved in full is not a clean diff. Reported as
  // an incomplete scan rather than a detection: both block, and the gate
  // description distinguishes them.
  let files;
  try {
    const pullRequest = await fetchPullRequest({ repository, prNumber, token });
    files = await fetchPRFiles({
      repository,
      prNumber,
      token,
      expectedFileCount: pullRequest.changed_files,
    });
  } catch (err) {
    console.error(`Could not retrieve the pull request diff: ${err.message}`);
    return EXIT_INCOMPLETE;
  }
  const report = await analyzePullRequestFiles(files, {
    getContent: (file) => fetchFileContent(file, { token }),
  });

  // Out-of-scope diffs must exit clean, not skip: the gate status is published
  // from this exit code and a required check needs a verdict.
  if (report.scannable.length === 0) {
    console.log('No scannable files in PR diff.');
    return EXIT_CLEAN;
  }

  for (const annotation of report.annotations) {
    console.log(formatAnnotation(annotation));
  }

  console.log(
    `\nScan complete: ${report.scannable.length} files scanned` +
      (report.blobScannedCount > 0
        ? ` (${report.blobScannedCount} via full contents)`
        : '') +
      `, ${report.hasBlocking ? 'BLOCKED' : 'PASSED'}, ${report.warningCount} warnings`,
  );

  if (report.unreadableCount > 0) {
    console.log(
      `${report.unreadableCount} file(s) could not be read and were treated as failures.`,
    );
  }

  if (report.hasBlocking) {
    console.log('\nHigh-confidence injection detected. PR check failed.');
    console.log(
      'Maintainers can override with: /security-override: <sha> <reason>',
    );
    return EXIT_BLOCKED;
  }

  return EXIT_CLEAN;
}

if (require.main === module) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(`Security scan failed: ${err.message}`);
      process.exit(EXIT_INCOMPLETE);
    });
}

module.exports = {
  EXIT_CLEAN,
  EXIT_BLOCKED,
  EXIT_INCOMPLETE,
  SCAN_PATHS,
  REGION_EXEMPT_PATHS,
  EXEMPT_MARKER,
  MAX_FILE_PAGES,
  parseNextLink,
  fetchPullRequest,
  fetchPRFiles,
  fetchFileContent,
  shouldScan,
  reconstructFromPatch,
  hasExemptRegions,
  stripExemptRegions,
  formatAnnotation,
  analyzePullRequestFiles,
  main,
};
