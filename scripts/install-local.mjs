// Builds Hangar from source and installs it into /Applications, replacing whatever copy is there.
//
// Run: npm run install:local
//
// Why this is a script rather than "npm run dist, open the DMG, drag it across":
//
// - **The running copy is usually the launchd job.** With launch at login and relaunch-on-crash on,
//   killing it is an unsuccessful exit, and launchd starts it again 30 seconds later — possibly
//   from a half-copied bundle. It has to be *asked* to quit, which exits 0, and `Hangar --quit`
//   is how (boot/index.ts). Older builds don't know that flag, so AppleScript is the fallback.
// - **Signing decides what works.** `npm run dist` skips signing entirely, and macOS does not
//   deliver notifications to an unsigned bundle. This signs with a local certificate if you made
//   one (`npm run cert:local`), and ad-hoc otherwise — see docs/packaging.md for the difference.
// - **One architecture, no DMG.** `dist` builds DMGs for both chips, ~240 MB, for a copy that is
//   then dragged out of one of them. This builds the unpacked .app for this Mac only.
//
// macOS only. Needs no sudo when your account can write to /Applications, which admin accounts can.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const LABEL = 'com.hangar.desktop';
const BUNDLE_ID = 'com.hangar.desktop';
const INSTALLED = '/Applications/Hangar.app';
const INSTALLED_EXE = path.join(INSTALLED, 'Contents', 'MacOS', 'Hangar');
const LOCAL_IDENTITY = 'Hangar Local';
const PLIST = path.join(os.homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);
const LOG = path.join(os.homedir(), 'Library', 'Logs', 'Hangar', 'hangar.log');
const GUI = `gui/${process.getuid?.() ?? 501}`;

if (process.platform !== 'darwin') {
  console.error('install:local builds and installs a macOS app, and this is not macOS.');
  process.exit(1);
}

// Same reason as scripts/run-electron.mjs: inherited from an editor, it turns every Electron we
// spawn — the icon renderer, `Hangar --quit` — into a plain node that does nothing useful.
const { ELECTRON_RUN_AS_NODE: _asNode, ...env } = process.env;

const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
// electron-builder's `dir` target names the x64 folder plain `mac`.
const built = path.resolve('dist', arch === 'arm64' ? 'mac-arm64' : 'mac', 'Hangar.app');

// --- helpers --------------------------------------------------------------------------------------

function step(message) {
  console.log(`\n\x1b[1m▸ ${message}\x1b[0m`);
}

/** Runs a command with output shown. Exits the script if it fails, unless `allowFailure`. */
function run(command, args, { allowFailure = false, quiet = false, timeout } = {}) {
  const result = spawnSync(command, args, { stdio: quiet ? 'pipe' : 'inherit', env, timeout });
  if (result.status !== 0 && !allowFailure) {
    console.error(`\n✗ ${command} ${args.join(' ')} failed (${result.status ?? result.signal ?? result.error})`);
    process.exit(1);
  }
  return result;
}

/** Output of a command, or '' if it failed. */
const capture = (command, args) =>
  spawnSync(command, args, { encoding: 'utf8', env }).stdout?.toString() ?? '';

/** The main Hangar process. Exact name, so helpers and a dev instance (named Electron) don't match. */
const hangarRunning = () => spawnSync('pgrep', ['-x', 'Hangar']).status === 0;

const jobLoaded = () => spawnSync('launchctl', ['print', `${GUI}/${LABEL}`], { stdio: 'ignore' }).status === 0;

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Polls until `done()` or the timeout. Returns whether it got there. */
function waitFor(done, timeoutMs) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (done()) return true;
    sleep(250);
  }
  return done();
}

// --- 1. build -------------------------------------------------------------------------------------

step('Building the app bundles');
run('npm', ['run', 'build']);
run('npm', ['run', 'icon']);

// --- 2. pick a signing identity -------------------------------------------------------------------

const identities = capture('security', ['find-identity', '-v', '-p', 'codesigning']);
const identity = identities.includes(`"${LOCAL_IDENTITY}"`) ? LOCAL_IDENTITY : '-';

step(`Packaging Hangar.app for ${arch}, signed ${identity === '-' ? 'ad-hoc' : `as "${identity}"`}`);
if (identity === '-') {
  console.log(
    '  Ad-hoc signing is enough for notifications, but its identity changes every build, so macOS\n' +
      '  will ask again for camera and microphone after each install. `npm run cert:local` once\n' +
      '  makes it stable.'
  );
}
// hardenedRuntime off: it only matters for notarisation, and with anything but a Developer ID it
// can stop the app launching at all (library validation). timestamp=none: timestamping calls
// Apple's server, which a local build has no need of and an offline one can't reach.
//
// electronDist: the Electron that `install-electron` already put in node_modules, which is this
// Mac's architecture by construction. Without it electron-builder takes its own copy from the
// download cache and then re-fetches SHASUMS256.txt from GitHub to verify it — so with no network,
// or with GitHub unreachable, a build that needs nothing new failed on a timeout.
const electronDist = path.resolve('node_modules', 'electron', 'dist');
if (!fs.existsSync(path.join(electronDist, 'Electron.app'))) {
  console.error('\n✗ node_modules/electron has no binary. Run `npx install-electron`, then this again.');
  process.exit(1);
}
run('npx', [
  'electron-builder',
  '--mac',
  'dir',
  `--${arch}`,
  `-c.electronDist=${electronDist}`,
  `-c.mac.identity=${identity}`,
  '-c.mac.hardenedRuntime=false',
  '-c.mac.timestamp=none',
]);

