/**
 * Core — Shared utilities, constants, and internal helpers
 */

const fs = require('fs');
const path = require('path');
const { execSync, execFileSync, spawnSync } = require('child_process');
const { MODEL_PROFILES, EFFORT_PROFILES } = require('./model-profiles.cjs');
const { DEFAULTS, WORKFLOW_DEFAULTS } = require('./defaults.cjs');

// ─── Path helpers ────────────────────────────────────────────────────────────

/** Normalize a relative path to always use forward slashes (cross-platform). */
function toPosixPath(p) {
  return p.split(path.sep).join('/');
}

/**
 * Return a flat object containing all common .planning/ subpaths for a given cwd.
 * Call once per function entry and destructure the properties needed.
 * @param {string} cwd - project root directory
 * @returns {{ root, phases, config, state, roadmap, requirements, todos, todosPending, todosCompleted, codebase, divergence, milestones, milestonesFile, project, archive }}
 */
function planningPaths(cwd) {
  const root = path.join(cwd, '.planning');
  return {
    root,
    phases: path.join(root, 'phases'),
    config: path.join(root, 'config.json'),
    state: path.join(root, 'STATE.md'),
    roadmap: path.join(root, 'ROADMAP.md'),
    requirements: path.join(root, 'REQUIREMENTS.md'),
    todos: path.join(root, 'todos'),
    todosPending: path.join(root, 'todos', 'pending'),
    todosCompleted: path.join(root, 'todos', 'completed'),
    codebase: path.join(root, 'codebase'),
    divergence: path.join(root, 'DIVERGENCE.md'),
    milestones: path.join(root, 'milestones'),
    milestonesFile: path.join(root, 'MILESTONES.md'),
    project: path.join(root, 'PROJECT.md'),
    archive: path.join(root, 'archive'),
  };
}

// ─── Output helpers ───────────────────────────────────────────────────────────

/**
 * Remove stale gsd-* temp files/dirs older than maxAgeMs (default: 5 minutes).
 * Runs opportunistically before each new temp file write to prevent unbounded accumulation.
 * @param {string} prefix - filename prefix to match (e.g., 'gsd-')
 * @param {object} opts
 * @param {number} opts.maxAgeMs - max age in ms before removal (default: 5 min)
 * @param {boolean} opts.dirsOnly - if true, only remove directories (default: false)
 */
function reapStaleTempFiles(
  prefix = 'gsd-',
  { maxAgeMs = 5 * 60 * 1000, dirsOnly = false } = {},
) {
  try {
    const tmpDir = require('os').tmpdir();
    const now = Date.now();
    const entries = fs.readdirSync(tmpDir);
    for (const entry of entries) {
      if (!entry.startsWith(prefix)) continue;
      const fullPath = path.join(tmpDir, entry);
      try {
        const stat = fs.statSync(fullPath);
        if (now - stat.mtimeMs < maxAgeMs) continue;
        if (dirsOnly && !stat.isDirectory()) continue;
        if (stat.isDirectory()) {
          fs.rmSync(fullPath, { recursive: true, force: true });
        } else {
          fs.unlinkSync(fullPath);
        }
      } catch {
        // skip files we can't stat or delete
      }
    }
  } catch {
    // non-critical: cleanup failures never break output
  }
}

// Module-level file output flag: when true, output() writes large payloads to
// a temp file prefixed with @file:. Off by default -- inline is the standard path.
// Activated via --file global flag in gsd-tools.cjs.
let _fileOutput = false;
function setFileOutput(val) {
  _fileOutput = val;
}

// Module-level JSON mode flag: when true, output() always emits JSON regardless
// of displayValue. Activated via --json global flag or --pick in gsd-tools.cjs.
let _jsonMode = false;
function setJsonMode(val) {
  _jsonMode = val;
}

/**
 * Write JSON to a temp file and return the @file: prefixed path.
 * Factored out to avoid duplication between _jsonMode and auto-JSON paths.
 */
