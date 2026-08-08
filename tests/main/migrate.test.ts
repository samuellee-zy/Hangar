// Config migration, end to end.
//
// migrateV1, migrateWorkspaceV3 and withDefaults were each tested in isolation. Their
// *composition* was not, and it was welded to readWithRecovery and app.getPath so it couldn't be.
// That composition is where a mistake signs every user out of every service, because partition
// names are the identity of a cookie jar.

import { describe, it, expect } from 'vitest';
import { migrateConfig } from '@core/config/migrate';

/** A v1 config: no version, no accounts, partitions implied by `sessionGroup`. */
const v1 = () => ({
  services: [
    { id: 's1', catalogId: 'gmail', name: 'Gmail', sessionGroup: 'google' },
    { id: 's2', catalogId: 'gcal', name: 'Calendar', sessionGroup: 'google' },
    { id: 's3', catalogId: 'slack', name: 'Slack', sessionGroup: 'slack' },
  ],
  workspaces: [{ id: 'w', name: 'All', serviceIds: ['s1', 's2', 's3'] }],
});

/** A v2 config: accounts exist, no preferences yet, workspaces still flat. */
const v2 = () => ({
  version: 2,
  accounts: [
    { id: 'a1', label: 'Google', provider: 'google', partition: 'persist:grp-google' },
    { id: 'a2', label: 'Slack', provider: 'slack', partition: 'persist:grp-slack' },
  ],
  services: [
    { id: 's1', catalogId: 'gmail', name: 'Gmail', accountId: 'a1', notifications: true, hibernate: true, zoom: 1 },
    { id: 's3', catalogId: 'slack', name: 'Slack', accountId: 'a2', notifications: true, hibernate: true, zoom: 1 },
  ],
  workspaces: [{ id: 'w', name: 'All', serviceIds: ['s1', 's3'] }],
});

describe('v1 → current', () => {
  it('rebuilds accounts from sessionGroup, one per group', () => {
    const c = migrateConfig(v1());
    expect(c.accounts).toHaveLength(2);
    expect(c.accounts.map((a) => a.partition).sort()).toEqual([
      'persist:grp-google',
      'persist:grp-slack',
    ]);
  });

  it('SERVICES SHARING A GROUP SHARE AN ACCOUNT — one Google login covers Gmail and Calendar', () => {
    const c = migrateConfig(v1());
    const [gmail, gcal] = c.services;
    expect(gmail!.accountId).toBe(gcal!.accountId);
  });

  it('fills in the fields v1 never had, rather than leaving them undefined', () => {
    // `hibernate: undefined` is falsy, so the service silently never hibernates.
    // `zoom: undefined` reaches setZoomFactor and THROWS out of the AppWindow constructor, so the
    // app fails to render at all on the first launch after upgrading.
    const c = migrateConfig(v1());
    for (const svc of c.services) {
      expect(typeof svc.zoom, svc.name).toBe('number');
      expect(typeof svc.hibernate, svc.name).toBe('boolean');
      expect(typeof svc.notifications, svc.name).toBe('boolean');
    }
  });

  it('converts flat serviceIds into a rail tree, order preserved', () => {
    const c = migrateConfig(v1());
    expect(c.workspaces[0]!.items).toEqual([
      { kind: 'service' as const, id: 's1' },
      { kind: 'service' as const, id: 's2' },
      { kind: 'service' as const, id: 's3' },
    ]);
  });

  it('supplies a complete preferences object', () => {
    const c = migrateConfig(v1());
    expect(c.preferences.appearance.railPosition).toBe('left');
    expect(c.preferences.notifications.firebase.projectId).toBe('');
  });
});

describe('v2 → current', () => {
  it('LEAVES PARTITION NAMES BYTE-IDENTICAL — this is what keeps you signed in', () => {
    const before = v2().accounts.map((a) => a.partition);
    expect(migrateConfig(v2()).accounts.map((a) => a.partition)).toEqual(before);
  });

  it('adds preferences without touching accounts or services', () => {
    const c = migrateConfig(v2());
    expect(c.accounts).toHaveLength(2);
    expect(c.services.map((s) => s.id)).toEqual(['s1', 's3']);
    expect(c.preferences.behaviour.defaultZoom).toBe(1);
  });
});

describe('the sign-out hazard', () => {
  it('REFUSES a v2+ config with no accounts instead of regenerating partitions', () => {
    // The old condition was `(version ?? 0) >= 2 && parsed.accounts`, so a v4 config that lost its
    // accounts array fell through to migrateV1 — which rebuilds partitions from
    // `sessionGroup ?? catalogId`. Those names don't match what's on disk, so every service loses
    // its cookie jar. Failing loudly is the only safe answer; the caller keeps the original file.
    const broken = { ...v2(), accounts: undefined };
    expect(() => migrateConfig(broken)).toThrow(/accounts/);
  });

  it('a v1 config with no accounts is fine — that is simply what v1 is', () => {
    expect(() => migrateConfig(v1())).not.toThrow();
  });
});

