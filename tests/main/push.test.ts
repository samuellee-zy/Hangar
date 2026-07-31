// Web Push policy. The socket, the Firebase project and the site sending a message are all absent
// here on purpose — everything below is a decision, and decisions are the part that can be wrong
// in a way nobody notices until a notification doesn't arrive.
//

import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import {
  dedupePersistentIds,
  extractNotification,
  findRegistration,
  firebaseConfigStatus,
  missingFirebaseFields,
  pushEligible,
  reconnectDelayMs,
  staleRegistrations,
  subscriptionKey,
  upsertRegistration,
  MAX_RECONNECT_DELAY_MS,
  PERSISTENT_ID_CAP,
} from '@core/push/policy';


const FULL = { projectId: 'p', appId: 'a', apiKey: 'k', messagingSenderId: 'm' };

describe("firebase config", () => {

  it('all four fields present is ready; nothing at all is unset', () => {
    assert.equal(firebaseConfigStatus(FULL), 'ready');
    assert.equal(firebaseConfigStatus({ projectId: '', appId: '', apiKey: '', messagingSenderId: '' }), 'unset');
    assert.equal(firebaseConfigStatus(null), 'unset');
  });

  it('a partial paste is INCOMPLETE, not unset — Settings must be able to say which field', () => {
    assert.equal(firebaseConfigStatus({ ...FULL, apiKey: '' }), 'incomplete');
    assert.deepEqual(missingFirebaseFields({ ...FULL, apiKey: '', appId: '' }), ['appId', 'apiKey']);
  });

  it('whitespace is not a value — a field of spaces counts as missing', () => {
    assert.equal(firebaseConfigStatus({ ...FULL, apiKey: '   ' }), 'incomplete');
  });
});

describe("eligibility — opt-in at every level", () => {

  const eligible = (over = {}) =>
    pushEligible({
      pushEnabled: true,
      configStatus: 'ready',
      serviceNotifications: true,
      level: 'all' as const,
      ...over,
    });

  it('everything on and configured means eligible', () => {
    assert.equal(eligible(), true);
  });

  it('a service is never subscribed without credentials, however keen the toggles are', () => {
    assert.equal(eligible({ configStatus: 'incomplete' }), false);
    assert.equal(eligible({ configStatus: 'unset' }), false);
  });

  it('the global toggle, the service toggle and mute each veto on their own', () => {
    assert.equal(eligible({ pushEnabled: false }), false);
    assert.equal(eligible({ serviceNotifications: false }), false);
    assert.equal(eligible({ level: 'muted' as const }), false);
  });
});

describe("replay suppression", () => {

  it('FCM replays on reconnect; the same id is only delivered once', () => {
    const first = dedupePersistentIds([], 'abc');
    assert.equal(first.fresh, true);
    const second = dedupePersistentIds(first.seen, 'abc');
    assert.equal(second.fresh, false);
    // A rejected id must not grow the list, or a flapping socket bloats the config.
    assert.equal(second.seen.length, 1);
  });

  it('the list is capped and trims oldest-first', () => {
    let seen: string[] = [];
    for (let i = 0; i < PERSISTENT_ID_CAP + 10; i++) seen = dedupePersistentIds(seen, `id-${i}`, PERSISTENT_ID_CAP).seen;
    assert.equal(seen.length, PERSISTENT_ID_CAP);
    assert.equal(seen.at(-1), `id-${PERSISTENT_ID_CAP + 9}`);
    // The oldest went, not the newest — dropping recent ids would reintroduce duplicates.
    assert.equal(seen.includes('id-0'), false);
    assert.equal(seen[0], 'id-10');
  });
});

