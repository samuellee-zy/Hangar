import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { test, expect } from '@playwright/test';
import { launch, seedConfig, tearDown, type Harness } from './harness';

let h: Harness;
test.afterEach(async ({}, info) => { await tearDown(h, info); h = undefined!; });
// Only used inside the isolated fixture app; deliberately exposes internals to check actual lifetimes.
type Runtime = { view: { webContents: Electron.WebContents }; lastActiveAt: number; stale?: boolean };
type Shell = {
  dispatch(command: unknown): void;
  services: { get(id: string): Runtime | undefined; safeToDiscard(id: string): Promise<boolean> };
  loadQueue: { timeoutMs: number };
  hibernateIdle(): void;
  refreshAfterWake(ms: number): void;
  conversations: { timer: unknown };
  overlay: { idle: { delayMs: number }; contents: Electron.WebContents | null };
  aiSurface: { idle: { delayMs: number }; contents: Electron.WebContents | null };
  win: Electron.BaseWindow;
};
const command = (value: unknown) => h.app.evaluate((_e, c) => (globalThis as unknown as { __hangarShell: Shell }).__hangarShell.dispatch(c), value);
const loaded = (id: string) => h.app.evaluate((_e, id) => {
  const runtime = (globalThis as unknown as { __hangarShell: Shell }).__hangarShell.services.get(id);
  return !!runtime && !!runtime.view.webContents && !runtime.view.webContents.isDestroyed() && !runtime.view.webContents.isLoading();
}, id);
const sweep = () => h.app.evaluate(() => {
  const shell = (globalThis as unknown as { __hangarShell: Shell }).__hangarShell;
  shell.services.get('one')!.lastActiveAt = Date.now() - 600_000;
  shell.hibernateIdle();
});
async function setup() {
  h = await launch((origin) => seedConfig(origin, { preferences: { behaviour: { hibernateAfterMinutes: 5, maxCachedServices: 2 } } }));
  await h.rail(); await expect.poll(() => loaded('one')).toBe(true);
}

test('idle services really release web contents and return to their last URL', async () => {
  await setup();
  await h.app.evaluate(async () => {
    const wc = (globalThis as unknown as { __hangarShell: Shell }).__hangarShell.services.get('one')!.view.webContents;
    await wc.loadURL(new URL('/badge', wc.getURL()).href);
  });
  await command({ type: 'focus-service', serviceId: 'two' });
  await expect.poll(() => loaded('two')).toBe(true);
  await sweep();
  await expect.poll(() => loaded('one')).toBe(false);
  await command({ type: 'focus-service', serviceId: 'one' });
  await expect.poll(() => loaded('one')).toBe(true);
  expect(await h.app.evaluate(() => (globalThis as unknown as { __hangarShell: Shell }).__hangarShell.services.get('one')!.view.webContents.getURL())).toContain('/badge');
});

test('editing, capture and a beforeunload veto prevent automatic sleeping', async () => {
  await setup();
  await h.app.evaluate(async () => {
    const wc = (globalThis as unknown as { __hangarShell: Shell }).__hangarShell.services.get('one')!.view.webContents;
    await wc.executeJavaScript(`document.body.innerHTML = '<textarea></textarea>'; const field = document.querySelector('textarea'); field.value = 'Unsent draft'; field.dispatchEvent(new Event('input', { bubbles: true }));`, true);
  });
  await command({ type: 'focus-service', serviceId: 'two' }); await expect.poll(() => loaded('two')).toBe(true);
  await sweep();
  await new Promise((r) => setTimeout(r, 1200));
  expect(await loaded('one')).toBe(true);
  await h.app.evaluate(async () => {
    const shell = (globalThis as unknown as { __hangarShell: Shell }).__hangarShell;
    await shell.services.get('one')!.view.webContents.executeJavaScript(`document.querySelector('textarea').value = ''; window.__hangar.capture(true);`);
  });
  await sweep(); await new Promise((r) => setTimeout(r, 1200)); expect(await loaded('one')).toBe(true);
  await h.app.evaluate(async () => {
    const wc = (globalThis as unknown as { __hangarShell: Shell }).__hangarShell.services.get('one')!.view.webContents;
    await wc.executeJavaScript(`window.__hangar.capture(false); window.onbeforeunload = () => false; void 0;`, true);
  });
  await sweep(); await new Promise((r) => setTimeout(r, 1200)); expect(await loaded('one')).toBe(true);
  await h.app.evaluate(async () => {
    const wc = (globalThis as unknown as { __hangarShell: Shell }).__hangarShell.services.get('one')!.view.webContents;
    await wc.executeJavaScript('window.onbeforeunload = null');
  });
  await sweep(); await expect.poll(() => loaded('one')).toBe(false);
});

