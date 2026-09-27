import { test, expect } from '@playwright/test';
import { launch, seedConfig, tearDown, type Harness } from './harness';

/**
 * What a service's page is told it's running in. WhatsApp refuses the app's own `Hangar/…` token
 * ("WhatsApp works with Google Chrome 100+", at Chrome 150), so its catalog entry gets the plain
 * Chrome string; everything else keeps the default. The WhatsApp entry here points at the local
 * fixture — the rule is about the entry, not the site.
 */

let h: Harness;
test.afterEach(async ({}, testInfo) => {
  await tearDown(h, testInfo);
});

const userAgentOf = (serviceId: string) =>
  h.app.evaluate(async (_electron, id) => {
    const shell = (globalThis as never as {
      __hangarShell: { services: { get: (id: string) => { view: Electron.WebContentsView } | undefined } };
    }).__hangarShell;
    const wc = shell.services.get(id)?.view.webContents;
    return wc ? ((await wc.executeJavaScript('navigator.userAgent')) as string) : null;
  }, serviceId);

test("WHATSAPP'S PAGE IS TOLD IT'S CHROME, WITHOUT THE APP'S TOKEN — every other page keeps it", async () => {
  h = await launch((origin) => {
    const config = seedConfig(origin) as ReturnType<typeof seedConfig> & {
      services: Array<Record<string, unknown>>;
      workspaces: Array<{ items: unknown[] }>;
    };
    config.services.push({ ...config.services[0], id: 'wa', catalogId: 'whatsapp', name: 'WhatsApp' });
    config.workspaces[0]!.items.push({ kind: 'service', id: 'wa' });
    return config;
  });
  await h.rail();
  await h.app.evaluate(() => {
    (globalThis as never as { __hangarShell: { dispatch: (c: unknown) => boolean } }).__hangarShell.dispatch({
      type: 'open-in-new-pane',
      serviceId: 'wa',
    });
  });

  await expect.poll(() => userAgentOf('wa')).toMatch(/Chrome\/\d+/);
  expect(await userAgentOf('wa')).not.toMatch(/Hangar\//);
  expect(await userAgentOf('wa')).not.toMatch(/Electron\//);
  await expect.poll(() => userAgentOf('one'), 'an ordinary service keeps the default').toMatch(/Hangar\//);
});
