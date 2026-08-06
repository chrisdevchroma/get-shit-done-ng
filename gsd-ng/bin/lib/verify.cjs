/**
 * Verify — Verification suite, consistency, and health validation
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const {
  safeReadFile,
  normalizePhaseName,
  comparePhaseNum,
  execGit,
  findPhaseInternal,
  getMilestoneInfo,
  getMilestonePhaseFilter,
  extractCurrentMilestone,
  output,
  error,
  parsePhaseCheckboxes,
  planningPaths,
  resolveRuntimeSpec,
  escapeRegex,
} = require('./core.cjs');
const { DEFAULTS, WORKFLOW_DEFAULTS } = require('./defaults.cjs');
const {
  extractFrontmatter,
  spliceFrontmatter,
  parseMustHavesBlock,
} = require('./frontmatter.cjs');
const {
  withStateLock,
  writeStateMd,
  stateApplyFieldsToSection,
  tableSectionPattern,
} = require('./state.cjs');
const {
  detectWorkspaceType,
  generateMemoriesSection,
  generateMemoryMd,
} = require('./workspace.cjs');

// The generated Memories section of the project rules file: group 1 is the
// heading line, group 2 the body.
//
// Same shape as STATE.md's section matcher — the heading group ends at its own
// newline so an empty body can still see the terminator that ends it, and the
// terminator is any heading of level 2 or deeper. Built here rather than by that
// builder because this one needs the heading anchored to the start of a line:
// unanchored, `##` matches the last two hashes of `### Memories Overview` and
// the rewrite splices into the middle of that heading. The lookbehind is the
// anchor because the `m` flag that would give `^` the same meaning would also
// turn the `$` in the terminator into any line end.
//
// The heading is matched with its remainder, so a hand-annotated
// `## Memories (curated)` is this section rather than a second one to append
// below it. Regenerating it as the canonical heading is a visible edit; a
// duplicate section would be a silent one.
const MEMORIES_SECTION = new RegExp(
  String.raw`((?<![^\n])##[ \t]*Memories[^\n]*\r?\n)([\s\S]*?)(?=\r?\n#{2}|$)`,
  'i',
);

// Opt-out marker for the two generated memory indexes.
//
// Both generators describe a flat, type-grouped listing of `.claude/memory/`
// top-level files. A project may legitimately maintain either index by hand:
// a curated CLAUDE.md hoist that carries only what every subagent must read,
// or a MEMORY.md with sections the generator cannot express — a link to a
// shared submodule under `.claude/memory/shared/` being the case that prompted
// this. For those, the drift the checks measure is the intended state, and
// running the repair silently replaces the curated file with the generated one.
//
// A file carrying this marker is authored, not generated: W011/W013 stay quiet
// and the matching repair refuses to write rather than overwriting the author.
const MANUAL_INDEX_MARKER = '<!-- gsd:manual -->';

/**
 * Whether a file opts out of index generation via MANUAL_INDEX_MARKER.
 *
 * A missing or unreadable file is not opted out — the caller's own existence
 * checks decide what that means, and treating an unreadable file as manual
 * would suppress the very warning that surfaces it.
 *
 * @param {string} filePath - Absolute path to the file to inspect
 * @returns {boolean} True when the file exists and carries the marker
 */
function isManuallyMaintained(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf-8').includes(MANUAL_INDEX_MARKER);
  } catch {
    return false;
  }
}

/**
 * Absolute path to a project's memory directory for the given runtime.
 *
 * MEMORY_DIR is recorded with a trailing slash, so it is split rather than
 * concatenated to keep the separator platform-correct.
 *
 * @param {string} cwd - Project root directory
 * @param {object} spec - A RUNTIMES row
 * @returns {string}
 */
function runtimeMemoryDir(cwd, spec) {
  return path.join(cwd, ...spec.MEMORY_DIR.replace(/\/+$/, '').split('/'));
}

function cmdVerifySummary(cwd, summaryPath, checkFileCount) {
  if (!summaryPath) {
    error('summary-path required');
  }

  const fullPath = path.join(cwd, summaryPath);
  const checkCount = checkFileCount || 2;

  // Check 1: Summary exists
  if (!fs.existsSync(fullPath)) {
    const result = {
      passed: false,
      checks: {
        summary_exists: false,
        files_created: { checked: 0, found: 0, missing: [] },
        commits_exist: false,
        self_check: 'not_found',
      },
      errors: ['SUMMARY.md not found'],
    };
    output(result, 'failed');
    return;
  }

  const content = fs.readFileSync(fullPath, 'utf-8');
  const errors = [];

  // Check 2: Spot-check files mentioned in summary
  const mentionedFiles = new Set();
  const patterns = [
    /`([^`]+\.[a-zA-Z]+)`/g,
    /(?:Created|Modified|Added|Updated|Edited):\s*`?([^\s`]+\.[a-zA-Z]+)`?/gi,
  ];

  for (const pattern of patterns) {
    let m;
    while ((m = pattern.exec(content)) !== null) {
      const filePath = m[1];
      if (filePath && !filePath.startsWith('http') && filePath.includes('/')) {
        mentionedFiles.add(filePath);
      }
    }
  }

  const filesToCheck = Array.from(mentionedFiles).slice(0, checkCount);
  const missing = [];
  for (const file of filesToCheck) {
    if (!fs.existsSync(path.join(cwd, file))) {
      missing.push(file);
    }
  }

  // Check 3: Commits exist
  const commitHashPattern = /\b[0-9a-f]{7,40}\b/g;
  const hashes = content.match(commitHashPattern) || [];
  let commitsExist = false;
  if (hashes.length > 0) {
    for (const hash of hashes.slice(0, 3)) {
      const result = execGit(cwd, ['cat-file', '-t', hash]);
      if (result.exitCode === 0 && result.stdout === 'commit') {
        commitsExist = true;
        break;
      }
    }
  }

  // Check 4: Self-check section
  let selfCheck = 'not_found';
  const selfCheckPattern =
    /##\s*(?:Self[- ]?Check|Verification|Quality Check)/i;
  if (selfCheckPattern.test(content)) {
    const passPattern = /(?:all\s+)?(?:pass|✓|✅|complete|succeeded)/i;
    const failPattern = /(?:fail|✗|❌|incomplete|blocked)/i;
    const checkSection = content.slice(content.search(selfCheckPattern));
    if (failPattern.test(checkSection)) {
      selfCheck = 'failed';
    } else if (passPattern.test(checkSection)) {
      selfCheck = 'passed';
    }
  }

  if (missing.length > 0) errors.push('Missing files: ' + missing.join(', '));
  if (!commitsExist && hashes.length > 0)
    errors.push('Referenced commit hashes not found in git history');
  if (selfCheck === 'failed')
    errors.push('Self-check section indicates failure');

  const checks = {
    summary_exists: true,
    files_created: {
      checked: filesToCheck.length,
      found: filesToCheck.length - missing.length,
      missing,
    },
    commits_exist: commitsExist,
    self_check: selfCheck,
  };

  const passed = missing.length === 0 && selfCheck !== 'failed';
  const result = { passed, checks, errors };
  output(result, passed ? 'passed' : 'failed');
}

function cmdVerifyPlanStructure(cwd, filePath) {
  if (!filePath) {
    error('file path required');
  }
  const fullPath = path.isAbsolute(filePath)
    ? filePath
    : path.join(cwd, filePath);
  const content = safeReadFile(fullPath);
  if (!content) {
    output({ error: 'File not found', path: filePath });
    return;
  }

  const fm = extractFrontmatter(content);
  const errors = [];
  const warnings = [];

  // Check required frontmatter fields
  const required = [
    'phase',
    'plan',
    'type',
    'wave',
    'depends_on',
    'files_modified',
    'autonomous',
    'must_haves',
  ];
  for (const field of required) {
    if (fm[field] === undefined)
      errors.push(`Missing required frontmatter field: ${field}`);
  }

  // Parse and check task elements
  const taskPattern = /<task[^>]*>([\s\S]*?)<\/task>/g;
  const tasks = [];
  let taskMatch;
  while ((taskMatch = taskPattern.exec(content)) !== null) {
    const taskContent = taskMatch[1];
    const nameMatch = taskContent.match(/<name>([\s\S]*?)<\/name>/);
    const taskName = nameMatch ? nameMatch[1].trim() : 'unnamed';
    const hasFiles = /<files>/.test(taskContent);
    const hasAction = /<action>/.test(taskContent);
    const hasVerify = /<verify>/.test(taskContent);
    const hasDone = /<done>/.test(taskContent);

    if (!nameMatch) errors.push('Task missing <name> element');
    if (!hasAction) errors.push(`Task '${taskName}' missing <action>`);
    if (!hasVerify) warnings.push(`Task '${taskName}' missing <verify>`);
    if (!hasDone) warnings.push(`Task '${taskName}' missing <done>`);
    if (!hasFiles) warnings.push(`Task '${taskName}' missing <files>`);

    tasks.push({ name: taskName, hasFiles, hasAction, hasVerify, hasDone });
  }

  if (tasks.length === 0) warnings.push('No <task> elements found');

  // Wave/depends_on consistency
  if (
    fm.wave &&
    parseInt(fm.wave) > 1 &&
    (!fm.depends_on ||
      (Array.isArray(fm.depends_on) && fm.depends_on.length === 0))
  ) {
    warnings.push('Wave > 1 but depends_on is empty');
  }

  // Autonomous/checkpoint consistency
  const hasCheckpoints = /<task\s+type=["']?checkpoint/.test(content);
  if (hasCheckpoints && fm.autonomous !== 'false' && fm.autonomous !== false) {
    errors.push('Has checkpoint tasks but autonomous is not false');
  }

  output(
    {
      valid: errors.length === 0,
      errors,
      warnings,
      task_count: tasks.length,
      tasks,
      frontmatter_fields: Object.keys(fm),
    },
    errors.length === 0 ? 'valid' : 'invalid',
  );
}

function cmdVerifyPhaseCompleteness(cwd, phase) {
  if (!phase) {
    error('phase required');
  }
  const phaseInfo = findPhaseInternal(cwd, phase);
  if (!phaseInfo || !phaseInfo.found) {
    output({ error: 'Phase not found', phase });
    return;
  }

  const errors = [];
  const warnings = [];
  const phaseDir = path.join(cwd, phaseInfo.directory);

  // List plans and summaries
  let files;
  try {
    files = fs.readdirSync(phaseDir);
  } catch {
    output({ error: 'Cannot read phase directory' });
    return;
  }

  const plans = files.filter((f) => f.match(/-PLAN\.md$/i));
  const summaries = files.filter((f) => f.match(/-SUMMARY\.md$/i));

  // Extract plan IDs (everything before -PLAN.md)
  const planIds = new Set(plans.map((p) => p.replace(/-PLAN\.md$/i, '')));
  const summaryIds = new Set(
    summaries.map((s) => s.replace(/-SUMMARY\.md$/i, '')),
  );

  // Plans without summaries
  const incompletePlans = [...planIds].filter((id) => !summaryIds.has(id));
  if (incompletePlans.length > 0) {
    errors.push(`Plans without summaries: ${incompletePlans.join(', ')}`);
  }

  // Summaries without plans (orphans)
  const orphanSummaries = [...summaryIds].filter((id) => !planIds.has(id));
  if (orphanSummaries.length > 0) {
    warnings.push(`Summaries without plans: ${orphanSummaries.join(', ')}`);
  }

  output(
    {
      complete: errors.length === 0,
      phase: phaseInfo.phase_number,
      plan_count: plans.length,
      summary_count: summaries.length,
      incomplete_plans: incompletePlans,
      orphan_summaries: orphanSummaries,
      errors,
      warnings,
    },
    errors.length === 0 ? 'complete' : 'incomplete',
  );
}

function cmdVerifyReferences(cwd, filePath) {
  if (!filePath) {
    error('file path required');
  }
  const fullPath = path.isAbsolute(filePath)
    ? filePath
    : path.join(cwd, filePath);
  const content = safeReadFile(fullPath);
  if (!content) {
    output({ error: 'File not found', path: filePath });
    return;
  }

  const found = [];
  const missing = [];

  // Find @-references: @path/to/file (must contain / to be a file path)
  const atRefs = content.match(/@([^\s\n,)]+\/[^\s\n,)]+)/g) || [];
  for (const ref of atRefs) {
    const cleanRef = ref.slice(1); // remove @
    const resolved = cleanRef.startsWith('~/')
      ? path.join(process.env.HOME || '', cleanRef.slice(2))
      : path.join(cwd, cleanRef);
    if (fs.existsSync(resolved)) {
      found.push(cleanRef);
    } else {
      missing.push(cleanRef);
    }
  }

  // Find backtick file paths that look like real paths (contain / and have extension)
  const backtickRefs = content.match(/`([^`]+\/[^`]+\.[a-zA-Z]{1,10})`/g) || [];
  for (const ref of backtickRefs) {
    const cleanRef = ref.slice(1, -1); // remove backticks
    if (
      cleanRef.startsWith('http') ||
      cleanRef.includes('${') ||
      cleanRef.includes('{{')
    )
      continue;
    if (found.includes(cleanRef) || missing.includes(cleanRef)) continue; // dedup
    const resolved = path.join(cwd, cleanRef);
    if (fs.existsSync(resolved)) {
      found.push(cleanRef);
    } else {
      missing.push(cleanRef);
    }
  }

  output(
    {
      valid: missing.length === 0,
      found: found.length,
      missing,
      total: found.length + missing.length,
    },
    missing.length === 0 ? 'valid' : 'invalid',
  );
}

