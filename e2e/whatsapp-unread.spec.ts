import { test, expect } from '@playwright/test';
import { launch, seedConfig, tearDown, type Harness } from './harness';

/**
 * WhatsApp's count is its messages, added up from the chat list's badges — not its title's "(2)",
 * which counts chats. Against a fixture laid out as the rule reads WhatsApp (e2e/fixture-server.ts):
 * the selector, the muted exclusion and the page winning over the title all run in real Chromium.
 */

let h: Harness;
test.afterEach(async ({}, testInfo) => {
  await tearDown(h, testInfo);
});

const unreadOf = (serviceId: string) =>
  h.app.evaluate((_electron, id) => {
    const shell = (globalThis as never as {
      __hangarShell: { state: () => { allServices: Array<{ id: string; unread: number }> } };
    }).__hangarShell;
    return shell.state().allServices.find((s) => s.id === id)?.unread ?? null;
  }, serviceId);

test("WHATSAPP COUNTS MESSAGES, NOT CHATS — 8 and 1, the muted chat's 3 left out, and the title's 2 ignored", async () => {
  h = await launch((origin) => {
    const config = seedConfig(origin) as ReturnType<typeof seedConfig> & {
      services: Array<Record<string, unknown>>;
      workspaces: Array<{ items: unknown[] }>;
    };
    config.services.push({
      ...config.services[0],
      id: 'wa',
      catalogId: 'whatsapp',
      name: 'WhatsApp',
      url: `${origin}/whatsapp`,
      // In the background, so being on screen doesn't read the count away.
      keepRunning: true,
    });
    config.workspaces[0]!.items.push({ kind: 'service', id: 'wa' });
    return config;
  });
  await h.rail();
  await expect.poll(() => unreadOf('wa'), { timeout: 15_000 }).toBe(9);

  // It follows the page: FAMILY's 8 read down to 5.
  await h.app.evaluate(async () => {
    const shell = (globalThis as never as {
      __hangarShell: { services: { get: (id: string) => { view: Electron.WebContentsView } | undefined } };
    }).__hangarShell;
    await shell.services.get('wa')!.view.webContents.executeJavaScript(
      "document.getElementById('family').textContent = '5'",
    );
  });
  await expect.poll(() => unreadOf('wa'), { timeout: 5_000 }).toBe(6);
});