test('idle time starts when leaving a pane and current panes stay protected while hidden', async () => {
  await setup();
  const age = await h.app.evaluate(() => {
    const shell = (globalThis as unknown as { __hangarShell: Shell }).__hangarShell;
    shell.services.get('one')!.lastActiveAt = 1;
    shell.dispatch({ type: 'focus-service', serviceId: 'two' });
    return Date.now() - shell.services.get('one')!.lastActiveAt;
  });
  expect(age).toBeLessThan(1000);
  await expect.poll(() => loaded('two')).toBe(true);
  await h.app.evaluate(() => {
    const shell = (globalThis as unknown as { __hangarShell: Shell }).__hangarShell;
    shell.win.hide(); shell.services.get('two')!.lastActiveAt = 1; shell.hibernateIdle();
  });
  await new Promise((r) => setTimeout(r, 1200)); expect(await loaded('two')).toBe(true);
});

test('native background pages are hidden and their timers slow down without debugger overrides', async () => {
  const { stdout } = await promisify(execFile)(process.execPath, ['scripts/benchmark-resources.mjs', '--visibility-only'], { timeout: 25000 });
  const { before, after } = JSON.parse(stdout.trim());
  expect(after[0].hidden).toBe(false);
  expect(after[1].hidden).toBe(true);
  expect(after[1].throttled).toBe(true);
  expect(after[1].ticks - before[1].ticks).toBeLessThan((after[0].ticks - before[0].ticks) / 2);
});

test('closed panels release their web contents and keep an unsent assistant query', async () => {
  await setup();
  await command({ type: 'open-ai' });
  await expect.poll(() => h.app.windows().some((p) => p.url().endsWith('#ai'))).toBe(true);
  const panel = h.app.windows().find((p) => p.url().endsWith('#ai'))!;
  await panel.locator('textarea').fill('Keep this unsent question');
  await h.app.evaluate(() => { (globalThis as unknown as { __hangarShell: Shell }).__hangarShell.aiSurface.idle.delayMs = 50; });
  await command({ type: 'close-ai' });
  await expect.poll(() => h.app.evaluate(() => (globalThis as unknown as { __hangarShell: Shell }).__hangarShell.aiSurface.contents === null)).toBe(true);
  await command({ type: 'open-ai' });
  await expect.poll(() => h.app.windows().some((p) => p.url().endsWith('#ai'))).toBe(true);
  await expect(h.app.windows().find((p) => p.url().endsWith('#ai'))!.locator('textarea')).toHaveValue('Keep this unsent question');
});

test('conversation inspection stops without consumers and starts when the inbox opens', async () => {
  await setup();
  const running = () => h.app.evaluate(() => !!(globalThis as unknown as { __hangarShell: Shell }).__hangarShell.conversations.timer);
  expect(await running()).toBe(false);
  await command({ type: 'open-inbox' }); await expect.poll(running).toBe(true);
  await command({ type: 'close-inbox' }); await expect.poll(running).toBe(false);
});

test('controlled inputs and removed draft fields remain protected', async () => {
  await setup();
  await h.app.evaluate(async () => {
    const wc = (globalThis as unknown as { __hangarShell: Shell }).__hangarShell.services.get('one')!.view.webContents;
    await wc.executeJavaScript(`document.body.innerHTML = '<input>'; const field = document.querySelector('input');
      field.dispatchEvent(new InputEvent('beforeinput', { bubbles: true })); field.value = 'Unsent';
      field.dispatchEvent(new Event('input', { bubbles: true })); field.defaultValue = field.value;`);
  });
  const safe = () => h.app.evaluate(() => (globalThis as unknown as { __hangarShell: Shell }).__hangarShell.services.safeToDiscard('one'));
  expect(await safe()).toBe(false);
  await h.app.evaluate(async () => {
    await (globalThis as unknown as { __hangarShell: Shell }).__hangarShell.services.get('one')!.view.webContents.executeJavaScript("document.querySelector('input').remove()");
  });
  expect(await safe()).toBe(false);
});

