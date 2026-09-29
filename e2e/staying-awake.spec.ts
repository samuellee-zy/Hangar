import { test, expect } from '@playwright/test';
import { launch, seedConfig, tearDown, type Harness } from './harness';

/**
 * A service off screen is still in the middle of something: a Slack huddle in its own window, music
 * with no pane. Hibernation and "Sleep background services" unloaded it all the same, and putting
 * one to sleep, popping it out or quitting ended the call without a word. And "keep running" was
 * one service at a time.
 *
 * A call is the meeting probe's, against a page with Slack's Leave button in it (`/in-call`).
 * Sound is `isCurrentlyAudible`, stubbed: a test machine may have no audio device to be audible on.
 */

let h: Harness;
test.afterEach(async ({}, testInfo) => {
  await tearDown(h, testInfo);
});

type Shell = {
  dispatch: (command: unknown) => boolean;
  hibernateIdle: () => void;
  state: () => { allServices: Array<{ id: string; meeting?: { inCall: boolean } }> };
  services: { has: (id: string) => boolean; get: (id: string) => { lastActiveAt: number } | undefined };
};

/** Slack, in a call, as the first service; `two` as the second. */
const launchInCall = (over: Record<string, unknown> = {}) =>
  launch((origin) => {
    const config = seedConfig(origin, over) as ReturnType<typeof seedConfig> & { services: Array<Record<string, unknown>> };
    config.services[0] = { ...config.services[0], catalogId: 'slack', name: 'Slack', url: `${origin}/in-call` };
    return config;
  });

const dispatch = (command: unknown) =>
  h.app.evaluate((_electron, c) => (globalThis as never as { __hangarShell: Shell }).__hangarShell.dispatch(c), command);

const loaded = (id: string) =>
  h.app.evaluate((_electron, serviceId) => (globalThis as never as { __hangarShell: Shell }).__hangarShell.services.has(serviceId), id);

const inCall = () =>
  h.app.evaluate(
    () => (globalThis as never as { __hangarShell: Shell }).__hangarShell.state().allServices.find((s) => s.id === 'one')?.meeting?.inCall === true,
  );

/** Slack's page, loaded and probed into a call. */
async function slackInCall() {
  await h.rail();
  await expect.poll(inCall, { timeout: 10_000 }).toBe(true);
}

const endCall = () =>
  h.app.evaluate(async ({ webContents }) => {
    const slack = webContents.getAllWebContents().find((c) => c.getURL().endsWith('/in-call'));
    return slack?.executeJavaScript('window.endCall()', true);
  });

test('A SERVICE IN A CALL OFF SCREEN IS KEPT — by "Sleep background services" and by the idle sweep, until the call ends', async () => {
  h = await launchInCall({ preferences: { behaviour: { hibernateAfterMinutes: 1 } } });
  await slackInCall();
  // Off screen: the pane shows Two, and Slack runs on behind it.
  await dispatch({ type: 'focus-service', serviceId: 'two' });
  await expect.poll(() => loaded('two')).toBe(true);

  await dispatch({ type: 'sleep-others' });
  expect(await loaded('one'), '"Sleep background services" kept the call').toBe(true);
  await expect.poll(() => h.log()).toContain('[sleep] kept one: in a call');

  // Idle for as long as you like: long past the one-minute timeout.
  const sweep = () =>
    h.app.evaluate(() => {
      const shell = (globalThis as never as { __hangarShell: Shell }).__hangarShell;
      shell.services.get('one')!.lastActiveAt = 0;
      shell.hibernateIdle();
    });
  await sweep();
  expect(await loaded('one'), 'the idle sweep kept it too').toBe(true);

  // Out of the call, the same sweep sleeps it — so the call is what kept it.
  await endCall();
  await expect.poll(inCall).toBe(false);
  await sweep();
  expect(await loaded('one')).toBe(false);
});

test('A SERVICE PLAYING SOUND OFF SCREEN IS KEPT BY "Sleep background services"', async () => {
  h = await launch();
  await h.rail();
  await dispatch({ type: 'focus-service', serviceId: 'two' });
  await expect.poll(() => loaded('two')).toBe(true);
  await dispatch({ type: 'focus-service', serviceId: 'one' });

  const audible = (on: boolean) =>
    h.app.evaluate(async ({ webContents }, on) => {
      for (let i = 0; i < 50; i++) {
        const two = webContents.getAllWebContents().find((c) => c.getURL().endsWith('/unread'));
        if (two) return void (two.isCurrentlyAudible = () => on);
        await new Promise((r) => setTimeout(r, 100));
      }
      throw new Error('no page for Two');
    }, on);
  await audible(true);
  await dispatch({ type: 'sleep-others' });
  expect(await loaded('two')).toBe(true);
  await expect.poll(() => h.log()).toContain('[sleep] kept two: playing audio');

  await audible(false);
  await dispatch({ type: 'sleep-others' });
  await expect.poll(() => loaded('two')).toBe(false);
});

