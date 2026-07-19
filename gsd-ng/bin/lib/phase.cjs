/**
 * Phase — Phase CRUD, query, and lifecycle operations
 */

const fs = require('fs');
const path = require('path');
const {
  escapeRegex,
  normalizePhaseName,
  comparePhaseNum,
  findPhaseInternal,
  getArchivedPhaseDirs,
  generateSlugInternal,
  getMilestonePhaseFilter,
  extractCurrentMilestone,
  replaceInCurrentMilestone,
  readVerificationStatus,
  getPhaseCompletionStatus,
  toPosixPath,
  output,
  error,
  planningPaths,
} = require('./core.cjs');
const { extractFrontmatter } = require('./frontmatter.cjs');
const { writeStateMd } = require('./state.cjs');

// VERIFICATION.md statuses that mean the verifier judged the phase goal NOT met.
// Requirement closure is withheld for these so the traceability table keeps
// telling the truth until the gaps are closed and the verifier re-runs.
// 'human_needed' is deliberately absent: it means every automated check passed
// and execute-phase only reaches phase-close after the human approves.
const FAILED_VERIFICATION_STATUSES = new Set(['gaps_found', 'halted']);

/**
 * Split a requirement-ID list into individual IDs.
 * Accepts comma-separated, space-separated, and bracket-wrapped forms.
 */
function parseRequirementIdList(raw) {
  return String(raw)
    .replace(/[[\]]/g, '')
    .split(/[,\s]+/)
    .map((r) => r.trim())
    .filter(Boolean);
}

/**
 * Read a frontmatter field that holds requirement IDs in any of the shapes the
 * templates produce: a YAML list, a bracketed inline list, or a bare string.
 * Anything else (a null field parses to an empty object) yields no IDs.
 */
function readRequirementIdField(value) {
  const ids = [];
  if (Array.isArray(value)) {
    for (const entry of value) ids.push(...parseRequirementIdList(entry));
  } else if (typeof value === 'string' && value) {
    ids.push(...parseRequirementIdList(value));
  }
  return ids;
}

/**
 * The identifier a plan document shares with its execution record, so the two
 * can be paired. Both the numbered and the bare filename forms reduce to the
 * same key.
 */
function planDocumentId(filename) {
  return filename.replace(/-?(?:PLAN|SUMMARY)\.md$/i, '');
}

/**
 * Read the requirement IDs the frontmatter of one file declares under `field`.
 * An unreadable file contributes nothing rather than aborting collection.
 */
function readFrontmatterRequirements(filePath, field) {
  try {
    const fm = extractFrontmatter(fs.readFileSync(filePath, 'utf-8'));
    return readRequirementIdField(fm && fm[field]);
  } catch {
    return [];
  }
}

/**
 * Collect every requirement ID a phase has actually delivered.
 *
 * Closure must key off delivered work, not declared intent. A PLAN's
 * `requirements:` frontmatter is a statement of what the plan set out to do; the
 * executor may deviate, and a plan may never run at all. The SUMMARY is the
 * record that a plan executed, and its `requirements-completed:` frontmatter is
 * the record of what landed. So each plan is resolved against its own summary:
 *
 *   - no paired summary → the plan has not completed and contributes nothing,
 *     matching how completion is judged everywhere else;
 *   - summary lists IDs → those are the delivered IDs, and any of them the plan
 *     never declared is returned as `undeclared` so the divergence surfaces
 *     instead of being silently accepted;
 *   - summary is silent (field absent, empty, or the file unreadable) → fall
 *     back to the plan's declaration. The field is a comparatively recent
 *     addition and its template default is an empty list, so failing closed
 *     here would strand every requirement of every phase written before it.
 *
 * The ROADMAP.md phase section's `**Requirements:**` line is a third source and
 * is unioned in, because a phase whose plans carry no `requirements:` would
 * otherwise never close anything — phase-close is the only place closure
 * happens. It is a phase-level declaration, though, not a delivery record, so it
 * is admitted only once every plan in the phase has a summary. Until then it is
 * intent covering work that has not all landed.
 *
 * @returns {{ids: string[], undeclared: string[]}}
 */
function collectPhaseRequirementIds(cwd, phaseNum, phaseInfo, roadmapContent) {
  const ids = [];
  const seen = new Set();
  const add = (id) => {
    if (!seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  };

  const phaseDir = path.join(cwd, phaseInfo.directory);

  // Source 1: ROADMAP.md phase section (scoped to avoid cross-phase matching),
  // admitted only for a phase whose every plan has been executed.
  if (roadmapContent && getPhaseCompletionStatus(phaseDir).isComplete) {
    const phaseEsc = escapeRegex(phaseNum);
    const phaseSectionMatch = extractCurrentMilestone(roadmapContent).match(
      new RegExp(
        `(#{2,4}\\s*Phase\\s+${phaseEsc}[:\\s][\\s\\S]*?)(?=#{2,4}\\s*Phase\\s+|$)`,
        'i',
      ),
    );
    const reqMatch = (phaseSectionMatch ? phaseSectionMatch[1] : '').match(
      /\*\*Requirements:\*\*\s*([^\n]+)/i,
    );
    if (reqMatch) parseRequirementIdList(reqMatch[1]).forEach(add);
  }

  // Source 2: each executed plan, read through the summary that records it.
  const summaryByPlanId = new Map();
  for (const summaryFile of phaseInfo.summaries || []) {
    summaryByPlanId.set(planDocumentId(summaryFile), summaryFile);
  }

  const undeclared = [];
  const undeclaredSeen = new Set();

  for (const planFile of phaseInfo.plans || []) {
    const summaryFile = summaryByPlanId.get(planDocumentId(planFile));
    if (!summaryFile) continue;

    const declaredIds = readFrontmatterRequirements(
      path.join(phaseDir, planFile),
      'requirements',
    );
    const deliveredIds = readFrontmatterRequirements(
      path.join(phaseDir, summaryFile),
      'requirements-completed',
    );

    if (deliveredIds.length === 0) {
      declaredIds.forEach(add);
      continue;
    }

    const declaredKeys = new Set(declaredIds.map((id) => id.toLowerCase()));
    for (const id of deliveredIds) {
      add(id);
      const key = id.toLowerCase();
      if (!declaredKeys.has(key) && !undeclaredSeen.has(key)) {
        undeclaredSeen.add(key);
        undeclared.push(id);
      }
    }
  }

  return { ids, undeclared };
}

// Status values the traceability table uses. Doubles as the signal that a
// pipe-delimited line IS a traceability row: the third column of a real row is
// always one of these, which no prose table in REQUIREMENTS.md reproduces.
const TRACEABILITY_STATUSES = new Set([
  'pending',
  'in progress',
  'complete',
  'blocked',
]);

// Statuses a phase-close is allowed to overwrite. 'Complete' is already closed
// and 'Blocked' is a human decision that closure must not silently revert.
const CLOSEABLE_STATUSES = /^(?:pending|in progress)$/i;

/**
 * Parse the traceability table out of REQUIREMENTS.md lines.
 *
 * Column order is Requirement | Phase | Status, matching the template. Rows are
 * identified by their status cell rather than by guessing at requirement-ID
 * syntax, so a project using any ID convention is read correctly.
 *
 * @param {string[]} lines  REQUIREMENTS.md split on newlines
 * @returns {Array<{lineIndex: number, id: string, phase: string, status: string}>}
 */
function parseTraceabilityRows(lines) {
  const rows = [];
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].trimStart().startsWith('|')) continue;
    // `| a | b | c |` splits to ['', ' a ', ' b ', ' c ', ''] — a three-column
    // row is the minimum shape, hence at least five parts.
    const cells = lines[i].split('|');
    if (cells.length < 5) continue;
    const id = cells[1].trim();
    const phase = cells[2].trim();
    const status = cells[3].trim();
    if (!id || !TRACEABILITY_STATUSES.has(status.toLowerCase())) continue;
    rows.push({ lineIndex: i, id, phase, status });
  }
  return rows;
}

