import { app, globalShortcut, session, shell } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import type { Preferences, ProxyConfig } from '@shared/types';

/**
 * Preferences that reach outside the app — the login item, the proxy, download handling and the
 * one global shortcut.
 *
 * These are applied idempotently on boot and again whenever the relevant preference changes, so
 * there's no separate "did we already do this" bookkeeping to get out of step.
 */

/**
 * Returns whether the setting actually took effect.
 *
 * Two ways this silently doesn't work, and both had to be found by running it:
 *
 *  1. **Unpackaged**, an Electron binary would register *itself* rather than Hangar, so it's
 *     skipped entirely.
 *  2. **Packaged but unsigned**, macOS refuses outright — "Operation not permitted", logged by
 *     Chromium's native layer, which means it never throws and a naive call looks like success.
 *     Login items are registered against a code signature; without a Developer ID there's nothing
 *     for macOS to trust.
 *
 * So the result is *verified by reading back* rather than assumed. A toggle the user flips that
 * quietly does nothing is worse than one that admits it can't.
 */
export function applyLoginItem(prefs: Preferences): boolean {
  if (!app.isPackaged) return false;

  const wanted = prefs.behaviour.launchAtLogin;
  // Skip a no-op call: the failure logs a native error line, and repeating it on every unrelated
  // boot makes the log look broken.
  if (app.getLoginItemSettings().openAtLogin === wanted) return true;

  app.setLoginItemSettings({
    openAtLogin: wanted,
    openAsHidden: prefs.behaviour.startHidden,
  });

  const applied = app.getLoginItemSettings().openAtLogin === wanted;
  if (!applied) {
    console.warn(
      '[system] launch at login was refused by macOS. This needs a code-signed build — ' +
        'see docs/packaging.md.'
    );
  }
  return applied;
}

/** Chromium's proxy rule format. `system` means "don't set one" — the default already is. */
export function proxyRules(proxy: ProxyConfig): { mode?: 'direct'; proxyRules?: string } | null {
  switch (proxy.mode) {
    case 'system':
      return null;
    case 'none':
      return { mode: 'direct' };
    case 'http':
      return { proxyRules: `http://${proxy.host}:${proxy.port}` };
    case 'socks4':
      return { proxyRules: `socks4://${proxy.host}:${proxy.port}` };
    case 'socks5':
      return { proxyRules: `socks5://${proxy.host}:${proxy.port}` };
  }
}

export async function applyProxy(sessions: Iterable<Electron.Session>, prefs: Preferences): Promise<void> {
  const rules = proxyRules(prefs.network.proxy);
  if (!rules) return;
  for (const ses of sessions) {
    try {
      await ses.setProxy(rules);
    } catch (err) {
      console.error('[proxy] failed to apply:', err);
    }
  }
}

/**
 * Downloads land in the configured folder without a prompt unless asked otherwise. Attaching per
 * session rather than globally, because each service has its own.
 */
export function attachDownloadHandler(ses: Electron.Session, getPrefs: () => Preferences): void {
  ses.on('will-download', (_event, item) => {
    const prefs = getPrefs().downloads;
    if (!prefs.askWhereToSave) {
      const folder = prefs.folder ?? app.getPath('downloads');
      // Setting an explicit path disables Chromium's own uniquifier, so downloading invoice.pdf
      // twice silently destroyed the first copy. Reproduce it ourselves.
      item.setSavePath(uniqueDownloadPath(folder, item.getFilename()));
    }
    item.once('done', (_e, state) => {
      if (state === 'completed' && prefs.openOnComplete) {
        void shell.openPath(item.getSavePath());
      }
    });
  });
}

/**
 * The one legitimate `globalShortcut`: explicit, single, user-configurable, and it exists precisely
 * to work while Hangar is unfocused. Everything else stays on `before-input-event` so web apps keep
 * their own keys — see docs/keyboard.md.
 */
let registered: string | null = null;

export function applyGlobalShortcut(accelerator: string | null, toggle: () => void): void {
  if (registered === accelerator) return;
  if (registered) globalShortcut.unregister(registered);
  registered = null;
  if (!accelerator) return;
  try {
    if (globalShortcut.register(accelerator, toggle)) registered = accelerator;
    else console.warn(`[shortcut] ${accelerator} is already taken by another app`);
  } catch (err) {
    console.error('[shortcut] invalid accelerator:', err);
  }
}

export const releaseGlobalShortcut = () => globalShortcut.unregisterAll();

export { session };

/**
 * `invoice.pdf` → `invoice (1).pdf` → `invoice (2).pdf`, matching the browser convention.
 *
 * Only needed because we set an explicit save path; Chromium does this itself when left alone. The
 * loop is bounded — at a thousand collisions something else is wrong, and overwriting is still
 * better than hanging.
 */
export function uniqueDownloadPath(folder: string, filename: string): string {
  const ext = path.extname(filename);
  const stem = path.basename(filename, ext);
  let candidate = path.join(folder, filename);
  for (let n = 1; fs.existsSync(candidate) && n < 1000; n++) {
    candidate = path.join(folder, `${stem} (${n})${ext}`);
  }
  return candidate;
}
