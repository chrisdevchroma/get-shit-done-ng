#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const os = require('os');
const readline = require('readline');
const crypto = require('crypto');
const { execSync } = require('child_process');

// Colors
const cyan = '\x1b[36m';
const green = '\x1b[32m';
const yellow = '\x1b[33m';
const dim = '\x1b[2m';
const reset = '\x1b[0m';

// Get version from package.json
const pkg = require('../package.json');
const { processTemplate, buildContext, injectAppendToFile, fillBetweenMarkers } = require('../gsd-ng/bin/lib/template-processor.cjs');
const { getPlatformCliPatterns, PLATFORM_TO_CLI, getReadEditWriteAllowRules, RW_FORMS, normalizePermissionRules } = require(path.join(__dirname, '..', 'gsd-ng', 'bin', 'lib', 'allowlist.cjs'));
const { syncAgentEffortFrontmatter, formatRestartNotice } = require(path.join(__dirname, '..', 'gsd-ng', 'bin', 'lib', 'effort-sync.cjs'));
const { extractFrontmatter, spliceFrontmatter } = require(path.join(__dirname, '..', 'gsd-ng', 'bin', 'lib', 'frontmatter.cjs'));

// Parse args
const args = process.argv.slice(2);
const hasGlobal = args.includes('--global') || args.includes('-g');
const hasLocal = args.includes('--local') || args.includes('-l');
const hasUninstall = args.includes('--uninstall') || args.includes('-u');
const noSeedPermissionsConfig = args.includes('--no-seed-permissions-config');
let noSeedSandboxConfig = args.includes('--no-seed-sandbox-config');
const hasSnapshot = args.includes('--snapshot');
const hasClean = args.includes('--clean');
const runtimeArgIdx = args.findIndex(a => a === '--runtime');
const runtimeArgVal = runtimeArgIdx !== -1 ? args[runtimeArgIdx + 1] : null;
// Runtime is ONLY set via --runtime flag. No implicit default.
// For non-interactive: --runtime is required (validated below).
// For interactive: promptRuntime() sets this before install.
let runtime = runtimeArgVal || null;  // null means "not specified yet"

// Validate --runtime value if provided
if (runtimeArgVal && !['claude', 'copilot'].includes(runtimeArgVal)) {
  console.error(`  ${yellow}Error: Unknown runtime '${runtimeArgVal}'. Use --runtime claude or --runtime copilot${reset}`);
  process.exit(1);
}

const REQUIRED_HOOKS = [
  'gsd-check-update.js',
  'gsd-context-monitor.js',
  'gsd-guardrail.js',
  'gsd-sandbox-detect.js',
  'gsd-statusline.js',
  'bash-safety-hook.cjs',
];

// Hook filenames GSD shipped under an earlier name and no longer ships.
//
// Removal candidates are normally derived from the manifest's `installed_hooks`
// plus what the running package ships. Names retired *before* the manifest
// recorded hooks match neither source and would persist forever, so they need an
// explicit entry here; a hook retired from here on is covered automatically.
//
// INVARIANT: this list must not be emptied. The --clean wipe tests assert a
// retired hook file is gone from the target, and it only disappears because it
// is named here.
const RETIRED_GSD_HOOKS = ['gsd-check-update.sh'];

/**
 * Hook filenames the running package installs for a runtime.
 * The Claude runtime copies every file in the package's hooks/ dir; Copilot
 * takes nothing from it and writes a single hook descriptor instead.
 */
function shippedHookNames(rt) {
  if (rt !== 'claude') return ['gsd-hooks.json'];
  const hooksSrc = path.join(__dirname, '..', 'hooks');
  if (!fs.existsSync(hooksSrc)) return [];
  return fs
    .readdirSync(hooksSrc, { withFileTypes: true })
    .filter(e => e.isFile())
    .map(e => e.name);
}

/**
 * Convert a pathPrefix (which uses absolute paths for global installs) to a
 * $HOME-relative form for replacing $HOME/.claude/ references in bash code blocks.
 * Preserves $HOME as a shell variable so paths remain portable across machines.
 *
 * For local installs (pathPrefix is a relative path like "./.claude/"), returns
 * a shell expression with fallback chain: $CLAUDE_PROJECT_DIR (hook contexts),
 * git rev-parse --show-toplevel (subdirectories), pwd (fallback).
 */
function toHomePrefix(pathPrefix) {
  const home = os.homedir().replace(/\\/g, '/');
  const normalized = pathPrefix.replace(/\\/g, '/');
  if (normalized.startsWith(home)) {
    return '$HOME' + normalized.slice(home.length);
  }
  // Convert tilde-based paths to $HOME-based paths for bash code blocks
  if (normalized.startsWith('~/')) {
    return '$HOME' + normalized.slice(1);
  }
  // For local installs (relative paths), use a fallback chain so that bash
  // code blocks work in both hook contexts (where CLAUDE_PROJECT_DIR is set)
  // and Bash tool invocations (where it is unset).
  // pathPrefix is like "./.claude/" — extract the dir name and build the correct path.
  // e.g., "./.claude/" → "${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}/.claude/"
  const dirMatch = normalized.match(/^\.\/(\.[^/]+\/)/);
  if (dirMatch) {
    return '${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}/' + dirMatch[1];
  }
  return normalized;
}

/**
 * Map a runtime identifier to a human-readable label for console output.
 * Centralizes the mapping so future runtimes can be added in one place.
 */
function getRuntimeLabel(runtime) {
  if (runtime === 'claude') return 'Claude Code';
  if (runtime === 'copilot') return 'Copilot CLI';
  return runtime || 'your runtime';
}

// Helper to get directory name based on runtime
function getDirName(rt) {
  if (rt === 'copilot') return '.github';
  return '.claude';
}

/**
 * Get the config directory path relative to home directory
 * Used for templating hooks that use path.join(homeDir, '<configDir>', ...)
 * @param {string} rt - Runtime ('claude' or 'copilot')
 * @param {boolean} isGlobal - Whether this is a global install
 */
function getConfigDirFromHome(rt, isGlobal) {
  if (rt === 'copilot') {
    return isGlobal ? "'.copilot'" : "'.github'";
  }
  if (!isGlobal) {
    return `'${getDirName(rt)}'`;
  }
  return "'.claude'";
}

/**
 * Get the global config directory
 * @param {string} rt - Runtime ('claude' or 'copilot')
 */
function getGlobalDir(rt) {
  if (rt === 'copilot') {
    if (process.env.COPILOT_CONFIG_DIR) return expandTilde(process.env.COPILOT_CONFIG_DIR);
    return path.join(os.homedir(), '.copilot');
  }
  // Claude Code: CLAUDE_CONFIG_DIR > ~/.claude
  if (process.env.CLAUDE_CONFIG_DIR) {
    return expandTilde(process.env.CLAUDE_CONFIG_DIR);
  }
  return path.join(os.homedir(), '.claude');
}

function buildBanner(version) {
  return '\n' +
  cyan + '   ██████╗ ███████╗██████╗\n' +
  '  ██╔════╝ ██╔════╝██╔══██╗\n' +
  '  ██║  ███╗███████╗██║  ██║\n' +
  '  ██║   ██║╚════██║██║  ██║\n' +
  '  ╚██████╔╝███████║██████╔╝\n' +
  '   ╚═════╝ ╚══════╝╚═════╝\n' +
  dim + '        ███╗   ██╗ ██████╗\n' +
  '        ████╗  ██║██╔════╝\n' +
  '        ██╔██╗ ██║██║  ███╗\n' +
  '        ██║╚██╗██║██║   ██║\n' +
  '        ██║ ╚████║╚██████╔╝\n' +
  '        ╚═╝  ╚═══╝ ╚═════╝' + reset + '\n' +
  '\n' +
  '  gsd-ng ' + dim + 'v' + version + reset + '\n' +
  '  A meta-prompting, context engineering and spec-driven\n' +
  '  development system for Claude Code.\n';
}

const hasHelp = args.includes('--help') || args.includes('-h');
const forceStatusline = args.includes('--force-statusline');

/**
 * Resolve the installed version string, appending +<hash> build metadata
 * when installing from a git checkout that isn't an exact release tag.
 *
 * Auto-snapshot triggers when:
 *   - Running from a git working tree (not an npm tarball install)
 *   - HEAD does not point to a tag matching `v<pkg.version>`
 *
 * --snapshot flag forces the +hash suffix regardless of branch/tag state.
 *
 * @param {string} baseVersion - Clean semver from package.json (e.g., '1.0.0-dev.3')
 * @returns {string} baseVersion, or baseVersion+<hash> for snapshot installs
 */
function resolveInstalledVersion(baseVersion) {
  const src = path.join(__dirname, '..');

  // Not a git repo (e.g., installed via npm tarball) — use clean version
  if (!fs.existsSync(path.join(src, '.git'))) return baseVersion;

  try {
    const hash = execSync('git rev-parse --short HEAD', {
      cwd: src, stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000
    }).toString().trim();

    if (!hash) return baseVersion;

    // --snapshot always appends hash
    if (hasSnapshot) return `${baseVersion}+${hash}`;

    // Auto-snapshot: check if HEAD is exactly the release tag for this version
    const exactTag = execSync(`git tag --points-at HEAD`, {
      cwd: src, stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000
    }).toString().trim();

    const releaseTags = exactTag.split('\n').filter(t => t.trim());
    const isTagged = releaseTags.some(t => t.trim() === `v${baseVersion}`);

    // If HEAD is the exact release tag, use clean version (this IS the release)
    if (isTagged) return baseVersion;

    // Otherwise, this is a dev checkout — append hash
    return `${baseVersion}+${hash}`;
  } catch {
    return baseVersion;
  }
}

// Single source of truth for the installed version string — used by banner,
// VERSION file writes (both runtimes), and the file manifest. Computed once
// to avoid repeated git probes and guarantee consistency across all surfaces.
const INSTALLED_VERSION = resolveInstalledVersion(pkg.version);

if (require.main === module) {
  console.log(buildBanner(INSTALLED_VERSION));

  if (hasUninstall) {
    console.log(`  ${yellow}Mode: Uninstall${reset}\n`);
  }

  // Show help if requested
  if (hasHelp) {
    console.log(`  ${yellow}Usage:${reset} npx gsd-ng [options]\n\n  ${yellow}Options:${reset}\n    ${cyan}-g, --global${reset}                       Install globally (to ~/.claude)\n    ${cyan}-l, --local${reset}                        Install locally (to current directory)\n    ${cyan}-u, --uninstall${reset}                    Uninstall GSD (requires --global or --local)\n    ${cyan}-h, --help${reset}                         Show this help message\n    ${cyan}--force-statusline${reset}                 Replace existing statusline config\n    ${cyan}--snapshot${reset}                         Force +hash build metadata in VERSION (auto-detected on non-tag commits)\n    ${cyan}--no-seed-permissions-config${reset}       Skip permissions.allow seeding\n    ${cyan}--no-seed-sandbox-config${reset}           Skip sandbox.enabled seeding (permissions still seeded)\n    ${cyan}--clean${reset}                            Wipe the GSD-managed tree before install (debugging / fresh-state reset)\n    ${cyan}--runtime <runtime>${reset}                Select runtime: claude or copilot (REQUIRED for non-interactive)\n\n  ${yellow}Examples:${reset}\n    ${dim}# Interactive install (prompts for runtime and location)${reset}\n    npx gsd-ng\n\n    ${dim}# Install Claude runtime globally${reset}\n    npx gsd-ng --runtime claude --global\n\n    ${dim}# Install Claude runtime to current project only${reset}\n    npx gsd-ng --runtime claude --local\n\n    ${dim}# Install for GitHub Copilot CLI (local)${reset}\n    npx gsd-ng --runtime copilot --local\n\n    ${dim}# Install for GitHub Copilot CLI (global)${reset}\n    npx gsd-ng --runtime copilot --global\n\n    ${dim}# Uninstall GSD globally${reset}\n    npx gsd-ng --runtime claude --global --uninstall\n\n    ${dim}# Uninstall Copilot CLI runtime globally${reset}\n    npx gsd-ng --runtime copilot --global --uninstall\n\n  ${yellow}Notes:${reset}\n    Sandbox mode is enabled by default. Use --no-seed-sandbox-config to skip it.\n`);
    process.exit(0);
  }
}

