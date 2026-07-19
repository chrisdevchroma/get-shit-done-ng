'use strict';

/**
 * Security gate commit status — publication and maintainer override.
 *
 * The gate is a COMMIT STATUS posted against the pull request head commit
 * under the context `security-gate`. It is not a check run.
 *
 * Why a status and not a check run: GitHub only permits the app that created a
 * check run to update it, so an override that mutates a check run depends on
 * an undocumented property of GitHub's authorization model and cannot be
 * verified from inside this repository. Commit statuses have no such
 * restriction — any token with write access may post one, and the newest
 * status for a context is the one that counts. The override therefore
 * SUPERSEDES the failing gate by posting a newer status rather than mutating
 * an existing object. Nothing here rests on undocumented behaviour.
 *
 * Both halves take an injected client (the Octokit instance that
 * actions/github-script provides), so the logic runs under test against a
 * stub. There is no standalone command-line entry point: the client only
 * exists inside the workflow step.
 *
 * Platform portability: every platform call goes through `postGateStatus` or
 * `readGateStatus` below. GitHub, Gitea and Forgejo share this route shape
 * (`POST /repos/{owner}/{repo}/statuses/{sha}`) and GitLab has an equivalent,
 * so porting means reimplementing those two functions, not tracing calls
 * through the logic. Only the GitHub client is implemented here.
 *
 * Fail-closed properties:
 *   - The override only supersedes an existing `failure` gate. A pull request
 *     that was never scanned has no gate status and cannot be passed by
 *     comment.
 *   - A scan step that crashes or is skipped publishes `failure`, not
 *     `success`.
 *   - Authorization and the reason requirement both precede any write.
 */

// Commit-status context. This is the string a maintainer makes required under
// branch protection, and the identity the override must post under for the
// supersede to take effect.
const GATE_CONTEXT = 'security-gate';

const OVERRIDE_PREFIX = '/security-override:';

// Collaborator permission levels that may override the gate.
const OVERRIDE_PERMISSIONS = ['write', 'admin', 'maintain'];

// GitHub rejects a commit-status description longer than this.
const MAX_DESCRIPTION = 140;

// The combined-status endpoint defaults to 30 statuses per page, accepts 100.
const STATUS_PAGE_SIZE = 100;
const MAX_STATUS_PAGES = 10;

/**
 * Post a commit status under the gate context.
 *
 * One of the two platform-facing functions in this module.
 *
 * @param {object} opts
 * @param {object} opts.client - Octokit-shaped client
 * @param {string} opts.owner
 * @param {string} opts.repo
 * @param {string} opts.sha - commit the status attaches to
 * @param {'success'|'failure'} opts.state
 * @param {string} opts.description - truncated to the platform limit
 * @returns {Promise<object>} the created status
 */
async function postGateStatus(opts) {
  const { client, owner, repo, sha, state, description } = opts;

  if (!sha) throw new Error('a gate status requires a commit SHA');

  const { data } = await client.rest.repos.createCommitStatus({
    owner,
    repo,
    sha,
    state,
    context: GATE_CONTEXT,
    description: truncate(description, MAX_DESCRIPTION),
  });

  return data;
}

/**
 * Read the current gate state for a commit.
 *
 * The combined-status endpoint reports the latest status per context, which is
 * exactly the value branch protection would evaluate. It is paginated and the
 * gate's position among a commit's contexts is not ours to control, so the
 * pages are walked rather than read once.
 *
 * @returns {Promise<string|null>} the gate state, or null when never posted
 */
async function readGateStatus(opts) {
  const { client, owner, repo, sha } = opts;

  for (let page = 1; page <= MAX_STATUS_PAGES; page++) {
    const { data } = await client.rest.repos.getCombinedStatusForRef({
      owner,
      repo,
      ref: sha,
      per_page: STATUS_PAGE_SIZE,
      page,
    });

    const statuses = (data && data.statuses) || [];
    const gate = statuses.find((s) => s && s.context === GATE_CONTEXT);
    if (gate) return gate.state;
    if (statuses.length < STATUS_PAGE_SIZE) return null;
  }

  // Past the cap the state is unknown. Reporting it as absent is the
  // fail-closed direction: an absent gate cannot be overridden.
  return null;
}

function truncate(text, limit) {
  const value = String(text == null ? '' : text);
  return value.length <= limit ? value : `${value.slice(0, limit - 1)}…`;
}

/**
 * Extract the justification from an override comment body.
 *
 * @param {string} body
 * @returns {string|null} trimmed reason, or null when absent or empty
 */
function parseOverrideReason(body) {
  if (typeof body !== 'string') return null;
  const match = /^\/security-override:[ \t]*(.+)$/m.exec(body.trim());
  if (!match) return null;
  const reason = match[1].trim();
  return reason.length > 0 ? reason : null;
}

