'use strict';

// Tests for the security gate commit status and the maintainer override.
//
// SCOPE BOUNDARY — READ BEFORE TRUSTING THESE TESTS.
//
// Every platform interaction here is a stub. These tests prove OUR logic is
// correct given an API that conforms to the documented commit-status contract.
// They prove NOTHING about GitHub's actual behaviour: not that a newer status
// supersedes an older one, not that permission levels are reported as modelled,
// not that a required status context gates a merge.
//
// The static workflow assertions at the bottom are not simulations — they read
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

// The verdict predates the comment, so the maintainer could have seen it.
const VERDICT_AT = '2026-01-01T11:00:00Z';
const COMMENTED_AT = '2026-01-01T12:00:00Z';

/**
 * Minimal Octokit-shaped stub. Records every call so tests can assert on the
 * request that was made, not merely on the returned value.
 *
 * `getCombinedStatusForRef` returns the latest status per context, matching
 * the endpoint's documented shape. A foreign context is always present so a
 * lookup that ignores the context filter picks up the wrong state.
 */
function makeGitHubStub(options = {}) {
  const {
    gateState = 'failure',
    gateCreatedAt = VERDICT_AT,
    headSha = HEAD_SHA,
  } = options;
  const permission =
    'permission' in options ? options.permission : 'admin';

  const calls = { permission: [], pulls: [], combined: [], statuses: [] };

  const statuses = [
    { context: 'ci/build', state: 'success', created_at: gateCreatedAt },
  ];
  if (gateState !== null) {
    statuses.push({
      context: GATE_CONTEXT,
      state: gateState,
      created_at: gateCreatedAt,
    });
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
          return { data: { head: { sha: headSha } } };
        },
      },
    },
  };
}

function comment(body, login = 'maintainer', createdAt = COMMENTED_AT) {
  return { body, user: { login }, created_at: createdAt };
}

function override(github, body, login, createdAt) {
  return gate.processOverride({
    github,
    owner: 'acme',
    repo: 'widgets',
    prNumber: 42,
    comment: comment(body, login, createdAt),
  });
}

