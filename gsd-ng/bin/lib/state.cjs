/**
 * State — STATE.md operations and progression engine
 */

const fs = require('fs');
const path = require('path');
const {
  loadConfig,
  resolveTargetBranch,
  findPhaseInternal,
  getMilestoneInfo,
  getMilestonePhaseFilter,
  getPhaseCompletionStatus,
  output,
  error,
  planningPaths,
  readTextArgOrFile,
  writeFileAtomic,
} = require('./core.cjs');
const {
  extractFrontmatter,
  reconstructFrontmatter,
} = require('./frontmatter.cjs');
const {
  scanForInjection,
  sanitizeForPrompt,
  securityWarningFor,
} = require('./security.cjs');

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Match one markdown section: group 1 is the heading line, group 2 the body.
 *
 * The header group ends at the heading's own newline. A trailing \s* there eats
 * the blank line after it, and an empty section body then cannot see the \n##
 * that terminates it — the lazy body runs on into the next section, which a
 * reader reports as its own and a writer replaces. Every section matcher in this
 * file is built here so that shape cannot come back at one site.
 *
 * namePattern is a regex fragment, not a literal — callers pass alternations.
 * The terminator stops at any heading of level 2 or deeper.
 */
function sectionPattern(namePattern, level = '##') {
  return new RegExp(
    `(${level}[ \\t]*${namePattern}[ \\t]*\\r?\\n)([\\s\\S]*?)(?=\\r?\\n#{2}|$)`,
    'i',
  );
}

/**
 * Match a section whose body is the rows of a markdown table: group 1 runs to the
 * end of the separator row, group 2 holds the rows. The run between heading and
 * table cannot cross a heading, so an empty section never adopts a later table.
 */
function tableSectionPattern(namePattern) {
  return new RegExp(
    `(##[ \\t]*${namePattern}[ \\t]*\\r?\\n(?:(?!\\r?\\n#{2})[\\s\\S])*?\\|[^\\n]+\\r?\\n\\|[-|: \\t]+\\r?\\n)([\\s\\S]*?)(?=\\r?\\n#{2}|$)`,
    'i',
  );
}

const BLOCKER_HEADINGS = '(?:Blockers|Blockers/Concerns|Concerns)';

const QUICK_TASKS_HEADING = /###[ \t]*Quick Tasks Completed[ \t]*\r?\n/i;

/**
 * Index of the table header row within the lines following a heading, or -1 when
 * the section holds no table. Stops at the next heading: an unbounded scan reads
 * and migrates a table that belongs to a later section.
 */
function findTableHeaderIndex(lines) {
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trimStart();
    if (line.startsWith('#')) return -1;
    if (line.startsWith('|')) return i;
  }
  return -1;
}

function cmdStateLoad(cwd) {
  const config = loadConfig(cwd);
  const {
    state: stateMdPath,
    config: configPath,
    roadmap: roadmapPath,
  } = planningPaths(cwd);

  let stateRaw = '';
  try {
    stateRaw = fs.readFileSync(stateMdPath, 'utf-8');
  } catch {}

  const configExists = fs.existsSync(configPath);
  const roadmapExists = fs.existsSync(roadmapPath);
  const stateExists = stateRaw.length > 0;

  // Scan-on-read: sanitize STATE.md content before returning to callers.
  // Never blocks — prepends [SECURITY WARNING:...] prefix if injection detected.
  const result = {
    config,
    state_raw: sanitizeForPrompt(stateRaw),
    state_exists: stateExists,
    roadmap_exists: roadmapExists,
    config_exists: configExists,
  };

  output(result);
}

/**
 * Parse markdown section content into structured data.
 * - Bullet lists (- item) -> array of strings
 * - Key: value lines -> object of key-value pairs
 * - Mixed content -> { items: [], fields: {}, text: string }
 */
