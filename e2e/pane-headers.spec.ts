import { test, expect, type Page } from '@playwright/test';
import { launch, seedConfig, tearDown, type Harness } from './harness';

/**
 * The bars that speak for a pane: the title bar on the top strip, and — with the preference on —
 * a header above each pane. Their buttons are unit-tested (PaneBar.test.tsx); these are about the
 * real views: that each is where it should be, says what its page is doing, and drives that page.
 */

let h: Harness;
test.afterEach(async ({}, testInfo) => {
  await tearDown(h, testInfo);
});

type Rect = { x: number; y: number; width: number; height: number };
type Shell = {
  win: Electron.BaseWindow;
  dispatch: (c: unknown) => boolean;
  state: () => { panes: Array<{ id: string; serviceId: string }> };
  services: { get: (id: string) => { view: Electron.WebContentsView } | undefined };
};

const dispatch = (command: unknown) =>
  h.app.evaluate((_electron, c) => {
    (globalThis as never as { __hangarShell: Shell }).__hangarShell.dispatch(c);
  }, command);

/** Views on the window whose page is one of the app's own routes, by route, with their bounds. */
const routeRects = (prefix: string) =>
  h.app.evaluate((_electron, prefix) => {
    const shell = (globalThis as never as { __hangarShell: Shell }).__hangarShell;
    return shell.win.contentView.children
      .filter((v) => 'webContents' in v && (v as Electron.WebContentsView).webContents.getURL().includes(`#${prefix}`))
      .map((v) => v.getBounds())
      .sort((a, b) => a.x - b.x);
  }, prefix);

const pageRects = () =>
  h.app.evaluate(() => {
    const shell = (globalThis as never as { __hangarShell: Shell }).__hangarShell;
    return shell.state().panes.map((p) => shell.services.get(p.serviceId)?.view.getBounds() ?? null);
  });

async function routePage(route: string): Promise<Page> {
  await expect.poll(() => h.app.windows().some((w) => w.url().includes(`#${route}`))).toBeTruthy();
  return h.app.windows().find((w) => w.url().includes(`#${route}`))!;
}

test('WITH HEADERS ON, EACH PANE HAS ONE ABOVE ITS PAGE — and its Back button drives that page', async () => {
  h = await launch((origin) => seedConfig(origin, { preferences: { appearance: { paneHeaders: true } } }));
  await h.rail();
  await dispatch({ type: 'split' });
  await expect.poll(async () => (await routeRects('header-')).length).toBe(2);

  const headers = (await routeRects('header-')) as Rect[];
  const pages = (await pageRects()) as Rect[];
  for (const [i, header] of headers.entries()) {
    expect(pages[i]!.x).toBe(header.x);
    expect(pages[i]!.width).toBe(header.width);
    expect(pages[i]!.y - header.y, 'the page starts below its header').toBe(30);
  }

  // Beneath their pages, after a relayout too: the part tucked under a page must stay under it.
  const stacking = await h.app.evaluate(() => {
    const shell = (globalThis as never as { __hangarShell: Shell & { relayout: () => void } }).__hangarShell;
    shell.relayout();
    const url = (v: Electron.View) => ('webContents' in v ? (v as Electron.WebContentsView).webContents.getURL() : '');
    const children = shell.win.contentView.children;
    return {
      highestHeader: Math.max(...children.map((v, i) => (url(v).includes('#header-') ? i : -1))),
      lowestPage: Math.min(...children.map((v, i) => (url(v).startsWith('http://127.0.0.1') ? i : Infinity))),
    };
  });
  expect(stacking.highestHeader).toBeLessThan(stacking.lowestPage);

  // The first pane goes somewhere, so it has somewhere to go back to.
  const bar = await routePage('header-0');
  await expect(bar.getByText('One', { exact: true })).toBeVisible();
  await expect(bar.getByRole('button', { name: 'Back' })).toBeDisabled();
  await h.app.evaluate(async (_electron) => {
    const shell = (globalThis as never as { __hangarShell: Shell }).__hangarShell;
    const wc = shell.services.get('one')!.view.webContents;
    await wc.loadURL(new URL('/blank', wc.getURL()).toString());
  });
  // Its page's title, which says more than the name.
  await expect(bar.getByText('Blank')).toBeVisible();
  await bar.getByRole('button', { name: 'Back' }).click();
  await expect
    .poll(() =>
      h.app.evaluate(() =>
        new URL(
          (globalThis as never as { __hangarShell: Shell }).__hangarShell.services.get('one')!.view.webContents.getURL(),
        ).pathname,
      ),
    )
    .toBe('/');
  await expect(bar.getByRole('button', { name: 'Forward' })).toBeEnabled();

  // Turned off: the headers go, and the pages take the space back.
  await dispatch({ type: 'set-preference', path: 'appearance.paneHeaders', value: false });
  await expect.poll(async () => (await routeRects('header-')).length).toBe(0);
  await expect.poll(async () => ((await pageRects())[0] as Rect).y).toBe(headers[0]!.y);
});

