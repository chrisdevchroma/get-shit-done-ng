/**
 * Roadmap — Roadmap parsing and update operations
 */

const fs = require('fs');
const path = require('path');
const {
  escapeRegex,
  boldLabel,
  phaseFieldPattern,
  phaseCheckboxPattern,
  normalizePhaseName,
  output,
  error,
  findPhaseInternal,
  extractCurrentMilestone,
  replaceInCurrentMilestone,
  hasPhaseTableRow,
  hasPhasePlansLine,
  isPhaseCheckboxSatisfied,
  getPhaseCompletionStatus,
  planningPaths,
} = require('./core.cjs');

const FIELD_VALUE = String.raw`\s*([^\n]+)`;
const GOAL_LINE = new RegExp(boldLabel('Goal') + FIELD_VALUE, 'i');
const DEPENDS_ON_LINE = new RegExp(boldLabel('Depends on') + FIELD_VALUE, 'i');
const SOURCE_TODOS_LINE = new RegExp(
  boldLabel('Source Todos') + FIELD_VALUE,
  'i',
);
// Not boldLabel(): the canonical form carries a parenthetical between the label
// and its colon — `**Success Criteria** (what must be TRUE):`.
const SUCCESS_CRITERIA_BLOCK =
  /\*\*Success Criteria(?:\*\*[^\n]*:|:\*\*[^\n]*)\s*\n((?:\s*\d+\.\s*[^\n]+\n?)+)/i;

function cmdRoadmapGetPhase(cwd, phaseNum, defaultValue) {
  const { roadmap: roadmapPath } = planningPaths(cwd);

  if (!fs.existsSync(roadmapPath)) {
    if (defaultValue !== undefined) {
      output(defaultValue, String(defaultValue));
      return;
    }
    output({ found: false, error: 'ROADMAP.md not found' }, '');
    return;
  }

  try {
    const content = extractCurrentMilestone(
      fs.readFileSync(roadmapPath, 'utf-8'),
    );

    // Escape special regex chars in phase number, handle decimal
    const escapedPhase = escapeRegex(phaseNum);

    // Match "## Phase X:", "### Phase X:", or "#### Phase X:" with optional name
    const phasePattern = new RegExp(
      `#{2,4}\\s*Phase\\s+${escapedPhase}:\\s*([^\\n]+)`,
      'i',
    );
    const headerMatch = content.match(phasePattern);

    if (!headerMatch) {
      // Fallback: check if phase exists in summary list but missing detail section
      const checklistPattern = new RegExp(
        `-\\s*\\[[ x]\\]\\s*\\*\\*Phase\\s+${escapedPhase}:\\s*([^*]+)\\*\\*`,
        'i',
      );
      const checklistMatch = content.match(checklistPattern);

      if (checklistMatch) {
        // Phase exists in summary but missing detail section - malformed ROADMAP
        if (defaultValue !== undefined) {
          output(defaultValue, String(defaultValue));
          return;
        }
        output(
          {
            found: false,
            phase_number: phaseNum,
            phase_name: checklistMatch[1].trim(),
            error: 'malformed_roadmap',
            message: `Phase ${phaseNum} exists in summary list but missing "### Phase ${phaseNum}:" detail section. ROADMAP.md needs both formats.`,
          },
          '',
        );
        return;
      }

      if (defaultValue !== undefined) {
        output(defaultValue, String(defaultValue));
        return;
      }
      output({ found: false, phase_number: phaseNum }, '');
      return;
    }

    const phaseName = headerMatch[1].trim();
    const headerIndex = headerMatch.index;

    // Find the end of this section (next ## or ### phase header, or end of file)
    const restOfContent = content.slice(headerIndex);
    const nextHeaderMatch = restOfContent.match(
      /\n#{2,4}\s+Phase\s+\d+[A-Z]?(?:\.\d+)*/i,
    );
    const sectionEnd = nextHeaderMatch
      ? headerIndex + nextHeaderMatch.index
      : content.length;

    const section = content.slice(headerIndex, sectionEnd).trim();

    // Extract goal if present
    const goalMatch = section.match(GOAL_LINE);
    const goal = goalMatch ? goalMatch[1].trim() : null;

    // Extract success criteria as structured array
    const criteriaMatch = section.match(SUCCESS_CRITERIA_BLOCK);
    const success_criteria = criteriaMatch
      ? criteriaMatch[1]
          .trim()
          .split('\n')
          .map((line) => line.replace(/^\s*\d+\.\s*/, '').trim())
          .filter(Boolean)
      : [];

    // Extract depends_on (same pattern as cmdRoadmapAnalyze)
    const dependsMatch = section.match(DEPENDS_ON_LINE);
    const depends_on = dependsMatch ? dependsMatch[1].trim() : null;

    // Extract source_todos
    const sourceTodosMatch = section.match(SOURCE_TODOS_LINE);
    const source_todos = sourceTodosMatch ? sourceTodosMatch[1].trim() : null;

    output(
      {
        found: true,
        phase_number: phaseNum,
        phase_name: phaseName,
        goal,
        success_criteria,
        depends_on,
        source_todos,
        section,
      },

      section,
    );
  } catch (e) {
    error('Failed to read ROADMAP.md: ' + e.message);
  }
}

