/**
 * Core — Shared utilities, constants, and internal helpers
 */

const fs = require('fs');
const path = require('path');
const { execSync, execFileSync, spawnSync } = require('child_process');
const { MODEL_PROFILES, EFFORT_PROFILES } = require('./model-profiles.cjs');
const { DEFAULTS, WORKFLOW_DEFAULTS } = require('./defaults.cjs');

// ─── Path helpers ────────────────────────────────────────────────────────────

/** Normalize a relative path to always use forward slashes (cross-platform). */
function toPosixPath(p) {
  return p.split(path.sep).join('/');
}

/**
 * Return a flat object containing all common .planning/ subpaths for a given cwd.
 * Call once per function entry and destructure the properties needed.
 * @param {string} cwd - project root directory
 * @returns {{ root, phases, config, state, roadmap, requirements, todos, todosPending, todosCompleted, codebase, milestones, milestonesFile, project, archive }}
 */
function planningPaths(cwd) {
  const root = path.join(cwd, '.planning');
  return {
    root,
    phases: path.join(root, 'phases'),
    config: path.join(root, 'config.json'),
    state: path.join(root, 'STATE.md'),
    roadmap: path.join(root, 'ROADMAP.md'),
    requirements: path.join(root, 'REQUIREMENTS.md'),
    todos: path.join(root, 'todos'),
    todosPending: path.join(root, 'todos', 'pending'),
    todosCompleted: path.join(root, 'todos', 'completed'),
    codebase: path.join(root, 'codebase'),
    milestones: path.join(root, 'milestones'),
    milestonesFile: path.join(root, 'MILESTONES.md'),
    project: path.join(root, 'PROJECT.md'),
    archive: path.join(root, 'archive'),
  };
}

// ─── Atomic file writes ──────────────────────────────────────────────────────

let atomicWriteCounter = 0;

// The `gsd-` segment namespaces the temp files so a sweep of a directory GSD
// writes into cannot match anything it did not create itself.
const ATOMIC_TEMP_PATTERN = /^\..+\.gsd-\d+\.\d+\.tmp$/;

// An atomic write is writeFileSync followed immediately by renameSync — both
// synchronous, both sub-second even for a large planning document. Nothing
// matching the temp pattern that has sat untouched for an hour can be a write
// in flight, and deleting one that was would turn litter into a lost file, so
// the threshold is set orders of magnitude above the real window rather than
// close to it.
const ATOMIC_TEMP_MAX_AGE_MS = 60 * 60 * 1000;

const sweptDirs = new Set();

/**
 * Delete atomic-write temp files left behind in `dir` by an interrupted write.
 *
 * A kill between the write and the rename leaves `.STATE.md.gsd-<pid>.<n>.tmp`
 * next to the target. Those live in the user's `.planning/`, not in
 * `os.tmpdir()`, so `reapStaleTempFiles` never saw them and they accumulated
 * for the life of the project.
 *
 * @param {string} dir - directory to sweep
 * @param {object} [opts]
 * @param {number} [opts.maxAgeMs] - minimum age before a file is collected
 * @returns {string[]} names of the files removed
 */
function reapStaleAtomicTempFiles(
  dir,
  { maxAgeMs = ATOMIC_TEMP_MAX_AGE_MS } = {},
) {
  const removed = [];
  const now = Date.now();
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return removed;
  }
  for (const entry of entries) {
    if (!ATOMIC_TEMP_PATTERN.test(entry)) continue;
    const fullPath = path.join(dir, entry);
    try {
      const stat = fs.statSync(fullPath);
      if (!stat.isFile()) continue;
      if (now - stat.mtimeMs < maxAgeMs) continue;
      fs.unlinkSync(fullPath);
      removed.push(entry);
    } catch {
      // skip entries we cannot stat or delete
    }
  }
  return removed;
}

/**
 * Write a file so that no concurrent reader can observe it half-written.
 *
 * fs.writeFileSync truncates and then writes, so any other process reading the
 * same path during that gap sees an empty or partial file. The planning
 * documents are read and rewritten by parallel executors, where that shows up
 * as a field parsed as undefined. Writing a temp file alongside the target and
 * renaming over it closes the gap: rename is atomic on POSIX, so a reader gets
 * either the whole old file or the whole new one.
 *
 * The temp file must live in the same directory as the target — rename across
 * filesystems is not atomic, and on Linux fails outright.
 *
 * Replacing by rename swaps the directory entry, so the target is a new inode
 * afterwards. Two consequences, inherent to the technique rather than bugs, and
 * both verified: a symlinked planning document is replaced by a regular file
 * holding the new content while the link target keeps the old one, and a
 * hardlinked copy stops tracking after the first write (link count drops to 1
 * and the other name keeps the old content). Anyone sharing a planning document
 * between projects by linking it needs to know that; see the user guide.
 *
 * @param {string} filePath - target path
 * @param {string} content - full file contents
 * @param {string} [encoding] - defaults to utf-8
 */
function writeFileAtomic(filePath, content, encoding = 'utf-8') {
  const dir = path.dirname(filePath);
  // Opportunistic, once per directory per process: the sweep is a readdir of a
  // small directory, and orphans only appear when a process dies, so there is
  // nothing to gain from repeating it on every write.
  if (!sweptDirs.has(dir)) {
    sweptDirs.add(dir);
    reapStaleAtomicTempFiles(dir);
  }
  const tmpPath = path.join(
    dir,
    `.${path.basename(filePath)}.gsd-${process.pid}.${atomicWriteCounter++}.tmp`,
  );

  let mode;
  try {
    mode = fs.statSync(filePath).mode;
  } catch {}

  try {
    fs.writeFileSync(tmpPath, content, encoding);
    if (mode !== undefined) fs.chmodSync(tmpPath, mode);
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    try {
      fs.unlinkSync(tmpPath);
    } catch {}
    throw err;
  }
}

// ─── File locks ──────────────────────────────────────────────────────────────

// A dead holder is stolen from on sight, so this threshold only backstops the
// cases where liveness cannot be established: a payload that never got written,
// a lock from another host. Critical sections are a read, a regex pass and a
// rename — about a millisecond — so 15s is four orders of magnitude of headroom
// rather than a guess at how long the work takes.
const LOCK_STALE_MS = 15 * 1000;

// The same backstop for a holder that can be shown to be running here. Age is
// not evidence against a process that answers signal 0: stealing on it puts two
// processes inside the section, which is the lost update the lock exists to
// stop. What is left for this threshold is a pid recycled onto an unrelated live
// process after its holder was hard-killed, which would otherwise make the lock
// immortal — so it is far above any real section, and finite.
const LOCK_LIVE_HOLDER_STALE_MS = 5 * 60 * 1000;

// Longer than LOCK_STALE_MS and shorter than LOCK_LIVE_HOLDER_STALE_MS, both on
// purpose. Above the first, so a caller never gives up while waiting for a lock
// it was seconds away from being entitled to steal — nothing can vouch for that
// holder, and failing a write the next call would have made is worse than the
// wait. Below the second, so a holder that is demonstrably still working
// produces a loud timeout in the waiter rather than a silent steal.
const LOCK_ACQUIRE_BUDGET_MS = 20 * 1000;

const LOCK_POLL_MS = 20;

// Per lock path: the reentrancy depth, and the identity of the file this process
// created. Depth rather than a boolean because one process calling two locked
// functions would otherwise wait out its whole budget against itself.
const heldLocks = new Map();
let lockExitHookInstalled = false;