function parseSectionContent(content) {
  const lines = content.split('\n');
  const items = [];
  const fields = {};
  const textLines = [];
  let hasItems = false;
  let hasFields = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // Bullet list item: - text or * text
    const bulletMatch = trimmed.match(/^[-*]\s+(.+)/);
    if (bulletMatch) {
      items.push(bulletMatch[1].trim());
      hasItems = true;
      continue;
    }

    // Key: value pair (but not markdown headers ##)
    const kvMatch = trimmed.match(/^([^#|\-*][^:]{0,60}):\s+(.+)/);
    if (kvMatch) {
      fields[kvMatch[1].trim()] = kvMatch[2].trim();
      hasFields = true;
      continue;
    }

    textLines.push(trimmed);
  }

  // Return the simplest useful structure
  if (hasItems && !hasFields && textLines.length === 0) {
    return items; // Pure bullet list -> array
  }
  if (hasFields && !hasItems && textLines.length === 0) {
    return fields; // Pure key-value -> object
  }
  // Mixed content
  const result = {};
  if (hasItems) result.items = items;
  if (hasFields) result.fields = fields;
  if (textLines.length > 0) result.text = textLines.join('\n');
  return Object.keys(result).length > 0 ? result : content; // Fallback to raw string if nothing parsed
}

function cmdStateGet(cwd, section) {
  const { state: statePath } = planningPaths(cwd);

  if (!section) {
    // No section arg: delegate to cmdStateSnapshot (already returns structured JSON)
    return cmdStateSnapshot(cwd);
  }

  try {
    const content = fs.readFileSync(statePath, 'utf-8');
    const fieldEscaped = escapeRegex(section);

    // Check for **field:** value (bold format)
    const boldPattern = new RegExp(`\\*\\*${fieldEscaped}:\\*\\*\\s*(.*)`, 'i');
    const boldMatch = content.match(boldPattern);
    if (boldMatch) {
      const value = sanitizeForPrompt(boldMatch[1].trim());
      output({ [section]: value }, value);
      return;
    }

    // Check for field: value (plain format)
    const plainPattern = new RegExp(`^${fieldEscaped}:\\s*(.*)`, 'im');
    const plainMatch = content.match(plainPattern);
    if (plainMatch) {
      const value = sanitizeForPrompt(plainMatch[1].trim());
      output({ [section]: value }, value);
      return;
    }

    // Check for ## Section -- parse into structured data
    const sectionMatch = content.match(sectionPattern(fieldEscaped));
    if (sectionMatch) {
      const sectionContent = sectionMatch[2].trim();
      // Parse the untrusted body before attaching the banner: parseSectionContent
      // reads the banner's own "key: value" shape as a field and swallows the
      // `[SECURITY WARNING:` marker callers match on.
      const warning = securityWarningFor(sectionContent);
      const structured = parseSectionContent(sectionContent);
      const display = JSON.stringify(structured);
      output(
        warning
          ? { [section]: structured, security_warning: warning }
          : { [section]: structured },
        warning ? `${warning}\n\n${display}` : display,
      );
      return;
    }

    output({ error: `Section or field "${section}" not found` }, '');
  } catch {
    error('STATE.md not found');
  }
}

function cmdStatePatch(cwd, patches) {
  const { state: statePath } = planningPaths(cwd);
  try {
    let content = fs.readFileSync(statePath, 'utf-8');
    const applied = stateReplaceFields(content, Object.entries(patches));
    content = applied.content;
    const results = { updated: applied.updated, failed: applied.missing };

    if (results.updated.length > 0) {
      writeStateMd(statePath, content, cwd);
    }

    if (results.updated.length === 0 && results.failed.length > 0) {
      error(`All patches failed: ${results.failed.join(', ')}`);
    }

    output(results, results.updated.length > 0 ? 'true' : 'false');
  } catch {
    error('STATE.md not found');
  }
}

function cmdStateUpdate(cwd, field, value) {
  if (!field || value === undefined) {
    error('field and value required for state update');
  }

  const { state: statePath } = planningPaths(cwd);
  try {
    let content = fs.readFileSync(statePath, 'utf-8');
    const result = stateReplaceField(content, field, value);
    if (result !== null) {
      writeStateMd(statePath, result, cwd);
      // Post-write verification: read back and confirm value persisted
      const written = fs.readFileSync(statePath, 'utf-8');
      const readBack = stateExtractField(written, field);
      if (readBack !== null && readBack.trim() === String(value).trim()) {
        output({ updated: true });
      } else {
        output({ updated: false, reason: 'value did not persist after write' });
        process.exitCode = 1;
      }
    } else {
      output({
        updated: false,
        reason: `Field "${field}" not found in STATE.md`,
      });
    }
  } catch {
    output({ updated: false, reason: 'STATE.md not found' });
  }
}

// ─── State Progression Engine ────────────────────────────────────────────────

function stateExtractField(content, fieldName) {
  const body = stripFrontmatter(content);
  const escaped = fieldName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Try **Field:** bold format first
  const boldPattern = new RegExp(`\\*\\*${escaped}:\\*\\*\\s*(.+)`, 'i');
  const boldMatch = body.match(boldPattern);
  if (boldMatch) return boldMatch[1].trim();
  // Fall back to plain Field: format
  const plainPattern = new RegExp(`^${escaped}:\\s*(.+)`, 'im');
  const plainMatch = body.match(plainPattern);
  return plainMatch ? plainMatch[1].trim() : null;
}

function stateReplaceField(content, fieldName, newValue) {
  const frontmatterMatch = content.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n*/);
  const frontmatter = frontmatterMatch ? frontmatterMatch[0] : '';
  const body = frontmatterMatch
    ? content.slice(frontmatterMatch[0].length)
    : content;
  const escaped = fieldName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Try **Field:** bold format first, then plain Field: format
  const boldPattern = new RegExp(`(\\*\\*${escaped}:\\*\\*\\s*)(.*)`, 'i');
  if (boldPattern.test(body)) {
    return (
      frontmatter +
      body.replace(boldPattern, (_match, prefix) => `${prefix}${newValue}`)
    );
  }
  const plainPattern = new RegExp(`(^${escaped}:\\s*)(.*)`, 'im');
  if (plainPattern.test(body)) {
    return (
      frontmatter +
      body.replace(plainPattern, (_match, prefix) => `${prefix}${newValue}`)
    );
  }
  return null;
}

/**
 * Apply several field updates in one pass, reporting which labels were found.
 *
 * Every STATE.md writer goes through here so a field cannot be supported in the
 * bold form and missed in the plain one — the split that left `phase complete`
 * updating some fields of a template-shaped STATE.md and silently skipping the
 * rest. `missing` lets callers report a rewrite that did not land instead of
 * unconditional success.
 *
 * Entries with a null or undefined value are skipped, not reported missing.
 */
function stateReplaceFields(content, fields) {
  let result = content;
  const updated = [];
  const missing = [];
  for (const [field, value] of fields) {
    if (value === undefined || value === null) continue;
    const next = stateReplaceField(result, field, value);
    if (next === null) {
      missing.push(field);
    } else {
      result = next;
      updated.push(field);
    }
  }
  return { content: result, updated, missing };
}

/**
 * Replace a field in STATE.md content, appending it if absent.
 * Uses bold format (**fieldName:** value) for appended fields to match STATE.md conventions.
 * Use stateReplaceField directly when field-must-exist is correct behavior.
 */
function stateReplaceFieldWithFallback(content, fieldName, newValue) {
  const result = stateReplaceField(content, fieldName, newValue);
  if (result !== null) return result;
  return content.trimEnd() + '\n**' + fieldName + ':** ' + newValue + '\n';
}

/**
 * Apply a set of fields, adding the ones the file does not carry to a section.
 *
 * Same replace pass as stateReplaceFields; the difference is where a missing
 * field lands. stateReplaceFieldWithFallback appends at end of file, which for
 * Current Position fields puts them after Session Continuity. Writing them into
 * the section that owns them keeps the file in the canonical shape a later
 * writer can find. Falls back to end of file when the section is absent.
 */
function stateApplyFieldsToSection(content, sectionName, fields) {
  const applied = stateReplaceFields(content, fields);
  let result = applied.content;
  const added = [];
  for (const [field, value] of fields) {
    if (!applied.missing.includes(field)) continue;
    result = stateAppendFieldToSection(result, sectionName, field, value);
    added.push(field);
  }
  return { content: result, updated: applied.updated, added };
}

function stateAppendFieldToSection(content, sectionName, fieldName, value) {
  const frontmatterMatch = content.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n*/);
  const frontmatter = frontmatterMatch ? frontmatterMatch[0] : '';
  const body = frontmatterMatch
    ? content.slice(frontmatterMatch[0].length)
    : content;
  const pattern = sectionPattern(escapeRegex(sectionName));
  if (!pattern.test(body)) {
    return stateReplaceFieldWithFallback(content, fieldName, value);
  }
  const line = `**${fieldName}:** ${value}`;
  return (
    frontmatter +
    body.replace(pattern, (_match, header, sectionBody) => {
      const eol = header.endsWith('\r\n') ? '\r\n' : '\n';
      return `${header}${sectionBody.replace(/\s*$/, '')}${eol}${line}${eol}`;
    })
  );
}