function cmdRoadmapAnalyze(cwd, phaseFilter) {
  const { roadmap: roadmapPath, phases: phasesDir } = planningPaths(cwd);

  if (!fs.existsSync(roadmapPath)) {
    output({
      error: 'ROADMAP.md not found',
      milestones: [],
      phases: [],
      current_phase: null,
    });
    return;
  }

  const rawContent = fs.readFileSync(roadmapPath, 'utf-8');
  const content = extractCurrentMilestone(rawContent);

  // Extract all phase headings: ## Phase N: Name or ### Phase N: Name
  const phasePattern =
    /#{2,4}\s*Phase\s+(\d+[A-Z]?(?:\.\d+)*)\s*:\s*([^\n]+)/gi;
  const phases = [];
  let match;

  while ((match = phasePattern.exec(content)) !== null) {
    const phaseNum = match[1];
    const phaseName = match[2].replace(/\(INSERTED\)/i, '').trim();

    // Extract goal from the section
    const sectionStart = match.index;
    const restOfContent = content.slice(sectionStart);
    const nextHeader = restOfContent.match(
      /\n#{2,4}\s+Phase\s+\d+[A-Z]?(?:\.\d+)*/i,
    );
    const sectionEnd = nextHeader
      ? sectionStart + nextHeader.index
      : content.length;
    const section = content.slice(sectionStart, sectionEnd);

    const goalMatch = section.match(GOAL_LINE);
    const goal = goalMatch ? goalMatch[1].trim() : null;

    const dependsMatch = section.match(DEPENDS_ON_LINE);
    const depends_on = dependsMatch ? dependsMatch[1].trim() : null;

    const sourceTodosMatch = section.match(SOURCE_TODOS_LINE);
    const source_todos = sourceTodosMatch ? sourceTodosMatch[1].trim() : null;

    // Check completion on disk
    const normalized = normalizePhaseName(phaseNum);
    let diskStatus = 'no_directory';
    let planCount = 0;
    let summaryCount = 0;
    let hasContext = false;
    let hasResearch = false;

    try {
      const entries = fs.readdirSync(phasesDir, { withFileTypes: true });
      const dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);
      const dirMatch = dirs.find(
        (d) => d.startsWith(normalized + '-') || d === normalized,
      );

      if (dirMatch) {
        const phaseFiles = fs.readdirSync(path.join(phasesDir, dirMatch));
        planCount = phaseFiles.filter(
          (f) => f.endsWith('-PLAN.md') || f === 'PLAN.md',
        ).length;
        summaryCount = phaseFiles.filter(
          (f) => f.endsWith('-SUMMARY.md') || f === 'SUMMARY.md',
        ).length;
        hasContext = phaseFiles.some(
          (f) => f.endsWith('-CONTEXT.md') || f === 'CONTEXT.md',
        );
        hasResearch = phaseFiles.some(
          (f) => f.endsWith('-RESEARCH.md') || f === 'RESEARCH.md',
        );

        const { isComplete, status: completionStatus } =
          getPhaseCompletionStatus(path.join(phasesDir, dirMatch));
        if (isComplete)
          diskStatus = completionStatus; // 'complete (verified)' or 'complete (unverified)'
        else if (summaryCount > 0) diskStatus = 'partial';
        else if (planCount > 0) diskStatus = 'planned';
        else if (hasResearch) diskStatus = 'researched';
        else if (hasContext) diskStatus = 'discussed';
        else diskStatus = 'empty';
      }
    } catch {}

    // Check ROADMAP checkbox status
    const checkboxMatch = content.match(
      new RegExp(phaseCheckboxPattern(phaseNum), 'i'),
    );
    const roadmapComplete = checkboxMatch
      ? checkboxMatch[2].toLowerCase() === 'x'
      : false;

    // If roadmap marks phase complete, trust that over disk file structure.
    // Phases completed before GSD tracking (or via external tools) may lack
    // the standard PLAN/SUMMARY pairs but are still done.
    if (roadmapComplete && !diskStatus.startsWith('complete')) {
      diskStatus = 'complete (unverified)';
    }

    phases.push({
      number: phaseNum,
      name: phaseName,
      goal,
      depends_on,
      source_todos,
      plan_count: planCount,
      summary_count: summaryCount,
      has_context: hasContext,
      has_research: hasResearch,
      disk_status: diskStatus,
      roadmap_complete: roadmapComplete,
    });
  }

  // Extract milestone info
  const milestones = [];
  const milestonePattern = /##\s*(.*v(\d+\.\d+)[^(\n]*)/gi;
  let mMatch;
  while ((mMatch = milestonePattern.exec(content)) !== null) {
    milestones.push({
      heading: mMatch[1].trim(),
      version: 'v' + mMatch[2],
    });
  }

  // Find current and next phase
  const currentPhase =
    phases.find(
      (p) => p.disk_status === 'planned' || p.disk_status === 'partial',
    ) || null;
  const nextPhase =
    phases.find(
      (p) =>
        p.disk_status === 'empty' ||
        p.disk_status === 'no_directory' ||
        p.disk_status === 'discussed' ||
        p.disk_status === 'researched',
    ) || null;

  // Aggregated stats
  const totalPlans = phases.reduce((sum, p) => sum + p.plan_count, 0);
  const totalSummaries = phases.reduce((sum, p) => sum + p.summary_count, 0);
  const completedPhases = phases.filter((p) =>
    p.disk_status.startsWith('complete'),
  ).length;

  // Detect phases in summary list without detail sections (malformed ROADMAP)
  const checklistPattern = /-\s*\[[ x]\]\s*\*\*Phase\s+(\d+[A-Z]?(?:\.\d+)*)/gi;
  const checklistPhases = new Set();
  let checklistMatch;
  while ((checklistMatch = checklistPattern.exec(content)) !== null) {
    checklistPhases.add(checklistMatch[1]);
  }
  const detailPhases = new Set(phases.map((p) => p.number));
  const missingDetails = [...checklistPhases].filter(
    (p) => !detailPhases.has(p),
  );

  let resultPhases = phases;
  let resultMilestones = milestones;
  if (phaseFilter) {
    resultPhases = phases.filter(
      (p) => String(p.number) === String(phaseFilter),
    );
    resultMilestones = undefined;
  }

  const result = {
    ...(resultMilestones !== undefined ? { milestones: resultMilestones } : {}),
    phases: resultPhases,
    phase_count: resultPhases.length,
    completed_phases: completedPhases,
    total_plans: totalPlans,
    total_summaries: totalSummaries,
    progress_percent:
      totalPlans > 0
        ? Math.min(100, Math.round((totalSummaries / totalPlans) * 100))
        : 0,
    current_phase: currentPhase ? currentPhase.number : null,
    next_phase: nextPhase
      ? { number: nextPhase.number, name: nextPhase.name }
      : null,
    missing_phase_details: missingDetails.length > 0 ? missingDetails : null,
  };

  output(result);
}

