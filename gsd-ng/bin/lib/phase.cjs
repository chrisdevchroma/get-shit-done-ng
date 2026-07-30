/**
 * Phase — Phase CRUD, query, and lifecycle operations
 */

const fs = require('fs');
const path = require('path');
const {
  escapeRegex,
  normalizePhaseName,
  boldLabel,
  phaseFieldPattern,
  phaseNumPattern,
  phaseCheckboxPattern,
  phaseCheckboxLinePattern,
  parsePhaseCheckboxes,
  comparePhaseNum,
  findPhaseInternal,
  getArchivedPhaseDirs,
  generateSlugInternal,
  getMilestonePhaseFilter,
  extractCurrentMilestone,
  replaceInCurrentMilestone,
  currentMilestoneOffset,
  hasPhaseTableRow,
  hasPhaseHeader,
  hasPhasePlansLine,
  isPhaseCheckboxSatisfied,
  readVerificationStatus,
  getPhaseCompletionStatus,
  toPosixPath,
  output,
  error,
  planningPaths,
  withRoadmapLock,
  withRequirementsLock,
  notePartialWrites,
  writeFileAtomic,
} = require('./core.cjs');
const { extractFrontmatter } = require('./frontmatter.cjs');
const {
  withStateLock,
  writeStateMd,
  stateExtractField,
  stateReplaceField,
  stateReplaceFields,
} = require('./state.cjs');

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

const FRONTMATTER_OPEN = /^---\r?\n/;
const FRONTMATTER_BLOCK = /^---\r?\n[\s\S]+?\r?\n---/;

// The roadmap phase-section requirements line. Every producer — templates,
// gsd-roadmapper, discuss-phase, `phase add` — writes the colon outside the
// bold, matching init.cjs. The colon-inside form is accepted too because
// documents in the wild carry it and rejecting them would silently close
// nothing for those projects.
const ROADMAP_REQUIREMENTS_LINE = new RegExp(
  boldLabel('Requirements') + String.raw`\s*([^\n]+)`,
  'i',
);

/**
 * Read the requirement IDs one file records under `field`, keeping the three
 * states a caller has to tell apart:
 *
 *   - `unreadable` — the file could not be read, or opens a frontmatter block it
 *     never closes. A truncated document parses to an empty object, so without
 *     the delimiter check the strongest signal available (this record cannot be
 *     trusted) collapses into the weakest (no opinion). A document with no
 *     opening delimiter at all is not corrupt, merely frontmatter-less, and is
 *     reported `absent`;
 *   - `absent` — the file carries no such field;
 *   - `present` — the field is there, and its value may be empty.
 *
 * @returns {{status: 'unreadable'|'absent'|'present', ids: string[]}}
 */
