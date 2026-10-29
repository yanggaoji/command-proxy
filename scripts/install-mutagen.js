#!/usr/bin/env node
import { installMutagen } from '../src/mutagen-install.js';

if (process.env.COMMAND_PROXY_SKIP_MUTAGEN_DOWNLOAD) {
  process.stderr.write(
    'command-proxy: skipping the Mutagen download (COMMAND_PROXY_SKIP_MUTAGEN_DOWNLOAD is set)\n',
  );
} else {
  try {
    await installMutagen({
      force: Boolean(process.env.COMMAND_PROXY_FORCE_MUTAGEN_DOWNLOAD),
    });
  } catch (err) {
    process.stderr.write(
      `command-proxy: warning: could not install Mutagen automatically: ${err.message}\n`,
    );
    process.stderr.write(
      'command-proxy: install Mutagen 0.15 or newer and put it on PATH, or rerun `npm rebuild command-proxy` (add -g for a global install).\n',
    );
    if (process.env.COMMAND_PROXY_DEBUG) {
      console.error(err.stack);
    }
  }
}