/**
 * Extract the phase identifiers named by a traceability table's phase cell.
 *
 * The cell is free text and is written inconsistently across projects: zero-
 * padded, unpadded, decimal, letter-suffixed, and any of those optionally
 * prefixed with the word "phase". When the cell does label its numbers that
 * way, only the labelled ones count — so an incidental number in a
 * parenthetical cannot be mistaken for a phase reference.
 *
 * @param {string} cell  raw phase-column text
 * @returns {string[]}   phase identifiers, unnormalised
 */
function extractPhaseTokens(cell) {
  const text = String(cell);
  const labelled = text.match(/phases?\s*\d+[A-Za-z]?(?:\.\d+)*/gi);
  const source = labelled ? labelled.join(' ') : text;
  return source.match(/\d+[A-Za-z]?(?:\.\d+)*/g) || [];
}

/**
 * Does a traceability row's phase cell name the phase being closed?
 * Normalised comparison, so padded, unpadded and word-prefixed spellings of
 * one phase are all recognised as that phase.
 */
function phaseCellNamesPhase(cell, phaseNum) {
  return extractPhaseTokens(cell).some(
    (token) => comparePhaseNum(token, phaseNum) === 0,
  );
}

/**
 * Check off the requirement IDs this phase is entitled to close in
 * REQUIREMENTS.md.
 *
 * Entitlement is decided by the traceability table, not by the caller's list.
 * The candidate IDs arrive from collectPhaseRequirementIds, which unions the
 * roadmap section with plan frontmatter — and a plan may name an ID the table
 * attributes to a phase that has not run. Closing it there would make the table
 * assert that unstarted work is done, which is exactly the lie the table exists
 * to prevent. Each candidate therefore falls into one of three cases:
 *
 *   - the table gives it a row for this phase → close the row and tick the box;
 *   - the table gives it a row for some other phase → change nothing, and
 *     return it so the caller can report it. Skipping silently would strand the
 *     requirement: the declaring phase thinks it shipped it, the owning phase
 *     may never run, and nobody is told;
 *   - the table has no row for it at all → nothing can contradict the plan, so
 *     tick the box, and return it as unmapped. This is the case that keeps a
 *     project with no traceability table working.
 *
 * Idempotent: rows already Complete are not re-closed and the checkbox pattern
 * no longer matches, so a repeated phase-close leaves the file byte-identical.
 *
 * @param {string} cwd
 * @param {string[]} reqIds     candidate IDs collected for the phase
 * @param {string|number} phaseNum  the phase being closed
 * @returns {{updated: boolean, closed: string[],
 *            otherPhase: Array<{id: string, phase: string}>, unmapped: string[]}}
 */
function closePhaseRequirements(cwd, reqIds, phaseNum) {
  const result = { updated: false, closed: [], otherPhase: [], unmapped: [] };
  const reqPath = planningPaths(cwd).requirements;
  if (reqIds.length === 0 || !fs.existsSync(reqPath)) return result;

  const lines = fs.readFileSync(reqPath, 'utf-8').split('\n');
  const rows = parseTraceabilityRows(lines);
  const hasTable = rows.length > 0;

  const rowsById = new Map();
  for (const row of rows) {
    const key = row.id.toLowerCase();
    if (!rowsById.has(key)) rowsById.set(key, []);
    rowsById.get(key).push(row);
  }

  const rowsToClose = [];
  const idsToCheck = [];

  for (const reqId of reqIds) {
    const idRows = rowsById.get(reqId.toLowerCase()) || [];

    if (idRows.length === 0) {
      result.closed.push(reqId);
      idsToCheck.push(reqId);
      // Only meaningful as a discrepancy when there is a table to be absent
      // from — a project without one has nothing to be inconsistent with.
      if (hasTable) result.unmapped.push(reqId);
      continue;
    }

    const ours = idRows.filter((r) => phaseCellNamesPhase(r.phase, phaseNum));
    if (ours.length === 0) {
      result.otherPhase.push({
        id: reqId,
        phase: [...new Set(idRows.map((r) => r.phase))].join(', '),
      });
      continue;
    }

    result.closed.push(reqId);
    rowsToClose.push(...ours);

    // An ID split across several phases is only finished when no row still
    // attributes outstanding work elsewhere — tick the box then, and not before.
    const outstandingElsewhere = idRows.some(
      (r) => !ours.includes(r) && r.status.toLowerCase() !== 'complete',
    );
    if (!outstandingElsewhere) idsToCheck.push(reqId);
  }

  if (result.closed.length === 0) return result;

  for (const row of rowsToClose) {
    if (!CLOSEABLE_STATUSES.test(row.status)) continue;
    const cells = lines[row.lineIndex].split('|');
    // Replace the cell's text, preserving its padding so the table stays aligned.
    cells[3] = cells[3].replace(/\S.*\S|\S/, 'Complete');
    lines[row.lineIndex] = cells.join('|');
  }

  let reqContent = lines.join('\n');
  for (const reqId of idsToCheck) {
    // Checkbox: - [ ] **<id>** → - [x] **<id>**
    reqContent = reqContent.replace(
      new RegExp(
        `(-\\s*\\[)[ ](\\]\\s*\\*\\*${escapeRegex(reqId)}\\*\\*)`,
        'gi',
      ),
      '$1x$2',
    );
  }

  fs.writeFileSync(reqPath, reqContent, 'utf-8');
  result.updated = true;
  return result;
}

/**
 * Names of the summaries in a phase that were written after its VERIFICATION.md.
 *
 * A verification report judges the state of the work as it stood when the
 * verifier ran. Summaries that postdate it record work the report never saw, so
 * its verdict — pass or fail — no longer describes the phase. The usual way this
 * happens is gap-closure plans executed with the verifier turned off: nothing
 * rewrites the report, and a failing verdict then blocks closure indefinitely
 * with no indication that it is obsolete.
 *
 * This is evidence for a human, never a trigger for automatic behaviour.
 * Timestamps are weak evidence — a fresh clone or checkout rewrites every mtime
 * — and more importantly, age is not evidence that gaps were closed. Acting on
 * staleness would mean a failing gate expires on its own, which is the same as
 * having no gate. So the result is reported and nothing else.
 *
 * @returns {string[]} summary filenames newer than the report, oldest-first
 */