/**
 * Expand ~ to home directory (shell doesn't expand in env vars passed to node)
 */
function expandTilde(filePath) {
  if (filePath && filePath.startsWith('~/')) {
    return path.join(os.homedir(), filePath.slice(2));
  }
  return filePath;
}

/**
 * Build a hook command path using forward slashes.
 */
function buildHookCommand(configDir, hookName) {
  // Use forward slashes for Node.js compatibility on all platforms
  const hooksPath = configDir.replace(/\\/g, '/') + '/hooks/' + hookName;
  return `node "${hooksPath}"`;
}

/**
 * Remove line and block comments, then trailing commas, both string-aware.
 * Claude Code accepts JSONC in settings.json, so a hand-written file that
 * JSON.parse rejects is usually still meaningful rather than damaged.
 */
function stripJsonc(text) {
  let out = '';
  let inString = false, escaped = false, inLine = false, inBlock = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i], n = text[i + 1];
    if (inLine) {
      if (c === '\n') { inLine = false; out += c; }
      continue;
    }
    if (inBlock) {
      if (c === '*' && n === '/') { inBlock = false; i++; }
      continue;
    }
    if (inString) {
      out += c;
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') { inString = true; out += c; continue; }
    if (c === '/' && n === '/') { inLine = true; i++; continue; }
    if (c === '/' && n === '*') { inBlock = true; i++; continue; }
    if (c === ',') {
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j])) j++;
      if (text[j] === '}' || text[j] === ']') continue;
    }
    out += c;
  }
  return out;
}

// Paths whose on-disk text only parsed after JSONC stripping. Writing them back
// as strict JSON discards the user's comments, so writeSettings preserves the
// original alongside first.
const jsoncSettingsPaths = new Set();

/**
 * Drop GSD's own hooks from one hook event in settings.
 *
 * A single entry's `hooks` array can hold GSD's hook and the user's own side by
 * side — same matcher, one entry. So the GSD commands are filtered out of that
 * inner array and the entry is discarded only once nothing is left in it.
 *
 * @param {(command: string) => boolean} isGsdCommand
 * @returns {boolean} whether anything was removed
 */
function pruneGsdHookEntries(settings, eventName, isGsdCommand) {
  if (!settings.hooks || !Array.isArray(settings.hooks[eventName])) return false;

  let removed = false;
  const kept = [];
  for (const entry of settings.hooks[eventName]) {
    if (!entry || !Array.isArray(entry.hooks)) {
      kept.push(entry);
      continue;
    }
    const hooks = entry.hooks.filter(h => !(h && typeof h.command === 'string' && isGsdCommand(h.command)));
    if (hooks.length !== entry.hooks.length) removed = true;
    if (hooks.length > 0) {
      kept.push(Object.assign({}, entry, { hooks }));
    }
  }

  settings.hooks[eventName] = kept;
  if (kept.length === 0) {
    delete settings.hooks[eventName];
  }
  return removed;
}

/**
 * Read and parse settings.json, returning empty object if it doesn't exist.
 *
 * A file that cannot be parsed at all is the user's content, not ours to
 * discard: returning {} here made the caller write a fresh file over it and
 * silently destroy every key in it. There is no safe way to merge into settings
 * we cannot read, so this refuses instead.
 */
function readSettings(settingsPath) {
  if (!fs.existsSync(settingsPath)) return {};
  const raw = fs.readFileSync(settingsPath, 'utf8');
  try {
    return JSON.parse(raw);
  } catch (strictError) {
    try {
      const parsed = JSON.parse(stripJsonc(raw));
      jsoncSettingsPaths.add(settingsPath);
      return parsed;
    } catch {
      console.error(`\n  ${yellow}Error: cannot parse ${settingsPath}${reset}`);
      console.error(`  ${dim}${strictError.message}${reset}`);
      console.error(`  Refusing to continue — overwriting it would destroy the settings it holds.`);
      console.error(`  Fix the syntax, or move the file aside, then run the installer again.\n`);
      process.exit(1);
    }
  }
}

/**
 * Write settings.json with proper formatting
 */
function writeSettings(settingsPath, settings) {
  if (jsoncSettingsPaths.has(settingsPath) && fs.existsSync(settingsPath)) {
    let backupPath = settingsPath + '.gsd-backup';
    let n = 2;
    while (fs.existsSync(backupPath)) {
      backupPath = settingsPath + '.gsd-backup-' + n++;
    }
    fs.copyFileSync(settingsPath, backupPath);
    jsoncSettingsPaths.delete(settingsPath);
    console.log(`  ${yellow}!${reset}  ${settingsPath} used JSONC syntax — rewritten as strict JSON, original backed up to ${path.basename(backupPath)}`);
  }
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
}

// Cache for attribution settings (populated once during install)
let attributionCached = undefined;
let attributionResolved = false;

/**
 * Get commit attribution setting
 * @returns {null|undefined|string} null = remove, undefined = keep default, string = custom
 */
function getCommitAttribution() {
  // Return cached value if available
  if (attributionResolved) {
    return attributionCached;
  }

  // Claude Code: read attribution from settings.json
  const settings = readSettings(path.join(getGlobalDir(runtime), 'settings.json'));
  let result;
  if (!settings.attribution || settings.attribution.commit === undefined) {
    result = undefined;
  } else if (settings.attribution.commit === '') {
    result = null;
  } else {
    result = settings.attribution.commit;
  }

  // Cache and return
  attributionCached = result;
  attributionResolved = true;
  return result;
}

/**
 * Process Co-Authored-By lines based on attribution setting
 * @param {string} content - File content to process
 * @param {null|undefined|string} attribution - null=remove, undefined=keep, string=replace
 * @returns {string} Processed content
 */
function processAttribution(content, attribution) {
  if (attribution === null) {
    // Remove Co-Authored-By lines and the preceding blank line
    return content.replace(/(\r?\n){2}Co-Authored-By:.*$/gim, '');
  }
  if (attribution === undefined) {
    return content;
  }
  // Replace with custom attribution (escape $ to prevent backreference injection)
  const safeAttribution = attribution.replace(/\$/g, '$$$$');
  return content.replace(/Co-Authored-By:.*$/gim, `Co-Authored-By: ${safeAttribution}`);
}

/**
 * Recursively copy directory, replacing paths in .md files
 * Deletes existing destDir first to remove orphaned files from previous versions
 * @param {string} srcDir - Source directory
 * @param {string} destDir - Destination directory
 * @param {string} pathPrefix - Path prefix for file references
 * @param {boolean} isCommand - Whether copying command files
 */
