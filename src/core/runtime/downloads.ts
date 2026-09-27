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
