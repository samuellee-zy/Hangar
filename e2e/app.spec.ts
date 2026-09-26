import fs from 'node:fs';
import path from 'node:path';
import { test, expect } from '@playwright/test';
import { launch, seedConfig, type Harness } from './harness';

/**
 * Sixteen tests covering what unit tests structurally cannot: real windows, real `WebContentsView`
 * hit-testing and z-order, real layout for drag and for CSS geometry, the preload's main-world
 * patches, and process lifecycle.
 *
 * Each was previously a `console.log` line in `HANGAR_PROBE` that a human had to read and
 * interpret. The value here isn't new coverage so much as coverage that can *fail*.
 */

let h: Harness;
test.afterEach(async () => {
  await h?.close();
});

test('boots, renders the rail, and loads a service into the first pane', async () => {
  h = await launch();
  const rail = await h.rail();
  await expect(rail.locator('.rail-item').first()).toBeVisible();
  // Two services plus the add and settings buttons.
  expect(await rail.locator('.rail-item').count()).toBeGreaterThanOrEqual(2);

  // The pane is a separate WebContentsView, so it's its own page.
  const pane = await h.app.windows().find((w) => w.url().includes('127.0.0.1'));
  expect(pane, 'a service should have loaded').toBeTruthy();
});

test('the overlay stops eating clicks once closed', async () => {
  // The overlay is a transparent full-window view. Hiding rather than *removing* it leaves it
  // hit-testing across its whole bounds, so every click meant for a pane lands on nothing and the
  // app appears frozen (decisions #15). This is the regression that behaviour exists to prevent.
  h = await launch();
  const rail = await h.rail();

  await rail.locator('.rail-add').first().click();
  await expect.poll(() => h.app.windows().some((w) => w.url().includes('#overlay'))).toBeTruthy();

  await rail.keyboard.press('Escape');

  // Now a rail click must still register. If the overlay were merely hidden, this would be
  // swallowed and no command would reach main.
  await rail.locator('.rail-item').first().click();
  await expect(rail.locator('.rail-item.is-focused, .rail-item.is-visible').first()).toBeVisible();
});

test("the preload's main-world patches are actually in the page's world", async () => {
  // The isolated-world trap (decisions #31): with contextIsolation the preload's `window` is not
  // the page's, so these patches were all silent no-ops while typechecking and reviewing clean.
  // Only an assertion from inside the page can tell the difference.
  h = await launch();
  await h.rail();

  const pane = await expect
    .poll(() => h.app.windows().find((w) => w.url().includes('127.0.0.1')))
    .toBeTruthy()
    .then(() => h.app.windows().find((w) => w.url().includes('127.0.0.1'))!);

  const probe = await pane.evaluate(async () => ({
    notificationPatched: (window as never as { Notification: { permission: string } }).Notification
      ?.permission,
    bridge: typeof (window as never as { __hangar?: { subscribePush?: unknown } }).__hangar
      ?.subscribePush,
    pushPatched: (
      window as never as {
        PushManager?: { prototype: { subscribe: () => void } };
      }
    ).PushManager?.prototype.subscribe
      .toString()
      .includes('subscribePush'),
    permissionState: await (
      window as never as {
        PushManager: { prototype: { permissionState: () => Promise<string> } };
      }
    ).PushManager.prototype.permissionState.call({}),
    // Push is off by default: this must RESOLVE null, never reject. The page falls back to its own
    // subscribe on null and would break outright on a rejection.
    subscribeResolvesNull:
      (await (
        window as never as {
          __hangar: { subscribePush: (k: string) => Promise<unknown> };
        }
      ).__hangar.subscribePush('test-key')) === null,
  }));

  expect(probe.notificationPatched).toBe('granted');
  expect(probe.bridge).toBe('function');
  expect(probe.pushPatched).toBe(true);
  expect(probe.permissionState).toBe('granted');
  expect(probe.subscribeResolvesNull).toBe(true);
});

test('a notification from a background service counts; a visible one does not', async () => {
  h = await launch();
  const rail = await h.rail();

  // Split so both services are loaded, then close the second pane — the view stays alive but
  // leaves the screen, which is the "loaded but not visible" state that should count.
  await rail.keyboard.press(process.platform === 'darwin' ? 'Meta+\\' : 'Control+\\');
  await rail.waitForTimeout(2500);

  const before = await h.app.evaluate(async ({ app }) => app.getBadgeCount?.() ?? 0);
  const panes = h.app.windows().filter((w) => w.url().includes('127.0.0.1'));
  expect(panes.length).toBeGreaterThanOrEqual(1);

  // Fire from whichever pane is NOT on screen. With one pane visible, the second qualifies.
  const target = panes[panes.length - 1]!;
  await target.evaluate(() => new Notification('E2E', { body: 'hello' }));
  await rail.waitForTimeout(800);

  const after = await h.app.evaluate(async ({ app }) => app.getBadgeCount?.() ?? 0);
  expect(after, 'a background notification should raise the badge').toBeGreaterThanOrEqual(before);
});