/**
 * Count completed plans for a phase by counting SUMMARY files on disk.
 *
 * Returns null when the phase cannot be located, which lets callers fall back
 * to whatever STATE.md claims — projects without on-disk phase directories
 * still advance by incrementing the stored value.
 */
function countCompletedPlansOnDisk(cwd, phaseRef) {
  if (!phaseRef) return null;
  try {
    const info = findPhaseInternal(cwd, phaseRef);
    if (!info || !info.found) return null;
    return info.summaries.length;
  } catch {
    return null;
  }
}

/**
 * Render a plan position using the same shape as the value already in STATE.md:
 * ("02-08", 9) -> "02-09", ("08", 9) -> "09", ("8", 9) -> "9".
 * Returns null when the existing value is not a recognized numeric form.
 */
function formatPlanPosition(existingValue, planNumber) {
  const formatMatch = existingValue && existingValue.match(/^(\d+-)?(\d+)$/);
  if (!formatMatch) return null;
  const prefix = formatMatch[1] || '';
  const width = formatMatch[2].length;
  return `${prefix}${String(planNumber).padStart(width, '0')}`;
}

function cmdStateAdvancePlan(cwd) {
  const { state: statePath } = planningPaths(cwd);
  if (!fs.existsSync(statePath)) {
    output({ error: 'STATE.md not found' });
    return;
  }

  let content = fs.readFileSync(statePath, 'utf-8');
  const today = new Date().toISOString().split('T')[0];

  // Try legacy separate fields first, then compound "Plan: X of Y" format
  const legacyPlan = stateExtractField(content, 'Current Plan');
  const legacyTotal = stateExtractField(content, 'Total Plans in Phase');
  const planField = stateExtractField(content, 'Plan');

  let currentPlan, totalPlans;
  let useCompoundFormat = false;

  if (legacyPlan && legacyTotal) {
    // For compound format like "02-08", extract the plan number (rightmost digit group)
    // parseInt("02-08", 10) → 2 (WRONG). Use regex to get the trailing number.
    const planNumMatch = legacyPlan.match(/(\d+)$/);
    currentPlan = planNumMatch
      ? parseInt(planNumMatch[1], 10)
      : parseInt(legacyPlan, 10);
    totalPlans = parseInt(legacyTotal, 10);
  } else if (planField) {
    // Compound format: "2 of 6 in current phase" or "2 of 6"
    currentPlan = parseInt(planField, 10);
    const ofMatch = planField.match(/of\s+(\d+)/);
    totalPlans = ofMatch ? parseInt(ofMatch[1], 10) : NaN;
    useCompoundFormat = true;
  }

  if (isNaN(currentPlan) || isNaN(totalPlans)) {
    output({
      error: 'Cannot parse Current Plan or Total Plans in Phase from STATE.md',
    });
    return;
  }

  // Wave execution runs several executors against one STATE.md concurrently, so
  // the position is counted from disk rather than incremented — that keeps a
  // repeat call idempotent where read-then-write-plus-one races.
  const phasePrefixMatch = legacyPlan && legacyPlan.match(/^(\d+)-\d+$/);
  const phaseRef =
    stateExtractField(content, 'Current Phase') ||
    (phasePrefixMatch ? phasePrefixMatch[1] : null);
  const completedOnDisk = countCompletedPlansOnDisk(cwd, phaseRef);
  const derivedFromDisk = completedOnDisk !== null;

  // A finished plan writes its SUMMARY before calling this, so the count already
  // includes the caller's own plan.
  const nextPlan = derivedFromDisk ? completedOnDisk + 1 : currentPlan + 1;
  const atEndOfPhase = derivedFromDisk
    ? completedOnDisk >= totalPlans
    : currentPlan >= totalPlans;

  if (atEndOfPhase) {
    content = stateReplaceFieldWithFallback(
      content,
      'Status',
      'Phase complete — ready for verification',
    );
    content = stateReplaceFieldWithFallback(content, 'Last Activity', today);
    writeStateMd(statePath, content, cwd);
    output(
      {
        advanced: false,
        reason: 'last_plan',
        current_plan: currentPlan,
        total_plans: totalPlans,
        completed_plans: completedOnDisk,
        derived_from_disk: derivedFromDisk,
        status: 'ready_for_verification',
      },
      'false',
    );
  } else {
    if (useCompoundFormat) {
      // Preserve compound format: "X of Y in current phase" → replace X only
      const newPlanValue = planField.replace(/^\d+/, String(nextPlan));
      content = stateReplaceField(content, 'Plan', newPlanValue) || content;
    } else {
      const legacyPlanRaw = stateExtractField(content, 'Current Plan');
      const newValue =
        formatPlanPosition(legacyPlanRaw, nextPlan) || String(nextPlan);
      content = stateReplaceField(content, 'Current Plan', newValue) || content;
    }
    content = stateReplaceFieldWithFallback(
      content,
      'Status',
      'Ready to execute',
    );
    content = stateReplaceFieldWithFallback(content, 'Last Activity', today);
    writeStateMd(statePath, content, cwd);
    // Deriving from disk can land *behind* the stored value — a STATE.md that
    // claims more progress than the summaries on disk support gets corrected
    // downwards — or exactly on it, when a retried caller recomputes the
    // position already stored. `advanced` is reserved for forward movement so
    // a caller branching on it alone can read neither as progress; `reason`
    // separates the correction from the no-op.
    const rewound = nextPlan < currentPlan;
    const advanced = nextPlan > currentPlan;
    const reason = rewound ? 'rewound' : advanced ? null : 'idempotent';
    output(
      {
        advanced,
        rewound,
        ...(reason ? { reason } : {}),
        previous_plan: currentPlan,
        current_plan: nextPlan,
        total_plans: totalPlans,
        completed_plans: completedOnDisk,
        derived_from_disk: derivedFromDisk,
      },
      rewound ? 'rewound' : advanced ? 'true' : 'unchanged',
    );
  }
}

