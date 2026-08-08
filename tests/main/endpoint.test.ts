// Asking a sleeping service's own API for its unread count.
//
// The whole feature is one authenticated request the user did not ask for, so most of what is
// tested here is the refusals: what makes it not fire, and what stops a failure being read as an
// empty inbox. A count that clears itself because the service returned a 401 is worse than no
// count at all — it looks like the app working.

import { describe, it, expect } from 'vitest';
import {
  MIN_POLL_SECONDS,
  endpointDue,
  pollIntervalSeconds,
  pollJitterMs,
  resolveEndpoint,
  unreadFromEndpoint,
} from '@core/notify/endpoint';
import { EndpointPoller, eligibleRule } from '@main/features/endpoint-poll';
import { catalogById } from '@shared/catalog';
import type { EndpointRule, ServiceInstance } from '@shared/types';

const json = (path: string): EndpointRule => ({ url: 'https://x.test/a', extract: { json: path } });
const ok = (body: string) => ({ status: 200, body });

describe('reading a count out of a response', () => {
  it('pulls a number off a JSON path', () => {
    expect(unreadFromEndpoint(json('counts.total'), ok('{"counts":{"total":7}}'))).toBe(7);
  });

  it('indexes into arrays on the way down', () => {
    expect(unreadFromEndpoint(json('boxes.0.unread'), ok('{"boxes":[{"unread":3}]}'))).toBe(3);
  });

  it("an array's length is the count, which covers the 'here are your unread items' shape", () => {
    expect(unreadFromEndpoint(json('items'), ok('{"items":[1,2,3]}'))).toBe(3);
    // And an empty one is a real zero, not an absent answer.
    expect(unreadFromEndpoint(json('items'), ok('{"items":[]}'))).toBe(0);
  });

  it('parses a string like a badge, and a boolean as any-or-none', () => {
    expect(unreadFromEndpoint(json('n'), ok('{"n":"12 unread"}'))).toBe(12);
    expect(unreadFromEndpoint(json('any'), ok('{"any":true}'))).toBe(1);
    expect(unreadFromEndpoint(json('any'), ok('{"any":false}'))).toBe(0);
  });

  it('an empty path is the whole body, for an endpoint that returns a bare number', () => {
    expect(unreadFromEndpoint(json(''), ok('4'))).toBe(4);
  });

  it('reads a regex capture, which is what a non-JSON feed needs', () => {
    const rule: EndpointRule = {
      url: 'https://x.test/a',
      extract: { regex: '<fullcount>(\\d+)</fullcount>' },
    };
    expect(unreadFromEndpoint(rule, ok('<feed><fullcount>5</fullcount></feed>'))).toBe(5);
    expect(unreadFromEndpoint(rule, ok('<feed></feed>')), 'no match is no information').toBe(null);
  });

  it('A FAILURE IS NEVER ZERO — that is the difference between a bug and a cleared badge', () => {
    // Signed out, rate-limited, service down. Every one of these would otherwise wipe a real count
    // and look exactly like the feature working.
    for (const status of [301, 401, 403, 429, 500, 503]) {
      expect(unreadFromEndpoint(json('n'), { status, body: '{"n":9}' }), String(status)).toBe(null);
    }
    expect(unreadFromEndpoint(json('n'), null), 'and a request that never completed').toBe(null);
  });

  it('a body or a path that no longer fits the rule says nothing', () => {
    expect(unreadFromEndpoint(json('n'), ok('<html>sign in</html>'))).toBe(null);
    expect(unreadFromEndpoint(json('a.b.c'), ok('{"a":{}}'))).toBe(null);
    expect(unreadFromEndpoint(json('n'), ok('{"n":null}'))).toBe(null);
    expect(unreadFromEndpoint(json('n'), ok('{"n":{"deep":1}}'))).toBe(null);
    expect(unreadFromEndpoint({ ...json(''), extract: { regex: '([' } }, ok('x'))).toBe(null);
  });

  it('a negative or fractional count is normalised rather than believed', () => {
    expect(unreadFromEndpoint(json('n'), ok('{"n":-4}'))).toBe(0);
    expect(unreadFromEndpoint(json('n'), ok('{"n":2.7}'))).toBe(2);
  });
});

