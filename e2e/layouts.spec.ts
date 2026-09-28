import fs from 'node:fs';
import path from 'node:path';
import { test, expect, type Page } from '@playwright/test';
import { launch, seedConfig, tearDown, type Harness } from './harness';

/**
 * Splitters, and the rest of arranging panes: reopening a closed one, moving one along, and the
 * one-large-and-a-stack shape. The geometry is unit-tested in layout.test.ts; these are about the
 * real views — that the handles exist where the gutters are, take a real drag, and move real panes.
 */

let h: Harness;
test.afterEach(async ({}, testInfo) => {
  await tearDown(h, testInfo);
});

type Rect = { x: number; y: number; width: number; height: number };

const dispatch = (command: unknown) =>
  h.app.evaluate((_electron, c) => {
    (globalThis as never as { __hangarShell: { dispatch: (c: unknown) => boolean } }).__hangarShell.dispatch(c);
  }, command);

/** Each pane's rectangle as its view has it, in pane order. */
const paneRects = () =>
  h.app.evaluate(() => {
    const shell = (globalThis as never as {
      __hangarShell: {
        state: () => { panes: Array<{ serviceId: string }> };
        services: { get: (id: string) => { view: Electron.WebContentsView } | undefined };
      };
    }).__hangarShell;
    return shell.state().panes.map((p) => shell.services.get(p.serviceId)?.view.getBounds() ?? null);
  });

/** The splitter views on the window: between columns left to right, or between rows top to bottom. */
const splitterRects = (axis: 'column' | 'row' = 'column') =>
  h.app.evaluate((_electron, axis) => {
    const shell = (globalThis as never as { __hangarShell: { win: Electron.BaseWindow } }).__hangarShell;
    const route = axis === 'row' ? /#splitter-row-\d+$/ : /#splitter-\d+$/;
    return shell.win.contentView.children
      .filter((v) => 'webContents' in v && route.test((v as Electron.WebContentsView).webContents.getURL()))
      .map((v) => v.getBounds())
      .sort((a, b) => (axis === 'row' ? a.y - b.y : a.x - b.x));
  }, axis);

const panesOf = () =>
  h.app.evaluate(() =>
    (globalThis as never as { __hangarShell: { state: () => { panes: Array<{ serviceId: string }> } } }).__hangarShell
      .state()
      .panes.map((p) => p.serviceId),
  );

async function splitterPage(index: number, axis: 'column' | 'row' = 'column'): Promise<Page> {
  const route = axis === 'row' ? `#splitter-row-${index}` : `#splitter-${index}`;
  await expect.poll(() => h.app.windows().some((w) => w.url().endsWith(route))).toBeTruthy();
  const page = h.app.windows().find((w) => w.url().endsWith(route))!;
  await page.waitForSelector('.splitter');
  return page;
}

/** A real drag on a splitter's own page, from its middle, `dx` across and `dy` down, in ten moves. */
async function drag(page: Page, dx: number, dy: number) {
  const box = await page.evaluate(() => ({ x: window.innerWidth / 2, y: window.innerHeight / 2 }));
  await page.mouse.move(box.x, box.y);
  await page.mouse.down();
  for (let step = 1; step <= 10; step++) await page.mouse.move(box.x + (dx * step) / 10, box.y + (dy * step) / 10);
  await page.mouse.up();
}

/** A config with `n` services, all in the one workspace. */
const withServices = (n: number) => (origin: string) => {
  const config = seedConfig(origin) as ReturnType<typeof seedConfig> & {
    services: Array<Record<string, unknown>>;
    workspaces: Array<{ items: unknown[] }>;
  };
  for (const id of ['three', 'four'].slice(0, n - 2)) {
    config.services.push({ ...config.services[0], id, name: id, accountId: 'acct-one' });
    config.workspaces[0]!.items.push({ kind: 'service', id });
  }
  return config;
};