function writeToTempFile(json) {
  reapStaleTempFiles();
  let tmpDir = require('os').tmpdir();
  try {
    fs.mkdirSync(tmpDir, { recursive: true });
  } catch {
    // os.tmpdir() directory may not be writable (e.g. sandbox sets TMPDIR=/tmp/claude
    // but /tmp is restricted). Fall back to a known-writable sibling directory.
    const uid = process.getuid();
    tmpDir = path.join(path.dirname(tmpDir), path.basename(tmpDir) + '-' + uid);
    fs.mkdirSync(tmpDir, { recursive: true });
  }
  const tmpPath = path.join(tmpDir, `gsd-${Date.now()}.json`);
  fs.writeFileSync(tmpPath, json, 'utf-8');
  return '@file:' + tmpPath;
}

function output(result, displayValue) {
  let data;
  if (_jsonMode) {
    // --json flag: always JSON, ignore displayValue
    const json = JSON.stringify(result, null, 2);
    data = _fileOutput ? writeToTempFile(json) : json;
  } else if (displayValue !== undefined) {
    // displayValue provided: emit as string (NO _fileOutput for scalar output)
    data = String(displayValue);
  } else if (result !== null && typeof result === 'object') {
    // Object/array with no displayValue: auto-JSON
    const json = JSON.stringify(result, null, 2);
    data = _fileOutput ? writeToTempFile(json) : json;
  } else {
    // Scalar with no displayValue: stringify
    data = String(result);
  }
  // process.stdout.write() is async when stdout is a pipe — process.exit()
  // can tear down the process before the reader consumes the buffer.
  // fs.writeSync(1, ...) blocks until the kernel accepts the bytes, and
  // skipping process.exit() lets the event loop drain naturally.
  try {
    fs.writeSync(1, data);
  } catch (e) {
    if (e.code !== 'EPIPE') throw e;
    // EPIPE: pipe reader closed early — data was buffered, safe to ignore
  }
}

function error(message) {
  fs.writeSync(2, 'Error: ' + message + '\n');
  process.exit(1);
}

// ─── File & Config utilities ──────────────────────────────────────────────────

function safeReadFile(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }
}

