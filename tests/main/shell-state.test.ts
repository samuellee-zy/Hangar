// Characterisation tests for the logic lifted out of window.ts.
//
// Written against the code AS IT IS, so the restructure that follows can be proven
// behaviour-preserving. Where current behaviour is wrong it's asserted anyway and marked BUG —
// those expectations flip when the fix lands, and the flip is the record of what changed.
//
// None of this was testable before: reaching it meant constructing a BaseWindow.

import { describe, it, expect } from 'vitest';
import {
  activeServicesOf,
  activeWorkspaceOf,
  projectShellState,
  removeServiceFromConfig,
  resolveCommand,
} from '@core/shell-state';
import { DEFAULT_PREFERENCES } from '@core/config/preferences';
import type { Config, RailItem } from '@shared/types';

const svc = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  catalogId: 'gmail',
  name: id,
  accountId: `acct-${id}`,
  notifications: true,
  hibernate: true,
  zoom: 1,
  ...over,
});

function config(over: Partial<Config> = {}): Config {
  return {
    version: 4 as const,
    preferences: DEFAULT_PREFERENCES,
    accounts: [],
    services: [],
    workspaces: [],
    activeWorkspaceId: null,
    layouts: {},
    ...over,
  } as Config;
}

/** A workspace holding the given services as flat rail items. */
const ws = (id: string, serviceIds: string[], extra: RailItem[] = []) => ({
  id,
  name: id,
  items: [...serviceIds.map((s) => ({ kind: 'service' as const, id: s })), ...extra],
});

describe('activeWorkspaceOf', () => {
  it('finds the named workspace', () => {
    const c = config({ workspaces: [ws('a', []), ws('b', [])] });
    expect(activeWorkspaceOf(c, 'b')?.id).toBe('b');
  });

  it('falls back to the first, so a dangling id still renders something', () => {
    const c = config({ workspaces: [ws('a', []), ws('b', [])] });
    expect(activeWorkspaceOf(c, 'gone')?.id).toBe('a');
    expect(activeWorkspaceOf(c, null)?.id).toBe('a');
  });

  it('is undefined when there are no workspaces at all', () => {
    expect(activeWorkspaceOf(config(), 'a')).toBeUndefined();
  });
});

describe('activeServicesOf', () => {
  it('returns the workspace services in rail order, not config order', () => {
    // ⌘1–9 and the palette both index this, so order is behaviour rather than presentation.
    const c = config({
      services: [svc('a'), svc('b'), svc('c')],
      workspaces: [ws('w', ['c', 'a'])],
    });
    expect(activeServicesOf(c, 'w').map((s) => s.id)).toEqual(['c', 'a']);
  });

  it('inlines folder members at the folder position', () => {
    const c = config({
      services: [svc('a'), svc('b'), svc('c')],
      workspaces: [
        {
          id: 'w',
          name: 'w',
          items: [
            { kind: 'service' as const, id: 'a' },
            { kind: 'folder' as const, id: 'f', name: 'F', collapsed: false, serviceIds: ['b', 'c'] },
          ],
        },
      ],
    });
    expect(activeServicesOf(c, 'w').map((s) => s.id)).toEqual(['a', 'b', 'c']);
  });

  it('drops rail items whose service no longer exists', () => {
    const c = config({ services: [svc('a')], workspaces: [ws('w', ['a', 'ghost'])] });
    expect(activeServicesOf(c, 'w').map((s) => s.id)).toEqual(['a']);
  });

  it('RETURNS EMPTY with no workspace, rather than falling back to every service', () => {
    // Falling back used to render tiles belonging to no workspace at all.
    const c = config({ services: [svc('a')] });
    expect(activeServicesOf(c, null)).toEqual([]);
  });
});