describe('how often it asks', () => {
  it('FLOORS THE INTERVAL, so a typo cannot become a load test', () => {
    expect(pollIntervalSeconds({ ...json('n'), everySeconds: 1 })).toBe(MIN_POLL_SECONDS);
    expect(pollIntervalSeconds({ ...json('n'), everySeconds: 0 })).toBe(MIN_POLL_SECONDS);
    expect(pollIntervalSeconds({ ...json('n'), everySeconds: 600 })).toBe(600);
  });

  it('a never-polled service is due immediately', () => {
    expect(endpointDue(json('n'), undefined, 1_000_000)).toBe(true);
  });

  it('waits out the interval', () => {
    const rule = { ...json('n'), everySeconds: 300 };
    expect(endpointDue(rule, 1_000_000, 1_000_000 + 299_000)).toBe(false);
    expect(endpointDue(rule, 1_000_000, 1_000_000 + 300_000)).toBe(true);
  });

  it('A CLOCK THAT WENT BACKWARDS does not park the next poll days out', () => {
    // A laptop waking in another timezone, or an NTP correction.
    expect(endpointDue(json('n'), 5_000_000, 1_000_000)).toBe(true);
  });
});

describe('per-service jitter, so a wake does not put every service in lockstep', () => {
  const rule = json('n');
  const interval = pollIntervalSeconds(rule) * 1000;

  it('never asks sooner than the interval — the floor is a rate limit, not a target', () => {
    // The one property that must not break. `MIN_POLL_SECONDS` exists so a typo'd rule cannot turn
    // into an accidental load test against someone's inbox, so jitter may only ever defer.
    for (const id of ['a', 'b', 'gmail-1', 'zzzz', '']) {
      expect(pollJitterMs(id, rule), id).toBeGreaterThanOrEqual(0);
    }
  });

  it('stays a fraction of the interval, so a poll is late rather than skipped', () => {
    for (const id of ['a', 'b', 'gmail-1', 'zzzz']) {
      expect(pollJitterMs(id, rule), id).toBeLessThan(interval);
    }
  });

  it('is stable for a given service, or the schedule would wander on every sweep', () => {
    expect(pollJitterMs('gmail-1', rule)).toBe(pollJitterMs('gmail-1', rule));
  });

  it('differs between services, which is the entire point', () => {
    expect(pollJitterMs('gmail-1', rule)).not.toBe(pollJitterMs('slack-1', rule));
  });

  it('defers the poll rather than bringing it forward', () => {
    const offset = pollJitterMs('gmail-1', rule);
    const last = 1_000_000;
    expect(endpointDue(rule, last, last + interval, offset)).toBe(offset === 0);
    expect(endpointDue(rule, last, last + interval + offset, offset)).toBe(true);
  });
});

describe('resolveEndpoint', () => {
  const catalogRule = json('catalog');

  it('follows the catalog when the service says nothing', () => {
    expect(resolveEndpoint(catalogRule, undefined)).toBe(catalogRule);
  });

  it('NULL IS "CALL NOTHING", and is not the same as unset', () => {
    // The way to stop a background request without turning the service's notifications off.
    expect(resolveEndpoint(catalogRule, null)).toBe(null);
  });

  it("a service's own rule replaces the catalog's", () => {
    const mine = json('mine');
    expect(resolveEndpoint(catalogRule, mine)).toBe(mine);
  });
});

const svc = (over: Partial<ServiceInstance> = {}): ServiceInstance =>
  ({
    id: 's1',
    catalogId: 'gmail',
    name: 'Gmail',
    accountId: 'a1',
    notifications: true,
    hibernate: true,
    zoom: 1,
    ...over,
  }) as ServiceInstance;

