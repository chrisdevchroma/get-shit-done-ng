#!/usr/bin/env node
/**
 * bash-safety-hook.cjs — PreToolUse hook for compound bash command allowlist matching
 *
 * Decomposes compound bash commands (&&, ||, ;, |, $() subshells) into individual
 * sub-commands and auto-approves only when ALL sub-commands match the user's
 * allowlist, including shell builtins.
 *
 * Algorithm ported from liberzon/claude-hooks (Python) to Node.js CommonJS.
 * See: https://github.com/liberzon/claude-hooks
 * See: https://github.com/anthropics/claude-code/issues/30435 (#30435)
 * See: https://github.com/anthropics/claude-code/issues/15897 (#15897 — why we don't use updatedInput)
 * See: https://github.com/anthropics/claude-code/issues/16561 (#16561 — compound command root cause)
 *
 * Hook output format (Claude Code PreToolUse):
 *   Allow: {"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow","permissionDecisionReason":"..."}}
 *   Deny:  {"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"..."}}
 *   Fall-through (no output): exit 0 silently
 *
 * Kill switch: GSD_DISABLE_BASH_HOOK=1 — exits immediately (checked FIRST, before stdin read)
 * Debug logging: GSD_HOOK_DEBUG=1 — writes verbose logs to stderr
 *
 * Settings layers read (CLAUDE_PROJECT_DIR and CLAUDE_SETTINGS_PATH env vars):
 *   Layer 1: $CLAUDE_SETTINGS_PATH || ~/.claude/settings.json
 *   Layer 2: ~/.claude/settings.local.json
 *   Layer 3: $CLAUDE_PROJECT_DIR/.claude/settings.json
 *   Layer 4: $CLAUDE_PROJECT_DIR/.claude/settings.local.json
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { readStdinWithTimeout } = require('./gsd-hook-stdin.cjs');

// ── Structural shell keywords — filter these out (not real commands) ──────────
// Control/syntax constructs that are not checkable commands. Includes shell
// syntax markers (done/fi/esac/then/else/elif/do/{/}), loop-control builtins
// (break/continue — accept an optional numeric arg but are not security-
// relevant themselves), and the nullary-idiom builtins true/false (accept
// and ignore any args; common in the `cmd || true` idiom).
//
// INVARIANT (enforced by decomposeCommand): extractSubshells() runs on every
// rawPart BEFORE this filter is consulted. That means a structural keyword
// wrapping a `$()` argument (e.g. `then $(curl evil)`, `break $(curl evil)`,
// `true $(curl evil)`) cannot bypass allow/deny — the inner command is
// pushed to the decomposed result regardless of whether the outer keyword
// is later filtered out here.
//
// exit/return/local/export are NOT in this set — they are real commands that
// must reach the allowlist path (covered by template entries like
// `Bash(local *)`, `Bash(export *)`). `eval` is never filtered or
// allowlisted — it executes arbitrary strings.
const STRUCTURAL_KEYWORDS = new Set([
  'done',
  'fi',
  'esac',
  '{',
  '}',
  'break',
  'continue',
  'then',
  'else',
  'elif',
  'do',
  'true',
  'false',
]);

// ── Compound statement headers — filter from decomposed output ────────────────
// These keywords introduce compound commands but are not executable commands themselves.
const COMPOUND_HEADER_RE = /^(for|while|until|if|case|select)\b/;

// ── Wrapper commands ─────────────────────────────────────────────────────────
// Commands that take another command as argv suffix. Without per-wrapper
// handling, an allowlist entry for the wrapper (e.g. `Bash(env *)`) silently
// bypasses the deny-first check on the wrapped command:
//   `env FOO=bar curl evil.com`       — `Bash(env *)` matches whole string
//   `timeout 10 curl evil.com`        — `Bash(timeout *)` matches whole string
//   `find . | xargs rm -rf`           — `Bash(xargs *)` matches the right side
//
// `extractWrappedCommand` (below) skips the wrapper's own options/values and
// returns the wrapped command, which `decomposeCommand` then ALSO pushes as
// a sub-command — so the allowlist check is applied to both the wrapper
// invocation and the wrapped command. Both must be allowlisted for approval.
//
// `sudo` is intentionally NOT included — sudo escalates privileges and should
// never be silently approved through a wrapped-command match. If a user
// allowlists `Bash(sudo *)` they are explicitly opting in. (`eval` similarly
// excluded.)
const WRAPPER_COMMANDS = new Set([
  'env',
  'timeout',
  'xargs',
  'nohup',
  'exec',
  'nice',
  'ionice',
  'chrt',
  'taskset',
  'flock',
  'stdbuf',
]);

// ── Heredoc detection regex ──────────────────────────────────────────────────
// Matches real heredoc operators (<<WORD, <<-WORD, <<'WORD', <<"WORD") while
// excluding here-strings (<<<). Uses (?<!<) lookbehind + (?!<) lookahead:
// without BOTH anchors, the regex engine can match the 2nd+3rd '<' of '<<<'
// as a valid '<<', bypassing a lookahead-only guard. This is an improvement
// over the upstream Python (liberzon/claude-hooks) which uses \w+ — immune
// to '<<<' by accident but unable to match non-word here-doc delimiters
// (hyphenated or dotted labels, e.g. eof-1, end.txt).
//
// Capture groups: (1) single-quoted delimiter, (2) double-quoted, (3) unquoted.
// Use: m[1] || m[2] || m[3] to get the delimiter.
const HEREDOC_START_RE =
  /(?<!<)<<(?!<)-?\s*(?:'([^'\n]+)'|"([^"\n]+)"|([^\s'"]+))/;

// ── _skipShellValue ───────────────────────────────────────────────────────────
/**
 * Starting at index i in cmd (immediately after `KEY=`), skip over the value
 * and return the index of the first character after the value.
 *
 * Handles: double-quoted strings, single-quoted strings, and unquoted words
 * (including $() subshell values such as `result=$(curl ...)`).
 *
 * Ported from liberzon/claude-hooks smart_approve.py _skip_shell_value().
 *
 * @param {string} cmd - Command string
 * @param {number} i - Index into cmd where the value starts (right after '=')
 * @returns {number} Index of first character after the value
 */
function _skipShellValue(cmd, i) {
  if (i >= cmd.length) return i;
  const ch = cmd[i];
  // Double-quoted string
  if (ch === '"') {
    let j = i + 1;
    while (j < cmd.length) {
      if (cmd[j] === '\\' && j + 1 < cmd.length) {
        j += 2;
        continue;
      }
      if (cmd[j] === '"') return j + 1;
      j++;
    }
    return j;
  }
  // Single-quoted string
  if (ch === "'") {
    let j = i + 1;
    while (j < cmd.length) {
      if (cmd[j] === "'") return j + 1;
      j++;
    }
    return j;
  }
  // Unquoted word — track $() paren depth
  let j = i;
  let parenDepth = 0;
  while (j < cmd.length) {
    if (cmd[j] === '$' && j + 1 < cmd.length && cmd[j + 1] === '(') {
      parenDepth++;
      j += 2;
      continue;
    }
    if (cmd[j] === '(' && parenDepth > 0) {
      parenDepth++;
      j++;
      continue;
    }
    if (cmd[j] === ')' && parenDepth > 0) {
      parenDepth--;
      j++;
      continue;
    }
    if (parenDepth === 0 && /\s/.test(cmd[j])) break;
    j++;
  }
  return j;
}