function summariesNewerThanVerification(phaseDir, summaries) {
  let verifiedAt;
  try {
    const verificationFile = fs
      .readdirSync(phaseDir)
      .find((f) => f.endsWith('-VERIFICATION.md') || f === 'VERIFICATION.md');
    if (!verificationFile) return [];
    verifiedAt = fs.statSync(path.join(phaseDir, verificationFile)).mtimeMs;
  } catch {
    // No readable report to compare against — nothing can be stale relative to it
    return [];
  }

  const newer = [];
  for (const summaryFile of summaries || []) {
    try {
      if (fs.statSync(path.join(phaseDir, summaryFile)).mtimeMs > verifiedAt) {
        newer.push(summaryFile);
      }
    } catch {
      // Summary vanished between listing and stat — nothing to compare
    }
  }
  return newer;
}

function cmdPhasesList(cwd, options) {
  const { phases: phasesDir } = planningPaths(cwd);
  const { type, phase, includeArchived } = options;

  // If no phases directory, return empty
  if (!fs.existsSync(phasesDir)) {
    if (type) {
      output({ files: [], count: 0 }, '');
    } else {
      output({ directories: [], count: 0 }, '');
    }
    return;
  }

  try {
    // Get all phase directories
    const entries = fs.readdirSync(phasesDir, { withFileTypes: true });
    let dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);

    // Include archived phases if requested
    if (includeArchived) {
      const archived = getArchivedPhaseDirs(cwd);
      for (const a of archived) {
        dirs.push(`${a.name} [${a.milestone}]`);
      }
    }

    // Sort numerically (handles integers, decimals, letter-suffix, hybrids)
    dirs.sort((a, b) => comparePhaseNum(a, b));

    // If filtering by phase number
    if (phase) {
      const normalized = normalizePhaseName(phase);
      const match = dirs.find((d) => d.startsWith(normalized));
      if (!match) {
        output(
          { files: [], count: 0, phase_dir: null, error: 'Phase not found' },
          '',
        );
        return;
      }
      dirs = [match];
    }

    // If listing files of a specific type
    if (type) {
      const files = [];
      for (const dir of dirs) {
        const dirPath = path.join(phasesDir, dir);
        const dirFiles = fs.readdirSync(dirPath);

        let filtered;
        if (type === 'plans') {
          filtered = dirFiles.filter(
            (f) => f.endsWith('-PLAN.md') || f === 'PLAN.md',
          );
        } else if (type === 'summaries') {
          filtered = dirFiles.filter(
            (f) => f.endsWith('-SUMMARY.md') || f === 'SUMMARY.md',
          );
        } else {
          filtered = dirFiles;
        }

        files.push(...filtered.sort());
      }

      const result = {
        files,
        count: files.length,
        phase_dir: phase ? dirs[0].replace(/^\d+(?:\.\d+)*-?/, '') : null,
      };
      output(result, files.join('\n'));
      return;
    }

    // Default: list directories
    output({ directories: dirs, count: dirs.length }, dirs.join('\n'));
  } catch (e) {
    error('Failed to list phases: ' + e.message);
  }
}

function cmdPhaseNextDecimal(cwd, basePhase) {
  const { phases: phasesDir } = planningPaths(cwd);
  const normalized = normalizePhaseName(basePhase);

  // Check if phases directory exists
  if (!fs.existsSync(phasesDir)) {
    output(
      {
        found: false,
        base_phase: normalized,
        next: `${normalized}.1`,
        existing: [],
      },

      `${normalized}.1`,
    );
    return;
  }

  try {
    const entries = fs.readdirSync(phasesDir, { withFileTypes: true });
    const dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);

    // Check if base phase exists
    const baseExists = dirs.some(
      (d) => d.startsWith(normalized + '-') || d === normalized,
    );

    // Find existing decimal phases for this base
    const decimalPattern = new RegExp(`^${normalized}\\.(\\d+)`);
    const existingDecimals = [];

    for (const dir of dirs) {
      const match = dir.match(decimalPattern);
      if (match) {
        existingDecimals.push(`${normalized}.${match[1]}`);
      }
    }

    // Sort numerically
    existingDecimals.sort((a, b) => comparePhaseNum(a, b));

    // Calculate next decimal
    let nextDecimal;
    if (existingDecimals.length === 0) {
      nextDecimal = `${normalized}.1`;
    } else {
      const lastDecimal = existingDecimals[existingDecimals.length - 1];
      const lastNum = parseInt(lastDecimal.split('.')[1], 10);
      nextDecimal = `${normalized}.${lastNum + 1}`;
    }

    output(
      {
        found: baseExists,
        base_phase: normalized,
        next: nextDecimal,
        existing: existingDecimals,
      },

      nextDecimal,
    );
  } catch (e) {
    error('Failed to calculate next decimal phase: ' + e.message);
  }
}

function cmdFindPhase(cwd, phase) {
  if (!phase) {
    error('phase identifier required');
  }

  const { phases: phasesDir } = planningPaths(cwd);
  const normalized = normalizePhaseName(phase);

  const notFound = {
    found: false,
    directory: null,
    phase_number: null,
    phase_name: null,
    plans: [],
    summaries: [],
  };

  try {
    const entries = fs.readdirSync(phasesDir, { withFileTypes: true });
    const dirs = entries
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort((a, b) => comparePhaseNum(a, b));

    const match = dirs.find((d) => d.startsWith(normalized));
    if (!match) {
      output(notFound, '');
      return;
    }

    const dirMatch = match.match(/^(\d+[A-Z]?(?:\.\d+)*)-?(.*)/i);
    const phaseNumber = dirMatch ? dirMatch[1] : normalized;
    const phaseName = dirMatch && dirMatch[2] ? dirMatch[2] : null;

    const phaseDir = path.join(phasesDir, match);
    const phaseFiles = fs.readdirSync(phaseDir);
    const plans = phaseFiles
      .filter((f) => f.endsWith('-PLAN.md') || f === 'PLAN.md')
      .sort();
    const summaries = phaseFiles
      .filter((f) => f.endsWith('-SUMMARY.md') || f === 'SUMMARY.md')
      .sort();

    const result = {
      found: true,
      directory: toPosixPath(path.join('.planning', 'phases', match)),
      phase_number: phaseNumber,
      phase_name: phaseName,
      plans,
      summaries,
    };

    output(result, result.directory);
  } catch {
    output(notFound, '');
  }
}

function extractObjective(content) {
  const m = content.match(/<objective>\s*\n?\s*(.+)/);
  return m ? m[1].trim() : null;
}

