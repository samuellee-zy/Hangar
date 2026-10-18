import AxeBuilder from '@axe-core/playwright';
import { test, expect } from '@playwright/test';
import { launch, seedConfig, tearDown, type Harness } from './harness';

let h: Harness;
test.afterEach(async ({}, info) => tearDown(h, info));
type Shell = { __hangarShell: { dispatch(c: unknown): void; win: { setSize(w: number, h: number): void }; services: { get(id: string): { view: { webContents: { getBackgroundThrottling(): boolean } } } }; inboxHub: { snapshot: () => unknown; refresh: () => Promise<void>; read: () => Promise<unknown> } } };
const dispatch = async (c: unknown) => h.app.evaluate((_electron, command) => (globalThis as never as Shell).__hangarShell.dispatch(command), c);

test('Inbox: native destination, scope, preview, keyboard, resize and safe return to apps', async () => {
  h = await launch((origin) => seedConfig(origin, { preferences: { appearance: { paneHeaders: true } } }));
  const rail = await h.rail();
  await rail.getByRole('button', { name: 'Unified inbox' }).click();
  await expect.poll(() => h.app.windows().some((p) => p.url().endsWith('#inbox'))).toBe(true);
  const page = h.app.windows().find((p) => p.url().endsWith('#inbox'))!;
  await expect(page.getByRole('heading', { name: /^Inbox/ })).toBeVisible();
  await expect.poll(() => h.app.evaluate(() => (globalThis as never as Shell).__hangarShell.services.get('one').view.webContents.getBackgroundThrottling())).toBe(true);
  const denied = await rail.evaluate(() => window.hangar.inbox.snapshot({ allWorkspaces: true }));
  expect(denied.ok).toBe(false);
  await page.getByRole('button', { name: 'Connections', exact: true }).click();
  await expect(page.getByText(/Limited page preview/).first()).toBeVisible();
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    expect((await new AxeBuilder({ page }).setLegacyMode().analyze()).violations).toEqual([]);
  }
  await h.app.evaluate(() => (globalThis as never as Shell).__hangarShell.win.setSize(720, 650));
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole('button', { name: 'Back to apps' }).click();
  await expect.poll(() => h.app.evaluate(() => (globalThis as never as Shell).__hangarShell.services.get('one').view.webContents.getBackgroundThrottling())).toBe(false);
  await dispatch({ type: 'open-inbox' });
  await expect(page.getByRole('heading', { name: /^Inbox/ })).toBeVisible();
  await rail.getByRole('button', { name: /^Two/ }).click();
  await expect.poll(() => h.app.evaluate(() => (globalThis as never as Shell).__hangarShell.services.get('two').view.webContents.getBackgroundThrottling())).toBe(false);
});

test('Inbox: source-labelled conversations and plain-text thread reader work at desktop and compact widths', async () => {
  h = await launch();
  await h.rail();
  // Synthetic connector results exercise the real native surface; no account or message fixture
  // is installed in production, and no credential/network request is made by this test.
  await h.app.evaluate(() => {
    const hub = (globalThis as never as Shell).__hangarShell.inboxHub;
    hub.refresh = async () => {};
    hub.snapshot = () => ({ workspaceId: 'w1', workspaceName: 'Work', sources: [
      { id: 's', serviceId: 'one', kind: 'slack', app: 'Slack', label: 'Product', identity: 'sam · Product team', state: 'ready', detail: 'Recent conversations; read state unknown.', updatedAt: Date.now(), canSearch: true, canRead: true, hasMore: false },
      { id: 'g', serviceId: 'two', kind: 'gmail', app: 'Gmail', label: 'Work', identity: 'sam@example.com', state: 'ready', detail: 'Recent inbox threads.', updatedAt: Date.now(), canSearch: true, canRead: true, hasMore: false },
    ], items: [
      { id: 'm1', ref: { connectionId: 's', threadId: 'C1:1.1' }, title: '#feature-launch', preview: 'The beta starts with a small group on Monday. We have the final scope ready for review.', author: 'Maya', at: Date.now(), unread: null, category: 'mentions', mention: true },
      { id: 'm2', ref: { connectionId: 'g', threadId: 'abc' }, title: 'Launch review · next steps', preview: 'Thanks for the walkthrough. Here are the three things we agreed to finish before beta.', author: 'Alex', at: Date.now() - 1200000, unread: true, category: 'email', mention: false },
    ] });
    hub.read = async () => ({ ref: { connectionId: 's', threadId: 'C1:1.1' }, title: '#feature-launch', partial: false, messages: [
      { id: '1', author: 'Maya', at: Date.now(), text: 'The beta starts with a small group on Monday.\n\nWe are keeping the first release focused on reading conversations and opening the original source. Replying can follow after we validate the workflow.' },
      { id: '2', author: 'Alex', at: Date.now(), text: 'Agreed. I will prepare the test accounts and share the checklist this afternoon.' },
    ] });
  });
  await dispatch({ type: 'open-inbox' });
  await expect.poll(() => h.app.windows().some((p) => p.url().endsWith('#inbox'))).toBe(true);
  const page = h.app.windows().find((p) => p.url().endsWith('#inbox'))!;
  await page.getByRole('button', { name: /#feature-launch The beta/ }).click();
  await expect(page.getByText(/I will prepare the test accounts/)).toBeVisible();
  await page.screenshot({ path: '/tmp/hangar-inbox-implemented.png' });
  expect((await new AxeBuilder({ page }).setLegacyMode().analyze()).violations).toEqual([]);
  await h.app.evaluate(() => (globalThis as never as Shell).__hangarShell.win.setSize(720, 650));
  await expect(page.getByText(/I will prepare the test accounts/)).toBeVisible();
  await page.screenshot({ path: '/tmp/hangar-inbox-compact.png' });
  await page.getByRole('region', { name: 'Messages', exact: true }).focus();
  await page.keyboard.press('End');
  expect((await new AxeBuilder({ page }).setLegacyMode().analyze()).violations).toEqual([]);
  await page.getByRole('button', { name: 'Back to conversation list' }).click();
  await expect(page.getByRole('button', { name: /Launch review/ })).toBeVisible();
  await page.getByRole('button', { name: 'Unread only' }).click();
  await expect(page.getByRole('button', { name: /#feature-launch The beta/ })).toHaveCount(0);
});
