// Config sync policy.
//
// The transport is git; this is the part that decides what travels. It's tested harder than its
// size suggests because the failure modes are all silent and all expensive: a synced FCM
// registration breaks push on both machines, a synced window bound strands the window offscreen,
// and a synced config missing an account makes every service that used it permanently unloadable.

import { describe, it, expect } from 'vitest';
import {
  applyIncoming,
  hasDiverged,
  LOCAL_ONLY_KEYS,
  portable,
  PORTABLE_KEYS,
  serialise,
  validateIncoming,
} from '@core/config/sync';
import { DEFAULT_PREFERENCES } from '@core/config/preferences';
import type { Config } from '@shared/types';

const svc = (id: string, accountId = 'a1') => ({
  id,
  catalogId: 'gmail',
  name: id,
  accountId,
  notifications: true,
  hibernate: true,
  zoom: 1,
});

function config(over: Partial<Config> = {}): Config {
  return {
    version: 4,
    preferences: DEFAULT_PREFERENCES,
    accounts: [{ id: 'a1', label: 'Google', provider: 'google', partition: 'persist:grp-google' }],
    services: [svc('one'), svc('two')],
    workspaces: [{ id: 'w', name: 'All', items: [] }],
    activeWorkspaceId: 'w',
    layouts: { w: { panes: [{ id: 'p', serviceId: 'one' }], focusedPaneId: 'p' } },
    pushRegistrations: [{ serviceId: 'one', vapidKey: 'k', credentials: { t: 1 }, seenIds: ['x'] }],
    window: { x: 0, y: 0, width: 1440, height: 900 },
    ...over,
  } as Config;
}

describe('what travels', () => {
  it('carries services, accounts, workspaces and preferences', () => {
    const p = portable(config()) as Record<string, unknown>;
    for (const key of PORTABLE_KEYS) expect(p, key).toHaveProperty(key);
  });

  it('NEVER carries push registrations — one endpoint, one receiver', () => {
    // An FCM registration is bound to a single receiver. Two machines holding the same endpoint
    // means both are wrong and neither gets the notification.
    expect(portable(config())).not.toHaveProperty('pushRegistrations');
  });

  it('never carries window bounds or layouts — both are display-shaped', () => {
    // A 4-pane split from a 32" monitor is unusable on a 13" laptop, and restoreBounds would
    // strand the window offscreen.
    expect(portable(config())).not.toHaveProperty('window');
    expect(portable(config())).not.toHaveProperty('layouts');
  });

  it('the two key lists do not overlap', () => {
    // An allowlist and a blocklist that disagree is how a machine-local secret ends up shared.
    for (const key of LOCAL_ONLY_KEYS) {
      expect(PORTABLE_KEYS as readonly string[]).not.toContain(key);
    }
  });
});

describe('divergence detection', () => {
  it('an identical config has not diverged', () => {
    expect(hasDiverged(config(), config())).toBe(false);
  });

  it('IGNORES machine-local changes — a window move must not trigger a commit', () => {
    // Bounds are saved on a 400ms debounce. If they counted, every nudge of the window would be a
    // commit and push, and the feature would be switched off within a day.
    const moved = config({ window: { x: 500, y: 500, width: 800, height: 600 } });
    expect(hasDiverged(config(), moved)).toBe(false);
  });

  it('ignores a layout change but notices a service change', () => {
    expect(hasDiverged(config(), config({ layouts: {} }))).toBe(false);
    expect(hasDiverged(config(), config({ services: [svc('one')] }))).toBe(true);
  });

  it('notices a preference change', () => {
    const p = { ...DEFAULT_PREFERENCES, appearance: { ...DEFAULT_PREFERENCES.appearance, railPosition: 'right' as const } };
    expect(hasDiverged(config(), config({ preferences: p }))).toBe(true);
  });

  it('KEY ORDER IS NOT A DIFF', () => {
    // JSON.stringify preserves insertion order, so two identical configs built in different orders
    // would produce a diff — and a sync that commits on every launch is one nobody keeps enabled.
    const a = config();
    const reordered = { ...config() } as Record<string, unknown>;
    const rebuilt = Object.fromEntries(Object.entries(reordered).reverse()) as unknown as Config;
    expect(hasDiverged(a, rebuilt)).toBe(false);
  });

  it('serialises deterministically and ends with a newline, so git diffs stay clean', () => {
    expect(serialise(config())).toBe(serialise(config()));
    expect(serialise(config()).endsWith('\n')).toBe(true);
  });
});

describe('applying an incoming config', () => {
  it('takes the portable half and KEEPS every local field', () => {
    const local = config();
    const incoming = portable(config({ services: [svc('three')] }));
    const merged = applyIncoming(local, incoming);

    expect(merged.services.map((s) => s.id)).toEqual(['three']);
    // The three that would break something if they travelled.
    expect(merged.pushRegistrations).toEqual(local.pushRegistrations);
    expect(merged.window).toEqual(local.window);
    expect(merged.layouts).toEqual(local.layouts);
  });

  it('is a whole-file replacement, not a field merge', () => {
    // A structural merge has to guess when both machines renamed the same service, and a wrong
    // guess can cost an account-to-partition mapping. Git already models that disagreement.
    const local = config();
    const incoming = portable(config({ accounts: [] , services: []}));
    expect(applyIncoming(local, incoming).accounts).toEqual([]);
  });
});

describe('validating what arrived', () => {
  const local = config();

  it('accepts a well-formed config', () => {
    const result = validateIncoming(portable(config()), local);
    expect(result.ok).toBe(true);
  });

  it('rejects anything that is not a config object', () => {
    for (const bad of [null, undefined, 'text', 42, []]) {
      expect(validateIncoming(bad, local).ok, JSON.stringify(bad)).toBe(false);
    }
  });

  it('REJECTS A SERVICE WHOSE ACCOUNT IS MISSING', () => {
    // partitionFor throws on a dangling accountId, so the service becomes permanently unloadable —
    // and it's a service you never touched on this machine.
    const broken = portable(config({ services: [svc('one', 'gone')] }));
    const result = validateIncoming(broken, local);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/account/);
  });

  it('rejects a config that would empty a non-empty rail', () => {
    // Losing one service is ordinary. Losing all of them is worth refusing, because a sync that
    // silently empties your rail looks exactly like a sync that worked.
    const emptied = portable(config({ services: [] }));
    expect(validateIncoming(emptied, local).ok).toBe(false);
  });

  it('ALLOWS an empty rail when this machine is also empty', () => {
    // A genuinely fresh machine, or one where you deliberately removed everything.
    const emptied = portable(config({ services: [] }));
    expect(validateIncoming(emptied, config({ services: [] })).ok).toBe(true);
  });

  it('rejects a missing accounts array rather than treating it as empty', () => {
    const noAccounts = { ...portable(config()), accounts: undefined } as never;
    expect(validateIncoming(noAccounts, local).ok).toBe(false);
  });
});
