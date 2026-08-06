'use strict';

/**
 * Grep contracts for the removal of the UI design-contract gate.
 *
 * The gate was six coupled pieces: a planning step that read UI config and
 * grepped for UI keywords, a `gsd-ui-checker` agent, a `workflow.ui_safety_gate`
 * config key, registry-vetting blocks in the UI researcher and auditor,
 * `npx shadcn view` / `npx shadcn diff` shell-outs, and a Registry Safety
 * section in the UI design-contract template. All six are gone; the UI
 * researcher, the UI auditor, the `workflow.ui_phase` toggle and the shadcn
 * *initialization* flow deliberately stayed.
 *
 * The subject of every assertion here is markdown or a config registry, so
 * each contract carries four arms: a required-content assertion that
 * discriminates the current tree from the one before the removal, a
 * forbidden-content assertion against the string that was removed, a
 * discrimination self-test proving each pattern rejects a counterfactual it
 * must reject and catches an anti-pattern it must catch, and a named subject
 * that resolves in the tree.
 *
 * The discrimination self-tests are load-bearing. A removal contract that is
 * only `assert.doesNotMatch` passes against a typo'd regex, an empty file and
 * a deleted file alike — the absence it reports would be an artifact of the
 * pattern, not of the tree.
 *
 * Layout: `agents/`, `docs/`, `tests/` sit at the repository root;
 * `workflows/`, `templates/`, `references/` and `bin/lib/` sit one level
 * deeper under `gsd-ng/`.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..');
const NESTED = path.join(REPO_ROOT, 'gsd-ng');

function readOuter(rel) {
  return fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
}

function readNested(rel) {
  return fs.readFileSync(path.join(NESTED, rel), 'utf8');
}

/**
 * Slice the document between two anchors so an assertion is scoped to a
 * region rather than to 700 lines. Throws when either anchor is missing —
 * a silently empty region would make every forbidden-content arm pass.
 */
function region(doc, startPattern, endPattern, label) {
  const start = startPattern.exec(doc);
  assert.ok(start, `anchor not found in ${label}: ${startPattern}`);
  const rest = doc.slice(start.index);
  const end = endPattern.exec(rest.slice(start[0].length));
  assert.ok(end, `closing anchor not found in ${label}: ${endPattern}`);
  return rest.slice(0, start[0].length + end.index);
}

// ── Patterns ────────────────────────────────────────────────────────────────

const PLANNING_STEP_OPEN = /^## 5\.5\. Create Validation Strategy$/m;
const PLANNING_STEP_CLOSE = /^## 6\. Check Existing Plans$/m;
const WRITES_VALIDATION_DOC = /Write to[^\n]{0,80}-VALIDATION\.md/;
const UI_GATE_STEP = /^#{1,4} *5\.6\./m;
const UI_GATE_HEADING = /UI Design Contract Gate/;
const UI_CONFIG_READ = /ui_safety_gate|workflow\.ui_phase/;

const CHECKER_NAME = /gsd-ui-checker/;
const ROSTER_KEEPS_RESEARCHER = /'gsd-ui-researcher':/;
const ROSTER_KEEPS_AUDITOR = /'gsd-ui-auditor':/;

const VALID_KEY_UI_PHASE = /'workflow\.ui_phase'/;
const VALID_KEY_UI_SAFETY_GATE = /'workflow\.ui_safety_gate'/;

const RESEARCHER_KEEPS_INIT_GATE = /<shadcn_gate>/;
const RESEARCHER_KEEPS_QUESTIONS = /<design_contract_questions>/;
const AUDITOR_KEEPS_PILLARS = /<audit_pillars>/;
const REGISTRY_SAFETY_DECLARED = /Registry safety declared/;
const REGISTRY_VETTING_GATE = /Registry vetting gate executed/;
const REGISTRY_AUDIT_BLOCK = /<registry_audit>/;
const REGISTRY_SAFETY_AUDIT = /Registry safety audit executed/;

const SHADCN_INIT_KEPT = /npx shadcn init/;
const SHADCN_REGISTRY_SHELLOUT = /npx shadcn (?:view|diff)\b/;

const TEMPLATE_KEEPS_DESIGN_SYSTEM = /^## Design System$/m;
const TEMPLATE_KEEPS_TOOL_ROW = /^\| Tool\s+\|[^\n]*shadcn/m;
const TEMPLATE_REGISTRY_SAFETY = /Registry Safety/i;
const TEMPLATE_CHECKER_SIGNOFF = /Checker Sign-Off/i;
const TEMPLATE_CHECKER_ATTRIBUTION = /verified by gsd-ui-checker/;