test('WHERE THERE IS A TOP STRIP, IT SAYS WHICH SERVICE HAS FOCUS — and there is none where the rail holds the traffic lights', async () => {
  h = await launch((origin) => seedConfig(origin, { preferences: { appearance: { railPosition: 'right' } } }));
  await h.rail();
  await dispatch({ type: 'split' });

  const [strip] = (await routeRects('titlebar')) as Rect[];
  const width = await h.app.evaluate(() =>
    (globalThis as never as { __hangarShell: Shell }).__hangarShell.win.getContentBounds().width,
  );
  expect(strip).toEqual({ x: 0, y: 0, width, height: 38 });

  const titlebar = await routePage('titlebar');
  await expect(titlebar.getByRole('toolbar', { name: 'Two, the focused pane' })).toBeVisible();
  await dispatch({ type: 'focus-service', serviceId: 'one' });
  await expect(titlebar.getByRole('toolbar', { name: 'One, the focused pane' })).toBeVisible();
  // Still the window's drag handle, all but its buttons.
  expect(await titlebar.locator('.pane-bar').evaluate((el) => getComputedStyle(el).getPropertyValue('-webkit-app-region'))).toBe(
    'drag',
  );

  // A left rail wide enough for the traffic lights has no strip, so no title bar.
  await dispatch({ type: 'set-preference', path: 'appearance.railPosition', value: 'left' });
  await expect.poll(async () => (await routeRects('titlebar')).length).toBe(0);
});

test('DRAGGING A PANE BY ITS HEADER ONTO ANOTHER SWAPS THEM — and the preview says so', async () => {
  h = await launch((origin) => seedConfig(origin, { preferences: { appearance: { paneHeaders: true } } }));
  await h.rail();
  await dispatch({ type: 'split' });
  await expect.poll(async () => (await routeRects('header-')).length).toBe(2);
  const [first, second] = (await routeRects('header-')) as Rect[];
  const panes = () =>
    h.app.evaluate(() =>
      (globalThis as never as { __hangarShell: Shell }).__hangarShell.state().panes.map((p) => p.serviceId),
    );
  expect(await panes()).toEqual(['one', 'two']);

  // What the first header sends: the lift, then the pointer in its own coordinates — here, over the
  // middle of the second pane.
  const paneId = await h.app.evaluate(
    () => (globalThis as never as { __hangarShell: Shell }).__hangarShell.state().panes[0]!.id,
  );
  await dispatch({ type: 'begin-pane-drag', paneId });
  await expect.poll(() => h.app.windows().some((w) => w.url().includes('#drag'))).toBeTruthy();
  const layer = h.app.windows().find((w) => w.url().includes('#drag'))!;
  const over = { x: second!.x - first!.x + second!.width / 2, y: 300 };
  await dispatch({ type: 'drag-tile-to', from: 'header', ...over });
  await expect(layer.locator('.drop-target')).toHaveText('Swap with Two');

  // Over itself: nothing to do, so nothing drawn.
  await dispatch({ type: 'drag-tile-to', from: 'header', x: first!.width / 2, y: 300 });
  await expect(layer.locator('.drop-target')).toHaveCount(0);

  await dispatch({ type: 'drag-tile-to', from: 'header', ...over });
  await dispatch({ type: 'drop-tile', from: 'header', ...over });
  await expect.poll(panes).toEqual(['two', 'one']);
  // The one dragged keeps focus.
  await expect
    .poll(() =>
      h.app.evaluate(() => {
        const state = (globalThis as never as { __hangarShell: Shell }).__hangarShell.state() as unknown as {
          panes: Array<{ id: string; serviceId: string }>;
          focusedPaneId: string;
        };
        return state.panes.find((p) => p.id === state.focusedPaneId)?.serviceId;
      }),
    )
    .toBe('one');
});