test('DRAGGING THE GAP BETWEEN PANES RESIZES THEM — and the widths survive a relaunch', async () => {
  h = await launch();
  await h.rail();
  await dispatch({ type: 'split' });
  await expect.poll(async () => (await paneRects()).filter(Boolean).length).toBe(2);

  // One handle, on the gutter between the two.
  await expect.poll(async () => (await splitterRects()).length).toBe(2 - 1);
  const [left, right] = (await paneRects()) as Rect[];
  const [handle] = await splitterRects();
  expect(handle!.x).toBeLessThanOrEqual(left!.x + left!.width);
  expect(handle!.x + handle!.width).toBeGreaterThanOrEqual(right!.x);

  // Above both panes — a pane re-attached over it would take the pointer, and the drag below goes
  // straight to the handle's page whatever is on top of it, so it can't show that.
  // After a second relayout, which re-attaches the panes on top: the first put the handle above them
  // only because it was made after them.
  const order = await h.app.evaluate(() => {
    const shell = (globalThis as never as { __hangarShell: { win: Electron.BaseWindow; relayout: () => void } })
      .__hangarShell;
    shell.relayout();
    const url = (v: Electron.View) => ('webContents' in v ? (v as Electron.WebContentsView).webContents.getURL() : '');
    const children = shell.win.contentView.children;
    return {
      handle: children.findIndex((v) => url(v).includes('#splitter-')),
      topPane: Math.max(...children.map((v, i) => (url(v).startsWith('http://127.0.0.1') ? i : -1))),
    };
  });
  expect(order.handle).toBeGreaterThan(order.topPane);

  // A real drag, on the handle's own page: 200px to the left.
  const page = await splitterPage(0);
  const box = await page.evaluate(() => ({ x: window.innerWidth / 2, y: window.innerHeight / 2 }));
  await page.mouse.move(box.x, box.y);
  await page.mouse.down();
  for (let step = 1; step <= 10; step++) await page.mouse.move(box.x - step * 20, box.y);
  await page.mouse.up();

  await expect.poll(async () => ((await paneRects())[0] as Rect).width).toBeLessThan(left!.width - 150);
  const [narrowed, widened] = (await paneRects()) as Rect[];
  expect(narrowed!.width + widened!.width, 'the pair shares what it had').toBe(left!.width + right!.width);
  // The handle went with the gutter.
  const [moved] = await splitterRects();
  expect(moved!.x).toBeLessThan(handle!.x - 150);

  // Saved when the drag let go.
  const config = () => JSON.parse(fs.readFileSync(path.join(h.userData, 'config.json'), 'utf8'));
  await expect.poll(() => config().layouts.w1?.weights?.length ?? 0).toBe(2);

  const userData = h.userData;
  await h.close({ keepProfile: true });
  h = await launch(undefined, { reuseUserData: userData });
  await h.rail();
  await expect.poll(async () => ((await paneRects())[0] as Rect | null)?.width ?? 0).toBe(narrowed!.width);

  // Double-click: equal again.
  const again = await splitterPage(0);
  const centre = await again.evaluate(() => ({ x: window.innerWidth / 2, y: window.innerHeight / 2 }));
  await again.mouse.dblclick(centre.x, centre.y);
  await expect
    .poll(async () => {
      const [a, b] = (await paneRects()) as Rect[];
      return Math.abs(a!.width - b!.width);
    })
    .toBeLessThanOrEqual(1);
});