function cmdPhasePlanIndex(cwd, phase) {
  if (!phase) {
    error('phase required for phase-plan-index');
  }

  const { phases: phasesDir } = planningPaths(cwd);
  const normalized = normalizePhaseName(phase);

  // Find phase directory
  let phaseDir = null;
  let phaseDirName = null;
  try {
    const entries = fs.readdirSync(phasesDir, { withFileTypes: true });
    const dirs = entries
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort((a, b) => comparePhaseNum(a, b));
    const match = dirs.find((d) => d.startsWith(normalized));
    if (match) {
      phaseDir = path.join(phasesDir, match);
      phaseDirName = match;
    }
  } catch {
    // phases dir doesn't exist
  }

  if (!phaseDir) {
    output({
      phase: normalized,
      error: 'Phase not found',
      plans: [],
      waves: {},
      incomplete: [],
      has_checkpoints: false,
    });
    return;
  }

  // Get all files in phase directory
  const phaseFiles = fs.readdirSync(phaseDir);
  const planFiles = phaseFiles
    .filter((f) => f.endsWith('-PLAN.md') || f === 'PLAN.md')
    .sort();
  const summaryFiles = phaseFiles.filter(
    (f) => f.endsWith('-SUMMARY.md') || f === 'SUMMARY.md',
  );

  // Build set of plan IDs with summaries
  const completedPlanIds = new Set(
    summaryFiles.map((s) =>
      s.replace('-SUMMARY.md', '').replace('SUMMARY.md', ''),
    ),
  );

  const plans = [];
  const waves = {};
  const incomplete = [];
  let hasCheckpoints = false;

  for (const planFile of planFiles) {
    const planId = planFile.replace('-PLAN.md', '').replace('PLAN.md', '');
    const planPath = path.join(phaseDir, planFile);
    const content = fs.readFileSync(planPath, 'utf-8');
    const fm = extractFrontmatter(content);

    // Count tasks: XML <task> tags (canonical) or ## Task N markdown (legacy)
    const xmlTasks = content.match(/<task[\s>]/gi) || [];
    const mdTasks = content.match(/##\s*Task\s*\d+/gi) || [];
    const taskCount = xmlTasks.length || mdTasks.length;

    // Parse wave as integer
    const wave = parseInt(fm.wave, 10) || 1;

    // Parse autonomous (default true if not specified)
    let autonomous = true;
    if (fm.autonomous !== undefined) {
      autonomous = fm.autonomous === 'true' || fm.autonomous === true;
    }

    if (!autonomous) {
      hasCheckpoints = true;
    }

    // Parse files_modified (underscore is canonical; also accept hyphenated for compat)
    let filesModified = [];
    const fmFiles = fm['files_modified'] || fm['files-modified'];
    if (fmFiles) {
      filesModified = Array.isArray(fmFiles) ? fmFiles : [fmFiles];
    }

    const hasSummary = completedPlanIds.has(planId);
    if (!hasSummary) {
      incomplete.push(planId);
    }

    const plan = {
      id: planId,
      wave,
      autonomous,
      objective: extractObjective(content) || fm.objective || null,
      files_modified: filesModified,
      task_count: taskCount,
      has_summary: hasSummary,
    };

    plans.push(plan);

    // Group by wave
    const waveKey = String(wave);
    if (!waves[waveKey]) {
      waves[waveKey] = [];
    }
    waves[waveKey].push(planId);
  }

  const result = {
    phase: normalized,
    plans,
    waves,
    incomplete,
    has_checkpoints: hasCheckpoints,
    overlaps: detectFileOverlaps(plans),
  };

  output(result);
}

/**
 * Detect file overlaps between same-wave plans.
 * Plans in different waves running sequentially are safe — only flag same-wave
 * parallel plans that share files_modified entries.
 *
 * @param {Array<{id: string, wave: number, files_modified: string[]}>} plans
 * @returns {Array<{plans: string[], files: string[]}>}
 */
function detectFileOverlaps(plans) {
  const overlaps = [];

  // Group plans by wave
  const byWave = {};
  for (const plan of plans) {
    const waveKey = String(plan.wave);
    if (!byWave[waveKey]) byWave[waveKey] = [];
    byWave[waveKey].push(plan);
  }

  // For each wave, check all pairs
  for (const wavePlans of Object.values(byWave)) {
    for (let i = 0; i < wavePlans.length; i++) {
      for (let j = i + 1; j < wavePlans.length; j++) {
        const planA = wavePlans[i];
        const planB = wavePlans[j];
        const setA = new Set(planA.files_modified);
        const sharedFiles = planB.files_modified.filter((f) => setA.has(f));
        if (sharedFiles.length > 0) {
          overlaps.push({
            plans: [planA.id, planB.id],
            files: sharedFiles.sort(),
          });
        }
      }
    }
  }

  return overlaps;
}

/**
 * Insert a `- [ ] **Phase N: Description**` checkbox line into the phases list
 * section of ROADMAP.md content.
 *
 * @param {string} rawContent - Full ROADMAP.md content
 * @param {string|number} phaseNum - Phase number or decimal (e.g. 3, '01.1')
 * @param {string} description - Phase description
 * @param {string|number|null} afterPhase - For inserts: parent phase to insert after.
 *   null for appends (phase add).
 * @returns {string} Updated ROADMAP.md content
 */
function insertCheckboxLine(rawContent, phaseNum, description, afterPhase) {
  const checkboxLine = `- [ ] **Phase ${phaseNum}: ${description}**`;
  const lines = rawContent.split('\n');

  if (afterPhase != null) {
    // For insert: find the parent phase's checkbox line (or last decimal of parent)
    const escapedParent = String(afterPhase).replace(/\./g, '\\.');
    const parentPattern = new RegExp(
      `^- \\[[ x]\\] \\*\\*Phase\\s+${escapedParent}[.:]`,
    );
    const decimalPattern = new RegExp(
      `^- \\[[ x]\\] \\*\\*Phase\\s+${escapedParent}\\.\\d+[.:]`,
    );
    let insertAfterIdx = -1;

    for (let i = 0; i < lines.length; i++) {
      if (parentPattern.test(lines[i])) {
        insertAfterIdx = i;
      }
      // Also match existing decimal phases of this parent (e.g. 36.1, 36.2)
      if (decimalPattern.test(lines[i])) {
        insertAfterIdx = i;
      }
    }

    if (insertAfterIdx >= 0) {
      lines.splice(insertAfterIdx + 1, 0, checkboxLine);
      return lines.join('\n');
    }
  }

  // For add (or insert fallback): append after last checkbox line in the phases list
  let lastCheckboxIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^- \[[ x]\] \*\*Phase\s+\d/.test(lines[i])) {
      lastCheckboxIdx = i;
    }
  }

  if (lastCheckboxIdx >= 0) {
    lines.splice(lastCheckboxIdx + 1, 0, checkboxLine);
  }
  return lines.join('\n');
}