function cmdStateRecordMetric(cwd, options) {
  const { state: statePath } = planningPaths(cwd);
  if (!fs.existsSync(statePath)) {
    output({ error: 'STATE.md not found' });
    return;
  }

  let content = fs.readFileSync(statePath, 'utf-8');
  const { phase, plan, duration, tasks, files } = options;

  if (!phase || !plan || !duration) {
    output({ error: 'phase, plan, and duration required' });
    return;
  }

  // Find Performance Metrics section and its table
  const metricsPattern = tableSectionPattern('Performance Metrics');
  const metricsMatch = content.match(metricsPattern);

  if (metricsMatch) {
    let tableBody = metricsMatch[2].trimEnd();
    const newRow = `| Phase ${phase} P${plan} | ${duration} | ${tasks || '-'} tasks | ${files || '-'} files |`;

    if (tableBody.trim() === '' || tableBody.includes('None yet')) {
      tableBody = newRow;
    } else {
      tableBody = tableBody + '\n' + newRow;
    }

    content = content.replace(
      metricsPattern,
      (_match, header) => `${header}${tableBody}\n`,
    );
    writeStateMd(statePath, content, cwd);
    output({ recorded: true, phase, plan, duration }, 'true');
  } else {
    output(
      {
        recorded: false,
        reason: 'Performance Metrics section not found in STATE.md',
      },
      'false',
    );
  }
}