function loadConfig(cwd) {
  const { config: configPath } = planningPaths(cwd);
  const defaults = {
    ...DEFAULTS,
    research: WORKFLOW_DEFAULTS.research,
    plan_checker: WORKFLOW_DEFAULTS.plan_check,
    verifier: WORKFLOW_DEFAULTS.verifier,
    nyquist_validation: WORKFLOW_DEFAULTS.nyquist_validation,
  };

  try {
    const raw = fs.readFileSync(configPath, 'utf-8');
    const parsed = JSON.parse(raw);

    // Migrate deprecated "depth" key to "granularity" with value mapping
    if ('depth' in parsed && !('granularity' in parsed)) {
      const depthToGranularity = {
        quick: 'coarse',
        standard: 'standard',
        comprehensive: 'fine',
      };
      parsed.granularity = depthToGranularity[parsed.depth] || parsed.depth;
      delete parsed.depth;
      try {
        fs.writeFileSync(configPath, JSON.stringify(parsed, null, 2), 'utf-8');
      } catch {}
    }

    const get = (key, nested) => {
      if (parsed[key] !== undefined) return parsed[key];
      if (
        nested &&
        parsed[nested.section] &&
        parsed[nested.section][nested.field] !== undefined
      ) {
        return parsed[nested.section][nested.field];
      }
      return undefined;
    };

    const parallelization = (() => {
      const val = get('parallelization');
      if (typeof val === 'boolean') return val;
      if (typeof val === 'object' && val !== null && 'enabled' in val)
        return val.enabled;
      return defaults.parallelization;
    })();

    return {
      model_profile: get('model_profile') ?? defaults.model_profile,
      commit_docs: (() => {
        const explicit = get('commit_docs', {
          section: 'planning',
          field: 'commit_docs',
        });
        // If explicitly set in config, respect the user's choice
        if (explicit !== undefined) return explicit;
        // Auto-detection: when no explicit value and .planning/ is gitignored,
        // default to false instead of true
        if (isGitIgnored(cwd, '.planning/')) return false;
        return defaults.commit_docs;
      })(),
      search_gitignored:
        get('search_gitignored', {
          section: 'planning',
          field: 'search_gitignored',
        }) ?? defaults.search_gitignored,
      branching_strategy:
        get('branching_strategy', {
          section: 'git',
          field: 'branching_strategy',
        }) ?? defaults.branching_strategy,
      phase_branch_template:
        get('phase_branch_template', {
          section: 'git',
          field: 'phase_branch_template',
        }) ?? defaults.phase_branch_template,
      milestone_branch_template:
        get('milestone_branch_template', {
          section: 'git',
          field: 'milestone_branch_template',
        }) ?? defaults.milestone_branch_template,
      target_branch:
        get('target_branch', { section: 'git', field: 'target_branch' }) ??
        defaults.target_branch,
      auto_push:
        get('auto_push', { section: 'git', field: 'auto_push' }) ??
        defaults.auto_push,
      remote:
        get('remote', { section: 'git', field: 'remote' }) ?? defaults.remote,
      review_branch_template:
        get('review_branch_template', {
          section: 'git',
          field: 'review_branch_template',
        }) ?? defaults.review_branch_template,
      pr_draft:
        get('pr_draft', { section: 'git', field: 'pr_draft' }) ??
        defaults.pr_draft,
      platform:
        get('platform', { section: 'git', field: 'platform' }) ??
        defaults.platform,
      commit_format:
        get('commit_format', { section: 'git', field: 'commit_format' }) ??
        defaults.commit_format,
      commit_template:
        get('commit_template', { section: 'git', field: 'commit_template' }) ??
        defaults.commit_template,
      versioning_scheme:
        get('versioning_scheme', {
          section: 'git',
          field: 'versioning_scheme',
        }) ?? defaults.versioning_scheme,
      research:
        get('research', { section: 'workflow', field: 'research' }) ??
        defaults.research,
      plan_checker:
        get('plan_checker', { section: 'workflow', field: 'plan_check' }) ??
        defaults.plan_checker,
      verifier:
        get('verifier', { section: 'workflow', field: 'verifier' }) ??
        defaults.verifier,
      nyquist_validation:
        get('nyquist_validation', {
          section: 'workflow',
          field: 'nyquist_validation',
        }) ?? defaults.nyquist_validation,
      parallelization,
      model_overrides: parsed.model_overrides || null,
      effort_overrides: parsed.effort_overrides || null,
    };
  } catch {
    return defaults;
  }
}

function getEngineRuntime() {
  // GSD_TEST_RUNTIME_MARKER_DIR: test-only override of the marker location.
  const markerDir =
    process.env.GSD_TEST_RUNTIME_MARKER_DIR || path.join(__dirname, '..', '..');
  try {
    const val = fs
      .readFileSync(path.join(markerDir, '.runtime'), 'utf-8')
      .trim();
    return val === 'copilot' ? 'copilot' : 'claude';
  } catch {
    return 'claude'; // marker absent → default to claude
  }
}

// ─── Git utilities ────────────────────────────────────────────────────────────

function isGitIgnored(cwd, targetPath) {
  try {
    // --no-index checks .gitignore rules regardless of whether the file is tracked.
    // Without it, git check-ignore returns "not ignored" for tracked files even when
    // .gitignore explicitly lists them — a common source of confusion when .planning/
    // was committed before being added to .gitignore.
    // Use execFileSync with array args to prevent command injection via path values.
    execFileSync(
      'git',
      ['check-ignore', '-q', '--no-index', '--', targetPath],
      {
        cwd,
        stdio: 'pipe',
      },
    );
    return true;
  } catch {
    return false;
  }
}

function execGit(cwd, args) {
  const result = spawnSync('git', args, {
    cwd,
    stdio: 'pipe',
    encoding: 'utf-8',
  });
  return {
    exitCode: result.status ?? 1,
    stdout: (result.stdout ?? '').toString().trim(),
    stderr: (result.stderr ?? '').toString().trim(),
  };
}

