'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const {
  processTemplate,
  validateMarkers,
  buildContext,
  RUNTIMES,
  fillBetweenMarkers,
  patternToRemoval,
} = require('../gsd-ng/bin/lib/template-processor.cjs');
const { resolveTmpDir, cleanup } = require('./helpers.cjs');

const BASE_TMPDIR = resolveTmpDir();

// --- Variable substitution ---

describe('processTemplate - variable substitution', () => {
  const cases = [
    {
      name: 'resolves context variable',
      input: 'Hello {{NAME}}',
      context: { runtime: 'claude', NAME: 'World' },
      expected: 'Hello World',
    },
    {
      name: 'resolves PROJECT_RULES_FILE for claude',
      input: '{{PROJECT_RULES_FILE}}',
      context: { runtime: 'claude' },
      expected: 'CLAUDE.md',
    },
    {
      name: 'resolves PROJECT_RULES_FILE for copilot',
      input: '{{PROJECT_RULES_FILE}}',
      context: { runtime: 'copilot' },
      expected: '.github/copilot-instructions.md',
    },
    {
      name: 'resolves USER_QUESTION_TOOL for claude',
      input: '{{USER_QUESTION_TOOL}}',
      context: { runtime: 'claude' },
      expected: 'AskUserQuestion',
    },
    {
      name: 'leaves unknown variable as-is',
      input: '{{UNKNOWN_VAR}}',
      context: { runtime: 'claude' },
      expected: '{{UNKNOWN_VAR}}',
    },
    {
      name: 'replacement containing $1 does not trigger backreference',
      input: 'path is {{VAR}}',
      context: { runtime: 'claude', VAR: '$1/foo' },
      expected: 'path is $1/foo',
    },
  ];

  for (const c of cases) {
    test(c.name, () => {
      assert.equal(processTemplate(c.input, c.context), c.expected);
    });
  }
});

// --- Conditional blocks ---

describe('processTemplate - conditional blocks', () => {
  const cases = [
    {
      name: 'keeps matching claude block',
      input: '<!-- ONLY:claude -->Claude text<!-- /ONLY:claude -->',
      context: { runtime: 'claude' },
      expected: 'Claude text',
    },
    {
      name: 'strips non-matching claude block for copilot runtime',
      input: '<!-- ONLY:claude -->Claude text<!-- /ONLY:claude -->',
      context: { runtime: 'copilot' },
      expected: '',
    },
    {
      name: 'keeps matching copilot block',
      input: '<!-- ONLY:copilot -->Copilot text<!-- /ONLY:copilot -->',
      context: { runtime: 'copilot' },
      expected: 'Copilot text',
    },
    {
      name: 'mixed blocks - keeps correct one for claude',
      input:
        '<!-- ONLY:claude -->C<!-- /ONLY:claude -->|<!-- ONLY:copilot -->P<!-- /ONLY:copilot -->',
      context: { runtime: 'claude' },
      expected: 'C|',
    },
    {
      name: 'mixed blocks - keeps correct one for copilot',
      input:
        '<!-- ONLY:claude -->C<!-- /ONLY:claude -->|<!-- ONLY:copilot -->P<!-- /ONLY:copilot -->',
      context: { runtime: 'copilot' },
      expected: '|P',
    },
    {
      name: 'multiline content inside conditional block preserved',
      input: '<!-- ONLY:claude -->line1\nline2\nline3<!-- /ONLY:claude -->',
      context: { runtime: 'claude' },
      expected: 'line1\nline2\nline3',
    },
    {
      name: 'variable inside conditional block resolved after block resolution',
      input:
        '<!-- ONLY:claude -->File: {{PROJECT_RULES_FILE}}<!-- /ONLY:claude -->',
      context: { runtime: 'claude' },
      expected: 'File: CLAUDE.md',
    },
  ];

  for (const c of cases) {
    test(c.name, () => {
      assert.equal(processTemplate(c.input, c.context), c.expected);
    });
  }
});

// --- validateMarkers ---

describe('validateMarkers', () => {
  const cases = [
    {
      name: 'balanced markers do not throw',
      input: '<!-- ONLY:claude -->text<!-- /ONLY:claude -->',
      shouldThrow: false,
    },
    {
      name: 'unclosed open marker throws with Unbalanced',
      input: '<!-- ONLY:claude -->text',
      shouldThrow: true,
      messagePattern: /Unbalanced/,
    },
    {
      name: 'close without open throws',
      input: '<!-- /ONLY:claude -->',
      shouldThrow: true,
      messagePattern: /Unbalanced/,
    },
    {
      name: 'empty content does not throw',
      input: '',
      shouldThrow: false,
    },
  ];

  for (const c of cases) {
    test(c.name, () => {
      if (c.shouldThrow) {
        assert.throws(() => validateMarkers(c.input), c.messagePattern);
      } else {
        assert.doesNotThrow(() => validateMarkers(c.input));
      }
    });
  }
});