/** Path of the lock guarding `filePath`. */
function lockPathFor(filePath) {
  return path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.gsd-lock`,
  );
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// Drop every lock this process holds, whatever depth it is at: the process is
// on its way out, so nothing is left to unwind to.
function releaseAllHeldLocks() {
  for (const [lockPath, held] of [...heldLocks.entries()]) {
    held.depth = 1;
    releaseFileLock(lockPath);
  }
}

// Ctrl-C is the ordinary way a command ends early, and `exit` does not run for
// signal termination — the lock outlived the process and the next command waited
// out the staleness threshold behind a holder that was already gone.
const LOCK_RELEASE_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'];

function installLockExitHook() {
  if (lockExitHookInstalled) return;
  lockExitHookInstalled = true;
  process.on('exit', releaseAllHeldLocks);
  for (const signal of LOCK_RELEASE_SIGNALS) {
    const handler = () => {
      releaseAllHeldLocks();
      // Listening for a signal suppresses the default termination, so hand the
      // signal back: with this listener gone the process dies by it and reports
      // the status it would have without the lock. A host that installed its own
      // listener keeps it, and decides for itself.
      process.removeListener(signal, handler);
      try {
        process.kill(process.pid, signal);
      } catch {
        process.exit(1);
      }
    };
    process.on(signal, handler);
  }
}

function readLockHolder(lockPath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(lockPath, 'utf-8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * What can be established about the recorded holder: 'dead', 'live', 'unknown'.
 *
 * Signal 0 is an existence check on POSIX and on Windows. EPERM means the
 * process is alive under another user, which is not dead. A pid from a different
 * host, or a payload that was never written, says nothing either way and is
 * 'unknown' — that is what the staleness threshold is for.
 *
 * @returns {'dead'|'live'|'unknown'}
 */
function lockHolderState(holder) {
  if (!holder || typeof holder.pid !== 'number') return 'unknown';
  if (holder.host && holder.host !== require('os').hostname()) return 'unknown';
  if (holder.pid === process.pid) return 'live';
  try {
    process.kill(holder.pid, 0);
    return 'live';
  } catch (err) {
    if (err.code === 'ESRCH') return 'dead';
    return err.code === 'EPERM' ? 'live' : 'unknown';
  }
}

function lockAgeMs(lockPath) {
  try {
    return Date.now() - fs.statSync(lockPath).mtimeMs;
  } catch {
    return null;
  }
}

// mtimeMs carries sub-millisecond precision and Date.now() is truncated to whole
// milliseconds, so a lock created moments ago almost always reads as a fraction
// of a millisecond ahead of the clock. A second of slack keeps that, and any
// small clock adjustment, from being read as a timestamp from the future.
const LOCK_FUTURE_TOLERANCE_MS = 1000;

/**
 * True when `ageMs` puts the lock past the point of being worth waiting for.
 *
 * An age well below zero counts: the mtime is ahead of this host's clock, which
 * no process on this host can have produced, and skew between hosts sharing a
 * `.planning/` is exactly the case the host check hands to the age. Judged by
 * `ageMs > staleMs` alone, such a lock is never stale and never stolen, so every
 * write on the file burns the whole budget and fails for as long as it is there.
 */
function lockAgeIsStale(ageMs, staleMs) {
  if (ageMs === null) return false;
  return ageMs < -LOCK_FUTURE_TOLERANCE_MS || ageMs > staleMs;
}

/**
 * Remove a lock judged stale. Returns false when it is still there afterwards.
 *
 * A directory at the lock path — junk, a botched cleanup — cannot be unlinked,
 * and swallowing that failure wedges the file as thoroughly as an unreclaimable
 * lock does. The name is GSD's own and holds a single JSON file at most, so
 * clearing it recursively removes nothing anyone else put there.
 */
function removeStaleLock(lockPath) {
  try {
    fs.unlinkSync(lockPath);
    return true;
  } catch (err) {
    if (err.code !== 'EISDIR' && err.code !== 'EPERM') return false;
  }
  try {
    fs.rmSync(lockPath, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * Create the lock, or report why not.
 *
 * `wx` is O_CREAT|O_EXCL on POSIX and CREATE_NEW on Windows — atomic on both,
 * with no lock-directory-versus-lock-file portability question and nowhere to
 * put the holder metadata but the file itself. The descriptor is closed before
 * returning so a later unlink cannot be refused on Windows.
 *
 * The identity comes from the open descriptor, so it is the file this call
 * created and not whatever is at the path by the time anyone looks again. That
 * is what lets release tell its own lock from a replacement.
 *
 * @returns {{outcome: 'acquired'|'taken'|'unavailable', identity: ?object}}
 */
function tryCreateLock(lockPath) {
  let fd;
  try {
    fd = fs.openSync(lockPath, 'wx');
  } catch (err) {
    return {
      outcome: err.code === 'EEXIST' ? 'taken' : 'unavailable',
      identity: null,
    };
  }
  let identity = null;
  // Identity is carried in the payload as well as the inode: a lock file
  // unlinked and recreated can land on the same inode, so dev+ino alone cannot
  // tell our own lock from a replacement that reused it.
  const token = require('crypto').randomBytes(12).toString('hex');
  let tokenWritten = false;
  try {
    fs.writeSync(
      fd,
      JSON.stringify({
        pid: process.pid,
        host: require('os').hostname(),
        at: new Date().toISOString(),
        token,
      }),
    );
    tokenWritten = true;
  } catch {
    // A lock with no readable payload still excludes; it just cannot be
    // liveness-checked, so it falls back to the staleness threshold.
  }
  try {
    const st = fs.fstatSync(fd);
    identity = {
      dev: st.dev,
      ino: st.ino,
      token: tokenWritten ? token : null,
    };
  } catch {
    // Without an identity release falls back to unlinking whatever is there.
  }
  try {
    fs.closeSync(fd);
  } catch {}
  return { outcome: 'acquired', identity };
}

function lockFileIdentity(lockPath) {
  try {
    const st = fs.statSync(lockPath);
    const holder = readLockHolder(lockPath);
    return { dev: st.dev, ino: st.ino, token: holder ? holder.token : null };
  } catch {
    return null;
  }
}

/**
 * Take the lock at `lockPath`, waiting for a live holder to finish.
 *
 * Three outcomes, none of which can wedge a project:
 * - `locked` / `reentrant` — held by this process, release it.
 * - `unlocked` — the lock file could not be created at all (read-only tree,
 *   missing directory, no permission). The caller runs unserialised, which is
 *   what it did before locking existed, rather than refusing to write.
 * - `timeout` — the holder held on for the whole budget without becoming
 *   reclaimable. The caller fails loudly instead of clobbering it.
 *
 * A lock is reclaimed when its holder is a process that has gone, or when its
 * age passes the threshold for what is known about that holder: `staleMs` when
 * nothing can be established, `liveStaleMs` when signal 0 says it is running
 * here. Age is not evidence against a running process, so a section that
 * outlasts `staleMs` keeps its exclusivity.
 *
 * @param {string} lockPath
 * @param {object} [opts]
 * @param {number} [opts.staleMs]
 * @param {number} [opts.liveStaleMs] - never below staleMs
 * @param {number} [opts.budgetMs]
 * @param {number} [opts.pollMs]
 * @returns {{mode: string, holder?: object, ageMs?: number}}
 */
function acquireFileLock(lockPath, opts = {}) {
  const {
    staleMs = LOCK_STALE_MS,
    budgetMs = LOCK_ACQUIRE_BUDGET_MS,
    pollMs = LOCK_POLL_MS,
  } = opts;
  const liveStaleMs =
    opts.liveStaleMs === undefined
      ? Math.max(staleMs, LOCK_LIVE_HOLDER_STALE_MS)
      : opts.liveStaleMs;

  const held = heldLocks.get(lockPath);
  if (held) {
    held.depth += 1;
    return { mode: 'reentrant' };
  }

  const deadline = Date.now() + budgetMs;
  for (;;) {
    const { outcome, identity } = tryCreateLock(lockPath);
    if (outcome === 'acquired') {
      installLockExitHook();
      heldLocks.set(lockPath, { depth: 1, identity });
      return { mode: 'locked' };
    }
    if (outcome === 'unavailable') return { mode: 'unlocked' };

    const holder = readLockHolder(lockPath);
    const ageMs = lockAgeMs(lockPath);
    const state = lockHolderState(holder);
    const limit = state === 'live' ? liveStaleMs : staleMs;
    if (state === 'dead' || lockAgeIsStale(ageMs, limit)) {
      removeStaleLock(lockPath);
    }
    if (Date.now() >= deadline) return { mode: 'timeout', holder, ageMs };
    sleepSync(pollMs);
  }
}

/**
 * Drop one level of the lock. Returns true when the lock file was removed.
 *
 * The file is only removed when it is still the one this process created. A
 * holder whose lock was reclaimed under it would otherwise delete the
 * reclaimer's lock and leave the section open to a third process, so a
 * replacement is left alone and reported: the write that just happened ran
 * alongside someone else's, which the caller cannot see any other way.
 */
function releaseFileLock(lockPath) {
  const held = heldLocks.get(lockPath);
  if (!held) return false;
  if (held.depth > 1) {
    held.depth -= 1;
    return false;
  }
  heldLocks.delete(lockPath);

  const present = lockFileIdentity(lockPath);
  if (held.identity && present && !sameLockFile(present, held.identity)) {
    reportLockTakenOver(lockPath);
    return false;
  }
  try {
    fs.unlinkSync(lockPath);
  } catch {}
  return true;
}

function sameLockFile(present, held) {
  // When we recorded a token, it is the whole test: the file at the path is ours
  // only if it still carries that token. A replacement need not carry one at
  // all, and an inode freed by our unlink can be handed straight back to it, so
  // dev+ino cannot tell the two apart. Fall back to the inode only when the
  // payload write failed and we have no token to compare.
  if (held.token) return present.token === held.token;
  return present.dev === held.dev && present.ino === held.ino;
}

function reportLockTakenOver(lockPath) {
  const holder = readLockHolder(lockPath);
  const who = holder
    ? `pid ${holder.pid} on ${holder.host || 'unknown host'}`
    : 'an unidentified process';
  const guarded = path.basename(lockPath).replace(/^\.|\.gsd-lock$/g, '');
  process.stderr.write(
    `Warning: the lock on ${guarded} was taken over by ${who} while this process ` +
      `still held it, so the change just written may have raced with that process. ` +
      `Check ${guarded} before relying on it.\n`,
  );
}

/**
 * Run `fn` with exclusive access to `filePath` across processes.
 *
 * writeFileAtomic makes a write indivisible, which stops a reader seeing half a
 * file. It does nothing for a read-modify-write: parallel executors that each
 * read STATE.md, append their own entry and write it back all succeed, and every
 * entry but the last one's is discarded with nothing reported. Serialising the
 * whole read-compute-write closes that, and because the loser re-reads after it
 * wins the lock, its append composes with the winner's instead of replacing it.
 *
 * A lock rather than a compare-and-swap because half of these mutations are
 * replacements — filtering a blocker out, setting Status from a value just read
 * — and replaying one of those against content that changed underneath is a
 * different operation, not a retry.
 *
 * @param {string} filePath - the file being mutated, not the lock path
 * @param {Function} fn - the critical section; keep it to file I/O
 * @param {object} [opts] - forwarded to acquireFileLock
 */
function withFileLock(filePath, fn, opts = {}) {
  const lockPath = lockPathFor(filePath);
  const acquired = acquireFileLock(lockPath, opts);
  if (acquired.mode === 'timeout') {
    const held = acquired.holder
      ? `held by pid ${acquired.holder.pid} on ${acquired.holder.host || 'unknown host'} since ${acquired.holder.at || 'unknown time'}`
      : 'held by an unidentified process';
    const err = new Error(
      `Timed out waiting for a lock on ${path.basename(filePath)} — ${held}. ` +
        `Retry once that process has finished, or delete ${lockPath} if it is gone.`,
    );
    err.code = 'GSD_LOCK_TIMEOUT';
    err.lockPath = lockPath;
    err.holder = acquired.holder || null;
    throw err;
  }
  try {
    return fn();
  } finally {
    if (acquired.mode !== 'unlocked') releaseFileLock(lockPath);
  }
}

/**
 * Run a ROADMAP.md read-modify-write as one indivisible step.
 *
 * Every executor in a wave calls `roadmap update-plan-progress`, which reads the
 * whole roadmap and writes the whole roadmap back. Its numbers come from disk
 * rather than from the file it is rewriting, so racers converge on a valid count
 * — but a caller that read before a sibling's summary landed writes its lower
 * count over the higher one, and the next call is the only thing that repairs it.
 * A caller updating a different phase is worse off than that: its row is not
 * recomputed by anyone, so the sibling's whole-file write drops it.
 *
 * Held across the disk reads too, not only the file rewrite. The stale value is
 * produced by counting summaries, so a lock taken after that count has already
 * been taken serialises the write of an answer that is already out of date.
 *
 * The section must span the read, so callers wrap their whole body rather than
 * the write; planningPaths is called inside to keep the one lock path per project.
 *
 * Ordering: this is the outer lock. A command that mutates ROADMAP.md and
 * STATE.md takes this one first and withStateLock inside it, never the reverse.
 */
function withRoadmapLock(cwd, fn) {
  return withFileLock(planningPaths(cwd).roadmap, fn);
}

/**
 * The canonical path of the guarded planning document `filePath` names, or null.
 *
 * For the generic commands that rewrite an arbitrary file — the frontmatter
 * writers — pointed at a planning document. Their write is a whole-file rewrite
 * built from a read, so outside the lock it discards whatever a locked writer
 * appended in between and voids the lock for everyone who took it. Pointed at
 * anything else, a todo in every workflow that calls them today, they get no lock:
 * a lock nobody contends for is a lock file to leave behind and a deadlock surface
 * for nothing.
 *
 * Returning the canonical path rather than a boolean is what keeps one lock per
 * document: an absolute argument, a relative one and a symlinked tree must all
 * resolve to the lock path the guarded commands use.
 */
function lockedPlanningDoc(cwd, filePath) {
  const real = (p) => {
    try {
      return fs.realpathSync(p);
    } catch {
      return path.resolve(p);
    }
  };
  const target = real(filePath);
  const paths = planningPaths(cwd);
  for (const guarded of [paths.state, paths.roadmap, paths.requirements]) {
    if (real(guarded) === target) return guarded;
  }
  return null;
}

// ─── Output helpers ───────────────────────────────────────────────────────────

/**
 * Remove stale gsd-* temp files/dirs older than maxAgeMs (default: 5 minutes).
 * Runs opportunistically before each new temp file write to prevent unbounded accumulation.
 * @param {string} prefix - filename prefix to match (e.g., 'gsd-')
 * @param {object} opts
 * @param {number} opts.maxAgeMs - max age in ms before removal (default: 5 min)
 * @param {boolean} opts.dirsOnly - if true, only remove directories (default: false)
 */
function reapStaleTempFiles(
  prefix = 'gsd-',
  { maxAgeMs = 5 * 60 * 1000, dirsOnly = false } = {},
) {
  try {
    const tmpDir = require('os').tmpdir();
    const now = Date.now();
    const entries = fs.readdirSync(tmpDir);
    for (const entry of entries) {
      if (!entry.startsWith(prefix)) continue;
      const fullPath = path.join(tmpDir, entry);
      try {
        const stat = fs.statSync(fullPath);
        if (now - stat.mtimeMs < maxAgeMs) continue;
        if (dirsOnly && !stat.isDirectory()) continue;
        if (stat.isDirectory()) {
          fs.rmSync(fullPath, { recursive: true, force: true });
        } else {
          fs.unlinkSync(fullPath);
        }
      } catch {
        // skip files we can't stat or delete
      }
    }
  } catch {
    // non-critical: cleanup failures never break output
  }
}

// Module-level file output flag: when true, output() writes large payloads to
// a temp file prefixed with @file:. Off by default -- inline is the standard path.
// Activated via --file global flag in gsd-tools.cjs.
let _fileOutput = false;
function setFileOutput(val) {
  _fileOutput = val;
}

// Module-level JSON mode flag: when true, output() always emits JSON regardless
// of displayValue. Activated via --json global flag or --pick in gsd-tools.cjs.
let _jsonMode = false;
function setJsonMode(val) {
  _jsonMode = val;
}

/**
 * Write JSON to a temp file and return the @file: prefixed path.
 * Factored out to avoid duplication between _jsonMode and auto-JSON paths.
 */
function writeToTempFile(json) {
  reapStaleTempFiles();
  let tmpDir = require('os').tmpdir();
  try {
    fs.mkdirSync(tmpDir, { recursive: true });
  } catch {
    // os.tmpdir() directory may not be writable (e.g. sandbox sets TMPDIR=/tmp/claude
    // but /tmp is restricted). Fall back to a known-writable sibling directory.
    const uid = process.getuid();
    tmpDir = path.join(path.dirname(tmpDir), path.basename(tmpDir) + '-' + uid);
    fs.mkdirSync(tmpDir, { recursive: true });
  }
  const tmpPath = path.join(tmpDir, `gsd-${Date.now()}.json`);
  fs.writeFileSync(tmpPath, json, 'utf-8');
  return '@file:' + tmpPath;
}

function output(result, displayValue) {
  let data;
  if (_jsonMode) {
    // --json flag: always JSON, ignore displayValue
    const json = JSON.stringify(result, null, 2);
    data = _fileOutput ? writeToTempFile(json) : json;
  } else if (displayValue !== undefined) {
    // displayValue provided: emit as string (NO _fileOutput for scalar output)
    data = String(displayValue);
  } else if (result !== null && typeof result === 'object') {
    // Object/array with no displayValue: auto-JSON
    const json = JSON.stringify(result, null, 2);
    data = _fileOutput ? writeToTempFile(json) : json;
  } else {
    // Scalar with no displayValue: stringify
    data = String(result);
  }
  // process.stdout.write() is async when stdout is a pipe — process.exit()
  // can tear down the process before the reader consumes the buffer.
  // fs.writeSync(1, ...) blocks until the kernel accepts the bytes, and
  // skipping process.exit() lets the event loop drain naturally.
  try {
    fs.writeSync(1, data);
  } catch (e) {
    if (e.code !== 'EPIPE') throw e;
    // EPIPE: pipe reader closed early — data was buffered, safe to ignore
  }
}

function error(message) {
  fs.writeSync(2, 'Error: ' + message + '\n');
  process.exit(1);
}

// ─── File & Config utilities ──────────────────────────────────────────────────

function safeReadFile(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }
}

/**
 * Resolve the integration branch — the single supported reader for
 * `target_branch`. Every caller must go through this rather than reaching into
 * a config object directly.
 *
 * loadConfig() normalizes the `git` block onto the top level, so a loaded
 * config carries `target_branch` and never `git.target_branch`. Both shapes are
 * accepted here so a raw `.planning/config.json` resolves identically, and the
 * precedence is the same everywhere:
 *
 *   overrides (e.g. a merged per-submodule block) > flat `target_branch`
 *   > nested `git.target_branch` > fallback
 *
 * @param {object|null|undefined} config - Loaded config, or raw parsed config.json
 * @param {{ overrides?: object|null, fallback?: string|null }} [opts] -
 *   `fallback` defaults to `DEFAULTS.target_branch`; pass `null` when the caller
 *   has a further resolution step of its own (the submodule git-tracking probe).
 * @returns {string|null}
 */
function resolveTargetBranch(config, opts = {}) {
  const fallback =
    opts.fallback !== undefined ? opts.fallback : DEFAULTS.target_branch;

  for (const layer of [opts.overrides, config]) {
    if (!layer || typeof layer !== 'object') continue;
    if (typeof layer.target_branch === 'string' && layer.target_branch) {
      return layer.target_branch;
    }
    const git = layer.git;
    if (
      git &&
      typeof git === 'object' &&
      typeof git.target_branch === 'string' &&
      git.target_branch
    ) {
      return git.target_branch;
    }
  }

  return fallback;
}

function loadConfig(cwd) {
  const { config: configPath } = planningPaths(cwd);
  const defaults = {
    ...DEFAULTS,
    research: WORKFLOW_DEFAULTS.research,
    plan_checker: WORKFLOW_DEFAULTS.plan_check,
    verifier: WORKFLOW_DEFAULTS.verifier,
    nyquist_validation: WORKFLOW_DEFAULTS.nyquist_validation,
  };

  try {
    const raw = fs.readFileSync(configPath, 'utf-8');
    const parsed = JSON.parse(raw);

    // Migrate deprecated "depth" key to "granularity" with value mapping
    if ('depth' in parsed && !('granularity' in parsed)) {
      const depthToGranularity = {
        quick: 'coarse',
        standard: 'standard',
        comprehensive: 'fine',
      };
      parsed.granularity = depthToGranularity[parsed.depth] || parsed.depth;
      delete parsed.depth;
      try {
        fs.writeFileSync(configPath, JSON.stringify(parsed, null, 2), 'utf-8');
      } catch {}
    }

    const get = (key, nested) => {
      if (parsed[key] !== undefined) return parsed[key];
      if (
        nested &&
        parsed[nested.section] &&
        parsed[nested.section][nested.field] !== undefined
      ) {
        return parsed[nested.section][nested.field];
      }
      return undefined;
    };

    const parallelization = (() => {
      const val = get('parallelization');
      if (typeof val === 'boolean') return val;
      if (typeof val === 'object' && val !== null && 'enabled' in val)
        return val.enabled;
      return defaults.parallelization;
    })();

    return {
      model_profile: get('model_profile') ?? defaults.model_profile,
      commit_docs: (() => {
        const explicit = get('commit_docs', {
          section: 'planning',
          field: 'commit_docs',
        });
        // If explicitly set in config, respect the user's choice
        if (explicit !== undefined) return explicit;
        // Auto-detection: when no explicit value and .planning/ is gitignored,
        // default to false instead of true
        if (isGitIgnored(cwd, '.planning/')) return false;
        return defaults.commit_docs;
      })(),
      search_gitignored:
        get('search_gitignored', {
          section: 'planning',
          field: 'search_gitignored',
        }) ?? defaults.search_gitignored,
      branching_strategy:
        get('branching_strategy', {
          section: 'git',
          field: 'branching_strategy',
        }) ?? defaults.branching_strategy,
      phase_branch_template:
        get('phase_branch_template', {
          section: 'git',
          field: 'phase_branch_template',
        }) ?? defaults.phase_branch_template,
      milestone_branch_template:
        get('milestone_branch_template', {
          section: 'git',
          field: 'milestone_branch_template',
        }) ?? defaults.milestone_branch_template,
      target_branch: resolveTargetBranch(parsed, {
        fallback: defaults.target_branch,
      }),
      auto_push:
        get('auto_push', { section: 'git', field: 'auto_push' }) ??
        defaults.auto_push,
      remote:
        get('remote', { section: 'git', field: 'remote' }) ?? defaults.remote,
      review_branch_template:
        get('review_branch_template', {
          section: 'git',
          field: 'review_branch_template',
        }) ?? defaults.review_branch_template,
      pr_draft:
        get('pr_draft', { section: 'git', field: 'pr_draft' }) ??
        defaults.pr_draft,
      platform:
        get('platform', { section: 'git', field: 'platform' }) ??
        defaults.platform,
      commit_format:
        get('commit_format', { section: 'git', field: 'commit_format' }) ??
        defaults.commit_format,
      commit_template:
        get('commit_template', { section: 'git', field: 'commit_template' }) ??
        defaults.commit_template,
      versioning_scheme:
        get('versioning_scheme', {
          section: 'git',
          field: 'versioning_scheme',
        }) ?? defaults.versioning_scheme,
      research:
        get('research', { section: 'workflow', field: 'research' }) ??
        defaults.research,
      plan_checker:
        get('plan_checker', { section: 'workflow', field: 'plan_check' }) ??
        defaults.plan_checker,
      verifier:
        get('verifier', { section: 'workflow', field: 'verifier' }) ??
        defaults.verifier,
      nyquist_validation:
        get('nyquist_validation', {
          section: 'workflow',
          field: 'nyquist_validation',
        }) ?? defaults.nyquist_validation,
      parallelization,
      model_overrides: parsed.model_overrides || null,
      effort_overrides: parsed.effort_overrides || null,
    };
  } catch {
    return defaults;
  }
}

function getEngineRuntime() {
  // GSD_TEST_RUNTIME_MARKER_DIR: test-only override of the marker location.
  const markerDir =
    process.env.GSD_TEST_RUNTIME_MARKER_DIR || path.join(__dirname, '..', '..');
  try {
    const val = fs
      .readFileSync(path.join(markerDir, '.runtime'), 'utf-8')
      .trim();
    return val === 'copilot' ? 'copilot' : 'claude';
  } catch {
    return 'claude'; // marker absent → default to claude
  }
}

// ─── Git utilities ────────────────────────────────────────────────────────────

function isGitIgnored(cwd, targetPath) {
  try {
    // --no-index checks .gitignore rules regardless of whether the file is tracked.
    // Without it, git check-ignore returns "not ignored" for tracked files even when
    // .gitignore explicitly lists them — a common source of confusion when .planning/
    // was committed before being added to .gitignore.
    // Use execFileSync with array args to prevent command injection via path values.
    execFileSync(
      'git',
      ['check-ignore', '-q', '--no-index', '--', targetPath],
      {
        cwd,
        stdio: 'pipe',
      },
    );
    return true;
  } catch {
    return false;
  }
}

function execGit(cwd, args) {
  const result = spawnSync('git', args, {
    cwd,
    stdio: 'pipe',
    encoding: 'utf-8',
  });
  return {
    exitCode: result.status ?? 1,
    stdout: (result.stdout ?? '').toString().trim(),
    stderr: (result.stderr ?? '').toString().trim(),
  };
}

// ─── Phase utilities ──────────────────────────────────────────────────────────

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Accepts the colon on either side of the bold markers. See phase.cjs.
function boldLabel(label) {
  return String.raw`\*\*${escapeRegex(label)}(?:\*\*:|:\*\*)`;
}

// Rewrite target for `label`'s value inside one phase's section. The search is
// stopped at the next phase header: an unbounded scan silently rewrites the
// following phase's line when this phase has no such field.
function phaseFieldPattern(phaseEscaped, label) {
  return (
    String.raw`(#{2,4}\s*Phase\s+${phaseEscaped}(?![\dA-Za-z.])(?:(?!\n#{2,4}\s*Phase\s)[\s\S])*?` +
    boldLabel(label) +
    String.raw`\s*)[^\n]+`
  );
}

