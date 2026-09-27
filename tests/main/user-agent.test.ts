// The user agent a service's page is given. WhatsApp refuses any product token beside `Chrome/…` —
// "WhatsApp works with Google Chrome 100+", at Chrome 150 — so its entry asks for the plain one.

import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { userAgentFor, withoutAppToken } from '@core/services/user-agent';
import { catalogById } from '@shared/catalog';

const OURS =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Hangar/0.1.0 Chrome/150.0.7871.129 Safari/537.36';
const CHROME =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.7871.129 Safari/537.36';

describe('the user agent a page gets', () => {
  it('WITHOUT THE APP TOKEN IS EXACTLY WHAT CHROME SENDS', () => {
    assert.equal(withoutAppToken(OURS, 'Hangar'), CHROME);
    assert.equal(withoutAppToken(CHROME, 'Hangar'), CHROME, 'nothing to take out');
  });

  it("WhatsApp's entry asks for it, and gets it", () => {
    assert.equal(catalogById('whatsapp')?.plainUserAgent, true);
    assert.equal(userAgentFor({}, catalogById('whatsapp'), OURS, 'Hangar'), CHROME);
  });

  it('every other service keeps the default — Google sign-in is known to accept it', () => {
    assert.equal(userAgentFor({}, catalogById('gmail'), OURS, 'Hangar'), null);
    assert.equal(userAgentFor({}, undefined, OURS, 'Hangar'), null, 'a custom connection');
  });

  it('a user agent set on the service wins, even over the plain one', () => {
    assert.equal(userAgentFor({ userAgent: 'Mine/1.0' }, catalogById('whatsapp'), OURS, 'Hangar'), 'Mine/1.0');
    assert.equal(userAgentFor({ userAgent: '  ' }, catalogById('whatsapp'), OURS, 'Hangar'), CHROME, 'blank is unset');
  });
});
