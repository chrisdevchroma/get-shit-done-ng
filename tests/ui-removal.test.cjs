/**
 * UI gate removal — grep-absence contracts.
 *
 * Asserts that the ui-gate machinery is absent from source: no
 * `gsd-ui-checker` agent, no `workflow.ui_safety_gate` config key, no
 * keyword-grep step in plan-phase, no registry-safety blocks in the UI
 * researcher/auditor, and no `npx shadcn view/diff` calls in agent files,
 * docs, or templates. Each test below reads a source file and asserts
 * grep-absence of a forbidden substring. A failing assertion means the
 * ui-gate machinery (or a residual reference to it) has been re-introduced.
 *
 * Path note: gsd-ng has a nested-submodule layout. `agents/`, `docs/`,
 * `commands/`, `tests/` live at REPO_ROOT (= gsd-ng/). `workflows/`,
 * `templates/`, `references/`, `bin/lib/*.cjs` live at REPO_ROOT/gsd-ng/.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..');
const NESTED = path.join(REPO_ROOT, 'gsd-ng');

function readSource(relPath) {
  return fs.readFileSync(path.join(REPO_ROOT, relPath), 'utf8');
}
function readNested(relPath) {
  return fs.readFileSync(path.join(NESTED, relPath), 'utf8');
}
function fileExists(absOrRel) {
  const p = path.isAbsolute(absOrRel)
    ? absOrRel
    : path.join(REPO_ROOT, absOrRel);
  return fs.existsSync(p);
}

describe('UI gate removal — grep-absence contracts', () => {
  test('SC-1: plan-phase.md has no ui_safety_gate, no ui_phase reads, no UI Design Contract Gate section', () => {
    const src = readNested('workflows/plan-phase.md');
    assert.doesNotMatch(
      src,
      /ui_safety_gate/,
      'plan-phase.md still references ui_safety_gate',
    );
    assert.doesNotMatch(
      src,
      /workflow\.ui_phase/,
      'plan-phase.md still reads workflow.ui_phase',
    );
    assert.doesNotMatch(
      src,
      /UI Design Contract Gate/,
      'plan-phase.md still has the UI Design Contract Gate heading',
    );
    assert.doesNotMatch(
      src,
      /## 5\.6\./,
      'plan-phase.md still has a section 5.6 (the gate)',
    );
  });

  test('SC-2: gsd-ui-checker.md does not exist and is not referenced in source tree', () => {
    assert.ok(
      !fileExists('agents/gsd-ui-checker.md'),
      'gsd-ui-checker.md still exists',
    );
    const filesToCheck = [
      'agents/gsd-ui-researcher.md',
      'agents/gsd-ui-auditor.md',
      'tests/config.test.cjs',
      'commands/gsd/ui-phase.md',
      'docs/USER-GUIDE.md',
      'gsd-ng/bin/lib/model-profiles.cjs',
      'gsd-ng/references/claude-model-profiles.md',
      'gsd-ng/templates/UI-SPEC.md',
      'gsd-ng/workflows/ui-phase.md',
      'gsd-ng/workflows/plan-phase.md',
    ];
    for (const rel of filesToCheck) {
      const src = fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
      assert.doesNotMatch(
        src,
        /gsd-ui-checker/,
        `${rel} still references gsd-ui-checker`,
      );
    }
  });

  test('SC-3 (grep): config.cjs VALID_CONFIG_KEYS does not contain workflow.ui_safety_gate', () => {
    const src = readNested('bin/lib/config.cjs');
    assert.doesNotMatch(
      src,
      /'workflow\.ui_safety_gate'/,
      'config.cjs VALID_CONFIG_KEYS still contains workflow.ui_safety_gate',
    );
  });

  test('SC-5: researcher and auditor have no registry-vetting / registry_audit blocks', () => {
    const researcher = readSource('agents/gsd-ui-researcher.md');
    const auditor = readSource('agents/gsd-ui-auditor.md');
    assert.doesNotMatch(
      researcher,
      /Registry safety declared/,
      'researcher success criteria still mention Registry safety',
    );
    assert.doesNotMatch(
      researcher,
      /Registry vetting gate executed/,
      'researcher success criteria still mention vetting gate',
    );
    assert.doesNotMatch(
      auditor,
      /<registry_audit>/,
      'auditor still contains <registry_audit> block',
    );
    assert.doesNotMatch(
      auditor,
      /Registry safety audit executed/,
      'auditor success criteria still mentions registry audit',
    );
    // Sanity: the core 6-pillar / question-flow content MUST still be present (regression guard)
    assert.match(
      researcher,
      /<design_contract_questions>/,
      'researcher lost its design_contract_questions block — over-deletion',
    );
    assert.match(
      auditor,
      /<audit_pillars>/,
      'auditor lost its audit_pillars block — over-deletion',
    );
  });

  test('SC-6: no npx shadcn view / npx shadcn diff calls in agents, docs, or templates', () => {
    const filesToCheck = [
      'agents/gsd-ui-researcher.md',
      'agents/gsd-ui-auditor.md',
      'docs/USER-GUIDE.md',
      'gsd-ng/templates/UI-SPEC.md',
    ];
    for (const rel of filesToCheck) {
      const src = fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
      assert.doesNotMatch(
        src,
        /npx shadcn view/,
        `${rel} still contains 'npx shadcn view'`,
      );
      assert.doesNotMatch(
        src,
        /npx shadcn diff/,
        `${rel} still contains 'npx shadcn diff'`,
      );
    }
  });

  test('SC-7: UI-SPEC.md template has no Registry Safety section/row and no Checker Sign-Off', () => {
    const tpl = readNested('templates/UI-SPEC.md');
    assert.doesNotMatch(
      tpl,
      /Registry Safety/i,
      'UI-SPEC.md template still has Registry Safety',
    );
    assert.doesNotMatch(
      tpl,
      /Checker Sign-Off/i,
      'UI-SPEC.md template still has Checker Sign-Off section',
    );
    assert.doesNotMatch(
      tpl,
      /verified by gsd-ui-checker/,
      'UI-SPEC.md template header still says "verified by gsd-ui-checker"',
    );
    assert.doesNotMatch(
      tpl,
      /Dimension \d+ /,
      'UI-SPEC.md template still has dimension checklist rows',
    );
  });

  test('Copilot-review gaps: residual gate wording absent + UI-SPEC draft status orphan absent', () => {
    const researcher = readSource('agents/gsd-ui-researcher.md');
    const auditor = readSource('agents/gsd-ui-auditor.md');

    assert.doesNotMatch(
      researcher,
      /Registry safety gate/,
      'researcher still contains residual "Registry safety gate" wording',
    );
    assert.doesNotMatch(
      researcher,
      /Set frontmatter `status: draft`/,
      'researcher still instructs to write status: draft (orphaned — no checker to upgrade it)',
    );
    assert.doesNotMatch(
      auditor,
      /exists and is approved/,
      'auditor still gates UI-SPEC consumption on "is approved" (no agent writes approved/non-approved any more)',
    );

    assert.match(
      researcher,
      /Set frontmatter `status: approved`/,
      'researcher lost the terminal-status instruction — regression',
    );
  });
});