// --- buildContext ---

describe('buildContext', () => {
  const cases = [
    {
      name: 'returns runtime only when no options',
      runtime: 'claude',
      options: undefined,
      expected: { runtime: 'claude' },
    },
    {
      name: 'merges extra options',
      runtime: 'claude',
      options: { extra: true },
      expected: { runtime: 'claude', extra: true },
    },
  ];

  for (const c of cases) {
    test(c.name, () => {
      assert.deepEqual(buildContext(c.runtime, c.options), c.expected);
    });
  }
});

// --- RUNTIMES registry ---

describe('RUNTIMES', () => {
  test('claude PROJECT_RULES_FILE is CLAUDE.md', () => {
    assert.equal(RUNTIMES.claude.PROJECT_RULES_FILE, 'CLAUDE.md');
  });

  test('copilot PROJECT_RULES_FILE is .github/copilot-instructions.md', () => {
    assert.equal(
      RUNTIMES.copilot.PROJECT_RULES_FILE,
      '.github/copilot-instructions.md',
    );
  });

  test('no runtime carries a TBD placeholder value', () => {
    const offenders = [];
    for (const [runtime, entry] of Object.entries(RUNTIMES)) {
      for (const [key, value] of Object.entries(entry)) {
        if (value === 'TBD') offenders.push(`${runtime}.${key}`);
      }
    }
    assert.deepEqual(
      offenders,
      [],
      `placeholder 'TBD' still shipped for: ${offenders.join(', ')}`,
    );
  });

  test('copilot USER_QUESTION_TOOL is ask_user', () => {
    assert.equal(RUNTIMES.copilot.USER_QUESTION_TOOL, 'ask_user');
    assert.equal(
      processTemplate('Use {{USER_QUESTION_TOOL}}', buildContext('copilot')),
      'Use ask_user',
    );
  });
});

// --- RUNTIMES extension ---