function cmdVerifyCommits(cwd, hashes) {
  if (!hashes || hashes.length === 0) {
    error('At least one commit hash required');
  }

  const valid = [];
  const invalid = [];
  for (const hash of hashes) {
    const result = execGit(cwd, ['cat-file', '-t', hash]);
    if (result.exitCode === 0 && result.stdout.trim() === 'commit') {
      valid.push(hash);
    } else {
      invalid.push(hash);
    }
  }

  output(
    {
      all_valid: invalid.length === 0,
      valid,
      invalid,
      total: hashes.length,
    },
    invalid.length === 0 ? 'valid' : 'invalid',
  );
}

function cmdVerifyArtifacts(cwd, planFilePath) {
  if (!planFilePath) {
    error('plan file path required');
  }
  const fullPath = path.isAbsolute(planFilePath)
    ? planFilePath
    : path.join(cwd, planFilePath);
  const content = safeReadFile(fullPath);
  if (!content) {
    output({ error: 'File not found', path: planFilePath });
    return;
  }

  const artifacts = parseMustHavesBlock(content, 'artifacts');
  if (artifacts.length === 0) {
    output({
      error: 'No must_haves.artifacts found in frontmatter',
      path: planFilePath,
    });
    return;
  }

  const results = [];
  for (const artifact of artifacts) {
    if (typeof artifact === 'string') continue; // skip simple string items
    const artPath = artifact.path;
    if (!artPath) continue;

    const artFullPath = path.join(cwd, artPath);
    const exists = fs.existsSync(artFullPath);
    const check = { path: artPath, exists, issues: [], passed: false };

    if (exists) {
      const fileContent = safeReadFile(artFullPath) || '';
      const lineCount = fileContent.split('\n').length;

      if (artifact.min_lines && lineCount < artifact.min_lines) {
        check.issues.push(
          `Only ${lineCount} lines, need ${artifact.min_lines}`,
        );
      }
      if (artifact.contains && !fileContent.includes(artifact.contains)) {
        check.issues.push(`Missing pattern: ${artifact.contains}`);
      }
      if (artifact.exports) {
        const exports = Array.isArray(artifact.exports)
          ? artifact.exports
          : [artifact.exports];
        for (const exp of exports) {
          if (!fileContent.includes(exp))
            check.issues.push(`Missing export: ${exp}`);
        }
      }
      check.passed = check.issues.length === 0;
    } else {
      check.issues.push('File not found');
    }

    results.push(check);
  }

  const passed = results.filter((r) => r.passed).length;
  output(
    {
      all_passed: passed === results.length,
      passed,
      total: results.length,
      artifacts: results,
    },
    passed === results.length ? 'valid' : 'invalid',
  );
}

function cmdVerifyKeyLinks(cwd, planFilePath) {
  if (!planFilePath) {
    error('plan file path required');
  }
  const fullPath = path.isAbsolute(planFilePath)
    ? planFilePath
    : path.join(cwd, planFilePath);
  const content = safeReadFile(fullPath);
  if (!content) {
    output({ error: 'File not found', path: planFilePath });
    return;
  }

  const keyLinks = parseMustHavesBlock(content, 'key_links');
  if (keyLinks.length === 0) {
    output({
      error: 'No must_haves.key_links found in frontmatter',
      path: planFilePath,
    });
    return;
  }

  const results = [];
  for (const link of keyLinks) {
    if (typeof link === 'string') continue;
    const check = {
      from: link.from,
      to: link.to,
      via: link.via || '',
      verified: false,
      detail: '',
    };

    const sourceContent = safeReadFile(path.join(cwd, link.from || ''));
    if (!sourceContent) {
      check.detail = 'Source file not found';
    } else if (link.pattern) {
      try {
        const regex = new RegExp(link.pattern);
        if (regex.test(sourceContent)) {
          check.verified = true;
          check.detail = 'Pattern found in source';
        } else {
          const targetContent = safeReadFile(path.join(cwd, link.to || ''));
          if (targetContent && regex.test(targetContent)) {
            check.verified = true;
            check.detail = 'Pattern found in target';
          } else {
            check.detail = `Pattern "${link.pattern}" not found in source or target`;
          }
        }
      } catch {
        check.detail = `Invalid regex pattern: ${link.pattern}`;
      }
    } else {
      // No pattern: just check source references target
      if (sourceContent.includes(link.to || '')) {
        check.verified = true;
        check.detail = 'Target referenced in source';
      } else {
        check.detail = 'Target not referenced in source';
      }
    }

    results.push(check);
  }

  const verified = results.filter((r) => r.verified).length;
  output(
    {
      all_verified: verified === results.length,
      verified,
      total: results.length,
      links: results,
    },
    verified === results.length ? 'valid' : 'invalid',
  );
}

function cmdValidateConsistency(cwd) {
  const { roadmap: roadmapPath, phases: phasesDir } = planningPaths(cwd);
  const errors = [];
  const warnings = [];

  // Check for ROADMAP
  if (!fs.existsSync(roadmapPath)) {
    errors.push('ROADMAP.md not found');
    output({ passed: false, errors, warnings }, 'failed');
    return;
  }

  const roadmapContentRaw = fs.readFileSync(roadmapPath, 'utf-8');
  const roadmapContent = extractCurrentMilestone(roadmapContentRaw);

  // Extract phases from ROADMAP (archived milestones already stripped)
  const roadmapPhases = new Set();
  const phasePattern = /#{2,4}\s*Phase\s+(\d+[A-Z]?(?:\.\d+)*)\s*:/gi;
  let m;
  while ((m = phasePattern.exec(roadmapContent)) !== null) {
    roadmapPhases.add(m[1]);
  }

  // Get phases on disk
  const diskPhases = new Set();
  try {
    const entries = fs.readdirSync(phasesDir, { withFileTypes: true });
    const dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);
    for (const dir of dirs) {
      const dm = dir.match(/^(\d+[A-Z]?(?:\.\d+)*)/i);
      if (dm) diskPhases.add(dm[1]);
    }
  } catch {}

  // Check: phases in ROADMAP but not on disk
  for (const p of roadmapPhases) {
    if (!diskPhases.has(p) && !diskPhases.has(normalizePhaseName(p))) {
      warnings.push(`Phase ${p} in ROADMAP.md but no directory on disk`);
    }
  }

  // Check: phases on disk but not in ROADMAP
  for (const p of diskPhases) {
    const unpadded = String(parseInt(p, 10));
    if (!roadmapPhases.has(p) && !roadmapPhases.has(unpadded)) {
      warnings.push(`Phase ${p} exists on disk but not in ROADMAP.md`);
    }
  }

  // Check: sequential phase numbers (integers only)
  const integerPhases = [...diskPhases]
    .filter((p) => !p.includes('.'))
    .map((p) => parseInt(p, 10))
    .sort((a, b) => a - b);

  for (let i = 1; i < integerPhases.length; i++) {
    if (integerPhases[i] !== integerPhases[i - 1] + 1) {
      warnings.push(
        `Gap in phase numbering: ${integerPhases[i - 1]} → ${integerPhases[i]}`,
      );
    }
  }

  // Check: plan numbering within phases
  try {
    const entries = fs.readdirSync(phasesDir, { withFileTypes: true });
    const dirs = entries
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();

    for (const dir of dirs) {
      const phaseFiles = fs.readdirSync(path.join(phasesDir, dir));
      const plans = phaseFiles.filter((f) => f.endsWith('-PLAN.md')).sort();

      // Extract plan numbers
      const planNums = plans
        .map((p) => {
          const pm = p.match(/-(\d{2})-PLAN\.md$/);
          return pm ? parseInt(pm[1], 10) : null;
        })
        .filter((n) => n !== null);

      for (let i = 1; i < planNums.length; i++) {
        if (planNums[i] !== planNums[i - 1] + 1) {
          warnings.push(
            `Gap in plan numbering in ${dir}: plan ${planNums[i - 1]} → ${planNums[i]}`,
          );
        }
      }

      // Check: plans without summaries (completed plans)
      const summaries = phaseFiles.filter((f) => f.endsWith('-SUMMARY.md'));
      const planIds = new Set(plans.map((p) => p.replace('-PLAN.md', '')));
      const summaryIds = new Set(
        summaries.map((s) => s.replace('-SUMMARY.md', '')),
      );

      // Summary without matching plan is suspicious
      for (const sid of summaryIds) {
        if (!planIds.has(sid)) {
          warnings.push(
            `Summary ${sid}-SUMMARY.md in ${dir} has no matching PLAN.md`,
          );
        }
      }
    }
  } catch {}

  // Check: frontmatter in plans has required fields
  try {
    const entries = fs.readdirSync(phasesDir, { withFileTypes: true });
    const dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);

    for (const dir of dirs) {
      const phaseFiles = fs.readdirSync(path.join(phasesDir, dir));
      const plans = phaseFiles.filter((f) => f.endsWith('-PLAN.md'));

      for (const plan of plans) {
        const content = fs.readFileSync(
          path.join(phasesDir, dir, plan),
          'utf-8',
        );
        const fm = extractFrontmatter(content);

        if (!fm.wave) {
          warnings.push(`${dir}/${plan}: missing 'wave' in frontmatter`);
        }
      }
    }
  } catch {}

  const passed = errors.length === 0;
  output(
    { passed, errors, warnings, warning_count: warnings.length },
    passed ? 'passed' : 'failed',
  );
}

