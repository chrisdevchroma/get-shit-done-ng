/**
 * Config — Planning config CRUD operations
 */

const fs = require('fs');
const path = require('path');
const {
  output,
  error,
  planningPaths,
  loadConfig,
  getEngineRuntime,
} = require('./core.cjs');
const { DEFAULTS, WORKFLOW_DEFAULTS } = require('./defaults.cjs');
const {
  VALID_PROFILES,
  VALID_EFFORT_VALUES,
  getAgentToModelMapForProfile,
  getAgentToEffortMapForProfile,
  formatAgentToModelMapAsTable,
  formatAgentToEffortMapAsTable,
} = require('./model-profiles.cjs');
const {
  syncAgentEffortFrontmatter,
  formatRestartNotice,
} = require('./effort-sync.cjs');

const VALID_CONFIG_KEYS = new Set([
  'mode',
  'granularity',
  'parallelization',
  'commit_docs',
  'model_profile',
  'search_gitignored',
  'workflow.research',
  'workflow.plan_check',
  'workflow.verifier',
  'workflow.nyquist_validation',
  'workflow.ui_phase',
  'workflow._auto_chain_active',
  'workflow.guardrail_enabled',
  'workflow.auto_advance',
  'git.branching_strategy',
  'git.phase_branch_template',
  'git.milestone_branch_template',
  'git.target_branch',
  'git.auto_push',
  'git.remote',
  'git.review_branch_template',
  'git.type_aliases',
  'git.pr_template',
  'git.pr_draft',
  'git.platform',
  'git.commit_format',
  'git.commit_template',
  'git.versioning_scheme',
  'planning.commit_docs',
  'planning.search_gitignored',
  'issue_tracker.auto_sync',
  'issue_tracker.default_action',
  'issue_tracker.comment_style',
  'issue_tracker.close_state',
  'issue_tracker.verify_label',
  'verification.test_command',
  'statusline.components.git_branch',
  'statusline.components.token_breakdown',
  'statusline.components.cross_model_warning',
  'statusline.components.api_limits',
  'git.ssh_check',
]);

const SUBMODULE_KEY_PATTERN =
  /^git\.submodules\.[^.]+\.(target_branch|branching_strategy|phase_branch_template|milestone_branch_template|review_branch_template|remote|auto_push|platform|pr_template|pr_draft|commit_format|commit_template|versioning_scheme|type_aliases|ssh_check)$/;

const EFFORT_OVERRIDE_KEY_PATTERN = /^effort_overrides\.[a-z][\w-]+$/;

// Profile/effort keys are Claude-only surface (CONTEXT.md Area 1).
// cmdConfigGet hides these from Copilot consumers — even if a hand-edited
// copilot config.json contains them — so the read-side strip is robust
// against future key additions.
const PROFILE_EFFORT_KEY_PATTERN =
  /^(model_profile|model_overrides(\..+)?|effort_overrides(\..+)?)$/;

const CONFIG_KEY_SUGGESTIONS = {
  'workflow.nyquist_validation_enabled': 'workflow.nyquist_validation',
  'agents.nyquist_validation_enabled': 'workflow.nyquist_validation',
  'nyquist.validation_enabled': 'workflow.nyquist_validation',
};

function validateKnownConfigKeyPath(keyPath) {
  const suggested = CONFIG_KEY_SUGGESTIONS[keyPath];
  if (suggested) {
    error(`Unknown config key: ${keyPath}. Did you mean ${suggested}?`);
  }
}

/**
 * Ensures the config file exists (creates it if needed).
 *
 * Does not call `output()`, so can be used as one step in a command without triggering `exit(0)` in
 * the happy path. But note that `error()` will still `exit(1)` out of the process.
 */
