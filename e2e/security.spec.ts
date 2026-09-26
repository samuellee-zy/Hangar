import { test, expect } from '@playwright/test';
import { launch, type Harness } from './harness';

/**
 * The app's own screens hold `window.hangar`, which can send any command there is. These check the
 * two halves of keeping that bridge to the app: a screen cannot be navigated anywhere else, and a
 * frame that isn't the app is not listened to.
 *
 * Unit tests cover the URL rules; only a real window can show that the guards are actually attached
 * to the views that need them — which is exactly what was missing before (§13.1, decision #97).
 */

let h: Harness;
test.afterEach(async () => {
  await h?.close();
});

test('THE RAIL CANNOT BE NAVIGATED OFF THE APP — a dropped link would hand it the bridge', async () => {
  h = await launch();
  const rail = await h.rail();
  const before = rail.url();

  // What a dropped link or a stray assignment does: a renderer-initiated navigation.
  await rail.evaluate((target) => {
    window.location.href = target;
  }, `${h.fixture.origin}/`);
  await new Promise((r) => setTimeout(r, 1000));

  expect(rail.url(), 'the rail must still be the app').toBe(before);
  expect(await rail.evaluate(() => typeof (window as { hangar?: unknown }).hangar)).toBe('object');
});

test('A SERVICE PAGE CANNOT SEND SHELL COMMANDS — IPC answers only the app\'s own frames', async () => {
  h = await launch();
  await h.rail();

  const before = await h.app.evaluate(() => {
    const shell = (globalThis as never as { __hangarShell?: { state: () => { services: unknown[] } } })
      .__hangarShell;
    return shell?.state().services.length ?? -1;
  });

  // Straight at the channel, the way a compromised renderer could, bypassing the preload's API.
  // The only frames we can script as "not the app" are service panes, so send from one.
  const pane = h.app.windows().find((w) => w.url().startsWith(h.fixture.origin));
  expect(pane, 'a service pane should be loaded').toBeTruthy();
  await h.app.evaluate(({ webContents, ipcMain }, origin) => {
    const wc = webContents.getAllWebContents().find((c) => c.getURL().startsWith(origin));
    // Main-side emit with the pane as the sender: exactly what an IPC message from it looks like.
    ipcMain.emit(
      'shell:command',
      { sender: wc, senderFrame: wc?.mainFrame },
      { type: 'add-custom-service', name: 'Injected', url: 'https://attacker.test/' },
    );
  }, h.fixture.origin);
  await new Promise((r) => setTimeout(r, 500));

  const after = await h.app.evaluate(() => {
    const shell = (globalThis as never as { __hangarShell?: { state: () => { services: unknown[] } } })
      .__hangarShell;
    return shell?.state().services.length ?? -1;
  });
  expect(after, 'the command from a service frame must be ignored').toBe(before);
});
