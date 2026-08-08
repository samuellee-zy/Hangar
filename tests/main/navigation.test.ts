// The navigation allowlist: what stays in the pane, what is handed to the system browser, and
// what the user is told about it.
//
// This had no coverage at all until now — only `isAllowedHost` was exercised, indirectly, through
// the catalog. The guards *around* it are where the two interesting bugs lived:
//
//   - `will-redirect` was not handled, so a 302 from an allowed host could walk the main frame to
//     any host at all while still carrying the service's cookie jar. The popup equivalent of this
//     hole was already closed by `did-create-window`; the main frame's was not.
//   - a block must not cost the user a working page. Clicking an external link in a loaded service
//     is the overwhelmingly common block, and replacing the pane with an explanation each time
//     would break the everyday case to serve the rare one.

import { describe, it, beforeEach } from 'vitest';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { shell } from 'electron';
import { attachNavigationGuards, isAllowedHost } from '@main/platform/session';
import type { ServiceInstance } from '@shared/types';

const openedUrls = () => (shell as unknown as { opened: string[] }).opened;

/**
 * Stand-in for a WebContents. The guards touch four things: `setWindowOpenHandler`, `on`,
 * `getURL` and `loadURL`. Casting here rather than at each call site keeps the "this is partial"
 * claim in one place, as in shortcuts.test.ts.
 */
class FakeContents extends EventEmitter {
  url: string;
  loaded: string[] = [];
  windowOpenHandler: ((details: { url: string }) => unknown) | null = null;

  constructor(url = '') {
    super();
    this.url = url;
  }

  getURL() {
    return this.url;
  }

  loadURL(target: string) {
    this.loaded.push(target);
    this.url = target;
    return Promise.resolve();
  }

  setWindowOpenHandler(handler: (details: { url: string }) => unknown) {
    this.windowOpenHandler = handler;
  }

  get asContents(): Electron.WebContents {
    return this as unknown as Electron.WebContents;
  }

  /** Returns whether the guard cancelled the navigation. */
  navigate(event: 'will-navigate' | 'will-redirect', url: string) {
    let prevented = false;
    this.emit(event, { preventDefault: () => (prevented = true) }, url);
    return prevented;
  }
}

// A custom connection: it carries its own allowlist, so these tests never depend on the catalog
// staying the shape it is today.
const service = (extra?: Partial<ServiceInstance>): ServiceInstance =>
  ({
    id: 'svc-1',
    name: 'Example',
    catalogId: '__custom',
    accountId: 'acct-1',
    url: 'https://example.com/',
    allowedHosts: ['example.com'],
    ...extra,
  }) as ServiceInstance;

beforeEach(() => {
  openedUrls().length = 0;
});

describe('isAllowedHost', () => {
  it('matches the host itself and anything beneath it', () => {
    const svc = service();
    assert.equal(isAllowedHost(svc, 'https://example.com/inbox'), true);
    assert.equal(isAllowedHost(svc, 'https://mail.example.com/'), true);
    assert.equal(isAllowedHost(svc, 'https://elsewhere.test/'), false);
    // The suffix match is anchored on a dot, so a host merely *ending* in the string is not a
    // match — `notexample.com` must not pass because `example.com` is allowed.
    assert.equal(isAllowedHost(svc, 'https://notexample.com/'), false);
  });

  it('unions extraAllowedHosts rather than replacing the list', () => {
    // The point of the separate field: a host added by hand must not cost the service the list it
    // already had, or a later catalog fix could never reach it.
    const svc = service({ extraAllowedHosts: ['login.example.test'] });
    assert.equal(isAllowedHost(svc, 'https://login.example.test/'), true);
    assert.equal(isAllowedHost(svc, 'https://example.com/'), true);
    assert.equal(isAllowedHost(svc, 'https://elsewhere.test/'), false);
  });

  it('an unparseable URL is not allowed', () => {
    assert.equal(isAllowedHost(service(), 'not a url'), false);
  });
});