describe('what it refuses to call', () => {
  it('uses the Gmail rule the catalog ships', () => {
    expect(eligibleRule(svc())?.url).toBe(catalogById('gmail')!.unread!.endpoint!.url);
  });

  it('REFUSES A URL OFF THE SERVICE\'S ALLOWLIST — the request carries its cookies', () => {
    // The one clause standing between a typo'd, imported or synced config and a credentialled
    // request to a host of someone else's choosing.
    const rule = { url: 'https://evil.test/collect', extract: { json: 'n' } };
    expect(eligibleRule(svc({ unreadEndpoint: rule }))).toBe(null);
  });

  it('accepts a subdomain of an allowed host, and refuses a lookalike', () => {
    const at = (url: string) => eligibleRule(svc({ unreadEndpoint: { url, extract: { json: 'n' } } }));
    expect(at('https://mail.google.com/x')).not.toBe(null);
    expect(at('https://mail.google.com.evil.test/x')).toBe(null);
    expect(at('not a url at all')).toBe(null);
  });

  it('a muted or notification-free service is not called at all', () => {
    expect(eligibleRule(svc({ notificationLevel: 'muted' }))).toBe(null);
    expect(eligibleRule(svc({ notifications: false }))).toBe(null);
  });

  it('a service with no rule anywhere is not called', () => {
    expect(eligibleRule(svc({ catalogId: 'notion' }))).toBe(null);
    expect(eligibleRule(svc({ unreadEndpoint: null }))).toBe(null);
  });
});

describe('the sweep', () => {
  // The request is injected, so the scheduling can be tested without a network or a Chromium
  // session. The real `session.fetch` — the part that borrows the login — is E2E's job.
  const harness = () => {
    const fetched: string[] = [];
    const reported: Array<[string, number]> = [];
    let respond = async (): Promise<{ status: number; body: string }> => ({
      status: 200,
      body: '<fullcount>6</fullcount>',
    });

    const poller = new EndpointPoller(
      () => [svc()],
      (id, n) => reported.push([id, n]),
      async (_svc, rule) => {
        fetched.push(rule.url);
        return respond();
      }
    );
    return {
      poller,
      fetched,
      reported,
      set: (next: typeof respond) => {
        respond = next;
      },
    };
  };

  it('reports the count it read', async () => {
    const h = harness();
    await h.poller.sweep();
    expect(h.reported).toEqual([['s1', 6]]);
  });

  it('DOES NOT ASK AGAIN UNTIL THE INTERVAL IS UP', async () => {
    const h = harness();
    const start = 1_000_000;
    // Each service also carries a fixed offset of its own, so services that fell due together stop
    // asking together. It only ever defers — see the jitter suite below.
    const due = start + 300_000 + pollJitterMs('s1', eligibleRule(svc())!);

    await h.poller.sweep(start);
    await h.poller.sweep(start + 30_000);
    expect(h.fetched.length, 'the 30s background sweep must not become a 30s poll').toBe(1);
    await h.poller.sweep(due);
    expect(h.fetched.length).toBe(2);
  });

  it('re-asks promptly once a service sleeps again', async () => {
    const h = harness();
    await h.poller.sweep(1_000_000);
    h.poller.forget('s1');
    await h.poller.sweep(1_000_001);
    expect(h.fetched.length).toBe(2);
  });

  it('A FAILING FETCH DOES NOT THROW OUT OF THE SWEEP OR CLEAR THE COUNT', async () => {
    // The sweep runs under `void` on a timer, where a rejection is invisible and the loop stops.
    const h = harness();
    h.set(async () => {
      throw new Error('network down');
    });
    await expect(h.poller.sweep()).resolves.toBeUndefined();
    expect(h.reported).toEqual([]);
  });

  it('reports nothing after dispose, so a late response cannot touch a torn-down window', async () => {
    const h = harness();
    let release = () => {};
    h.set(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ status: 200, body: '<fullcount>6</fullcount>' });
        })
    );

    const sweeping = h.poller.sweep();
    h.poller.dispose();
    release();
    await sweeping;
    expect(h.reported).toEqual([]);
  });

  it('never has two requests out for one service at once', async () => {
    // A service that takes longer than the interval to answer would otherwise accumulate one
    // outstanding request per sweep, forever.
    const h = harness();
    h.set(() => new Promise(() => {}));
    void h.poller.sweep(1_000_000);
    void h.poller.sweep(2_000_000);
    await Promise.resolve();
    expect(h.fetched.length).toBe(1);
  });
});