/** Answers the window's next questions with button `response` (0 goes ahead, 1 is Cancel), and keeps them. */
const answer = (response: number) =>
  h.app.evaluate(({ dialog }, response) => {
    const asked = ((globalThis as never as { __asked: string[] }).__asked ??= []);
    dialog.showMessageBox = (async (_window: unknown, options: { message: string }) => {
      asked.push(options.message);
      return { response, checkboxChecked: false };
    }) as never;
  }, response);
const asked = () => h.app.evaluate(() => (globalThis as never as { __asked?: string[] }).__asked ?? []);

test('PUTTING A SERVICE IN A CALL TO SLEEP ASKS FIRST — Cancel keeps the call', async () => {
  h = await launchInCall();
  await slackInCall();

  await answer(1);
  await dispatch({ type: 'sleep-service', serviceId: 'one' });
  await expect.poll(asked).toEqual(['Slack is in a call. Put it to sleep?']);
  expect(await loaded('one'), 'Cancel: still in the call').toBe(true);

  await answer(0);
  await dispatch({ type: 'sleep-service', serviceId: 'one' });
  await expect.poll(() => loaded('one')).toBe(false);
});

test('POPPING OUT A SERVICE IN A CALL ASKS FIRST — its window loads the page again, which ends the call', async () => {
  h = await launchInCall();
  await slackInCall();
  const windows = () => h.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().filter((w) => w.getTitle().includes('Slack')).length);

  await answer(1);
  await dispatch({ type: 'pop-out-service', serviceId: 'one' });
  await expect.poll(asked).toEqual(['Slack is in a call. Pop it out?']);
  expect(await windows(), 'Cancel: no window of its own').toBe(0);
  expect(await loaded('one'), 'and the call still up in the pane').toBe(true);

  await answer(0);
  await dispatch({ type: 'pop-out-service', serviceId: 'one' });
  await expect.poll(windows).toBe(1);
  expect(await asked(), 'asked once, not again by the sleep it does').toHaveLength(2);
  await expect.poll(() => loaded('one')).toBe(false);
});

test('QUITTING WITH A SERVICE IN A CALL ASKS, WHATEVER "Confirm before quitting" SAYS — and `--quit` never does', async () => {
  h = await launchInCall();
  await slackInCall();
  const primary = h.app.process();
  const exited = new Promise<number | null>((resolve) => primary.once('exit', (code) => resolve(code)));

  // ⌘Q, as the menu's Quit sends it: through `before-quit`. Cancelled.
  await h.app.evaluate(({ app, dialog }) => {
    const asked = ((globalThis as never as { __asked: string[] }).__asked = []);
    dialog.showMessageBoxSync = ((options: { message: string }) => {
      asked.push(options.message);
      return 1;
    }) as never;
    app.quit();
  });
  expect(await h.app.evaluate(() => (globalThis as never as { __asked: string[] }).__asked)).toEqual([
    'Slack is in a call. Quit Hangar?',
  ]);
  expect(await loaded('one'), 'Cancel leaves it running, call and all').toBe(true);

  // What `npm run install:local` sends: no one is there to answer, so it isn't asked.
  await h.app.evaluate(({ app }) => {
    app.emit('second-instance', {}, [], '', { quit: true });
  });
  expect(await exited, 'quit, cleanly, without a second question').toBe(0);
});

test('KEEP EVERY SERVICE RUNNING LOADS THE REST AT ONCE — one at a time, half a second apart', async () => {
  h = await launch((origin) => {
    const config = seedConfig(origin) as ReturnType<typeof seedConfig> & {
      services: Array<Record<string, unknown>>;
      workspaces: Array<{ items: Array<Record<string, unknown>> }>;
    };
    for (const id of ['three', 'four']) {
      config.services.push({ ...config.services[0], id, name: id, url: `${origin}/badge?${id}`, accountId: 'acct-one' });
      config.workspaces[0]!.items.push({ kind: 'service', id });
    }
    return config;
  });
  await h.rail();
  await expect.poll(() => loaded('one')).toBe(true);
  expect(await loaded('three'), 'not before it is asked for').toBe(false);

  // When each view is made, from main's side: the moment `ensure` built it.
  await h.app.evaluate(({ app }) => {
    const made = ((globalThis as never as { __made: Array<{ at: number; url: string }> }).__made = []);
    app.on('web-contents-created', (_event, wc) => {
      const at = Date.now();
      wc.once('did-start-navigation', (details) => made.push({ at, url: details.url }));
    });
  });
  await dispatch({ type: 'set-preference', path: 'behaviour.keepAllRunning', value: true });
  for (const id of ['two', 'three', 'four']) await expect.poll(() => loaded(id), { timeout: 10_000 }).toBe(true);

  const made = await h.app.evaluate(() => (globalThis as never as { __made: Array<{ at: number; url: string }> }).__made);
  const services = made.filter((m) => /\/(unread|badge)/.test(m.url)).map((m) => m.at);
  expect(services).toHaveLength(3);
  for (let i = 1; i < services.length; i++) {
    // Timers only ever run late, so a gap well under the stagger means there wasn't one.
    expect(services[i]! - services[i - 1]!, 'loaded one after another, not all at once').toBeGreaterThanOrEqual(400);
  }
});
