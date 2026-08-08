import { app, dialog, ipcMain, nativeTheme, powerMonitor } from 'electron';
import { installLogGuards } from '@main/platform/logging';
import { catalogById } from '@shared/catalog';
import { loadConfig } from '@main/platform/config';
import { installIconProtocol, registerIconScheme } from '@main/features/icons';
import { installMenu } from '@main/boot/menu';
import { DEFAULT_BINDINGS } from '@core/keyboard/keymap';
import { DEFAULT_COOKIE_TTL_DAYS, flushStorage, promoteSessionCookies } from '@main/platform/persist-cookies';
import { allLiveSessions, partitionFor, pruneSessions } from '@main/platform/session';
import { applyUserAgent } from '@main/platform/ua';
import { beginQuit, isQuitting } from '@main/platform/quit-state';
import { releaseGlobalShortcut } from '@main/platform/system';
import { AppWindow } from '@main/window/app-window';
import type { Command } from '@shared/types';

/**
 * Process entry point. Owns boot order, the single-instance lock, the IPC surface, and the two
 * background loops (session durability and hibernation).
 *
 * Boot order is load-bearing and documented in docs/architecture.md — `app.setName` before the
 * menu, `registerIconScheme` before app-ready, and `applyUserAgent` first thing *inside*
 * whenReady, before any session or view exists.
 */

// Before anything that logs, which is nearly everything below. A terminal that goes away while the
// app is running turns every subsequent log line into a fatal EPIPE — see the module.
installLogGuards();

// Unpackaged Electron reports its own name, so the menu bar and About box read "Electron".
// package.json's productName only applies once packaged — this makes dev match the real thing.
app.setName('Hangar');

/**
 * Profile isolation, for tests and for `npm run dev:isolated`.
 *
 * `userData` holds the config *and* every session partition, so an end-to-end test run against the
 * default path would drive your real setup — sign services out, reorder your rail, and on a bad
 * assertion delete things. The same is true of a dev instance once the packaged app is installed
 * and running all day. Set before `whenReady`, because `config.ts` resolves its paths lazily but the
 * first `loadConfig()` happens inside the AppWindow constructor.
 */
const isolatedUserData = process.env['HANGAR_USER_DATA'];
if (isolatedUserData) {
  app.setPath('userData', isolatedUserData);
  console.log(`[boot] userData overridden: ${isolatedUserData}`);
}

let shell: AppWindow | null = null;

/**
 * `closed`, not `close`: the close handler prevents default when `closeToTray` is on, so the window
 * may be merely hidden. Only a real destruction should tear everything down.
 */
const trackWindow = (w: AppWindow) => {
  w.win.on('closed', () => {
    w.dispose();
    shell = null;
    publishTestHandle();
  });
};

/**
 * Exposes the live `AppWindow` to Playwright's `app.evaluate`, which runs in the main process but
 * has no way to reach a module-scoped variable.
 *
 * Gated on `HANGAR_USER_DATA`, so it exists only where the profile has already been isolated — a
 * test run or `dev:isolated`, never the installed app against your real setup. Re-published on
 * every change because `activate` builds a *new* AppWindow, and a test asserting the
 * ⌘W-then-reopen path needs the current one rather than the corpse.
 */
function publishTestHandle(): void {
  if (!process.env['HANGAR_USER_DATA']) return;
  (globalThis as { __hangarShell?: AppWindow | null }).__hangarShell = shell;
}

// A second copy fighting over the same partitions would corrupt cookie jars, so hand off to the
// running instance instead.
const gotLock = app.requestSingleInstanceLock();
console.log(`[boot] single-instance lock: ${gotLock ? 'acquired' : 'denied — handing off and quitting'}`);
if (!gotLock) {
  // `app.quit()` before app-ready doesn't stop this module executing — everything below still
  // registered, and a second copy briefly raced the first over the same partitions, which is
  // exactly what corrupts a cookie jar. Exit outright instead.
  app.exit(0);
}

// Must precede app-ready, hence not inside whenReady with the rest of the setup.
registerIconScheme();

app.on('second-instance', () => {
  // `showWindow()`, not a hand-rolled restore-and-focus. Under `closeToTray` the window is *hidden*
  // rather than minimized, so restoring and focusing without showing it put focus on something
  // invisible — relaunching from Spotlight looked like the app had died.
  shell?.showWindow();
});

