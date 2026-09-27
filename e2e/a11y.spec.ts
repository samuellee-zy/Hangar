import AxeBuilder from '@axe-core/playwright';
import { test, expect, type Page } from '@playwright/test';
import { launch, seedConfig, tearDown, type Harness } from './harness';

/**
 * Automated accessibility checks on the app's own screens, in both themes.
 *
 * Not a substitute for using it with VoiceOver (backlog §4.3) — axe finds what can be found from
 * the markup: names, roles, contrast. The contrast half is why both themes run: the light one had
 * never been checked, and failed on the muted text under every Settings row.
 *
 * Legacy mode, because axe otherwise opens a page of its own to reach into frames, and Electron
 * doesn't support creating one. Our screens have no frames.
 */

let h: Harness;

test.afterEach(async ({}, testInfo) => {
  await tearDown(h, testInfo);
});

type Shell = { __hangarShell: { dispatch: (c: unknown) => boolean } };

async function violations(page: Page, scheme: 'light' | 'dark') {
  await page.emulateMedia({ colorScheme: scheme });
  // Past the 120ms background transitions, or axe measures a colour halfway between the themes.
  await page.waitForTimeout(400);
  const { violations } = await new AxeBuilder({ page })
    .setLegacyMode(true)
    .withTags(['wcag2a', 'wcag2aa'])
    .analyze();
  return violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical')
    .map((v) => `${v.id}: ${v.nodes.map((n) => `${n.target.join(' ')} — ${n.any.map((a) => a.message).join('; ')}`).join(' | ')}`);
}

async function surface(route: string, open: unknown): Promise<Page> {
  await h.app.evaluate((_electron, command) => {
    (globalThis as never as Shell).__hangarShell.dispatch(command);
  }, open);
  await expect.poll(() => h.app.windows().some((w) => w.url().includes(`#${route}`))).toBeTruthy();
  const page = h.app.windows().find((w) => w.url().includes(`#${route}`))!;
  await page.waitForLoadState('domcontentloaded');
  return page;
}

for (const scheme of ['light', 'dark'] as const) {
  test(`the rail and Settings pass axe — ${scheme}`, async () => {
    h = await launch();
    const rail = await h.rail();
    expect(await violations(rail, scheme)).toEqual([]);

    const settings = await surface('settings', { type: 'open-settings' });
    await expect(settings.getByRole('heading', { level: 1 })).toBeVisible();
    expect(await violations(settings, scheme)).toEqual([]);
  });

  test(`the palette and the service picker pass axe — ${scheme}`, async () => {
    h = await launch();
    await h.rail();
    const overlay = await surface('overlay', { type: 'open-palette' });
    await expect(overlay.getByRole('combobox')).toBeVisible();
    expect(await violations(overlay, scheme)).toEqual([]);

    await h.app.evaluate(() => (globalThis as never as Shell).__hangarShell.dispatch({ type: 'open-connections' }));
    await expect(overlay.getByRole('dialog')).toBeVisible();
    expect(await violations(overlay, scheme)).toEqual([]);

    await h.app.evaluate(() => (globalThis as never as Shell).__hangarShell.dispatch({ type: 'open-activity' }));
    await expect(overlay.getByRole('dialog', { name: /Recent notifications/ })).toBeVisible();
    expect(await violations(overlay, scheme)).toEqual([]);
  });

  test(`the title bar and a pane header pass axe — ${scheme}`, async () => {
    h = await launch((origin) =>
      seedConfig(origin, { preferences: { appearance: { railPosition: 'right', paneHeaders: true } } }),
    );
    await h.rail();
    const header = await surface('header-0', { type: 'split' });
    await expect(header.getByRole('toolbar')).toBeVisible();
    expect(await violations(header, scheme)).toEqual([]);
    const titlebar = await surface('titlebar', { type: 'show-window' });
    await expect(titlebar.getByRole('toolbar')).toBeVisible();
    expect(await violations(titlebar, scheme)).toEqual([]);
  });
}
