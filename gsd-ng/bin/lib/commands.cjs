/**
 * Commands — Standalone utility commands
 */
const fs = require('fs');
const path = require('path');
const { execSync, spawnSync } = require('child_process');
const os = require('os');
const {
  safeReadFile,
  loadConfig,
  isGitIgnored,
  execGit,
  normalizePhaseName,
  comparePhaseNum,
  getArchivedPhaseDirs,
  generateSlugInternal,
  getMilestoneInfo,
  getMilestonePhaseFilter,
  resolveModelInternal,
  resolveEffortInternal,
  extractCurrentMilestone,
  getPhaseCompletionStatus,
  toPosixPath,
  output,
  error,
  findPhaseInternal,
  planningPaths,
  getEngineRuntime,
} = require('./core.cjs');
const { extractFrontmatter } = require('./frontmatter.cjs');
const { MODEL_PROFILES, EFFORT_PROFILES } = require('./model-profiles.cjs');
const {
  validatePath,
  scanForInjection,
  wrapUntrustedContent,
  logSecurityEvent,
} = require('./security.cjs');
const {
  getPlatformCliPatterns,
  PLATFORM_TO_CLI,
  getReadEditWriteAllowRules,
  RW_FORMS,
} = require('./allowlist.cjs');
const {
  compareSemVer,
  parseChannel,
  selectLatestForChannel,
} = require('./semver-utils.cjs');

function cmdGenerateSlug(text) {
  if (!text) {
    error('text required for slug generation');
  }

  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

  const result = { slug };
  output(result, slug);
}

function cmdCurrentTimestamp(format) {
  const now = new Date();
  let result;

  switch (format) {
    case 'date':
      result = now.toISOString().split('T')[0];
      break;
    case 'filename':
      result = now.toISOString().replace(/:/g, '-').replace(/\..+/, '');
      break;
    case 'full':
    default:
      result = now.toISOString();
      break;
  }

  output({ timestamp: result }, result);
}

function cmdListTodos(cwd, area) {
  const { todosPending: pendingDir } = planningPaths(cwd);

  let count = 0;
  const todos = [];

  try {
    const files = fs.readdirSync(pendingDir).filter((f) => f.endsWith('.md'));

    for (const file of files) {
      try {
        const content = fs.readFileSync(path.join(pendingDir, file), 'utf-8');
        const createdMatch = content.match(/^created:\s*(.+)$/m);
        const titleMatch = content.match(/^title:\s*(.+)$/m);
        const areaMatch = content.match(/^area:\s*(.+)$/m);

        const todoArea = areaMatch ? areaMatch[1].trim() : 'general';

        // Apply area filter if specified
        if (area && todoArea !== area) continue;

        count++;
        todos.push({
          file,
          created: createdMatch ? createdMatch[1].trim() : 'unknown',
          title: titleMatch ? titleMatch[1].trim() : 'Untitled',
          area: todoArea,
          path: toPosixPath(path.join('.planning', 'todos', 'pending', file)),
        });
      } catch {}
    }
  } catch {}

  const result = { count, todos };
  output(result, count.toString());
}

function cmdVerifyPathExists(cwd, targetPath) {
  if (!targetPath) {
    error('path required for verification');
  }

  // Defense-in-depth: validate path does not escape cwd
  if (!path.isAbsolute(targetPath)) {
    const pathCheck = validatePath(targetPath, cwd);
    if (!pathCheck.safe) {
      output({ exists: false, type: null, error: pathCheck.error }, 'false');
      return;
    }
  }

  const fullPath = path.isAbsolute(targetPath)
    ? targetPath
    : path.join(cwd, targetPath);

  try {
    const stats = fs.statSync(fullPath);
    const type = stats.isDirectory()
      ? 'directory'
      : stats.isFile()
        ? 'file'
        : 'other';
    const result = { exists: true, type };
    output(result, 'true');
  } catch {
    const result = { exists: false, type: null };
    output(result, 'false');
  }
}

function cmdHistoryDigest(cwd) {
  const { phases: phasesDir } = planningPaths(cwd);
  const digest = { phases: {}, decisions: [], tech_stack: new Set() };

  // Collect all phase directories: archived + current
  const allPhaseDirs = [];

  // Add archived phases first (oldest milestones first)
  const archived = getArchivedPhaseDirs(cwd);
  for (const a of archived) {
    allPhaseDirs.push({
      name: a.name,
      fullPath: a.fullPath,
      milestone: a.milestone,
    });
  }

  // Add current phases
  if (fs.existsSync(phasesDir)) {
    try {
      const currentDirs = fs
        .readdirSync(phasesDir, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
        .sort();
      for (const dir of currentDirs) {
        allPhaseDirs.push({
          name: dir,
          fullPath: path.join(phasesDir, dir),
          milestone: null,
        });
      }
    } catch {}
  }

  if (allPhaseDirs.length === 0) {
    digest.tech_stack = [];
    output(digest);
    return;
  }

  try {
    for (const { name: dir, fullPath: dirPath } of allPhaseDirs) {
      const summaries = fs
        .readdirSync(dirPath)
        .filter((f) => f.endsWith('-SUMMARY.md') || f === 'SUMMARY.md');

      for (const summary of summaries) {
        try {
          const content = fs.readFileSync(path.join(dirPath, summary), 'utf-8');
          const fm = extractFrontmatter(content);

          const phaseNum = fm.phase || dir.split('-')[0];

          if (!digest.phases[phaseNum]) {
            digest.phases[phaseNum] = {
              name: fm.name || dir.split('-').slice(1).join(' ') || 'Unknown',
              provides: new Set(),
              affects: new Set(),
              patterns: new Set(),
            };
          }

          // Merge provides
          if (fm['dependency-graph'] && fm['dependency-graph'].provides) {
            fm['dependency-graph'].provides.forEach((p) =>
              digest.phases[phaseNum].provides.add(p),
            );
          } else if (fm.provides) {
            fm.provides.forEach((p) => digest.phases[phaseNum].provides.add(p));
          }

          // Merge affects
          if (fm['dependency-graph'] && fm['dependency-graph'].affects) {
            fm['dependency-graph'].affects.forEach((a) =>
              digest.phases[phaseNum].affects.add(a),
            );
          }

          // Merge patterns
          if (fm['patterns-established']) {
            fm['patterns-established'].forEach((p) =>
              digest.phases[phaseNum].patterns.add(p),
            );
          }

          // Merge decisions
          if (fm['key-decisions']) {
            fm['key-decisions'].forEach((d) => {
              digest.decisions.push({ phase: phaseNum, decision: d });
            });
          }

          // Merge tech stack
          if (fm['tech-stack'] && fm['tech-stack'].added) {
            fm['tech-stack'].added.forEach((t) =>
              digest.tech_stack.add(typeof t === 'string' ? t : t.name),
            );
          }
        } catch (e) {
          // Skip malformed summaries
        }
      }
    }

    // Convert Sets to Arrays for JSON output
    Object.keys(digest.phases).forEach((p) => {
      digest.phases[p].provides = [...digest.phases[p].provides];
      digest.phases[p].affects = [...digest.phases[p].affects];
      digest.phases[p].patterns = [...digest.phases[p].patterns];
    });
    digest.tech_stack = [...digest.tech_stack];

    output(digest);
  } catch (e) {
    error('Failed to generate history digest: ' + e.message);
  }
}

function cmdResolveModel(cwd, agentType) {
  if (!agentType) {
    error('agent-type required');
  }

  const config = loadConfig(cwd);
  const profile = config.model_profile || 'balanced';
  const model = resolveModelInternal(cwd, agentType);

  const agentModels = MODEL_PROFILES[agentType];
  const result = agentModels
    ? { model, profile }
    : { model, profile, unknown_agent: true };
  output(result, model);
}

function cmdResolveEffort(cwd, agentType) {
  if (!agentType) {
    error('agent-type required');
  }

  const config = loadConfig(cwd);
  const profile = config.model_profile || 'balanced';
  const effort = resolveEffortInternal(cwd, agentType);

  const agentEfforts = EFFORT_PROFILES[agentType];
  const result = agentEfforts
    ? { effort, profile }
    : { effort, profile, unknown_agent: true };
  output(result, effort || 'inherit');
}

function applyCommitFormat(message, config, context) {
  const format = config.commit_format || 'gsd';
  const ctx = context || {};

  if (format === 'gsd' || format === 'conventional') {
    return message;
  }

  if (format === 'issue-first') {
    if (ctx.issueRef) {
      return `[#${ctx.issueRef}] ${message}`;
    }
    return message;
  }

  if (format === 'custom') {
    const template = config.commit_template;
    if (!template) return message;
    return template
      .replace(/\{type\}/g, ctx.type || '')
      .replace(/\{scope\}/g, ctx.scope || '')
      .replace(/\{description\}/g, ctx.description || message)
      .replace(/\{issue\}/g, ctx.issueRef || '');
  }

  return message;
}

function appendIssueTrailers(message, trailers) {
  if (!trailers || trailers.length === 0) return message;
  const lines = trailers.map((t) => `${t.action} #${t.number}`);
  return message + '\n\n' + lines.join('\n');
}

function cmdCommit(cwd, message, files, amend) {
  if (!message && !amend) {
    error('commit message required');
  }

  const config = loadConfig(cwd);

  // Check commit_docs config
  if (!config.commit_docs) {
    const result = {
      committed: false,
      hash: null,
      reason: 'skipped_commit_docs_false',
    };
    output(result, 'skipped');
    return;
  }

  // Check if .planning is gitignored
  if (isGitIgnored(cwd, '.planning')) {
    const result = {
      committed: false,
      hash: null,
      reason: 'skipped_gitignored',
    };
    output(result, 'skipped');
    return;
  }

  // Apply commit format template (GSD-generated commits only)
  if (message) {
    message = applyCommitFormat(message, config);
  }

  // Stage files
  const filesToStage = files && files.length > 0 ? files : ['.planning/'];
  for (const file of filesToStage) {
    execGit(cwd, ['add', file]);
  }

  // Commit
  const commitArgs = amend
    ? ['commit', '--amend', '--no-edit']
    : ['commit', '-m', message];
  const commitResult = execGit(cwd, commitArgs);
  if (commitResult.exitCode !== 0) {
    if (
      commitResult.stdout.includes('nothing to commit') ||
      commitResult.stderr.includes('nothing to commit')
    ) {
      const result = {
        committed: false,
        hash: null,
        reason: 'nothing_to_commit',
      };
      output(result, 'nothing');
      return;
    }
    const result = {
      committed: false,
      hash: null,
      reason: 'nothing_to_commit',
      error: commitResult.stderr,
    };
    output(result, 'nothing');
    return;
  }

  // Get short hash
  const hashResult = execGit(cwd, ['rev-parse', '--short', 'HEAD']);
  const hash = hashResult.exitCode === 0 ? hashResult.stdout : null;
  const result = { committed: true, hash, reason: 'committed' };
  output(result, hash || 'committed');
}

function cmdSummaryExtract(cwd, summaryPath, fields, defaultValue) {
  if (!summaryPath) {
    error('summary-path required for summary-extract');
  }

  const fullPath = path.join(cwd, summaryPath);

  if (!fs.existsSync(fullPath)) {
    if (defaultValue !== undefined) {
      output(defaultValue, String(defaultValue));
      return;
    }
    output({ error: 'File not found', path: summaryPath });
    return;
  }

  const content = fs.readFileSync(fullPath, 'utf-8');
  const fm = extractFrontmatter(content);

  // Parse key-decisions into structured format
  const parseDecisions = (decisionsList) => {
    if (!decisionsList || !Array.isArray(decisionsList)) return [];
    return decisionsList.map((d) => {
      const colonIdx = d.indexOf(':');
      if (colonIdx > 0) {
        return {
          summary: d.substring(0, colonIdx).trim(),
          rationale: d.substring(colonIdx + 1).trim(),
        };
      }
      return { summary: d, rationale: null };
    });
  };

  // Extract one-liner from body: first line matching **bold text** pattern
  let oneLiner = null;
  const body = content.replace(/^---[\s\S]*?---\n?/, '');
  const boldMatch = body.match(/^\*\*(.+?)\*\*\s*$/m);
  if (boldMatch) {
    oneLiner = boldMatch[1].trim();
  }

  // Build full result
  const fullResult = {
    path: summaryPath,
    one_liner: oneLiner,
    key_files: fm['key-files'] || [],
    tech_added: (fm['tech-stack'] && fm['tech-stack'].added) || [],
    patterns: fm['patterns-established'] || [],
    decisions: parseDecisions(fm['key-decisions']),
    requirements_completed: fm['requirements-completed'] || [],
  };

  // If fields specified, filter to only those fields
  if (fields && fields.length > 0) {
    const filtered = { path: summaryPath };
    for (const field of fields) {
      if (fullResult[field] !== undefined) {
        filtered[field] = fullResult[field];
      }
    }
    output(filtered);
    return;
  }

  output(fullResult);
}

async function cmdWebsearch(query, options) {
  const apiKey = process.env.BRAVE_API_KEY;

  if (!apiKey) {
    // No key = silent skip, agent falls back to built-in WebSearch
    output({ available: false, reason: 'BRAVE_API_KEY not set' }, '');
    return;
  }

  if (!query) {
    output({ available: false, error: 'Query required' }, '');
    return;
  }

  const params = new URLSearchParams({
    q: query,
    count: String(options.limit || 10),
    country: 'us',
    search_lang: 'en',
    text_decorations: 'false',
  });

  if (options.freshness) {
    params.set('freshness', options.freshness);
  }

  try {
    const response = await fetch(
      `https://api.search.brave.com/res/v1/web/search?${params}`,
      {
        headers: {
          Accept: 'application/json',
          'X-Subscription-Token': apiKey,
        },
      },
    );

    if (!response.ok) {
      output({ available: false, error: `API error: ${response.status}` }, '');
      return;
    }

    const data = await response.json();

    const results = (data.web?.results || []).map((r) => ({
      title: r.title,
      url: r.url,
      description: r.description,
      age: r.age || null,
    }));

    output(
      {
        available: true,
        query,
        count: results.length,
        results,
      },
      results.map((r) => `${r.title}\n${r.url}\n${r.description}`).join('\n\n'),
    );
  } catch (err) {
    output({ available: false, error: err.message }, '');
  }
}

function cmdProgressRender(cwd, format) {
  const { phases: phasesDir, roadmap: roadmapPath } = planningPaths(cwd);
  const milestone = getMilestoneInfo(cwd);

  const phases = [];
  let totalPlans = 0;
  let totalSummaries = 0;

  try {
    const entries = fs.readdirSync(phasesDir, { withFileTypes: true });
    const dirs = entries
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort((a, b) => comparePhaseNum(a, b));

    for (const dir of dirs) {
      const dm = dir.match(/^(\d+(?:\.\d+)*)-?(.*)/);
      const phaseNum = dm ? dm[1] : dir;
      const phaseName = dm && dm[2] ? dm[2].replace(/-/g, ' ') : '';
      const phaseFiles = fs.readdirSync(path.join(phasesDir, dir));
      const plans = phaseFiles.filter(
        (f) => f.endsWith('-PLAN.md') || f === 'PLAN.md',
      ).length;
      const summaries = phaseFiles.filter(
        (f) => f.endsWith('-SUMMARY.md') || f === 'SUMMARY.md',
      ).length;

      totalPlans += plans;
      totalSummaries += summaries;

      let status;
      if (plans === 0) status = 'Pending';
      else {
        const { isComplete, status: cs } = getPhaseCompletionStatus(
          path.join(phasesDir, dir),
        );
        if (isComplete)
          status =
            cs === 'complete (verified)' ? 'Complete (verified)' : 'Complete';
        else if (summaries > 0) status = 'In Progress';
        else status = 'Planned';
      }

      phases.push({
        number: phaseNum,
        name: phaseName,
        plans,
        summaries,
        status,
      });
    }
  } catch {}

  const percent =
    totalPlans > 0
      ? Math.min(100, Math.round((totalSummaries / totalPlans) * 100))
      : 0;

  if (format === 'table') {
    // Render markdown table
    const barWidth = 10;
    const filled = Math.round((percent / 100) * barWidth);
    const bar = '\u2588'.repeat(filled) + '\u2591'.repeat(barWidth - filled);
    let out = `# ${milestone.version} ${milestone.name}\n\n`;
    out += `**Progress:** [${bar}] ${totalSummaries}/${totalPlans} plans (${percent}%)\n\n`;
    out += `| Phase | Name | Plans | Status |\n`;
    out += `|-------|------|-------|--------|\n`;
    for (const p of phases) {
      out += `| ${p.number} | ${p.name} | ${p.summaries}/${p.plans} | ${p.status} |\n`;
    }
    output({ rendered: out }, out);
  } else if (format === 'bar') {
    const barWidth = 20;
    const filled = Math.round((percent / 100) * barWidth);
    const bar = '\u2588'.repeat(filled) + '\u2591'.repeat(barWidth - filled);
    const text = `[${bar}] ${totalSummaries}/${totalPlans} plans (${percent}%)`;
    output(
      { bar: text, percent, completed: totalSummaries, total: totalPlans },
      text,
    );
  } else {
    // JSON format
    output({
      milestone_version: milestone.version,
      milestone_name: milestone.name,
      phases,
      total_plans: totalPlans,
      total_summaries: totalSummaries,
      percent,
    });
  }
}

/**
 * Parse a duration string like '7d', '2w', '1m', '1y' into milliseconds.
 * Returns null for invalid/empty input.
 *
 * @param {string|null|undefined} interval
 * @returns {number|null}
 */
function parseDuration(interval) {
  const match = String(interval || '').match(/^(\d+)([dwmy])$/i);
  if (!match) return null;
  const [, n, unit] = match;
  const multipliers = {
    d: 86400000,
    w: 604800000,
    m: 2592000000,
    y: 31536000000,
  };
  return parseInt(n, 10) * (multipliers[unit.toLowerCase()] || 0);
}

/**
 * Check if a recurring todo is past its interval and due for attention.
 *
 * @param {{ recurring?: boolean|string, interval?: string, last_completed?: string }} todoData
 * @returns {boolean}
 */
function isRecurringDue(todoData) {
  if (!todoData) return false;
  const recurring = todoData.recurring;
  if (!recurring || String(recurring) === 'false') return false;
  const intervalMs = parseDuration(todoData.interval);
  if (!intervalMs) return true; // No valid interval = always due
  const lastCompleted = todoData.last_completed
    ? new Date(todoData.last_completed).getTime()
    : 0;
  return Date.now() - lastCompleted >= intervalMs;
}

function cmdTodoComplete(cwd, filename) {
  if (!filename) {
    error('filename required for todo complete');
  }

  const { todosPending: pendingDir, todosCompleted: completedDir } =
    planningPaths(cwd);

  const strayDoneDir = path.join(pendingDir, '..', 'done');
  if (fs.existsSync(strayDoneDir)) {
    process.stderr.write(
      `[warning] Stray .planning/todos/done/ directory detected — likely created by an off-piste agent. ` +
        `Move its contents into .planning/todos/completed/ and remove the empty done/ directory.\n`,
    );
  }

  const sourcePath = path.join(pendingDir, filename);

  if (!fs.existsSync(sourcePath)) {
    error(`Todo not found: ${filename}`);
  }

  // Read file content once for both recurring check and non-recurring path
  const content = fs.readFileSync(sourcePath, 'utf-8');
  const fm = extractFrontmatter(content);

  // Check if this is a recurring todo — update last_completed instead of moving
  if (fm && (fm.recurring === true || String(fm.recurring) === 'true')) {
    const today = new Date().toISOString();
    const todayDate = today.split('T')[0];

    // Update last_completed in frontmatter — keep file in pending/
    let updatedContent;
    if (content.includes('last_completed:')) {
      // Replace existing last_completed value
      updatedContent = content.replace(
        /^last_completed:.*$/m,
        `last_completed: ${today}`,
      );
    } else {
      // Add last_completed before closing ---
      updatedContent = content.replace(
        /\n---/,
        `\nlast_completed: ${today}\n---`,
      );
    }

    fs.writeFileSync(sourcePath, updatedContent, 'utf-8');
    output(
      {
        completed: true,
        recurring: true,
        file: filename,
        date: todayDate,
        next_due: fm.interval || 'unknown',
      },
      `recurring-reset: ${filename}`,
    );
    return;
  }

  // Non-recurring: existing behavior — add completed timestamp and move to completed/
  // Ensure completed directory exists
  fs.mkdirSync(completedDir, { recursive: true });

  const today = new Date().toISOString().split('T')[0];
  const completedContent = `completed: ${today}\n` + content;

  fs.writeFileSync(
    path.join(completedDir, filename),
    completedContent,
    'utf-8',
  );
  fs.unlinkSync(sourcePath);

  // Inline issue-sync for non-recurring completions with external_ref
  if (fm && fm.external_ref) {
    // Read issue_tracker config directly from config.json since loadConfig returns a structured
    // object and does not expose the raw issue_tracker section.
    let itConfig = {};
    try {
      const rawConfig = JSON.parse(
        fs.readFileSync(planningPaths(cwd).config, 'utf-8'),
      );
      itConfig = rawConfig.issue_tracker || {};
    } catch {
      /* no config.json, use empty defaults */
    }
    if (itConfig.auto_sync !== false) {
      try {
        const commitHash = getLatestCommitHash(cwd);
        const syncResults = syncSingleRef(
          fm.external_ref,
          { commitHash },
          itConfig,
        );
        output(
          { completed: true, file: filename, date: today, synced: syncResults },
          'completed',
        );
        return;
      } catch (_e) {
        // Sync failure is non-fatal — fall through to normal completion output
      }
    }
  }

  output({ completed: true, file: filename, date: today }, 'completed');
}

/**
 * List pending todo filenames whose frontmatter phase field matches the given phase number.
 *
 * @param {string} cwd
 * @param {string|number} phase - Phase number to match
 */
function cmdTodoListByPhase(cwd, phase) {
  if (!phase) error('phase required for todo list-by-phase');
  const { todosPending } = planningPaths(cwd);
  let files = [];
  try {
    files = fs.readdirSync(todosPending).filter((f) => f.endsWith('.md'));
  } catch (_e) {
    // Directory doesn't exist — return empty
    output([]);
    return;
  }
  const matches = [];
  for (const file of files) {
    try {
      const content = fs.readFileSync(path.join(todosPending, file), 'utf-8');
      const fm = extractFrontmatter(content);
      if (String(fm.phase) === String(phase)) matches.push(file);
    } catch (_e) {
      // Skip unreadable files
    }
  }
  output(matches);
}

/**
 * List pending todo filenames that are referenced in ROADMAP.md Source Todos for the given phase.
 * Only returns todos that actually exist in the pending directory.
 *
 * @param {string} cwd
 * @param {string|number} phase - Phase number to look up in ROADMAP
 */
function cmdTodoScanPhaseLinked(cwd, phase) {
  if (!phase) error('phase required for todo scan-phase-linked');
  const { todosPending, roadmap: roadmapPath } = planningPaths(cwd);

  // Read ROADMAP and parse source_todos for the given phase
  let sourceTodosStr = null;
  try {
    if (!fs.existsSync(roadmapPath)) {
      output([]);
      return;
    }
    const content = fs.readFileSync(roadmapPath, 'utf-8');
    const escapedPhase = String(phase).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const phasePattern = new RegExp(
      `#{2,4}\\s*Phase\\s+${escapedPhase}:\\s*[^\\n]+`,
      'i',
    );
    const headerMatch = content.match(phasePattern);
    if (!headerMatch) {
      output([]);
      return;
    }
    const sectionStart = headerMatch.index;
    const restOfContent = content.slice(sectionStart);
    const nextHeaderMatch = restOfContent.match(
      /\n#{2,4}\s+Phase\s+\d+[A-Z]?(?:\.\d+)*/i,
    );
    const sectionEnd = nextHeaderMatch
      ? sectionStart + nextHeaderMatch.index
      : content.length;
    const section = content.slice(sectionStart, sectionEnd);
    const sourceTodosMatch = section.match(/\*\*Source Todos\*\*:\s*([^\n]+)/i);
    if (sourceTodosMatch) sourceTodosStr = sourceTodosMatch[1].trim();
  } catch (_e) {
    output([]);
    return;
  }

  if (!sourceTodosStr) {
    output([]);
    return;
  }

  // Parse source_todos string: backtick-wrapped, comma-separated
  const todoFiles = sourceTodosStr
    .replace(/`/g, '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  // Return only files that exist in pending dir
  const existing = todoFiles.filter((f) => {
    try {
      return fs.existsSync(path.join(todosPending, f));
    } catch (_e) {
      return false;
    }
  });
  output(existing);
}

/**
 * List recurring todos that are past their interval (due for attention).
 *
 * @param {string} cwd
 */
function cmdRecurringDue(cwd) {
  const { todosPending: pendingDir } = planningPaths(cwd);
  const due = [];

  try {
    const files = fs.readdirSync(pendingDir).filter((f) => f.endsWith('.md'));
    for (const file of files) {
      try {
        const content = fs.readFileSync(path.join(pendingDir, file), 'utf-8');
        const fm = extractFrontmatter(content);
        if (fm && (fm.recurring === true || String(fm.recurring) === 'true')) {
          if (isRecurringDue(fm)) {
            due.push({
              file,
              title: fm.title || 'Untitled',
              interval: fm.interval || 'unknown',
              last_completed: fm.last_completed || 'never',
              path: toPosixPath(
                path.join('.planning', 'todos', 'pending', file),
              ),
            });
          }
        }
      } catch (_e) {
        // Skip unreadable files
      }
    }
  } catch (_e) {
    // pending/ directory may not exist
  }

  output(
    { count: due.length, todos: due },
    due.length > 0 ? due.map((d) => d.file).join(', ') : 'none due',
  );
}

function cmdScaffold(cwd, type, options) {
  const { phase, name } = options;
  const padded = phase ? normalizePhaseName(phase) : '00';
  const today = new Date().toISOString().split('T')[0];

  // Find phase directory
  const phaseInfo = phase ? findPhaseInternal(cwd, phase) : null;
  const phaseDir = phaseInfo ? path.join(cwd, phaseInfo.directory) : null;

  if (phase && !phaseDir && type !== 'phase-dir') {
    error(`Phase ${phase} directory not found`);
  }

  let filePath, content;

  switch (type) {
    case 'context': {
      filePath = path.join(phaseDir, `${padded}-CONTEXT.md`);
      content = `---\nphase: "${padded}"\nname: "${name || phaseInfo?.phase_name || 'Unnamed'}"\ncreated: ${today}\n---\n\n# Phase ${phase}: ${name || phaseInfo?.phase_name || 'Unnamed'} — Context\n\n## Decisions\n\n_Decisions will be captured during /gsd:discuss-phase ${phase}_\n\n## Discretion Areas\n\n_Areas where the executor can use judgment_\n\n## Deferred Ideas\n\n_Ideas to consider later_\n`;
      break;
    }
    case 'uat': {
      filePath = path.join(phaseDir, `${padded}-UAT.md`);
      content = `---\nphase: "${padded}"\nname: "${name || phaseInfo?.phase_name || 'Unnamed'}"\ncreated: ${today}\nstatus: pending\n---\n\n# Phase ${phase}: ${name || phaseInfo?.phase_name || 'Unnamed'} — User Acceptance Testing\n\n## Test Results\n\n| # | Test | Status | Notes |\n|---|------|--------|-------|\n\n## Summary\n\n_Pending UAT_\n`;
      break;
    }
    case 'verification': {
      filePath = path.join(phaseDir, `${padded}-VERIFICATION.md`);
      content = `---\nphase: "${padded}"\nname: "${name || phaseInfo?.phase_name || 'Unnamed'}"\ncreated: ${today}\nstatus: pending\n---\n\n# Phase ${phase}: ${name || phaseInfo?.phase_name || 'Unnamed'} — Verification\n\n## Goal-Backward Verification\n\n**Phase Goal:** [From ROADMAP.md]\n\n## Checks\n\n| # | Requirement | Status | Evidence |\n|---|------------|--------|----------|\n\n## Result\n\n_Pending verification_\n`;
      break;
    }
    case 'phase-dir': {
      if (!phase || !name) {
        error('phase and name required for phase-dir scaffold');
      }
      const slug = generateSlugInternal(name);
      const dirName = `${padded}-${slug}`;
      const phasesParent = planningPaths(cwd).phases;
      fs.mkdirSync(phasesParent, { recursive: true });
      const dirPath = path.join(phasesParent, dirName);
      fs.mkdirSync(dirPath, { recursive: true });
      output(
        {
          created: true,
          directory: `.planning/phases/${dirName}`,
          path: dirPath,
        },
        dirPath,
      );
      return;
    }
    default:
      error(
        `Unknown scaffold type: ${type}. Available: context, uat, verification, phase-dir`,
      );
  }

  if (fs.existsSync(filePath)) {
    output(
      { created: false, reason: 'already_exists', path: filePath },
      'exists',
    );
    return;
  }

  fs.writeFileSync(filePath, content, 'utf-8');
  const relPath = toPosixPath(path.relative(cwd, filePath));
  output({ created: true, path: relPath }, relPath);
}