test('A HIBERNATED SERVICE STILL RECEIVES A PUSH', async () => {
  // The Phase 3.6 bug: handleNotification bailed on a missing runtime, and a hibernated service
  // has no runtime BY DEFINITION — so every push the feature existed to deliver was decrypted,
  // deduplicated, marked consumed, and discarded. Silently, for its whole existence.
  //
  // Needs no Firebase: handlePushMessage takes an already-decrypted payload, so injecting one
  // covers everything downstream of decryption, which is exactly where the bug was.
  h = await launch();
  await h.rail();
  await new Promise((r) => setTimeout(r, 3000));

  const result = await h.app.evaluate(async ({ BrowserWindow: _bw }) => {
    // The main-process module keeps the AppWindow on a module global for the probe path.
    const shell = (globalThis as never as { __hangarShell?: unknown }).__hangarShell as
      | {
          state: () => {
            services: Array<{
              id: string;
              name: string;
              sleeping: boolean;
              unread: number;
            }>;
          };
          dispatch: (c: unknown) => boolean;
          injectPush: (id: string, p: { title: string; body: string }) => void;
        }
      | undefined;
    if (!shell) return { error: 'no shell handle' };

    const awake = shell.state().services.find((s) => !s.sleeping);
    if (!awake) return { error: 'nothing awake to sleep' };

    shell.dispatch({ type: 'sleep-service', serviceId: awake.id });
    await new Promise((r) => setTimeout(r, 1200));

    const asleep = shell.state().services.find((s) => s.id === awake.id)!;
    const before = asleep.unread;
    shell.injectPush(awake.id, { title: 'Push', body: 'while asleep' });
    await new Promise((r) => setTimeout(r, 600));

    const after = shell.state().services.find((s) => s.id === awake.id)!;
    return { sleeping: after.sleeping, before, after: after.unread };
  });

  expect(result.error).toBeUndefined();
  expect(result.sleeping, 'the service must actually be asleep for this to mean anything').toBe(
    true,
  );
  expect(result.after).toBeGreaterThan(result.before!);
});

test('⌘W then reopening leaves the app fully working', async () => {
  // Nothing disposed the old window, so the global shortcut, tray, Settings and push sockets all
  // kept references to a destroyed BrowserWindow and threw from then on (decisions #54).
  h = await launch();
  await h.rail();

  const result = await h.app.evaluate(async ({ app }) => {
    const g = globalThis as never as {
      __hangarShell?: { win: { close: () => void } };
    };
    g.__hangarShell?.win.close();
    await new Promise((r) => setTimeout(r, 1500));

    app.emit('activate');
    await new Promise((r) => setTimeout(r, 3000));

    const shell = (
      globalThis as never as {
        __hangarShell?: { dispatch: (c: unknown) => boolean };
      }
    ).__hangarShell;
    if (!shell) return { rebuilt: false };

    const errors: string[] = [];
    for (const command of [{ type: 'show-window' }, { type: 'open-settings' }]) {
      try {
        shell.dispatch(command);
      } catch (e) {
        errors.push(`${(command as { type: string }).type}: ${String(e)}`);
      }
    }
    return { rebuilt: true, errors };
  });

  expect(result.rebuilt, 'activate should rebuild the window').toBe(true);
  expect(result.errors, 'these threw "Object has been destroyed" before the fix').toEqual([]);
});