function ensureConfigFile(cwd) {
  const { config: configPath, root: planningDir } = planningPaths(cwd);

  // Ensure .planning directory exists
  try {
    if (!fs.existsSync(planningDir)) {
      fs.mkdirSync(planningDir, { recursive: true });
    }
  } catch (err) {
    error('Failed to create .planning directory: ' + err.message);
  }

  // Check if config already exists
  if (fs.existsSync(configPath)) {
    return { created: false, reason: 'already_exists' };
  }

  // Load user-level defaults from ~/.gsd/defaults.json if available
  const homedir = require('os').homedir();
  const globalDefaultsPath = path.join(homedir, '.gsd', 'defaults.json');
  let userDefaults = {};
  try {
    if (fs.existsSync(globalDefaultsPath)) {
      userDefaults = JSON.parse(fs.readFileSync(globalDefaultsPath, 'utf-8'));
      // Migrate deprecated "depth" key to "granularity"
      if ('depth' in userDefaults && !('granularity' in userDefaults)) {
        const depthToGranularity = {
          quick: 'coarse',
          standard: 'standard',
          comprehensive: 'fine',
        };
        userDefaults.granularity =
          depthToGranularity[userDefaults.depth] || userDefaults.depth;
        delete userDefaults.depth;
        try {
          fs.writeFileSync(
            globalDefaultsPath,
            JSON.stringify(userDefaults, null, 2),
            'utf-8',
          );
        } catch {}
      }
    }
  } catch (err) {
    // Ignore malformed global defaults, fall back to hardcoded
  }

  // Create default config (user-level defaults override hardcoded defaults)
  const hardcoded = {
    model_profile: DEFAULTS.model_profile,
    commit_docs: DEFAULTS.commit_docs,
    search_gitignored: DEFAULTS.search_gitignored,
    branching_strategy: DEFAULTS.branching_strategy,
    phase_branch_template: DEFAULTS.phase_branch_template,
    milestone_branch_template: DEFAULTS.milestone_branch_template,
    workflow: { ...WORKFLOW_DEFAULTS },
    parallelization: DEFAULTS.parallelization,
  };
  const defaults = {
    ...hardcoded,
    ...userDefaults,
    workflow: { ...hardcoded.workflow, ...(userDefaults.workflow || {}) },
  };

  try {
    fs.writeFileSync(configPath, JSON.stringify(defaults, null, 2), 'utf-8');
    return { created: true, path: '.planning/config.json' };
  } catch (err) {
    error('Failed to create config.json: ' + err.message);
  }
}

/**
 * Command to ensure the config file exists (creates it if needed).
 *
 * Note that this exits the process (via `output()`) even in the happy path; use
 * `ensureConfigFile()` directly if you need to avoid this.
 */
function cmdConfigEnsureSection(cwd) {
  const ensureConfigFileResult = ensureConfigFile(cwd);
  if (ensureConfigFileResult.created) {
    output(ensureConfigFileResult, 'created');
  } else {
    output(ensureConfigFileResult, 'exists');
  }
}

/**
 * Sets a value in the config file, allowing nested values via dot notation (e.g.,
 * "workflow.research").
 *
 * Does not call `output()`, so can be used as one step in a command without triggering `exit(0)` in
 * the happy path. But note that `error()` will still `exit(1)` out of the process.
 */
function setConfigValue(cwd, keyPath, parsedValue) {
  const { config: configPath } = planningPaths(cwd);

  // Load existing config or start with empty object
  let config = {};
  try {
    if (fs.existsSync(configPath)) {
      config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    }
  } catch (err) {
    error('Failed to read config.json: ' + err.message);
  }

  // Set nested value using dot notation (e.g., "workflow.research")
  const keys = keyPath.split('.');
  let current = config;
  for (let i = 0; i < keys.length - 1; i++) {
    const key = keys[i];
    if (current[key] === undefined || typeof current[key] !== 'object') {
      current[key] = {};
    }
    current = current[key];
  }
  const previousValue = current[keys[keys.length - 1]]; // Capture previous value before overwriting
  current[keys[keys.length - 1]] = parsedValue;

  // Write back
  try {
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
    return { updated: true, key: keyPath, value: parsedValue, previousValue };
  } catch (err) {
    error('Failed to write config.json: ' + err.message);
  }
}