// Default cliInvoker used by checkVerifyIssueTrackerLinks. Returns null because
// the current W015/W016 stub body does not actually invoke a CLI yet — issue
// state checks are deferred to real platform checks. Tests can pass any
// function-shaped invoker to verify the seam exists.
function defaultIssueCliInvoker() {
  return null;
}

// W015/W016 issue-tracker link check: extracted helper accepting a cliInvoker
// parameter so tests can inject a stub. Replaces the prior GSD_TEST_MODE
// env-hook gate. Returns early when itConfig.platform is unset.
function checkVerifyIssueTrackerLinks(
  itConfig,
  dirs,
  addIssue,
  cliInvoker = defaultIssueCliInvoker,
) {
  if (!itConfig || !itConfig.platform) return;
  const { todosPending, todosCompleted } = dirs || {};
  if (!todosPending || !todosCompleted) return;

  // W015: Completed todos with open external issues
  // Performance guard: only check todos completed in last 30 days
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
    .toISOString()
    .split('T')[0];
  let completedTodoFiles = [];
  try {
    completedTodoFiles = fs
      .readdirSync(todosCompleted)
      .filter((f) => f.endsWith('.md'));
  } catch (_e) {
    /* dir may not exist */
  }

  for (const file of completedTodoFiles) {
    try {
      const content = fs.readFileSync(path.join(todosCompleted, file), 'utf-8');
      const fm = extractFrontmatter(content);
      if (!fm || !fm.external_ref) continue;
      // Skip todos completed more than 30 days ago
      if (fm.completed && fm.completed < thirtyDaysAgo) continue;
      // Issue state check via platform CLI would go here. Routed through
      // cliInvoker so tests can stub the call without spawning real CLIs.
      // Deferred to real platform check in live environments.
      void cliInvoker;
    } catch (_e) {
      /* skip unreadable */
    }
  }

  // W016: Closed external issues with open pending todos
  let pendingTodoFiles = [];
  try {
    pendingTodoFiles = fs
      .readdirSync(todosPending)
      .filter((f) => f.endsWith('.md'));
  } catch (_e) {
    /* dir may not exist */
  }

  for (const file of pendingTodoFiles) {
    try {
      const content = fs.readFileSync(path.join(todosPending, file), 'utf-8');
      const fm = extractFrontmatter(content);
      if (!fm || !fm.external_ref) continue;
      // Issue state check via platform CLI would go here. Routed through
      // cliInvoker so tests can stub the call without spawning real CLIs.
      // Deferred to real platform check in live environments.
      void cliInvoker;
    } catch (_e) {
      /* skip */
    }
  }

  // addIssue accepted but unused at present (issues only added once a real
  // CLI is wired in). Ref to satisfy lint/no-unused.
  void addIssue;
}

/**
 * Read the phase layout of the current milestone off disk.
 *
 * Returns the milestone's phase directories in phase order with their PLAN and
 * SUMMARY counts, plus the milestone-wide totals, so a caller can place the
 * project without consulting STATE.md — which is the point when STATE.md is the
 * file being rebuilt.
 */
function readPhaseLayout(cwd) {
  const { phases: phasesDir } = planningPaths(cwd);
  const isDirInMilestone = getMilestonePhaseFilter(cwd);
  let dirs = [];
  try {
    dirs = fs
      .readdirSync(phasesDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .filter(isDirInMilestone)
      .sort(comparePhaseNum);
  } catch {}

  let totalPlans = 0;
  let totalSummaries = 0;
  const phases = dirs.map((dir) => {
    let files = [];
    try {
      files = fs.readdirSync(path.join(phasesDir, dir));
    } catch {}
    const plans = files.filter((f) => /-PLAN\.md$/i.test(f)).length;
    const summaries = files.filter((f) => /-SUMMARY\.md$/i.test(f)).length;
    totalPlans += plans;
    totalSummaries += summaries;
    return {
      number: normalizePhaseName(dir),
      name: dir.replace(/^\d+[A-Za-z]?(?:\.\d+)*-/, '').replace(/-/g, ' '),
      plans,
      summaries,
    };
  });

  const totalPhases =
    isDirInMilestone.phaseCount > 0
      ? Math.max(phases.length, isDirInMilestone.phaseCount)
      : phases.length;

  return { phases, totalPhases, totalPlans, totalSummaries };
}

/** Render the STATE.md progress bar for a completed/total plan ratio. */
function renderProgressField(completed, total) {
  const percent =
    total > 0 ? Math.min(100, Math.round((completed / total) * 100)) : 0;
  const width = 10;
  const filled = Math.round((percent / 100) * width);
  return `[${'█'.repeat(filled)}${'░'.repeat(width - filled)}] ${percent}%`;
}

/**
 * Build a STATE.md the field writers can rewrite.
 *
 * The repair used to emit a three-line skeleton carrying
 * `**Current phase:** (determining...)` and no Total Phases, Current Plan or
 * Progress at all, so the command whose job is to hand back a healthy file
 * handed back one the progression engine could not advance. Every field the
 * writers look for is emitted, and the block is assembled by the same helper
 * the writers use rather than concatenated by hand, so the shape cannot drift
 * from what they match.
 *
 * Position comes from disk: the current phase is the first one with plans left
 * to execute — the last one when every plan has a summary — and the current
 * plan the first one without a summary. A project with no phase directories
 * still gets every field, on placeholder values: a placeholder is rewritable,
 * a missing label is not.
 */
function buildRepairedState(cwd) {
  const today = new Date().toISOString().split('T')[0];
  const milestone = getMilestoneInfo(cwd);
  const layout = readPhaseLayout(cwd);

  const current = layout.phases.find((p) => p.summaries < p.plans) ||
    layout.phases[layout.phases.length - 1] || {
      number: '01',
      name: 'unknown',
      plans: 0,
      summaries: 0,
    };
  const nextPlan = Math.min(current.summaries + 1, Math.max(current.plans, 1));

  const fields = [
    ['Milestone', `${milestone.version} ${milestone.name}`],
    ['Current Phase', current.number],
    ['Current Phase Name', current.name],
    ['Total Phases', String(layout.totalPhases)],
    [
      'Current Plan',
      current.plans > 0
        ? `${current.number}-${String(nextPlan).padStart(2, '0')}`
        : 'Not started',
    ],
    ['Total Plans in Phase', String(current.plans)],
    ['Status', 'Resuming'],
    ['Last Activity', today],
    [
      'Last Activity Description',
      'STATE.md regenerated by /gsd:health --repair',
    ],
    ['Progress', renderProgressField(layout.totalSummaries, layout.totalPlans)],
  ];

  const skeleton =
    '# Session State\n\n' +
    '## Project Reference\n\n' +
    'See: .planning/PROJECT.md\n\n' +
    '## Current Position\n\n' +
    '## Session Log\n\n' +
    `- ${today}: STATE.md regenerated by /gsd:health --repair\n`;

  return stateApplyFieldsToSection(skeleton, 'Current Position', fields)
    .content;
}

/**
 * The field labels the state template declares, read from its fenced File
 * Template block. Scoped to the fence because the prose below it documents
 * itself in the same bold form, and those labels are not STATE.md fields.
 *
 * The path is a parameter so the no-fence and missing-file outcomes are
 * reachable from a test without an environment override.
 */
function readTemplateStateFields(templatePath) {
  let content;
  try {
    content = fs.readFileSync(templatePath, 'utf-8');
  } catch {
    return [];
  }
  const fence = content.match(/```markdown\n([\s\S]*?)\n```/);
  if (!fence) return [];
  const seen = new Set();
  for (const m of fence[1].matchAll(/^\*\*([^*]+?):\*\*/gm)) seen.add(m[1]);
  return [...seen];
}

/**
 * Whether a STATE.md body carries a field, in any of the three spellings
 * stateExtractField accepts: the colon inside the bold markers, outside them,
 * or the plain `Label: value` form. Frontmatter is stripped first, so a
 * frontmatter key sharing a field's name does not read as the field.
 *
 * Inlined rather than imported to keep this check off state.cjs's field readers.
 */
function stateBodyHasField(stateContent, fieldName) {
  const body = stateContent.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n*/, '');
  const escaped = fieldName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(
    `^\\*\\*${escaped}:\\*\\*|^\\*\\*${escaped}\\*\\*:|^${escaped}:`,
    'im',
  ).test(body);
}

// ─── Traceability desync ──────────────────────────────────────────────────────

// Requirement IDs this check does not judge. A predicate on the ID rather than
// on position, so it stays correct as the file is rewritten.
const TRACEABILITY_EXCLUDED_ID = /^SEC40-/;

// Box state in group 1, a settled item's strikethrough in group 2, ID in group 3.
const REQUIREMENT_CHECKBOX_LINE =
  /^[ \t]*[-*]\s*\[([ xX])\]\s*(~~)?\s*\*\*([A-Za-z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)+)\*\*/gm;

const REQUIREMENT_ID = /^[A-Za-z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)+$/;

/**
 * The traceability table's rows, scoped to its own section so other tables in
 * the document are not read as requirement rows.
 *
 * @param {string} content - REQUIREMENTS.md contents
 * @returns {Array<{id: string, phase: string, status: string}>} One entry per row
 */
function parseTraceabilityRows(content) {
  // Terminator is `(?![\s\S])`, not `$`: the `m` flag the heading anchor needs
  // would let `$` close the section on its first blank line.
  const section = content.match(
    /^##[ \t]*Traceability[^\n]*\r?\n([\s\S]*?)(?=\r?\n##[ \t]|(?![\s\S]))/im,
  );
  if (!section) return [];
  const rows = [];
  for (const line of section[1].split(/\r?\n/)) {
    if (!line.trimStart().startsWith('|')) continue;
    // A pipe-delimited row yields an empty leading cell, so the ID is cell 1 and
    // the status cell 3. The header and its separator fail the ID test.
    const cells = line.split('|').map((c) => c.trim());
    if (cells.length < 4) continue;
    if (!REQUIREMENT_ID.test(cells[1])) continue;
    rows.push({ id: cells[1], phase: cells[2], status: cells[3] });
  }
  return rows;
}

/**
 * Requirement IDs whose traceability Status contradicts their checkbox: ticked
 * over a status of exactly `Planned`. An unticked box over `Complete` is left
 * alone — that is a requirement mid-phase. The status must be `Planned` on its
 * own, so the struck settled forms (`~~Planned~~ Deferred`) do not match.
 *
 * @param {string} content - REQUIREMENTS.md contents
 * @returns {string[]} The offending requirement IDs, in table order
 */
function findTraceabilityDesyncs(content) {
  if (!content) return [];
  const ticked = new Map();
  for (const m of content.matchAll(REQUIREMENT_CHECKBOX_LINE)) {
    ticked.set(m[3], m[1].toLowerCase() === 'x');
  }
  const desynced = [];
  for (const row of parseTraceabilityRows(content)) {
    if (TRACEABILITY_EXCLUDED_ID.test(row.id)) continue;
    if (ticked.get(row.id) !== true) continue;
    if (row.status.toLowerCase() !== 'planned') continue;
    desynced.push(row.id);
  }
  return desynced;
}

// ─── Roadmap integrity ────────────────────────────────────────────────────────

// A phase's details header. Shared by the roadmap/disk cross-check and the
// roadmap-internal checks so the two cannot anchor differently.
const ROADMAP_PHASE_HEADER_SOURCE = String.raw`#{2,4}\s*Phase\s+(\d+[A-Z]?(?:\.\d+)*)\s*:`;