function cmdRoadmapUpdatePlanProgress(cwd, phaseNum) {
  if (!phaseNum) {
    error('phase number required for roadmap update-plan-progress');
  }

  const { roadmap: roadmapPath } = planningPaths(cwd);

  const phaseInfo = findPhaseInternal(cwd, phaseNum);
  if (!phaseInfo) {
    error(`Phase ${phaseNum} not found`);
  }

  const planCount = phaseInfo.plans.length;
  const summaryCount = phaseInfo.summaries.length;

  if (planCount === 0) {
    output(
      {
        updated: false,
        reason: 'No plans found',
        plan_count: 0,
        summary_count: 0,
      },
      'no plans',
    );
    return;
  }

  const phaseAbsDir = path.join(cwd, phaseInfo.directory);
  const { isComplete, status: completionStatus } =
    getPhaseCompletionStatus(phaseAbsDir);
  const status = isComplete
    ? completionStatus === 'complete (verified)'
      ? 'Complete (verified)'
      : 'Complete'
    : summaryCount > 0
      ? 'In Progress'
      : 'Planned';
  const today = new Date().toISOString().split('T')[0];

  if (!fs.existsSync(roadmapPath)) {
    output(
      {
        updated: false,
        reason: 'ROADMAP.md not found',
        plan_count: planCount,
        summary_count: summaryCount,
      },
      'no roadmap',
    );
    return;
  }

  let roadmapContent = fs.readFileSync(roadmapPath, 'utf-8');
  const phaseEscaped = escapeRegex(phaseNum);
  const landed = [];
  const missed = [];

  // Progress table row: update Plans/Status/Date columns (handles 4 or 5 column tables)
  const tableRowPattern = new RegExp(
    `^(\\|\\s*${phaseEscaped}\\.?\\s[^|]*(?:\\|[^\\n]*)*)$`,
    'im',
  );
  const dateField = isComplete ? ` ${today} ` : '  ';
  const tableRow = replaceInCurrentMilestone(
    roadmapContent,
    tableRowPattern,
    (fullRow) => {
      const cells = fullRow.split('|').slice(1, -1); // drop leading/trailing empty from split
      if (cells.length === 5) {
        // 5-col: Phase | Milestone | Plans | Status | Completed
        cells[2] = ` ${summaryCount}/${planCount} `;
        cells[3] = ` ${status.padEnd(11)}`;
        cells[4] = dateField;
      } else if (cells.length === 4) {
        // 4-col: Phase | Plans | Status | Completed
        cells[1] = ` ${summaryCount}/${planCount} `;
        cells[2] = ` ${status.padEnd(11)}`;
        cells[3] = dateField;
      }
      return '|' + cells.join('|') + '|';
    },
  );
  roadmapContent = tableRow.content;
  if (tableRow.changed) landed.push('progress-table');
  else if (hasPhaseTableRow(roadmapContent, phaseNum))
    missed.push('progress-table');

  // Update plan count in phase detail section
  const planCountPattern = new RegExp(
    phaseFieldPattern(phaseEscaped, 'Plans'),
    'i',
  );
  const planCountText = isComplete
    ? `${summaryCount}/${planCount} plans complete`
    : `${summaryCount}/${planCount} plans executed`;
  const plansLine = replaceInCurrentMilestone(
    roadmapContent,
    planCountPattern,
    `$1${planCountText}`,
  );
  roadmapContent = plansLine.content;
  if (plansLine.changed) landed.push('plans-line');
  else if (hasPhasePlansLine(roadmapContent, phaseNum))
    missed.push('plans-line');

  // If complete: check phase-level checkbox
  if (isComplete) {
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
    if (checkbox.changed) landed.push('phase-checkbox');
    else if (!isPhaseCheckboxSatisfied(roadmapContent, phaseNum))
      missed.push('phase-checkbox');
  }

  // Mark completed plan checkboxes (e.g. "- [ ] 50-01-PLAN.md" or "- [ ] 50-01:")
  for (const summaryFile of phaseInfo.summaries) {
    const planId = summaryFile
      .replace('-SUMMARY.md', '')
      .replace('SUMMARY.md', '');
    if (!planId) continue;
    const planEscaped = escapeRegex(planId);
    const planCheckboxPattern = new RegExp(
      `(-\\s*\\[) (\\]\\s*${planEscaped})`,
      'i',
    );
    const planCheckbox = replaceInCurrentMilestone(
      roadmapContent,
      planCheckboxPattern,
      '$1x$2',
    );
    roadmapContent = planCheckbox.content;
    if (planCheckbox.changed && !landed.includes('plan-checkboxes'))
      landed.push('plan-checkboxes');
  }

  if (landed.length > 0) {
    fs.writeFileSync(roadmapPath, roadmapContent, 'utf-8');
  }

  output(
    {
      updated: landed.length > 0,
      ...(landed.length === 0
        ? { reason: 'no rewrite target matched in ROADMAP.md' }
        : {}),
      phase: phaseNum,
      plan_count: planCount,
      summary_count: summaryCount,
      status,
      complete: isComplete,
      missed_targets: missed,
    },
    missed.length > 0
      ? `${summaryCount}/${planCount} ${status} (missed: ${missed.join(', ')})`
      : `${summaryCount}/${planCount} ${status}`,
  );
}

module.exports = {
  cmdRoadmapGetPhase,
  cmdRoadmapAnalyze,
  cmdRoadmapUpdatePlanProgress,
};