// ── _normalizeWrapperName ────────────────────────────────────────────────────
/**
 * Normalize an invocation token to the canonical wrapper name used in
 * WRAPPER_COMMANDS lookup. Handles two non-canonical forms that would
 * otherwise bypass the wrapper-bypass guard when allowlisted in the same
 * non-canonical form:
 *   - full paths:   `/usr/bin/env` -> `env`
 *   - quoted name:  `"env"` / `'env'` -> `env`
 *   - combined:     `"/usr/bin/env"` -> `env`
 *
 * The normalization is intentionally narrow: it does NOT do alias lookup,
 * shell-builtin resolution, or substring matching — `myenv` and `envwrap`
 * still won't be treated as `env`.
 *
 * @param {string} s - Raw first-token of the command
 * @returns {string} Normalized wrapper name (may be empty)
 */
function _normalizeWrapperName(s) {
  if (typeof s !== 'string' || s.length === 0) return '';
  let n = s;
  // Strip matching surrounding quotes (single or double).
  if (n.length >= 2) {
    const first = n[0];
    const last = n[n.length - 1];
    if ((first === '"' || first === "'") && first === last) {
      n = n.slice(1, -1);
    }
  }
  // Take basename if any `/` separator is present.
  const slashIdx = n.lastIndexOf('/');
  if (slashIdx >= 0) {
    n = n.slice(slashIdx + 1);
  }
  return n;
}

// ── _endsWithUnescapedBackslash ──────────────────────────────────────────────
/**
 * Returns true if `s` ends with an odd number of trailing backslashes,
 * which means the final backslash is an escape (e.g. `FOO=a\` indicates
 * the next whitespace was escaped — value continues into next token).
 * Even-count trailing backslashes (`\\`, `\\\\`, ...) are literal.
 *
 * @param {string} s
 * @returns {boolean}
 */
function _endsWithUnescapedBackslash(s) {
  let n = 0;
  for (let k = s.length - 1; k >= 0 && s[k] === '\\'; k--) n++;
  return n % 2 === 1;
}

// ── isStandaloneAssignment ────────────────────────────────────────────────────
/**
 * Returns true if cmd is a standalone variable assignment with no command following.
 *
 * Handles simple assignments (FOO=bar), quoted assignments (FOO="bar baz"),
 * and subshell assignments (result=$(curl ...)).
 *
 * @param {string} cmd - Normalized command string
 * @returns {boolean}
 */
function isStandaloneAssignment(cmd) {
  const m = cmd.match(/^[A-Za-z_][A-Za-z0-9_]*=/);
  if (!m) return false;
  const end = _skipShellValue(cmd, m[0].length);
  return cmd.slice(end).trim() === '';
}

// ── stripHeredocs ─────────────────────────────────────────────────────────────
/**
 * Strip heredoc bodies from a command string, leaving just the <<DELIM marker line.
 *
 * Heredocs like <<'EOF'\n...\nEOF are replaced with the marker line only
 * (body removed). This prevents heredoc content lines from being treated
 * as sub-commands when splitOnOperators() splits on newlines.
 *
 * Ported from liberzon/claude-hooks smart_approve.py strip_heredocs().
 *
 * @param {string} command - Raw bash command string (may contain newlines)
 * @returns {string} Command with heredoc bodies removed
 */
function stripHeredocs(command) {
  const lines = command.split('\n');
  const result = [];
  let heredocDelim = null;
  let i = 0;

  while (i < lines.length) {
    if (heredocDelim !== null) {
      // Inside heredoc body -- look for the terminator line
      if (lines[i].trim() === heredocDelim) {
        heredocDelim = null;
      }
      i++;
      continue;
    }

    // Check for heredoc marker — uses shared HEREDOC_START_RE (see constant definition)
    const m = lines[i].match(HEREDOC_START_RE);
    if (m) {
      const heredocPos = m.index;
      if (!isInsideQuotes(lines[i], heredocPos)) {
        heredocDelim = m[1] || m[2] || m[3];
      }
    }

    result.push(lines[i]);
    i++;
  }

  return result.join('\n');
}

// ── isInsideQuotes ────────────────────────────────────────────────────────────
/**
 * Check if position idx in line falls inside a quoted string.
 * Left-to-right scan tracking single/double quote toggle state.
 *
 * @param {string} line - The line to check
 * @param {number} idx  - Position to test
 * @returns {boolean} true if idx is inside a quoted region
 */
function isInsideQuotes(line, idx) {
  let inSingle = false;
  let inDouble = false;
  for (let j = 0; j < idx; j++) {
    const c = line[j];
    if (c === "'" && !inDouble) {
      inSingle = !inSingle;
    } else if (c === '"' && !inSingle) {
      inDouble = !inDouble;
    } else if (c === '\\' && inDouble && j + 1 < idx) {
      j++; // skip escaped char inside double quotes
    }
  }
  return inSingle || inDouble;
}

// ── splitNaive ────────────────────────────────────────────────────────────────
/**
 * Operator-only split with no quote/subshell/conditional awareness — splits on
 * &&, ||, |, ;, and newline, treating every other character as literal. Used by
 * splitOnOperators as the fail-closed fallback for malformed input (unbalanced
 * quote/subshell/backtick/`[[`), where the normal tracking would otherwise absorb
 * a hidden command into one segment. Over-splits, which can only deny/passthrough.
 *
 * @param {string} command
 * @returns {string[]}
 */
function splitNaive(command) {
  const parts = [];
  let current = '';
  let i = 0;
  while (i < command.length) {
    const ch = command[i];
    const next = command[i + 1] || '';
    if ((ch === '&' && next === '&') || (ch === '|' && next === '|')) {
      parts.push(current);
      current = '';
      i += 2;
      continue;
    }
    if (ch === '|' || ch === ';' || ch === '\n') {
      parts.push(current);
      current = '';
      i++;
      continue;
    }
    current += ch;
    i++;
  }
  if (current !== '') parts.push(current);
  return parts;
}