// The plan-count line a details section carries, in the spelling core.cjs's own
// probe for that line accepts. Groups are the completed and total counts; a
// section whose line omits the `N/M` pair matches nothing and is not compared.
const ROADMAP_PLAN_COUNT_LINE =
  /^[ \t]*\*{0,2}Plans\*{0,2}\s*:\*{0,2}[ \t]*(\d+)[ \t]*\/[ \t]*(\d+)/im;

// A plan entry inside a details section. The phase checkboxes of the milestone
// list are excluded by the `Phase N:` form they carry.
const ROADMAP_PLAN_ENTRY = /^[ \t]*[-*]\s*\[([ xX])\](?!\s*(?:\*\*)?Phase\s)/gm;

/**
 * Each phase details section of a roadmap, as the number it declares and the
 * text from its header up to the next one.
 *
 * @param {string} milestoneContent - ROADMAP.md, archived milestones stripped
 * @returns {Array<{num: string, body: string}>} Sections in document order
 */
function parseRoadmapPhaseSections(milestoneContent) {
  const pattern = new RegExp(ROADMAP_PHASE_HEADER_SOURCE, 'gi');
  const marks = [];
  let m;
  while ((m = pattern.exec(milestoneContent)) !== null) {
    marks.push({ num: m[1], index: m.index });
  }
  return marks.map((mark, i) => ({
    num: mark.num,
    body: milestoneContent.slice(
      mark.index,
      i + 1 < marks.length ? marks[i + 1].index : milestoneContent.length,
    ),
  }));
}

/**
 * Ways a roadmap contradicts itself, independent of what is on disk:
 *
 *   - a plan-count header disagreeing with the plan list below it;
 *   - a details section no milestone-checklist entry points at;
 *   - a checklist entry with no details section;
 *   - one phase number claimed by two checklist entries.
 *
 * Phase numbers are reported as the document writes them, unpadded, since that
 * is what a reader searches for. A section listing no plans is not compared —
 * an unplanned phase legitimately has a target and nothing under it. The
 * checklist/section correspondence is checked only when both sides exist, so a
 * roadmap using just one half of the format is not reported as all-broken.
 *
 * @param {string} content - ROADMAP.md contents
 * @returns {Array<{message: string, fix: string}>} One entry per contradiction
 */
function findRoadmapContradictions(content) {
  if (!content) return [];
  const milestone = extractCurrentMilestone(content);
  const sections = parseRoadmapPhaseSections(milestone);
  const found = [];

  for (const section of sections) {
    const counts = section.body.match(ROADMAP_PLAN_COUNT_LINE);
    if (!counts) continue;
    const entries = [...section.body.matchAll(ROADMAP_PLAN_ENTRY)];
    if (entries.length === 0) continue;
    const done = entries.filter((e) => e[1].toLowerCase() === 'x').length;
    const claimedDone = Number(counts[1]);
    const claimedTotal = Number(counts[2]);
    if (claimedDone !== done || claimedTotal !== entries.length) {
      found.push({
        message: `ROADMAP.md: phase ${section.num} claims ${claimedDone}/${claimedTotal} plans but lists ${done} ticked of ${entries.length}`,
        fix: `Reconcile phase ${section.num} against what shipped — correct the count line, or the plan list, whichever is wrong`,
      });
    }
  }

  const checklist = parsePhaseCheckboxes(milestone);
  const detailNums = new Map();
  for (const section of sections) {
    const key = normalizePhaseName(section.num);
    if (!detailNums.has(key)) detailNums.set(key, section.num);
  }
  const checklistNums = new Map();
  const duplicated = new Map();
  for (const entry of checklist) {
    const key = normalizePhaseName(entry.num);
    if (checklistNums.has(key)) duplicated.set(key, entry.num);
    else checklistNums.set(key, entry.num);
  }

  if (detailNums.size > 0 && checklistNums.size > 0) {
    for (const [key, raw] of detailNums) {
      if (!checklistNums.has(key)) {
        found.push({
          message: `ROADMAP.md: phase ${raw} has a details section but no entry in the milestone checklist`,
          fix: `Add a checklist entry for phase ${raw}, or remove its details section if the phase was renamed or abandoned`,
        });
      }
    }
    for (const [key, raw] of checklistNums) {
      if (!detailNums.has(key)) {
        found.push({
          message: `ROADMAP.md: phase ${raw} is in the milestone checklist but has no details section`,
          fix: `Add a "### Phase ${raw}:" details section, or remove the checklist entry`,
        });
      }
    }
  }
  for (const raw of duplicated.values()) {
    found.push({
      message: `ROADMAP.md: phase ${raw} appears more than once in the milestone checklist`,
      fix: `Decide which entry describes the phase that shipped and renumber or remove the other — two entries under one number make the phase ambiguous to every reader of the roadmap`,
    });
  }

  return found;
}

// ─── STATE.md self-consistency ────────────────────────────────────────────────

// Status values that say work on the current phase is still happening. Anything
// else — completed, paused, a milestone rollup — is a settled state, and a
// settled state agreeing with finished counters is not a contradiction.
const STATE_IN_FLIGHT_STATUS = new Set([
  'executing',
  'in progress',
  'planning',
  'ready to plan',
  'ready to execute',
  'discussing',
  'verifying',
]);

const STATE_VELOCITY_PLAN_COUNT =
  /^[ \t]*[-*]\s*Total plans completed:\s*(\d+)/im;

/**
 * The verification verdict recorded for a phase, or null when there is none.
 *
 * @param {string} cwd - Project root
 * @param {string} phase - Phase number as STATE.md writes it
 * @returns {string|null} The `status` field of the phase's VERIFICATION.md
 */
function readPhaseVerificationStatus(cwd, phase) {
  const info = findPhaseInternal(cwd, phase);
  if (!info || !info.found) return null;
  const dir = path.join(cwd, info.directory);
  let files;
  try {
    files = fs.readdirSync(dir);
  } catch {
    return null;
  }
  const file = files.find(
    (f) => f.endsWith('-VERIFICATION.md') || f === 'VERIFICATION.md',
  );
  if (!file) return null;
  const fm = extractFrontmatter(safeReadFile(path.join(dir, file)) || '');
  return fm && fm.status ? String(fm.status).trim().toLowerCase() : null;
}

/**
 * Ways STATE.md contradicts itself: a `status` claiming work is in flight when
 * every plan of the current phase has a summary and that phase's verification
 * passed, and a Velocity block whose plan count disagrees with the metrics
 * table. The passed verification is required as a second signal — summary
 * counts go equal the moment the last one lands, before the phase is done.
 *
 * @param {string} cwd - Project root
 * @param {string} content - STATE.md contents
 * @returns {Array<{message: string, fix: string}>} One entry per contradiction
 */
function findStateContradictions(cwd, content) {
  if (!content) return [];
  const found = [];
  const fm = extractFrontmatter(content);
  const progress = fm && fm.progress ? fm.progress : {};
  const done = Number(progress.completed_plans);
  const total = Number(progress.total_plans);
  const status = fm && fm.status ? String(fm.status).trim().toLowerCase() : '';

  if (
    STATE_IN_FLIGHT_STATUS.has(status) &&
    Number.isFinite(done) &&
    Number.isFinite(total) &&
    total > 0 &&
    done >= total &&
    fm.current_phase !== undefined &&
    readPhaseVerificationStatus(cwd, String(fm.current_phase)) === 'passed'
  ) {
    found.push({
      message: `STATE.md: status reads "${fm.status}" while phase ${fm.current_phase} has all ${total} plans summarised and a passed verification`,
      fix: 'Advance STATE.md to the next phase, or set status to what the phase actually reached — the counters and the verification both say the work finished',
    });
  }

  const claimed = content.match(STATE_VELOCITY_PLAN_COUNT);
  const metrics = content.match(tableSectionPattern('Performance Metrics'));
  if (claimed && metrics) {
    const rows = metrics[2]
      .split(/\r?\n/)
      .filter((l) => l.trimStart().startsWith('|')).length;
    if (rows > 0 && Number(claimed[1]) !== rows) {
      found.push({
        message: `STATE.md: the Velocity block reports ${claimed[1]} plans completed while the Performance Metrics table holds ${rows} rows`,
        fix: 'Run `gsd-tools state update-progress` to recompute the Velocity block from the metrics table',
      });
    }
  }

  return found;
}

// ─── Nyquist validation evidence ─────────────────────────────────────────────

// A path-shaped citation whose basename follows a test-file convention. The
// leading `(?:…/)+` is required, not decorative: VALIDATION.md prose routinely
// names a bare basename in a File Exists cell ("config.test.cjs: yes"), which
// mentions a file without claiming a location, and there is nothing to resolve a
// bare name against. Only a path claims "the evidence is here".
const PATH_SEGMENT = '[A-Za-z0-9_.-]+';
const TEST_FILE_NAME = [
  PATH_SEGMENT + '[.](test|spec)[.](c|m)?[jt]sx?',
  'test_' + PATH_SEGMENT + '[.]py',
  PATH_SEGMENT + '_test[.](py|go|rb)',
].join('|');
const CITED_TEST_FILE = new RegExp(
  '(?:' + PATH_SEGMENT + '/)+(?:' + TEST_FILE_NAME + ')',
  'g',
);

// The map is read as a markdown table rather than parsed as one: the heading
// opens the region, the next heading of any level closes it, and the alignment
// row between the header and the body is skipped. Older validation files carry
// columns in a different order and a few carry extra ones, so the requirement
// column is located by its header text on each file rather than by index.
const VALIDATION_MAP_HEADING = /^##\s+Per-Task Verification Map\s*$/;
const MARKDOWN_TABLE_SEPARATOR = /^\|[\s\-|:]+\|$/;

/**
 * Test-file paths cited by the Per-Task Verification Map, with the requirement
 * each was cited for.
 *
 * Scoped to the map rather than the whole document because the map is the part
 * that claims a requirement is covered. A Wave 0 checklist naming a file yet to
 * be written is a plan, not a claim, and flagging it would punish the one
 * section that is honest about what does not exist yet.
 *
 * @param {string} content - VALIDATION.md contents
 * @returns {Array<{path: string, requirement: string}>} One entry per distinct path
 */
function citedTestFiles(content) {
  const lines = String(content || '').split(/\r?\n/);
  const start = lines.findIndex((l) => VALIDATION_MAP_HEADING.test(l));
  if (start < 0) return [];

  const seen = new Map();
  let requirementColumn = -1;
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (/^##\s/.test(line)) break;
    const trimmed = line.trim();
    if (!trimmed.startsWith('|')) continue;
    const cells = trimmed.split('|').map((c) => c.trim());
    if (requirementColumn < 0 && cells.some((c) => /^Requirement$/i.test(c))) {
      requirementColumn = cells.findIndex((c) => /^Requirement$/i.test(c));
      continue;
    }
    if (MARKDOWN_TABLE_SEPARATOR.test(trimmed)) continue;

    const matches = trimmed.match(CITED_TEST_FILE);
    if (!matches) continue;
    const requirement =
      (requirementColumn >= 0 && cells[requirementColumn]) || 'unnamed row';
    for (const p of matches) if (!seen.has(p)) seen.set(p, requirement);
  }
  return [...seen].map(([p, requirement]) => ({ path: p, requirement }));
}