describe('projectShellState', () => {
  const base = {
    runtimes: new Map(),
    unread: new Map<string, number>(),
    panes: [],
    focusedPaneId: null,
    orphanPartitions: [],
    quarantinedConfigs: [],
  };

  it('a service with no runtime is reported asleep', () => {
    const c = config({ services: [svc('a')], workspaces: [ws('w', ['a'])], activeWorkspaceId: 'w' });
    const state = projectShellState({ ...base, config: c });
    expect(state.services[0]!.sleeping).toBe(true);
    expect(state.services[0]!.unread).toBe(0);
  });

  it('a live runtime contributes loading and unread', () => {
    const c = config({ services: [svc('a')], workspaces: [ws('w', ['a'])], activeWorkspaceId: 'w' });
    const state = projectShellState({
      ...base,
      config: c,
      runtimes: new Map([['a', { loading: true }]]),
      unread: new Map([['a', 3]]),
    });
    expect(state.services[0]).toMatchObject({ sleeping: false, loading: true, unread: 3 });
  });

  it('a catalog service takes the brand colour and initials', () => {
    const c = config({ services: [svc('a')], workspaces: [ws('w', ['a'])], activeWorkspaceId: 'w' });
    const view = projectShellState({ ...base, config: c }).services[0]!;
    expect(view.color).toBe('#EA4335'); // Gmail
    expect(view.initials).toBe('Gm');
  });

  it('a custom connection falls back to its own colour, then to #666', () => {
    const c = config({
      services: [svc('a', { catalogId: '__custom', color: '#123456', name: 'Zed' }), svc('b', { catalogId: '__custom', name: 'Que' })],
      workspaces: [ws('w', ['a', 'b'])],
      activeWorkspaceId: 'w',
    });
    const [a, b] = projectShellState({ ...base, config: c }).services;
    expect(a!.color).toBe('#123456');
    expect(b!.color).toBe('#666');
    // No catalog entry means initials come from the name.
    expect(b!.initials).toBe('Qu');
  });

  it('allServices spans every workspace, while services is the active one only', () => {
    // Settings edits all of them; the rail draws one. Conflating these hid services from Settings.
    const c = config({
      services: [svc('a'), svc('b')],
      workspaces: [ws('w1', ['a']), ws('w2', ['b'])],
      activeWorkspaceId: 'w1',
    });
    const state = projectShellState({ ...base, config: c });
    expect(state.services.map((s) => s.id)).toEqual(['a']);
    expect(state.allServices.map((s) => s.id)).toEqual(['a', 'b']);
  });

  it('passes panes, focus and the diagnostic lists through untouched', () => {
    const c = config({ workspaces: [ws('w', [])], activeWorkspaceId: 'w' });
    const state = projectShellState({
      ...base,
      config: c,
      panes: [{ id: 'p1', serviceId: 'a' }],
      focusedPaneId: 'p1',
      orphanPartitions: ['acct-old'],
      quarantinedConfigs: ['/tmp/config.json.corrupt-1'],
      flashServiceId: 'a',
    });
    expect(state.panes).toEqual([{ id: 'p1', serviceId: 'a' }]);
    expect(state.focusedPaneId).toBe('p1');
    expect(state.orphanPartitions).toEqual(['acct-old']);
    expect(state.quarantinedConfigs).toEqual(['/tmp/config.json.corrupt-1']);
    expect(state.flashServiceId).toBe('a');
  });

  it('survives a config with no workspaces — a blank rail, not a throw', () => {
    const state = projectShellState({ ...base, config: config({ services: [svc('a')] }) });
    expect(state.services).toEqual([]);
    expect(state.railItems).toEqual([]);
  });
});

describe('resolveCommand', () => {
  const c = config({
    services: [svc('a'), svc('b'), svc('c')],
    workspaces: [ws('w1', ['a', 'b', 'c']), ws('w2', [])],
    activeWorkspaceId: 'w1',
  });
  const ctx = { config: c, focusedPaneId: 'p1' };

  it('#n is one-based and resolves against rail order', () => {
    expect(resolveCommand({ type: 'focus-service', serviceId: '#1' }, ctx)).toEqual({
      type: 'focus-service',
      serviceId: 'a',
    });
    expect(resolveCommand({ type: 'focus-service', serviceId: '#3' }, ctx)).toEqual({
      type: 'focus-service',
      serviceId: 'c',
    });
  });

  it('RETURNS NULL past the end, so the keystroke is not swallowed', () => {
    // dispatch turns null into false, and attachShortcuts only consumes a key when dispatch
    // returns true. ⌘7 with three services has to reach the page.
    expect(resolveCommand({ type: 'focus-service', serviceId: '#7' }, ctx)).toBeNull();
  });

  it('#n for workspaces indexes the workspace list', () => {
    expect(resolveCommand({ type: 'set-workspace', workspaceId: '#2' }, ctx)).toEqual({
      type: 'set-workspace',
      workspaceId: 'w2',
    });
    expect(resolveCommand({ type: 'set-workspace', workspaceId: '#9' }, ctx)).toBeNull();
  });

  it('#focused becomes the focused pane, or null when nothing has focus', () => {
    expect(resolveCommand({ type: 'close-pane', paneId: '#focused' }, ctx)).toEqual({
      type: 'close-pane',
      paneId: 'p1',
    });
    expect(
      resolveCommand({ type: 'close-pane', paneId: '#focused' }, { ...ctx, focusedPaneId: null })
    ).toBeNull();
  });

  it('a real id is passed through untouched', () => {
    const cmd = { type: 'focus-service' as const, serviceId: 'b' };
    expect(resolveCommand(cmd, ctx)).toBe(cmd);
    const close = { type: 'close-pane' as const, paneId: 'p2' };
    expect(resolveCommand(close, ctx)).toBe(close);
  });

  it('commands with no positional form are returned as-is', () => {
    for (const cmd of [{ type: 'split' as const }, { type: 'open-palette' as const }]) {
      expect(resolveCommand(cmd, ctx)).toBe(cmd);
    }
  });
});