app.whenReady().then(() => {
  // First, before any session or view exists. See ua.ts for why this is the whole UA story.
  applyUserAgent();
  const config = loadConfig();
  nativeTheme.themeSource = config.preferences.appearance.theme;
  installIconProtocol(() => loadConfig().services);
  shell = new AppWindow();
  trackWindow(shell);
  publishTestHandle();
  // The bindings are read on every rebuild rather than captured, so `refreshMenu` after a rebind
  // redraws against the new map without this call site knowing anything about it.
  installMenu(
    (command) => shell?.dispatch(command) ?? false,
    () => loadConfig().preferences.keyboard?.bindings ?? DEFAULT_BINDINGS
  );
  shell.applySystemPreferences();
  // "Launch to the tray rather than a window" — the emphasis is on *launch*. The setting exists so
  // that logging in doesn't throw a window at you, and it was being applied to every start,
  // including one a person had just typed. `npm run dev` then produced no window, no error and no
  // clue: the app booted perfectly, loaded its rail and its services, and hid.
  //
  // A development run is never the unattended login it is guarding against, so it never hides.
  const startHidden = config.preferences.behaviour.startHidden && app.isPackaged;
  if (startHidden) shell.win.hide();

  ipcMain.handle('shell:get-state', () => shell?.state() ?? null);
  ipcMain.handle('overlay:get-mode', () => shell?.overlayOpen ?? null);
  // Memory readout for Settings, so the hibernation setting has a visible consequence.
  ipcMain.handle('app:metrics', () => {
    const metrics = app.getAppMetrics();
    return {
      processes: metrics.length,
      residentMb: Math.round(
        metrics.reduce((sum, m) => sum + (m.memory?.workingSetSize ?? 0), 0) / 1024
      ),
    };
  });
  ipcMain.on('shell:command', (_event, command: Command) => {
    // The renderer is a separate process, so an exception thrown here surfaces nowhere useful —
    // the click just appears to do nothing. Log the command and any failure explicitly.
    try {
      shell?.dispatch(command);
    } catch (err) {
      console.error(`[command] ${command.type} failed:`, err);
    }
  });

  // Attribution comes from the *sender*, never from the payload — a page could otherwise claim to
  // be another service and steer notifications or reloads at it.
  ipcMain.on('service:notification', (event, payload: unknown) => {
    // Wrapped for the same reason `shell:command` is, and more urgently: the payload comes from a
    // page rather than from our own renderer. `handleNotification` normalises its shape; this
    // catches anything downstream of that, where a throw would surface nowhere at all.
    try {
      const serviceId = shell?.serviceIdForContents(event.sender);
      if (serviceId) shell?.handleNotification(serviceId, payload);
    } catch (err) {
      console.error('[notification] failed:', err);
    }
  });

  // Same rule: which service is asking is decided by the sender, not by anything it passes. A page
  // that could name its own service id could register a push endpoint against another one.
  ipcMain.handle('service:push-subscribe', async (event, vapidKey: unknown) => {
    if (typeof vapidKey !== 'string' || vapidKey === '') return null;
    const serviceId = shell?.serviceIdForContents(event.sender);
    if (!serviceId) return null;
    return shell?.subscribePush(serviceId, vapidKey) ?? null;
  });

  ipcMain.on('service:retry', (event) => {
    const serviceId = shell?.serviceIdForContents(event.sender);
    if (serviceId) shell?.retryService(serviceId);
  });

  // No payload: the host comes from what main last blocked for this sender's service. See the
  // preload's allowHost for why the page is not allowed to name it.
  ipcMain.on('service:allow-host', (event) => {
    const serviceId = shell?.serviceIdForContents(event.sender);
    if (serviceId) shell?.allowBlockedHost(serviceId);
  });

  ipcMain.on('service:blank', (event) => {
    const serviceId = shell?.serviceIdForContents(event.sender);
    if (serviceId) shell?.reloadIfStillBlank(serviceId);
  });

  ipcMain.handle('service:unread-rules', (event) => {
    const serviceId = shell?.serviceIdForContents(event.sender);
    return serviceId ? (shell?.unreadRulesFor(serviceId) ?? []) : [];
  });

  ipcMain.on('service:unread', (event, probes: unknown) => {
    // A page's own scripts can reach `__hangar`, so `probes` is hostile input in the same way a
    // notification payload is. `handleUnreadProbes` validates the shape; this catches the rest.
    try {
      const serviceId = shell?.serviceIdForContents(event.sender);
      if (serviceId) shell?.handleUnreadProbes(serviceId, probes);
    } catch (err) {
      console.error('[unread] failed:', err);
    }
  });

  // Without clearing `shell` on close, ⌘W would destroy the window while leaving a live-looking
  // reference behind — `activate` would then no-op and the dock icon became a dead end.
  app.on('activate', () => {
    if (!shell) {
      shell = new AppWindow();
      trackWindow(shell);
      publishTestHandle();
      // Re-apply, or the rebuilt window has no global shortcut, no tray and no proxy. This was
      // called once at boot and never again, so everything system-level died with the first ⌘W.
      shell.applySystemPreferences();
    } else {
      shell.win.focus();
    }
  });
});

// --- session durability --------------------------------------------------------------------
// Session cookies never reach disk, so without this a restart signs you out of anything that
// doesn't issue a persistent cookie. See the Phase 0 findings in persist-cookies.ts.

