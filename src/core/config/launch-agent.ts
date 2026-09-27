import type { Preferences } from '@shared/types';

/**
 * The launchd job that starts Hangar at login and restarts it if it dies.
 *
 * `app.setLoginItemSettings` is refused on an unsigned build — macOS registers login items against a
 * code signature and there is nothing to trust — which is why the toggle has never worked. A
 * user-level LaunchAgent carries no such requirement: it is a plist in `~/Library/LaunchAgents`, and
 * launchd reads it at login whoever wrote it.
 *
 * Rendering is pure and takes its paths as arguments, so the whole thing is testable without an app
 * bundle, a home directory, or Electron.
 */

export const LAUNCH_AGENT_LABEL = 'com.hangar.desktop';

/**
 * Restarting is only possible for a job launchd started itself.
 *
 * launchd supervises its own children. A Hangar started from Finder or the Dock is not one, so no
 * `KeepAlive` setting can bring it back — which makes "restart it if it dies" without "start it at
 * login" a promise nothing could keep. So the job exists only when `launchAtLogin` is on, and
 * `relaunchOnCrash` decides whether that job is supervised once it is running.
 */
export function launchAgentWanted(prefs: Preferences): boolean {
  return prefs.behaviour.launchAtLogin;
}

/**
 * Whether an executable is an installed copy, and so one login should launch.
 *
 * The job's `ProgramArguments` is whatever copy last wrote it, and every packaged copy writes it on
 * boot. Opening the freshly built `dist/mac-arm64/Hangar.app` to try it out therefore repointed
 * login at the build directory — which works right up until the next clean build deletes it, and
 * then login starts nothing, with no error anywhere. Only a copy in an Applications folder may
 * claim the job; the system one or the user's own `~/Applications`.
 */
export function isInstalledCopy(executable: string, home: string): boolean {
  const roots = ['/Applications/', `${home.replace(/\/+$/, '')}/Applications/`];
  return roots.some((root) => executable.startsWith(root) && executable.includes('.app/Contents/MacOS/'));
}

export interface LaunchAgentPaths {
  /** The executable inside the bundle: `/Applications/Hangar.app/Contents/MacOS/Hangar`. */
  program: string;
  /** Where launchd should send stdout and stderr. */
  log: string;
}

/** `&` and `<` in a path would produce a plist launchd refuses to parse. */
function xml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * `ThrottleInterval` is 10 seconds by default, which is enough to stop a crash loop spinning but
 * short enough that catching it to turn the setting off is a race. Thirty is still prompt for the
 * case this exists for — a crash hours into a session — and leaves room to intervene.
 */
const THROTTLE_SECONDS = 30;

export function renderLaunchAgent(prefs: Preferences, paths: LaunchAgentPaths): string {
  // Supervision, not launching: RunAtLoad is what starts it, and it is unconditional here because
  // the job is only written at all when launchAtLogin is on.
  const keepAlive = prefs.behaviour.relaunchOnCrash
    ? `  <key>KeepAlive</key>
  <dict>
    <!-- Only an *unsuccessful* exit. Every deliberate quit in the app goes through app.quit() or
         app.exit(0), so a plain <true/> here would make Hangar impossible to quit. -->
    <key>SuccessfulExit</key>
    <false/>
  </dict>
`
    : '';

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<!-- Written by Hangar from Settings. Edits here are overwritten when those settings change. -->
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCH_AGENT_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(paths.program)}</string>
  </array>
  <!-- Without this, System Settings lists the item with no name and no way to tell what it is. -->
  <key>AssociatedBundleIdentifiers</key>
  <array>
    <string>${LAUNCH_AGENT_LABEL}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
${keepAlive}  <key>ThrottleInterval</key>
  <integer>${THROTTLE_SECONDS}</integer>
  <!-- A Finder-launched app has no terminal, so without these there is no log at all. -->
  <key>StandardOutPath</key>
  <string>${xml(paths.log)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(paths.log)}</string>
</dict>
</plist>
`;
}