// ── splitOnOperators ──────────────────────────────────────────────────────────
/**
 * Split a compound bash command string on operators: &&, ||, ;, |, newline.
 * Uses a character-by-character state machine to correctly handle:
 *   - Single-quoted strings (no escapes inside)
 *   - Double-quoted strings (backslash escapes allowed)
 *   - $() subshells (tracked by depth, no split inside)
 *   - Backtick subshells (legacy `cmd`)
 *
 * Ported from liberzon/claude-hooks smart_approve.py split_on_operators().
 *
 * `[[ ... ]]` conditionals suppress operator splitting inside them, so
 * `[[ -n "$x" && -f "$t" ]]` is a single segment. If the scan ends with an
 * unbalanced quote, subshell, backtick, or `[[` (malformed input), the tracking
 * may have absorbed a later command into one segment; the command is then re-split
 * via splitNaive so every segment reaches the deny check (fail-closed).
 *
 * @param {string} command - Raw bash command string
 * @returns {string[]} Array of sub-command strings (may need trimming/normalizing)
 */
function splitOnOperators(command) {
  command = command.replace(/\\\n/g, ' ');
  const parts = [];
  let current = '';
  let singleQuote = false;
  let doubleQuote = false;
  let depth = 0; // $() subshell depth
  let backtick = false;
  let condDepth = 0; // [[ ]] bash conditional-keyword depth
  let i = 0;

  while (i < command.length) {
    const ch = command[i];
    const next = command[i + 1] || '';

    // ── Single quote state ──
    if (ch === "'" && !doubleQuote && !singleQuote && depth === 0) {
      singleQuote = true;
      current += ch;
      i++;
      continue;
    }
    if (ch === "'" && singleQuote) {
      singleQuote = false;
      current += ch;
      i++;
      continue;
    }
    // Inside single quotes: no escapes, no special chars
    if (singleQuote) {
      current += ch;
      i++;
      continue;
    }

    // ── Double quote state ──
    if (ch === '"' && !doubleQuote && depth === 0) {
      doubleQuote = true;
      current += ch;
      i++;
      continue;
    }
    if (ch === '"' && doubleQuote) {
      doubleQuote = false;
      current += ch;
      i++;
      continue;
    }
    // Inside double quotes: allow backslash escapes
    if (doubleQuote) {
      if (ch === '\\' && next) {
        current += ch + next;
        i += 2;
        continue;
      }
      // Track $() inside double quotes for depth — consume $( as a unit (i += 2)
      // to prevent the '(' being re-processed by the bare-paren handler
      if (ch === '$' && next === '(') {
        depth++;
        current += ch + next;
        i += 2;
        continue;
      }
      if (ch === ')' && depth > 0) {
        depth--;
        current += ch;
        i++;
        continue;
      }
      current += ch;
      i++;
      continue;
    }

    // ── Outside quotes ──

    // Backslash escape
    if (ch === '\\' && next) {
      current += ch + next;
      i += 2;
      continue;
    }

    // $( — enter subshell. Consume $( as a unit (i += 2) so the '(' is not
    // re-processed by the bare-paren handler, which would double-increment depth.
    // Python upstream: i += 2. Without this, depth stays >0 after the closing ')',
    // preventing operator splitting — a security bypass.
    if (ch === '$' && next === '(') {
      depth++;
      current += ch + next;
      i += 2;
      continue;
    }

    // ( — track nested parens inside subshell
    if (ch === '(' && depth > 0) {
      depth++;
      current += ch;
      i++;
      continue;
    }

    // Backtick subshell (legacy `cmd`)
    if (ch === '`') {
      backtick = !backtick;
      current += ch;
      i++;
      continue;
    }

    // ) — exit subshell
    if (ch === ')' && depth > 0) {
      depth--;
      current += ch;
      i++;
      continue;
    }

    // ── [[ / ]] conditional-keyword tracking (depth===0, outside quotes/subshells/backticks) ──
    // Treats `[[` and `]]` as keyword tokens only when whitespace-delimited (bash semantics).
    // This prevents `[[:alpha:]]` (character class, followed by `:`) and glob/array syntax
    // from opening a conditional region.
    //
    // Fail-safe design: when the open-heuristic is uncertain, do NOT open a region. Erring
    // toward MORE splitting causes passthrough/manual-prompt (current behavior), never a bypass.
    // Erring toward LESS splitting could merge an unchecked command — so keep open strict.
    //
    // Only runs when depth===0 and !backtick (no subshell/backtick context).
    if (depth === 0 && !backtick) {
      // Detect `[[` open: two '[' chars, previous char is start-of-string or whitespace,
      // char immediately after `[[` is whitespace or end-of-string.
      if (
        ch === '[' &&
        next === '[' &&
        (current === '' || /\s/.test(current[current.length - 1])) &&
        (command[i + 2] === undefined || /\s/.test(command[i + 2]))
      ) {
        // Nested `[[` is invalid bash (condDepth never legitimately exceeds 1); a
        // second `[[` inside a conditional is malformed — fail closed via splitNaive.
        if (condDepth > 0) {
          return splitNaive(command);
        }
        condDepth++;
        current += '[[';
        i += 2;
        continue;
      }

      // Detect `]]` close: two ']' chars, condDepth > 0, previous char is whitespace
      // (a real `]]` is always preceded by whitespace in a bash conditional).
      if (
        ch === ']' &&
        next === ']' &&
        condDepth > 0 &&
        current.length > 0 &&
        /\s/.test(current[current.length - 1])
      ) {
        condDepth--;
        current += ']]';
        i += 2;
        continue;
      }
    }

    // Inside subshell or backtick: don't split
    if (depth > 0 || backtick) {
      current += ch;
      i++;
      continue;
    }

    // ── Inside [[ ]] conditional: operators are literal test content, not split points ──
    // All of &&, ||, |, ;, \n are internal to the conditional expression and must not
    // cause a split. This block runs AFTER [[ / ]] detection above, so closers are still
    // recognized when condDepth reaches 0.
    if (condDepth > 0) {
      current += ch;
      i++;
      continue;
    }

    // ── Operator detection (only at depth==0, condDepth===0, outside quotes) ──

    // && operator
    if (ch === '&' && next === '&') {
      parts.push(current);
      current = '';
      i += 2;
      continue;
    }

    // || operator
    if (ch === '|' && next === '|') {
      parts.push(current);
      current = '';
      i += 2;
      continue;
    }

    // | pipe (single, not part of ||)
    if (ch === '|') {
      parts.push(current);
      current = '';
      i++;
      continue;
    }

    // ; semicolon
    if (ch === ';') {
      parts.push(current);
      current = '';
      i++;
      continue;
    }

    // Newline
    if (ch === '\n') {
      parts.push(current);
      current = '';
      i++;
      continue;
    }

    current += ch;
    i++;
  }

  // ── Fail-closed guard for malformed input ────────────────────────────────────
  // An unbalanced quote, subshell, backtick, or `[[` at end-of-input means the
  // tracking above may have absorbed top-level operators into one segment, hiding a
  // later command from the deny check. Such input is a bash syntax error, but the
  // hook must still fail closed: re-split naively so every segment is checked.
  if (singleQuote || doubleQuote || depth > 0 || backtick || condDepth > 0) {
    return splitNaive(command);
  }

  // Push trailing part
  if (current !== '') {
    parts.push(current);
  }

  return parts;
}