function cmdPhaseAdd(cwd, description) {
  if (!description) {
    error('description required for phase add');
  }

  const { roadmap: roadmapPath, phases: phasesDir } = planningPaths(cwd);
  if (!fs.existsSync(roadmapPath)) {
    error('ROADMAP.md not found');
  }

  const rawContent = fs.readFileSync(roadmapPath, 'utf-8');
  const content = extractCurrentMilestone(rawContent);
  const slug = generateSlugInternal(description);

  // Find highest integer phase number (in current milestone only)
  const phasePattern = /#{2,4}\s*Phase\s+(\d+)[A-Z]?(?:\.\d+)*:/gi;
  let maxPhase = 0;
  let m;
  while ((m = phasePattern.exec(content)) !== null) {
    const num = parseInt(m[1], 10);
    if (num > maxPhase) maxPhase = num;
  }

  const newPhaseNum = maxPhase + 1;
  const paddedNum = String(newPhaseNum).padStart(2, '0');
  const dirName = `${paddedNum}-${slug}`;
  const dirPath = path.join(phasesDir, dirName);

  // Create directory with .gitkeep so git tracks empty folders
  fs.mkdirSync(dirPath, { recursive: true });
  fs.writeFileSync(path.join(dirPath, '.gitkeep'), '');

  // Build phase entry
  const phaseEntry = `\n### Phase ${newPhaseNum}: ${description}\n\n**Goal:** [To be planned]\n**Requirements**: TBD\n**Depends on:** Phase ${maxPhase}\n**Plans:** 0 plans\n\nPlans:\n- [ ] TBD (run /gsd:plan-phase ${newPhaseNum} to break down)\n`;

  // Find insertion point: before last "---" or at end
  let updatedContent;
  const lastSeparator = rawContent.lastIndexOf('\n---');
  if (lastSeparator > 0) {
    updatedContent =
      rawContent.slice(0, lastSeparator) +
      phaseEntry +
      rawContent.slice(lastSeparator);
  } else {
    updatedContent = rawContent + phaseEntry;
  }

  // Insert checkbox summary line in the phases list at the top of ROADMAP.md
  updatedContent = insertCheckboxLine(
    updatedContent,
    newPhaseNum,
    description,
    null,
  );

  fs.writeFileSync(roadmapPath, updatedContent, 'utf-8');

  const result = {
    phase_number: newPhaseNum,
    padded: paddedNum,
    name: description,
    slug,
    directory: `.planning/phases/${dirName}`,
  };

  output(result, paddedNum);
}

function cmdPhaseInsert(cwd, afterPhase, description) {
  if (!afterPhase || !description) {
    error('after-phase and description required for phase insert');
  }

  const { roadmap: roadmapPath, phases: phasesDir } = planningPaths(cwd);
  if (!fs.existsSync(roadmapPath)) {
    error('ROADMAP.md not found');
  }

  const rawContent = fs.readFileSync(roadmapPath, 'utf-8');
  const content = extractCurrentMilestone(rawContent);
  const slug = generateSlugInternal(description);

  // Normalize input then strip leading zeros for flexible matching
  const normalizedAfter = normalizePhaseName(afterPhase);
  const unpadded = normalizedAfter.replace(/^0+/, '');
  const afterPhaseEscaped = unpadded.replace(/\./g, '\\.');
  const targetPattern = new RegExp(
    `#{2,4}\\s*Phase\\s+0*${afterPhaseEscaped}:`,
    'i',
  );
  if (!targetPattern.test(content)) {
    error(`Phase ${afterPhase} not found in ROADMAP.md`);
  }

  // Calculate next decimal using existing logic
  const normalizedBase = normalizePhaseName(afterPhase);
  let existingDecimals = [];

  try {
    const entries = fs.readdirSync(phasesDir, { withFileTypes: true });
    const dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);
    const decimalPattern = new RegExp(`^${normalizedBase}\\.(\\d+)`);
    for (const dir of dirs) {
      const dm = dir.match(decimalPattern);
      if (dm) existingDecimals.push(parseInt(dm[1], 10));
    }
  } catch {}

  const nextDecimal =
    existingDecimals.length === 0 ? 1 : Math.max(...existingDecimals) + 1;
  const decimalPhase = `${normalizedBase}.${nextDecimal}`;
  const dirName = `${decimalPhase}-${slug}`;
  const dirPath = path.join(phasesDir, dirName);

  // Create directory with .gitkeep so git tracks empty folders
  fs.mkdirSync(dirPath, { recursive: true });
  fs.writeFileSync(path.join(dirPath, '.gitkeep'), '');

  // Build phase entry
  const phaseEntry = `\n### Phase ${decimalPhase}: ${description} (INSERTED)\n\n**Goal:** [Urgent work - to be planned]\n**Requirements**: TBD\n**Depends on:** Phase ${afterPhase}\n**Plans:** 0 plans\n\nPlans:\n- [ ] TBD (run /gsd:plan-phase ${decimalPhase} to break down)\n`;

  // Insert after the target phase section
  const headerPattern = new RegExp(
    `(#{2,4}\\s*Phase\\s+0*${afterPhaseEscaped}:[^\\n]*\\n)`,
    'i',
  );
  const headerMatch = rawContent.match(headerPattern);
  if (!headerMatch) {
    error(`Could not find Phase ${afterPhase} header`);
  }

  const headerIdx = rawContent.indexOf(headerMatch[0]);
  const afterHeader = rawContent.slice(headerIdx + headerMatch[0].length);
  const nextPhaseMatch = afterHeader.match(
    /\n#{2,4}\s+Phase\s+\d+[A-Z]?(?:\.\d+)*/i,
  );

  let insertIdx;
  if (nextPhaseMatch) {
    insertIdx = headerIdx + headerMatch[0].length + nextPhaseMatch.index;
  } else {
    insertIdx = rawContent.length;
  }

  let updatedContent =
    rawContent.slice(0, insertIdx) + phaseEntry + rawContent.slice(insertIdx);

  // Insert checkbox summary line in the phases list, after the parent phase's checkbox
  updatedContent = insertCheckboxLine(
    updatedContent,
    decimalPhase,
    description + ' (INSERTED)',
    afterPhase,
  );

  fs.writeFileSync(roadmapPath, updatedContent, 'utf-8');

  const result = {
    phase_number: decimalPhase,
    after_phase: afterPhase,
    name: description,
    slug,
    directory: `.planning/phases/${dirName}`,
  };

  output(result, decimalPhase);
}