function cmdStateUpdateProgress(cwd) {
  const { state: statePath, phases: phasesDir } = planningPaths(cwd);
  if (!fs.existsSync(statePath)) {
    output({ error: 'STATE.md not found' });
    return;
  }

  let content = fs.readFileSync(statePath, 'utf-8');

  // Count summaries across current milestone phases only
  let totalPlans = 0;
  let totalSummaries = 0;

  if (fs.existsSync(phasesDir)) {
    const isDirInMilestone = getMilestonePhaseFilter(cwd);
    const phaseDirs = fs
      .readdirSync(phasesDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .filter(isDirInMilestone);
    for (const dir of phaseDirs) {
      const files = fs.readdirSync(path.join(phasesDir, dir));
      totalPlans += files.filter((f) => f.match(/-PLAN\.md$/i)).length;
      totalSummaries += files.filter((f) => f.match(/-SUMMARY\.md$/i)).length;
    }
  }

  const percent =
    totalPlans > 0
      ? Math.min(100, Math.round((totalSummaries / totalPlans) * 100))
      : 0;
  const barWidth = 10;
  const filled = Math.round((percent / 100) * barWidth);
  const bar = '\u2588'.repeat(filled) + '\u2591'.repeat(barWidth - filled);
  const progressStr = `[${bar}] ${percent}%`;

  const withProgress = stateReplaceField(content, 'Progress', progressStr);
  if (withProgress !== null) {
    content = withProgress;
    writeStateMd(statePath, content, cwd);
    output(
      {
        updated: true,
        percent,
        completed: totalSummaries,
        total: totalPlans,
        bar: progressStr,
      },
      progressStr,
    );
  } else {
    output(
      { updated: false, reason: 'Progress field not found in STATE.md' },
      'false',
    );
  }
}

function cmdStateAddDecision(cwd, options) {
  const { state: statePath } = planningPaths(cwd);
  if (!fs.existsSync(statePath)) {
    output({ error: 'STATE.md not found' });
    return;
  }

  const { phase, summary, summary_file, rationale, rationale_file } = options;
  let summaryText = null;
  let rationaleText = '';

  try {
    summaryText = readTextArgOrFile(cwd, summary, summary_file, 'summary');
    rationaleText = readTextArgOrFile(
      cwd,
      rationale || '',
      rationale_file,
      'rationale',
    );
  } catch (err) {
    output({ added: false, reason: err.message }, 'false');
    return;
  }

  if (!summaryText) {
    output({ error: 'summary required' });
    return;
  }

  let content = fs.readFileSync(statePath, 'utf-8');
  const entry = `- [Phase ${phase || '?'}]: ${summaryText}${rationaleText ? ` — ${rationaleText}` : ''}`;

  // Find Decisions section (various heading patterns)
  const pattern = sectionPattern(
    '(?:Decisions|Decisions Made|Accumulated.*Decisions)',
    '###?',
  );
  const match = content.match(pattern);

  if (match) {
    let sectionBody = match[2];
    // Remove placeholders
    sectionBody = sectionBody
      .replace(/None yet\.?\s*\n?/gi, '')
      .replace(/No decisions yet\.?\s*\n?/gi, '');
    sectionBody = sectionBody.trimEnd() + '\n' + entry + '\n';
    content = content.replace(
      pattern,
      (_match, header) => `${header}${sectionBody}`,
    );
    writeStateMd(statePath, content, cwd);
    output({ added: true, decision: entry }, 'true');
  } else {
    output(
      { added: false, reason: 'Decisions section not found in STATE.md' },
      'false',
    );
  }
}

function cmdStateAddBlocker(cwd, text) {
  const { state: statePath } = planningPaths(cwd);
  if (!fs.existsSync(statePath)) {
    output({ error: 'STATE.md not found' });
    return;
  }
  const blockerOptions =
    typeof text === 'object' && text !== null ? text : { text };
  let blockerText = null;

  try {
    blockerText = readTextArgOrFile(
      cwd,
      blockerOptions.text,
      blockerOptions.text_file,
      'blocker',
    );
  } catch (err) {
    output({ added: false, reason: err.message }, 'false');
    return;
  }

  if (!blockerText) {
    output({ error: 'text required' });
    return;
  }

  let content = fs.readFileSync(statePath, 'utf-8');
  const entry = `- ${blockerText}`;

  const pattern = sectionPattern(BLOCKER_HEADINGS, '###?');
  const match = content.match(pattern);

  if (match) {
    let sectionBody = match[2];
    sectionBody = sectionBody
      .replace(/None\.?\s*\n?/gi, '')
      .replace(/None yet\.?\s*\n?/gi, '');
    sectionBody = sectionBody.trimEnd() + '\n' + entry + '\n';
    content = content.replace(
      pattern,
      (_match, header) => `${header}${sectionBody}`,
    );
    writeStateMd(statePath, content, cwd);
    output({ added: true, blocker: blockerText }, 'true');
  } else {
    output(
      { added: false, reason: 'Blockers section not found in STATE.md' },
      'false',
    );
  }
}

function cmdStateResolveBlocker(cwd, text) {
  const { state: statePath } = planningPaths(cwd);
  if (!fs.existsSync(statePath)) {
    output({ error: 'STATE.md not found' });
    return;
  }
  if (!text) {
    output({ error: 'text required' });
    return;
  }

  let content = fs.readFileSync(statePath, 'utf-8');

  const pattern = sectionPattern(BLOCKER_HEADINGS, '###?');
  const match = content.match(pattern);

  if (match) {
    const sectionBody = match[2];
    const lines = sectionBody.split('\n');
    const filtered = lines.filter((line) => {
      if (!line.startsWith('- ')) return true;
      return !line.toLowerCase().includes(text.toLowerCase());
    });

    let newBody = filtered.join('\n');
    // If section is now empty, add placeholder
    if (!newBody.trim() || !newBody.includes('- ')) {
      newBody = 'None\n';
    }

    content = content.replace(
      pattern,
      (_match, header) => `${header}${newBody}`,
    );
    writeStateMd(statePath, content, cwd);
    output({ resolved: true, blocker: text }, 'true');
  } else {
    output(
      { resolved: false, reason: 'Blockers section not found in STATE.md' },
      'false',
    );
  }
}

function cmdStateRecordSession(cwd, options) {
  const { state: statePath } = planningPaths(cwd);
  if (!fs.existsSync(statePath)) {
    output({ error: 'STATE.md not found' });
    return;
  }

  let content = fs.readFileSync(statePath, 'utf-8');
  const now = new Date().toISOString();
  const updated = [];

  const applied = stateReplaceFields(content, [
    ['Last session', now],
    ['Last Date', now],
    ['Stopped At', options.stopped_at || null],
    ['Resume File', options.resume_file || 'None'],
  ]);
  content = applied.content;
  updated.push(...applied.updated);

  if (updated.length > 0) {
    writeStateMd(statePath, content, cwd);
    output({ recorded: true, updated }, 'true');
  } else {
    output(
      { recorded: false, reason: 'No session fields found in STATE.md' },
      'false',
    );
  }
}

function cmdStateSnapshot(cwd, phaseFilter) {
  const { state: statePath } = planningPaths(cwd);

  if (!fs.existsSync(statePath)) {
    output({ error: 'STATE.md not found' });
    return;
  }

  const content = fs.readFileSync(statePath, 'utf-8');

  // Extract basic fields
  const currentPhase = stateExtractField(content, 'Current Phase');
  const currentPhaseName = stateExtractField(content, 'Current Phase Name');
  const totalPhasesRaw = stateExtractField(content, 'Total Phases');
  const currentPlan = stateExtractField(content, 'Current Plan');
  const totalPlansRaw = stateExtractField(content, 'Total Plans in Phase');
  const status = stateExtractField(content, 'Status');
  const progressRaw = stateExtractField(content, 'Progress');
  const lastActivity = stateExtractField(content, 'Last Activity');
  const lastActivityDesc = stateExtractField(
    content,
    'Last Activity Description',
  );
  const pausedAt = stateExtractField(content, 'Paused At');

  // Load config for git target_branch visibility
  const config = loadConfig(cwd);
  const targetBranch = resolveTargetBranch(config);

  // Parse numeric fields
  const totalPhases = totalPhasesRaw ? parseInt(totalPhasesRaw, 10) : null;
  const totalPlansInPhase = totalPlansRaw ? parseInt(totalPlansRaw, 10) : null;
  const progressPercent = progressRaw
    ? parseInt(progressRaw.replace('%', ''), 10)
    : null;

  // Extract decisions table
  const decisions = [];
  const decisionsMatch = content.match(tableSectionPattern('Decisions Made'));
  if (decisionsMatch) {
    const tableBody = decisionsMatch[2];
    const rows = tableBody
      .trim()
      .split('\n')
      .filter((r) => r.includes('|'));
    for (const row of rows) {
      const cells = row
        .split('|')
        .map((c) => c.trim())
        .filter(Boolean);
      if (cells.length >= 3) {
        decisions.push({
          phase: cells[0],
          summary: cells[1],
          rationale: cells[2],
        });
      }
    }
  }

  // Extract blockers list
  const blockers = [];
  const blockersMatch = content.match(sectionPattern('Blockers'));
  if (blockersMatch) {
    const blockersSection = blockersMatch[2];
    const items = blockersSection.match(/^-\s+(.+)$/gm) || [];
    for (const item of items) {
      blockers.push(item.replace(/^-\s+/, '').trim());
    }
  }

  // Extract session info
  const session = {
    last_date: null,
    stopped_at: null,
    resume_file: null,
  };

  const sessionMatch = content.match(
    sectionPattern('Session(?:[ \\t]+Continuity)?'),
  );
  if (sessionMatch) {
    const sessionSection = sessionMatch[2];
    session.last_date =
      stateExtractField(sessionSection, 'Last Date') ||
      stateExtractField(sessionSection, 'Last session');
    session.stopped_at = stateExtractField(sessionSection, 'Stopped At');
    session.resume_file = stateExtractField(sessionSection, 'Resume File');
  }

  const filteredDecisions = phaseFilter
    ? decisions.filter(
        (d) => d.phase === phaseFilter || d.phase === String(phaseFilter),
      )
    : decisions;

  const result = {
    current_phase: currentPhase,
    current_phase_name: currentPhaseName,
    total_phases: totalPhases,
    current_plan: currentPlan,
    total_plans_in_phase: totalPlansInPhase,
    status,
    progress_percent: progressPercent,
    last_activity: lastActivity,
    last_activity_desc: lastActivityDesc,
    target_branch: targetBranch,
    decisions: filteredDecisions,
    blockers,
    paused_at: pausedAt,
    session,
  };

  output(result);
}

// ─── State Frontmatter Sync ──────────────────────────────────────────────────

/**
 * Extract machine-readable fields from STATE.md markdown body and build
 * a YAML frontmatter object. Allows hooks and scripts to read state
 * reliably via `state json` instead of fragile regex parsing.
 */
function buildStateFrontmatter(bodyContent, cwd) {
  const currentPhase = stateExtractField(bodyContent, 'Current Phase');
  const currentPhaseName = stateExtractField(bodyContent, 'Current Phase Name');
  const currentPlan = stateExtractField(bodyContent, 'Current Plan');
  const totalPhasesRaw = stateExtractField(bodyContent, 'Total Phases');
  const totalPlansRaw = stateExtractField(bodyContent, 'Total Plans in Phase');
  const status = stateExtractField(bodyContent, 'Status');
  const progressRaw = stateExtractField(bodyContent, 'Progress');
  const lastActivity = stateExtractField(bodyContent, 'Last Activity');
  const stoppedAt =
    stateExtractField(bodyContent, 'Stopped At') ||
    stateExtractField(bodyContent, 'Stopped at');
  const pausedAt = stateExtractField(bodyContent, 'Paused At');

  let milestone = null;
  let milestoneName = null;
  if (cwd) {
    try {
      const info = getMilestoneInfo(cwd);
      milestone = info.version;
      milestoneName = info.name;
    } catch {}
  }

  let totalPhases = totalPhasesRaw ? parseInt(totalPhasesRaw, 10) : null;
  let completedPhases = null;
  let totalPlans = totalPlansRaw ? parseInt(totalPlansRaw, 10) : null;
  let completedPlans = null;

  if (cwd) {
    try {
      const { phases: phasesDir } = planningPaths(cwd);
      if (fs.existsSync(phasesDir)) {
        const isDirInMilestone = getMilestonePhaseFilter(cwd);
        const phaseDirs = fs
          .readdirSync(phasesDir, { withFileTypes: true })
          .filter((e) => e.isDirectory())
          .map((e) => e.name)
          .filter(isDirInMilestone);
        let diskTotalPlans = 0;
        let diskTotalSummaries = 0;
        let diskCompletedPhases = 0;

        for (const dir of phaseDirs) {
          const dirPath = path.join(phasesDir, dir);
          const { isComplete } = getPhaseCompletionStatus(dirPath);
          const files = fs.readdirSync(dirPath);
          const plans = files.filter((f) => f.match(/-PLAN\.md$/i)).length;
          const summaries = files.filter((f) =>
            f.match(/-SUMMARY\.md$/i),
          ).length;
          diskTotalPlans += plans;
          diskTotalSummaries += summaries;
          if (isComplete) diskCompletedPhases++;
        }
        totalPhases =
          isDirInMilestone.phaseCount > 0
            ? Math.max(phaseDirs.length, isDirInMilestone.phaseCount)
            : phaseDirs.length;
        completedPhases = diskCompletedPhases;
        totalPlans = diskTotalPlans;
        completedPlans = diskTotalSummaries;
      }
    } catch {}
  }

  let progressPercent = null;
  if (progressRaw) {
    const pctMatch = progressRaw.match(/(\d+)%/);
    if (pctMatch) progressPercent = parseInt(pctMatch[1], 10);
  }

  // Normalize status to one of: planning, discussing, executing, verifying, paused, completed, unknown
  // Uses exact match checks to prevent false positives (e.g. "gap closure complete" → "completed",
  // "unverified" → "verifying"). Only exact or well-known prefix forms are normalized.
  let normalizedStatus = status || 'unknown';
  const statusLower = (status || '').toLowerCase().trim();
  if (
    statusLower === 'paused' ||
    statusLower === 'stopped' ||
    statusLower.startsWith('paused ') ||
    pausedAt
  ) {
    normalizedStatus = 'paused';
  } else if (
    statusLower === 'executing' ||
    statusLower === 'in progress' ||
    statusLower.startsWith('executing ')
  ) {
    normalizedStatus = 'executing';
  } else if (statusLower === 'planning' || statusLower === 'ready to plan') {
    normalizedStatus = 'planning';
  } else if (
    statusLower === 'discussing' ||
    statusLower.startsWith('discussing ')
  ) {
    normalizedStatus = 'discussing';
  } else if (
    statusLower === 'verifying' ||
    statusLower.startsWith('verifying ')
  ) {
    normalizedStatus = 'verifying';
  } else if (statusLower === 'completed' || statusLower === 'done') {
    normalizedStatus = 'completed';
  } else if (statusLower === 'ready to execute') {
    normalizedStatus = 'executing';
  }

  const fm = { gsd_state_version: '1.0' };

  if (milestone) fm.milestone = milestone;
  if (milestoneName) fm.milestone_name = milestoneName;
  if (currentPhase) fm.current_phase = currentPhase;
  if (currentPhaseName) fm.current_phase_name = currentPhaseName;
  if (currentPlan) fm.current_plan = currentPlan;
  fm.status = normalizedStatus;
  if (stoppedAt) fm.stopped_at = stoppedAt;
  if (pausedAt) fm.paused_at = pausedAt;
  fm.last_updated = new Date().toISOString();
  if (lastActivity) fm.last_activity = lastActivity;

  const progress = {};
  if (totalPhases !== null) progress.total_phases = totalPhases;
  if (completedPhases !== null) progress.completed_phases = completedPhases;
  if (totalPlans !== null) progress.total_plans = totalPlans;
  if (completedPlans !== null) progress.completed_plans = completedPlans;
  if (progressPercent !== null) progress.percent = progressPercent;
  if (Object.keys(progress).length > 0) fm.progress = progress;

  return fm;
}

function stripFrontmatter(content) {
  return content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n*/, '');
}

