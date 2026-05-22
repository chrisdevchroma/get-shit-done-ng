#!/usr/bin/env node
// Check for GSD updates in background, write result to cache
// Called by SessionStart hook - runs once per session

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const homeDir = os.homedir();
const cwd = process.cwd();

// Detect GSD config directory — supports Claude Code (.claude), Copilot local (.github), Copilot global (.copilot)
// Respects CLAUDE_CONFIG_DIR for custom config directory setups
function detectConfigDir(baseDir) {
  // Check env override first (supports multi-account setups)
  const envDir = process.env.CLAUDE_CONFIG_DIR;
  if (envDir && fs.existsSync(path.join(envDir, 'gsd-ng', 'VERSION'))) {
    return envDir;
  }
  // Check Claude Code local (.claude/gsd-ng/VERSION)
  if (fs.existsSync(path.join(baseDir, '.claude', 'gsd-ng', 'VERSION'))) {
    return path.join(baseDir, '.claude');
  }
  // Check Copilot local (.github/gsd-ng/VERSION)
  if (fs.existsSync(path.join(baseDir, '.github', 'gsd-ng', 'VERSION'))) {
    return path.join(baseDir, '.github');
  }
  // Check Copilot global (~/.copilot/gsd-ng/VERSION)
  if (fs.existsSync(path.join(baseDir, '.copilot', 'gsd-ng', 'VERSION'))) {
    return path.join(baseDir, '.copilot');
  }
  return envDir || path.join(baseDir, '.claude');
}

const globalConfigDir = detectConfigDir(homeDir);
const projectConfigDir = detectConfigDir(cwd);
const cacheDir = path.join(globalConfigDir, 'cache');
const cacheFile = path.join(cacheDir, 'gsd-update-check.json');

// VERSION file locations (check project first, then global)
const projectVersionFile = path.join(projectConfigDir, 'gsd-ng', 'VERSION');
const globalVersionFile = path.join(globalConfigDir, 'gsd-ng', 'VERSION');