function cmdStats(cwd, format) {
  const {
    phases: phasesDir,
    roadmap: roadmapPath,
    requirements: reqPath,
    state: statePath,
  } = planningPaths(cwd);
  const milestone = getMilestoneInfo(cwd);
  const isDirInMilestone = getMilestonePhaseFilter(cwd);

  // Phase & plan stats (reuse progress pattern)
  const phasesByNumber = new Map();
  let totalPlans = 0;
  let totalSummaries = 0;

  try {
    const roadmapContent = extractCurrentMilestone(
      fs.readFileSync(roadmapPath, 'utf-8'),
    );
    const headingPattern =
      /#{2,4}\s*Phase\s+(\d+[A-Z]?(?:\.\d+)*)\s*:\s*([^\n]+)/gi;
    let match;
    while ((match = headingPattern.exec(roadmapContent)) !== null) {
      phasesByNumber.set(match[1], {
        number: match[1],
        name: match[2].replace(/\(INSERTED\)/i, '').trim(),
        plans: 0,
        summaries: 0,
        status: 'Not Started',
      });
    }
  } catch {}

  try {
    const entries = fs.readdirSync(phasesDir, { withFileTypes: true });
    const dirs = entries
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .filter(isDirInMilestone)
      .sort((a, b) => comparePhaseNum(a, b));

    for (const dir of dirs) {
      const dm = dir.match(/^(\d+[A-Z]?(?:\.\d+)*)-?(.*)/i);
      const phaseNum = dm ? dm[1] : dir;
      const phaseName = dm && dm[2] ? dm[2].replace(/-/g, ' ') : '';
      const phaseFiles = fs.readdirSync(path.join(phasesDir, dir));
      const plans = phaseFiles.filter(
        (f) => f.endsWith('-PLAN.md') || f === 'PLAN.md',
      ).length;
      const summaries = phaseFiles.filter(
        (f) => f.endsWith('-SUMMARY.md') || f === 'SUMMARY.md',
      ).length;

      totalPlans += plans;
      totalSummaries += summaries;

      let status;
      if (plans === 0) status = 'Not Started';
      else {
        const { isComplete, status: cs } = getPhaseCompletionStatus(
          path.join(phasesDir, dir),
        );
        if (isComplete)
          status =
            cs === 'complete (verified)' ? 'Complete (verified)' : 'Complete';
        else if (summaries > 0) status = 'In Progress';
        else status = 'Planned';
      }

      const existing = phasesByNumber.get(phaseNum);
      phasesByNumber.set(phaseNum, {
        number: phaseNum,
        name: existing?.name || phaseName,
        plans,
        summaries,
        status,
      });
    }
  } catch {}

  const phases = [...phasesByNumber.values()].sort((a, b) =>
    comparePhaseNum(a.number, b.number),
  );
  const completedPhases = phases.filter(
    (p) => p.status === 'Complete' || p.status === 'Complete (verified)',
  ).length;
  const planPercent =
    totalPlans > 0
      ? Math.min(100, Math.round((totalSummaries / totalPlans) * 100))
      : 0;
  const percent =
    phases.length > 0
      ? Math.min(100, Math.round((completedPhases / phases.length) * 100))
      : 0;

  // Requirements stats
  let requirementsTotal = 0;
  let requirementsComplete = 0;
  try {
    if (fs.existsSync(reqPath)) {
      const reqContent = fs.readFileSync(reqPath, 'utf-8');
      const checked = reqContent.match(/^- \[x\] \*\*/gm);
      const unchecked = reqContent.match(/^- \[ \] \*\*/gm);
      requirementsComplete = checked ? checked.length : 0;
      requirementsTotal =
        requirementsComplete + (unchecked ? unchecked.length : 0);
    }
  } catch {}

  // Last activity from STATE.md
  let lastActivity = null;
  try {
    if (fs.existsSync(statePath)) {
      const stateContent = fs.readFileSync(statePath, 'utf-8');
      const activityMatch =
        stateContent.match(/^last_activity:\s*(.+)$/im) ||
        stateContent.match(/\*\*Last Activity:\*\*\s*(.+)/i) ||
        stateContent.match(/^Last Activity:\s*(.+)$/im) ||
        stateContent.match(/^Last activity:\s*(.+)$/im);
      if (activityMatch) lastActivity = activityMatch[1].trim();
    }
  } catch {}

  // Git stats
  let gitCommits = 0;
  let gitFirstCommitDate = null;
  const commitCount = execGit(cwd, ['rev-list', '--count', 'HEAD']);
  if (commitCount.exitCode === 0) {
    gitCommits = parseInt(commitCount.stdout, 10) || 0;
  }
  const rootHash = execGit(cwd, ['rev-list', '--max-parents=0', 'HEAD']);
  if (rootHash.exitCode === 0 && rootHash.stdout) {
    const firstCommit = rootHash.stdout.split('\n')[0].trim();
    const firstDate = execGit(cwd, ['show', '-s', '--format=%as', firstCommit]);
    if (firstDate.exitCode === 0) {
      gitFirstCommitDate = firstDate.stdout || null;
    }
  }

  const result = {
    milestone_version: milestone.version,
    milestone_name: milestone.name,
    phases,
    phases_completed: completedPhases,
    phases_total: phases.length,
    total_plans: totalPlans,
    total_summaries: totalSummaries,
    percent,
    plan_percent: planPercent,
    requirements_total: requirementsTotal,
    requirements_complete: requirementsComplete,
    git_commits: gitCommits,
    git_first_commit_date: gitFirstCommitDate,
    last_activity: lastActivity,
  };

  if (format === 'table') {
    const barWidth = 10;
    const filled = Math.round((percent / 100) * barWidth);
    const bar = '\u2588'.repeat(filled) + '\u2591'.repeat(barWidth - filled);
    let out = `# ${milestone.version} ${milestone.name} \u2014 Statistics\n\n`;
    out += `**Progress:** [${bar}] ${completedPhases}/${phases.length} phases (${percent}%)\n`;
    if (totalPlans > 0) {
      out += `**Plans:** ${totalSummaries}/${totalPlans} complete (${planPercent}%)\n`;
    }
    out += `**Phases:** ${completedPhases}/${phases.length} complete\n`;
    if (requirementsTotal > 0) {
      out += `**Requirements:** ${requirementsComplete}/${requirementsTotal} complete\n`;
    }
    out += '\n';
    out += `| Phase | Name | Plans | Completed | Status |\n`;
    out += `|-------|------|-------|-----------|--------|\n`;
    for (const p of phases) {
      out += `| ${p.number} | ${p.name} | ${p.plans} | ${p.summaries} | ${p.status} |\n`;
    }
    if (gitCommits > 0) {
      out += `\n**Git:** ${gitCommits} commits`;
      if (gitFirstCommitDate) out += ` (since ${gitFirstCommitDate})`;
      out += '\n';
    }
    if (lastActivity) out += `**Last activity:** ${lastActivity}\n`;
    output({ rendered: out }, out);
  } else {
    output(result);
  }
}

/**
 * Map of known platform identifiers to their CLI tools.
 */
const PLATFORM_CLI = {
  github: 'gh',
  gitlab: 'glab',
  forgejo: 'fj',
  gitea: 'tea',
};

/**
 * Map of install URLs for platform CLIs (used in warning messages).
 */
const PLATFORM_CLI_URLS = {
  gh: 'https://cli.github.com/',
  glab: 'https://gitlab.com/gitlab-org/cli',
  fj: 'https://codeberg.org/Forgejo/forgejo-cli',
  tea: 'https://gitea.com/gitea/tea',
};

/**
 * Issue tracker CLI command specifications for 4 platforms x 5 operations.
 * Each function returns { cli, args } ready for spawnSync dispatch.
 */
