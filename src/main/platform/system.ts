import { app, globalShortcut, session, shell } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { applyLaunchAgent } from '@main/platform/launch-agent';
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
 * This used to call `app.setLoginItemSettings`, which cannot work here: macOS registers login items
 * against a code signature, and unsigned it refuses with "Operation not permitted" — logged by
 * Chromium's native layer, so the call never throws and a naive one looks like success. That is
 * decision #45, and reading the value back was how the toggle at least admitted it had failed.
 *
 * A user-level LaunchAgent has no signature requirement, so the toggle can simply work. Both
 * mechanisms at once would be worse than either: on a signed build they are two independent
 * registrations, and login would start Hangar twice with the single-instance lock discarding one.
 * So this is now a single line, and the read-back honesty moves with it.
 *
 * `startHidden` no longer has anything to do here — `setLoginItemSettings`' `openAsHidden` was only
 * ever a hint to that mechanism, and boot/index.ts hides the window itself on any launch.
 */
export function applyLoginItem(prefs: Preferences): boolean {
  return applyLaunchAgent(prefs);
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
 * Which sessions already have the handler.
 *
 * `session.fromPartition` returns a singleton per partition, and `pruneSessions` drops a partition
 * from the "configured" set when no service uses it — so removing every service on a partition and
 * re-adding one runs `sessionFor` again against the *same* `Session`. The permission handlers
 * beside this one are `setX` calls and replace; `on('will-download')` appends, so each cycle
 * stacked another listener and one download then ran the save-path logic twice.
 *
 * Weak, so a session that really does go away isn't retained by this map.
 */
const downloadHandlerAttached = new WeakSet<Electron.Session>();

/**
 * Downloads land in the configured folder without a prompt unless asked otherwise. Attaching per
 * session rather than globally, because each service has its own. Idempotent — see above.
 */
export function attachDownloadHandler(ses: Electron.Session, getPrefs: () => Preferences): void {
  if (downloadHandlerAttached.has(ses)) return;
  downloadHandlerAttached.add(ses);

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