// ─── Phase utilities ──────────────────────────────────────────────────────────

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizePhaseName(phase) {
  const match = String(phase).match(/^(\d+)([A-Z])?((?:\.\d+)*)/i);
  if (!match) return phase;
  const padded = match[1].padStart(2, '0');
  const letter = match[2] ? match[2].toUpperCase() : '';
  const decimal = match[3] || '';
  return padded + letter + decimal;
}

function comparePhaseNum(a, b) {
  const pa = String(a).match(/^(\d+)([A-Z])?((?:\.\d+)*)/i);
  const pb = String(b).match(/^(\d+)([A-Z])?((?:\.\d+)*)/i);
  if (!pa || !pb) return String(a).localeCompare(String(b));
  const intDiff = parseInt(pa[1], 10) - parseInt(pb[1], 10);
  if (intDiff !== 0) return intDiff;
  // No letter sorts before letter: 12 < 12A < 12B
  const la = (pa[2] || '').toUpperCase();
  const lb = (pb[2] || '').toUpperCase();
  if (la !== lb) {
    if (!la) return -1;
    if (!lb) return 1;
    return la < lb ? -1 : 1;
  }
  // Segment-by-segment decimal comparison: 12A < 12A.1 < 12A.1.2 < 12A.2
  const aDecParts = pa[3]
    ? pa[3]
        .slice(1)
        .split('.')
        .map((p) => parseInt(p, 10))
    : [];
  const bDecParts = pb[3]
    ? pb[3]
        .slice(1)
        .split('.')
        .map((p) => parseInt(p, 10))
    : [];
  const maxLen = Math.max(aDecParts.length, bDecParts.length);
  if (aDecParts.length === 0 && bDecParts.length > 0) return -1;
  if (bDecParts.length === 0 && aDecParts.length > 0) return 1;
  for (let i = 0; i < maxLen; i++) {
    const av = Number.isFinite(aDecParts[i]) ? aDecParts[i] : 0;
    const bv = Number.isFinite(bDecParts[i]) ? bDecParts[i] : 0;
    if (av !== bv) return av - bv;
  }
  return 0;
}

function searchPhaseInDir(baseDir, relBase, normalized) {
  try {
    const entries = fs.readdirSync(baseDir, { withFileTypes: true });
    const dirs = entries
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort((a, b) => comparePhaseNum(a, b));
    const match = dirs.find((d) => d.startsWith(normalized));
    if (!match) return null;

    const dirMatch = match.match(/^(\d+[A-Z]?(?:\.\d+)*)-?(.*)/i);
    const phaseNumber = dirMatch ? dirMatch[1] : normalized;
    const phaseName = dirMatch && dirMatch[2] ? dirMatch[2] : null;
    const phaseDir = path.join(baseDir, match);
    const phaseFiles = fs.readdirSync(phaseDir);

    const plans = phaseFiles
      .filter((f) => f.endsWith('-PLAN.md') || f === 'PLAN.md')
      .sort();
    const summaries = phaseFiles
      .filter((f) => f.endsWith('-SUMMARY.md') || f === 'SUMMARY.md')
      .sort();
    const hasResearch = phaseFiles.some(
      (f) =>
        (f.endsWith('-RESEARCH.md') && !f.endsWith('-GAP-RESEARCH.md')) ||
        f === 'RESEARCH.md',
    );
    const hasContext = phaseFiles.some(
      (f) => f.endsWith('-CONTEXT.md') || f === 'CONTEXT.md',
    );
    const hasVerification = phaseFiles.some(
      (f) => f.endsWith('-VERIFICATION.md') || f === 'VERIFICATION.md',
    );

    const completedPlanIds = new Set(
      summaries.map((s) =>
        s.replace('-SUMMARY.md', '').replace('SUMMARY.md', ''),
      ),
    );
    const incompletePlans = plans.filter((p) => {
      const planId = p.replace('-PLAN.md', '').replace('PLAN.md', '');
      return !completedPlanIds.has(planId);
    });

    return {
      found: true,
      directory: toPosixPath(path.join(relBase, match)),
      phase_number: phaseNumber,
      phase_name: phaseName,
      phase_slug: phaseName
        ? phaseName
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-+|-+$/g, '')
        : null,
      plans,
      summaries,
      incomplete_plans: incompletePlans,
      has_research: hasResearch,
      has_context: hasContext,
      has_verification: hasVerification,
    };
  } catch {
    return null;
  }
}