// A phase number is written zero-padded in directory names and unpadded in
// ROADMAP.md prose, and either spelling is a valid CLI argument. One fragment
// matches both, so the same resolved number can drive the directory lookup and
// the document rewrite.
function phaseNumPattern(phaseNum) {
  return (
    String.raw`0*` + escapeRegex(String(phaseNum).replace(/^0+(?=\d)/, ''))
  );
}

// Checkbox item for one phase in the roadmap's phase list. The prefix between
// the box and the word `Phase` is bare or bold and nothing else: a permissive
// prefix lets the match start inside another phase's description, which ticks
// the wrong phase. `boxState` narrows the box itself, e.g. to `[ ]` to tick
// only an unticked entry.
function phaseCheckboxPattern(phaseNum, boxState = '[ x]') {
  return String.raw`(-\s*\[)(${boxState})(\]\s*(?:\*\*)?Phase\s+${phaseNumPattern(phaseNum)}[:\s][^\n]*)`;
}

// One whole checkbox line, for the readers rather than the rewriters: box state
// in group 1, phase number in group 2, everything after the colon in group 3.
// `phaseNum` narrows to that phase and its decimals; omitted, any phase matches.
// The bare-or-bold prefix is phaseCheckboxPattern's — a reader that takes only
// the bold form reports a bare-form roadmap as having no phases at all, which
// is how `phase complete` came to call a milestone finished with a phase left.
// Leading whitespace is allowed for the same reason: the rewriters' pattern is
// not anchored, so they tick an entry nested under its milestone heading, and a
// reader that cannot see one disagrees with them about which phases exist.
function phaseCheckboxLinePattern(phaseNum = null, opts = {}) {
  const num =
    phaseNum == null
      ? String.raw`\d+[A-Z]?(?:\.\d+)*`
      : phaseNumPattern(phaseNum) +
        String.raw`[A-Z]?` +
        (opts.withDecimals ? String.raw`(?:\.\d+)*` : '');
  return String.raw`^[ \t]*[-*]\s*\[([ xX])\]\s*(?:\*\*)?Phase\s+(${num})(?![\dA-Za-z.])\s*:?\s*([^\n]*)$`;
}