// ── normalizeCommand ──────────────────────────────────────────────────────────
/**
 * Normalize a single (already-split) sub-command string:
 *   1. Strip heredoc body (<< WORD ... WORD)
 *   2. Strip leading keyword prefixes (do, then, else, elif)
 *   3. Strip leading env var assignments (KEY=value KEY2=value2 ...)
 *   4. Strip trailing redirections (>, >>, <, 2>&1, etc.)
 *   5. Collapse whitespace and trim
 *
 * Returns empty string for structural keywords and standalone assignments.
 *
 * Ported from liberzon/claude-hooks smart_approve.py normalize_command().
 *
 * @param {string} cmd - Single sub-command string (pre-split)
 * @returns {string} Normalized command (may be empty string)
 */
function normalizeCommand(cmd) {
  let s = cmd.trim();
  if (!s) return '';

  // Strip heredoc/here-string redirection: << WORD ... (remove << marker and everything after)
  // Uses shared HEREDOC_START_RE to exclude here-strings (<<<), then strips the rest of the line.
  s = s
    .replace(new RegExp(HEREDOC_START_RE.source + '\\s*.*$', 's'), '')
    .trim();

  // Strip keyword prefixes: do, then, else, elif (at start of command)
  s = s.replace(/^(do|then|else|elif)\s+/, '');

  // Strip leading env var prefixes: KEY=value KEY2=value ...
  // Uses _skipShellValue to correctly handle quoted values and $() subshell values.
  while (true) {
    const m = s.match(/^[A-Za-z_][A-Za-z0-9_]*=/);
    if (!m) break;
    const endVal = _skipShellValue(s, m[0].length);
    const rest = s.slice(endVal).trimStart();
    if (!rest) break; // standalone assignment — stop stripping, keep as-is
    s = rest;
  }

  // Strip trailing redirections: >, >>, <, 2>&1, &>, /dev/null, etc.
  // Simple approach: strip common redirection patterns from the end
  // Remove: 2>&1, &>, &>>, >>, >, <, followed by optional filename
  s = s.replace(/\s+[0-9]*>>?\s*\S+$/, '');
  s = s.replace(/\s+[0-9]*>&[0-9]+$/, '');
  s = s.replace(/\s+&>>?\s*\S+$/, '');
  s = s.replace(/\s+<\s*\S+$/, '');

  // Also strip 2>&1 appearing anywhere at end
  s = s.replace(/\s+2>&1$/, '');

  // Collapse internal whitespace
  s = s.replace(/\s+/g, ' ').trim();

  return s;
}

// ── decomposeCommand ──────────────────────────────────────────────────────────
/**
 * Decompose a compound bash command into an array of individual command strings.
 *
 * Steps:
 *   1. Split on operators (&&, ||, ;, |, newline) using state machine
 *   2. For each token, extract $() subshell contents recursively
 *   3. Normalize each token
 *   4. Filter out structural keywords (done/fi/esac/{/}/break/continue) and
 *      standalone assignments (FOO=bar with no command following)
 *
 * @param {string} command - Full compound bash command
 * @returns {string[]} Flat array of normalized individual command strings
 */
/**
 * Extract the wrapped command from a wrapper invocation. Returns the wrapped
 * command string (rest of argv after the wrapper's own options/values) or
 * null if the input isn't a wrapper invocation.
 *
 * Per-wrapper option handling:
 *   - env: skip `-i` / `--ignore-environment`, `-u VAR` / `--unset VAR`,
 *     and any `KEY=value` tokens (env-var assignments)
 *   - timeout: skip flags, then skip the duration positional arg
 *   - xargs: skip flags. xargs flags are option-rich (`-I {}`, `-n N`,
 *     `-P N`, etc.); we conservatively skip any `-X` token plus the next
 *     token for known value-taking flags
 *   - nohup, exec, stdbuf, flock: no options to skip — next token is cmd
 *   - nice, ionice, chrt, taskset: skip `-N val` style flags
 *
 * Limitations: bare-word option syntax varies across implementations; we err
 * toward over-stripping (skip a token that might be a positional arg). The
 * cost is a slightly less precise check on the wrapped command — never a
 * less-strict one. The returned wrapped command itself is run through the
 * allowlist independently, so over-stripping cannot grant new permissions.
 *
 * @param {string} cmd - Normalized sub-command string (single statement)
 * @returns {string | null} Wrapped command string, or null
 */
