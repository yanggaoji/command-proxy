/**
 * An error caused by command-proxy itself (as opposed to the remote command).
 * The exit code defaults to 70, matching the plan's "command never ran" rule.
 */
export class CliError extends Error {
  /**
   * @param {string} message
   * @param {number} [exitCode]
   * @param {{ hint?: string }} [options]
   */
  constructor(message, exitCode = 70, options = {}) {
    super(message);
    this.name = 'CliError';
    this.exitCode = exitCode;
    this.hint = options.hint;
  }
}

/** Invalid command-line usage. Exits with 2. */
export class UsageError extends CliError {
  /**
   * @param {string} message
   * @param {{ hint?: string }} [options]
   */
  constructor(message, options = {}) {
    super(message, 2, options);
    this.name = 'UsageError';
  }
}

/** The user cancelled an interactive prompt. Exits with 1 without a message. */
export class CancelledError extends Error {
  constructor() {
    super('Cancelled');
    this.name = 'CancelledError';
  }
}
