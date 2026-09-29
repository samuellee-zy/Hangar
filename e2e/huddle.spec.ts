import { test, expect } from '@playwright/test';
import { launch, seedConfig, tearDown, type Harness } from './harness';

/**
 * Slack starts a huddle by opening a blank window and drawing into it. The blank window was refused
 * — about:blank is on no allowlist — and handed to a browser that won't open it either, so Start
 * Huddle did nothing. Against a fixture that does what Slack does, as a Slack-catalog service.
 */

let h: Harness;
test.afterEach(async ({}, testInfo) => {
  await tearDown(h, testInfo);
});

const launchAsSlack = () =>
  launch((origin) => {
    const config = seedConfig(origin) as ReturnType<typeof seedConfig> & { services: Array<Record<string, unknown>> };
    // Slack's catalog entry — so it's a reviewed service that may use the microphone — at the fixture.
    config.services[0] = { ...config.services[0], catalogId: 'slack', name: 'Slack', url: `${origin}/huddle` };
    return config;
  });

test('START HUDDLE OPENS ITS WINDOW, AND THE WINDOW MAY USE THE MICROPHONE — it did nothing at all', async () => {
  h = await launchAsSlack();
  await h.rail();
  const result = await h.app.evaluate(async ({ BrowserWindow, webContents }) => {
    const slack = await (async () => {
      for (let i = 0; i < 50; i++) {
        const wc = webContents.getAllWebContents().find((c) => c.getURL().endsWith('/huddle'));
        if (wc && !wc.isLoading()) return wc;
        await new Promise((r) => setTimeout(r, 100));
      }
      return null;
    })();
    if (!slack) return { error: 'no Slack page' };
    const before = BrowserWindow.getAllWindows().length;
    await slack.executeJavaScript("document.getElementById('start').click(); true", true);
    await new Promise((r) => setTimeout(r, 1000));
    const popup = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL() === 'about:blank');
    if (!popup) return { error: 'no huddle window', before, after: BrowserWindow.getAllWindows().length };
    const heading = await popup.webContents.executeJavaScript("document.getElementById('huddle')?.textContent ?? null");
    const microphone = await popup.webContents.executeJavaScript(
      "navigator.permissions.query({ name: 'microphone' }).then((p) => p.state)",
    );
    return { heading, microphone };
  });
  expect(result).toEqual({ heading: 'In a huddle', microphone: 'granted' });
});

test('A BLANK WINDOW SENT TO A LINK OFF THE ALLOWLIST CLOSES — the browser has the link', async () => {
  h = await launchAsSlack();
  await h.rail();
  const result = await h.app.evaluate(async ({ BrowserWindow, shell, webContents }) => {
    const opened: string[] = [];
    const original = shell.openExternal;
    shell.openExternal = async (url: string) => void opened.push(url);
    try {
      let slack = null;
      for (let i = 0; i < 50 && !slack; i++) {
        slack = webContents.getAllWebContents().find((c) => c.getURL().endsWith('/huddle') && !c.isLoading()) ?? null;
        if (!slack) await new Promise((r) => setTimeout(r, 100));
      }
      await slack!.executeJavaScript(
        "const w = window.open('about:blank'); w.opener = null; w.location = 'https://example.com/elsewhere'; true",
        true,
      );
      await new Promise((r) => setTimeout(r, 1500));
      const leftOpen = BrowserWindow.getAllWindows().filter((w) => ['about:blank', ''].includes(w.webContents.getURL()));
      return { opened, leftOpen: leftOpen.length };
    } finally {
      shell.openExternal = original;
    }
  });
  expect(result.opened).toEqual(['https://example.com/elsewhere']);
  expect(result.leftOpen, 'no empty window left behind').toBe(0);
});