test('DRAGGING A TILE ONTO A PANE PUTS IT THERE, AND GIVES THE PANES BACK AFTERWARDS', async () => {
  // The half of drag-to-pane that unit tests structurally cannot reach: a real window, real pane
  // rectangles, and a real transparent view attached over them.
  //
  // Two failure modes are being pinned. The drop must land on the pane the highlight named, which
  // depends on main translating between three coordinate spaces correctly — and the layer must
  // *detach* afterwards, because a transparent WebContentsView hit-tests across its whole bounds
  // and one left attached swallows every click in the window (decisions #15, #86).
  h = await launch();
  const rail = await h.rail();

  await h.app.evaluate(() => {
    const g = globalThis as never as {
      __hangarShell?: { dispatch: (c: unknown) => boolean };
    };
    g.__hangarShell?.dispatch({ type: 'begin-tile-drag', serviceId: 'two' });
  });

  await expect.poll(() => h.app.windows().some((w) => w.url().includes('#drag'))).toBeTruthy();
  const layer = h.app.windows().find((w) => w.url().includes('#drag'))!;

  // The layer's own viewport *is* the content area, so its centre is the centre of the only pane.
  const size = await layer.evaluate(() => ({
    w: window.innerWidth,
    h: window.innerHeight,
  }));
  const centre = { x: Math.round(size.w / 2), y: Math.round(size.h / 2) };

  // `evaluate` hands the callback the Electron module first and the argument second — hence the
  // unused leading parameter here and below.
  await h.app.evaluate((_electron, { x, y }) => {
    const g = globalThis as never as {
      __hangarShell?: { dispatch: (c: unknown) => boolean };
    };
    g.__hangarShell?.dispatch({ type: 'drag-tile-to', from: 'content', x, y });
  }, centre);

  // The indicator is the whole user-visible half of this feature: it answers "what happens if I let
  // go here?" before anything irreversible happens.
  await expect(layer.locator('.drop-target')).toBeVisible();
  await expect(layer.locator('.drop-target')).toHaveText('Open here');

  const replaced = await h.app.evaluate((_electron, { x, y }) => {
    const g = globalThis as never as {
      __hangarShell?: {
        dispatch: (c: unknown) => boolean;
        state: () => { panes: Array<{ serviceId: string }> };
      };
    };
    g.__hangarShell?.dispatch({ type: 'drop-tile', from: 'content', x, y });
    return g.__hangarShell?.state().panes.map((p) => p.serviceId);
  }, centre);
  expect(replaced, 'the drop should have replaced the pane it highlighted').toEqual(['two']);

  // Nothing left drawn, and — the part that matters — nothing left in front of the panes.
  await expect(layer.locator('.drop-target')).toHaveCount(0);
  await rail.locator('.rail-item').first().click();
  await expect(rail.locator('.rail-item.is-focused, .rail-item.is-visible').first()).toBeVisible();

  // And the other answer: released in the gutter, it opens alongside rather than replacing.
  const opened = await h.app.evaluate(() => {
    const g = globalThis as never as {
      __hangarShell?: {
        dispatch: (c: unknown) => boolean;
        state: () => { panes: Array<{ serviceId: string }> };
      };
    };
    g.__hangarShell?.dispatch({ type: 'begin-tile-drag', serviceId: 'one' });
    // Top-left of the content area is gutter, never a pane.
    g.__hangarShell?.dispatch({
      type: 'drop-tile',
      from: 'content',
      x: 2,
      y: 2,
    });
    return g.__hangarShell?.state().panes.map((p) => p.serviceId);
  });
  expect(opened).toHaveLength(2);
});

test('DRAGGING A TILE ONTO A FOLDER FILES IT THERE, AND DRAGGING IT OUT TAKES IT BACK', async () => {
  // The only test anywhere that performs a *real* drag. dnd-kit decides what you dropped on from
  // measured rectangles, and jsdom reports every element as zero-sized — so in unit tests it never
  // resolves a drop target at all, and every assertion about dragging passes whether the wiring
  // exists or not. This needs a real renderer with real layout.
  h = await launch((origin) => {
    const config = seedConfig(origin) as {
      workspaces: Array<{ items: unknown[] }>;
    };
    config.workspaces[0]!.items = [
      { kind: 'service', id: 'one' },
      {
        kind: 'folder',
        id: 'f1',
        name: 'Work',
        collapsed: false,
        serviceIds: [],
      },
    ];
    return config;
  });
  const rail = await h.rail();

  const items = () =>
    h.app.evaluate(() => {
      const g = globalThis as never as {
        __hangarShell?: {
          state: () => {
            railItems: Array<{
              kind: string;
              id: string;
              serviceIds?: string[];
            }>;
          };
        };
      };
      return g.__hangarShell?.state().railItems;
    });

  /** A real pointer drag, in steps — dnd-kit ignores anything under its 5px activation distance. */
  const drag = async (from: string, to: string) => {
    const start = await rail.locator(from).first().boundingBox();
    const end = await rail.locator(to).first().boundingBox();
    if (!start || !end) throw new Error(`no box for ${from} → ${to}`);
    await rail.mouse.move(start.x + start.width / 2, start.y + start.height / 2);
    await rail.mouse.down();
    await rail.mouse.move(end.x + end.width / 2, end.y + end.height / 2, {
      steps: 12,
    });
    await rail.mouse.up();
  };

  await drag('.rail-item[aria-label*="One"]', '.rail-folder');
  await expect
    .poll(async () => (await items())?.find((i) => i.kind === 'folder')?.serviceIds)
    .toEqual(['one']);

  // And back out: the member is a sortable row of its own, so dropping it on a top-level tile
  // promotes it. Without that the gesture is a one-way door.
  await drag('.rail-item.is-nested', '.rail-item[aria-label*="Two"]');
  await expect
    .poll(async () => (await items())?.find((i) => i.kind === 'folder')?.serviceIds)
    .toEqual([]);
  await expect.poll(async () => (await items())?.some((i) => i.id === 'one')).toBeTruthy();
});

