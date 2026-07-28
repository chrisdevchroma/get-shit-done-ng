/**
 * Init — Compound init commands for workflow bootstrapping
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const {
  loadConfig,
  resolveTargetBranch,
  resolveModelInternal,
  resolveEffortInternal,
  findPhaseInternal,
  boldLabel,
  getRoadmapPhaseInternal,
  pathExistsInternal,
  generateSlugInternal,
  getMilestoneInfo,
  getMilestonePhaseFilter,
  extractCurrentMilestone,
  normalizePhaseName,
  toPosixPath,
  output,
  error,
  planningPaths,
} = require('./core.cjs');
const { DEFAULTS } = require('./defaults.cjs');
const { validatePhaseNumber } = require('./security.cjs');
const { adjustQuickTable } = require('./state.cjs');
const { resolveGitContext } = require('./workspace.cjs');
const { resolveTypeAlias, readTypeAliases } = require('./type-alias.cjs');

function cmdInitExecutePhase(cwd, phase) {
  if (!phase) {
    error('phase required for init execute-phase');
  }
  const phaseCheck = validatePhaseNumber(String(phase));
  if (!phaseCheck.valid) {
    error(`Invalid phase number: ${phaseCheck.error}`);
  }
  phase = phaseCheck.normalized;

  const config = loadConfig(cwd);
  let phaseInfo = findPhaseInternal(cwd, phase);
  const milestone = getMilestoneInfo(cwd);

  const roadmapPhase = getRoadmapPhaseInternal(cwd, phase);

  // Fallback to ROADMAP.md if no phase directory exists yet
  if (!phaseInfo && roadmapPhase?.found) {
    const phaseName = roadmapPhase.phase_name;
    phaseInfo = {
      found: true,
      directory: null,
      phase_number: roadmapPhase.phase_number,
      phase_name: phaseName,
      phase_slug: phaseName
        ? phaseName
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-+|-+$/g, '')
        : null,
      plans: [],
      summaries: [],
      incomplete_plans: [],
      has_research: false,
      has_context: false,
      has_verification: false,
    };
  }

  const reqMatch = roadmapPhase?.section?.match(
    new RegExp(
      '^' + boldLabel('Requirements') + String.raw`[^\S\n]*([^\n]*)$`,
      'm',
    ),
  );
  const reqExtracted = reqMatch
    ? reqMatch[1]
        .replace(/[\[\]]/g, '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
        .join(', ')
    : null;
  const phase_req_ids =
    reqExtracted && reqExtracted !== 'TBD' ? reqExtracted : null;

  const result = {
    // Models
    executor_model: resolveModelInternal(cwd, 'gsd-executor'),
    verifier_model: resolveModelInternal(cwd, 'gsd-verifier'),

    // Efforts
    executor_effort: resolveEffortInternal(cwd, 'gsd-executor'),
    verifier_effort: resolveEffortInternal(cwd, 'gsd-verifier'),

    // Config flags
    commit_docs: config.commit_docs,
    parallelization: config.parallelization,
    branching_strategy: config.branching_strategy,
    phase_branch_template: config.phase_branch_template,
    milestone_branch_template: config.milestone_branch_template,
    target_branch: resolveTargetBranch(config),
    auto_push: config.auto_push,
    remote: config.remote,
    review_branch_template: config.review_branch_template,
    pr_draft: config.pr_draft,
    platform: config.platform,
    verifier_enabled: config.verifier,

    // Phase info
    phase_found: !!phaseInfo,
    phase_dir: phaseInfo?.directory || null,
    phase_number: phaseInfo?.phase_number || null,
    phase_name: phaseInfo?.phase_name || null,
    phase_slug: phaseInfo?.phase_slug || null,
    phase_req_ids,

    // Plan inventory
    plans: phaseInfo?.plans || [],
    summaries: phaseInfo?.summaries || [],
    incomplete_plans: phaseInfo?.incomplete_plans || [],
    plan_count: phaseInfo?.plans?.length || 0,
    incomplete_count: phaseInfo?.incomplete_plans?.length || 0,

    // Branch name (pre-computed)
    branch_name: (() => {
      const workspaceTypeAlias = resolveTypeAlias('feat', readTypeAliases(cwd));
      if (config.branching_strategy === 'phase' && phaseInfo) {
        return config.phase_branch_template
          .replace('{phase}', phaseInfo.phase_number)
          .replace('{slug}', phaseInfo.phase_slug || 'phase')
          .replace('{type}', workspaceTypeAlias);
      }
      if (config.branching_strategy === 'milestone') {
        return config.milestone_branch_template
          .replace('{milestone}', milestone.version)
          .replace(
            '{slug}',
            generateSlugInternal(milestone.name) || 'milestone',
          )
          .replace('{type}', workspaceTypeAlias);
      }
      return null;
    })(),

    // Milestone info
    milestone_version: milestone.version,
    milestone_name: milestone.name,
    milestone_slug: generateSlugInternal(milestone.name),

    // File existence
    state_exists: pathExistsInternal(cwd, '.planning/STATE.md'),
    roadmap_exists: pathExistsInternal(cwd, '.planning/ROADMAP.md'),
    config_exists: pathExistsInternal(cwd, '.planning/config.json'),
    // File paths
    state_path: '.planning/STATE.md',
    roadmap_path: '.planning/ROADMAP.md',
    config_path: '.planning/config.json',
  };

  // Resolve submodule git context for workflows that need push/PR routing
  let gitCtx = null;
  try {
    gitCtx = resolveGitContext(cwd);
  } catch {
    // If git-context resolution fails, leave fields null — workflows fall back to workspace-level config
  }

  if (gitCtx) {
    result.submodule_is_active = gitCtx.is_submodule;
    result.submodule_git_cwd = gitCtx.git_cwd;
    result.submodule_remote = gitCtx.remote;
    result.submodule_remote_url = gitCtx.remote_url;
    result.submodule_target_branch = gitCtx.target_branch;
    result.submodule_ambiguous = gitCtx.ambiguous;
    result.ambiguous_paths = gitCtx.ambiguous_paths || [];
  } else {
    result.submodule_is_active = false;
    result.submodule_git_cwd = null;
    result.submodule_remote = null;
    result.submodule_remote_url = null;
    result.submodule_target_branch = null;
    result.submodule_ambiguous = false;
    result.ambiguous_paths = [];
  }

  if (gitCtx && gitCtx.is_submodule) {
    // Submodule active — use merged per-submodule config from gitCtx
    result.branching_strategy = gitCtx.branching_strategy;
    result.phase_branch_template = gitCtx.phase_branch_template;
    result.milestone_branch_template = gitCtx.milestone_branch_template;
    result.target_branch = gitCtx.target_branch;
    result.auto_push = gitCtx.auto_push;
    result.remote = gitCtx.remote;
    result.review_branch_template = gitCtx.review_branch_template;
    result.pr_draft = gitCtx.pr_draft;
    result.platform = gitCtx.platform;
    result.type_aliases = gitCtx.type_aliases;

    // Recompute branch_name using overridden values
    const bs = result.branching_strategy;
    const submoduleTypeAlias = resolveTypeAlias('feat', result.type_aliases);
    if (bs === 'phase' && phaseInfo) {
      result.branch_name = result.phase_branch_template
        .replace('{phase}', phaseInfo.phase_number)
        .replace('{slug}', phaseInfo.phase_slug || 'phase')
        .replace('{type}', submoduleTypeAlias);
    } else if (bs === 'milestone') {
      result.branch_name = result.milestone_branch_template
        .replace('{milestone}', result.milestone_version)
        .replace(
          '{slug}',
          generateSlugInternal(result.milestone_name) || 'milestone',
        )
        .replace('{type}', submoduleTypeAlias);
    } else {
      result.branch_name = null;
    }
  }

  output(result);
}

function cmdInitPlanPhase(cwd, phase) {
  if (!phase) {
    error('phase required for init plan-phase');
  }
  const phaseCheck = validatePhaseNumber(String(phase));
  if (!phaseCheck.valid) {
    error(`Invalid phase number: ${phaseCheck.error}`);
  }
  phase = phaseCheck.normalized;

  const config = loadConfig(cwd);
  let phaseInfo = findPhaseInternal(cwd, phase);

  const roadmapPhase = getRoadmapPhaseInternal(cwd, phase);

  // Fallback to ROADMAP.md if no phase directory exists yet
  if (!phaseInfo && roadmapPhase?.found) {
    const phaseName = roadmapPhase.phase_name;
    phaseInfo = {
      found: true,
      directory: null,
      phase_number: roadmapPhase.phase_number,
      phase_name: phaseName,
      phase_slug: phaseName
        ? phaseName
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-+|-+$/g, '')
        : null,
      plans: [],
      summaries: [],
      incomplete_plans: [],
      has_research: false,
      has_context: false,
      has_verification: false,
    };
  }

  const reqMatch = roadmapPhase?.section?.match(
    new RegExp(
      '^' + boldLabel('Requirements') + String.raw`[^\S\n]*([^\n]*)$`,
      'm',
    ),
  );
  const reqExtracted = reqMatch
    ? reqMatch[1]
        .replace(/[\[\]]/g, '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
        .join(', ')
    : null;
  const phase_req_ids =
    reqExtracted && reqExtracted !== 'TBD' ? reqExtracted : null;

  const result = {
    // Models
    researcher_model: resolveModelInternal(cwd, 'gsd-phase-researcher'),
    planner_model: resolveModelInternal(cwd, 'gsd-planner'),
    checker_model: resolveModelInternal(cwd, 'gsd-plan-checker'),

    // Efforts
    researcher_effort: resolveEffortInternal(cwd, 'gsd-phase-researcher'),
    planner_effort: resolveEffortInternal(cwd, 'gsd-planner'),
    checker_effort: resolveEffortInternal(cwd, 'gsd-plan-checker'),

    // Workflow flags
    research_enabled: config.research,
    plan_checker_enabled: config.plan_checker,
    nyquist_validation_enabled: config.nyquist_validation,
    commit_docs: config.commit_docs,

    // Phase info
    phase_found: !!phaseInfo,
    phase_dir: phaseInfo?.directory || null,
    phase_number: phaseInfo?.phase_number || null,
    phase_name: phaseInfo?.phase_name || null,
    phase_slug: phaseInfo?.phase_slug || null,
    padded_phase: phaseInfo?.phase_number
      ? normalizePhaseName(phaseInfo.phase_number)
      : null,
    phase_req_ids,

    // Existing artifacts
    has_research: phaseInfo?.has_research || false,
    has_context: phaseInfo?.has_context || false,
    has_plans: (phaseInfo?.plans?.length || 0) > 0,
    plan_count: phaseInfo?.plans?.length || 0,

    // Environment
    planning_exists: pathExistsInternal(cwd, '.planning'),
    roadmap_exists: pathExistsInternal(cwd, '.planning/ROADMAP.md'),

    // File paths
    state_path: '.planning/STATE.md',
    roadmap_path: '.planning/ROADMAP.md',
    requirements_path: '.planning/REQUIREMENTS.md',
  };

  // Suggest parent phase for decimal phase not found
  if (!phaseInfo && String(phase).includes('.')) {
    const parentPhase = String(phase).split('.')[0];
    const parentInfo = findPhaseInternal(cwd, parentPhase);
    const parentRoadmap = getRoadmapPhaseInternal(cwd, parentPhase);
    if (parentInfo || parentRoadmap?.found) {
      result.phase_suggestion = `Phase ${phase} not found. Did you mean Phase ${parentPhase}?`;
    }
  }

  if (phaseInfo?.directory) {
    // Find *-CONTEXT.md in phase directory
    const phaseDirFull = path.join(cwd, phaseInfo.directory);
    try {
      const files = fs.readdirSync(phaseDirFull);
      const contextFile = files.find(
        (f) => f.endsWith('-CONTEXT.md') || f === 'CONTEXT.md',
      );
      if (contextFile) {
        result.context_path = toPosixPath(
          path.join(phaseInfo.directory, contextFile),
        );
      }
      const researchFile = files.find(
        (f) =>
          (f.endsWith('-RESEARCH.md') && !f.endsWith('-GAP-RESEARCH.md')) ||
          f === 'RESEARCH.md',
      );
      if (researchFile) {
        result.research_path = toPosixPath(
          path.join(phaseInfo.directory, researchFile),
        );
      }
      const gapResearchFile = files.find((f) => f.endsWith('-GAP-RESEARCH.md'));
      if (gapResearchFile) {
        result.gap_research_path = toPosixPath(
          path.join(phaseInfo.directory, gapResearchFile),
        );
      }
      result.has_gap_research = !!gapResearchFile;
      const verificationFile = files.find(
        (f) => f.endsWith('-VERIFICATION.md') || f === 'VERIFICATION.md',
      );
      if (verificationFile) {
        result.verification_path = toPosixPath(
          path.join(phaseInfo.directory, verificationFile),
        );
      }
      const uatFile = files.find(
        (f) => f.endsWith('-UAT.md') || f === 'UAT.md',
      );
      if (uatFile) {
        result.uat_path = toPosixPath(path.join(phaseInfo.directory, uatFile));
      }
    } catch {}
  } else {
    result.has_gap_research = false;
  }

  output(result);
}

function cmdInitNewProject(cwd) {
  const config = loadConfig(cwd);

  // Detect existing code
  let hasCode = false;
  let hasPackageFile = false;
  try {
    const files = execSync(
      'find . -maxdepth 3 \\( -name "*.ts" -o -name "*.js" -o -name "*.py" -o -name "*.go" -o -name "*.rs" -o -name "*.swift" -o -name "*.java" \\) 2>/dev/null | grep -v node_modules | grep -v .git | head -5',
      {
        cwd,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    hasCode = files.trim().length > 0;
  } catch {}

  hasPackageFile =
    pathExistsInternal(cwd, 'package.json') ||
    pathExistsInternal(cwd, 'requirements.txt') ||
    pathExistsInternal(cwd, 'Cargo.toml') ||
    pathExistsInternal(cwd, 'go.mod') ||
    pathExistsInternal(cwd, 'Package.swift');

  const result = {
    // Models
    researcher_model: resolveModelInternal(cwd, 'gsd-project-researcher'),
    synthesizer_model: resolveModelInternal(cwd, 'gsd-research-synthesizer'),
    roadmapper_model: resolveModelInternal(cwd, 'gsd-roadmapper'),

    // Efforts
    researcher_effort: resolveEffortInternal(cwd, 'gsd-project-researcher'),
    synthesizer_effort: resolveEffortInternal(cwd, 'gsd-research-synthesizer'),
    roadmapper_effort: resolveEffortInternal(cwd, 'gsd-roadmapper'),

    // Config
    commit_docs: config.commit_docs,

    // Existing state
    project_exists: pathExistsInternal(cwd, '.planning/PROJECT.md'),
    has_codebase_map: pathExistsInternal(cwd, '.planning/codebase'),
    planning_exists: pathExistsInternal(cwd, '.planning'),

    // Brownfield detection
    has_existing_code: hasCode,
    has_package_file: hasPackageFile,
    is_brownfield: hasCode || hasPackageFile,
    needs_codebase_map:
      (hasCode || hasPackageFile) &&
      !pathExistsInternal(cwd, '.planning/codebase'),

    // Git state
    has_git: pathExistsInternal(cwd, '.git'),

    // File paths
    project_path: '.planning/PROJECT.md',
  };

  output(result);
}

function cmdInitNewMilestone(cwd) {
  const config = loadConfig(cwd);
  const milestone = getMilestoneInfo(cwd);

  const result = {
    // Models
    researcher_model: resolveModelInternal(cwd, 'gsd-project-researcher'),
    synthesizer_model: resolveModelInternal(cwd, 'gsd-research-synthesizer'),
    roadmapper_model: resolveModelInternal(cwd, 'gsd-roadmapper'),

    // Efforts
    researcher_effort: resolveEffortInternal(cwd, 'gsd-project-researcher'),
    synthesizer_effort: resolveEffortInternal(cwd, 'gsd-research-synthesizer'),
    roadmapper_effort: resolveEffortInternal(cwd, 'gsd-roadmapper'),

    // Config
    commit_docs: config.commit_docs,
    research_enabled: config.research,

    // Current milestone
    current_milestone: milestone.version,
    current_milestone_name: milestone.name,

    // File existence
    project_exists: pathExistsInternal(cwd, '.planning/PROJECT.md'),
    roadmap_exists: pathExistsInternal(cwd, '.planning/ROADMAP.md'),
    state_exists: pathExistsInternal(cwd, '.planning/STATE.md'),

    // File paths
    project_path: '.planning/PROJECT.md',
    roadmap_path: '.planning/ROADMAP.md',
    state_path: '.planning/STATE.md',
  };

  output(result);
}

function cmdInitQuick(cwd, description, verifyMode) {
  const config = loadConfig(cwd);
  const now = new Date();
  const slug = description
    ? generateSlugInternal(description)?.substring(0, 40)
    : null;

  // Generate collision-resistant quick task ID: YYMMDD-xxx
  // xxx = 2-second precision blocks since midnight, encoded as 3-char Base36 (lowercase)
  // Range: 000 (00:00:00) to xbz (23:59:58), guaranteed 3 chars for any time of day.
  // Provides ~2s uniqueness window per user — practically collision-free across a team.
  const yy = String(now.getFullYear()).slice(-2);
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  const dateStr = yy + mm + dd;
  const secondsSinceMidnight =
    now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds();
  const timeBlocks = Math.floor(secondsSinceMidnight / 2);
  const timeEncoded = timeBlocks.toString(36).padStart(3, '0');
  const quickId = dateStr + '-' + timeEncoded;

  // Determine table_has_status:
  // - If verifyMode: call adjustQuickTable (auto-migrates if needed), use its result
  // - If not verifyMode: read-only check of existing table format
  let table_has_status = false;
  if (verifyMode) {
    const adjustResult = adjustQuickTable(cwd);
    table_has_status = adjustResult.table_has_status;
  } else {
    // Read-only detection: check if Quick Tasks Completed table has Status column
    try {
      const { state: statePath } = planningPaths(cwd);
      const stateContent = fs.readFileSync(statePath, 'utf-8');
      const sectionMatch = stateContent.match(
        /###\s*Quick Tasks Completed\s*\n/i,
      );
      if (sectionMatch) {
        const afterSection = stateContent.slice(
          sectionMatch.index + sectionMatch[0].length,
        );
        const firstTableLine = afterSection
          .split('\n')
          .find((l) => l.trimStart().startsWith('|'));
        if (firstTableLine) {
          const headerCells = firstTableLine
            .split('|')
            .map((c) => c.trim())
            .filter((c) => c !== '');
          table_has_status = headerCells.some(
            (c) => c.toLowerCase() === 'status',
          );
        }
      }
    } catch {
      // STATE.md doesn't exist or unreadable — table_has_status stays false
    }
  }

  const result = {
    // Models
    planner_model: resolveModelInternal(cwd, 'gsd-planner'),
    executor_model: resolveModelInternal(cwd, 'gsd-executor'),
    checker_model: resolveModelInternal(cwd, 'gsd-plan-checker'),
    verifier_model: resolveModelInternal(cwd, 'gsd-verifier'),

    // Efforts
    planner_effort: resolveEffortInternal(cwd, 'gsd-planner'),
    executor_effort: resolveEffortInternal(cwd, 'gsd-executor'),
    checker_effort: resolveEffortInternal(cwd, 'gsd-plan-checker'),
    verifier_effort: resolveEffortInternal(cwd, 'gsd-verifier'),

    // Config
    commit_docs: config.commit_docs,

    // Quick task info
    quick_id: quickId,
    slug: slug,
    description: description || null,

    // Timestamps
    date: now.toISOString().split('T')[0],
    timestamp: now.toISOString(),

    // Paths
    quick_dir: '.planning/quick',
    task_dir: slug ? `.planning/quick/${quickId}-${slug}` : null,

    // File existence
    roadmap_exists: pathExistsInternal(cwd, '.planning/ROADMAP.md'),
    planning_exists: pathExistsInternal(cwd, '.planning'),

    // Table format detection
    table_has_status,
  };

  output(result);
}

function cmdInitResume(cwd) {
  const config = loadConfig(cwd);

  // Check for interrupted agent
  let interruptedAgentId = null;
  try {
    interruptedAgentId = fs
      .readFileSync(
        path.join(planningPaths(cwd).root, 'current-agent-id.txt'),
        'utf-8',
      )
      .trim();
  } catch {}

  const result = {
    // File existence
    state_exists: pathExistsInternal(cwd, '.planning/STATE.md'),
    roadmap_exists: pathExistsInternal(cwd, '.planning/ROADMAP.md'),
    project_exists: pathExistsInternal(cwd, '.planning/PROJECT.md'),
    planning_exists: pathExistsInternal(cwd, '.planning'),

    // File paths
    state_path: '.planning/STATE.md',
    roadmap_path: '.planning/ROADMAP.md',
    project_path: '.planning/PROJECT.md',

    // Agent state
    has_interrupted_agent: !!interruptedAgentId,
    interrupted_agent_id: interruptedAgentId,

    // Config
    commit_docs: config.commit_docs,
  };

  output(result);
}

function cmdInitVerifyWork(cwd, phase) {
  if (!phase) {
    error('phase required for init verify-work');
  }
  const phaseCheck = validatePhaseNumber(String(phase));
  if (!phaseCheck.valid) {
    error(`Invalid phase number: ${phaseCheck.error}`);
  }
  phase = phaseCheck.normalized;

  const config = loadConfig(cwd);
  let phaseInfo = findPhaseInternal(cwd, phase);

  // Fallback to ROADMAP.md if no phase directory exists yet
  if (!phaseInfo) {
    const roadmapPhase = getRoadmapPhaseInternal(cwd, phase);
    if (roadmapPhase?.found) {
      const phaseName = roadmapPhase.phase_name;
      phaseInfo = {
        found: true,
        directory: null,
        phase_number: roadmapPhase.phase_number,
        phase_name: phaseName,
        phase_slug: phaseName
          ? phaseName
              .toLowerCase()
              .replace(/[^a-z0-9]+/g, '-')
              .replace(/^-+|-+$/g, '')
          : null,
        plans: [],
        summaries: [],
        incomplete_plans: [],
        has_research: false,
        has_context: false,
        has_verification: false,
      };
    }
  }

  const result = {
    // Models
    planner_model: resolveModelInternal(cwd, 'gsd-planner'),
    checker_model: resolveModelInternal(cwd, 'gsd-plan-checker'),

    // Config
    commit_docs: config.commit_docs,

    // Phase info
    phase_found: !!phaseInfo,
    phase_dir: phaseInfo?.directory || null,
    phase_number: phaseInfo?.phase_number || null,
    phase_name: phaseInfo?.phase_name || null,

    // Existing artifacts
    has_verification: phaseInfo?.has_verification || false,
  };

  output(result);
}

function cmdInitPhaseOp(cwd, phase) {
  if (phase) {
    const phaseCheck = validatePhaseNumber(String(phase));
    if (!phaseCheck.valid) {
      error(`Invalid phase number: ${phaseCheck.error}`);
    }
    phase = phaseCheck.normalized;
  }
  const config = loadConfig(cwd);
  let phaseInfo = findPhaseInternal(cwd, phase);

  // If the only disk match comes from an archived milestone, prefer the
  // current milestone's ROADMAP entry so discuss-phase and similar flows
  // don't attach to shipped work that reused the same phase number.
  if (phaseInfo?.archived) {
    const roadmapPhase = getRoadmapPhaseInternal(cwd, phase);
    if (roadmapPhase?.found) {
      const phaseName = roadmapPhase.phase_name;
      phaseInfo = {
        found: true,
        directory: null,
        phase_number: roadmapPhase.phase_number,
        phase_name: phaseName,
        phase_slug: phaseName
          ? phaseName
              .toLowerCase()
              .replace(/[^a-z0-9]+/g, '-')
              .replace(/^-+|-+$/g, '')
          : null,
        plans: [],
        summaries: [],
        incomplete_plans: [],
        has_research: false,
        has_context: false,
        has_verification: false,
      };
    }
  }

  // Fallback to ROADMAP.md if no directory exists (e.g., Plans: TBD)
  if (!phaseInfo) {
    const roadmapPhase = getRoadmapPhaseInternal(cwd, phase);
    if (roadmapPhase?.found) {
      const phaseName = roadmapPhase.phase_name;
      phaseInfo = {
        found: true,
        directory: null,
        phase_number: roadmapPhase.phase_number,
        phase_name: phaseName,
        phase_slug: phaseName
          ? phaseName
              .toLowerCase()
              .replace(/[^a-z0-9]+/g, '-')
              .replace(/^-+|-+$/g, '')
          : null,
        plans: [],
        summaries: [],
        incomplete_plans: [],
        has_research: false,
        has_context: false,
        has_verification: false,
      };
    }
  }

  const result = {
    // Config
    commit_docs: config.commit_docs,

    // Phase info
    phase_found: !!phaseInfo,
    phase_dir: phaseInfo?.directory || null,
    phase_number: phaseInfo?.phase_number || null,
    phase_name: phaseInfo?.phase_name || null,
    phase_slug: phaseInfo?.phase_slug || null,
    padded_phase: phaseInfo?.phase_number
      ? normalizePhaseName(phaseInfo.phase_number)
      : null,

    // Existing artifacts
    has_research: phaseInfo?.has_research || false,
    has_context: phaseInfo?.has_context || false,
    has_plans: (phaseInfo?.plans?.length || 0) > 0,
    has_verification: phaseInfo?.has_verification || false,
    plan_count: phaseInfo?.plans?.length || 0,

    // File existence
    roadmap_exists: pathExistsInternal(cwd, '.planning/ROADMAP.md'),
    planning_exists: pathExistsInternal(cwd, '.planning'),

    // File paths
    state_path: '.planning/STATE.md',
    roadmap_path: '.planning/ROADMAP.md',
    requirements_path: '.planning/REQUIREMENTS.md',
  };

  // Suggest parent phase for decimal phase not found
  if (!phaseInfo && String(phase).includes('.')) {
    const parentPhase = String(phase).split('.')[0];
    const parentInfo = findPhaseInternal(cwd, parentPhase);
    const parentRoadmap = getRoadmapPhaseInternal(cwd, parentPhase);
    if (parentInfo || parentRoadmap?.found) {
      result.phase_suggestion = `Phase ${phase} not found. Did you mean Phase ${parentPhase}?`;
    }
  }

  if (phaseInfo?.directory) {
    const phaseDirFull = path.join(cwd, phaseInfo.directory);
    try {
      const files = fs.readdirSync(phaseDirFull);
      const contextFile = files.find(
        (f) => f.endsWith('-CONTEXT.md') || f === 'CONTEXT.md',
      );
      if (contextFile) {
        result.context_path = toPosixPath(
          path.join(phaseInfo.directory, contextFile),
        );
      }
      const researchFile = files.find(
        (f) =>
          (f.endsWith('-RESEARCH.md') && !f.endsWith('-GAP-RESEARCH.md')) ||
          f === 'RESEARCH.md',
      );
      if (researchFile) {
        result.research_path = toPosixPath(
          path.join(phaseInfo.directory, researchFile),
        );
      }
      const verificationFile = files.find(
        (f) => f.endsWith('-VERIFICATION.md') || f === 'VERIFICATION.md',
      );
      if (verificationFile) {
        result.verification_path = toPosixPath(
          path.join(phaseInfo.directory, verificationFile),
        );
      }
      const uatFile = files.find(
        (f) => f.endsWith('-UAT.md') || f === 'UAT.md',
      );
      if (uatFile) {
        result.uat_path = toPosixPath(path.join(phaseInfo.directory, uatFile));
      }
    } catch {}
  }

  output(result);
}

function cmdInitTodos(cwd, area) {
  const config = loadConfig(cwd);
  const now = new Date();

  // List todos (reuse existing logic)
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

        if (area && todoArea !== area) continue;

        count++;
        todos.push({
          file,
          created: createdMatch ? createdMatch[1].trim() : 'unknown',
          title: titleMatch ? titleMatch[1].trim() : 'Untitled',
          area: todoArea,
          path: '.planning/todos/pending/' + file,
        });
      } catch {}
    }
  } catch {}

  const result = {
    // Config
    commit_docs: config.commit_docs,

    // Timestamps
    date: now.toISOString().split('T')[0],
    timestamp: now.toISOString(),

    // Todo inventory
    todo_count: count,
    todos,
    area_filter: area || null,

    // Paths
    pending_dir: '.planning/todos/pending',
    completed_dir: '.planning/todos/completed',

    // File existence
    planning_exists: pathExistsInternal(cwd, '.planning'),
    todos_dir_exists: pathExistsInternal(cwd, '.planning/todos'),
    pending_dir_exists: pathExistsInternal(cwd, '.planning/todos/pending'),
  };

  output(result);
}

function cmdInitMilestoneOp(cwd) {
  const config = loadConfig(cwd);
  const milestone = getMilestoneInfo(cwd);

  // Count phases
  let phaseCount = 0;
  let completedPhases = 0;
  const { phases: phasesDir, archive: archiveDir } = planningPaths(cwd);
  try {
    const entries = fs.readdirSync(phasesDir, { withFileTypes: true });
    const dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);
    phaseCount = dirs.length;

    // Count phases with summaries (completed)
    for (const dir of dirs) {
      try {
        const phaseFiles = fs.readdirSync(path.join(phasesDir, dir));
        const hasSummary = phaseFiles.some(
          (f) => f.endsWith('-SUMMARY.md') || f === 'SUMMARY.md',
        );
        if (hasSummary) completedPhases++;
      } catch {}
    }
  } catch {}

  // Check archive
  let archivedMilestones = [];
  try {
    archivedMilestones = fs
      .readdirSync(archiveDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {}

  const result = {
    // Config
    commit_docs: config.commit_docs,

    // Git config fields — will be overridden by gitCtx merge if submodule is active
    branching_strategy: config.branching_strategy,
    target_branch: resolveTargetBranch(config),
    auto_push: config.auto_push,
    remote: config.remote,
    platform: config.platform,
    phase_branch_template: config.phase_branch_template,
    milestone_branch_template: config.milestone_branch_template,

    // Current milestone
    milestone_version: milestone.version,
    milestone_name: milestone.name,
    milestone_slug: generateSlugInternal(milestone.name),

    // Phase counts
    phase_count: phaseCount,
    completed_phases: completedPhases,
    all_phases_complete: phaseCount > 0 && phaseCount === completedPhases,

    // Archive
    archived_milestones: archivedMilestones,
    archive_count: archivedMilestones.length,

    // File existence
    project_exists: pathExistsInternal(cwd, '.planning/PROJECT.md'),
    roadmap_exists: pathExistsInternal(cwd, '.planning/ROADMAP.md'),
    state_exists: pathExistsInternal(cwd, '.planning/STATE.md'),
    archive_exists: pathExistsInternal(cwd, '.planning/archive'),
    phases_dir_exists: pathExistsInternal(cwd, '.planning/phases'),
  };

  // Resolve submodule git context for workflows that need branch routing
  let gitCtx = null;
  try {
    gitCtx = resolveGitContext(cwd);
  } catch {
    // If git-context resolution fails, leave fields null — workflows fall back to workspace-level config
  }

  if (gitCtx) {
    result.submodule_is_active = gitCtx.is_submodule;
    result.submodule_git_cwd = gitCtx.git_cwd;
    result.submodule_remote = gitCtx.remote;
    result.submodule_remote_url = gitCtx.remote_url;
    result.submodule_target_branch = gitCtx.target_branch;
    result.submodule_ambiguous = gitCtx.ambiguous;
    result.ambiguous_paths = gitCtx.ambiguous_paths || [];
  } else {
    result.submodule_is_active = false;
    result.submodule_git_cwd = null;
    result.submodule_remote = null;
    result.submodule_remote_url = null;
    result.submodule_target_branch = null;
    result.submodule_ambiguous = false;
    result.ambiguous_paths = [];
  }

  if (gitCtx && gitCtx.is_submodule) {
    result.branching_strategy = gitCtx.branching_strategy;
    result.target_branch = gitCtx.target_branch;
    result.auto_push = gitCtx.auto_push;
    result.remote = gitCtx.remote;
    result.platform = gitCtx.platform;
    result.phase_branch_template = gitCtx.phase_branch_template;
    result.milestone_branch_template = gitCtx.milestone_branch_template;
    result.type_aliases = gitCtx.type_aliases;
  }

  output(result);
}

function cmdInitMapCodebase(cwd) {
  const config = loadConfig(cwd);

  // Check for existing codebase maps
  const { codebase: codebaseDir } = planningPaths(cwd);
  let existingMaps = [];
  try {
    existingMaps = fs.readdirSync(codebaseDir).filter((f) => f.endsWith('.md'));
  } catch {}

  const result = {
    // Models
    mapper_model: resolveModelInternal(cwd, 'gsd-codebase-mapper'),

    // Config
    commit_docs: config.commit_docs,
    search_gitignored: config.search_gitignored,
    parallelization: config.parallelization,

    // Paths
    codebase_dir: '.planning/codebase',

    // Existing maps
    existing_maps: existingMaps,
    has_maps: existingMaps.length > 0,

    // File existence
    planning_exists: pathExistsInternal(cwd, '.planning'),
    codebase_dir_exists: pathExistsInternal(cwd, '.planning/codebase'),
  };

  output(result);
}

function cmdInitProgress(cwd) {
  const config = loadConfig(cwd);
  const milestone = getMilestoneInfo(cwd);

  // Analyze phases — filter to current milestone and include ROADMAP-only phases
  const { phases: phasesDir, roadmap: roadmapPath } = planningPaths(cwd);
  const phases = [];
  let currentPhase = null;
  let nextPhase = null;

  // Build set of phases defined in ROADMAP for the current milestone
  const roadmapPhaseNums = new Set();
  const roadmapPhaseNames = new Map();
  try {
    const roadmapContent = extractCurrentMilestone(
      fs.readFileSync(roadmapPath, 'utf-8'),
    );
    const headingPattern =
      /#{2,4}\s*Phase\s+(\d+[A-Z]?(?:\.\d+)*)\s*:\s*([^\n]+)/gi;
    let hm;
    while ((hm = headingPattern.exec(roadmapContent)) !== null) {
      roadmapPhaseNums.add(hm[1]);
      roadmapPhaseNames.set(hm[1], hm[2].replace(/\(INSERTED\)/i, '').trim());
    }
  } catch {}

  const isDirInMilestone = getMilestonePhaseFilter(cwd);
  const seenPhaseNums = new Set();

  try {
    const entries = fs.readdirSync(phasesDir, { withFileTypes: true });
    const dirs = entries
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .filter(isDirInMilestone)
      .sort((a, b) => {
        const pa = a.match(/^(\d+[A-Z]?(?:\.\d+)*)/i);
        const pb = b.match(/^(\d+[A-Z]?(?:\.\d+)*)/i);
        if (!pa || !pb) return a.localeCompare(b);
        return parseInt(pa[1], 10) - parseInt(pb[1], 10);
      });

    for (const dir of dirs) {
      const match = dir.match(/^(\d+[A-Z]?(?:\.\d+)*)-?(.*)/i);
      const phaseNumber = match ? match[1] : dir;
      const phaseName = match && match[2] ? match[2] : null;
      seenPhaseNums.add(phaseNumber.replace(/^0+/, '') || '0');

      const phasePath = path.join(phasesDir, dir);
      const phaseFiles = fs.readdirSync(phasePath);

      const plans = phaseFiles.filter(
        (f) => f.endsWith('-PLAN.md') || f === 'PLAN.md',
      );
      const summaries = phaseFiles.filter(
        (f) => f.endsWith('-SUMMARY.md') || f === 'SUMMARY.md',
      );
      const hasResearch = phaseFiles.some(
        (f) =>
          (f.endsWith('-RESEARCH.md') && !f.endsWith('-GAP-RESEARCH.md')) ||
          f === 'RESEARCH.md',
      );

      const status =
        summaries.length >= plans.length && plans.length > 0
          ? 'complete'
          : plans.length > 0
            ? 'in_progress'
            : hasResearch
              ? 'researched'
              : 'pending';

      const phaseInfo = {
        number: phaseNumber,
        name: phaseName,
        directory: '.planning/phases/' + dir,
        status,
        plan_count: plans.length,
        summary_count: summaries.length,
        has_research: hasResearch,
      };

      phases.push(phaseInfo);

      // Find current (first incomplete with plans) and next (first pending)
      if (
        !currentPhase &&
        (status === 'in_progress' || status === 'researched')
      ) {
        currentPhase = phaseInfo;
      }
      if (!nextPhase && status === 'pending') {
        nextPhase = phaseInfo;
      }
    }
  } catch {}

  // Add phases defined in ROADMAP but not yet scaffolded to disk
  for (const [num, name] of roadmapPhaseNames) {
    const stripped = num.replace(/^0+/, '') || '0';
    if (!seenPhaseNums.has(stripped)) {
      const phaseInfo = {
        number: num,
        name: name
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-+|-+$/g, ''),
        directory: null,
        status: 'not_started',
        plan_count: 0,
        summary_count: 0,
        has_research: false,
      };
      phases.push(phaseInfo);
      if (!nextPhase && !currentPhase) {
        nextPhase = phaseInfo;
      }
    }
  }

  // Re-sort phases by number after adding ROADMAP-only phases
  phases.sort((a, b) => parseInt(a.number, 10) - parseInt(b.number, 10));

  // Check for paused work
  let pausedAt = null;
  try {
    const state = fs.readFileSync(planningPaths(cwd).state, 'utf-8');
    const pauseMatch = state.match(/\*\*Paused At:\*\*\s*(.+)/);
    if (pauseMatch) pausedAt = pauseMatch[1].trim();
  } catch {}

  const result = {
    // Models
    executor_model: resolveModelInternal(cwd, 'gsd-executor'),
    planner_model: resolveModelInternal(cwd, 'gsd-planner'),

    // Config
    commit_docs: config.commit_docs,

    // Milestone
    milestone_version: milestone.version,
    milestone_name: milestone.name,

    // Phase overview
    phases,
    phase_count: phases.length,
    completed_count: phases.filter((p) => p.status === 'complete').length,
    in_progress_count: phases.filter((p) => p.status === 'in_progress').length,

    // Current state
    current_phase: currentPhase,
    next_phase: nextPhase,
    paused_at: pausedAt,
    has_work_in_progress: !!currentPhase,

    // File existence
    project_exists: pathExistsInternal(cwd, '.planning/PROJECT.md'),
    roadmap_exists: pathExistsInternal(cwd, '.planning/ROADMAP.md'),
    state_exists: pathExistsInternal(cwd, '.planning/STATE.md'),
    // File paths
    state_path: '.planning/STATE.md',
    roadmap_path: '.planning/ROADMAP.md',
    project_path: '.planning/PROJECT.md',
    config_path: '.planning/config.json',
  };

  output(result);
}

const INIT_FIELD_DEFAULTS = {
  // booleans
  submodule_is_active: false,
  submodule_ambiguous: false,
  auto_push: false,
  pr_draft: true,
  commit_docs: true,
  parallelization: true,
  verifier_enabled: false,
  phase_found: false,
  state_exists: false,
  roadmap_exists: false,
  config_exists: false,
  planning_exists: false,
  all_phases_complete: false,
  archive_exists: false,
  phases_dir_exists: false,
  // arrays
  ambiguous_paths: [],
  plans: [],
  summaries: [],
  incomplete_plans: [],
  archived_milestones: [],
  // nullable strings (raw output: "")
  submodule_git_cwd: null,
  submodule_remote: null,
  submodule_remote_url: null,
  submodule_target_branch: null,
  phase_dir: null,
  phase_number: null,
  phase_name: null,
  phase_slug: null,
  phase_req_ids: null,
  branch_name: null,
  review_branch_template: null,
  platform: null,
  pr_template: null,
  type_aliases: null,
  executor_model: null,
  verifier_model: null,
  researcher_model: null,
  planner_model: null,
  // plain strings with defaults
  branching_strategy: DEFAULTS.branching_strategy,
  target_branch: DEFAULTS.target_branch,
  remote: DEFAULTS.remote,
  phase_branch_template: DEFAULTS.phase_branch_template,
  milestone_branch_template: DEFAULTS.milestone_branch_template,
  // numbers
  plan_count: 0,
  incomplete_count: 0,
  phase_count: 0,
  completed_phases: 0,
  archive_count: 0,
  // file paths
  state_path: '.planning/STATE.md',
  roadmap_path: '.planning/ROADMAP.md',
  config_path: '.planning/config.json',
  requirements_path: '.planning/REQUIREMENTS.md',
};

function cmdInitGet(jsonStr, fieldName) {
  if (!fieldName) {
    error('Usage: init-get <json> <field>');
  }
  let parsed = null;
  if (jsonStr) {
    try {
      parsed = JSON.parse(jsonStr);
    } catch {
      // Malformed JSON — parsed remains null, will exit 1 below
    }
  }
  // Empty string or malformed JSON — surface as failure, do not silently fall to defaults
  if (parsed === null) {
    error('init-get: invalid JSON input — $INIT may be empty or init failed');
  }
  // If parse succeeded, try to get the value
  if (parsed !== null) {
    const value = parsed[fieldName];
    if (value !== undefined && value !== null) {
      const rawStr = Array.isArray(value)
        ? JSON.stringify(value)
        : String(value);
      output(value, rawStr);
      return;
    }
  }
  // Field absent — use registry default (parse succeeded, field just not present)
  if (Object.prototype.hasOwnProperty.call(INIT_FIELD_DEFAULTS, fieldName)) {
    const def = INIT_FIELD_DEFAULTS[fieldName];
    const rawStr = Array.isArray(def)
      ? JSON.stringify(def)
      : def === null
        ? ''
        : String(def);
    output(def, rawStr);
    return;
  }
  // Unknown field — return null (raw: empty string)
  output(null, '');
}

module.exports = {
  cmdInitExecutePhase,
  cmdInitPlanPhase,
  cmdInitNewProject,
  cmdInitNewMilestone,
  cmdInitQuick,
  cmdInitResume,
  cmdInitVerifyWork,
  cmdInitPhaseOp,
  cmdInitTodos,
  cmdInitMilestoneOp,
  cmdInitMapCodebase,
  cmdInitProgress,
  cmdInitGet,
  INIT_FIELD_DEFAULTS,
};
