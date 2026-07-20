'use strict';

/**
 * Read a hook's JSON payload from stdin and pass the raw text to `onInput`.
 *
 * On Windows/Git Bash the inherited pipe can stay open after Claude Code has
 * written the payload, so waiting for 'end' alone hangs the hook until Claude
 * Code kills it and reports a hook error.
 *
 * What an unread payload should mean is the caller's decision, not this
 * module's: an advisory hook must fail open (the default silent exit 0), while
 * a hook whose silence grants permission must supply an `onTimeout` that fails
 * closed.
 *
 * @param {(input: string) => void} onInput
 * @param {{ timeoutMs?: number, onTimeout?: () => void }} [options]
 */
function readStdinWithTimeout(onInput, options = {}) {
  const envTimeout = Number(process.env.GSD_HOOK_STDIN_TIMEOUT_MS);
  const timeoutMs =
    Number.isFinite(envTimeout) && envTimeout > 0
      ? envTimeout
      : typeof options.timeoutMs === 'number'
        ? options.timeoutMs
        : 3000;
  const onTimeout =
    typeof options.onTimeout === 'function'
      ? options.onTimeout
      : () => process.exit(0);

  let input = '';
  const stdinTimeout = setTimeout(onTimeout, timeoutMs);
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