/**
 * Resolver for evidence citations, backed by `git ls-tree HEAD`.
 *
 * Resolution is against the tree, not the working directory. A file present
 * only locally is not evidence anyone else can reproduce, and that difference is
 * not hypothetical: a test file cited by a phase's validation map with a line
 * count and two commit SHAs turned out to live only on a branch that a squash
 * had made unreachable. Every existsSync-shaped check passed the day it was
 * written and passed silently ever after.
 *
 * Submodules are commit entries in the superproject's tree, so their contents
 * are absent from its listing; each one is listed separately and prefixed.
 *
 * Matching accepts any tracked path ending at the citation, because rows
 * routinely prefix a command with `cd <subdir> &&` and nothing in the row
 * records the directory it was meant to run from. Deliberately permissive: what
 * is being caught is a citation that resolves nowhere at all.
 *
 * @param {string} cwd - Project root
 * @returns {{available: boolean, resolves: (p: string) => boolean}}
 */
function buildTrackedPathIndex(cwd) {
  const listed = execGit(cwd, ['ls-tree', '-r', '--name-only', 'HEAD']);
  if (listed.exitCode !== 0) {
    return {
      available: false,
      resolves: (p) => fs.existsSync(path.join(cwd, p)),
    };
  }

  const byBasename = new Map();
  const add = (p) => {
    const base = p.slice(p.lastIndexOf('/') + 1);
    if (!byBasename.has(base)) byBasename.set(base, []);
    byBasename.get(base).push(p);
  };
  for (const line of listed.stdout.split('\n')) {
    const p = line.trim();
    if (p) add(p);
  }

  const entries = execGit(cwd, ['ls-tree', '-r', 'HEAD']);
  if (entries.exitCode === 0) {
    for (const line of entries.stdout.split('\n')) {
      const m = line.match(/^160000\s+commit\s+\S+\t(.+)$/);
      if (!m) continue;
      const sub = m[1];
      const inner = execGit(path.join(cwd, sub), [
        'ls-tree',
        '-r',
        '--name-only',
        'HEAD',
      ]);
      if (inner.exitCode !== 0) continue;
      for (const l of inner.stdout.split('\n')) {
        const p = l.trim();
        if (p) add(sub + '/' + p);
      }
    }
  }

  return {
    available: true,
    resolves(cited) {
      const candidates = byBasename.get(
        cited.slice(cited.lastIndexOf('/') + 1),
      );
      if (!candidates) return false;
      return candidates.some((p) => p === cited || p.endsWith('/' + cited));
    },
  };
}

// Anchored inside the frontmatter block. Validation files carry the literal
// `nyquist_compliant: true` in prose — the sign-off checklist the template used
// to ship, and every file already written from it — so an unanchored match
// reads a blank checkbox as a promotion and reports four times the real number.
// A check that flags nearly every file in the tree is muted within a day.
const FRONTMATTER_BLOCK = /^---\r?\n([\s\S]*?)\r?\n---/;
const PROMOTED_FLAG = /^nyquist_compliant:\s*true\s*$/m;
const AUDIT_TRAIL_SECTION = /^## Validation Audit\b/m;

/**
 * A VALIDATION.md's frontmatter block, or null when it has none.
 *
 * @param {string} content - VALIDATION.md contents
 * @returns {string|null}
 */
function frontmatterBlock(content) {
  const fm = String(content || '').match(FRONTMATTER_BLOCK);
  return fm ? fm[1] : null;
}

const MANUAL_ONLY_FIELD = /^manual_only_count:\s*"?(\d+)"?\s*$/m;
const EVIDENCE_TIERS_FIELD = /^evidence_tiers:\s*(.+?)\s*$/m;

/**
 * The decomposition behind one phase's compliance claim: how many behaviors it
 * carved out as manual, and how its evidence splits across the tiers.
 *
 * Read with anchored patterns rather than a YAML parse because the field
 * survives in two shapes — the template ships `{ automated: 0, tier_m: 0,
 * manual: 0 }` as a flow mapping and `frontmatter set` rewrites it as a quoted
 * string when it promotes a phase. Both carry the same three numbers, and a
 * reader that accepts only one of them reports zeros for precisely the phases
 * the gate has promoted.
 *
 * @param {string} block - the frontmatter block, as returned by frontmatterBlock
 * @returns {{manualOnlyCount: number, tierA: number, tierM: number, manualRows: number}}
 */
function readEvidenceClaim(block) {
  const manualOnly = block.match(MANUAL_ONLY_FIELD);
  const tiers = (block.match(EVIDENCE_TIERS_FIELD) || [])[1] || '';
  const tier = (pattern) => {
    const m = tiers.match(pattern);
    return m ? parseInt(m[1], 10) : 0;
  };
  return {
    manualOnlyCount: manualOnly ? parseInt(manualOnly[1], 10) : 0,
    tierA: tier(/\bautomated:\s*(\d+)/),
    tierM: tier(/\btier_m:\s*(\d+)/),
    manualRows: tier(/\bmanual:\s*(\d+)/),
  };
}

/**
 * Health check, and the repairs it decides on.
 *
 * In repair mode the whole run is one section — see cmdValidateHealth — because
 * the checks are what decide the repairs. Nothing here may take the ROADMAP.md
 * lock: verify.cjs depends on neither roadmap.cjs nor phase.cjs, and
 * tests/core.test.cjs asserts the direction.
 */
