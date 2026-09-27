import { spawn } from 'node:child_process';
import path from 'node:path';
import { test, expect } from '@playwright/test';
import { launch, tearDown, type Harness } from './harness';

/**
 * `hangar://` links and the command line, through the real handlers: macOS's `open-url`, the
 * second-instance handoff, and a launch with flags. What a link may do is unit-tested
 * (deeplink.test.ts); these are about it arriving.
 *
 * The events are emitted by hand — an unpackaged build isn't registered for the scheme, and
 * shouldn't be — but through `app.emit`, so it's the app's own listeners that answer.
 */

let h: Harness;
test.afterEach(async ({}, testInfo) => {
  await tearDown(h, testInfo);
});

type Shell = { state: () => { panes: Array<{ serviceId: string }>; focusedPaneId: string | null } };

const focusedService = () =>
  h.app.evaluate(() => {
    const state = (globalThis as never as { __hangarShell: Shell }).__hangarShell.state();
    return state.panes.find((p) => (p as { id?: string }).id === state.focusedPaneId)?.serviceId ?? null;
  });

const dnd = () =>
  h.app.evaluate(() => {
    const state = (globalThis as never as {
      __hangarShell: { state: () => { preferences: { notifications: { dnd: boolean; dndUntil: number | null } } } };
    }).__hangarShell.state();
    return state.preferences.notifications;
  });

test('A HANGAR:// LINK FROM MACOS OPENS THE SERVICE IT NAMES — by name, as Shortcuts would write it', async () => {
  h = await launch();
  await h.rail();
  await expect.poll(focusedService).toBe('one');

  await h.app.evaluate(({ app }) => {
    app.emit('open-url', { preventDefault() {} }, 'hangar://open/Two');
  });
  await expect.poll(focusedService).toBe('two');

  // Not a verb it has: refused, and said so.
  await h.app.evaluate(({ app }) => {
    app.emit('open-url', { preventDefault() {} }, 'hangar://remove-service/two');
  });
  await expect.poll(() => h.log()).toContain('[link] ignored: there is no "remove-service"');
  await expect
    .poll(() =>
      h.app.evaluate(() =>
        (globalThis as never as { __hangarShell: { state: () => { services: unknown[] } } }).__hangarShell.state()
          .services.length,
      ),
    )
    .toBe(2);
});

test('A SECOND `Hangar --dnd on --for 30` HANDS ITS FLAGS TO THE RUNNING COPY, and exits', async () => {
  h = await launch();
  await h.rail();
  expect((await dnd()).dnd).toBe(false);

  // A real second process, as a script or a terminal would start one: it can't take the lock, so it
  // sends its flags with the handoff and goes.
  const electronBinary = await h.app.evaluate(() => process.execPath);
  const { ELECTRON_RUN_AS_NODE: _asNode, ...inherited } = process.env;
  const second = spawn(
    electronBinary,
    [path.join(__dirname, '..', 'out', 'main', 'index.js'), '--dnd', 'on', '--for', '30'],
    { env: { ...inherited, HANGAR_USER_DATA: h.userData }, stdio: 'ignore' },
  );
  const exited = await new Promise<number | null>((resolve) => second.once('exit', (code) => resolve(code)));
  expect(exited, 'the second copy hands off and exits').toBe(0);

  await expect.poll(async () => (await dnd()).dnd).toBe(true);
  const { dndUntil } = await dnd();
  expect(dndUntil! - Date.now()).toBeGreaterThan(29 * 60_000);
  expect(dndUntil! - Date.now()).toBeLessThanOrEqual(30 * 60_000);

  // And what it sent is checked for shape, not trusted: anything but a string is dropped.
  await h.app.evaluate(({ app }) => {
    app.emit('second-instance', {}, [], '', { links: [42, { type: 'remove-service' }, 'hangar://dnd/off'] });
  });
  await expect.poll(async () => (await dnd()).dnd).toBe(false);
});

test('FLAGS AT LAUNCH RUN ONCE THE WINDOW IS UP', async () => {
  h = await launch(undefined, { args: ['--open', 'two'] });
  await h.rail();
  await expect.poll(focusedService).toBe('two');
});