describe('RUNTIMES extension', () => {
  test('RUNTIMES.claude exposes COMMAND_PREFIX = /gsd:', () => {
    assert.equal(RUNTIMES.claude.COMMAND_PREFIX, '/gsd:');
  });
  test('RUNTIMES.claude exposes GSD_BLOCK_OPEN = ## GSD', () => {
    assert.equal(RUNTIMES.claude.GSD_BLOCK_OPEN, '## GSD');
  });
  test('RUNTIMES.claude exposes GSD_BLOCK_CLOSE = ## (h2 prefix marker)', () => {
    assert.equal(RUNTIMES.claude.GSD_BLOCK_CLOSE, '## ');
  });
  test('RUNTIMES.claude exposes MEMORY_DIR = .claude/memory/', () => {
    assert.equal(RUNTIMES.claude.MEMORY_DIR, '.claude/memory/');
  });
  test('RUNTIMES.copilot exposes COMMAND_PREFIX = /gsd-', () => {
    assert.equal(RUNTIMES.copilot.COMMAND_PREFIX, '/gsd-');
  });
  test('RUNTIMES.copilot exposes GSD_BLOCK_OPEN = <!-- GSD Configuration -->', () => {
    assert.equal(RUNTIMES.copilot.GSD_BLOCK_OPEN, '<!-- GSD Configuration -->');
  });
  test('RUNTIMES.copilot exposes GSD_BLOCK_CLOSE = <!-- /GSD Configuration -->', () => {
    assert.equal(
      RUNTIMES.copilot.GSD_BLOCK_CLOSE,
      '<!-- /GSD Configuration -->',
    );
  });
  test('RUNTIMES.copilot exposes MEMORY_DIR = .github/memory/', () => {
    assert.equal(RUNTIMES.copilot.MEMORY_DIR, '.github/memory/');
  });

  test('processTemplate resolves 4 new tokens for claude', () => {
    const corpus =
      '{{COMMAND_PREFIX}} {{GSD_BLOCK_OPEN}} {{GSD_BLOCK_CLOSE}} {{MEMORY_DIR}}';
    const out = processTemplate(corpus, buildContext('claude'));
    assert.equal(out, '/gsd: ## GSD ##  .claude/memory/');
    assert.ok(!out.includes('{{'), 'no unresolved {{VAR}} should remain');
  });
  test('processTemplate resolves 4 new tokens for copilot', () => {
    const corpus =
      '{{COMMAND_PREFIX}} {{GSD_BLOCK_OPEN}} {{GSD_BLOCK_CLOSE}} {{MEMORY_DIR}}';
    const out = processTemplate(corpus, buildContext('copilot'));
    assert.equal(
      out,
      '/gsd- <!-- GSD Configuration --> <!-- /GSD Configuration --> .github/memory/',
    );
    assert.ok(!out.includes('{{'), 'no unresolved {{VAR}} should remain');
  });

  test('SYNTHETIC RUNTIME ACCEPTANCE: adding _test_runtime registry entry alone resolves all 6 keys', () => {
    // Mutate RUNTIMES in-test to add a synthetic runtime — proves "registry-only abstraction" property.
    const stash = RUNTIMES._test_runtime;
    RUNTIMES._test_runtime = {
      PROJECT_RULES_FILE: '_TEST_RULES.md',
      USER_QUESTION_TOOL: '_TEST_TOOL',
      COMMAND_PREFIX: '/_test:',
      GSD_BLOCK_OPEN: '<!-- TEST OPEN -->',
      GSD_BLOCK_CLOSE: '<!-- TEST CLOSE -->',
      MEMORY_DIR: '_test/memory/',
    };
    try {
      const corpus = [
        '{{PROJECT_RULES_FILE}}',
        '{{USER_QUESTION_TOOL}}',
        '{{COMMAND_PREFIX}}',
        '{{GSD_BLOCK_OPEN}}',
        '{{GSD_BLOCK_CLOSE}}',
        '{{MEMORY_DIR}}',
      ].join(' | ');
      const out = processTemplate(corpus, { runtime: '_test_runtime' });
      assert.equal(
        out,
        '_TEST_RULES.md | _TEST_TOOL | /_test: | <!-- TEST OPEN --> | <!-- TEST CLOSE --> | _test/memory/',
      );
      assert.ok(
        !out.includes('{{'),
        'all template vars must resolve via the registry alone',
      );
    } finally {
      if (stash === undefined) delete RUNTIMES._test_runtime;
      else RUNTIMES._test_runtime = stash;
    }
  });
});

// --- opencode registry row ---

/** Registry keys prefixed with _ are synthetic test fixtures, not shipped runtimes. */
function realRuntimes() {
  return Object.entries(RUNTIMES).filter(([name]) => !name.startsWith('_'));
}

describe('RUNTIMES.opencode', () => {
  const contentKeys = [
    ['PROJECT_RULES_FILE', 'AGENTS.md'],
    ['USER_QUESTION_TOOL', 'question'],
    ['COMMAND_PREFIX', '/gsd-'],
    ['GSD_BLOCK_OPEN', '<!-- GSD Configuration -->'],
    ['GSD_BLOCK_CLOSE', '<!-- /GSD Configuration -->'],
    ['MEMORY_DIR', '.opencode/memory/'],
  ];

  for (const [key, expected] of contentKeys) {
    test(`opencode ${key} is ${expected}`, () => {
      assert.equal(RUNTIMES.opencode[key], expected);
    });
  }

  test('registry holds exactly claude, copilot, opencode', () => {
    assert.deepEqual(realRuntimes().map(([name]) => name), [
      'claude',
      'copilot',
      'opencode',
    ]);
  });

  test('processTemplate resolves all six content keys for opencode', () => {
    const corpus = contentKeys.map(([key]) => `{{${key}}}`).join(' | ');
    const out = processTemplate(corpus, buildContext('opencode'));
    assert.equal(out, contentKeys.map(([, value]) => value).join(' | '));
    assert.ok(!out.includes('{{'), 'no unresolved {{VAR}} should remain');
  });

  test('ONLY:opencode block is kept for opencode', () => {
    assert.equal(
      processTemplate(
        '<!-- ONLY:opencode -->OpenCode text<!-- /ONLY:opencode -->',
        buildContext('opencode'),
      ),
      'OpenCode text',
    );
  });

  test('ONLY:opencode block is stripped for claude and copilot', () => {
    const input = 'a<!-- ONLY:opencode -->OpenCode text<!-- /ONLY:opencode -->b';
    assert.equal(processTemplate(input, buildContext('claude')), 'ab');
    assert.equal(processTemplate(input, buildContext('copilot')), 'ab');
  });

  test('ONLY:claude and ONLY:copilot blocks are stripped for opencode', () => {
    const input =
      '<!-- ONLY:claude -->C<!-- /ONLY:claude -->|<!-- ONLY:copilot -->P<!-- /ONLY:copilot -->';
    assert.equal(processTemplate(input, buildContext('opencode')), '|');
  });
});