describe('security gate: maintainer override', () => {
  test('a maintainer comment with a reason posts a passing gate carrying the reason', async () => {
    const github = makeGitHubStub({ permission: 'write' });

    const result = await override(
      github,
      `/security-override: ${HEAD_SHA} vendored fixture, reviewed by hand`,
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
    await override(github, `/security-override: ${HEAD_SHA} reviewed`);

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
      const result = await override(
        github,
        `/security-override: ${HEAD_SHA} reviewed`,
      );
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
    const green = makeGitHubStub({ gateState: 'success' });
    const passed = await override(
      green,
      `/security-override: ${HEAD_SHA} nothing wrong`,
    );
    assert.equal(passed.status, 'noop');
    assert.equal(green.calls.statuses.length, 0);

    // Never scanned: no gate status exists at all. This is the fail-closed
    // case — an unscanned commit must not become passable by comment.
    const unscanned = makeGitHubStub({ gateState: null });
    const never = await override(
      unscanned,
      `/security-override: ${HEAD_SHA} skip it`,
    );
    assert.equal(never.status, 'noop');
    assert.equal(unscanned.calls.statuses.length, 0);
    assert.match(never.message, /Nothing to override/);
  });

  test('the gate state is read from the gate context, not another context', async () => {
    // The stub always carries a passing `ci/build` status. Logic that reads
    // the first status rather than the gate's would see success and no-op.
    const github = makeGitHubStub({ gateState: 'failure' });
    const result = await override(
      github,
      `/security-override: ${HEAD_SHA} reviewed`,
    );

    assert.equal(github.calls.combined.length, 1);
    assert.equal(github.calls.combined[0].ref, HEAD_SHA);
    assert.equal(result.status, 'applied');
  });
});

describe('security gate: override command parsing', () => {
  test('the command is only recognised at the start of the comment body', () => {
    const bodies = [
      'Looks good to me.\n/security-override: reviewed',
      'line one\nline two\n/security-override: reviewed',
      '> /security-override: reviewed',
      'Quoting a maintainer:\n\n> /security-override: reviewed',
      '```\n/security-override: reviewed\n```',
      'x /security-override: reviewed',
    ];

    for (const body of bodies) {
      assert.equal(
        gate.parseOverrideCommand(body),
        null,
        `body ${JSON.stringify(body)} must not parse as an override`,
      );
      assert.equal(gate.parseOverrideReason(body), null);
    }
  });

  test('leading whitespace does not parse, matching the workflow trigger', () => {
    // The workflow gates on startsWith() against the UNTRIMMED body, so a body
    // opening with whitespace never starts a run. Trimming here would make the
    // module strictly more permissive than the only caller that reaches it.
    const yaml = readWorkflow('security-override.yml');
    assert.match(
      yaml,
      /startsWith\(github\.event\.comment\.body, '\/security-override:'\)/,
      'the trigger this test pins its direction to has moved',
    );

    for (const body of [
      ' /security-override: reviewed',
      '\t/security-override: reviewed',
      '\n/security-override: reviewed',
    ]) {
      assert.equal(gate.parseOverrideCommand(body), null);
    }
  });

  test('a command on the first line parses even with prose beneath it', () => {
    const parsed = gate.parseOverrideCommand(
      '/security-override: vendored fixture\n\nFull rationale below.\n',
    );
    assert.deepEqual(parsed, { sha: null, reason: 'vendored fixture' });
  });

  test('a pinned SHA is captured and not swallowed into the reason', () => {
    const parsed = gate.parseOverrideCommand(
      `/security-override: ${HEAD_SHA} reviewed by hand`,
    );
    assert.deepEqual(parsed, { sha: HEAD_SHA, reason: 'reviewed by hand' });
    assert.doesNotMatch(parsed.reason, /a{7}/);

    const abbreviated = gate.parseOverrideCommand(
      '/security-override: AAAAAAA reviewed by hand',
    );
    assert.deepEqual(abbreviated, {
      sha: 'aaaaaaa',
      reason: 'reviewed by hand',
    });
  });

  test('a pinned SHA with no reason after it is rejected', () => {
    assert.equal(gate.parseOverrideCommand(`/security-override: ${HEAD_SHA}`), null);
  });

  test('an ordinary reason is not mistaken for a pinned SHA', () => {
    const parsed = gate.parseOverrideCommand('/security-override: decaf is fine');
    assert.deepEqual(parsed, { sha: null, reason: 'decaf is fine' });
  });
});

describe('security gate: override cannot clear an unseen verdict', () => {
  test('a verdict created after the comment is refused', async () => {
    // Maintainer reviews commit A and comments; the contributor pushes B; B is
    // scanned and fails. The comment predates that verdict, so it cannot be an
    // approval of it.
    const github = makeGitHubStub({
      gateCreatedAt: '2026-01-01T12:00:01Z',
    });

    const result = await override(
      github,
      `/security-override: ${HEAD_SHA} reviewed`,
    );

    assert.equal(result.status, 'rejected');
    assert.match(result.message, /after|newer/i);
    assert.equal(
      github.calls.statuses.length,
      0,
      'a refused override must post nothing',
    );
  });

  test('a verdict created before the comment is applied', async () => {
    const github = makeGitHubStub({ gateCreatedAt: '2026-01-01T11:59:59Z' });
    const result = await override(
      github,
      `/security-override: ${HEAD_SHA} reviewed`,
    );

    assert.equal(result.status, 'applied');
    assert.equal(github.calls.statuses.length, 1);
    assert.equal(github.calls.statuses[0].state, 'success');
  });

  test('a missing timestamp on either side is refused, not assumed fresh', async () => {
    const noStatusTime = makeGitHubStub({ gateCreatedAt: null });
    const a = await override(
      noStatusTime,
      `/security-override: ${HEAD_SHA} reviewed`,
    );
    assert.equal(a.status, 'rejected');
    assert.equal(noStatusTime.calls.statuses.length, 0);

    const noCommentTime = makeGitHubStub();
    const b = await override(
      noCommentTime,
      `/security-override: ${HEAD_SHA} reviewed`,
      'maintainer',
      null,
    );
    assert.equal(b.status, 'rejected');
    assert.equal(noCommentTime.calls.statuses.length, 0);
  });

  test('a pinned SHA matching the head is still refused when the verdict postdates the comment', async () => {
    // The pin proves which code was approved; it does not prove which verdict
    // was read. A verdict posted after the comment reports findings the
    // maintainer never saw, even on the very commit they named — a re-run under
    // an updated ruleset produces exactly that. Refusing costs one comment.
    const github = makeGitHubStub({ gateCreatedAt: '2026-06-01T00:00:00Z' });
    const result = await override(
      github,
      `/security-override: ${HEAD_SHA} reviewed by hand`,
    );

    assert.equal(result.status, 'rejected');
    assert.match(result.message, /after/i);
    assert.equal(github.calls.statuses.length, 0);
  });

  test('a pinned SHA matching the head applies and carries the reason through', async () => {
    const github = makeGitHubStub();
    const result = await override(
      github,
      `/security-override: ${HEAD_SHA} reviewed by hand`,
    );

    assert.equal(result.status, 'applied');
    assert.equal(result.reason, 'reviewed by hand');
    assert.equal(github.calls.statuses.length, 1);
    assert.equal(github.calls.statuses[0].sha, HEAD_SHA);
    assert.equal(
      github.calls.statuses[0].description,
      'Override by @maintainer: reviewed by hand',
    );
  });

  test('an abbreviated pinned SHA matches by prefix', async () => {
    const github = makeGitHubStub();
    const result = await override(
      github,
      '/security-override: aaaaaaa reviewed by hand',
    );
    assert.equal(result.status, 'applied');
  });

  test('a pinned SHA naming a superseded commit is refused', async () => {
    const github = makeGitHubStub({ headSha: 'b'.repeat(40) });
    const result = await override(
      github,
      `/security-override: ${HEAD_SHA} reviewed by hand`,
    );

    assert.equal(result.status, 'rejected');
    assert.match(result.message, /b{7}/);
    assert.equal(
      github.calls.statuses.length,
      0,
      'a mismatched pin must post nothing',
    );
  });
});

describe('security gate: the pinned SHA is mandatory', () => {
  test('an override naming no commit is refused and posts nothing', async () => {
    const github = makeGitHubStub();
    const result = await override(
      github,
      '/security-override: vendored fixture, reviewed by hand',
    );

    assert.equal(result.status, 'rejected');
    assert.match(
      result.message,
      /must name the commit/i,
      'the refusal must be the missing-pin one, not the mismatch branch ' +
        'reporting a commit named "null"',
    );
    assert.doesNotMatch(result.message, /names commit/i);
    assert.equal(
      github.calls.statuses.length,
      0,
      'an unpinned override must post nothing',
    );
  });

  test('the refusal names the required form and the current head', async () => {
    const head = 'c'.repeat(40);
    const github = makeGitHubStub({ headSha: head });
    const result = await override(github, '/security-override: reviewed');

    assert.match(
      result.message,
      /\/security-override: <sha> <reason>/,
      'the maintainer must be told the form that would work',
    );
    assert.ok(
      result.message.includes(head),
      'the message must carry the head SHA verbatim so it can be copied',
    );
  });

  test('a partial SHA too short to be a pin is refused, not read as a reason', async () => {
    // Six hex characters fall below the pin threshold. Treating them as prose
    // would apply an override the maintainer believed was pinned.
    const github = makeGitHubStub({ headSha: `aaaaaa${'b'.repeat(34)}` });
    const result = await override(github, '/security-override: aaaaaa reviewed');

    assert.equal(result.status, 'rejected');
    assert.match(result.message, /must name the commit/i);
    assert.match(result.message, /\/security-override: <sha> <reason>/);
    assert.equal(github.calls.statuses.length, 0);
  });

  test('a reason opening with a hex word is refused as a mismatched pin, with the form spelled out', async () => {
    // `deadbeef` is indistinguishable from an abbreviated SHA. The refusal has
    // to make that reading visible, or the maintainer cannot see why a plain
    // sentence was rejected.
    const github = makeGitHubStub();
    const result = await override(
      github,
      '/security-override: deadbeef looks fine to me',
    );

    assert.equal(result.status, 'rejected');
    assert.match(result.message, /deadbeef/);
    assert.match(result.message, /\/security-override: <sha> <reason>/);
    assert.equal(github.calls.statuses.length, 0);
  });

  test('a multi-word reason survives a pin intact', async () => {
    const github = makeGitHubStub();
    const reason = 'vendored fixture: 0xdeadbeef in the diff is test data';
    const result = await override(
      github,
      `/security-override: ${HEAD_SHA} ${reason}`,
    );

    assert.equal(result.status, 'applied');
    assert.equal(result.reason, reason);
    assert.ok(github.calls.statuses[0].description.endsWith(reason));
  });

  test('the workflow trigger stays prefix-only so an unpinned command still reaches the refusal', () => {
    // Narrowing `startsWith` to the pinned form would make a malformed command
    // start no run at all: no refusal, no annotation, silence.
    const yaml = readWorkflow('security-override.yml');
    assert.match(
      yaml,
      /startsWith\(github\.event\.comment\.body, '\/security-override:'\)/,
    );
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
    await override(
      github,
      `/security-override: ${HEAD_SHA} ${'x'.repeat(500)}`,
    );

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

  test('the reference documents the pinned form as the only form', () => {
    const reference = fs.readFileSync(
      path.join(
        REPO_ROOT,
        'gsd-ng',
        'references',
        'security-untrusted-content.md',
      ),
      'utf8',
    );

    assert.match(reference, /\/security-override: <sha> <reason>/);
    assert.match(reference, /start of the comment body/i);
    assert.match(
      reference,
      /required|mandatory/i,
      'the doc must say the SHA is required, not offer it as an option',
    );
    assert.doesNotMatch(
      reference,
      /^\/security-override: <reason>$/m,
      'the unpinned form is refused and must not be documented as usable',
    );
    assert.doesNotMatch(
      reference,
      /leaves a window/i,
      'mandatory pinning closed that window; the claim must not survive',
    );
  });
});
