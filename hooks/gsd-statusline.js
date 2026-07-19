#!/usr/bin/env node
// Claude Code Statusline - GSD Edition
// Shows: model | current task | directory | context usage | git branch | token breakdown

const fs = require('fs');
const path = require('path');
const os = require('os');

// ── Locate shared cache-path module ──────────────────────────────────────────
// Dual-candidate pattern (deployed vs source layout), same as gsd-check-update.js.
let _cachePathLib = null;
try {
  const candidates = [
    path.join(__dirname, '..', 'bin', 'lib', 'cache-path.cjs'),
    path.join(__dirname, '..', 'gsd-ng', 'bin', 'lib', 'cache-path.cjs'),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      _cachePathLib = require(p);
      break;
    }
  }
} catch (e) {
  // Silent fail — statusline must never crash; banner simply won't show
}
const { execSync } = require('child_process');
const { readStdinWithTimeout } = require('./gsd-hook-stdin.cjs');

// ─── Utility: TTL-based file cache ──────────────────────────────────────────

/**
 * Cache a computed string value to a file with a TTL.
 * Returns the cached value if fresh, otherwise calls computeFn(), writes result, and returns it.
 * Returns '' on any error (silent fail pattern for statusline).
 */
function withCache(cacheFile, ttlSeconds, computeFn) {
  try {
    if (fs.existsSync(cacheFile)) {
      const ageMs = Date.now() - fs.statSync(cacheFile).mtimeMs;
      if (ageMs / 1000 < ttlSeconds) return fs.readFileSync(cacheFile, 'utf8');
    }
  } catch (e) {
    /* cache read failed — fall through to compute */
  }
  try {
    const value = computeFn();
    try {
      fs.writeFileSync(cacheFile, value);
    } catch (e) {
      /* cache write failed — return value uncached */
    }
    return value;
  } catch (e) {
    return '';
  }
}

// ─── Token formatting ────────────────────────────────────────────────────────

/**
 * Format a token count as a human-readable string.
 * e.g. 12345 → "12.3k", 500 → "500"
 */
function formatTokenCount(n) {
  return n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n);
}

// ─── Git branch display ──────────────────────────────────────────────────────

/**
 * Format a branch name with ANSI color.
 * main/master → red (\x1b[31m), all others → cyan (\x1b[36m)
 */
function formatBranchDisplay(branchName) {
  const isDanger = branchName === 'main' || branchName === 'master';
  return isDanger
    ? `\x1b[31m[${branchName}]\x1b[0m`
    : `\x1b[36m[${branchName}]\x1b[0m`;
}

/**
 * Render the git branch segment.
 * Uses TTL-based caching (5s) to avoid blocking the statusline on every call.
 * Returns '' if disabled, git not available, or no branch.
 */
function renderGitBranch(data, config) {
  if (config?.statusline?.components?.git_branch === false) return '';
  const cacheFile = path.join(os.tmpdir(), 'gsd-statusline-git.cache');
  return withCache(cacheFile, 5, () => {
    const cwd = data.workspace?.current_dir || process.cwd();
    const branch = execSync('git branch --show-current', {
      encoding: 'utf8',
      timeout: 1500,
      cwd,
      stdio: ['pipe', 'pipe', 'ignore'],
    }).trim();
    if (!branch) return '';
    return formatBranchDisplay(branch);
  });
}

// ─── Token breakdown ─────────────────────────────────────────────────────────

/**
 * Render the token breakdown segment (cache creation ↑ and cache read ↓).
 * Returns '' if disabled, current_usage is null, or both counts are 0.
 */
function renderTokenBreakdown(data, config) {
  if (config?.statusline?.components?.token_breakdown === false) return '';
  const usage = data.context_window?.current_usage;
  if (!usage) return '';
  const created = usage.cache_creation_input_tokens || 0;
  const read = usage.cache_read_input_tokens || 0;
  if (created === 0 && read === 0) return '';
  return `\x1b[2m\u2191${formatTokenCount(created)} \u2193${formatTokenCount(read)}\x1b[0m`;
}

