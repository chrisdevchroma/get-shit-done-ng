/**
 * Workspace — Workspace topology detection and memory helpers
 */

const fs = require('fs');
const path = require('path');
const {
  output,
  error,
  execGit,
  loadConfig,
  resolveTargetBranch,
  planningPaths,
} = require('./core.cjs');
const { DEFAULTS } = require('./defaults.cjs');
const { extractFrontmatter } = require('./frontmatter.cjs');
const { cmdDetectPlatform } = require('./commands.cjs');

// ─── Workspace topology detection ────────────────────────────────────────────

/**
 * Find the sole configured submodule that overlaps with the candidate path set.
 * Configured submodules live under `config.git.submodules.<basename>`.
 * Candidate paths are the full submodule paths from .gitmodules (e.g. 'lib-a' or 'nested/lib-a').
 * Matching is by basename (path.split('/').pop()) — same keying as the existing single-hit resolution.
 * Returns the candidate path if exactly one match, null otherwise.
 *
 * @param {object} config - Parsed .planning/config.json (may be empty / missing git.submodules)
 * @param {string[]} candidatePaths - Submodule paths to check (full paths from .gitmodules)
 * @returns {string|null} Sole matching candidate path, or null if 0 or 2+ matches
 */
function findConfiguredIntersection(config, candidatePaths) {
  const configuredBasenames = new Set(
    Object.keys(config?.git?.submodules || {}),
  );
  const intersection = (candidatePaths || []).filter((p) => {
    const basename = p.split('/').pop();
    return configuredBasenames.has(basename);
  });
  return intersection.length === 1 ? intersection[0] : null;
}

/**
 * Parse .gitmodules to extract submodule path= values.
 * @param {string} gitmodulesPath - Absolute path to .gitmodules
 * @returns {string[]} Array of submodule paths (relative to project root)
 */
function parseSubmodulePaths(gitmodulesPath) {
  try {
    const content = fs.readFileSync(gitmodulesPath, 'utf-8');
    const paths = [];
    for (const line of content.split('\n')) {
      const m = line.match(/^\s*path\s*=\s*(.+)$/);
      if (m) paths.push(m[1].trim());
    }
    return paths;
  } catch {
    return [];
  }
}

/**
 * Detect the workspace topology for the given directory.
 *
 * Detection order (first match wins):
 *   1. .gitmodules exists -> submodule
 *   2. pnpm-workspace.yaml exists -> monorepo
 *   3. package.json with workspaces field (array or object) -> monorepo
 *   4. Default -> standalone
 *
 * @param {string} cwd - Directory to inspect
 * @returns {{ type: 'submodule'|'monorepo'|'standalone', signal: string|null, submodule_paths: string[] }}
 */
function detectWorkspaceType(cwd) {
  // 1. Check for git submodules
  if (fs.existsSync(path.join(cwd, '.gitmodules'))) {
    const submodulePaths = parseSubmodulePaths(path.join(cwd, '.gitmodules'));
    return {
      type: 'submodule',
      signal: '.gitmodules',
      submodule_paths: submodulePaths,
    };
  }

  // 2. Check for pnpm workspace
  if (fs.existsSync(path.join(cwd, 'pnpm-workspace.yaml'))) {
    return {
      type: 'monorepo',
      signal: 'pnpm-workspace.yaml',
      submodule_paths: [],
    };
  }

  // 3. Check package.json for workspaces field
  const pkgPath = path.join(cwd, 'package.json');
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
      if (pkg.workspaces) {
        return {
          type: 'monorepo',
          signal: 'package.json#workspaces',
          submodule_paths: [],
        };
      }
    } catch {
      // Malformed package.json — treat as standalone
    }
  }

  // 4. Default: standalone
  return { type: 'standalone', signal: null, submodule_paths: [] };
}

// ─── Memory section generation ────────────────────────────────────────────────

