import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, expect } from '@playwright/test';
import { launch, seedConfig, tearDown, type Harness } from './harness';

/**
 * A file clicked in a chat was saved, and nothing said so: no banner, no bounce in the Dock, no
 * progress. It looked like a click that did nothing, and the file was found later, in Downloads.
 *
 * macOS delivers a banner only to a signed app, so the banner is caught where main shows it —
 * `Notification.prototype.show` — along with the Dock's bounce and progress bar.
 */

let h: Harness;
let folder: string;
test.beforeEach(() => {
  folder = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-downloads-'));
});
test.afterEach(async ({}, testInfo) => {
  await tearDown(h, testInfo);
  fs.rmSync(folder, { recursive: true, force: true });
});

type Seen = {
  banners: Array<{ title: string; body: string }>;
  bounced: string[];
  progress: number[];
  revealed: string[];
};

const launchWithFiles = () =>
  launch((origin) => {
    const config = seedConfig(origin, { preferences: { downloads: { folder } } }) as ReturnType<typeof seedConfig> & {
      services: Array<Record<string, unknown>>;
    };
    config.services[0] = { ...config.services[0], url: `${origin}/downloads` };
    return config;
  });

/** Watches what main does to say a download happened, and keeps each banner so it can be clicked. */
const watch = () =>
  h.app.evaluate(({ Notification, app, shell }) => {
    const g = globalThis as never as { __seen: Seen; __banners: Electron.Notification[]; __hangarShell: { win: Electron.BaseWindow } };
    g.__seen = { banners: [], bounced: [], progress: [], revealed: [] };
    g.__banners = [];
    Notification.prototype.show = function (this: Electron.Notification) {
      g.__seen.banners.push({ title: this.title, body: this.body });
      g.__banners.push(this);
    };
    app.dock!.downloadFinished = (file: string) => void g.__seen.bounced.push(file);
    shell.showItemInFolder = (file: string) => void g.__seen.revealed.push(file);
    g.__hangarShell.win.setProgressBar = (value: number) => void g.__seen.progress.push(value);
  });

const seen = () => h.app.evaluate(() => (globalThis as never as { __seen: Seen }).__seen);

/** Clicks a link in One's page, as a person would. */
const click = (id: string) =>
  h.app.evaluate(async ({ webContents }, id) => {
    let page: Electron.WebContents | undefined;
    for (let i = 0; i < 50 && !page; i++) {
      page = webContents.getAllWebContents().find((c) => c.getURL().endsWith('/downloads') && !c.isLoading());
      if (!page) await new Promise((r) => setTimeout(r, 100));
    }
    if (!page) throw new Error('no page with files');
    await page.executeJavaScript(`document.getElementById(${JSON.stringify(id)}).click(); true`, true);
  }, id);

test('A FILE CLICKED IN A SERVICE SAYS IT DOWNLOADED — a banner naming it and the service, and the Dock bounces', async () => {
  h = await launchWithFiles();
  await h.rail();
  await watch();

  await click('report');
  const saved = path.join(folder, 'report.pdf');
  await expect.poll(() => fs.existsSync(saved), 'saved where downloads go').toBe(true);
  await expect.poll(async () => (await seen()).banners).toEqual([
    { title: 'Downloaded report.pdf', body: 'From One. Click to show it in Finder.' },
  ]);
  expect((await seen()).bounced, "the Downloads stack's bounce").toEqual([saved]);
  expect(h.log()).toContain('[download] One: report.pdf — completed');
  const listed = await h.app.evaluate(
    () => (globalThis as never as { __hangarShell: { state: () => { downloads: Array<{ service: string | null }> } } }).__hangarShell.state().downloads,
  );
  expect(listed[0]?.service, 'and the Activity list says where from').toBe('One');

  // Clicking the banner shows the file; it never opens it.
  await h.app.evaluate(() => (globalThis as never as { __banners: Electron.Notification[] }).__banners[0]!.emit('click'));
  expect((await seen()).revealed).toEqual([saved]);

  // Turned off, the file still lands, quietly.
  await h.app.evaluate(() =>
    (globalThis as never as { __hangarShell: { dispatch: (c: unknown) => boolean } }).__hangarShell.dispatch({
      type: 'set-preference',
      path: 'downloads.notify',
      value: false,
    }),
  );
  await click('report');
  await expect.poll(() => fs.existsSync(path.join(folder, 'report (1).pdf'))).toBe(true);
  await expect.poll(() => h.log().split('report.pdf — completed').length - 1).toBe(2);
  expect((await seen()).banners, 'no second banner').toHaveLength(1);
});

test('THE DOCK SHOWS HOW FAR A DOWNLOAD HAS GOT, AND NOTHING ONCE IT ENDS', async () => {
  h = await launchWithFiles();
  await h.rail();
  await watch();

  await click('slow');
  await expect.poll(() => fs.existsSync(path.join(folder, 'slow.bin')), { timeout: 10_000 }).toBe(true);
  await expect.poll(async () => (await seen()).progress.at(-1), 'the bar goes when it ends').toBe(-1);
  const progress = (await seen()).progress;
  expect(progress.some((p) => p > 0 && p < 1), `part-way along: ${progress.join(', ')}`).toBe(true);
  const running = progress.slice(0, -1);
  expect(running, 'and never backwards').toEqual([...running].sort((a, b) => a - b));
});