test('⌘⇧T REOPENS A CLOSED PANE WHERE IT WAS, AND A PANE CAN BE MOVED ALONG', async () => {
  h = await launch();
  await h.rail();
  await dispatch({ type: 'split' });
  await expect.poll(panesOf).toEqual(['one', 'two']);

  // Close the first, which is the harder case: reopened, it goes back in front rather than at the end.
  await h.app.evaluate(() => {
    const shell = (globalThis as never as {
      __hangarShell: { dispatch: (c: unknown) => boolean; layout: { panes: Array<{ id: string }> } };
    }).__hangarShell;
    shell.dispatch({ type: 'close-pane', paneId: shell.layout.panes[0]!.id });
  });
  await expect.poll(panesOf).toEqual(['two']);
  await expect.poll(async () => (await splitterRects()).length, 'one pane, no gutter, no handle').toBe(0);

  await dispatch({ type: 'reopen-pane' });
  await expect.poll(panesOf).toEqual(['one', 'two']);
  await expect.poll(async () => (await paneRects()).filter(Boolean).length, 'its page is running again').toBe(2);

  // Nothing left to reopen: the keystroke is let through rather than swallowed.
  expect(
    await h.app.evaluate(() =>
      (globalThis as never as { __hangarShell: { dispatch: (c: unknown) => boolean } }).__hangarShell.dispatch({
        type: 'reopen-pane',
      }),
    ),
  ).toBe(false);

  // The reopened pane has focus; moving it right swaps it with its neighbour.
  await dispatch({ type: 'move-pane', delta: 1 });
  await expect.poll(panesOf).toEqual(['two', 'one']);
  const saved = () =>
    (JSON.parse(fs.readFileSync(path.join(h.userData, 'config.json'), 'utf8')).layouts.w1?.panes ?? []).map(
      (p: { serviceId: string }) => p.serviceId,
    );
  await expect.poll(saved).toEqual(['two', 'one']);
});

test('ONE LARGE PANE AND THE REST STACKED BESIDE IT', async () => {
  h = await launch((origin) => {
    const config = seedConfig(origin) as ReturnType<typeof seedConfig> & {
      services: Array<Record<string, unknown>>;
      workspaces: Array<{ items: unknown[] }>;
    };
    config.services.push({ ...config.services[0], id: 'three', name: 'Three', accountId: 'acct-one' });
    config.workspaces[0]!.items.push({ kind: 'service', id: 'three' });
    return config;
  });
  await h.rail();
  await dispatch({ type: 'split' });
  await dispatch({ type: 'split' });
  await expect.poll(async () => (await paneRects()).filter(Boolean).length).toBe(3);
  await expect.poll(async () => (await splitterRects()).length, 'three columns, two handles').toBe(2);

  await dispatch({ type: 'toggle-layout-shape' });
  await expect.poll(async () => (await splitterRects()).length, 'two columns now, one handle').toBe(1);
  const [main, top, bottom] = (await paneRects()) as Rect[];
  expect(main!.height, 'the first pane has the full height').toBeGreaterThan(top!.height * 1.8);
  expect(top!.x, 'the other two share a column').toBe(bottom!.x);
  expect(top!.y).toBeLessThan(bottom!.y);
  expect(top!.x).toBeGreaterThan(main!.x + main!.width);

  // And it's kept.
  const shape = () => JSON.parse(fs.readFileSync(path.join(h.userData, 'config.json'), 'utf8')).layouts.w1?.shape;
  await expect.poll(shape).toBe('main-stack');
  await dispatch({ type: 'toggle-layout-shape' });
  await expect.poll(async () => (await splitterRects()).length).toBe(2);
  await expect.poll(shape).toBeUndefined();
});

test('THE STACK BESIDE THE LARGE PANE HAS A SPLITTER BETWEEN ITS ROWS — a real drag, and the heights survive a relaunch', async () => {
  h = await launch(withServices(3));
  await h.rail();
  await dispatch({ type: 'split' });
  await dispatch({ type: 'split' });
  await dispatch({ type: 'toggle-layout-shape' });
  await expect.poll(async () => (await splitterRects('row')).length, 'one between the two stacked').toBe(1);
  const [, top, bottom] = (await paneRects()) as Rect[];
  const [handle] = await splitterRects('row');
  expect(handle!.x).toBe(top!.x);
  expect(handle!.y).toBeLessThanOrEqual(top!.y + top!.height);
  expect(handle!.y + handle!.height).toBeGreaterThanOrEqual(bottom!.y);

  // Above the panes after a relayout, which re-attaches them on top — as the column handle is.
  const above = await h.app.evaluate(() => {
    const shell = (globalThis as never as { __hangarShell: { win: Electron.BaseWindow; relayout: () => void } }).__hangarShell;
    shell.relayout();
    const url = (v: Electron.View) => ('webContents' in v ? (v as Electron.WebContentsView).webContents.getURL() : '');
    const children = shell.win.contentView.children;
    const handle = children.findIndex((v) => url(v).includes('#splitter-row-'));
    return handle > Math.max(...children.map((v, i) => (url(v).startsWith('http://127.0.0.1') ? i : -1)));
  });
  expect(above).toBe(true);

  await drag(await splitterPage(0, 'row'), 0, 150);
  await expect.poll(async () => ((await paneRects())[1] as Rect).height).toBeGreaterThan(top!.height + 100);
  const [, taller, shorter] = (await paneRects()) as Rect[];
  expect(taller!.height + shorter!.height, 'the pair shares what it had').toBe(top!.height + bottom!.height);
  const [moved] = await splitterRects('row');
  expect(moved!.y, 'the handle went with the gutter').toBeGreaterThan(handle!.y + 100);

  const config = () => JSON.parse(fs.readFileSync(path.join(h.userData, 'config.json'), 'utf8'));
  await expect.poll(() => config().layouts.w1?.rowWeights?.length ?? 0).toBe(2);
  const userData = h.userData;
  await h.close({ keepProfile: true });
  h = await launch(undefined, { reuseUserData: userData });
  await h.rail();
  await expect.poll(async () => ((await paneRects())[1] as Rect | null)?.height ?? 0).toBe(taller!.height);
});

