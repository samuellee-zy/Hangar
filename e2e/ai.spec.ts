import AxeBuilder from '@axe-core/playwright';
import { test, expect } from '@playwright/test';
import type { AiController } from '../src/main/ai/controller';
import type { ConnectorHub } from '../src/main/connectors/hub';
import type { AgentEngine } from '../src/main/ai/contracts';
import { launch, seedConfig, tearDown, type Harness } from './harness';

let h: Harness;
test.afterEach(async ({}, info) => tearDown(h, info));
type View = { getBounds(): { x: number; width: number } };
type Shell = { __hangarShell: { dispatch(c: unknown): void; win: { setSize(w: number, h: number): void }; inboxHub: ConnectorHub; aiController: AiController & { engines: Record<string, AgentEngine> }; services: { get(id: string): { view: View & { webContents: { getBackgroundThrottling(): boolean } } } }; aiSurface: { view: View; contents: { getURL(): string; sendInputEvent(event: { type: 'keyDown' | 'keyUp'; keyCode: string }): void } }; dragLayer: { view: View }; findBar: { isOpen: boolean }; opened?: unknown } };
const dispatch = async (c: unknown) => h.app.evaluate((_e, command) => (globalThis as unknown as Shell).__hangarShell.dispatch(command), c);

test('AI: native panel reserves space, denies unrelated IPC, respects compact layout and restores apps', async () => {
  h = await launch((origin) => seedConfig(origin, { preferences: { appearance: { paneHeaders: true } } }));
  const rail = await h.rail();
  await h.app.evaluate(() => (globalThis as unknown as Shell).__hangarShell.win.setSize(1400, 900));
  await rail.getByRole('button', { name: 'Search with AI' }).click();
  await expect.poll(() => h.app.windows().some((p) => p.url().endsWith('#ai'))).toBe(true);
  const page = h.app.windows().find((p) => p.url().endsWith('#ai'))!;
  await expect(page.getByRole('heading', { name: 'Ask AI' })).toBeVisible();
  expect((await rail.evaluate(() => window.hangar.ai.snapshot())).ok).toBe(false);
  expect((await page.evaluate(() => window.hangar.inbox.snapshot({ allWorkspaces: true }))).ok).toBe(false);
  for (const position of ['left', 'right', 'top', 'bottom']) {
    await dispatch({ type: 'set-preference', path: 'appearance.railPosition', value: position });
    await expect.poll(() => h.app.evaluate(() => {
      const view = (globalThis as unknown as Shell).__hangarShell.services.get('one').view;
      return view.getBounds().width;
    })).toBeLessThan(1000);
    expect(await h.app.evaluate(() => {
      const shell = (globalThis as unknown as Shell).__hangarShell;
      const pane = shell.services.get('one').view.getBounds(), panel = shell.aiSurface.view.getBounds();
      return pane.x + pane.width <= panel.x;
    })).toBe(true);
    expect((await new AxeBuilder({ page }).setLegacyMode().analyze()).violations).toEqual([]);
  }
  await dispatch({ type: 'set-preference', path: 'appearance.railPosition', value: 'left' });
  await dispatch({ type: 'begin-tile-drag', serviceId: 'two' });
  expect(await h.app.evaluate(() => {
    const shell = (globalThis as unknown as Shell).__hangarShell;
    const drag = shell.dragLayer.view.getBounds(), panel = shell.aiSurface.view.getBounds();
    return drag.x + drag.width === panel.x;
  })).toBe(true);
  await dispatch({ type: 'cancel-tile-drag' });
  await dispatch({ type: 'open-find' });
  expect(await h.app.evaluate(() => (globalThis as unknown as Shell).__hangarShell.findBar.isOpen)).toBe(true);
  await dispatch({ type: 'close-overlay' });
  expect(await h.app.evaluate(() => (globalThis as unknown as Shell).__hangarShell.findBar.isOpen)).toBe(false);
  await expect(rail.getByRole('button', { name: 'Search with AI' })).toHaveAttribute('aria-pressed', 'true');
  await h.app.evaluate(() => (globalThis as unknown as Shell).__hangarShell.win.setSize(720, 650));
  await expect.poll(() => h.app.evaluate(() => (globalThis as unknown as Shell).__hangarShell.services.get('one').view.webContents.getBackgroundThrottling())).toBe(true);
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole('button', { name: 'Close assistant' }).click();
  await expect.poll(() => h.app.evaluate(() => (globalThis as unknown as Shell).__hangarShell.services.get('one').view.webContents.getBackgroundThrottling())).toBe(false);
  await dispatch({ type: 'open-ai' });
  await page.getByLabel('Your question').focus();
  await h.app.evaluate(() => {
    const wc = (globalThis as unknown as Shell).__hangarShell.aiSurface.contents;
    wc.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
    wc.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
  });
  await expect(rail.getByRole('button', { name: 'Search with AI' })).toHaveAttribute('aria-pressed', 'false');
});