test('A COMPACT RAIL OPENS ON THE CHEVRON AND GIVES THE WIDTH BACK WHEN SHUT', async () => {
  // Nothing about this is reachable from a unit test. The rail's size is a `WebContentsView` bound
  // and the pane's is another — two facts about a real window and none about a DOM.
  h = await launch((origin) => ({
    ...(seedConfig(origin) as object),
    preferences: { appearance: { compactRail: true, railSize: 96 } },
  }));
  const rail = await h.rail();

  // Each renderer fills its view exactly, so its own viewport is the measurement.
  const width = () => rail.evaluate(() => window.innerWidth);
  const paneWidth = async () => {
    const pane = h.app.windows().find((w) => w.url().includes('127.0.0.1'));
    return pane ? pane.evaluate(() => window.innerWidth) : null;
  };

  await expect.poll(width).toBe(48);
  const paneCollapsed = await paneWidth();
  expect(paneCollapsed, 'a service should have loaded').toBeTruthy();

  // Hovering must do nothing at all. The rail used to open here and then depend on a `pointerleave`
  // that Chromium does not deliver when the pointer crosses into a pane's view, so it stayed open
  // over the page — the bug this design replaced.
  await rail.mouse.move(11, 300);
  await rail.mouse.move(400, 300);
  expect(await width(), 'hovering must not open the rail').toBe(48);

  // Collapsed is still a usable rail: every service is one click away, which is why the tiles are
  // drawn at 48px rather than hidden behind the chevron.
  await expect(rail.getByRole('button', { name: /One/ })).toBeVisible();

  await rail.getByRole('button', { name: 'Show the rail' }).click();
  await expect.poll(width).toBe(180);

  // The panes reflow around it rather than sitting under it, so nothing the rail covers can be
  // clicked through it — an attached view hit-tests its whole rectangle.
  await expect
    .poll(paneWidth, {
      message: 'the panes must give up the width the rail took',
    })
    .toBe(paneCollapsed! - (180 - 48));

  await rail.getByRole('button', { name: 'Hide the rail' }).click();
  await expect.poll(width).toBe(48);
  await expect.poll(paneWidth, { message: 'and take it back on the way out' }).toBe(paneCollapsed);
});

/** Which overlay is open, or null. Read from main, because a closed overlay's view is cached. */
const overlayMode = () =>
  h.app.evaluate(() => {
    const g = globalThis as never as {
      __hangarShell?: { overlayOpen: { mode: string } | null };
    };
    return g.__hangarShell?.overlayOpen?.mode ?? null;
  });

/**
 * A keystroke through the *browser* input path, which is the only one `before-input-event` sees.
 *
 * Not `page.keyboard.press`: that injects through CDP straight into the renderer, so the whole
 * shortcut layer is bypassed and every assertion below would pass against an app with no keyboard
 * handling at all. `webContents.sendInputEvent` goes through main first, the way a real key does.
 */
const press = (target: { serviceId?: string }, key: string, modifiers: string[] = ['meta']) =>
  h.app.evaluate(
    (_electron, arg) => {
      const g = globalThis as never as {
        __hangarShell?: {
          railContents: Electron.WebContents;
          contentsForService: (id: string) => Electron.WebContents | null;
        };
      };
      const shell = g.__hangarShell;
      if (!shell) throw new Error('no shell');
      const wc = arg.serviceId ? shell.contentsForService(arg.serviceId) : shell.railContents;
      if (!wc) throw new Error(`no contents for ${arg.serviceId ?? 'rail'}`);
      const event = { keyCode: arg.key, modifiers: arg.modifiers as never };
      wc.sendInputEvent({ ...event, type: 'keyDown' });
      wc.sendInputEvent({ ...event, type: 'keyUp' });
    },
    { serviceId: target.serviceId, key, modifiers },
  );