/**
 * Command to set a value in the config file, allowing nested values via dot notation (e.g.,
 * "workflow.research").
 *
 * Note that this exits the process (via `output()`) even in the happy path; use `setConfigValue()`
 * directly if you need to avoid this.
 */
function cmdConfigSet(cwd, keyPath, value) {
  if (!keyPath) {
    error('Usage: config-set <key.path> <value>');
  }

  validateKnownConfigKeyPath(keyPath);

  // model_profile is a domain-level setting, not a flat key/value.
  // Route users to the dedicated command so they get profile validation,
  // agent effort sync, and the restart notice.
  if (keyPath === 'model_profile') {
    error(
      "'model_profile' must be set via 'config-set-model-profile <profile>'. " +
        "Setting it through 'config-set' skips agent effort sync, profile validation, and the restart notice.",
    );
  }

  if (
    !VALID_CONFIG_KEYS.has(keyPath) &&
    !SUBMODULE_KEY_PATTERN.test(keyPath) &&
    !EFFORT_OVERRIDE_KEY_PATTERN.test(keyPath)
  ) {
    error(
      `Unknown config key: "${keyPath}". Valid keys: ${[...VALID_CONFIG_KEYS].sort().join(', ')}`,
    );
  }

  // Value-validation for effort_overrides.* keys: reject values outside the valid set.
  if (
    EFFORT_OVERRIDE_KEY_PATTERN.test(keyPath) &&
    !VALID_EFFORT_VALUES.includes(value)
  ) {
    error(
      `Invalid effort value "${value}" for ${keyPath}. ` +
        `Valid values: ${VALID_EFFORT_VALUES.join(', ')}.`,
    );
  }

  // Parse value (handle booleans and numbers)
  let parsedValue = value;
  if (value === 'true') parsedValue = true;
  else if (value === 'false') parsedValue = false;
  else if (!isNaN(value) && value !== '') parsedValue = Number(value);

  const setConfigValueResult = setConfigValue(cwd, keyPath, parsedValue);

  // For effort_overrides.* writes, sync deployed agent files immediately so the
  // change takes effect on next Claude Code session restart.
  if (EFFORT_OVERRIDE_KEY_PATTERN.test(keyPath)) {
    const agentsDir = path.join(cwd, '.claude', 'agents');
    const syncResult = syncAgentEffortFrontmatter(cwd, agentsDir);
    const restartNotice = formatRestartNotice(syncResult.changes || []);
    if (restartNotice) {
      process.stderr.write(restartNotice + '\n');
    }
    setConfigValueResult.effortChanges = syncResult.changes || [];
  }

  output(setConfigValueResult, `${keyPath}=${parsedValue}`);
}

function cmdConfigGet(cwd, keyPath, defaultValue) {
  const { config: configPath } = planningPaths(cwd);

  if (!keyPath) {
    error('Usage: config-get <key.path>');
  }

  // Claude-only surface lock: profile/effort keys read as not-present on non-Claude runtimes.
  if (
    PROFILE_EFFORT_KEY_PATTERN.test(keyPath) &&
    getEngineRuntime() !== 'claude'
  ) {
    if (defaultValue !== undefined) {
      output(defaultValue, String(defaultValue));
      return;
    }
    error(`Key not found: ${keyPath}`);
    return;
  }

  if (
    !VALID_CONFIG_KEYS.has(keyPath) &&
    !SUBMODULE_KEY_PATTERN.test(keyPath) &&
    !EFFORT_OVERRIDE_KEY_PATTERN.test(keyPath)
  ) {
    if (defaultValue !== undefined) {
      output(defaultValue, String(defaultValue));
      return;
    }
    error(
      `Unknown config key: "${keyPath}". Valid keys: ${[...VALID_CONFIG_KEYS].sort().join(', ')}`,
    );
  }

  let config = {};
  try {
    if (fs.existsSync(configPath)) {
      config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    } else {
      if (defaultValue !== undefined) {
        output(defaultValue, String(defaultValue));
        return;
      }
      error('No config.json found at ' + configPath);
    }
  } catch (err) {
    if (err.message.startsWith('No config.json')) throw err;
    error('Failed to read config.json: ' + err.message);
  }

  // Traverse dot-notation path (e.g., "workflow.auto_advance")
  const keys = keyPath.split('.');
  let current = config;
  for (const key of keys) {
    if (
      current === undefined ||
      current === null ||
      typeof current !== 'object'
    ) {
      if (defaultValue !== undefined) {
        output(defaultValue, String(defaultValue));
        return;
      }
      error(`Key not found: ${keyPath}`);
    }
    current = current[key];
  }

  if (current === undefined) {
    if (defaultValue !== undefined) {
      output(defaultValue, String(defaultValue));
      return;
    }
    error(`Key not found: ${keyPath}`);
  }

  output(current, String(current));
}