const ISSUE_COMMANDS = {
  github: {
    list: (repo, opts) => {
      const args = [
        'issue',
        'list',
        '--json',
        'number,title,body,labels,state',
      ];
      if (repo) args.push('--repo', repo);
      if (opts.label) args.push('--label', opts.label);
      if (opts.milestone) args.push('--milestone', opts.milestone);
      if (opts.limit) args.push('--limit', String(opts.limit));
      return { cli: 'gh', args };
    },
    view: (number, repo) => {
      const args = [
        'issue',
        'view',
        String(number),
        '--json',
        'number,title,body,labels,state',
      ];
      if (repo) args.push('--repo', repo);
      return { cli: 'gh', args };
    },
    close: (number, repo, comment) => {
      const args = ['issue', 'close', String(number)];
      if (repo) args.push('--repo', repo);
      if (comment) args.push('--comment', comment);
      return { cli: 'gh', args };
    },
    comment: (number, repo, body) => {
      const args = ['issue', 'comment', String(number), '--body', body];
      if (repo) args.push('--repo', repo);
      return { cli: 'gh', args };
    },
    create: (repo, title, body, labels) => {
      const args = ['issue', 'create', '--title', title, '--body', body];
      if (repo) args.push('--repo', repo);
      if (labels && labels.length) args.push('--label', labels.join(','));
      return { cli: 'gh', args };
    },
    label: (number, repo, labelName) => {
      const args = ['issue', 'edit', String(number), '--add-label', labelName];
      if (repo) args.push('--repo', repo);
      return { cli: 'gh', args };
    },
    label_create: (repo, labelName) => {
      const args = ['label', 'create', labelName, '--force'];
      if (repo) args.push('--repo', repo);
      return { cli: 'gh', args };
    },
  },
  gitlab: {
    list: (repo, opts) => {
      const args = ['issue', 'list', '--output', 'json'];
      if (repo) args.push('--repo', repo);
      if (opts.label) args.push('--label', opts.label);
      if (opts.milestone) args.push('--milestone', opts.milestone);
      return { cli: 'glab', args };
    },
    view: (number, repo) => {
      const args = ['issue', 'view', String(number), '--output', 'json'];
      if (repo) args.push('--repo', repo);
      return { cli: 'glab', args };
    },
    close: (number, repo, _comment) => {
      const args = ['issue', 'close', String(number)];
      if (repo) args.push('--repo', repo);
      return { cli: 'glab', args };
    },
    comment: (number, repo, body) => {
      const args = ['issue', 'note', String(number), '--message', body];
      if (repo) args.push('--repo', repo);
      return { cli: 'glab', args };
    },
    create: (repo, title, body, labels) => {
      const args = ['issue', 'create', '--title', title, '--description', body];
      if (repo) args.push('--repo', repo);
      if (labels && labels.length) args.push('--label', labels.join(','));
      return { cli: 'glab', args };
    },
    label: (number, repo, labelName) => {
      const args = ['issue', 'edit', String(number), '--add-labels', labelName];
      if (repo) args.push('--repo', repo);
      return { cli: 'glab', args };
    },
    label_create: (repo, labelName) => {
      const args = ['label', 'create', labelName];
      if (repo) args.push('--repo', repo);
      return { cli: 'glab', args };
    },
  },
  forgejo: {
    list: (repo, _opts) => {
      const args = ['issue', 'list'];
      if (repo) args.push('--repo', repo);
      return { cli: 'fj', args };
    },
    view: (number, repo) => {
      const args = ['issue', 'view', String(number)];
      if (repo) args.push('--repo', repo);
      return { cli: 'fj', args };
    },
    close: (number, repo, comment) => {
      const args = ['issue', 'close', String(number)];
      if (repo) args.push('--repo', repo);
      if (comment) args.push('-w', comment);
      return { cli: 'fj', args };
    },
    comment: (number, repo, body) => {
      const args = ['issue', 'comment', String(number), '--body', body];
      if (repo) args.push('--repo', repo);
      return { cli: 'fj', args };
    },
    create: (repo, title, body, _labels) => {
      const args = ['issue', 'create', title, '--body', body];
      if (repo) args.push('--repo', repo);
      return { cli: 'fj', args };
    },
    label: (number, repo, labelName) => {
      const args = ['issue', 'edit', String(number), '--add-labels', labelName];
      if (repo) args.push('--repo', repo);
      return { cli: 'fj', args };
    },
    label_create: (repo, labelName) => {
      const args = ['label', 'create', labelName];
      if (repo) args.push('--repo', repo);
      return { cli: 'fj', args };
    },
  },
  gitea: {
    list: (repo, opts) => {
      const args = ['issues', 'list', '--output', 'json'];
      if (repo) args.push('--repo', repo);
      if (opts.limit) args.push('--limit', String(opts.limit));
      return { cli: 'tea', args };
    },
    view: (number, repo) => {
      const args = ['issues', 'view', String(number), '--output', 'json'];
      if (repo) args.push('--repo', repo);
      return { cli: 'tea', args };
    },
    close: (number, repo, _comment) => {
      const args = ['issues', 'close', String(number)];
      if (repo) args.push('--repo', repo);
      return { cli: 'tea', args };
    },
    comment: (number, repo, body) => {
      const args = ['comment', String(number), '--body', body];
      if (repo) args.push('--repo', repo);
      return { cli: 'tea', args };
    },
    create: (repo, title, body, labels) => {
      const args = [
        'issues',
        'create',
        '--title',
        title,
        '--description',
        body,
      ];
      if (repo) args.push('--repo', repo);
      if (labels && labels.length) args.push('--label', labels.join(','));
      return { cli: 'tea', args };
    },
    label: (number, repo, labelName) => {
      const args = [
        'issues',
        'edit',
        String(number),
        '--add-labels',
        labelName,
      ];
      if (repo) args.push('--repo', repo);
      return { cli: 'tea', args };
    },
    label_create: (repo, labelName) => {
      const args = ['labels', 'create', labelName];
      if (repo) args.push('--repo', repo);
      return { cli: 'tea', args };
    },
  },
};

/**
 * Parses an external issue ref string into structured objects.
 * Handles format: platform:[[org/repo]#]number[:action]
 * Supports comma-separated multi-ref strings.
 *
 * @param {string} refStr - e.g. "github:#42" or "gitlab:myorg/myrepo#198" or "github:#42, forgejo:#55"
 * @param {string|null} defaultRepo - Repo to use when ref has no explicit repo
 * @returns {Array<{platform, repo, number, action, raw}>}
 */