function extractWrappedCommand(cmd) {
  if (typeof cmd !== 'string' || cmd.length === 0) return null;
  const tokens = cmd.trim().split(/\s+/);
  if (tokens.length < 2) return null;
  // Normalize the invocation token so non-canonical forms don't bypass
  // the wrapper-bypass guard: `/usr/bin/env` and `"env"` both reduce to
  // `env` for the WRAPPER_COMMANDS lookup. The original token is kept
  // intact for everything else (decomposeCommand still pushes the outer
  // command verbatim against the allowlist).
  const wrapper = _normalizeWrapperName(tokens[0]);
  if (!WRAPPER_COMMANDS.has(wrapper)) return null;

  let i = 1;

  if (wrapper === 'env') {
    while (i < tokens.length) {
      const t = tokens[i];
      // `--` end-of-options marker: skip and stop option parsing — the very
      // next token is the wrapped command.
      if (t === '--') {
        i++;
        break;
      }
      if (t === '-i' || t === '--ignore-environment' || t === '-0') {
        i++;
        continue;
      }
      if (t === '-u' || t === '--unset' || t === '-C' || t === '--chdir') {
        i += 2;
        continue;
      }
      // GNU env combined short-flag form: -uVAR, -CDIR (value attached, no space)
      if (/^-[uC]./.test(t)) {
        i++;
        continue;
      }
      // GNU env long-option-with-value form: --unset=VAR, --chdir=DIR
      if (t.startsWith('--unset=') || t.startsWith('--chdir=')) {
        i++;
        continue;
      }
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(t)) {
        // Quoted-value handling: `FOO="a b"` or `FOO='a b'` opens a quoted
        // value that whitespace tokenization splits across multiple tokens
        // (e.g. tokens become `FOO="a` and `b"`). Without this, the env
        // option-walk would stop at `b"` (no `=`, not a flag) and return
        // garbage starting with the value-tail. We detect an unbalanced
        // opening quote on the value side of `=` and consume forward
        // tokens until we find the matching closer.
        //
        // For double quotes, the closer detection has to be escape-aware:
        // a token ending in `\"` is an escaped literal `"`, not the end
        // of the quoted value (`env FOO="a\" b" cmd` — value is `a" b`).
        // Single quotes don't process escapes in shell at all, so plain
        // `endsWith("'")` is sufficient.
        //
        // Failure mode is conservative: if no closer is found we fall
        // through, returning a tail that is unlikely to match any
        // allowlist entry — never silent approval.
        const eqIdx = t.indexOf('=');
        const value = t.slice(eqIdx + 1);
        const quoteChar = value[0];
        if (quoteChar === '"' || quoteChar === "'") {
          const isCloser = (s) => {
            if (s.length === 0 || s[s.length - 1] !== quoteChar) return false;
            if (quoteChar === "'") return true; // no escapes inside single-quoted
            // Double-quoted: trailing `"` is a literal closer iff preceded
            // by an even number (incl. 0) of backslashes.
            let n = 0;
            for (let k = s.length - 2; k >= 0 && s[k] === '\\'; k--) n++;
            return n % 2 === 0;
          };
          // Single-token balanced assignment: value has length >= 2 AND
          // ends with the matching un-escaped quoteChar.
          if (!(value.length >= 2 && isCloser(value))) {
            // Unbalanced — consume forward tokens until we find a real closer.
            i++;
            while (i < tokens.length) {
              if (isCloser(tokens[i])) {
                i++;
                break;
              }
              i++;
            }
            continue;
          }
        }
        // Plain (unquoted) value — but it may end with an unescaped
        // backslash, indicating that the shell consumed an escaped
        // whitespace and the value continues into the next token
        // (e.g. `FOO=a\ b` tokenizes as `FOO=a\` then `b`). Trailing
        // odd-count backslashes = escape; even count = literal `\\`.
        // Consume continuation tokens until the value no longer ends
        // with an unescaped backslash.
        i++;
        let lastTok = t;
        while (i < tokens.length && _endsWithUnescapedBackslash(lastTok)) {
          lastTok = tokens[i];
          i++;
        }
        continue;
      }
      break;
    }
  } else if (wrapper === 'timeout') {
    // Skip options
    while (i < tokens.length && tokens[i].startsWith('-')) {
      const t = tokens[i];
      if (
        t === '-s' ||
        t === '--signal' ||
        t === '-k' ||
        t === '--kill-after'
      ) {
        i += 2;
      } else {
        i++;
      }
    }
    // Skip duration positional
    if (i < tokens.length) i++;
  } else if (wrapper === 'xargs') {
    while (i < tokens.length && tokens[i].startsWith('-')) {
      const t = tokens[i];
      if (t === '--') {
        i++;
        break;
      }
      // Value-taking flags
      if (
        t === '-I' ||
        t === '-i' ||
        t === '-n' ||
        t === '--max-args' ||
        t === '-P' ||
        t === '--max-procs' ||
        t === '-L' ||
        t === '--max-lines' ||
        t === '-d' ||
        t === '--delimiter' ||
        t === '-E' ||
        t === '--eof' ||
        t === '-s' ||
        t === '--max-chars' ||
        t === '-a' ||
        t === '--arg-file'
      ) {
        i += 2;
      } else {
        // Boolean flags like -0, -t, -p, -r, -x, --no-run-if-empty
        i++;
      }
    }
  } else if (wrapper === 'nice' || wrapper === 'ionice' || wrapper === 'chrt') {
    while (i < tokens.length && tokens[i].startsWith('-')) {
      const t = tokens[i];
      if (
        t === '-n' ||
        t === '--adjustment' ||
        t === '-c' ||
        t === '--class' ||
        t === '-p' ||
        t === '--pid'
      ) {
        i += 2;
      } else {
        i++;
      }
    }
  } else if (wrapper === 'taskset') {
    // taskset has two valid CLI shapes:
    //   1. command-launch: taskset [options] <mask> <cmd> [args...]
    //                      taskset -c <cpu-list> <cmd> [args...]
    //   2. pid-mode:       taskset -p [mask] <pid>
    //                      taskset --pid [mask] <pid>
    //                      taskset -pc <cpu-list> <pid>     (combined)
    //                      taskset -pa <pid>                (with --all-tasks)
    //
    // Pid mode operates on an existing process — there is NO wrapped
    // command. Returning the trailing positional (the PID) as a "wrapped
    // command" was a false positive that caused decide() to passthrough
    // instead of allow on `taskset -pc 0 1234` with `Bash(taskset:*)`
    // allowlisted (the bogus `1234` sub-command failed allowlist match).
    //
    // Pid-mode detection: scan the option tokens for any short-flag combo
    // containing 'p' (-p, -pc, -pa, -pca, etc.) or the long form --pid.
    // taskset's recognized short flags are p/c/a/h/V — `-typo`-like noise
    // isn't a realistic input, so a simple includes('p') after the dash
    // is precise enough.
    for (let k = 1; k < tokens.length; k++) {
      const t = tokens[k];
      if (!t.startsWith('-')) break; // first positional reached
      if (t === '--pid') return null;
      // Short-flag combo (single dash, no '=' value): -p, -pc, -pca, -ap, ...
      if (/^-[a-zA-Z]+$/.test(t) && t.includes('p')) return null;
    }

    // Command-launch mode: skip option flags, then the mask/cpu-list positional.
    while (i < tokens.length && tokens[i].startsWith('-')) {
      i++;
    }
    if (i < tokens.length) i++; // mask/cpu-list
  } else if (wrapper === 'flock') {
    // flock has two valid CLI shapes:
    //   1. flock [options] <file>|<fd> <cmd> [args...]    — argv form
    //   2. flock [options] <file>|<fd> -c <shell-string>  — single shell-string
    //
    // Form 2 is hostile to whitespace tokenization: the value of -c is a
    // single shell-quoted argument that spans multiple "tokens" once split
    // on whitespace. Extracting -c via the existing token-walk produced
    // garbage like `-c "curl evil.com"` (quotes leaked, leading -c kept) —
    // the inner curl was never surfaced to the deny-first check, allowing
    // a wrapper-bypass.
    //
    // Fix: do a shell-aware extraction on the ORIGINAL cmd string (not the
    // whitespace-tokenized tokens). Match -c / --command followed by a
    // double-quoted, single-quoted, or bare-word value, and return the
    // INNER content as the wrapped command. The matched value is then run
    // through decomposeCommand's allowlist check independently.
    //
    // The regex below intentionally only handles the three common shell
    // quoting shapes. More exotic forms (dollar-single-quote, concatenated
    // strings, locale-quoted forms) are not supported — we err toward
    // conservative failure (return the post-file-token tail unchanged),
    // which the caller will check against the allowlist as-is. That fails
    // closed: a malformed quoted string is unlikely to match any allowlist
    // entry, so the worst case is passthrough, never silent approval of
    // the wrapped command.
    // Match -c <value>, --command <value>, --command=<value>, or -c=<value>.
    // The `=` form is standard for long options (--command=...) and
    // accepted here for the short form too (-c=...) to keep the wrapper
    // guard consistent against either spelling. The value alternatives
    // are double-quoted, single-quoted, or bare-word.
    const flockShellMatch = cmd.match(
      /(?:^|\s)(?:-c|--command)(?:\s+|=)(?:"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+))/,
    );
    if (flockShellMatch) {
      const inner =
        flockShellMatch[1] !== undefined
          ? flockShellMatch[1]
          : flockShellMatch[2] !== undefined
            ? flockShellMatch[2]
            : flockShellMatch[3];
      return inner.length > 0 ? inner : null;
    }

    // No -c form: walk argv-style. flock [options] <file>|<fd> <cmd> ...
    while (i < tokens.length && tokens[i].startsWith('-')) {
      const t = tokens[i];
      if (
        t === '-w' ||
        t === '--timeout' ||
        t === '-E' ||
        t === '--conflict-exit-code'
      ) {
        i += 2;
      } else {
        i++;
      }
    }
    if (i < tokens.length) i++; // FILE/FD
  } else if (wrapper === 'stdbuf') {
    while (i < tokens.length && tokens[i].startsWith('-')) {
      const t = tokens[i];
      if (t === '-i' || t === '-o' || t === '-e') {
        i += 2;
      } else {
        i++;
      }
    }
  } else if (wrapper === 'exec') {
    // bash builtin exec accepts: exec [-cl] [-a name] [cmd [args...]]
    //   -a NAME   set argv[0] of cmd (value-taking)
    //   -c        clear environment
    //   -l        prepend `-` to argv[0] (login shell)
    // Without this branch exec was falling through to the no-op tail, so
    // `exec -a name git status` returned `-a name git status` as the
    // wrapped command — first word `-a` failed allowlist match → the
    // wrapped git was never surfaced to the deny-first check.
    while (i < tokens.length && tokens[i].startsWith('-')) {
      const t = tokens[i];
      if (t === '-a') {
        i += 2;
        continue;
      }
      // Combined short form ending in `a` (e.g. `-cla`, `-la`) — POSIX
      // getopt convention is the trailing value-taking flag consumes the
      // next argv. Restrict body to known boolean letters c/l/C/L.
      if (/^-[clCL]*a$/.test(t)) {
        i += 2;
        continue;
      }
      // Boolean / boolean-combo: -c, -l, -cl, -lc — single token, skip.
      i++;
    }
  }
  // nohup — no options to skip; next token is the command

  if (i >= tokens.length) return null;
  return tokens.slice(i).join(' ');
}