test('IN THE 2×2 GRID ONE ROW SPLITTER SPANS BOTH COLUMNS, and moves both', async () => {
  h = await launch(withServices(4));
  await h.rail();
  for (let i = 0; i < 3; i++) await dispatch({ type: 'split' });
  await expect.poll(async () => (await paneRects()).filter(Boolean).length).toBe(4);
  await expect.poll(async () => (await splitterRects('row')).length).toBe(1);
  const [a, b] = (await paneRects()) as Rect[];
  const [row] = await splitterRects('row');
  expect(row!.x).toBe(a!.x);
  expect(row!.x + row!.width).toBe(b!.x + b!.width);

  await drag(await splitterPage(0, 'row'), 0, -120);
  await expect.poll(async () => ((await paneRects())[0] as Rect).height).toBeLessThan(a!.height - 80);
  const [ta, tb, bc, bd] = (await paneRects()) as Rect[];
  expect(ta!.height, 'both top panes').toBe(tb!.height);
  expect(bc!.height, 'both bottom panes').toBe(bd!.height);
});

test('⌃⌘→ AND ⌃⌘← WIDEN AND NARROW THE FOCUSED PANE — through the real key path', async () => {
  h = await launch();
  await h.rail();
  await dispatch({ type: 'split' });
  await expect.poll(async () => (await paneRects()).filter(Boolean).length).toBe(2);
  const [left] = (await paneRects()) as Rect[];
  const focusFirst = () =>
    h.app.evaluate(() => {
      const shell = (globalThis as never as {
        __hangarShell: { state: () => { panes: Array<{ id: string }> }; dispatch: (c: unknown) => boolean };
      }).__hangarShell;
      shell.dispatch({ type: 'focus-pane', paneId: shell.state().panes[0]!.id });
    });
  await focusFirst();
  // Through `before-input-event`, as a real key comes: `page.keyboard` would skip the shortcut layer.
  const press = (keyCode: string) =>
    h.app.evaluate((_electron, keyCode) => {
      const shell = (globalThis as never as { __hangarShell: { contentsForService: (id: string) => Electron.WebContents | null } })
        .__hangarShell;
      const wc = shell.contentsForService('one')!;
      const event = { keyCode, modifiers: ['meta', 'control'] as never };
      wc.sendInputEvent({ ...event, type: 'keyDown' });
      wc.sendInputEvent({ ...event, type: 'keyUp' });
    }, keyCode);
  await press('Right');
  await expect.poll(async () => ((await paneRects())[0] as Rect).width).toBe(left!.width + 48);
  await press('Left');
  await press('Left');
  await expect.poll(async () => ((await paneRects())[0] as Rect).width).toBe(left!.width - 48);
  const config = () => JSON.parse(fs.readFileSync(path.join(h.userData, 'config.json'), 'utf8'));
  await expect.poll(() => config().layouts.w1?.weights?.length ?? 0, 'saved, with no let-go to wait for').toBe(2);
});
