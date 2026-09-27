// mailto: links → compose screens. The template has to carry every part of the message, or the
// feature half-works: the address arrives and the subject someone clicked for does not.

import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { canCompose, composeUrlFor, parseMailto } from '@shared/mailto';

describe('reading a mailto link', () => {
  it('addresses, subject, body, cc and bcc — decoded', () => {
    assert.deepEqual(
      parseMailto('mailto:a@x.com,b@y.com?Subject=Hello%20there&cc=c@z.com&body=Line%201%0ALine%202&bcc=d@w.com'),
      { to: 'a@x.com,b@y.com', cc: 'c@z.com', bcc: 'd@w.com', subject: 'Hello there', body: 'Line 1\nLine 2' },
    );
  });

  it('a bare address is enough; anything that is not mailto is not one', () => {
    assert.equal(parseMailto('mailto:a@x.com')?.to, 'a@x.com');
    assert.equal(parseMailto('https://example.com'), null);
  });
});

describe('compose URLs', () => {
  const link = 'mailto:a@x.com?subject=Invoice%20%2342&body=Hi';

  it('Gmail takes the link whole, through its own handler', () => {
    assert.equal(
      composeUrlFor('gmail', link),
      `https://mail.google.com/mail/?extsrc=mailto&url=${encodeURIComponent(link)}`,
    );
  });

  it('OUTLOOK GETS EVERY PART — the subject, with its #, survives the trip', () => {
    const url = new URL(composeUrlFor('outlook', link)!);
    assert.equal(url.origin + url.pathname, 'https://outlook.office.com/mail/deeplink/compose');
    assert.equal(url.searchParams.get('to'), 'a@x.com');
    assert.equal(url.searchParams.get('subject'), 'Invoice #42');
    assert.equal(url.searchParams.get('body'), 'Hi');
  });

  it('only services with a known compose entry point are offered', () => {
    assert.equal(canCompose('gmail'), true);
    assert.equal(canCompose('slack'), false);
    assert.equal(composeUrlFor('slack', link), null);
  });
});