// ── Locate shared semver-utils module ─────────────────────────────────────────
// Supports both the source tree layout (gsd-ng/hooks/ → gsd-ng/gsd-ng/bin/lib/)
// and the deployed tree layout (.claude/gsd-ng/hooks/ → .claude/gsd-ng/bin/lib/).
const semverUtilsPath = (function () {
  const candidates = [
    // Deployed layout: hooks/ lives beside bin/lib/
    path.join(__dirname, '..', 'bin', 'lib', 'semver-utils.cjs'),
    // Source layout: hooks/ lives at gsd-ng/hooks/, lib at gsd-ng/gsd-ng/bin/lib/
    path.join(__dirname, '..', 'gsd-ng', 'bin', 'lib', 'semver-utils.cjs'),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
})();

// Defensive guard: if semver-utils is unreachable skip the update check silently.
if (!semverUtilsPath && !process.env.GSD_TEST_MODE) {
  process.exit(0);
}

// ── SemVer utilities (sourced from shared module) ─────────────────────────────
const { compareSemVer, normalizeTag, isSnapshot, parseChannel } =
  semverUtilsPath
    ? require(semverUtilsPath)
    : {
        compareSemVer: () => 0,
        normalizeTag: (t) => t,
        isSnapshot: () => false,
        parseChannel: () => null,
      };

// ── Child source builder ───────────────────────────────────────────────────────
/**
 * Build the JS source string for the detached child process.
 * @param {object} config
 * @param {string} config.cacheFile
 * @param {string} config.projectVersionFile
 * @param {string} config.globalVersionFile
 * @param {string} config.semverUtilsPath - absolute path to semver-utils.cjs
 * @param {string} config.githubOwner
 * @param {string} config.githubRepo
 * @param {number} config.githubTtl
 * @param {string} config.assetName
 * @returns {string} JS source for `node -e`
 */
function buildChildSource(config) {
  const {
    cacheFile: cf,
    projectVersionFile: pvf,
    globalVersionFile: gvf,
    semverUtilsPath: sup,
    githubOwner,
    githubRepo,
    githubTtl,
    // assetName currently unused in child logic but accepted for forward-compat
  } = config;

  return `(function() {
  const fs = require('fs');
  const { execSync } = require('child_process');
  const { compareSemVer, normalizeTag, isSnapshot, parseChannel, selectLatestForChannel } = require(${JSON.stringify(sup)});

  const cacheFile = ${JSON.stringify(cf)};
  const projectVersionFile = ${JSON.stringify(pvf)};
  const globalVersionFile = ${JSON.stringify(gvf)};
  const GITHUB_OWNER = ${JSON.stringify(githubOwner)};
  const GITHUB_REPO = ${JSON.stringify(githubRepo)};
  const GITHUB_TTL = ${JSON.stringify(githubTtl)};

  // Check project directory first (local install), then global
  let installed = '0.0.0';
  try {
    if (fs.existsSync(projectVersionFile)) {
      installed = fs.readFileSync(projectVersionFile, 'utf8').trim();
    } else if (fs.existsSync(globalVersionFile)) {
      installed = fs.readFileSync(globalVersionFile, 'utf8').trim();
    }
  } catch (e) {}

  const installedChannel = parseChannel(installed);

  // npm version lookup — channel-pinned for prerelease users, latest fallback for stable
  // Seam for testing: GSD_TEST_EXEC_NPMVIEW env var can point to a JS module that exports
  // a function(cmd) => string, injected in place of execSync for npm view calls.
  let execNpmView;
  if (process.env.GSD_TEST_EXEC_NPMVIEW) {
    execNpmView = require(process.env.GSD_TEST_EXEC_NPMVIEW);
  } else {
    execNpmView = function(cmd) { return execSync(cmd, { encoding: 'utf8', timeout: 10000 }); };
  }

  let latest = null;
  if (installedChannel) {
    try {
      const v = execNpmView('npm view gsd-ng dist-tags.' + installedChannel)
        .toString().trim();
      if (v && /^\\d+\\.\\d+\\.\\d+/.test(v)) latest = v;
    } catch (e) {}
  }
  if (!latest) {
    try {
      const v = execNpmView('npm view gsd-ng version').toString().trim();
      if (v && /^\\d+\\.\\d+\\.\\d+/.test(v)) latest = v;
    } catch (e) {}
  }

  let source = latest ? 'npm' : 'unknown';

  // If npm failed and installed version is not a snapshot, try GitHub
  if (!latest && !isSnapshot(installed)) {
    // Check TTL cooldown — skip GitHub if checked recently
    let cachedData = null;
    try { cachedData = JSON.parse(fs.readFileSync(cacheFile, 'utf8')); } catch(e) {}
    const now = Math.floor(Date.now() / 1000);
    if (cachedData && cachedData.source === 'github' && cachedData.checked && (now - cachedData.checked) < GITHUB_TTL) {
      // Within cooldown — reuse cached result, don't hit API
      process.exit(0);
    }

    const https = require('https');

    if (installedChannel) {
      // Prerelease user: paginate /releases?per_page=100 and channel-filter
      const opts = {
        hostname: 'api.github.com',
        path: '/repos/' + GITHUB_OWNER + '/' + GITHUB_REPO + '/releases?per_page=100',
        headers: {
          'User-Agent': 'gsd-ng',
          'Accept': 'application/vnd.github.v3+json',
        },
        timeout: 10000,
      };
      const cachedEtag = (cachedData && cachedData.etag) || null;
      if (cachedEtag) opts.headers['If-None-Match'] = cachedEtag;

      const req = https.request(opts, function(res) {
        const etag = res.headers['etag'] || null;

        if (res.statusCode === 304) {
          res.destroy();
          if (cachedData) {
            cachedData.checked = now;
            if (etag) cachedData.etag = etag;
            try { fs.writeFileSync(cacheFile, JSON.stringify(cachedData)); } catch(e) {}
          }
          process.exit(0);
        }

        if (res.statusCode === 404) {
          res.destroy();
          const result = { update_available: false, installed, latest: 'unknown', checked: now, source: 'github', etag: null };
          try { fs.writeFileSync(cacheFile, JSON.stringify(result)); } catch(e) {}
          process.exit(0);
        }

        if (res.statusCode !== 200) {
          res.destroy();
          process.exit(0);
        }

        let data = '';
        res.on('data', function(c) { data += c; });
        res.on('end', function() {
          try {
            const releases = JSON.parse(data);
            if (!Array.isArray(releases)) { process.exit(0); }
            const tags = releases.map(function(x) { return normalizeTag(x.tag_name || ''); });
            latest = selectLatestForChannel(tags, installedChannel);
            if (!latest) { process.exit(0); }
            source = 'github';
            const result = {
              update_available: compareSemVer(installed, latest) < 0,
              installed,
              latest,
              checked: now,
              source,
              etag: etag || null,
            };
            try { fs.writeFileSync(cacheFile, JSON.stringify(result)); } catch(e) {}
          } catch(e) {}
          process.exit(0);
        });
      });

      req.on('error', function() { process.exit(0); });
      req.on('timeout', function() { req.destroy(); process.exit(0); });
      req.end();
      // Async path — do not fall through to synchronous write
      return;
    } else {
      // Stable user: /releases/latest + skip prerelease
      const opts = {
        hostname: 'api.github.com',
        path: '/repos/' + GITHUB_OWNER + '/' + GITHUB_REPO + '/releases/latest',
        headers: {
          'User-Agent': 'gsd-ng',
          'Accept': 'application/vnd.github.v3+json',
        },
        timeout: 10000,
      };
      const cachedEtag = (cachedData && cachedData.etag) || null;
      if (cachedEtag) opts.headers['If-None-Match'] = cachedEtag;

      const req = https.request(opts, function(res) {
        const etag = res.headers['etag'] || null;

        // 304: release unchanged — update checked timestamp and exit
        if (res.statusCode === 304) {
          res.destroy();
          if (cachedData) {
            cachedData.checked = now;
            if (etag) cachedData.etag = etag;
            try { fs.writeFileSync(cacheFile, JSON.stringify(cachedData)); } catch(e) {}
          }
          process.exit(0);
        }

        // 404: no release exists yet — not an error, just no update
        if (res.statusCode === 404) {
          res.destroy();
          const result = { update_available: false, installed, latest: 'unknown', checked: now, source: 'github', etag: null };
          try { fs.writeFileSync(cacheFile, JSON.stringify(result)); } catch(e) {}
          process.exit(0);
        }

        // Non-200: unexpected — treat as failure, write no-update
        if (res.statusCode !== 200) {
          res.destroy();
          process.exit(0);
        }

        let data = '';
        res.on('data', function(c) { data += c; });
        res.on('end', function() {
          try {
            const r = JSON.parse(data);
            // Skip pre-release versions
            if (r.prerelease) { process.exit(0); }
            const tagVersion = normalizeTag(r.tag_name || '');
            if (!tagVersion) { process.exit(0); }
            latest = tagVersion;
            source = 'github';
            // Write cache with GitHub-specific fields
            const result = {
              update_available: compareSemVer(installed, latest) < 0,
              installed,
              latest,
              checked: now,
              source,
              etag: etag || null,
            };
            try { fs.writeFileSync(cacheFile, JSON.stringify(result)); } catch(e) {}
          } catch(e) {}
          process.exit(0);
        });
      });

      req.on('error', function() { process.exit(0); });
      req.on('timeout', function() { req.destroy(); process.exit(0); });
      req.end();
      // IMPORTANT: return here to prevent the synchronous write below from executing
      // The GitHub path is async — it writes cache in its own callbacks above
      return;
    }
  }

  // Synchronous path (npm succeeded or both failed / snapshot version)
  const result = {
    update_available: !!(latest && compareSemVer(installed, latest) < 0),
    installed,
    latest: latest || 'unknown',
    checked: Math.floor(Date.now() / 1000),
    source,
  };

  try { fs.writeFileSync(cacheFile, JSON.stringify(result)); } catch(e) {}
})();
`;
}

// Test mode: export utilities and skip hook execution
if (process.env.GSD_TEST_MODE) {
  module.exports = {
    compareSemVer,
    normalizeTag,
    isSnapshot,
    parseChannel,
    buildChildSource,
  };
  return;
}

// GSD_OFFLINE: skip update check entirely — useful for CI and airgapped environments
if (process.env.GSD_OFFLINE) {
  process.exit(0);
}

// Ensure cache directory exists
// GSD_SIMULATE_SANDBOX: skip write — cacheDir is in ~/.claude which is EROFS in sandbox
if (!process.env.GSD_SIMULATE_SANDBOX) {
  try {
    if (!fs.existsSync(cacheDir)) {
      fs.mkdirSync(cacheDir, { recursive: true });
    }
  } catch (e) {
    // EROFS/EACCES/EPERM in sandbox — cache dir unavailable, skip update check
    process.exit(0);
  }
}

// Run check in background (spawn detached process)
const childSource = buildChildSource({
  cacheFile,
  projectVersionFile,
  globalVersionFile,
  semverUtilsPath,
  githubOwner: 'chrisdevchroma',
  githubRepo: 'gsd-ng',
  githubTtl: 3600,
  assetName: 'gsd-ng.tar.gz',
});

const child = spawn(process.execPath, ['-e', childSource], {
  stdio: 'ignore',
  detached: true,
});

child.unref();