// ─── Cross-model context warning ─────────────────────────────────────────────

/**
 * Render the cross-model context warning.
 * Shows [>200k] in yellow when:
 *   - exceeds_200k_tokens is true (not null/false/undefined)
 *   - context_window_size > 200000 (only for large-window models; skip Sonnet/Haiku class)
 * This warning indicates token usage exceeded 200K in the current session,
 * which is a degradation signal for large-window models (Opus 4.6 = 1M window).
 * Returns '' otherwise.
 */
function renderCrossModelWarning(data, config) {
  if (config?.statusline?.components?.cross_model_warning === false) return '';
  if (!data.exceeds_200k_tokens) return '';
  const windowSize = data.context_window?.context_window_size || 0;
  if (windowSize <= 200000) return '';
  return `\x1b[33m[>200k]\x1b[0m`;
}

// ─── GSD update banner ───────────────────────────────────────────────────────

/**
 * Render the GSD update-available banner segment, or '' to suppress it.
 *
 * Resolves the cache path through the shared cache-path.cjs helper (local-before-global),
 * so it reads the same cache the writer wrote and a stale global cache is never read for a
 * local install. Suppresses the banner when cache.installed differs from the live local
 * VERSION — guards the within-session gap after /gsd:update before the next TTL refresh.
 *
 * @param {object} opts - cwd (project dir), homeDir, env, and fs are all injectable for tests.
 * @returns {string}
 */
function renderUpdateBanner({ cwd, homeDir, env, fs: fsArg }) {
  try {
    const fsLib = fsArg || fs;
    const hd = homeDir || os.homedir();
    const e = env || process.env;

    if (!_cachePathLib) return '';
    const { resolveUpdateCacheFile, detectConfigDir } = _cachePathLib;

    const cacheFile = resolveUpdateCacheFile({ cwd, homeDir: hd, env: e });
    if (!fsLib.existsSync(cacheFile)) return '';
    let cache;
    try {
      cache = JSON.parse(fsLib.readFileSync(cacheFile, 'utf8'));
    } catch (_) {
      return '';
    }
    if (!cache.update_available) return '';

    const localConfigDir = detectConfigDir(cwd, e);
    if (localConfigDir) {
      try {
        const liveVersion = fsLib
          .readFileSync(path.join(localConfigDir, 'gsd-ng', 'VERSION'), 'utf8')
          .trim();
        if (cache.installed !== liveVersion) return ''; // updated mid-session — suppress until next TTL
      } catch (_) {
        return ''; // VERSION unreadable — suppress to be safe
      }
    }

    return '\x1b[33m⬆ /gsd:update\x1b[0m │ ';
  } catch (_) {
    return '';
  }
}

// ─── Main statusline ──────────────────────────────────────────────────────────