describe("payload extraction — the shape is site-defined, so this is all defensive", () => {

  it('an FCM notification block', () => {
    assert.deepEqual(
      extractNotification({ notification: { title: 'Ada', body: 'ping' } }, 'Slack'),
      { title: 'Ada', body: 'ping', tag: undefined, url: undefined }
    );
  });

  it('a top-level payload, which is what most service workers actually send', () => {
    const out = extractNotification({ title: 'Ada', body: 'ping', tag: 'dm-1' }, 'Slack');
    assert.equal(out!.title, 'Ada');
    assert.equal(out!.tag, 'dm-1');
  });

  it('a JSON string nested under data.notification', () => {
    const out = extractNotification(
      { data: { notification: JSON.stringify({ title: 'Ada', body: 'ping' }) } },
      'Slack'
    );
    assert.equal(out!.title, 'Ada');
  });

  it('alternative field names sites actually use', () => {
    assert.equal(extractNotification({ subject: 'Re: budget' }, 'Gmail')!.title, 'Re: budget');
    assert.equal(extractNotification({ title: 'x', message: 'hi' }, 'Gmail')!.body, 'hi');
    assert.equal(extractNotification({ title: 'x', alert: 'hi' }, 'Gmail')!.body, 'hi');
  });

  it('A BODY WITH NO TITLE STILL GETS THE SERVICE NAME — otherwise you cannot tell which Slack', () => {
    const out = extractNotification({ body: 'ping' }, 'Slack (work)');
    assert.equal(out!.title, 'Slack (work)');
    assert.equal(out!.body, 'ping');
  });

  it('a click target is picked up under any of its three common names', () => {
    assert.equal(extractNotification({ title: 't', url: '/a' }, 'S')!.url, '/a');
    assert.equal(extractNotification({ title: 't', click_action: '/b' }, 'S')!.url, '/b');
  });

  it('an unreadable payload returns null rather than an empty banner', () => {
    assert.equal(extractNotification(null, 'Slack'), null);
    assert.equal(extractNotification('just a string', 'Slack'), null);
    assert.equal(extractNotification({}, 'Slack'), null);
    // Present but blank is still nothing worth showing.
    assert.equal(extractNotification({ title: '   ', body: '' }, 'Slack'), null);
  });

  it('malformed JSON under data.notification falls through instead of throwing', () => {
    const out = extractNotification({ data: { notification: '{oh no', title: 'fallback' } }, 'S');
    assert.equal(out!.title, 'fallback');
  });
});

describe("reconnect backoff", () => {

  it('doubles per attempt', () => {
    assert.equal(reconnectDelayMs(0), 2_000);
    assert.equal(reconnectDelayMs(1), 4_000);
    assert.equal(reconnectDelayMs(2), 8_000);
  });

  it('CAPPED — an overnight lid-close must not compute an hours-long delay it never wakes from', () => {
    assert.equal(reconnectDelayMs(50), MAX_RECONNECT_DELAY_MS);
    assert.equal(reconnectDelayMs(1e6), MAX_RECONNECT_DELAY_MS);
    // Negative attempts shouldn't produce a sub-second hot loop either.
    assert.equal(reconnectDelayMs(-5), 2_000);
  });
});

describe("registration bookkeeping", () => {

  const reg = (serviceId, vapidKey = 'v1') => ({ serviceId, vapidKey, credentials: { t: 1 }, seenIds: [] });

  it('a registration is found by service and key together', () => {
    const list = [reg('svc-1'), reg('svc-2')];
    assert.equal(findRegistration(list, 'svc-1', 'v1').serviceId, 'svc-1');
    // A rotated VAPID key means the stored registration is dead — FCM rejects pushes signed with a
    // key that doesn't match the subscription, so this must miss.
    assert.equal(findRegistration(list, 'svc-1', 'v2'), undefined);
    assert.equal(subscriptionKey('svc-1', 'v1') === subscriptionKey('svc-1', 'v2'), false);
  });

  it('UPSERT REPLACES BY SERVICE — a rotated key evicts, it does not accumulate', () => {
    let list = [reg('svc-1', 'v1')];
    list = upsertRegistration(list, reg('svc-1', 'v2'));
    assert.equal(list.length, 1);
    assert.equal(list[0].vapidKey, 'v2');
  });

  it('upsert leaves other services alone', () => {
    const list = upsertRegistration([reg('svc-1'), reg('svc-2')], reg('svc-1', 'v9'));
    assert.equal(list.length, 2);
    assert.equal(list.filter((r) => r.serviceId === 'svc-2').length, 1);
  });

  it('registrations for deleted services are reported so their sockets can be closed', () => {
    const stale = staleRegistrations([reg('svc-1'), reg('gone')], ['svc-1']);
    assert.deepEqual(stale.map((r) => r.serviceId), ['gone']);
    assert.deepEqual(staleRegistrations([reg('svc-1')], ['svc-1']), []);
  });
});

// MessageEnvelope.persistentId is typed as a string but arrives from the wire, and FCM does not
// guarantee it. An undefined id used to be pushed into `seen`, so a run of them would fill the
// 512-entry cap and evict the real ids it exists to remember — silently un-deduplicating.
describe('a missing persistentId', () => {
  it('does not pollute the seen list', () => {
    const { fresh, seen } = dedupePersistentIds(['real-1'], undefined);
    assert.equal(fresh, true, 'still deliver it — a message without an id is still a message');
    assert.deepEqual(seen, ['real-1'], 'but do not remember it');
  });

  it('repeated undefined ids never evict real ones', () => {
    let seen = ['real-1', 'real-2'];
    for (let i = 0; i < 600; i++) seen = dedupePersistentIds(seen, undefined).seen;
    assert.deepEqual(seen, ['real-1', 'real-2']);
  });

  it('an empty-string id is treated the same way', () => {
    assert.deepEqual(dedupePersistentIds(['real-1'], '').seen, ['real-1']);
  });
});
