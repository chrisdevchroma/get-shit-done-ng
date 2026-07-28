/**
 * Mapping of GSD agent to model for each profile.
 *
 * Should be in sync with the profiles table in `gsd-ng/references/claude-model-profiles.md`. But
 * possibly worth making this the single source of truth at some point, and removing the markdown
 * reference table in favor of programmatically determining the model to use for an agent (which
 * would be faster, use fewer tokens, and be less error-prone).
 */
const MODEL_PROFILES = {
  'gsd-planner': { quality: 'opus', balanced: 'opus', budget: 'sonnet' },
  'gsd-roadmapper': { quality: 'opus', balanced: 'sonnet', budget: 'sonnet' },
  'gsd-executor': { quality: 'opus', balanced: 'sonnet', budget: 'sonnet' },
  'gsd-phase-researcher': {
    quality: 'opus',
    balanced: 'sonnet',
    budget: 'haiku',
  },
  'gsd-project-researcher': {
    quality: 'opus',
    balanced: 'sonnet',
    budget: 'haiku',
  },
  'gsd-research-synthesizer': {
    quality: 'sonnet',
    balanced: 'sonnet',
    budget: 'haiku',
  },
  'gsd-debugger': { quality: 'opus', balanced: 'sonnet', budget: 'sonnet' },
  'gsd-codebase-mapper': {
    quality: 'sonnet',
    balanced: 'haiku',
    budget: 'haiku',
  },
  'gsd-incremental-mapper': {
    quality: 'sonnet',
    balanced: 'sonnet',
    budget: 'haiku',
  },
  'gsd-verifier': { quality: 'opus', balanced: 'sonnet', budget: 'haiku' },
  'gsd-plan-checker': {
    quality: 'sonnet',
    balanced: 'sonnet',
    budget: 'haiku',
  },
  'gsd-integration-checker': {
    quality: 'sonnet',
    balanced: 'sonnet',
    budget: 'haiku',
  },
  'gsd-nyquist-auditor': {
    quality: 'sonnet',
    balanced: 'sonnet',
    budget: 'haiku',
  },
  'gsd-ui-researcher': { quality: 'opus', balanced: 'sonnet', budget: 'haiku' },
  'gsd-ui-auditor': { quality: 'sonnet', balanced: 'sonnet', budget: 'haiku' },
};
const VALID_PROFILES = Object.keys(MODEL_PROFILES['gsd-planner']);

/**
 * Valid values for the `effort:` frontmatter field and for `effort_overrides.*`
 * entries in .planning/config.json.
 *
 * Tier ordering (ascending thinking budget): low < medium < high < xhigh < max.
 * `inherit` resolves to null in resolveEffortInternal (omits the field).
 */
const VALID_EFFORT_VALUES = [
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
  'inherit',
];

/**
 * Mapping of GSD agent to effort level for each profile.
 *
 * Quality: critical decision-makers (planner, roadmapper, debugger, verifier) at xhigh, others at high.
 * Balanced: all inherit (session default applies, matches current behavior).
 * Budget: writers/decision-makers at high, mechanical/read-only agents at medium.
 */
const EFFORT_PROFILES = {
  'gsd-planner': { quality: 'xhigh', balanced: 'inherit', budget: 'high' },
  'gsd-roadmapper': { quality: 'xhigh', balanced: 'inherit', budget: 'high' },
  'gsd-executor': { quality: 'high', balanced: 'inherit', budget: 'high' },
  'gsd-phase-researcher': {
    quality: 'high',
    balanced: 'inherit',
    budget: 'medium',
  },
  'gsd-project-researcher': {
    quality: 'high',
    balanced: 'inherit',
    budget: 'medium',
  },
  'gsd-research-synthesizer': {
    quality: 'high',
    balanced: 'inherit',
    budget: 'medium',
  },
  'gsd-debugger': { quality: 'xhigh', balanced: 'inherit', budget: 'high' },
  'gsd-codebase-mapper': {
    quality: 'high',
    balanced: 'inherit',
    budget: 'medium',
  },
  'gsd-incremental-mapper': {
    quality: 'high',
    balanced: 'inherit',
    budget: 'medium',
  },
  'gsd-verifier': { quality: 'xhigh', balanced: 'inherit', budget: 'high' },
  'gsd-plan-checker': {
    quality: 'high',
    balanced: 'inherit',
    budget: 'medium',
  },
  'gsd-integration-checker': {
    quality: 'high',
    balanced: 'inherit',
    budget: 'medium',
  },
  'gsd-nyquist-auditor': {
    quality: 'high',
    balanced: 'inherit',
    budget: 'medium',
  },
  'gsd-ui-researcher': {
    quality: 'high',
    balanced: 'inherit',
    budget: 'medium',
  },
  'gsd-ui-auditor': { quality: 'high', balanced: 'inherit', budget: 'medium' },
};