function findPhaseInternal(cwd, phase) {
  if (!phase) return null;

  const { phases: phasesDir, milestones: milestonesDir } = planningPaths(cwd);
  const normalized = normalizePhaseName(phase);

  // Search current phases first
  const current = searchPhaseInDir(phasesDir, '.planning/phases', normalized);
  if (current) return current;

  // Search archived milestone phases (newest first)
  if (!fs.existsSync(milestonesDir)) return null;

  try {
    const milestoneEntries = fs.readdirSync(milestonesDir, {
      withFileTypes: true,
    });
    const archiveDirs = milestoneEntries
      .filter((e) => e.isDirectory() && /^v[\d.]+-phases$/.test(e.name))
      .map((e) => e.name)
      .sort()
      .reverse();

    for (const archiveName of archiveDirs) {
      const version = archiveName.match(/^(v[\d.]+)-phases$/)[1];
      const archivePath = path.join(milestonesDir, archiveName);
      const relBase = '.planning/milestones/' + archiveName;
      const result = searchPhaseInDir(archivePath, relBase, normalized);
      if (result) {
        result.archived = version;
        return result;
      }
    }
  } catch {}

  return null;
}

function getArchivedPhaseDirs(cwd) {
  const { milestones: milestonesDir } = planningPaths(cwd);
  const results = [];

  if (!fs.existsSync(milestonesDir)) return results;

  try {
    const milestoneEntries = fs.readdirSync(milestonesDir, {
      withFileTypes: true,
    });
    // Find v*-phases directories, sort newest first
    const phaseDirs = milestoneEntries
      .filter((e) => e.isDirectory() && /^v[\d.]+-phases$/.test(e.name))
      .map((e) => e.name)
      .sort()
      .reverse();

    for (const archiveName of phaseDirs) {
      const version = archiveName.match(/^(v[\d.]+)-phases$/)[1];
      const archivePath = path.join(milestonesDir, archiveName);
      const entries = fs.readdirSync(archivePath, { withFileTypes: true });
      const dirs = entries
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
        .sort((a, b) => comparePhaseNum(a, b));

      for (const dir of dirs) {
        results.push({
          name: dir,
          milestone: version,
          basePath: path.join('.planning', 'milestones', archiveName),
          fullPath: path.join(archivePath, dir),
        });
      }
    }
  } catch {}

  return results;
}

// ─── Roadmap milestone scoping ───────────────────────────────────────────────

/**
 * Extract the current (active) milestone content from ROADMAP.md.
 * Strips shipped milestone sections wrapped in <details> blocks.
 * Returns the remaining content which is the active milestone.
 */
function extractCurrentMilestone(content) {
  return content.replace(/<details>[\s\S]*?<\/details>/gi, '');
}

/**
 * Replace a pattern only in the current milestone section of ROADMAP.md
 * (everything after the last </details> close tag). Used for write operations
 * that must not accidentally modify archived milestone checkboxes/tables.
 */
function replaceInCurrentMilestone(content, pattern, replacement) {
  const lastDetailsClose = content.lastIndexOf('</details>');
  if (lastDetailsClose === -1) {
    return content.replace(pattern, replacement);
  }
  const offset = lastDetailsClose + '</details>'.length;
  const before = content.slice(0, offset);
  const after = content.slice(offset);
  return before + after.replace(pattern, replacement);
}

// ─── Roadmap & model utilities ────────────────────────────────────────────────

