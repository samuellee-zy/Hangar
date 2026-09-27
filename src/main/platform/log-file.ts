import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { format } from 'node:util';
import { app } from 'electron';
import { redactUrlsIn } from '@core/runtime/urls';

/**
 * The log file: where it is, keeping it a sane size, and making sure every packaged launch writes to
 * it.
 *
 * It is the LaunchAgent's `StandardOutPath`, so a copy launchd started has its stdout and stderr in
 * it already — Chromium's native lines included. A copy opened from Finder or the Dock has no such
 * redirection and logged nowhere at all, which is exactly the copy people report problems with.
 */

export const LOG_FILE = path.join(os.homedir(), 'Library', 'Logs', 'Hangar', 'hangar.log');

/** Rotated past this, to `hangar.log.1`. One generation is plenty for a personal app. */
const MAX_LOG_BYTES = 5 * 1024 * 1024;

/**
 * How often the size is checked after boot. Under launchd the app runs for weeks between launches,
 * and a boot-only check let the file grow without limit the whole time.
 */
const ROTATE_CHECK_MS = 10 * 60_000;

/**
 * Copy-and-truncate rather than rename. launchd holds the file open, in append mode, for the life
 * of the job: renaming would send this whole session's output into `.1`, while truncating in place
 * is safe because every write through an `O_APPEND` descriptor lands at the new end.
 */
export function rotateIfLarge(file: string, maxBytes = MAX_LOG_BYTES): boolean {
  let size: number;
  try {
    size = fs.statSync(file).size;
  } catch {
    return false; // no log yet
  }
  if (size < maxBytes) return false;
  try {
    fs.copyFileSync(file, `${file}.1`);
    fs.truncateSync(file, 0);
    return true;
  } catch {
    return false;
  }
}

/** Whether this process's stdout already *is* the log file — i.e. launchd started it. */
function stdoutIsFile(file: string): boolean {
  try {
    const out = fs.fstatSync(1);
    const log = fs.statSync(file);
    return out.ino === log.ino && out.dev === log.dev;
  } catch {
    return false;
  }
}

/**
 * Timestamps on the lines launchd captures. A copy launchd started writes to the log through its
 * stdout, which is why it skips the tee below — and why every line it wrote had no time on it.
 */
function timestampConsole(): void {
  for (const level of ['log', 'warn', 'error'] as const) {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]) => original(`${new Date().toISOString()} ${format(...args)}`);
  }
}

/** Timestamped lines appended to the log, for launches whose stdout goes nowhere. */
function teeConsole(file: string): void {
  const stream = fs.createWriteStream(file, { flags: 'a' });
  // A write error here must never become the app's problem — it is only a log.
  stream.on('error', () => {});
  for (const level of ['log', 'warn', 'error'] as const) {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      original(...args);
      stream.write(`${new Date().toISOString()} ${format(...args)}\n`);
    };
  }
}

/**
 * Node prints process warnings through a default `warning` listener, and Electron raises one for
 * every failed `loadURL` with the full URL in it — sign-in URLs carrying `login_hint` (an email
 * address), `state` and nonces. 96% of one user's log was these. Replaced with a listener that
 * writes the same line through our console with the query strings taken out.
 */
function redactWarnings(): void {
  process.removeAllListeners('warning');
  process.on('warning', (warning) => {
    console.warn(`[warning] ${redactUrlsIn(`${warning.name}: ${warning.message}`)}`);
  });
}

/** Call once at boot, after `installLogGuards`. Packaged builds only: a dev run has a terminal. */
export function setUpLogFile(): void {
  redactWarnings();
  if (!app.isPackaged) return;
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
  } catch {
    return;
  }
  const rotated = rotateIfLarge(LOG_FILE);
  if (stdoutIsFile(LOG_FILE)) timestampConsole();
  else teeConsole(LOG_FILE);
  if (rotated) console.log(`[log] rotated the previous log to ${path.basename(LOG_FILE)}.1`);
  // Copy-and-truncate is safe under either writer: both hold the file in append mode.
  setInterval(() => {
    if (rotateIfLarge(LOG_FILE)) console.log(`[log] rotated to ${path.basename(LOG_FILE)}.1`);
  }, ROTATE_CHECK_MS).unref();
}

/**
 * Milliseconds since the process started, for the `[boot]` marks. Startup had one timing line —
 * the ad blocker's — so "is it slow to open" had no answer beyond a stopwatch.
 */
export function sinceLaunch(): number {
  return Math.round(performance.now());
}
