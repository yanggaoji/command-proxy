# command-proxy

Run a command in your current directory on a remote server. The directory is
kept in sync in both directions by [Mutagen](https://mutagen.io/), while the
command itself runs over your normal system `ssh` connection.

```sh
cd ~/work/demo
command-proxy npm test        # runs on the remote server, output shown locally
command-proxy git clone ...   # files created remotely appear locally afterwards
```

The first run asks a few questions. Every later run just syncs, executes, and
syncs back.

## How it works

- **Mutagen** maintains a continuous two-way-safe synchronization session
  between the project directory and a directory on the remote host.
- **System `ssh`** executes the command, with stdin, stdout, stderr, TTY
  programs, colors, Ctrl+C, and exit codes passed through as if you had run
  ssh yourself.
- **command-proxy** handles the first-run wizard, configuration, ignore rules,
  conflict warnings, and the flush before and after each command.

Because synchronization is continuous and not a one-shot copy, files created
remotely are normally available locally before the command even exits. An
explicit flush before and after the command makes that reliable.

## Requirements

- Node.js 20.12 or newer.
- An OpenSSH client on `PATH`.
- [Mutagen](https://github.com/mutagen-io/mutagen/releases) 0.15 or newer.
  `npm install` downloads it automatically when it is not already on `PATH`
  (see [Mutagen installation](#mutagen-installation)).
- SSH **key-based** login to the remote host. Passphrase-protected keys must be
  loaded into an agent; the connection probe runs in batch mode and cannot type
  a password.
- A Linux or macOS remote host with a POSIX shell, and a writable remote
  directory.

Local platforms: macOS, Linux, and Windows. Remote Windows hosts are not
supported.

Install with:

```sh
npm install -g command-proxy
```

### Mutagen installation

The npm `postinstall` script downloads the Mutagen release for the current
platform and architecture when `mutagen` is not already on `PATH`. It verifies
the release against Mutagen's `SHA256SUMS` file and stores the executable and
its `mutagen-agents.tar.gz` bundle under the package's `vendor/mutagen/`
directory. command-proxy prefers that copy over `PATH`, so a stale system
Mutagen does not get in the way.

The download is roughly 100 MB. It is skipped when Mutagen 0.15 or newer is
already on `PATH`. If the download fails (for example, while offline), the npm
installation still succeeds and command-proxy reports the problem when it is
run. Retry the download with:

```sh
npm rebuild command-proxy
```

For a global installation, use `npm rebuild -g command-proxy`. `npm install
--ignore-scripts` also skips the download. Set
`COMMAND_PROXY_SKIP_MUTAGEN_DOWNLOAD=1` to skip it deliberately, or
`COMMAND_PROXY_FORCE_MUTAGEN_DOWNLOAD=1` to replace the bundled copy. The
version is pinned by command-proxy and updated with its releases.

## Quick start

```sh
cd ~/work/demo
command-proxy npm test
```

On the first run the wizard:

1. Checks that `ssh` and Mutagen are available.
2. Asks for either an alias from `~/.ssh/config` or a `user@host[:port]`.
   - An existing alias is used as-is.
   - For `user@host`, it asks for the port and an optional private key file,
     shows the `~/.ssh/config` block it wants to add, and only writes it after
     you confirm. The previous file is saved as `~/.ssh/config.bak`, and only
     the marked block is ever changed.
3. Tests the connection, including the host key, and retries on failure.
4. Asks where the remote copy should live. The default is
   `~/.command-proxy/<directory>-<id>`. If the directory already has files, it
   warns that the two directories will be merged.
5. Chooses a remote shell mode: `login` (default) or `plain`.
6. Scans the local directory after ignore rules. If it contains more than
   50,000 files or 1 GB, it asks for confirmation.
7. Creates the Mutagen session and performs the initial sync.

Configuration is global, so nothing (except the optional
`.command-proxyignore`) is added to your project.

## Usage

```text
command-proxy [options] <command> [args...]
command-proxy --sync | --status | --init | --ignore | --reset
```

Options are recognized **only before the command**. Everything after the first
non-option argument is passed to the remote command unchanged, so this works:

```sh
command-proxy git clone --depth 1 https://example.com/repo.git
command-proxy npm test -- --watch
```

Use `--` if the command itself starts with a dash:

```sh
command-proxy -- ./some-script --flag
```

| Option | Meaning |
| --- | --- |
| `--init` | Reconfigure the current project's connection and remote directory. |
| `--status` | Show the sync state, conflict count, and conflict paths. |
| `--sync` | Create or resume the session and flush now, without running a command. |
| `--ignore` | Open the global ignore file in `$VISUAL` or `$EDITOR`. |
| `--no-sync` | Run the command without the flush before or after it. |
| `--reset` | Terminate the session and remove this project's configuration. No files are deleted. |
| `-h`, `--help` | Show help. |
| `-v`, `--version` | Show the version. |

Examples:

```sh
# A pipeline or redirection must be quoted so the remote shell runs it.
command-proxy sh -c 'grep -r TODO . | head -20'

# Run against the already-synced remote files without touching the session.
command-proxy --no-sync git status

# Interactive programs work because ssh gets a TTY.
command-proxy python
command-proxy vim

# Run from a subdirectory; the remote working directory matches it.
cd src/app && command-proxy pwd
# -> /home/dev/.command-proxy/demo-ab12cd/src/app
```

The remote command runs through the login shell (`${SHELL:-/bin/sh} -lc`) by
default, so `PATH` changes from nvm, pyenv, etc. apply. If the login shell is
csh or otherwise incompatible, choose `plain` during setup; the inner command
is then handed straight to the remote shell.

## Ignore rules

Ignore rules apply to uploads and downloads alike. They are merged in this
order:

1. Built-in defaults: `node_modules`, `.DS_Store`, `Thumbs.db`, `__pycache__`,
   `*.pyc`, `.venv`, `.cache`.
2. The global file in the command-proxy config directory, editable with
   `command-proxy --ignore`.
3. An optional `.command-proxyignore` in the project root, suitable for
   committing and sharing with a team.

The syntax follows `.gitignore`: `*`, `?`, `**`, character classes, a leading
`/` to anchor a pattern, a trailing `/` for directories only, and `!` to
re-include a path. Ignore matching in the pre-sync scan is an approximation of
Mutagen's own matcher; Mutagen remains the source of truth.

`.git` is intentionally **not** ignored, so repositories cloned remotely work
locally. Add `.git` to the ignore list yourself if a large repository makes the
initial sync too slow.

Changing any ignore rule changes the ignore hash stored in the config. The next
run terminates and recreates the Mutagen session automatically; already synced
files stay in place.

## Conflicts

The session uses Mutagen's `two-way-safe` mode. If the same file changed on
both sides, Mutagen does not overwrite either version. command-proxy prints a
warning on stderr and continues; the remote command's exit code is not changed.

```sh
command-proxy --status
```

shows the session state and the conflicting paths. Resolve the file on either
side, then run `command-proxy --sync` (or any command) again. Synchronization
continues in the background between command-proxy runs.

## Configuration

The global directory is:

| Platform | Location |
| --- | --- |
| macOS / Linux | `$XDG_CONFIG_HOME/command-proxy/`, or `~/.config/command-proxy/` |
| Windows | `%APPDATA%\command-proxy\` |

It contains:

```text
config.json    project connection settings and the ignore hash
ignore         global ignore rules
locks/         short-lived locks used while creating sessions
```

`config.json` maps the real path of each project root to its settings:

```json
{
  "projects": {
    "/Users/a/proj": {
      "id": "ab12cd",
      "sshAlias": "cp-proj-ab12cd",
      "remoteRoot": "/home/dev/.command-proxy/proj-ab12cd",
      "shellMode": "login",
      "ignoreHash": "..."
    }
  }
}
```

Project roots are found by walking up from the current directory, like git.
Running from a subdirectory maps the relative path onto the same place under
the remote root. Registering a home directory, filesystem root, or system
directory as a project root is refused.

When you enter `user@host`, command-proxy appends a block like this to
`~/.ssh/config`:

```sshconfig
# >>> command-proxy:ab12cd >>>
Host cp-proj-ab12cd
  HostName 203.0.113.10
  User dev
  Port 22
  IdentityFile ~/.ssh/id_ed25519
  ServerAliveInterval 30
  ControlMaster auto
  ControlPath ~/.ssh/cm-%C
  ControlPersist 10m
# <<< command-proxy:ab12cd <<<
```

`ControlMaster` and related options are omitted on Windows. The block is
removed only by `--reset`, and only when the start and end markers are both
intact. An incomplete marked block is reported, not guessed at or rewritten.

`--reset` also terminates the Mutagen session and deletes the project's entry
from `config.json`. It never deletes local or remote files, and it does not
remove the remote directory.

## Output and exit codes

command-proxy's own progress, warnings, and errors go to **stderr**. Stdout is
reserved for the remote command (except `--status`, which intentionally prints
to stdout). Progress lines appear only when stderr is a terminal, so redirected
output stays clean.

| Exit code | Meaning |
| --- | --- |
| remote command's code | Passed through unchanged. |
| `2` | Usage error in command-proxy arguments. |
| `70` | command-proxy could not set up or run the command (missing tools, configuration, Mutagen failure, connection probe failure, etc.). |
| `255` | ssh connection error, passed through; an explanatory note is also written to stderr. |

A sync conflict, a failed flush, or a flush timeout is reported as a warning but
does **not** change the exit code. A flush waits up to 60 seconds by default;
after that, synchronization continues in the background.

## Common problems

**`ssh` was not found on PATH.** Install the OpenSSH client and make sure the
directory containing it is on `PATH`. On Windows, the OpenSSH client is an
optional feature.

**Mutagen is not usable.** `npm install` normally downloads it automatically.
If the install used `--ignore-scripts`, ran offline, or printed a download
warning, run `npm rebuild command-proxy` (or `npm rebuild -g command-proxy` for
a global install) to retry, or install Mutagen 0.15 or newer yourself and put
it on `PATH`.

**`Permission denied (publickey)`.** Set up key-based login (for example with
`ssh-copy-id`) and check the user, port, and identity file. A passphrase-protected
key must be loaded into `ssh-agent`; the probe cannot prompt for a passphrase.

**`Host key verification failed`.** Run `ssh <alias-or-host>` once in a
terminal and accept the host key, then retry command-proxy.

**First-time setup requires an interactive terminal.** The wizard needs a TTY.
Run `command-proxy --init` in a terminal first, then commands can run from
scripts or CI.

**The session is halted.** Run `command-proxy --status` to see the reason.
`halted-on-root-deletion` is recovered automatically when the remote root is
missing and the local root still exists. Other halted states are not rebuilt
automatically, because doing so could discard data. If the session cannot be
recovered, run `command-proxy --reset` and configure the project again.

**A remote command created `node_modules`, but it is not local.** That is
expected: `node_modules` is in the built-in ignore list and is not downloaded.

**`--status` says the session is not created yet.** Run `command-proxy --sync`
to create it, or run any command.

**Remote files did not change.** Check `command-proxy --status` for conflicts
and errors. `--no-sync` deliberately skips both flushes.

**Debugging.** Set `COMMAND_PROXY_DEBUG=1` to print a stack trace for
command-proxy errors.

## Limitations

- Remote hosts must run Linux or macOS; Windows remotes are not supported.
- One remote host per local project; no multi-host fan-out.
- No port forwarding and no disconnect protection for long-running remote
  tasks. If ssh drops, the remote process may be terminated by the server.
- Mutagen's default handling of symbolic links, executable bits, and file
  metadata applies. Case-only differences between a case-insensitive local
  filesystem and a case-sensitive remote filesystem are reported as conflicts
  rather than merged.
- The whole project root is synchronized except ignore rules. Register large
  or unsuitable directories only after confirming the pre-sync size warning.
- The remote directory must be writable, and its parent chain must be
  creatable by the SSH user.
- The Mutagen session is persistent by design; `--reset` is the supported way
  to stop and remove it.

## Development

```sh
npm install
npm test
```

`npm install` downloads Mutagen (roughly 100 MB) unless a current `mutagen` is
already on `PATH`.

Unit tests use the built-in `node:test` runner and do not need a remote host.
The end-to-end test is opt-in and requires a real SSH alias plus Mutagen:

```sh
COMMAND_PROXY_TEST_SSH_ALIAS=myserver npm test
```

It creates temporary local and remote directories and an isolated command-proxy
configuration, exercises command execution, stdin, exit codes, back-sync,
ignored files, subdirectories, `--status`, `--sync`, and `--reset`, then removes
them. Your normal command-proxy configuration is not touched; your real SSH
configuration and keys are used read-only.

Mutagen's command-line flags have changed between releases. This implementation
targets Mutagen 0.15+ and falls back from `--sync-mode` to `--mode` where
needed; the opt-in test above is the quickest way to verify the Mutagen version
you have installed.

## License

MIT