// What the roadmap appends after the name and is not part of it: the plan count
// the templates carry, and the completion or insertion marker. A parenthetical
// that says none of those is part of the name — `Auth (JWT)`.
const PHASE_CHECKBOX_META_SUFFIX =
  /\s*\((?:(?:completed|inserted)\b[^)]*|[^)]*\bplans?\b[^)]*)\)\s*$/i;

// A description follows the name after a spaced dash, as it does after the bold
// markers in `**Phase N: Name** - description`.
const PHASE_CHECKBOX_DESCRIPTION = /\s+(?:[—–]|-{1,2})\s+[^\n]*$/;

// The name as written after the colon, minus the bold markers, any description
// after it and the roadmap's own trailing metadata. Null when nothing is left: a
// checkbox may carry only a number.
function phaseCheckboxName(rest) {
  // A bold entry closes its markers at the end of the name; anything after them
  // is a trailing description, not part of it. The bare form has no closing
  // delimiter, so it ends at the description separator instead — without one,
  // `Phase N: Audit (1 plan) — completed DATE` named the phase after the whole
  // line, and that name reaches slugified fields.
  const raw = String(rest).replace(/^\s*\*\*\s*/, '');
  const bolded = raw.match(/^([^*\n]*?)\s*\*\*/);
  const body = bolded
    ? bolded[1]
    : raw
        .replace(/^(?:[—–]|-{1,2})\s+/, '')
        .replace(PHASE_CHECKBOX_DESCRIPTION, '');

  let name = body.replace(/\*\*/g, '').trim();
  // Repeated because both markers can be there at once: `phase complete`
  // appends its own to a line the template already gave a plan count.
  for (;;) {
    const stripped = name.replace(PHASE_CHECKBOX_META_SUFFIX, '').trim();
    if (stripped === name) break;
    name = stripped;
  }
  return name || null;
}