describe('attachNavigationGuards', () => {
  it('lets an allowed navigation through untouched', () => {
    const wc = new FakeContents('https://example.com/');
    attachNavigationGuards(wc.asContents, service(), 'persist:test');

    assert.equal(wc.navigate('will-navigate', 'https://example.com/settings'), false);
    assert.deepEqual(openedUrls(), []);
    assert.deepEqual(wc.loaded, []);
  });

  it('blocks a navigation off the allowlist and opens it in the browser', () => {
    const wc = new FakeContents('https://example.com/');
    attachNavigationGuards(wc.asContents, service(), 'persist:test');

    assert.equal(wc.navigate('will-navigate', 'https://elsewhere.test/page'), true);
    assert.deepEqual(openedUrls(), ['https://elsewhere.test/page']);
  });

  it('BLOCKS A SERVER-SIDE REDIRECT — the bypass this suite exists for', () => {
    // `will-navigate` fires only for navigations the page asks for. A 302 fires this instead, and
    // while it went unhandled an allowed host could redirect the main frame anywhere.
    const wc = new FakeContents('https://example.com/');
    attachNavigationGuards(wc.asContents, service(), 'persist:test');

    assert.equal(wc.navigate('will-redirect', 'https://elsewhere.test/steal'), true);
    assert.deepEqual(openedUrls(), ['https://elsewhere.test/steal']);
  });

  it('a redirect that stays on the allowlist is not disturbed', () => {
    const wc = new FakeContents('https://example.com/');
    attachNavigationGuards(wc.asContents, service(), 'persist:test');

    assert.equal(wc.navigate('will-redirect', 'https://sso.example.com/authorize'), false);
    assert.deepEqual(openedUrls(), []);
  });

  it('NEVER REPLACES A GOOD PAGE — clicking an external link leaves the service alone', () => {
    // The regression guard. Showing the blocked page unconditionally would mean every external
    // link click in a loaded service destroyed the page the user was reading.
    const wc = new FakeContents('https://example.com/inbox');
    attachNavigationGuards(wc.asContents, service(), 'persist:test');

    wc.navigate('will-navigate', 'https://elsewhere.test/page');

    assert.deepEqual(wc.loaded, []);
    assert.equal(wc.getURL(), 'https://example.com/inbox');
  });

  it('explains itself when the block leaves the pane with nothing', () => {
    // The opposite case, and the one that made Teams look broken: the block interrupted the
    // service's own load, so there is no page to keep and a silent bounce leaves a dead pane.
    const wc = new FakeContents('');
    attachNavigationGuards(wc.asContents, service(), 'persist:test');

    wc.navigate('will-navigate', 'https://elsewhere.test/page');

    assert.equal(wc.loaded.length, 1);
    const page = decodeURIComponent(wc.loaded[0]!);
    assert.ok(page.startsWith('data:text/html'));
    assert.ok(page.includes('elsewhere.test'));
    assert.ok(page.includes('Example'));
  });

  it('replaces about:blank and its own blocked page too', () => {
    for (const start of ['about:blank', 'data:text/html;charset=utf-8,x']) {
      const wc = new FakeContents(start);
      attachNavigationGuards(wc.asContents, service(), 'persist:test');
      wc.navigate('will-redirect', 'https://elsewhere.test/page');
      assert.equal(wc.loaded.length, 1, start);
    }
  });

  it('escapes what it interpolates into the blocked page', () => {
    // Service names are user-controlled and the URL comes off the wire. See decisions #34.
    const wc = new FakeContents('');
    attachNavigationGuards(wc.asContents, service({ name: '<img src=x onerror=alert(1)>' }), 'p');

    wc.navigate('will-navigate', 'https://elsewhere.test/"><script>alert(1)</script>');

    const page = decodeURIComponent(wc.loaded[0]!);
    assert.ok(!page.includes('<img src=x'));
    assert.ok(!page.includes('<script>alert(1)</script>'));
    assert.ok(page.includes('&lt;img src=x'));
  });

  it('opens a disallowed popup externally instead of in a window', () => {
    const wc = new FakeContents('https://example.com/');
    attachNavigationGuards(wc.asContents, service(), 'persist:test');

    const denied = wc.windowOpenHandler!({ url: 'https://elsewhere.test/' }) as {
      action: string;
    };
    assert.equal(denied.action, 'deny');
    assert.deepEqual(openedUrls(), ['https://elsewhere.test/']);

    // Sign-in flows are popups, so an allowed one has to survive — and in the service's own
    // partition, or it would open signed out.
    const allowed = wc.windowOpenHandler!({ url: 'https://sso.example.com/' }) as {
      action: string;
      overrideBrowserWindowOptions: { webPreferences: { partition: string } };
    };
    assert.equal(allowed.action, 'allow');
    assert.equal(allowed.overrideBrowserWindowOptions.webPreferences.partition, 'persist:test');
  });
});
