/**
 * State — STATE.md operations and progression engine
 */

const fs = require('fs');
const path = require('path');
const {
  loadConfig,
  findPhaseInternal,
  getMilestoneInfo,
  getMilestonePhaseFilter,
  getPhaseCompletionStatus,
  output,
  error,
  planningPaths,
  readTextArgOrFile,
} = require('./core.cjs');
const {
  extractFrontmatter,
  reconstructFrontmatter,
} = require('./frontmatter.cjs');
const { scanForInjection, sanitizeForPrompt } = require('./security.cjs');

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
    const fieldEscaped = section.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

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
    const sectionPattern = new RegExp(
      `##\\s*${fieldEscaped}\\s*\n([\\s\\S]*?)(?=\\n##|$)`,
      'i',
    );
    const sectionMatch = content.match(sectionPattern);
    if (sectionMatch) {
      const sectionContent = sanitizeForPrompt(sectionMatch[1].trim());
      const structured = parseSectionContent(sectionContent);
      output({ [section]: structured }, JSON.stringify(structured));
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
    const results = { updated: [], failed: [] };

    for (const [field, value] of Object.entries(patches)) {
      const fieldEscaped = field.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      // Try **Field:** bold format first, then plain Field: format
      const boldPattern = new RegExp(
        `(\\*\\*${fieldEscaped}:\\*\\*\\s*)(.*)`,
        'i',
      );
      const plainPattern = new RegExp(`(^${fieldEscaped}:\\s*)(.*)`, 'im');

      if (boldPattern.test(content)) {
        content = content.replace(
          boldPattern,
          (_match, prefix) => `${prefix}${value}`,
        );
        results.updated.push(field);
      } else if (plainPattern.test(content)) {
        content = content.replace(
          plainPattern,
          (_match, prefix) => `${prefix}${value}`,
        );
        results.updated.push(field);
      } else {
        results.failed.push(field);
      }
    }

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

  const replaceField = (c, primary, fallback, value) => {
    let r = stateReplaceField(c, primary, value);
    if (r) return r;
    if (fallback) {
      r = stateReplaceField(c, fallback, value);
      if (r) return r;
    }
    return stateReplaceFieldWithFallback(c, primary, value);
  };

  // Derive the position from disk instead of incrementing the stored value.
  // Wave-based execution runs several executors against one STATE.md at once;
  // read-value-then-write-value-plus-one lands at +1 however many plans just
  // finished, because every executor reads the same number before any of them
  // writes. Counting SUMMARY files gives every caller the same answer, makes a
  // repeat call a no-op, and makes the value correct again after a failed run.
  const phasePrefixMatch = legacyPlan && legacyPlan.match(/^(\d+)-\d+$/);
  const phaseRef =
    stateExtractField(content, 'Current Phase') ||
    (phasePrefixMatch ? phasePrefixMatch[1] : null);
  const completedOnDisk = countCompletedPlansOnDisk(cwd, phaseRef);
  const derivedFromDisk = completedOnDisk !== null;

  // A finished plan writes its SUMMARY before calling this, so the count
  // includes the caller's own plan — the next position is count + 1, and the
  // phase is done once the count reaches the plan total.
  const nextPlan = derivedFromDisk ? completedOnDisk + 1 : currentPlan + 1;
  const atEndOfPhase = derivedFromDisk
    ? completedOnDisk >= totalPlans
    : currentPlan >= totalPlans;

  if (atEndOfPhase) {
    content = replaceField(
      content,
      'Status',
      null,
      'Phase complete — ready for verification',
    );
    content = replaceField(content, 'Last Activity', 'Last activity', today);
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
      // Preserve original format: "02-08" → "02-09", "08" → "09", "8" → "9".
      // Non-numeric values have no format to preserve — write the bare number.
      const legacyPlanRaw = stateExtractField(content, 'Current Plan');
      const newValue =
        formatPlanPosition(legacyPlanRaw, nextPlan) || String(nextPlan);
      content = stateReplaceField(content, 'Current Plan', newValue) || content;
    }
    content = replaceField(content, 'Status', null, 'Ready to execute');
    content = replaceField(content, 'Last Activity', 'Last activity', today);
    writeStateMd(statePath, content, cwd);
    // Deriving from disk can land *behind* the stored value — a STATE.md that
    // claims more progress than the summaries on disk support gets corrected
    // downwards. The new position is right, but calling that an advance reads
    // as forward progress, so say plainly which way the counter moved.
    output(
      {
        advanced: true,
        rewound: nextPlan < currentPlan,
        previous_plan: currentPlan,
        current_plan: nextPlan,
        total_plans: totalPlans,
        completed_plans: completedOnDisk,
        derived_from_disk: derivedFromDisk,
      },
      'true',
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
  const metricsPattern =
    /(##\s*Performance Metrics[\s\S]*?\n\|[^\n]+\n\|[-|\s]+\n)([\s\S]*?)(?=\n##|\n$|$)/i;
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

  // Try **Progress:** bold format first, then plain Progress: format
  const boldProgressPattern = /(\*\*Progress:\*\*\s*).*/i;
  const plainProgressPattern = /^(Progress:\s*).*/im;
  if (boldProgressPattern.test(content)) {
    content = content.replace(
      boldProgressPattern,
      (_match, prefix) => `${prefix}${progressStr}`,
    );
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
  } else if (plainProgressPattern.test(content)) {
    content = content.replace(
      plainProgressPattern,
      (_match, prefix) => `${prefix}${progressStr}`,
    );
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
  const sectionPattern =
    /(###?\s*(?:Decisions|Decisions Made|Accumulated.*Decisions)\s*\n)([\s\S]*?)(?=\n###?|\n##[^#]|$)/i;
  const match = content.match(sectionPattern);

  if (match) {
    let sectionBody = match[2];
    // Remove placeholders
    sectionBody = sectionBody
      .replace(/None yet\.?\s*\n?/gi, '')
      .replace(/No decisions yet\.?\s*\n?/gi, '');
    sectionBody = sectionBody.trimEnd() + '\n' + entry + '\n';
    content = content.replace(
      sectionPattern,
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

  const sectionPattern =
    /(###?\s*(?:Blockers|Blockers\/Concerns|Concerns)\s*\n)([\s\S]*?)(?=\n###?|\n##[^#]|$)/i;
  const match = content.match(sectionPattern);

  if (match) {
    let sectionBody = match[2];
    sectionBody = sectionBody
      .replace(/None\.?\s*\n?/gi, '')
      .replace(/None yet\.?\s*\n?/gi, '');
    sectionBody = sectionBody.trimEnd() + '\n' + entry + '\n';
    content = content.replace(
      sectionPattern,
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

  const sectionPattern =
    /(###?\s*(?:Blockers|Blockers\/Concerns|Concerns)\s*\n)([\s\S]*?)(?=\n###?|\n##[^#]|$)/i;
  const match = content.match(sectionPattern);

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
      sectionPattern,
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

  // Update Last session / Last Date
  let result = stateReplaceField(content, 'Last session', now);
  if (result) {
    content = result;
    updated.push('Last session');
  }
  result = stateReplaceField(content, 'Last Date', now);
  if (result) {
    content = result;
    updated.push('Last Date');
  }

  // Update Stopped at
  if (options.stopped_at) {
    result = stateReplaceField(content, 'Stopped At', options.stopped_at);
    if (!result)
      result = stateReplaceField(content, 'Stopped at', options.stopped_at);
    if (result) {
      content = result;
      updated.push('Stopped At');
    }
  }

  // Update Resume file
  const resumeFile = options.resume_file || 'None';
  result = stateReplaceField(content, 'Resume File', resumeFile);
  if (!result) result = stateReplaceField(content, 'Resume file', resumeFile);
  if (result) {
    content = result;
    updated.push('Resume File');
  }

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
  const targetBranch = config.target_branch || 'main';

  // Parse numeric fields
  const totalPhases = totalPhasesRaw ? parseInt(totalPhasesRaw, 10) : null;
  const totalPlansInPhase = totalPlansRaw ? parseInt(totalPlansRaw, 10) : null;
  const progressPercent = progressRaw
    ? parseInt(progressRaw.replace('%', ''), 10)
    : null;

  // Extract decisions table
  const decisions = [];
  const decisionsMatch = content.match(
    /##\s*Decisions Made[\s\S]*?\n\|[^\n]+\n\|[-|\s]+\n([\s\S]*?)(?=\n##|\n$|$)/i,
  );
  if (decisionsMatch) {
    const tableBody = decisionsMatch[1];
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
  const blockersMatch = content.match(
    /##\s*Blockers\s*\n([\s\S]*?)(?=\n##|$)/i,
  );
  if (blockersMatch) {
    const blockersSection = blockersMatch[1];
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

  const sessionMatch = content.match(/##\s*Session\s*\n([\s\S]*?)(?=\n##|$)/i);
  if (sessionMatch) {
    const sessionSection = sessionMatch[1];
    const lastDateMatch =
      sessionSection.match(/\*\*Last Date:\*\*\s*(.+)/i) ||
      sessionSection.match(/^Last Date:\s*(.+)/im);
    const stoppedAtMatch =
      sessionSection.match(/\*\*Stopped At:\*\*\s*(.+)/i) ||
      sessionSection.match(/^Stopped At:\s*(.+)/im);
    const resumeFileMatch =
      sessionSection.match(/\*\*Resume File:\*\*\s*(.+)/i) ||
      sessionSection.match(/^Resume File:\s*(.+)/im);

    if (lastDateMatch) session.last_date = lastDateMatch[1].trim();
    if (stoppedAtMatch) session.stopped_at = stoppedAtMatch[1].trim();
    if (resumeFileMatch) session.resume_file = resumeFileMatch[1].trim();
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
  fs.writeFileSync(statePath, synced, 'utf-8');
}

function cmdStateRebuildFrontmatter(cwd) {
  const { state: statePath } = planningPaths(cwd);
  if (!fs.existsSync(statePath)) {
    output({ error: 'STATE.md not found' });
    return;
  }
  let content = fs.readFileSync(statePath, 'utf-8');
  const synced = syncStateFrontmatter(content, cwd);
  fs.writeFileSync(statePath, synced, 'utf-8');
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
 * Current Phase Name, Current Plan, Total Plans in Phase, Current focus body,
 * and Current Position section.
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

  // Update flat fields
  const replacements = [
    ['Status', 'In progress'],
    ['Last Activity', today],
    ['Last Activity Description', description],
    ['Current Phase', phaseNum],
    ['Current Phase Name', phaseName],
    ['Current Plan', firstPlan],
    ['Total Plans in Phase', String(planCount)],
  ];

  const failed = [];
  for (const [field, value] of replacements) {
    content = stateReplaceFieldWithFallback(content, field, value);
  }

  // Update ## Current Position section body
  const positionSectionPattern =
    /(##\s*Current Position\s*\n)([\s\S]*?)(?=\n##|$)/i;
  const positionBody = `\nPhase ${phaseNum} of ?? (${phaseName}) — In Progress\nPlan: 1 of ${planCount} — executing\nStatus: Phase ${phaseNum} starting — ${phaseName}\n`;
  if (positionSectionPattern.test(content)) {
    content = content.replace(
      positionSectionPattern,
      (_match, header) => `${header}${positionBody}`,
    );
  }

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
      failed,
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
  const sectionMatch = content.match(/###\s*Quick Tasks Completed\s*\n/i);
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

  // Find the header line (first line starting with |)
  const headerIdx = lines.findIndex((l) => l.trimStart().startsWith('|'));
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
  stateExtractField,
  stateReplaceField,
  stateReplaceFieldWithFallback,
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
