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
  INJECTION_PATTERNS_TIERED,
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
    // The source names the approval tool by registry placeholder, so the gate
    // survives onto a runtime whose tool is called something else.
    assert.match(
      gate,
      /\{\{USER_QUESTION_TOOL\}\}/,
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
    const askAt = md.indexOf('{{USER_QUESTION_TOOL}}', md.indexOf(gate));
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

// ── The markdown-link rules section of the reference document ────────────────
//
// A grep contract over markdown, written to the four admissibility clauses in
// gsd-ng/references/nyquist-evidence-tiers.md: a required-content arm anchored
// to one section, a forbidden-content arm for each way the section could
// contradict the scanner, and a discrimination self-test that runs every
// pattern against a synthetic counterfactual it must reject or catch.
//
// The document is the only place the tier assignments are explained to a
// reader, and a wrong tier there is worse than silence: it tells someone the
// advisory rule blocks CI, or that a script-bearing MIME type is safe-listed.

const MDLINK_HEADING = '## Markdown Link Injection Rules';

// A rule id paired with a tier inside one table row. Prose that merely names
// the rules does not satisfy it.
function tierRow(id, tier) {
  return new RegExp('\\|\\s*`' + id + '`\\s*\\|\\s*' + tier + '\\s*\\|');
}

// The safe-list note must state the verdict on the script-bearing MIME type,
// not merely mention it.
const SVG_IS_FLAGGED = /image\/svg\+xml[\s\S]{0,200}are flagged/;

// The advisory rule's routing, stated together with its tier.
const ADVISORY_ROUTES_TO_FINDINGS =
  /medium\s*\/\s*advisory[\s\S]{0,120}findings\[\]/;

// The emit shape callers depend on, with the normalization suffix.
const EMIT_SHAPE = /`RULE-ID: description`/;
const EVASION_SUFFIX = /`\[homoglyph-evasion\]`\s+is appended/;

// Forbidden arms. Each is a way the section could be rewritten into a
// statement the scanner does not implement.
const FORBIDDEN = {
  // The advisory rule promoted to a blocking tier in the table.
  advisoryRowSaysHigh: tierRow('AT-FILE-CREDENTIAL-PATH', 'high'),
  // A blocking rule demoted in the table.
  linkRowSaysMedium: /\|\s*`MD-LINK-[A-Z-]+`\s*\|\s*medium\s*\|/,
  // The script-bearing MIME type inside the permitted enumeration. Bounded to
  // one sentence so the real note — which names it after the enumeration
  // ends, as the thing that is flagged — does not match.
  svgInSafeList: /(?:permitted|safe-?list(?:ed)?)[^.]{0,120}image\/svg\+xml/i,
  // The emit format the labelling work replaced.
  legacyEmit: /pattern\.toString\(\)/,
};

// Synthetic counterfactuals, kept together so the self-tests read as a block
// and cannot be dropped quietly one at a time.
const COUNTERFACTUALS = {
  // Names every rule, assigns no tiers.
  noTiers: [
    'The rules are MD-LINK-JS-SCHEME, MD-LINK-DATA-SCHEME, MD-LINK-USERINFO,',
    'MD-LINK-TOKEN-IN-QUERY and AT-FILE-CREDENTIAL-PATH.',
  ].join('\n'),
  // Mentions the MIME type without stating the verdict.
  svgMentioned: 'SVG assets in this repo are referenced by file path.',
  // Safe-lists it.
  svgSafeListed:
    'Only these MIME types are permitted inside `data:` URIs: `image/png`, `image/svg+xml`.',
  // Promotes the advisory rule.
  advisoryHigh: '| `AT-FILE-CREDENTIAL-PATH` | high | `@~/.ssh/id_rsa` | n/a |',
  // Demotes a blocking rule.
  linkMedium: '| `MD-LINK-JS-SCHEME` | medium | `[x](javascript:0)` | n/a |',
  // Describes the pre-labelling emit shape.
  legacyEmit: 'Each entry carries the pattern source via `pattern.toString()`.',
};

describe('MDLINK-DOC: the markdown-link rules section documents what the scanner does', () => {
  const section = sectionBody(readPayload(REFERENCE_REL), MDLINK_HEADING);

  test('MDLINK-DOC-01: the section exists and is anchored', () => {
    assert.ok(
      section,
      `the reference document lost its "${MDLINK_HEADING}" section`,
    );
  });

  test('MDLINK-DOC-02: every rule is documented at the tier the scanner gives it', () => {
    const documented = [
      'MD-LINK-JS-SCHEME',
      'MD-LINK-DATA-SCHEME',
      'MD-LINK-USERINFO',
      'MD-LINK-TOKEN-IN-QUERY',
      'AT-FILE-CREDENTIAL-PATH',
    ];
    for (const id of documented) {
      const entry = INJECTION_PATTERNS_TIERED.find((e) => e.id === id);
      assert.ok(entry, `the scanner no longer defines ${id}`);
      assert.match(
        section,
        tierRow(id, entry.confidence),
        `the section must document ${id} at tier ${entry.confidence}, which is ` +
          'the tier the scanner assigns it',
      );
    }
  });

  test('MDLINK-DOC-03: the safe-list note states the verdict on the script-bearing type', () => {
    assert.match(
      section,
      SVG_IS_FLAGGED,
      'the note must say the script-bearing MIME type is flagged, not merely name it',
    );
    assert.doesNotMatch(
      section,
      FORBIDDEN.svgInSafeList,
      'nothing may add a script-bearing MIME type to the permitted enumeration',
    );
  });

  test('MDLINK-DOC-04: the advisory rule is documented as advisory, and stays that way', () => {
    assert.match(
      section,
      ADVISORY_ROUTES_TO_FINDINGS,
      'the tier note must pair the advisory tier with the array it routes to',
    );
    assert.match(
      section,
      /NOT a CI hard-block/,
      'the reason the rule is advisory is that it must not block CI on our own docs',
    );
    assert.doesNotMatch(
      section,
      FORBIDDEN.advisoryRowSaysHigh,
      'the advisory rule may not be listed at a blocking tier',
    );
    assert.doesNotMatch(
      section,
      FORBIDDEN.linkRowSaysMedium,
      'the link rules are blocking; none may be listed as advisory',
    );
  });

  test('MDLINK-DOC-05: the emit shape is documented, and the pre-labelling shape is gone', () => {
    assert.match(
      section,
      EMIT_SHAPE,
      'callers parse the emitted string; the section must state its shape',
    );
    assert.match(
      section,
      EVASION_SUFFIX,
      'the normalization suffix is part of the emitted string',
    );
    assert.doesNotMatch(
      section,
      FORBIDDEN.legacyEmit,
      'the pre-labelling emit shape may not be reinstated in the document',
    );
  });

  test('MDLINK-DOC-06: the patterns discriminate', () => {
    // Required arms reject text that looks right and says nothing.
    assert.doesNotMatch(
      COUNTERFACTUALS.noTiers,
      tierRow('MD-LINK-JS-SCHEME', 'high'),
      'naming the rules without tiers must not satisfy the tier assertion',
    );
    assert.doesNotMatch(
      COUNTERFACTUALS.svgMentioned,
      SVG_IS_FLAGGED,
      'mentioning the MIME type must not satisfy the verdict assertion',
    );
    assert.doesNotMatch(
      COUNTERFACTUALS.noTiers,
      ADVISORY_ROUTES_TO_FINDINGS,
      'naming the advisory rule must not satisfy the routing assertion',
    );
    assert.doesNotMatch(
      COUNTERFACTUALS.noTiers,
      EMIT_SHAPE,
      'naming the rules must not satisfy the emit-shape assertion',
    );

    // Forbidden arms catch a synthetic instance of what they ban.
    assert.match(
      COUNTERFACTUALS.svgSafeListed,
      FORBIDDEN.svgInSafeList,
      'the safe-list arm must catch a script-bearing type added to the enumeration',
    );
    assert.match(
      COUNTERFACTUALS.advisoryHigh,
      FORBIDDEN.advisoryRowSaysHigh,
      'the tier arm must catch the advisory rule promoted to blocking',
    );
    assert.match(
      COUNTERFACTUALS.linkMedium,
      FORBIDDEN.linkRowSaysMedium,
      'the tier arm must catch a blocking rule demoted to advisory',
    );
    assert.match(
      COUNTERFACTUALS.legacyEmit,
      FORBIDDEN.legacyEmit,
      'the emit arm must catch the pre-labelling shape',
    );

    // And a forbidden arm must not fire on the sentence that explains why the
    // rule is advisory, which names the blocking tier in passing.
    assert.doesNotMatch(
      'Promoting this rule to high tier would cause CI to block our own docs.',
      FORBIDDEN.advisoryRowSaysHigh,
      'explaining the tier choice is not the same as assigning the wrong tier',
    );
  });
});
