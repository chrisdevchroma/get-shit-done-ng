/**
 * GSD Agent Frontmatter Tests
 *
 * Validates that all agent .md files have correct frontmatter fields:
 * - Anti-heredoc instruction present in file-writing agents
 * - Commented hooks: pattern in file-writing agents
 * - Spawn type consistency across workflows
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const AGENTS_DIR = path.join(__dirname, '..', 'agents');
const WORKFLOWS_DIR = path.join(__dirname, '..', 'gsd-ng', 'workflows');
const COMMANDS_DIR = path.join(__dirname, '..', 'commands', 'gsd');

const ALL_AGENTS = fs.readdirSync(AGENTS_DIR)
  .filter(f => f.startsWith('gsd-') && f.endsWith('.md'))
  .map(f => f.replace('.md', ''));

const FILE_WRITING_AGENTS = ALL_AGENTS.filter(name => {
  const content = fs.readFileSync(path.join(AGENTS_DIR, name + '.md'), 'utf-8');
  const toolsMatch = content.match(/^tools:\s*(.+)$/m);
  return toolsMatch && toolsMatch[1].includes('Write');
});

const READ_ONLY_AGENTS = ALL_AGENTS.filter(name => !FILE_WRITING_AGENTS.includes(name));

// ─── Anti-Heredoc Instruction ────────────────────────────────────────────────

const SHARED_CONTEXT_PATH = path.join(__dirname, '..', 'gsd-ng', 'references', 'agent-shared-context.md');

describe('HDOC: anti-heredoc instruction', () => {
  test('agent-shared-context.md has centralized anti-heredoc instruction', () => {
    const content = fs.readFileSync(SHARED_CONTEXT_PATH, 'utf-8');
    assert.ok(
      content.includes("never use `Bash(cat << 'EOF')` or heredoc"),
      'agent-shared-context.md missing anti-heredoc instruction (centralized copy)'
    );
  });

  for (const agent of FILE_WRITING_AGENTS) {
    test(`${agent} references agent-shared-context.md (inherits anti-heredoc)`, () => {
      const content = fs.readFileSync(path.join(AGENTS_DIR, agent + '.md'), 'utf-8');
      assert.ok(
        content.includes('agent-shared-context'),
        `${agent} does not reference agent-shared-context.md — anti-heredoc instruction not inherited`
      );
    });
  }

  for (const agent of FILE_WRITING_AGENTS) {
    test(`${agent} has no duplicate anti-heredoc instruction`, () => {
      const content = fs.readFileSync(path.join(AGENTS_DIR, agent + '.md'), 'utf-8');
      assert.ok(
        !content.includes("never use `Bash(cat << 'EOF')` or heredoc"),
        `${agent} has duplicate anti-heredoc instruction — remove per-agent copy (centralized in agent-shared-context.md)`
      );
    });
  }

  test('no active heredoc patterns in any agent file', () => {
    for (const agent of ALL_AGENTS) {
      const content = fs.readFileSync(path.join(AGENTS_DIR, agent + '.md'), 'utf-8');
      // Match actual heredoc commands (not references in anti-heredoc instruction)
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        // Skip lines that are part of the anti-heredoc instruction or markdown code fences
        if (line.includes('never use') || line.includes('NEVER') || line.trim().startsWith('```')) continue;
        // Check for actual heredoc usage instructions
        if (/^cat\s+<<\s*'?EOF'?\s*>/.test(line.trim())) {
          assert.fail(`${agent}:${i + 1} has active heredoc pattern: ${line.trim()}`);
        }
      }
    }
  });
});

// ─── Hooks Frontmatter ───────────────────────────────────────────────────────

describe('HOOK: hooks frontmatter pattern', () => {
  for (const agent of FILE_WRITING_AGENTS) {
    test(`${agent} has commented hooks pattern`, () => {
      const content = fs.readFileSync(path.join(AGENTS_DIR, agent + '.md'), 'utf-8');
      const frontmatter = content.split('---')[1] || '';
      assert.ok(
        frontmatter.includes('# hooks:'),
        `${agent} missing commented hooks: pattern in frontmatter`
      );
    });
  }

  for (const agent of READ_ONLY_AGENTS) {
    test(`${agent} (read-only) does not need hooks`, () => {
      const content = fs.readFileSync(path.join(AGENTS_DIR, agent + '.md'), 'utf-8');
      const frontmatter = content.split('---')[1] || '';
      // Read-only agents may or may not have hooks — just verify they parse
      assert.ok(frontmatter.includes('name:'), `${agent} has valid frontmatter`);
    });
  }
});

// ─── Spawn Type Consistency ──────────────────────────────────────────────────

describe('SPAWN: spawn type consistency', () => {
  test('no "First, read agent .md" workaround pattern remains', () => {
    const dirs = [WORKFLOWS_DIR, COMMANDS_DIR];
    for (const dir of dirs) {
      if (!fs.existsSync(dir)) continue;
      const files = fs.readdirSync(dir).filter(f => f.endsWith('.md'));
      for (const file of files) {
        const content = fs.readFileSync(path.join(dir, file), 'utf-8');
        const hasWorkaround = content.includes('First, read ~/.claude/agents/gsd-');
        assert.ok(
          !hasWorkaround,
          `${file} still has "First, read agent .md" workaround — use named subagent_type instead`
        );
      }
    }
  });

  test('named agent spawns use correct agent names', () => {
    const validAgentTypes = new Set([
      ...ALL_AGENTS,
      'general-purpose',  // Allowed for orchestrator spawns
    ]);

    const dirs = [WORKFLOWS_DIR, COMMANDS_DIR];
    for (const dir of dirs) {
      if (!fs.existsSync(dir)) continue;
      const files = fs.readdirSync(dir).filter(f => f.endsWith('.md'));
      for (const file of files) {
        const content = fs.readFileSync(path.join(dir, file), 'utf-8');
        const matches = content.matchAll(/subagent_type="([^"]+)"/g);
        for (const match of matches) {
          const agentType = match[1];
          assert.ok(
            validAgentTypes.has(agentType),
            `${file} references unknown agent type: ${agentType}`
          );
        }
      }
    }
  });

  test('diagnose-issues uses gsd-debugger (not general-purpose)', () => {
    const content = fs.readFileSync(
      path.join(WORKFLOWS_DIR, 'diagnose-issues.md'), 'utf-8'
    );
    assert.ok(
      content.includes('subagent_type="gsd-debugger"'),
      'diagnose-issues should spawn gsd-debugger, not general-purpose'
    );
  });
});

// ─── Required Frontmatter Fields ─────────────────────────────────────────────

describe('AGENT: required frontmatter fields', () => {
  for (const agent of ALL_AGENTS) {
    test(`${agent} has name, description, tools, color`, () => {
      const content = fs.readFileSync(path.join(AGENTS_DIR, agent + '.md'), 'utf-8');
      const frontmatter = content.split('---')[1] || '';
      assert.ok(frontmatter.includes('name:'), `${agent} missing name:`);
      assert.ok(frontmatter.includes('description:'), `${agent} missing description:`);
      assert.ok(frontmatter.includes('tools:'), `${agent} missing tools:`);
      assert.ok(frontmatter.includes('color:'), `${agent} missing color:`);
    });
  }
});

// ─── Converted Agent Colours (opencode) ──────────────────────────────────────

const { spawnSync } = require('child_process');
const { resolveTmpDir, cleanup } = require('./helpers.cjs');

const INSTALLER = path.join(__dirname, '..', 'bin', 'install.js');
const BASE_TMPDIR = resolveTmpDir();

/**
 * The colours opencode's agent schema accepts, written out rather than read
 * from the registry: a test that derives its expectation from the thing under
 * test cannot fail when that thing is wrong.
 */
