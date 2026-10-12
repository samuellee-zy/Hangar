import fs from 'node:fs';
import path from 'node:path';
import { test, expect } from '@playwright/test';
import { launch, seedConfig, tearDown, type Harness } from './harness';

/**
 * A sign-in that goes to a host the service doesn't list. Slack's "Sign in with Google IDP" sent the
 * workspace to accounts.google.com, which Slack's list didn't have: the redirect was handed to the
 * browser, which signed itself in, and the pane sat on Slack's sign-in page with nothing to say why.
 *
 * `idp.test` is pointed at the fixture server, so the identity provider is another host — as it is
 * for real — and one Allow can add: a name without a dot is never accepted onto an allowlist.
 */

let h: Harness;
test.afterEach(async ({}, testInfo) => {
  await tearDown(h, testInfo);
});

const launchAtSignIn = () =>
  launch(
    (origin) => {
      const config = seedConfig(origin) as ReturnType<typeof seedConfig> & { services: Array<Record<string, unknown>> };
      config.services[0] = { ...config.services[0], url: `${origin}/sso` };
      return config;
    },
    { args: ['--host-resolver-rules=MAP idp.test 127.0.0.1'] },
  );

/** The pane's page, once it's loaded and not the one given. */
const pane = () =>
  h.app.evaluate(async () => {
    const shell = (globalThis as never as { __hangarShell: { contentsForService: (id: string) => Electron.WebContents | null } }).__hangarShell;
    const wc = shell.contentsForService('one');
    if (!wc || wc.isLoading()) return null;
    return { url: wc.getURL(), text: (await wc.executeJavaScript('document.body.innerText', true)) as string };
  });

/** Clicks in One's pane, as a person would. */
const click = (selector: string) =>
  h.app.evaluate(async (_electron, selector) => {
    const shell = (globalThis as never as { __hangarShell: { contentsForService: (id: string) => Electron.WebContents | null } }).__hangarShell;
    await shell.contentsForService('one')!.executeJavaScript(`document.querySelector(${JSON.stringify(selector)}).click(); true`, true);
  }, selector);

const watchBrowser = () =>
  h.app.evaluate(({ shell }) => {
    const opened = ((globalThis as never as { __opened: string[] }).__opened = []);
    shell.openExternal = async (url: string) => void opened.push(url);
  });
const opened = () => h.app.evaluate(() => (globalThis as never as { __opened: string[] }).__opened);

test('A SIGN-IN TO A HOST THE SERVICE DOES NOT LIST ASKS IN THE PANE — and Allow carries on signing in there', async () => {
  h = await launchAtSignIn();
  await h.rail();
  await expect.poll(async () => (await pane())?.url ?? '').toContain('/sso');
  await watchBrowser();

  await click('#sso');
  await expect.poll(async () => (await pane())?.text ?? '').toContain('Sign in to One through idp.test?');
  expect(await opened(), 'not to the browser: it would have signed the browser in').toEqual([]);
  expect(h.log()).toContain('[nav] One: idp.test is a sign-in step not on the allowlist (will-redirect) — asking');

  await click('button');
  await expect.poll(async () => (await pane())?.url ?? '', 'on to the step that was stopped').toMatch(
    /^http:\/\/idp\.test:\d+\/o\/saml2\/idp\?SAMLRequest=fZJdb&RelayState=r1$/,
  );
  expect((await pane())?.text).toContain('Choose an account');
  // Written a moment later: config writes are debounced.
  const onDisk = () =>
    JSON.parse(fs.readFileSync(path.join(h.userData, 'config.json'), 'utf8')).services.find((s: { id: string }) => s.id === 'one')
      .extraAllowedHosts;
  await expect.poll(onDisk, 'kept, for the next sign-in').toEqual(['idp.test']);
});

test('A REDIRECT THAT IS NOT A SIGN-IN STILL GOES TO THE BROWSER, and the pane stays where it was', async () => {
  h = await launchAtSignIn();
  await h.rail();
  await expect.poll(async () => (await pane())?.url ?? '').toContain('/sso');
  await watchBrowser();

  await click('#out');
  await expect.poll(opened).toEqual([expect.stringMatching(/^http:\/\/idp\.test:\d+\/elsewhere$/)]);
  expect((await pane())?.url).toMatch(/\/sso$/);
});