function getRoadmapPhaseInternal(cwd, phaseNum) {
  if (!phaseNum) return null;
  const { roadmap: roadmapPath } = planningPaths(cwd);
  if (!fs.existsSync(roadmapPath)) return null;

  try {
    const content = extractCurrentMilestone(
      fs.readFileSync(roadmapPath, 'utf-8'),
    );
    const escapedPhase = escapeRegex(phaseNum.toString());
    const phasePattern = new RegExp(
      `#{2,4}\\s*Phase\\s+${escapedPhase}:\\s*([^\\n]+)`,
      'i',
    );
    const headerMatch = content.match(phasePattern);
    if (!headerMatch) return null;

    const phaseName = headerMatch[1].trim();
    const headerIndex = headerMatch.index;
    const restOfContent = content.slice(headerIndex);
    const nextHeaderMatch = restOfContent.match(
      /\n#{2,4}\s+Phase\s+\d+[A-Z]?(?:\.\d+)*/i,
    );
    const sectionEnd = nextHeaderMatch
      ? headerIndex + nextHeaderMatch.index
      : content.length;
    const section = content.slice(headerIndex, sectionEnd).trim();

    const goalMatch = section.match(
      /\*\*Goal(?:\*\*:|\*?\*?:\*\*)\s*([^\n]+)/i,
    );
    const goal = goalMatch ? goalMatch[1].trim() : null;

    return {
      found: true,
      phase_number: phaseNum.toString(),
      phase_name: phaseName,
      goal,
      section,
    };
  } catch {
    return null;
  }
}

function resolveModelInternal(cwd, agentType) {
  const config = loadConfig(cwd);

  // Check per-agent override first
  const override = config.model_overrides?.[agentType];
  if (override) {
    return override;
  }

  // Fall back to profile lookup
  const profile = config.model_profile || 'balanced';
  const agentModels = MODEL_PROFILES[agentType];
  if (!agentModels) return 'sonnet';
  if (profile === 'inherit') return null;
  return agentModels[profile] || agentModels['balanced'] || 'sonnet';
}

function resolveEffortInternal(cwd, agentType) {
  const config = loadConfig(cwd);

  // Non-Claude runtimes do not support effort: frontmatter — skip silently.
  if (getEngineRuntime() !== 'claude') {
    return null;
  }

  // Resolve effort from override or profile (unchanged logic).
  const hasExplicitOverride = Object.prototype.hasOwnProperty.call(
    config.effort_overrides || {},
    agentType,
  );
  let effort;
  if (hasExplicitOverride) {
    const override = config.effort_overrides[agentType];
    effort = override === 'inherit' ? null : override;
  } else {
    const profile = config.model_profile || 'balanced';
    const agentEfforts = EFFORT_PROFILES[agentType];
    if (!agentEfforts) return null;
    const profileEffort = agentEfforts[profile];
    effort =
      !profileEffort || profileEffort === 'inherit' ? null : profileEffort;
  }

  // Model-tier compatibility: haiku does not support effort at all; xhigh and max
  // are high reasoning tiers. When the resolved model is known and incompatible
  // with the resolved effort, suppress (return null) and warn only on explicit
  // overrides.
  // resolveModelInternal returns null for session-inherit — leave those alone.
  //
  // These are the bare aliases the harness resolves (opus→Opus 4.8,
  // sonnet→Sonnet 5, fable→Fable 5), all of which accept xhigh/max. A model
  // string outside this set — e.g. a version-pinned `sonnet-4-6` via
  // model_overrides — is treated as unsupported, since xhigh did not exist
  // below the Opus tier before Sonnet 5.
  const HIGH_TIER_EFFORT_MODELS = ['opus', 'fable', 'sonnet'];
  const resolvedModel = resolveModelInternal(cwd, agentType);
  const haikuSkip = resolvedModel === 'haiku';
  const highEffortSkip =
    resolvedModel &&
    !HIGH_TIER_EFFORT_MODELS.includes(resolvedModel) &&
    (effort === 'xhigh' || effort === 'max');
  if (haikuSkip || highEffortSkip) {
    if (hasExplicitOverride && effort !== null) {
      const overrideValue = config.effort_overrides[agentType];
      const reason = haikuSkip
        ? 'haiku does not support effort: frontmatter'
        : `${effort} requires opus, fable, or sonnet (resolved model: ${resolvedModel})`;
      fs.writeSync(
        2,
        `Warning: effort_overrides.${agentType}="${overrideValue}" ignored — ${reason}\n`,
      );
    }
    return null;
  }

  return effort;
}