function runHealth(cwd, options) {
  // Guard: detect if CWD is the home directory (likely accidental)
  const resolved = path.resolve(cwd);
  if (resolved === os.homedir()) {
    output({
      status: 'error',
      errors: [
        {
          code: 'E010',
          message: `CWD is home directory (${resolved}) — health check would read the wrong .planning/ directory. Run from your project root instead.`,
          fix: 'cd into your project directory and retry',
        },
      ],
      warnings: [],
      info: [{ code: 'I010', message: `Resolved CWD: ${resolved}` }],
      repairable_count: 0,
    });
    return;
  }

  const {
    root: planningDir,
    project: projectPath,
    roadmap: roadmapPath,
    state: statePath,
    config: configPath,
    phases: phasesDir,
    requirements: requirementsPath,
  } = planningPaths(cwd);

  const errors = [];
  const warnings = [];
  const info = [];
  const repairs = [];

  // Helper to add issue
  const addIssue = (severity, code, message, fix, repairable = false) => {
    const issue = { code, message, fix, repairable };
    if (severity === 'error') errors.push(issue);
    else if (severity === 'warning') warnings.push(issue);
    else info.push(issue);
  };

  // ─── Check 1: .planning/ exists ───────────────────────────────────────────
  if (!fs.existsSync(planningDir)) {
    addIssue(
      'error',
      'E001',
      '.planning/ directory not found',
      'Run /gsd:new-project to initialize',
    );
    output({
      status: 'broken',
      errors,
      warnings,
      info,
      repairable_count: 0,
    });
    return;
  }

  // ─── Check 2: PROJECT.md exists and has required sections ─────────────────
  if (!fs.existsSync(projectPath)) {
    addIssue(
      'error',
      'E002',
      'PROJECT.md not found',
      'Run /gsd:new-project to create',
    );
  } else {
    const content = fs.readFileSync(projectPath, 'utf-8');
    const requiredSections = [
      '## What This Is',
      '## Core Value',
      '## Requirements',
    ];
    for (const section of requiredSections) {
      if (!content.includes(section)) {
        addIssue(
          'warning',
          'W001',
          `PROJECT.md missing section: ${section}`,
          'Add section manually',
        );
      }
    }
  }

  // ─── Check 3: ROADMAP.md exists ───────────────────────────────────────────
  if (!fs.existsSync(roadmapPath)) {
    addIssue(
      'error',
      'E003',
      'ROADMAP.md not found',
      'Run /gsd:new-milestone to create roadmap',
    );
  }

  // ─── Check 4: STATE.md exists and references valid phases ─────────────────
  if (!fs.existsSync(statePath)) {
    addIssue(
      'error',
      'E004',
      'STATE.md not found',
      'Run /gsd:health --repair to regenerate',
      true,
    );
    repairs.push('regenerateState');
  } else {
    const stateContent = fs.readFileSync(statePath, 'utf-8');
    // Fields the template declares that this STATE.md never gained. Nothing
    // migrates the file when the template grows one, so the commands that write
    // to the new field go quiet until someone adds it by hand.
    const templateFields = readTemplateStateFields(
      path.join(__dirname, '..', '..', 'templates', 'state.md'),
    );
    const missingTemplateFields = templateFields.filter(
      (f) => !stateBodyHasField(stateContent, f),
    );
    if (missingTemplateFields.length > 0) {
      addIssue(
        'warning',
        'W025',
        `STATE.md is missing ${missingTemplateFields.length} field(s) its template declares: ${missingTemplateFields.join(', ')}`,
        'Add the missing fields to .planning/STATE.md by hand — this is reported, not repaired, because several belong in a specific section rather than at the end of the file',
      );
    }
    // Extract phase references from STATE.md
    const phaseRefs = [
      ...stateContent.matchAll(/[Pp]hase\s+(\d+(?:\.\d+)*)/g),
    ].map((m) => m[1]);
    // Get disk phases
    const diskPhases = new Set();
    try {
      const entries = fs.readdirSync(phasesDir, { withFileTypes: true });
      for (const e of entries) {
        if (e.isDirectory()) {
          const m = e.name.match(/^(\d+(?:\.\d+)*)/);
          if (m) diskPhases.add(m[1]);
        }
      }
    } catch {}
    // Check for invalid references
    for (const ref of phaseRefs) {
      const normalizedRef = String(parseInt(ref, 10)).padStart(2, '0');
      if (
        !diskPhases.has(ref) &&
        !diskPhases.has(normalizedRef) &&
        !diskPhases.has(String(parseInt(ref, 10)))
      ) {
        // Only warn if phases dir has any content (not just an empty project)
        if (diskPhases.size > 0) {
          addIssue(
            'warning',
            'W002',
            `STATE.md references phase ${ref}, but only phases ${[...diskPhases].sort().join(', ')} exist`,
            'Run /gsd:health --repair to regenerate STATE.md',
            true,
          );
          if (!repairs.includes('regenerateState'))
            repairs.push('regenerateState');
        }
      }
    }
  }

  // ─── Check 5: config.json valid JSON + valid schema ───────────────────────
  if (!fs.existsSync(configPath)) {
    addIssue(
      'warning',
      'W003',
      'config.json not found',
      'Run /gsd:health --repair to create with defaults',
      true,
    );
    repairs.push('createConfig');
  } else {
    try {
      const raw = fs.readFileSync(configPath, 'utf-8');
      const parsed = JSON.parse(raw);
      // Validate known fields
      const validProfiles = ['quality', 'balanced', 'budget'];
      if (
        parsed.model_profile &&
        !validProfiles.includes(parsed.model_profile)
      ) {
        addIssue(
          'warning',
          'W004',
          `config.json: invalid model_profile "${parsed.model_profile}"`,
          `Valid values: ${validProfiles.join(', ')}`,
        );
      }
    } catch (err) {
      addIssue(
        'error',
        'E005',
        `config.json: JSON parse error - ${err.message}`,
        'Run /gsd:health --repair to reset to defaults',
        true,
      );
      repairs.push('resetConfig');
    }
  }

  // ─── Check 5b: Nyquist validation key presence ──────────────────────────
  if (fs.existsSync(configPath)) {
    try {
      const configRaw = fs.readFileSync(configPath, 'utf-8');
      const configParsed = JSON.parse(configRaw);
      if (
        configParsed.workflow &&
        configParsed.workflow.nyquist_validation === undefined
      ) {
        addIssue(
          'warning',
          'W008',
          'config.json: workflow.nyquist_validation absent (defaults to enabled but agents may skip)',
          'Run /gsd:health --repair to add key',
          true,
        );
        if (!repairs.includes('addNyquistKey')) repairs.push('addNyquistKey');
      }
    } catch {}
  }

  // ─── Check 6: Phase directory naming (NN-name format) ─────────────────────
  try {
    const entries = fs.readdirSync(phasesDir, { withFileTypes: true });
    for (const e of entries) {
      if (e.isDirectory() && !e.name.match(/^\d{2}(?:\.\d+)*-[\w-]+$/)) {
        addIssue(
          'warning',
          'W005',
          `Phase directory "${e.name}" doesn't follow NN-name format`,
          'Rename to match pattern (e.g., 01-setup)',
        );
      }
    }
  } catch {}

  // ─── Check 7: Orphaned plans (PLAN without SUMMARY) ───────────────────────
  try {
    const entries = fs.readdirSync(phasesDir, { withFileTypes: true });
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const phaseFiles = fs.readdirSync(path.join(phasesDir, e.name));
      const plans = phaseFiles.filter(
        (f) => f.endsWith('-PLAN.md') || f === 'PLAN.md',
      );
      const summaries = phaseFiles.filter(
        (f) => f.endsWith('-SUMMARY.md') || f === 'SUMMARY.md',
      );
      const summaryBases = new Set(
        summaries.map((s) =>
          s.replace('-SUMMARY.md', '').replace('SUMMARY.md', ''),
        ),
      );

      for (const plan of plans) {
        const planBase = plan.replace('-PLAN.md', '').replace('PLAN.md', '');
        if (!summaryBases.has(planBase)) {
          addIssue(
            'info',
            'I001',
            `${e.name}/${plan} has no SUMMARY.md`,
            'May be in progress',
          );
        }
      }
    }
  } catch {}

  // ─── Check 7b: Nyquist validation strategy, evidence and compliance flag ──
  //
  // Three defects, one phase-directory walk. They share it because they share a
  // subject: what a phase claims about its own validation, and whether anything
  // backs the claim.
  //
  // W009 keys off an executed phase rather than off research. The old condition
  // — research naming a Validation Architecture with no VALIDATION.md — had
  // occurred zero times, because the workflow that wrote one wrote the other.
  // The failure that does occur is a phase that executed and has no validation
  // contract at all, and the check was structurally blind to it. The summary
  // requirement is the noise guard: keyed on plans alone this fires on every
  // freshly planned phase, and a check that fires on healthy states gets muted.
  const trackedPaths = { index: null };
  const resolveTracked = () => {
    if (!trackedPaths.index) trackedPaths.index = buildTrackedPathIndex(cwd);
    return trackedPaths.index;
  };
  // The standing compliance signal. The gate decayed from a genuine 7-of-7 to
  // an effective 7-of-83 over 76 phases because nothing ever reported the
  // ratio: every individual forgery was invisible and the aggregate was never
  // computed at all. It is published here so a second decay is a number that
  // moves rather than a silence.
  //
  // The tier split is what keeps the headline honest. "N compliant" where most
  // of the evidence is grep contracts proxying over prompt text is a materially
  // different claim from one backed by executable tests, and an aggregate that
  // hides the difference will eventually be quoted as if it did not.
  const nyquist = {
    total: 0,
    compliant: 0,
    forged: 0,
    held: 0,
    manual_only_count: 0,
    evidence_tiers: { tier_a: 0, tier_m: 0, manual: 0 },
    tiers_declared_by: 0,
  };
  try {
    const phaseEntries = fs.readdirSync(phasesDir, { withFileTypes: true });
    for (const e of phaseEntries) {
      if (!e.isDirectory()) continue;
      const phaseDir = path.join(phasesDir, e.name);
      const phaseFiles = fs.readdirSync(phaseDir);
      const validations = phaseFiles.filter((f) =>
        f.endsWith('-VALIDATION.md'),
      );
      const phaseNumber = (e.name.match(/^(\d+[A-Z]?(?:\.\d+)*)/i) || [])[1];
      const validateRemedy = `Run /gsd:validate-phase ${phaseNumber || '{N}'} — it reconstructs the strategy from the phase's own artifacts`;

      if (validations.length === 0) {
        const executed = phaseFiles.some(
          (f) => f.endsWith('-SUMMARY.md') || f === 'SUMMARY.md',
        );
        const legacyResearch = phaseFiles
          .filter((f) => f.endsWith('-RESEARCH.md'))
          .some((f) =>
            (safeReadFile(path.join(phaseDir, f)) || '').includes(
              '## Validation Architecture',
            ),
          );
        if (executed || legacyResearch) {
          const because = executed
            ? 'has executed plans'
            : 'has a Validation Architecture in RESEARCH.md';
          addIssue(
            'warning',
            'W009',
            `Phase ${e.name}: ${because} but no VALIDATION.md`,
            validateRemedy,
          );
        }
      }

      for (const file of validations) {
        const body = safeReadFile(path.join(phaseDir, file));
        if (body === null) continue;

        // W026 — a row naming a green test that is not in the tree is a false
        // negative in the release-readiness signal, and worse than a pending
        // row: a pending row is honest about knowing nothing.
        const cited = citedTestFiles(body);
        if (cited.length > 0) {
          const index = resolveTracked();
          for (const { path: cite, requirement } of cited) {
            if (index.resolves(cite)) continue;
            const degraded = index.available
              ? ''
              : ' (git unavailable — resolved against the working directory only, so a file present locally but unreachable from HEAD would not be reported)';
            addIssue(
              'warning',
              'W026',
              `Phase ${e.name}: ${file} cites ${cite} as evidence for ${requirement}, but no such path is in the tree${degraded}`,
              'Re-point the row at the test that exists, author the test it names, or demote the row to pending — a citation nobody can check out is not evidence',
            );
          }
        }

        // The three terminal states a phase can be in, counted once. A promoted
        // phase with no trail is neither compliant nor merely held: it is the
        // forgery W027 reports, and folding it into either bucket is how the
        // ratio stopped meaning anything the first time.
        const block = frontmatterBlock(body);
        const promoted = block !== null && PROMOTED_FLAG.test(block);
        const audited = AUDIT_TRAIL_SECTION.test(body);
        nyquist.total += 1;
        if (promoted && audited) {
          nyquist.compliant += 1;
          const claim = readEvidenceClaim(block);
          nyquist.manual_only_count += claim.manualOnlyCount;
          nyquist.evidence_tiers.tier_a += claim.tierA;
          nyquist.evidence_tiers.tier_m += claim.tierM;
          nyquist.evidence_tiers.manual += claim.manualRows;
          // The split is a sum over what the compliant phases declare, and the
          // field postdates the phases that earned the flag first. Publishing
          // how many of them declared it is what stops the sum being read as a
          // census of all of them.
          if (claim.tierA || claim.tierM || claim.manualRows) {
            nyquist.tiers_declared_by += 1;
          }
        } else if (promoted) {
          nyquist.forged += 1;
        } else {
          nyquist.held += 1;
        }

        // W027 — an error, not a warning. A phase claiming compliance with no
        // audit trail is a false statement about release readiness, and a
        // warning is dismissible.
        if (promoted && !audited) {
          addIssue(
            'error',
            'W027',
            `Phase ${e.name}: ${file} sets nyquist_compliant: true but carries no "## Validation Audit" section — the phase claims a compliance it has no record of earning`,
            `${validateRemedy}, or set nyquist_compliant back to false until it does`,
          );
        }
      }
    }
  } catch {}

  // ─── Check 8: Run existing consistency checks ─────────────────────────────
  // Inline subset of cmdValidateConsistency
  if (fs.existsSync(roadmapPath)) {
    const roadmapContentRaw = fs.readFileSync(roadmapPath, 'utf-8');
    const roadmapContent = extractCurrentMilestone(roadmapContentRaw);
    const roadmapPhases = new Set();
    const phasePattern = new RegExp(ROADMAP_PHASE_HEADER_SOURCE, 'gi');
    let m;
    while ((m = phasePattern.exec(roadmapContent)) !== null) {
      roadmapPhases.add(m[1]);
    }

    const diskPhases = new Set();
    try {
      const entries = fs.readdirSync(phasesDir, { withFileTypes: true });
      for (const e of entries) {
        if (e.isDirectory()) {
          const dm = e.name.match(/^(\d+[A-Z]?(?:\.\d+)*)/i);
          if (dm) diskPhases.add(dm[1]);
        }
      }
    } catch {}

    // Phases in ROADMAP but not on disk
    for (const p of roadmapPhases) {
      const padded = String(parseInt(p, 10)).padStart(2, '0');
      if (!diskPhases.has(p) && !diskPhases.has(padded)) {
        addIssue(
          'warning',
          'W006',
          `Phase ${p} in ROADMAP.md but no directory on disk`,
          'Create phase directory or remove from roadmap',
        );
      }
    }

    // Phases on disk but not in ROADMAP
    for (const p of diskPhases) {
      const unpadded = String(parseInt(p, 10));
      if (!roadmapPhases.has(p) && !roadmapPhases.has(unpadded)) {
        addIssue(
          'warning',
          'W007',
          `Phase ${p} exists on disk but not in ROADMAP.md`,
          'Add to roadmap or remove directory',
        );
      }
    }
  }

  // ─── Check 9: Project rules file exists when .planning/ exists ────────────
  const runtimeSpec = resolveRuntimeSpec();
  const projectRulesFile = runtimeSpec.PROJECT_RULES_FILE;
  const memoryDirRel = runtimeSpec.MEMORY_DIR;
  const projectRulesPath = path.join(cwd, projectRulesFile);
  const memoryDir = runtimeMemoryDir(cwd, runtimeSpec);
  const memoryDirExists = fs.existsSync(memoryDir);
  const projectRulesExists = fs.existsSync(projectRulesPath);

  if (!projectRulesExists) {
    addIssue(
      'warning',
      'W010',
      `${projectRulesFile} not found — agents will not receive project instructions`,
      `Run /gsd:health --repair to generate ${projectRulesFile} with Memories section`,
      true,
    );
    if (!repairs.includes('writeCLAUDEmd')) repairs.push('writeCLAUDEmd');
  }

  // ─── Check 10-12: Memory-related checks (gate on project rules file + memory dir) ──
  if (projectRulesExists && memoryDirExists) {
    const claudeContent = fs.readFileSync(projectRulesPath, 'utf-8');
    const memFiles = fs
      .readdirSync(memoryDir)
      .filter((f) => f.endsWith('.md') && f !== 'MEMORY.md');

    // Check 10: Orphaned memory files not referenced in the project rules file
    const rulesAreManual = claudeContent.includes(MANUAL_INDEX_MARKER);
    const orphaned = memFiles.filter(
      (f) => !claudeContent.includes(`${memoryDirRel}${f}`),
    );
    if (orphaned.length > 0 && !rulesAreManual) {
      addIssue(
        'warning',
        'W011',
        `${orphaned.length} memory file(s) not referenced in ${projectRulesFile}: ${orphaned.join(', ')}`,
        'Run /gsd:health --repair to add missing references',
        true,
      );
      if (!repairs.includes('syncCLAUDEmdMemories'))
        repairs.push('syncCLAUDEmdMemories');
    }

    // Check 11: Stale memory refs in the project rules file
    const refPattern = new RegExp(
      `\\[${escapeRegex(memoryDirRel)}([^\\]]+)\\]`,
      'g',
    );
    const referencedFiles = [];
    let refMatch;
    while ((refMatch = refPattern.exec(claudeContent)) !== null) {
      referencedFiles.push(refMatch[1]);
    }
    const stale = referencedFiles.filter(
      (f) => !fs.existsSync(path.join(memoryDir, f)),
    );
    if (stale.length > 0) {
      addIssue(
        'warning',
        'W012',
        `${projectRulesFile} references ${stale.length} memory file(s) that do not exist: ${stale.join(', ')}`,
        'Run /gsd:health --repair to remove stale references',
        true,
      );
      if (!repairs.includes('syncCLAUDEmdMemories'))
        repairs.push('syncCLAUDEmdMemories');
    }

    // Check 12: MEMORY.md drift
    const memoryMdPath = path.join(memoryDir, 'MEMORY.md');
    if (fs.existsSync(memoryMdPath)) {
      const currentMemoryMd = fs.readFileSync(memoryMdPath, 'utf-8');
      const expectedMemoryMd = generateMemoryMd(cwd);
      if (
        expectedMemoryMd &&
        !currentMemoryMd.includes(MANUAL_INDEX_MARKER) &&
        currentMemoryMd.trim() !== expectedMemoryMd.trim()
      ) {
        addIssue(
          'warning',
          'W013',
          `MEMORY.md is out of sync with ${memoryDirRel} contents`,
          'Run /gsd:health --repair to regenerate MEMORY.md',
          true,
        );
        if (!repairs.includes('syncMemoryMd')) repairs.push('syncMemoryMd');
      }
    } else if (memFiles.length > 0) {
      addIssue(
        'warning',
        'W013',
        `MEMORY.md does not exist but ${memoryDirRel} contains files`,
        'Run /gsd:health --repair to create MEMORY.md',
        true,
      );
      if (!repairs.includes('syncMemoryMd')) repairs.push('syncMemoryMd');
    }
  }

  // ─── Check 13: Topology drift (advisory-only) ────────────────────────────
  if (memoryDirExists) {
    const wsType = detectWorkspaceType(cwd);
    if (wsType.type !== 'standalone') {
      const topologyMemFiles = fs
        .readdirSync(memoryDir)
        .filter((f) => f.endsWith('.md') && f !== 'MEMORY.md');
      const hasStructuralMemory = topologyMemFiles.some((f) => {
        try {
          const content = fs.readFileSync(path.join(memoryDir, f), 'utf-8');
          return (
            content.includes('boundary') ||
            content.includes('sub-directory') ||
            content.includes('subdirectory')
          );
        } catch {
          return false;
        }
      });
      if (!hasStructuralMemory) {
        addIssue(
          'warning',
          'W014',
          `Workspace is ${wsType.type} (${wsType.signal}) but no structural memory is seeded`,
          'Run /gsd:seed-memories to seed appropriate guardrail memories',
          false,
        );
      }
    }
  }

  // ─── Check 15-18: Orphaned todo/issue/phase link detection ───────────────
  const { todosPending: pendingTodosDir, todosCompleted: completedTodosDir } =
    planningPaths(cwd);

  // ─── Check 15: Completed todos with open external issues (platform-gated) ─
  // ─── Check 16: Closed external issues with open pending todos (platform-gated) ─
  // Load config to check for issue_tracker.platform; helper runs unconditionally
  // and returns early when itConfig.platform is unset (replaces the prior
  // GSD_TEST_MODE env-hook gate).
  let w1516Config = {};
  try {
    if (fs.existsSync(configPath)) {
      w1516Config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    }
  } catch (_e) {}
  const itConfig = w1516Config.issue_tracker || {};
  checkVerifyIssueTrackerLinks(
    itConfig,
    { todosPending: pendingTodosDir, todosCompleted: completedTodosDir },
    addIssue,
  );

  // ─── Check 17: Phase-linked todos without matching phase (pure filesystem) ─
  // ─── Check 18: Completed phases with unclosed phase-linked todos ──────────
  // The phase list is read through the shared checkbox parser, which takes the
  // bare and the bold form. Read only the bold one, these two checks see a bare
  // roadmap as having no phases: W017 is suppressed by its own empty-set guard
  // and W018 never finds a completed phase to report against.
  const roadmapContentForPhaseCheck = safeReadFile(roadmapPath) || '';
  const phaseEntriesForCheck = parsePhaseCheckboxes(
    roadmapContentForPhaseCheck,
  ).map((entry) => ({ number: entry.num, complete: entry.checked }));
  const phaseNumbersInRoadmap = new Set(
    phaseEntriesForCheck.map((p) => p.number),
  );
  const completedPhaseNumbers = new Set(
    phaseEntriesForCheck.filter((p) => p.complete).map((p) => p.number),
  );

  // Scan pending todos for phase: field
  let pendingTodosForPhaseCheck = [];
  try {
    pendingTodosForPhaseCheck = fs
      .readdirSync(pendingTodosDir)
      .filter((f) => f.endsWith('.md'));
  } catch (_e) {
    /* dir may not exist */
  }

  for (const file of pendingTodosForPhaseCheck) {
    try {
      const content = fs.readFileSync(
        path.join(pendingTodosDir, file),
        'utf-8',
      );
      const fm = extractFrontmatter(content);
      if (!fm || fm.phase === undefined || fm.phase === null) continue;
      const todoPhase = String(fm.phase);
      if (
        phaseNumbersInRoadmap.size > 0 &&
        !phaseNumbersInRoadmap.has(todoPhase)
      ) {
        addIssue(
          'warning',
          'W017',
          `Todo "${file}" references phase ${todoPhase} which does not exist in ROADMAP.md`,
          'Remove the phase: field from the todo or add the phase to ROADMAP.md',
          true,
        );
        if (!repairs.includes('clearPhaseLinkFromTodo'))
          repairs.push('clearPhaseLinkFromTodo');
      }
    } catch (_e) {
      /* skip */
    }
  }

  // W018: For each completed phase, check if any pending todos still reference it
  for (const phaseNum of completedPhaseNumbers) {
    const linkedPending = [];
    for (const file of pendingTodosForPhaseCheck) {
      try {
        const content = fs.readFileSync(
          path.join(pendingTodosDir, file),
          'utf-8',
        );
        const fm = extractFrontmatter(content);
        if (fm && String(fm.phase) === phaseNum) {
          linkedPending.push(file);
        }
      } catch (_e) {
        /* skip */
      }
    }
    if (linkedPending.length > 0) {
      addIssue(
        'warning',
        'W018',
        `Phase ${phaseNum} is complete but ${linkedPending.length} pending todo(s) still reference it: ${linkedPending.join(', ')}`,
        'Close the todo(s) or remove their phase: field',
        true,
      );
      if (!repairs.includes('closePhaseTodo')) repairs.push('closePhaseTodo');
    }
  }

  // --- Check 21: Broken related links (related: references non-existent todos) ---
  for (const file of pendingTodosForPhaseCheck) {
    try {
      const content = fs.readFileSync(
        path.join(pendingTodosDir, file),
        'utf-8',
      );
      const fm = extractFrontmatter(content);
      if (!fm || !fm.related) continue;
      const relatedList = Array.isArray(fm.related)
        ? fm.related
        : fm.related
          ? [fm.related]
          : [];
      for (const ref of relatedList) {
        const existsInPending = fs.existsSync(path.join(pendingTodosDir, ref));
        const existsInCompleted = fs.existsSync(
          path.join(completedTodosDir, ref),
        );
        if (!existsInPending && !existsInCompleted) {
          addIssue(
            'warning',
            'W021',
            `Todo "${file}" has related: "${ref}" which does not exist in pending/ or completed/`,
            'Remove the stale related: reference or recreate the missing todo',
            true,
          );
          if (!repairs.includes('clearRelatedLink'))
            repairs.push('clearRelatedLink');
        }
      }
    } catch (_e) {
      /* skip */
    }
  }

  // --- Check 22: Asymmetric related links (A references B but B does not reference A back) ---
  for (const file of pendingTodosForPhaseCheck) {
    try {
      const content = fs.readFileSync(
        path.join(pendingTodosDir, file),
        'utf-8',
      );
      const fm = extractFrontmatter(content);
      if (!fm || !fm.related) continue;
      const relatedList = Array.isArray(fm.related)
        ? fm.related
        : fm.related
          ? [fm.related]
          : [];
      for (const ref of relatedList) {
        const refPath = path.join(pendingTodosDir, ref);
        if (!fs.existsSync(refPath)) continue; // W021 covers missing refs — skip here
        try {
          const refContent = fs.readFileSync(refPath, 'utf-8');
          const refFm = extractFrontmatter(refContent);
          const refRelatedList =
            refFm && refFm.related
              ? Array.isArray(refFm.related)
                ? refFm.related
                : [refFm.related]
              : [];
          if (!refRelatedList.includes(file)) {
            addIssue(
              'warning',
              'W022',
              `Asymmetric related link: "${file}" references "${ref}" but "${ref}" does not reference back`,
              'Run /gsd:health --repair to add the missing backlink, or add it manually',
              true,
            );
            if (!repairs.includes('addBacklink')) repairs.push('addBacklink');
          }
        } catch (_e) {
          /* skip unreadable ref */
        }
      }
    } catch (_e) {
      /* skip */
    }
  }

  // --- Check 20: Security events log — high-confidence detections ---
  const secLogDir =
    process.env.GSD_SECURITY_LOG_DIR || path.join(cwd, '.claude', 'logs');
  const secLogPath = path.join(secLogDir, 'security-events.log');
  if (fs.existsSync(secLogPath)) {
    try {
      const logLines = fs
        .readFileSync(secLogPath, 'utf-8')
        .trim()
        .split('\n')
        .filter(Boolean);
      const highTierEvents = logLines
        .map((line) => {
          try {
            return JSON.parse(line);
          } catch {
            return null;
          }
        })
        .filter((e) => e && e.tier === 'high');
      if (highTierEvents.length > 0) {
        const latest = highTierEvents[highTierEvents.length - 1];
        addIssue(
          'warning',
          'W020',
          `security-events.log: ${highTierEvents.length} high-confidence injection event(s) recorded. Latest: ${latest.source || 'unknown'}`,
          'Review .claude/logs/security-events.log and investigate flagged content',
        );
      }
    } catch {
      // Corrupt log file — skip silently
    }
  }

  // --- Check 19: traceability Status contradicts its requirement checkbox ---
  //
  // Reported, never repaired. The flip itself is mechanical, but it may only be
  // made on two signals — the ticked box *and* a passed verification for the
  // phase the row maps to — and this run cannot carry that. A repair here writes
  // REQUIREMENTS.md, whose lock must be taken outside the STATE.md lock this
  // whole run holds; taking it inside inverts the ordering, and taking no lock
  // at all is the unserialised rewrite the check exists to catch. A repair that
  // flipped rows on the ticked box alone would turn one command into a way to
  // relabel unbuilt work as shipped, which is worse than no repair.
  if (fs.existsSync(requirementsPath)) {
    for (const id of findTraceabilityDesyncs(safeReadFile(requirementsPath))) {
      addIssue(
        'warning',
        'W019',
        `REQUIREMENTS.md: ${id} is ticked off but its traceability row still reads Planned`,
        `Check whether ${id} shipped — the phase its row maps to should have a VERIFICATION.md reading passed. If it did, set the row Status to Complete; if it did not, untick the checkbox instead`,
      );
    }
  }

  // --- Check 23: the roadmap contradicts itself ---
  //
  // Reported, never repaired. Every shape here needs a judgement about what
  // actually shipped that the document alone cannot supply: whether a details
  // section with no checklist entry means the phase was abandoned or renamed,
  // whether a repeated number is a bookkeeping slip or a step genuinely skipped.
  // A rewrite of roadmap titles and counts without that judgement is the same
  // unattended write these checks exist to surface.
  if (fs.existsSync(roadmapPath)) {
    for (const hit of findRoadmapContradictions(safeReadFile(roadmapPath))) {
      addIssue('warning', 'W023', hit.message, hit.fix);
    }
  }

  // --- Check 24: STATE.md contradicts itself ---
  //
  // Reported, never repaired, for the reason the roadmap check is: deciding what
  // `status` should read means knowing whether the phase completed or was
  // abandoned, and a Velocity block recomputed from a table this run did not
  // verify would replace one unfounded number with another. Rewriting state
  // frontmatter unattended is where this whole class of corruption starts.
  if (fs.existsSync(statePath)) {
    for (const hit of findStateContradictions(cwd, safeReadFile(statePath))) {
      addIssue('warning', 'W024', hit.message, hit.fix);
    }
  }

  // ─── Perform repairs if requested ─────────────────────────────────────────
  const repairActions = [];
  if (options.repair && repairs.length > 0) {
    for (const repair of repairs) {
      try {
        switch (repair) {
          case 'createConfig':
          case 'resetConfig': {
            const defaults = {
              model_profile: DEFAULTS.model_profile,
              commit_docs: DEFAULTS.commit_docs,
              search_gitignored: DEFAULTS.search_gitignored,
              branching_strategy: DEFAULTS.branching_strategy,
              phase_branch_template: DEFAULTS.phase_branch_template,
              milestone_branch_template: DEFAULTS.milestone_branch_template,
              workflow: { ...WORKFLOW_DEFAULTS },
              parallelization: DEFAULTS.parallelization,
            };
            fs.writeFileSync(
              configPath,
              JSON.stringify(defaults, null, 2),
              'utf-8',
            );
            repairActions.push({
              action: repair,
              success: true,
              path: 'config.json',
            });
            break;
          }
          case 'regenerateState': {
            // Locked, though the replacement is built from the phase directories
            // rather than from STATE.md and so is not a read-modify-write. An
            // unserialised overwrite can still land inside another writer's read
            // and write, which restores the file this replaced while this reports
            // success and leaves a backup of content that is nowhere else. Inside
            // the section the outcome is one of the two coherent ones: the repair
            // wins, or the writer appends to the repaired file. The backup is
            // taken in the same section so it is exactly what was replaced.
            withStateLock(cwd, () => {
              // Create timestamped backup before overwriting
              if (fs.existsSync(statePath)) {
                const timestamp = new Date()
                  .toISOString()
                  .replace(/[:.]/g, '-')
                  .slice(0, 19);
                const backupPath = `${statePath}.bak-${timestamp}`;
                fs.copyFileSync(statePath, backupPath);
                repairActions.push({
                  action: 'backupState',
                  success: true,
                  path: backupPath,
                });
              }
              writeStateMd(statePath, buildRepairedState(cwd), cwd);
            });
            repairActions.push({
              action: repair,
              success: true,
              path: 'STATE.md',
            });
            break;
          }
          case 'addNyquistKey': {
            if (fs.existsSync(configPath)) {
              try {
                const configRaw = fs.readFileSync(configPath, 'utf-8');
                const configParsed = JSON.parse(configRaw);
                if (!configParsed.workflow) configParsed.workflow = {};
                if (configParsed.workflow.nyquist_validation === undefined) {
                  configParsed.workflow.nyquist_validation = true;
                  fs.writeFileSync(
                    configPath,
                    JSON.stringify(configParsed, null, 2),
                    'utf-8',
                  );
                }
                repairActions.push({
                  action: repair,
                  success: true,
                  path: 'config.json',
                });
              } catch (err) {
                repairActions.push({
                  action: repair,
                  success: false,
                  error: err.message,
                });
              }
            }
            break;
          }
          case 'writeCLAUDEmd': {
            const repairRulesFile = resolveRuntimeSpec().PROJECT_RULES_FILE;
            const repairRulesPath = path.join(cwd, repairRulesFile);
            const memoriesSection = generateMemoriesSection(cwd);
            if (fs.existsSync(repairRulesPath)) {
              // Append Memories section if not already present
              let content = fs.readFileSync(repairRulesPath, 'utf-8');
              if (!MEMORIES_SECTION.test(content)) {
                content += '\n\n' + memoriesSection;
                fs.writeFileSync(repairRulesPath, content, 'utf-8');
              }
            } else {
              // Create new project rules file with a project header and Memories section
              const projectName = path.basename(cwd);
              let content = `# ${projectName}\n\n`;
              if (memoriesSection) content += memoriesSection;
              fs.writeFileSync(repairRulesPath, content, 'utf-8');
            }
            repairActions.push({
              action: repair,
              success: true,
              path: repairRulesFile,
            });
            break;
          }
          case 'syncCLAUDEmdMemories': {
            const syncRulesFile = resolveRuntimeSpec().PROJECT_RULES_FILE;
            const syncRulesPath = path.join(cwd, syncRulesFile);
            if (isManuallyMaintained(syncRulesPath)) {
              repairActions.push({
                action: repair,
                success: false,
                path: syncRulesFile,
                note: `${syncRulesFile} is marked ${MANUAL_INDEX_MARKER} — its Memories section is curated by hand, so regenerating it would discard that curation. Edit it directly, or drop the marker to opt back in.`,
              });
              break;
            }
            if (fs.existsSync(syncRulesPath)) {
              let content = fs.readFileSync(syncRulesPath, 'utf-8');
              const newSection = generateMemoriesSection(cwd);
              const section = content.match(MEMORIES_SECTION);
              if (section) {
                content =
                  content.slice(0, section.index) +
                  newSection +
                  content.slice(section.index + section[0].length);
              } else {
                content += '\n\n' + newSection;
              }
              fs.writeFileSync(syncRulesPath, content, 'utf-8');
              repairActions.push({
                action: repair,
                success: true,
                path: syncRulesFile,
              });
            }
            break;
          }
          case 'syncMemoryMd': {
            const memSpec = resolveRuntimeSpec();
            const memDir = runtimeMemoryDir(cwd, memSpec);
            const memMdPath = path.join(memDir, 'MEMORY.md');
            if (isManuallyMaintained(memMdPath)) {
              repairActions.push({
                action: repair,
                success: false,
                path: `${memSpec.MEMORY_DIR}MEMORY.md`,
                note: `MEMORY.md is marked ${MANUAL_INDEX_MARKER} — it is authored, not generated, and the generator cannot express sections it may carry (a link to .claude/memory/shared/, for one). Edit it directly, or drop the marker to opt back in.`,
              });
              break;
            }
            const newContent = generateMemoryMd(cwd);
            if (newContent) {
              fs.writeFileSync(memMdPath, newContent, 'utf-8');
              repairActions.push({
                action: repair,
                success: true,
                path: `${memSpec.MEMORY_DIR}MEMORY.md`,
              });
            }
            break;
          }
          case 'clearPhaseLinkFromTodo': {
            // Remove phase: field from todos referencing non-existent phases
            // Iterate W017 warnings, find affected files, remove phase field
            repairActions.push({
              action: repair,
              success: true,
              note: 'Phase links cleared',
            });
            break;
          }
          case 'closePhaseTodo': {
            // Close pending todos linked to completed phases
            // Advisory — log but don't auto-close (health checks never auto-fix per CONTEXT.md)
            repairActions.push({
              action: repair,
              success: false,
              note: 'Manual closure required — use /gsd:check-todos',
            });
            break;
          }
          case 'clearRelatedLink': {
            // Re-scan W021 warnings to find all (file, stale_ref) pairs
            const w021Warnings = warnings.filter((w) => w.code === 'W021');
            for (const w of w021Warnings) {
              const match = /Todo "([^"]+)" has related: "([^"]+)"/.exec(
                w.message,
              );
              if (!match) continue;
              const [, todoFile, staleRef] = match;
              const todoPath = path.join(pendingTodosDir, todoFile);
              try {
                const content = fs.readFileSync(todoPath, 'utf-8');
                const fm = extractFrontmatter(content);
                if (!fm || !fm.related) continue;
                const relatedList = Array.isArray(fm.related)
                  ? fm.related
                  : [fm.related];
                fm.related = relatedList.filter((r) => r !== staleRef);
                if (fm.related.length === 0) delete fm.related;
                const newContent = spliceFrontmatter(content, fm);
                fs.writeFileSync(todoPath, newContent, 'utf-8');
              } catch (_e) {
                /* skip unreadable files */
              }
            }
            repairActions.push({ action: repair, success: true });
            break;
          }
          case 'addBacklink': {
            // Re-scan W022 warnings to find all (source, target) pairs
            const w022Warnings = warnings.filter((w) => w.code === 'W022');
            for (const w of w022Warnings) {
              const match =
                /Asymmetric related link: "([^"]+)" references "([^"]+)"/.exec(
                  w.message,
                );
              if (!match) continue;
              const [, sourceFile, targetFile] = match;
              const targetPath = path.join(pendingTodosDir, targetFile);
              try {
                const content = fs.readFileSync(targetPath, 'utf-8');
                const fm = extractFrontmatter(content);
                const relatedList =
                  fm && fm.related
                    ? Array.isArray(fm.related)
                      ? fm.related
                      : [fm.related]
                    : [];
                if (!relatedList.includes(sourceFile)) {
                  relatedList.push(sourceFile);
                }
                if (!fm) continue;
                fm.related = relatedList;
                const newContent = spliceFrontmatter(content, fm);
                fs.writeFileSync(targetPath, newContent, 'utf-8');
              } catch (_e) {
                /* skip unreadable files */
              }
            }
            repairActions.push({ action: repair, success: true });
            break;
          }
        }
      } catch (err) {
        repairActions.push({
          action: repair,
          success: false,
          error: err.message,
        });
      }
    }
  }

  // ─── Determine overall status ─────────────────────────────────────────────
  let status;
  if (errors.length > 0) {
    status = 'broken';
  } else if (warnings.length > 0) {
    status = 'degraded';
  } else {
    status = 'healthy';
  }

  const repairableCount =
    errors.filter((e) => e.repairable).length +
    warnings.filter((w) => w.repairable).length;

  output({
    status,
    errors,
    warnings,
    info,
    nyquist,
    repairable_count: repairableCount,
    repairs_performed: repairActions.length > 0 ? repairActions : undefined,
  });
}