test('A REBOUND CHORD TAKES EFFECT, AND THE OLD ONE STOPS WORKING', async () => {
  // The half of rebinding no unit test can reach. `translate` is pure and thoroughly covered, but
  // it only matters if `before-input-event` is the thing that runs — and until now it wasn't: the
  // menu registered the same accelerators at the application level, where they fire first. A
  // rebound ⌘K would have kept opening the palette from the menu's copy of the fact, and every
  // unit test in the suite would still have passed.
  h = await launch();
  const rail = await h.rail();

  await press({}, 'k');
  await expect.poll(overlayMode).toBe('palette');
  await press({}, 'Escape', []);
  await expect.poll(overlayMode).toBe(null);

  await h.app.evaluate(() => {
    const g = globalThis as never as {
      __hangarShell?: { dispatch: (c: unknown) => boolean };
    };
    g.__hangarShell?.dispatch({
      type: 'rebind',
      actionId: 'palette',
      chord: 'meta+j',
    });
  });

  await press({}, 'k');
  await rail.waitForTimeout(300);
  expect(await overlayMode(), '⌘K should no longer be the palette').toBe(null);

  await press({}, 'j');
  await expect.poll(overlayMode).toBe('palette');

  // The menu is the other copy of the fact, and both halves of how it holds it matter.
  const item = await h.app.evaluate(({ Menu }) => {
    const found = (Menu.getApplicationMenu()?.items ?? [])
      .flatMap((menu) => menu.submenu?.items ?? [])
      .find((entry) => entry.label === 'Command palette');
    return found
      ? {
          accelerator: found.accelerator ?? null,
          registered: found.registerAccelerator,
        }
      : null;
  });
  expect(item?.accelerator, 'the menu should have been redrawn').toBe('Command+J');
  expect(
    item?.registered,
    'a registered accelerator fires ahead of before-input-event, which is what made rebinding impossible',
  ).toBe(false);

  // And it is on disk, not just in memory — a rebind that doesn't survive a restart isn't one.
  // Polled: writes are debounced (config.ts, WRITE_DEBOUNCE_MS).
  await expect
    .poll(() => {
      const stored = JSON.parse(fs.readFileSync(path.join(h.userData, 'config.json'), 'utf8'));
      return stored.preferences.keyboard.bindings.palette;
    })
    .toBe('meta+j');
});

test('A SERVICE KEEPS THE CHORDS ON ITS PASSTHROUGH LIST', async () => {
  // The motivating case, end to end: Hangar reads every keystroke before the page does, so Slack's
  // own ⌘K switcher was unreachable. Only a real `before-input-event` on a real service view can
  // show that the key both fails to open the palette *and* arrives in the page.
  h = await launch((origin) => {
    const config = seedConfig(origin) as {
      services: Array<Record<string, unknown>>;
    };
    config.services[1]!['keyboardPassthrough'] = ['meta+k'];
    return config;
  });
  await h.rail();

  const paneFor = async (urlPart: string) => {
    await expect.poll(() => h.app.windows().some((w) => w.url().includes(urlPart))).toBeTruthy();
    return h.app.windows().find((w) => w.url().includes(urlPart))!;
  };

  // Put the claiming service on screen. It has to have a live view for its keystrokes to exist.
  await h.app.evaluate(() => {
    const g = globalThis as never as {
      __hangarShell?: { dispatch: (c: unknown) => boolean };
    };
    g.__hangarShell?.dispatch({ type: 'open-in-new-pane', serviceId: 'two' });
  });

  const claiming = await paneFor('/unread');
  await claiming.evaluate(() => {
    (window as never as { __keys: string[] }).__keys = [];
    window.addEventListener('keydown', (e) => {
      (window as never as { __keys: string[] }).__keys.push(e.key);
    });
  });

  await press({ serviceId: 'two' }, 'k');
  await claiming.waitForTimeout(300);

  expect(await overlayMode(), 'the palette must not have opened').toBe(null);
  expect(
    await claiming.evaluate(() => (window as never as { __keys: string[] }).__keys),
    'the page must actually receive the key it claimed',
  ).toContain('k');

  // And only that service. A passthrough list is per service, not a global exemption.
  await press({ serviceId: 'one' }, 'k');
  await expect.poll(overlayMode).toBe('palette');
});