step('Verifying the signature');
run('codesign', ['--verify', '--deep', '--strict', '--verbose=1', built]);

// --- 3. quit the running copy ---------------------------------------------------------------------

let bootedOut = false;

if (hangarRunning()) {
  step('Quitting the running Hangar');

  // a. Builds from this change on: a silent, graceful quit with no confirm dialog.
  if (fs.existsSync(INSTALLED_EXE)) {
    run(INSTALLED_EXE, ['--quit'], { allowFailure: true, quiet: true, timeout: 15_000 });
    waitFor(() => !hangarRunning(), 15_000);
  }

  // b. Older builds don't know `--quit` (it just shows their window). AppleScript's quit is still
  //    graceful — exit 0, cookies promoted — but goes through "Confirm before quitting".
  if (hangarRunning()) {
    console.log('  Asking it to quit. If it asks "Quit Hangar?", click Quit.');
    run('osascript', ['-e', `tell application id "${BUNDLE_ID}" to quit`], {
      allowFailure: true,
      quiet: true,
      timeout: 60_000,
    });
    waitFor(() => !hangarRunning(), 30_000);
  }

  // c. Still there: take the job away from launchd first, so it isn't restarted, then stop it.
  //    Cookies promoted in the last minute may be lost; everything older already was.
  if (hangarRunning()) {
    console.log('  It did not quit. Stopping it.');
    if (jobLoaded()) {
      run('launchctl', ['bootout', `${GUI}/${LABEL}`], { allowFailure: true, quiet: true });
      bootedOut = true;
    }
    run('pkill', ['-TERM', '-x', 'Hangar'], { allowFailure: true, quiet: true });
    if (!waitFor(() => !hangarRunning(), 10_000)) {
      run('pkill', ['-KILL', '-x', 'Hangar'], { allowFailure: true, quiet: true });
      waitFor(() => !hangarRunning(), 5_000);
    }
  }

  if (hangarRunning()) {
    console.error('\n✗ Hangar is still running, so it cannot be replaced. Quit it and run this again.');
    process.exit(1);
  }
  console.log('  Quit.');
}

// --- 4. swap the bundle ---------------------------------------------------------------------------

step(`Installing into ${INSTALLED}`);
const staging = `${INSTALLED}.new`;
const aside = `${INSTALLED}.old`;
fs.rmSync(staging, { recursive: true, force: true });
fs.rmSync(aside, { recursive: true, force: true });
// `ditto`, not a JS copy: it keeps the bundle's symlinks, permissions and extended attributes, and
// a signed bundle that loses any of them no longer verifies.
run('ditto', [built, staging]);
// Staged then renamed, so there is never a moment with a half-copied app at the real path.
if (fs.existsSync(INSTALLED)) fs.renameSync(INSTALLED, aside);
fs.renameSync(staging, INSTALLED);
fs.rmSync(aside, { recursive: true, force: true });
// A local build is never quarantined, but a stale attribute from a DMG-installed copy would be.
run('xattr', ['-dr', 'com.apple.quarantine', INSTALLED], { allowFailure: true, quiet: true });
run('codesign', ['--verify', '--deep', '--strict', INSTALLED]);

// --- 5. start it again ----------------------------------------------------------------------------

step('Starting Hangar');
const plistProgram = fs.existsSync(PLIST)
  ? /<key>ProgramArguments<\/key>\s*<array>\s*<string>([^<]+)<\/string>/.exec(fs.readFileSync(PLIST, 'utf8'))?.[1]
  : undefined;
const plistIsOurs = plistProgram === INSTALLED_EXE;

if (plistProgram && !plistIsOurs) {
  console.log(`  The login item points at ${plistProgram}, not ${INSTALLED_EXE}.`);
  console.log('  Opening normally; the app rewrites the login item on launch.');
}

// Under launchd when there is a job for this copy, so "relaunch if it stops" applies from now
// rather than from the next login.
if (plistIsOurs && (bootedOut || !jobLoaded())) {
  run('launchctl', ['bootstrap', GUI, PLIST], { allowFailure: true });
} else if (plistIsOurs) {
  run('launchctl', ['kickstart', `${GUI}/${LABEL}`], { allowFailure: true });
}
if (!waitFor(hangarRunning, 5_000)) run('open', [INSTALLED]);

if (!waitFor(hangarRunning, 20_000)) {
  console.error(`\n✗ Installed, but Hangar did not start. Check ${LOG}`);
  process.exit(1);
}

// --- 6. report ------------------------------------------------------------------------------------

// `codesign -d` reports on stderr.
const signature = spawnSync('codesign', ['-dv', INSTALLED], { encoding: 'utf8' }).stderr ?? '';
const signedAs = /Authority=([^\n]+)/.exec(signature)?.[1] ?? (/Signature=adhoc/.test(signature) ? 'ad-hoc' : 'unknown');
const version = capture('defaults', ['read', path.join(INSTALLED, 'Contents', 'Info'), 'CFBundleShortVersionString']).trim();

console.log(`\n\x1b[32m✓ Hangar ${version} installed and running\x1b[0m`);
console.log(`  Signed:      ${signedAs}`);
console.log(`  Login item:  ${plistProgram ? (plistIsOurs ? 'this copy' : plistProgram) : 'off'}`);
console.log(`  launchd job: ${jobLoaded() ? 'loaded' : 'not loaded'}`);
console.log(`  Log:         ${LOG}`);