// --- spec shape parity across runtimes ---

describe('RUNTIMES spec parity', () => {
  for (const spec of ['configHome', 'layout', 'TOOL_MAP']) {
    test(`every runtime carries a ${spec} spec`, () => {
      const missing = realRuntimes()
        .filter(
          ([, entry]) =>
            !Object.prototype.hasOwnProperty.call(entry, spec) ||
            (spec !== 'TOOL_MAP' && !entry[spec]),
        )
        .map(([name]) => name);
      assert.deepEqual(missing, [], `runtimes missing ${spec}: ${missing}`);
    });
  }

  test('every runtime carries RUNTIME_LABEL and PROJECT_DIR_ENV', () => {
    for (const [name, entry] of realRuntimes()) {
      assert.equal(typeof entry.RUNTIME_LABEL, 'string', `${name}.RUNTIME_LABEL`);
      assert.equal(
        typeof entry.PROJECT_DIR_ENV,
        'string',
        `${name}.PROJECT_DIR_ENV`,
      );
    }
  });

  test('RUNTIME_LABEL reproduces getRuntimeLabel output', () => {
    assert.equal(RUNTIMES.claude.RUNTIME_LABEL, 'Claude Code');
    assert.equal(RUNTIMES.copilot.RUNTIME_LABEL, 'Copilot CLI');
    assert.equal(RUNTIMES.opencode.RUNTIME_LABEL, 'OpenCode');
  });

  test('CONFIG_DIR equals configHome.localDirName on every runtime', () => {
    const drifted = realRuntimes()
      .filter(([, entry]) => entry.CONFIG_DIR !== entry.configHome.localDirName)
      .map(
        ([name, entry]) =>
          `${name}: ${entry.CONFIG_DIR} !== ${entry.configHome.localDirName}`,
      );
    assert.deepEqual(drifted, [], `CONFIG_DIR drifted: ${drifted.join(', ')}`);
  });

  test('processTemplate resolves {{CONFIG_DIR}} to each runtime local dir', () => {
    assert.equal(
      processTemplate('{{CONFIG_DIR}}/skills/', buildContext('opencode')),
      '.opencode/skills/',
    );
    assert.equal(
      processTemplate('{{CONFIG_DIR}}/skills/', buildContext('claude')),
      '.claude/skills/',
    );
    assert.equal(
      processTemplate('{{CONFIG_DIR}}/skills/', buildContext('copilot')),
      '.github/skills/',
    );
  });
});

// --- configHome spec ---

describe('RUNTIMES configHome', () => {
  const cases = [
    {
      runtime: 'claude',
      envVar: 'CLAUDE_CONFIG_DIR',
      xdg: null,
      globalDirName: '.claude',
      localDirName: '.claude',
      configDirLiteral: { global: "'.claude'", local: "'.claude'" },
    },
    {
      runtime: 'copilot',
      envVar: 'COPILOT_CONFIG_DIR',
      xdg: null,
      globalDirName: '.copilot',
      localDirName: '.github',
      configDirLiteral: { global: "'.copilot'", local: "'.github'" },
    },
    {
      runtime: 'opencode',
      envVar: 'OPENCODE_CONFIG_DIR',
      xdg: {
        varName: 'XDG_CONFIG_HOME',
        fallback: '~/.config',
        suffix: 'opencode',
      },
      globalDirName: null,
      localDirName: '.opencode',
      configDirLiteral: { global: "'.opencode'", local: "'.opencode'" },
    },
  ];

  for (const c of cases) {
    test(`${c.runtime} configHome reproduces today's resolver values`, () => {
      const { runtime, ...expected } = c;
      assert.deepEqual(RUNTIMES[runtime].configHome, expected);
    });
  }
});

// --- layout spec ---