// ── Counterfactuals ─────────────────────────────────────────────────────────
//
// One block, so the self-tests read as a unit and cannot be dropped one at a
// time. Each `…Restored` string is a synthetic instance of the anti-pattern a
// forbidden arm must catch; each `…Current` string is a plausible near-miss a
// forbidden arm must NOT catch.

const COUNTERFACTUALS = {
  gateStepRestored:
    '## 5.5. Create Validation Strategy\n\nWrite the validation strategy.\n\n' +
    '## 5.6. UI Design Contract Gate\n\n' +
    'Read `workflow.ui_safety_gate`. If true, grep the phase context for UI keywords.\n\n' +
    '## 6. Check Existing Plans\n',
  gateStepCurrent:
    '## 5.5. Create Validation Strategy\n\n' +
    '2. Write to `${PHASE_DIR}/${PADDED_PHASE}-VALIDATION.md` (use Write tool)\n\n' +
    '## 6. Check Existing Plans\n',

  checkerRestored:
    "  'gsd-ui-researcher': { quality: 'opus' },\n" +
    "  'gsd-ui-checker': { quality: 'sonnet' },\n" +
    "  'gsd-ui-auditor': { quality: 'sonnet' },\n",
  checkerCurrent:
    "  'gsd-ui-researcher': { quality: 'opus' },\n" +
    "  'gsd-ui-auditor': { quality: 'sonnet' },\n",

  configKeyRestored:
    "  'workflow.ui_phase',\n  'workflow.ui_safety_gate',\n  'workflow.verifier',\n",
  configKeyCurrent: "  'workflow.ui_phase',\n  'workflow.verifier',\n",

  vettingRestored:
    '## Success Criteria\n\n- [ ] Registry safety declared for every component\n' +
    '- [ ] Registry vetting gate executed before hand-off\n\n<registry_audit>\n' +
    '- [ ] Registry safety audit executed\n</registry_audit>\n',
  vettingCurrent:
    '<shadcn_gate>\n\n## shadcn Initialization Gate\n\n' +
    'Offer to initialize the design system when no components.json is found.\n' +
    '</shadcn_gate>\n\n<design_contract_questions>\n</design_contract_questions>\n',

  shellOutRestored:
    'Inspect the component before adopting it:\n\n```bash\nnpx shadcn view button\n' +
    'npx shadcn diff button\n```\n',
  shellOutCurrent:
    'Configure a preset at ui.shadcn.com/create, then:\n\n```bash\n' +
    'npx shadcn init --preset {paste}\n```\n',

  templateRegistryRestored:
    '## Design System\n\n| Property | Value |\n| Tool | {shadcn / none} |\n\n' +
    '## Registry Safety\n\n| Component | Source | Verified |\n\n' +
    '## Checker Sign-Off\n\nContract verified by gsd-ui-checker.\n',
  templateRegistryCurrent:
    '## Design System\n\n| Property          | Value                |\n' +
    '| Tool              | {shadcn / none}      |\n',
};

// ── Contracts ───────────────────────────────────────────────────────────────

describe('planning workflow carries no UI design-contract gate', () => {
  const PLAN_PHASE = readNested('workflows/plan-phase.md');
  const STEP_REGION = region(
    PLAN_PHASE,
    PLANNING_STEP_OPEN,
    PLANNING_STEP_CLOSE,
    'workflows/plan-phase.md',
  );

  test('the validation step runs straight into the next numbered step', () => {
    assert.match(
      STEP_REGION,
      WRITES_VALIDATION_DOC,
      'the validation-strategy step must still write the validation document — ' +
        'an empty region would make every absence assertion below vacuous',
    );
    assert.doesNotMatch(
      STEP_REGION,
      UI_GATE_STEP,
      'a step numbered 5.6 sits between the validation step and the next one',
    );
    assert.doesNotMatch(
      PLAN_PHASE,
      UI_GATE_HEADING,
      'the gate heading is back in the planning workflow',
    );
    assert.doesNotMatch(
      PLAN_PHASE,
      UI_CONFIG_READ,
      'the planning workflow reads UI config again',
    );
  });

  test('the gate patterns discriminate', () => {
    assert.match(COUNTERFACTUALS.gateStepRestored, UI_GATE_STEP);
    assert.match(COUNTERFACTUALS.gateStepRestored, UI_GATE_HEADING);
    assert.match(COUNTERFACTUALS.gateStepRestored, UI_CONFIG_READ);
    assert.doesNotMatch(COUNTERFACTUALS.gateStepCurrent, UI_GATE_STEP);
    assert.doesNotMatch(COUNTERFACTUALS.gateStepCurrent, UI_GATE_HEADING);
    assert.doesNotMatch(COUNTERFACTUALS.gateStepCurrent, UI_CONFIG_READ);
    assert.match(COUNTERFACTUALS.gateStepCurrent, WRITES_VALIDATION_DOC);
  });
});