function readFrontmatterRequirements(filePath, field) {
  let content;
  try {
    content = fs.readFileSync(filePath, 'utf-8');
  } catch {
    return { status: 'unreadable', ids: [] };
  }
  if (FRONTMATTER_OPEN.test(content) && !FRONTMATTER_BLOCK.test(content)) {
    return { status: 'unreadable', ids: [] };
  }
  const value = extractFrontmatter(content)[field];
  if (value === undefined) return { status: 'absent', ids: [] };
  return { status: 'present', ids: readRequirementIdField(value) };
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
 *   - summary omits the field entirely → fall back to the plan's declaration.
 *     The field is a comparatively recent addition, so a summary written before
 *     it existed makes no claim either way, and failing closed on silence would
 *     strand every requirement of every phase predating it;
 *   - summary carries the field but empty → close nothing for that plan, and
 *     return it in `emptySummaries`. An empty list is not silence: it is a
 *     written claim to have delivered nothing, and reading a claim of nothing as
 *     permission to close everything inverts it;
 *   - summary unreadable or corrupt → close nothing for that plan, and return it
 *     in `unreadableSummaries`. Falling back here would let a truncated file
 *     close a full declaration, which is the failure this whole mechanism exists
 *     to prevent. An unusable record is not evidence of delivery.
 *
 * The ROADMAP.md phase section's `**Requirements**:` line is a third source and
 * is unioned in, because a phase whose plans carry no `requirements:` would
 * otherwise never close anything — phase-close is the only place closure
 * happens. It is a phase-level declaration, though, not a delivery record, so it
 * is admitted only when the delivery records raise nothing against it: every
 * plan has a summary, none is empty or unreadable, and none records less than
 * its plan declared. Otherwise the phase-level intent would re-close exactly
 * what the per-plan records just withheld.
 *
 * That gate is deliberately all-or-nothing, and must stay that way. The
 * surgical alternative — admit the line and subtract only the IDs some record
 * withheld — looks tighter and is wrong, because it assumes the withheld IDs
 * are exactly the work that did not land. Requirement IDs do not partition work
 * that cleanly: a task an executor dropped can be the work behind a requirement
 * that plan never listed, including one only the roadmap names. So subtracting
 * ID-by-ID closes roadmap-only IDs on the strength of "every plan ran", which
 * is precisely the inference the narrowing disproved. The two failure modes are
 * not symmetric — over-closing asserts in the traceability table that unshipped
 * work is done and nobody is told, while under-closing leaves an ID Pending and
 * reports why in `narrowedSummaries`, which a re-run clears once the narrowing
 * is resolved. Fail closed, and report.
 *
 * @returns {{ids: string[], undeclared: string[], unreadableSummaries: string[],
 *            emptySummaries: string[],
 *            narrowedSummaries: Array<{summary: string, withheld: string[]}>}}
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

  const summaryByPlanId = new Map();
  for (const summaryFile of phaseInfo.summaries || []) {
    summaryByPlanId.set(planDocumentId(summaryFile), summaryFile);
  }

  const undeclared = [];
  const undeclaredSeen = new Set();
  const unreadableSummaries = [];
  const emptySummaries = [];
  const narrowedSummaries = [];
  let withheldFromPlans = false;

  for (const planFile of phaseInfo.plans || []) {
    const summaryFile = summaryByPlanId.get(planDocumentId(planFile));
    if (!summaryFile) continue;

    const delivery = readFrontmatterRequirements(
      path.join(phaseDir, summaryFile),
      'requirements-completed',
    );
    if (delivery.status === 'unreadable') {
      unreadableSummaries.push(summaryFile);
      withheldFromPlans = true;
      continue;
    }

    const declaredIds = readFrontmatterRequirements(
      path.join(phaseDir, planFile),
      'requirements',
    ).ids;

    if (delivery.status === 'absent') {
      declaredIds.forEach(add);
      continue;
    }

    if (delivery.ids.length === 0) {
      emptySummaries.push(summaryFile);
      withheldFromPlans = true;
      continue;
    }

    const deliveredKeys = new Set(delivery.ids.map((id) => id.toLowerCase()));
    const withheld = declaredIds.filter(
      (id) => !deliveredKeys.has(id.toLowerCase()),
    );
    if (withheld.length > 0) {
      narrowedSummaries.push({ summary: summaryFile, withheld });
      withheldFromPlans = true;
    }

    const declaredKeys = new Set(declaredIds.map((id) => id.toLowerCase()));
    for (const id of delivery.ids) {
      add(id);
      const key = id.toLowerCase();
      if (!declaredKeys.has(key) && !undeclaredSeen.has(key)) {
        undeclaredSeen.add(key);
        undeclared.push(id);
      }
    }
  }

  if (
    roadmapContent &&
    !withheldFromPlans &&
    getPhaseCompletionStatus(phaseDir).isComplete
  ) {
    const phaseEsc = phaseNumPattern(phaseNum);
    const phaseSectionMatch = extractCurrentMilestone(roadmapContent).match(
      new RegExp(
        `(#{2,4}\\s*Phase\\s+${phaseEsc}[:\\s][\\s\\S]*?)(?=#{2,4}\\s*Phase\\s+|$)`,
        'i',
      ),
    );
    const reqMatch = (phaseSectionMatch ? phaseSectionMatch[1] : '').match(
      ROADMAP_REQUIREMENTS_LINE,
    );
    if (reqMatch) parseRequirementIdList(reqMatch[1]).forEach(add);
  }

  return {
    ids,
    undeclared,
    unreadableSummaries,
    emptySummaries,
    narrowedSummaries,
  };
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

const SEPARATOR_CELL = /^:?-+:?$/;

/**
 * Parse the traceability table out of REQUIREMENTS.md lines.
 *
 * Column order is Requirement | Phase | Status, matching the template. A
 * project may use any requirement-ID convention, so rows are not identified by
 * ID syntax. They are identified by the table they sit in: consecutive
 * pipe-prefixed lines form a block, and a block is a traceability table when it
 * carries a Status-headed column or at least one row whose status is a known
 * one. Anchoring on the block rather than on each row's own status is what lets
 * a row reading something outside the vocabulary still be seen — such a row is
 * returned with `recognised: false` so callers can refuse to act on it, rather
 * than being dropped and mistaken for the absence of a row.
 *
 * @param {string[]} lines  REQUIREMENTS.md split on newlines
 * @returns {{rows: Array<{lineIndex: number, id: string, phase: string,
 *            status: string, recognised: boolean}>, tableFound: boolean}}
 */
function parseTraceabilityRows(lines) {
  const rows = [];
  let tableFound = false;

  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].trimStart().startsWith('|')) continue;

    let end = i;
    while (end < lines.length && lines[end].trimStart().startsWith('|')) end++;

    const block = [];
    for (let j = i; j < end; j++) {
      // `| a | b | c |` splits to ['', ' a ', ' b ', ' c ', ''] — a three-column
      // row is the minimum shape, hence at least five parts.
      const cells = lines[j].split('|');
      if (cells.length < 5) continue;
      const id = cells[1].trim();
      if (!id) continue;
      if (cells.slice(1, -1).every((c) => SEPARATOR_CELL.test(c.trim())))
        continue;
      const status = cells[3].trim();
      block.push({
        lineIndex: j,
        id,
        phase: cells[2].trim(),
        status,
        recognised: TRACEABILITY_STATUSES.has(status.toLowerCase()),
      });
    }

    const header =
      block.length > 0 && block[0].status.toLowerCase() === 'status'
        ? block[0]
        : null;
    if (header || block.some((r) => r.recognised)) {
      tableFound = true;
      for (const row of block) if (row !== header) rows.push(row);
    }

    i = end - 1;
  }

  return { rows, tableFound };
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
 * to prevent. Each candidate therefore falls into one of four cases:
 *
 *   - the table gives it a row for this phase → close the row and tick the box;
 *   - that row is Blocked → change nothing and return it as blocked. A block is
 *     a human decision closure must not revert, and that applies to the checkbox
 *     and to `closed` no less than to the row itself;
 *   - that row's status is not one this code knows → change nothing and return
 *     it as unreadable. A word nobody can interpret is not permission to close;
 *     the safe reading of an unknown state is that it is not done;
 *   - the table gives it a row for some other phase → change nothing, and
 *     return it so the caller can report it. Skipping silently would strand the
 *     requirement: the declaring phase thinks it shipped it, the owning phase
 *     may never run, and nobody is told;
 *   - the table has no row for it at all → nothing can contradict the plan, so
 *     tick the box, and return it as unmapped. This is the case that keeps a
 *     project with no traceability table working.
 *
 * Idempotent: rows already Complete are not re-closed and the checkbox pattern
 * no longer matches, so a repeated phase-close leaves the file byte-identical and
 * `updated` is false — it reports the write, not the attempt.
 *
 * @param {string} cwd
 * @param {string[]} reqIds     candidate IDs collected for the phase
 * @param {string|number} phaseNum  the phase being closed
 * @returns {{updated: boolean, closed: string[],
 *            otherPhase: Array<{id: string, phase: string}>, unmapped: string[],
 *            blocked: Array<{id: string, status: string}>,
 *            unreadable: Array<{id: string, status: string}>}}
 */