function cmdPhaseRemove(cwd, targetPhase, options) {
  if (!targetPhase) {
    error('phase number required for phase remove');
  }

  const { roadmap: roadmapPath, phases: phasesDir } = planningPaths(cwd);
  const force = options.force || false;

  if (!fs.existsSync(roadmapPath)) {
    error('ROADMAP.md not found');
  }

  // Normalize the target
  const normalized = normalizePhaseName(targetPhase);
  const isDecimal = targetPhase.includes('.');

  // Find and validate target directory
  let targetDir = null;
  try {
    const entries = fs.readdirSync(phasesDir, { withFileTypes: true });
    const dirs = entries
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort((a, b) => comparePhaseNum(a, b));
    targetDir = dirs.find(
      (d) => d.startsWith(normalized + '-') || d === normalized,
    );
  } catch {}

  // Check for executed work (SUMMARY.md files)
  if (targetDir && !force) {
    const targetPath = path.join(phasesDir, targetDir);
    const files = fs.readdirSync(targetPath);
    const summaries = files.filter(
      (f) => f.endsWith('-SUMMARY.md') || f === 'SUMMARY.md',
    );
    if (summaries.length > 0) {
      error(
        `Phase ${targetPhase} has ${summaries.length} executed plan(s). Use --force to remove anyway.`,
      );
    }
  }

  // Delete target directory
  if (targetDir) {
    fs.rmSync(path.join(phasesDir, targetDir), {
      recursive: true,
      force: true,
    });
  }

  // Renumber subsequent phases
  const renamedDirs = [];
  const renamedFiles = [];

  if (isDecimal) {
    // Decimal removal: renumber sibling decimals (e.g., removing 06.2 → 06.3 becomes 06.2)
    const baseParts = normalized.split('.');
    const baseInt = baseParts[0];
    const removedDecimal = parseInt(baseParts[1], 10);

    try {
      const entries = fs.readdirSync(phasesDir, { withFileTypes: true });
      const dirs = entries
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
        .sort((a, b) => comparePhaseNum(a, b));

      // Find sibling decimals with higher numbers
      const decPattern = new RegExp(`^${baseInt}\\.(\\d+)-(.+)$`);
      const toRename = [];
      for (const dir of dirs) {
        const dm = dir.match(decPattern);
        if (dm && parseInt(dm[1], 10) > removedDecimal) {
          toRename.push({ dir, oldDecimal: parseInt(dm[1], 10), slug: dm[2] });
        }
      }

      // Sort descending to avoid conflicts
      toRename.sort((a, b) => b.oldDecimal - a.oldDecimal);

      for (const item of toRename) {
        const newDecimal = item.oldDecimal - 1;
        const oldPhaseId = `${baseInt}.${item.oldDecimal}`;
        const newPhaseId = `${baseInt}.${newDecimal}`;
        const newDirName = `${baseInt}.${newDecimal}-${item.slug}`;

        // Rename directory
        fs.renameSync(
          path.join(phasesDir, item.dir),
          path.join(phasesDir, newDirName),
        );
        renamedDirs.push({ from: item.dir, to: newDirName });

        // Rename files inside
        const dirFiles = fs.readdirSync(path.join(phasesDir, newDirName));
        for (const f of dirFiles) {
          // Files may have phase prefix like "06.2-01-PLAN.md"
          if (f.includes(oldPhaseId)) {
            const newFileName = f.replace(oldPhaseId, newPhaseId);
            fs.renameSync(
              path.join(phasesDir, newDirName, f),
              path.join(phasesDir, newDirName, newFileName),
            );
            renamedFiles.push({ from: f, to: newFileName });
          }
        }
      }
    } catch {}
  } else {
    // Integer removal: renumber all subsequent integer phases
    const removedInt = parseInt(normalized, 10);

    try {
      const entries = fs.readdirSync(phasesDir, { withFileTypes: true });
      const dirs = entries
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
        .sort((a, b) => comparePhaseNum(a, b));

      // Collect directories that need renumbering (integer phases > removed, and their decimals/letters)
      const toRename = [];
      for (const dir of dirs) {
        const dm = dir.match(/^(\d+)([A-Z])?(?:\.(\d+))?-(.+)$/i);
        if (!dm) continue;
        const dirInt = parseInt(dm[1], 10);
        if (dirInt > removedInt) {
          toRename.push({
            dir,
            oldInt: dirInt,
            letter: dm[2] ? dm[2].toUpperCase() : '',
            decimal: dm[3] ? parseInt(dm[3], 10) : null,
            slug: dm[4],
          });
        }
      }

      // Sort descending to avoid conflicts
      toRename.sort((a, b) => {
        if (a.oldInt !== b.oldInt) return b.oldInt - a.oldInt;
        return (b.decimal || 0) - (a.decimal || 0);
      });

      for (const item of toRename) {
        const newInt = item.oldInt - 1;
        const newPadded = String(newInt).padStart(2, '0');
        const oldPadded = String(item.oldInt).padStart(2, '0');
        const letterSuffix = item.letter || '';
        const decimalSuffix = item.decimal !== null ? `.${item.decimal}` : '';
        const oldPrefix = `${oldPadded}${letterSuffix}${decimalSuffix}`;
        const newPrefix = `${newPadded}${letterSuffix}${decimalSuffix}`;
        const newDirName = `${newPrefix}-${item.slug}`;

        // Rename directory
        fs.renameSync(
          path.join(phasesDir, item.dir),
          path.join(phasesDir, newDirName),
        );
        renamedDirs.push({ from: item.dir, to: newDirName });

        // Rename files inside
        const dirFiles = fs.readdirSync(path.join(phasesDir, newDirName));
        for (const f of dirFiles) {
          if (f.startsWith(oldPrefix)) {
            const newFileName = newPrefix + f.slice(oldPrefix.length);
            fs.renameSync(
              path.join(phasesDir, newDirName, f),
              path.join(phasesDir, newDirName, newFileName),
            );
            renamedFiles.push({ from: f, to: newFileName });
          }
        }
      }
    } catch {}
  }

  // Update ROADMAP.md
  let roadmapContent = fs.readFileSync(roadmapPath, 'utf-8');

  // Remove the target phase section
  const targetEscaped = escapeRegex(targetPhase);
  const sectionPattern = new RegExp(
    `\\n?#{2,4}\\s*Phase\\s+${targetEscaped}\\s*:[\\s\\S]*?(?=\\n#{2,4}\\s+Phase\\s+\\d+[A-Z]?(?:\\.\\d+)*|$)`,
    'i',
  );
  roadmapContent = roadmapContent.replace(sectionPattern, '');

  // Remove from phase list (checkbox)
  const checkboxPattern = new RegExp(
    `\\n?-\\s*\\[[ x]\\]\\s*.*Phase\\s+${targetEscaped}[:\\s][^\\n]*`,
    'gi',
  );
  roadmapContent = roadmapContent.replace(checkboxPattern, '');

  // Remove from progress table
  const tableRowPattern = new RegExp(
    `\\n?\\|\\s*${targetEscaped}\\.?\\s[^|]*\\|[^\\n]*`,
    'gi',
  );
  roadmapContent = roadmapContent.replace(tableRowPattern, '');

  // Renumber references in ROADMAP for subsequent phases
  if (!isDecimal) {
    const removedInt = parseInt(normalized, 10);

    // Collect all integer phases > removedInt
    const maxPhase = 99; // reasonable upper bound
    for (let oldNum = maxPhase; oldNum > removedInt; oldNum--) {
      const newNum = oldNum - 1;
      const oldStr = String(oldNum);
      const newStr = String(newNum);
      const oldPad = oldStr.padStart(2, '0');
      const newPad = newStr.padStart(2, '0');

      // Phase headings: ## Phase N: or ### Phase N: — renumber old to new
      roadmapContent = roadmapContent.replace(
        new RegExp(`(#{2,4}\\s*Phase\\s+)${oldStr}(\\s*:)`, 'gi'),
        `$1${newStr}$2`,
      );

      // Checkbox items: - [ ] **Phase N:** — renumber old to new
      roadmapContent = roadmapContent.replace(
        new RegExp(`(Phase\\s+)${oldStr}([:\\s])`, 'g'),
        `$1${newStr}$2`,
      );

      // Plan references: 18-01 → 17-01
      roadmapContent = roadmapContent.replace(
        new RegExp(`${oldPad}-(\\d{2})`, 'g'),
        `${newPad}-$1`,
      );

      // Table rows: | 18. → | 17.
      roadmapContent = roadmapContent.replace(
        new RegExp(`(\\|\\s*)${oldStr}\\.\\s`, 'g'),
        `$1${newStr}. `,
      );

      // Depends on references
      roadmapContent = roadmapContent.replace(
        new RegExp(`(Depends on:\\*\\*\\s*Phase\\s+)${oldStr}\\b`, 'gi'),
        `$1${newStr}`,
      );
    }
  }

  fs.writeFileSync(roadmapPath, roadmapContent, 'utf-8');

  // Update STATE.md phase count
  const statePath = planningPaths(cwd).state;
  if (fs.existsSync(statePath)) {
    let stateContent = fs.readFileSync(statePath, 'utf-8');
    // Update "Total Phases" field
    const totalPattern = /(\*\*Total Phases:\*\*\s*)(\d+)/;
    const totalMatch = stateContent.match(totalPattern);
    if (totalMatch) {
      const oldTotal = parseInt(totalMatch[2], 10);
      stateContent = stateContent.replace(totalPattern, `$1${oldTotal - 1}`);
    }
    // Update "Phase: X of Y" pattern
    const ofPattern = /(\bof\s+)(\d+)(\s*(?:\(|phases?))/i;
    const ofMatch = stateContent.match(ofPattern);
    if (ofMatch) {
      const oldTotal = parseInt(ofMatch[2], 10);
      stateContent = stateContent.replace(ofPattern, `$1${oldTotal - 1}$3`);
    }
    writeStateMd(statePath, stateContent, cwd);
  }

  const result = {
    removed: targetPhase,
    directory_deleted: targetDir || null,
    renamed_directories: renamedDirs,
    renamed_files: renamedFiles,
    roadmap_updated: true,
    state_updated: fs.existsSync(statePath),
  };

  output(result);
}

function cmdPhaseComplete(cwd, phaseNum) {
  if (!phaseNum) {
    error('phase number required for phase complete');
  }

  const {
    roadmap: roadmapPath,
    state: statePath,
    phases: phasesDir,
  } = planningPaths(cwd);
  const normalized = normalizePhaseName(phaseNum);
  const today = new Date().toISOString().split('T')[0];

  // Verify phase info
  const phaseInfo = findPhaseInternal(cwd, phaseNum);
  if (!phaseInfo) {
    error(`Phase ${phaseNum} not found`);
  }

  const planCount = phaseInfo.plans.length;
  const summaryCount = phaseInfo.summaries.length;
  let requirementsUpdated = false;
  let roadmapContent = null;

  // Update ROADMAP.md: mark phase complete
  if (fs.existsSync(roadmapPath)) {
    roadmapContent = fs.readFileSync(roadmapPath, 'utf-8');

    // Checkbox: - [ ] Phase N: → - [x] Phase N: (...completed DATE)
    const checkboxPattern = new RegExp(
      `(-\\s*\\[)[ ](\\]\\s*.*Phase\\s+${escapeRegex(phaseNum)}[:\\s][^\\n]*)`,
      'i',
    );
    roadmapContent = replaceInCurrentMilestone(
      roadmapContent,
      checkboxPattern,
      `$1x$2 (completed ${today})`,
    );

    // Progress table: update Status to Complete, add date (handles 4 or 5 column tables)
    const phaseEscaped = escapeRegex(phaseNum);
    const tableRowPattern = new RegExp(
      `^(\\|\\s*${phaseEscaped}\\.?\\s[^|]*(?:\\|[^\\n]*)*)$`,
      'im',
    );
    roadmapContent = replaceInCurrentMilestone(
      roadmapContent,
      tableRowPattern,
      (fullRow) => {
        const cells = fullRow.split('|').slice(1, -1);
        if (cells.length === 5) {
          // 5-col: Phase | Milestone | Plans | Status | Completed
          cells[3] = ' Complete    ';
          cells[4] = ` ${today} `;
        } else if (cells.length === 4) {
          // 4-col: Phase | Plans | Status | Completed
          cells[2] = ' Complete    ';
          cells[3] = ` ${today} `;
        }
        return '|' + cells.join('|') + '|';
      },
    );

    // Update plan count in phase section
    const planCountPattern = new RegExp(
      `(#{2,4}\\s*Phase\\s+${phaseEscaped}[\\s\\S]*?\\*\\*Plans:\\*\\*\\s*)[^\\n]+`,
      'i',
    );
    roadmapContent = replaceInCurrentMilestone(
      roadmapContent,
      planCountPattern,
      `$1${summaryCount}/${planCount} plans complete`,
    );

    fs.writeFileSync(roadmapPath, roadmapContent, 'utf-8');
  }

  // ── Requirement closure ───────────────────────────────────────────────────
  // Closing requirements is a phase-close action gated on the verifier's
  // assessment, never a per-plan side effect. Firing per-plan would let whichever
  // plan finished first close every ID it declared — an ID shared by many plans
  // in a phase would read Complete while most of its work was unstarted, and
  // under wave-based parallel execution two executors could also clobber each
  // other's REQUIREMENTS.md write. VERIFICATION.md is the completion authority
  // everywhere else in GSD (see getPhaseCompletionStatus); it is here too.
  const phaseDirAbs = path.join(cwd, phaseInfo.directory);
  const verificationStatus = readVerificationStatus(phaseDirAbs);
  const requirementsBlockedBy = FAILED_VERIFICATION_STATUSES.has(
    verificationStatus,
  )
    ? verificationStatus
    : null;

  // A report older than the work it judges is stale by construction. Reported
  // either way; it changes nothing about whether closure proceeds.
  const staleSummaries = summariesNewerThanVerification(
    phaseDirAbs,
    phaseInfo.summaries,
  );
  const verificationStale = staleSummaries.length > 0;

  let requirementIds = [];
  let requirementsOtherPhase = [];
  let requirementsUnmapped = [];
  let requirementsUndeclared = [];
  let requirementsBlockedHint = null;
  if (requirementsBlockedBy) {
    // Verifier says the goal is not met — leave every ID Pending. A later
    // re-run after gap closure will pick them up. When the report predates the
    // summaries it is blocking on, say so: the block is otherwise indistinguish-
    // able from a current verdict, and an operator has no way to tell that the
    // remedy is to re-run the verifier rather than to re-close the same gaps.
    requirementsBlockedHint = verificationStale
      ? `Requirement closure is blocked by a verification report (${requirementsBlockedBy}) ` +
        `that predates ${staleSummaries.length} summary file(s) in this phase: ` +
        `${staleSummaries.join(', ')}. The report cannot reflect that work. ` +
        `Re-run verification for this phase; closure stays withheld until it does, ` +
        `because the report's age is not evidence the gaps were closed.`
      : `Requirement closure is blocked by a verification report (${requirementsBlockedBy}). ` +
        `Close the reported gaps and re-run verification.`;
  } else {
    // Either the verifier passed, it needs human sign-off (which execute-phase
    // obtains before reaching phase-close), or no VERIFICATION.md exists at all
    // because workflow.verifier is off. Verification is a qualifier, not a gate
    // — an absent report must not strand requirements as permanently Pending.
    const collected = collectPhaseRequirementIds(
      cwd,
      phaseNum,
      phaseInfo,
      roadmapContent,
    );
    const closure = closePhaseRequirements(cwd, collected.ids, phaseNum);
    requirementsUpdated = closure.updated;
    requirementIds = closure.closed;
    requirementsOtherPhase = closure.otherPhase;
    requirementsUnmapped = closure.unmapped;
    requirementsUndeclared = collected.undeclared;
  }

  // Find next phase — check both filesystem AND roadmap
  // Phases may be defined in ROADMAP.md but not yet scaffolded to disk,
  // so a filesystem-only scan would incorrectly report is_last_phase:true
  let nextPhaseNum = null;
  let nextPhaseName = null;
  let isLastPhase = true;

  try {
    const isDirInMilestone = getMilestonePhaseFilter(cwd);
    const entries = fs.readdirSync(phasesDir, { withFileTypes: true });
    const dirs = entries
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .filter(isDirInMilestone)
      .sort((a, b) => comparePhaseNum(a, b));

    // Find the next phase directory after current
    for (const dir of dirs) {
      const dm = dir.match(/^(\d+[A-Z]?(?:\.\d+)*)-?(.*)/i);
      if (dm) {
        if (comparePhaseNum(dm[1], phaseNum) > 0) {
          nextPhaseNum = dm[1];
          nextPhaseName = dm[2] || null;
          isLastPhase = false;
          break;
        }
      }
    }
  } catch {}

  // Fallback: if filesystem found no next phase, check ROADMAP.md
  // for phases that are defined but not yet planned (no directory on disk).
  // Union of two patterns:
  //   1. Header pattern: `### Phase N: Title` (post-planning, when Details section exists)
  //   2. Bullet pattern: `- [ ] **Phase N: Title**` (pre-planning, bullet-only entry)
  // Note on normalization: the header pattern returns whatever is written (e.g. '06'),
  // while the bullet pattern returns whatever is written (e.g. '6'). We do NOT pad here —
  // comparePhaseNum handles both forms semantically. When both a header and bullet reference
  // the same phase, the header entry is preferred (via sort-stable dedup).
  if (isLastPhase && fs.existsSync(roadmapPath)) {
    try {
      const roadmapForPhases = extractCurrentMilestone(
        fs.readFileSync(roadmapPath, 'utf-8'),
      );
      const headerPattern =
        /#{2,4}\s*Phase\s+(\d+[A-Z]?(?:\.\d+)*)\s*:\s*([^\n]+)/gi;
      // Bullet pattern also captures the name (between `:` and the closing `**`)
      const bulletPattern =
        /^[-*]\s*\[[ x]\]\s*\*\*Phase\s+(\d+[A-Z]?(?:\.\d+)*):\s*([^*\n]+?)\*\*/gim;

      const candidates = [];
      let pm;
      while ((pm = headerPattern.exec(roadmapForPhases)) !== null) {
        candidates.push({ index: pm.index, num: pm[1], name: pm[2] });
      }
      while ((pm = bulletPattern.exec(roadmapForPhases)) !== null) {
        candidates.push({ index: pm.index, num: pm[1], name: pm[2] });
      }
      // Sort by phase number ascending (comparePhaseNum handles padded/unpadded forms).
      // At equal phase number, preserve document order (header tends to appear after bullet
      // in ROADMAP.md, but the dedup step below keeps the first — typically the bullet — unless
      // the header appeared earlier in the document, in which case document order wins).
      candidates.sort((a, b) => {
        const c = comparePhaseNum(a.num, b.num);
        if (c !== 0) return c;
        return a.index - b.index;
      });
      // Dedupe by phase number, keeping first (header-preferred when headers appear before
      // bullets in the ROADMAP; for typical layout where bullet lists precede Details sections,
      // the bullet match is kept — both yield the same name so the choice is cosmetic).
      const seen = new Set();
      const unique = candidates.filter((c) => {
        if (seen.has(c.num)) return false;
        seen.add(c.num);
        return true;
      });

      for (const c of unique) {
        if (comparePhaseNum(c.num, phaseNum) > 0) {
          nextPhaseNum = c.num;
          nextPhaseName = c.name
            .replace(/\(INSERTED\)/i, '')
            .trim()
            .toLowerCase()
            .replace(/\s+/g, '-');
          isLastPhase = false;
          break;
        }
      }
    } catch {}
  }

  // Update STATE.md
  if (fs.existsSync(statePath)) {
    let stateContent = fs.readFileSync(statePath, 'utf-8');

    // Update Current Phase
    stateContent = stateContent.replace(
      /(\*\*Current Phase:\*\*\s*).*/,
      `$1${nextPhaseNum || phaseNum}`,
    );

    // Update Current Phase Name
    if (nextPhaseName) {
      stateContent = stateContent.replace(
        /(\*\*Current Phase Name:\*\*\s*).*/,
        `$1${nextPhaseName.replace(/-/g, ' ')}`,
      );
    }

    // Update Status
    stateContent = stateContent.replace(
      /(\*\*Status:\*\*\s*).*/,
      `$1${isLastPhase ? 'Milestone complete' : 'Ready to plan'}`,
    );

    // Update Current Plan
    stateContent = stateContent.replace(
      /(\*\*Current Plan:\*\*\s*).*/,
      `$1Not started`,
    );

    // Update Last Activity
    stateContent = stateContent.replace(
      /(\*\*Last Activity:\*\*\s*).*/,
      `$1${today}`,
    );

    // Update Last Activity Description
    stateContent = stateContent.replace(
      /(\*\*Last Activity Description:\*\*\s*).*/,
      `$1Phase ${phaseNum} complete${nextPhaseNum ? `, transitioned to Phase ${nextPhaseNum}` : ''}`,
    );

    writeStateMd(statePath, stateContent, cwd);
  }

  const result = {
    completed_phase: phaseNum,
    phase_name: phaseInfo.phase_name,
    plans_executed: `${summaryCount}/${planCount}`,
    next_phase: nextPhaseNum
      ? { number: nextPhaseNum, name: nextPhaseName }
      : null,
    next_phase_name: nextPhaseName, // keep for backward compat with transition.md consumers
    is_last_phase: isLastPhase,
    date: today,
    roadmap_updated: fs.existsSync(roadmapPath),
    state_updated: fs.existsSync(statePath),
    requirements_updated: requirementsUpdated,
    requirements_closed: requirementIds,
    requirements_other_phase: requirementsOtherPhase,
    requirements_unmapped: requirementsUnmapped,
    requirements_undeclared: requirementsUndeclared,
    verification_status: verificationStatus,
    verification_stale: verificationStale,
    verification_stale_summaries: staleSummaries,
    requirements_blocked_by: requirementsBlockedBy,
    requirements_blocked_hint: requirementsBlockedHint,
  };

  output(result);
}

module.exports = {
  cmdPhasesList,
  cmdPhaseNextDecimal,
  cmdFindPhase,
  cmdPhasePlanIndex,
  cmdPhaseAdd,
  cmdPhaseInsert,
  cmdPhaseRemove,
  cmdPhaseComplete,
};