// Every phase checkbox in `content`, in document order.
function parsePhaseCheckboxes(content) {
  const pattern = new RegExp(phaseCheckboxLinePattern(), 'gim');
  const entries = [];
  let m;
  while ((m = pattern.exec(content)) !== null) {
    entries.push({
      index: m.index,
      checked: m[1].toLowerCase() === 'x',
      num: m[2],
      name: phaseCheckboxName(m[3]),
    });
  }
  return entries;
}

function normalizePhaseName(phase) {
  const match = String(phase).match(/^(\d+)([A-Z])?((?:\.\d+)*)/i);
  if (!match) return phase;
  const padded = match[1].padStart(2, '0');
  const letter = match[2] ? match[2].toUpperCase() : '';
  const decimal = match[3] || '';
  return padded + letter + decimal;
}

function comparePhaseNum(a, b) {
  const pa = String(a).match(/^(\d+)([A-Z])?((?:\.\d+)*)/i);
  const pb = String(b).match(/^(\d+)([A-Z])?((?:\.\d+)*)/i);
  if (!pa || !pb) return String(a).localeCompare(String(b));
  const intDiff = parseInt(pa[1], 10) - parseInt(pb[1], 10);
  if (intDiff !== 0) return intDiff;
  // No letter sorts before letter: 12 < 12A < 12B
  const la = (pa[2] || '').toUpperCase();
  const lb = (pb[2] || '').toUpperCase();
  if (la !== lb) {
    if (!la) return -1;
    if (!lb) return 1;
    return la < lb ? -1 : 1;
  }
  // Segment-by-segment decimal comparison: 12A < 12A.1 < 12A.1.2 < 12A.2
  const aDecParts = pa[3]
    ? pa[3]
        .slice(1)
        .split('.')
        .map((p) => parseInt(p, 10))
    : [];
  const bDecParts = pb[3]
    ? pb[3]
        .slice(1)
        .split('.')
        .map((p) => parseInt(p, 10))
    : [];
  const maxLen = Math.max(aDecParts.length, bDecParts.length);
  if (aDecParts.length === 0 && bDecParts.length > 0) return -1;
  if (bDecParts.length === 0 && aDecParts.length > 0) return 1;
  for (let i = 0; i < maxLen; i++) {
    const av = Number.isFinite(aDecParts[i]) ? aDecParts[i] : 0;
    const bv = Number.isFinite(bDecParts[i]) ? bDecParts[i] : 0;
    if (av !== bv) return av - bv;
  }
  return 0;
}