function closePhaseRequirements(cwd, reqIds, phaseNum) {
  const result = {
    updated: false,
    closed: [],
    otherPhase: [],
    unmapped: [],
    blocked: [],
    unreadable: [],
  };
  const reqPath = planningPaths(cwd).requirements;
  if (reqIds.length === 0 || !fs.existsSync(reqPath)) return result;
  // The read and the rewrite are one section: the file is written back from the
  // read, so a mark another writer made in between is dropped. Inside the
  // ROADMAP.md lock that phase complete already holds, which is the supported
  // order — roadmap, requirements, state.
  return withRequirementsLock(cwd, () => {
    const originalContent = fs.readFileSync(reqPath, 'utf-8');
    const lines = originalContent.split('\n');
    const { rows, tableFound: hasTable } = parseTraceabilityRows(lines);

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

      const unreadable = ours.filter((r) => !r.recognised);
      if (unreadable.length > 0) {
        result.unreadable.push({
          id: reqId,
          status: [...new Set(unreadable.map((r) => r.status))].join(', '),
        });
        continue;
      }

      // 'Complete' is not closeable but does mean done, so it must not count as
      // held — that case is the idempotent re-run.
      const held = ours.filter(
        (r) =>
          !CLOSEABLE_STATUSES.test(r.status) &&
          r.status.trim().toLowerCase() !== 'complete',
      );
      if (held.length > 0) {
        result.blocked.push({
          id: reqId,
          status: [...new Set(held.map((r) => r.status.trim()))].join(', '),
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

    if (reqContent === originalContent) return result;

    writeFileAtomic(reqPath, reqContent);
    result.updated = true;
    return result;
  });
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

// Index of the first line belonging to the current milestone. Line-based
// rewrites start here so they cannot reach into an archived section.
function currentMilestoneStartLine(content) {
  const offset = currentMilestoneOffset(content);
  if (offset === 0) return 0;
  let line = 0;
  for (let i = 0; i < offset; i++) {
    if (content[i] === '\n') line++;
  }
  return line + 1;
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
  // The list being appended to is the current milestone's. Scanning from the top
  // of the document put the new phase inside a shipped <details> section
  // whenever that section held the last checkbox in the file.
  const first = currentMilestoneStartLine(rawContent);

  if (afterPhase != null) {
    // For insert: the parent phase's checkbox line, or the last decimal of that
    // parent (e.g. 36.1, 36.2) — one pattern covers both.
    const parentPattern = new RegExp(
      phaseCheckboxLinePattern(afterPhase, { withDecimals: true }),
      'i',
    );
    let insertAfterIdx = -1;

    for (let i = first; i < lines.length; i++) {
      if (parentPattern.test(lines[i])) {
        insertAfterIdx = i;
      }
    }

    if (insertAfterIdx >= 0) {
      lines.splice(insertAfterIdx + 1, 0, checkboxLine);
      return lines.join('\n');
    }
  }

  // For add (or insert fallback): append after last checkbox line in the phases list
  const anyCheckbox = new RegExp(phaseCheckboxLinePattern(), 'i');
  let lastCheckboxIdx = -1;
  for (let i = first; i < lines.length; i++) {
    if (anyCheckbox.test(lines[i])) {
      lastCheckboxIdx = i;
    }
  }

  if (lastCheckboxIdx >= 0) {
    lines.splice(lastCheckboxIdx + 1, 0, checkboxLine);
    return lines.join('\n');
  }

  // This milestone has no phase list yet. The list belongs above the detail
  // sections; returning the content untouched instead left `phase add`
  // reporting a phase that the roadmap never listed.
  const headerPattern = /^#{2,4}\s*Phase\s+\d/i;
  for (let i = first; i < lines.length; i++) {
    if (headerPattern.test(lines[i])) {
      lines.splice(i, 0, checkboxLine, '');
      return lines.join('\n');
    }
  }

  lines.push(checkboxLine);
  return lines.join('\n');
}

// Locked: the new phase number is the highest one this read of the roadmap can
// see. An unserialised writer landing in between takes the whole new section and
// its checkbox with it, and nothing recomputes them afterwards.
function cmdPhaseAdd(cwd, description) {
  if (!description) {
    error('description required for phase add');
  }

  return withRoadmapLock(cwd, () => {
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

    writeFileAtomic(roadmapPath, updatedContent);

    const result = {
      phase_number: newPhaseNum,
      padded: paddedNum,
      name: description,
      slug,
      directory: `.planning/phases/${dirName}`,
    };

    output(result, paddedNum);
  });
}

// Locked for the same reason as phase add: an inserted section and its checkbox
// are new content, not a recomputed field, so a racing whole-file write erases
// them for good.
function cmdPhaseInsert(cwd, afterPhase, description) {
  if (!afterPhase || !description) {
    error('after-phase and description required for phase insert');
  }

  return withRoadmapLock(cwd, () => {
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

    writeFileAtomic(roadmapPath, updatedContent);

    const result = {
      phase_number: decimalPhase,
      after_phase: afterPhase,
      name: description,
      slug,
      directory: `.planning/phases/${dirName}`,
    };

    output(result, decimalPhase);
  });
}

// True when the current milestone still names an integer phase above
// `removedInt`, by header or by checkbox. That is what the renumbering exists to
// rewrite, so a renumbering that changed nothing while one is present has missed
// its target. Called with the whole current milestone rather than the write
// scope, for the reason the other probes are: a phase above a collapsed section
// is a target the renumbering cannot reach, not one it has no business reaching.
function namesPhaseAbove(region, removedInt) {
  const headerPattern = /^#{2,4}\s*Phase\s+(\d+)/gim;
  const numbers = [];
  let m;
  while ((m = headerPattern.exec(region)) !== null) {
    numbers.push(parseInt(m[1], 10));
  }
  for (const entry of parsePhaseCheckboxes(region)) {
    numbers.push(parseInt(entry.num, 10));
  }
  return numbers.some((n) => Number.isFinite(n) && n > removedInt);
}

/**
 * Phase identifiers a roadmap's live milestones name more than once.
 *
 * Headings and checkbox items are counted in separate namespaces: one phase
 * legitimately has both, but not two headings or two checkboxes. Identifiers are
 * compared unpadded, so a padded spelling and a bare one of the same number are
 * one phase named twice — which is the point, since a partial renumbering
 * produces exactly that.
 *
 * @returns {string[]} the duplicated identifiers, unpadded and sorted
 */
function duplicatePhaseIds(content) {
  const milestone = extractCurrentMilestone(content);
  const headings = [];
  const headingPattern = /^#{2,4}\s*Phase\s+(\d+[A-Za-z]?(?:\.\d+)*)/gim;
  let m;
  while ((m = headingPattern.exec(milestone)) !== null) headings.push(m[1]);

  const duplicates = new Set();
  for (const group of [
    headings,
    parsePhaseCheckboxes(milestone).map((entry) => entry.num),
  ]) {
    const seen = new Set();
    for (const raw of group) {
      const id = String(raw)
        .replace(/^0+(?=\d)/, '')
        .toUpperCase();
      if (seen.has(id)) duplicates.add(id);
      seen.add(id);
    }
  }
  return [...duplicates].sort();
}

// How much text either side of a number can decide whether it is a phase
// reference. The longest shape below — a bolded dependency label and the word
// Phase — is under thirty characters, so this is generous rather than a limit.
const RENUMBER_CONTEXT_CHARS = 64;

/**
 * Shift every reference to a phase above `removedInt` down by one.
 *
 * One pass over the digit runs, each judged by the text as it was read and
 * rewritten at most once. Rewriting in a pass per source number, walking down
 * from the highest, re-read its own output: a reference lowered to N by the pass
 * for N+1 was lowered again by the pass for N, and again by the pass below that,
 * so every phase above the removed one collapsed onto the removed one's number.
 *
 * Zero-padding is preserved at the width it was found, so a roadmap that pads
 * its phase numbers to two digits goes on doing so and one that writes them bare
 * is not padded against its will. Reaching only the bare spelling left every
 * padded reference pointing at whichever phase now holds its old number.
 */
function renumberPhaseReferences(text, removedInt) {
  const shift = (written) => {
    const num = parseInt(written, 10);
    if (!Number.isFinite(num) || num <= removedInt) return null;
    const next = String(num - 1);
    return written.startsWith('0') ? next.padStart(written.length, '0') : next;
  };

  const isPhaseReference = (written, before, after) => {
    // A section heading, and the bare `Phase N:` / `Phase N ` that covers
    // checkbox items, dependency lines and prose alike.
    if (/#{2,4}\s*Phase\s+$/i.test(before) && /^\s*:/.test(after)) return true;
    if (/Phase\s+$/.test(before) && /^[:\s]/.test(after)) return true;
    // A progress-table row: `| N. Name`.
    if (/\|\s*$/.test(before) && /^\.\s/.test(after)) return true;
    // A dependency whose number ends the line, which the shapes above miss.
    if (
      /Depends on:\*\*\s*Phase\s+$/i.test(before) &&
      !/^[A-Za-z0-9_]/.test(after)
    ) {
      return true;
    }
    // A plan reference, `18-01`. A preceding digit, dot or hyphen disqualifies
    // it, or the rewrite walks into dates and version-like tokens: 2020-01-01,
    // `ref 3.14-05`, `version 1.05-01`. The trailing side stays open to a hyphen
    // so that 18-01-PLAN.md is still a plan reference.
    return (
      written.length === 2 &&
      !/[\d.-]$/.test(before) &&
      /^-\d{2}(?!\d)/.test(after)
    );
  };

  return text.replace(/\d+/g, (written, index) => {
    const before = text.slice(
      Math.max(0, index - RENUMBER_CONTEXT_CHARS),
      index,
    );
    const end = index + written.length;
    const after = text.slice(end, end + RENUMBER_CONTEXT_CHARS);
    if (!isPhaseReference(written, before, after)) return written;
    const next = shift(written);
    return next === null ? written : next;
  });
}

// Unlike phase-close, a re-run is not a repair here: the renumbering shifts what
// every later phase is called, so the second run's target number names a
// different phase than the first run's did. Saying so is the whole point of
// reporting what landed.
const PHASE_REMOVE_RETRY_HINT =
  'Re-running `phase remove` is not a repair: the renumbering has already ' +
  'shifted what the later phases are called, so the same number now names a ' +
  'different phase. Reconcile .planning/phases/ against ROADMAP.md and ' +
  'STATE.md by hand.';

// Locked over the directory work as well as the rewrite: the renumbering is
// driven by what is on disk, and a roadmap written from a pre-renumbering read
// would name phases that no longer exist under those numbers.
function cmdPhaseRemove(cwd, targetPhase, options) {
  if (!targetPhase) {
    error('phase number required for phase remove');
  }

  // Collected inside the locked body and read by the catch outside it: what a
  // failure partway through has already written.
  const applied = [];

  try {
    return withRoadmapLock(cwd, () => {
      const { roadmap: roadmapPath, phases: phasesDir } = planningPaths(cwd);
      const force = options.force || false;

      if (!fs.existsSync(roadmapPath)) {
        error('ROADMAP.md not found');
      }

      // Normalize the target
      const normalized = normalizePhaseName(targetPhase);
      const isDecimal = targetPhase.includes('.');
      // Read before anything is deleted, so the existence check below sees the
      // document as it stood.
      const roadmapBeforeAnything = fs.readFileSync(roadmapPath, 'utf-8');

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

      // A phase with no directory that the current milestone names nowhere does
      // not exist, and removing it is nothing. Falling through decremented the
      // phase count for a phase that was never counted — a number that was never
      // true — and reported the write as an update.
      const namedInRoadmap =
        hasPhaseHeader(roadmapBeforeAnything, targetPhase) ||
        hasPhaseTableRow(roadmapBeforeAnything, targetPhase) ||
        parsePhaseCheckboxes(
          extractCurrentMilestone(roadmapBeforeAnything),
        ).some((entry) => comparePhaseNum(entry.num, targetPhase) === 0);

      if (!targetDir && !namedInRoadmap) {
        output({
          removed: null,
          found: false,
          directory_deleted: null,
          renamed_directories: [],
          renamed_files: [],
          roadmap_updated: false,
          roadmap_landed: [],
          roadmap_missed_targets: [],
          roadmap_withheld: [],
          roadmap_withheld_hint: null,
          state_updated: false,
        });
        return;
      }

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
        applied.push(`.planning/phases/${targetDir} deleted`);
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
              toRename.push({
                dir,
                oldDecimal: parseInt(dm[1], 10),
                slug: dm[2],
              });
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
            const decimalSuffix =
              item.decimal !== null ? `.${item.decimal}` : '';
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

      if (renamedDirs.length > 0) {
        applied.push(
          `${renamedDirs.length} directory renumbering(s) under .planning/phases/`,
        );
      }

      // Update ROADMAP.md. Every rewrite here is scoped to the current milestone and
      // checked for landing: unscoped, the removals deleted a same-numbered phase
      // out of an archived milestone section, and unchecked they reported success
      // having matched nothing.
      let roadmapContent = fs.readFileSync(roadmapPath, 'utf-8');
      const roadmapBefore = roadmapContent;
      const roadmapLanded = [];
      const roadmapMissed = [];
      const roadmapWithheld = [];
      let roadmapWithheldHint = null;

      // Remove the target phase section
      const targetEscaped = phaseNumPattern(targetPhase);
      const sectionPattern = new RegExp(
        `\\n?#{2,4}\\s*Phase\\s+${targetEscaped}\\s*:[\\s\\S]*?(?=\\n#{2,4}\\s+Phase\\s+\\d+[A-Z]?(?:\\.\\d+)*|$)`,
        'i',
      );
      const section = replaceInCurrentMilestone(
        roadmapContent,
        sectionPattern,
        '',
      );
      roadmapContent = section.content;
      if (section.changed) roadmapLanded.push('phase-section');
      else if (hasPhaseHeader(roadmapBefore, targetPhase))
        roadmapMissed.push('phase-section');

      // Remove from phase list (checkbox)
      const checkboxPattern = new RegExp(
        String.raw`\n?` + phaseCheckboxPattern(targetPhase),
        'gi',
      );
      const checkbox = replaceInCurrentMilestone(
        roadmapContent,
        checkboxPattern,
        '',
      );
      roadmapContent = checkbox.content;
      if (checkbox.changed) roadmapLanded.push('phase-checkbox');
      else if (!isPhaseCheckboxSatisfied(roadmapBefore, targetPhase))
        roadmapMissed.push('phase-checkbox');

      // Remove from progress table
      const tableRowPattern = new RegExp(
        `\\n?\\|\\s*${targetEscaped}\\.?\\s[^|]*\\|[^\\n]*`,
        'gi',
      );
      const tableRow = replaceInCurrentMilestone(
        roadmapContent,
        tableRowPattern,
        '',
      );
      roadmapContent = tableRow.content;
      if (tableRow.changed) roadmapLanded.push('progress-table');
      else if (hasPhaseTableRow(roadmapBefore, targetPhase))
        roadmapMissed.push('progress-table');

      // Renumber references in ROADMAP for subsequent phases. Applied to the
      // current milestone slice only — over the whole document it renumbered
      // archived milestone sections and mangled the dates in their progress tables.
      //
      // The renumbering is the only rewrite here that can give two phases the
      // same number: the removals only delete. So that is where the consistency
      // of the result is decided, and it is refused outright in the two cases
      // that produce a duplicate, rather than written and reported afterwards.
      if (!isDecimal) {
        const removedInt = parseInt(normalized, 10);
        const offset = currentMilestoneOffset(roadmapContent);
        const head = roadmapContent.slice(0, offset);
        const tailBefore = roadmapContent.slice(offset);
        // Over the whole current milestone, not the write scope: a phase above a
        // collapsed section is a target the renumbering cannot reach, and read
        // scoped like the rewrite it was reported clean.
        const namesAbove = namesPhaseAbove(
          extractCurrentMilestone(roadmapContent),
          removedInt,
        );

        // A renumbering compensates for a removal that happened. Applied on top
        // of one that did not, it shifts the next phase onto the number the
        // document still uses for the phase being removed.
        if (roadmapMissed.length > 0) {
          if (namesAbove) {
            roadmapWithheld.push('renumber');
            roadmapWithheldHint =
              `Renumbering was withheld: ROADMAP.md still names the removed ` +
              `phase (${roadmapMissed.join(', ')}), and shifting the later ` +
              `phases down on top of that would give two phases the same ` +
              `number. The phase directories have been renumbered, so ` +
              `ROADMAP.md now names phases by their old numbers — fix the ` +
              `unreachable reference and reconcile ROADMAP.md by hand.`;
          }
        } else {
          const tail = renumberPhaseReferences(tailBefore, removedInt);
          const candidate = head + tail;
          // Only duplicates this rewrite would introduce count. A roadmap that
          // already names a phase twice is not made worse by leaving it alone,
          // and refusing to renumber it forever is not a fix.
          const before = duplicatePhaseIds(roadmapContent);
          const introduced = duplicatePhaseIds(candidate).filter(
            (id) => !before.includes(id),
          );

          if (introduced.length > 0) {
            roadmapWithheld.push('renumber');
            roadmapWithheldHint =
              `Renumbering was withheld: applying it would have named phase ` +
              `${introduced.join(', ')} twice in ROADMAP.md, because some ` +
              `reference to it is written in a shape the rewrite cannot reach. ` +
              `The phase directories have been renumbered, so ROADMAP.md now ` +
              `names phases by their old numbers — reconcile it by hand.`;
          } else {
            roadmapContent = candidate;
            if (tail !== tailBefore) roadmapLanded.push('renumber');
            else if (namesAbove) roadmapMissed.push('renumber');
          }
        }
      }

      if (roadmapLanded.length > 0) {
        writeFileAtomic(roadmapPath, roadmapContent);
        applied.push(`ROADMAP.md (${roadmapLanded.join(', ')})`);
      }

      // Update STATE.md phase count. Locked across the read: the new count is the
      // count this reads minus one, so a read that loses its window does not just
      // drop a concurrent writer's entry, it writes a number that was never true.
      const statePath = planningPaths(cwd).state;
      if (fs.existsSync(statePath)) {
        withStateLock(cwd, () => {
          let stateContent = fs.readFileSync(statePath, 'utf-8');
          // Update "Total Phases" field. stateReplaceField rewrites the whole value,
          // so anything trailing the count — "7 phases" — is carried over rather than
          // dropped.
          const totalRaw = stateExtractField(stateContent, 'Total Phases');
          const totalMatch = totalRaw && totalRaw.match(/^(\d+)(.*)$/);
          if (totalMatch) {
            const newTotal = parseInt(totalMatch[1], 10) - 1;
            stateContent =
              stateReplaceField(
                stateContent,
                'Total Phases',
                `${newTotal}${totalMatch[2]}`,
              ) || stateContent;
          }
          // Update "Phase: X of Y" pattern
          const ofPattern = /(\bof\s+)(\d+)(\s*(?:\(|phases?))/i;
          const ofMatch = stateContent.match(ofPattern);
          if (ofMatch) {
            const oldTotal = parseInt(ofMatch[2], 10);
            stateContent = stateContent.replace(
              ofPattern,
              `$1${oldTotal - 1}$3`,
            );
          }
          writeStateMd(statePath, stateContent, cwd);
        });
      }

      const result = {
        removed: targetPhase,
        found: true,
        directory_deleted: targetDir || null,
        renamed_directories: renamedDirs,
        renamed_files: renamedFiles,
        roadmap_updated: roadmapLanded.length > 0,
        roadmap_landed: roadmapLanded,
        roadmap_missed_targets: roadmapMissed,
        roadmap_withheld: roadmapWithheld,
        roadmap_withheld_hint: roadmapWithheldHint,
        state_updated: fs.existsSync(statePath),
      };

      output(result);
    });
  } catch (err) {
    throw notePartialWrites(err, applied, PHASE_REMOVE_RETRY_HINT);
  }
}

// Every rewrite here is a recomputation from what is on disk — the checkbox, the
// progress row, the plan count and the position all follow from the summaries
// present — so re-running after a failure converges on the same result rather
// than compounding it. That is what makes naming what landed a sufficient
// remedy, and it is what this sentence promises the operator.
const PHASE_COMPLETE_RETRY_HINT =
  'Every field this writes is recomputed from what is on disk, so `phase ' +
  'complete` is safe to re-run: clear the cause and run it again to finish the ' +
  'updates that did not land.';

// Locked even though phase-close runs after every executor in the phase has
// returned: that ordering is a workflow convention, not something the command
// enforces, and `gsd-tools phase complete` run by hand against a phase whose
// last wave is still finishing would tick the checkbox and fill the completion
// date from a read a straggler's update-plan-progress then writes over. It reads
// the roadmap twice — once to rewrite it, once to find the next phase — and the
// lock also makes those two reads agree.
//
// The state lock is taken where STATE.md is written and not one line earlier, so
// a failure between the two writes leaves ROADMAP.md updated and STATE.md not.
// Taking both up front would narrow that window without closing it — the writes
// are to different files and no lock makes a pair of them atomic, so an I/O
// error or a crash produces the same half-applied result — while every executor
// calling `state record-metric` in parallel would then queue behind this whole
// body, requirement collection and all. The window is reported instead, by
// notePartialWrites below.
function cmdPhaseComplete(cwd, phaseNum) {
  if (!phaseNum) {
    error('phase number required for phase complete');
  }

  // Collected inside the locked body and read by the catch outside it: what a
  // failure partway through has already written.
  const applied = [];

  try {
    return withRoadmapLock(cwd, () => {
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
      const roadmapLanded = [];
      const roadmapMissed = [];

      // Update ROADMAP.md: mark phase complete
      if (fs.existsSync(roadmapPath)) {
        roadmapContent = fs.readFileSync(roadmapPath, 'utf-8');

        // Checkbox: - [ ] Phase N: → - [x] Phase N: (...completed DATE)
        const checkboxPattern = new RegExp(
          phaseCheckboxPattern(phaseNum, '[ ]'),
          'i',
        );
        const checkbox = replaceInCurrentMilestone(
          roadmapContent,
          checkboxPattern,
          `$1x$3 (completed ${today})`,
        );
        roadmapContent = checkbox.content;
        if (checkbox.changed) roadmapLanded.push('phase-checkbox');
        else if (!isPhaseCheckboxSatisfied(roadmapContent, phaseNum, '[ ]'))
          roadmapMissed.push('phase-checkbox');

        // Progress table: update Status to Complete, add date (handles 4 or 5 column tables)
        const phaseEscaped = phaseNumPattern(phaseNum);
        const tableRowPattern = new RegExp(
          `^(\\|\\s*${phaseEscaped}\\.?\\s[^|]*(?:\\|[^\\n]*)*)$`,
          'im',
        );
        const tableRow = replaceInCurrentMilestone(
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
        roadmapContent = tableRow.content;
        if (tableRow.changed) roadmapLanded.push('progress-table');
        else if (hasPhaseTableRow(roadmapContent, phaseNum))
          roadmapMissed.push('progress-table');

        // Update plan count in phase section
        const planCountPattern = new RegExp(
          phaseFieldPattern(phaseEscaped, 'Plans'),
          'i',
        );
        const plansLine = replaceInCurrentMilestone(
          roadmapContent,
          planCountPattern,
          `$1${summaryCount}/${planCount} plans complete`,
        );
        roadmapContent = plansLine.content;
        if (plansLine.changed) roadmapLanded.push('plans-line');
        else if (hasPhasePlansLine(roadmapContent, phaseNum))
          roadmapMissed.push('plans-line');

        if (roadmapLanded.length > 0) {
          writeFileAtomic(roadmapPath, roadmapContent);
          applied.push(`ROADMAP.md (${roadmapLanded.join(', ')})`);
        }
      }

      // ── Requirement closure ───────────────────────────────────────────────────
      // Gated on the verifier's assessment: VERIFICATION.md is the completion
      // authority everywhere in GSD (see getPhaseCompletionStatus).
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
      let requirementsUnreadableRows = [];
      let requirementsBlockedRows = [];
      let requirementsOtherPhase = [];
      let requirementsUnmapped = [];
      let requirementsUndeclared = [];
      let requirementsUnreadableSummaries = [];
      let requirementsEmptySummaries = [];
      let requirementsNarrowedSummaries = [];
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
        if (closure.updated) {
          applied.push('REQUIREMENTS.md (traceability rows and checkboxes)');
        }
        requirementIds = closure.closed;
        requirementsBlockedRows = closure.blocked;
        requirementsUnreadableRows = closure.unreadable;
        requirementsOtherPhase = closure.otherPhase;
        requirementsUnmapped = closure.unmapped;
        requirementsUndeclared = collected.undeclared;
        requirementsUnreadableSummaries = collected.unreadableSummaries;
        requirementsEmptySummaries = collected.emptySummaries;
        requirementsNarrowedSummaries = collected.narrowedSummaries;
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
      // Union of two sources:
      //   1. Header pattern: `### Phase N: Title` (post-planning, when Details section exists)
      //   2. Checkbox lines (pre-planning, bullet-only entry), read through the
      //      shared helper so both supported forms — bare and bold — are seen here.
      // Note on normalization: the header pattern returns whatever is written (e.g. '06'),
      // while the checkbox returns whatever is written (e.g. '6'). We do NOT pad here —
      // comparePhaseNum handles both forms semantically. When both a header and bullet reference
      // the same phase, the header entry is preferred (via sort-stable dedup).
      if (isLastPhase && fs.existsSync(roadmapPath)) {
        try {
          const roadmapForPhases = extractCurrentMilestone(
            fs.readFileSync(roadmapPath, 'utf-8'),
          );
          const headerPattern =
            /#{2,4}\s*Phase\s+(\d+[A-Z]?(?:\.\d+)*)\s*:\s*([^\n]+)/gi;

          const candidates = [];
          let pm;
          while ((pm = headerPattern.exec(roadmapForPhases)) !== null) {
            candidates.push({ index: pm.index, num: pm[1], name: pm[2] });
          }
          for (const entry of parsePhaseCheckboxes(roadmapForPhases)) {
            candidates.push({
              index: entry.index,
              num: entry.num,
              name: entry.name || '',
            });
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
              nextPhaseName =
                c.name
                  .replace(/\(INSERTED\)/i, '')
                  .trim()
                  .toLowerCase()
                  .replace(/\s+/g, '-') || null;
              isLastPhase = false;
              break;
            }
          }
        } catch {}
      }

      // Update STATE.md. Locked for the same reason the roadmap write above is:
      // the position and status written here are computed from a read of the file
      // being replaced, so an executor's metric or decision landing in that window
      // is discarded with success reported for both.
      let stateFieldsUpdated = [];
      let stateFieldsMissing = [];
      if (fs.existsSync(statePath)) {
        withStateLock(cwd, () => {
          const stateContent = fs.readFileSync(statePath, 'utf-8');
          const applied = stateReplaceFields(stateContent, [
            ['Current Phase', nextPhaseNum || phaseNum],
            [
              'Current Phase Name',
              nextPhaseName ? nextPhaseName.replace(/-/g, ' ') : null,
            ],
            ['Status', isLastPhase ? 'Milestone complete' : 'Ready to plan'],
            ['Current Plan', 'Not started'],
            ['Last Activity', today],
            [
              'Last Activity Description',
              `Phase ${phaseNum} complete${nextPhaseNum ? `, transitioned to Phase ${nextPhaseNum}` : ''}`,
            ],
          ]);
          stateFieldsUpdated = applied.updated;
          stateFieldsMissing = applied.missing;
          writeStateMd(statePath, applied.content, cwd);
        });
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
        roadmap_updated: roadmapLanded.length > 0,
        roadmap_missed_targets: roadmapMissed,
        state_updated: fs.existsSync(statePath),
        state_fields_updated: stateFieldsUpdated,
        state_fields_missing: stateFieldsMissing,
        requirements_updated: requirementsUpdated,
        requirements_closed: requirementIds,
        requirements_blocked_rows: requirementsBlockedRows,
        requirements_unreadable_rows: requirementsUnreadableRows,
        requirements_other_phase: requirementsOtherPhase,
        requirements_unmapped: requirementsUnmapped,
        requirements_undeclared: requirementsUndeclared,
        requirements_unreadable_summaries: requirementsUnreadableSummaries,
        requirements_empty_summaries: requirementsEmptySummaries,
        requirements_narrowed_summaries: requirementsNarrowedSummaries,
        verification_status: verificationStatus,
        verification_stale: verificationStale,
        verification_stale_summaries: staleSummaries,
        requirements_blocked_by: requirementsBlockedBy,
        requirements_blocked_hint: requirementsBlockedHint,
      };

      output(result);
    });
  } catch (err) {
    throw notePartialWrites(err, applied, PHASE_COMPLETE_RETRY_HINT);
  }
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
