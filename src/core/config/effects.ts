import type { Preferences } from '@shared/types';

/**
 * Which side effect a changed preference needs, decided without performing it.
 *
 * `AppWindow.applyPreferenceEffect` was an if/else chain over path strings, mixing *which* effect a
 * key needs with *how* to run it. That made the decision untestable — you cannot ask "does
 * `notifications.firebase.apiKey` restart push?" without an Electron session — and it produced a
 * concrete drift: the reset path iterated a second, hand-maintained list of representative paths,
 * with a comment claiming a new branch "can't be forgotten here". It could. The list and the chain
 * were two copies of the same set, kept in step by hand.
 *
 * Splitting the decision out fixes both. The chain becomes a switch over these tags, and the reset
 * path iterates the tags themselves rather than a parallel list of paths that must happen to cover
 * them all.
 */
export type PreferenceEffect =
  /** Register or clear the macOS login item. */
  | 'login-item'
  /** Re-apply the proxy across every live session. */
  | 'proxy'
  /** Turn ad and tracker blocking on or off across every live session. */
  | 'adblock'
  /** Re-register the global shortcut. */
  | 'shortcut'
  /** Create or destroy the tray icon. */
  | 'tray'
  /** Start or stop the Web Push sockets. */
  | 'push'
  /** Push new spellcheck languages into sessions already created. */
  | 'spellcheck'
  /** Load the services that should be running and aren't — "Keep every service running" was turned on. */
  | 'background-services';

/** Every effect, so a caller that must run all of them cannot miss one. */
export const ALL_PREFERENCE_EFFECTS: readonly PreferenceEffect[] = [
  'login-item',
  'proxy',
  'adblock',
  'shortcut',
  'tray',
  'push',
  'spellcheck',
  'background-services',
];

/**
 * The effect a path needs, or null when it needs none beyond being written.
 *
 * Most preferences are read at the point of use and need nothing — the rail reads `railSize` on
 * every render. Only the ones that configure something *outside* the config appear here.
 */
export function preferenceEffectFor(path: string): PreferenceEffect | null {
  // `relaunchOnCrash` too: it is a key in the same launchd job that `launchAtLogin` writes.
  if (path === 'behaviour.launchAtLogin' || path === 'behaviour.relaunchOnCrash') {
    return 'login-item';
  }
  if (path.startsWith('network.proxy')) return 'proxy';
  if (path === 'network.blockAds') return 'adblock';
  if (path === 'behaviour.globalShortcut') return 'shortcut';
  // `closeToTray` too: hiding the window with no tray icon leaves no way back to it.
  if (path === 'appearance.showTrayIcon' || path === 'behaviour.closeToTray') return 'tray';
  if (path === 'notifications.push' || path.startsWith('notifications.firebase')) return 'push';
  if (path === 'behaviour.spellcheckLanguages') return 'spellcheck';
  // Takes effect at once, like a service's own "Keep running". Turned off, nothing is unloaded:
  // the idle sweep does that, if hibernation is on.
  if (path === 'behaviour.keepAllRunning') return 'background-services';
  return null;
}

/**
 * Every effect a wholesale change of preferences needs, in `ALL_PREFERENCE_EFFECTS` order.
 *
 * For the paths that replace preferences without going through `set-preference` — an incoming
 * sync and an import. They re-rendered every screen and ran none of the effects, so Settings showed
 * the tray on, ad blocking off or a new global shortcut, and nothing outside the app changed until
 * a restart.
 */
export function effectsForChange(before: Preferences, after: Preferences): PreferenceEffect[] {
  const found = new Set<PreferenceEffect>();
  const walk = (a: unknown, b: unknown, path: string) => {
    if (isRecord(a) && isRecord(b)) {
      for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
        walk(a[key], b[key], path ? `${path}.${key}` : key);
      }
      return;
    }
    if (JSON.stringify(a) === JSON.stringify(b)) return;
    const effect = preferenceEffectFor(path);
    if (effect) found.add(effect);
  };
  walk(before, after, '');
  return ALL_PREFERENCE_EFFECTS.filter((effect) => found.has(effect));
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Whether a tray icon should exist.
 *
 * `closeToTray` forces one on regardless of `showTrayIcon`: closing the window hides it, and
 * without an icon there is nothing left that leads back to the app. The two preferences read as
 * independent and are not.
 */
export function trayWanted(prefs: Preferences): boolean {
  return prefs.appearance.showTrayIcon || prefs.behaviour.closeToTray;
}
