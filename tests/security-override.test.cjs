'use strict';

// Tests for the security gate commit status and the maintainer override.
//
// SCOPE BOUNDARY — READ BEFORE TRUSTING THESE TESTS.
//
// Every platform interaction here is a stub. These tests prove that OUR logic
// is correct given an API that conforms to the documented commit-status
// contract. They prove NOTHING about GitHub's actual behaviour: not that a
// newer status supersedes an older one for the same context, not that
// permission levels are reported as modelled, not that a required status
// context gates a merge. That is simulation, not live fire.
//
// What the design buys is narrower and real. The override posts a NEW commit
// status under an existing context rather than mutating a check run. Mutating
// a check run is restricted to the app that created it — an undocumented
// property of GitHub's authorization model, unverifiable from here. Posting a
// commit status carries no such restriction. The mechanism therefore no longer
// depends on undocumented behaviour, which is a different and stronger claim
// than "we tested GitHub".
//
// The static workflow assertions at the bottom are not simulations. They read
// the committed workflow files and pin structural invariants directly.

const fs = require('fs');
const path = require('path');
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const gate = require('../scripts/security-gate.cjs');
const scanner = require('../scripts/ci-security-scan.cjs');

const REPO_ROOT = path.join(__dirname, '..');
const WORKFLOW_DIR = path.join(REPO_ROOT, '.github', 'workflows');

const GATE_CONTEXT = gate.GATE_CONTEXT;
const HEAD_SHA = 'a'.repeat(40);

/**
 * Minimal Octokit-shaped stub. Records every call so tests can assert on the
 * request that was made, not merely on the returned value.
 *
 * `getCombinedStatusForRef` returns the latest status per context, matching
 * the endpoint's documented shape. A foreign context is always present so a
 * lookup that ignores the context filter picks up the wrong state.
 */
function makeGitHubStub(options = {}) {
  const { gateState = 'failure' } = options;
  const permission =
    'permission' in options ? options.permission : 'admin';

  const calls = { permission: [], pulls: [], combined: [], statuses: [] };

  const statuses = [{ context: 'ci/build', state: 'success' }];
  if (gateState !== null) {
    statuses.push({ context: GATE_CONTEXT, state: gateState });
  }

  return {
    calls,
    rest: {
      repos: {
        async getCollaboratorPermissionLevel(args) {
          calls.permission.push(args);
          return { data: { permission } };
        },
        async getCombinedStatusForRef(args) {
          calls.combined.push(args);
          return { data: { statuses } };
        },
        async createCommitStatus(args) {
          calls.statuses.push(args);
          return { data: { ...args } };
        },
      },
      pulls: {
        async get(args) {
          calls.pulls.push(args);
          return { data: { head: { sha: HEAD_SHA } } };
        },
      },
    },
  };
}

function comment(body, login = 'maintainer') {
  return { body, user: { login } };
}

function override(github, body, login) {
  return gate.processOverride({
    github,
    owner: 'acme',
    repo: 'widgets',
    prNumber: 42,
    comment: comment(body, login),
  });
}