describe('RUNTIMES layout', () => {
  test('claude layout describes the commands and agents it writes today', () => {
    const { commands, agents } = RUNTIMES.claude.layout;
    assert.equal(commands.dir, 'commands/gsd');
    assert.equal(commands.pattern, '<name>.md');
    assert.equal(commands.converter, 'identity');
    assert.equal(agents.dir, 'agents');
    assert.equal(agents.pattern, 'gsd-<name>.md');
    assert.equal(agents.converter, 'identity');
  });

  test('claude layout lists the seven shipped hook files', () => {
    assert.deepEqual(RUNTIMES.claude.layout.hooks.files, [
      'bash-safety-hook.cjs',
      'gsd-check-update.js',
      'gsd-context-monitor.js',
      'gsd-guardrail.js',
      'gsd-hook-stdin.cjs',
      'gsd-sandbox-detect.js',
      'gsd-statusline.js',
    ]);
    assert.equal(RUNTIMES.claude.layout.hooks.dir, 'hooks');
    assert.equal(RUNTIMES.claude.layout.hooks.rewriteConfigDirLiteral, true);
  });

  test('claude layout enables the CommonJS marker, settings and six post-pass dirs', () => {
    const layout = RUNTIMES.claude.layout;
    assert.equal(layout.writeCommonJsMarker, true);
    assert.equal(layout.settings, true);
    assert.deepEqual(layout.templatePassDirs, [
      'gsd-ng/workflows',
      'gsd-ng/references',
      'gsd-ng/bin/lib',
      'gsd-ng/templates',
      'commands/gsd',
      'agents',
    ]);
    assert.equal(layout.rulesFile, null);
  });

  test('copilot layout describes skills, agent suffix and the hook descriptor', () => {
    const layout = RUNTIMES.copilot.layout;
    assert.equal(layout.commands.dir, 'skills');
    assert.equal(layout.commands.pattern, 'gsd-<name>/SKILL.md');
    assert.equal(layout.commands.converter, 'copilotCommand');
    assert.deepEqual(layout.commands.skip, ['set-profile.md']);
    assert.equal(layout.agents.dir, 'agents');
    assert.equal(layout.agents.pattern, 'gsd-<name>.agent.md');
    assert.equal(layout.agents.converter, 'copilotAgent');
    assert.deepEqual(layout.hooks.files, ['gsd-hooks.json']);
    assert.equal(layout.hooks.localOnly, true);
  });

  test('copilot layout disables the CommonJS marker and settings but has a post-pass', () => {
    const layout = RUNTIMES.copilot.layout;
    assert.equal(layout.writeCommonJsMarker, false);
    assert.equal(layout.settings, false);
    assert.deepEqual(layout.templatePassDirs, [
      'gsd-ng/workflows',
      'gsd-ng/references',
      'gsd-ng/bin/lib',
      'gsd-ng/templates',
    ]);
    assert.deepEqual(layout.rulesFile, {
      base: 'targetDir',
      name: 'copilot-instructions.md',
      template: 'project-rules-block.md',
    });
  });

  test('opencode layout describes command/, agent/ and the plugin file rename', () => {
    const layout = RUNTIMES.opencode.layout;
    assert.equal(layout.commands.dir, 'command');
    assert.equal(layout.commands.pattern, 'gsd-<name>.md');
    assert.equal(layout.commands.converter, 'opencodeCommand');
    assert.equal(layout.agents.dir, 'agent');
    assert.equal(layout.agents.pattern, 'gsd-<name>.md');
    assert.equal(layout.agents.converter, 'opencodeAgent');
    assert.equal(layout.plugin.dir, 'plugin');
    assert.deepEqual(layout.plugin.files, [
      { from: 'hooks/gsd-opencode-plugin.js', to: 'gsd-core.js' },
    ]);
  });

  test('opencode layout copies three hook payload files into the engine tree', () => {
    assert.deepEqual(RUNTIMES.opencode.layout.hooksPayload, {
      dir: 'gsd-ng/hooks',
      from: 'hooks',
      files: [
        'bash-safety-hook.cjs',
        'gsd-hook-stdin.cjs',
        'gsd-check-update.js',
      ],
    });
  });

  test('opencode layout disables the CommonJS marker and bases its rules file on cwd, for local installs only', () => {
    const layout = RUNTIMES.opencode.layout;
    assert.equal(layout.writeCommonJsMarker, false);
    assert.equal(layout.settings, false);
    assert.deepEqual(layout.rulesFile, {
      base: 'cwd',
      name: 'AGENTS.md',
      template: 'project-rules-block.md',
      localOnly: true,
    });
    assert.deepEqual(layout.templatePassDirs, [
      'gsd-ng/workflows',
      'gsd-ng/references',
      'gsd-ng/bin/lib',
      'gsd-ng/templates',
    ]);
    assert.deepEqual(layout.configSeed, {
      file: 'opencode.json',
      contents: { $schema: 'https://opencode.ai/config.json' },
    });
  });

  test('every runtime layout carries the same set of keys', () => {
    const claudeKeys = Object.keys(RUNTIMES.claude.layout).sort();
    for (const [name, entry] of realRuntimes()) {
      assert.deepEqual(
        Object.keys(entry.layout).sort(),
        claudeKeys,
        `${name}.layout key set diverges from claude`,
      );
    }
  });
});