test('A BADGE IN THE PAGE BECOMES THE COUNT, AND GOES DOWN AGAIN', async () => {
  // The gap this closes: for the 27 catalog entries with no title pattern, unread was a tally of
  // `new Notification()` calls. A tally only ever rises, never notices you read something
  // elsewhere, and sits at zero for anyone who turned that site's notifications off.
  //
  // No unit test can reach this. The parsing is pure and covered, but the code that queries the
  // page lives inside a serialised `executeInMainWorld` closure — it cannot import anything, so it
  // cannot be imported either. A real page, a real MutationObserver and a real IPC hop are the only
  // way to find out whether any of it runs.
  h = await launch((origin) => {
    const config = seedConfig(origin) as {
      services: Array<Record<string, unknown>>;
    };
    config.services[0]!['url'] = `${origin}/badge`;
    config.services[0]!['unreadSelector'] = '.unread-badge';
    return config;
  });
  await h.rail();

  const unread = () =>
    h.app.evaluate(() => {
      const g = globalThis as never as {
        __hangarShell?: {
          state: () => { services: Array<{ id: string; unread: number }> };
        };
      };
      return g.__hangarShell?.state().services.find((s) => s.id === 'one')?.unread ?? -1;
    });

  await expect.poll(() => h.app.windows().some((w) => w.url().includes('/badge'))).toBeTruthy();
  const page = h.app.windows().find((w) => w.url().includes('/badge'))!;

  await expect.poll(unread, { timeout: 15_000 }).toBe(3);

  // The observer, not just the initial read: nobody reloads a chat app to find out they have mail.
  await page.evaluate(() => {
    document.querySelector('.unread-badge')!.textContent = '7';
  });
  await expect.poll(unread, { timeout: 15_000 }).toBe(7);

  // Changing the selector must land on a page that is already open — the field is edited by someone
  // looking at the service, and a selector you have to reload to test is one nobody tunes.
  await h.app.evaluate(() => {
    const g = globalThis as never as {
      __hangarShell?: { dispatch: (c: unknown) => boolean };
    };
    g.__hangarShell?.dispatch({
      type: 'update-service',
      serviceId: 'one',
      patch: { unreadSelector: '.other-badge' },
    });
  });
  await expect.poll(unread, { timeout: 15_000 }).toBe(9);

  // The assertion the whole feature exists for. An event tally physically cannot do this.
  await page.evaluate(() => document.querySelector('.other-badge')!.remove());
  await expect.poll(unread, { timeout: 15_000 }).toBe(0);
});

test('A SLEEPING SERVICE IS ASKED OVER ITS OWN LOGIN', async () => {
  // Both page-reading mechanisms need a rendered page, so a hibernated service can report nothing —
  // and hibernation is what makes a rail of twenty services affordable, so the count you most want
  // belongs to the service least able to give one.
  //
  // The claim under test is narrow and is the whole feature: the request main makes carries the
  // cookies that service's *partition* holds. The fixture's endpoint answers 401 without them, so a
  // count arriving at all is proof — a plain fetch from main could not have produced it.
  h = await launch((origin) => {
    const config = seedConfig(origin) as {
      services: Array<Record<string, unknown>>;
    };
    config.services[1]!['url'] = `${origin}/session`;
    config.services[1]!['unreadEndpoint'] = {
      url: `${origin}/api/unread`,
      extract: { json: 'counts.unread' },
    };
    return config;
  });
  await h.rail();

  const result = await h.app.evaluate(async () => {
    const shell = (
      globalThis as never as {
        __hangarShell?: {
          dispatch: (c: unknown) => boolean;
          pollEndpoints: () => Promise<void>;
          state: () => {
            panes: Array<{ id: string; serviceId: string }>;
            services: Array<{ id: string; unread: number; sleeping: boolean }>;
          };
        };
      }
    ).__hangarShell!;

    // Sign in: load the service once so its partition receives the cookie.
    shell.dispatch({ type: 'open-in-new-pane', serviceId: 'two' });
    await new Promise((r) => setTimeout(r, 2500));

    // Then take it off screen and unload it. The view is destroyed; the cookie jar is not, which is
    // the asymmetry this feature runs on.
    const pane = shell.state().panes.find((p) => p.serviceId === 'two');
    if (pane) shell.dispatch({ type: 'close-pane', paneId: pane.id });
    shell.dispatch({ type: 'sleep-others' });
    await new Promise((r) => setTimeout(r, 500));

    const sleeping = shell.state().services.find((s) => s.id === 'two')?.sleeping ?? false;
    // The sweep runs on a 30s interval; call it rather than waiting for one.
    await shell.pollEndpoints();
    return {
      sleeping,
      unread: shell.state().services.find((s) => s.id === 'two')?.unread ?? -1,
    };
  });

  expect(result.sleeping, 'the service must have no live view for this to prove anything').toBe(
    true,
  );
  expect(result.unread, 'the endpoint answers 401 to a request without the partition cookie').toBe(
    5,
  );
});

test('a truncated config is quarantined, not overwritten', async () => {
  // The whole point of the durability work: the bad file is the only copy of the user's setup, so
  // it must survive for inspection rather than being replaced by defaults.
  h = await launch(() => '{"services":[{"id":"one",');
  await h.rail();

  const files = fs.readdirSync(h.userData);
  const quarantined = files.filter((f) => f.includes('corrupt'));
  expect(quarantined, `no quarantine file among ${files.join(', ')}`).toHaveLength(1);
  expect(fs.readFileSync(path.join(h.userData, quarantined[0]!), 'utf8')).toBe(
    '{"services":[{"id":"one",',
  );
});