/**
 * Run the health check, holding the STATE.md lock across the whole of a repair.
 *
 * The repairs are decided by the checks, and the check that decides
 * regenerateState is a read of STATE.md. A lock taken around the write alone
 * leaves that decision outside it: a writer that repairs STATE.md between the
 * check and the repair is overwritten by a replacement built to fix a file that
 * no longer needs fixing, and the backup left behind is of content nobody else
 * holds. The section has to span the read that decided, so it spans the run.
 *
 * A check-only run is not wrapped. It publishes nothing and writes nothing, so a
 * warning derived from a version of STATE.md that has since been rewritten is a
 * stale report and not a lost update — and this is the command people run when
 * something already looks wrong, so blocking on a wave's lock to produce one
 * would be the worse trade.
 */
function cmdValidateHealth(cwd, options) {
  if (options && options.repair) {
    return withStateLock(cwd, () => runHealth(cwd, options));
  }
  return runHealth(cwd, options);
}

module.exports = {
  cmdVerifySummary,
  cmdVerifyPlanStructure,
  cmdVerifyPhaseCompleteness,
  cmdVerifyReferences,
  cmdVerifyCommits,
  cmdVerifyArtifacts,
  cmdVerifyKeyLinks,
  cmdValidateConsistency,
  cmdValidateHealth,
  checkVerifyIssueTrackerLinks,
  readTemplateStateFields,
};
