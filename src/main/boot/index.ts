import { app, dialog, ipcMain, nativeTheme, powerMonitor } from 'electron';
import { installLogGuards } from '@main/platform/logging';
import { persistAll, startMaintenance } from '@main/boot/maintenance';
import { setUpLogFile, sinceLaunch } from '@main/platform/log-file';
import { flushConfig, loadConfig } from '@main/platform/config';
import { installIconProtocol, registerIconScheme } from '@main/features/icons';
import { installMenu } from '@main/boot/menu';
import { DEFAULT_BINDINGS } from '@core/keyboard/keymap';
import { applyUserAgent } from '@main/platform/ua';
import { beginQuit, isQuitting } from '@main/platform/quit-state';
import { releaseGlobalShortcut } from '@main/platform/system';
import { AppWindow } from '@main/window/app-window';
import { setNotificationClickRoute } from '@main/window/attention';
import { isInternalSender } from '@main/platform/renderer-url';
import { commandProblem, isCommand } from '@core/commands';
import { redactUrl } from '@core/runtime/urls';

/**
 * Process entry point. Owns boot order, the single-instance lock, the IPC surface and quitting.
 * The background loops — session durability, the sweeps, suspend and resume — start here and live
 * in boot/maintenance.ts.
 *
 * Boot order is load-bearing and documented in docs/architecture.md — `app.setName` before the
 * menu, `registerIconScheme` before app-ready, and `applyUserAgent` first thing *inside*
 * whenReady, before any session or view exists.
 */

// Before anything that logs, which is nearly everything below. A terminal that goes away while the
// app is running turns every subsequent log line into a fatal EPIPE — see the module.
installLogGuards();
setUpLogFile();

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

/**
 * `Hangar --quit` asks the running copy to quit, without the confirm dialog, and exits.
 *
 * For `scripts/install-local.mjs`, which has to replace the bundle of a copy that is usually the
 * launchd job. Killing it would count as an unsuccessful exit and launchd would start it again
 * mid-copy; a graceful quit exits 0, and still promotes session cookies on the way out. AppleScript
 * `quit` is graceful too, but goes through `confirmQuit` and so stops on a dialog.
 *
 * Carried as the lock's `additionalData` rather than parsed out of the forwarded argv, because it
 * is ours to shape and Chromium's switch handling is not.
 */
const quitRequested = process.argv.includes('--quit');

// A second copy fighting over the same partitions would corrupt cookie jars, so hand off to the
// running instance instead.
const gotLock = app.requestSingleInstanceLock({ quit: quitRequested });
console.log(`[boot] single-instance lock: ${gotLock ? 'acquired' : 'denied — handing off and quitting'}`);
if (!gotLock || quitRequested) {
  // `app.quit()` before app-ready doesn't stop this module executing — everything below still
  // registered, and a second copy briefly raced the first over the same partitions, which is
  // exactly what corrupts a cookie jar. Exit outright instead.
  //
  // `--quit` with the lock acquired means nothing was running to quit, and booting the whole app
  // in answer to "quit" would be exactly backwards.
  app.exit(0);
}

// Must precede app-ready, hence not inside whenReady with the rest of the setup.
registerIconScheme();

/**
 * The one way to put a window in front of the user: build one if there is none, then show it.
 *
 * `showWindow()`, never a bare `focus()`. Under `closeToTray` the window is *hidden* rather than
 * minimized, and focusing a hidden window does nothing visible — which is how a Dock click, a
 * Finder double-click and a Spotlight launch all came to look like the app had died while it sat
 * there running (decision #96). `activate` and `second-instance` both land here so that the two can
 * never drift apart again: they did once, when only one of them was fixed.
 */
// A banner click lands on the service whether or not the window that raised it still exists.
setNotificationClickRoute((serviceId) => {
  ensureShell();
  shell?.dispatch({ type: 'focus-service', serviceId });
});

function ensureShell(): void {
  if (!shell) {
    shell = new AppWindow();
    trackWindow(shell);
    publishTestHandle();
    // Re-apply, or a rebuilt window has no global shortcut, no tray and no proxy. This was called
    // once at boot and never again, so everything system-level died with the first ⌘W.
    shell.applySystemPreferences();
  }
  shell.showWindow();
}

/**
 * `mailto:` links, once Hangar is the default email app. macOS can deliver one before the app is
 * ready — clicking an address launches Hangar to handle it — so it waits for a window.
 */
let pendingMailto: string | null = null;
app.on('open-url', (event, url) => {
  if (!/^mailto:/i.test(url)) return;
  event.preventDefault();
  if (shell && app.isReady()) shell.openMailto(url);
  else pendingMailto = url;
});