function syncStateFrontmatter(content, cwd) {
  // Read existing frontmatter BEFORE stripping — it may contain values
  // that the body no longer has (e.g., Status field removed by an agent).
  const existingFm = extractFrontmatter(content);
  const body = stripFrontmatter(content);
  const derivedFm = buildStateFrontmatter(body, cwd);

  // Preserve existing frontmatter status when body-derived status is 'unknown'.
  // This prevents a missing Status: field in the body from overwriting a
  // previously valid status (e.g., 'executing' → 'unknown').
  if (
    derivedFm.status === 'unknown' &&
    existingFm.status &&
    existingFm.status !== 'unknown'
  ) {
    derivedFm.status = existingFm.status;
  }

  const yamlStr = reconstructFrontmatter(derivedFm);
  return `---\n${yamlStr}\n---\n\n${body}`;
}

/**
 * Write STATE.md with synchronized YAML frontmatter.
 * All STATE.md writes should use this instead of raw writeFileSync.
 * Scans content for injection patterns before writing — advisory only, never blocks.
 */
function writeStateMd(statePath, content, cwd) {
  // Scan-on-write: detect potential injection in content being persisted
  const { clean, findings } = scanForInjection(content);
  if (!clean) {
    process.stderr.write(
      `[security] Advisory: potential injection in STATE.md: ${findings.join('; ')}\n`,
    );
  }
  // Sync YAML frontmatter from body on every write so top YAML and body bold stay in lockstep.
  // syncStateFrontmatter is idempotent and read-only on the body — only constructs FM from it.
  const synced = syncStateFrontmatter(content, cwd);
  writeFileAtomic(statePath, synced);
}

