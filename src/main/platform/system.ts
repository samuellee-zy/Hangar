import { Notification, app, globalShortcut, session, shell } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { downloadNotice, safeToAutoOpen } from '@core/runtime/downloads';
import { applyLaunchAgent } from '@main/platform/launch-agent';
import type { DownloadEntry, Preferences, ProxyConfig } from '@shared/types';

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
 */
export function applyLoginItem(prefs: Preferences): boolean {
  return applyLaunchAgent(prefs);
}

export type ProxySetting = { mode: 'system' | 'direct' } | { proxyRules: string };

/**
 * What to hand `session.setProxy`.
 *
 * Always *something*. `system` used to return null and `applyProxy` returned early on null, which
 * made "system" mean "leave whatever is there" — so switching from a work proxy back to System left
 * every open service on the work proxy until restart. It is `mode: 'system'` now, which actively
 * restores it.
 *
 * A manual proxy without a host and port also falls back to the system's. Picking "http" in
 * Settings writes the mode before you have typed anything, and applying that as `http://:0` cut
 * every service off the network until the host was filled in.
 */
export function proxyRules(proxy: ProxyConfig): ProxySetting {
  switch (proxy.mode) {
    case 'system':
      return { mode: 'system' };
    case 'none':
      return { mode: 'direct' };
    case 'http':
    case 'socks4':
    case 'socks5': {
      const host = proxy.host.trim();
      if (!host || !(proxy.port > 0 && proxy.port <= 65535)) return { mode: 'system' };
      return { proxyRules: `${proxy.mode}://${host}:${proxy.port}` };
    }
  }
}