function decomposeCommand(command) {
  if (!command || !command.trim()) return [];

  const rawParts = splitOnOperators(stripHeredocs(command));
  const result = [];

  for (const part of rawParts) {
    // Extract $() and backtick subshell contents FIRST, unconditionally.
    //
    // Invariant: structural keywords (then/else/elif/do/break/continue) can
    // wrap a $() argument (e.g. `then $(curl ...)`, `break $(curl ...)`).
    // If we filtered on firstWord BEFORE extracting, those keyword-wrapped
    // subshells would silently bypass allow/deny. Running extractSubshells
    // on the raw `part` first guarantees every inner command is checked
    // independently of whether the outer part is later filtered out as
    // structural.
    const subshells = extractSubshells(part);
    for (const sub of subshells) {
      const subParts = splitOnOperators(sub);
      for (const sp of subParts) {
        const norm = normalizeCommand(sp);
        if (
          norm &&
          !STRUCTURAL_KEYWORDS.has(norm) &&
          !STRUCTURAL_KEYWORDS.has(norm.split(/\s+/)[0]) &&
          !COMPOUND_HEADER_RE.test(norm)
        ) {
          if (!isStandaloneAssignment(norm)) {
            result.push(norm);
          }
        }
      }
    }

    // Now decide whether to push the outer part. Structural keywords,
    // compound-statement headers, and standalone assignments are filtered.
    const normalized = normalizeCommand(part);
    if (!normalized) continue;

    const firstWord = normalized.split(/\s+/)[0];
    if (STRUCTURAL_KEYWORDS.has(firstWord)) continue;
    if (STRUCTURAL_KEYWORDS.has(normalized)) continue;
    if (COMPOUND_HEADER_RE.test(firstWord)) continue;
    if (isStandaloneAssignment(normalized)) continue;

    result.push(normalized);

    // Wrapper-bypass guard: if the command is a wrapper invocation
    // (env/timeout/xargs/etc.), also push the wrapped command so the
    // allowlist check covers it independently. Without this, a single
    // `Bash(env *)` allowlist entry would silently approve `env FOO=1
    // <anything>`. See WRAPPER_COMMANDS for the full list.
    const wrapped = extractWrappedCommand(normalized);
    if (wrapped) {
      const wrappedFirst = wrapped.split(/\s+/)[0];
      if (
        wrappedFirst &&
        !STRUCTURAL_KEYWORDS.has(wrappedFirst) &&
        !COMPOUND_HEADER_RE.test(wrappedFirst) &&
        !isStandaloneAssignment(wrapped)
      ) {
        result.push(wrapped);
      }
    }
  }

  return result;
}

/**
 * Extract contents of $() and backtick subshells recursively.
 * Returns array of subshell content strings (inner commands only).
 * Adapted from liberzon/claude-hooks extract_subshells().
 *
 * Uses a state machine for both $() and backtick scanning to correctly handle:
 *   - Single-quoted strings (no escapes inside — ) and ` are literal)
 *   - Double-quoted strings (backslash escapes allowed)
 *   - Backslash escapes outside quotes (skip next char)
 *
 * @param {string} command
 * @returns {string[]}
 */
