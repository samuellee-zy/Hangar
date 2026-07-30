// Notification policy. The subtle rule is that suppressing a banner and ignoring an event are
// different things — get that wrong and Do Not Disturb silently loses messages instead of deferring
// them, which is the one outcome nobody would forgive.
//

import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { badgeTotal, decideNotification, nextUnread } from '@core/notify/policy';


const ctx = (over = {}) => ({ enabled: true, dnd: false, level: 'all', visible: false, ...over });

describe("banner vs count", () => {

  it('a background notification banners and counts', () => {
    assert.deepEqual(decideNotification(ctx()), { banner: true, count: true });
  });

  it('DND SUPPRESSES THE BANNER BUT STILL COUNTS — nothing is lost while you focus', () => {
    assert.deepEqual(decideNotification(ctx({ dnd: true })), { banner: false, count: true });
  });

  it('a muted service neither banners nor counts — you asked not to care', () => {
    assert.deepEqual(decideNotification(ctx({ level: 'muted' })), { banner: false, count: false });
  });

  it('muting beats DND, and beats being visible', () => {
    assert.deepEqual(decideNotification(ctx({ level: 'muted', dnd: true })), {
      banner: false,
      count: false,
    });
    assert.deepEqual(decideNotification(ctx({ level: 'muted', visible: true })), {
      banner: false,
      count: false,
    });
  });

  it('notifications off globally behaves like muting everything', () => {
    assert.deepEqual(decideNotification(ctx({ enabled: false })), { banner: false, count: false });
  });

  it('a visible service neither banners nor counts — you can already see it', () => {
    assert.deepEqual(decideNotification(ctx({ visible: true })), { banner: false, count: false });
  });

  it('visible wins over DND: no phantom unread for a pane in front of you', () => {
    assert.deepEqual(decideNotification(ctx({ visible: true, dnd: true })), {
      banner: false,
      count: false,
    });
  });
});

describe("unread accumulation", () => {

  it('counting increments, suppressing does not', () => {
    assert.equal(nextUnread(3, { banner: true, count: true }), 4);
    assert.equal(nextUnread(3, { banner: false, count: true }), 4, 'DND still accrues');
    assert.equal(nextUnread(3, { banner: false, count: false }), 3);
  });

  it('a run of DND notifications accumulates rather than collapsing to one', () => {
    let n = 0;
    for (let i = 0; i < 5; i++) n = nextUnread(n, decideNotification(ctx({ dnd: true })));
    assert.equal(n, 5);
  });
});

describe("badge total", () => {

  it('the badge sums every service', () => {
    assert.equal(badgeTotal([1, 2, 3]), 6);
  });

  it('an empty app badges 0, not NaN — macOS needs an explicit 0 to clear', () => {
    assert.equal(badgeTotal([]), 0);
  });

  it('negative counts cannot drag the total below zero', () => {
    assert.equal(badgeTotal([5, -3]), 5);
  });
});
