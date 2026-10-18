import { test, expect } from '@playwright/test';
import { launch, seedConfig, tearDown, type Harness } from './harness';

let h: Harness;
test.afterEach(async ({}, testInfo) => tearDown(h, testInfo));

type Shell = {
  dispatch: (command: unknown) => boolean;
  win: { hide: () => void; show: () => void };
  services: { get: (id: string) => { view: { webContents: {
    getBackgroundThrottling: () => boolean;
    isCurrentlyAudible: () => boolean;
  } } } | undefined };
  state: () => { allServices: Array<{ id: string; conversations?: Array<{ id: string; name: string; unread: number }> }> };
};

const dispatch = (command: unknown) => h.app.evaluate((_electron, c) =>
  (globalThis as never as { __hangarShell: Shell }).__hangarShell.dispatch(c), command);

const throttling = () => h.app.evaluate(() => {
  const shell = (globalThis as never as { __hangarShell: Shell }).__hangarShell;
  return ['one', 'two'].map((id) => shell.services.get(id)?.view.webContents.getBackgroundThrottling());
});

test('off-screen services throttle; showing the window and playing sound keep the right pages running', async () => {
  h = await launch();
  await h.rail();
  await dispatch({ type: 'focus-service', serviceId: 'two' });
  await expect.poll(throttling).toEqual([true, false]);

  await h.app.evaluate(() => (globalThis as never as { __hangarShell: Shell }).__hangarShell.win.hide());
  await expect.poll(throttling).toEqual([true, true]);
  await h.app.evaluate(() => (globalThis as never as { __hangarShell: Shell }).__hangarShell.win.show());
  await expect.poll(throttling).toEqual([true, false]);

  // A test machine needn't have an audio device. Exercise the real window events and policy
  // with only Chromium's audibility query stubbed, as in staying-awake.spec.ts.
  await h.app.evaluate(() => {
    const shell = (globalThis as never as { __hangarShell: Shell }).__hangarShell;
    shell.services.get('one')!.view.webContents.isCurrentlyAudible = () => true;
    shell.win.hide();
  });
  await expect.poll(throttling).toEqual([false, true]);
  await h.app.evaluate(() => {
    const shell = (globalThis as never as { __hangarShell: Shell }).__hangarShell;
    shell.services.get('one')!.view.webContents.isCurrentlyAudible = () => false;
  });
});

test('the conversation bridge reads an off-screen chat and opens its row through the command handler', async () => {
  h = await launch((origin) => {
    const config = seedConfig(origin);
    config.services[0]!.catalogId = 'slack';
    config.services[0]!.url = `${origin}/badge`;
    return config;
  });
  await h.rail();
  await expect.poll(() => h.app.evaluate(({ webContents }) =>
    webContents.getAllWebContents().some((wc) => wc.getURL().endsWith('/badge') && !wc.isLoading()),
  )).toBe(true);
  await h.app.evaluate(async ({ webContents }) => {
    const page = webContents.getAllWebContents().find((wc) => wc.getURL().endsWith('/badge'))!;
    await page.executeJavaScript(`
      document.body.innerHTML = '<div data-qa-channel-sidebar-channel-id="C-demo"><a class="p-channel_sidebar__channel p-channel_sidebar__channel--unread"><span class="p-channel_sidebar__name">feature-review</span><span class="p-channel_sidebar__badge">2</span></a></div>';
      document.querySelector('a').addEventListener('click', () => { document.body.dataset.opened = 'C-demo'; });
    `);
  });
  await dispatch({ type: 'focus-service', serviceId: 'two' });
  const chats = () => h.app.evaluate(() =>
    (globalThis as never as { __hangarShell: Shell }).__hangarShell.state().allServices.find((s) => s.id === 'one')?.conversations,
  );
  await expect.poll(chats, { timeout: 15_000 }).toMatchObject([{ id: 'C-demo', name: 'feature-review', unread: 2 }]);
  await dispatch({ type: 'open-conversation', serviceId: 'one', conversationId: 'C-demo' });
  await expect.poll(() => h.app.evaluate(async ({ webContents }) =>
    webContents.getAllWebContents().find((wc) => wc.getURL().endsWith('/badge'))?.executeJavaScript('document.body.dataset.opened'),
  )).toBe('C-demo');
  await expect.poll(throttling).toEqual([false, true]);
});