describe('removeServiceFromConfig', () => {
  function populated(): Config {
    return config({
      services: [svc('a'), svc('b'), svc('c')],
      accounts: [
        { id: 'acct-a', label: 'A', provider: 'google', partition: 'persist:a' },
        { id: 'acct-b', label: 'B', provider: 'slack', partition: 'persist:b' },
        { id: 'acct-c', label: 'C', provider: 'notion', partition: 'persist:c' },
      ],
      workspaces: [
        ws('w1', ['a', 'b']),
        {
          id: 'w2',
          name: 'w2',
          items: [{ kind: 'folder' as const, id: 'f', name: 'F', collapsed: false, serviceIds: ['a', 'c'] }],
        },
      ],
      layouts: {
        w1: { panes: [{ id: 'p1', serviceId: 'a' }, { id: 'p2', serviceId: 'b' }], focusedPaneId: 'p1' },
        w2: { panes: [{ id: 'p3', serviceId: 'a' }], focusedPaneId: 'p3' },
      },
    });
  }

  it('removes the service itself', () => {
    const c = populated();
    removeServiceFromConfig(c, 'a');
    expect(c.services.map((s) => s.id)).toEqual(['b', 'c']);
  });

  it('removes it from top-level rail items AND from inside folders', () => {
    // Two nesting levels; missing either leaves a tile pointing at nothing.
    const c = populated();
    removeServiceFromConfig(c, 'a');
    expect(c.workspaces[0]!.items).toEqual([{ kind: 'service' as const, id: 'b' }]);
    const folder = c.workspaces[1]!.items[0] as Extract<RailItem, { kind: 'folder' }>;
    expect(folder.serviceIds).toEqual(['c']);
  });

  it('removes its panes from EVERY workspace layout, not just the active one', () => {
    const c = populated();
    removeServiceFromConfig(c, 'a');
    expect(c.layouts['w1']!.panes.map((p) => p.serviceId)).toEqual(['b']);
    expect(c.layouts['w2']!.panes).toEqual([]);
  });

  it('garbage-collects the account only when nothing else uses it', () => {
    const c = populated();
    removeServiceFromConfig(c, 'a');
    expect(c.accounts.map((a) => a.id)).toEqual(['acct-b', 'acct-c']);
  });

  it('KEEPS a shared account — two services on one Google login', () => {
    // Dropping it would leave the survivor pointing at a missing account, and partitionFor throws
    // on that, making the service permanently unloadable.
    const c = config({
      services: [svc('a', { accountId: 'shared' }), svc('b', { accountId: 'shared' })],
      accounts: [{ id: 'shared', label: 'Google', provider: 'google', partition: 'persist:g' }],
      workspaces: [ws('w', ['a', 'b'])],
    });
    removeServiceFromConfig(c, 'a');
    expect(c.accounts.map((a) => a.id)).toEqual(['shared']);
  });

  it('removing an unknown id changes nothing', () => {
    const c = populated();
    const before = JSON.stringify(c);
    removeServiceFromConfig(c, 'nope');
    expect(JSON.stringify(c)).toBe(before);
  });

  it('removing the last service leaves a valid, empty config', () => {
    // The state that used to be treated as corruption on the next load — see decisions #47.
    const c = config({
      services: [svc('a')],
      accounts: [{ id: 'acct-a', label: 'A', provider: 'google', partition: 'persist:a' }],
      workspaces: [ws('w', ['a'])],
      layouts: { w: { panes: [{ id: 'p1', serviceId: 'a' }], focusedPaneId: 'p1' } },
    });
    removeServiceFromConfig(c, 'a');
    expect(c.services).toEqual([]);
    expect(c.accounts).toEqual([]);
    expect(c.workspaces[0]!.items).toEqual([]);
    expect(c.layouts['w']!.panes).toEqual([]);
  });
});

// A1/A2: the count is keyed by service id, not carried on the runtime, so it outlives hibernation
// and can exist for a service that has never been loaded. That is what makes Web Push work.
describe('unread survives having no runtime', () => {
  it('A HIBERNATED SERVICE CAN STILL SHOW UNREAD', () => {
    const c = config({ services: [svc('a')], workspaces: [ws('w', ['a'])], activeWorkspaceId: 'w' });
    const state = projectShellState({
      config: c,
      runtimes: new Map(),          // asleep
      unread: new Map([['a', 5]]),  // ...and still has unread
      panes: [],
      focusedPaneId: null,
      orphanPartitions: [],
      quarantinedConfigs: [],
    });
    expect(state.services[0]).toMatchObject({ sleeping: true, unread: 5 });
  });
});