function cmdStateRebuildFrontmatter(cwd) {
  const { state: statePath } = planningPaths(cwd);
  if (!fs.existsSync(statePath)) {
    output({ error: 'STATE.md not found' });
    return;
  }
  let content = fs.readFileSync(statePath, 'utf-8');
  const synced = syncStateFrontmatter(content, cwd);
  writeFileAtomic(statePath, synced);
  output({ rebuilt: true });
}

function cmdStateJson(cwd) {
  const { state: statePath } = planningPaths(cwd);
  if (!fs.existsSync(statePath)) {
    output({ error: 'STATE.md not found' }, 'STATE.md not found');
    return;
  }

  const content = fs.readFileSync(statePath, 'utf-8');
  const fm = extractFrontmatter(content);

  if (!fm || Object.keys(fm).length === 0) {
    const body = stripFrontmatter(content);
    const built = buildStateFrontmatter(body, cwd);
    output(built, JSON.stringify(built, null, 2));
    return;
  }

  output(fm, JSON.stringify(fm, null, 2));
}

/**
 * Update STATE.md to reflect the start of a new phase.
 *
 * Sets: Status, Last Activity, Last Activity Description, Current Phase,
 * Current Phase Name, Current Plan, Total Plans in Phase, and the Current focus
 * body. Fields the file does not already carry are added to Current Position.
 */
