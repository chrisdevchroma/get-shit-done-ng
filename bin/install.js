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
const { processTemplate, buildContext, injectAppendToFile, fillBetweenMarkers, RUNTIMES, patternToRemoval } = require('../gsd-ng/bin/lib/template-processor.cjs');
const { getPlatformCliPatterns, PLATFORM_TO_CLI, getReadEditWriteAllowRules, RW_FORMS, normalizePermissionRules } = require(path.join(__dirname, '..', 'gsd-ng', 'bin', 'lib', 'allowlist.cjs'));
const { syncAgentEffortFrontmatter, formatRestartNotice } = require(path.join(__dirname, '..', 'gsd-ng', 'bin', 'lib', 'effort-sync.cjs'));
const { extractFrontmatter, spliceFrontmatter } = require(path.join(__dirname, '..', 'gsd-ng', 'bin', 'lib', 'frontmatter.cjs'));
const { globalConfigDirFor } = require(path.join(__dirname, '..', 'gsd-ng', 'bin', 'lib', 'cache-path.cjs'));

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

// Every runtime GSD knows, in registry order. The only runtime list.
const RUNTIME_IDS = Object.keys(RUNTIMES);

/**
 * The `--runtime x or --runtime y` fragment shared by every flag-hint message,
 * so a new registry row reaches all of them at once.
 */
function runtimeFlagHint() {
  return RUNTIME_IDS.map(rt => `--runtime ${rt}`).join(' or ');
}

// Validate --runtime value if provided
if (runtimeArgVal && !RUNTIME_IDS.includes(runtimeArgVal)) {
  console.error(`  ${yellow}Error: Unknown runtime '${runtimeArgVal}'. Use ${runtimeFlagHint()}${reset}`);
  process.exit(1);
}

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
 * The artifact sets a runtime's layout declares, in the order an uninstall
 * removes them. Writing, manifesting and removal all walk this list, so the
 * three descriptions cannot drift apart.
 *
 * Each entry carries the shape its removal takes:
 *   tree  — GSD owns the whole directory, so it goes recursively
 *   dirs  — directory entries under it whose name matches a derived prefix
 *   files — file entries under it whose name matches a derived prefix + suffix
 *   names — an explicit filename set (generated descriptors, plugin files)
 *
 * A runtime with no registry row declares nothing, so nothing is removed for
 * it. That is the fall-through this replaces: the old `else` branch was named
 * non-Claude but behaved as Copilot, and applied Copilot's removal set to any
 * tree that reached it.
 */
function layoutArtifacts(rt) {
  const spec = (RUNTIMES[rt] || {}).layout;
  if (!spec) return [];
  const entries = [];

  // The prefix and suffix come from the write pattern itself, so a remover can
  // never describe a different set than the writer created.
  const patterned = (key, entry) => {
    if (entry.ownsDir) return { key, shape: 'tree', dir: entry.dir };
    const { prefix, suffix, entryType } = patternToRemoval(entry.pattern);
    return {
      key,
      shape: entryType === 'dir' ? 'dirs' : 'files',
      dir: entry.dir,
      prefix,
      suffix,
    };
  };

  if (spec.commands) entries.push(patterned('commands', spec.commands));
  if (spec.engine && spec.engine.dir) {
    entries.push({ key: 'engine', shape: 'tree', dir: spec.engine.dir });
  }
  if (spec.agents) entries.push(patterned('agents', spec.agents));
  if (spec.plugin) {
    entries.push({
      key: 'plugin',
      shape: 'names',
      dir: spec.plugin.dir,
      files: spec.plugin.files.map(f => f.to || path.basename(f.from)),
      from: null,
    });
  }
  if (spec.hooks) {
    entries.push({
      key: 'hooks',
      shape: 'names',
      dir: spec.hooks.dir,
      files: spec.hooks.files,
      from: spec.hooks.from,
    });
  }
  return entries;
}

/**
 * Filenames the running package installs for a `names` artifact.
 *
 * An entry without a source dir names files GSD generates or maps by hand. An
 * entry with one takes the names the source dir actually holds, so what an
 * install writes and what an uninstall removes cannot diverge by a filename —
 * but only among the names its layout declares. A packaged source directory
 * can hold a file belonging to another runtime's layout: hooks/ ships the
 * OpenCode plugin because that directory is in `package.json` files, and a
 * Claude install must not copy it into hooks/. A layout that declares no
 * filenames still takes the whole directory.
 */
function shippedNames(entry) {
  if (!entry.from) return entry.files.slice();
  const srcDir = path.join(__dirname, '..', entry.from);
  if (!fs.existsSync(srcDir)) return [];
  const present = fs
    .readdirSync(srcDir, { withFileTypes: true })
    .filter(e => e.isFile())
    .map(e => e.name);
  const declared = Array.isArray(entry.files)
    ? entry.files.filter(name => typeof name === 'string')
    : [];
  if (declared.length === 0) return present;
  const have = new Set(present);
  return declared.filter(name => have.has(name));
}

/**
 * The plural noun an uninstall log line uses for an artifact, taken from the
 * last segment of its declared directory: `skills` stays skills, `agent`
 * becomes agents.
 */
function artifactNoun(entry) {
  const base = path.basename(entry.dir);
  return base.endsWith('s') ? base : base + 's';
}

/** The hooks artifact of a runtime's layout, or null when it declares none. */
function hooksArtifact(rt) {
  return layoutArtifacts(rt).find(e => e.key === 'hooks') || null;
}

