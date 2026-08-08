// Promoting session cookies so a restart doesn't sign you out of everything.
//
// The bug that prompted these: Gmail reported `rejected 1` every 60 seconds, forever, because the
// cookie being retried could never succeed. Two separate defects in one line of output — a cookie
// that would not promote, and a log that repeated a steady state until it filled the pipe whose
// collapse later took the app down.

import { describe, it, expect, vi } from 'vitest';
import { promoteSessionCookies } from '@main/platform/persist-cookies';

type SetDetails = Electron.CookiesSetDetails;

const cookie = (over: Partial<Electron.Cookie> = {}): Electron.Cookie =>
  ({
    name: 'sid',
    value: 'v',
    domain: '.example.com',
    path: '/',
    secure: true,
    httpOnly: true,
    session: true,
    ...over,
  }) as Electron.Cookie;

/**
 * A session whose `cookies.set` enforces the prefix rules Chromium enforces, so a test can fail the
 * way the real store fails rather than the way we assume it does.
 */
function fakeSession(cookies: Electron.Cookie[]) {
  const set = vi.fn(async (details: SetDetails) => {
    // Electron rejects a details object whose URL has no host, which is what a cookie with no
    // usable domain produces.
    if (!/^https?:\/\/[^/]+/.test(details.url)) throw new Error(`invalid url: ${details.url}`);
    if (details.name?.startsWith('__Host-')) {
      if (details.domain !== undefined) throw new Error('__Host- cookies may not specify a domain');
      if (details.path !== '/') throw new Error('__Host- cookies must have path /');
      if (!details.secure) throw new Error('__Host- cookies must be secure');
    }
    if (details.name?.startsWith('__Secure-') && !details.secure) {
      throw new Error('__Secure- cookies must be secure');
    }
  });

  return {
    session: {
      cookies: { get: async () => cookies, set, flushStore: async () => {} },
    } as unknown as Electron.Session,
    set,
  };
}

describe('promoting cookies that Chromium is fussy about', () => {

  it('promotes a __Host- cookie instead of failing it forever', () => {
    // The regression. `cookies.get` reports a resolved host in `domain` for these, and handing that
    // straight back is rejected every single time — so the cookie never gained an expiry and the
    // user was signed out of Gmail on every restart, while the log claimed one rejection a minute.
    const { session, set } = fakeSession([
      cookie({ name: '__Host-GAPS', domain: 'accounts.google.com', path: '/' }),
    ]);

    return promoteSessionCookies(session, { label: 'host-prefix' }).then((result) => {
      expect(result).toEqual({ promoted: 1, failed: 0 });
      const details = set.mock.calls[0][0];
      expect(details.domain, 'a Domain attribute is what invalidates the prefix').toBeUndefined();
      expect(details.path).toBe('/');
      expect(details.secure).toBe(true);
      expect(details.url).toBe('https://accounts.google.com/');
    });
  });

  it('keeps the domain for an ordinary cookie, which needs it to stay cross-subdomain', async () => {
    const { session, set } = fakeSession([cookie({ name: 'sid', domain: '.example.com' })]);
    await promoteSessionCookies(session, { label: 'ordinary' });
    expect(set.mock.calls[0][0].domain).toBe('.example.com');
  });

  it('forces secure on a __Secure- cookie rather than letting it reject', async () => {
    const { session, set } = fakeSession([cookie({ name: '__Secure-1PSID', secure: false })]);
    const result = await promoteSessionCookies(session, { label: 'secure-prefix' });
    expect(result).toEqual({ promoted: 1, failed: 0 });
    expect(set.mock.calls[0][0].secure).toBe(true);
  });

  it('gives every promoted cookie an expiry, which is the entire point', async () => {
    const { session, set } = fakeSession([cookie()]);
    const before = Math.floor(Date.now() / 1000);
    await promoteSessionCookies(session, { label: 'expiry', ttlDays: 30 });
    const { expirationDate } = set.mock.calls[0][0];
    expect(expirationDate).toBeGreaterThanOrEqual(before + 29 * 86400);
  });

  it('leaves cookies that already have an expiry alone', async () => {
    const { session, set } = fakeSession([cookie({ expirationDate: 1_900_000_000 })]);
    const result = await promoteSessionCookies(session, { label: 'already-persistent' });
    expect(result).toEqual({ promoted: 0, failed: 0 });
    expect(set).not.toHaveBeenCalled();
  });

  it('one unusable cookie does not stop the rest of the jar', async () => {
    // The loop is sequential and each `set` is awaited, so a throw that escaped would abandon every
    // cookie after it — silently signing the user out of whatever sorted later.
    const { session } = fakeSession([
      cookie({ name: '__Host-ok', domain: 'x.test' }),
      cookie({ name: 'no-domain', domain: '' }),
      cookie({ name: 'plain' }),
    ]);
    const result = await promoteSessionCookies(session, { label: 'mixed' });
    expect(result).toEqual({ promoted: 2, failed: 1 });
  });
});

describe('a log line that does not repeat itself once a minute', () => {

  const captureLog = () => vi.spyOn(console, 'log').mockImplementation(() => {});

  it('reports a steady state once, not on every sweep', async () => {
    // The 60-second persistence loop calls this forever. Before the dedupe, an unchanging result
    // printed an identical line every minute for as long as the app ran.
    const log = captureLog();
    const { session } = fakeSession([cookie({ name: 'rotating' })]);

    for (let sweep = 0; sweep < 5; sweep++) {
      await promoteSessionCookies(session, { label: 'steady' });
    }

    expect(log).toHaveBeenCalledTimes(1);
    log.mockRestore();
  });

  it('speaks up again when the result actually changes', async () => {
    const log = captureLog();
    const one = fakeSession([cookie({ name: 'a' })]);
    await promoteSessionCookies(one.session, { label: 'changing' });

    const two = fakeSession([cookie({ name: 'a' }), cookie({ name: 'b' })]);
    await promoteSessionCookies(two.session, { label: 'changing' });

    expect(log).toHaveBeenCalledTimes(2);
    log.mockRestore();
  });

  it('names the cookies, so a repeat is diagnosable without a debugger', async () => {
    // `promoted 1` every minute is a mystery; `promoted 1 (esctx)` is Azure AD reissuing its
    // session context cookie, which is the service's business and not a bug here.
    const log = captureLog();
    const { session } = fakeSession([cookie({ name: 'esctx' })]);
    await promoteSessionCookies(session, { label: 'named' });
    expect(log.mock.calls[0][0]).toContain('esctx');
    log.mockRestore();
  });

  it('says nothing at all when there was nothing to do', async () => {
    const log = captureLog();
    const { session } = fakeSession([]);
    await promoteSessionCookies(session, { label: 'quiet' });
    expect(log).not.toHaveBeenCalled();
    log.mockRestore();
  });
});