function parseExternalRef(refStr, defaultRepo) {
  if (!refStr) return [];
  const refs = refStr
    .split(',')
    .map((r) => r.trim())
    .filter(Boolean);
  return refs
    .map((ref) => {
      const actionMatch = ref.match(/^([^:]+):(.+):(\w+)$/);
      let action = null;
      let remainder = ref;
      if (actionMatch && ['close', 'comment'].includes(actionMatch[3])) {
        remainder = `${actionMatch[1]}:${actionMatch[2]}`;
        action = actionMatch[3];
      }
      const match = remainder.match(/^([^:]+):(?:([^#]+)?#)(\d+)$/);
      if (!match) return null;
      const [, platform, repo, number] = match;
      return {
        platform,
        repo: repo || defaultRepo || null,
        number: parseInt(number, 10),
        action: action || null,
        raw: ref,
      };
    })
    .filter(Boolean);
}

/**
 * Dispatches an issue CLI call via spawnSync.
 * Honors GSD_TEST_MODE to return dry_run result without executing the CLI.
 *
 * @param {string} platform - One of: github, gitlab, forgejo, gitea
 * @param {string} operation - One of: list, view, close, comment, create
 * @param {Array} args - Arguments to spread into the platform operation function
 * @returns {{ success: boolean, data?: any, error?: string, dry_run?: boolean }}
 */
/**
 * Legacy back-compat shim used when GSD_TEST_MODE is set and no cliInvoker
 * override is provided. Mirrors the old in-line mock that cmdIssueImport
 * applied directly. Returns mock issue data for "view" calls and dry-run
 * acknowledgments for write operations.
 */
function _legacyTestModeInvoker(platform, operation, args) {
  if (operation === 'view') {
    const number = args && args[0];
    const labels = process.env.GSD_TEST_LABELS
      ? JSON.parse(process.env.GSD_TEST_LABELS)
      : [];
    const iid = process.env.GSD_TEST_IID
      ? parseInt(process.env.GSD_TEST_IID, 10)
      : null;
    return {
      success: true,
      data: {
        number: iid || parseInt(String(number), 10),
        iid: iid || null,
        title: 'Test issue ' + number,
        body: process.env.GSD_TEST_BODY || 'Test body',
        labels: labels.map((l) => (typeof l === 'string' ? { name: l } : l)),
        state: 'open',
      },
    };
  }
  // For write ops (close/comment/label/etc.) emulate the legacy GSD_TEST_MODE
  // dry-run shape that invokeIssueCli used to return inline.
  const platformCmds = ISSUE_COMMANDS[platform];
  if (!platformCmds || !platformCmds[operation]) {
    return {
      success: false,
      error: !platformCmds
        ? `Unknown platform: ${platform}`
        : `Unknown operation: ${operation}`,
    };
  }
  const cmdSpec = platformCmds[operation](...args);
  return {
    success: true,
    data: null,
    dry_run: true,
    cli: cmdSpec.cli,
    args: cmdSpec.args,
  };
}

function invokeIssueCli(platform, operation, args) {
  const { spawnSync } = require('child_process');
  const platformCmds = ISSUE_COMMANDS[platform];
  if (!platformCmds)
    return { success: false, error: `Unknown platform: ${platform}` };
  if (!platformCmds[operation])
    return { success: false, error: `Unknown operation: ${operation}` };
  const cmdSpec = platformCmds[operation](...args);
  if (process.env.GSD_TEST_MODE) {
    return {
      success: true,
      data: null,
      dry_run: true,
      cli: cmdSpec.cli,
      args: cmdSpec.args,
    };
  }
  /* c8 ignore start — real-CLI branch: spawnSync against gh/glab/fj/tea binaries. Tested via cliInvoker injection seam in cmdIssueImport/cmdIssueSync. */
  const result = spawnSync(cmdSpec.cli, cmdSpec.args, {
    stdio: 'pipe',
    encoding: 'utf-8',
  });
  if (result.status !== 0) {
    return {
      success: false,
      error: (result.stderr || result.stdout || '').trim(),
      exitCode: result.status,
    };
  }
  let parsed = null;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    parsed = result.stdout.trim();
  }
  return { success: true, data: parsed };
  /* c8 ignore stop */
}

/**
 * Builds a comment to post to an external issue tracker when a GSD item is resolved.
 * 'external' style omits GSD internals; 'verbose' includes full context.
 *
 * @param {'external'|'verbose'} style
 * @param {{ phaseName?, commitHash?, prNumber?, branchName?, todoTitle? }} context
 * @returns {string}
 */
function buildSyncComment(style, context) {
  const ctx = context || {};
  if (style === 'verbose') {
    const parts = [];
    if (ctx.phaseName) parts.push(`Phase: ${ctx.phaseName}`);
    if (ctx.commitHash) parts.push(`Commit: ${ctx.commitHash}`);
    if (ctx.prNumber) parts.push(`PR: #${ctx.prNumber}`);
    if (ctx.branchName) parts.push(`Branch: ${ctx.branchName}`);
    if (ctx.todoTitle) parts.push(`Todo: ${ctx.todoTitle}`);
    return parts.length
      ? `Resolved via GSD. ${parts.join(', ')}.`
      : 'Resolved via GSD.';
  }
  if (ctx.prNumber) return `Resolved in PR #${ctx.prNumber}.`;
  if (ctx.commitHash)
    return `Resolved in commit ${ctx.commitHash.slice(0, 7)}.`;
  if (ctx.branchName) return `Resolved in branch ${ctx.branchName}.`;
  return 'Resolved.';
}

/**
 * Builds a comment to post to an external issue tracker when a GSD import occurs.
 * 'external' style omits GSD internals — returns 'Tracked for resolution.' only.
 * 'verbose' style references the todo filename.
 *
 * @param {'external'|'verbose'} style
 * @param {{ todoFile? }} context
 * @returns {string}
 */
function buildImportComment(style, context) {
  const ctx = context || {};
  if (style === 'verbose') {
    return `Tracking as GSD todo: ${ctx.todoFile || 'unknown'}`;
  }
  return 'Tracked for resolution.';
}

function cmdDetectPlatform(cwd, remote, silent) {
  const { spawnSync } = require('child_process');

  // 1. Check config override
  const cfg = loadConfig(cwd);
  // loadConfig returns a flat object; cfg.platform is the platform field (not cfg.git.platform)
  const platformOverride = cfg.platform || null;

  let platform = null;
  let source = 'unknown';
  let remoteUrl = null;
  let cli = null;
  let cliInstalled = false;

  if (platformOverride) {
    platform = platformOverride;
    source = 'config';
  } else {
    // 2. Auto-detect from remote URL
    // loadConfig returns a flat object; cfg.remote is the git remote name (not cfg.git.remote)
    const remoteName = remote || cfg.remote || 'origin';
    const remoteResult = execGit(cwd, ['remote', 'get-url', remoteName]);

    if (remoteResult.exitCode === 0 && remoteResult.stdout) {
      remoteUrl = remoteResult.stdout.trim();
      const urlLower = remoteUrl.toLowerCase();

      if (urlLower.includes('github.com')) {
        platform = 'github';
        source = 'detected';
      } else if (urlLower.includes('gitlab.com')) {
        platform = 'gitlab';
        source = 'detected';
      } else if (urlLower.includes('codeberg.org')) {
        platform = 'forgejo';
        source = 'detected';
      } else if (urlLower.includes('gitea.com')) {
        platform = 'gitea';
        source = 'detected';
      } else {
        source = 'unknown';
      }
    }
  }

  // 3. Resolve CLI for detected/configured platform
  if (platform && PLATFORM_CLI[platform]) {
    cli = PLATFORM_CLI[platform];

    // 4. Check CLI availability
    const cliCheck = spawnSync(cli, ['--version'], { stdio: 'pipe' });
    cliInstalled = cliCheck.status === 0;
  }

  const result = {
    platform,
    source,
    remote_url: remoteUrl,
    cli,
    cli_installed: cliInstalled,
    cli_install_url: cli ? PLATFORM_CLI_URLS[cli] || null : null,
  };

  // When called in silent mode (field extraction path), skip output/exit and return the result.
  if (silent) return result;
  output(result, platform || 'unknown');
  return result; // unreachable (output calls process.exit), retained for clarity
}

function cmdSquash(cwd, phase, options) {
  const { strategy, dryRun, allowStable, listBackupTags: listTags } = options;

  // Handle --list-backup-tags subcommand
  if (listTags) {
    const tagResult = execGit(cwd, ['tag', '--list', 'gsd/backup/*']);
    const tags =
      tagResult.exitCode === 0 && tagResult.stdout
        ? tagResult.stdout.split('\n').filter(Boolean)
        : [];
    output({ tags }, tags.join('\n'));
    return;
  }

  if (!phase) error('phase number required for squash');
  if (!strategy) error('--strategy required: single, per-plan, or logical');

  const config = loadConfig(cwd);
  const targetBranch =
    config.target_branch || (config.git && config.git.target_branch) || 'main';

  // Get current branch name
  const branchResult = execGit(cwd, ['branch', '--show-current']);
  const currentBranch = branchResult.stdout || 'unknown';

  // Find phase directory
  const { phases: phasesDir } = planningPaths(cwd);
  let phaseDir = null;
  try {
    const dirs = fs
      .readdirSync(phasesDir)
      .filter(
        (d) =>
          d.startsWith(String(phase).padStart(2, '0') + '-') ||
          d.startsWith(String(phase) + '-'),
      );
    if (dirs.length > 0) {
      phaseDir = path.join(phasesDir, dirs[0]);
    }
  } catch {}

  // Collect SUMMARY.md one-liners for squash message
  const summaries = [];
  if (phaseDir) {
    try {
      const files = fs
        .readdirSync(phaseDir)
        .filter((f) => f.endsWith('-SUMMARY.md'))
        .sort();
      for (const file of files) {
        const content = fs.readFileSync(path.join(phaseDir, file), 'utf-8');
        // Extract bold one-liner from body (line starting with **)
        const oneLinerMatch = content.match(/^\*\*(.+)\*\*$/m);
        const oneLiner = oneLinerMatch ? oneLinerMatch[1] : null;
        const planMatch = file.match(/(\d+-\d+)/);
        const planId = planMatch
          ? planMatch[1]
          : file.replace('-SUMMARY.md', '');
        summaries.push({ planId, oneLiner: oneLiner || `Plan ${planId}` });
      }
    } catch {}
  }

  // Build squash groups based on strategy
  let groups;
  if (strategy === 'single') {
    const message =
      summaries.length > 0
        ? summaries.map((s) => `- ${s.planId}: ${s.oneLiner}`).join('\n')
        : `Phase ${phase} squash`;
    groups = [
      {
        name: `Phase ${phase}`,
        commits: 'all',
        message: `feat: Phase ${phase}\n\n${message}`,
      },
    ];
  } else if (strategy === 'per-plan') {
    groups = summaries.map((s) => ({
      name: `Plan ${s.planId}`,
      commits: s.planId,
      message: `feat(${s.planId}): ${s.oneLiner}`,
    }));
    if (groups.length === 0) {
      groups = [
        {
          name: `Phase ${phase}`,
          commits: 'all',
          message: `feat: Phase ${phase}`,
        },
      ];
    }
  } else if (strategy === 'logical') {
    // Logical = same as single for CLI; workflow presents interactive grouping
    groups = [
      {
        name: `Phase ${phase}`,
        commits: 'all',
        message: `feat: Phase ${phase}`,
      },
    ];
  } else {
    error(`Unknown strategy: ${strategy}. Use: single, per-plan, logical`);
  }

  // Dry run: return plan without executing (safe even on stable branches)
  if (dryRun) {
    output(
      { dry_run: true, strategy, phase, groups, executed: false },
      `DRY RUN (${strategy}):\n` +
        groups
          .map((g) => `  ${g.name}: ${g.message.split('\n')[0]}`)
          .join('\n'),
    );
    return;
  }

  // Safety: refuse to operate on stable branches without explicit flag (not applicable to dry-run)
  const stableBranches = ['main', 'master', 'develop'];
  if (stableBranches.includes(currentBranch) && !allowStable) {
    error(
      `Refusing to squash on stable branch '${currentBranch}'. Use --allow-stable to override, or operate on a work/review branch.`,
    );
  }

  // Create backup tag BEFORE any rewrite
  const date = new Date().toISOString().split('T')[0];
  const safeBranch = currentBranch.replace(/\//g, '-');
  const backupTag = `gsd/backup/${date}/${safeBranch}`;
  const tagResult = execGit(cwd, ['tag', backupTag]);
  if (tagResult.exitCode !== 0) {
    // Tag may already exist for today; append counter
    let counter = 1;
    let altTag;
    do {
      altTag = `${backupTag}-${counter}`;
      counter++;
    } while (execGit(cwd, ['tag', '--list', altTag]).stdout.trim() !== '');
    execGit(cwd, ['tag', altTag]);
  }

  // Execute squash: use git reset --soft for single/logical strategy
  if (strategy === 'single' || strategy === 'logical') {
    // Try to find merge base with target branch; fall back to root commit
    let baseRef = null;
    const mergeBase = execGit(cwd, ['merge-base', targetBranch, 'HEAD']);
    if (mergeBase.exitCode === 0 && mergeBase.stdout) {
      baseRef = mergeBase.stdout;
    } else {
      // Target branch may not exist (e.g., single-branch repo) — use root commit
      const rootCommit = execGit(cwd, ['rev-list', '--max-parents=0', 'HEAD']);
      if (rootCommit.exitCode === 0 && rootCommit.stdout) {
        baseRef = rootCommit.stdout.split('\n')[0].trim();
      }
    }

    if (!baseRef) {
      error(
        `Cannot find squash base — neither merge-base with ${targetBranch} nor root commit found`,
      );
    }

    execGit(cwd, ['reset', '--soft', baseRef]);
    const commitResult = execGit(cwd, ['commit', '-m', groups[0].message]);
    if (commitResult.exitCode !== 0) {
      error('Squash commit failed: ' + commitResult.stderr);
    }
  }

  // Verify backup tag exists
  const verifyTag = execGit(cwd, ['tag', '--list', 'gsd/backup/*']);
  const backupTags = verifyTag.stdout
    ? verifyTag.stdout.split('\n').filter(Boolean)
    : [];

  output(
    {
      squashed: true,
      strategy,
      phase,
      groups: groups.length,
      backup_tag: backupTags[backupTags.length - 1] || backupTag,
      executed: true,
    },
    `Squashed (${strategy}): ${groups.length} group(s), backup: ${backupTag}`,
  );
}

/**
 * Categorize a commit one-liner into Keep a Changelog sections.
 * Maps: feat -> Added, fix -> Fixed, refactor/perf -> Changed, revert -> Removed.
 * Default: Changed.
 */
function categorizeCommitType(oneLiner) {
  if (!oneLiner) return 'Changed';
  const lower = oneLiner.toLowerCase();
  if (/^feat[\s(:]/.test(lower)) return 'Added';
  if (/^fix[\s(:]/.test(lower)) return 'Fixed';
  if (/^(refactor|perf)[\s(:]/.test(lower)) return 'Changed';
  if (/^revert[\s(:]/.test(lower)) return 'Removed';
  return 'Changed';
}

/**
 * Derive version bump level from summary one-liners.
 * Highest-wins: BREAKING CHANGE -> major, any feat -> minor, otherwise -> patch.
 */
function deriveVersionBump(summaries) {
  if (!summaries || summaries.length === 0) return 'patch';
  if (summaries.some((s) => s.oneLiner && /BREAKING CHANGE/i.test(s.oneLiner)))
    return 'major';
  if (summaries.some((s) => s.oneLiner && /^feat[\s(:]/i.test(s.oneLiner)))
    return 'minor';
  return 'patch';
}

/**
 * Bump a version string according to the configured scheme.
 *
 * @param {string} current - Current version string
 * @param {'major'|'minor'|'patch'} level - Bump level
 * @param {'semver'|'calver'|'date'} scheme - Versioning scheme
 * @returns {string} New version string
 */
function bumpVersion(current, level, scheme) {
  const parts = current.split('.').map(Number);

  if (scheme === 'semver') {
    const [major, minor, patch] = parts;
    if (level === 'major') return `${major + 1}.0.0`;
    if (level === 'minor') return `${major}.${minor + 1}.0`;
    return `${major}.${minor}.${patch + 1}`;
  }

  if (scheme === 'calver') {
    const now = new Date();
    const year = now.getFullYear();
    const month = now.getMonth() + 1;
    // If current version is from same year+month, increment patch
    if (parts[0] === year && parts[1] === month) {
      return `${year}.${month}.${(parts[2] || 0) + 1}`;
    }
    // New month: reset patch to 0
    return `${year}.${month}.0`;
  }

  if (scheme === 'date') {
    // Chrome-style: MAJOR.MINOR.BUILD — BUILD auto-increments
    const [major, minor, build] = parts;
    return `${major}.${minor}.${(build || 0) + 1}`;
  }

  // Fallback: semver patch
  const [major, minor, patch] = parts;
  return `${major}.${minor}.${patch + 1}`;
}

/**
 * Append SemVer build metadata (+hash) to a version string.
 * Note: Do NOT write +hash to package.json (npm rejects it).
 *
 * @param {string} version - Version string
 * @param {string|null} hash - Short git hash
 * @returns {string} Version with optional +hash
 */
function appendBuildMetadata(version, hash) {
  if (!hash) return version;
  return `${version}+${hash}`;
}

/**
 * Generate a Keep a Changelog version block from summary data.
 *
 * @param {string} version - Version string (e.g., '1.1.0')
 * @param {string} date - ISO date string (e.g., '2026-03-16')
 * @param {Array<{planId: string, oneLiner: string}>} summaries - Plan summaries
 * @returns {string} Markdown block for CHANGELOG.md
 */
function generateChangelog(version, date, summaries) {
  // Group summaries by category
  const categories = { Added: [], Changed: [], Fixed: [], Removed: [] };

  for (const s of summaries) {
    const category = categorizeCommitType(s.oneLiner);
    // Strip type prefix for cleaner entry
    let description = s.oneLiner || `Plan ${s.planId}`;
    description = description.replace(
      /^(feat|fix|refactor|perf|revert|chore|docs|test)\s*(\([^)]*\))?\s*:\s*/i,
      '',
    );
    // Capitalize first letter
    description = description.charAt(0).toUpperCase() + description.slice(1);
    categories[category].push(`- ${description} [Plan ${s.planId}]`);
  }

  let block = `## [${version}] - ${date}\n`;

  // Only include sections that have entries
  for (const [section, entries] of Object.entries(categories)) {
    if (entries.length > 0) {
      block += `\n### ${section}\n`;
      block += entries.join('\n') + '\n';
    }
  }

  // If completely empty, add an empty Added section as placeholder
  if (summaries.length === 0) {
    block += '\n### Added\n- (no changes recorded)\n';
  }

  return block;
}

/**
 * Bump version in package.json and write VERSION file.
 * Reads bump level from commit type analysis if not explicitly provided.
 */
function cmdVersionBump(cwd, options, silent) {
  const { level: explicitLevel, scheme: explicitScheme, snapshot } = options;
  const config = loadConfig(cwd);
  const scheme = explicitScheme || config.versioning_scheme || 'semver';

  // Read current version from package.json
  const pkgPath = path.join(cwd, 'package.json');
  let currentVersion = '0.0.0';
  let pkg = {};
  try {
    pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
    currentVersion = pkg.version || '0.0.0';
  } catch {}

  // If no explicit level, derive from summaries
  let level = explicitLevel;
  if (!level) {
    const { phases: phasesDir } = planningPaths(cwd);
    const summaries = [];
    try {
      const dirs = fs
        .readdirSync(phasesDir, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name);
      for (const dir of dirs) {
        const files = fs
          .readdirSync(path.join(phasesDir, dir))
          .filter((f) => f.endsWith('-SUMMARY.md'));
        for (const file of files) {
          const content = fs.readFileSync(
            path.join(phasesDir, dir, file),
            'utf-8',
          );
          const oneLinerMatch = content.match(/^\*\*(.+)\*\*$/m);
          summaries.push({ oneLiner: oneLinerMatch ? oneLinerMatch[1] : null });
        }
      }
    } catch {}
    level = deriveVersionBump(summaries);
  }

  const newVersion = bumpVersion(currentVersion, level, scheme);

  // Write clean version to package.json (no +hash — npm rejects build metadata)
  pkg.version = newVersion;
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf-8');

  // Write to VERSION file (with optional build metadata)
  let versionFileContent = newVersion;
  if (snapshot) {
    const hashResult = execGit(cwd, ['rev-parse', '--short', 'HEAD']);
    const hash = hashResult.exitCode === 0 ? hashResult.stdout.trim() : null;
    if (hash) {
      versionFileContent = appendBuildMetadata(newVersion, hash);
    }
  }
  const versionFilePath = path.join(cwd, 'VERSION');
  fs.writeFileSync(versionFilePath, versionFileContent + '\n', 'utf-8');

  const versionResult = {
    bumped: true,
    previous: currentVersion,
    version: newVersion,
    version_file: versionFileContent,
    level,
    scheme,
    snapshot: !!snapshot,
  };
  // When called in silent mode (field extraction path), skip output/exit and return the result.
  if (silent) return versionResult;
  output(versionResult, newVersion);
  return versionResult; // unreachable (output calls process.exit), retained for clarity
}

/**
 * Generate CHANGELOG.md entries from SUMMARY.md files across all phases.
 * Inserts the new version block after the [Unreleased] section.
 */
function cmdGenerateChangelog(cwd, version, options) {
  const { date: dateOverride } = options;
  const date = dateOverride || new Date().toISOString().split('T')[0];

  if (!version) error('version required for generate-changelog');

  // Collect summaries from all phase directories
  const { phases: phasesDir } = planningPaths(cwd);
  const summaries = [];
  try {
    const dirs = fs
      .readdirSync(phasesDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
    for (const dir of dirs) {
      const files = fs
        .readdirSync(path.join(phasesDir, dir))
        .filter((f) => f.endsWith('-SUMMARY.md'))
        .sort();
      for (const file of files) {
        const content = fs.readFileSync(
          path.join(phasesDir, dir, file),
          'utf-8',
        );
        const oneLinerMatch = content.match(/^\*\*(.+)\*\*$/m);
        const planMatch = file.match(/(\d+(?:\.\d+)?-\d+)/);
        const planId = planMatch
          ? planMatch[1]
          : file.replace('-SUMMARY.md', '');
        summaries.push({
          planId,
          oneLiner: oneLinerMatch ? oneLinerMatch[1] : null,
        });
      }
    }
  } catch {}

  const block = generateChangelog(version, date, summaries);

  // Insert into CHANGELOG.md (after [Unreleased] section, or after header)
  const changelogPath = path.join(cwd, 'CHANGELOG.md');
  let existingContent = '';
  try {
    existingContent = fs.readFileSync(changelogPath, 'utf-8');
  } catch {}

  let updatedContent;
  if (existingContent) {
    // Find insertion point: after ## [Unreleased] section
    const unreleasedIdx = existingContent.indexOf('## [Unreleased]');
    if (unreleasedIdx >= 0) {
      // Find the next ## header after [Unreleased]
      const afterUnreleased = existingContent.indexOf(
        '\n## [',
        unreleasedIdx + 1,
      );
      if (afterUnreleased >= 0) {
        updatedContent =
          existingContent.slice(0, afterUnreleased) +
          '\n' +
          block +
          '\n' +
          existingContent.slice(afterUnreleased + 1);
      } else {
        // No version after Unreleased — append at end
        updatedContent = existingContent.trimEnd() + '\n\n' + block;
      }
    } else {
      // No Unreleased section — insert after first blank line after heading
      const firstNewline = existingContent.indexOf('\n\n');
      if (firstNewline >= 0) {
        updatedContent =
          existingContent.slice(0, firstNewline) +
          '\n\n' +
          block +
          '\n' +
          existingContent.slice(firstNewline + 2);
      } else {
        updatedContent = existingContent + '\n\n' + block;
      }
    }
  } else {
    // Create new CHANGELOG.md
    updatedContent = `# Changelog\n\nAll notable changes will be documented in this file.\n\nFormat follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).\n\n## [Unreleased]\n\n${block}`;
  }

  fs.writeFileSync(changelogPath, updatedContent, 'utf-8');

  // Clear [Unreleased] section content (entries move to new version block)
  let finalContent = fs.readFileSync(changelogPath, 'utf-8');
  const unreleasedStart = finalContent.indexOf('## [Unreleased]');
  if (unreleasedStart >= 0) {
    const unreleasedEnd = finalContent.indexOf('\n## [', unreleasedStart + 15);
    if (unreleasedEnd >= 0) {
      finalContent =
        finalContent.slice(0, unreleasedStart + '## [Unreleased]'.length) +
        '\n' +
        finalContent.slice(unreleasedEnd);
      fs.writeFileSync(changelogPath, finalContent, 'utf-8');
    }
  }

  output(
    {
      generated: true,
      version,
      date,
      entries: summaries.length,
      path: 'CHANGELOG.md',
    },
    `CHANGELOG.md updated with ${summaries.length} entries for v${version}`,
  );
}

/**
 * Label-to-area mapping for import.
 * Maps common issue label names to GSD area values.
 */
const LABEL_AREA_MAP = {
  bug: 'bug',
  enhancement: 'feature',
  feature: 'feature',
  documentation: 'docs',
  docs: 'docs',
  performance: 'perf',
  security: 'security',
  test: 'test',
  tests: 'test',
  refactor: 'refactor',
  chore: 'chore',
};

/**
 * Import an external issue as a GSD todo.
 * Creates a .planning/todos/pending/{date}-{slug}.md file.
 *
 * @param {string} cwd
 * @param {string} platform - github|gitlab|forgejo|gitea
 * @param {number|string} number - Issue number
 * @param {string|null} repo - Optional repo override
 * @returns {{ imported, todo_file, title, external_ref, commented }}
 */
function cmdIssueImport(cwd, platform, number, repo, _testOverrides) {
  loadConfig(cwd); // Ensure config is loaded (side-effects: migration)
  // Read issue_tracker config directly from config.json since loadConfig
  // returns a flat structured object and does not expose the raw issue_tracker section.
  let itConfig = {};
  try {
    const rawConfig = JSON.parse(
      fs.readFileSync(planningPaths(cwd).config, 'utf-8'),
    );
    itConfig = rawConfig.issue_tracker || {};
  } catch {
    /* no config.json, use empty defaults */
  }
  const commentStyle = itConfig.comment_style || 'external';
  const commentOnImport = commentStyle === 'verbose';

  // Resolve CLI invoker: explicit injection wins, then GSD_TEST_MODE shim, then real CLI.
  const overrides = _testOverrides || {};
  const cli =
    overrides.cliInvoker ||
    (process.env.GSD_TEST_MODE ? _legacyTestModeInvoker : invokeIssueCli);

  // Fetch issue details
  const cliResult = cli(platform, 'view', [number, repo]);
  if (!cliResult.success) {
    error(`Failed to fetch issue ${platform}:${number}: ${cliResult.error}`);
  }
  const issueData = cliResult.data || {};

  // Normalize GitLab iid to number
  if (issueData.iid && !issueData.number) {
    issueData.number = issueData.iid;
  }

  const issueNumber = issueData.number || parseInt(String(number), 10);
  const title = issueData.title || `Issue #${issueNumber}`;
  const body = issueData.body || '';
  const rawLabels = issueData.labels || [];
  const labelNames = rawLabels.map((l) =>
    typeof l === 'string' ? l.toLowerCase() : (l.name || '').toLowerCase(),
  );

  // Map first matching label to area, or 'general'
  let area = 'general';
  for (const label of labelNames) {
    if (LABEL_AREA_MAP[label]) {
      area = LABEL_AREA_MAP[label];
      break;
    }
    // Use the label name directly if not in map
    area = label || 'general';
    break;
  }

  // Build external_ref string
  const externalRef = repo
    ? `${platform}:${repo}#${issueNumber}`
    : `${platform}:#${issueNumber}`;

  // Security: scan external content for prompt injection patterns (Rule of Two: external data + write access)
  const titleScan = scanForInjection(title, { external: true });
  const bodyScan = scanForInjection(body, { external: true });

  // Log all findings regardless of tier
  if (!titleScan.clean) {
    logSecurityEvent(cwd, {
      source: `issue-import:${externalRef}:title`,
      tier: titleScan.tier,
      blocked: titleScan.blocked,
      findings: titleScan.findings,
    });
  }
  if (!bodyScan.clean) {
    logSecurityEvent(cwd, {
      source: `issue-import:${externalRef}:body`,
      tier: bodyScan.tier,
      blocked: bodyScan.blocked,
      findings: bodyScan.findings,
    });
  }

  // Block on high-confidence detection (unambiguous attack indicators in external content)
  const highTier = titleScan.tier === 'high' || bodyScan.tier === 'high';
  if (highTier) {
    const allBlocked = [...titleScan.blocked, ...bodyScan.blocked];
    error(
      `[SECURITY] High-confidence injection detected in issue ${externalRef}. Detected: ${allBlocked.join('; ')}. Re-run with --force-unsafe to override.`,
    );
  }

  // Wrap body in untrusted-content tags for all non-blocked writes
  const wrappedBody = wrapUntrustedContent(body, externalRef);

  // Generate filename: date-slug.md (ISO date prefix)
  const today = new Date().toISOString().split('T')[0];
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  const filename = `${today}-${slug}.md`;

  // Build platform display name
  const platformDisplay = platform.charAt(0).toUpperCase() + platform.slice(1);

  // Write todo file
  const { todosPending: pendingDir } = planningPaths(cwd);
  fs.mkdirSync(pendingDir, { recursive: true });
  const todoFilePath = path.join(pendingDir, filename);
  const created = new Date().toISOString();

  const content = [
    '---',
    `created: ${created}`,
    `title: ${title}`,
    `area: ${area}`,
    `external_ref: "${externalRef}"`,
    'files: []',
    '---',
    '',
    '## Problem',
    '',
    `[Imported from ${platformDisplay} issue #${issueNumber}]`,
    '',
    wrappedBody,
    '',
    '## Solution',
    '',
    '[To be determined]',
    '',
  ].join('\n');

  fs.writeFileSync(todoFilePath, content, 'utf-8');

  // Optionally post import comment
  let commented = false;
  if (commentOnImport) {
    try {
      const importComment = buildImportComment(commentStyle, {
        todoFile: filename,
      });
      cli(platform, 'comment', [issueNumber, repo, importComment]);
      commented = true;
    } catch (_e) {
      // Skip on failure (Forgejo comment may not exist)
    }
  }

  const result = {
    imported: true,
    todo_file: filename,
    title,
    external_ref: externalRef,
    commented,
  };

  output(result, `Imported ${externalRef} -> ${filename}`);
  return result;
}

/**
 * Parse REQUIREMENTS.md traceability table for rows with external_ref and status.
 * Returns array of { reqId, status, externalRef } objects.
 *
 * @param {string} content - REQUIREMENTS.md file content
 * @returns {Array<{reqId: string, status: string, externalRef: string}>}
 */
function parseRequirementsExternalRefs(content) {
  if (!content) return [];
  const results = [];
  const lines = content.split('\n');

  // Find the header row to locate column indices
  let externalRefCol = -1;
  let statusCol = -1;
  let idCol = -1;
  let inTable = false;

  for (const line of lines) {
    if (!line.startsWith('|')) {
      if (inTable) continue;
      continue;
    }

    const cells = line
      .split('|')
      .map((c) => c.trim())
      .filter(Boolean);

    // Detect header row
    if (!inTable) {
      const lowerCells = cells.map((c) => c.toLowerCase());
      const hasExternalRef = lowerCells.some(
        (c) => c.includes('external_ref') || c === 'external ref',
      );
      if (hasExternalRef) {
        inTable = true;
        externalRefCol = lowerCells.findIndex(
          (c) => c.includes('external_ref') || c === 'external ref',
        );
        statusCol = lowerCells.findIndex((c) => c === 'status');
        idCol = lowerCells.findIndex((c) => c === 'id');
        continue;
      }
    }

    if (!inTable) continue;

    // Skip separator rows
    if (cells.every((c) => /^[-:]+$/.test(c))) continue;

    if (externalRefCol >= 0 && externalRefCol < cells.length) {
      const extRef = cells[externalRefCol];
      if (!extRef || extRef === '-' || extRef === '') continue;

      const status = statusCol >= 0 ? cells[statusCol] : '';
      const reqId = idCol >= 0 ? cells[idCol] : '';
      results.push({ reqId, status, externalRef: extRef });
    }
  }

  return results;
}

/**
 * Get the latest short git commit hash.
 * Returns null if not in a git repo.
 *
 * @param {string} cwd
 * @returns {string|null}
 */
function getLatestCommitHash(cwd) {
  const result = execGit(cwd, ['rev-parse', '--short', 'HEAD']);
  if (result.exitCode !== 0) return null;
  return result.stdout ? result.stdout.trim() : null;
}

/**
 * Apply a verify label to an external issue.
 * Advisory-only: warns on failure, never exits with error.
 * In GSD_TEST_MODE, uses dry_run path via invokeIssueCli.
 *
 * @param {string} platform
 * @param {number} number
 * @param {string|null} repo
 * @param {string} verifyLabel
 * @returns {boolean} true if label applied successfully
 */
function applyVerifyLabel(platform, number, repo, verifyLabel, _invoker) {
  const cli = _invoker || invokeIssueCli;
  let result = cli(platform, 'label', [number, repo, verifyLabel]);
  if (!result.success) {
    // Try to auto-create the label first, then retry
    const createResult = cli(platform, 'label_create', [repo, verifyLabel]);
    if (createResult.success) {
      result = cli(platform, 'label', [number, repo, verifyLabel]);
    }
    if (!result.success) {
      process.stderr.write(
        `Warning: Could not apply verify label '${verifyLabel}' to ${platform}:#${number}. ${result.error || ''}. Continuing without label.\n`,
      );
    }
  }
  return result.success;
}

/**
 * Sync completed GSD items to external issue trackers.
 * Reads REQUIREMENTS.md and done todos, dispatches close/comment for external_refs.
 *
 * @param {string} cwd
 * @param {string|null} phase - Filter to specific phase (not used in current minimal impl)
 * @param {{ auto: boolean }} options - auto=true means outbound-only
 * @returns {{ synced, conflicts, skipped }}
 */
/**
 * Sync a single external_ref string to its external issue tracker.
 * Module-level helper used by both cmdIssueSync and cmdTodoComplete.
 *
 * @param {string} refStr - External ref string (e.g. "github:#42")
 * @param {{ commitHash?: string, phaseName?: string }} commentContext
 * @param {{ default_action?: string, comment_style?: string, close_state?: string, verify_label?: string }} itConfig
 * @returns {Array<{ ref: string, action: string, success: boolean, error?: string }>}
 */
function syncSingleRef(refStr, commentContext, itConfig, _invoker) {
  const cfg = itConfig || {};
  const defaultAction = cfg.default_action || 'close';
  const commentStyle = cfg.comment_style || 'external';
  const closeState = cfg.close_state || 'close';
  const verifyLabel = cfg.verify_label || 'needs-verification';
  const cli = _invoker || invokeIssueCli;

  const results = [];
  const refs = parseExternalRef(refStr, null);
  for (const ref of refs) {
    const action = ref.action || defaultAction;
    const comment = buildSyncComment(commentStyle, commentContext || {});

    let cliResult;
    if (action === 'close' && closeState === 'verify') {
      // Apply verify label only — leave issue open for manual sign-off
      const labeled = applyVerifyLabel(
        ref.platform,
        ref.number,
        ref.repo,
        verifyLabel,
        cli,
      );
      cliResult = { success: labeled, action: 'verify' };
    } else if (action === 'close' && closeState === 'verify_then_close') {
      // Apply verify label, then close
      applyVerifyLabel(ref.platform, ref.number, ref.repo, verifyLabel, cli);
      const supportsInlineComment =
        ref.platform === 'github' || ref.platform === 'forgejo';
      if (supportsInlineComment) {
        cliResult = cli(ref.platform, 'close', [ref.number, ref.repo, comment]);
      } else {
        cli(ref.platform, 'comment', [ref.number, ref.repo, comment]);
        cliResult = cli(ref.platform, 'close', [ref.number, ref.repo, null]);
      }
    } else if (action === 'close') {
      // Default close behavior (close_state=close or no config)
      // GitHub and Forgejo support inline comments on close; GitLab and
      // Gitea ignore the comment parameter. Post a separate comment first
      // for platforms that would lose the reference, then close.
      const supportsInlineComment =
        ref.platform === 'github' || ref.platform === 'forgejo';
      if (supportsInlineComment) {
        cliResult = cli(ref.platform, 'close', [ref.number, ref.repo, comment]);
      } else {
        cli(ref.platform, 'comment', [ref.number, ref.repo, comment]);
        cliResult = cli(ref.platform, 'close', [ref.number, ref.repo, null]);
      }
    } else {
      cliResult = cli(ref.platform, 'comment', [ref.number, ref.repo, comment]);
    }

    results.push({
      ref: ref.raw,
      action: cliResult.action || action,
      success: cliResult.success,
      error: cliResult.success ? undefined : cliResult.error,
    });
  }
  return results;
}

function cmdIssueSync(cwd, phase, options, _testOverrides) {
  const opts = options || {};
  // Note: existing tests historically passed a 4th positional `true` as a
  // legacy "verify state" flag that was always ignored. Treat truthy non-object
  // 4th args as legacy and discard them so the cliInvoker seam stays clean.
  const overrides =
    _testOverrides && typeof _testOverrides === 'object' ? _testOverrides : {};
  const cliInvoker =
    overrides.cliInvoker ||
    (process.env.GSD_TEST_MODE ? _legacyTestModeInvoker : invokeIssueCli);
  loadConfig(cwd); // Ensure config is loaded (side-effects: migration)
  // Read issue_tracker config directly from config.json since loadConfig
  // returns a flat structured object and does not expose the raw issue_tracker section.
  let itConfig = {};
  const paths = planningPaths(cwd);
  try {
    const rawConfig = JSON.parse(fs.readFileSync(paths.config, 'utf-8'));
    itConfig = rawConfig.issue_tracker || {};
  } catch {
    /* no config.json, use empty defaults */
  }

  const synced = [];
  const conflicts = [];
  let skipped = 0;

  // Build sync comment context
  const commitHash = getLatestCommitHash(cwd);
  const commentContext = { commitHash, phaseName: phase };

  // 1. Scan REQUIREMENTS.md
  const reqPath = paths.requirements;
  const reqContent = safeReadFile(reqPath);
  if (reqContent) {
    const rows = parseRequirementsExternalRefs(reqContent);
    for (const row of rows) {
      if (row.status === 'Complete') {
        const refResults = syncSingleRef(
          row.externalRef,
          commentContext,
          itConfig,
          cliInvoker,
        );
        synced.push(...refResults);
      } else if (row.externalRef && row.externalRef !== '-') {
        skipped++;
      }
    }
  }

  // 2. Scan completed todos
  const doneTodosDir = paths.todosCompleted;
  let doneTodoFiles = [];
  try {
    doneTodoFiles = fs
      .readdirSync(doneTodosDir)
      .filter((f) => f.endsWith('.md'));
  } catch (_e) {
    // Directory may not exist
  }

  for (const file of doneTodoFiles) {
    try {
      const content = fs.readFileSync(path.join(doneTodosDir, file), 'utf-8');
      const fm = extractFrontmatter(content);
      if (fm && fm.external_ref) {
        const refStr = fm.external_ref;

        // Security: scan todo content for injection before processing (external data was written on import)
        const scanResult = scanForInjection(content, { external: true });
        if (!scanResult.clean) {
          logSecurityEvent(cwd, {
            source: `issue-sync:${refStr}`,
            tier: scanResult.tier,
            blocked: scanResult.blocked,
            findings: scanResult.findings,
          });
        }
        if (scanResult.tier === 'high') {
          // Log warning but don't block sync (batch operation — log and continue)
          process.stderr.write(
            `[security] High-confidence injection detected in sync for ${refStr}. Logged to security-events.log.\n`,
          );
        }

        const refResults = syncSingleRef(
          refStr,
          commentContext,
          itConfig,
          cliInvoker,
        );
        synced.push(...refResults);
      }
    } catch (_e) {
      // Skip unreadable files
    }
  }

  // 3. Inbound check (manual mode only, not auto)
  if (!opts.auto) {
    // For each known ref, check external state vs GSD state
    // In test mode we skip actual CLI calls; just return empty conflicts
    // (full inbound implementation is a future enhancement)
  }

  const result = { synced, conflicts, skipped };
  output(
    result,
    `Synced ${synced.length} ref(s), ${conflicts.length} conflict(s), ${skipped} skipped`,
  );
  return result;
}

/**
 * List all external_ref values found in REQUIREMENTS.md and todo frontmatter.
 * Deduplicates by ref_string.
 *
 * @param {string} cwd
 * @returns {{ refs: Array<{source, ref_string, parsed}>, count }}
 */
function cmdIssueListRefs(cwd) {
  const refs = [];
  const seen = new Set();

  function addRef(source, refStr) {
    if (!refStr || seen.has(refStr)) return;
    seen.add(refStr);
    const parsed = parseExternalRef(refStr, null);
    refs.push({ source, ref_string: refStr, parsed });
  }

  // 1. Scan REQUIREMENTS.md
  const {
    requirements: reqPath,
    todosPending,
    todosCompleted,
  } = planningPaths(cwd);
  const reqContent = safeReadFile(reqPath);
  if (reqContent) {
    const rows = parseRequirementsExternalRefs(reqContent);
    for (const row of rows) {
      if (row.externalRef) {
        // externalRef may be comma-separated
        const parts = row.externalRef
          .split(',')
          .map((r) => r.trim())
          .filter(Boolean);
        for (const part of parts) {
          addRef('requirements', part);
        }
      }
    }
  }

  // 2. Scan todos/pending and todos/completed
  for (const [subDir, dir] of [
    ['pending', todosPending],
    ['completed', todosCompleted],
  ]) {
    let files = [];
    try {
      files = fs.readdirSync(dir).filter((f) => f.endsWith('.md'));
    } catch (_e) {
      continue;
    }
    for (const file of files) {
      try {
        const content = fs.readFileSync(path.join(dir, file), 'utf-8');
        const fm = extractFrontmatter(content);
        if (fm && fm.external_ref) {
          const parts = fm.external_ref
            .split(',')
            .map((r) => r.trim())
            .filter(Boolean);
          for (const part of parts) {
            addRef(`todos/${subDir}/${file}`, part);
          }
        }
      } catch (_e) {
        // Skip unreadable files
      }
    }
  }

  const result = { refs, count: refs.length };
  output(result, `Found ${refs.length} external ref(s)`);
  return result;
}

function cmdStalenessCheck(cwd, countOnly = false) {
  const { codebase: codebaseDir } = planningPaths(cwd);
  if (!fs.existsSync(codebaseDir)) {
    if (countOnly) {
      output(0, '0');
    } else {
      output({ stale: [], all_stale: false }, 'no codebase directory');
    }
    return;
  }

  const docs = fs.readdirSync(codebaseDir).filter((f) => f.endsWith('.md'));
  const stale = [];

  for (const doc of docs) {
    const filePath = path.join(codebaseDir, doc);
    try {
      const content = fs.readFileSync(filePath, 'utf8');
      const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
      if (!fmMatch) {
        stale.push({ doc, reason: 'no_frontmatter', changed_files: [] });
        continue;
      }
      const hashMatch = fmMatch[1].match(/last_mapped_commit:\s*(\S+)/);
      if (!hashMatch) {
        stale.push({ doc, reason: 'no_commit_hash', changed_files: [] });
        continue;
      }
      const hash = hashMatch[1];
      try {
        const changed = execSync(`git diff --name-only ${hash}..HEAD`, {
          encoding: 'utf8',
          cwd,
          timeout: 5000,
          stdio: ['pipe', 'pipe', 'ignore'],
        }).trim();
        if (changed) {
          stale.push({
            doc,
            hash,
            changed_files: changed.split('\n').filter(Boolean),
          });
        }
      } catch (e) {
        // Hash not found (post-squash) — mark as stale, needs full re-map
        stale.push({ doc, hash, reason: 'hash_not_found', changed_files: [] });
      }
    } catch {}
  }

  if (countOnly) {
    output(stale.length, String(stale.length));
    return;
  }

  const allStale = stale.length === docs.length;
  output(
    { stale, all_stale: allStale, total_docs: docs.length },
    stale.length > 0 ? stale.map((s) => s.doc).join(', ') : 'none',
  );
}

function cmdHelp(cwd, args) {
  const commandsDir = path.join(__dirname, '..', '..', '..', 'commands', 'gsd');
  let commands = [];

  try {
    const files = fs.readdirSync(commandsDir).filter((f) => f.endsWith('.md'));

    for (const file of files) {
      try {
        const content = fs.readFileSync(path.join(commandsDir, file), 'utf-8');
        const fm = extractFrontmatter(content);
        commands.push({
          name: fm && fm.name ? fm.name : 'gsd:' + path.basename(file, '.md'),
          description: fm && fm.description ? fm.description : '',
          argument_hint: fm && fm['argument-hint'] ? fm['argument-hint'] : '',
        });
      } catch {}
    }

    commands.sort((a, b) => a.name.localeCompare(b.name));
  } catch (e) {
    const result = { commands: [], error: 'Commands directory not found' };
    output(result, 'Commands directory not found');
    return;
  }

  function formatHelpText(cmds) {
    const pad = 35;
    const lines = ['GSD Command Reference', ''];
    for (const cmd of cmds) {
      const namePart = cmd.name.padEnd(pad);
      const hint = cmd.argument_hint ? ` [${cmd.argument_hint}]` : '';
      lines.push(`${namePart}${cmd.description}${hint}`);
    }
    return lines.join('\n');
  }

  const result = { commands };
  output(result, formatHelpText(commands));
}

// ─────────────────────────────────────────────────────────────────────────────
// Divergence tracking helpers and command
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Valid triage status values for divergence tracking.
 * Includes upstream states plus branch-tracking states needs-adaptation and already-covered.
 */
const VALID_TRIAGE_STATES = [
  'picked',
  'skipped',
  'deferred',
  'pending',
  'needs-adaptation',
  'already-covered',
  'adapted',
];

/**
 * Classify a commit subject by conventional commit prefix.
 * Priority: fix/security > feat > docs/chore/etc > unknown
 *
 * @param {string} subject
 * @returns {'fix'|'feat'|'other'|'unknown'}
 */
function classifyCommit(subject) {
  if (/^BREAKING[\s_]CHANGE/i.test(subject)) return 'fix';
  if (/^(fix|security|hotfix|bugfix|revert)[\(!:\s]/i.test(subject))
    return 'fix';
  if (/^feat[\(!:\s]/i.test(subject)) return 'feat';
  if (/^(docs|chore|test|refactor|style|ci|build|perf)[\(!:\s]/i.test(subject))
    return 'other';
  return 'unknown';
}

/**
 * Sort order for commit classifications. Lower = higher priority.
 *
 * @param {string} classification
 * @returns {number}
 */
function priorityOrder(classification) {
  return { fix: 0, feat: 1, other: 2, unknown: 3 }[classification] ?? 3;
}

/**
 * Extract PR number from commit subject.
 * Matches the number inside forms like `(#N)`, `PR #N`,
 * or `Merge pull request #N`.
 *
 * @param {string} subject
 * @returns {string|null}
 */
function extractPrNumber(subject) {
  const m = subject.match(/#(\d+)/);
  return m ? m[1] : null;
}

/**
 * Normalize a commit subject for fuzzy matching.
 * Strips PR refs, conventional commit prefixes, punctuation, and lowercases.
 *
 * @param {string} subject
 * @returns {string}
 */
function normalizeForMatch(subject) {
  return subject
    .replace(/#\d+/g, '')
    .replace(
      /^(fix|feat|docs|chore|refactor|test|style|ci|build|perf|revert|security|hotfix|bugfix)(\([^)]*\))?[!:]?\s*/i,
      '',
    )
    .replace(/[^a-z0-9\s]/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/**
 * Parse a specific branch tracking section from DIVERGENCE.md.
 *
 * @param {string} filePath
 * @param {string} sectionKey - e.g., "main..feature/foo"
 * @returns {Map<string, {date: string, subject: string, status: string, reason: string}>}
 */
function parseDivergenceBranchSection(filePath, sectionKey) {
  const result = new Map();
  if (!fs.existsSync(filePath)) return result;

  let content;
  try {
    content = fs.readFileSync(filePath, 'utf-8');
  } catch {
    return result;
  }

  const sectionHeader = `## Branch Tracking: ${sectionKey}`;
  const sectionIdx = content.indexOf(sectionHeader);
  if (sectionIdx === -1) return result;

  // Find the next ## heading or end of file
  const afterHeader = content.substring(sectionIdx + sectionHeader.length);
  const nextSectionIdx = afterHeader.indexOf('\n## ');
  const sectionContent =
    nextSectionIdx !== -1
      ? afterHeader.substring(0, nextSectionIdx)
      : afterHeader;

  const lines = sectionContent.split('\n');
  let inTable = false;
  let headerSeen = false;
  let hasClassificationCol = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('|')) {
      if (inTable) break;
      continue;
    }
    const cells = trimmed
      .split('|')
      .map((c) => c.trim())
      .filter(Boolean);
    if (!headerSeen) {
      const lowerCells = cells.map((c) => c.toLowerCase());
      if (lowerCells.includes('hash')) {
        headerSeen = true;
        inTable = true;
        hasClassificationCol = lowerCells.includes('classification');
        continue;
      }
    }
    if (!inTable) continue;
    if (cells.every((c) => /^[-:]+$/.test(c))) continue;
    if (hasClassificationCol ? cells.length >= 5 : cells.length >= 4) {
      // Branch table: hash | date | subject | classification | status | reason
      // Legacy table: hash | date | subject | status | reason
      const [hash, date, subject, classOrStatus, ...rest] = cells;
      let status, reasonParts;
      if (hasClassificationCol) {
        [status, ...reasonParts] = rest;
      } else {
        status = classOrStatus;
        reasonParts = rest;
      }
      result.set(hash.trim(), {
        date: date.trim(),
        subject: subject.trim(),
        classification: hasClassificationCol ? classOrStatus.trim() : undefined,
        status: (status || '').trim(),
        reason: reasonParts.join(' | ').trim(),
      });
    }
  }
  return result;
}

/**
 * Write or overwrite a branch tracking section in DIVERGENCE.md.
 * Preserves all other content.
 *
 * @param {string} filePath
 * @param {string} sectionKey - e.g., "main..feature/foo"
 * @param {Array<{hash, date, subject, classification, status, reason}>} commits
 */
function writeDivergenceBranchSection(filePath, sectionKey, commits) {
  const today = new Date().toISOString().split('T')[0];
  const sectionHeader = `## Branch Tracking: ${sectionKey}`;
  const rows = commits
    .map(
      (c) =>
        `| ${c.hash} | ${c.date} | ${c.subject} | ${c.classification || ''} | ${c.status} | ${c.reason} |`,
    )
    .join('\n');

  const newSection = [
    '',
    sectionHeader,
    `**Tracked:** ${sectionKey}`,
    `**Last checked:** ${today}`,
    '',
    '| Hash | Date | Subject | Classification | Status | Reason |',
    '|------|------|---------|----------------|--------|--------|',
    rows,
    '',
  ].join('\n');

  let content = '';
  try {
    content = fs.readFileSync(filePath, 'utf-8');
  } catch {}

  if (!content) {
    // Create minimal DIVERGENCE.md with just this section
    fs.writeFileSync(filePath, '# Divergence Tracking\n' + newSection, 'utf-8');
    return;
  }

  const existingSectionIdx = content.indexOf(sectionHeader);
  if (existingSectionIdx !== -1) {
    // Replace existing section
    const afterHeader = content.substring(existingSectionIdx);
    const nextSectionIdx = afterHeader.indexOf('\n## ', sectionHeader.length);
    const beforeSection = content.substring(0, existingSectionIdx);
    const afterSection =
      nextSectionIdx !== -1 ? afterHeader.substring(nextSectionIdx) : '';
    content = beforeSection.trimEnd() + newSection + afterSection;
  } else {
    // Append new section
    content = content.trimEnd() + '\n' + newSection;
  }

  fs.writeFileSync(filePath, content, 'utf-8');
}

/**
 * Parse a DIVERGENCE.md markdown table into a Map of hash -> entry object.
 * Returns an empty Map if the file doesn't exist or has no table.
 *
 * @param {string} filePath - Absolute path to DIVERGENCE.md
 * @returns {Map<string, {date: string, subject: string, status: string, reason: string}>}
 */
function parseDivergenceFile(filePath) {
  const result = new Map();
  if (!fs.existsSync(filePath)) return result;

  let content;
  try {
    content = fs.readFileSync(filePath, 'utf-8');
  } catch {
    return result;
  }

  const lines = content.split('\n');
  let inTable = false;
  let headerSeen = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('|')) {
      if (inTable) break; // table ended
      continue;
    }

    const cells = trimmed
      .split('|')
      .map((c) => c.trim())
      .filter(Boolean);

    // Detect header row (first table row with text cells)
    if (!headerSeen) {
      const lowerCells = cells.map((c) => c.toLowerCase());
      if (lowerCells[0] === 'hash' || lowerCells.includes('hash')) {
        headerSeen = true;
        inTable = true;
        continue;
      }
    }

    if (!inTable) continue;

    // Skip separator rows
    if (cells.every((c) => /^[-:]+$/.test(c))) continue;

    // Data row: | hash | date | subject | status | reason |
    if (cells.length >= 4) {
      const [hash, date, subject, status, ...reasonParts] = cells;
      const reason = reasonParts.join(' | ');
      result.set(hash.trim(), {
        date: date.trim(),
        subject: subject.trim(),
        status: status.trim(),
        reason: reason.trim(),
      });
    }
  }

  return result;
}

/**
 * Write a new DIVERGENCE.md with header section and commit triage table.
 *
 * @param {string} filePath - Absolute path to DIVERGENCE.md
 * @param {string} upstreamUrl - URL of upstream remote
 * @param {Array<{hash, date, subject, status, reason}>} commits
 */
function writeDivergenceFile(
  filePath,
  upstreamUrl,
  commits,
  remoteName = 'upstream',
) {
  const today = new Date().toISOString().split('T')[0];
  const rows = commits
    .map(
      (c) =>
        `| ${c.hash} | ${c.date} | ${c.subject} | ${c.status} | ${c.reason} |`,
    )
    .join('\n');

  const content = [
    '# Divergence Tracking',
    '',
    `**Upstream remote (${remoteName}):** ${upstreamUrl}`,
    `**Last checked:** ${today}`,
    '',
    '## Commit Triage',
    '',
    '| Hash | Date | Subject | Status | Reason |',
    '|------|------|---------|--------|--------|',
    rows,
    '',
  ].join('\n');

  fs.writeFileSync(filePath, content, 'utf-8');
}

/**
 * Rewrite the triage table in an existing DIVERGENCE.md with updated state.
 * Preserves the header section above the table. Updates "Last checked" date.
 *
 * @param {string} filePath - Absolute path to DIVERGENCE.md
 * @param {Map<string, {date, subject, status, reason}>} triageState
 */
function rewriteDivergenceTable(filePath, triageState) {
  const today = new Date().toISOString().split('T')[0];
  let content = '';
  try {
    content = fs.readFileSync(filePath, 'utf-8');
  } catch {
    // File doesn't exist — create from scratch
    const commits = [...triageState.entries()].map(([hash, e]) => ({
      hash,
      date: e.date || '',
      subject: e.subject || '',
      status: e.status || 'pending',
      reason: e.reason || '',
    }));
    writeDivergenceFile(filePath, 'unknown', commits);
    return;
  }

  // Update "Last checked" date
  content = content.replace(
    /\*\*Last checked:\*\*\s*.+/,
    `**Last checked:** ${today}`,
  );

  // Find the table section and replace it
  const tableHeaderIdx = content.indexOf(
    '| Hash | Date | Subject | Status | Reason |',
  );
  if (tableHeaderIdx === -1) {
    // No existing table — append it
    const rows = [...triageState.entries()]
      .map(
        ([hash, e]) =>
          `| ${hash} | ${e.date || ''} | ${e.subject || ''} | ${e.status || 'pending'} | ${e.reason || ''} |`,
      )
      .join('\n');
    content =
      content.trimEnd() +
      '\n\n## Commit Triage\n\n| Hash | Date | Subject | Status | Reason |\n|------|------|---------|--------|--------|\n' +
      rows +
      '\n';
    fs.writeFileSync(filePath, content, 'utf-8');
    return;
  }

  // Find the end of the separator row and rebuild from there
  const sepRow = '|------|------|---------|--------|--------|';
  const sepIdx = content.indexOf(sepRow, tableHeaderIdx);
  const afterSep =
    sepIdx !== -1
      ? sepIdx + sepRow.length
      : tableHeaderIdx + '| Hash | Date | Subject | Status | Reason |'.length;

  const rows = [...triageState.entries()]
    .map(
      ([hash, e]) =>
        `| ${hash} | ${e.date || ''} | ${e.subject || ''} | ${e.status || 'pending'} | ${e.reason || ''} |`,
    )
    .join('\n');

  const beforeTable = content.slice(0, afterSep);
  content = beforeTable + '\n' + rows + '\n';

  fs.writeFileSync(filePath, content, 'utf-8');
}

/**
 * Divergence tracking command — shows upstream drift and manages triage.
 *
 * Modes:
 *   Default: Show all upstream commits with triage status
 *   --refresh: Fetch from upstream first
 *   --init: Create DIVERGENCE.md with full upstream commit inventory
 *   --triage <hash> --status <status> --reason <text>: Update a commit's triage status
 *   --branch <name>: Track drift between base ref and branch
 *   --base <ref>: Base ref for branch mode (default: git.target_branch or main)
 *
 * @param {string} cwd
 * @param {{ refresh?: boolean, init?: boolean, triage?: string, status?: string, reason?: string, branch?: string, base?: string, remote?: string, remoteBranch?: string }} opts
 */
function cmdDivergence(cwd, opts) {
  const { divergence: divergencePath } = planningPaths(cwd);

  // ── Branch mode: track drift between base and branch ──────────────────────
  if (opts.branch) {
    const config = loadConfig(cwd);
    const base = opts.base || config.git?.target_branch || 'main';
    const sectionKey = `${base}..${opts.branch}`;

    // Verify branch exists
    try {
      execSync(`git rev-parse --verify ${opts.branch}`, { cwd, stdio: 'pipe' });
    } catch {
      error(`Branch '${opts.branch}' not found. Verify the branch name.`);
      return;
    }

    // ── Branch init mode ──
    if (opts.init) {
      let allCommits = [];
      try {
        const log = execSync(
          `git log ${sectionKey} --format="%H|%ad|%s" --date=short`,
          { cwd, encoding: 'utf8', stdio: 'pipe' },
        ).trim();
        if (log) {
          // Load existing section to detect already-triaged commits
          const existingTriage = parseDivergenceBranchSection(
            divergencePath,
            sectionKey,
          );

          allCommits = log.split('\n').map((line) => {
            const [hash, date, ...subjectParts] = line.split('|');
            const subject = subjectParts.join('|').substring(0, 80);
            const shortHash = hash.substring(0, 7);
            const classification = classifyCommit(subject);
            const prNumber = extractPrNumber(subject);

            // Check if already triaged
            const existing = existingTriage.get(shortHash);
            if (existing) {
              return {
                hash: shortHash,
                date,
                subject,
                classification,
                status: existing.status,
                reason: existing.reason,
              };
            }

            // Check for PR number or message match against existing triaged items
            let matchStatus = 'pending';
            let matchReason = '';
            if (prNumber) {
              for (const [triHash, triEntry] of existingTriage) {
                if (
                  extractPrNumber(triEntry.subject) === prNumber &&
                  triEntry.status !== 'pending'
                ) {
                  matchStatus = 'already-covered';
                  matchReason = `Matches PR #${prNumber} (${triHash})`;
                  break;
                }
              }
            }
            if (matchStatus === 'pending') {
              const normalized = normalizeForMatch(subject);
              for (const [triHash, triEntry] of existingTriage) {
                if (
                  normalizeForMatch(triEntry.subject) === normalized &&
                  triEntry.status !== 'pending'
                ) {
                  matchStatus = 'already-covered';
                  matchReason = `Message matches ${triHash}`;
                  break;
                }
              }
            }

            return {
              hash: shortHash,
              date,
              subject,
              classification,
              status: matchStatus,
              reason: matchReason,
            };
          });

          // Sort by priority: fix > feat > other > unknown
          allCommits.sort(
            (a, b) =>
              priorityOrder(a.classification) - priorityOrder(b.classification),
          );
        }
      } catch {}

      writeDivergenceBranchSection(divergencePath, sectionKey, allCommits);
      output(
        {
          status: 'initialized',
          section: sectionKey,
          commits: allCommits.length,
        },
        `Initialized branch section '${sectionKey}' with ${allCommits.length} commits`,
      );
      return;
    }

    // ── Branch triage mode ──
    if (opts.triage) {
      const hash = opts.triage;
      const status = opts.status;
      const reason = opts.reason || '';

      if (!VALID_TRIAGE_STATES.includes(status)) {
        error(
          `Invalid status: ${status}. Must be one of: ${VALID_TRIAGE_STATES.join(', ')}`,
        );
        return;
      }
      if (
        ['skipped', 'deferred', 'needs-adaptation', 'adapted'].includes(
          status,
        ) &&
        !reason
      ) {
        error(
          `Reason required for ${status} status. Use --reason "your rationale"`,
        );
        return;
      }

      const triageState = parseDivergenceBranchSection(
        divergencePath,
        sectionKey,
      );
      let entry = triageState.get(hash);
      if (!entry) {
        try {
          const info = execSync(
            `git log --format="%ad|%s" --date=short -1 ${hash}`,
            { cwd, encoding: 'utf8', stdio: 'pipe' },
          ).trim();
          const [date, ...subjectParts] = info.split('|');
          entry = {
            date: date || '',
            subject: subjectParts.join('|').substring(0, 80),
          };
        } catch {
          entry = { date: '', subject: '' };
        }
      }

      triageState.set(hash, { ...entry, status, reason });
      // Rewrite section
      const commits = [...triageState.entries()].map(([h, e]) => ({
        hash: h,
        date: e.date || '',
        subject: e.subject || '',
        classification: classifyCommit(e.subject || ''),
        status: e.status || 'pending',
        reason: e.reason || '',
      }));
      writeDivergenceBranchSection(divergencePath, sectionKey, commits);
      output(
        { status: 'updated', hash, new_status: status, section: sectionKey },
        `Updated ${hash} in ${sectionKey}: ${status}${reason ? ' — ' + reason : ''}`,
      );
      return;
    }

    // ── Branch show mode (default) ──
    const triageState = parseDivergenceBranchSection(
      divergencePath,
      sectionKey,
    );
    let commits = [];
    try {
      const log = execSync(
        `git log ${sectionKey} --format="%H|%ad|%s" --date=short`,
        { cwd, encoding: 'utf8', stdio: 'pipe' },
      ).trim();
      if (log) {
        commits = log.split('\n').map((line) => {
          const [hash, date, ...subjectParts] = line.split('|');
          const subject = subjectParts.join('|').substring(0, 80);
          const shortHash = hash.substring(0, 7);
          const existing = triageState.get(shortHash);
          const classification = classifyCommit(subject);
          return {
            hash: shortHash,
            full_hash: hash,
            date: date || '',
            subject,
            classification,
            status: existing ? existing.status : 'pending',
            reason: existing ? existing.reason : '',
          };
        });
        // Sort by priority
        commits.sort(
          (a, b) =>
            priorityOrder(a.classification) - priorityOrder(b.classification),
        );
      }
    } catch {}

    const pending = commits.filter((c) => c.status === 'pending').length;
    const summaryText = `Branch divergence (${sectionKey}): ${pending} pending of ${commits.length} total`;
    output(
      {
        status: 'ok',
        section: sectionKey,
        base,
        branch: opts.branch,
        commits,
        summary: {
          pending,
          total: commits.length,
          by_classification: {
            fix: commits.filter((c) => c.classification === 'fix').length,
            feat: commits.filter((c) => c.classification === 'feat').length,
            other: commits.filter((c) => c.classification === 'other').length,
            unknown: commits.filter((c) => c.classification === 'unknown')
              .length,
          },
        },
      },
      summaryText,
    );
    return;
  }

  // Check upstream remote exists
  const remoteName = opts.remote || 'upstream';
  const trackingRef = `${remoteName}/${opts.remoteBranch || 'main'}`;
  let upstreamUrl = null;
  try {
    upstreamUrl = execSync(`git remote get-url ${remoteName}`, {
      cwd,
      encoding: 'utf8',
      stdio: 'pipe',
    }).trim();
  } catch {}

  if (!upstreamUrl) {
    output(
      { status: 'no_upstream', commits: [] },
      `No '${remoteName}' remote found. Add one with: git remote add ${remoteName} <url>`,
    );
    return;
  }

  // Optionally fetch from upstream
  if (opts.refresh) {
    try {
      execSync(`git fetch ${remoteName}`, {
        cwd,
        stdio: 'pipe',
        timeout: 30000,
      });
    } catch {
      // Fetch failed (network? auth?) — continue with cached refs
    }
  }

  // ── Init mode: create DIVERGENCE.md with current upstream state ──────────
  if (opts.init) {
    let mergeBase = '';
    try {
      mergeBase = execSync(`git merge-base HEAD ${trackingRef}`, {
        cwd,
        encoding: 'utf8',
        stdio: 'pipe',
      }).trim();
    } catch {}

    const range = mergeBase ? `${mergeBase}..${trackingRef}` : trackingRef;
    let allCommits = [];
    try {
      const log = execSync(
        `git log ${range} --format="%H|%ad|%s" --date=short`,
        { cwd, encoding: 'utf8', stdio: 'pipe' },
      ).trim();
      if (log) {
        allCommits = log.split('\n').map((line) => {
          const [hash, date, ...subjectParts] = line.split('|');
          return {
            hash: hash.substring(0, 7),
            date: date || '',
            subject: subjectParts.join('|').substring(0, 80),
            status: 'pending',
            reason: '',
          };
        });
      }
    } catch {}

    writeDivergenceFile(divergencePath, upstreamUrl, allCommits, remoteName);
    output(
      { status: 'initialized', commits: allCommits.length },
      `Initialized DIVERGENCE.md with ${allCommits.length} upstream commits`,
    );
    return;
  }

  // ── Triage mode: update a specific commit's status ────────────────────────
  if (opts.triage) {
    const hash = opts.triage;
    const status = opts.status;
    const reason = opts.reason || '';

    if (!VALID_TRIAGE_STATES.includes(status)) {
      error(
        `Invalid status: ${status}. Must be one of: ${VALID_TRIAGE_STATES.join(', ')}`,
      );
      return;
    }
    if (['skipped', 'deferred', 'adapted'].includes(status) && !reason) {
      error(
        `Reason required for ${status} status. Use --reason "your rationale"`,
      );
      return;
    }

    const triageState = parseDivergenceFile(divergencePath);

    // Look up existing entry or fetch from git log
    let entry = triageState.get(hash);
    if (!entry) {
      try {
        const info = execSync(
          `git log --format="%ad|%s" --date=short -1 ${hash}`,
          { cwd, encoding: 'utf8', stdio: 'pipe' },
        ).trim();
        const [date, ...subjectParts] = info.split('|');
        entry = {
          date: date || '',
          subject: subjectParts.join('|').substring(0, 80),
        };
      } catch {
        entry = { date: '', subject: '' };
      }
    }

    triageState.set(hash, { ...entry, status, reason });
    rewriteDivergenceTable(divergencePath, triageState);
    output(
      { status: 'updated', hash, new_status: status },
      `Updated ${hash}: ${status}${reason ? ' — ' + reason : ''}`,
    );
    return;
  }

  // ── Default mode: show divergence status ─────────────────────────────────
  const triageState = parseDivergenceFile(divergencePath);

  let commits = [];
  try {
    const log = execSync(
      `git log HEAD..${trackingRef} --format="%H|%ad|%s" --date=short`,
      { cwd, encoding: 'utf8', stdio: 'pipe' },
    ).trim();
    if (log) {
      commits = log.split('\n').map((line) => {
        const [hash, date, ...subjectParts] = line.split('|');
        const subject = subjectParts.join('|').substring(0, 80);
        const shortHash = hash.substring(0, 7);
        const existing = triageState.get(shortHash) || triageState.get(hash);
        return {
          hash: shortHash,
          full_hash: hash,
          date: date || '',
          subject,
          status: existing ? existing.status : 'pending',
          reason: existing ? existing.reason : '',
        };
      });
    }
  } catch {}

  // Include triage entries for commits already picked (no longer in HEAD..upstream/main)
  const logHashes = new Set(commits.map((c) => c.hash));
  for (const [hash, entry] of triageState) {
    if (!logHashes.has(hash) && entry.status !== 'pending') {
      commits.push({
        hash,
        full_hash: '',
        date: entry.date || '',
        subject: entry.subject || '',
        status: entry.status,
        reason: entry.reason,
      });
    }
  }

  const pending = commits.filter((c) => c.status === 'pending').length;
  const picked = commits.filter((c) => c.status === 'picked').length;
  const skipped = commits.filter((c) => c.status === 'skipped').length;
  const deferred = commits.filter((c) => c.status === 'deferred').length;

  const summaryText = `Upstream divergence: ${pending} pending, ${picked} picked, ${skipped} skipped, ${deferred} deferred (${commits.length} total)`;
  output(
    {
      status: 'ok',
      upstream: upstreamUrl,
      commits,
      summary: { pending, picked, skipped, deferred, total: commits.length },
    },
    summaryText,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Ping-pong oscillation detection
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Parse output from `git log --format="%H|%ae|%s" --name-only` into an array
 * of commit objects. Each entry has hash, author email, subject, and changed files.
 *
 * Git log --name-only format places a blank line between the commit header and
 * the file list, and another blank line between commits:
 *   HASH|AUTHOR|SUBJECT
 *
 *   file1.js
 *   file2.js
 *
 *   HASH2|AUTHOR2|SUBJECT2
 *   ...
 *
 * @param {string} logOutput - Raw git log output string
 * @returns {Array<{hash: string, author: string, subject: string, files: string[]}>}
 */
function parseCommitLog(logOutput) {
  if (!logOutput || !logOutput.trim()) return [];

  const commits = [];
  const lines = logOutput.split('\n');
  let currentCommit = null;

  for (const rawLine of lines) {
    const line = rawLine.trim();

    // Check if line looks like a commit header: "hash|author|subject"
    // Hash is 40 hex chars (full) or 7-12 chars (short), followed by pipe
    if (/^[0-9a-f]{7,}/.test(line) && line.includes('|')) {
      // Save previous commit
      if (currentCommit) {
        commits.push(currentCommit);
      }

      const pipeIdx = line.indexOf('|');
      const hash = line.slice(0, pipeIdx).trim();
      const rest = line.slice(pipeIdx + 1);
      const secondPipeIdx = rest.indexOf('|');

      if (secondPipeIdx === -1) {
        currentCommit = { hash, author: rest.trim(), subject: '', files: [] };
      } else {
        const author = rest.slice(0, secondPipeIdx).trim();
        const subject = rest.slice(secondPipeIdx + 1).trim();
        currentCommit = { hash, author, subject, files: [] };
      }
    } else if (line && currentCommit) {
      // Non-empty, non-header line while in a commit: it's a file path
      currentCommit.files.push(line);
    }
    // Empty lines are skipped (they're separators between header and file list)
  }

  // Don't forget the last commit
  if (currentCommit) {
    commits.push(currentCommit);
  }

  return commits;
}

/**
 * Detect oscillation patterns in a commit sequence.
 *
 * Oscillation = different authors alternating modifications to the same file.
 * Single-author repeated modifications (iteration) do NOT trigger this.
 *
 * Escalation:
 *   - 2 alternations on same file by different authors → 'warning'
 *   - 3+ alternations on same file by different authors → 'halt'
 *
 * @param {Array<{hash: string, author: string, subject: string, files: string[]}>} commits
 * @returns {{ status: 'ok'|'warning'|'halt', reason: string, details: { oscillating_files: string[], agent_sequence: string[] } }}
 */
function detectOscillation(commits) {
  if (!commits || commits.length === 0) {
    return {
      status: 'ok',
      reason: 'No commits to analyze',
      details: { oscillating_files: [], agent_sequence: [] },
    };
  }

  // Build per-file author modification sequences
  // Map<filepath, Array<{author, hash, index}>>
  const fileHistory = new Map();

  for (let i = 0; i < commits.length; i++) {
    const commit = commits[i];
    for (const file of commit.files) {
      if (!fileHistory.has(file)) {
        fileHistory.set(file, []);
      }
      fileHistory
        .get(file)
        .push({ author: commit.author, hash: commit.hash, index: i });
    }
  }

  const oscillatingFiles = [];
  const agentSequenceEntries = [];
  let maxAlternations = 0;

  for (const [file, history] of fileHistory) {
    if (history.length < 2) continue;

    // Count author alternations: A→B or B→A counts as 1 alternation
    let alternations = 0;
    for (let j = 1; j < history.length; j++) {
      if (history[j].author !== history[j - 1].author) {
        alternations++;
      }
    }

    if (alternations >= 1) {
      // Check that there are at least 2 distinct authors involved
      const uniqueAuthors = new Set(history.map((h) => h.author));
      if (uniqueAuthors.size >= 2) {
        oscillatingFiles.push(file);
        agentSequenceEntries.push(
          `${file}: [${history.map((h) => h.author).join(' → ')}]`,
        );
        if (alternations > maxAlternations) {
          maxAlternations = alternations;
        }
      }
    }
  }

  if (oscillatingFiles.length === 0) {
    return {
      status: 'ok',
      reason: 'No oscillation detected',
      details: { oscillating_files: [], agent_sequence: [] },
    };
  }

  // Escalation: >=2 alternations = halt, 1 alternation = warning
  // A-B = 1 alternation = warning
  // A-B-A = 2 alternations = halt
  const status = maxAlternations >= 2 ? 'halt' : 'warning';
  const reason =
    status === 'halt'
      ? `Oscillation halted: ${oscillatingFiles.length} file(s) modified 3+ times by alternating agents`
      : `Oscillation warning: ${oscillatingFiles.length} file(s) modified by alternating agents`;

  return {
    status,
    reason,
    details: {
      oscillating_files: oscillatingFiles,
      agent_sequence: agentSequenceEntries,
    },
  };
}

/**
 * CLI command: Detect ping-pong agent oscillation in recent commit history.
 *
 * @param {string} cwd - Working directory
 * @param {string[]} args - CLI args (supports --window N)
 */
function cmdPingpongCheck(cwd, args) {
  const windowIdx = args.indexOf('--window');
  const window =
    windowIdx !== -1 ? parseInt(args[windowIdx + 1], 10) || 20 : 20;

  const result = execGit(cwd, [
    'log',
    `--format=%H|%ae|%s`,
    '--name-only',
    `-${window}`,
    '--',
    '.',
  ]);

  if (result.exitCode !== 0 || !result.stdout || !result.stdout.trim()) {
    const response = {
      status: 'ok',
      reason: 'no git history',
      details: { oscillating_files: [], agent_sequence: [] },
    };
    output(response, 'ok');
    return;
  }

  const commits = parseCommitLog(result.stdout);
  const detection = detectOscillation(commits);

  output(detection, detection.status);
}

/**
 * Detect breakout: executor modified files not declared in plan's files_modified.
 *
 * Severity tiers:
 *   - Informational: 1 unexpected file in same directory as a declared file (no output)
 *   - Warning: 1-3 unexpected files across different directories
 *   - Halt: 4+ unexpected files across different directories
 *
 * Always-allowed paths (.planning/, .claude/, package-lock.json) are skipped.
 * Test files paired with declared implementation files are treated as informational.
 *
 * @param {Array<{hash: string, author: string, subject: string, files: string[]}>} commits
 * @param {string[]} declaredFiles - files_modified from plan frontmatter
 * @returns {{ status: 'ok'|'warning'|'halt', reason: string, details: { unexpected_files: Array<{file: string, commit: string, tier: string}> } }}
 */
function detectBreakout(commits, declaredFiles) {
  if (!declaredFiles || declaredFiles.length === 0) {
    return {
      status: 'ok',
      reason: 'No declared files to check',
      details: { unexpected_files: [] },
    };
  }
  if (!commits || commits.length === 0) {
    return {
      status: 'ok',
      reason: 'No commits to analyze',
      details: { unexpected_files: [] },
    };
  }

  // Normalize: strip leading ./ and use path.normalize
  const normalize = (f) => path.normalize(f).replace(/^\.[\\/]/, '');
  const declared = new Set(declaredFiles.map(normalize));

  // Always-allowed path prefixes (GSD internal artifacts)
  const alwaysAllowedPrefixes = [
    '.planning' + path.sep,
    '.claude' + path.sep,
    '.planning/',
    '.claude/',
  ];
  // Always-allowed exact files
  const alwaysAllowedFiles = new Set(['package-lock.json']);

  // Check if a file is a test companion of a declared file
  const isTestPair = (file) => {
    const base = path.basename(file);
    // Match patterns: foo.test.js, foo.spec.js
    const testMatch = base.match(/^(.+?)\.(test|spec)\.[^.]+$/);
    const inTestsDir = /(?:^|[\\/])tests[\\/]/.test(file);
    const isTestFile = testMatch || inTestsDir;
    if (!isTestFile) return false;
    // Determine the base stem
    let stem;
    if (testMatch) {
      stem = testMatch[1];
    } else {
      // In tests/ directory: use the file basename without extension
      stem = base.replace(/\.[^.]+$/, '');
    }
    // Check if any declared file shares the same base name stem
    for (const d of declared) {
      const dBase = path.basename(d);
      const dStem = dBase.replace(/\.[^.]+$/, '');
      if (dStem === stem) return true;
    }
    return false;
  };

  // Check if a file's parent directory shares the same leaf name as any declared file's parent
  const isSiblingDir = (file) => {
    const fileLeaf = path.basename(path.dirname(file));
    if (!fileLeaf || fileLeaf === '.') return false;
    for (const d of declared) {
      const declaredLeaf = path.basename(path.dirname(d));
      if (declaredLeaf === fileLeaf) return true;
    }
    return false;
  };

  const unexpected = [];
  const seen = new Set(); // deduplicate across commits

  for (const commit of commits) {
    for (const rawFile of commit.files) {
      const file = normalize(rawFile);
      const key = `${file}:${commit.hash}`;
      if (seen.has(key)) continue;
      seen.add(key);

      // Skip always-allowed paths
      if (alwaysAllowedPrefixes.some((p) => file.startsWith(p))) continue;
      if (alwaysAllowedFiles.has(file)) continue;

      // Skip declared files
      if (declared.has(file)) continue;

      // Check same-directory proximity and test pairing
      const fileDir = path.dirname(file);
      const inDeclaredDir = [...declared].some(
        (d) => path.dirname(d) === fileDir,
      );
      const paired = isTestPair(file);

      const tier =
        inDeclaredDir || paired || isSiblingDir(file) ? 'info' : 'warning';
      unexpected.push({ file, commit: commit.hash, tier });
    }
  }

  const warnings = unexpected.filter((u) => u.tier === 'warning');

  if (unexpected.length === 0) {
    return {
      status: 'ok',
      reason: 'All committed files within declared scope',
      details: { unexpected_files: [] },
    };
  }

  if (warnings.length === 0) {
    // Only informational tier — no output needed
    return {
      status: 'ok',
      reason:
        'Unexpected files only in same directory as declared files (informational)',
      details: { unexpected_files: unexpected },
    };
  }

  if (warnings.length >= 4) {
    return {
      status: 'halt',
      reason: `Breakout halt: ${warnings.length} file(s) modified outside declared scope across different directories`,
      details: { unexpected_files: unexpected },
    };
  }

  return {
    status: 'warning',
    reason: `Breakout warning: ${warnings.length} file(s) modified outside declared scope`,
    details: { unexpected_files: unexpected },
  };
}

/**
 * CLI command: Detect breakout — executor files outside declared plan scope.
 *
 * @param {string} cwd - Working directory
 * @param {string[]} args - CLI args: --plan {id} --declared-files f1,f2,f3
 */
function cmdBreakoutCheck(cwd, args) {
  const planIdx = args.indexOf('--plan');
  const planId = planIdx !== -1 ? args[planIdx + 1] : null;
  const filesIdx = args.indexOf('--declared-files');
  const filesArg = filesIdx !== -1 ? args[filesIdx + 1] : '';

  if (!planId) {
    const response = {
      status: 'ok',
      reason: 'No --plan specified',
      details: { unexpected_files: [] },
    };
    output(response, 'ok');
    return;
  }

  const declaredFiles = filesArg
    ? filesArg
        .split(',')
        .map((f) => f.trim())
        .filter(Boolean)
    : [];

  // Query git log for commits matching this plan
  const result = execGit(cwd, [
    'log',
    '--format=%H|%ae|%s',
    '--name-only',
    '--grep',
    planId,
    '-30',
    '--',
    '.',
  ]);

  if (result.exitCode !== 0 || !result.stdout || !result.stdout.trim()) {
    const response = {
      status: 'ok',
      reason: 'No matching commits found',
      details: { unexpected_files: [] },
    };
    output(response, 'ok');
    return;
  }

  const commits = parseCommitLog(result.stdout);
  const detection = detectBreakout(commits, declaredFiles);

  output(detection, detection.status);
}

function cmdGenerateAllowlist(cwd, platform = process.platform) {
  // 1. Load static template as baseline
  const templatePath = path.join(
    __dirname,
    '..',
    '..',
    'templates',
    'settings-sandbox.json',
  );
  let template;
  try {
    template = JSON.parse(fs.readFileSync(templatePath, 'utf8'));
  } catch (e) {
    template = {
      sandbox: { enabled: true, autoAllowBashIfSandboxed: true },
      permissions: { allow: [] },
    };
  }

  // 2. Strip bare + canonical Read/Edit/Write from template — we append
  //    the platform-appropriate form below, matching install.js behavior.
  //    Uses RW_FORMS (frozen Set) from allowlist.cjs — single source of truth for permission forms.
  const baseStatic = (template.permissions?.allow || []).filter(
    (e) => !RW_FORMS.has(e),
  );
  const staticEntries = new Set(baseStatic);

  // 3. Add platform-aware Read/Edit/Write forms
  for (const e of getReadEditWriteAllowRules(platform)) staticEntries.add(e);

  // 4. Dynamic CLI entries (platform detection via which + config-derived)
  const dynamicEntries = new Set();
  const platformCLIs = ['gh', 'glab', 'fj', 'tea'];
  for (const cli of platformCLIs) {
    try {
      execSync(`which ${cli}`, { stdio: 'ignore', timeout: 2000 });
      for (const p of getPlatformCliPatterns(cli)) dynamicEntries.add(p);
    } catch {
      // CLI not installed — skip
    }
  }

  // Read config for any platform-specific settings
  const configPath = planningPaths(cwd).config;
  try {
    if (fs.existsSync(configPath)) {
      const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      const platformName = config.git?.platform;
      if (platformName && PLATFORM_TO_CLI[platformName]) {
        for (const p of getPlatformCliPatterns(PLATFORM_TO_CLI[platformName])) {
          dynamicEntries.add(p);
        }
      }
    }
  } catch {}

  // 5. Merge static + dynamic, sort for consistency
  const allEntries = [...new Set([...staticEntries, ...dynamicEntries])].sort();

  // 6. Build output JSON
  const result = {
    sandbox: template.sandbox || {
      enabled: true,
      autoAllowBashIfSandboxed: true,
    },
    permissions: { allow: allEntries },
  };

  output(result);
}

/**
 * Detect the test command for a single directory.
 *
 * Checks for common test infrastructure files in order of priority.
 * Does NOT check .planning/config.json — caller handles config overrides.
 *
 * @param {string} dir - Absolute path to directory to inspect
 * @returns {string|null} Test command string, or null if no infrastructure found
 */
function detectSingleDir(dir) {
  const pkgPath = path.join(dir, 'package.json');
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
    if (
      pkg.scripts &&
      pkg.scripts.test &&
      !pkg.scripts.test.includes('no test specified')
    ) {
      return 'npm test';
    }
  } catch {}
  if (
    fs.existsSync(path.join(dir, 'pytest.ini')) ||
    fs.existsSync(path.join(dir, 'pyproject.toml'))
  ) {
    return 'python -m pytest';
  }
  if (fs.existsSync(path.join(dir, 'Cargo.toml'))) {
    return 'cargo test';
  }
  if (fs.existsSync(path.join(dir, 'go.mod'))) {
    return 'go test ./...';
  }
  return null;
}

/**
 * Normalize a test_command config value to Array<{dir, command}>.
 *
 * - Array: passed through unchanged
 * - String: wrapped as [{dir: '.', command: value}]
 * - Other/missing: returns []
 *
 * @param {*} value - The verification.test_command config value
 * @returns {Array<{dir: string, command: string}>}
 */
function normalizeTestCommandConfig(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') return [{ dir: '.', command: value }];
  return [];
}

/**
 * Resolve workspace glob patterns to real relative directories.
 *
 * Supports pnpm-workspace.yaml and package.json#workspaces (array or Yarn Berry object).
 * Only handles simple glob patterns ending with /* (one level of wildcards).
 *
 * @param {string} cwd - Project root directory
 * @param {string} signal - Workspace signal: 'pnpm-workspace.yaml' or 'package.json#workspaces'
 * @returns {string[]} Array of relative directory paths (relative to cwd)
 */
function resolveWorkspacePaths(cwd, signal) {
  let patterns = [];
  if (signal === 'pnpm-workspace.yaml') {
    try {
      const content = fs.readFileSync(
        path.join(cwd, 'pnpm-workspace.yaml'),
        'utf-8',
      );
      let inPackages = false;
      for (const line of content.split('\n')) {
        if (/^packages\s*:/.test(line)) {
          inPackages = true;
          continue;
        }
        if (inPackages) {
          const m = line.match(/^\s+-\s+['"]?([^'"#\s]+)['"]?/);
          if (m) patterns.push(m[1]);
          else if (/^\S/.test(line) && !/^\s+-/.test(line)) break;
        }
      }
    } catch {}
  } else if (signal === 'package.json#workspaces') {
    try {
      const pkg = JSON.parse(
        fs.readFileSync(path.join(cwd, 'package.json'), 'utf-8'),
      );
      const ws = pkg.workspaces;
      patterns = Array.isArray(ws) ? ws : ws && ws.packages ? ws.packages : [];
    } catch {}
  }

  const dirs = [];
  for (const pattern of patterns) {
    if (pattern.endsWith('/*')) {
      const base = pattern.slice(0, -2);
      const absBase = path.join(cwd, base);
      try {
        const entries = fs.readdirSync(absBase, { withFileTypes: true });
        for (const e of entries) {
          if (e.isDirectory()) dirs.push(path.join(base, e.name));
        }
      } catch {}
    } else if (!pattern.startsWith('!')) {
      if (fs.existsSync(path.join(cwd, pattern))) dirs.push(pattern);
    }
  }
  return dirs;
}

/**
 * Discover the test command(s) for the project at `cwd`.
 *
 * Priority order:
 *   1. verification.test_command in .planning/config.json (user override)
 *      - String value → [{dir: '.', command: value}]
 *      - Array value → passed through unchanged
 *   2. Workspace topology detection:
 *      - standalone → scan cwd for test infrastructure
 *      - submodule  → scan each submodule_path listed in .gitmodules
 *      - monorepo   → resolve workspace glob patterns, scan each package dir
 *   3. Returns [] if no test infrastructure found
 *
 * @param {string} cwd - Project root directory
 * @returns {Array<{dir: string, command: string}>} Array of {dir, command} entries.
 *   dir is relative to cwd (e.g. '.', 'packages/core').
 *   Empty array means no test infrastructure detected anywhere.
 */
function discoverTestCommand(cwd) {
  // 1. Config override takes priority
  const configPath = planningPaths(cwd).config;
  try {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    const nested = config.verification;
    if (nested && nested.test_command) {
      return normalizeTestCommandConfig(nested.test_command);
    }
  } catch {}

  // 2. Detect workspace topology
  const { detectWorkspaceType } = require('./workspace.cjs');
  const ws = detectWorkspaceType(cwd);

  if (ws.type === 'standalone') {
    const cmd = detectSingleDir(cwd);
    return cmd ? [{ dir: '.', command: cmd }] : [];
  }

  if (ws.type === 'submodule') {
    return ws.submodule_paths
      .map((p) => ({ dir: p, command: detectSingleDir(path.join(cwd, p)) }))
      .filter((entry) => entry.command !== null);
  }

  if (ws.type === 'monorepo') {
    const pkgDirs = resolveWorkspacePaths(cwd, ws.signal);
    return pkgDirs
      .map((p) => ({ dir: p, command: detectSingleDir(path.join(cwd, p)) }))
      .filter((entry) => entry.command !== null);
  }

  return [];
}

/**
 * Archive phase directories from completed milestones into .planning/milestones/vX.Y-phases/.
 *
 * Algorithm:
 * 1. Read MILESTONES.md, extract completed milestone versions (- [x] **vX.Y...)
 * 2. Skip milestones that already have a vX.Y-phases/ archive directory
 * 3. For each unarchived milestone, read vX.Y-ROADMAP.md to extract phase numbers
 * 4. Cross-reference against .planning/phases/ directories that still exist
 * 5. dryRun: return preview; otherwise: mkdir + renameSync each phase dir
 */
function cmdCleanup(cwd, options) {
  const { dryRun } = options || {};
  const {
    milestonesFile: milestonesFilePath,
    milestones: milestonesDir,
    phases: phasesDir,
  } = planningPaths(cwd);

  // Read MILESTONES.md
  let milestonesContent;
  try {
    milestonesContent = fs.readFileSync(milestonesFilePath, 'utf-8');
  } catch {
    const result = {
      milestones: [],
      nothing_to_do: true,
      error: 'MILESTONES.md not found',
    };
    output(result, 'MILESTONES.md not found. Nothing to clean up.');
    return;
  }

  // Extract completed milestone versions: - [x] **vX.Y ... or table format | vX.Y | ... | Complete |
  const completedVersions = [];
  const listPattern = /^-\s*\[x\]\s*\*\*(v[\d.]+)[^*]*/gim;
  let m;
  while ((m = listPattern.exec(milestonesContent)) !== null) {
    completedVersions.push(m[1]);
  }
  // Table format fallback: | vX.Y | ... | Complete |
  const tablePattern = /^\|\s*(v[\d.]+)\s*\|[^|]+\|\s*Complete\s*\|/gim;
  while ((m = tablePattern.exec(milestonesContent)) !== null) {
    if (!completedVersions.includes(m[1])) completedVersions.push(m[1]);
  }

  if (completedVersions.length === 0) {
    const result = { milestones: [], nothing_to_do: true };
    output(result, 'No completed milestones found. Nothing to clean up.');
    return;
  }

  // Find which milestones already have phase archives
  const existingArchives = new Set();
  try {
    const entries = fs.readdirSync(milestonesDir, { withFileTypes: true });
    for (const e of entries) {
      const match = e.name.match(/^(v[\d.]+)-phases$/);
      if (match && e.isDirectory()) existingArchives.add(match[1]);
    }
  } catch {}

  // Get currently existing phase directories
  const existingPhaseDirs = new Set();
  try {
    const entries = fs.readdirSync(phasesDir, { withFileTypes: true });
    for (const e of entries) {
      if (e.isDirectory()) existingPhaseDirs.add(e.name);
    }
  } catch {}

  const milestoneResults = [];

  for (const version of completedVersions) {
    // Skip already-archived milestones
    if (existingArchives.has(version)) continue;

    const roadmapSnapshot = path.join(milestonesDir, `${version}-ROADMAP.md`);
    if (!fs.existsSync(roadmapSnapshot)) {
      milestoneResults.push({
        version,
        skipped: true,
        reason: 'ROADMAP snapshot not found',
      });
      continue;
    }

    // Extract phase numbers from the snapshot
    let snapshotContent;
    try {
      snapshotContent = fs.readFileSync(roadmapSnapshot, 'utf-8');
    } catch {
      milestoneResults.push({
        version,
        skipped: true,
        reason: 'Could not read ROADMAP snapshot',
      });
      continue;
    }

    const phasePattern = /#{2,4}\s*Phase\s+(\d+[A-Z]?(?:\.\d+)*)\s*:/gi;
    const phaseNums = new Set();
    let pm;
    while ((pm = phasePattern.exec(snapshotContent)) !== null) {
      phaseNums.add(pm[1]);
    }

    // Normalize phase numbers for comparison: "01" == "1", "1.1" == "1.1"
    // Build a set of normalized phase numbers from the ROADMAP snapshot
    const normalizedPhaseNums = new Set(
      [...phaseNums].map((n) => n.replace(/^0+(\d)/, '$1')),
    );

    // Match phase numbers to actual directories that still exist
    const phasesToArchive = [];
    for (const dir of [...existingPhaseDirs].sort()) {
      const dm = dir.match(/^(\d+[A-Z]?(?:\.\d+)*)-?/i);
      if (dm) {
        const normalized = dm[1].replace(/^0+(\d)/, '$1');
        if (normalizedPhaseNums.has(normalized)) {
          phasesToArchive.push(dir);
        }
      }
    }

    const destination = path.join(
      '.planning',
      'milestones',
      `${version}-phases`,
    );
    const nameLine = milestonesContent.match(
      new RegExp(
        `\\*\\*${version.replace('.', '\\.')}\\s*[—–-]?\\s*([^*]+)\\*\\*`,
      ),
    );
    const name = nameLine ? nameLine[1].trim() : version;

    milestoneResults.push({
      version,
      name,
      destination,
      phases_to_archive: phasesToArchive,
    });

    // If executing (not dry-run), do the move
    if (!dryRun && phasesToArchive.length > 0) {
      const destFullPath = path.join(milestonesDir, `${version}-phases`);
      fs.mkdirSync(destFullPath, { recursive: true });
      for (const dir of phasesToArchive) {
        fs.renameSync(path.join(phasesDir, dir), path.join(destFullPath, dir));
        existingPhaseDirs.delete(dir);
      }
    }
  }

  const nonSkipped = milestoneResults.filter((m) => !m.skipped);
  const hasWork = nonSkipped.some(
    (m) => m.phases_to_archive && m.phases_to_archive.length > 0,
  );
  const nothingToDo =
    milestoneResults.length === 0 || (!hasWork && nonSkipped.length === 0);

  const result = { milestones: milestoneResults, nothing_to_do: nothingToDo };

  if (dryRun) {
    let text = '## Cleanup Preview\n\n';
    if (nothingToDo) {
      text += 'All milestones already archived. Nothing to clean up.\n';
    } else {
      for (const entry of milestoneResults) {
        if (entry.skipped) {
          text += `### ${entry.version} — Skipped: ${entry.reason}\n\n`;
        } else {
          text += `### ${entry.version} — ${entry.name}\n`;
          text += `Phases to archive: ${entry.phases_to_archive.join(', ')}\n`;
          text += `Destination: ${entry.destination}/\n\n`;
        }
      }
    }
    output(result, text);
  } else {
    const total = milestoneResults
      .filter((m) => !m.skipped)
      .reduce(
        (sum, m) =>
          sum + (m.phases_to_archive ? m.phases_to_archive.length : 0),
        0,
      );
    const mCount = milestoneResults.filter(
      (m) =>
        !m.skipped && m.phases_to_archive && m.phases_to_archive.length > 0,
    ).length;
    output(
      result,
      `Archived ${total} phase directories from ${mCount} milestones.`,
    );
  }
}

// ─── Update command ───────────────────────────────────────────────────────────

/**
 * Detect GSD install location (local or global).
 * Returns { isLocal, installPath, installedVersion } or null if not found.
 *
 * @param {string} cwd - Working directory
 * @returns {{ isLocal: boolean, installPath: string, installedVersion: string } | null}
 */
function detectInstallLocation(cwd) {
  const homeDir = process.env.GSD_TEST_HOME || os.homedir();

  const localPath = path.join(cwd, '.claude', 'gsd-ng', 'VERSION');
  const globalPath = path.join(homeDir, '.claude', 'gsd-ng', 'VERSION');

  // Strips build metadata (semver §10) so compareSemVer sees a clean version.
  const VERSION_RE = /^(\d+\.\d+\.\d+(?:-[\w.]+)?)/;

  // Check local first
  if (fs.existsSync(localPath)) {
    try {
      const localVersion = fs.readFileSync(localPath, 'utf-8').trim();
      const m = localVersion.match(VERSION_RE);
      if (m) {
        // Only treat as LOCAL if local path differs from global path
        // (prevents misdetection when cwd === homeDir)
        const localDir = path.dirname(localPath);
        const globalDir = path.dirname(globalPath);
        if (localDir !== globalDir) {
          return {
            isLocal: true,
            installPath: localDir,
            installedVersion: m[1],
          };
        }
      }
    } catch {}
  }

  // Fall back to global
  if (fs.existsSync(globalPath)) {
    try {
      const globalVersion = fs.readFileSync(globalPath, 'utf-8').trim();
      const m = globalVersion.match(VERSION_RE);
      if (m) {
        return {
          isLocal: false,
          installPath: path.dirname(globalPath),
          installedVersion: m[1],
        };
      }
    } catch {}
  }

  return null;
}

/**
 * Check for GSD updates and optionally execute the update.
 *
 * @param {string} cwd - Working directory
 * @param {{ dryRun: boolean, local: boolean, global: boolean }} options
 * @param {{ latestVersion: string|null, updateSource: string|null } | null} _testOverrides - Test injection
 */
/**
 * Internal helper: download GitHub release tarball, extract it, and run
 * the bundled install.js. Extracted from cmdUpdate as a separate function
 * so tests can inject a fake `execUpdate` via `_testOverrides.execUpdate`.
 *
 * @param {{ version: string, installFlag: string, runtime: string, url: string }} args
 * @returns {{ success: boolean, error?: string }}
 */
/* c8 ignore start — network+filesystem ops: download tarball, extract via tar binary, exec install.js. Tested via execUpdate seam injection (cmdUpdate — execUpdate seam describe block). */
function _downloadAndInstallTarball(args) {
  const { installFlag, url: tarballUrl, runtime } = args;
  const tmpExtractDir = path.join(os.tmpdir(), 'gsd-update-' + Date.now());
  const tarballPath = path.join(tmpExtractDir, 'gsd-ng.tar.gz');
  const extractDir = path.join(tmpExtractDir, 'extracted');

  try {
    fs.mkdirSync(tmpExtractDir, { recursive: true });
    fs.mkdirSync(extractDir, { recursive: true });

    // Download tarball
    const downloadScript = `
      const https = require('https');
      const http = require('http');
      const fs = require('fs');
      function download(url, dest, cb) {
        const mod = url.startsWith('https') ? https : http;
        const req = mod.get(url, { headers: { 'User-Agent': 'gsd-ng' }, timeout: 30000 }, function(res) {
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            res.destroy(); return download(res.headers.location, dest, cb);
          }
          if (res.statusCode !== 200) { res.destroy(); return cb(new Error('HTTP ' + res.statusCode)); }
          const file = fs.createWriteStream(dest);
          res.pipe(file);
          file.on('finish', function() { file.close(cb); });
          file.on('error', cb);
        });
        req.on('error', cb);
        req.setTimeout(30000, function() { req.destroy(new Error('download timeout')); });
      }
      download(process.argv[1], process.argv[2], function(err) {
        if (err) { process.stderr.write('Download failed: ' + err.message + '\\n'); process.exit(1); }
      });
    `;
    const dlResult = spawnSync(
      'node',
      ['-e', downloadScript, tarballUrl, tarballPath],
      {
        timeout: 60000,
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    if (dlResult.status !== 0) throw new Error('Download failed');

    // Extract tarball
    const tarResult = spawnSync('tar', ['xzf', tarballPath, '-C', extractDir], {
      stdio: 'pipe',
    });
    if (tarResult.status !== 0) throw new Error('Extract failed');

    // Run install.js
    const installResult = spawnSync(
      'node',
      [path.join(extractDir, 'bin', 'install.js'), installFlag, '--runtime', runtime],
      {
        stdio: 'inherit',
        timeout: 120000,
      },
    );
    if (installResult.status !== 0) throw new Error('Install failed');
  } catch (e) {
    try {
      fs.rmSync(tmpExtractDir, { recursive: true, force: true });
    } catch {}
    return { success: false, error: e.message || 'unknown error' };
  }
  try {
    fs.rmSync(tmpExtractDir, { recursive: true, force: true });
  } catch {}
  return { success: true };
}
/* c8 ignore stop */

function cmdUpdate(cwd, options, _testOverrides) {
  const { dryRun = false } = options || {};
  const homeDir = process.env.GSD_TEST_HOME || os.homedir();

  // Support subprocess testing via env var (used by runGsdTools tests)
  if (!_testOverrides && process.env.GSD_UPDATE_TEST_OVERRIDES) {
    try {
      _testOverrides = JSON.parse(process.env.GSD_UPDATE_TEST_OVERRIDES);
    } catch {}
  }
  const overrides = _testOverrides || {};

  // 1. Detect install location
  const installInfo = detectInstallLocation(cwd);
  if (!installInfo) {
    return output({
      status: 'unknown_version',
      message: 'No VERSION file found. Run npx gsd-ng@latest to install.',
    });
  }

  const { isLocal, installedVersion } = installInfo;
  const installed = installedVersion;

  const installedChannel = parseChannel(installed);

  // 2. Check latest version
  let latestVersion = null;
  let updateSource = null;

  if (overrides.latestVersion) {
    latestVersion = overrides.latestVersion;
    updateSource = overrides.updateSource || null;
  } else if (_testOverrides && !overrides.execNpmView) {
    // Test override present without an explicit execNpmView seam means "no
    // live network" — don't fall through to real `npm view`.
    latestVersion = null;
    updateSource = null;
  } else {
    /* c8 ignore start — network: `npm view` + GitHub Releases API. */
    const execNpmView =
      overrides.execNpmView ||
      ((cmd) =>
        execSync(cmd, {
          timeout: 15000,
          stdio: ['pipe', 'pipe', 'pipe'],
          encoding: 'utf-8',
        }));
    let npmVersion = null;
    if (installedChannel) {
      try {
        const v = execNpmView(`npm view gsd-ng dist-tags.${installedChannel}`)
          .toString()
          .trim();
        if (v && /^\d+\.\d+\.\d+/.test(v)) npmVersion = v;
      } catch {}
    }
    if (!npmVersion) {
      try {
        const v = execNpmView('npm view gsd-ng version').toString().trim();
        if (v && /^\d+\.\d+\.\d+/.test(v)) npmVersion = v;
      } catch {}
    }
    if (npmVersion) {
      latestVersion = npmVersion;
      updateSource = 'npm';
    }

    if (!latestVersion) {
      const githubScript = installedChannel
        ? `
        const https = require('https');
        const opts = {
          hostname: 'api.github.com',
          path: '/repos/chrisdevchroma/gsd-ng/releases?per_page=100',
          headers: { 'User-Agent': 'gsd-ng', 'Accept': 'application/vnd.github.v3+json' },
          timeout: 10000,
        };
        const channel = ${JSON.stringify(installedChannel)};
        const req = https.request(opts, function(res) {
          if (res.statusCode !== 200) { process.exit(1); }
          let d = '';
          res.on('data', function(c) { d += c; });
          res.on('end', function() {
            try {
              const r = JSON.parse(d);
              if (!Array.isArray(r)) { process.exit(1); }
              const tags = r
                .map(function(x) { return (x.tag_name || '').replace(/^v/, ''); })
                .filter(function(t) {
                  return t && t.indexOf('-' + channel) !== -1 && /^\\d+\\.\\d+\\.\\d+/.test(t);
                });
              if (tags.length === 0) { process.exit(0); }
              process.stdout.write(tags.join('\\n'));
            } catch(e) { process.exit(1); }
          });
        });
        req.on('error', function() { process.exit(1); });
        req.on('timeout', function() { req.destroy(); });
        req.end();
      `
        : `
        const https = require('https');
        const opts = {
          hostname: 'api.github.com',
          path: '/repos/chrisdevchroma/gsd-ng/releases/latest',
          headers: { 'User-Agent': 'gsd-ng', 'Accept': 'application/vnd.github.v3+json' },
          timeout: 10000,
        };
        const req = https.request(opts, function(res) {
          if (res.statusCode === 404) { process.exit(0); }
          if (res.statusCode !== 200) { process.exit(1); }
          let d = '';
          res.on('data', function(c) { d += c; });
          res.on('end', function() {
            try {
              const r = JSON.parse(d);
              if (r.prerelease) { process.exit(0); }
              const tag = (r.tag_name || '').replace(/^v/, '');
              if (tag) process.stdout.write(tag);
            } catch(e) { process.exit(1); }
          });
        });
        req.on('error', function() { process.exit(1); });
        req.on('timeout', function() { req.destroy(); });
        req.end();
      `;
      const githubResult = spawnSync('node', ['-e', githubScript], {
        timeout: 15000,
        stdio: ['pipe', 'pipe', 'pipe'],
        encoding: 'utf-8',
      });
      const stdout = (githubResult.stdout || '').toString().trim();
      if (stdout) {
        if (installedChannel) {
          const picked = selectLatestForChannel(
            stdout.split('\n').map((t) => t.trim()),
            installedChannel,
          );
          if (picked) {
            latestVersion = picked;
            updateSource = 'github';
          }
        } else if (/^\d+\.\d+\.\d+/.test(stdout)) {
          latestVersion = stdout;
          updateSource = 'github';
        }
      }
    }
    /* c8 ignore stop */
  }

  // If both sources unavailable
  if (!latestVersion) {
    return output({
      status: 'both_unavailable',
      message: 'Could not check for updates (npm and GitHub both unavailable).',
    });
  }

  // 3. Compare versions
  const cmp = compareSemVer(installed, latestVersion);
  if (cmp === 0) {
    return output({
      status: 'already_current',
      installed,
      latest: latestVersion,
    });
  }
  if (cmp > 0) {
    return output({
      status: 'ahead',
      installed,
      latest: latestVersion,
    });
  }

  // 4. Dry-run: return info without executing
  if (dryRun) {
    return output({
      status: 'update_available',
      installed,
      latest: latestVersion,
      update_source: updateSource,
      install_type: isLocal ? 'local' : 'global',
      update_available: true,
    });
  }

  // 5. Execute update
  const installFlag = isLocal ? '--local' : '--global';

  // Dry-execute short-circuit: returns install_command without shelling out.
  // Honors both `_testOverrides.dryExecute` (preferred) and the legacy
  // GSD_TEST_DRY_EXECUTE env hook for back-compat with subprocess tests.
  const installTarget = `gsd-ng@${installedChannel || 'latest'}`;
  const runtime = getEngineRuntime();

  if (overrides.dryExecute || process.env.GSD_TEST_DRY_EXECUTE) {
    let installCommand;
    if (updateSource === 'npm') {
      installCommand = `npx -y ${installTarget} ${installFlag} --runtime ${runtime}`;
    } else {
      installCommand = `node install.js ${installFlag} --runtime ${runtime} (github tarball download)`;
    }
    return output({
      status: 'updated',
      from: installed,
      to: latestVersion,
      source: updateSource,
      install_command: installCommand,
    });
  }

  if (updateSource === 'npm') {
    /* c8 ignore start — network: `npx -y gsd-ng@<channel>` shells out to npm. Exercised via dryExecute/GSD_TEST_DRY_EXECUTE short-circuit above (cmdUpdate dry-execute returns updated with install_command (npm) test). */
    try {
      execSync(`npx -y ${installTarget} ${installFlag} --runtime ${runtime}`, {
        stdio: 'inherit',
        timeout: 120000,
      });
    } catch (e) {
      return output({
        status: 'error',
        message: 'Update failed: ' + (e.message || 'unknown error'),
      });
    }
    /* c8 ignore stop */
  } else {
    // GitHub path: download tarball, extract, run install.js (delegated to
    // _downloadAndInstallTarball so tests can inject a fake execUpdate).
    const exec = overrides.execUpdate || _downloadAndInstallTarball;
    const execResult = exec({
      version: latestVersion,
      installFlag,
      runtime,
      url: `https://github.com/chrisdevchroma/gsd-ng/releases/download/${latestVersion}/gsd-ng.tar.gz`,
    });
    if (execResult && execResult.success === false) {
      return output({
        status: 'error',
        message: 'Update failed: ' + (execResult.error || 'unknown error'),
      });
    }
  }

  // 6. Clear update cache
  for (const cacheBase of [cwd, homeDir]) {
    try {
      fs.unlinkSync(
        path.join(cacheBase, '.claude', 'cache', 'gsd-update-check.json'),
      );
    } catch {}
  }

  return output({
    status: 'updated',
    from: installed,
    to: latestVersion,
    source: updateSource,
  });
}

module.exports = {
  cmdGenerateSlug,
  cmdCurrentTimestamp,
  cmdListTodos,
  cmdVerifyPathExists,
  cmdHistoryDigest,
  cmdResolveModel,
  cmdResolveEffort,
  applyCommitFormat,
  appendIssueTrailers,
  cmdCommit,
  cmdSummaryExtract,
  cmdWebsearch,
  cmdProgressRender,
  parseDuration,
  isRecurringDue,
  cmdTodoComplete,
  cmdTodoListByPhase,
  cmdTodoScanPhaseLinked,
  cmdRecurringDue,
  cmdScaffold,
  cmdStats,
  cmdDetectPlatform,
  cmdSquash,
  categorizeCommitType,
  deriveVersionBump,
  bumpVersion,
  appendBuildMetadata,
  generateChangelog,
  cmdVersionBump,
  cmdGenerateChangelog,
  ISSUE_COMMANDS,
  parseExternalRef,
  parseRequirementsExternalRefs,
  invokeIssueCli,
  applyVerifyLabel,
  buildSyncComment,
  buildImportComment,
  cmdIssueImport,
  syncSingleRef,
  cmdIssueSync,
  cmdIssueListRefs,
  cmdStalenessCheck,
  cmdGenerateAllowlist,
  cmdHelp,
  classifyCommit,
  priorityOrder,
  extractPrNumber,
  normalizeForMatch,
  parseDivergenceBranchSection,
  writeDivergenceBranchSection,
  VALID_TRIAGE_STATES,
  parseDivergenceFile,
  writeDivergenceFile,
  rewriteDivergenceTable,
  cmdDivergence,
  parseCommitLog,
  detectOscillation,
  cmdPingpongCheck,
  detectBreakout,
  cmdBreakoutCheck,
  detectSingleDir,
  normalizeTestCommandConfig,
  resolveWorkspacePaths,
  discoverTestCommand,
  cmdCleanup,
  detectInstallLocation,
  cmdUpdate,
  _downloadAndInstallTarball,
  compareSemVer,
};