// --- removal predicate derived from the write pattern ---

describe('patternToRemoval', () => {
  const cases = [
    {
      pattern: 'gsd-<name>.md',
      expected: { prefix: 'gsd-', suffix: '.md', entryType: 'file' },
    },
    {
      pattern: 'gsd-<name>.agent.md',
      expected: { prefix: 'gsd-', suffix: '.agent.md', entryType: 'file' },
    },
    {
      pattern: 'gsd-<name>/SKILL.md',
      expected: { prefix: 'gsd-', suffix: '', entryType: 'dir' },
    },
    {
      pattern: '<name>.md',
      expected: { prefix: '', suffix: '.md', entryType: 'file' },
    },
  ];

  for (const c of cases) {
    test(`derives removal predicate from ${c.pattern}`, () => {
      assert.deepEqual(patternToRemoval(c.pattern), c.expected);
    });
  }

  test('throws when the pattern has no <name> placeholder', () => {
    assert.throws(() => patternToRemoval('SKILL.md'), /<name>/);
  });

  test('every layout write pattern yields a usable removal predicate', () => {
    for (const [name, entry] of realRuntimes()) {
      for (const kind of ['commands', 'agents']) {
        const { prefix, suffix, entryType } = patternToRemoval(
          entry.layout[kind].pattern,
        );
        assert.ok(
          ['file', 'dir'].includes(entryType),
          `${name}.${kind} entryType`,
        );
        assert.equal(typeof prefix, 'string');
        assert.equal(typeof suffix, 'string');
      }
    }
  });
});

// --- TOOL_MAP ---

describe('RUNTIMES TOOL_MAP', () => {
  test('claude TOOL_MAP is null, meaning the identity map', () => {
    assert.equal(RUNTIMES.claude.TOOL_MAP, null);
  });

  test('copilot TOOL_MAP is the installer map verbatim', () => {
    assert.deepEqual(RUNTIMES.copilot.TOOL_MAP, {
      Read: 'read',
      Write: 'edit',
      Edit: 'edit',
      Bash: 'execute',
      Grep: 'search',
      Glob: 'search',
      Task: 'agent',
      WebSearch: 'web',
      WebFetch: 'web',
      TodoWrite: 'todo',
      AskUserQuestion: 'ask_user',
      SlashCommand: 'skill',
    });
  });

  test('opencode TOOL_MAP uses the canonical opencode tool ids', () => {
    assert.deepEqual(RUNTIMES.opencode.TOOL_MAP, {
      Read: 'read',
      Write: 'write',
      Edit: 'edit',
      Bash: 'bash',
      Glob: 'glob',
      Grep: 'grep',
      WebFetch: 'webfetch',
      WebSearch: 'websearch',
      TodoWrite: 'todowrite',
      AskUserQuestion: 'question',
      Task: 'task',
      Agent: 'task',
    });
  });

  test('opencode TOOL_MAP omits names with no opencode equivalent', () => {
    assert.equal(RUNTIMES.opencode.TOOL_MAP.SlashCommand, undefined);
  });
});

// --- fillBetweenMarkers ---

