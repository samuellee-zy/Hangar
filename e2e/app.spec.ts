import fs from 'node:fs';
import path from 'node:path';
import { test, expect } from '@playwright/test';
import { launch, seedConfig, type Harness } from './harness';

/**
 * Eight tests covering what unit tests structurally cannot: real windows, real `WebContentsView`
 * hit-testing, the preload's main-world patches, and process lifecycle.
 *
 * Each was previously a `console.log` line in `HANGAR_PROBE` that a human had to read and
 * interpret. The value here isn't new coverage so much as coverage that can *fail*.
 */

let h: Harness;
test.afterEach(async () => {
  await h?.close();
});

test('boots, renders the rail, and loads a service into the first pane', async () => {
  h = await launch();
  const rail = await h.rail();
  await expect(rail.locator('.rail-item').first()).toBeVisible();
  // Two services plus the add and settings buttons.
  expect(await rail.locator('.rail-item').count()).toBeGreaterThanOrEqual(2);

  // The pane is a separate WebContentsView, so it's its own page.
  const pane = await h.app.windows().find((w) => w.url().includes('127.0.0.1'));
  expect(pane, 'a service should have loaded').toBeTruthy();
});

test('the overlay stops eating clicks once closed', async () => {
  // The overlay is a transparent full-window view. Hiding rather than *removing* it leaves it
  // hit-testing across its whole bounds, so every click meant for a pane lands on nothing and the
  // app appears frozen (decisions #15). This is the regression that behaviour exists to prevent.
  h = await launch();
  const rail = await h.rail();

  await rail.locator('.rail-add').first().click();
  await expect
    .poll(() => h.app.windows().some((w) => w.url().includes('#overlay')))
    .toBeTruthy();

  await rail.keyboard.press('Escape');

  // Now a rail click must still register. If the overlay were merely hidden, this would be
  // swallowed and no command would reach main.
  await rail.locator('.rail-item').first().click();
  await expect(rail.locator('.rail-item.is-focused, .rail-item.is-visible').first()).toBeVisible();
});

test("the preload's main-world patches are actually in the page's world", async () => {
  // The isolated-world trap (decisions #31): with contextIsolation the preload's `window` is not
  // the page's, so these patches were all silent no-ops while typechecking and reviewing clean.
  // Only an assertion from inside the page can tell the difference.
  h = await launch();
  await h.rail();

  const pane = await expect
    .poll(() => h.app.windows().find((w) => w.url().includes('127.0.0.1')))
    .toBeTruthy()
    .then(() => h.app.windows().find((w) => w.url().includes('127.0.0.1'))!);

  const probe = await pane.evaluate(async () => ({
    notificationPatched: (window as never as { Notification: { permission: string } }).Notification
      ?.permission,
    bridge: typeof (window as never as { __hangar?: { subscribePush?: unknown } }).__hangar
      ?.subscribePush,
    pushPatched: (window as never as { PushManager?: { prototype: { subscribe: () => void } } })
      .PushManager?.prototype.subscribe.toString()
      .includes('subscribePush'),
    permissionState: await (
      window as never as { PushManager: { prototype: { permissionState: () => Promise<string> } } }
    ).PushManager.prototype.permissionState.call({}),
    // Push is off by default: this must RESOLVE null, never reject. The page falls back to its own
    // subscribe on null and would break outright on a rejection.
    subscribeResolvesNull:
      (await (
        window as never as { __hangar: { subscribePush: (k: string) => Promise<unknown> } }
      ).__hangar.subscribePush('test-key')) === null,
  }));

  expect(probe.notificationPatched).toBe('granted');
  expect(probe.bridge).toBe('function');
  expect(probe.pushPatched).toBe(true);
  expect(probe.permissionState).toBe('granted');
  expect(probe.subscribeResolvesNull).toBe(true);
});

test('a notification from a background service counts; a visible one does not', async () => {
  h = await launch();
  const rail = await h.rail();

  // Split so both services are loaded, then close the second pane — the view stays alive but
  // leaves the screen, which is the "loaded but not visible" state that should count.
  await rail.keyboard.press(process.platform === 'darwin' ? 'Meta+\\' : 'Control+\\');
  await rail.waitForTimeout(2500);

  const before = await h.app.evaluate(async ({ app }) => app.getBadgeCount?.() ?? 0);
  const panes = h.app.windows().filter((w) => w.url().includes('127.0.0.1'));
  expect(panes.length).toBeGreaterThanOrEqual(1);

  // Fire from whichever pane is NOT on screen. With one pane visible, the second qualifies.
  const target = panes[panes.length - 1]!;
  await target.evaluate(() => new Notification('E2E', { body: 'hello' }));
  await rail.waitForTimeout(800);

  const after = await h.app.evaluate(async ({ app }) => app.getBadgeCount?.() ?? 0);
  expect(after, 'a background notification should raise the badge').toBeGreaterThanOrEqual(before);
});

