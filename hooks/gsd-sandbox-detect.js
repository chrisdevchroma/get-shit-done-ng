#!/usr/bin/env node
// Sandbox Detect - PreToolUse hook
// Detects whether Claude Code is running inside its filesystem sandbox and
// injects a one-time additionalContext message so the agent can adapt its
// behaviour (avoid writing to restricted paths, etc.).
//
// Detection strategy (in priority order):
//   1. SANDBOX_RUNTIME=1 env var (set by Claude Code when sandbox is active)
//   2. Probe write to ~/.claude/ — if EROFS/EACCES/EPERM, sandbox is active
//
// Once-per-session gate:
//   Writes a marker to os.tmpdir() (always writable, even inside sandbox).
//   On subsequent calls with the same session_id, exits 0 silently.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { readStdinWithTimeout } = require('./gsd-hook-stdin.cjs');

readStdinWithTimeout(input => {
  try {
    const data = JSON.parse(input);
    const sessionId = data.session_id || 'unknown';

    // ── Once-per-session gate ─────────────────────────────────────────────
    const sandboxTmpDir = [process.env.TMPDIR, os.tmpdir(), `/tmp/claude-${process.getuid()}`, '/tmp']
      .filter(Boolean)
      .find(d => { try { return fs.existsSync(d); } catch { return false; } })
      || os.tmpdir();
    const markerPath = path.join(sandboxTmpDir, 'gsd-sandbox-detect-' + sessionId + '.flag');

    if (fs.existsSync(markerPath)) {
      // Already ran this session — exit silently
      process.exit(0);
    }

    // Write the marker (defensive try/catch — tmpdir should always be writable)
    try {
      fs.writeFileSync(markerPath, '1');
    } catch (_markerErr) {
      // If we can't write the marker we can't deduplicate — exit silently
      process.exit(0);
    }

    // ── Sandbox detection ─────────────────────────────────────────────────

    // Primary signal: explicit env var set by Claude Code
    const sandboxByEnv = process.env.SANDBOX_RUNTIME === '1';

    let sandboxByProbe = false;
    if (!sandboxByEnv) {
      // Fallback: attempt a probe write inside ~/.claude/
      const probePath = path.join(os.homedir(), '.claude', '.sandbox-probe-' + sessionId);
      try {
        fs.writeFileSync(probePath, '1');
        fs.unlinkSync(probePath); // clean up on success — not sandbox
      } catch (e) {
        if (e.code === 'EROFS' || e.code === 'EACCES' || e.code === 'EPERM') {
          sandboxByProbe = true;
        }
        // Other errors (e.g. ENOENT for missing ~/.claude/) → not sandbox
      }
    }

    // ── Output ────────────────────────────────────────────────────────────
    if (sandboxByEnv || sandboxByProbe) {
      const message =
        'SANDBOX MODE ACTIVE: Claude Code sandbox is restricting filesystem writes. ' +
        'GSD update checks (gsd-check-update.js) are operating in degraded mode — ' +
        'the update cache cannot be written. ' +
        'Context bridge writes (gsd-statusline.js, gsd-context-monitor.js) use tmpdir and work normally.';

      process.stdout.write(JSON.stringify({ additionalContext: message }));
    }

    // If not sandbox: exit 0 silently (no stdout write)
  } catch (_e) {
    // Silent fail — never block tool execution
    process.exit(0);
  }
});