function cmdStateBeginPhase(cwd, phaseNumber, phaseName, planCount) {
  const { state: statePath } = planningPaths(cwd);
  if (!fs.existsSync(statePath)) {
    output({ updated: false, error: 'STATE.md not found' });
    return;
  }

  if (!phaseNumber || !phaseName || !planCount) {
    output({
      updated: false,
      error: '--phase, --name, and --plans are required',
    });
    return;
  }

  let content = fs.readFileSync(statePath, 'utf-8');
  const today = new Date().toISOString().split('T')[0];

  // Format phase number with leading zero if needed (e.g., "3" -> "03")
  const phaseNum = String(phaseNumber).padStart(2, '0');
  // Current Plan starts at first plan of the new phase
  const firstPlan = `${phaseNum}-01`;
  const description = `Starting Phase ${phaseNum}: ${phaseName}`;

  // ## Current Position is written a field at a time, never wholesale. The
  // section holds fields this command knows nothing about — Total Phases,
  // Progress — so replacing its body dropped them, and the compound lines it
  // wrote in their place carried two facts each, which no later field writer
  // can update without destroying one of them.
  const replacements = [
    ['Status', 'In progress'],
    ['Last Activity', today],
    ['Last Activity Description', description],
    ['Current Phase', phaseNum],
    ['Current Phase Name', phaseName],
    ['Current Plan', firstPlan],
    ['Total Plans in Phase', String(planCount)],
  ];

  const applied = stateApplyFieldsToSection(
    content,
    'Current Position',
    replacements,
  );
  content = applied.content;

  // Update ## Current focus section body
  const focusSectionPattern = /(##\s*Current focus\s*\n)([\s\S]*?)(?=\n##|$)/i;
  const focusBody = `\n${phaseName} — ${planCount} plan${planCount !== 1 ? 's' : ''} to execute\n`;
  if (focusSectionPattern.test(content)) {
    content = content.replace(
      focusSectionPattern,
      (_match, header) => `${header}${focusBody}`,
    );
  }

  writeStateMd(statePath, content, cwd);
  output(
    {
      updated: true,
      phase: phaseNum,
      name: phaseName,
      plans: planCount,
      fields_updated: applied.updated,
      fields_added: applied.added,
    },
    'true',
  );
}

/**
 * Insert a Status column into the Quick Tasks Completed table if it is missing.
 * Reads STATE.md, finds the ### Quick Tasks Completed section, checks the header row
 * for a Status column, and if absent inserts it before the Directory column in the
 * header, separator, and all data rows.
 *
 * Returns:
 *   { adjusted: false, reason: 'section_not_found', table_has_status: false }
 *   { adjusted: false, reason: 'already_has_status', table_has_status: true }
 *   { adjusted: true, table_has_status: true }
 */
function adjustQuickTable(cwd) {
  const { state: statePath } = planningPaths(cwd);

  let content;
  try {
    content = fs.readFileSync(statePath, 'utf-8');
  } catch {
    return {
      adjusted: false,
      reason: 'section_not_found',
      table_has_status: false,
    };
  }

  // Find the ### Quick Tasks Completed section
  const sectionMatch = content.match(QUICK_TASKS_HEADING);
  if (!sectionMatch) {
    return {
      adjusted: false,
      reason: 'section_not_found',
      table_has_status: false,
    };
  }

  // Find the first table row after the section heading (the header row)
  const afterSection = content.slice(
    sectionMatch.index + sectionMatch[0].length,
  );
  const lines = afterSection.split('\n');

  // Find the header line (first line starting with |, within this section)
  const headerIdx = findTableHeaderIndex(lines);
  if (headerIdx === -1) {
    // Section exists but has no table
    return {
      adjusted: false,
      reason: 'section_not_found',
      table_has_status: false,
    };
  }

  const headerLine = lines[headerIdx];
  // Split header by | and get cell names (trim whitespace)
  const headerCells = headerLine
    .split('|')
    .map((c) => c.trim())
    .filter((c) => c !== '');

  // Check if Status column already exists (case-insensitive)
  const hasStatus = headerCells.some((c) => c.toLowerCase() === 'status');
  if (hasStatus) {
    return {
      adjusted: false,
      reason: 'already_has_status',
      table_has_status: true,
    };
  }

  // Find the index of the Directory column in header cells
  const dirIdx = headerCells.findIndex((c) => c.toLowerCase() === 'directory');
  if (dirIdx === -1) {
    // Can't find where to insert — treat as already adjusted or unknown
    return {
      adjusted: false,
      reason: 'directory_not_found',
      table_has_status: false,
    };
  }

  // Helper: insert a cell value before the Directory column in a table row string
  function insertCellBeforeDir(rowLine, newCell) {
    // Split by | keeping empties to preserve leading/trailing pipes
    const parts = rowLine.split('|');
    // parts[0] is empty (before leading |), parts[1..n-1] are cells, parts[n] is empty (after trailing |)
    // headerCells[dirIdx] maps to parts[dirIdx + 1] (offset by 1 because of leading empty)
    const insertAt = dirIdx + 1;
    parts.splice(insertAt, 0, newCell);
    return parts.join('|');
  }

  // Process lines: migrate header, separator, and data rows
  const newLines = [...lines];

  // Migrate header row
  newLines[headerIdx] = insertCellBeforeDir(headerLine, ' Status ');

  // Check next line — should be the separator row (contains ---)
  if (
    headerIdx + 1 < lines.length &&
    lines[headerIdx + 1].trimStart().startsWith('|')
  ) {
    newLines[headerIdx + 1] = insertCellBeforeDir(
      lines[headerIdx + 1],
      '--------',
    );
  }

  // Migrate all subsequent data rows
  for (let i = headerIdx + 2; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trimStart().startsWith('|')) break; // End of table
    newLines[i] = insertCellBeforeDir(line, '  ');
  }

  // Reconstruct content: replace the afterSection portion
  const updatedAfterSection = newLines.join('\n');
  const updatedContent =
    content.slice(0, sectionMatch.index + sectionMatch[0].length) +
    updatedAfterSection;

  writeStateMd(statePath, updatedContent, cwd);
  return { adjusted: true, table_has_status: true };
}

function cmdStateAdjustQuickTable(cwd) {
  const result = adjustQuickTable(cwd);
  output(result);
}

module.exports = {
  QUICK_TASKS_HEADING,
  findTableHeaderIndex,
  sectionPattern,
  tableSectionPattern,
  stateExtractField,
  stateReplaceField,
  stateReplaceFields,
  stateReplaceFieldWithFallback,
  stateApplyFieldsToSection,
  writeStateMd,
  cmdStateRebuildFrontmatter,
  cmdStateLoad,
  cmdStateGet,
  cmdStatePatch,
  cmdStateUpdate,
  cmdStateAdvancePlan,
  cmdStateRecordMetric,
  cmdStateUpdateProgress,
  cmdStateAddDecision,
  cmdStateAddBlocker,
  cmdStateResolveBlocker,
  cmdStateRecordSession,
  cmdStateSnapshot,
  cmdStateJson,
  cmdStateBeginPhase,
  adjustQuickTable,
  cmdStateAdjustQuickTable,
};