function copyWithPathReplacement(srcDir, destDir, pathPrefix, isCommand = false) {
  const dirName = getDirName(runtime);

  // Clean install: remove existing destination to prevent orphaned files
  if (fs.existsSync(destDir)) {
    fs.rmSync(destDir, { recursive: true });
  }
  fs.mkdirSync(destDir, { recursive: true });

  const entries = fs.readdirSync(srcDir, { withFileTypes: true });

  for (const entry of entries) {
    const srcPath = path.join(srcDir, entry.name);
    const destPath = path.join(destDir, entry.name);

    if (entry.isDirectory()) {
      copyWithPathReplacement(srcPath, destPath, pathPrefix, isCommand);
    } else if (entry.name.endsWith('.md')) {
      // Replace ~/.claude/ and $HOME/.claude/ and ./.claude/ with runtime-appropriate paths
      let content = fs.readFileSync(srcPath, 'utf8');
      const globalClaudeRegex = /~\/\.claude\//g;
      const globalClaudeHomeRegex = /\$HOME\/\.claude\//g;
      const localClaudeRegex = /\.\/\.claude\//g;
      content = content.replace(globalClaudeRegex, toHomePrefix(pathPrefix));
      content = content.replace(globalClaudeHomeRegex, toHomePrefix(pathPrefix));
      content = content.replace(localClaudeRegex, `./${dirName}/`);
      // NOTE: {{PROJECT_RULES_FILE}} is intentionally NOT resolved here.
      // Skills (seed-memories, new-project Step 9) detect the active runtime at
      // skill-execution time and resolve runtime-divergent paths themselves
      // (project rules file, memory directory) using the topology of the
      // workspace — so the same skill source files work for every runtime in
      // the RUNTIMES registry. Other template variables such as
      // {{PROJECT_RULES_FILE}} and {{MEMORY_DIR}} are resolved later by the
      // processTemplate loop using values from the active runtime's RUNTIMES
      // entry.
      content = processAttribution(content, getCommitAttribution());
      fs.writeFileSync(destPath, content);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

/**
 * Uninstall GSD from the specified directory
 * Removes only GSD-specific files/directories, preserves user content
 * @param {boolean} isGlobal - Whether to uninstall from global or local
 */
function uninstall(isGlobal) {
  const isClaudeCode = runtime === 'claude';
  const dirName = getDirName(runtime);

  // Get the target directory based on install type
  const targetDir = isGlobal
    ? getGlobalDir(runtime)
    : path.join(process.cwd(), dirName);

  const locationLabel = isGlobal
    ? targetDir.replace(os.homedir(), '~')
    : targetDir.replace(process.cwd(), '.');

  const runtimeLabel = getRuntimeLabel(runtime);
  console.log(`  Uninstalling GSD from ${cyan}${runtimeLabel}${reset} at ${cyan}${locationLabel}${reset}\n`);

  // Check if target directory exists
  if (!fs.existsSync(targetDir)) {
    console.log(`  ${yellow}⚠${reset} Directory does not exist: ${locationLabel}`);
    console.log(`  Nothing to uninstall.\n`);
    return;
  }

  let removedCount = 0;

  if (isClaudeCode) {
    // Count what exists before removal for accurate log output.
    const gsdCommandsDir = path.join(targetDir, 'commands', 'gsd');
    const gsdDir = path.join(targetDir, 'gsd-ng');
    const agentsDir = path.join(targetDir, 'agents');
    const hooksDir = path.join(targetDir, 'hooks');

    const hadCommands = fs.existsSync(gsdCommandsDir);
    const hadGsdDir = fs.existsSync(gsdDir);

    let agentCount = 0;
    if (fs.existsSync(agentsDir)) {
      agentCount = fs.readdirSync(agentsDir).filter(f => f.startsWith('gsd-') && f.endsWith('.md')).length;
    }

    // Counted before removal — the removal set is partly sourced from the
    // manifest, which removeGsdFiles deletes along with everything else.
    let hookCount = 0;
    if (fs.existsSync(hooksDir)) {
      hookCount = [...gsdOwnedHookNames(targetDir, runtime)]
        .filter(h => fs.existsSync(path.join(hooksDir, h))).length;
    }
    const hadManifest = fs.existsSync(path.join(targetDir, MANIFEST_NAME));

    // 1-4. Delegate all GSD file removal to shared helper.
    removeGsdFiles(targetDir, runtime);

    // Log results for steps 1-4.
    if (hadCommands) { removedCount++; console.log(`  ${green}✓${reset} Removed commands/gsd/`); }
    if (hadGsdDir) { removedCount++; console.log(`  ${green}✓${reset} Removed gsd-ng/`); }
    if (agentCount > 0) { removedCount++; console.log(`  ${green}✓${reset} Removed ${agentCount} GSD agents`); }
    if (hookCount > 0) { removedCount++; console.log(`  ${green}✓${reset} Removed ${hookCount} GSD hooks`); }
    if (hadManifest) { removedCount++; console.log(`  ${green}✓${reset} Removed ${MANIFEST_NAME}`); }

    // 5. Remove GSD package.json (CommonJS mode marker)
    const pkgJsonPath = path.join(targetDir, 'package.json');
    if (fs.existsSync(pkgJsonPath)) {
      try {
        const content = fs.readFileSync(pkgJsonPath, 'utf8').trim();
        // Only remove if it's our minimal CommonJS marker
        if (content === '{"type":"commonjs"}') {
          fs.unlinkSync(pkgJsonPath);
          removedCount++;
          console.log(`  ${green}✓${reset} Removed GSD package.json`);
        }
      } catch (e) {
        // Ignore read errors
      }
    }

    // 6. Clean up settings.json (remove GSD hooks and statusline)
    const settingsPath = path.join(targetDir, 'settings.json');
    if (fs.existsSync(settingsPath)) {
      let settings = readSettings(settingsPath);
      let settingsModified = false;

      // Remove GSD statusline if it references our hook
      if (settings.statusLine && settings.statusLine.command &&
          settings.statusLine.command.includes('gsd-statusline')) {
        delete settings.statusLine;
        settingsModified = true;
        console.log(`  ${green}✓${reset} Removed GSD statusline from settings`);
      }

      // Remove GSD hooks from SessionStart
      if (pruneGsdHookEntries(settings, 'SessionStart', c =>
        c.includes('gsd-check-update') || c.includes('gsd-statusline')
      )) {
        settingsModified = true;
        console.log(`  ${green}✓${reset} Removed GSD hooks from settings`);
      }

      // Remove GSD hooks from PostToolUse
      if (pruneGsdHookEntries(settings, 'PostToolUse', c =>
        c.includes('gsd-context-monitor')
      )) {
        settingsModified = true;
        console.log(`  ${green}✓${reset} Removed context monitor hook from settings`);
      }

      // Remove GSD hooks from PreToolUse. bash-safety-hook.cjs is GSD-installed
      // despite the unprefixed name; leaving its entry behind would point the
      // runtime at a script uninstall has just deleted.
      if (pruneGsdHookEntries(settings, 'PreToolUse', c =>
        c.includes('gsd-sandbox-detect') ||
        c.includes('gsd-guardrail') ||
        c.includes('bash-safety-hook.cjs')
      )) {
        settingsModified = true;
        console.log(`  ${green}✓${reset} Removed GSD PreToolUse hooks from settings`);
      }

      // Remove GSD-seeded permissions.allow entries
      if (settings.permissions && Array.isArray(settings.permissions.allow)) {
        const sandboxTemplatePath = path.join(__dirname, '..', 'gsd-ng', 'templates', 'settings-sandbox.json');
        try {
          let templateEntries = [];
          if (fs.existsSync(sandboxTemplatePath)) {
            const sandboxTemplate = JSON.parse(fs.readFileSync(sandboxTemplatePath, 'utf8'));
            templateEntries = sandboxTemplate.permissions?.allow ?? [];
          }

          // Also compute dynamic platform CLI entries for removal
          const platformCLIs = ['gh', 'glab', 'fj', 'tea'];
          const dynamicEntries = [];
          for (const cli of platformCLIs) {
            try {
              execSync(`which ${cli}`, { stdio: 'ignore', timeout: 2000 });
              dynamicEntries.push(...getPlatformCliPatterns(cli));
            } catch {
              // CLI not installed — skip
            }
          }
          const removalSet = new Set([...templateEntries, ...dynamicEntries]);
          const before = settings.permissions.allow.length;
          settings.permissions.allow = settings.permissions.allow.filter(e => !removalSet.has(e));

          if (settings.permissions.allow.length < before) {
            settingsModified = true;
            console.log(`  ${green}✓${reset} Removed GSD permissions from settings`);
          }

          // Clean up empty structures
          if (settings.permissions.allow.length === 0) {
            delete settings.permissions.allow;
          }
          if (settings.permissions && Object.keys(settings.permissions).length === 0) {
            delete settings.permissions;
          }
        } catch {
          // Template missing or unreadable — skip
        }
      }

      // Clean up empty hooks object
      if (settings.hooks && Object.keys(settings.hooks).length === 0) {
        delete settings.hooks;
      }

      if (settingsModified) {
        writeSettings(settingsPath, settings);
        removedCount++;
      }
    }

    if (removedCount === 0) {
      console.log(`  ${yellow}⚠${reset} No GSD files found to remove.`);
    }

    console.log(`
  ${green}Done!${reset} GSD has been uninstalled from Claude Code.
  Your other files and settings have been preserved.
`);
  } else {
    // Non-Claude runtime uninstall path

    // Count what exists before removal for accurate log output.
    const skillsDir = path.join(targetDir, 'skills');
    const gsdDir = path.join(targetDir, 'gsd-ng');
    const agentsDir = path.join(targetDir, 'agents');

    let skillCount = 0;
    if (fs.existsSync(skillsDir)) {
      skillCount = fs.readdirSync(skillsDir, { withFileTypes: true })
        .filter(e => e.isDirectory() && e.name.startsWith('gsd-')).length;
    }

    const hadGsdDir = fs.existsSync(gsdDir);

    let agentCount = 0;
    if (fs.existsSync(agentsDir)) {
      agentCount = fs.readdirSync(agentsDir).filter(f => f.startsWith('gsd-') && f.endsWith('.agent.md')).length;
    }

    const gsdHooksPath = path.join(targetDir, 'hooks', 'gsd-hooks.json');
    const hadGsdHooks = fs.existsSync(gsdHooksPath);
    const hadManifest = fs.existsSync(path.join(targetDir, MANIFEST_NAME));

    // 1-3 + gsd-hooks.json. Delegate GSD file removal to shared helper.
    removeGsdFiles(targetDir, runtime);

    // Log results for steps 1-3 and gsd-hooks.json.
    if (skillCount > 0) { removedCount++; console.log(`  ${green}✓${reset} Removed ${skillCount} GSD skills`); }
    if (hadGsdDir) { removedCount++; console.log(`  ${green}✓${reset} Removed gsd-ng/`); }
    if (agentCount > 0) { removedCount++; console.log(`  ${green}✓${reset} Removed ${agentCount} GSD agents`); }
    if (hadGsdHooks) { removedCount++; console.log(`  ${green}✓${reset} Removed hooks/gsd-hooks.json`); }
    if (hadManifest) { removedCount++; console.log(`  ${green}✓${reset} Removed ${MANIFEST_NAME}`); }

    // 4. Clean GSD section from copilot-instructions.md
    const instructionsPath = path.join(targetDir, 'copilot-instructions.md');
    if (fs.existsSync(instructionsPath)) {
      const content = fs.readFileSync(instructionsPath, 'utf8');
      const cleaned = stripGsdFromCopilotInstructions(content);
      if (cleaned === null) {
        fs.unlinkSync(instructionsPath);
        removedCount++;
        console.log(`  ${green}✓${reset} Removed copilot-instructions.md (was GSD-only)`);
      } else if (cleaned !== content) {
        fs.writeFileSync(instructionsPath, cleaned);
        removedCount++;
        console.log(`  ${green}✓${reset} Cleaned GSD section from copilot-instructions.md`);
      }
    }

    // Print summary and return (no settings.json cleanup for Copilot)
    if (removedCount === 0) {
      console.log(`  ${yellow}⚠${reset} No GSD files found to remove`);
    } else {
      console.log(`\n  ${green}✓${reset} Uninstalled ${removedCount} GSD component(s)`);
    }
  }
}

/**
 * Verify a directory exists and contains files
 */
function verifyInstalled(dirPath, description) {
  if (!fs.existsSync(dirPath)) {
    console.error(`  ${yellow}✗${reset} Failed to install ${description}: directory not created`);
    return false;
  }
  try {
    const entries = fs.readdirSync(dirPath);
    if (entries.length === 0) {
      console.error(`  ${yellow}✗${reset} Failed to install ${description}: directory is empty`);
      return false;
    }
  } catch (e) {
    console.error(`  ${yellow}✗${reset} Failed to install ${description}: ${e.message}`);
    return false;
  }
  return true;
}

/**
 * Verify a file exists
 */
function verifyFileInstalled(filePath, description) {
  if (!fs.existsSync(filePath)) {
    console.error(`  ${yellow}✗${reset} Failed to install ${description}: file not created`);
    return false;
  }
  return true;
}

/**
 * Install to the specified directory
 * @param {boolean} isGlobal - Whether to install globally or locally
 */

// ──────────────────────────────────────────────────────
// Local Patch Persistence
// ──────────────────────────────────────────────────────

const PATCHES_DIR_NAME = 'gsd-local-patches';
const MANIFEST_NAME = 'gsd-file-manifest.json';

/**
 * Filenames under <targetDir>/hooks/ that belong to GSD, and which uninstall and
 * the --clean wipe must therefore remove.
 *
 * Three sources are unioned because none alone is sufficient:
 *  - the manifest's `installed_hooks`, recording exactly what this install
 *    wrote. This is what makes the set self-maintaining: a hook the installed
 *    release shipped is removed by a later release that no longer ships it,
 *    with no list to remember to update.
 *  - the filenames the running package ships, covering installs whose manifest
 *    is absent, unreadable, or written before hooks were recorded.
 *  - RETIRED_GSD_HOOKS, covering names already retired by the time the manifest
 *    began recording hooks.
 *
 * Membership is by exact filename throughout — never a prefix or glob, so under
 * hooks/ a user file is a deletion candidate only if its name collides exactly
 * with a GSD hook. This says nothing about other directories: agents/ and
 * skills/ are cleaned by `gsd-` prefix match, where a user file so named is
 * removed.
 */
function gsdOwnedHookNames(targetDir, rt) {
  const names = new Set(shippedHookNames(rt));
  if (rt === 'claude') {
    for (const name of RETIRED_GSD_HOOKS) names.add(name);
  }

  const manifestPath = path.join(targetDir, MANIFEST_NAME);
  if (fs.existsSync(manifestPath)) {
    try {
      const recorded = JSON.parse(fs.readFileSync(manifestPath, 'utf8')).installed_hooks;
      if (Array.isArray(recorded)) {
        for (const name of recorded) {
          // Bare filenames only. The manifest is GSD-written but lives in a
          // user-writable tree, so a hand-edited entry must not be able to steer
          // deletion out of hooks/ via a separator or a dot segment.
          if (typeof name !== 'string' || !name) continue;
          if (name === '.' || name === '..' || name !== path.basename(name)) continue;
          names.add(name);
        }
      }
    } catch {
      // Unreadable manifest — the shipped and retired names still apply.
    }
  }
  return names;
}

/**
 * Compute SHA256 hash of file contents
 */
function fileHash(filePath) {
  const content = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(content).digest('hex');
}

// ─── GSD-managed frontmatter (agent files) ───────────────────────────────────
// syncAgentEffortFrontmatter() re-serialises the whole frontmatter block of a
// deployed agents/*.md on any supported config change, so a raw sha256 diverges
// from the manifest without the user having touched the file. Agent entries
// therefore carry a SECOND hash, taken over the canonicalised frontmatter minus
// the managed keys plus the untouched body: config churn is invisible to it, a
// real edit still shows up.
//
// Known gap: extractFrontmatter() discards comment lines and spliceFrontmatter()
// never re-emits them, so an edit made *inside* a frontmatter YAML comment is
// normalised away and is neither reported nor backed up. Agent files ship a
// commented-out `# hooks:` block that invites exactly that edit.

const MANAGED_AGENT_FRONTMATTER_KEYS = ['effort'];

/**
 * Canonicalise a deployed agent file for comparison: reparse the frontmatter,
 * drop the GSD-managed keys, and re-serialise through the same writer the sync
 * uses. Files that carry no frontmatter are returned unchanged.
 */
function stripManagedFrontmatter(content) {
  if (!/^---\r?\n/.test(content)) return content;
  const fm = extractFrontmatter(content);
  for (const key of MANAGED_AGENT_FRONTMATTER_KEYS) delete fm[key];
  return spliceFrontmatter(content, fm);
}

/** SHA256 of a file with GSD-managed frontmatter normalised out. */
function normalizedFileHash(filePath) {
  const content = stripManagedFrontmatter(fs.readFileSync(filePath, 'utf8'));
  return crypto.createHash('sha256').update(content).digest('hex');
}

/**
 * Recursively collect all files in dir with their hashes
 */
function generateManifest(dir, baseDir) {
  if (!baseDir) baseDir = dir;
  const manifest = {};
  if (!fs.existsSync(dir)) return manifest;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    const relPath = path.relative(baseDir, fullPath).replace(/\\/g, '/');
    if (entry.isDirectory()) {
      Object.assign(manifest, generateManifest(fullPath, baseDir));
    } else {
      manifest[relPath] = fileHash(fullPath);
    }
  }
  return manifest;
}

/**
 * Write file manifest after installation for future modification detection
 */
function writeManifest(configDir, version) {
  const gsdDir = path.join(configDir, 'gsd-ng');
  const commandsDir = path.join(configDir, 'commands', 'gsd');
  const agentsDir = path.join(configDir, 'agents');
  // `files_normalized` is an additive, optional companion map to `files`: the
  // same key space, normalised hashes, populated only for entries with GSD-managed
  // frontmatter. Older installers ignore it; newer ones fall back to raw-hash
  // comparison when a pre-existing manifest does not carry it.
  const manifest = { version: version || pkg.version, timestamp: new Date().toISOString(), schema_version: 2, files: {}, files_normalized: {} };

  const gsdHashes = generateManifest(gsdDir);
  for (const [rel, hash] of Object.entries(gsdHashes)) {
    manifest.files['gsd-ng/' + rel] = hash;
  }
  if (fs.existsSync(commandsDir)) {
    const cmdHashes = generateManifest(commandsDir);
    for (const [rel, hash] of Object.entries(cmdHashes)) {
      manifest.files['commands/gsd/' + rel] = hash;
    }
  }
  if (fs.existsSync(agentsDir)) {
    for (const file of fs.readdirSync(agentsDir)) {
      if (file.startsWith('gsd-') && file.endsWith('.md')) {
        const agentPath = path.join(agentsDir, file);
        manifest.files['agents/' + file] = fileHash(agentPath);
        manifest.files_normalized['agents/' + file] = normalizedFileHash(agentPath);
      }
    }
  }

  // `installed_hooks` is an additive record of the hook files this install put
  // in hooks/, kept deliberately outside `files`: it exists so a later release
  // knows what to remove, not to track content drift, and adding hooks to
  // `files` would silently enrol them in local-patch backup. Older installers
  // ignore the key, so no schema bump is needed.
  const hooksDir = path.join(configDir, 'hooks');
  manifest.installed_hooks = shippedHookNames(runtime)
    .filter(name => fs.existsSync(path.join(hooksDir, name)))
    .sort();

  fs.writeFileSync(path.join(configDir, MANIFEST_NAME), JSON.stringify(manifest, null, 2));
  return manifest;
}

/**
 * Compare manifest to current files and copy mismatches to gsd-local-patches/.
 * Pure backup — no console output. Returns { modified: string[], patchesDisplayPath: string|null }.
 * patchesDisplayPath is null when nothing was modified (caller can skip notices).
 */
function _backupModifiedFilesQuiet(configDir) {
  const manifestPath = path.join(configDir, MANIFEST_NAME);
  if (!fs.existsSync(manifestPath)) return { modified: [], patchesDisplayPath: null };
  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); } catch { return { modified: [], patchesDisplayPath: null }; }
  const patchesDir = path.join(configDir, PATCHES_DIR_NAME);
  const normalizedHashes = manifest.files_normalized || {};
  const modified = [];
  for (const [relPath, originalHash] of Object.entries(manifest.files || {})) {
    const fullPath = path.join(configDir, relPath);
    if (!fs.existsSync(fullPath)) continue;
    const currentHash = fileHash(fullPath);
    if (currentHash === originalHash) continue;
    // A raw mismatch on an entry that carries a normalised hash (agent files)
    // may be GSD's own doing — a model-profile or effort-override change
    // rewrote the managed frontmatter. Re-check against the normalised hash,
    // which sees only the body and the non-managed frontmatter, before calling
    // it a user modification. Manifests written before this map existed have no
    // entry here and fall through to the raw verdict.
    if (
      normalizedHashes[relPath] &&
      normalizedFileHash(fullPath) === normalizedHashes[relPath]
    ) {
      continue;
    }
    const backupPath = path.join(patchesDir, relPath);
    fs.mkdirSync(path.dirname(backupPath), { recursive: true });
    fs.copyFileSync(fullPath, backupPath);
    modified.push(relPath);
  }
  if (modified.length > 0) {
    const meta = {
      backed_up_at: new Date().toISOString(),
      from_version: manifest.version,
      files: modified,
    };
    fs.writeFileSync(path.join(patchesDir, 'backup-meta.json'), JSON.stringify(meta, null, 2));
  }
  const _isUnderCwd = configDir.startsWith(process.cwd() + path.sep) || configDir === process.cwd();
  const patchesDisplayPath =
    (_isUnderCwd
      ? configDir.replace(process.cwd(), '.')
      : configDir.replace(os.homedir(), '~')) +
    '/' +
    PATCHES_DIR_NAME +
    '/';
  return { modified, patchesDisplayPath: modified.length > 0 ? patchesDisplayPath : null };
}

