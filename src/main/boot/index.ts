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

let shell: AppWindow | null = null;

/**
 * `closed`, not `close`: the close handler prevents default when `closeToTray` is on, so the window
 * may be merely hidden. Only a real destruction should tear everything down.
 */
const trackWindow = (w: AppWindow) => {
  w.win.on('closed', () => {
    w.dispose();
    shell = null;
  });
};

// A second copy fighting over the same partitions would corrupt cookie jars, so hand off to the
// running instance instead.
const gotLock = app.requestSingleInstanceLock();
console.log(`[boot] single-instance lock: ${gotLock ? 'acquired' : 'denied — handing off and quitting'}`);
if (!gotLock) {
  app.quit();
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

  // HANGAR_PROBE=1 opens the picker and reports what the overlay actually rendered. Renderer
  // failures are otherwise invisible from the terminal (see docs/decisions.md #14).
  if (process.env['HANGAR_PROBE']) void probeOverlay();

  // Without clearing `shell` on close, ⌘W would destroy the window while leaving a live-looking
  // reference behind — `activate` would then no-op and the dock icon became a dead end.
  app.on('activate', () => {
    if (!shell) {
      shell = new AppWindow();
      trackWindow(shell);
      // Re-apply, or the rebuilt window has no global shortcut, no tray and no proxy. This was
      // called once at boot and never again, so everything system-level died with the first ⌘W.
      shell.applySystemPreferences();
    } else {
      shell.win.focus();
    }
  });
});

/** Diagnostic only: opens the connection picker, inspects its DOM, and clicks the first tile. */
async function probeOverlay(): Promise<void> {
  await new Promise((r) => setTimeout(r, 3000));

  const rail = shell?.railContents;
  if (rail) {
    console.log(
      '[probe] rail:',
      await rail.executeJavaScript(`JSON.stringify({
        tiles: document.querySelectorAll('.rail-item').length,
        icons: document.querySelectorAll('.rail-icon').length,
        addButton: !!document.querySelector('.rail-add'),
        draggable: !!document.querySelector('[aria-roledescription]'),
      })`)
    );
  }

  shell?.dispatch({ type: 'open-connections' });
  await new Promise((r) => setTimeout(r, 2500));

  const view = shell?.overlayContents;
  if (!view) return console.log('[probe] no overlay contents');

  // Target a tile that is NOT already added, so a successful click has a visible, checkable effect.
  const target = await view.executeJavaScript(`(() => {
    const tile = [...document.querySelectorAll('.grid-tile')].find(t => !t.classList.contains('is-added'));
    if (!tile) return { error: 'every catalog service is already added' };
    const r = tile.getBoundingClientRect();
    const cx = Math.round(r.left + r.width / 2), cy = Math.round(r.top + r.height / 2);
    const hit = document.elementFromPoint(cx, cy);
    return {
      name: tile.innerText.split('\\n')[0],
      cx, cy,
      // If this isn't the tile or one of its children, something is covering it in the DOM.
      topmostAtCentre: hit ? hit.className || hit.tagName : null,
      hitIsInsideTile: !!hit && tile.contains(hit),
    };
  })()`);
  console.log('[probe] target tile:', JSON.stringify(target));

  if (typeof target?.cx !== 'number') {
    // Nothing left to add is a valid state — don't let it skip the rest of the probe.
    shell?.dispatch({ type: 'close-overlay' });
    await probeNotifications();
    return;
  }

  // A REAL input event. element.click() bypasses hit-testing entirely, so it can't distinguish
  // "handler wired" from "view actually receives mouse input" — which is the question here.
  const point = { x: target.cx, y: target.cy, button: 'left' as const, clickCount: 1 };
  view.sendInputEvent({ type: 'mouseMove', x: point.x, y: point.y });
  view.sendInputEvent({ type: 'mouseDown', ...point });
  view.sendInputEvent({ type: 'mouseUp', ...point });
  console.log(`[probe] sent real mouseDown/Up at ${point.x},${point.y} on "${target.name}"`);

  // The actual regression test: reopen the picker and confirm the service just added now reads as
  // added. Before the broadcast + nonce fix this showed the snapshot from the first open forever.
  await new Promise((r) => setTimeout(r, 1500));
  shell?.dispatch({ type: 'open-connections' });
  await new Promise((r) => setTimeout(r, 1200));

  const after = await view.executeJavaScript(`(() => {
    const tile = [...document.querySelectorAll('.grid-tile')]
      .find(t => t.innerText.startsWith(${JSON.stringify(target.name)}));
    return { name: ${JSON.stringify(target.name)}, text: tile?.innerText.replace('\\n', ' / ') ?? 'MISSING' };
  })()`);
  console.log('[probe] on reopen:', JSON.stringify(after));
  shell?.dispatch({ type: 'close-overlay' });

  await probeNotifications();
}

