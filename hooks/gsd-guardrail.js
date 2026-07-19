#!/usr/bin/env node
// gsd-hook-version: {{GSD_VERSION}}
// gsd-guardrail.js - PreToolUse advisory hook for GSD workflow adherence
// Registered with matcher "Edit|Write|EnterPlanMode"
// Advisory only: emits additionalContext, never blocks (exit 2)
//
// Fires when agents edit files outside GSD workflow context.
// Two patterns detected:
//   1. Native plan mode activation (EnterPlanMode tool)
//   2. Out-of-scope file edits (Edit/Write targeting project files outside .planning/ or .claude/)
//
// Suppression (either one disables guardrail):
//   - GSD_NO_GUARDRAIL=1 env var (session-level override)
//   - workflow.guardrail_enabled: false in .planning/config.json (persistent override)
//
// Logging: JSONL events written to .claude/logs/guardrail-events.log (or GSD_GUARDRAIL_LOG_DIR)

const fs = require('fs');
const path = require('path');
const { readStdinWithTimeout } = require('./gsd-hook-stdin.cjs');

// ── Session-level override: check env var before reading stdin ────────────────
if (process.env.GSD_NO_GUARDRAIL === '1') {
  process.exit(0);
}

readStdinWithTimeout(input => {
  try {
    const data = JSON.parse(input);
    const cwd = data.cwd || process.cwd();
    const toolName = data.tool_name || '';
    const toolInput = data.tool_input || {};

    // ── Check if this is a GSD project ───────────────────────────────────────
    if (!fs.existsSync(path.join(cwd, '.planning', 'STATE.md'))) {
      // Not a GSD project — exit silently
      process.exit(0);
    }

    // ── Persistent override: check config.json ────────────────────────────────
    // Absence of the key means enabled (default-on per CONTEXT.md decision).
    // Only workflow.guardrail_enabled === false (explicit opt-out) disables it.
    try {
      const configPath = path.join(cwd, '.planning', 'config.json');
      if (fs.existsSync(configPath)) {
        const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        if (config.workflow && config.workflow.guardrail_enabled === false) {
          process.exit(0);
        }
      }
    } catch (_configErr) {
      // Silent fail on missing or malformed config — continue with enabled
    }

    // ── EnterPlanMode detection ───────────────────────────────────────────────
    if (toolName === 'EnterPlanMode') {
      const message =
        'GSD WORKFLOW REMINDER: A GSD workflow is active in this project. ' +
        'Prefer using /gsd:plan-phase to create plans rather than native plan mode. ' +
        'Native plan mode bypasses GSD\'s state tracking, atomic commits, and SUMMARY generation.';

      logEvent(cwd, { event: 'plan_mode' }, toolName);
      process.stdout.write(JSON.stringify({ additionalContext: message }));
      process.exit(0);
    }

    // ── Out-of-scope file detection (Edit/Write only) ─────────────────────────
    if (toolName === 'Edit' || toolName === 'Write') {
      const filePath = toolInput.file_path || (toolInput.content && toolInput.content.file_path) || '';

      // GSD internal files — pass through silently
      if (filePath.includes('.planning/') || filePath.includes('.claude/')) {
        process.exit(0);
      }

      const message =
        'GSD WORKFLOW REMINDER: You are editing a project file directly. ' +
        'If you are an orchestrator, prefer spawning gsd-executor agents rather than editing files directly. ' +
        'Direct edits bypass atomic commit tracking and SUMMARY.md generation. ' +
        'If you are a gsd-executor agent, ignore this message -- you are operating correctly.';

      logEvent(cwd, { event: 'out_of_scope_edit', file: filePath }, toolName);
      process.stdout.write(JSON.stringify({ additionalContext: message }));
      process.exit(0);
    }

    // If tool name doesn't match any pattern (shouldn't happen given hook matcher),
    // exit silently.
    process.exit(0);
  } catch (_e) {
    // Silent fail — never block tool execution
    process.exit(0);
  }
});

/**
 * Append a JSONL event to the guardrail log.
 * Uses GSD_GUARDRAIL_LOG_DIR env var for testability, falls back to cwd/.claude/logs/
 * Silent fail on any fs errors (e.g., sandbox restrictions).
 *
 * @param {string} cwd - Working directory of the GSD project
 * @param {object} eventData - { event: string, file?: string, expected_files?: string[] }
 * @param {string} toolName - Tool that triggered the guardrail
 */
function logEvent(cwd, eventData, toolName) {
  try {
    const logDir = process.env.GSD_GUARDRAIL_LOG_DIR || path.join(cwd, '.claude', 'logs');
    try {
      fs.mkdirSync(logDir, { recursive: true });
    } catch (_mkdirErr) {
      // Silent fail if sandbox blocks directory creation
      return;
    }

    const logFile = path.join(logDir, 'guardrail-events.log');
    const entry = JSON.stringify({
      ts: new Date().toISOString(),
      event: eventData.event,
      tool: toolName,
      file: eventData.file || null,
      expected_files: eventData.expected_files || null,
    });

    fs.appendFileSync(logFile, entry + '\n');
  } catch (_logErr) {
    // Silent fail — logging must never prevent hook exit
  }
}