/**
 * Formats the agent-to-model mapping as a human-readable table (in string format).
 *
 * @param {Object<string, string>} agentToModelMap - A mapping from agent to model
 * @returns {string} A formatted table string
 */
function formatAgentToModelMapAsTable(agentToModelMap) {
  const agentWidth = Math.max(
    'Agent'.length,
    ...Object.keys(agentToModelMap).map((a) => a.length),
  );
  const modelWidth = Math.max(
    'Model'.length,
    ...Object.values(agentToModelMap).map((m) => m.length),
  );
  const sep = '─'.repeat(agentWidth + 2) + '┼' + '─'.repeat(modelWidth + 2);
  const header =
    ' ' + 'Agent'.padEnd(agentWidth) + ' │ ' + 'Model'.padEnd(modelWidth);
  let agentToModelTable = header + '\n' + sep + '\n';
  for (const [agent, model] of Object.entries(agentToModelMap)) {
    agentToModelTable +=
      ' ' + agent.padEnd(agentWidth) + ' │ ' + model.padEnd(modelWidth) + '\n';
  }
  return agentToModelTable;
}

/**
 * Returns a mapping from agent to model for the given model profile.
 *
 * @param {string} normalizedProfile - The normalized (lowercase and trimmed) profile name
 * @returns {Object<string, string>} A mapping from agent to model for the given profile
 */
function getAgentToModelMapForProfile(normalizedProfile) {
  const agentToModelMap = {};
  for (const [agent, profileToModelMap] of Object.entries(MODEL_PROFILES)) {
    agentToModelMap[agent] = profileToModelMap[normalizedProfile];
  }
  return agentToModelMap;
}

/**
 * Formats the agent-to-effort mapping as a human-readable table (in string format).
 *
 * @param {Object<string, string>} agentToEffortMap - A mapping from agent to effort level
 * @returns {string} A formatted table string
 */
function formatAgentToEffortMapAsTable(agentToEffortMap) {
  const agentWidth = Math.max(
    'Agent'.length,
    ...Object.keys(agentToEffortMap).map((a) => a.length),
  );
  const effortWidth = Math.max(
    'Effort'.length,
    ...Object.values(agentToEffortMap).map((e) => e.length),
  );
  const sep =
    '\u2500'.repeat(agentWidth + 2) +
    '\u253C' +
    '\u2500'.repeat(effortWidth + 2);
  const header =
    ' ' +
    'Agent'.padEnd(agentWidth) +
    ' \u2502 ' +
    'Effort'.padEnd(effortWidth);
  let table = header + '\n' + sep + '\n';
  for (const [agent, effort] of Object.entries(agentToEffortMap)) {
    table +=
      ' ' +
      agent.padEnd(agentWidth) +
      ' \u2502 ' +
      effort.padEnd(effortWidth) +
      '\n';
  }
  return table;
}

/**
 * Returns a mapping from agent to effort level for the given effort profile.
 *
 * @param {string} normalizedProfile - The normalized (lowercase and trimmed) profile name
 * @returns {Object<string, string>} A mapping from agent to effort for the given profile
 */
function getAgentToEffortMapForProfile(normalizedProfile) {
  const agentToEffortMap = {};
  for (const [agent, profileToEffortMap] of Object.entries(EFFORT_PROFILES)) {
    agentToEffortMap[agent] = profileToEffortMap[normalizedProfile];
  }
  return agentToEffortMap;
}

module.exports = {
  MODEL_PROFILES,
  EFFORT_PROFILES,
  VALID_PROFILES,
  VALID_EFFORT_VALUES,
  formatAgentToModelMapAsTable,
  formatAgentToEffortMapAsTable,
  getAgentToModelMapForProfile,
  getAgentToEffortMapForProfile,
};