function extractSubshells(command) {
  const subshells = [];
  let i = 0;

  // Extract $(...) — state machine tracks quotes/escapes, skips $((...)) arithmetic
  while (i < command.length) {
    if (
      command[i] === '$' &&
      i + 1 < command.length &&
      command[i + 1] === '(' &&
      !(i + 2 < command.length && command[i + 2] === '(')
    ) {
      // Found $(  — scan forward to the matching ) using a state machine
      let depth = 1; // we've consumed the opening (
      const start = i + 2;
      let j = i + 2;
      let sqInner = false;
      let dqInner = false;

      while (j < command.length && depth > 0) {
        const c = command[j];

        // Inside single quotes: nothing is special except the closing '
        if (sqInner) {
          if (c === "'") sqInner = false;
          j++;
          continue;
        }

        // Backslash escape (outside single quotes): skip next char
        if (c === '\\') {
          j += 2;
          continue;
        }

        // Double-quote toggle
        if (c === '"') {
          dqInner = !dqInner;
          j++;
          continue;
        }

        // Inside double quotes: only backslash and " are special (parens are literal)
        if (dqInner) {
          j++;
          continue;
        }

        // Single-quote open (outside double quotes)
        if (c === "'") {
          sqInner = true;
          j++;
          continue;
        }

        // Track nested $() depth
        if (c === '(') {
          depth++;
        } else if (c === ')') {
          depth--;
          if (depth === 0) {
            const content = command.slice(start, j);
            subshells.push(content);
            // Recurse for nested subshells
            subshells.push(...extractSubshells(content));
            break;
          }
        }

        j++;
      }
      // Unterminated `$(` (scan reached end-of-input with depth > 0): surface the
      // remaining content so a command hidden in an unbalanced subshell still
      // reaches the deny check. The `depth === 0` break above already pushed the
      // balanced case, so this only fires for malformed input.
      if (depth > 0) {
        const content = command.slice(start);
        if (content.trim()) {
          subshells.push(content);
          subshells.push(...extractSubshells(content));
        }
      }
      i = j + 1;
    } else {
      i++;
    }
  }

  // Extract backtick subshells using state-machine (no nesting in bash)
  // Tracks singleQuote, doubleQuote, and backslash escape to correctly identify
  // unescaped backtick delimiters vs literal/escaped backticks.
  {
    let sq = false;
    let dq = false;
    let btStart = -1; // index after opening backtick, or -1 if not in backtick
    let k = 0;

    while (k < command.length) {
      const c = command[k];

      // Inside single quotes: only closing ' is special
      if (sq) {
        if (c === "'") sq = false;
        k++;
        continue;
      }

      // Backslash escape (outside single quotes): skip next char entirely
      if (c === '\\') {
        k += 2;
        continue;
      }

      // Double-quote toggle
      if (c === '"' && btStart === -1) {
        // Only toggle dq when NOT inside a backtick subshell
        // (inside backtick, we do want to find the closing backtick)
        dq = !dq;
        k++;
        continue;
      }

      // Single-quote open (outside double quotes and outside backtick)
      if (c === "'" && !dq && btStart === -1) {
        sq = true;
        k++;
        continue;
      }

      // Backtick handling: inside single quotes or escaped — already handled above
      if (c === '`') {
        if (dq) {
          // Backtick inside double quotes IS a subshell in bash — extract it
          if (btStart === -1) {
            // Opening backtick inside double quotes
            btStart = k + 1;
          } else {
            // Closing backtick
            const content = command.slice(btStart, k);
            if (content.trim()) {
              subshells.push(content);
              subshells.push(...extractSubshells(content));
            }
            btStart = -1;
          }
        } else if (btStart === -1) {
          // Opening backtick outside quotes
          btStart = k + 1;
        } else {
          // Closing backtick outside quotes
          const content = command.slice(btStart, k);
          if (content.trim()) {
            subshells.push(content);
            subshells.push(...extractSubshells(content));
          }
          btStart = -1;
          dq = false; // reset in case we were inside dq for this backtick
        }
        k++;
        continue;
      }

      k++;
    }

    // Unterminated backtick (loop ended with an open backtick): surface the
    // remaining content so a command hidden in an unbalanced backtick subshell
    // still reaches the deny check.
    if (btStart !== -1) {
      const content = command.slice(btStart);
      if (content.trim()) {
        subshells.push(content);
        subshells.push(...extractSubshells(content));
      }
    }
  }

  return subshells;
}

// ── parseBashPattern ──────────────────────────────────────────────────────────
/**
 * Parse a Bash() permission pattern from settings.json.
 *
 * Pattern formats:
 *   "Bash(git:*)"       -> prefix="git", matches commands starting with "git "
 *   "Bash(npm run:*)"   -> prefix="npm run", matches commands starting with "npm run "
 *   "Bash(git status)"  -> prefix match (matches "git status" and "git status --porcelain")
 *   "Bash(*)"           -> matches everything
 *
 * Returns null if the string is not a Bash() pattern.
 *
 * @param {string} pattern - Raw permission pattern string
 * @returns {{ type: 'prefix', prefix: string } | { type: 'glob', prefix: string, regex: RegExp } | { type: 'any' } | null}
 */
function parseBashPattern(pattern) {
  if (typeof pattern !== 'string') return null;

  // Must start with Bash( and end with )
  if (!pattern.startsWith('Bash(') || !pattern.endsWith(')')) return null;

  const inner = pattern.slice(5, -1); // strip "Bash(" and ")"

  if (inner === '*') {
    return { type: 'any' };
  }

  // Check for colon separator: "cmd:glob"
  const colonIdx = inner.indexOf(':');
  if (colonIdx !== -1) {
    const prefix = inner.slice(0, colonIdx);
    const globPart = inner.slice(colonIdx + 1);

    if (globPart === '*') {
      // Match anything starting with prefix (with or without trailing args)
      return { type: 'prefix', prefix };
    }

    // Convert glob to regex: * -> .*, ? -> ., escape metacharacters
    const regex = globToRegex(prefix + (globPart ? ' ' + globPart : ''));
    return { type: 'glob', prefix, regex };
  }

  // No colon — exact or glob match against full command
  // Fix for Bug 10: patterns ending with " *" (e.g. "echo *", "gh pr *")
  // should match zero-arg case. Treat as prefix match instead of glob.
  if (
    inner.endsWith(' *') &&
    !inner.slice(0, -2).includes('*') &&
    !inner.includes('?')
  ) {
    return { type: 'prefix', prefix: inner.slice(0, -2) };
  }
  // Fall through to regex for non-trailing-star globs (e.g. "*.sh", "test?")
  if (inner.includes('*') || inner.includes('?')) {
    const regex = globToRegex(inner);
    return { type: 'glob', prefix: inner.split(/[*?]/)[0].trim(), regex };
  }

  // Exact prefix match
  return { type: 'prefix', prefix: inner };
}

/**
 * Convert a shell glob pattern to a RegExp.
 * Only * and ? are glob metacharacters; others are escaped.
 *
 * @param {string} glob - Glob pattern string
 * @returns {RegExp}
 */
function globToRegex(glob) {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  const regexStr = '^' + escaped.replace(/\*/g, '.*').replace(/\?/g, '.') + '$';
  return new RegExp(regexStr, 'i');
}

// ── commandMatchesPattern ─────────────────────────────────────────────────────
/**
 * Test whether a normalized command string matches a single permission pattern.
 *
 * @param {string} command - Normalized individual command (e.g. "git status")
 * @param {string} pattern - Raw permission pattern (e.g. "Bash(git:*)")
 * @returns {boolean}
 */
function commandMatchesPattern(command, pattern) {
  const parsed = parseBashPattern(pattern);
  if (!parsed) return false;

  if (parsed.type === 'any') return true;

  if (parsed.type === 'prefix') {
    // Match: command equals prefix OR command starts with "prefix "
    return command === parsed.prefix || command.startsWith(parsed.prefix + ' ');
  }

  if (parsed.type === 'glob') {
    return parsed.regex.test(command);
  }

  return false;
}

// ── loadMergedSettings ────────────────────────────────────────────────────────
/**
 * Read and merge permissions from all 4 settings layers:
 *   Layer 1: $CLAUDE_SETTINGS_PATH || ~/.claude/settings.json
 *   Layer 2: ~/.claude/settings.local.json
 *   Layer 3: $CLAUDE_PROJECT_DIR/.claude/settings.json
 *   Layer 4: $CLAUDE_PROJECT_DIR/.claude/settings.local.json
 *
 * Missing files and JSON parse errors are silently skipped.
 * allow/deny arrays are concatenated and deduplicated across layers.
 *
 * @param {object} [envOverride] - Override env vars (for testing). Defaults to process.env.
 * @returns {{ permissions: { allow: string[], deny: string[] } }}
 */