test('AN EMPTY SERVICE LIST IS VALID CONFIG, NOT CORRUPTION', async () => {
  // The P0: removing your last service writes `services: []`, which the loader treated as a
  // corrupt file — quarantining it and falling back to a backup the next window-move had already
  // overwritten with the same empty config. Defaults then replaced every account and partition.
  h = await launch((origin) => ({
    ...seedConfig(origin),
    services: [],
    workspaces: [],
  }));
  await h.rail();

  expect(fs.readdirSync(h.userData).filter((f) => f.includes('corrupt'))).toHaveLength(0);
  const config = JSON.parse(fs.readFileSync(path.join(h.userData, 'config.json'), 'utf8'));
  expect(config.services).toEqual([]);
  // The accounts are the part that mattered — they were being replaced wholesale.
  expect(config.accounts.length).toBeGreaterThan(0);
});

test('the footer buttons sit in the same centred column as the tiles', async () => {
  // The add and settings buttons are `<button>`, so they are inline-block, and the `margin: 0 auto`
  // they inherit from .rail-item cannot centre an inline-block. In a plain block footer they went
  // flush left with all the slack on the right, a visible step out of the tile column. Only real
  // layout catches this: the rule was present and looked correct in review.
  h = await launch();
  const rail = await h.rail();
  await expect(rail.locator('.rail-item').first()).toBeVisible();

  const centres = await rail.evaluate(() => {
    const centre = (el: Element) => {
      const r = el.getBoundingClientRect();
      return r.left + r.width / 2;
    };
    const footer = document.querySelector('.rail-footer')!;
    return {
      tiles: [...document.querySelectorAll('.rail-items .rail-item')].map(centre),
      buttons: [...footer.querySelectorAll('.rail-add')].map(centre),
      footer: centre(footer),
    };
  });

  expect(centres.tiles.length).toBeGreaterThan(0);
  expect(centres.buttons).toHaveLength(2);

  // Centred in their own column...
  for (const button of centres.buttons) {
    expect(Math.abs(button - centres.footer)).toBeLessThanOrEqual(0.5);
  }
  // ...and that column is the one the tiles are already in.
  for (const button of centres.buttons) {
    expect(Math.abs(button - centres.tiles[0]!)).toBeLessThanOrEqual(0.5);
  }
});

test('A RESIZE STORM DOES NOT BROADCAST A STORM — the rail is sent state only when it changes', async () => {
  // Every resize event relays out, and every relayout ended in a full broadcast to every surface:
  // dragging the window's edge re-rendered the rail, the overlay and Settings sixty times a second
  // with an identical state each time.
  h = await launch();
  const rail = await h.rail();
  await rail.waitForTimeout(500);

  await rail.evaluate(() => {
    const g = window as unknown as { __received: number; hangar: { onState: (f: () => void) => void } };
    g.__received = 0;
    g.hangar.onState(() => g.__received++);
  });

  await h.app.evaluate(async () => {
    const shell = (globalThis as never as { __hangarShell: { win: Electron.BaseWindow } }).__hangarShell;
    const { width, height } = shell.win.getBounds();
    for (let i = 0; i < 30; i++) {
      shell.win.setSize(width - (i % 2) * 20, height);
      await new Promise((r) => setTimeout(r, 5));
    }
    shell.win.setSize(width, height);
  });
  await rail.waitForTimeout(500);

  const received = await rail.evaluate(() => (window as unknown as { __received: number }).__received);
  expect(received, `${received} broadcasts for 30 resizes that changed nothing it draws`).toBeLessThanOrEqual(2);
});

test('WITH LINK ROUTING ON, A LINK TO ANOTHER OF YOUR SERVICES OPENS THERE — not in the browser', async () => {
  // One fixture server under two names: service "one" lives on 127.0.0.1, service "two" on
  // localhost. A link from one to two's host is off one's allowlist, so it leaves one — and with
  // routing on it should land in two's pane rather than being handed to the system browser.
  h = await launch((origin) => {
    const localhost = origin.replace('127.0.0.1', 'localhost');
    const config = seedConfig(origin, { preferences: { behaviour: { routeLinks: true } } }) as {
      services: Array<{ id: string; url: string; allowedHosts: string[] }>;
    };
    config.services[1]!.url = `${localhost}/unread`;
    config.services[1]!.allowedHosts = ['localhost'];
    return config;
  });
  await h.rail();
  const localhost = h.fixture.origin.replace('127.0.0.1', 'localhost');

  const opened = await h.app.evaluate(async ({ shell, webContents }, target) => {
    const openedExternally: string[] = [];
    const original = shell.openExternal;
    shell.openExternal = async (url: string) => {
      openedExternally.push(url);
    };
    const one = webContents.getAllWebContents().find((c) => c.getURL().startsWith('http://127.0.0.1'));
    await one?.executeJavaScript(`window.open(${JSON.stringify(target)}, '_blank'); true`);
    await new Promise((r) => setTimeout(r, 2500));
    shell.openExternal = original;
    const two = webContents.getAllWebContents().find((c) => c.getURL().startsWith(target));
    return { openedExternally, landedIn: two?.getURL() ?? null };
  }, `${localhost}/unread/routed`);

  expect(opened.openedExternally, 'it must not have gone to the browser').toEqual([]);
  expect(opened.landedIn).toBe(`${localhost}/unread/routed`);
});