function searchPhaseInDir(baseDir, relBase, normalized) {
  try {
    const entries = fs.readdirSync(baseDir, { withFileTypes: true });
    const dirs = entries
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort((a, b) => comparePhaseNum(a, b));
    const match = dirs.find((d) => d.startsWith(normalized));
    if (!match) return null;

    const dirMatch = match.match(/^(\d+[A-Z]?(?:\.\d+)*)-?(.*)/i);
    const phaseNumber = dirMatch ? dirMatch[1] : normalized;
    const phaseName = dirMatch && dirMatch[2] ? dirMatch[2] : null;
    const phaseDir = path.join(baseDir, match);
    const phaseFiles = fs.readdirSync(phaseDir);

    const plans = phaseFiles
      .filter((f) => f.endsWith('-PLAN.md') || f === 'PLAN.md')
      .sort();
    const summaries = phaseFiles
      .filter((f) => f.endsWith('-SUMMARY.md') || f === 'SUMMARY.md')
      .sort();
    const hasResearch = phaseFiles.some(
      (f) =>
        (f.endsWith('-RESEARCH.md') && !f.endsWith('-GAP-RESEARCH.md')) ||
        f === 'RESEARCH.md',
    );
    const hasContext = phaseFiles.some(
      (f) => f.endsWith('-CONTEXT.md') || f === 'CONTEXT.md',
    );
    const hasVerification = phaseFiles.some(
      (f) => f.endsWith('-VERIFICATION.md') || f === 'VERIFICATION.md',
    );

    const completedPlanIds = new Set(
      summaries.map((s) =>
        s.replace('-SUMMARY.md', '').replace('SUMMARY.md', ''),
      ),
    );
    const incompletePlans = plans.filter((p) => {
      const planId = p.replace('-PLAN.md', '').replace('PLAN.md', '');
      return !completedPlanIds.has(planId);
    });

    return {
      found: true,
      directory: toPosixPath(path.join(relBase, match)),
      phase_number: phaseNumber,
      phase_name: phaseName,
      phase_slug: phaseName
        ? phaseName
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-+|-+$/g, '')
        : null,
      plans,
      summaries,
      incomplete_plans: incompletePlans,
      has_research: hasResearch,
      has_context: hasContext,
      has_verification: hasVerification,
    };
  } catch {
    return null;
  }
}

function findPhaseInternal(cwd, phase) {
  if (!phase) return null;

  const { phases: phasesDir, milestones: milestonesDir } = planningPaths(cwd);
  const normalized = normalizePhaseName(phase);

  // Search current phases first
  const current = searchPhaseInDir(phasesDir, '.planning/phases', normalized);
  if (current) return current;

  // Search archived milestone phases (newest first)
  if (!fs.existsSync(milestonesDir)) return null;

  try {
    const milestoneEntries = fs.readdirSync(milestonesDir, {
      withFileTypes: true,
    });
    const archiveDirs = milestoneEntries
      .filter((e) => e.isDirectory() && /^v[\d.]+-phases$/.test(e.name))
      .map((e) => e.name)
      .sort()
      .reverse();

    for (const archiveName of archiveDirs) {
      const version = archiveName.match(/^(v[\d.]+)-phases$/)[1];
      const archivePath = path.join(milestonesDir, archiveName);
      const relBase = '.planning/milestones/' + archiveName;
      const result = searchPhaseInDir(archivePath, relBase, normalized);
      if (result) {
        result.archived = version;
        return result;
      }
    }
  } catch {}

  return null;
}

function getArchivedPhaseDirs(cwd) {
  const { milestones: milestonesDir } = planningPaths(cwd);
  const results = [];

  if (!fs.existsSync(milestonesDir)) return results;

  try {
    const milestoneEntries = fs.readdirSync(milestonesDir, {
      withFileTypes: true,
    });
    // Find v*-phases directories, sort newest first
    const phaseDirs = milestoneEntries
      .filter((e) => e.isDirectory() && /^v[\d.]+-phases$/.test(e.name))
      .map((e) => e.name)
      .sort()
      .reverse();

    for (const archiveName of phaseDirs) {
      const version = archiveName.match(/^(v[\d.]+)-phases$/)[1];
      const archivePath = path.join(milestonesDir, archiveName);
      const entries = fs.readdirSync(archivePath, { withFileTypes: true });
      const dirs = entries
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
        .sort((a, b) => comparePhaseNum(a, b));

      for (const dir of dirs) {
        results.push({
          name: dir,
          milestone: version,
          basePath: path.join('.planning', 'milestones', archiveName),
          fullPath: path.join(archivePath, dir),
        });
      }
    }
  } catch {}

  return results;
}

// ─── Roadmap milestone scoping ───────────────────────────────────────────────

/**
 * Extract the current (active) milestone content from ROADMAP.md.
 * Strips shipped milestone sections wrapped in <details> blocks.
 * Returns the remaining content which is the active milestone.
 */
function extractCurrentMilestone(content) {
  return content.replace(/<details>[\s\S]*?<\/details>/gi, '');
}

/**
 * Replace a pattern only in the current milestone section of ROADMAP.md
 * (everything after the last </details> close tag). Used for write operations
 * that must not accidentally modify archived milestone checkboxes/tables.
 *
 * Returns `{ content, changed }`. `changed` reports whether the pattern found
 * its target, not whether the bytes differ — a rewrite to the value already
 * there still landed. Callers must inspect it: a pattern that matches nothing
 * otherwise writes the file back unaltered and reports success, which is how
 * every rewrite bug in this file has reached users.
 */
function replaceInCurrentMilestone(content, pattern, replacement) {
  const offset = currentMilestoneOffset(content);
  const before = content.slice(0, offset);
  const after = content.slice(offset);
  const changed = new RegExp(pattern.source, pattern.flags).test(after);
  return { content: before + after.replace(pattern, replacement), changed };
}

function currentMilestoneOffset(content) {
  const lastDetailsClose = content.lastIndexOf('</details>');
  return lastDetailsClose === -1 ? 0 : lastDetailsClose + '</details>'.length;
}

function currentMilestoneSlice(content) {
  return content.slice(currentMilestoneOffset(content));
}

// ─── Rewrite target probes ───────────────────────────────────────────────────
//
// Deliberately looser than the patterns that do the rewriting, and used only to
// decide whether a rewrite that matched nothing is worth reporting. A roadmap
// with no progress table has not missed one; a roadmap whose table row is
// written in a shape the rewrite cannot reach has.

