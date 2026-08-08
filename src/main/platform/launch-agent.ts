import { app } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  LAUNCH_AGENT_LABEL,
  launchAgentWanted,
  renderLaunchAgent,
} from '@core/config/launch-agent';
import type { Preferences } from '@shared/types';

/**
 * Installing the launchd job. The decision and the plist are in `core/config/launch-agent.ts`; this
 * is the file system.
 *
 * **It writes a file and stops there.** No `launchctl`, deliberately: `applySystemPreferences()`
 * runs this on boot and again on every `activate`, and once Hangar is running *as* the launchd job,
 * a `bootout` would terminate it. Turning the relaunch setting off would quit the app, and so would
 * ⌘W-then-reopen. Nothing here should be able to kill the process it is running in.
 *
 * The cost is that both settings take effect at the next login rather than immediately, which is
 * the honest behaviour anyway: launchd can only supervise a process it started, so a Hangar opened
 * from Finder is unsupervised no matter what this writes.
 */

const agentPath = (): string =>
  path.join(os.homedir(), 'Library', 'LaunchAgents', `${LAUNCH_AGENT_LABEL}.plist`);

const logPath = (): string => path.join(os.homedir(), 'Library', 'Logs', 'Hangar', 'hangar.log');

/**
 * Whether the job on disk matches what the preferences ask for.
 *
 * Read back rather than assumed, for the same reason `applyLoginItem` used to read the login item
 * back: a setting that silently fails to apply is worse than one that admits it can't. Returns true
 * when disk and intent agree, including when both say "no job".
 */
export function applyLaunchAgent(prefs: Preferences): boolean {
  // Unpackaged, `getPath('exe')` is the Electron binary, so the job would launch a bare Electron
  // rather than Hangar — the same trap the old login-item code guarded against.
  if (!app.isPackaged || process.platform !== 'darwin') return false;

  const file = agentPath();

  try {
    if (!launchAgentWanted(prefs)) {
      // Left loaded until logout if launchd already started it this session; deleting the file is
      // what stops it coming back. Booting it out here would kill the running app.
      fs.rmSync(file, { force: true });
      return !fs.existsSync(file);
    }

    const wanted = renderLaunchAgent(prefs, { program: app.getPath('exe'), log: logPath() });

    // Skip an identical rewrite. This runs on every boot and every activate, and rewriting the file
    // each time would churn its mtime for no reason.
    if (fs.existsSync(file) && fs.readFileSync(file, 'utf8') === wanted) return true;

    fs.mkdirSync(path.dirname(file), { recursive: true });
    // launchd will not create the log's directory itself, and a StandardOutPath it cannot open
    // makes the job fail to start with nothing written anywhere to say so.
    fs.mkdirSync(path.dirname(logPath()), { recursive: true });
    fs.writeFileSync(file, wanted, 'utf8');

    return fs.readFileSync(file, 'utf8') === wanted;
  } catch (err) {
    console.error('[launch-agent] could not update the login item:', err);
    return false;
  }
}