test('AI: real broker streams synthetic evidence, opens opaque citations and clears revoked results', async () => {
  h = await launch(); await h.rail();
  await h.app.evaluate(() => {
    const shell = (globalThis as unknown as Shell).__hangarShell;
    shell.win.setSize(1400, 1000);
    const ref = { connectionId: 'fixture', threadId: 'C1:1.1' };
    shell.inboxHub.snapshot = () => ({ workspaceId: 'w1', workspaceName: 'Work', sources: [
      { id: 'fixture', serviceId: 'one', kind: 'slack', app: 'Slack', label: 'Product', identity: 'sam · Product team', state: 'ready', detail: 'Synthetic test source', updatedAt: Date.now(), canSearch: true, canRead: true, hasMore: false },
    ], items: [] });
    shell.inboxHub.search = async () => [{ id: 'm1', ref, title: '#feature-launch', preview: 'The beta starts Monday.', author: 'Maya', at: Date.now(), unread: null, category: 'channels', mention: false }];
    shell.inboxHub.read = async () => ({ ref, title: '#feature-launch', partial: false, messages: [{ id: '1', author: 'Maya', text: 'Start with read-only inbox access. Beta is Monday. Alex owns the checklist.', at: Date.now() }] });
    shell.inboxHub.open = async (source) => { shell.opened = source; };
    shell.aiController.engines.codex = {
      id: 'codex', status: async () => ({ id: 'codex', name: 'Codex', state: 'ready', detail: 'Synthetic runtime · no network calls' }), login: async () => {}, logout: async () => {}, dispose: () => {},
      run: async (_request, broker, emit) => {
        await broker.call('hangar_search', { connectionId: 'fixture', query: 'feature launch' });
        await broker.call('hangar_read', { evidenceId: 'S1' });
        emit({ type: 'text', delta: 'The beta starts Monday, with read-only inbox access. [S1]\n\n' });
        emit({ type: 'text', delta: 'Alex owns the launch checklist. [S1]\n\nOpen question: the thread does not give a date for replying from the inbox.\n\nSearched Slack. Other app history was outside this search.' });
      },
    };
  });
  await dispatch({ type: 'open-ai' });
  await expect.poll(() => h.app.windows().some((p) => p.url().endsWith('#ai'))).toBe(true);
  const page = h.app.windows().find((p) => p.url().endsWith('#ai'))!;
  await page.getByRole('button', { name: 'Check runtime' }).click();
  await page.getByLabel('Your question').fill('Give me the decisions and open questions about the inbox feature.');
  await page.getByRole('button', { name: 'Search with Codex' }).click();
  await expect(page.getByText('Search complete', { exact: true })).toBeVisible();
  await expect(page.getByText(/Alex owns the launch checklist/)).toBeVisible();
  await page.getByRole('button', { name: 'Open source S1: #feature-launch' }).first().click();
  expect(await h.app.evaluate(() => (globalThis as unknown as Shell).__hangarShell.opened)).toEqual({ connectionId: 'fixture', threadId: 'C1:1.1' });
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    expect((await new AxeBuilder({ page }).setLegacyMode().analyze()).violations).toEqual([]);
  }
  await page.screenshot({ path: '/tmp/hangar-ai-implemented.png' });
  await h.app.evaluate(() => {
    const shell = (globalThis as unknown as Shell).__hangarShell;
    shell.inboxHub.snapshot = () => ({ workspaceId: 'w1', workspaceName: 'Work', sources: [], items: [] });
    shell.aiController.sourceChanged();
  });
  await expect(page.getByText(/Alex owns the launch checklist/)).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Search with Codex' })).toBeDisabled();
});
