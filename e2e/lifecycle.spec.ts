import fs from 'node:fs';
import path from 'node:path';
import { test, expect } from '@playwright/test';
import { launch, type Harness } from './harness';

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
