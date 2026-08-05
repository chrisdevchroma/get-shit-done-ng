'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Every runtime-shaped fact GSD knows, one row per runtime.
 *
 * Uppercase keys are template variables: `processTemplate` resolves `{{KEY}}`
 * against the active row, so adding a key makes it substitutable everywhere with
 * no engine change.
 *
 * Lowercase keys are specs the installer reads instead of comparing runtime
 * names:
 *   - `configHome` — where the runtime keeps its config, global and local.
 *   - `layout` — what an install writes and an uninstall removes.
 *   - `TOOL_MAP` — Claude tool names translated to the runtime's own ids, or
 *     `null` for the identity map. Names absent from a map have no equivalent
 *     and are dropped by the consumer.
 *   - `COLOR_MAP` — colour words the source uses translated to the values the
 *     runtime's own schema accepts, where it constrains them.
 */
const RUNTIMES = {
  claude: {
    PROJECT_RULES_FILE: 'CLAUDE.md',
    USER_QUESTION_TOOL: 'AskUserQuestion',
    COMMAND_PREFIX: '/gsd:',
    GSD_BLOCK_OPEN: '## GSD',
    GSD_BLOCK_CLOSE: '## ',
    MEMORY_DIR: '.claude/memory/',
    // The project-local config directory name, for content that names a
    // project-relative path. It duplicates `configHome.localDirName` because
    // substitution reads uppercase keys straight off the row while the
    // installer reads the lowercase spec; a test pins the two together so they
    // cannot drift.
    CONFIG_DIR: '.claude',
    RUNTIME_LABEL: 'Claude Code',
    PROJECT_DIR_ENV: 'CLAUDE_PROJECT_DIR',

    configHome: {
      envVar: 'CLAUDE_CONFIG_DIR',
      xdg: null,
      globalDirName: '.claude',
      localDirName: '.claude',
      configDirLiteral: { global: "'.claude'", local: "'.claude'" },
    },

    layout: {
      engine: { dir: 'gsd-ng' },
      commands: {
        dir: 'commands/gsd',
        pattern: '<name>.md',
        converter: 'identity',
        skip: [],
        ownsDir: true,
      },
      agents: {
        dir: 'agents',
        pattern: 'gsd-<name>.md',
        converter: 'identity',
        skip: [],
        ownsDir: false,
      },
      plugin: null,
      hooks: {
        dir: 'hooks',
        from: 'hooks',
        files: [
          'bash-safety-hook.cjs',
          'gsd-check-update.js',
          'gsd-context-monitor.js',
          'gsd-guardrail.js',
          'gsd-hook-stdin.cjs',
          'gsd-sandbox-detect.js',
          'gsd-statusline.js',
        ],
        rewriteConfigDirLiteral: true,
        localOnly: false,
      },
      hooksPayload: null,
      writeCommonJsMarker: true,
      settings: true,
      // Every directory this runtime ships unconverted content into. The
      // `identity` converter copies a file verbatim, so anything it writes needs
      // the post-pass; a directory left off the list ships its placeholders raw.
      // Converted destinations (copilot's and opencode's commands and agents)
      // are deliberately absent from their lists — `convertContent` already runs
      // processTemplate on them, and a second pass would re-validate ONLY
      // markers the first pass has already stripped.
      templatePassDirs: [
        'gsd-ng/workflows',
        'gsd-ng/references',
        'gsd-ng/bin/lib',
        'gsd-ng/templates',
        'commands/gsd',
        'agents',
      ],
      rulesFile: null,
      configSeed: null,
    },

    TOOL_MAP: null,
  },

  copilot: {
    PROJECT_RULES_FILE: '.github/copilot-instructions.md',
    // Sourced from the installer's Claude→Copilot tool map, not from Copilot CLI
    // documentation. A documented name should override this.
    USER_QUESTION_TOOL: 'ask_user',
    COMMAND_PREFIX: '/gsd-',
    GSD_BLOCK_OPEN: '<!-- GSD Configuration -->',
    GSD_BLOCK_CLOSE: '<!-- /GSD Configuration -->',
    MEMORY_DIR: '.github/memory/',
    CONFIG_DIR: '.github',
    RUNTIME_LABEL: 'Copilot CLI',
    PROJECT_DIR_ENV: 'CLAUDE_PROJECT_DIR',

    configHome: {
      envVar: 'COPILOT_CONFIG_DIR',
      xdg: null,
      globalDirName: '.copilot',
      localDirName: '.github',
      configDirLiteral: { global: "'.copilot'", local: "'.github'" },
    },

    layout: {
      engine: { dir: 'gsd-ng' },
      commands: {
        dir: 'skills',
        pattern: 'gsd-<name>/SKILL.md',
        converter: 'copilotCommand',
        // Configures effort: frontmatter, which is a Claude-only feature.
        skip: ['set-profile.md'],
        ownsDir: false,
      },
      agents: {
        dir: 'agents',
        pattern: 'gsd-<name>.agent.md',
        converter: 'copilotAgent',
        skip: [],
        ownsDir: false,
      },
      plugin: null,
      // A descriptor GSD generates rather than a copy of a shipped file. Global
      // hooks are unsupported by the Copilot CLI, so this is local-install only.
      hooks: {
        dir: 'hooks',
        from: null,
        files: ['gsd-hooks.json'],
        rewriteConfigDirLiteral: false,
        localOnly: true,
      },
      // What the descriptor above spawns. Without it the named path resolves to
      // nothing and the update check never runs — which is what copilot did
      // from the day the descriptor was written. Local-only, like the
      // descriptor: a global install writes neither.
      hooksPayload: {
        dir: 'gsd-ng/hooks',
        from: 'hooks',
        files: ['gsd-check-update.js', 'gsd-hook-stdin.cjs'],
        localOnly: true,
      },
      writeCommonJsMarker: false,
      settings: false,
      // Empty until now, which is why every registry placeholder in a copilot
      // install's engine tree shipped unresolved. `skills` and `agents` stay off
      // the list: their converter already resolved them.
      templatePassDirs: [
        'gsd-ng/workflows',
        'gsd-ng/references',
        'gsd-ng/bin/lib',
        'gsd-ng/templates',
      ],
      rulesFile: {
        base: 'targetDir',
        name: 'copilot-instructions.md',
        template: 'project-rules-block.md',
      },
      configSeed: null,
    },

    TOOL_MAP: {
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
    },
  },

  opencode: {
    PROJECT_RULES_FILE: 'AGENTS.md',
    USER_QUESTION_TOOL: 'question',
    COMMAND_PREFIX: '/gsd-',
    GSD_BLOCK_OPEN: '<!-- GSD Configuration -->',
    GSD_BLOCK_CLOSE: '<!-- /GSD Configuration -->',
    MEMORY_DIR: '.opencode/memory/',
    CONFIG_DIR: '.opencode',
    RUNTIME_LABEL: 'OpenCode',
    // OpenCode sets no project-directory variable of its own. The existing
    // ${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel)} fallback resolves
    // correctly when the variable is unset, so this stays a cosmetic leak rather
    // than an invented variable nothing exports.
    PROJECT_DIR_ENV: 'CLAUDE_PROJECT_DIR',

    configHome: {
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

    layout: {
      engine: { dir: 'gsd-ng' },
      commands: {
        dir: 'command',
        pattern: 'gsd-<name>.md',
        converter: 'opencodeCommand',
        // Configures effort: frontmatter and model profiles, both Claude-only.
        skip: ['set-profile.md'],
        ownsDir: false,
      },
      agents: {
        dir: 'agent',
        pattern: 'gsd-<name>.md',
        converter: 'opencodeAgent',
        skip: [],
        ownsDir: false,
      },
      plugin: {
        dir: 'plugin',
        files: [{ from: 'hooks/gsd-opencode-plugin.js', to: 'gsd-core.js' }],
      },
      hooks: null,
      // The plugin spawns these, so the payload has to land in the engine tree.
      // Copilot's descriptor points at an equivalent path that nothing copies.
      hooksPayload: {
        dir: 'gsd-ng/hooks',
        from: 'hooks',
        files: [
          'bash-safety-hook.cjs',
          'gsd-hook-stdin.cjs',
          'gsd-check-update.js',
        ],
      },
      // OpenCode's plugin glob matches *.{ts,js} and loads via import(). A .js
      // file under a package.json declaring {"type":"commonjs"} is parsed as
      // CommonJS, where `export const` is a syntax error.
      writeCommonJsMarker: false,
      settings: false,
      // `command` and `agent` stay off the list: their converter already
      // resolved them.
      templatePassDirs: [
        'gsd-ng/workflows',
        'gsd-ng/references',
        'gsd-ng/bin/lib',
        'gsd-ng/templates',
      ],
      // OpenCode reads project rules from the project root, not from its config
      // home — unlike claude and copilot, whose rules file sits in targetDir.
      // A `cwd` base only means something when the working directory is a
      // project, which a global install cannot assume: it would write into
      // whatever directory it was invoked from, and an uninstall run elsewhere
      // would never come back for it. So local-only, same flag the hook specs
      // above use.
      rulesFile: {
        base: 'cwd',
        name: 'AGENTS.md',
        template: 'project-rules-block.md',
        localOnly: true,
      },
      configSeed: {
        file: 'opencode.json',
        contents: { $schema: 'https://opencode.ai/config.json' },
      },
    },

    TOOL_MAP: {
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
    },

    // OpenCode's agent schema accepts #RRGGBB or one of seven theme literals,
    // so the bare colour words the source agents carry have to be translated.
    // A word absent from this map has no theme equivalent; the consumer falls
    // back to a valid literal rather than emitting a value the schema rejects.
    COLOR_MAP: {
      cyan: 'info',
      green: 'success',
      purple: 'accent',
      blue: 'primary',
      orange: 'warning',
      yellow: 'secondary',
    },
  },
};

/**
 * Derive the predicate that removes what a layout write pattern created.
 *
 * The pattern is the single source: `gsd-<name>.md` gives prefix `gsd-` and
 * suffix `.md`; `gsd-<name>/SKILL.md` gives a directory entry with prefix
 * `gsd-`. Writing the remover out a second time is how the two halves drift.
 *
 * @param {string} pattern - Layout write pattern containing `<name>`
 * @returns {{prefix: string, suffix: string, entryType: 'file'|'dir'}}
 */
function patternToRemoval(pattern) {
  if (typeof pattern !== 'string' || !pattern.includes('<name>')) {
    throw new Error(
      'patternToRemoval: pattern must contain a <name> placeholder, got: ' +
        pattern,
    );
  }
  const firstSegment = pattern.split('/')[0];
  const entryType = firstSegment === pattern ? 'file' : 'dir';
  const [prefix, suffix] = firstSegment.split('<name>');
  return { prefix, suffix, entryType };
}

/**
 * Process a template string by resolving conditional blocks and substituting variables.
 *
 * 1. Validates balanced ONLY markers
 * 2. Resolves <!-- ONLY:runtime --> conditional blocks (keep matching, strip non-matching)
 * 3. Substitutes {{VAR}} using a replacer function (avoids $ backreference bugs)
 *
 * @param {string} content - Template content
 * @param {object} context - Must include `runtime` key; additional keys used as variables
 * @returns {string} Processed content
 */
function processTemplate(content, context) {
  if (!context || typeof context !== 'object') {
    throw new Error('processTemplate: context must be a non-null object');
  }
  let out = content;

  // 1. Validate markers (balanced open/close)
  validateMarkers(out);

  // 2. Resolve conditional blocks
  for (const rt of Object.keys(RUNTIMES)) {
    const regex = new RegExp(
      '<!-- ONLY:' + rt + ' -->([\\s\\S]*?)<!-- /ONLY:' + rt + ' -->',
      'g',
    );
    if (rt === context.runtime) {
      out = out.replace(regex, (_, inner) => inner);
    } else {
      out = out.replace(regex, () => '');
    }
  }

  // 3. Substitute {{VAR}} using replacer function (avoids $ backreference bugs)
  out = out.replace(/\{\{(\w+)\}\}/g, (match, key) => {
    const runtimeVars = RUNTIMES[context.runtime] || {};
    if (key in runtimeVars) return runtimeVars[key];
    if (key in context) return String(context[key]);
    return match; // leave unresolved as-is
  });

  return out;
}

/**
 * Validate that all <!-- ONLY:X --> markers are balanced (each open has a matching close).
 *
 * @param {string} content - Content to validate
 * @throws {Error} If markers are unbalanced
 */
function validateMarkers(content) {
  const openPattern = /<!-- ONLY:(\w+) -->/g;
  const closePattern = /<!-- \/ONLY:(\w+) -->/g;
  const opens = {};
  const closes = {};
  let m;
  while ((m = openPattern.exec(content)) !== null) {
    opens[m[1]] = (opens[m[1]] || 0) + 1;
  }
  while ((m = closePattern.exec(content)) !== null) {
    closes[m[1]] = (closes[m[1]] || 0) + 1;
  }
  const allKeys = new Set(Object.keys(opens).concat(Object.keys(closes)));
  for (const key of allKeys) {
    if ((opens[key] || 0) !== (closes[key] || 0)) {
      throw new Error(
        'Unbalanced ONLY:' +
          key +
          ' markers: ' +
          (opens[key] || 0) +
          ' opens, ' +
          (closes[key] || 0) +
          ' closes',
      );
    }
  }
}

/**
 * Build a context object for template processing.
 *
 * @param {string} runtime - Runtime name (e.g. 'claude', 'copilot')
 * @param {object} [options] - Additional key-value pairs to merge
 * @returns {object} Context with runtime and any extra options
 */
function buildContext(runtime, options) {
  return { runtime, ...(options || {}) };
}

/**
 * Append a template block to a file. Creates the file if it doesn't exist.
 * Idempotent: skips if the marker string is already present in the file.
 *
 * @param {string} filePath - Absolute path to target file
 * @param {string} templatePath - Absolute path to template file
 * @param {string} marker - String to check for idempotency
 */
function injectAppendToFile(filePath, templatePath, marker) {
  if (fs.existsSync(filePath)) {
    const existing = fs.readFileSync(filePath, 'utf8');
    if (existing.includes(marker)) {
      return; // Already injected
    }
  }
  if (!fs.existsSync(templatePath)) {
    return; // Template missing — skip silently
  }
  const blockContent = fs.readFileSync(templatePath, 'utf8').trim();
  const block = '\n' + blockContent + '\n';
  if (fs.existsSync(filePath)) {
    fs.appendFileSync(filePath, block, 'utf8');
  } else {
    fs.writeFileSync(filePath, block.trimStart(), 'utf8');
  }
}

/**
 * Fill content between a pair of markers in a file, using the inner content
 * extracted from between the same markers in a template file.
 * Idempotent: always overwrites to stay in sync with the template.
 * No-op if the file does not exist or either marker is missing.
 *
 * @param {string} filePath - Absolute path to the target file containing the markers
 * @param {string} templatePath - Absolute path to the template file
 * @param {string} startMarker - Opening marker string
 * @param {string} endMarker - Closing marker string
 */
function fillBetweenMarkers(filePath, templatePath, startMarker, endMarker) {
  if (!fs.existsSync(filePath)) return;
  const existing = fs.readFileSync(filePath, 'utf8');
  const startIdx = existing.indexOf(startMarker);
  const endIdx = existing.indexOf(endMarker);
  if (startIdx === -1 || endIdx === -1) return;

  const template = fs.readFileSync(templatePath, 'utf8');
  const tStart = template.indexOf(startMarker);
  const tEnd = template.indexOf(endMarker);
  const innerContent =
    tStart !== -1 && tEnd !== -1
      ? template.slice(tStart + startMarker.length, tEnd)
      : '\n' + template.trim() + '\n';

  const before = existing.slice(0, startIdx + startMarker.length);
  const after = existing.slice(endIdx);
  fs.writeFileSync(filePath, before + innerContent + after, 'utf8');
}

module.exports = {
  processTemplate,
  validateMarkers,
  buildContext,
  RUNTIMES,
  patternToRemoval,
  injectAppendToFile,
  fillBetweenMarkers,
};