/**
 * Generate the CLAUDE.md Memories section string from .claude/memory/ files.
 *
 * Reads all .md files (except MEMORY.md), extracts frontmatter description/name,
 * and builds the bullet list section.
 *
 * @param {string} cwd - Project root directory
 * @returns {string} Markdown section string, or '' if no memory directory
 */
function generateMemoriesSection(cwd) {
  const memoryDir = path.join(cwd, '.claude', 'memory');

  if (!fs.existsSync(memoryDir)) {
    return '';
  }

  let files;
  try {
    files = fs
      .readdirSync(memoryDir)
      .filter((f) => f.endsWith('.md') && f !== 'MEMORY.md')
      .sort();
  } catch {
    return '';
  }

  if (files.length === 0) {
    return '';
  }

  const bullets = files.map((filename) => {
    const filePath = path.join(memoryDir, filename);
    let description = '(no description)';
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      const fm = extractFrontmatter(content);
      if (fm.description) {
        description = fm.description;
      } else if (fm.name) {
        description = fm.name;
      }
    } catch {
      // Use fallback description
    }
    return `- [.claude/memory/${filename}](.claude/memory/${filename}) — ${description}`;
  });

  return [
    '## Memories',
    '',
    'Read `.claude/memory/` for persistent feedback and project context. Key entries:',
    '',
    ...bullets,
  ].join('\n');
}

/**
 * Generate the MEMORY.md content string from .claude/memory/ files.
 *
 * Groups files by their frontmatter `type` field. Capitalizes group headings.
 * Filters out MEMORY.md itself.
 *
 * @param {string} cwd - Project root directory
 * @returns {string} MEMORY.md content string, or '' if no qualifying files
 */
function generateMemoryMd(cwd) {
  const memoryDir = path.join(cwd, '.claude', 'memory');

  if (!fs.existsSync(memoryDir)) {
    return '';
  }

  let files;
  try {
    files = fs
      .readdirSync(memoryDir)
      .filter((f) => f.endsWith('.md') && f !== 'MEMORY.md')
      .sort();
  } catch {
    return '';
  }

  if (files.length === 0) {
    return '';
  }

  // Build groups
  const groups = {};
  for (const filename of files) {
    const filePath = path.join(memoryDir, filename);
    let description = '(no description)';
    let groupName = 'Other';
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      const fm = extractFrontmatter(content);
      if (fm.description) {
        description = fm.description;
      } else if (fm.name) {
        description = fm.name;
      }
      if (fm.type) {
        // Capitalize first letter of type for the group heading
        groupName = fm.type.charAt(0).toUpperCase() + fm.type.slice(1);
      }
    } catch {
      // Use defaults
    }

    if (!groups[groupName]) {
      groups[groupName] = [];
    }
    groups[groupName].push({ filename, description });
  }

  /* c8 ignore next 3 — unreachable: groups is populated by the loop above whenever files.length > 0, which is already guarded earlier */
  if (Object.keys(groups).length === 0) {
    return '';
  }

  const lines = ['# Memory Index'];
  for (const [groupName, entries] of Object.entries(groups)) {
    lines.push('');
    lines.push(`## ${groupName}`);
    for (const { filename, description } of entries) {
      lines.push(`- [${filename}](${filename}) — ${description}`);
    }
  }

  return lines.join('\n');
}

// ─── Memory template seeding ─────────────────────────────────────────────────

/**
 * Copy a memory template file to the target directory with the given filename.
 *
 * Creates the target directory if it doesn't exist.
 *
 * @param {string} templatePath - Absolute path to the source template file
 * @param {string} targetDir - Directory to seed the memory into
 * @param {string} filename - Filename for the output file
 * @returns {{ seeded: true, path: string } | { seeded: false, reason: string }}
 */
