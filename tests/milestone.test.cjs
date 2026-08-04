/**
 * GSD Tools Tests - Milestone
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const {
  runGsdTools,
  createTempProject,
  cleanup,
  waitForReadyFlag,
  trackExit,
  waitForExit,
} = require('./helpers.cjs');
const {
  formatMilestoneHeading,
  parseCompletedMilestones,
} = require('../gsd-ng/bin/lib/milestone-format.cjs');

describe('milestone-format shared module', () => {
  test('a heading the writer emits parses back to version and name', () => {
    const heading = formatMilestoneHeading('v0.2', 'FabGL Bring-Up', '2026-07-24');
    assert.strictEqual(heading, '## v0.2 FabGL Bring-Up (Shipped: 2026-07-24)');
    assert.deepStrictEqual(parseCompletedMilestones(heading), [
      { version: 'v0.2', name: 'FabGL Bring-Up' },
    ]);
  });

  test('an unnamed milestone parses with a null name', () => {
    const heading = formatMilestoneHeading('v0.2', 'v0.2', '2026-07-24');
    assert.deepStrictEqual(parseCompletedMilestones(heading), [
      { version: 'v0.2', name: null },
    ]);
  });

  test('legacy list and table forms parse', () => {
    assert.deepStrictEqual(
      parseCompletedMilestones('- [x] **v1.0 — Foundation** — initial release'),
      [{ version: 'v1.0', name: 'Foundation' }],
    );
    assert.deepStrictEqual(
      parseCompletedMilestones('| v1.0 | Foundation | Complete |'),
      [{ version: 'v1.0', name: 'Foundation' }],
    );
  });

  test('incomplete entries and non-entries are ignored', () => {
    assert.deepStrictEqual(
      parseCompletedMilestones(
        [
          '# Milestones',
          '## v2.0 Expansion (In progress)',
          '- [ ] **v3.0 — Later**',
          '| v4.0 | Later still | Planned |',
          '',
        ].join('\n'),
      ),
      [],
    );
  });

  test('handles empty and missing content', () => {
    assert.deepStrictEqual(parseCompletedMilestones(''), []);
    assert.deepStrictEqual(parseCompletedMilestones(null), []);
    assert.deepStrictEqual(parseCompletedMilestones(undefined), []);
  });

  test('a version repeated across formats is reported once, keeping its name', () => {
    const entries = parseCompletedMilestones(
      [
        '## v1.0 (Shipped: 2026-07-24)',
        '- [x] **v1.0 — Foundation**',
        '## v1.1 Auth (Shipped: 2026-07-25)',
        '',
      ].join('\n'),
    );
    assert.deepStrictEqual(entries, [
      { version: 'v1.0', name: 'Foundation' },
      { version: 'v1.1', name: 'Auth' },
    ]);
  });
});

describe('milestone complete command', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('archives roadmap, requirements, creates MILESTONES.md', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap v1.0 MVP\n\n### Phase 1: Foundation\n**Goal:** Setup\n`,
    );
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'REQUIREMENTS.md'),
      `# Requirements\n\n- [ ] User auth\n- [ ] Dashboard\n`,
    );
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      `# State\n\n**Status:** In progress\n**Last Activity:** 2025-01-01\n**Last Activity Description:** Working\n`,
    );

    const p1 = path.join(tmpDir, '.planning', 'phases', '01-foundation');
    fs.mkdirSync(p1, { recursive: true });
    fs.writeFileSync(
      path.join(p1, '01-01-SUMMARY.md'),
      `---\none-liner: Set up project infrastructure\n---\n# Summary\n`,
    );

    const result = runGsdTools(
      'milestone complete v1.0 --name MVP Foundation --json',
      tmpDir,
    );
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.version, 'v1.0');
    assert.strictEqual(output.phases, 1);
    assert.ok(output.archived.roadmap, 'roadmap should be archived');
    assert.ok(output.archived.requirements, 'requirements should be archived');

    // Verify archive files exist
    assert.ok(
      fs.existsSync(
        path.join(tmpDir, '.planning', 'milestones', 'v1.0-ROADMAP.md'),
      ),
      'archived roadmap should exist',
    );
    assert.ok(
      fs.existsSync(
        path.join(tmpDir, '.planning', 'milestones', 'v1.0-REQUIREMENTS.md'),
      ),
      'archived requirements should exist',
    );

    // Verify MILESTONES.md created
    assert.ok(
      fs.existsSync(path.join(tmpDir, '.planning', 'MILESTONES.md')),
      'MILESTONES.md should be created',
    );
    const milestones = fs.readFileSync(
      path.join(tmpDir, '.planning', 'MILESTONES.md'),
      'utf-8',
    );
    assert.ok(
      milestones.includes('v1.0 MVP Foundation'),
      'milestone entry should contain name',
    );
    assert.ok(
      milestones.includes('Set up project infrastructure'),
      'accomplishments should be listed',
    );
  });

  test('harness litter in phases/ is not counted as a phase', () => {
    // Roadmap with no phase entries at all: the milestone filter has nothing to
    // match against and falls back to accepting whatever is on disk.
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap v1.0 MVP\n\nNo phases written yet.\n`,
    );
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      `# State\n\n**Status:** In progress\n**Last Activity:** 2025-01-01\n**Last Activity Description:** Working\n`,
    );

    const phasesDir = path.join(tmpDir, '.planning', 'phases');
    for (const name of ['01-alpha', '02-beta']) {
      fs.mkdirSync(path.join(phasesDir, name), { recursive: true });
    }
    fs.mkdirSync(path.join(phasesDir, '.claude', '.cc-writes'), {
      recursive: true,
    });
    fs.mkdirSync(path.join(phasesDir, 'node_modules'), { recursive: true });

    const result = runGsdTools('milestone complete v1.0 --name MVP --json', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(
      output.phases,
      2,
      'only the two real phase directories should count',
    );
  });

  test('prepends to existing MILESTONES.md (reverse chronological)', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'MILESTONES.md'),
      `# Milestones\n\n## v0.9 Alpha (Shipped: 2025-01-01)\n\n---\n\n`,
    );
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap v1.0\n`,
    );
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      `# State\n\n**Status:** In progress\n**Last Activity:** 2025-01-01\n**Last Activity Description:** Working\n`,
    );

    const result = runGsdTools('milestone complete v1.0 --name Beta', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const milestones = fs.readFileSync(
      path.join(tmpDir, '.planning', 'MILESTONES.md'),
      'utf-8',
    );
    assert.ok(
      milestones.includes('v0.9 Alpha'),
      'existing entry should be preserved',
    );
    assert.ok(milestones.includes('v1.0 Beta'), 'new entry should be present');
    // New entry should appear BEFORE old entry (reverse chronological)
    const newIdx = milestones.indexOf('v1.0 Beta');
    const oldIdx = milestones.indexOf('v0.9 Alpha');
    assert.ok(
      newIdx < oldIdx,
      'new entry should appear before old entry (reverse chronological)',
    );
  });

  test('three sequential completions maintain reverse-chronological order', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'MILESTONES.md'),
      `# Milestones\n\n## v1.0 First (Shipped: 2025-01-01)\n\n---\n\n`,
    );
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap v1.1\n`,
    );
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      `# State\n\n**Status:** In progress\n**Last Activity:** 2025-01-01\n**Last Activity Description:** Working\n`,
    );

    let result = runGsdTools('milestone complete v1.1 --name Second', tmpDir);
    assert.ok(result.success, `v1.1 failed: ${result.error}`);

    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap v1.2\n`,
    );

    result = runGsdTools('milestone complete v1.2 --name Third', tmpDir);
    assert.ok(result.success, `v1.2 failed: ${result.error}`);

    const milestones = fs.readFileSync(
      path.join(tmpDir, '.planning', 'MILESTONES.md'),
      'utf-8',
    );

    const idx10 = milestones.indexOf('v1.0 First');
    const idx11 = milestones.indexOf('v1.1 Second');
    const idx12 = milestones.indexOf('v1.2 Third');

    assert.ok(idx10 !== -1, 'v1.0 should be present');
    assert.ok(idx11 !== -1, 'v1.1 should be present');
    assert.ok(idx12 !== -1, 'v1.2 should be present');
    assert.ok(idx12 < idx11, 'v1.2 should appear before v1.1');
    assert.ok(idx11 < idx10, 'v1.1 should appear before v1.0');
  });

  test('archives phase directories with --archive-phases flag', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap v1.0\n`,
    );
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      `# State\n\n**Status:** In progress\n**Last Activity:** 2025-01-01\n**Last Activity Description:** Working\n`,
    );

    const p1 = path.join(tmpDir, '.planning', 'phases', '01-foundation');
    fs.mkdirSync(p1, { recursive: true });
    fs.writeFileSync(
      path.join(p1, '01-01-SUMMARY.md'),
      `---\none-liner: Set up project infrastructure\n---\n# Summary\n`,
    );

    const result = runGsdTools(
      'milestone complete v1.0 --name MVP --archive-phases --json',
      tmpDir,
    );
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(
      output.archived.phases,
      true,
      'phases should be archived',
    );

    // Phase directory moved to milestones/v1.0-phases/
    assert.ok(
      fs.existsSync(
        path.join(
          tmpDir,
          '.planning',
          'milestones',
          'v1.0-phases',
          '01-foundation',
        ),
      ),
      'archived phase directory should exist in milestones/v1.0-phases/',
    );

    // Original phase directory no longer exists
    assert.ok(
      !fs.existsSync(p1),
      'original phase directory should no longer exist',
    );
  });

  test('archived REQUIREMENTS.md contains archive header', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'REQUIREMENTS.md'),
      `# Requirements\n\n- [ ] **TEST-01**: core.cjs has tests\n- [ ] **TEST-02**: more tests\n`,
    );
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap v1.0\n`,
    );
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      `# State\n\n**Status:** In progress\n**Last Activity:** 2025-01-01\n**Last Activity Description:** Working\n`,
    );

    const result = runGsdTools('milestone complete v1.0 --name MVP', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const archivedReq = fs.readFileSync(
      path.join(tmpDir, '.planning', 'milestones', 'v1.0-REQUIREMENTS.md'),
      'utf-8',
    );
    assert.ok(
      archivedReq.includes('Requirements Archive: v1.0'),
      'should contain archive version',
    );
    assert.ok(archivedReq.includes('SHIPPED'), 'should contain SHIPPED status');
    assert.ok(
      archivedReq.includes('Archived:'),
      'should contain Archived: date line',
    );
    // Original content preserved after header
    assert.ok(
      archivedReq.includes('# Requirements'),
      'original content should be preserved',
    );
    assert.ok(
      archivedReq.includes('**TEST-01**'),
      'original requirement items should be preserved',
    );
  });

  test('STATE.md gets updated during milestone complete', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap v1.0\n`,
    );
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      `# State\n\n**Status:** In progress\n**Last Activity:** 2025-01-01\n**Last Activity Description:** Working\n`,
    );

    const result = runGsdTools(
      'milestone complete v1.0 --name Test --json',
      tmpDir,
    );
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(
      output.state_updated,
      true,
      'state_updated should be true',
    );

    const state = fs.readFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      'utf-8',
    );
    assert.ok(
      state.includes('v1.0 milestone complete'),
      'status should be updated to milestone complete',
    );
    assert.ok(
      state.includes('v1.0 milestone completed and archived'),
      'last activity description should reference milestone completion',
    );
  });

  test('handles missing ROADMAP.md gracefully', () => {
    // Only STATE.md — no ROADMAP.md, no REQUIREMENTS.md
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      `# State\n\n**Status:** In progress\n**Last Activity:** 2025-01-01\n**Last Activity Description:** Working\n`,
    );

    const result = runGsdTools(
      'milestone complete v1.0 --name NoRoadmap --json',
      tmpDir,
    );
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(
      output.archived.roadmap,
      false,
      'roadmap should not be archived',
    );
    assert.strictEqual(
      output.archived.requirements,
      false,
      'requirements should not be archived',
    );
    assert.strictEqual(
      output.milestones_updated,
      true,
      'MILESTONES.md should still be created',
    );

    assert.ok(
      fs.existsSync(path.join(tmpDir, '.planning', 'MILESTONES.md')),
      'MILESTONES.md should be created even without ROADMAP.md',
    );
  });

  test('scopes stats to current milestone phases only', () => {
    // Set up ROADMAP.md with specific phase entries
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap v1.1\n\n### Phase 3: New Feature\n**Goal:** Build it\n\n### Phase 4: Polish\n**Goal:** Ship it\n`,
    );
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      `# State\n\n**Status:** In progress\n**Last Activity:** 2025-01-01\n**Last Activity Description:** Working\n`,
    );

    // Create phases from PREVIOUS milestone (should be excluded)
    const p1 = path.join(tmpDir, '.planning', 'phases', '01-old-setup');
    fs.mkdirSync(p1, { recursive: true });
    fs.writeFileSync(path.join(p1, '01-01-PLAN.md'), '# Plan\n');
    fs.writeFileSync(
      path.join(p1, '01-01-SUMMARY.md'),
      '---\none-liner: Old setup work\n---\n# Summary\n',
    );
    const p2 = path.join(tmpDir, '.planning', 'phases', '02-old-core');
    fs.mkdirSync(p2, { recursive: true });
    fs.writeFileSync(path.join(p2, '02-01-PLAN.md'), '# Plan\n');
    fs.writeFileSync(
      path.join(p2, '02-01-SUMMARY.md'),
      '---\none-liner: Old core work\n---\n# Summary\n',
    );

    // Create phases for CURRENT milestone (should be included)
    const p3 = path.join(tmpDir, '.planning', 'phases', '03-new-feature');
    fs.mkdirSync(p3, { recursive: true });
    fs.writeFileSync(path.join(p3, '03-01-PLAN.md'), '# Plan\n');
    fs.writeFileSync(
      path.join(p3, '03-01-SUMMARY.md'),
      '---\none-liner: Built new feature\n---\n# Summary\n',
    );
    const p4 = path.join(tmpDir, '.planning', 'phases', '04-polish');
    fs.mkdirSync(p4, { recursive: true });
    fs.writeFileSync(path.join(p4, '04-01-PLAN.md'), '# Plan\n');
    fs.writeFileSync(path.join(p4, '04-02-PLAN.md'), '# Plan 2\n');
    fs.writeFileSync(
      path.join(p4, '04-01-SUMMARY.md'),
      '---\none-liner: Polished UI\n---\n# Summary\n',
    );

    const result = runGsdTools(
      'milestone complete v1.1 --name "Second Release" --json',
      tmpDir,
    );
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    // Should only count phases 3 and 4, not 1 and 2
    assert.strictEqual(
      output.phases,
      2,
      'should count only milestone phases (3, 4)',
    );
    assert.strictEqual(
      output.plans,
      3,
      'should count only plans from phases 3 and 4',
    );
    // Accomplishments should only be from phases 3 and 4
    assert.ok(
      output.accomplishments.includes('Built new feature'),
      'should include current milestone accomplishment',
    );
    assert.ok(
      output.accomplishments.includes('Polished UI'),
      'should include current milestone accomplishment',
    );
    assert.ok(
      !output.accomplishments.includes('Old setup work'),
      'should NOT include previous milestone accomplishment',
    );
    assert.ok(
      !output.accomplishments.includes('Old core work'),
      'should NOT include previous milestone accomplishment',
    );
  });

  test('archive-phases only archives current milestone phases', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap v1.1\n\n### Phase 2: Current Work\n**Goal:** Do it\n`,
    );
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      `# State\n\n**Status:** In progress\n**Last Activity:** 2025-01-01\n**Last Activity Description:** Working\n`,
    );

    // Phase from previous milestone
    const p1 = path.join(tmpDir, '.planning', 'phases', '01-old');
    fs.mkdirSync(p1, { recursive: true });
    fs.writeFileSync(path.join(p1, '01-01-PLAN.md'), '# Plan\n');

    // Phase from current milestone
    const p2 = path.join(tmpDir, '.planning', 'phases', '02-current');
    fs.mkdirSync(p2, { recursive: true });
    fs.writeFileSync(path.join(p2, '02-01-PLAN.md'), '# Plan\n');

    const result = runGsdTools(
      'milestone complete v1.1 --name Test --archive-phases',
      tmpDir,
    );
    assert.ok(result.success, `Command failed: ${result.error}`);

    // Current milestone phase should be archived
    assert.ok(
      fs.existsSync(
        path.join(
          tmpDir,
          '.planning',
          'milestones',
          'v1.1-phases',
          '02-current',
        ),
      ),
      'current milestone phase should be archived',
    );
    // Previous milestone phase should NOT be archived
    assert.ok(
      fs.existsSync(path.join(tmpDir, '.planning', 'phases', '01-old')),
      'previous milestone phase should NOT be archived',
    );
  });

  test('phase 1 in roadmap does NOT match directory 10-something (no prefix collision)', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap v1.0\n\n### Phase 1: Foundation\n**Goal:** Setup\n`,
    );
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      `# State\n\n**Status:** In progress\n**Last Activity:** 2025-01-01\n**Last Activity Description:** Working\n`,
    );

    const p1 = path.join(tmpDir, '.planning', 'phases', '01-foundation');
    fs.mkdirSync(p1, { recursive: true });
    fs.writeFileSync(path.join(p1, '01-01-PLAN.md'), '# Plan\n');
    fs.writeFileSync(
      path.join(p1, '01-01-SUMMARY.md'),
      '---\none-liner: Foundation work\n---\n',
    );

    const p10 = path.join(tmpDir, '.planning', 'phases', '10-scaling');
    fs.mkdirSync(p10, { recursive: true });
    fs.writeFileSync(path.join(p10, '10-01-PLAN.md'), '# Plan\n');
    fs.writeFileSync(
      path.join(p10, '10-01-SUMMARY.md'),
      '---\none-liner: Scaling work\n---\n',
    );

    const result = runGsdTools(
      'milestone complete v1.0 --name MVP --json',
      tmpDir,
    );
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(
      output.phases,
      1,
      'should count only phase 1, not phase 10',
    );
    assert.strictEqual(output.plans, 1, 'should count only plans from phase 1');
    assert.ok(
      output.accomplishments.includes('Foundation work'),
      'should include phase 1 accomplishment',
    );
    assert.ok(
      !output.accomplishments.includes('Scaling work'),
      'should NOT include phase 10 accomplishment',
    );
  });

  test('non-numeric directory is excluded when milestone scoping is active', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap v1.0\n\n### Phase 1: Core\n**Goal:** Build core\n`,
    );
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      `# State\n\n**Status:** In progress\n**Last Activity:** 2025-01-01\n**Last Activity Description:** Working\n`,
    );

    const p1 = path.join(tmpDir, '.planning', 'phases', '01-core');
    fs.mkdirSync(p1, { recursive: true });
    fs.writeFileSync(path.join(p1, '01-01-PLAN.md'), '# Plan\n');

    // Non-phase directory — should be excluded
    const misc = path.join(tmpDir, '.planning', 'phases', 'notes');
    fs.mkdirSync(misc, { recursive: true });
    fs.writeFileSync(path.join(misc, 'PLAN.md'), '# Not a phase\n');

    const result = runGsdTools(
      'milestone complete v1.0 --name Test --json',
      tmpDir,
    );
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(
      output.phases,
      1,
      'non-numeric dir should not be counted as a phase',
    );
    assert.strictEqual(
      output.plans,
      1,
      'plans from non-numeric dir should not be counted',
    );
  });

  test('large phase numbers (456, 457) scope correctly', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap v1.49\n\n### Phase 456: DACP\n**Goal:** Ship DACP\n\n### Phase 457: Integration\n**Goal:** Integrate\n`,
    );
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      `# State\n\n**Status:** In progress\n**Last Activity:** 2025-01-01\n**Last Activity Description:** Working\n`,
    );

    const p456 = path.join(tmpDir, '.planning', 'phases', '456-dacp');
    fs.mkdirSync(p456, { recursive: true });
    fs.writeFileSync(path.join(p456, '456-01-PLAN.md'), '# Plan\n');

    const p457 = path.join(tmpDir, '.planning', 'phases', '457-integration');
    fs.mkdirSync(p457, { recursive: true });
    fs.writeFileSync(path.join(p457, '457-01-PLAN.md'), '# Plan\n');

    // Prior milestone phase — should not match current range
    const p45 = path.join(tmpDir, '.planning', 'phases', '45-old');
    fs.mkdirSync(p45, { recursive: true });
    fs.writeFileSync(path.join(p45, 'PLAN.md'), '# Plan\n');

    const result = runGsdTools(
      'milestone complete v1.49 --name DACP --json',
      tmpDir,
    );
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(
      output.phases,
      2,
      'should count only phases 456 and 457',
    );
  });

  test('counts tasks from **Tasks:** N in summary body', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap v1.0\n\n### Phase 1: Foundation\n**Goal:** Setup\n`,
    );
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      `# State\n\n**Status:** In progress\n**Last Activity:** 2025-01-01\n**Last Activity Description:** Working\n`,
    );

    const p1 = path.join(tmpDir, '.planning', 'phases', '01-foundation');
    fs.mkdirSync(p1, { recursive: true });
    fs.writeFileSync(
      path.join(p1, '01-01-SUMMARY.md'),
      `---\none-liner: Built the foundation\n---\n\n# Phase 1: Foundation Summary\n\n**Built the foundation**\n\n## Performance\n\n- **Duration:** 28 min\n- **Tasks:** 7\n- **Files modified:** 12\n`,
    );

    const result = runGsdTools(
      'milestone complete v1.0 --name MVP --json',
      tmpDir,
    );
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(
      output.tasks,
      7,
      'should count tasks from **Tasks:** N field',
    );
  });

  test('extracts one-liner from body when not in frontmatter', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap v1.0\n\n### Phase 1: Foundation\n**Goal:** Setup\n`,
    );
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      `# State\n\n**Status:** In progress\n**Last Activity:** 2025-01-01\n**Last Activity Description:** Working\n`,
    );

    const p1 = path.join(tmpDir, '.planning', 'phases', '01-foundation');
    fs.mkdirSync(p1, { recursive: true });
    // No one-liner in frontmatter, but present in body as bold line
    fs.writeFileSync(
      path.join(p1, '01-01-SUMMARY.md'),
      `---\nphase: "01"\n---\n\n# Phase 1: Foundation Summary\n\n**JWT auth with refresh rotation using jose library**\n\n## Performance\n`,
    );

    const result = runGsdTools(
      'milestone complete v1.0 --name MVP --json',
      tmpDir,
    );
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.ok(
      output.accomplishments.includes(
        'JWT auth with refresh rotation using jose library',
      ),
      'should extract one-liner from body bold line',
    );
  });

  test('handles empty phases directory', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap v1.0\n`,
    );
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      `# State\n\n**Status:** In progress\n**Last Activity:** 2025-01-01\n**Last Activity Description:** Working\n`,
    );
    // phases directory exists but is empty (from createTempProject)

    const result = runGsdTools(
      'milestone complete v1.0 --name EmptyPhases --json',
      tmpDir,
    );
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.phases, 0, 'phase count should be 0');
    assert.strictEqual(output.plans, 0, 'plan count should be 0');
    assert.strictEqual(output.tasks, 0, 'task count should be 0');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// requirements mark-complete command
// ─────────────────────────────────────────────────────────────────────────────

describe('requirements mark-complete command', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  // ─── helpers ──────────────────────────────────────────────────────────────

  function writeRequirements(tmpDir, content) {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'REQUIREMENTS.md'),
      content,
      'utf-8',
    );
  }

  function readRequirements(tmpDir) {
    return fs.readFileSync(
      path.join(tmpDir, '.planning', 'REQUIREMENTS.md'),
      'utf-8',
    );
  }

  const STANDARD_REQUIREMENTS = `# Requirements

## Test Coverage
- [ ] **TEST-01**: core.cjs has tests for loadConfig
- [ ] **TEST-02**: core.cjs has tests for resolveModelInternal
- [x] **TEST-03**: core.cjs has tests for escapeRegex (already complete)

## Bug Regressions
- [ ] **REG-01**: Test confirms loadConfig returns model_overrides

## Infrastructure
- [ ] **INFRA-01**: GitHub Actions workflow runs tests

## Traceability

| Requirement | Phase | Status |
|-------------|-------|--------|
| TEST-01 | Phase 1 | Pending |
| TEST-02 | Phase 1 | Pending |
| TEST-03 | Phase 1 | Complete |
| REG-01 | Phase 1 | Pending |
| INFRA-01 | Phase 6 | Pending |
`;

  // ─── tests ────────────────────────────────────────────────────────────────

  test('marks single requirement complete (checkbox + table)', () => {
    writeRequirements(tmpDir, STANDARD_REQUIREMENTS);

    const result = runGsdTools(
      'requirements mark-complete TEST-01 --json',
      tmpDir,
    );
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.updated, true);
    assert.ok(
      output.marked_complete.includes('TEST-01'),
      'TEST-01 should be marked complete',
    );

    const content = readRequirements(tmpDir);
    assert.ok(
      content.includes('- [x] **TEST-01**'),
      'checkbox should be checked',
    );
    assert.ok(
      content.includes('| TEST-01 | Phase 1 | Complete |'),
      'table row should be Complete',
    );
    // Other checkboxes unchanged
    assert.ok(
      content.includes('- [ ] **TEST-02**'),
      'TEST-02 should remain unchecked',
    );
  });

  test('handles mixed prefixes in single call (TEST-XX, REG-XX, INFRA-XX)', () => {
    writeRequirements(tmpDir, STANDARD_REQUIREMENTS);

    const result = runGsdTools(
      'requirements mark-complete TEST-01,REG-01,INFRA-01 --json',
      tmpDir,
    );
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(
      output.marked_complete.length,
      3,
      'should mark 3 requirements complete',
    );
    assert.ok(output.marked_complete.includes('TEST-01'));
    assert.ok(output.marked_complete.includes('REG-01'));
    assert.ok(output.marked_complete.includes('INFRA-01'));

    const content = readRequirements(tmpDir);
    assert.ok(
      content.includes('- [x] **TEST-01**'),
      'TEST-01 checkbox should be checked',
    );
    assert.ok(
      content.includes('- [x] **REG-01**'),
      'REG-01 checkbox should be checked',
    );
    assert.ok(
      content.includes('- [x] **INFRA-01**'),
      'INFRA-01 checkbox should be checked',
    );
    assert.ok(
      content.includes('| TEST-01 | Phase 1 | Complete |'),
      'TEST-01 table should be Complete',
    );
    assert.ok(
      content.includes('| REG-01 | Phase 1 | Complete |'),
      'REG-01 table should be Complete',
    );
    assert.ok(
      content.includes('| INFRA-01 | Phase 6 | Complete |'),
      'INFRA-01 table should be Complete',
    );
  });

  test('accepts space-separated IDs', () => {
    writeRequirements(tmpDir, STANDARD_REQUIREMENTS);

    const result = runGsdTools(
      'requirements mark-complete TEST-01 TEST-02 --json',
      tmpDir,
    );
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(
      output.marked_complete.length,
      2,
      'should mark 2 requirements complete',
    );

    const content = readRequirements(tmpDir);
    assert.ok(
      content.includes('- [x] **TEST-01**'),
      'TEST-01 should be checked',
    );
    assert.ok(
      content.includes('- [x] **TEST-02**'),
      'TEST-02 should be checked',
    );
  });

  test('accepts bracket-wrapped IDs [REQ-01, REQ-02]', () => {
    writeRequirements(tmpDir, STANDARD_REQUIREMENTS);

    const result = runGsdTools(
      'requirements mark-complete [TEST-01,TEST-02] --json',
      tmpDir,
    );
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(
      output.marked_complete.length,
      2,
      'should mark 2 requirements complete',
    );

    const content = readRequirements(tmpDir);
    assert.ok(
      content.includes('- [x] **TEST-01**'),
      'TEST-01 should be checked',
    );
    assert.ok(
      content.includes('- [x] **TEST-02**'),
      'TEST-02 should be checked',
    );
  });

  test('returns not_found for invalid IDs while updating valid ones', () => {
    writeRequirements(tmpDir, STANDARD_REQUIREMENTS);

    const result = runGsdTools(
      'requirements mark-complete TEST-01,FAKE-99 --json',
      tmpDir,
    );
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.updated, true, 'should still update valid IDs');
    assert.ok(
      output.marked_complete.includes('TEST-01'),
      'TEST-01 should be marked complete',
    );
    assert.ok(
      output.not_found.includes('FAKE-99'),
      'FAKE-99 should be in not_found',
    );
    assert.strictEqual(
      output.total,
      2,
      'total should reflect all IDs attempted',
    );
  });

  test('idempotent — re-marking already-complete requirement does not corrupt', () => {
    writeRequirements(tmpDir, STANDARD_REQUIREMENTS);

    // The third test requirement already has [x] and Complete in the fixture
    const result = runGsdTools(
      'requirements mark-complete TEST-03 --json',
      tmpDir,
    );
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.ok(
      output.already_complete.includes('TEST-03'),
      'already-complete ID should be in already_complete',
    );
    assert.deepStrictEqual(
      output.not_found,
      [],
      'should not appear in not_found',
    );

    const content = readRequirements(tmpDir);
    // File should not be corrupted — no [xx] or doubled markers
    assert.ok(
      content.includes('- [x] **TEST-03**'),
      'existing [x] should remain intact',
    );
    assert.ok(!content.includes('[xx]'), 'should not have doubled x markers');
    assert.ok(
      !content.includes('- [x] [x]'),
      'should not have duplicate checkbox',
    );
  });

  test('returns already_complete for idempotent calls on completed requirements', () => {
    writeRequirements(tmpDir, STANDARD_REQUIREMENTS);

    // The third test requirement already has [x] and Complete in the fixture
    const result = runGsdTools(
      'requirements mark-complete TEST-03 --json',
      tmpDir,
    );
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.deepStrictEqual(
      output.already_complete,
      ['TEST-03'],
      'already_complete should contain TEST-03',
    );
    assert.deepStrictEqual(output.not_found, [], 'not_found should be empty');
  });

  test('mixed: updates pending, reports already-complete, and flags missing', () => {
    writeRequirements(tmpDir, STANDARD_REQUIREMENTS);

    // first: pending (will be marked), third: already complete, last: not found
    const result = runGsdTools(
      'requirements mark-complete TEST-01,TEST-03,FAKE-99 --json',
      tmpDir,
    );
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.deepStrictEqual(
      output.marked_complete,
      ['TEST-01'],
      'marked_complete should contain TEST-01',
    );
    assert.deepStrictEqual(
      output.already_complete,
      ['TEST-03'],
      'already_complete should contain TEST-03',
    );
    assert.deepStrictEqual(
      output.not_found,
      ['FAKE-99'],
      'not_found should contain FAKE-99',
    );
  });

  test('missing REQUIREMENTS.md returns expected error structure', () => {
    // createTempProject does not create REQUIREMENTS.md — so it's already missing

    const result = runGsdTools(
      'requirements mark-complete TEST-01 --json',
      tmpDir,
    );
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.updated, false, 'updated should be false');
    assert.strictEqual(
      output.reason,
      'REQUIREMENTS.md not found',
      'should report file not found',
    );
  });
});

// ─── milestone.cjs branch coverage residuals (60-11) ─────────────────────
describe('milestone.cjs residuals (60-11)', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  // cmdRequirementsMarkComplete: empty/whitespace IDs after parsing
  test('requirements mark-complete: whitespace-only IDs error', () => {
    const { spawnSync } = require('node:child_process');
    const r = spawnSync(
      process.execPath,
      [
        '-e',
        `const m = require(${JSON.stringify(path.resolve('gsd-ng/bin/lib/milestone.cjs'))});m.cmdRequirementsMarkComplete(${JSON.stringify(tmpDir)}, ['  ', ',,', '   ']);`,
      ],
      { encoding: 'utf-8' },
    );
    assert.strictEqual(r.status, 1);
    assert.match(r.stderr, /no valid requirement IDs/);
  });

  test('requirements mark-complete: empty array errors with usage', () => {
    const { spawnSync } = require('node:child_process');
    const r = spawnSync(
      process.execPath,
      [
        '-e',
        `const m = require(${JSON.stringify(path.resolve('gsd-ng/bin/lib/milestone.cjs'))});m.cmdRequirementsMarkComplete(${JSON.stringify(tmpDir)}, []);`,
      ],
      { encoding: 'utf-8' },
    );
    assert.strictEqual(r.status, 1);
    assert.match(r.stderr, /requirement IDs required/);
  });

  test('requirements mark-complete: null arg errors with usage', () => {
    const { spawnSync } = require('node:child_process');
    const r = spawnSync(
      process.execPath,
      [
        '-e',
        `const m = require(${JSON.stringify(path.resolve('gsd-ng/bin/lib/milestone.cjs'))});m.cmdRequirementsMarkComplete(${JSON.stringify(tmpDir)}, null);`,
      ],
      { encoding: 'utf-8' },
    );
    assert.strictEqual(r.status, 1);
    assert.match(r.stderr, /requirement IDs required/);
  });

  // cmdMilestoneComplete: !version error
  test('milestone complete: missing version errors', () => {
    const { spawnSync } = require('node:child_process');
    const r = spawnSync(
      process.execPath,
      [
        '-e',
        `const m = require(${JSON.stringify(path.resolve('gsd-ng/bin/lib/milestone.cjs'))});m.cmdMilestoneComplete(${JSON.stringify(tmpDir)}, '', {});`,
      ],
      { encoding: 'utf-8' },
    );
    assert.strictEqual(r.status, 1);
    assert.match(r.stderr, /version required/);
  });

  // cmdMilestoneComplete: audit file present is renamed into archive
  test('milestone complete: archives MILESTONE-AUDIT.md when present', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      '# Roadmap\n\n# v1.0 — milestone\n',
    );
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      '---\nmilestone: v1.0\nmilestone_name: milestone\n---\n# State\n',
    );
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'v1.0-MILESTONE-AUDIT.md'),
      '# Audit\n',
    );
    const r = runGsdTools(
      ['milestone', 'complete', 'v1.0', '--name', 'first', '--json'],
      tmpDir,
    );
    assert.ok(r.success, r.error);
    // The audit file should now live in the archive dir
    const archiveAudit = path.join(
      tmpDir,
      '.planning',
      'milestones',
      'v1.0-MILESTONE-AUDIT.md',
    );
    assert.ok(fs.existsSync(archiveAudit));
    // Original location no longer present
    assert.ok(
      !fs.existsSync(path.join(tmpDir, '.planning', 'v1.0-MILESTONE-AUDIT.md')),
    );
  });

  // cmdMilestoneComplete: empty MILESTONES.md → write fresh entry
  test('milestone complete: empty MILESTONES.md is treated as new', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      '# Roadmap\n\n# v1.0 — m\n',
    );
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      '---\nmilestone: v1.0\nmilestone_name: m\n---\n',
    );
    // Empty MILESTONES.md (whitespace only)
    fs.writeFileSync(path.join(tmpDir, '.planning', 'MILESTONES.md'), '   \n');
    const r = runGsdTools(['milestone', 'complete', 'v1.0', '--json'], tmpDir);
    assert.ok(r.success, r.error);
    const content = fs.readFileSync(
      path.join(tmpDir, '.planning', 'MILESTONES.md'),
      'utf-8',
    );
    assert.match(content, /^# Milestones/);
    assert.match(content, /## v1\.0/);
  });

  // cmdMilestoneComplete: MILESTONES.md without recognizable header → prepend
  test('milestone complete: MILESTONES.md with no header gets prepended entry', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      '# Roadmap\n\n# v2.0 — second\n',
    );
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      '---\nmilestone: v2.0\nmilestone_name: second\n---\n',
    );
    // No # heading at top — just prose
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'MILESTONES.md'),
      'just plain text no header\n',
    );
    const r = runGsdTools(['milestone', 'complete', 'v2.0', '--json'], tmpDir);
    assert.ok(r.success, r.error);
    const content = fs.readFileSync(
      path.join(tmpDir, '.planning', 'MILESTONES.md'),
      'utf-8',
    );
    // Entry was prepended
    assert.match(content, /^## v2\.0/);
    assert.ok(content.includes('just plain text no header'));
  });
});

describe('milestone complete STATE.md field formats', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  function scaffold(positionBlock) {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      '# Roadmap\n\n# v1.0 — first\n',
    );
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      '---\nmilestone: v1.0\nmilestone_name: first\n---\n# Project State\n\n## Current Position\n\n' +
        positionBlock,
    );
  }

  function assertMilestoneFieldsMoved(state) {
    const today = new Date().toISOString().split('T')[0];
    assert.match(
      state,
      /^(\*\*)?Status:(\*\*)?\s*v1\.0 milestone complete\s*$/m,
      `Status should record the shipped milestone (got: ${state})`,
    );
    assert.match(
      state,
      new RegExp(`^(\\*\\*)?Last Activity:(\\*\\*)?\\s*${today}\\s*$`, 'm'),
      `Last Activity should be today (got: ${state})`,
    );
    assert.match(
      state,
      /^(\*\*)?Last Activity Description:(\*\*)?\s*v1\.0 milestone completed and archived\s*$/m,
      `Last Activity Description should be rewritten (got: ${state})`,
    );
  }

  test('plain-format STATE.md: every field is updated', () => {
    scaffold(
      'Status: In progress\nLast Activity: 2025-01-01\nLast Activity Description: Working\n',
    );
    const r = runGsdTools(['milestone', 'complete', 'v1.0', '--json'], tmpDir);
    assert.ok(r.success, r.error);
    assertMilestoneFieldsMoved(
      fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8'),
    );
    const out = JSON.parse(r.output);
    assert.deepStrictEqual(
      out.state_fields_missing,
      [],
      `no field should be reported missing (got: ${r.output})`,
    );
  });

  test('bold-format STATE.md: every field is updated', () => {
    scaffold(
      '**Status:** In progress\n**Last Activity:** 2025-01-01\n**Last Activity Description:** Working\n',
    );
    const r = runGsdTools(['milestone', 'complete', 'v1.0', '--json'], tmpDir);
    assert.ok(r.success, r.error);
    assertMilestoneFieldsMoved(
      fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8'),
    );
  });

  test('reports fields it could not find instead of silent success', () => {
    scaffold('Status: In progress\n');
    const r = runGsdTools(['milestone', 'complete', 'v1.0', '--json'], tmpDir);
    assert.ok(r.success, r.error);
    const out = JSON.parse(r.output);
    assert.deepStrictEqual(out.state_fields_updated, ['Status']);
    assert.ok(
      out.state_fields_missing.includes('Last Activity'),
      `absent fields should be reported (got: ${r.output})`,
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// validate consistency command
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// MILESTONES.md round trip: what `milestone complete` writes, `cleanup` reads
// ─────────────────────────────────────────────────────────────────────────────

describe('milestone complete → cleanup round trip', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  function seedProject() {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      '# Roadmap v1.0\n\n### Phase 1: Foundation\n**Goal:** Setup\n\n### Phase 2: Auth\n**Goal:** Login\n',
    );
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      '# State\n\n**Status:** In progress\n**Last Activity:** 2025-01-01\n**Last Activity Description:** Working\n',
    );
    for (const dir of ['01-foundation', '02-auth']) {
      const phaseDir = path.join(tmpDir, '.planning', 'phases', dir);
      fs.mkdirSync(phaseDir, { recursive: true });
      fs.writeFileSync(
        path.join(phaseDir, `${dir.slice(0, 2)}-01-SUMMARY.md`),
        '---\none-liner: Did the thing\n---\n# Summary\n',
      );
    }
  }

  test('cleanup finds the milestone that milestone complete just wrote', () => {
    seedProject();

    const completed = runGsdTools(
      ['milestone', 'complete', 'v1.0', '--name', 'Foundation', '--json'],
      tmpDir,
    );
    assert.ok(completed.success, `milestone complete failed: ${completed.error}`);

    const result = runGsdTools(['cleanup', '--dry-run', '--json'], tmpDir);
    assert.ok(result.success, `cleanup failed: ${result.error}`);

    const parsed = JSON.parse(result.output);
    assert.strictEqual(
      parsed.nothing_to_do,
      false,
      'cleanup must not report nothing_to_do for a milestone it just wrote',
    );
    const entry = (parsed.milestones || []).find((m) => m.version === 'v1.0');
    assert.ok(entry, 'cleanup should detect v1.0');
    assert.deepStrictEqual(
      entry.phases_to_archive.sort(),
      ['01-foundation', '02-auth'],
      'both phase directories should be queued for archiving',
    );
    assert.strictEqual(entry.name, 'Foundation', 'milestone name should survive the round trip');
  });

  test('cleanup archives the phases of a milestone completed without --archive-phases', () => {
    seedProject();

    const completed = runGsdTools(
      ['milestone', 'complete', 'v1.0', '--name', 'Foundation', '--json'],
      tmpDir,
    );
    assert.ok(completed.success, `milestone complete failed: ${completed.error}`);
    assert.ok(
      fs.existsSync(path.join(tmpDir, '.planning', 'phases', '01-foundation')),
      'phases stay in place without --archive-phases',
    );

    const result = runGsdTools(['cleanup', '--json'], tmpDir);
    assert.ok(result.success, `cleanup failed: ${result.error}`);

    const archived = path.join(tmpDir, '.planning', 'milestones', 'v1.0-phases');
    assert.ok(
      fs.existsSync(path.join(archived, '01-foundation')),
      '01-foundation should be archived',
    );
    assert.ok(
      fs.existsSync(path.join(archived, '02-auth')),
      '02-auth should be archived',
    );
    assert.ok(
      !fs.existsSync(path.join(tmpDir, '.planning', 'phases', '01-foundation')),
      '01-foundation should be gone from phases/',
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// STATE.md write waits for the lock
// ─────────────────────────────────────────────────────────────────────────────
//
// milestone complete reads STATE.md, replaces three fields in what it read and
// writes the whole file back. Nothing in the command establishes that no other
// writer is running — it takes a version and archives against it whenever it is
// called — so an unserialised write here discards whatever a locked writer added
// between the read and the write.
//
// The lock is held by the test process, so the child's wait does not depend on
// timing, and the child announces itself through a flag file so the window is
// measured from a loaded process. The second half asserts the write lands once
// the lock is free, so a child that did nothing fails too.

describe('milestone complete STATE.md write waits for the lock', () => {
  const MILESTONE_LIB = path.join(
    __dirname,
    '..',
    'gsd-ng',
    'bin',
    'lib',
    'milestone.cjs',
  );

  const CHILD_SRC = `
    const fs = require('fs');
    const [lib, cwd, readyFlag] = process.argv.slice(1);
    const milestone = require(lib);
    fs.writeFileSync(readyFlag, '');
    milestone.cmdMilestoneComplete(cwd, 'v1.0', { name: 'MVP' });
  `;

  let tmpDir;
  let statePath;
  let lockPath;
  let readyFlag;

  beforeEach(() => {
    tmpDir = createTempProject();
    statePath = path.join(tmpDir, '.planning', 'STATE.md');
    lockPath = path.join(tmpDir, '.planning', '.STATE.md.gsd-lock');
    readyFlag = path.join(tmpDir, 'child-ready');
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      '# Roadmap v1.0 MVP\n\n### Phase 1: Foundation\n**Goal:** Setup\n',
    );
    fs.writeFileSync(
      statePath,
      [
        '# Session State',
        '',
        '## Current Position',
        '',
        '**Status:** Executing',
        '**Last Activity:** 2026-01-01',
        '**Last Activity Description:** Working',
        '',
      ].join('\n'),
    );
    const dir = path.join(tmpDir, '.planning', 'phases', '01-foundation');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, '01-01-PLAN.md'), '# Plan');
    fs.writeFileSync(
      path.join(dir, '01-01-SUMMARY.md'),
      '---\none-liner: Set up project infrastructure\n---\n# Summary\n',
    );
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('does not rewrite STATE.md while another writer holds it', async () => {
    const before = fs.readFileSync(statePath, 'utf-8');
    fs.writeFileSync(
      lockPath,
      JSON.stringify({
        pid: process.pid,
        host: require('os').hostname(),
        at: new Date().toISOString(),
      }),
    );

    const child = spawn(
      process.execPath,
      ['-e', CHILD_SRC, '--', MILESTONE_LIB, tmpDir, readyFlag],
      { stdio: ['ignore', 'ignore', 'pipe'] },
    );
    let stderr = '';
    child.stderr.on('data', (d) => (stderr += d));
    trackExit(child);

    await waitForReadyFlag(readyFlag, 'the child');

    // A window far wider than the read-and-rewrite the command performs; the
    // lock, not the clock, is what keeps the child out.
    await new Promise((r) => setTimeout(r, 600));
    assert.strictEqual(
      fs.readFileSync(statePath, 'utf-8'),
      before,
      'STATE.md was rewritten while another writer held the lock',
    );

    fs.unlinkSync(lockPath);
    const code = await waitForExit(child, 'milestone complete');
    assert.strictEqual(code, 0, `the command should succeed: ${stderr.trim()}`);

    const after = fs.readFileSync(statePath, 'utf-8');
    assert.notStrictEqual(
      after,
      before,
      'STATE.md should have been rewritten once the lock was free',
    );
    assert.ok(
      after.includes('**Status:** v1.0 milestone complete'),
      `the status update should have landed: ${after}`,
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// REQUIREMENTS.md has two writers, and they must both be inside its lock
// ─────────────────────────────────────────────────────────────────────────────
//
// `requirements mark-complete` rewrites the whole file from a read of it, so two
// callers marking different IDs each report the ID they marked and one of the
// marks is gone. Phase close does the same rewrite and was serialised only by
// happening to sit inside the roadmap lock, which this entry point never takes.

describe('concurrent requirements mark-complete', () => {
  const { resolveTmpDir, TOOLS_PATH } = require('./helpers.cjs');

  let tmpDir;
  let reqPath;
  let flagDir;

  const IDS = ['REQ-01', 'REQ-02', 'REQ-03', 'REQ-04', 'REQ-05', 'REQ-06'];

  beforeEach(() => {
    tmpDir = createTempProject();
    reqPath = path.join(tmpDir, '.planning', 'REQUIREMENTS.md');
    fs.writeFileSync(
      reqPath,
      [
        '# Requirements',
        '',
        ...IDS.map((id) => `- [ ] **${id}** Something to build`),
        '',
        '## Traceability',
        '',
        '| ID | Phase | Status |',
        '|----|-------|--------|',
        ...IDS.map((id) => `| ${id} | 1 | Pending |`),
        '',
      ].join('\n'),
    );
    flagDir = fs.mkdtempSync(path.join(resolveTmpDir(), 'gsd-req-barrier-'));
  });

  afterEach(() => {
    cleanup(tmpDir);
    cleanup(flagDir);
  });

  test('every concurrent mark survives', async () => {
    const goFlag = path.join(flagDir, 'go');
    const CHILD_SRC = `
      const fs = require('fs');
      const { spawnSync } = require('child_process');
      const [tools, cwd, readyFlag, goFlag, id] = process.argv.slice(1);
      fs.writeFileSync(readyFlag, '');
      const spin = new Int32Array(new SharedArrayBuffer(4));
      while (!fs.existsSync(goFlag)) { Atomics.wait(spin, 0, 0, 1); }
      const r = spawnSync(process.execPath, [tools, 'requirements', 'mark-complete', id, '--json'], { cwd, encoding: 'utf-8' });
      process.stderr.write(r.stderr || '');
      process.exit(r.status === 0 ? 0 : 1);
    `;

    const children = IDS.map((id, i) => {
      const readyFlag = path.join(flagDir, `ready-${i}`);
      const child = spawn(
        process.execPath,
        ['-e', CHILD_SRC, '--', TOOLS_PATH, tmpDir, readyFlag, goFlag, id],
        { stdio: ['ignore', 'ignore', 'pipe'] },
      );
      child._readyFlag = readyFlag;
      child._stderr = '';
      child.stderr.on('data', (d) => (child._stderr += d));
      return child;
    });

    const deadline = Date.now() + 20000;
    while (!children.every((c) => fs.existsSync(c._readyFlag))) {
      assert.ok(Date.now() < deadline, 'a child never signalled readiness');
      await new Promise((r) => setTimeout(r, 5));
    }
    fs.writeFileSync(goFlag, '');

    const codes = await Promise.all(
      children.map((c) => new Promise((r) => c.on('close', r))),
    );
    assert.deepStrictEqual(
      codes,
      IDS.map(() => 0),
      `every child should succeed (stderr: ${children
        .map((c) => c._stderr.trim())
        .filter(Boolean)
        .join(' | ')})`,
    );

    const content = fs.readFileSync(reqPath, 'utf-8');
    const unticked = IDS.filter(
      (id) => !content.includes(`- [x] **${id}**`),
    );
    assert.deepStrictEqual(
      unticked,
      [],
      `marks reported as made but absent from REQUIREMENTS.md: ${unticked.join(', ')}`,
    );
    const stillPending = IDS.filter((id) =>
      new RegExp(`\\|\\s*${id}\\s*\\|[^|]+\\|\\s*Pending\\s*\\|`).test(content),
    );
    assert.deepStrictEqual(
      stillPending,
      [],
      `traceability rows left Pending: ${stillPending.join(', ')}`,
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// milestone complete archives one version of the roadmap
// ─────────────────────────────────────────────────────────────────────────────
//
// The command reads ROADMAP.md to archive it and then records a status beside it
// in STATE.md. With the state lock alone, the snapshot could predate a roadmap
// write that the recorded status is on the other side of — a shipped milestone
// described by two versions, with nothing saying which.

describe('milestone complete waits for the ROADMAP.md lock', () => {
  const MILESTONE_LIB = path.join(
    __dirname,
    '..',
    'gsd-ng',
    'bin',
    'lib',
    'milestone.cjs',
  );

  const CHILD_SRC = `
    const fs = require('fs');
    const [lib, cwd, readyFlag] = process.argv.slice(1);
    const milestone = require(lib);
    fs.writeFileSync(readyFlag, '');
    milestone.cmdMilestoneComplete(cwd, 'v1.0', { name: 'MVP' });
  `;

  let tmpDir;
  let roadmapPath;
  let roadmapLock;
  let archived;
  let readyFlag;

  beforeEach(() => {
    tmpDir = createTempProject();
    roadmapPath = path.join(tmpDir, '.planning', 'ROADMAP.md');
    roadmapLock = path.join(tmpDir, '.planning', '.ROADMAP.md.gsd-lock');
    archived = path.join(
      tmpDir,
      '.planning',
      'milestones',
      'v1.0-ROADMAP.md',
    );
    readyFlag = path.join(tmpDir, 'child-ready');
    fs.writeFileSync(
      roadmapPath,
      '# Roadmap v1.0 MVP\n\n### Phase 1: Foundation\n**Goal:** Setup\n',
    );
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      '# Session State\n\n## Current Position\n\n**Status:** Executing\n',
    );
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('archives nothing while another writer holds the roadmap', async () => {
    fs.writeFileSync(
      roadmapLock,
      JSON.stringify({
        pid: process.pid,
        host: require('os').hostname(),
        at: new Date().toISOString(),
      }),
    );

    const child = spawn(
      process.execPath,
      ['-e', CHILD_SRC, '--', MILESTONE_LIB, tmpDir, readyFlag],
      { stdio: ['ignore', 'ignore', 'pipe'] },
    );
    let stderr = '';
    child.stderr.on('data', (d) => (stderr += d));
    trackExit(child);

    await waitForReadyFlag(readyFlag, 'the child');

    // A window far wider than the read and the copy the archive performs; the
    // lock, not the clock, is what keeps the child out.
    await new Promise((r) => setTimeout(r, 600));
    assert.ok(
      !fs.existsSync(archived),
      'the roadmap was archived while another writer held it',
    );

    // What the lock holder was in the middle of writing.
    fs.writeFileSync(
      roadmapPath,
      '# Roadmap v1.0 MVP\n\n### Phase 1: Foundation\n**Goal:** Setup\n\n### Phase 2: Next\n**Goal:** More\n',
    );
    fs.unlinkSync(roadmapLock);

    const code = await waitForExit(child, 'milestone complete');
    assert.strictEqual(code, 0, `the command should succeed: ${stderr.trim()}`);
    assert.strictEqual(
      fs.readFileSync(archived, 'utf-8'),
      fs.readFileSync(roadmapPath, 'utf-8'),
      'the archive must be the version the status was recorded against',
    );
  });
});