/**
 * Turn the scan step's result into a gate verdict.
 *
 * Anything that is not a clean run blocks. `incomplete` separates a scan that
 * reached no verdict from one that found something, which only the exit code
 * distinguishes: exit 1 is a finding, anything else is an incomplete run.
 *
 * @param {object} opts
 * @param {string} opts.outcome - the Actions step outcome
 * @param {string|number} [opts.exitCode] - absent when the step never ran
 * @returns {{blocked: boolean, incomplete: boolean}}
 */
function classifyScanOutcome(opts) {
  const { outcome, exitCode } = opts || {};

  if (outcome === 'success') return { blocked: false, incomplete: false };

  const code = exitCode == null || exitCode === '' ? null : Number(exitCode);
  return { blocked: true, incomplete: code !== 1 };
}

/**
 * Publish the scan verdict as the gate status.
 *
 * Called on every run of the scan workflow, whatever the scan concluded, so
 * that every pull request produces a gate verdict. A gate that only appeared
 * on failure would leave clean pull requests pending forever once the context
 * is required, as would a workflow that a pull request never starts.
 *
 * @param {object} opts
 * @param {object} opts.github - Octokit-shaped client
 * @param {string} opts.owner
 * @param {string} opts.repo
 * @param {string} opts.headSha
 * @param {boolean} opts.blocked - true when the run did not clear the PR
 * @param {boolean} [opts.incomplete] - true when the scan reached no verdict;
 *   changes the message only, never the state
 * @returns {Promise<object>} the created status
 */
async function publishGateVerdict(opts) {
  const { github, owner, repo, headSha, blocked, incomplete = false } = opts;

  const state = blocked ? 'failure' : 'success';
  let description;
  if (!blocked) {
    description = 'No blocking findings.';
  } else if (incomplete) {
    description = `Scan did not complete; no verdict. Maintainers: ${OVERRIDE_PREFIX} <reason>`;
  } else {
    description = `Injection findings detected. Maintainers: ${OVERRIDE_PREFIX} <reason>`;
  }

  return postGateStatus({
    client: github,
    owner,
    repo,
    sha: headSha,
    state,
    description,
  });
}

/**
 * Apply a maintainer override by superseding a failing gate status.
 *
 * Returns a structured result rather than calling into the Actions core
 * helpers, so the caller decides what is a step failure and the logic stays
 * testable in isolation.
 *
 * @param {object} opts
 * @param {object} opts.github - Octokit-shaped client
 * @param {string} opts.owner
 * @param {string} opts.repo
 * @param {number} opts.prNumber
 * @param {object} opts.comment - issue_comment payload comment
 * @returns {Promise<{status: 'applied'|'rejected'|'noop', message: string,
 *   reason?: string}>}
 */
async function processOverride(opts) {
  const { github, owner, repo, prNumber, comment } = opts;

  const username = comment && comment.user ? comment.user.login : null;
  if (!username) {
    return { status: 'rejected', message: 'Override comment has no author.' };
  }

  const reason = parseOverrideReason(comment.body);
  if (!reason) {
    return {
      status: 'rejected',
      message: `Override requires a reason. Format: ${OVERRIDE_PREFIX} <reason>`,
    };
  }

  // Authorization. A read-only or unaffiliated commenter must not be able to
  // clear the gate, so this precedes every write.
  const { data: permission } =
    await github.rest.repos.getCollaboratorPermissionLevel({
      owner,
      repo,
      username,
    });

  const level = permission ? permission.permission : null;
  if (!OVERRIDE_PERMISSIONS.includes(level)) {
    return {
      status: 'rejected',
      message: `User ${username} does not have write permissions (has: ${level})`,
    };
  }

  const { data: pr } = await github.rest.pulls.get({
    owner,
    repo,
    pull_number: prNumber,
  });

  const headSha = pr && pr.head ? pr.head.sha : null;
  if (!headSha) {
    return {
      status: 'rejected',
      message: `Could not resolve head commit for pull request #${prNumber}`,
    };
  }

  // Only a failing gate may be superseded. An absent gate means the commit was
  // never scanned, and overriding it would pass unreviewed code.
  const current = await readGateStatus({
    client: github,
    owner,
    repo,
    sha: headSha,
  });

  if (current !== 'failure') {
    return {
      status: 'noop',
      message:
        current === null
          ? `No ${GATE_CONTEXT} status on this commit. Nothing to override.`
          : `The ${GATE_CONTEXT} status is already "${current}". Nothing to override.`,
    };
  }

  await postGateStatus({
    client: github,
    owner,
    repo,
    sha: headSha,
    state: 'success',
    description: `Override by @${username}: ${reason}`,
  });

  return {
    status: 'applied',
    reason,
    message: `Security gate overridden by @${username}. Reason: ${reason}`,
  };
}

module.exports = {
  GATE_CONTEXT,
  OVERRIDE_PREFIX,
  OVERRIDE_PERMISSIONS,
  MAX_DESCRIPTION,
  STATUS_PAGE_SIZE,
  MAX_STATUS_PAGES,
  truncate,
  classifyScanOutcome,
  postGateStatus,
  readGateStatus,
  parseOverrideReason,
  publishGateVerdict,
  processOverride,
};