readStdinWithTimeout((input) => {
  try {
    const data = JSON.parse(input);
    const model = data.model?.display_name || 'Claude';
    const dir = data.workspace?.current_dir || process.cwd();
    const session = data.session_id || '';
    const remaining = data.context_window?.remaining_percentage;

    // Context window display (shows USED percentage scaled to usable context)
    // Claude Code reserves ~16.5% for autocompact buffer, so usable context
    // is 83.5% of the total window. We normalize to show 100% at that point.
    const AUTO_COMPACT_BUFFER_PCT = 16.5;
    let ctx = '';
    if (remaining != null) {
      // Normalize: subtract buffer from remaining, scale to usable range
      const usableRemaining = Math.max(
        0,
        ((remaining - AUTO_COMPACT_BUFFER_PCT) /
          (100 - AUTO_COMPACT_BUFFER_PCT)) *
          100,
      );
      const used = Math.max(
        0,
        Math.min(100, Math.round(100 - usableRemaining)),
      );

      // Write context metrics to bridge file for the context-monitor PostToolUse hook.
      // The monitor reads this file to inject agent-facing warnings when context is low.
      if (session) {
        // GSD_SIMULATE_SANDBOX: skip bridge write defensively (os.tmpdir() is writable
        // in sandbox, but guard added per locked degradation pattern for all hook writes)
        if (!process.env.GSD_SIMULATE_SANDBOX) {
          try {
            const bridgePath = path.join(
              os.tmpdir(),
              `claude-ctx-${session}.json`,
            );
            const bridgeData = JSON.stringify({
              session_id: session,
              remaining_percentage: remaining,
              used_pct: used,
              timestamp: Math.floor(Date.now() / 1000),
            });
            fs.writeFileSync(bridgePath, bridgeData);
          } catch (e) {
            // Silent fail -- bridge is best-effort, don't break statusline
          }
        }
      }

      // Build progress bar (10 segments)
      const filled = Math.floor(used / 10);
      const bar = '█'.repeat(filled) + '░'.repeat(10 - filled);

      // Color based on usable context thresholds
      if (used < 50) {
        ctx = `\x1b[32m${bar} ${used}%\x1b[0m`;
      } else if (used < 65) {
        ctx = `\x1b[33m${bar} ${used}%\x1b[0m`;
      } else if (used < 80) {
        ctx = `\x1b[38;5;208m${bar} ${used}%\x1b[0m`;
      } else {
        ctx = `\x1b[5;31m💀 ${bar} ${used}%\x1b[0m`;
      }
    }

    // GSD update available? (local-before-global cache precedence + staleness guard)
    const gsdUpdate = renderUpdateBanner({
      cwd: dir,
      homeDir: os.homedir(),
      env: process.env,
    });

    // Load config for statusline component toggles
    // Direct JSON.parse — avoid spawning gsd-tools (process spawn overhead per anti-pattern docs)
    let config = {};
    try {
      const projectDir =
        data.workspace?.project_dir ||
        data.workspace?.current_dir ||
        process.cwd();
      const configPath = path.join(projectDir, '.planning', 'config.json');
      if (fs.existsSync(configPath)) {
        config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      }
    } catch (e) {
      // Silent fail — config is optional; all components default to enabled
    }

    // New component segments
    const gitBranch = renderGitBranch(data, config);
    const tokenBreakdown = renderTokenBreakdown(data, config);
    const crossModelWarn = renderCrossModelWarning(data, config);

    // Output
    const dirname = path.basename(dir);

    // gsdUpdate already includes its own ' │ ' suffix when non-empty,
    // so prepend it to model rather than treating as a separate segment.
    const modelSeg = `${gsdUpdate}\x1b[2m${model}\x1b[0m`;

    // dirname [branch] combined — branch is '' when unavailable
    const dirBranchSeg = `\x1b[2m${dirname}\x1b[0m${gitBranch ? ' ' + gitBranch : ''}`;

    // ctx + crossModelWarn combined — either may be empty
    const ctxCombined = [ctx, crossModelWarn].filter(Boolean).join(' ');

    // Build segments array in desired order:
    //   gsdUpdate model | dirname [branch] | ctx crossModelWarn | tokenBreakdown
    const segments = [
      modelSeg,
      dirBranchSeg,
      ctxCombined,
      tokenBreakdown,
    ].filter((s) => s !== '');

    process.stdout.write(segments.join(' \u2502 '));
  } catch (e) {
    // Silent fail - don't break statusline on parse errors
  }
});

// Exports for testing (not used by Claude Code — hook reads stdin, writes stdout)
if (typeof module !== 'undefined') {
  module.exports = {
    formatTokenCount,
    formatBranchDisplay,
    renderTokenBreakdown,
    renderCrossModelWarning,
    renderGitBranch,
    withCache,
    renderUpdateBanner,
  };
}
