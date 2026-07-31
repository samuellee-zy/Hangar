import { app, dialog, ipcMain, nativeTheme, powerMonitor } from 'electron';
import { catalogById } from '@shared/catalog';
import { loadConfig } from '@main/platform/config';
import { installIconProtocol, registerIconScheme } from '@main/features/icons';
import { installMenu } from '@main/boot/menu';
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

// Unpackaged Electron reports its own name, so the menu bar and About box read "Electron".
// package.json's productName only applies once packaged — this makes dev match the real thing.
app.setName('Hangar');

/**
 * Test isolation.
 *
 * `userData` holds the config *and* every session partition, so an end-to-end test run against the
 * default path would drive your real setup — sign services out, reorder your rail, and on a bad
 * assertion delete things. Set before `whenReady`, because `config.ts` resolves its paths lazily
 * but the first `loadConfig()` happens inside the AppWindow constructor.
 */
const testUserData = process.env['HANGAR_USER_DATA'];
if (testUserData) {
  app.setPath('userData', testUserData);
  console.log(`[boot] userData overridden: ${testUserData}`);
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
 * Gated on `HANGAR_USER_DATA` so it exists only when a test has already isolated the profile —
 * there's no path by which a normal run publishes an internal handle. Re-published on every change
 * because `activate` builds a *new* AppWindow, and a test asserting the ⌘W-then-reopen path needs
 * the current one rather than the corpse.
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
  if (!shell) return;
  if (shell.win.isMinimized()) shell.win.restore();
  shell.win.focus();
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
  installMenu((command) => shell?.dispatch(command) ?? false);
  shell.applySystemPreferences();
  if (config.preferences.behaviour.startHidden) shell.win.hide();

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
  ipcMain.on('service:notification', (event, payload) => {
    const serviceId = shell?.serviceIdForContents(event.sender);
    if (serviceId) shell?.handleNotification(serviceId, payload);
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

  ipcMain.on('service:blank', (event) => {
    const serviceId = shell?.serviceIdForContents(event.sender);
    if (serviceId) shell?.reloadIfStillBlank(serviceId);
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
  const services = loadConfig().services.filter((svc) => partitionFor(svc) === partition);
  if (services.length === 0) return DEFAULT_COOKIE_TTL_DAYS;

  return services.reduce((shortest, svc) => {
    const entry = catalogById(svc.catalogId);
    const ttl = entry?.sessionNotPersistable ? 0 : svc.cookieTtlDays ?? DEFAULT_COOKIE_TTL_DAYS;
    return Math.min(shortest, ttl);
  }, Number.POSITIVE_INFINITY);
}

async function persistAll(): Promise<void> {
  const needed = new Set(loadConfig().services.map(partitionFor));
  for (const partition of pruneSessions(needed)) {
    console.log(`[session] released ${partition} — no service uses it`);
  }

  for (const [partition, ses] of allLiveSessions()) {
    const ttlDays = ttlForPartition(partition);
    if (ttlDays > 0) await promoteSessionCookies(ses, { label: partition, ttlDays });
    await flushStorage(ses);
  }
}

setInterval(() => void persistAll(), 60_000);

// Hibernation sweep. Frequent enough that a 1-minute timeout behaves as advertised, cheap enough
// that it doesn't matter — the decision is pure arithmetic over a handful of services.
setInterval(() => shell?.hibernateIdle(), 30_000);

// --- power ------------------------------------------------------------------------------------
// A closing lid is an unclean exit as far as unwritten session cookies are concerned, and views
// that slept through it hold stale content and often a dead socket.

let suspendedAt: number | null = null;

powerMonitor.on('suspend', () => {
  suspendedAt = Date.now();
  console.log('[power] suspending — flushing sessions');
  void persistAll();
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
