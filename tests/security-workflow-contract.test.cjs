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
