import { spawn } from 'node:child_process';
import os from 'node:os';
import { CliError } from './errors.js';

/**
 * Quote one argument for a POSIX shell. The whole value is wrapped in single
 * quotes; embedded single quotes are closed, escaped, and reopened.
 *
 * @param {string} value
 */
export function shQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

/**
 * Build the string passed to ssh. With shellMode "login", the command runs via
 * the remote user's login shell so PATH additions from nvm, pyenv, etc. apply.
 * With "plain", the command is handed straight to the remote shell.
 *
 * @param {string} remoteDir
 * @param {string[]} argv
 * @param {'login' | 'plain'} shellMode
 */
export function buildRemoteCommand(remoteDir, argv, shellMode) {
  const inner = `cd ${shQuote(remoteDir)} && ${argv.map(shQuote).join(' ')}`;
  if (shellMode === 'plain') {
    return inner;
  }
  return `exec "\${SHELL:-/bin/sh}" -lc ${shQuote(inner)}`;
}

/**
 * Convert a terminating signal name to the conventional shell exit status.
 *
 * @param {NodeJS.Signals | null} signal
 */
function signalExitCode(signal) {
  const number = signal ? os.constants.signals[signal] : undefined;
  return number ? 128 + number : 1;
}

/**
 * Run `ssh` with the terminal (or pipes) inherited from this process, so
 * colors, interactive programs, stdin, stdout, and stderr all behave exactly
 * like a direct ssh invocation.
 *
 * @param {{ sshAlias: string, shellMode: 'login' | 'plain' }} project
 * @param {string} remoteDir
 * @param {string[]} argv
 * @returns {Promise<number>} the remote command's exit code
 */
export function runRemoteCommand(project, remoteDir, argv) {
  const tty = Boolean(process.stdin.isTTY);
  const remoteCommand = buildRemoteCommand(remoteDir, argv, project.shellMode);
  const args = [
    tty ? '-tt' : '-T',
    '-o',
    'ConnectTimeout=15',
    project.sshAlias,
    remoteCommand,
  ];

  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn('ssh', args, { stdio: 'inherit' });
    } catch (err) {
      reject(new CliError(`cannot start ssh: ${err.message}`));
      return;
    }

    let settled = false;

    const onSigint = () => {
      // With a TTY, Ctrl+C is a character sent to the remote; ignore the local
      // signal so Node does not exit before ssh does.
      if (!tty) {
        child.kill('SIGINT');
      }
    };
    const onSigterm = () => {
      child.kill('SIGTERM');
    };
    const cleanup = () => {
      process.off('SIGINT', onSigint);
      process.off('SIGTERM', onSigterm);
    };

    process.on('SIGINT', onSigint);
    process.on('SIGTERM', onSigterm);

    child.on('error', (err) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(new CliError(`cannot start ssh: ${err.message}`, 70, {
        hint: 'Check that the OpenSSH client is installed and on PATH.',
      }));
    });

    child.on('exit', (code, signal) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve(code ?? signalExitCode(signal));
    });
  });
}
