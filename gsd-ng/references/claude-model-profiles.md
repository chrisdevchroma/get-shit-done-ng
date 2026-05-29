# Model Profiles

Model profiles control which Claude model each GSD agent uses. This allows balancing quality vs token spend.

## Profile Definitions

| Agent | `quality` | `balanced` | `budget` |
|-------|-----------|------------|----------|
| gsd-planner | opus | opus | sonnet |
| gsd-roadmapper | opus | sonnet | sonnet |
| gsd-executor | opus | sonnet | sonnet |
| gsd-phase-researcher | opus | sonnet | haiku |
| gsd-project-researcher | opus | sonnet | haiku |
| gsd-research-synthesizer | sonnet | sonnet | haiku |
| gsd-debugger | opus | sonnet | sonnet |
| gsd-codebase-mapper | sonnet | haiku | haiku |
| gsd-incremental-mapper | sonnet | sonnet | haiku |
| gsd-verifier | opus | sonnet | haiku |
| gsd-plan-checker | sonnet | sonnet | haiku |
| gsd-integration-checker | sonnet | sonnet | haiku |
| gsd-nyquist-auditor | sonnet | sonnet | haiku |
| gsd-ui-researcher | opus | sonnet | haiku |
| gsd-ui-auditor | sonnet | sonnet | haiku |

## Profile Philosophy

**quality** - Maximum reasoning power
- Opus for content producers (planner, roadmapper, executor, researchers, debugger, verifier, ui-researcher)
- Sonnet for synthesizers, mappers, and checkers
- Use when: quota available, critical architecture work

**balanced** (default) - Smart allocation
- Opus only for planning (where architecture decisions happen)
- Sonnet for execution and research (follows explicit instructions)
- Sonnet for verification (needs reasoning, not just pattern matching)
- Use when: normal development, good balance of quality and cost

**budget** - Minimal Opus usage
- Sonnet for anything that writes code
- Haiku for research and verification
- Use when: conserving quota, high-volume work, less critical phases

## Resolution Logic

Orchestrators resolve model before spawning:

```
1. Read .planning/config.json
2. Check model_overrides for agent-specific override
3. If no override, look up agent in profile table
4. Pass model parameter to Task call
```

## Per-Agent Overrides

Override specific agents without changing the entire profile:

```json
{
  "model_profile": "balanced",
  "model_overrides": {
    "gsd-executor": "opus",
    "gsd-planner": "haiku"
  }
}
```

Overrides take precedence over the profile. Valid values: `opus`, `sonnet`, `haiku`.

## Switching Profiles

Runtime: `{{COMMAND_PREFIX}}set-profile <profile>`

Per-project default: Set in `.planning/config.json`:
```json
{
  "model_profile": "balanced"
}
```

## Design Rationale

**Why Opus for gsd-planner?**
Planning involves architecture decisions, goal decomposition, and task design. This is where model quality has the highest impact.

**Why Sonnet for gsd-executor?**
Executors follow explicit PLAN.md instructions. The plan already contains the reasoning; execution is implementation.

**Why Sonnet (not Haiku) for verifiers in balanced?**
Verification requires goal-backward reasoning - checking if code *delivers* what the phase promised, not just pattern matching. Sonnet handles this well; Haiku may miss subtle gaps.

**Why Haiku for gsd-codebase-mapper?**
Read-only exploration and pattern extraction. No reasoning required, just structured output from file contents.

**Why `inherit` instead of passing `opus` directly?**
Claude Code's `"opus"` alias maps to a specific model version. Organizations may block older opus versions while allowing newer ones. The `inherit` profile causes `resolveModelInternal` to return `null`, which omits the `model` parameter from Agent tool calls. This lets opus-tier agents inherit whatever model the user's session is running. This avoids version conflicts and silent fallbacks to Sonnet.

## Effort Profiles

Effort profiles control the `effort:` frontmatter injected into agent spawn calls. This maps each agent to a thinking budget tier. Effort is Claude-only — it is not injected for Copilot runtimes.

### Effort Profile Definitions

| Agent | `quality` | `balanced` | `budget` |
|-------|-----------|------------|----------|
| gsd-planner | max | inherit | high |
| gsd-roadmapper | max | inherit | high |
| gsd-executor | high | inherit | high |
| gsd-phase-researcher | high | inherit | medium |
| gsd-project-researcher | high | inherit | medium |
| gsd-research-synthesizer | high | inherit | medium |
| gsd-debugger | max | inherit | high |
| gsd-codebase-mapper | high | inherit | medium |
| gsd-incremental-mapper | high | inherit | medium |
| gsd-verifier | max | inherit | high |
| gsd-plan-checker | high | inherit | medium |
| gsd-integration-checker | high | inherit | medium |
| gsd-nyquist-auditor | high | inherit | medium |
| gsd-ui-researcher | high | inherit | medium |
| gsd-ui-auditor | high | inherit | medium |

### Valid Effort Values

- `low` — Minimal thinking budget
- `medium` — Moderate thinking budget
- `high` — High thinking budget
- `xhigh` — Extra-high thinking budget (Opus 4.7+ only)
- `max` — Maximum thinking budget (Opus only)
- `inherit` — Omit effort from spawn; session default applies (current behavior)

**Tier ordering (ascending thinking budget):** `low < medium < high < xhigh < max`. Use `inherit` to explicitly omit the frontmatter.

### Effort Resolution Order

```
1. If engine runtime != 'claude', return null (effort unsupported)
2. Check effort_overrides[agent] in .planning/config.json
3. If no override, look up agent in EFFORT_PROFILES[agent][profile]
4. If value is 'inherit', return null (omit effort parameter)
5. Resolve the agent's model. If the model is incompatible with the effort, return null:
   - haiku does not support the effort: frontmatter at all
   - xhigh and max require opus
   Emit a one-line stderr warning only if step 2 produced an explicit non-inherit override that is being dropped here.
```

### Runtime Gating

Effort is Claude-only. The engine detects its runtime from a `.runtime` marker file that `install.js` writes into the deployed engine tree (`<config-dir>/gsd-ng/.runtime`, sibling of `VERSION`). When the marker is absent, the engine defaults to Claude. On Copilot installs, `resolveEffortInternal` always returns null regardless of profile or overrides.

### Per-Agent Effort Overrides

Override specific agents without changing the entire profile:

```json
{
  "model_profile": "balanced",
  "effort_overrides": {
    "gsd-executor": "max",
    "gsd-planner": "high"
  }
}
```

Configure via CLI: `gsd-tools config-set effort_overrides.gsd-executor max`

Overrides take precedence over the profile. Valid values: `low`, `medium`, `high`, `xhigh`, `max`, `inherit`. Use `inherit` to clear the per-agent override so effort is omitted/null and the session-level behavior is preserved.

### Profile Philosophy

**quality** — Maximum reasoning power
- Critical decision-makers (planner, roadmapper, debugger, verifier) at `max`
- All other agents at `high`
- No agent below `high` — use when quota is available and correctness is critical

**balanced** (default) — Session default applies
- All agents at `inherit` — omits effort from spawn
- Current behavior preserved: matches session-level thinking budget
- Use for normal development when you don't want to override session settings

**budget** — Reduced thinking where safe
- Decision-makers (planner, executor, debugger, verifier) at `high`
- Mechanical/read-only agents (researchers, mappers, checkers) at `medium`
- Use when conserving budget; never drops below `medium`