/**
 * Command to set the model profile in the config file.
 *
 * Note that this exits the process (via `output()`) even in the happy path.
 */
function cmdConfigSetModelProfile(cwd, profile) {
  if (!profile) {
    error(`Usage: config-set-model-profile <${VALID_PROFILES.join('|')}>`);
  }

  const normalizedProfile = profile.toLowerCase().trim();
  if (!VALID_PROFILES.includes(normalizedProfile)) {
    error(
      `Invalid profile '${profile}'. Valid profiles: ${VALID_PROFILES.join(', ')}`,
    );
  }

  // Ensure config exists (create if needed)
  ensureConfigFile(cwd);

  // Set the model profile in the config
  const { previousValue } = setConfigValue(
    cwd,
    'model_profile',
    normalizedProfile,
  );
  const previousProfile = previousValue || 'balanced';

  // Build result value / message and return
  const agentToModelMap = getAgentToModelMapForProfile(normalizedProfile);
  const agentToEffortMap = getAgentToEffortMapForProfile(normalizedProfile);

  // Sync effort: frontmatter into deployed agent files (Claude-only).
  // Helper short-circuits on non-claude runtimes and missing .claude/agents dir.
  const agentsDir = path.join(cwd, '.claude', 'agents');
  const syncResult = syncAgentEffortFrontmatter(cwd, agentsDir);
  const restartNotice = formatRestartNotice(syncResult.changes || []);
  if (restartNotice) {
    process.stderr.write(restartNotice + '\n');
  }

  const result = {
    updated: true,
    profile: normalizedProfile,
    previousProfile,
    agentToModelMap,
    agentToEffortMap,
    effortChanges: syncResult.changes || [],
  };
  const rawValue = getCmdConfigSetModelProfileResultMessage(
    normalizedProfile,
    previousProfile,
    agentToModelMap,
    agentToEffortMap,
  );
  output(result, rawValue);
}

/**
 * Returns the message to display for the result of the `config-set-model-profile` command when
 * displaying raw output.
 */
function getCmdConfigSetModelProfileResultMessage(
  normalizedProfile,
  previousProfile,
  agentToModelMap,
  agentToEffortMap,
) {
  const agentToModelTable = formatAgentToModelMapAsTable(agentToModelMap);
  const agentToEffortTable = agentToEffortMap
    ? formatAgentToEffortMapAsTable(agentToEffortMap)
    : null;
  const didChange = previousProfile !== normalizedProfile;
  const paragraphs = didChange
    ? [
        `\u2713 Model profile set to: ${normalizedProfile} (was: ${previousProfile})`,
        'Model assignments:',
        agentToModelTable,
        ...(agentToEffortTable
          ? ['Effort assignments:', agentToEffortTable]
          : []),
        'Next spawned agents will use the new profile.',
      ]
    : [
        `\u2713 Model profile is already set to: ${normalizedProfile}`,
        'Model assignments:',
        agentToModelTable,
        ...(agentToEffortTable
          ? ['Effort assignments:', agentToEffortTable]
          : []),
      ];
  return paragraphs.join('\n\n');
}

module.exports = {
  cmdConfigEnsureSection,
  cmdConfigSet,
  cmdConfigGet,
  cmdConfigSetModelProfile,
  setConfigValue,
};