/** Hook filenames the running package installs for a runtime. */
function shippedHookNames(rt) {
  const entry = hooksArtifact(rt);
  return entry ? shippedNames(entry) : [];
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
 * The label is registry data, so a new runtime needs no edit here.
 */
function getRuntimeLabel(runtime) {
  const entry = RUNTIMES[runtime];
  if (entry && entry.RUNTIME_LABEL) return entry.RUNTIME_LABEL;
  return runtime || 'your runtime';
}

/**
 * The registry runtime an installer-layer resolver should read.
 * An unrecognized value falls back to Claude: it is rejected at argument
 * parsing, not here, so the resolvers must answer rather than throw. Own
 * property only, so a prototype name like `constructor` is unrecognized.
 * @param {string} rt - Runtime identifier
 */
function resolvedRuntimeName(rt) {
  return Object.prototype.hasOwnProperty.call(RUNTIMES, rt) ? rt : 'claude';
}

/**
 * The registry's config-home spec for a runtime.
 * @param {string} rt - Runtime identifier
 */
function configHomeSpec(rt) {
  return RUNTIMES[resolvedRuntimeName(rt)].configHome;
}

// Helper to get the project-local directory name for a runtime
function getDirName(rt) {
  return configHomeSpec(rt).localDirName;
}

/**
 * Get the config directory path relative to home directory
 * Used for templating hooks that use path.join(homeDir, '<configDir>', ...)
 * @param {string} rt - Runtime identifier
 * @param {boolean} isGlobal - Whether this is a global install
 */
function getConfigDirFromHome(rt, isGlobal) {
  const literal = configHomeSpec(rt).configDirLiteral;
  return isGlobal ? literal.global : literal.local;
}

/**
 * Get the global config directory.
 *
 * A thin caller of the payload's single derivation — the resolution order lives
 * there, beside the probes that have to agree with it.
 * @param {string} rt - Runtime identifier
 */
function getGlobalDir(rt) {
  return globalConfigDirFor(resolvedRuntimeName(rt));
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
  '  development system for Claude Code, Copilot CLI and OpenCode.\n';
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
    console.log(`  ${yellow}Usage:${reset} npx gsd-ng [options]\n\n  ${yellow}Options:${reset}\n    ${cyan}-g, --global${reset}                       Install globally (to ~/.claude)\n    ${cyan}-l, --local${reset}                        Install locally (to current directory)\n    ${cyan}-u, --uninstall${reset}                    Uninstall GSD (requires --global or --local)\n    ${cyan}-h, --help${reset}                         Show this help message\n    ${cyan}--force-statusline${reset}                 Replace existing statusline config\n    ${cyan}--snapshot${reset}                         Force +hash build metadata in VERSION (auto-detected on non-tag commits)\n    ${cyan}--no-seed-permissions-config${reset}       Skip permissions.allow seeding\n    ${cyan}--no-seed-sandbox-config${reset}           Skip sandbox.enabled seeding (permissions still seeded)\n    ${cyan}--clean${reset}                            Wipe the GSD-managed tree before install (debugging / fresh-state reset)\n    ${cyan}--runtime <runtime>${reset}                Select runtime: claude, copilot or opencode (REQUIRED for non-interactive)\n\n  ${yellow}Examples:${reset}\n    ${dim}# Interactive install (prompts for runtime and location)${reset}\n    npx gsd-ng\n\n    ${dim}# Install Claude runtime globally${reset}\n    npx gsd-ng --runtime claude --global\n\n    ${dim}# Install Claude runtime to current project only${reset}\n    npx gsd-ng --runtime claude --local\n\n    ${dim}# Install for GitHub Copilot CLI (local)${reset}\n    npx gsd-ng --runtime copilot --local\n\n    ${dim}# Install for GitHub Copilot CLI (global)${reset}\n    npx gsd-ng --runtime copilot --global\n\n    ${dim}# Install for OpenCode (local)${reset}\n    npx gsd-ng --runtime opencode --local\n\n    ${dim}# Install for OpenCode (global)${reset}\n    npx gsd-ng --runtime opencode --global\n\n    ${dim}# Uninstall GSD globally${reset}\n    npx gsd-ng --runtime claude --global --uninstall\n\n    ${dim}# Uninstall Copilot CLI runtime globally${reset}\n    npx gsd-ng --runtime copilot --global --uninstall\n\n  ${yellow}Notes:${reset}\n    Sandbox mode is enabled by default. Use --no-seed-sandbox-config to skip it.\n`);
    process.exit(0);
  }
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

  const layoutSpec = (RUNTIMES[runtime] || {}).layout || {};
  let removedCount = 0;

  // What exists before removal, so the log lines can be accurate. Counted first
  // because part of the removal set is sourced from the manifest, which
  // removeGsdFiles deletes along with everything else.
  const artifacts = layoutArtifacts(runtime).map(entry => ({
    entry,
    owned: ownedEntryNames(targetDir, runtime, entry),
  }));
  const hadManifest = fs.existsSync(path.join(targetDir, MANIFEST_NAME));

  // Delegate all GSD file removal to the shared helper.
  removeGsdFiles(targetDir, runtime);

  for (const { entry, owned } of artifacts) {
    if (owned.length === 0) continue;
    if (entry.shape === 'tree') {
      removedCount++;
      console.log(`  ${green}✓${reset} Removed ${entry.dir}/`);
    } else if (entry.shape === 'names' && !entry.from) {
      // A set GSD generates or maps by hand is short and fixed, so name what
      // went. A set copied wholesale out of the package's source dir varies by
      // release, so it is counted instead.
      for (const name of owned) {
        removedCount++;
        console.log(`  ${green}✓${reset} Removed ${entry.dir}/${name}`);
      }
    } else {
      removedCount++;
      console.log(`  ${green}✓${reset} Removed ${owned.length} GSD ${artifactNoun(entry)}`);
    }
  }
  if (hadManifest) { removedCount++; console.log(`  ${green}✓${reset} Removed ${MANIFEST_NAME}`); }

  // Remove the GSD package.json (CommonJS mode marker) where the layout
  // declares one.
  if (layoutSpec.writeCommonJsMarker) {
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
  }

  // Clean up settings.json (remove GSD hooks and statusline) for a runtime
  // whose layout declares settings.
  const settingsPath = path.join(targetDir, 'settings.json');
  if (layoutSpec.settings && fs.existsSync(settingsPath)) {
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

  // Strip the GSD block from the rules file the layout declares, and delete the
  // file when GSD was all it held. A spec the install skipped at this scope is
  // skipped here too: a rules file this scope never wrote is the user's, even
  // when one happens to sit in the working directory.
  if (layoutSpec.rulesFile && !(layoutSpec.rulesFile.localOnly && isGlobal)) {
    const rulesPath = rulesFilePath(runtime, targetDir);
    if (fs.existsSync(rulesPath)) {
      const content = fs.readFileSync(rulesPath, 'utf8');
      const cleaned = stripProjectRules(
        content,
        RUNTIMES[runtime].GSD_BLOCK_OPEN,
        RUNTIMES[runtime].GSD_BLOCK_CLOSE,
      );
      if (cleaned === null) {
        fs.unlinkSync(rulesPath);
        removedCount++;
        console.log(`  ${green}✓${reset} Removed ${layoutSpec.rulesFile.name} (was GSD-only)`);
      } else if (cleaned !== content) {
        fs.writeFileSync(rulesPath, cleaned);
        removedCount++;
        console.log(`  ${green}✓${reset} Cleaned GSD section from ${layoutSpec.rulesFile.name}`);
      }
    }
  }

  if (removedCount === 0) {
    console.log(`  ${yellow}⚠${reset} No GSD files found to remove.`);
  } else {
    console.log(`\n  ${green}✓${reset} Uninstalled ${removedCount} GSD component(s)`);
  }

  console.log(`
  ${green}Done!${reset} GSD has been uninstalled from ${runtimeLabel}.
  Your other files and settings have been preserved.
`);
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
 * The filenames a manifest records as installed, sanitised.
 *
 * Bare filenames only. The manifest is GSD-written but lives in a user-writable
 * tree, so a hand-edited entry must not be able to steer deletion out of the
 * artifact's own directory via a separator or a dot segment.
 */
function manifestRecordedNames(targetDir) {
  const manifestPath = path.join(targetDir, MANIFEST_NAME);
  if (!fs.existsSync(manifestPath)) return [];
  try {
    const recorded = JSON.parse(fs.readFileSync(manifestPath, 'utf8')).installed_hooks;
    if (!Array.isArray(recorded)) return [];
    return recorded.filter(name =>
      typeof name === 'string' &&
      name &&
      name !== '.' &&
      name !== '..' &&
      name === path.basename(name)
    );
  } catch {
    // Unreadable manifest — the shipped and retired names still apply.
    return [];
  }
}

/**
 * Filenames under a `names` artifact's directory that belong to GSD, and which
 * uninstall and the --clean wipe must therefore remove.
 *
 * Three sources are unioned because none alone is sufficient:
 *  - the manifest's `installed_hooks`, recording exactly what this install
 *    wrote. This is what makes the set self-maintaining: a file the installed
 *    release shipped is removed by a later release that no longer ships it,
 *    with no list to remember to update.
 *  - the filenames the running package ships, covering installs whose manifest
 *    is absent, unreadable, or written before the record existed.
 *  - RETIRED_GSD_HOOKS, covering names already retired by the time the manifest
 *    began recording them. Those were shipped out of the package hooks/ dir, so
 *    they apply to artifacts that install from a source dir.
 *
 * Membership is by exact filename throughout — never a prefix or glob, so under
 * hooks/ a user file is a deletion candidate only if its name collides exactly
 * with a GSD file. This says nothing about other directories: agents/ and
 * skills/ are cleaned by `gsd-` prefix match, where a user file so named is
 * removed.
 */
function gsdOwnedNames(targetDir, entry) {
  const names = new Set(shippedNames(entry));
  if (entry.from) {
    for (const name of RETIRED_GSD_HOOKS) names.add(name);
  }
  for (const name of manifestRecordedNames(targetDir)) names.add(name);
  return names;
}

/** gsdOwnedNames for the runtime's hooks artifact; empty when it declares none. */
function gsdOwnedHookNames(targetDir, rt) {
  const entry = hooksArtifact(rt);
  return entry ? gsdOwnedNames(targetDir, entry) : new Set();
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
// Order of the manifested artifact kinds. Fixed rather than taken from the
// layout walk, because the manifest is serialised in insertion order and its
// bytes are compared against a recorded install tree.
const MANIFEST_ARTIFACT_ORDER = ['engine', 'commands', 'agents'];

function writeManifest(configDir, version) {
  // `files_normalized` is an additive, optional companion map to `files`: the
  // same key space, normalised hashes, populated only for entries with GSD-managed
  // frontmatter. Older installers ignore it; newer ones fall back to raw-hash
  // comparison when a pre-existing manifest does not carry it.
  const manifest = { version: version || pkg.version, timestamp: new Date().toISOString(), schema_version: 2, files: {}, files_normalized: {} };

  const artifacts = layoutArtifacts(runtime);
  const byKey = key => artifacts.find(entry => entry.key === key);

  // The manifested set is the same layout description the writer and the
  // remover read, so a runtime cannot install something the manifest ignores.
  for (const key of MANIFEST_ARTIFACT_ORDER) {
    const entry = byKey(key);
    if (!entry) continue;
    const dir = artifactDir(configDir, entry);
    for (const name of ownedEntryNames(configDir, runtime, entry)) {
      if (entry.shape === 'files') {
        const filePath = path.join(dir, name);
        manifest.files[entry.dir + '/' + name] = fileHash(filePath);
        // Only agent files carry GSD-managed frontmatter, so only they need the
        // companion hash that sees past it.
        if (entry.key === 'agents') {
          manifest.files_normalized[entry.dir + '/' + name] = normalizedFileHash(filePath);
        }
        continue;
      }
      // tree: the artifact's own directory; dirs: one match under it.
      const walkRoot = entry.shape === 'tree' ? dir : path.join(dir, name);
      const keyPrefix = entry.shape === 'tree' ? entry.dir + '/' : entry.dir + '/' + name + '/';
      for (const [rel, hash] of Object.entries(generateManifest(walkRoot))) {
        manifest.files[keyPrefix + rel] = hash;
      }
    }
  }

  // `installed_hooks` is an additive record of the hook and plugin files this
  // install wrote, kept deliberately outside `files`: it exists so a later
  // release knows what to remove, not to track content drift, and adding them
  // to `files` would silently enrol them in local-patch backup. Older
  // installers ignore the key, so no schema bump is needed.
  const recorded = new Set();
  for (const entry of artifacts) {
    if (entry.shape !== 'names') continue;
    const dir = artifactDir(configDir, entry);
    for (const name of shippedNames(entry)) {
      if (fs.existsSync(path.join(dir, name))) recorded.add(name);
    }
  }
  manifest.installed_hooks = [...recorded].sort();

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

/** Absolute path of an artifact's directory under a target tree. */
function artifactDir(targetDir, entry) {
  return path.join(targetDir, ...entry.dir.split('/'));
}

/**
 * Entry names under an artifact's directory that GSD owns, by the artifact's
 * declared shape. Returns [] for a directory that does not exist or is a
 * symlink, so callers never resolve through a link the user made.
 *
 * `names` artifacts are the load-bearing case on a runtime whose other
 * artifacts the ordinary install re-clears anyway: the Copilot hooks descriptor
 * is written only for local installs — global Copilot hooks are unsupported by
 * the CLI — so on a global target nothing but this ever deletes it.
 */
function ownedEntryNames(targetDir, rt, entry) {
  if (entry.shape === 'tree') {
    const dir = artifactDir(targetDir, entry);
    return fs.existsSync(dir) ? [entry.dir] : [];
  }

  const dir = artifactDir(targetDir, entry);
  if (!isEnumerableManagedDir(dir)) return [];

  if (entry.shape === 'names') {
    return [...gsdOwnedNames(targetDir, entry)].filter(name =>
      fs.existsSync(path.join(dir, name)),
    );
  }

  const wantDir = entry.shape === 'dirs';
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter(e => (wantDir ? e.isDirectory() : !e.isDirectory()))
    .map(e => e.name)
    .filter(
      name => name.startsWith(entry.prefix) && name.endsWith(entry.suffix),
    );
}

/**
 * Remove GSD-owned files under targetDir for the given runtime.
 * Pure fs operations, apart from a warning when a symlinked directory is
 * skipped. No settings cleanup.
 * Called by both wipeManagedTree (--clean) and uninstall().
 */
function removeGsdFiles(targetDir, runtime) {
  for (const entry of layoutArtifacts(runtime)) {
    const dir = artifactDir(targetDir, entry);
    for (const name of ownedEntryNames(targetDir, runtime, entry)) {
      if (entry.shape === 'tree') {
        fs.rmSync(dir, { recursive: true });
      } else if (entry.shape === 'dirs') {
        fs.rmSync(path.join(dir, name), { recursive: true, force: true });
      } else {
        fs.unlinkSync(path.join(dir, name));
      }
    }
  }

  // The manifest is GSD-written and describes GSD's own files, so it goes with
  // them for every runtime. Read last: gsdOwnedNames() above sources the
  // `names` removal sets from it.
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
const claudeToCopilotTools = RUNTIMES.copilot.TOOL_MAP;

/**
 * The runtime's global config directory expressed relative to $HOME, or
 * absolute when it does not sit beneath $HOME.
 *
 * Derived from the same resolution that picks the install target, so an
 * override variable moves both together. A config home outside $HOME has no
 * home-relative form, and emitting one would name a directory that does not
 * exist, so the absolute path is returned and callers prefixing `~/` or
 * `$HOME/` must check for it.
 *
 * @param {string} rt - Runtime identifier
 * @returns {string} home-relative path, or an absolute one
 */
function globalHomeRelative(rt) {
  const dir = globalConfigDirFor(resolvedRuntimeName(rt));
  // A spec declaring no global directory at all: no runtime is in that state,
  // and the project-local name is the only remaining answer.
  if (!dir) return configHomeSpec(rt).localDirName;
  const relative = path.relative(os.homedir(), dir);
  if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) {
    return relative.split(path.sep).join('/');
  }
  return dir;
}

/**
 * Path and reference conversion applied to all content written for a runtime
 * other than the one the source tree is authored in.
 *
 * The source names Claude's directories, so those are the literals rewritten;
 * what they become is read from the target runtime's config-home spec, which is
 * also what resolves the install target. Adding a runtime therefore needs a
 * registry row, not an edit here.
 *
 * @param {string} content - File content to convert
 * @param {string} targetRuntime - Runtime the content is being written for
 * @param {boolean} isGlobal - Whether this is a global install
 * @returns {string} Converted content
 */
function convertContent(content, targetRuntime, isGlobal = false) {
  const spec = configHomeSpec(targetRuntime);
  let out = content;

  if (isGlobal) {
    const globalDir = globalHomeRelative(targetRuntime);
    // An override pointing outside $HOME has no home-relative form, so the
    // absolute path replaces the whole reference rather than being appended to
    // a `~/` or `$HOME/` prefix that would name a directory nothing installs to.
    if (path.isAbsolute(globalDir)) {
      const absolute = globalDir.replace(/\\/g, '/');
      out = out.replace(/~\/\.claude\//g, () => `${absolute}/`);
      out = out.replace(/\$HOME\/\.claude\//g, () => `${absolute}/`);
    } else {
      out = out.replace(/~\/\.claude\//g, () => `~/${globalDir}/`);
      out = out.replace(/\$HOME\/\.claude\//g, () => `$HOME/${globalDir}/`);
    }
  } else {
    const localDir = spec.localDirName;
    out = out.replace(/~\/\.claude\//g, () => `${localDir}/`);
    out = out.replace(/\$HOME\/\.claude\//g, () => `${localDir}/`);
    out = out.replace(/\.\/\.claude\//g, () => `./${localDir}/`);
  }

  // Resolve {{variables}} and <!-- ONLY:x --> conditional blocks via template-processor.
  // Path rewriting stays above (separate per design — CONTEXT.md Decision #7).
  out = processTemplate(out, buildContext(targetRuntime));

  return out;
}

/**
 * Copilot-targeted content conversion. Kept as a named entry point because it
 * is exported and required by name.
 *
 * @param {string} content - File content to convert
 * @param {boolean} isGlobal - Whether this is a global install
 * @returns {string} Converted content
 */
function convertClaudeToCopilotContent(content, isGlobal = false) {
  return convertContent(content, 'copilot', isGlobal);
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
  return '---\n' + resolveFrontmatterVars(frontmatter, 'copilot') + '\n---\n' + convertedBody;
}

/**
 * Resolve registry placeholders in frontmatter, after its tool names have been
 * mapped.
 *
 * The copilot converters translate frontmatter separately from the body and then
 * hand only the body to `convertContent`, so a `{{VAR}}` in a `description:` or
 * `argument-hint:` reached no substitution at all and shipped raw. Order is
 * load-bearing: the tool maps are keyed by the Claude tool name, so this has to
 * run after the mapping, never before it.
 *
 * @param {string} frontmatter - Frontmatter text, without its `---` fences
 * @param {string} targetRuntime - Runtime the content is being written for
 * @returns {string} Frontmatter with registry placeholders resolved
 */
function resolveFrontmatterVars(frontmatter, targetRuntime) {
  return processTemplate(frontmatter, buildContext(targetRuntime));
}

// ─── Agent frontmatter: the two forms `tools:` is written in ─────────────────

/** `tools: Read, Write, Bash` — the value on the key's own line. */
const TOOLS_INLINE_RE = /^tools:[ \t]*(\S.*)$/m;

/** `tools:` followed by indented `- Name` lines. */
const TOOLS_BLOCK_RE = /^tools:[ \t]*\n((?:[ \t]+-[ \t]*\S+[ \t]*\n?)+)/m;

function splitInlineTools(value) {
  return value
    .split(/[\s,]+/)
    .map(t => t.trim())
    .filter(Boolean);
}

function splitBlockTools(block) {
  return block
    .split('\n')
    .map(line => line.replace(/^[ \t]*-[ \t]*/, '').trim())
    .filter(Boolean);
}

/**
 * The Claude tool names an agent's frontmatter declares, whichever YAML form it
 * uses. Reading only the inline form silently passes the block-list agent's
 * tools through unconverted, which is what every consumer here has to avoid.
 *
 * @param {string} frontmatter - Agent frontmatter, without its `---` fences
 * @returns {string[]} Declared tool names, empty when the key is absent
 */
function agentToolNames(frontmatter) {
  const inline = frontmatter.match(TOOLS_INLINE_RE);
  if (inline) return splitInlineTools(inline[1]);
  const block = frontmatter.match(TOOLS_BLOCK_RE);
  if (block) return splitBlockTools(block[1]);
  return [];
}

/**
 * Replace whichever `tools:` form the frontmatter uses with a single rendered
 * line, so both forms converge on one output shape.
 *
 * @param {string} frontmatter - Agent frontmatter, without its `---` fences
 * @param {(names: string[]) => string} render - Renders the replacement value
 * @returns {string} Frontmatter with the tools entry rewritten
 */
function rewriteAgentTools(frontmatter, render) {
  const inline = frontmatter.match(TOOLS_INLINE_RE);
  if (inline) {
    return frontmatter.replace(TOOLS_INLINE_RE, () => 'tools: ' + render(splitInlineTools(inline[1])));
  }
  const block = frontmatter.match(TOOLS_BLOCK_RE);
  if (block) {
    return frontmatter.replace(TOOLS_BLOCK_RE, () => 'tools: ' + render(splitBlockTools(block[1])) + '\n');
  }
  return frontmatter;
}

/**
 * Split frontmatter into top-level key blocks: each key's own line plus the
 * indented or list lines continuing it.
 *
 * A comment line ends the block it follows — YAML comments belong to no scalar,
 * and the agents carry a commented-out `hooks:` example directly after a key.
 *
 * @param {string} frontmatter - Frontmatter text, without its `---` fences
 * @returns {Map<string, {raw: string, value: string, hasValue: boolean}>}
 */
function frontmatterBlocks(frontmatter) {
  const blocks = new Map();
  let current = null;
  for (const line of frontmatter.split('\n')) {
    const keyed = line.match(/^([A-Za-z0-9_-]+):(.*)$/);
    if (keyed) {
      current = keyed[1];
      blocks.set(current, {
        raw: line,
        value: keyed[2].trim(),
        hasValue: keyed[2].trim() !== '',
      });
      continue;
    }
    if (current === null) continue;
    if (line.trim() === '' || line.trim().startsWith('#')) {
      current = null;
      continue;
    }
    const block = blocks.get(current);
    block.raw += '\n' + line;
    block.hasValue = true;
  }
  return blocks;
}

/**
 * Convert a Claude agent .md to Copilot .agent.md format.
 * Adjusts the tools frontmatter field from either YAML form of Claude tool names
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

  const frontmatter = rewriteAgentTools(frontmatterMatch[1], names =>
    JSON.stringify(names.map(t => claudeToCopilotTools[t] || t.toLowerCase()))
  );

  const convertedBody = convertClaudeToCopilotContent(frontmatterMatch[2], isGlobal);
  return '---\n' + resolveFrontmatterVars(frontmatter, 'copilot') + '\n---\n' + convertedBody;
}

// ─── Content Conversion Engine (Claude → OpenCode) ───────────────────────────

const claudeToOpencodeTools = RUNTIMES.opencode.TOOL_MAP;
const opencodeColors = RUNTIMES.opencode.COLOR_MAP;

/**
 * Frontmatter keys OpenCode's command struct declares, in emission order.
 *
 * The struct is closed: `name` comes from the file path, and GSD's
 * `allowed-tools`, `argument-hint`, `argument-instructions` and `type` have no
 * slot in it. `allowed-tools` in particular has no equivalent anywhere —
 * OpenCode restricts tools through the referenced agent's permission map, not
 * per command. Emitting only these keys is deliberate rather than a reliance on
 * the loader tolerating extras.
 */
const OPENCODE_COMMAND_KEYS = ['description', 'agent'];

/** OpenCode's agent schema accepts this, or one of the seven theme literals. */
const OPENCODE_HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;

/**
 * The colour a source value with no valid translation becomes.
 *
 * A wrong-but-valid colour is a cosmetic defect; an invalid one fails the
 * schema, and one malformed file stops the whole surface from loading.
 */
const OPENCODE_FALLBACK_COLOR = 'info';

/**
 * OpenCode-targeted content conversion.
 *
 * `@file` references get one extra pass over the shared rewrite. A local
 * install already lands on the documented project-relative form; a global one
 * would otherwise carry `~/…`, and whether OpenCode expands a tilde or a shell
 * variable inside an `@` reference is undocumented and could not be verified
 * from source. An unresolved reference makes every workflow-dispatch command a
 * no-op, so the absolute path is baked in — accepting that it names the OS user
 * — rather than left to a behaviour nothing confirms.
 *
 * @param {string} content - File content to convert
 * @param {boolean} isGlobal - Whether this is a global install
 * @param {string} [targetDir] - Resolved install directory, for a global install
 * @returns {string} Converted content
 */
function convertClaudeToOpencodeContent(content, isGlobal, targetDir) {
  const out = convertContent(content, 'opencode', isGlobal);
  if (!isGlobal) return out;

  const resolved = (targetDir || getGlobalDir('opencode')).replace(/\\/g, '/');
  const homeRelative = globalHomeRelative('opencode');
  // The forms convertContent just wrote: prefixed when the config home is under
  // $HOME, the bare absolute path when it is not.
  const written = path.isAbsolute(homeRelative)
    ? ['@' + homeRelative.replace(/\\/g, '/') + '/']
    : ['@~/' + homeRelative + '/', '@$HOME/' + homeRelative + '/'];
  return written.reduce(
    (acc, prefix) => acc.split(prefix).join('@' + resolved + '/'),
    out,
  );
}

/**
 * Convert a Claude command .md to an OpenCode command file.
 *
 * The body passes through untouched beyond path rewriting and `{{VAR}}`
 * resolution: `$ARGUMENTS`, `$1..$n`, `` !`shell` `` and `@file` are all native
 * OpenCode syntax. The frontmatter is rebuilt from the source's own lines, so a
 * quoted or folded value keeps its quoting, and a key with no value is dropped
 * rather than emitted empty.
 *
 * @param {string} content - Source command .md content
 * @param {boolean} isGlobal - Whether this is a global install
 * @param {string} [targetDir] - Resolved install directory, for a global install
 * @returns {string} Converted content
 */
function convertClaudeCommandToOpencodeCommand(content, isGlobal, targetDir) {
  const converted = convertClaudeToOpencodeContent(content, isGlobal, targetDir);
  const frontmatterMatch = converted.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!frontmatterMatch) return converted;

  const blocks = frontmatterBlocks(frontmatterMatch[1]);
  const kept = [];
  for (const key of OPENCODE_COMMAND_KEYS) {
    const block = blocks.get(key);
    if (block && block.hasValue) kept.push(block.raw);
  }

  const body = frontmatterMatch[2];
  if (kept.length === 0) return body;
  return '---\n' + kept.join('\n') + '\n---\n' + body;
}

/**
 * A source colour value expressed as something OpenCode's agent schema accepts,
 * ready to emit as a YAML scalar.
 *
 * Quotes come off first — three of the source agents quote their hex — and a
 * hex goes back out quoted, because an unquoted `#` opens a YAML comment and
 * the key would decode as empty.
 *
 * @param {string} value - Raw frontmatter value
 * @returns {string} A quoted hex colour or one of the seven theme literals
 */
function opencodeAgentColor(value) {
  const bare = String(value || '').trim().replace(/^['"]|['"]$/g, '').trim();
  if (OPENCODE_HEX_COLOR_RE.test(bare)) return '"' + bare + '"';
  return opencodeColors[bare.toLowerCase()] || OPENCODE_FALLBACK_COLOR;
}

/**
 * The OpenCode permission ids an agent's declared tools translate to, in source
 * order and de-duplicated — `Task` and `Agent` both name the same one.
 *
 * A tool with no entry in the map has no OpenCode equivalent and is dropped;
 * passing an untranslated Claude name through would name a tool that does not
 * exist.
 *
 * @param {string} frontmatter - Agent frontmatter, without its `---` fences
 * @returns {string[]} OpenCode tool ids
 */
function opencodeAgentPermissions(frontmatter) {
  const ids = [];
  for (const name of agentToolNames(frontmatter)) {
    const mapped = claudeToOpencodeTools[name];
    if (mapped && !ids.includes(mapped)) ids.push(mapped);
  }
  return ids;
}

/**
 * Convert a Claude agent .md to an OpenCode agent file.
 *
 * `permission` is emitted rather than the deprecated `tools` record: OpenCode's
 * own normalisation folds `write`/`edit`/`patch` onto `permission.edit`, and
 * writing the map directly does not depend on that fold. `name` is left out —
 * the loader injects it from the path. `effort` is carried through: the struct
 * collects unknown keys, and stripping it would break the effort sync.
 *
 * @param {string} content - Source agent .md content
 * @param {boolean} isGlobal - Whether this is a global install
 * @param {string} [targetDir] - Resolved install directory, for a global install
 * @returns {string} Converted content
 */
function convertClaudeAgentToOpencodeAgent(content, isGlobal, targetDir) {
  const converted = convertClaudeToOpencodeContent(content, isGlobal, targetDir);
  const frontmatterMatch = converted.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!frontmatterMatch) return converted;

  const frontmatter = frontmatterMatch[1];
  const blocks = frontmatterBlocks(frontmatter);
  const lines = [];

  const description = blocks.get('description');
  if (description && description.hasValue) lines.push(description.raw);

  lines.push('mode: subagent');

  const color = blocks.get('color');
  if (color && color.hasValue) lines.push('color: ' + opencodeAgentColor(color.value));

  const permissions = opencodeAgentPermissions(frontmatter);
  if (permissions.length > 0) {
    lines.push('permission:');
    for (const id of permissions) lines.push('  ' + id + ': allow');
  }

  const effort = blocks.get('effort');
  if (effort && effort.hasValue) lines.push(effort.raw);

  return '---\n' + lines.join('\n') + '\n---\n' + frontmatterMatch[2];
}

/**
 * Refuse a marker pair that cannot delimit a block.
 *
 * Both halves are located with indexOf, so a close marker the open marker starts
 * with is found inside the open itself and the "block" between them is empty —
 * a merge on such a pair rewrites the file around a boundary that is not there.
 * A runtime whose block is delimited that way (a heading prefix, say) must
 * declare no rules file rather than reach this path.
 *
 * @param {string} open - Opening marker
 * @param {string} close - Closing marker
 */
function assertBlockMarkerPair(open, close) {
  if (!open || !close || open.startsWith(close)) {
    throw new Error(
      `Rules-file markers are not a delimiter pair: open ${JSON.stringify(open)}, ` +
      `close ${JSON.stringify(close)}. A runtime whose GSD block is not wrapped in ` +
      'a matched pair must declare no rulesFile in its layout.',
    );
  }
}

/**
 * The rules file a runtime's layout declares, resolved to an absolute path.
 *
 * `base` says which root it hangs off: `targetDir` for a runtime that reads its
 * rules from the install target, `cwd` for one that reads them from the project
 * root. Install and uninstall both come through here, so a global uninstall
 * cannot look somewhere the global install did not write. Whether either scope
 * touches the file at all is the caller's question — a `localOnly` spec is
 * skipped for a global install at both ends.
 *
 * @param {string} rt - Runtime identifier
 * @param {string} targetDir - Install target directory
 * @returns {string|null} Absolute path, or null when the layout declares none
 */
function rulesFilePath(rt, targetDir) {
  const spec = ((RUNTIMES[rt] || {}).layout || {}).rulesFile;
  if (!spec) return null;
  return path.join(spec.base === 'cwd' ? process.cwd() : targetDir, spec.name);
}

/**
 * Merge the GSD block into a runtime's project rules file.
 *
 * The file is a shared convention — other tools read it too — so the block is
 * strictly additive: every byte outside the markers survives. Three cases:
 *   - File doesn't exist: create with markers wrapping blockContent
 *   - File exists with markers: replace content between markers
 *   - File exists without markers: append markers + blockContent at end
 *
 * @param {string} rulesPath - Absolute path to the rules file
 * @param {string} blockContent - GSD block content, already template-resolved
 * @param {string} open - Opening marker
 * @param {string} close - Closing marker
 */
function mergeProjectRules(rulesPath, blockContent, open, close) {
  assertBlockMarkerPair(open, close);

  // Resolving a runtime's ONLY block leaves the blank lines that wrapped the
  // markers behind. Three or more consecutive newlines say nothing in markdown,
  // so folding them keeps one template's output tidy for every runtime.
  const body = blockContent.replace(/\n{3,}/g, '\n\n').trim();
  const gsdBlock = open + '\n' + body + '\n' + close;

  if (!fs.existsSync(rulesPath)) {
    fs.writeFileSync(rulesPath, gsdBlock + '\n');
    return;
  }

  const existing = fs.readFileSync(rulesPath, 'utf8');
  const markerStart = existing.indexOf(open);
  const markerEnd = existing.indexOf(close);

  if (markerStart !== -1 && markerEnd !== -1) {
    // Replace content between markers (inclusive)
    const updated = existing.slice(0, markerStart) +
      gsdBlock +
      existing.slice(markerEnd + close.length);
    fs.writeFileSync(rulesPath, updated);
  } else {
    // Append GSD block at end
    const separator = existing.endsWith('\n') ? '\n' : '\n\n';
    fs.writeFileSync(rulesPath, existing + separator + gsdBlock + '\n');
  }
}

/**
 * Remove the GSD block from a rules file's content.
 *
 * @param {string} content - File content containing possible GSD markers
 * @param {string} open - Opening marker
 * @param {string} close - Closing marker
 * @returns {string|null} Cleaned content, or null if file should be deleted (was GSD-only)
 */
function stripProjectRules(content, open, close) {
  assertBlockMarkerPair(open, close);

  const markerStart = content.indexOf(open);
  const markerEnd = content.indexOf(close);

  if (markerStart === -1 || markerEnd === -1) {
    return content; // No GSD block found — return unchanged
  }

  const before = content.slice(0, markerStart).trimEnd();
  const after = content.slice(markerEnd + close.length).trimStart();
  const cleaned = [before, after].filter(Boolean).join('\n\n');

  if (!cleaned.trim()) {
    return null; // File was GSD-only — caller should delete it
  }
  return cleaned + '\n';
}

/**
 * Add the keys a layout's config seed declares to the runtime's own config
 * file, and only the ones it does not already carry.
 *
 * The file belongs to the user, not to GSD: an existing value is never
 * replaced — including the schema URL, since a user pinning an older one has a
 * reason — and a file that does not parse is left exactly as found, because a
 * malformed config is far more likely mid-edit than abandoned. Absent is the
 * one case that writes from scratch.
 *
 * @param {string} seedPath - Absolute path to the runtime's config file
 * @param {object} contents - Keys to add where missing
 * @returns {boolean} Whether the file was written
 */
function seedConfigFile(seedPath, contents) {
  let cfg = {};
  if (fs.existsSync(seedPath)) {
    try {
      cfg = JSON.parse(fs.readFileSync(seedPath, 'utf8'));
    } catch {
      cfg = null;
    }
    if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) {
      console.log(`  ${yellow}⚠${reset} Left ${seedPath} alone — it is not a JSON object`);
      return false;
    }
  }

  let added = 0;
  for (const [key, value] of Object.entries(contents)) {
    if (!Object.prototype.hasOwnProperty.call(cfg, key)) {
      cfg[key] = value;
      added++;
    }
  }
  if (added === 0) return false;

  fs.writeFileSync(seedPath, JSON.stringify(cfg, null, 2) + '\n');
  return true;
}

// ─── Spec-driven writing ─────────────────────────────────────────────────────

/**
 * Content converters, selected by the `converter` key a layout declares.
 *
 * A runtime is added by registering its converters here and naming them in its
 * registry row — never by adding a branch to install().
 *
 * `identity` is the no-conversion writer: the source is already in the form its
 * runtime reads, so it takes only the path and attribution pass every installed
 * .md gets. The others convert out of that form into another runtime's.
 */
const CONVERTERS = {
  identity: (content, ctx) =>
    processAttribution(
      content
        .replace(/~\/\.claude\//g, () => toHomePrefix(ctx.pathPrefix))
        .replace(/\$HOME\/\.claude\//g, () => toHomePrefix(ctx.pathPrefix)),
      getCommitAttribution()
    ),
  copilotCommand: (content, ctx) =>
    convertClaudeCommandToCopilotSkill(content, ctx.name, ctx.isGlobal),
  copilotAgent: (content, ctx) =>
    convertClaudeAgentToCopilotAgent(content, ctx.isGlobal),
  opencodeCommand: (content, ctx) =>
    convertClaudeCommandToOpencodeCommand(content, ctx.isGlobal, ctx.targetDir),
  opencodeAgent: (content, ctx) =>
    convertClaudeAgentToOpencodeAgent(content, ctx.isGlobal, ctx.targetDir),
};

/**
 * The converter a layout entry names.
 *
 * An unregistered key stops the install: writing the file unconverted would
 * produce a tree that looks complete and holds another runtime's paths and tool
 * names throughout.
 */
function converterFor(key) {
  const convert = CONVERTERS[key];
  if (!convert) {
    throw new Error(
      `install: layout declares converter '${key}', which is not registered in CONVERTERS. ` +
      `Registered converters: ${Object.keys(CONVERTERS).join(', ')}`
    );
  }
  return convert;
}

/**
 * Writers for files a layout names but the package does not ship — GSD
 * generates their contents. Keyed by filename, so two runtimes declaring the
 * same descriptor get the same writer.
 */
const GENERATED_FILES = {
  'gsd-hooks.json': ({ dirName, engineDir }) =>
    JSON.stringify({
      version: 1,
      hooks: {
        sessionStart: [
          {
            type: 'command',
            bash: `node ${dirName}/${engineDir}/hooks/gsd-check-update.js`,
            cwd: '.',
            timeoutSec: 30,
          }
        ]
      }
    }, null, 2),
};

/**
 * Files GSD adds to a runtime's engine tree that the layout spec does not
 * describe.
 *
 * The spec ships inside that tree, so a field added to it changes the content
 * hash of an installed file for every runtime; installer-only facts live here
 * instead. A runtime absent from this table gets none of them — a lookup, not a
 * branch.
 */
const ENGINE_EXTRA_FILES = {
  claude: [{ from: 'CHANGELOG.md', to: 'CHANGELOG.md' }],
};

/** Where each artifact kind a layout can declare is read from in the package. */
const ARTIFACT_SOURCE_DIRS = {
  engine: ['gsd-ng'],
  commands: ['commands', 'gsd'],
  agents: ['agents'],
};

/**
 * The artifact name a write pattern produces for a source file.
 *
 * The `gsd` prefix a source file may already carry is stripped first, so the
 * pattern alone decides whether the installed name carries one: `<name>.md`
 * keeps commands unprefixed, `gsd-<name>.agent.md` prefixes and re-suffixes an
 * agent, `gsd-<name>/SKILL.md` nests it.
 *
 * @param {string} pattern - Layout write pattern containing `<name>`
 * @param {string} file - Source filename, e.g. `gsd-executor.md`
 * @returns {string} Relative path under the artifact's directory
 */
function patternToRelPath(pattern, file) {
  const name = path.basename(file, '.md').replace(/^gsd[:-]/, '');
  return pattern.replace('<name>', name);
}

/**
 * Resolve {{variables}} and <!-- ONLY:x --> markers in every .md and .cjs file
 * under dir, recursively.
 *
 * Recursion is what reaches the engine's nested template directories; a flat
 * read left everything below the first level unresolved. Files whose markers do
 * not balance are left alone — documentation quoting the syntax is not a
 * template.
 *
 * @param {string} dir - Directory to sweep
 * @param {object} ctx - Template context from buildContext()
 */
function resolveTemplateDir(dir, ctx) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      resolveTemplateDir(full, ctx);
      continue;
    }
    if (!entry.name.endsWith('.md') && !entry.name.endsWith('.cjs')) continue;
    const content = fs.readFileSync(full, 'utf-8');
    if (!content.includes('{{') && !content.includes('<!-- ONLY:')) continue;
    try {
      fs.writeFileSync(full, processTemplate(content, ctx), 'utf-8');
    } catch {
      // Skip files with unbalanced markers (e.g., documentation containing example syntax)
    }
  }
}

/**
 * Write a whole-directory artifact: GSD owns the destination, so the previous
 * copy goes and the package's tree replaces it verbatim.
 */
function writeTreeArtifact(entry, ctx) {
  const srcDir = path.join(ctx.src, ...ARTIFACT_SOURCE_DIRS[entry.key]);
  if (!fs.existsSync(srcDir)) return;
  const destDir = artifactDir(ctx.targetDir, entry);

  copyWithPathReplacement(srcDir, destDir, ctx.pathPrefix);

  if (entry.key === 'engine') {
    for (const extra of ENGINE_EXTRA_FILES[ctx.runtime] || []) {
      const extraSrc = path.join(ctx.src, extra.from);
      if (!fs.existsSync(extraSrc)) continue;
      const extraDest = path.join(destDir, extra.to);
      fs.copyFileSync(extraSrc, extraDest);
      if (verifyFileInstalled(extraDest, extra.to)) {
        console.log(`  ${green}✓${reset} Installed ${extra.to}`);
      } else {
        ctx.failures.push(extra.to);
      }
    }
  }

  if (verifyInstalled(destDir, entry.dir)) {
    console.log(`  ${green}✓${reset} Installed ${entry.dir}`);
  } else {
    ctx.failures.push(entry.dir);
  }
}

/**
 * Write a per-file artifact: every source file is converted and lands under the
 * name the layout's write pattern gives it.
 *
 * What a previous install left is cleared first, by the same predicate the
 * remover derives from that pattern — so the two cannot describe different
 * sets, and user files under the same directory are untouched.
 */
function writeConvertedArtifact(entry, spec, ctx) {
  const srcDir = path.join(ctx.src, ...ARTIFACT_SOURCE_DIRS[entry.key]);
  if (!fs.existsSync(srcDir)) return;
  const destDir = artifactDir(ctx.targetDir, entry);
  const convert = converterFor(spec.converter);

  for (const name of ownedEntryNames(ctx.targetDir, ctx.runtime, entry)) {
    const owned = path.join(destDir, name);
    if (entry.shape === 'dirs') fs.rmSync(owned, { recursive: true, force: true });
    else fs.unlinkSync(owned);
  }
  fs.mkdirSync(destDir, { recursive: true });

  let count = 0;
  for (const file of fs.readdirSync(srcDir)) {
    if (!file.endsWith('.md')) continue;
    if ((spec.skip || []).includes(file)) continue;
    const relPath = patternToRelPath(spec.pattern, file);
    const destPath = path.join(destDir, ...relPath.split('/'));
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    const content = fs.readFileSync(path.join(srcDir, file), 'utf8');
    fs.writeFileSync(
      destPath,
      convert(content, Object.assign({}, ctx, { name: relPath.split('/')[0] }))
    );
    count++;
  }

  if (verifyInstalled(destDir, entry.dir)) {
    console.log(`  ${green}✓${reset} Installed ${count} ${artifactNoun(entry)}`);
  } else {
    ctx.failures.push(entry.dir);
  }
}

/**
 * The files a named set installs, as { from, to } pairs. `from` is null for a
 * file GSD generates rather than ships.
 *
 * A set backed by a source directory takes its names from that directory, which
 * is where the manifest and the remover take theirs — so what an install writes
 * and what an uninstall removes cannot diverge by a filename.
 */
function namedFilePairs(entry, spec) {
  if (spec.from) {
    return shippedNames({ from: spec.from, files: spec.files }).map(name => ({
      from: `${spec.from}/${name}`,
      to: name,
    }));
  }
  return spec.files.map(file =>
    typeof file === 'string'
      ? { from: null, to: file }
      : { from: file.from, to: file.to || path.basename(file.from) }
  );
}

/**
 * Write a named file set: hook scripts, generated hook descriptors, plugin
 * entry points.
 */
function writeNamedArtifact(entry, spec, ctx) {
  const destDir = artifactDir(ctx.targetDir, entry);

  if (spec.localOnly && ctx.isGlobal) {
    console.log(`  (${entry.dir} skipped — ${ctx.runtimeLabel} does not support them for a global install)`);
    return;
  }

  fs.mkdirSync(destDir, { recursive: true });
  const configDirReplacement = getConfigDirFromHome(ctx.runtime, ctx.isGlobal);

  for (const pair of namedFilePairs(entry, spec)) {
    const destPath = path.join(destDir, pair.to);
    if (!pair.from) {
      const generate = GENERATED_FILES[pair.to];
      if (!generate) {
        throw new Error(
          `install: layout names generated file '${pair.to}', which has no writer in GENERATED_FILES. ` +
          `Registered: ${Object.keys(GENERATED_FILES).join(', ')}`
        );
      }
      fs.writeFileSync(destPath, generate(ctx));
      console.log(`  ${green}✓${reset} Installed ${entry.dir}/${pair.to}`);
      continue;
    }
    const srcFile = path.join(ctx.src, ...pair.from.split('/'));
    if (!fs.existsSync(srcFile)) continue;
    if (spec.rewriteConfigDirLiteral && pair.to.endsWith('.js')) {
      // .js hooks reference the config dir as a literal '.claude' — rewrite it for the target runtime.
      const content = fs.readFileSync(srcFile, 'utf8').replace(/'\.claude'/g, configDirReplacement);
      fs.writeFileSync(destPath, content);
    } else {
      fs.copyFileSync(srcFile, destPath);
    }
  }

  // Every file the layout names must have landed: a runtime configured to run a
  // hook GSD failed to write points at a script that is not there.
  const declared = spec.files.map(file => (typeof file === 'string' ? file : file.to || path.basename(file.from)));
  const missing = declared.filter(name => !fs.existsSync(path.join(destDir, name)));
  if (missing.length > 0) {
    console.error(`  ${yellow}✗${reset} Failed to install ${entry.dir}: missing ${missing.join(', ')}`);
    ctx.failures.push(entry.dir);
    return;
  }
  if (spec.from) {
    console.log(`  ${green}✓${reset} Installed ${entry.dir}`);
  }
}

/** Write one declared artifact set into the target tree. */
function writeArtifact(entry, ctx) {
  const spec = ctx.layout[entry.key];
  if (entry.shape === 'tree') return writeTreeArtifact(entry, ctx);
  if (entry.shape === 'names') return writeNamedArtifact(entry, spec, ctx);
  return writeConvertedArtifact(entry, spec, ctx);
}

// ─────────────────────────────────────────────────────────────────────────────

function writeRuntimeMarker(targetDir, runtime) {
  const dest = path.join(targetDir, 'gsd-ng', '.runtime');
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, runtime + '\n');
  console.log(`  ${green}✓${reset} Wrote .runtime marker (${runtime})`);
}

function install(isGlobal) {
  const dirName = getDirName(runtime);
  const src = path.join(__dirname, '..');
  const layout = (RUNTIMES[runtime] || {}).layout || {};
  const engineDir = (layout.engine && layout.engine.dir) || 'gsd-ng';

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

  // Everything the writers need, resolved once. Nothing in it is a runtime
  // name used to choose behaviour — `runtime` is a registry key to read from.
  const ctx = {
    runtime, runtimeLabel, layout, src, targetDir,
    dirName, engineDir, isGlobal, pathPrefix, failures,
  };

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

  fs.mkdirSync(targetDir, { recursive: true });

  // One walk over the artifact kinds this runtime's layout declares. The
  // manifest and the uninstall walk the same list, so an install cannot write
  // something neither of them knows about.
  for (const entry of layoutArtifacts(runtime)) {
    writeArtifact(entry, ctx);
  }

  // The hook payload a plugin spawns lands inside the engine tree, so it is
  // written after the copy that replaces that tree wholesale.
  if (layout.hooksPayload && !(layout.hooksPayload.localOnly && isGlobal)) {
    const payload = layout.hooksPayload;
    const payloadDir = path.join(targetDir, ...payload.dir.split('/'));
    fs.mkdirSync(payloadDir, { recursive: true });
    for (const name of payload.files) {
      const srcFile = path.join(src, ...payload.from.split('/'), name);
      if (!fs.existsSync(srcFile)) continue;
      fs.copyFileSync(srcFile, path.join(payloadDir, name));
    }
    console.log(`  ${green}✓${reset} Installed ${payload.dir}`);
  }

  // Write VERSION file (with +hash for snapshot/develop installs)
  const versionDest = path.join(targetDir, engineDir, 'VERSION');
  fs.mkdirSync(path.dirname(versionDest), { recursive: true });
  fs.writeFileSync(versionDest, INSTALLED_VERSION);
  if (verifyFileInstalled(versionDest, 'VERSION')) {
    console.log(`  ${green}✓${reset} Wrote VERSION (${INSTALLED_VERSION})`);
  } else {
    failures.push('VERSION');
  }

  // package.json forces CommonJS mode for GSD's scripts where the layout asks
  // for one. Node walks up looking for the nearest package.json, so without it
  // a project declaring "type": "module" breaks every require() below it.
  if (layout.writeCommonJsMarker) {
    fs.writeFileSync(path.join(targetDir, 'package.json'), '{"type":"commonjs"}\n');
    console.log(`  ${green}✓${reset} Wrote package.json (CommonJS mode)`);
  }

  // Sync effort: frontmatter into the deployed agent files, post-copy. Must run
  // BEFORE writeManifest so the manifest hashes the post-sync content.
  // syncAgentEffortFrontmatter reads the engine's own runtime and returns
  // untouched for one that does not carry the feature, so it needs no gate here.
  const agentsEntry = layoutArtifacts(runtime).find(entry => entry.key === 'agents');
  if (agentsEntry) {
    const syncResult = syncAgentEffortFrontmatter(process.cwd(), artifactDir(targetDir, agentsEntry));
    if (syncResult.changes && syncResult.changes.length > 0) {
      console.log(`  ${green}✓${reset} Synced effort frontmatter (${syncResult.changes.length} agent${syncResult.changes.length === 1 ? '' : 's'} changed)`);
      // CONTEXT.md Area 4 lock: restart notice on real changes at ALL three touchpoints
      // (install, set-profile, config-set effort_overrides). Emitted on stderr —
      // keeps stdout / JSON-mode payloads clean and gives all three call sites one voice.
      const restartNotice = formatRestartNotice(syncResult.changes);
      if (restartNotice) {
        process.stderr.write(restartNotice + '\n');
      }
    }
  }

  // Merge the GSD block into the rules file the layout declares, from the
  // template the engine tree just delivered. A spec flagged local-only is
  // skipped for a global install — there is no project to merge into, so the
  // file would be created in whatever directory the installer was run from.
  if (layout.rulesFile && !(layout.rulesFile.localOnly && isGlobal)) {
    const templatePath = path.join(targetDir, engineDir, 'templates', layout.rulesFile.template);
    if (fs.existsSync(templatePath)) {
      // Resolved here rather than by the install-time post-pass: the template
      // is one file serving every runtime that declares a rules file, and the
      // block that lands in the user's file is the resolved form of it.
      const block = processTemplate(fs.readFileSync(templatePath, 'utf8'), buildContext(runtime));
      mergeProjectRules(
        rulesFilePath(runtime, targetDir),
        block,
        RUNTIMES[runtime].GSD_BLOCK_OPEN,
        RUNTIMES[runtime].GSD_BLOCK_CLOSE,
      );
      console.log(`  ${green}✓${reset} Generated ${layout.rulesFile.name}`);
    }
  }

  // Seed the runtime's own config file where the layout declares one.
  if (layout.configSeed) {
    if (seedConfigFile(path.join(targetDir, layout.configSeed.file), layout.configSeed.contents)) {
      console.log(`  ${green}✓${reset} Seeded ${layout.configSeed.file}`);
    }
  }

  if (failures.length > 0) {
    console.error(`\n  ${yellow}Installation incomplete!${reset} Failed: ${failures.join(', ')}`);
    process.exit(1);
  }

  // Resolve {{variables}} and <!-- ONLY:x --> markers in the directories the
  // layout declares. A runtime whose content is converted per file at write
  // time declares none. Path rewriting stays separate per design.
  const templateCtx = buildContext(runtime);
  for (const rel of layout.templatePassDirs || []) {
    resolveTemplateDir(path.join(targetDir, ...rel.split('/')), templateCtx);
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

  let settingsPath = null;
  let settings = null;
  let statuslineCommand = null;

  // Statusline, hooks, permissions and sandbox mode, for a runtime whose layout
  // declares a settings file.
  if (layout.settings) {
    const postToolEvent = 'PostToolUse';
    settingsPath = path.join(targetDir, 'settings.json');
    settings = readSettings(settingsPath);
    statuslineCommand = isGlobal
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
  }

  writeRuntimeMarker(targetDir, runtime);

  return { settingsPath, settings, statuslineCommand, runtime };
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
  const result = install(isGlobal);
  if (result && result.settingsPath) {
    handleStatusline(result.settings, isInteractive, (shouldInstallStatusline) => {
      finishInstall(result.settingsPath, result.settings, result.statuslineCommand, shouldInstallStatusline);
    });
  } else if (result) {
    // Copilot or other runtime without settings.json
    console.log(`\n  ${green}Done!${reset} GSD installed for ${cyan}${getRuntimeLabel(runtime)}${reset}.\n`);
  }
}

/**
 * Numbered runtime choices for the interactive prompt, in registry order.
 */
function runtimeChoiceLines() {
  return RUNTIME_IDS.map((rt, i) =>
    `  ${cyan}${i + 1}${reset}) ${getRuntimeLabel(rt)} ${dim}(${getDirName(rt)}/)${reset}`
  );
}

/**
 * Prompt for runtime selection.
 * Called FIRST in interactive flow, before location.
 * No default -- user must explicitly pick one of the numbered runtimes.
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

  console.log(`  ${yellow}Which runtime?${reset}\n\n${runtimeChoiceLines().join('\n')}\n`);

  rl.question(`  Choice: `, (answer) => {
    answered = true;
    rl.close();
    const choice = answer.trim();
    const picked = /^\d+$/.test(choice) ? RUNTIME_IDS[Number(choice) - 1] : undefined;
    if (picked) {
      callback(picked);
    } else {
      console.log(`\n  ${yellow}Invalid choice. Please enter 1-${RUNTIME_IDS.length}.${reset}\n`);
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
      console.error(`  ${yellow}Error: --runtime required. Use ${runtimeFlagHint()}${reset}`);
      process.exit(1);
    }
    uninstall(hasGlobal);
  } else if (hasGlobal || hasLocal) {
    // Non-interactive: --runtime is REQUIRED
    if (!runtime) {
      console.error(`  ${yellow}Error: --runtime required. Use ${runtimeFlagHint()}${reset}`);
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
      // Interactive flow: runtime -> location -> sandbox. Sandbox mode is seeded
      // into the settings file, so only a runtime whose layout declares one is
      // asked about it.
      promptRuntime((selectedRuntime) => {
        runtime = selectedRuntime;
        promptLocation((isGlobal) => {
          if ((RUNTIMES[runtime].layout || {}).settings) {
            const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
            askSandboxMode(rl, (enableSandbox) => {
              rl.close();
              if (!enableSandbox) {
                noSeedSandboxConfig = true;
              }
              installAndFinish(isGlobal, true);
            });
          } else {
            installAndFinish(isGlobal, true);
          }
        });
      });
    }
  }
}

module.exports = {
  convertClaudeToCopilotContent,
  convertClaudeAgentToCopilotAgent,
  convertClaudeCommandToOpencodeCommand,
  convertClaudeAgentToOpencodeAgent,
  convertContent,
  removeGsdFiles,
  layoutArtifacts,
  runtimeFlagHint,
  runtimeChoiceLines,
  getRuntimeLabel,
  getDirName,
  getConfigDirFromHome,
  getGlobalDir,
  globalHomeRelative,
  CONVERTERS,
  converterFor,
  resolveTemplateDir,
  mergeProjectRules,
  stripProjectRules,
  rulesFilePath,
  seedConfigFile,
};
