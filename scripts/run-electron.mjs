// Runs a command with ELECTRON_RUN_AS_NODE stripped from the environment, and optionally against a
// separate user profile.
//
// That variable turns the Electron binary into a plain node, and editors, task runners and test
// harnesses set it for their own child processes — where it is then inherited by anything you
// launch from an integrated terminal. The symptom is a long way from the cause: `require('electron')`
// resolves to a path string instead of the API, so the first call into it dies with
// "Cannot read properties of undefined (reading 'setName')" and no hint as to why.
//
// `env -u` says this in one word, but only on POSIX, and the npm scripts have to run on Windows too.
// The same goes for `VAR=x cmd`, which is why `--profile` is a flag here rather than inline in the
// npm script.
//
// The e2e harness strips the same variable when it spawns the app; it does so separately because it
// builds an env object for electron.launch rather than inheriting one.

import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

const argv = process.argv.slice(2);

/**
 * `--profile <name>` runs against `<app data>/<name>` instead of the real user profile.
 *
 * Once the packaged app is installed and running all day, a dev instance shares its `userData` —
 * the config *and* every session partition — so an experiment can sign you out of things or reorder
 * a rail you were using. Plain `npm run dev` keeps the real profile on purpose: testing unread
 * detection needs real logins, and a fresh profile has none.
 */
const profileAt = argv.indexOf('--profile');
let profile = null;
if (profileAt !== -1) {
  profile = argv[profileAt + 1];
  if (!profile) {
    console.error('--profile needs a name');
    process.exit(64);
  }
  argv.splice(profileAt, 2);
}

const [command, ...args] = argv;

if (!command) {
  console.error('usage: node scripts/run-electron.mjs [--profile <name>] <command> [args...]');
  process.exit(64);
}

const { ELECTRON_RUN_AS_NODE: _asNode, ...env } = process.env;

/** Where Electron would put `userData`, so a dev profile lands beside the real one. */
function appDataDir() {
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support');
  if (process.platform === 'win32') return process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming');
  return process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config');
}

if (profile) {
  env.HANGAR_USER_DATA = path.join(appDataDir(), profile);
  console.log(`profile: ${env.HANGAR_USER_DATA}`);
}

// The bin shims in node_modules/.bin are .cmd files on Windows, which spawn can only resolve
// through a shell.
const child = spawn(command, args, {
  stdio: 'inherit',
  env,
  shell: process.platform === 'win32',
});

child.on('error', (err) => {
  console.error(`failed to start ${command}: ${err.message}`);
  process.exit(1);
});

// Signals reach the child directly via the process group, so this only has to mirror how it ended.
child.on('exit', (code, signal) => {
  process.exit(signal ? 1 : (code ?? 0));
});