test("A BLANK FRAME INSIDE SOMEONE ELSE'S EMBED ISN'T THE SERVICE — it's judged by its own origin", async () => {
  h = await launchAsSlack();
  await h.rail();
  const state = await h.app.evaluate(async ({ webContents }) => {
    for (let i = 0; i < 60; i++) {
      const slack = webContents.getAllWebContents().find((c) => c.getURL().endsWith('/huddle'));
      const embed = slack?.mainFrame.frames.find((f) => f.url.endsWith('/embed'));
      if (embed) {
        try {
          return await embed.executeJavaScript('window.blankMicrophone ? window.blankMicrophone() : null');
        } catch {
          // Not ready yet.
        }
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    return 'no embed';
  });
  expect(state).toBe('denied');
});

/** The blank windows open now — the huddle, or anything else about:blank — by what they show. */
const blankWindows = () =>
  h.app.evaluate(async ({ BrowserWindow }) =>
    Promise.all(
      BrowserWindow.getAllWindows()
        .filter((w) => !w.isDestroyed() && ['about:blank', ''].includes(w.webContents.getURL()))
        .map((w) => w.webContents.executeJavaScript('document.body ? document.body.innerText : ""') as Promise<string>),
    ),
  );

const slackPage = () =>
  h.app.evaluate(async ({ webContents }) => {
    for (let i = 0; i < 60; i++) {
      if (webContents.getAllWebContents().some((c) => c.getURL().endsWith('/huddle') && !c.isLoading())) return true;
      await new Promise((r) => setTimeout(r, 100));
    }
    return false;
  });

test("A BLANK WINDOW OPENED BY SOMEONE ELSE'S EMBED IS CLOSED — only the service may open one", async () => {
  // A third-party frame in Slack could open a window with no address bar and Slack's cookie jar,
  // and write anything into it. The opener's origin is what gives it away.
  h = await launchAsSlack();
  await h.rail();
  expect(await slackPage()).toBe(true);
  await h.app.evaluate(async ({ webContents }) => {
    for (let i = 0; i < 60; i++) {
      const slack = webContents.getAllWebContents().find((c) => c.getURL().endsWith('/huddle'));
      const embed = slack?.mainFrame.frames.find((f) => f.url.endsWith('/embed'));
      if (embed) {
        try {
          await embed.executeJavaScript('window.openBlank()', true);
          return;
        } catch {
          // Not ready yet.
        }
      }
      await new Promise((r) => setTimeout(r, 100));
    }
  });
  await new Promise((r) => setTimeout(r, 1000));
  expect(await blankWindows(), 'no window left open, planted or otherwise').toEqual([]);
});

test('A LINK REFUSED INSIDE THE HUDDLE LEAVES THE CALL UP — its address is about:blank all its life', async () => {
  h = await launchAsSlack();
  await h.rail();
  expect(await slackPage()).toBe(true);
  const opened = await h.app.evaluate(async ({ BrowserWindow, shell, webContents }) => {
    const sent: string[] = [];
    const original = shell.openExternal;
    shell.openExternal = async (url: string) => void sent.push(url);
    try {
      const slack = webContents.getAllWebContents().find((c) => c.getURL().endsWith('/huddle'))!;
      await slack.executeJavaScript("document.getElementById('start').click(); true", true);
      await new Promise((r) => setTimeout(r, 800));
      const huddle = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL() === 'about:blank')!;
      // A link clicked in the call, off Slack's allowlist.
      await huddle.webContents.executeJavaScript("location.href = 'https://example.com/shared-doc'; true", true);
      await new Promise((r) => setTimeout(r, 1200));
      return sent;
    } finally {
      shell.openExternal = original;
    }
  });
  expect(opened, 'the link went to the browser').toEqual(['https://example.com/shared-doc']);
  expect(await blankWindows(), 'and the huddle is still there, as it was drawn').toEqual(['In a huddle']);
});

test('A BLANK WINDOW WHOSE LINK GOES TO ANOTHER OF YOUR SERVICES CLOSES TOO — it was left open and empty', async () => {
  h = await launch((origin) => {
    const localhost = origin.replace('127.0.0.1', 'localhost');
    const config = seedConfig(origin, { preferences: { behaviour: { routeLinks: true } } }) as ReturnType<typeof seedConfig> & {
      services: Array<Record<string, unknown>>;
    };
    config.services[0] = { ...config.services[0], catalogId: 'slack', name: 'Slack', url: `${origin}/huddle` };
    config.services[1] = { ...config.services[1], url: `${localhost}/unread`, allowedHosts: ['localhost'] };
    return config;
  });
  await h.rail();
  expect(await slackPage()).toBe(true);
  const target = `${h.fixture.origin.replace('127.0.0.1', 'localhost')}/unread/routed`;
  const landed = await h.app.evaluate(async ({ shell, webContents }, target) => {
    const original = shell.openExternal;
    shell.openExternal = async () => {};
    try {
      const slack = webContents.getAllWebContents().find((c) => c.getURL().endsWith('/huddle'))!;
      await slack.executeJavaScript(
        `const w = window.open('about:blank'); w.location = ${JSON.stringify(target)}; true`,
        true,
      );
      await new Promise((r) => setTimeout(r, 2000));
      return webContents.getAllWebContents().some((c) => c.getURL() === target);
    } finally {
      shell.openExternal = original;
    }
  }, target);
  expect(landed, 'routed to the other service').toBe(true);
  expect(await blankWindows(), 'and no empty window left behind').toEqual([]);
});