app.on('second-instance', (_event, _argv, _cwd, additionalData) => {
  if ((additionalData as { quit?: unknown } | null)?.quit === true) {
    console.log('[boot] --quit from a second instance');
    quitGracefully({ confirm: false });
    return;
  }
  // Before ready there is nothing to show and nothing safe to build; the window is about to appear
  // anyway, since nothing hides it at boot any more.
  if (app.isReady()) ensureShell();
});

app.whenReady().then(() => {
  console.log(`[boot] ready at ${sinceLaunch()}ms`);
  // First, before any session or view exists. See ua.ts for why this is the whole UA story.
  applyUserAgent();
  const config = loadConfig();
  nativeTheme.themeSource = config.preferences.appearance.theme;
  installIconProtocol(() => loadConfig().services);

  // Every route back to the window, and every IPC handler, is registered *before* the window is
  // built. They were registered after it, so a throw anywhere in construction or in
  // `applySystemPreferences` — `new Tray()` included — left a Dock icon that did nothing and a rail
  // whose `shell:get-state` had no handler: a blank window with no way to recover it.
  app.on('activate', () => ensureShell());
  registerIpc();

  // GPU, network service, utilities. Chromium restarts them itself, and the only trace used to be a
  // bare line from Chromium's own logging — this says which, why, and with what exit code.
  app.on('child-process-gone', (_event, details) => {
    if (details.reason === 'clean-exit') return;
    console.warn(
      `[process] ${details.name ?? details.type} ${details.reason} (exit ${details.exitCode})`,
    );
  });

  shell = new AppWindow();
  console.log(`[boot] window built at ${sinceLaunch()}ms`);
  trackWindow(shell);
  publishTestHandle();
  // The bindings are read on every rebuild rather than captured, so `refreshMenu` after a rebind
  // redraws against the new map without this call site knowing anything about it.
  //
  // `show-window` is answered here rather than by the shell, because the menu outlives it: after ⌘W
  // with close-to-tray off there is no shell to dispatch to, and "Show Hangar" has to build one.
  installMenu(
    (command) => {
      if (command.type !== 'show-window') return shell?.dispatch(command) ?? false;
      ensureShell();
      return true;
    },
    () => loadConfig().preferences.keyboard?.bindings ?? DEFAULT_BINDINGS
  );
  shell.applySystemPreferences();
  if (pendingMailto) {
    shell.openMailto(pendingMailto);
    pendingMailto = null;
  }
})
  // Logged by name. Unhandled, a throw anywhere in startup was a bare "unhandled rejection" line
  // with nothing to say it was the app failing to come up.
  .catch((err: unknown) => console.error('[boot] startup failed:', err));

/**
 * The app's own channels answer only the app's own screens.
 *
 * `shell:command` can do anything a person can in Settings — add a service, point sync at a repo,
 * give Gmail custom JavaScript — and it used to answer any sender at all. The screens that hold
 * the bridge are locked to this renderer now (`loadRoute`), and this is the second half: a frame
 * showing anything else is ignored, and says so in the log.
 */
function fromApp(event: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent, channel: string): boolean {
  if (isInternalSender(event)) return true;
  // Redacted: a sign-in page's URL carries `login_hint` and nonces in its query.
  const from = event.senderFrame ? redactUrl(event.senderFrame.url).slice(0, 80) : 'a closed frame';
  console.warn(`[ipc] ignored ${channel} from ${from}`);
  return false;
}

/**
 * Whether a service message comes from the error or blocked page main put in the pane, rather than
 * from the service's own page. Those pages are `data:` URLs we wrote; "Allow this host" and "Try
 * again" are their buttons, and a page's own script has no business pressing them.
 */
const fromRecoveryPage = (event: Electron.IpcMainEvent): boolean =>
  event.senderFrame?.url.startsWith('data:') === true;