const OPENCODE_COLOR_LITERALS = [
  'primary',
  'secondary',
  'accent',
  'success',
  'warning',
  'error',
  'info',
];
const OPENCODE_HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

/**
 * The plugin source the opencode layout declares does not exist yet, so the
 * installer reports that one artifact as failed. The agent files are written
 * either way; any other failure is a real one.
 */
const OPENCODE_PENDING_ARTIFACT = 'plugin';

describe('AGENT: converted agent colours pass opencode schema', () => {
  test('OPENCODE-AGT-COLOR-01: every installed agent colour is a hex or a theme literal', () => {
    const tmpDir = fs.mkdtempSync(path.join(BASE_TMPDIR, 'gsd-oc-color-'));
    try {
      const result = spawnSync(
        process.execPath,
        [
          INSTALLER,
          '--runtime',
          'opencode',
          '--local',
          '--no-seed-permissions-config',
          '--no-seed-sandbox-config',
        ],
        {
          encoding: 'utf8',
          timeout: 60000,
          cwd: tmpDir,
          env: Object.assign({}, process.env, { HOME: tmpDir }),
        },
      );
      if (result.status !== 0) {
        const failed = (result.stderr || '').match(/Failed: (.+)/);
        assert.ok(
          failed && failed[1].trim() === OPENCODE_PENDING_ARTIFACT,
          'opencode install may only fail on ' +
            OPENCODE_PENDING_ARTIFACT +
            '\nstderr: ' +
            (result.stderr || ''),
        );
      }

      const agentDir = path.join(tmpDir, '.opencode', 'agent');
      const files = fs
        .readdirSync(agentDir)
        .filter((f) => f.startsWith('gsd-') && f.endsWith('.md'))
        .sort();
      assert.strictEqual(
        files.length,
        ALL_AGENTS.length,
        'one converted agent per source agent (OPENCODE-AGT-COLOR-01)',
      );

      const offenders = [];
      for (const file of files) {
        const text = fs.readFileSync(path.join(agentDir, file), 'utf-8');
        const match = text.match(/^color:[ \t]*(.+)$/m);
        if (!match) {
          offenders.push(`${file}: no color`);
          continue;
        }
        const value = match[1].trim().replace(/^['"]|['"]$/g, '');
        if (!OPENCODE_HEX_COLOR.test(value) && !OPENCODE_COLOR_LITERALS.includes(value)) {
          offenders.push(`${file}: ${value}`);
        }
      }

      assert.deepStrictEqual(
        offenders,
        [],
        'opencode accepts #RRGGBB or one of ' +
          OPENCODE_COLOR_LITERALS.join(', ') +
          ' — one rejected value stops the whole agent surface from loading ' +
          '(OPENCODE-AGT-COLOR-01)',
      );
    } finally {
      cleanup(tmpDir);
    }
  });
});
