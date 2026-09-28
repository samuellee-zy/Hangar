// Notification policy. The subtle rule is that suppressing a banner and ignoring an event are
// different things — get that wrong and Do Not Disturb silently loses messages instead of deferring
// them, which is the one outcome nobody would forgive.
//

import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import {
  badgeTotal,
  decideNotification,
  nextUnread,
  normaliseNotification,
} from '@core/notify/policy';
import {
  UnreadCounts,
  countFromBadgeText,
  describeDomReading,
  resolveUnreadRules,
  unreadFromDom,
  unreadFromTitle,
} from '@core/notify/unread';
import { catalog, catalogById } from '@shared/catalog';


const ctx = (over = {}) => ({
  enabled: true,
  dnd: false,
  level: 'all' as const,
  serviceEnabled: true,
  inVisiblePane: false,
  windowVisible: true,
  ...over,
});

describe("banner vs count", () => {

  it('BADGE ONLY COUNTS AND NEVER BANNERS — a service you want waiting, not interrupting', () => {
    assert.deepEqual(decideNotification(ctx({ level: 'badge' })), { banner: false, count: true });
    // Still nothing for a message you were looking at, like every other level.
    assert.deepEqual(decideNotification(ctx({ level: 'badge', inVisiblePane: true })), {
      banner: false,
      count: false,
    });
  });

  it('a background notification banners and counts', () => {
    assert.deepEqual(decideNotification(ctx()), { banner: true, count: true });
  });

  it('DND SUPPRESSES THE BANNER BUT STILL COUNTS — nothing is lost while you focus', () => {
    assert.deepEqual(decideNotification(ctx({ dnd: true })), { banner: false, count: true });
  });

  it('a muted service neither banners nor counts — you asked not to care', () => {
    assert.deepEqual(decideNotification(ctx({ level: 'muted' as const })), { banner: false, count: false });
  });

  it('muting beats DND, and beats being visible', () => {
    assert.deepEqual(decideNotification(ctx({ level: 'muted' as const, dnd: true })), {
      banner: false,
      count: false,
    });
    assert.deepEqual(decideNotification(ctx({ level: 'muted' as const, inVisiblePane: true })), {
      banner: false,
      count: false,
    });
  });

  it('notifications off globally behaves like muting everything', () => {
    assert.deepEqual(decideNotification(ctx({ enabled: false })), { banner: false, count: false });
  });

  it('a visible service neither banners nor counts — you can already see it', () => {
    assert.deepEqual(decideNotification(ctx({ inVisiblePane: true })), { banner: false, count: false });
  });

  it('visible wins over DND: no phantom unread for a pane in front of you', () => {
    assert.deepEqual(decideNotification(ctx({ inVisiblePane: true, dnd: true })), {
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

// A3 and A14.2. Both flipped from the characterisation baseline: previously `visible` was pane
// occupancy alone, and the per-service toggle was not consulted here at all.
describe('the two vetoes that were missing', () => {
  it('CLOSE-TO-TRAY NO LONGER SILENCES THE FRONT PANE', () => {
    // Pane occupancy used to be the whole test. With closeToTray on, closing the window while
    // Slack held the focused pane discarded every Slack message — the app believed you were
    // looking at a pane inside a hidden window.
    assert.deepEqual(ctx, ctx); // keep the helper referenced for readers
    const hidden = decideNotification(ctx({ inVisiblePane: true, windowVisible: false }));
    assert.deepEqual(hidden, { banner: true, count: true });
  });

  it('a visible pane in a visible window still suppresses, as before', () => {
    assert.deepEqual(
      decideNotification(ctx({ inVisiblePane: true, windowVisible: true })),
      { banner: false, count: false }
    );
  });

  it('a minimised window is not "looking at it" either', () => {
    // windowVisible folds in isMinimized() on the caller's side.
    assert.deepEqual(
      decideNotification(ctx({ inVisiblePane: true, windowVisible: false, dnd: true })),
      { banner: false, count: true }
    );
  });

  it("the per-service toggle now gates banners, not just push", () => {
    // It gated pushEligible but never decideNotification, so turning notifications off for a
    // service stopped pushes while banners kept arriving.
    assert.deepEqual(
      decideNotification(ctx({ serviceEnabled: false })),
      { banner: false, count: false }
    );
  });
});

// D1 — reading unread from what a service displays, rather than tallying the notifications it
// fires. A tally only ever rises, never reflects what you read elsewhere, and is zero for a
// service whose browser notifications are off.
describe('unread from the page title', () => {
  // Mirrors the catalog. The `\\+?` is load-bearing: without it "(99+)" fails to match, and a
  // busy Slack reports ZERO unread rather than a lot.
  const gmail = { titlePattern: '^\\((\\d+)\\+?\\)' };

  it('reads the count out of a real Gmail title', () => {
    assert.equal(unreadFromTitle('(5) Inbox - you@gmail.com - Gmail', gmail), 5);
  });

  it('reads a real Slack title', () => {
    assert.equal(unreadFromTitle('(3) Slack | general | Acme', gmail), 3);
  });

  it('A TITLE THAT STOPS MATCHING MEANS ZERO — this is how reading elsewhere clears the badge', () => {
    // The behaviour a running tally structurally cannot have.
    assert.equal(unreadFromTitle('Inbox - you@gmail.com - Gmail', gmail), 0);
  });

  it('NULL when no pattern is declared — no information, which is not zero', () => {
    // Custom connections have no pattern, and a global parser would invent counts from any page
    // whose title happens to contain a bracketed number.
    assert.equal(unreadFromTitle('(2) Draft — Notion', undefined), null);
    assert.equal(unreadFromTitle('(2) Draft', {}), null);
  });

  it('a match with no capture group counts as one', () => {
    // Covers sites that show a bare dot or asterisk rather than a number.
    assert.equal(unreadFromTitle('• Linear', { titlePattern: '^•' }), 1);
  });

  it('handles 99+ and other truncated counts', () => {
    assert.equal(unreadFromTitle('(99+) Slack', gmail), 99);
  });

  it('a malformed pattern returns null rather than throwing', () => {
    // One bad catalog entry must not break title handling for every other service.
    assert.equal(unreadFromTitle('(1) x', { titlePattern: '([unclosed' }), null);
  });

  it('clamps a negative capture to zero rather than taking its absolute value', () => {
    // Nonsense input should read as "nothing unread", not "four unread".
    assert.equal(unreadFromTitle('(-4) x', { titlePattern: '\\((-?\\d+)\\)' }), 0);
  });

  it("GMAIL'S COUNT COMES AFTER THE LABEL — it read zero while open, since the rule wanted it first", () => {
    const rule = catalogById('gmail')!.unread;
    assert.equal(unreadFromTitle('Inbox (3) - you@gmail.com - Gmail', rule), 3);
    assert.equal(unreadFromTitle('Primary (12) - you@gmail.com - Gmail', rule), 12);
    assert.equal(unreadFromTitle('(5) Inbox - you@gmail.com - Gmail', rule), 5, 'the other order too');
    assert.equal(unreadFromTitle('Inbox - you@gmail.com - Gmail', rule), 0);
    // A count is only taken before the first dash: after it is the address, then a subject.
    assert.equal(unreadFromTitle('Starred - you@gmail.com - Gmail (2)', rule), 0);
  });

  it('A THOUSANDS SEPARATOR IS PART OF THE COUNT — "(1,234)" was one', () => {
    const rule = catalogById('gmail')!.unread;
    assert.equal(unreadFromTitle('Inbox (1,234) - you@gmail.com - Gmail', rule), 1234);
    assert.equal(unreadFromTitle('Boîte de réception (1 234) - vous@gmail.com - Gmail', rule), 1234);
    assert.equal(unreadFromTitle('Posteingang (1.234) - du@gmail.com - Gmail', rule), 1234);
  });

  it('the catalog patterns match the titles their services actually produce', () => {
    for (const entry of catalog) {
      if (!entry.unread?.titlePattern) continue;
      assert.equal(unreadFromTitle(`(7) ${entry.name}`, entry.unread), 7, entry.id);
      assert.equal(unreadFromTitle(`(99+) ${entry.name}`, entry.unread), 99, entry.id);
      assert.equal(unreadFromTitle(entry.name, entry.unread), 0, entry.id);
    }
  });
});

// Reading the count out of the page's own badge — the mechanism for the 27 catalog entries that
// never put one in the title. The page-side code deliberately does no arithmetic so that all of it
// lands here, where a test can reach it.
describe('unread from the DOM', () => {
  const probe = (values: string[], anchored = true) => ({ anchored, values });

  it('says what it read, for Settings — the badge, or why there was none', () => {
    const rules = [{ selector: '.badge', anchor: '.shell' }];
    assert.equal(describeDomReading(rules, [probe(['12 unread'])]), '“12 unread”');
    assert.equal(describeDomReading(rules, [probe([])]), 'no badge on the page');
    assert.equal(describeDomReading(rules, [probe([], false)]), 'page not drawn yet');
    assert.equal(describeDomReading([], [probe(['3'])]), 'no page rule');
    assert.equal(describeDomReading(rules, [probe(['1', '2', '3', '4', '5'])]), '“1”, “2”, “3” and 2 more');
  });

  it('reads the number out of a badge, however the site writes it', () => {
    assert.equal(countFromBadgeText('3'), 3);
    assert.equal(countFromBadgeText(' 12 '), 12);
    assert.equal(countFromBadgeText('9+'), 9);
    assert.equal(countFromBadgeText('(4)'), 4);
    assert.equal(countFromBadgeText('unread: 7'), 7, 'digits anywhere, not only leading');
    assert.equal(countFromBadgeText('3 unread messages'), 3);
  });

  it('a badge with no digits is one, and an empty one is none', () => {
    // The dot-style badge: present means "something", and that something is at least 1.
    assert.equal(countFromBadgeText('•'), 1);
    assert.equal(countFromBadgeText('new'), 1);
    // Sites commonly leave the badge element in place and empty it. That is a real zero.
    assert.equal(countFromBadgeText(''), 0);
    assert.equal(countFromBadgeText('   '), 0);
  });

  it('a matched badge gives its count', () => {
    assert.equal(unreadFromDom([{ selector: '.badge' }], [probe(['5'])]), 5);
  });

  it('NO RULES MEANS NO INFORMATION, not zero', () => {
    // The distinction the whole three-way return exists for: a service we cannot read has to keep
    // whatever the notification tally built up rather than being silently cleared.
    assert.equal(unreadFromDom(undefined, [probe(['5'])]), null);
    assert.equal(unreadFromDom([], [probe(['5'])]), null);
  });

  it('AN ANCHORED PAGE WITH NO BADGE IS ZERO — this is how a badge clears', () => {
    assert.equal(unreadFromDom([{ selector: '.badge', anchor: '#app' }], [probe([], true)]), 0);
  });

  it('AN UNANCHORED PAGE SAYS NOTHING, so a reload does not wipe a real count', () => {
    // The SPA has not drawn its sidebar yet. Answering zero here clears the badge on every reload,
    // which is indistinguishable from the count being wrong.
    assert.equal(unreadFromDom([{ selector: '.badge', anchor: '#app' }], [probe([], false)]), null);
  });

  it('falls through to the next rule when the first has not loaded', () => {
    const rules = [
      { selector: '.new-badge', anchor: '#new-app' },
      { selector: '.old-badge', anchor: '#old-app' },
    ];
    assert.equal(unreadFromDom(rules, [probe([], false), probe(['4'])]), 4);
  });

  it('stops at the first rule that can answer, including when the answer is zero', () => {
    const rules = [{ selector: '.badge', anchor: '#app' }, { selector: '.fallback' }];
    assert.equal(unreadFromDom(rules, [probe([], true), probe(['9'])]), 0);
  });

  it("read: 'count' counts the elements rather than reading them", () => {
    // One dot per unread row, with no number anywhere on the page.
    const rules = [{ selector: '.row.unread', read: 'count' as const }];
    assert.equal(unreadFromDom(rules, [probe(['', '', ''])]), 3);
  });

  it('takes the first match, not the sum of every match', () => {
    // A service showing a per-channel badge *and* a total would otherwise report roughly double.
    assert.equal(unreadFromDom([{ selector: '.badge' }], [probe(['4', '3', '1'])]), 4);
  });

  it('SURVIVES ANYTHING A PAGE CAN SEND, because a page can reach the bridge', () => {
    const rules = [{ selector: '.badge' }];
    assert.equal(unreadFromDom(rules, null), null);
    assert.equal(unreadFromDom(rules, 'nope'), null);
    assert.equal(unreadFromDom(rules, [42]), null);
    assert.equal(unreadFromDom(rules, [{}]), null, 'no values array is no probe at all');
    assert.equal(unreadFromDom(rules, [{ anchored: true, values: 'x' }]), null);
    // Non-strings are dropped rather than coerced, so a tampered-with entry cannot become a count.
    assert.equal(unreadFromDom(rules, [{ anchored: true, values: [null, '5'] }]), 5);
    assert.equal(unreadFromDom(rules, [{ anchored: true, values: [{ toString: () => '9' }] }]), 0);
    assert.equal(unreadFromDom(rules, []), null, 'fewer probes than rules');
  });

  it('ignores a truthy-but-not-true anchored flag', () => {
    // Straight from IPC, so the shape is asserted rather than assumed.
    assert.equal(unreadFromDom([{ selector: '.b' }], [{ anchored: 1, values: [] }]), null);
  });
});

describe('resolveUnreadRules', () => {
  const detection = { dom: [{ selector: '.catalog-badge' }] };

  it('follows the catalog when the user has set nothing', () => {
    assert.deepEqual(resolveUnreadRules(detection, undefined), [{ selector: '.catalog-badge' }]);
  });

  it("a user's selector replaces the catalog's", () => {
    assert.deepEqual(resolveUnreadRules(detection, '.mine'), [{ selector: '.mine' }]);
  });

  it('THE EMPTY STRING IS "DETECT NOTHING", and is not the same as unset', () => {
    // The only way to switch off a catalog rule that has started matching the wrong node. Collapse
    // this with `undefined` and the catalog default becomes unremovable.
    assert.deepEqual(resolveUnreadRules(detection, ''), []);
    assert.deepEqual(resolveUnreadRules(detection, '   '), []);
  });

  it('a service with no detection at all resolves to no rules', () => {
    assert.deepEqual(resolveUnreadRules(undefined, undefined), []);
    assert.deepEqual(resolveUnreadRules({ titlePattern: '^\\((\\d+)\\)' }, undefined), []);
  });
});

// The class beside `unreadFromTitle`, which had no tests at all — the counts every badge, tray
// total and folder roll-up reads.
describe('UnreadCounts', () => {
  it('an unknown service reads zero rather than undefined', () => {
    assert.equal(new UnreadCounts().get('nobody'), 0);
  });

  it('increment returns the new value, so the caller needs no second lookup', () => {
    const counts = new UnreadCounts();
    assert.equal(counts.increment('slack'), 1);
    assert.equal(counts.increment('slack'), 2);
    assert.equal(counts.get('slack'), 2);
  });

  it('SET CAN GO DOWN, which is the entire reason it exists next to increment', () => {
    // Title detection reports a state, not an event. Without this, reading your mail elsewhere
    // could never lower the badge.
    const counts = new UnreadCounts();
    counts.set('gmail', 5);
    counts.set('gmail', 2);
    assert.equal(counts.get('gmail'), 2);
  });

  it('setting zero or less forgets the service rather than storing a zero', () => {
    const counts = new UnreadCounts();
    counts.set('gmail', 3);
    counts.set('gmail', 0);
    assert.equal(counts.get('gmail'), 0);
    assert.equal(counts.snapshot().size, 0, 'and leaves nothing behind in the projection');

    counts.set('gmail', -1);
    assert.equal(counts.snapshot().size, 0);
  });

  it('clear forgets one service and leaves the rest', () => {
    const counts = new UnreadCounts();
    counts.set('gmail', 3);
    counts.set('slack', 4);
    counts.clear('gmail');
    assert.equal(counts.get('gmail'), 0);
    assert.equal(counts.get('slack'), 4);
  });

  it('PRUNE DROPS DELETED SERVICES — or the badge counts something the UI cannot explain', () => {
    const counts = new UnreadCounts();
    counts.set('gmail', 3);
    counts.set('deleted', 9);
    counts.prune(['gmail']);
    assert.equal(counts.total(), 3);
    assert.deepEqual([...counts.snapshot().keys()], ['gmail']);
  });

  it('total sums every service, and is exactly 0 when empty', () => {
    // macOS shows no badge at 0, so the dock call needs a real 0 rather than a skipped call.
    const counts = new UnreadCounts();
    assert.equal(counts.total(), 0);
    counts.set('gmail', 3);
    counts.set('slack', 4);
    assert.equal(counts.total(), 7);
  });

  it('snapshot is a copy, so a consumer cannot mutate the live counts', () => {
    const counts = new UnreadCounts();
    counts.set('gmail', 3);
    const snap = counts.snapshot();
    snap.set('gmail', 99);
    snap.set('injected', 1);
    assert.equal(counts.get('gmail'), 3);
    assert.equal(counts.get('injected'), 0);
  });
});

// The payload arrives from a *page*, via a bridge the preload puts in the main world — so
// `__hangar.notify(null)` is something any loaded service can do. Reading `.title` off that threw
// a TypeError inside an `ipcMain.on` handler, where nothing catches it.
describe('normalising a notification off the wire', () => {
  it('NULL AND UNDEFINED DO NOT THROW — the crash a page could trigger at will', () => {
    assert.deepEqual(normaliseNotification(null), { title: '', body: '', silent: false });
    assert.deepEqual(normaliseNotification(undefined), { title: '', body: '', silent: false });
  });

  it('a primitive instead of an object does not throw either', () => {
    for (const payload of ['boom', 42, true, Symbol('x')]) {
      assert.deepEqual(normaliseNotification(payload), { title: '', body: '', silent: false });
    }
  });

  it('passes an ordinary payload through unchanged', () => {
    assert.deepEqual(
      normaliseNotification({ title: 'Hi', body: 'There', silent: true }),
      { title: 'Hi', body: 'There', silent: true }
    );
  });

  it('stringifies a number rather than dropping the notification', () => {
    // A site passing a number is doing something ordinary. Showing "3" beats showing nothing.
    assert.deepEqual(
      normaliseNotification({ title: 3, body: false }),
      { title: '3', body: 'false', silent: false }
    );
  });

  it('a non-primitive title becomes empty rather than "[object Object]"', () => {
    assert.equal(normaliseNotification({ title: { toString: () => 'evil' } }).title, '');
    assert.equal(normaliseNotification({ title: ['a', 'b'] }).title, '');
  });

  it('silent is only true for a real boolean true', () => {
    // Truthy-but-not-true must not silence a notification the user expects to hear.
    assert.equal(normaliseNotification({ silent: 'yes' }).silent, false);
    assert.equal(normaliseNotification({ silent: 1 }).silent, false);
    assert.equal(normaliseNotification({ silent: true }).silent, true);
  });

  it('an empty title is left empty, so the caller can fall back to the service name', () => {
    // `handleNotification` does `payload.title || svc.name`.
    assert.equal(normaliseNotification({}).title, '');
  });
});
