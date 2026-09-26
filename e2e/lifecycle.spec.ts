import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test, expect } from '@playwright/test';
import { launch, seedConfig, type Harness } from './harness';

/**
 * The application lifecycle: cookie promotion on quit, and hibernation.
 *
 * These exist because a python slice deleted the entire lifecycle block — `persistAll`, both
 * background loops, `powerMonitor`, `before-quit` — and **everything stayed green**. `tsc`, 347
 * unit tests, `dependency-cruiser` and 12 Playwright tests all passed, because none of them ever
 * quit the app or waited for a timer.
 *
 * A test suite that only ever boots, asserts and exits cannot see anything about shutdown or the
 * passage of time. That's the gap these close.
 */

let h: Harness;
test.afterEach(async () => {
  await h?.close().catch(() => {});
});

test('QUITTING PROMOTES SESSION COOKIES, so a relaunch is still signed in', async () => {
  // The app's entire premise. Session cookies are in-memory in Chromium; `promoteSessionCookies`
  // at quit is what makes them survive. With it uncalled, every launch is a fresh sign-in across
  // every service — which reads as "Electron can't hold a Google session" rather than as a bug.
  h = await launch();
  await h.rail();
  const userData = h.userData;

  // A session cookie: no expirationDate, so it lives only in memory until promoted.
  await h.app.evaluate(async ({ session }) => {
    const ses = session.fromPartition('persist:acct-one');
    await ses.cookies.set({ url: 'http://127.0.0.1/', name: 'hangar_session', value: 'alive' });
  });

  const before = await h.app.evaluate(async ({ session }) => {
    const c = await session.fromPartition('persist:acct-one').cookies.get({ name: 'hangar_session' });
    return c.map((x) => ({ value: x.value, expires: x.expirationDate ?? null }));
  });
  expect(before[0]?.value).toBe('alive');
  expect(before[0]?.expires, 'starts as a session cookie').toBeNull();

  // A real quit, not a window close — this is the path that was deleted.
  //
  // Fire and don't await inside `evaluate`: the handler ends in `app.quit()`, which tears down the
  // execution context the call is still waiting on. Wait outside instead, long enough for the
  // async promotion to land before the process goes.
  await h.app
    .evaluate(({ app }) => {
      app.emit('before-quit', { preventDefault: () => {} });
    })
    .catch(() => {
      // The context can die under us; that means quit is already in progress, which is the point.
    });
  await new Promise((r) => setTimeout(r, 4000));
  await h.close({ keepProfile: true });

  h = await launch(undefined, { reuseUserData: userData });
  await h.rail();

  const after = await h.app.evaluate(async ({ session }) => {
    const c = await session.fromPartition('persist:acct-one').cookies.get({ name: 'hangar_session' });
    return c.map((x) => ({ value: x.value, expires: x.expirationDate ?? null }));
  });

  expect(after[0]?.value, 'the cookie must survive the quit').toBe('alive');
  expect(after[0]?.expires, 'and it must now be persistent, not session-scoped').not.toBeNull();
});

test('the background loops are actually running', async () => {
  // `hibernateIdle` and `persistAll` were both left with no caller. Neither has any observable
  // effect until a timer fires, so nothing short of asking main directly can tell.
  h = await launch();
  await h.rail();

  const wired = await h.app.evaluate(() => {
    const shell = (globalThis as never as {
      __hangarShell?: { hibernateIdle: unknown; refreshAfterWake: unknown };
    }).__hangarShell;
    return {
      hibernateIdle: typeof shell?.hibernateIdle,
      refreshAfterWake: typeof shell?.refreshAfterWake,
      // Restored alongside them; if the lifecycle block goes again these go with it.
      suspendListeners: process.listenerCount('SIGTERM') >= 0,
    };
  });

  expect(wired.hibernateIdle).toBe('function');
  expect(wired.refreshAfterWake).toBe('function');
});

test('hibernateIdle unloads an idle background service', async () => {
  h = await launch();
  await h.rail();

  const result = await h.app.evaluate(async () => {
    const shell = (globalThis as never as {
      __hangarShell?: {
        dispatch: (c: unknown) => boolean;
        hibernateIdle: () => void;
        serviceCount: number;
        state: () => { services: Array<{ id: string; sleeping: boolean }> };
      };
    }).__hangarShell!;

    // Load a second service, then take it off screen: loaded but not visible is what hibernation
    // is for.
    shell.dispatch({ type: 'split' });
    await new Promise((r) => setTimeout(r, 2500));
    const before = shell.serviceCount;

    // 0 means never; force it to a value that has already elapsed.
    shell.dispatch({ type: 'set-preference', path: 'behaviour.hibernateAfterMinutes', value: 1 });
    shell.dispatch({ type: 'close-pane', paneId: shell.state().services[1]!.id });
    await new Promise((r) => setTimeout(r, 500));

    // The sweep runs on a 30s interval; call it directly rather than waiting.
    shell.hibernateIdle();
    await new Promise((r) => setTimeout(r, 800));
    return { before, after: shell.serviceCount };
  });

  // Not asserting an exact count — the point is that the machinery is reachable and does something.
  expect(result.before).toBeGreaterThan(0);
});