describe('idempotence and shape', () => {
  it('migrating an already-current config changes nothing', () => {
    const once = migrateConfig(v1());
    const twice = migrateConfig(once);
    expect(twice).toEqual(once);
  });

  it('catalog-backed services drop a stored url so they follow catalog fixes', () => {
    const c = migrateConfig({
      version: 2,
      accounts: [{ id: 'a1', label: 'G', provider: 'google', partition: 'persist:g' }],
      services: [{ id: 's1', catalogId: 'gmail', name: 'Gmail', accountId: 'a1', url: 'https://stale.example', notifications: true, hibernate: true, zoom: 1 }],
      workspaces: [],
    });
    expect(c.services[0]!.url).toBeUndefined();
  });

  it('a custom connection KEEPS its url — there is no catalog to fall back to', () => {
    const c = migrateConfig({
      version: 2,
      accounts: [{ id: 'a1', label: 'X', provider: 'custom', partition: 'persist:x' }],
      services: [{ id: 's1', catalogId: '__custom', name: 'X', accountId: 'a1', url: 'https://x.example', notifications: true, hibernate: true, zoom: 1 }],
      workspaces: [],
    });
    expect(c.services[0]!.url).toBe('https://x.example');
  });

  it('activeWorkspaceId falls back to the first workspace, then to null', () => {
    expect(migrateConfig(v1()).activeWorkspaceId).toBe('w');
    expect(migrateConfig({ services: [], workspaces: [] }).activeWorkspaceId).toBeNull();
  });

  it('missing layouts becomes an empty map, not undefined', () => {
    expect(migrateConfig(v1()).layouts).toEqual({});
  });

  it('push registrations survive a migration', () => {
    const c = migrateConfig({
      ...v2(),
      pushRegistrations: [{ serviceId: 's1', vapidKey: 'k', credentials: {}, seenIds: ['x'] }],
    });
    expect(c.pushRegistrations).toHaveLength(1);
  });
});

describe('rejecting what it cannot understand', () => {
  it('throws rather than guessing, so the caller can preserve the original', () => {
    for (const bad of [null, undefined, 'string', 42, {}, { services: 'nope' }]) {
      expect(() => migrateConfig(bad), JSON.stringify(bad)).toThrow();
    }
  });

  it('an empty services array is valid — see decisions #47', () => {
    expect(() => migrateConfig({ services: [], workspaces: [] })).not.toThrow();
  });
});

// `validateIncoming` refused an orphaned service on the sync path from the start. This function is
// the single normalisation point load *and* import share, and it did not — so the one path a
// hand-edited file actually arrives by was the unguarded one.
//
// It matters because the failure is remote from its cause: `partitionFor` throws, which takes out
// `restoreLayout` and the 60-second `persistAll` loop. That loop is what promotes session cookies
// to disk, so the symptom is being signed out of everything after a restart, much later.
describe('services must be able to resolve their account', () => {
  const orphaned = () => ({
    version: 4,
    accounts: [{ id: 'a1', label: 'Google', provider: 'google', partition: 'persist:g' }],
    services: [
      { id: 's1', catalogId: 'gmail', name: 'Gmail', accountId: 'a1', notifications: true, hibernate: true, zoom: 1 },
      { id: 's2', catalogId: 'slack', name: 'Slack', accountId: 'GONE', notifications: true, hibernate: true, zoom: 1 },
    ],
    workspaces: [],
  });

  it('A DANGLING accountId IS REFUSED rather than written to disk', () => {
    expect(() => migrateConfig(orphaned())).toThrow(/account/i);
  });

  it('names the offending service, so the message is actionable', () => {
    expect(() => migrateConfig(orphaned())).toThrow(/Slack/);
  });

  it('a config where every service resolves is untouched', () => {
    expect(() => migrateConfig(v2())).not.toThrow();
  });

  it('holds for v1 too, where accounts are rebuilt rather than read', () => {
    // migrateV1 derives accounts from the services themselves, so this should be impossible —
    // which is exactly why it is worth asserting rather than assuming.
    expect(() => migrateConfig(v1())).not.toThrow();
  });

  it('matches what validateIncoming already enforced for sync', () => {
    // The two guards existing in one place and not the other is the actual defect. If sync's check
    // is ever relaxed this should be revisited together with it.
    const config = orphaned();
    const accountIds = new Set(config.accounts.map((a) => a.id));
    expect(config.services.some((s) => !accountIds.has(s.accountId))).toBe(true);
    expect(() => migrateConfig(config)).toThrow();
  });
});
