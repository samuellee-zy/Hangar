import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from '@playwright/test';
import { launch, seedConfig, type Harness } from '../e2e/harness';

/**
 * Every rail position, compact and not, in both themes — plus the opened panel and Settings.
 *
 * The window is pinned on top at a fixed place and size, then the screen is captured there, so the
 * native parts (traffic lights, the strip behind them) are in the picture. Playwright forces a light
 * colour scheme on the pages it drives, so each page is told the theme explicitly.
 */

const OUT = path.join(__dirname, '..', 'test-results', 'shots');
const BOUNDS = { x: 80, y: 80, width: 820, height: 520 };
const POSITIONS = ['left', 'right', 'top', 'bottom'] as const;
const THEMES = ['dark', 'light'] as const;

type Shell = { win: Electron.BaseWindow; dispatch: (c: unknown) => boolean };

let h: Harness | undefined;
test.afterEach(async () => {
  await h?.close();
  h = undefined;
});

async function open(theme: (typeof THEMES)[number], appearance: Record<string, unknown>) {
  h = await launch((origin) => {
    const c = seedConfig(origin, { preferences: { appearance: { theme, ...appearance } } }) as {
      services: Array<Record<string, unknown>>;
      workspaces: Array<{ items: unknown[] }>;
    };
    // Enough tiles to fill a rail, and a folder to show how members sit.
    for (let i = 3; i <= 6; i++) {
      c.services.push({ ...c.services[0], id: `s${i}`, name: `Service ${i}`, accountId: 'acct-one' });
      c.workspaces[0]!.items.push({ kind: 'service', id: `s${i}` });
    }
    return c;
  });
  await h.rail();
  await h.app.evaluate(({ app }, bounds) => {
    const shell = (globalThis as never as { __hangarShell: Shell }).__hangarShell;
    shell.win.setBounds(bounds);
    shell.win.setAlwaysOnTop(true);
    app.focus({ steal: true });
    shell.win.focus();
  }, BOUNDS);
  await scheme(theme);
}

async function scheme(theme: (typeof THEMES)[number]) {
  for (const page of h!.app.windows()) await page.emulateMedia({ colorScheme: theme });
}

async function capture(name: string) {
  await new Promise((r) => setTimeout(r, 1200));
  fs.mkdirSync(OUT, { recursive: true });
  const { x, y, width, height } = BOUNDS;
  execFileSync('screencapture', ['-x', '-R', `${x},${y},${width},${height}`, path.join(OUT, `${name}.png`)]);
}

for (const theme of THEMES) {
  for (const railPosition of POSITIONS) {
    for (const compactRail of [false, true]) {
      const name = `${theme}-${railPosition}-${compactRail ? 'compact' : 'normal'}`;
      test(name, async () => {
        await open(theme, { railPosition, compactRail });
        await capture(name);
      });
    }
  }

  test(`${theme}-split`, async () => {
    await open(theme, { railPosition: 'left' });
    await h!.app.evaluate(() => {
      const shell = (globalThis as never as { __hangarShell: Shell }).__hangarShell;
      shell.dispatch({ type: 'open-in-new-pane', serviceId: 'two' });
      shell.dispatch({ type: 'open-in-new-pane', serviceId: 's3' });
    });
    await capture(`${theme}-split`);
    await h!.app.evaluate(() =>
      (globalThis as never as { __hangarShell: Shell }).__hangarShell.dispatch({ type: 'toggle-maximise-pane' }),
    );
    await capture(`${theme}-maximised`);
  });

  // A dragged gutter with its handle pointed at, then the one-large shape.
  test(`${theme}-layouts`, async () => {
    await open(theme, { railPosition: 'left' });
    await h!.app.evaluate((_electron, bounds) => {
      const shell = (globalThis as never as { __hangarShell: Shell }).__hangarShell;
      shell.dispatch({ type: 'open-in-new-pane', serviceId: 'two' });
      shell.dispatch({ type: 'open-in-new-pane', serviceId: 's3' });
      shell.dispatch({ type: 'drag-split', index: 0, screenX: bounds.x + 420 });
      shell.dispatch({ type: 'end-split' });
    }, BOUNDS);
    await new Promise((r) => setTimeout(r, 800));
    await scheme(theme);
    const handle = h!.app.windows().find((w) => w.url().includes('#splitter-0'));
    if (handle) {
      const size = await handle.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }));
      await handle.mouse.move(size.w / 2, size.h / 2);
    }
    await capture(`${theme}-resized`);
    await h!.app.evaluate(() =>
      (globalThis as never as { __hangarShell: Shell }).__hangarShell.dispatch({ type: 'toggle-layout-shape' }),
    );
    await capture(`${theme}-main-stack`);
  });

  test(`${theme}-panel`, async () => {
    await open(theme, { railPosition: 'left', compactRail: true });
    await h!.app.evaluate(() => {
      (globalThis as never as { __hangarShell: Shell }).__hangarShell.dispatch({ type: 'toggle-rail' });
    });
    await scheme(theme);
    await capture(`${theme}-panel`);
  });

  for (const [name, target] of [
    ['settings', {}],
    ['service-settings', { serviceId: 'one' }],
  ] as const) test(`${theme}-${name}`, async () => {
    await open(theme, {});
    await h!.app.evaluate(({ BrowserWindow }, { bounds, target }) => {
      (globalThis as never as { __hangarShell: Shell }).__hangarShell.dispatch({ type: 'open-settings', ...target });
      const settings = BrowserWindow.getAllWindows().find((w) => w.getTitle().includes('Settings'));
      settings?.setBounds(bounds);
      settings?.setAlwaysOnTop(true);
      settings?.focus();
    }, { bounds: BOUNDS, target });
    await new Promise((r) => setTimeout(r, 800));
    await scheme(theme);
    await capture(`${theme}-${name}`);
  });
}