// ─── Misc utilities ───────────────────────────────────────────────────────────

function pathExistsInternal(cwd, targetPath) {
  const fullPath = path.isAbsolute(targetPath)
    ? targetPath
    : path.join(cwd, targetPath);
  try {
    fs.statSync(fullPath);
    return true;
  } catch {
    return false;
  }
}

function readTextArgOrFile(cwd, value, filePath, label) {
  if (!filePath) return value;

  const resolvedPath = path.isAbsolute(filePath)
    ? filePath
    : path.join(cwd, filePath);
  try {
    return fs.readFileSync(resolvedPath, 'utf-8').trimEnd();
  } catch {
    throw new Error(`${label} file not found: ${filePath}`);
  }
}

function generateSlugInternal(text, maxLen = 50) {
  if (!text) return null;
  let slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (slug.length > maxLen) {
    slug = slug.slice(0, maxLen).replace(/-[^-]*$/, '');
  }
  return slug;
}

function getMilestoneInfo(cwd) {
  try {
    const roadmap = fs.readFileSync(planningPaths(cwd).roadmap, 'utf-8');

    // First: check for list-format roadmaps using 🚧 (in-progress) marker
    // e.g. "- 🚧 **v2.1 Belgium** — Phases 24-28 (in progress)"
    const inProgressMatch = roadmap.match(/🚧\s*\*\*v(\d+\.\d+)\s+([^*]+)\*\*/);
    if (inProgressMatch) {
      return {
        version: 'v' + inProgressMatch[1],
        name: inProgressMatch[2].trim(),
      };
    }

    // Second: heading-format roadmaps — strip shipped milestones in <details> blocks
    const cleaned = extractCurrentMilestone(roadmap);
    // Extract version and name from the same ## heading for consistency
    const headingMatch = cleaned.match(/## .*v(\d+\.\d+)[:\s]+([^\n(]+)/);
    if (headingMatch) {
      return {
        version: 'v' + headingMatch[1],
        name: headingMatch[2].trim(),
      };
    }
    // Fallback: try bare version match
    const versionMatch = cleaned.match(/v(\d+\.\d+)/);
    return {
      version: versionMatch ? versionMatch[0] : 'v1.0',
      name: 'milestone',
    };
  } catch {
    return { version: 'v1.0', name: 'milestone' };
  }
}

/**
 * Returns a filter function that checks whether a phase directory belongs
 * to the current milestone based on ROADMAP.md phase headings.
 * If no ROADMAP exists or no phases are listed, returns a pass-all filter.
 */
function getMilestonePhaseFilter(cwd) {
  const milestonePhaseNums = new Set();
  try {
    const roadmap = extractCurrentMilestone(
      fs.readFileSync(planningPaths(cwd).roadmap, 'utf-8'),
    );
    const phasePattern = /#{2,4}\s*Phase\s+(\d+[A-Z]?(?:\.\d+)*)\s*:/gi;
    let m;
    while ((m = phasePattern.exec(roadmap)) !== null) {
      milestonePhaseNums.add(m[1]);
    }
    // Also recognize bullet-only entries: `- [ ] **Phase N: Title**` (no Details header yet).
    // These exist for phases that are declared in the roadmap but not yet planned
    // via /gsd:plan-phase. The `getMilestonePhaseFilter` only needs the phase number,
    // so a simple Set union with the header results is sufficient.
    const bulletPattern =
      /^[-*]\s*\[[ x]\]\s*\*\*Phase\s+(\d+[A-Z]?(?:\.\d+)*)\b/gim;
    let bm;
    while ((bm = bulletPattern.exec(roadmap)) !== null) {
      milestonePhaseNums.add(bm[1]);
    }
  } catch {}

  if (milestonePhaseNums.size === 0) {
    const passAll = () => true;
    passAll.phaseCount = 0;
    return passAll;
  }

  const normalized = new Set(
    [...milestonePhaseNums].map((n) =>
      (n.replace(/^0+/, '') || '0').toLowerCase(),
    ),
  );

  function isDirInMilestone(dirName) {
    const m = dirName.match(/^0*(\d+[A-Za-z]?(?:\.\d+)*)/);
    if (!m) return false;
    return normalized.has(m[1].toLowerCase());
  }
  isDirInMilestone.phaseCount = milestonePhaseNums.size;
  return isDirInMilestone;
}

// ─── Phase Completion Status ────────────────────────────────────────────────

/**
 * Determine phase completion status with verification awareness.
 * Returns { isComplete, status } where status is one of:
 *   'not_started', 'in_progress', 'complete (verified)', 'complete (unverified)'
 * isComplete is true when summaries >= plans (backward compatible).
 * Verification is a qualifier, not a gate.
 */
function getPhaseCompletionStatus(phaseDir) {
  if (!fs.existsSync(phaseDir)) {
    return { isComplete: false, status: 'not_started' };
  }
  let files;
  try {
    files = fs.readdirSync(phaseDir);
  } catch {
    return { isComplete: false, status: 'not_started' };
  }
  const planCount = files.filter(
    (f) => f.match(/-PLAN\.md$/i) || f === 'PLAN.md',
  ).length;
  const summaryCount = files.filter(
    (f) => f.match(/-SUMMARY\.md$/i) || f === 'SUMMARY.md',
  ).length;
  if (planCount === 0) return { isComplete: false, status: 'not_started' };
  if (summaryCount < planCount)
    return { isComplete: false, status: 'in_progress' };
  // summaries >= plans — phase is complete. Check verification status.
  const verificationFile = files.find(
    (f) => f.endsWith('-VERIFICATION.md') || f === 'VERIFICATION.md',
  );
  if (verificationFile) {
    try {
      const { extractFrontmatter } = require('./frontmatter.cjs');
      const verContent = fs.readFileSync(
        path.join(phaseDir, verificationFile),
        'utf-8',
      );
      const fm = extractFrontmatter(verContent);
      if (fm && fm.status === 'passed') {
        return { isComplete: true, status: 'complete (verified)' };
      }
    } catch {
      // VERIFICATION.md unreadable — treat as unverified
    }
  }
  return { isComplete: true, status: 'complete (unverified)' };
}

// ─── Summary body helpers ─────────────────────────────────────────────────

/**
 * Extract a one-liner from the summary body when it's not in frontmatter.
 * The summary template defines one-liner as a bold markdown line after the heading:
 *   # Phase X: Name Summary
 *   **[substantive one-liner text]**
 */
function extractOneLinerFromBody(content) {
  if (!content) return null;
  // Strip frontmatter first
  const body = content.replace(/^---\n[\s\S]*?\n---\n*/, '');
  // Find the first **...** line after a # heading
  const match = body.match(/^#[^\n]*\n+\*\*([^*]+)\*\*/m);
  return match ? match[1].trim() : null;
}

module.exports = {
  output,
  setFileOutput,
  setJsonMode,
  error,
  reapStaleTempFiles,
  safeReadFile,
  loadConfig,
  getEngineRuntime,
  isGitIgnored,
  execGit,
  escapeRegex,
  normalizePhaseName,
  comparePhaseNum,
  searchPhaseInDir,
  findPhaseInternal,
  getArchivedPhaseDirs,
  getRoadmapPhaseInternal,
  resolveModelInternal,
  resolveEffortInternal,
  pathExistsInternal,
  readTextArgOrFile,
  generateSlugInternal,
  getMilestoneInfo,
  getMilestonePhaseFilter,
  extractCurrentMilestone,
  replaceInCurrentMilestone,
  getPhaseCompletionStatus,
  toPosixPath,
  extractOneLinerFromBody,
  planningPaths,
};