export async function applyProxy(sessions: Iterable<Electron.Session>, prefs: Preferences): Promise<void> {
  const rules = proxyRules(prefs.network.proxy);
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
 * Recent downloads, for the tray and Settings. A file used to land silently — no progress, and no
 * way back to it afterwards short of opening the Downloads folder and hunting.
 */
const recent: DownloadEntry[] = [];
let downloadsChanged: (() => void) | null = null;
let nextDownloadId = 0;

/** Newest first, at most ten. */
export const recentDownloads = (): DownloadEntry[] => recent.slice(0, 10);
export const onDownloadsChanged = (listener: (() => void) | null): void => {
  downloadsChanged = listener;
};
export const downloadPath = (id: string): string | null => recent.find((d) => d.id === id)?.path || null;

function track(item: Electron.DownloadItem, service: string | null): DownloadEntry {
  const entry: DownloadEntry = {
    id: String(++nextDownloadId),
    name: item.getFilename(),
    path: item.getSavePath(),
    state: 'progressing',
    received: 0,
    total: item.getTotalBytes(),
    at: Date.now(),
    service,
  };
  recent.unshift(entry);
  recent.length = Math.min(recent.length, 20);
  // Progress is throttled to whole percents; every chunk would be a broadcast per few KB.
  let lastPercent = -1;
  item.on('updated', () => {
    entry.received = item.getReceivedBytes();
    entry.total = item.getTotalBytes();
    entry.path = item.getSavePath() || entry.path;
    const percent = entry.total ? Math.floor((entry.received / entry.total) * 100) : -1;
    if (percent !== lastPercent) {
      lastPercent = percent;
      downloadsChanged?.();
    }
  });
  item.once('done', (_e, state) => {
    entry.state = state;
    entry.path = item.getSavePath() || entry.path;
    entry.received = item.getReceivedBytes();
    // The name only: the log gets pasted into bug reports, and a path says whose Mac it is.
    console.log(`[download] ${entry.service ?? 'Hangar'}: ${entry.name} — ${state}`);
    downloadsChanged?.();
  });
  downloadsChanged?.();
  return entry;
}

/**
 * Banners for downloads, held until they close. Only this set references one once `notice` returns,
 * and a banner collected before it's clicked does nothing when it is — the same trap the service
 * banners in window/attention.ts are held against. Bounded for the same reason as theirs.
 */
const liveNotices = new Set<Notification>();

/** The banner for a download that's ended, if it wants one. See `downloadNotice`. */
function notice(entry: DownloadEntry): void {
  const text = downloadNotice(entry, entry.service);
  if (!text) return;
  // Silent: a browser doesn't chime for a file you asked for, and neither should this.
  const banner = new Notification({ title: text.title, body: text.body, silent: true });
  const saved = entry.path;
  // Finder, never the file itself: showing a file can't run it. A failed one has nothing to show.
  if (entry.state === 'completed' && saved) banner.on('click', () => shell.showItemInFolder(saved));
  banner.on('close', () => liveNotices.delete(banner));
  banner.on('failed', (_event, error) => {
    console.error(`[download] banner for ${entry.name} not delivered — ${error}`);
    liveNotices.delete(banner);
  });
  liveNotices.add(banner);
  while (liveNotices.size > 20) liveNotices.delete(liveNotices.values().next().value!);
  banner.show();
}

/**
 * Downloads land in the configured folder without a prompt unless asked otherwise. Attaching per
 * session rather than globally, because each service has its own. Idempotent — see above.
 */
export function attachDownloadHandler(
  ses: Electron.Session,
  getPrefs: () => Preferences,
  /** The service a page belongs to, by name, for "From Slack". Null for a page that is no service's. */
  serviceNameOf: (wc: Electron.WebContents) => string | null = () => null,
): void {
  if (downloadHandlerAttached.has(ses)) return;
  downloadHandlerAttached.add(ses);

  ses.on('will-download', (_event, item, source) => {
    const prefs = getPrefs().downloads;
    if (!prefs.askWhereToSave) {
      const folder = prefs.folder ?? app.getPath('downloads');
      // Setting an explicit path disables Chromium's own uniquifier, so downloading invoice.pdf
      // twice silently destroyed the first copy. Reproduce it ourselves.
      item.setSavePath(uniqueDownloadPath(folder, item.getFilename()));
    }
    const entry = track(item, source && !source.isDestroyed() ? serviceNameOf(source) : null);
    item.once('done', (_e, state) => {
      // Read now rather than at the start: the setting may have changed while it downloaded.
      const now = getPrefs().downloads;
      // The Downloads stack in the Dock bounces, as it does for a browser's. macOS does nothing
      // for a file saved anywhere else.
      if (state === 'completed') app.dock?.downloadFinished(item.getSavePath());
      // Opening it is its own notice; a banner on top would be two for one file.
      const opens = state === 'completed' && now.openOnComplete;
      if (now.notify && !opens) notice(entry);
      if (!opens) return;
      const saved = item.getSavePath();
      // Never *run* something because a page downloaded it — see `safeToAutoOpen`.
      if (!safeToAutoOpen(path.basename(saved))) {
        console.log(`[download] not opening ${path.basename(saved)} automatically — it would run`);
        shell.showItemInFolder(saved);
        return;
      }
      shell.openPath(saved).then((error) => {
        if (error) console.warn(`[download] could not open ${path.basename(saved)}: ${error}`);
      }, () => {});
    });
  });
}

/**
 * The one legitimate `globalShortcut`: explicit, single, user-configurable, and it exists precisely
 * to work while Hangar is unfocused. Everything else stays on `before-input-event` so web apps keep
 * their own keys — see docs/keyboard.md.
 */
let registered: string | null = null;
let registeredToggle: (() => void) | null = null;

/**
 * How the last attempt to register went, for Settings to show. "Taken" and "invalid" used to go to
 * the log and nowhere else, so a shortcut that another app already owned just silently didn't work.
 */
export type GlobalShortcutStatus = 'off' | 'active' | 'taken' | 'invalid';
let status: GlobalShortcutStatus = 'off';
export const globalShortcutStatus = (): GlobalShortcutStatus => status;

export function applyGlobalShortcut(accelerator: string | null, toggle: () => void): void {
  // Same chord *and* same handler. The chord alone was the check, so after ⌘W rebuilt the window
  // the new one's `applySystemPreferences` was told "already registered" — and the shortcut kept
  // calling the old, disposed window's toggle, or nothing at all once dispose had released it.
  if (registered === accelerator && registeredToggle === toggle) return;
  registeredToggle = null;
  if (registered) globalShortcut.unregister(registered);
  registered = null;
  status = 'off';
  if (!accelerator) return;
  try {
    if (globalShortcut.register(accelerator, toggle)) {
      registered = accelerator;
      registeredToggle = toggle;
      status = 'active';
    } else {
      status = 'taken';
      console.warn(`[shortcut] ${accelerator} is already taken by another app`);
    }
  } catch (err) {
    status = 'invalid';
    console.error('[shortcut] invalid accelerator:', err);
  }
}

/**
 * Forgets the registration as well as removing it — otherwise the next `applyGlobalShortcut` with
 * the same chord believed it was still registered and did nothing, and the rebuilt window had no
 * shortcut at all.
 */
export const releaseGlobalShortcut = () => {
  globalShortcut.unregisterAll();
  registered = null;
  registeredToggle = null;
  status = 'off';
};

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