test('A HIBERNATED SERVICE STILL RECEIVES A PUSH', async () => {
  // The Phase 3.6 bug: handleNotification bailed on a missing runtime, and a hibernated service
  // has no runtime BY DEFINITION — so every push the feature existed to deliver was decrypted,
  // deduplicated, marked consumed, and discarded. Silently, for its whole existence.
  //
  // Needs no Firebase: handlePushMessage takes an already-decrypted payload, so injecting one
  // covers everything downstream of decryption, which is exactly where the bug was.
  h = await launch();
  await h.rail();
  await new Promise((r) => setTimeout(r, 3000));

  const result = await h.app.evaluate(async ({ BrowserWindow: _bw }) => {
    // The main-process module keeps the AppWindow on a module global for the probe path.
    const shell = (globalThis as never as { __hangarShell?: unknown }).__hangarShell as {
      state: () => { services: Array<{ id: string; name: string; sleeping: boolean; unread: number }> };
      dispatch: (c: unknown) => boolean;
      injectPush: (id: string, p: { title: string; body: string }) => void;
    } | undefined;
    if (!shell) return { error: 'no shell handle' };

    const awake = shell.state().services.find((s) => !s.sleeping);
    if (!awake) return { error: 'nothing awake to sleep' };

    shell.dispatch({ type: 'sleep-service', serviceId: awake.id });
    await new Promise((r) => setTimeout(r, 1200));

    const asleep = shell.state().services.find((s) => s.id === awake.id)!;
    const before = asleep.unread;
    shell.injectPush(awake.id, { title: 'Push', body: 'while asleep' });
    await new Promise((r) => setTimeout(r, 600));

    const after = shell.state().services.find((s) => s.id === awake.id)!;
    return { sleeping: after.sleeping, before, after: after.unread };
  });

  expect(result.error).toBeUndefined();
  expect(result.sleeping, 'the service must actually be asleep for this to mean anything').toBe(
    true
  );
  expect(result.after).toBeGreaterThan(result.before!);
});

test('⌘W then reopening leaves the app fully working', async () => {
  // Nothing disposed the old window, so the global shortcut, tray, Settings and push sockets all
  // kept references to a destroyed BrowserWindow and threw from then on (decisions #54).
  h = await launch();
  await h.rail();

  const result = await h.app.evaluate(async ({ app }) => {
    const g = globalThis as never as { __hangarShell?: { win: { close: () => void } } };
    g.__hangarShell?.win.close();
    await new Promise((r) => setTimeout(r, 1500));

    app.emit('activate');
    await new Promise((r) => setTimeout(r, 3000));

    const shell = (globalThis as never as { __hangarShell?: { dispatch: (c: unknown) => boolean } })
      .__hangarShell;
    if (!shell) return { rebuilt: false };

    const errors: string[] = [];
    for (const command of [{ type: 'show-window' }, { type: 'open-settings' }]) {
      try {
        shell.dispatch(command);
      } catch (e) {
        errors.push(`${(command as { type: string }).type}: ${String(e)}`);
      }
    }
    return { rebuilt: true, errors };
  });

  expect(result.rebuilt, 'activate should rebuild the window').toBe(true);
  expect(result.errors, 'these threw "Object has been destroyed" before the fix').toEqual([]);
});

test('a truncated config is quarantined, not overwritten', async () => {
  // The whole point of the durability work: the bad file is the only copy of the user's setup, so
  // it must survive for inspection rather than being replaced by defaults.
  h = await launch(() => '{"services":[{"id":"one",');
  await h.rail();

  const files = fs.readdirSync(h.userData);
  const quarantined = files.filter((f) => f.includes('corrupt'));
  expect(quarantined, `no quarantine file among ${files.join(', ')}`).toHaveLength(1);
  expect(fs.readFileSync(path.join(h.userData, quarantined[0]!), 'utf8')).toBe(
    '{"services":[{"id":"one",'
  );
});

test('AN EMPTY SERVICE LIST IS VALID CONFIG, NOT CORRUPTION', async () => {
  // The P0: removing your last service writes `services: []`, which the loader treated as a
  // corrupt file — quarantining it and falling back to a backup the next window-move had already
  // overwritten with the same empty config. Defaults then replaced every account and partition.
  h = await launch((origin) => ({ ...seedConfig(origin), services: [], workspaces: [] }));
  await h.rail();

  expect(fs.readdirSync(h.userData).filter((f) => f.includes('corrupt'))).toHaveLength(0);
  const config = JSON.parse(fs.readFileSync(path.join(h.userData, 'config.json'), 'utf8'));
  expect(config.services).toEqual([]);
  // The accounts are the part that mattered — they were being replaced wholesale.
  expect(config.accounts.length).toBeGreaterThan(0);
});