function registerIpc(): void {
  ipcMain.handle('shell:get-state', (event) =>
    fromApp(event, 'shell:get-state') ? (shell?.stateFor(event.sender) ?? null) : null,
  );
  ipcMain.handle('overlay:get-mode', (event) =>
    fromApp(event, 'overlay:get-mode') ? (shell?.overlayOpen ?? null) : null,
  );
  // Memory readout for Settings, so the hibernation setting has a visible consequence.
  ipcMain.handle('app:metrics', (event) => {
    if (!fromApp(event, 'app:metrics')) return null;
    const metrics = app.getAppMetrics();
    return {
      processes: metrics.length,
      residentMb: Math.round(
        metrics.reduce((sum, m) => sum + (m.memory?.workingSetSize ?? 0), 0) / 1024
      ),
    };
  });
  ipcMain.on('shell:command', (event, command: unknown) => {
    if (!fromApp(event, 'shell:command')) return;
    // Shape-checked before it reaches dispatch — see core/commands.ts.
    if (!isCommand(command)) {
      console.warn(`[command] refused: ${commandProblem(command)}`);
      return;
    }
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
    if (!fromRecoveryPage(event)) return;
    const serviceId = shell?.serviceIdForContents(event.sender);
    if (serviceId) shell?.retryService(serviceId);
  });

  // No payload: the host comes from what main last blocked for this sender's service. See the
  // preload's allowHost for why the page is not allowed to name it.
  ipcMain.on('service:allow-host', (event) => {
    if (!fromRecoveryPage(event)) return;
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
}

// Session durability, the background sweeps, and suspend/resume. See boot/maintenance.ts.
startMaintenance(() => shell);

/**
 * How long a quit waits for cookie promotion before going anyway.
 *
 * Unbounded, a `cookies.get` or `flushStore` that stalls — the log has network-service crashes in
 * it — meant ⌘Q never finished, and the user's next move was Force Quit. Under the LaunchAgent
 * that is an unsuccessful exit, so launchd started it straight back up. A normal promotion takes
 * tens of milliseconds; three seconds is generous and still reads as "quitting", not "hung".
 */
const QUIT_PERSIST_TIMEOUT_MS = 3_000;

/**
 * Quit, promoting session cookies first. Returns without quitting if the user cancels the confirm.
 *
 * `confirm: false` is for `--quit`, which a script sends: there is no one there to click the
 * dialog, and a dialog nobody answers is a quit that never happens.
 */
function quitGracefully({ confirm }: { confirm: boolean }): void {
  if (isQuitting()) return;

  if (confirm && loadConfig().preferences.behaviour.confirmQuit) {
    const response = dialog.showMessageBoxSync({
      type: 'question',
      buttons: ['Quit', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      message: 'Quit Hangar?',
    });
    // Cancelling must leave the app fully usable — no half-quit state.
    if (response !== 0) return;
  }

  // Tells the window's close handler this is a real quit, not a close-to-tray.
  beginQuit();
  releaseGlobalShortcut();
  // persistAll MUST finish before anything tears down sessions. It promotes session cookies to
  // persistent ones, which is the whole reason you stay signed in across a restart — disposing
  // first would sign the user out of everything, the exact failure Phase 1 exists to prevent.
  //
  // "Finish" is bounded, though: see QUIT_PERSIST_TIMEOUT_MS. The minute-by-minute loop has already
  // promoted everything older than a minute, so a timeout here loses at most that last minute.
  const timeout = new Promise<void>((resolve) =>
    setTimeout(() => {
      console.warn(`[quit] cookie promotion still running after ${QUIT_PERSIST_TIMEOUT_MS}ms — quitting anyway`);
      resolve();
    }, QUIT_PERSIST_TIMEOUT_MS).unref()
  );
  void Promise.race([persistAll(), timeout])
    .catch((err) => console.error('[quit] cookie promotion failed:', err))
    .finally(() => {
      // Guarded, because a throw here skips the line after it: a failed write (a full disk, a
      // profile deleted underneath us) left `app.quit()` uncalled and the app half-quit for good —
      // the Force Quit this function exists to prevent. `process.on('exit')` flushes once more.
      try {
        flushConfig();
      } catch (err) {
        console.error('[quit] could not write pending config changes:', err);
      }
      app.quit();
    });
}

/**
 * Logout, restart or shutdown. "Confirm before quitting" is for ⌘Q, where a dialog saves you from a
 * slip of the finger; asking during a logout just stops the logout, with macOS reporting that
 * Hangar cancelled it. The system is ending the session, so quit the way `--quit` does.
 */
let systemEnding = false;
powerMonitor.on('shutdown', () => {
  systemEnding = true;
  console.log('[power] the session is ending — quitting without asking');
  quitGracefully({ confirm: false });
});

app.on('before-quit', (event) => {
  // The second pass — `app.quit()` from `quitGracefully` itself — is let through.
  if (isQuitting()) return;
  event.preventDefault();
  quitGracefully({ confirm: !systemEnding });
});

// macOS convention: closing the window doesn't quit. Also avoids Electron's default
// "last window closed → quit", which fires when panes are torn down during a relayout.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