/**
 * Fires a real `new Notification()` inside a *background* service and checks the count lands.
 * Runs in the page, through the wrapped constructor, so it exercises the whole path rather than
 * calling handleNotification directly.
 */
/**
 * Verifies the push interception from *inside the page's world*, which is the only place it's
 * observable. The Phase 3.1 notification override typechecked, reviewed clean, and was a silent
 * no-op for exactly this reason — the preload's `window` is not the page's.
 */
/**
 * The A4 regression. ⌘W on the last pane destroys the window; the dock icon rebuilds it. Everything
 * system-level used to keep a closure over the destroyed window and throw from then on.
 */
async function probeTeardown(): Promise<void> {
  const before = process.memoryUsage().rss;
  const viewsBefore = shell ? shell.serviceCount : 0;

  shell?.win.close();
  await new Promise((r) => setTimeout(r, 1500));
  console.log(`[probe] after close: shell=${shell === null ? 'null (disposed)' : 'STILL SET'}`);

  app.emit('activate');
  await new Promise((r) => setTimeout(r, 3000));
  if (!shell) return console.log('[probe] activate did not rebuild the window');

  // The three that used to throw `Object has been destroyed`.
  const results: string[] = [];
  try {
    shell.dispatch({ type: 'show-window' });
    results.push('show-window ok');
  } catch (e) {
    results.push(`show-window THREW: ${e}`);
  }
  try {
    shell.dispatch({ type: 'open-settings' });
    results.push('settings ok');
  } catch (e) {
    results.push(`settings THREW: ${e}`);
  }
  const after = process.memoryUsage().rss;
  console.log(
    `[probe] teardown: views ${viewsBefore}->${shell.serviceCount}, ` +
      `rss ${(before / 1e6).toFixed(0)}MB->${(after / 1e6).toFixed(0)}MB, ${results.join(', ')}`
  );
}

async function probePush(): Promise<void> {
  const state = shell?.state();
  const target = state?.services.find((s) => !s.sleeping);
  if (!target) return console.log('[probe] no loaded service to test push against');
  const wc = shell?.contentsForService(target.id);
  if (!wc) return;

  const result = await wc.executeJavaScript(`(async () => {
    const proto = window.PushManager && window.PushManager.prototype;
    if (!proto) return { error: 'no PushManager in this page' };
    const out = {
      patchedSubscribe: proto.subscribe.toString().includes('subscribePush'),
      bridge: typeof (window.__hangar && window.__hangar.subscribePush),
      permissionState: await proto.permissionState.call({}),
    };
    // Push is off by default, so this must resolve to null and NOT throw — the page falls back to
    // its own subscribe on null, and would break outright on a rejection.
    try {
      out.bridgeReturns = await window.__hangar.subscribePush('test-vapid-key');
    } catch (e) {
      out.bridgeThrew = String(e);
    }
    return out;
  })()`);
  console.log('[probe] push:', JSON.stringify(result));
}

async function probeNotifications(): Promise<void> {
  await new Promise((r) => setTimeout(r, 800));

  // On a fresh start every non-visible service is also unloaded, so there's nothing in the state
  // we need. Split to load a second service, then close that pane: closing detaches the view but
  // keeps it alive, which is exactly "loaded but not on screen".
  shell?.dispatch({ type: 'split' });
  await new Promise((r) => setTimeout(r, 2500));
  const split = shell?.state();
  const second = split?.panes[1];
  if (second) shell?.dispatch({ type: 'close-pane', paneId: second.id });
  await new Promise((r) => setTimeout(r, 800));

  const state = shell?.state();
  const visible = new Set(state?.panes.map((p) => p.serviceId));
  const background = state?.services.find((s) => !visible.has(s.id) && !s.sleeping);
  if (!background) return console.log('[probe] no background service to notify');

  const wc = shell?.contentsForService(background.id);
  if (!wc) return console.log('[probe] background service has no view');

  await wc.executeJavaScript(`new Notification('Probe', { body: 'hello' }); true`);
  await new Promise((r) => setTimeout(r, 600));

  const after = shell?.state().services.find((s) => s.id === background.id);
  console.log(
    `[probe] notified "${background.name}": unread ${background.unread} -> ${after?.unread}` +
      ` (badge ${app.getBadgeCount?.() ?? 'n/a'})`
  );

  await probePush();
  await probeTeardown();
}

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