/**
 * Detect user-modified GSD files by comparing against install manifest.
 * Backs up modified files to gsd-local-patches/ for reapply after update.
 */
function saveLocalPatches(configDir) {
  const { modified, patchesDisplayPath } = _backupModifiedFilesQuiet(configDir);
  if (modified.length > 0) {
    console.log(
      '  ' + yellow + 'i' + reset + '  Found ' + modified.length + ' locally modified GSD file(s) — backed up to ' + patchesDisplayPath
    );
    for (const f of modified) {
      console.log('     ' + dim + f + reset);
    }
  }
  return modified;
}

/**
 * After install, report backed-up patches for user to reapply.
 */
function reportLocalPatches(configDir) {
  const patchesDir = path.join(configDir, PATCHES_DIR_NAME);
  const metaPath = path.join(patchesDir, 'backup-meta.json');
  if (!fs.existsSync(metaPath)) return [];

  let meta;
  try { meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')); } catch { return []; }

  if (meta.files && meta.files.length > 0) {
    const reapplyCommand = '/gsd:reapply-patches';
    console.log('');
    console.log('  ' + yellow + 'Local patches detected' + reset + ' (from v' + meta.from_version + '):');
    for (const f of meta.files) {
      console.log('     ' + cyan + f + reset);
    }
    console.log('');
    const _isUnderCwd = configDir.startsWith(process.cwd() + path.sep) || configDir === process.cwd();
    const patchesDisplayPath = (_isUnderCwd ? configDir.replace(process.cwd(), '.') : configDir.replace(os.homedir(), '~')) + '/' + PATCHES_DIR_NAME + '/';
    console.log('  Your modifications are saved in ' + cyan + patchesDisplayPath + reset);
    console.log('  Run ' + cyan + reapplyCommand + reset + ' to merge them into the new version.');
    console.log('  Or manually compare and merge the files.');
    console.log('');
  }
  return meta.files || [];
}

// ─── Manifest schema migrations ──────────────────────────────────────────────
// Table-driven migrations between manifest schema versions. Each entry runs
// when the on-disk manifest's schema_version matches `from` (null = missing).
// Future schema bumps append rows here; existing code does not change.

/**
 * Migrate a v1 manifest (no schema_version) to v2.
 * Silently backs up any real user-modified files, then lets the caller's
 * normal install flow overwrite managed files and call writeManifest().
 * Returns { backedUp: string[], patchesDisplayPath: string|null } so the
 * caller can compose the migration notice.
 */
function migrateV1ToV2(configDir, _manifest) {
  const { modified, patchesDisplayPath } = _backupModifiedFilesQuiet(configDir);
  return { backedUp: modified, patchesDisplayPath };
}

// Each entry: { from: schema_version (null = missing/v1), to: schema_version, run: fn }
// Entries MUST be ordered ascending by `from` so chained migrations apply in a single pass.
const MIGRATIONS = [
  // schema_version: 2 — post-substitution hashes (current schema)
  { from: null, to: 2, run: migrateV1ToV2 },
];

/**
 * Walk applicable migrations against the on-disk manifest. Returns:
 *   { ran: boolean, notices: string[] }
 * `notices` is the list of stdout lines the caller should print AFTER the
 * normal install flow finishes (so file refresh happens between detection
 * and the user-visible message).
 */
function applyMigrations(configDir) {
  const manifestPath = path.join(configDir, MANIFEST_NAME);
  if (!fs.existsSync(manifestPath)) return { ran: false, notices: [] };
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch {
    return { ran: false, notices: [] };
  }
  let currentVersion = manifest.schema_version ?? null;
  let ran = false;
  const notices = [];
  for (const m of MIGRATIONS) {
    // Exact source-version match. `null` represents v1/missing schema_version.
    if (m.from !== currentVersion) continue;
    const result = m.run(configDir, manifest) || {};
    ran = true;
    notices.push('  ' + yellow + 'i' + reset + '  Migrated manifest to v' + m.to + ' — files refreshed from source');
    if (result.backedUp && result.backedUp.length > 0 && result.patchesDisplayPath) {
      notices.push('  ' + yellow + 'i' + reset + '  Your modifications were backed up to ' + result.patchesDisplayPath);
    }
    // Advance so chained migrations (e.g. v1→v2 then v2→v3) apply in one pass.
    currentVersion = m.to;
  }
  return { ran, notices };
}

/**
 * Gate for the deletion loops that enumerate a directory's entries.
 *
 * `fs.rmSync` on a symlinked directory unlinks the link and leaves the target
 * alone, but `readdirSync` + `unlinkSync`/`rmSync` on the joined paths resolves
 * through the link and deletes inside the target. GSD does not own whatever is
 * on the other side of a link the user made, so the loop is skipped rather than
 * resolved. `fs.existsSync` follows links, so it cannot serve as this gate.
 */
function isEnumerableManagedDir(dir) {
  let st;
  try {
    st = fs.lstatSync(dir);
  } catch {
    return false;
  }
  if (st.isSymbolicLink()) {
    console.log(`  ${yellow}!${reset}  Skipped ${dir} — symlinked directory, GSD does not remove files through it`);
    return false;
  }
  return st.isDirectory();
}

/**
 * Remove GSD-owned files under targetDir for the given runtime.
 * Pure fs operations, apart from a warning when a symlinked directory is
 * skipped. No settings cleanup.
 * Called by both wipeManagedTree (--clean) and uninstall().
 */
function removeGsdFiles(targetDir, runtime) {
  const isClaude = runtime === 'claude';

  if (isClaude) {
    // 1. Remove GSD commands
    const gsdCommandsDir = path.join(targetDir, 'commands', 'gsd');
    if (fs.existsSync(gsdCommandsDir)) {
      fs.rmSync(gsdCommandsDir, { recursive: true });
    }

    // 2. Remove gsd-ng directory
    const gsdDir = path.join(targetDir, 'gsd-ng');
    if (fs.existsSync(gsdDir)) {
      fs.rmSync(gsdDir, { recursive: true });
    }

    // 3. Remove GSD agents (gsd-*.md files only, preserve user agents)
    const agentsDir = path.join(targetDir, 'agents');
    if (isEnumerableManagedDir(agentsDir)) {
      for (const file of fs.readdirSync(agentsDir)) {
        if (file.startsWith('gsd-') && file.endsWith('.md')) {
          fs.unlinkSync(path.join(agentsDir, file));
        }
      }
    }

    // 4. Remove GSD-owned hook files
    const hooksDir = path.join(targetDir, 'hooks');
    if (isEnumerableManagedDir(hooksDir)) {
      for (const hook of gsdOwnedHookNames(targetDir, runtime)) {
        const hookPath = path.join(hooksDir, hook);
        if (fs.existsSync(hookPath)) {
          fs.unlinkSync(hookPath);
        }
      }
    }
  } else {
    // Non-Claude runtime: remove skills/gsd-* dirs (preserve user skills)
    const skillsDir = path.join(targetDir, 'skills');
    if (isEnumerableManagedDir(skillsDir)) {
      for (const entry of fs.readdirSync(skillsDir, { withFileTypes: true })) {
        if (entry.isDirectory() && entry.name.startsWith('gsd-')) {
          fs.rmSync(path.join(skillsDir, entry.name), { recursive: true, force: true });
        }
      }
    }

    // Non-Claude runtime: remove gsd-ng directory
    const gsdDir = path.join(targetDir, 'gsd-ng');
    if (fs.existsSync(gsdDir)) {
      fs.rmSync(gsdDir, { recursive: true });
    }

    // Non-Claude runtime: remove only gsd-*.agent.md files (preserve user agents)
    const agentsDir = path.join(targetDir, 'agents');
    if (isEnumerableManagedDir(agentsDir)) {
      for (const file of fs.readdirSync(agentsDir)) {
        if (file.startsWith('gsd-') && file.endsWith('.agent.md')) {
          fs.unlinkSync(path.join(agentsDir, file));
        }
      }
    }

    // Non-Claude runtime: remove only GSD-owned hook files.
    // Today that set is the single gsd-hooks.json descriptor.
    //
    // This deletion is the load-bearing one on this runtime. The three above it
    // are also performed by the ordinary install (skills/gsd-* and
    // agents/gsd-*.agent.md are re-cleared by the same wildcard predicates,
    // gsd-ng/ is removed before it is re-copied), so for a local install the
    // wipe leaves no observable trace. But the installer writes gsd-hooks.json
    // only for local installs — global Copilot hooks are unsupported by the CLI
    // — so on a global target nothing else ever deletes this file. Removing
    // this line would silently strand it.
    const copilotHooksDir = path.join(targetDir, 'hooks');
    if (isEnumerableManagedDir(copilotHooksDir)) {
      for (const hook of gsdOwnedHookNames(targetDir, runtime)) {
        const hookPath = path.join(copilotHooksDir, hook);
        if (fs.existsSync(hookPath)) {
          fs.unlinkSync(hookPath);
        }
      }
    }
  }

  // The manifest is GSD-written and describes GSD's own files, so it goes with
  // them on both removal paths. Read last: gsdOwnedHookNames() above sources the
  // hook removal set from it.
  const manifestPath = path.join(targetDir, MANIFEST_NAME);
  if (fs.existsSync(manifestPath)) {
    fs.unlinkSync(manifestPath);
  }
}

/**
 * Remove the GSD-managed subtree under targetDir for the given runtime.
 * Used by --clean to force a fresh-state install. NEVER wipes
 * gsd-local-patches/ — backed-up user modifications are preserved across
 * resets so the user can inspect them.
 */
function wipeManagedTree(targetDir, runtime) {
  // Remove all GSD-owned files without touching user content. The manifest goes
  // with them (both runtimes — manifest path is the same).
  removeGsdFiles(targetDir, runtime);

  // Explicitly DO NOT wipe gsd-local-patches/ — preserved per CONTEXT.md decision.
}

// ─── Content Conversion Engine (Claude → Copilot) ────────────────────────────

/**
 * Tool name mapping from Claude Code tool names to Copilot tool identifiers.
 * Used when converting Claude command/agent files to Copilot skill/agent format.
 */
const claudeToCopilotTools = {
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
};

/** HTML comment markers wrapping the GSD-managed block in copilot-instructions.md */
const GSD_COPILOT_INSTRUCTIONS_MARKER = '<!-- GSD Configuration -->';
const GSD_COPILOT_INSTRUCTIONS_CLOSE_MARKER = '<!-- /GSD Configuration -->';


/**
 * Path and reference conversion applied to ALL Copilot content.
 * Converts Claude-specific paths, directory names, and command prefixes to Copilot equivalents.
 * @param {string} content - File content to convert
 * @param {boolean} isGlobal - Whether this is a global install
 * @returns {string} Converted content
 */
function convertClaudeToCopilotContent(content, isGlobal = false) {
  let out = content;

  if (isGlobal) {
    // Global: ~/.claude/ → ~/.copilot/, $HOME/.claude/ → $HOME/.copilot/
    out = out.replace(/~\/\.claude\//g, '~/.copilot/');
    out = out.replace(/\$HOME\/\.claude\//g, '$HOME/.copilot/');
  } else {
    // Local: ~/.claude/ → .github/, $HOME/.claude/ → .github/, ./.claude/ → ./.github/
    out = out.replace(/~\/\.claude\//g, '.github/');
    out = out.replace(/\$HOME\/\.claude\//g, '.github/');
    out = out.replace(/\.\/\.claude\//g, './.github/');
  }

  // Resolve {{variables}} and <!-- ONLY:x --> conditional blocks via template-processor.
  // Path rewriting stays above (separate per design — CONTEXT.md Decision #7).
  const ctx = buildContext('copilot');
  out = processTemplate(out, ctx);

  return out;
}

/**
 * Convert a Claude command .md file to Copilot SKILL.md format.
 * Adjusts YAML frontmatter (allowed-tools list → comma-separated string with mapped names)
 * and applies path/reference conversion to the body.
 * @param {string} content - Source command .md content
 * @param {string} skillName - Name of the skill (used for context only)
 * @param {boolean} isGlobal - Whether this is a global install
 * @returns {string} Converted content
 */
function convertClaudeCommandToCopilotSkill(content, skillName, isGlobal) {
  const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!frontmatterMatch) {
    return convertClaudeToCopilotContent(content, isGlobal);
  }

  let frontmatter = frontmatterMatch[1];
  const body = frontmatterMatch[2];

  // Convert name: field — replace gsd: prefix with gsd- (Copilot skill names cannot contain colons)
  frontmatter = frontmatter.replace(/^(name:\s*)gsd:/m, '$1gsd-');

  // Convert allowed-tools YAML list to comma-separated Copilot format with mapped names
  frontmatter = frontmatter.replace(
    /^allowed-tools:\s*\n((?:[ \t]*-[ \t]*\S+[ \t]*\n?)*)/m,
    (match, listBlock) => {
      const tools = listBlock
        .split('\n')
        .map(line => line.replace(/^[ \t]*-[ \t]*/, '').trim())
        .filter(Boolean)
        .map(t => claudeToCopilotTools[t] || t.toLowerCase());
      return 'allowed-tools: ' + tools.join(', ') + '\n';
    }
  );

  const convertedBody = convertClaudeToCopilotContent(body, isGlobal);
  return '---\n' + frontmatter + '\n---\n' + convertedBody;
}

/**
 * Convert a Claude agent .md to Copilot .agent.md format.
 * Adjusts the tools frontmatter field from space/comma-separated Claude tool names
 * to a JSON array of Copilot tool names.
 * @param {string} content - Source agent .md content
 * @param {boolean} isGlobal - Whether this is a global install
 * @returns {string} Converted content
 */
function convertClaudeAgentToCopilotAgent(content, isGlobal) {
  const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!frontmatterMatch) {
    return convertClaudeToCopilotContent(content, isGlobal);
  }

  let frontmatter = frontmatterMatch[1];
  const body = frontmatterMatch[2];

  // Convert tools: line from space/comma-separated names to JSON array of Copilot names
  frontmatter = frontmatter.replace(
    /^(tools:[ \t]*)(.+)$/m,
    (match, prefix, toolsValue) => {
      const tools = toolsValue
        .split(/[\s,]+/)
        .map(t => t.trim())
        .filter(Boolean)
        .map(t => claudeToCopilotTools[t] || t.toLowerCase());
      return prefix + JSON.stringify(tools);
    }
  );

  const convertedBody = convertClaudeToCopilotContent(body, isGlobal);
  return '---\n' + frontmatter + '\n---\n' + convertedBody;
}

/**
 * Merge the GSD configuration block into copilot-instructions.md.
 * Three cases:
 *   - File doesn't exist: create with markers wrapping templateContent
 *   - File exists with markers: replace content between markers
 *   - File exists without markers: append markers + templateContent at end
 * @param {string} instructionsPath - Absolute path to copilot-instructions.md
 * @param {string} templateContent - GSD configuration block content
 */
function mergeCopilotInstructions(instructionsPath, templateContent) {
  const gsdBlock = GSD_COPILOT_INSTRUCTIONS_MARKER + '\n' +
    templateContent.trim() + '\n' +
    GSD_COPILOT_INSTRUCTIONS_CLOSE_MARKER;

  if (!fs.existsSync(instructionsPath)) {
    fs.writeFileSync(instructionsPath, gsdBlock + '\n');
    return;
  }

  const existing = fs.readFileSync(instructionsPath, 'utf8');
  const markerStart = existing.indexOf(GSD_COPILOT_INSTRUCTIONS_MARKER);
  const markerEnd = existing.indexOf(GSD_COPILOT_INSTRUCTIONS_CLOSE_MARKER);

  if (markerStart !== -1 && markerEnd !== -1) {
    // Replace content between markers (inclusive)
    const updated = existing.slice(0, markerStart) +
      gsdBlock +
      existing.slice(markerEnd + GSD_COPILOT_INSTRUCTIONS_CLOSE_MARKER.length);
    fs.writeFileSync(instructionsPath, updated);
  } else {
    // Append GSD block at end
    const separator = existing.endsWith('\n') ? '\n' : '\n\n';
    fs.writeFileSync(instructionsPath, existing + separator + gsdBlock + '\n');
  }
}

/**
 * Remove the GSD block from copilot-instructions.md content.
 * @param {string} content - File content containing possible GSD markers
 * @returns {string|null} Cleaned content, or null if file should be deleted (was GSD-only)
 */
function stripGsdFromCopilotInstructions(content) {
  const markerStart = content.indexOf(GSD_COPILOT_INSTRUCTIONS_MARKER);
  const markerEnd = content.indexOf(GSD_COPILOT_INSTRUCTIONS_CLOSE_MARKER);

  if (markerStart === -1 || markerEnd === -1) {
    return content; // No GSD block found — return unchanged
  }

  const before = content.slice(0, markerStart).trimEnd();
  const after = content.slice(markerEnd + GSD_COPILOT_INSTRUCTIONS_CLOSE_MARKER.length).trimStart();
  const cleaned = [before, after].filter(Boolean).join('\n\n');

  if (!cleaned.trim()) {
    return null; // File was GSD-only — caller should delete it
  }
  return cleaned + '\n';
}

// ─────────────────────────────────────────────────────────────────────────────

function writeRuntimeMarker(targetDir, runtime) {
  const dest = path.join(targetDir, 'gsd-ng', '.runtime');
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, runtime + '\n');
  console.log(`  ${green}✓${reset} Wrote .runtime marker (${runtime})`);
}

function install(isGlobal) {
  const isClaudeCode = runtime === 'claude';
  const dirName = getDirName(runtime);
  const src = path.join(__dirname, '..');

  // Get the target directory based on install type
  const targetDir = isGlobal
    ? getGlobalDir(runtime)
    : path.join(process.cwd(), dirName);

  const locationLabel = isGlobal
    ? targetDir.replace(os.homedir(), '~')
    : targetDir.replace(process.cwd(), '.');

  // Path prefix for file references in markdown content
  // For global installs: use tilde-based path (~/.claude/) to avoid baking
  // absolute paths (containing OS username) into templates
  // For local installs: use relative
  const pathPrefix = isGlobal
    ? `${targetDir.replace(/\\/g, '/').replace(os.homedir().replace(/\\/g, '/'), '~')}/`
    : `./${dirName}/`;

  const runtimeLabel = getRuntimeLabel(runtime);
  console.log(`  Installing for ${cyan}${runtimeLabel}${reset} to ${cyan}${locationLabel}${reset}\n`);

  // Track installation failures
  const failures = [];

  if (isClaudeCode) {
    // --clean: wipe managed tree, skip migration AND patch detection. Wins silently
    // over a v1 manifest — no migration, no notices, fresh install only.
    let migrationResult;
    if (hasClean) {
      wipeManagedTree(targetDir, runtime);
      console.log(`  ${green}✓${reset} Wiped managed tree (--clean)`);
      migrationResult = { ran: false, notices: [] };
    } else {
      // Detect and apply manifest schema migrations BEFORE patch detection.
      // If a migration runs (e.g. v1 manifest), it silently backs up modified
      // files and we skip the normal saveLocalPatches/reportLocalPatches path
      // for this install — a single migration notice replaces both messages.
      migrationResult = applyMigrations(targetDir);
      if (!migrationResult.ran) {
        // Save any locally modified GSD files before they get wiped
        saveLocalPatches(targetDir);
      }
    }

    // Claude Code: nested structure in commands/ directory
    const commandsDir = path.join(targetDir, 'commands');
    fs.mkdirSync(commandsDir, { recursive: true });

    const gsdSrc = path.join(src, 'commands', 'gsd');
    const gsdDest = path.join(commandsDir, 'gsd');
    copyWithPathReplacement(gsdSrc, gsdDest, pathPrefix, true);
    if (verifyInstalled(gsdDest, 'commands/gsd')) {
      console.log(`  ${green}✓${reset} Installed commands/gsd`);
    } else {
      failures.push('commands/gsd');
    }

    // Copy gsd-ng skill with path replacement
    const skillSrc = path.join(src, 'gsd-ng');
    const skillDest = path.join(targetDir, 'gsd-ng');
    copyWithPathReplacement(skillSrc, skillDest, pathPrefix);
    if (verifyInstalled(skillDest, 'gsd-ng')) {
      console.log(`  ${green}✓${reset} Installed gsd-ng`);
    } else {
      failures.push('gsd-ng');
    }

    // Copy agents to agents directory
    const agentsSrc = path.join(src, 'agents');
    if (fs.existsSync(agentsSrc)) {
      const agentsDest = path.join(targetDir, 'agents');
      fs.mkdirSync(agentsDest, { recursive: true });

      // Remove old GSD agents (gsd-*.md) before copying new ones
      if (isEnumerableManagedDir(agentsDest)) {
        for (const file of fs.readdirSync(agentsDest)) {
          if (file.startsWith('gsd-') && file.endsWith('.md')) {
            fs.unlinkSync(path.join(agentsDest, file));
          }
        }
      }

      // Copy new agents
      const agentEntries = fs.readdirSync(agentsSrc, { withFileTypes: true });
      for (const entry of agentEntries) {
        if (entry.isFile() && entry.name.endsWith('.md')) {
          let content = fs.readFileSync(path.join(agentsSrc, entry.name), 'utf8');
          // Replace ~/.claude/ and $HOME/.claude/ as they are the source of truth in the repo
          const dirRegex = /~\/\.claude\//g;
          const homeDirRegex = /\$HOME\/\.claude\//g;
          content = content.replace(dirRegex, toHomePrefix(pathPrefix));
          content = content.replace(homeDirRegex, toHomePrefix(pathPrefix));
          content = processAttribution(content, getCommitAttribution());
          fs.writeFileSync(path.join(agentsDest, entry.name), content);
        }
      }
      if (verifyInstalled(agentsDest, 'agents')) {
        console.log(`  ${green}✓${reset} Installed agents`);
      } else {
        failures.push('agents');
      }
    }

    // Sync effort: frontmatter into deployed agent files (Claude-only, post-copy).
    // Must run BEFORE writeManifest so manifest hashes the post-sync content.
    // Note: this code path lives inside an outer `if (isClaudeCode) { ... }` wrapper,
    // so the explicit isClaudeCode check below is technically redundant — keep it
    // as a defensive guard that documents intent and survives future refactors.
    if (isClaudeCode && fs.existsSync(path.join(targetDir, 'agents'))) {
      const effortAgentsDir = path.join(targetDir, 'agents');
      const syncResult = syncAgentEffortFrontmatter(process.cwd(), effortAgentsDir);
      if (syncResult.changes && syncResult.changes.length > 0) {
        console.log(`  ${green}✓${reset} Synced effort frontmatter (${syncResult.changes.length} agent${syncResult.changes.length === 1 ? '' : 's'} changed)`);
        // CONTEXT.md Area 4 lock: restart notice on real changes at ALL three touchpoints
        // (install, set-profile, config-set effort_overrides). Use stderr to match Plans 05/06
        // emission style — keeps stdout / JSON-mode payloads clean and gives all three call
        // sites one voice.
        const restartNotice = formatRestartNotice(syncResult.changes);
        if (restartNotice) {
          process.stderr.write(restartNotice + '\n');
        }
      }
    }

    // Copy CHANGELOG.md
    const changelogSrc = path.join(src, 'CHANGELOG.md');
    const changelogDest = path.join(targetDir, 'gsd-ng', 'CHANGELOG.md');
    if (fs.existsSync(changelogSrc)) {
      fs.copyFileSync(changelogSrc, changelogDest);
      if (verifyFileInstalled(changelogDest, 'CHANGELOG.md')) {
        console.log(`  ${green}✓${reset} Installed CHANGELOG.md`);
      } else {
        failures.push('CHANGELOG.md');
      }
    }

    // Write VERSION file (with +hash for snapshot/develop installs)
    const versionDest = path.join(targetDir, 'gsd-ng', 'VERSION');
    fs.writeFileSync(versionDest, INSTALLED_VERSION);
    if (verifyFileInstalled(versionDest, 'VERSION')) {
      console.log(`  ${green}✓${reset} Wrote VERSION (${INSTALLED_VERSION})`);
    } else {
      failures.push('VERSION');
    }

    // Write package.json to force CommonJS mode for GSD scripts
    // Prevents "require is not defined" errors when project has "type": "module"
    // Node.js walks up looking for package.json - this stops inheritance from project
    const pkgJsonDest = path.join(targetDir, 'package.json');
    fs.writeFileSync(pkgJsonDest, '{"type":"commonjs"}\n');
    console.log(`  ${green}✓${reset} Wrote package.json (CommonJS mode)`);

    // .js hooks reference the config dir as a literal '.claude' — rewrite it for the target runtime.
    const hooksSrc = path.join(src, 'hooks');
    if (fs.existsSync(hooksSrc)) {
      const hooksDest = path.join(targetDir, 'hooks');
      fs.mkdirSync(hooksDest, { recursive: true });
      const configDirReplacement = getConfigDirFromHome(runtime, isGlobal);

      for (const entry of fs.readdirSync(hooksSrc)) {
        const srcFile = path.join(hooksSrc, entry);
        if (!fs.statSync(srcFile).isFile()) continue;
        const destFile = path.join(hooksDest, entry);
        if (entry.endsWith('.js')) {
          const content = fs
            .readFileSync(srcFile, 'utf8')
            .replace(/'\.claude'/g, configDirReplacement);
          fs.writeFileSync(destFile, content);
        } else {
          fs.copyFileSync(srcFile, destFile);
        }
      }

      const missingHooks = REQUIRED_HOOKS.filter(
        h => !fs.existsSync(path.join(hooksDest, h))
      );
      if (verifyInstalled(hooksDest, 'hooks') && missingHooks.length === 0) {
        console.log(`  ${green}✓${reset} Installed hooks`);
      } else {
        if (missingHooks.length > 0) {
          console.error(
            `  ${yellow}✗${reset} Failed to install hooks: missing required hook(s): ${missingHooks.join(', ')}`
          );
        }
        failures.push('hooks');
      }
    }

    if (failures.length > 0) {
      console.error(`\n  ${yellow}Installation incomplete!${reset} Failed: ${failures.join(', ')}`);
      process.exit(1);
    }

    // Resolve {{variables}} and <!-- ONLY:x --> markers in Claude workflow/reference/lib/commands files.
    // Uses template-processor.cjs (centralized template engine).
    // Copilot path handles this separately in convertClaudeToCopilotContent().
    // Path rewriting (e.g., ~/.claude/ -> ~/.copilot/) stays separate per design.
    const ctx = buildContext('claude');
    const claudeTemplateDirs = [
      path.join(targetDir, 'gsd-ng', 'workflows'),
      path.join(targetDir, 'gsd-ng', 'references'),
      path.join(targetDir, 'gsd-ng', 'bin', 'lib'),
      path.join(targetDir, 'commands', 'gsd'),
    ];
    for (const dir of claudeTemplateDirs) {
      if (!fs.existsSync(dir)) continue;
      const files = fs.readdirSync(dir).filter(f => f.endsWith('.md') || f.endsWith('.cjs'));
      for (const file of files) {
        const filePath = path.join(dir, file);
        let content = fs.readFileSync(filePath, 'utf-8');
        if (content.includes('{{') || content.includes('<!-- ONLY:')) {
          try {
            content = processTemplate(content, ctx);
            fs.writeFileSync(filePath, content, 'utf-8');
          } catch {
            // Skip files with unbalanced markers (e.g., documentation containing example syntax)
          }
        }
      }
    }

    // Write file manifest AFTER template post-pass so hashes match resolved on-disk content.
    // (If writeManifest ran before the loop, next install would detect phantom local modifications.)
    writeManifest(targetDir, INSTALLED_VERSION);
    console.log(`  ${green}✓${reset} Wrote file manifest (${MANIFEST_NAME})`);

    // Report any backed-up local patches — but skip when a migration ran this
    // install (the migration notice already covered the user's modifications).
    if (migrationResult.ran) {
      for (const line of migrationResult.notices) {
        console.log(line);
      }
    } else {
      reportLocalPatches(targetDir);
    }

    // Configure statusline and hooks in settings.json
    const postToolEvent = 'PostToolUse';
    const settingsPath = path.join(targetDir, 'settings.json');
    const settings = readSettings(settingsPath);
    const statuslineCommand = isGlobal
      ? buildHookCommand(targetDir, 'gsd-statusline.js')
      : 'node "$CLAUDE_PROJECT_DIR"/' + dirName + '/hooks/gsd-statusline.js';
    const updateCheckCommand = isGlobal
      ? buildHookCommand(targetDir, 'gsd-check-update.js')
      : 'node "$CLAUDE_PROJECT_DIR"/' + dirName + '/hooks/gsd-check-update.js';
    const contextMonitorCommand = isGlobal
      ? buildHookCommand(targetDir, 'gsd-context-monitor.js')
      : 'node "$CLAUDE_PROJECT_DIR"/' + dirName + '/hooks/gsd-context-monitor.js';
    const sandboxDetectCommand = isGlobal
      ? buildHookCommand(targetDir, 'gsd-sandbox-detect.js')
      : 'node "$CLAUDE_PROJECT_DIR"/' + dirName + '/hooks/gsd-sandbox-detect.js';
    const guardrailCommand = isGlobal
      ? buildHookCommand(targetDir, 'gsd-guardrail.js')
      : 'node "$CLAUDE_PROJECT_DIR"/' + dirName + '/hooks/gsd-guardrail.js';
    const bashSafetyCommand = isGlobal
      ? buildHookCommand(targetDir, 'bash-safety-hook.cjs')
      : 'node "$CLAUDE_PROJECT_DIR"/' + dirName + '/hooks/bash-safety-hook.cjs';

    // Configure hooks in settings.json
    if (!settings.hooks) {
      settings.hooks = {};
    }

    // Configure SessionStart hook for update checking
    if (!settings.hooks.SessionStart) {
      settings.hooks.SessionStart = [];
    }

    const hasGsdUpdateHook = settings.hooks.SessionStart.some(entry =>
      entry.hooks && entry.hooks.some(h => h.command && h.command.includes('gsd-check-update'))
    );

    if (!hasGsdUpdateHook) {
      settings.hooks.SessionStart.push({
        hooks: [
          {
            type: 'command',
            command: updateCheckCommand
          }
        ]
      });
      console.log(`  ${green}✓${reset} Configured update check hook`);
    }

    // Configure post-tool hook for context window monitoring
    if (!settings.hooks[postToolEvent]) {
      settings.hooks[postToolEvent] = [];
    }

    const hasContextMonitorHook = settings.hooks[postToolEvent].some(entry =>
      entry.hooks && entry.hooks.some(h => h.command && h.command.includes('gsd-context-monitor'))
    );

    if (!hasContextMonitorHook) {
      settings.hooks[postToolEvent].push({
        matcher: 'Bash|Edit|Write|MultiEdit|Agent|Task',
        hooks: [
          {
            type: 'command',
            command: contextMonitorCommand,
            timeout: 10
          }
        ]
      });
      console.log(`  ${green}✓${reset} Configured context window monitor hook`);
    } else {
      // Migration: add matcher/timeout to existing context monitor hooks without them
      for (const entry of settings.hooks[postToolEvent]) {
        if (entry.hooks && entry.hooks.some(h => h.command && h.command.includes('gsd-context-monitor'))) {
          if (!entry.matcher) {
            entry.matcher = 'Bash|Edit|Write|MultiEdit|Agent|Task';
          }
          for (const h of entry.hooks) {
            if (h.command && h.command.includes('gsd-context-monitor') && !h.timeout) {
              h.timeout = 10;
            }
          }
        }
      }
    }

    // Configure PreToolUse hook for sandbox detection
    if (!settings.hooks.PreToolUse) {
      settings.hooks.PreToolUse = [];
    }

    const hasGsdSandboxDetectHook = settings.hooks.PreToolUse.some(entry =>
      entry.hooks && entry.hooks.some(h => h.command && h.command.includes('gsd-sandbox-detect'))
    );

    if (!hasGsdSandboxDetectHook) {
      settings.hooks.PreToolUse.push({
        hooks: [
          {
            type: 'command',
            command: sandboxDetectCommand
          }
        ]
      });
      console.log(`  ${green}✓${reset} Configured sandbox detection hook`);
    }

    // Configure PreToolUse hook for workflow guardrail
    const hasGsdGuardrailHook = settings.hooks.PreToolUse.some(entry =>
      entry.hooks && entry.hooks.some(h => h.command && h.command.includes('gsd-guardrail'))
    );

    if (!hasGsdGuardrailHook) {
      settings.hooks.PreToolUse.push({
        matcher: 'Edit|Write|EnterPlanMode',
        hooks: [
          {
            type: 'command',
            command: guardrailCommand,
          }
        ]
      });
      console.log(`  ${green}✓${reset} Configured workflow guardrail hook`);
    }

    // Configure PreToolUse hook for bash command safety (compound command allowlist).
    // Replaces AST safety rules — transparent hook instead of model instructions.
    // See: https://github.com/anthropics/claude-code/issues/30435
    // Append at END of PreToolUse array — user's custom hooks run first.
    const bashSafetyHookInstalled = fs.existsSync(
      path.join(targetDir, 'hooks', 'bash-safety-hook.cjs')
    );
    const hasGsdBashSafetyHook = settings.hooks.PreToolUse.some(entry =>
      entry.hooks && entry.hooks.some(h => h.command && h.command.includes('bash-safety-hook.cjs'))
    );

    if (bashSafetyHookInstalled && !hasGsdBashSafetyHook) {
      settings.hooks.PreToolUse.push({
        matcher: 'Bash',
        hooks: [
          {
            type: 'command',
            command: bashSafetyCommand
          }
        ]
      });
      console.log(`  ${green}✓${reset} Configured bash command safety hook`);
    }

    // Seed permissions.allow/deny/ask from settings-sandbox.json template (three-section sync)
    if (!noSeedPermissionsConfig) {
      const sandboxTemplatePath = path.join(src, 'gsd-ng', 'templates', 'settings-sandbox.json');
      try {
        const sandboxTemplate = JSON.parse(fs.readFileSync(sandboxTemplatePath, 'utf8'));

        // Effective platform (override via GSD_TEST_FORCE_PLATFORM for test harnesses — test-only seam)
        const seedPlatform = process.env.GSD_TEST_FORCE_PLATFORM || process.platform;

        // -- Build templateAllow with platform-aware Read/Edit/Write forms --
        const rawTemplateAllow = sandboxTemplate.permissions?.allow ?? [];
        const baseTemplateAllow = rawTemplateAllow.filter(e => !RW_FORMS.has(e));
        const platformRw = getReadEditWriteAllowRules(seedPlatform);

        // Dynamic CLI entries (platform detection via which + .planning/config.json)
        const platformCLIs = ['gh', 'glab', 'fj', 'tea'];
        const dynamicEntries = [];
        for (const cli of platformCLIs) {
          try {
            execSync(`which ${cli}`, { stdio: 'ignore', timeout: 2000 });
            dynamicEntries.push(...getPlatformCliPatterns(cli));
          } catch {
            // CLI not installed — skip
          }
        }
        const configPath = path.join(process.cwd(), '.planning', 'config.json');
        try {
          if (fs.existsSync(configPath)) {
            const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
            const platform = config.git?.platform;
            if (platform && PLATFORM_TO_CLI[platform]) {
              for (const entry of getPlatformCliPatterns(PLATFORM_TO_CLI[platform])) {
                if (!dynamicEntries.includes(entry)) dynamicEntries.push(entry);
              }
            }
          }
        } catch {
          // config.json missing or unparseable — skip
        }

        // All three sections are normalised before seeding — see
        // normalizePermissionRules in gsd-ng/bin/lib/allowlist.cjs.
        const templateAllow = normalizePermissionRules([...baseTemplateAllow, ...platformRw, ...dynamicEntries]);
        const templateDeny  = normalizePermissionRules(sandboxTemplate.permissions?.deny ?? []);
        const templateAsk   = normalizePermissionRules(sandboxTemplate.permissions?.ask  ?? []);

        // -- Three-section union-only sync helper --
        const syncSection = (existing, templateEntries) => {
          const existingSet = new Set(existing);
          const toAdd = templateEntries.filter(e => !existingSet.has(e));
          return { merged: [...existing, ...toAdd], added: toAdd.length };
        };

        const existingAllow = settings.permissions?.allow ?? [];
        const existingDeny  = settings.permissions?.deny  ?? [];
        const existingAsk   = settings.permissions?.ask   ?? [];

        const allowResult = syncSection(existingAllow, templateAllow);
        const denyResult  = syncSection(existingDeny,  templateDeny);
        const askResult   = syncSection(existingAsk,   templateAsk);

        // -- Apply merged results --
        if (allowResult.added > 0 || denyResult.added > 0 || askResult.added > 0) {
          if (!settings.permissions) settings.permissions = {};
          if (allowResult.added > 0) settings.permissions.allow = allowResult.merged;
          if (denyResult.added  > 0) settings.permissions.deny  = denyResult.merged;
          if (askResult.added   > 0) settings.permissions.ask   = askResult.merged;
        }

        // -- Per-section logging --
        if (allowResult.added > 0) console.log(`  ${green}✓${reset} Added ${allowResult.added} allow entries`);
        if (denyResult.added  > 0) console.log(`  ${green}✓${reset} Added ${denyResult.added} deny rules`);
        if (askResult.added   > 0) console.log(`  ${green}✓${reset} Added ${askResult.added} ask entries`);
        if (allowResult.added === 0 && denyResult.added === 0 && askResult.added === 0) {
          console.log(`  ${green}✓${reset} Permissions already up to date`);
        }
      } catch {
        // Template missing or unreadable — skip silently
      }
    }

    // Seed sandbox settings by default (opt-out via --no-seed-sandbox-config)
    if (!noSeedSandboxConfig) {
      const sandboxTemplatePath = path.join(src, 'gsd-ng', 'templates', 'settings-sandbox.json');
      try {
        const sandboxTemplate = JSON.parse(fs.readFileSync(sandboxTemplatePath, 'utf8'));
        let sandboxSeeded = false;

        if (sandboxTemplate.sandbox) {
          if (!settings.sandbox) settings.sandbox = {};
          if (settings.sandbox.enabled === undefined && sandboxTemplate.sandbox.enabled !== undefined) {
            settings.sandbox.enabled = sandboxTemplate.sandbox.enabled;
            sandboxSeeded = true;
          }
          if (settings.sandbox.autoAllowBashIfSandboxed === undefined && sandboxTemplate.sandbox.autoAllowBashIfSandboxed !== undefined) {
            settings.sandbox.autoAllowBashIfSandboxed = sandboxTemplate.sandbox.autoAllowBashIfSandboxed;
            sandboxSeeded = true;
          }
        }

        if (sandboxSeeded) {
          console.log(`  ${green}✓${reset} Enabled sandbox mode`);
        }
      } catch {
        // Template missing or unreadable — skip
      }
    }

    writeRuntimeMarker(targetDir, runtime);

    return { settingsPath, settings, statuslineCommand };

  } else {
    // Copilot: skills (from commands), agents, gsd-ng engine, copilot-instructions.md
    // NO settings.json, NO hooks, NO statusline, NO sandbox seeding

    if (hasClean) {
      wipeManagedTree(targetDir, runtime);
      console.log(`  ${green}✓${reset} Wiped managed tree (--clean)`);
    }

    // 1. Copy gsd-ng skill engine (same as Claude Code)
    const skillSrc = path.join(src, 'gsd-ng');
    const skillDest = path.join(targetDir, 'gsd-ng');
    copyWithPathReplacement(skillSrc, skillDest, pathPrefix);
    if (verifyInstalled(skillDest, 'gsd-ng')) {
      console.log(`  ${green}✓${reset} Installed gsd-ng`);
    } else {
      failures.push('gsd-ng');
    }

    // 2. Convert commands to Copilot skills (skills/gsd-{name}/SKILL.md)
    const commandsSrc = path.join(src, 'commands', 'gsd');
    const skillsDir = path.join(targetDir, 'skills');
    if (fs.existsSync(commandsSrc)) {
      // Clean existing GSD skills
      if (isEnumerableManagedDir(skillsDir)) {
        for (const entry of fs.readdirSync(skillsDir, { withFileTypes: true })) {
          if (entry.isDirectory() && entry.name.startsWith('gsd-')) {
            fs.rmSync(path.join(skillsDir, entry.name), { recursive: true });
          }
        }
      }
      fs.mkdirSync(skillsDir, { recursive: true });

      const commandFiles = fs.readdirSync(commandsSrc).filter(f => {
        if (!f.endsWith('.md')) return false;
        // Skip Claude-only commands. set-profile configures effort: frontmatter
        // which Copilot does not support (Claude-only feature).
        if (f === 'set-profile.md') return false;
        return true;
      });
      let skillCount = 0;
      for (const file of commandFiles) {
        const content = fs.readFileSync(path.join(commandsSrc, file), 'utf8');
        const skillName = 'gsd-' + path.basename(file, '.md').replace(/^gsd[:-]/, '');
        const skillDir = path.join(skillsDir, skillName);
        fs.mkdirSync(skillDir, { recursive: true });
        const converted = convertClaudeCommandToCopilotSkill(content, skillName, isGlobal);
        fs.writeFileSync(path.join(skillDir, 'SKILL.md'), converted);
        skillCount++;
      }
      console.log(`  ${green}✓${reset} Installed ${skillCount} Copilot skills`);
    }

    // 3. Convert agents to Copilot .agent.md format
    const agentsSrc = path.join(src, 'agents');
    if (fs.existsSync(agentsSrc)) {
      const agentsDest = path.join(targetDir, 'agents');
      // Clean existing GSD agents
      if (isEnumerableManagedDir(agentsDest)) {
        for (const file of fs.readdirSync(agentsDest)) {
          if (file.startsWith('gsd-') && file.endsWith('.agent.md')) {
            fs.unlinkSync(path.join(agentsDest, file));
          }
        }
      }
      fs.mkdirSync(agentsDest, { recursive: true });

      const agentFiles = fs.readdirSync(agentsSrc).filter(f => f.endsWith('.md'));
      let agentCount = 0;
      for (const file of agentFiles) {
        const content = fs.readFileSync(path.join(agentsSrc, file), 'utf8');
        const converted = convertClaudeAgentToCopilotAgent(content, isGlobal);
        const agentName = path.basename(file, '.md') + '.agent.md';
        fs.writeFileSync(path.join(agentsDest, agentName), converted);
        agentCount++;
      }
      console.log(`  ${green}✓${reset} Installed ${agentCount} Copilot agents`);
    }

    // 4. Generate copilot-instructions.md
    const templatePath = path.join(targetDir, 'gsd-ng', 'templates', 'copilot-instructions.md');
    const instructionsPath = path.join(targetDir, 'copilot-instructions.md');
    if (fs.existsSync(templatePath)) {
      const template = fs.readFileSync(templatePath, 'utf8');
      mergeCopilotInstructions(instructionsPath, template);
      console.log(`  ${green}✓${reset} Generated copilot-instructions.md`);
    }

    // 5. Write gsd-hooks.json (SessionStart update-check hook)
    // Note: global Copilot hooks (~/.copilot/hooks/) are not yet supported by Copilot CLI
    // (feature request #1354). Only wire hooks for local installs.
    if (!isGlobal) {
      const hooksDir = path.join(targetDir, 'hooks');
      fs.mkdirSync(hooksDir, { recursive: true });
      const gsdHooksPath = path.join(hooksDir, 'gsd-hooks.json');
      const hookContent = JSON.stringify({
        version: 1,
        hooks: {
          sessionStart: [
            {
              type: 'command',
              bash: `node ${dirName}/gsd-ng/hooks/gsd-check-update.js`,
              cwd: '.',
              timeoutSec: 30,
            }
          ]
        }
      }, null, 2);
      fs.writeFileSync(gsdHooksPath, hookContent);
      console.log(`  ${green}✓${reset} Installed hooks/gsd-hooks.json`);
    } else {
      console.log(`  (hooks skipped — global Copilot hooks not yet supported by Copilot CLI)`);
    }

    // Copilot: no settings.json, no statusline, no sandbox seeding
    if (failures.length > 0) {
      console.log(`\n  ${yellow}⚠ ${failures.length} component(s) failed to install${reset}`);
    }

    // Write VERSION file (snapshot-aware, same as claude path) — overrides any
    // verbatim copy from source tree so copilot installs get the same +hash
    // suffix on dev checkouts.
    const versionDest = path.join(targetDir, 'gsd-ng', 'VERSION');
    fs.mkdirSync(path.dirname(versionDest), { recursive: true });
    fs.writeFileSync(versionDest, INSTALLED_VERSION);
    console.log(`  ${green}✓${reset} Wrote VERSION (${INSTALLED_VERSION})`);

    // Manifest records post-template-processing hashes for all installed
    // runtimes; the active runtime is determined by buildContext().
    // Required for local-patch detection on future re-installs.
    writeManifest(targetDir, INSTALLED_VERSION);
    console.log(`  ${green}✓${reset} Wrote file manifest (${MANIFEST_NAME})`);

    writeRuntimeMarker(targetDir, runtime);

    return { settingsPath: null, settings: null, statuslineCommand: null, runtime };
  }
}

/**
 * Apply statusline config, then print completion message
 */
function finishInstall(settingsPath, settings, statuslineCommand, shouldInstallStatusline) {
  if (shouldInstallStatusline) {
    settings.statusLine = {
      type: 'command',
      command: statuslineCommand
    };
    console.log(`  ${green}✓${reset} Configured statusline`);
  }

  writeSettings(settingsPath, settings);

  console.log(`
  ${green}Done!${reset} Open a blank directory in Claude Code and run ${cyan}/gsd:new-project${reset}.
`);
}

/**
 * Handle statusline configuration with optional prompt
 */
function handleStatusline(settings, isInteractive, callback) {
  const hasExisting = settings.statusLine != null;

  if (!hasExisting) {
    callback(true);
    return;
  }

  if (forceStatusline) {
    callback(true);
    return;
  }

  if (!isInteractive) {
    console.log(`  ${yellow}⚠${reset} Skipping statusline (already configured)`);
    console.log(`    Use ${cyan}--force-statusline${reset} to replace\n`);
    callback(false);
    return;
  }

  const existingCmd = settings.statusLine.command || settings.statusLine.url || '(custom)';

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  console.log(`
  ${yellow}⚠${reset} Existing statusline detected\n
  Your current statusline:
    ${dim}command: ${existingCmd}${reset}

  GSD includes a statusline showing:
    • Model name
    • Current task (from todo list)
    • Context window usage (color-coded)

  ${cyan}1${reset}) Keep existing
  ${cyan}2${reset}) Replace with GSD statusline
`);

  rl.question(`  Choice ${dim}[1]${reset}: `, (answer) => {
    rl.close();
    const choice = answer.trim() || '1';
    callback(choice === '2');
  });
}

/**
 * Ask whether to enable sandbox mode by default.
 * Only called from the interactive (TTY) installer flow for Claude runtime.
 * Copilot runtime skips this prompt entirely (no sandbox model).
 * Default is YES (Y/n) — user must explicitly type 'n' to opt out.
 * User-facing language says "sandbox mode" not "seed sandbox config".
 */
function askSandboxMode(rl, callback) {
  rl.question('  Enable sandbox mode by default? (Y/n): ', (answer) => {
    const enable = answer.trim().toLowerCase() !== 'n';
    callback(enable);
  });
}

/**
 * Install GSD and finalize (hook registration + statusline)
 */
function installAndFinish(isGlobal, isInteractive) {
  const isClaudeCode = runtime === 'claude';
  const result = install(isGlobal);
  if (result && result.settingsPath) {
    handleStatusline(result.settings, isInteractive, (shouldInstallStatusline) => {
      finishInstall(result.settingsPath, result.settings, result.statuslineCommand, shouldInstallStatusline);
    });
  } else if (result) {
    // Copilot or other runtime without settings.json
    console.log(`\n  ${green}Done!${reset} GSD installed for ${cyan}${isClaudeCode ? 'Claude Code' : getRuntimeLabel(runtime)}${reset}.\n`);
  }
}

/**
 * Prompt for runtime selection.
 * Called FIRST in interactive flow, before location.
 * No default -- user must explicitly choose 1 or 2.
 */
function promptRuntime(callback) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  let answered = false;

  rl.on('close', () => {
    if (!answered) {
      answered = true;
      console.log(`\n  ${yellow}Installation cancelled${reset}\n`);
      process.exit(0);
    }
  });

  console.log(`  ${yellow}Which runtime?${reset}\n\n  ${cyan}1${reset}) Claude Code  ${dim}(commands in .claude/)${reset}\n  ${cyan}2${reset}) Copilot CLI   ${dim}(skills in .github/)${reset}\n`);

  rl.question(`  Choice: `, (answer) => {
    answered = true;
    rl.close();
    const choice = answer.trim();
    if (choice === '1') {
      callback('claude');
    } else if (choice === '2') {
      callback('copilot');
    } else {
      console.log(`\n  ${yellow}Invalid choice. Please enter 1 or 2.${reset}\n`);
      promptRuntime(callback);
    }
  });
}

/**
 * Prompt for install location
 */
function promptLocation(callback) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  let answered = false;

  rl.on('close', () => {
    if (!answered) {
      answered = true;
      console.log(`\n  ${yellow}Installation cancelled${reset}\n`);
      process.exit(0);
    }
  });

  const globalPath = getGlobalDir(runtime).replace(os.homedir(), '~');
  const localPath = './' + getDirName(runtime);

  console.log(`  ${yellow}Where would you like to install?${reset}\n\n  ${cyan}1${reset}) Global ${dim}(${globalPath})${reset} - available in all projects\n  ${cyan}2${reset}) Local  ${dim}(${localPath})${reset} - this project only\n`);

  rl.question(`  Choice ${dim}[1]${reset}: `, (answer) => {
    answered = true;
    rl.close();
    const choice = answer.trim() || '1';
    const isGlobal = choice !== '2';
    callback(isGlobal);
  });
}

// Main logic — only runs when executed directly, not when require()d by tests
if (require.main === module) {
  if (hasGlobal && hasLocal) {
    console.error(`  ${yellow}Cannot specify both --global and --local${reset}`);
    process.exit(1);
  } else if (hasUninstall) {
    if (!hasGlobal && !hasLocal) {
      console.error(`  ${yellow}--uninstall requires --global or --local${reset}`);
      process.exit(1);
    }
    if (!runtime) {
      console.error(`  ${yellow}Error: --runtime required. Use --runtime claude or --runtime copilot${reset}`);
      process.exit(1);
    }
    uninstall(hasGlobal);
  } else if (hasGlobal || hasLocal) {
    // Non-interactive: --runtime is REQUIRED
    if (!runtime) {
      console.error(`  ${yellow}Error: --runtime required. Use --runtime claude or --runtime copilot${reset}`);
      process.exit(1);
    }
    installAndFinish(hasGlobal, false);
  } else {
    // Interactive
    if (!process.stdin.isTTY) {
      console.error(`  ${yellow}Non-interactive terminal detected. Use --runtime with --global or --local.${reset}\n`);
      console.error(`  ${dim}Examples:${reset}\n    npx gsd-ng --runtime claude --global\n    npx gsd-ng --runtime claude --local\n    npx gsd-ng --runtime copilot --local\n`);
      process.exit(1);
    } else {
      // Interactive flow: runtime -> location -> sandbox (Claude only)
      promptRuntime((selectedRuntime) => {
        runtime = selectedRuntime;
        promptLocation((isGlobal) => {
          if (runtime === 'claude') {
            // Claude: ask about sandbox mode
            const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
            askSandboxMode(rl, (enableSandbox) => {
              rl.close();
              if (!enableSandbox) {
                noSeedSandboxConfig = true;
              }
              installAndFinish(isGlobal, true);
            });
          } else {
            // Copilot has no sandbox model -- skip sandbox prompt
            installAndFinish(isGlobal, true);
          }
        });
      });
    }
  }
}

module.exports = { convertClaudeToCopilotContent };
