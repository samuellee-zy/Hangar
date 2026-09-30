/**
 * Whether a finished download may be opened automatically.
 *
 * "Open when complete" used `shell.openPath` on whatever arrived, which for a file that *is* a
 * program means running it: a page in any service could start a download of `invoice.command`, and
 * with the setting on it executed the moment it landed — no click, no prompt beyond Gatekeeper's,
 * and Gatekeeper does not look at shell scripts at all. Documents, images and archives open; for
 * anything that runs or installs, Finder shows the file and the decision stays a person's.
 *
 * Extensions, lowercase, without the dot. A blocklist rather than an allowlist on purpose: the
 * setting exists to open ordinary files, and an allowlist would quietly turn it off for every type
 * nobody thought to list. The list is what macOS will execute or install on open.
 */
const RUNS_OR_INSTALLS = new Set([
  // Apps, installers, disk images that autorun an installer.
  'app', 'pkg', 'mpkg', 'dmg',
  // Scripts Terminal or the shell will run.
  'command', 'sh', 'bash', 'zsh', 'csh', 'ksh', 'tool', 'terminal',
  // Automation.
  'scpt', 'scptd', 'applescript', 'workflow', 'action', 'shortcut',
  // Code that loads into something else, or runs under a runtime.
  'jar', 'py', 'pl', 'rb', 'js', 'mjs', 'osax', 'prefpane', 'plugin', 'kext', 'bundle',
  'webloc', 'inetloc', 'fileloc',
  // Configuration that changes the system when opened.
  'mobileconfig',
]);

export function safeToAutoOpen(filename: string): boolean {
  const dot = filename.lastIndexOf('.');
  if (dot <= 0 || dot === filename.length - 1) return true; // no extension: opens in an editor
  return !RUNS_OR_INSTALLS.has(filename.slice(dot + 1).toLowerCase());
}

/**
 * What to say when a download ends, or null for nothing.
 *
 * A download used to land in silence: a click on a file in Slack saved it, and nothing on screen
 * said so — no bubble as a browser has, no bounce in the Dock. The banner names the file and the
 * service it came from, since "Downloaded report.pdf" from one of six chat apps is half an answer.
 *
 * Nothing for a cancelled one — that was you, at the save dialog — and nothing while it runs: the
 * Dock's progress bar says that (`downloadProgress`).
 */
export function downloadNotice(
  entry: { name: string; state: 'progressing' | 'completed' | 'cancelled' | 'interrupted' },
  serviceName: string | null,
): { title: string; body: string } | null {
  const from = serviceName ? `From ${serviceName}. ` : '';
  switch (entry.state) {
    case 'completed':
      return { title: `Downloaded ${entry.name}`, body: `${from}Click to show it in Finder.` };
    case 'interrupted':
      return { title: `Couldn't download ${entry.name}`, body: `${from}Try it again from the page.` };
    default:
      return null;
  }
}

/**
 * The Dock icon's progress bar across every download still running, as `setProgressBar` takes it:
 * a fraction, or -1 for no bar at all. One whose size the server didn't send counts as not started,
 * so the bar can't jump backwards when its size is learned.
 */
export function downloadProgress(
  entries: readonly { state: string; received: number; total: number }[],
): number {
  const running = entries.filter((d) => d.state === 'progressing');
  if (!running.length) return -1;
  const total = running.reduce((sum, d) => sum + d.total, 0);
  if (total <= 0) return 0;
  const received = running.reduce((sum, d) => sum + (d.total > 0 ? Math.min(d.received, d.total) : 0), 0);
  return Math.min(1, received / total);
}
