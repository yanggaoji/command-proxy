/**
 * command-proxy's own messages always go to stderr, keeping stdout clean for
 * the remote command's output. Progress messages are only shown when stderr is
 * a terminal; warnings and errors are always shown.
 */

/** Progress information, only on an interactive terminal. */
export function progress(message) {
  if (process.stderr.isTTY) {
    process.stderr.write(`command-proxy: ${message}\n`);
  }
}

/** A warning. Does not change the command's exit code. */
export function warn(message) {
  process.stderr.write(`command-proxy: warning: ${message}\n`);
}

/** A fatal command-proxy error. */
export function error(message) {
  process.stderr.write(`command-proxy: ${message}\n`);
}