test('long wake defers cached pages and protects an unsent draft when reopened', async () => {
  await setup();
  await h.app.evaluate(async () => {
    const wc = (globalThis as unknown as { __hangarShell: Shell }).__hangarShell.services.get('one')!.view.webContents;
    await wc.executeJavaScript(`document.body.innerHTML = '<textarea></textarea>'; const field = document.querySelector('textarea'); field.value = 'Unsent'; field.dispatchEvent(new Event('input', { bubbles: true }));`);
  });
  await command({ type: 'focus-service', serviceId: 'two' }); await expect.poll(() => loaded('two')).toBe(true);
  await h.app.evaluate(() => (globalThis as unknown as { __hangarShell: Shell }).__hangarShell.refreshAfterWake(600_000));
  await new Promise((r) => setTimeout(r, 1300));
  expect(await h.app.evaluate(() => (globalThis as unknown as { __hangarShell: Shell }).__hangarShell.services.get('one')!.stale)).toBe(true);
  await command({ type: 'focus-service', serviceId: 'one' });
  await new Promise((r) => setTimeout(r, 1300));
  expect(await h.app.evaluate(() => (globalThis as unknown as { __hangarShell: Shell }).__hangarShell.services.get('one')!.view.webContents.executeJavaScript("document.querySelector('textarea')?.value"))).toBe('Unsent');
});

test('50 sleep/wake and panel release cycles leave no extra web contents', async () => {
  test.setTimeout(120_000);
  await setup();
  await h.app.evaluate(() => {
    const shell = (globalThis as unknown as { __hangarShell: Shell }).__hangarShell;
    shell.aiSurface.idle.delayMs = 10;
  });
  const counts: number[] = [];
  for (let cycle = 0; cycle < 50; cycle++) {
    await command({ type: 'focus-service', serviceId: 'one' }); await expect.poll(() => loaded('one')).toBe(true);
    await command({ type: 'focus-service', serviceId: 'two' }); await expect.poll(() => loaded('two')).toBe(true);
    await sweep(); await expect.poll(() => loaded('one')).toBe(false);
    await command({ type: 'open-ai' });
    await expect.poll(() => h.app.windows().some((p) => p.url().endsWith('#ai'))).toBe(true);
    await command({ type: 'close-ai' });
    await expect.poll(() => h.app.evaluate(() => (globalThis as unknown as { __hangarShell: Shell }).__hangarShell.aiSurface.contents === null)).toBe(true);
    counts.push(await h.app.evaluate(({ webContents }) => webContents.getAllWebContents().length));
  }
  expect(new Set(counts).size).toBe(1);
  expect(counts.at(-1)).toBeLessThanOrEqual(3);
});


test('a stalled background load is stopped before the next queued service starts', async () => {
  h = await launch((origin) => {
    const config = seedConfig(origin);
    config.services[1]!.url = `${origin}/stalled`;
    config.services.push({ ...config.services[0]!, id: 'three', name: 'Three', url: `${origin}/badge` });
    config.workspaces[0]!.items.push({ kind: 'service', id: 'three' });
    return config;
  });
  await h.rail(); await expect.poll(() => loaded('one')).toBe(true);
  await h.app.evaluate(() => { (globalThis as unknown as { __hangarShell: Shell }).__hangarShell.loadQueue.timeoutMs = 500; });
  await command({ type: 'set-preference', path: 'behaviour.keepAllRunning', value: true });
  await expect.poll(() => loaded('three')).toBe(true);
  expect(await h.app.evaluate(() => {
    const runtime = (globalThis as unknown as { __hangarShell: Shell }).__hangarShell.services.get('two')!;
    return { stopped: !runtime.view.webContents.isLoading(), stale: runtime.stale };
  })).toEqual({ stopped: true, stale: true });
});


test('a timeout before the first document commits retries the service address', async () => {
  h = await launch((origin) => {
    const config = seedConfig(origin);
    config.services[1]!.url = `${origin}/stall-before-headers`;
    return config;
  });
  await h.rail(); await expect.poll(() => loaded('one')).toBe(true);
  await h.app.evaluate(() => { (globalThis as unknown as { __hangarShell: Shell }).__hangarShell.loadQueue.timeoutMs = 500; });
  await command({ type: 'set-preference', path: 'behaviour.keepAllRunning', value: true });
  await expect.poll(() => h.app.evaluate(() => (globalThis as unknown as { __hangarShell: Shell }).__hangarShell.services.get('two')?.view.webContents.getTitle())).toBe('Fixture recovered');
});