function loadMergedSettings(envOverride) {
  const env = envOverride || process.env;

  /**
   * @param {string} filePath
   * @returns {object} Parsed JSON or {} on failure
   */
  function loadSettings(filePath) {
    try {
      const content = fs.readFileSync(filePath, 'utf8');
      return JSON.parse(content);
    } catch (_e) {
      return {};
    }
  }

  const homeDir = env.HOME || os.homedir();

  // Layer 1: global settings ($CLAUDE_SETTINGS_PATH or ~/.claude/settings.json)
  const layer1Path =
    env.CLAUDE_SETTINGS_PATH || path.join(homeDir, '.claude', 'settings.json');
  const layer1 = loadSettings(layer1Path);

  // Layer 2: global local settings (~/.claude/settings.local.json)
  const layer2Path = path.join(homeDir, '.claude', 'settings.local.json');
  const layer2 = loadSettings(layer2Path);

  // Layers 3 & 4 require CLAUDE_PROJECT_DIR
  const projectDir = env.CLAUDE_PROJECT_DIR || '';
  const layer3 = projectDir
    ? loadSettings(path.join(projectDir, '.claude', 'settings.json'))
    : {};
  const layer4 = projectDir
    ? loadSettings(path.join(projectDir, '.claude', 'settings.local.json'))
    : {};

  // Merge all layers — concatenate and deduplicate
  function extractArray(obj, key) {
    const perms = obj && obj.permissions;
    const arr = perms && perms[key];
    return Array.isArray(arr) ? arr : [];
  }

  const allAllow = [
    ...extractArray(layer1, 'allow'),
    ...extractArray(layer2, 'allow'),
    ...extractArray(layer3, 'allow'),
    ...extractArray(layer4, 'allow'),
  ];
  const allDeny = [
    ...extractArray(layer1, 'deny'),
    ...extractArray(layer2, 'deny'),
    ...extractArray(layer3, 'deny'),
    ...extractArray(layer4, 'deny'),
  ];

  return {
    permissions: {
      allow: [...new Set(allAllow)],
      deny: [...new Set(allDeny)],
    },
  };
}

// ── decide ────────────────────────────────────────────────────────────────────
/**
 * Make an allow/deny/passthrough decision for a bash command.
 *
 * Algorithm:
 *   1. Decompose command into sub-commands
 *   2. For each sub-command: check deny patterns FIRST (deny-first)
 *   3. If any sub-command matches deny -> return {decision: 'deny', reason}
 *   4. For each sub-command: check allow patterns
 *   5. If ALL sub-commands matched allow -> return {decision: 'allow', reason}
 *   6. If ANY sub-command unmatched -> return {decision: 'passthrough'}
 *
 * @param {string} command - Raw bash command (may be compound)
 * @param {{ permissions: { allow: string[], deny: string[] } }} settings - Merged settings
 * @returns {{ decision: 'allow'|'deny'|'passthrough', reason?: string }}
 */
function decide(command, settings) {
  const allowPatterns =
    (settings && settings.permissions && settings.permissions.allow) || [];
  const denyPatterns =
    (settings && settings.permissions && settings.permissions.deny) || [];

  const subCommands = decomposeCommand(command);

  if (subCommands.length === 0) {
    // Nothing to check (empty or structural-only) — passthrough
    return { decision: 'passthrough' };
  }

  // ── Step 1: Deny-first check ─────────────────────────────────────────────
  for (const sub of subCommands) {
    for (const pattern of denyPatterns) {
      if (commandMatchesPattern(sub, pattern)) {
        return {
          decision: 'deny',
          reason: `Command "${sub}" matches deny pattern "${pattern}"`,
        };
      }
    }
  }

  // ── Step 2: Allow check — ALL sub-commands must match ───────────────────
  const matched = [];
  const unmatched = [];

  for (const sub of subCommands) {
    // Check allow patterns
    let found = false;
    for (const pattern of allowPatterns) {
      if (commandMatchesPattern(sub, pattern)) {
        matched.push({ sub, via: pattern });
        found = true;
        break;
      }
    }

    if (!found) {
      unmatched.push(sub);
    }
  }

  if (unmatched.length === 0 && matched.length > 0) {
    const reasons = matched.map(
      (m) => `"${m.sub}" matches allow pattern "${m.via}"`,
    );
    return {
      decision: 'allow',
      reason: reasons.join('; '),
    };
  }

  return { decision: 'passthrough' };
}

// ── Main hook body ────────────────────────────────────────────────────────────
// Guard execution with require.main === module — allows pure function testing
// without executing stdin reader.

if (require.main === module) {
  // ── Kill switch — exit immediately when disabled (must be inside require.main
  //    so that require()ing this module for testing doesn't exit the process) ──
  if (process.env.GSD_DISABLE_BASH_HOOK === '1') {
    process.exit(0);
  }

  const debug = process.env.GSD_HOOK_DEBUG === '1';

  readStdinWithTimeout((input) => {
    try {
      const data = JSON.parse(input);

      // Only handle Bash tool calls
      if (data.tool_name !== 'Bash') {
        if (debug)
          process.stderr.write('[gsd-bash-hook] non-Bash tool, passthrough\n');
        process.exit(0);
      }

      const command = (data.tool_input && data.tool_input.command) || '';
      if (debug)
        process.stderr.write('[gsd-bash-hook] command: ' + command + '\n');

      const settings = loadMergedSettings();
      const result = decide(command, settings);

      if (debug)
        process.stderr.write(
          '[gsd-bash-hook] decision: ' + result.decision + '\n',
        );

      if (result.decision === 'allow') {
        process.stdout.write(
          JSON.stringify({
            hookSpecificOutput: {
              hookEventName: 'PreToolUse',
              permissionDecision: 'allow',
              permissionDecisionReason:
                result.reason || 'All sub-commands approved',
            },
          }),
        );
        process.exit(0);
      }

      if (result.decision === 'deny') {
        process.stdout.write(
          JSON.stringify({
            hookSpecificOutput: {
              hookEventName: 'PreToolUse',
              permissionDecision: 'deny',
              permissionDecisionReason:
                result.reason || 'Command denied by pattern',
            },
          }),
        );
        process.exit(0);
      }

      // Passthrough — exit 0 silently, Claude Code prompts normally
      process.exit(0);
    } catch (_e) {
      // Graceful degradation — never block tool execution
      if (debug)
        process.stderr.write('[gsd-bash-hook] error: ' + _e.message + '\n');
      process.exit(0);
    }
  });
}

// ── Module exports for testability ───────────────────────────────────────────
module.exports = {
  isInsideQuotes,
  stripHeredocs,
  splitOnOperators,
  normalizeCommand,
  decomposeCommand,
  extractSubshells,
  extractWrappedCommand,
  parseBashPattern,
  commandMatchesPattern,
  loadMergedSettings,
  decide,
  HEREDOC_START_RE,
  WRAPPER_COMMANDS,
  _skipShellValue,
  isStandaloneAssignment,
};
