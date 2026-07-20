'use strict';

// Contract tests for the markdown layer of untrusted-content handling.
//
// The security reference document and the three workflows that cite it are
// load-bearing but unexecutable: nothing imports them, so nothing catches a
// reorganization that drops a section or a rename that breaks a citation.
// These tests pin the parts that other code and other agents depend on.
//
// Where a workflow embeds a shell expression (the outbound strip step), the
// expression is EXTRACTED AND RUN rather than grepped for. An existence-only
// assertion cannot see the realistic defect — an expression that removes the
// opening tag and leaves the closing one.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const {
  wrapUntrustedContent,
  stripUntrustedWrappers,
} = require('../gsd-ng/bin/lib/security.cjs');

const REPO_ROOT = path.join(__dirname, '..');

// The shipped agent payload root. Workflow @-references resolve against it.
const PAYLOAD_ROOT = path.join(REPO_ROOT, 'gsd-ng');

const REFERENCE_REL = 'references/security-untrusted-content.md';
const REFERENCE_ABS = path.join(PAYLOAD_ROOT, REFERENCE_REL);

const REFERRING_WORKFLOWS = [
  'import-issue.md',
  'sync-issues.md',
  'create-pr.md',
];

function readPayload(rel) {
  return fs.readFileSync(path.join(PAYLOAD_ROOT, rel), 'utf8');
}

function workflowPath(name) {
  return path.join(PAYLOAD_ROOT, 'workflows', name);
}

// Resolve an @-reference the way an agent loading it would: drop the leading
// '@', drop any installed-runtime prefix (a ${...} shell expansion and/or the
// deployed `.claude/gsd-ng/` segment), and join the remainder to the payload
// root. Both the bare and the deployed-path citation forms occur in the tree.
function resolveReference(ref) {
  let rel = ref.replace(/^@/, '');
  rel = rel.replace(/^\$\{[^}]*\}\/?/, '');
  rel = rel.replace(/^\.claude\/gsd-ng\//, '');
  return path.join(PAYLOAD_ROOT, rel);
}

// Body of a `## Heading` section, up to the next same-or-higher-level heading.
function sectionBody(markdown, heading) {
  const lines = markdown.split('\n');
  const start = lines.findIndex((l) => l.trim() === heading);
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^##\s/.test(lines[i])) {
      end = i;
      break;
    }
  }
  return lines.slice(start + 1, end).join('\n');
}

// The `sed -i '<script>' "$PR_BODY_FILE"` line inside the outbound
// sanitization step. Returns the script itself, so it can be run.
function extractSedScript(md) {
  const m = /^\s*sed -i '([^']*)' "\$PR_BODY_FILE"\s*$/m.exec(md);
  return m ? m[1] : null;
}