function seedMemoryTemplate(templatePath, targetDir, filename) {
  if (!fs.existsSync(templatePath)) {
    return { seeded: false, reason: 'template not found' };
  }

  try {
    fs.mkdirSync(targetDir, { recursive: true });
    const outputPath = path.join(targetDir, filename);
    fs.copyFileSync(templatePath, outputPath);
    return { seeded: true, path: outputPath };
  } catch (err) {
    return { seeded: false, reason: err.message };
  }
}

// ─── Git context resolution ───────────────────────────────────────────────────

/**
 * Resolve the git context for the current workspace. Handles standalone,
 * submodule (single), and submodule (multiple / ambiguous) workspace types.
 *
 * Returns a resolved object with remote, branch, platform and routing metadata
 * so git-touching workflows can operate on the correct repository.
 *
 * @param {string} cwd - Project root directory
 * @returns {object} Resolved git context object
 */
function resolveGitContext(cwd) {
  const { type, submodule_paths: submodulePaths } = detectWorkspaceType(cwd);

  // ── Standalone workspace ───────────────────────────────────────────────────
  if (type !== 'submodule' || submodulePaths.length === 0) {
    const config = loadConfig(cwd);
    const remote = config.remote || 'origin';
    const targetBranch = resolveTargetBranch(config);

    const remoteResult = execGit(cwd, ['remote', 'get-url', remote]);
    const remoteUrl =
      remoteResult.exitCode === 0 ? remoteResult.stdout || null : null;

    const branchResult = execGit(cwd, ['branch', '--show-current']);
    const currentBranch =
      branchResult.exitCode === 0 ? branchResult.stdout || null : null;

    const sshUrl = Boolean(
      remoteUrl &&
      (remoteUrl.startsWith('git@') || remoteUrl.startsWith('ssh://')),
    );

    const platformInfo = cmdDetectPlatform(cwd, remote, true) || {};

    return {
      is_submodule: false,
      submodule_path: null,
      git_cwd: cwd,
      remote,
      remote_url: remoteUrl,
      ssh_url: sshUrl,
      target_branch: targetBranch,
      current_branch: currentBranch,
      ambiguous: false,
      ambiguous_paths: [],
      platform: platformInfo.platform || null,
      cli: platformInfo.cli || null,
      cli_installed: platformInfo.cli_installed || false,
      cli_install_url: platformInfo.cli_install_url || null,
    };
  }

  // ── Submodule workspace ────────────────────────────────────────────────────

  // Load config once for both ambiguity disambiguation and the eventual
  // single-hit per-submodule override merge below.
  let parsedConfig = {};
  try {
    const pp = planningPaths(cwd);
    const rawConfig = fs.readFileSync(pp.config, 'utf-8');
    parsedConfig = JSON.parse(rawConfig);
  } catch {
    parsedConfig = {};
  }

  // Detect which submodule(s) have changes in the workspace diff
  const headDiff = execGit(cwd, ['diff', '--name-only', 'HEAD']);
  const cachedDiff = execGit(cwd, ['diff', '--cached', '--name-only']);

  const changedFiles = [
    ...(headDiff.exitCode === 0 && headDiff.stdout
      ? headDiff.stdout.split('\n').filter(Boolean)
      : []),
    ...(cachedDiff.exitCode === 0 && cachedDiff.stdout
      ? cachedDiff.stdout.split('\n').filter(Boolean)
      : []),
  ];

  let hitPaths = submodulePaths.filter((sp) =>
    changedFiles.some((f) => f === sp || f.startsWith(sp + '/')),
  );

  // Multiple submodules dirty — try to disambiguate via per-submodule config.
  if (hitPaths.length > 1) {
    const sole = findConfiguredIntersection(parsedConfig, hitPaths);
    if (sole) {
      // Exactly one of the dirty submodules is configured; pick it and
      // fall through to single-hit resolution below.
      hitPaths = [sole];
    } else {
      // Either zero configured submodules among the dirty ones (real ambiguity)
      // or 2+ configured (multi-config — still ambiguous, surface configured set).
      const configuredBasenames = Object.keys(
        parsedConfig?.git?.submodules || {},
      );
      const ambiguousList =
        configuredBasenames.length > 1 ? configuredBasenames : hitPaths;
      return {
        is_submodule: true,
        submodule_path: null,
        git_cwd: null,
        remote: null,
        remote_url: null,
        ssh_url: false,
        target_branch: null,
        current_branch: null,
        ambiguous: true,
        ambiguous_paths: ambiguousList,
        platform: null,
        cli: null,
        cli_installed: false,
        cli_install_url: null,
      };
    }
  }

  // Clean tree, multiple submodules — disambiguate via per-submodule config.
  if (submodulePaths.length > 1 && hitPaths.length === 0) {
    const sole = findConfiguredIntersection(parsedConfig, submodulePaths);
    if (sole) {
      hitPaths = [sole];
    } else {
      const configuredBasenames = Object.keys(
        parsedConfig?.git?.submodules || {},
      );
      const ambiguousList =
        configuredBasenames.length > 1 ? configuredBasenames : submodulePaths;
      return {
        is_submodule: true,
        submodule_path: null,
        git_cwd: null,
        remote: null,
        remote_url: null,
        ssh_url: false,
        target_branch: null,
        current_branch: null,
        ambiguous: true,
        ambiguous_paths: ambiguousList,
        platform: null,
        cli: null,
        cli_installed: false,
        cli_install_url: null,
      };
    }
  }

  // Resolve active submodule: matched submodule or fallback to first
  const activePath = hitPaths[0] || submodulePaths[0];
  const subCwd = path.join(cwd, activePath);

  // Read submodule config overrides from already-parsed .planning/config.json
  let configSubmodule = {};
  try {
    const globalGit = parsedConfig.git || {};
    const submoduleName = activePath ? activePath.split('/').pop() : null;
    const perSubmodule =
      (submoduleName &&
        globalGit.submodules &&
        globalGit.submodules[submoduleName]) ||
      {};
    // Merged: global git fields as base, per-submodule overrides on top
    configSubmodule = { ...globalGit, ...perSubmodule };
    /* c8 ignore next 3 — unreachable: parsedConfig is plain JSON.parse output; property access on .git/.submodules cannot throw without internal mocking */
  } catch {
    // Defaults — parsedConfig is empty when config missing or malformed
  }

  const remote = configSubmodule.remote || 'origin';

  const remoteResult = execGit(subCwd, ['remote', 'get-url', remote]);
  const remoteUrl =
    remoteResult.exitCode === 0 ? remoteResult.stdout || null : null;

  const branchResult = execGit(subCwd, ['branch', '--show-current']);
  const currentBranch =
    branchResult.exitCode === 0 ? branchResult.stdout || null : null;

  // Resolve target branch: config override > git tracking > fallback 'main'
  let targetBranch = resolveTargetBranch(parsedConfig, {
    overrides: configSubmodule,
    fallback: null,
  });
  if (!targetBranch && currentBranch) {
    const mergeResult = execGit(subCwd, [
      'config',
      `branch.${currentBranch}.merge`,
    ]);
    if (mergeResult.exitCode === 0 && mergeResult.stdout) {
      targetBranch = mergeResult.stdout.replace(/^refs\/heads\//, '') || null;
    }
  }
  if (!targetBranch) {
    targetBranch = 'main';
  }

  const sshUrl = Boolean(
    remoteUrl &&
    (remoteUrl.startsWith('git@') || remoteUrl.startsWith('ssh://')),
  );

  // Pass per-submodule platform override so loadConfig(subCwd) is bypassed (no .planning/ there).
  const platformInfo =
    cmdDetectPlatform(subCwd, remote, true, configSubmodule.platform || null) ||
    {};

  return {
    is_submodule: true,
    submodule_path: activePath,
    git_cwd: subCwd,
    remote,
    remote_url: remoteUrl,
    ssh_url: sshUrl,
    target_branch: targetBranch,
    current_branch: currentBranch,
    ambiguous: false,
    ambiguous_paths: [],
    platform: platformInfo.platform || null,
    cli: platformInfo.cli || null,
    cli_installed: platformInfo.cli_installed || false,
    cli_install_url: platformInfo.cli_install_url || null,
    branching_strategy: configSubmodule.branching_strategy || 'none',
    auto_push:
      configSubmodule.auto_push !== undefined
        ? configSubmodule.auto_push
        : false,
    phase_branch_template:
      configSubmodule.phase_branch_template || DEFAULTS.phase_branch_template,
    milestone_branch_template:
      configSubmodule.milestone_branch_template ||
      DEFAULTS.milestone_branch_template,
    review_branch_template: configSubmodule.review_branch_template || null,
    pr_draft:
      configSubmodule.pr_draft !== undefined ? configSubmodule.pr_draft : true,
    pr_template: configSubmodule.pr_template || null,
    type_aliases: configSubmodule.type_aliases || null,
  };
}

// ─── CLI commands ─────────────────────────────────────────────────────────────

/**
 * CLI wrapper for detectWorkspaceType. Outputs JSON via output().
 *
 * @param {string} cwd - Working directory
 * @param {boolean} silent - If true, return result without calling output()
 */
function cmdDetectWorkspace(cwd, silent) {
  const result = detectWorkspaceType(cwd);
  if (silent) return result;
  output(result);
}

/**
 * CLI wrapper for resolveGitContext. Outputs JSON via output().
 *
 * @param {string} cwd - Working directory
 * @param {boolean} silent - If true, return result without calling output()
 */
function cmdGitContext(cwd, silent) {
  const result = resolveGitContext(cwd);
  if (silent) return result;
  output(result);
}

/**
 * Check SSH agent status for a given remote URL.
 * Returns structured JSON with ssh_required, agent_running, status, message.
 *
 * @param {string} remoteUrl - The git remote URL to check
 * @param {boolean} silent - If true, return result without output()/process.exit()
 */
function cmdSshCheck(remoteUrl, silent) {
  const sshRequired = !!(
    remoteUrl &&
    (remoteUrl.startsWith('git@') || remoteUrl.startsWith('ssh://'))
  );

  if (!sshRequired) {
    const result = {
      ssh_required: false,
      agent_running: false,
      status: 'not_required',
      message: 'Remote does not use SSH',
    };
    if (silent) return result;
    output(result);
    return;
  }

  let agentRunning = false;
  let status = 'agent_not_running';
  let message = 'SSH agent is not running';

  try {
    const { execSync } = require('child_process');
    execSync('ssh-add -l', {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    // Exit code 0: identities loaded
    agentRunning = true;
    status = 'ok';
    message = 'SSH agent has identities loaded';
  } catch (err) {
    if (err.status === 1) {
      // Exit code 1: agent running but no identities
      agentRunning = true;
      status = 'no_identities';
      message =
        'SSH agent is running but no identities are loaded. Run: ssh-add';
    } else {
      // Exit code 2 or stderr contains agent socket error: agent not running
      const stderr = (err.stderr || '').toString();
      if (
        err.status === 2 ||
        stderr.includes('Could not open') ||
        stderr.includes('not open')
      ) {
        status = 'agent_not_running';
        message =
          'SSH agent is not running. Run: eval "$(ssh-agent -s)" && ssh-add';
      } else {
        status = 'agent_not_running';
        message = 'SSH agent check failed: ' + (stderr || err.message);
      }
    }
  }

  const result = {
    ssh_required: true,
    agent_running: agentRunning,
    status,
    message,
  };
  if (silent) return result;
  output(result);
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  detectWorkspaceType,
  findConfiguredIntersection,
  generateMemoriesSection,
  generateMemoryMd,
  seedMemoryTemplate,
  cmdDetectWorkspace,
  resolveGitContext,
  cmdGitContext,
  cmdSshCheck,
};