describe('security gate: maintainer override', () => {
  test('a maintainer comment with a reason posts a passing gate carrying the reason', async () => {
    const github = makeGitHubStub({ permission: 'write' });

    const result = await override(
      github,
      '/security-override: vendored fixture, reviewed by hand',
    );

    assert.equal(result.status, 'applied');
    assert.equal(result.reason, 'vendored fixture, reviewed by hand');
    assert.equal(github.calls.statuses.length, 1);

    const posted = github.calls.statuses[0];
    assert.equal(posted.state, 'success');
    assert.equal(posted.sha, HEAD_SHA);
    assert.match(posted.description, /vendored fixture, reviewed by hand/);
    assert.match(posted.description, /@maintainer/);
  });

  test('the override posts under the gate context, not some other context', async () => {
    // A status posted under a different context leaves the failing gate as the
    // newest value for `security-gate`, so branch protection would still block.
    const github = makeGitHubStub();
    await override(github, '/security-override: reviewed');

    assert.equal(github.calls.statuses[0].context, GATE_CONTEXT);
    assert.equal(github.calls.statuses[0].context, 'security-gate');
  });

  test('every permission level below write is rejected and no status is posted', async () => {
    for (const permission of ['read', 'none', 'triage', null, undefined]) {
      const github = makeGitHubStub({ permission });

      const result = await override(
        github,
        '/security-override: trust me',
        'drive-by',
      );

      assert.equal(
        result.status,
        'rejected',
        `permission ${permission} should be rejected`,
      );
      assert.match(result.message, /does not have write permissions/);
      assert.equal(
        github.calls.statuses.length,
        0,
        `permission ${permission} must not post a status`,
      );
    }
  });

  test('each level at or above write is accepted', async () => {
    for (const permission of gate.OVERRIDE_PERMISSIONS) {
      const github = makeGitHubStub({ permission });
      const result = await override(github, '/security-override: reviewed');
      assert.equal(result.status, 'applied', `${permission} should be allowed`);
      assert.equal(github.calls.statuses[0].state, 'success');
    }
  });

  test('a comment with no reason is rejected before any permission lookup', async () => {
    for (const body of [
      '/security-override:',
      '/security-override:    ',
      '/security-override',
      'please /security-override: sneaky',
    ]) {
      const github = makeGitHubStub();
      const result = await override(github, body);
      assert.equal(result.status, 'rejected', `body ${JSON.stringify(body)}`);
      assert.equal(github.calls.permission.length, 0);
      assert.equal(github.calls.statuses.length, 0);
    }
  });

  test('a commit with no failing gate is a no-op', async () => {
    // Gate already green: nothing to override.
    const green = makeGitHubStub({ gateState: 'success' });
    const passed = await override(green, '/security-override: nothing wrong');
    assert.equal(passed.status, 'noop');
    assert.equal(green.calls.statuses.length, 0);

    // Never scanned: no gate status exists at all. This is the fail-closed
    // case — an unscanned commit must not become passable by comment.
    const unscanned = makeGitHubStub({ gateState: null });
    const never = await override(unscanned, '/security-override: skip it');
    assert.equal(never.status, 'noop');
    assert.equal(unscanned.calls.statuses.length, 0);
    assert.match(never.message, /Nothing to override/);
  });

  test('the gate state is read from the gate context, not another context', async () => {
    // The stub always carries a passing `ci/build` status. Logic that reads
    // the first status rather than the gate's would see success and no-op.
    const github = makeGitHubStub({ gateState: 'failure' });
    const result = await override(github, '/security-override: reviewed');

    assert.equal(github.calls.combined.length, 1);
    assert.equal(github.calls.combined[0].ref, HEAD_SHA);
    assert.equal(result.status, 'applied');
  });
});

describe('security gate: verdict publication', () => {
  const POISONED = [
    {
      filename: 'commands/gsd-plan.md',
      status: 'modified',
      patch: '+[click here](javascript:alert(1))',
    },
  ];
  const CLEAN = [
    {
      filename: 'commands/gsd-plan.md',
      status: 'modified',
      patch: '+Ordinary documentation describing the planning command.',
    },
  ];

  // Drives the real scanner and feeds its verdict into publication, mirroring
  // what the workflow does via the scan step's exit status.
  async function publishFor(files) {
    const report = await scanner.analyzePullRequestFiles(files);
    const github = makeGitHubStub();
    await gate.publishGateVerdict({
      github,
      owner: 'acme',
      repo: 'widgets',
      headSha: HEAD_SHA,
      blocked: report.hasBlocking,
    });
    return { report, posted: github.calls.statuses };
  }

  test('a poisoned payload posts a failing gate naming the override command', async () => {
    const { report, posted } = await publishFor(POISONED);

    assert.equal(report.hasBlocking, true, 'scanner must block the payload');
    assert.equal(posted.length, 1);
    assert.equal(posted[0].context, GATE_CONTEXT);
    assert.equal(posted[0].state, 'failure');
    assert.equal(posted[0].sha, HEAD_SHA);
    assert.match(posted[0].description, /\/security-override:/);
  });

  test('a clean payload posts a passing gate', async () => {
    const { report, posted } = await publishFor(CLEAN);

    assert.equal(report.hasBlocking, false, 'scanner must clear the payload');
    assert.equal(posted.length, 1);
    assert.equal(posted[0].context, GATE_CONTEXT);
    assert.equal(posted[0].state, 'success');
    // A passing gate must not advertise the override command; that text is the
    // failure branch's, and its absence proves the two branches really differ.
    assert.doesNotMatch(posted[0].description, /\/security-override:/);
  });

  test('publication refuses to proceed without a commit SHA', async () => {
    const github = makeGitHubStub();
    await assert.rejects(
      () =>
        gate.publishGateVerdict({
          github,
          owner: 'acme',
          repo: 'widgets',
          headSha: null,
          blocked: false,
        }),
      /requires a commit SHA/,
    );
    assert.equal(github.calls.statuses.length, 0);
  });

  test('a long reason is truncated to the platform description limit', async () => {
    const github = makeGitHubStub();
    await override(github, `/security-override: ${'x'.repeat(500)}`);

    const description = github.calls.statuses[0].description;
    assert.ok(
      description.length <= gate.MAX_DESCRIPTION,
      `description was ${description.length} characters; the platform rejects ` +
        `anything over ${gate.MAX_DESCRIPTION}`,
    );
  });
});