test('POPPING A SERVICE OUT GIVES IT A WINDOW OF ITS OWN, signed in, and sleeps the pane copy', async () => {
  h = await launch();
  await h.rail();

  const result = await h.app.evaluate(async ({ BrowserWindow, session }) => {
    const shell = (globalThis as never as {
      __hangarShell: { dispatch: (c: unknown) => boolean; state: () => { services: { id: string; sleeping: boolean }[] } };
    }).__hangarShell;
    // A cookie in the service's jar, to prove the window shares it rather than starting signed out.
    await session.fromPartition('persist:acct-one').cookies.set({ url: 'http://127.0.0.1/', name: 'who', value: 'me' });
    shell.dispatch({ type: 'pop-out-service', serviceId: 'one' });
    await new Promise((r) => setTimeout(r, 1500));
    const popped = BrowserWindow.getAllWindows().find((w) => w.getTitle().includes('One'));
    const cookies = popped ? await popped.webContents.session.cookies.get({ name: 'who' }) : [];
    return {
      opened: Boolean(popped),
      signedIn: cookies[0]?.value === 'me',
      paneAsleep: shell.state().services.find((s) => s.id === 'one')?.sleeping ?? false,
    };
  });

  expect(result.opened, 'a window titled after the service').toBe(true);
  expect(result.signedIn, 'the same session as the pane').toBe(true);
  expect(result.paneAsleep, 'only one copy running').toBe(true);
});

test('A NOTIFICATION YOU MISSED IS KEPT IN RECENT — one you were looking at is not', async () => {
  h = await launch();
  await h.rail();
  const recent = await h.app.evaluate(async () => {
    const shell = (globalThis as never as {
      __hangarShell: {
        handleNotification: (id: string, p: unknown) => void;
        state: () => { recentNotifications?: { serviceId: string; title: string }[] };
      };
    }).__hangarShell;
    // "two" is loaded but not in a pane, so it counts; "one" is on screen in the first pane.
    shell.handleNotification('two', { title: 'Missed this', body: 'while away' });
    shell.handleNotification('one', { title: 'Saw this', body: 'on screen' });
    return shell.state().recentNotifications ?? [];
  });
  expect(recent.map((n) => n.title)).toEqual(['Missed this']);
});

test('MAXIMISING A PANE TAKES THE OTHER OFF THE WINDOW — and the focus ring marks the focused one', async () => {
  h = await launch();
  await h.rail();

  const result = await h.app.evaluate(async ({ webContents }) => {
    const shell = (globalThis as never as {
      __hangarShell: { win: Electron.BaseWindow; dispatch: (c: unknown) => boolean; focusRing: Electron.View | null };
    }).__hangarShell;
    shell.dispatch({ type: 'split' });
    await new Promise((r) => setTimeout(r, 2000));
    const attachedPanes = () =>
      shell.win.contentView.children.filter((v) =>
        'webContents' in v && (v as Electron.WebContentsView).webContents.getURL().startsWith('http://127.0.0.1'),
      ).length;
    const split = attachedPanes();
    const ringWithTwo = Boolean(shell.focusRing?.getVisible());
    shell.dispatch({ type: 'toggle-maximise-pane' });
    await new Promise((r) => setTimeout(r, 300));
    const maximised = attachedPanes();
    const ringWithOne = Boolean(shell.focusRing?.getVisible());
    shell.dispatch({ type: 'toggle-maximise-pane' });
    await new Promise((r) => setTimeout(r, 300));
    return { split, maximised, restored: attachedPanes(), ringWithTwo, ringWithOne, _: webContents.getAllWebContents().length };
  });

  expect(result.split).toBe(2);
  expect(result.maximised, 'the hidden pane must be detached, not left underneath').toBe(1);
  expect(result.restored).toBe(2);
  expect(result.ringWithTwo, 'two panes: the focused one is marked').toBe(true);
  expect(result.ringWithOne, 'one pane drawn: nothing to tell apart').toBe(false);
});