/**
 * How long to extend a partition's session cookies by, or 0 to leave them alone.
 *
 * Several services can share one partition, so the *shortest* TTL wins — if any service in the
 * group opts out, the whole jar opts out. `sessionNotPersistable` forces 0: Phase 0 proved that
 * promoting Salesforce's `sid` achieves nothing because the org invalidates it server-side, so
 * extending it is pure downside.
 */
function ttlForPartition(partition: string): number {
  const services = loadConfig().services.filter((svc) => {
    // Same reason as `persistAll`: a service with a missing account throws rather than answering,
    // and it is not this function's job to fail the whole partition over it.
    try {
      return partitionFor(svc) === partition;
    } catch {
      return false;
    }
  });
  if (services.length === 0) return DEFAULT_COOKIE_TTL_DAYS;

  return services.reduce((shortest, svc) => {
    const entry = catalogById(svc.catalogId);
    const ttl = entry?.sessionNotPersistable ? 0 : svc.cookieTtlDays ?? DEFAULT_COOKIE_TTL_DAYS;
    return Math.min(shortest, ttl);
  }, Number.POSITIVE_INFINITY);
}

async function persistAll(): Promise<void> {
  // Per service, not `services.map(partitionFor)`. `partitionFor` throws on a service whose
  // account is missing, and one throw here took out the whole loop — permanently, because it runs
  // under `void` on an interval with nothing to report the rejection. Cookie promotion and storage
  // flushing would then stop for *every* service, and the user finds out weeks later by being
  // signed out of everything after a restart.
  //
  // `migrateConfig` now refuses a config that could produce this, so it should be unreachable.
  // Keeping the guard anyway: the cost of being wrong is the durability of every session in the
  // app, and this loop should degrade to "skip that one" rather than "stop".
  const needed = new Set<string>();
  for (const svc of loadConfig().services) {
    try {
      needed.add(partitionFor(svc));
    } catch (err) {
      console.error(`[session] skipping ${svc.name}:`, err);
    }
  }

  for (const partition of pruneSessions(needed)) {
    console.log(`[session] released ${partition} — no service uses it`);
  }

  for (const [partition, ses] of allLiveSessions()) {
    const ttlDays = ttlForPartition(partition);
    if (ttlDays > 0) await promoteSessionCookies(ses, { label: partition, ttlDays });
    await flushStorage(ses);
  }
}

setInterval(() => {
  // The interval is fire-and-forget, so an unhandled rejection here is invisible. Catch it, or the
  // only symptom of a broken persistence loop is lost sessions much later.
  void persistAll().catch((err) => console.error('[session] persist failed:', err));
}, 60_000);

// Hibernation sweep. Frequent enough that a 1-minute timeout behaves as advertised, cheap enough
// that it doesn't matter — the decision is pure arithmetic over a handful of services.
setInterval(() => shell?.hibernateIdle(), 30_000);

// Unread for sleeping services. The sweep is far cheaper than the interval suggests: it only
// considers services with no live view *and* an endpoint rule, and each of those carries its own
// interval floored at a minute. On a typical config it does nothing at all.
setInterval(() => {
  // Same reason as `persistAll`: this runs under `void` on a timer, where an unhandled rejection
  // is invisible and the loop just stops.
  void shell?.pollEndpoints().catch((err) => console.error('[endpoint] sweep failed:', err));
}, 30_000);

// --- power ------------------------------------------------------------------------------------
// A closing lid is an unclean exit as far as unwritten session cookies are concerned, and views
// that slept through it hold stale content and often a dead socket.

let suspendedAt: number | null = null;

powerMonitor.on('suspend', () => {
  suspendedAt = Date.now();
  console.log('[power] suspending — flushing sessions');
  void persistAll().catch((err) => console.error('[power] suspend flush failed:', err));
});

powerMonitor.on('resume', () => {
  const suspendedFor = suspendedAt ? Date.now() - suspendedAt : 0;
  suspendedAt = null;
  console.log(`[power] resumed after ${Math.round(suspendedFor / 1000)}s`);
  shell?.refreshAfterWake(suspendedFor);
});

app.on('before-quit', (event) => {
  if (isQuitting()) return;
  event.preventDefault();

  if (loadConfig().preferences.behaviour.confirmQuit) {
    const { response } = { response: dialog.showMessageBoxSync({
      type: 'question',
      buttons: ['Quit', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      message: 'Quit Hangar?',
    }) };
    // Cancelling must leave the app fully usable — no half-quit state.
    if (response !== 0) return;
  }

  // Tells the window's close handler this is a real quit, not a close-to-tray.
  beginQuit();
  releaseGlobalShortcut();
  // persistAll MUST finish before anything tears down sessions. It promotes session cookies to
  // persistent ones, which is the whole reason you stay signed in across a restart — disposing
  // first would sign the user out of everything, the exact failure Phase 1 exists to prevent.
  void persistAll()
    .catch((err) => console.error('[quit] cookie promotion failed:', err))
    .finally(() => app.quit());
});

// macOS convention: closing the window doesn't quit. Also avoids Electron's default
// "last window closed → quit", which fires when panes are torn down during a relayout.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
