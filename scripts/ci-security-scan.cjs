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
 */

const { scanForInjection } = require('../gsd-ng/bin/lib/security.cjs');

// Repository path prefixes whose contents become agent context: anything an
// agent may read as instructions (commands, agent definitions, hooks, the
// packaged runtime, workflow and script code, prose docs shipped alongside).
// Matching is a plain prefix test, so directory entries end in '/' and bare
// filenames match that file at the repository root.
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
// Must match the 'paths:' trigger in .github/workflows/security-scan.yml —
// a path scanned here but absent there never starts the workflow at all. The
// two lists are asserted equal by the test suite.
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
  'CLAUDE.md',
];

// Exact repository paths whose high-confidence hits do not fail the build.
//
// Both entries are the injection detector itself and its written reference:
// they enumerate the attack strings they exist to recognise, so every scan
// trips on them and the repository would block its own security work.
//
// These files are still scanned and every finding is still emitted as an
// annotation — the exemption removes the failure, not the signal. Exact
// paths only (no prefixes, no globs), and the test suite deep-equals this
// array so it cannot grow without a deliberate, reviewed edit.
const BLOCK_EXEMPT_PATHS = [
  'gsd-ng/bin/lib/security.cjs',
  'gsd-ng/references/security-untrusted-content.md',
];

// Upper bound on paginated file-list requests. A pull request larger than
// this is refused rather than scanned partially.
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
 * Fetch the complete changed-file list for a pull request, following
 * pagination to the last page. A single page caps at 100 entries; stopping
 * there would silently leave every further changed file unscanned.
 *
 * @param {object} opts
 * @param {string} opts.repository - owner/name
 * @param {string|number} opts.prNumber
 * @param {string} opts.token
 * @param {Function} [opts.fetchImpl] - injectable fetch (tests)
 * @param {number} [opts.maxPages]
 * @returns {Promise<object[]>} every changed-file entry
 */
async function fetchPRFiles(opts) {
  const {
    repository,
    prNumber,
    token,
    fetchImpl = fetch,
    maxPages = MAX_FILE_PAGES,
  } = opts;

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
    if (!next) return all;
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

// Exact-path membership. Never a prefix or glob test — a prefix exemption on
// a directory would silently cover files added to it later.
function isBlockExempt(filename) {
  return BLOCK_EXEMPT_PATHS.includes(filename);
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
    let content = file.patch;

    // No diff hunk. The API omits `patch` for oversized and binary-classified
    // files, so skipping here would let an attacker pad a file past the limit
    // to slip content through unscanned. Read the full blob instead, and fail
    // closed if even that is unavailable.
    if (!content) {
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

    const exempt = isBlockExempt(file.filename);

    if (result.blocked.length > 0) {
      if (!exempt) hasBlocking = true;
      for (const pattern of result.blocked) {
        annotations.push({
          level: exempt ? 'warning' : 'error',
          file: file.filename,
          message: exempt
            ? `High-confidence injection pattern (known detector content, not blocking — review manually): ${pattern}`
            : `High-confidence injection pattern detected: ${pattern}`,
        });
      }
      if (exempt) warningCount += result.blocked.length;
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

async function main(env = process.env) {
  const prNumber = env.PR_NUMBER;
  const token = env.GITHUB_TOKEN;
  const repository = env.GITHUB_REPOSITORY;

  if (!prNumber || !token || !repository) {
    console.error(
      'Missing required env vars: PR_NUMBER, GITHUB_TOKEN, GITHUB_REPOSITORY',
    );
    return 1;
  }

  const files = await fetchPRFiles({ repository, prNumber, token });
  const report = await analyzePullRequestFiles(files, {
    getContent: (file) => fetchFileContent(file, { token }),
  });

  if (report.scannable.length === 0) {
    console.log('No scannable files in PR diff.');
    return 0;
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
    console.log('Maintainers can override with: /security-override: <reason>');
    return 1;
  }

  return 0;
}

if (require.main === module) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(`Security scan failed: ${err.message}`);
      process.exit(1);
    });
}

module.exports = {
  SCAN_PATHS,
  BLOCK_EXEMPT_PATHS,
  MAX_FILE_PAGES,
  parseNextLink,
  fetchPRFiles,
  fetchFileContent,
  shouldScan,
  isBlockExempt,
  formatAnnotation,
  analyzePullRequestFiles,
  main,
};