describe('the UI checker agent is gone and the other two remain', () => {
  const ROSTER = readNested('bin/lib/model-profiles.cjs');
  const SUBJECTS = [
    'agents/gsd-ui-researcher.md',
    'agents/gsd-ui-auditor.md',
    'docs/USER-GUIDE.md',
  ];

  test('the agent roster lists the researcher and auditor and no checker', () => {
    assert.match(
      ROSTER,
      ROSTER_KEEPS_RESEARCHER,
      'the UI researcher was deleted along with the checker — over-deletion',
    );
    assert.match(
      ROSTER,
      ROSTER_KEEPS_AUDITOR,
      'the UI auditor was deleted along with the checker — over-deletion',
    );
    assert.doesNotMatch(ROSTER, CHECKER_NAME, 'the checker is back in the roster');
    assert.ok(
      !fs.existsSync(path.join(REPO_ROOT, 'agents/gsd-ui-checker.md')),
      'the checker agent file exists again',
    );
    for (const rel of SUBJECTS) {
      assert.doesNotMatch(readOuter(rel), CHECKER_NAME, `${rel} names the checker again`);
    }
    assert.doesNotMatch(
      readNested('templates/UI-SPEC.md'),
      CHECKER_NAME,
      'the design-contract template names the checker again',
    );
  });

  test('the roster patterns discriminate', () => {
    assert.match(COUNTERFACTUALS.checkerRestored, CHECKER_NAME);
    assert.match(COUNTERFACTUALS.checkerRestored, ROSTER_KEEPS_RESEARCHER);
    assert.doesNotMatch(COUNTERFACTUALS.checkerCurrent, CHECKER_NAME);
    assert.match(COUNTERFACTUALS.checkerCurrent, ROSTER_KEEPS_AUDITOR);
  });
});

describe('the UI safety-gate config key is deregistered', () => {
  const CONFIG = readNested('bin/lib/config.cjs');

  test('the phase toggle stays a valid key and the gate key does not', () => {
    assert.match(
      CONFIG,
      VALID_KEY_UI_PHASE,
      'the UI phase toggle was removed too — the removal was meant to be surgical',
    );
    assert.doesNotMatch(
      CONFIG,
      VALID_KEY_UI_SAFETY_GATE,
      'the safety-gate key is a valid config key again',
    );
  });

  test('the config-key patterns discriminate', () => {
    assert.match(COUNTERFACTUALS.configKeyRestored, VALID_KEY_UI_SAFETY_GATE);
    assert.match(COUNTERFACTUALS.configKeyRestored, VALID_KEY_UI_PHASE);
    assert.doesNotMatch(COUNTERFACTUALS.configKeyCurrent, VALID_KEY_UI_SAFETY_GATE);
    assert.match(COUNTERFACTUALS.configKeyCurrent, VALID_KEY_UI_PHASE);
  });
});

describe('registry-vetting blocks are gone from the researcher and auditor', () => {
  const RESEARCHER = readOuter('agents/gsd-ui-researcher.md');
  const AUDITOR = readOuter('agents/gsd-ui-auditor.md');

  test('both agents keep their core blocks and carry no registry vetting', () => {
    assert.match(
      RESEARCHER,
      RESEARCHER_KEEPS_INIT_GATE,
      'the researcher lost its initialization gate — that was not part of the removal',
    );
    assert.match(
      RESEARCHER,
      RESEARCHER_KEEPS_QUESTIONS,
      'the researcher lost its design-contract questions — over-deletion',
    );
    assert.match(
      AUDITOR,
      AUDITOR_KEEPS_PILLARS,
      'the auditor lost its audit pillars — over-deletion',
    );
    assert.doesNotMatch(RESEARCHER, REGISTRY_SAFETY_DECLARED);
    assert.doesNotMatch(RESEARCHER, REGISTRY_VETTING_GATE);
    assert.doesNotMatch(AUDITOR, REGISTRY_AUDIT_BLOCK);
    assert.doesNotMatch(AUDITOR, REGISTRY_SAFETY_AUDIT);
  });

  test('the registry-vetting patterns discriminate', () => {
    assert.match(COUNTERFACTUALS.vettingRestored, REGISTRY_SAFETY_DECLARED);
    assert.match(COUNTERFACTUALS.vettingRestored, REGISTRY_VETTING_GATE);
    assert.match(COUNTERFACTUALS.vettingRestored, REGISTRY_AUDIT_BLOCK);
    assert.match(COUNTERFACTUALS.vettingRestored, REGISTRY_SAFETY_AUDIT);
    assert.doesNotMatch(COUNTERFACTUALS.vettingCurrent, REGISTRY_SAFETY_DECLARED);
    assert.doesNotMatch(COUNTERFACTUALS.vettingCurrent, REGISTRY_AUDIT_BLOCK);
    assert.match(COUNTERFACTUALS.vettingCurrent, RESEARCHER_KEEPS_INIT_GATE);
  });
});