// --- Static workflow invariants (not simulations) ---------------------------

function readWorkflow(name) {
  return fs.readFileSync(path.join(WORKFLOW_DIR, name), 'utf8');
}

// Split a workflow into list-item blocks. A block runs from one `- ` list
// marker to the next, which is enough to scope a step's own keys: any `ref:`
// belonging to a checkout step appears inside that step's block.
function listItemBlocks(yaml) {
  const lines = yaml.split('\n');
  const starts = [];
  lines.forEach((line, i) => {
    if (/^\s*- /.test(line)) starts.push(i);
  });
  return starts.map((start, n) => {
    const end = n + 1 < starts.length ? starts[n + 1] : lines.length;
    return lines.slice(start, end).join('\n');
  });
}

describe('security gate: workflow invariants', () => {
  test('the scan workflow checks out with no ref, so contributor code never executes', () => {
    const yaml = readWorkflow('security-scan.yml');
    const checkouts = listItemBlocks(yaml).filter((block) =>
      /uses:\s*actions\/checkout@/.test(block),
    );

    assert.ok(checkouts.length > 0, 'expected a checkout step');
    for (const block of checkouts) {
      assert.doesNotMatch(
        block,
        /^\s*ref:/m,
        'checkout must not specify a ref: the untrusted trigger requires the ' +
          'default branch, and a ref would run contributor-supplied code',
      );
    }
  });

  test('the scan workflow publishes the gate on every run', () => {
    const yaml = readWorkflow('security-scan.yml');
    // Word-bounded: a substring match would still accept a renamed symbol.
    assert.match(yaml, /\bsecurity-gate\.cjs\b/);
    assert.match(yaml, /\bpublishGateVerdict\b/);
    // `if: always()` is what makes a blocking verdict still produce a gate.
    const publish = listItemBlocks(yaml).find((block) =>
      /\bpublishGateVerdict\b/.test(block),
    );
    assert.ok(publish, 'expected a publication step');
    assert.match(publish, /if:\s*always\(\)/);
  });

  test('the override workflow delegates to the shared module', () => {
    const yaml = readWorkflow('security-override.yml');
    assert.match(yaml, /\bsecurity-gate\.cjs\b/);
    assert.match(yaml, /\bprocessOverride\b/);
    // The superseded design mutated a check run inline.
    assert.doesNotMatch(yaml, /checks\.update/);
  });

  test('both workflows request statuses: write and no checks scope', () => {
    for (const name of ['security-scan.yml', 'security-override.yml']) {
      const yaml = readWorkflow(name);
      const block = /^permissions:\n((?:\s{2}\S.*\n)+)/m.exec(yaml);
      assert.ok(block, `${name} must declare an explicit permissions block`);
      const granted = block[1]
        .trim()
        .split('\n')
        .map((l) => l.trim());

      assert.ok(
        granted.includes('statuses: write'),
        `${name} must be able to post the gate status`,
      );
      assert.ok(
        !granted.some((g) => g.startsWith('checks:')),
        `${name} no longer uses the Checks API and must not request it`,
      );
      // Nothing in either workflow writes to the repository or its issues.
      assert.ok(
        !granted.includes('contents: write'),
        `${name} must not gain write scope over repository contents`,
      );
    }
  });

  test('the gate context is a single definition shared by module and docs', () => {
    assert.equal(GATE_CONTEXT, 'security-gate');
    const reference = fs.readFileSync(
      path.join(
        REPO_ROOT,
        'gsd-ng',
        'references',
        'security-untrusted-content.md',
      ),
      'utf8',
    );
    assert.match(reference, /`security-gate`/);
    assert.match(reference, /required status check/i);
  });
});