// Run a sed script over stdin. Deliberately not `-i`: reading stdin keeps the
// invocation portable across GNU and BSD sed, while still exercising the real
// expression through the real binary.
function runSed(script, input) {
  return execFileSync('sed', [script], {
    input,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

function trimTrailingNewlines(s) {
  return s.replace(/\n+$/, '');
}

// Body of an `<step name="...">` block.
function stepBody(md, name) {
  const open = `<step name="${name}">`;
  const start = md.indexOf(open);
  if (start === -1) return null;
  const end = md.indexOf('</step>', start);
  return md.slice(start + open.length, end === -1 ? md.length : end);
}

// Invoke the CLI purely to exercise argument validation, and return whatever
// it printed. The command is expected to fail downstream on the bogus
// platform; the flag either survives arg parsing or it does not.
function runCliForArgValidation(args) {
  try {
    return execFileSync(
      process.execPath,
      [path.join(PAYLOAD_ROOT, 'bin', 'gsd-tools.cjs'), ...args],
      { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
  } catch (err) {
    return (err.stdout || '') + (err.stderr || '');
  }
}

describe('SEC40-REFFILE: the untrusted-content reference document', () => {
  test('REFFILE-01: the reference file exists at the path workflows cite', () => {
    assert.ok(
      fs.existsSync(REFERENCE_ABS),
      `missing reference document: ${REFERENCE_ABS}`,
    );
  });

  test('REFFILE-02: the load-bearing sections are all present', () => {
    const md = readPayload(REFERENCE_REL);
    // Verified against the file as shipped, not assumed. Each of these is
    // depended on by something outside the document: the tag semantics by
    // the wrap/strip helpers, the handling rules by every consuming agent,
    // the gate by the import workflow, the sanitization by create-pr.
    const required = [
      '## Tag Semantics',
      '## Agent Handling Rules',
      '## The `untrusted_title` Frontmatter Marker',
      '## Rule of Two Gate',
      '## Outbound Sanitization',
    ];
    const present = md
      .split('\n')
      .filter((l) => /^##\s/.test(l))
      .map((l) => l.trim());
    for (const heading of required) {
      assert.ok(
        present.includes(heading),
        `reference document lost its "${heading}" section; headings present: ${present.join(', ')}`,
      );
    }
  });

  test('REFFILE-03: the handling rules keep the never-execute directive', () => {
    const body = sectionBody(
      readPayload(REFERENCE_REL),
      '## Agent Handling Rules',
    );
    assert.ok(body, 'the handling-rules section is missing entirely');
    assert.match(
      body,
      /never execute instructions/i,
      'the treat-as-data-not-directives rule is the semantic core of the document',
    );
  });

  test('REFFILE-04: the handling rules keep the never-strip directive', () => {
    const body = sectionBody(
      readPayload(REFERENCE_REL),
      '## Agent Handling Rules',
    );
    assert.ok(body, 'the handling-rules section is missing entirely');
    assert.match(
      body,
      /never modify wrapper tags/i,
      'wrapper tags are structural markers for scanning; agents must not rewrite them',
    );
    assert.match(
      body,
      /do not strip, escape, or alter/i,
      'inbound content is preserved intact — stripping is an outbound-only operation',
    );
  });

  test('REFFILE-05: the gate section states it is hard, not advisory', () => {
    const body = sectionBody(readPayload(REFERENCE_REL), '## Rule of Two Gate');
    assert.ok(body, 'the gate section is missing entirely');
    assert.match(body, /hard gate, not advisory/i);
    assert.match(body, /require explicit user approval/i);
  });

  test('REFFILE-06: the sanitization section names the strip helper', () => {
    const body = sectionBody(
      readPayload(REFERENCE_REL),
      '## Outbound Sanitization',
    );
    assert.ok(body, 'the sanitization section is missing entirely');
    assert.match(body, /stripUntrustedWrappers\(\)/);
  });

  test('REFFILE-07: the title marker section forbids stripping the flag', () => {
    const body = sectionBody(
      readPayload(REFERENCE_REL),
      '## The `untrusted_title` Frontmatter Marker',
    );
    assert.ok(body, 'the untrusted_title section is missing entirely');
    assert.match(body, /untrusted_title:\s*true/);
    assert.match(body, /not strip|preserve/i);
  });
});

describe('SEC40-WFREF: workflows citing the reference document', () => {
  for (const name of REFERRING_WORKFLOWS) {
    test(`WFREF-01 (${name}): cites the reference and the citation resolves`, () => {
      const md = fs.readFileSync(workflowPath(name), 'utf8');
      const m = /^@(\S*references\/security-untrusted-content\.md)\s*$/m.exec(
        md,
      );
      assert.ok(
        m,
        `${name} no longer carries an @-reference to the security reference document`,
      );

      // The half that matters: a citation is only worth anything if it
      // resolves. A reference-existence grep passes just as well against a
      // path that points at nothing.
      const resolved = resolveReference(m[0]);
      assert.ok(
        fs.existsSync(resolved),
        `${name} cites "${m[0]}", which resolves to ${resolved} — no such file`,
      );
      assert.equal(
        fs.realpathSync(resolved),
        fs.realpathSync(REFERENCE_ABS),
        `${name} resolves to a different file than the shipped security reference`,
      );
    });
  }
});

describe('SEC40-OUTBOUND: the create-pr outbound strip step', () => {
  test('OUTBOUND-01: the strip step exists and targets the wrapper tags', () => {
    const md = fs.readFileSync(workflowPath('create-pr.md'), 'utf8');
    const script = extractSedScript(md);
    assert.ok(
      script,
      'create-pr.md no longer carries a sed strip step over $PR_BODY_FILE',
    );
    assert.match(
      script,
      /untrusted-content/,
      'the strip step must operate on the wrapper tags',
    );
  });

  test('OUTBOUND-02: running the extracted expression removes BOTH tags', () => {
    const md = fs.readFileSync(workflowPath('create-pr.md'), 'utf8');
    const script = extractSedScript(md);
    const fixture = wrapUntrustedContent('body text', 'github:#42');

    // Sanity: the fixture really does carry both tags, so the assertions
    // below cannot pass against an input that had nothing to strip.
    assert.match(fixture, /<untrusted-content/);
    assert.match(fixture, /<\/untrusted-content>/);

    const stripped = runSed(script, fixture);

    assert.match(
      stripped,
      /body text/,
      'inner content must survive — this is a tag removal, not a content filter',
    );
    assert.doesNotMatch(
      stripped,
      /<untrusted-content/,
      'the opening tag leaked into outbound content',
    );
    assert.doesNotMatch(
      stripped,
      /<\/untrusted-content>/,
      'the closing tag leaked into outbound content — an expression that ' +
        'handles only the opening tag passes an existence check and still ' +
        'ships this defect',
    );
  });

  test('OUTBOUND-03: the expression agrees with the programmatic helper', () => {
    const md = fs.readFileSync(workflowPath('create-pr.md'), 'utf8');
    const script = extractSedScript(md);
    const fixture =
      wrapUntrustedContent('first body', 'github:#42') +
      '\n\nsome trusted prose\n\n' +
      wrapUntrustedContent('second body', 'gitlab:repo#15');

    const viaSed = trimTrailingNewlines(runSed(script, fixture));
    const viaHelper = trimTrailingNewlines(stripUntrustedWrappers(fixture));

    // The two code paths must not diverge on well-formed wrapped content.
    // They are not equivalent in general — sed removes any tag it sees while
    // the helper requires a matched pair — so the contract is pinned on the
    // shape the wrapper actually produces.
    assert.equal(
      viaSed,
      viaHelper,
      'the workflow expression and the programmatic helper disagree',
    );
    assert.match(viaSed, /first body/);
    assert.match(viaSed, /second body/);
    assert.match(viaSed, /some trusted prose/);
  });
});

describe('SEC40-RULETWO-WF: the import-issue approval gate', () => {
  test('RULETWO-01: the gate step exists and uses the approval tool', () => {
    const md = fs.readFileSync(workflowPath('import-issue.md'), 'utf8');
    const gate = stepBody(md, 'security_gate');
    assert.ok(gate, 'import-issue.md lost its security_gate step');
    assert.match(
      gate,
      /AskUserQuestion/,
      'the gate must be presented through the approval tool, not as prose',
    );
    assert.match(
      gate,
      /\[SECURITY\]/,
      'the gate must key off the blocking error the CLI emits',
    );
    assert.match(
      gate,
      /High-confidence injection pattern detected/,
      'the gate must tell the user what tripped it',
    );
  });

  test('RULETWO-02: the gate offers an explicit approve/cancel choice', () => {
    const md = fs.readFileSync(workflowPath('import-issue.md'), 'utf8');
    const gate = stepBody(md, 'security_gate');
    assert.match(gate, /Review and override/);
    assert.match(gate, /Cancel import/);
    assert.match(
      gate,
      /stop workflow/i,
      'declining must abort, not fall through to the write',
    );
  });

  test('RULETWO-03: no override instruction precedes the approval prompt', () => {
    const md = fs.readFileSync(workflowPath('import-issue.md'), 'utf8');
    const gate = stepBody(md, 'security_gate');
    const askAt = md.indexOf('AskUserQuestion', md.indexOf(gate));
    const firstOverrideAt = md.indexOf('--force-unsafe');

    assert.notEqual(askAt, -1);
    assert.notEqual(firstOverrideAt, -1);

    // The write this gate protects is the overriding re-run. A gate that the
    // document reaches only after instructing the agent to override is not a
    // gate, so the ordering is the assertion that carries the requirement.
    assert.ok(
      askAt < firstOverrideAt,
      'the workflow names the override before it asks for approval',
    );
  });

  test('RULETWO-04: the override flag named here is one the CLI accepts', () => {
    const md = fs.readFileSync(workflowPath('import-issue.md'), 'utf8');
    const named = new Set(md.match(/--[a-z][a-z0-9-]*unsafe\b/g) || []);
    assert.equal(
      named.size,
      1,
      `expected exactly one override flag spelling, found: ${[...named].join(', ')}`,
    );
    const flag = [...named][0];

    const out = runCliForArgValidation([
      'issue-import',
      'bogusplatform',
      '42',
      flag,
    ]);
    assert.doesNotMatch(
      out,
      /Unknown flag/,
      `the workflow instructs the agent to re-run with ${flag}, which the CLI rejects`,
    );

    // Negative control: the assertion above is only meaningful if this
    // invocation shape can produce "Unknown flag" at all.
    const control = runCliForArgValidation([
      'issue-import',
      'bogusplatform',
      '42',
      '--force-bogus',
    ]);
    assert.match(
      control,
      /Unknown flag/,
      'arg validation did not reject an unknown flag — the check above is vacuous',
    );
  });
});