describe('registry shell-outs are gone and the init flow is not', () => {
  const SUBJECTS = {
    'agents/gsd-ui-researcher.md': readOuter('agents/gsd-ui-researcher.md'),
    'agents/gsd-ui-auditor.md': readOuter('agents/gsd-ui-auditor.md'),
    'docs/USER-GUIDE.md': readOuter('docs/USER-GUIDE.md'),
    'gsd-ng/templates/UI-SPEC.md': readNested('templates/UI-SPEC.md'),
  };

  test('the documented shadcn call is init, never view or diff', () => {
    assert.match(
      SUBJECTS['docs/USER-GUIDE.md'],
      SHADCN_INIT_KEPT,
      'the initialization flow was removed too — only the registry calls were in scope',
    );
    for (const [rel, src] of Object.entries(SUBJECTS)) {
      assert.doesNotMatch(src, SHADCN_REGISTRY_SHELLOUT, `${rel} shells out to the registry again`);
    }
  });

  test('the shell-out pattern separates registry calls from initialization', () => {
    assert.match(COUNTERFACTUALS.shellOutRestored, SHADCN_REGISTRY_SHELLOUT);
    assert.doesNotMatch(
      COUNTERFACTUALS.shellOutCurrent,
      SHADCN_REGISTRY_SHELLOUT,
      'the pattern is matching the initialization call — it would flag a tree that is correct',
    );
    assert.match(COUNTERFACTUALS.shellOutCurrent, SHADCN_INIT_KEPT);
    assert.doesNotMatch(COUNTERFACTUALS.shellOutRestored, SHADCN_INIT_KEPT);
  });
});

describe('the design-contract template carries no registry section', () => {
  const TEMPLATE = readNested('templates/UI-SPEC.md');

  test('the template keeps its design-system table and drops the registry rows', () => {
    assert.match(
      TEMPLATE,
      TEMPLATE_KEEPS_DESIGN_SYSTEM,
      'the template lost its design-system section — over-deletion',
    );
    assert.match(
      TEMPLATE,
      TEMPLATE_KEEPS_TOOL_ROW,
      'the template lost the design-system tool row — over-deletion',
    );
    assert.doesNotMatch(TEMPLATE, TEMPLATE_REGISTRY_SAFETY);
    assert.doesNotMatch(TEMPLATE, TEMPLATE_CHECKER_SIGNOFF);
    assert.doesNotMatch(TEMPLATE, TEMPLATE_CHECKER_ATTRIBUTION);
  });

  test('the template patterns discriminate', () => {
    assert.match(COUNTERFACTUALS.templateRegistryRestored, TEMPLATE_REGISTRY_SAFETY);
    assert.match(COUNTERFACTUALS.templateRegistryRestored, TEMPLATE_CHECKER_SIGNOFF);
    assert.match(COUNTERFACTUALS.templateRegistryRestored, TEMPLATE_CHECKER_ATTRIBUTION);
    assert.doesNotMatch(COUNTERFACTUALS.templateRegistryCurrent, TEMPLATE_REGISTRY_SAFETY);
    assert.doesNotMatch(COUNTERFACTUALS.templateRegistryCurrent, TEMPLATE_CHECKER_SIGNOFF);
    assert.match(COUNTERFACTUALS.templateRegistryCurrent, TEMPLATE_KEEPS_DESIGN_SYSTEM);
    assert.match(COUNTERFACTUALS.templateRegistryCurrent, TEMPLATE_KEEPS_TOOL_ROW);
  });
});
