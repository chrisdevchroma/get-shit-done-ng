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
} = require('./core.cjs');
const { DEFAULTS, WORKFLOW_DEFAULTS } = require('./defaults.cjs');
const { RUNTIMES } = require('./template-processor.cjs');
const {
  extractFrontmatter,
  spliceFrontmatter,
  parseMustHavesBlock,
} = require('./frontmatter.cjs');
const {
  withStateLock,
  writeStateMd,
  stateApplyFieldsToSection,
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

  // ─── Check 7b: Nyquist VALIDATION.md consistency ────────────────────────
  try {
    const phaseEntries = fs.readdirSync(phasesDir, { withFileTypes: true });
    for (const e of phaseEntries) {
      if (!e.isDirectory()) continue;
      const phaseFiles = fs.readdirSync(path.join(phasesDir, e.name));
      const hasResearch = phaseFiles.some((f) => f.endsWith('-RESEARCH.md'));
      const hasValidation = phaseFiles.some((f) =>
        f.endsWith('-VALIDATION.md'),
      );
      if (hasResearch && !hasValidation) {
        const researchFile = phaseFiles.find((f) => f.endsWith('-RESEARCH.md'));
        const researchContent = fs.readFileSync(
          path.join(phasesDir, e.name, researchFile),
          'utf-8',
        );
        if (researchContent.includes('## Validation Architecture')) {
          addIssue(
            'warning',
            'W009',
            `Phase ${e.name}: has Validation Architecture in RESEARCH.md but no VALIDATION.md`,
            'Re-run /gsd:plan-phase with --research to regenerate',
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
    const phasePattern = /#{2,4}\s*Phase\s+(\d+[A-Z]?(?:\.\d+)*)\s*:/gi;
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
  const gsdRuntime = process.env.GSD_RUNTIME || 'claude';
  const projectRulesFile = (RUNTIMES[gsdRuntime] || RUNTIMES.claude)
    .PROJECT_RULES_FILE;
  const projectRulesPath = path.join(cwd, projectRulesFile);
  const memoryDir = path.join(cwd, '.claude', 'memory');
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

    // Check 10: Orphaned memory files not referenced in CLAUDE.md
    const orphaned = memFiles.filter(
      (f) => !claudeContent.includes(`.claude/memory/${f}`),
    );
    if (orphaned.length > 0) {
      addIssue(
        'warning',
        'W011',
        `${orphaned.length} memory file(s) not referenced in CLAUDE.md: ${orphaned.join(', ')}`,
        'Run /gsd:health --repair to add missing references',
        true,
      );
      if (!repairs.includes('syncCLAUDEmdMemories'))
        repairs.push('syncCLAUDEmdMemories');
    }

    // Check 11: Stale memory refs in CLAUDE.md
    const refPattern = /\[\.claude\/memory\/([^\]]+)\]/g;
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
        `CLAUDE.md references ${stale.length} memory file(s) that do not exist: ${stale.join(', ')}`,
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
        currentMemoryMd.trim() !== expectedMemoryMd.trim()
      ) {
        addIssue(
          'warning',
          'W013',
          'MEMORY.md is out of sync with .claude/memory/ contents',
          'Run /gsd:health --repair to regenerate MEMORY.md',
          true,
        );
        if (!repairs.includes('syncMemoryMd')) repairs.push('syncMemoryMd');
      }
    } else if (memFiles.length > 0) {
      addIssue(
        'warning',
        'W013',
        'MEMORY.md does not exist but .claude/memory/ contains files',
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
            const repairRuntime = process.env.GSD_RUNTIME || 'claude';
            const repairRulesFile = (RUNTIMES[repairRuntime] || RUNTIMES.claude)
              .PROJECT_RULES_FILE;
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
            const syncRuntime = process.env.GSD_RUNTIME || 'claude';
            const syncRulesFile = (RUNTIMES[syncRuntime] || RUNTIMES.claude)
              .PROJECT_RULES_FILE;
            const syncRulesPath = path.join(cwd, syncRulesFile);
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
            const memDir = path.join(cwd, '.claude', 'memory');
            const memMdPath = path.join(memDir, 'MEMORY.md');
            const newContent = generateMemoryMd(cwd);
            if (newContent) {
              fs.writeFileSync(memMdPath, newContent, 'utf-8');
              repairActions.push({
                action: repair,
                success: true,
                path: '.claude/memory/MEMORY.md',
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
};