function hasPhaseTableRow(content, phaseNum) {
  return new RegExp(
    String.raw`^\|\s*${phaseNumPattern(phaseNum)}[.\s|]`,
    'im',
  ).test(currentMilestoneSlice(content));
}

// A header naming the phase, without requiring the colon the section rewrites
// key on: a header that separates its name with a dash instead is a target they
// cannot reach.
function hasPhaseHeader(content, phaseNum) {
  return new RegExp(
    String.raw`^#{2,4}\s*Phase\s+${phaseNumPattern(phaseNum)}(?![\dA-Za-z.])`,
    'im',
  ).test(currentMilestoneSlice(content));
}

function hasPhasePlansLine(content, phaseNum) {
  const section = currentMilestoneSlice(content).match(
    new RegExp(
      String.raw`#{2,4}\s*Phase\s+${phaseNumPattern(phaseNum)}(?![\dA-Za-z.])(?:(?!\n#{2,4}\s*Phase\s)[\s\S])*`,
      'i',
    ),
  );
  return section ? /^\s*\*{0,2}Plans\*{0,2}\s*:/im.test(section[0]) : false;
}

// True when there is nothing to report: either the phase has no checkbox at
// all, or it has one in the supported form and a tick that matched nothing
// only means the box was already ticked. False when some checkbox line names
// the phase in a shape the rewrite cannot reach.
function isPhaseCheckboxSatisfied(content, phaseNum) {
  const slice = currentMilestoneSlice(content);
  const loose = new RegExp(
    String.raw`-\s*\[[ x]\][^\n]*Phase\s+${phaseNumPattern(phaseNum)}(?![\dA-Za-z.])[:\s]`,
    'i',
  );
  if (!loose.test(slice)) return true;
  return new RegExp(phaseCheckboxPattern(phaseNum), 'i').test(slice);
}

// ─── Roadmap & model utilities ────────────────────────────────────────────────

function getRoadmapPhaseInternal(cwd, phaseNum) {
  if (!phaseNum) return null;
  const { roadmap: roadmapPath } = planningPaths(cwd);
  if (!fs.existsSync(roadmapPath)) return null;

  try {
    const content = extractCurrentMilestone(
      fs.readFileSync(roadmapPath, 'utf-8'),
    );
    const escapedPhase = phaseNumPattern(phaseNum.toString());
    const phasePattern = new RegExp(
      `#{2,4}\\s*Phase\\s+${escapedPhase}:\\s*([^\\n]+)`,
      'i',
    );
    const headerMatch = content.match(phasePattern);
    if (!headerMatch) return null;

    const phaseName = headerMatch[1].trim();
    const headerIndex = headerMatch.index;
    const restOfContent = content.slice(headerIndex);
    const nextHeaderMatch = restOfContent.match(
      /\n#{2,4}\s+Phase\s+\d+[A-Z]?(?:\.\d+)*/i,
    );
    const sectionEnd = nextHeaderMatch
      ? headerIndex + nextHeaderMatch.index
      : content.length;
    const section = content.slice(headerIndex, sectionEnd).trim();

    const goalMatch = section.match(
      new RegExp(boldLabel('Goal') + String.raw`\s*([^\n]+)`, 'i'),
    );
    const goal = goalMatch ? goalMatch[1].trim() : null;

    return {
      found: true,
      phase_number: phaseNum.toString(),
      phase_name: phaseName,
      goal,
      section,
    };
  } catch {
    return null;
  }
}

function resolveModelInternal(cwd, agentType) {
  const config = loadConfig(cwd);

  // Check per-agent override first
  const override = config.model_overrides?.[agentType];
  if (override) {
    return override;
  }

  // Fall back to profile lookup
  const profile = config.model_profile || 'balanced';
  const agentModels = MODEL_PROFILES[agentType];
  if (!agentModels) return 'sonnet';
  if (profile === 'inherit') return null;
  return agentModels[profile] || agentModels['balanced'] || 'sonnet';
}

function resolveEffortInternal(cwd, agentType) {
  const config = loadConfig(cwd);

  // Non-Claude runtimes do not support effort: frontmatter — skip silently.
  if (getEngineRuntime() !== 'claude') {
    return null;
  }

  // Resolve effort from override or profile (unchanged logic).
  const hasExplicitOverride = Object.prototype.hasOwnProperty.call(
    config.effort_overrides || {},
    agentType,
  );
  let effort;
  if (hasExplicitOverride) {
    const override = config.effort_overrides[agentType];
    effort = override === 'inherit' ? null : override;
  } else {
    const profile = config.model_profile || 'balanced';
    const agentEfforts = EFFORT_PROFILES[agentType];
    if (!agentEfforts) return null;
    const profileEffort = agentEfforts[profile];
    effort =
      !profileEffort || profileEffort === 'inherit' ? null : profileEffort;
  }

  // Model-tier compatibility: haiku does not support effort at all; xhigh and max
  // are high reasoning tiers. When the resolved model is known and incompatible
  // with the resolved effort, suppress (return null) and warn only on explicit
  // overrides.
  // resolveModelInternal returns null for session-inherit — leave those alone.
  //
  // These are the bare aliases the harness resolves (opus→Opus 4.8,
  // sonnet→Sonnet 5, fable→Fable 5), all of which accept xhigh/max. A model
  // string outside this set — e.g. a version-pinned `sonnet-4-6` via
  // model_overrides — is treated as unsupported, since xhigh did not exist
  // below the Opus tier before Sonnet 5.
  const HIGH_TIER_EFFORT_MODELS = ['opus', 'fable', 'sonnet'];
  const resolvedModel = resolveModelInternal(cwd, agentType);
  const haikuSkip = resolvedModel === 'haiku';
  const highEffortSkip =
    resolvedModel &&
    !HIGH_TIER_EFFORT_MODELS.includes(resolvedModel) &&
    (effort === 'xhigh' || effort === 'max');
  if (haikuSkip || highEffortSkip) {
    if (hasExplicitOverride && effort !== null) {
      const overrideValue = config.effort_overrides[agentType];
      const reason = haikuSkip
        ? 'haiku does not support effort: frontmatter'
        : `${effort} requires opus, fable, or sonnet (resolved model: ${resolvedModel})`;
      fs.writeSync(
        2,
        `Warning: effort_overrides.${agentType}="${overrideValue}" ignored — ${reason}\n`,
      );
    }
    return null;
  }

  return effort;
}

// ─── Misc utilities ───────────────────────────────────────────────────────────

function pathExistsInternal(cwd, targetPath) {
  const fullPath = path.isAbsolute(targetPath)
    ? targetPath
    : path.join(cwd, targetPath);
  try {
    fs.statSync(fullPath);
    return true;
  } catch {
    return false;
  }
}

function readTextArgOrFile(cwd, value, filePath, label) {
  if (!filePath) return value;

  const resolvedPath = path.isAbsolute(filePath)
    ? filePath
    : path.join(cwd, filePath);
  try {
    return fs.readFileSync(resolvedPath, 'utf-8').trimEnd();
  } catch {
    throw new Error(`${label} file not found: ${filePath}`);
  }
}

function generateSlugInternal(text, maxLen = 50) {
  if (!text) return null;
  let slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (slug.length > maxLen) {
    slug = slug.slice(0, maxLen).replace(/-[^-]*$/, '');
  }
  return slug;
}

