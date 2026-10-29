import { UsageError } from './errors.js';

const ACTIONS = new Map([
  ['--init', 'init'],
  ['--status', 'status'],
  ['--ignore', 'ignore'],
  ['--sync', 'sync'],
  ['--reset', 'reset'],
  ['--help', 'help'],
  ['-h', 'help'],
  ['--version', 'version'],
  ['-v', 'version'],
]);

/**
 * Parse only the options before the command. Everything after the first
 * non-option argument (or after `--`) is passed to the remote command
 * untouched, so `command-proxy git clone --depth 1 url` works.
 *
 * @param {string[]} argv
 * @returns {{ action: string, command: string[], noSync: boolean }}
 */
export function parseArgv(argv) {
  let action = null;
  let actionArg = null;
  let noSync = false;
  let index = 0;

  while (index < argv.length) {
    const arg = argv[index];

    if (arg === '--') {
      index += 1;
      break;
    }
    if (!arg.startsWith('-') || arg === '-') {
      break;
    }
    if (arg === '--no-sync') {
      if (noSync) {
        throw new UsageError('--no-sync specified more than once');
      }
      noSync = true;
      index += 1;
      continue;
    }

    const next = ACTIONS.get(arg);
    if (!next) {
      throw new UsageError(`unknown option: ${arg}`);
    }
    if (action) {
      throw new UsageError(`cannot combine ${actionArg} and ${arg}`);
    }
    action = next;
    actionArg = arg;
    index += 1;
  }

  const command = argv.slice(index);

  if (action && command.length > 0) {
    throw new UsageError(`${actionArg} does not take a command`);
  }
  if (noSync && action) {
    throw new UsageError('--no-sync only applies when running a command');
  }
  if (noSync && command.length === 0) {
    throw new UsageError('--no-sync requires a command');
  }
  if (!action && command.length === 0) {
    action = 'help';
  }

  return { action: action ?? 'run', command, noSync };
}
