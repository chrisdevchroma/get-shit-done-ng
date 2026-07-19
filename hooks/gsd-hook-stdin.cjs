'use strict';

/**
 * Read a hook's JSON payload from stdin and pass the raw text to `onInput`.
 *
 * On Windows/Git Bash the inherited pipe can stay open after Claude Code has
 * written the payload, so waiting for 'end' alone hangs the hook until Claude
 * Code kills it and reports a hook error. An unclosed stdin therefore exits 0.
 */
function readStdinWithTimeout(onInput, timeoutMs = 3000) {
  let input = '';
  const stdinTimeout = setTimeout(() => process.exit(0), timeoutMs);
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => {
    input += chunk;
  });
  process.stdin.on('end', () => {
    clearTimeout(stdinTimeout);
    onInput(input);
  });
}

module.exports = { readStdinWithTimeout };