function getMilestoneInfo(cwd) {
  try {
    const roadmap = fs.readFileSync(planningPaths(cwd).roadmap, 'utf-8');

    // First: check for list-format roadmaps using 🚧 (in-progress) marker
    // e.g. "- 🚧 **v2.1 Belgium** — Phases 24-28 (in progress)"
    const inProgressMatch = roadmap.match(/🚧\s*\*\*v(\d+\.\d+)\s+([^*]+)\*\*/);
    if (inProgressMatch) {
      return {
        version: 'v' + inProgressMatch[1],
        name: inProgressMatch[2].trim(),
      };
    }

    // Second: heading-format roadmaps — strip shipped milestones in <details> blocks
    const cleaned = extractCurrentMilestone(roadmap);
    // Extract version and name from the same ## heading for consistency
    const headingMatch = cleaned.match(/## .*v(\d+\.\d+)[:\s]+([^\n(]+)/);
    if (headingMatch) {
      return {
        version: 'v' + headingMatch[1],
        name: headingMatch[2].trim(),
      };
    }
    // Fallback: try bare version match
    const versionMatch = cleaned.match(/v(\d+\.\d+)/);
    return {
      version: versionMatch ? versionMatch[0] : 'v1.0',
      name: 'milestone',
    };
  } catch {
    return { version: 'v1.0', name: 'milestone' };
  }
}

/** A phase directory starts with its (optionally zero-padded) phase number. */
const PHASE_DIR_ANCHOR = /^0*(\d+[A-Za-z]?(?:\.\d+)*)/;

/**
 * Returns a filter function that checks whether a phase directory belongs
 * to the current milestone based on ROADMAP.md phase headings.
 *
 * If no ROADMAP exists or no phases are listed, the filter accepts every
 * directory whose name is shaped like a phase. That keeps a project whose
 * roadmap is not yet written able to see its own phases, without counting
 * whatever else lands in .planning/phases/ — `.claude`, `node_modules`, `.git`.
 */
function getMilestonePhaseFilter(cwd) {
  const milestonePhaseNums = new Set();
  try {
    const roadmap = extractCurrentMilestone(
      fs.readFileSync(planningPaths(cwd).roadmap, 'utf-8'),
    );
    const phasePattern = /#{2,4}\s*Phase\s+(\d+[A-Z]?(?:\.\d+)*)\s*:/gi;
    let m;
    while ((m = phasePattern.exec(roadmap)) !== null) {
      milestonePhaseNums.add(m[1]);
    }
    // Also recognize bullet-only entries: `- [ ] Phase N: Title` (no Details
    // header yet). These exist for phases that are declared in the roadmap but
    // not yet planned via /gsd:plan-phase. The `getMilestonePhaseFilter` only
    // needs the phase number, so a Set union with the header results suffices.
    for (const entry of parsePhaseCheckboxes(roadmap)) {
      milestonePhaseNums.add(entry.num);
    }
  } catch {}

  if (milestonePhaseNums.size === 0) {
    const anyPhaseDir = (dirName) => PHASE_DIR_ANCHOR.test(dirName);
    anyPhaseDir.phaseCount = 0;
    return anyPhaseDir;
  }

  const normalized = new Set(
    [...milestonePhaseNums].map((n) =>
      (n.replace(/^0+/, '') || '0').toLowerCase(),
    ),
  );

  function isDirInMilestone(dirName) {
    const m = dirName.match(PHASE_DIR_ANCHOR);
    if (!m) return false;
    return normalized.has(m[1].toLowerCase());
  }
  isDirInMilestone.phaseCount = milestonePhaseNums.size;
  return isDirInMilestone;
}

// ─── Phase Completion Status ────────────────────────────────────────────────

/**
 * Read the `status:` field from a phase's VERIFICATION.md.
 *
 * Returns null when the phase has no verification report, or the report exists
 * but cannot be read/parsed. Callers must distinguish that null ("nobody has
 * judged this phase") from a concrete failing status like 'gaps_found'
 * ("the verifier judged it and the goal is not met") — they mean opposite
 * things for anything gated on verification.
 *
 * Known statuses written by gsd-verifier: passed | gaps_found | human_needed | halted
 */
function readVerificationStatus(phaseDir) {
  let files;
  try {
    files = fs.readdirSync(phaseDir);
  } catch {
    return null;
  }
  const verificationFile = files.find(
    (f) => f.endsWith('-VERIFICATION.md') || f === 'VERIFICATION.md',
  );
  if (!verificationFile) return null;
  try {
    const { extractFrontmatter } = require('./frontmatter.cjs');
    const fm = extractFrontmatter(
      fs.readFileSync(path.join(phaseDir, verificationFile), 'utf-8'),
    );
    return fm && typeof fm.status === 'string' ? fm.status.trim() : null;
  } catch {
    return null;
  }
}

/**
 * Determine phase completion status with verification awareness.
 * Returns { isComplete, status } where status is one of:
 *   'not_started', 'in_progress', 'complete (verified)', 'complete (unverified)'
 * isComplete is true when summaries >= plans (backward compatible).
 * Verification is a qualifier, not a gate.
 */
function getPhaseCompletionStatus(phaseDir) {
  if (!fs.existsSync(phaseDir)) {
    return { isComplete: false, status: 'not_started' };
  }
  let files;
  try {
    files = fs.readdirSync(phaseDir);
  } catch {
    return { isComplete: false, status: 'not_started' };
  }
  const planCount = files.filter(
    (f) => f.match(/-PLAN\.md$/i) || f === 'PLAN.md',
  ).length;
  const summaryCount = files.filter(
    (f) => f.match(/-SUMMARY\.md$/i) || f === 'SUMMARY.md',
  ).length;
  if (planCount === 0) return { isComplete: false, status: 'not_started' };
  if (summaryCount < planCount)
    return { isComplete: false, status: 'in_progress' };
  // summaries >= plans — phase is complete. Check verification status.
  if (readVerificationStatus(phaseDir) === 'passed') {
    return { isComplete: true, status: 'complete (verified)' };
  }
  return { isComplete: true, status: 'complete (unverified)' };
}

// ─── Summary body helpers ─────────────────────────────────────────────────

/**
 * Extract a one-liner from the summary body when it's not in frontmatter.
 * The summary template defines one-liner as a bold markdown line after the heading:
 *   # Phase X: Name Summary
 *   **[substantive one-liner text]**
 */
function extractOneLinerFromBody(content) {
  if (!content) return null;
  // Strip frontmatter first
  const body = content.replace(/^---\n[\s\S]*?\n---\n*/, '');
  // Find the first **...** line after a # heading
  const match = body.match(/^#[^\n]*\n+\*\*([^*]+)\*\*/m);
  return match ? match[1].trim() : null;
}

module.exports = {
  output,
  setFileOutput,
  setJsonMode,
  error,
  reapStaleTempFiles,
  reapStaleAtomicTempFiles,
  writeFileAtomic,
  lockPathFor,
  acquireFileLock,
  releaseFileLock,
  withFileLock,
  withRoadmapLock,
  lockedPlanningDoc,
  LOCK_STALE_MS,
  LOCK_ACQUIRE_BUDGET_MS,
  safeReadFile,
  loadConfig,
  resolveTargetBranch,
  getEngineRuntime,
  isGitIgnored,
  execGit,
  escapeRegex,
  boldLabel,
  phaseFieldPattern,
  phaseNumPattern,
  phaseCheckboxPattern,
  phaseCheckboxLinePattern,
  phaseCheckboxName,
  parsePhaseCheckboxes,
  normalizePhaseName,
  comparePhaseNum,
  searchPhaseInDir,
  findPhaseInternal,
  getArchivedPhaseDirs,
  getRoadmapPhaseInternal,
  resolveModelInternal,
  resolveEffortInternal,
  pathExistsInternal,
  readTextArgOrFile,
  generateSlugInternal,
  getMilestoneInfo,
  getMilestonePhaseFilter,
  extractCurrentMilestone,
  replaceInCurrentMilestone,
  currentMilestoneOffset,
  hasPhaseTableRow,
  hasPhaseHeader,
  hasPhasePlansLine,
  isPhaseCheckboxSatisfied,
  getPhaseCompletionStatus,
  readVerificationStatus,
  toPosixPath,
  extractOneLinerFromBody,
  planningPaths,
};