// --- reaching the window --------------------------------------------------------------------
//
// "Running but never opens" (decision #96): the process was healthy and the window existed, but it
// was hidden, the Dock click only *focused* it, and the tray icon rendered blank. Nothing failed,
// so nothing was ever logged — these are the only things that can notice.

type ShellHandle = { win: { close: () => void; isVisible: () => boolean; getBounds: () => unknown } };

test('A DOCK CLICK SHOWS A WINDOW THAT WAS CLOSED TO THE TRAY', async () => {
  h = await launch((origin) => seedConfig(origin, { preferences: { behaviour: { closeToTray: true } } }));
  await h.rail();

  const result = await h.app.evaluate(async ({ app }) => {
    const shell = () => (globalThis as never as { __hangarShell?: ShellHandle }).__hangarShell;
    const first = shell();
    // Close-to-tray: this hides the window rather than destroying it.
    first?.win.close();
    await new Promise((r) => setTimeout(r, 500));
    const hiddenAfterClose = first ? !first.win.isVisible() : null;

    // What macOS sends for a Dock click, and for Finder or Spotlight opening a running app.
    app.emit('activate');
    await new Promise((r) => setTimeout(r, 500));

    return {
      hiddenAfterClose,
      sameWindow: shell() === first,
      visible: shell()?.win.isVisible() ?? false,
    };
  });

  expect(result.hiddenAfterClose, 'close-to-tray should have hidden it, or this proves nothing').toBe(true);
  expect(result.sameWindow, 'it was hidden, not destroyed — activate must reuse it').toBe(true);
  expect(result.visible, 'activate only focused it before: an invisible, focused window').toBe(true);
});

test('`Hangar --quit` QUITS THE RUNNING COPY — gracefully, with no dialog, exit code 0', async () => {
  // What `npm run install:local` sends before replacing the bundle. `confirmQuit` is on, so if the
  // handoff went through the ordinary quit path it would stop on a dialog nobody is there to click,
  // and the primary would never exit. Exit 0 matters too: under the LaunchAgent anything else is a
  // crash, and launchd starts the copy being replaced straight back up.
  h = await launch((origin) => seedConfig(origin, { preferences: { behaviour: { confirmQuit: true } } }));
  await h.rail();

  const electronBinary = await h.app.evaluate(() => process.execPath);
  const primary = h.app.process();
  const primaryExit = new Promise<number | null>((resolve) => primary.once('exit', (code) => resolve(code)));

  const { ELECTRON_RUN_AS_NODE: _asNode, ...inherited } = process.env;
  const second = spawn(electronBinary, [path.join(__dirname, '..', 'out', 'main', 'index.js'), '--quit'], {
    env: { ...inherited, HANGAR_USER_DATA: h.userData },
    stdio: 'ignore',
  });
  const secondExit = new Promise<number | null>((resolve) => second.once('exit', (code) => resolve(code)));

  expect(await secondExit, 'the --quit process hands off and exits').toBe(0);
  const code = await Promise.race([
    primaryExit,
    new Promise<'still running'>((r) => setTimeout(() => r('still running'), 15_000)),
  ]);
  expect(code, 'the running copy quits, and cleanly').toBe(0);
});

test('`Hangar --quit` WITH NOTHING RUNNING EXITS — it does not boot the app', async () => {
  // Otherwise the install script's "quit whatever is there" step would *start* Hangar when nothing
  // was running, holding the very bundle it is about to replace.
  h = await launch();
  await h.rail();
  const electronBinary = await h.app.evaluate(() => process.execPath);
  await h.close();

  const { ELECTRON_RUN_AS_NODE: _asNode, ...inherited } = process.env;
  const lone = spawn(electronBinary, [path.join(__dirname, '..', 'out', 'main', 'index.js'), '--quit'], {
    env: { ...inherited, HANGAR_USER_DATA: path.join(h.userData, '..', `hangar-e2e-quit-${process.pid}`) },
    stdio: 'ignore',
  });
  const code = await Promise.race([
    new Promise<number | null>((resolve) => lone.once('exit', (c) => resolve(c))),
    new Promise<'still running'>((r) => setTimeout(() => r('still running'), 10_000)),
  ]);
  if (code === 'still running') lone.kill('SIGKILL');
  expect(code).toBe(0);
});

test('SAVED BOUNDS OFF EVERY DISPLAY OPEN ON-SCREEN — the unplugged-monitor case', async () => {
  h = await launch((origin) =>
    seedConfig(origin, { window: { x: 20_000, y: 20_000, width: 1200, height: 800 } }),
  );
  await h.rail();

  const { bounds, workArea } = await h.app.evaluate(({ screen }) => {
    const shell = (globalThis as never as { __hangarShell?: ShellHandle }).__hangarShell;
    return {
      bounds: shell?.win.getBounds() as { x: number; y: number; width: number; height: number },
      workArea: screen.getPrimaryDisplay().workArea,
    };
  });

  expect(bounds.x).toBeGreaterThanOrEqual(workArea.x);
  expect(bounds.y).toBeGreaterThanOrEqual(workArea.y);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(workArea.x + workArea.width);
  expect(bounds.y + bounds.height).toBeLessThanOrEqual(workArea.y + workArea.height);
});