describe('fillBetweenMarkers', () => {
  test('fills content between markers from template inner content', () => {
    const tmpDir = fs.mkdtempSync(path.join(BASE_TMPDIR, 'tp-fill-'));
    try {
      const targetPath = path.join(tmpDir, 'target.md');
      const templatePath = path.join(tmpDir, 'template.md');
      fs.writeFileSync(
        targetPath,
        'before\n<!-- START -->\n<!-- /START -->\nafter\n',
      );
      fs.writeFileSync(
        templatePath,
        '<!-- START -->\ninner content\n<!-- /START -->\n',
      );
      fillBetweenMarkers(
        targetPath,
        templatePath,
        '<!-- START -->',
        '<!-- /START -->',
      );
      const result = fs.readFileSync(targetPath, 'utf8');
      assert.ok(
        result.includes('inner content'),
        'filled content must appear between markers',
      );
      assert.ok(
        result.includes('before'),
        'content before markers must be preserved',
      );
      assert.ok(
        result.includes('after'),
        'content after markers must be preserved',
      );
    } finally {
      cleanup(tmpDir);
    }
  });

  test('overwrites existing content between markers (always in sync with template)', () => {
    const tmpDir = fs.mkdtempSync(path.join(BASE_TMPDIR, 'tp-fill-'));
    try {
      const targetPath = path.join(tmpDir, 'target.md');
      const templatePath = path.join(tmpDir, 'template.md');
      fs.writeFileSync(
        targetPath,
        '<!-- START -->\nstale content\n<!-- /START -->\n',
      );
      fs.writeFileSync(
        templatePath,
        '<!-- START -->\nfresh content\n<!-- /START -->\n',
      );
      fillBetweenMarkers(
        targetPath,
        templatePath,
        '<!-- START -->',
        '<!-- /START -->',
      );
      const result = fs.readFileSync(targetPath, 'utf8');
      assert.ok(
        result.includes('fresh content'),
        'stale content must be replaced with template content',
      );
      assert.ok(
        !result.includes('stale content'),
        'stale content must not remain',
      );
    } finally {
      cleanup(tmpDir);
    }
  });

  test('no-op if target file does not exist', () => {
    const tmpDir = fs.mkdtempSync(path.join(BASE_TMPDIR, 'tp-fill-'));
    try {
      const templatePath = path.join(tmpDir, 'template.md');
      fs.writeFileSync(templatePath, '<!-- S -->\ncontent\n<!-- /S -->\n');
      assert.doesNotThrow(() => {
        fillBetweenMarkers(
          path.join(tmpDir, 'missing.md'),
          templatePath,
          '<!-- S -->',
          '<!-- /S -->',
        );
      });
    } finally {
      cleanup(tmpDir);
    }
  });

  test('no-op if markers are absent from target file', () => {
    const tmpDir = fs.mkdtempSync(path.join(BASE_TMPDIR, 'tp-fill-'));
    try {
      const targetPath = path.join(tmpDir, 'target.md');
      const templatePath = path.join(tmpDir, 'template.md');
      const original = 'no markers here\n';
      fs.writeFileSync(targetPath, original);
      fs.writeFileSync(templatePath, '<!-- S -->\ncontent\n<!-- /S -->\n');
      fillBetweenMarkers(targetPath, templatePath, '<!-- S -->', '<!-- /S -->');
      assert.equal(
        fs.readFileSync(targetPath, 'utf8'),
        original,
        'file must be unchanged when markers absent',
      );
    } finally {
      cleanup(tmpDir);
    }
  });

  test('falls back to full template when template has no markers', () => {
    const tmpDir = fs.mkdtempSync(path.join(BASE_TMPDIR, 'tp-fill-'));
    try {
      const targetPath = path.join(tmpDir, 'target.md');
      const templatePath = path.join(tmpDir, 'template.md');
      fs.writeFileSync(targetPath, '<!-- S -->\n<!-- /S -->\n');
      fs.writeFileSync(templatePath, 'bare template content\n');
      fillBetweenMarkers(targetPath, templatePath, '<!-- S -->', '<!-- /S -->');
      const result = fs.readFileSync(targetPath, 'utf8');
      assert.ok(
        result.includes('bare template content'),
        'bare template content must be injected as fallback',
      );
    } finally {
      cleanup(tmpDir);
    }
  });
});

// --- Idempotency ---

describe('processTemplate - idempotency', () => {
  test('applying processTemplate twice yields same result as once', () => {
    const input =
      '<!-- ONLY:claude -->{{PROJECT_RULES_FILE}}<!-- /ONLY:claude -->|<!-- ONLY:copilot -->{{PROJECT_RULES_FILE}}<!-- /ONLY:copilot -->';
    const ctx = { runtime: 'claude' };
    const once = processTemplate(input, ctx);
    const twice = processTemplate(once, ctx);
    assert.equal(twice, once);
  });
});

// --- Input validation ---

describe('processTemplate - input validation (F-005)', () => {
  test('F-005: processTemplate throws descriptive error when context is null', () => {
    assert.throws(
      () => processTemplate('hello {{NAME}}', null),
      (err) => {
        assert.ok(err instanceof Error, 'should throw an Error');
        assert.ok(
          err.message.includes('context') && err.message.includes('non-null'),
          `Expected descriptive error about context being non-null, got: ${err.message}`,
        );
        return true;
      },
    );
  });

  test('F-005: processTemplate throws descriptive error when context is undefined', () => {
    assert.throws(
      () => processTemplate('hello {{NAME}}', undefined),
      (err) => {
        assert.ok(err instanceof Error, 'should throw an Error');
        assert.ok(
          err.message.includes('context'),
          `Expected error mentioning context, got: ${err.message}`,
        );
        return true;
      },
    );
  });
});

// --- injectAppendToFile (60-11 residuals) ---
describe('injectAppendToFile', () => {
  const {
    injectAppendToFile,
  } = require('../gsd-ng/bin/lib/template-processor.cjs');

  function setupTmp() {
    const dir = fs.mkdtempSync(path.join(BASE_TMPDIR, 'tp-inject-'));
    return dir;
  }

  test('creates file when target does not exist', () => {
    const dir = setupTmp();
    try {
      const target = path.join(dir, 'OUTPUT.md');
      const tpl = path.join(dir, 'block.tpl');
      fs.writeFileSync(tpl, '## Block\nbody', 'utf8');
      injectAppendToFile(target, tpl, '## Block');
      assert.ok(fs.existsSync(target));
      const content = fs.readFileSync(target, 'utf8');
      // Created with trimStart on block (no leading newline) but trailing newline
      assert.ok(content.startsWith('## Block'));
      assert.ok(content.includes('body'));
    } finally {
      cleanup(dir);
    }
  });

  test('appends to existing file when marker is absent', () => {
    const dir = setupTmp();
    try {
      const target = path.join(dir, 'OUTPUT.md');
      const tpl = path.join(dir, 'block.tpl');
      fs.writeFileSync(target, '# Existing content\n', 'utf8');
      fs.writeFileSync(tpl, '## New Block\nadded', 'utf8');
      injectAppendToFile(target, tpl, '## New Block');
      const content = fs.readFileSync(target, 'utf8');
      assert.ok(content.startsWith('# Existing content'));
      assert.ok(content.includes('## New Block'));
      assert.ok(content.includes('added'));
    } finally {
      cleanup(dir);
    }
  });

  test('idempotent: skips when marker already present', () => {
    const dir = setupTmp();
    try {
      const target = path.join(dir, 'OUTPUT.md');
      const tpl = path.join(dir, 'block.tpl');
      fs.writeFileSync(target, '# Existing\n## Marker\nfirst run\n', 'utf8');
      fs.writeFileSync(tpl, '## Marker\nsecond run', 'utf8');
      const beforeMtime = fs.statSync(target).mtime.getTime();
      injectAppendToFile(target, tpl, '## Marker');
      // Content unchanged — marker was already present
      const content = fs.readFileSync(target, 'utf8');
      assert.ok(content.includes('first run'));
      assert.ok(!content.includes('second run'));
    } finally {
      cleanup(dir);
    }
  });

  test('silently skips when template path does not exist', () => {
    const dir = setupTmp();
    try {
      const target = path.join(dir, 'OUTPUT.md');
      const missingTpl = path.join(dir, 'does-not-exist.tpl');
      // No-op: target should remain absent (no template to read)
      injectAppendToFile(target, missingTpl, '## Marker');
      assert.strictEqual(fs.existsSync(target), false);
    } finally {
      cleanup(dir);
    }
  });

  test('silently skips when template missing but target exists', () => {
    const dir = setupTmp();
    try {
      const target = path.join(dir, 'OUTPUT.md');
      const missingTpl = path.join(dir, 'gone.tpl');
      fs.writeFileSync(target, '# Existing\n', 'utf8');
      injectAppendToFile(target, missingTpl, '## Never');
      // File content unchanged
      const content = fs.readFileSync(target, 'utf8');
      assert.strictEqual(content, '# Existing\n');
    } finally {
      cleanup(dir);
    }
  });

  test('trims template content (strips trailing newline before wrapping)', () => {
    const dir = setupTmp();
    try {
      const target = path.join(dir, 'OUTPUT.md');
      const tpl = path.join(dir, 'block.tpl');
      // Template has lots of trailing whitespace
      fs.writeFileSync(tpl, '## Hi\nbody\n\n\n   \n', 'utf8');
      injectAppendToFile(target, tpl, '## Hi');
      const content = fs.readFileSync(target, 'utf8');
      // Created from trimStart: no leading \n, trailing \n appended
      assert.match(content, /^## Hi\nbody\n$/);
    } finally {
      cleanup(dir);
    }
  });
});
