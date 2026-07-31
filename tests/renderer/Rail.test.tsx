// The rail: the app's primary surface, and until now untested.
//
// The keyboard cases here are written FIRST and deliberately: dnd-kit's KeyboardSensor binds
// Space/Enter to "lift", which once shadowed plain activation entirely — a keyboard user could
// never simply open a service (decisions #25). Keyboard drag was moved behind ⌃Space to fix it.
// Adding tree roles and tabindex to the same elements can re-break that, so it is pinned before
// the roles land rather than after.

import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Rail } from '../../src/renderer/Rail';
import { sent, setShellState, pushState } from './setup';
import { DEFAULT_PREFERENCES } from '../../src/core/config/preferences';
import type { ServiceView, ShellState, RailItem } from '../../src/shared/types';

const svc = (id: string, over: Partial<ServiceView> = {}): ServiceView =>
  ({
    id,
    catalogId: 'gmail',
    name: id,
    accountId: `acct-${id}`,
    notifications: true,
    hibernate: true,
    zoom: 1,
    initials: id.slice(0, 2),
    color: '#4A154B',
    loading: false,
    sleeping: false,
    unread: 0,
    ...over,
  }) as ServiceView;

function state(over: Partial<ShellState> = {}): ShellState {
  const services = over.services ?? [svc('gmail'), svc('slack')];
  return {
    services,
    railItems: services.map((s): RailItem => ({ kind: 'service', id: s.id })),
    allServices: services,
    preferences: DEFAULT_PREFERENCES,
    orphanPartitions: [],
    quarantinedConfigs: [],
    syncStatus: { state: 'off' },
    accounts: [],
    workspaces: [],
    panes: [{ id: 'p1', serviceId: services[0]!.id }],
    focusedPaneId: 'p1',
    activeWorkspaceId: 'w',
    ...over,
  } as ShellState;
}

/** Renders and lets the async initial getState() resolve. */
async function renderRail(s: ShellState) {
  setShellState(s);
  const view = render(<Rail />);
  await act(async () => {});
  return view;
}

describe('keyboard activation', () => {
  it('SPACE OPENS A SERVICE — it must not be swallowed by drag-to-lift', () => {
    // The regression in decisions #25: dnd-kit bound Space to lift, so a keyboard user could
    // never activate a tile at all.
    return renderRail(state()).then(async () => {
      const tile = screen.getByRole('button', { name: /gmail/i });
      tile.focus();
      await userEvent.keyboard(' ');
      expect(sent).toContainEqual({ type: 'focus-service', serviceId: 'gmail' });
    });
  });

  it('Enter opens a service too', async () => {
    await renderRail(state());
    screen.getByRole('button', { name: /slack/i }).focus();
    await userEvent.keyboard('{Enter}');
    expect(sent).toContainEqual({ type: 'focus-service', serviceId: 'slack' });
  });

  it('⌃Space does NOT open — it is reserved for lifting a tile to drag', async () => {
    await renderRail(state());
    screen.getByRole('button', { name: /gmail/i }).focus();
    await userEvent.keyboard('{Control>} {/Control}');
    expect(sent).not.toContainEqual({ type: 'focus-service', serviceId: 'gmail' });
  });

  it('every tile is reachable by tab, and takes exactly one tab stop', async () => {
    // dnd-kit's attributes add role=button and tabIndex to the wrapper. Spread onto a div that
    // contains a real <button>, that gives each tile two stops and nests one control in another.
    await renderRail(state());
    const stops: string[] = [];
    for (let i = 0; i < 4; i++) {
      await userEvent.tab();
      const el = document.activeElement as HTMLElement | null;
      if (el && el !== document.body) stops.push(el.getAttribute('aria-label') ?? el.className);
    }
    const tileStops = stops.filter((s) => s.includes('rail-item') || /gmail|slack/i.test(s));
    expect(new Set(tileStops).size).toBe(tileStops.length);
  });
});

describe('activation by pointer', () => {
  it('a click focuses the service', async () => {
    await renderRail(state());
    await userEvent.click(screen.getByRole('button', { name: /slack/i }));
    expect(sent).toContainEqual({ type: 'focus-service', serviceId: 'slack' });
  });

  it('⌥-click opens alongside instead of replacing', async () => {
    await renderRail(state());
    // user-event v14 keeps modifier state per *session*, so the held Alt only reaches the click
    // if both come from the same `setup()`. The bare `userEvent.click` starts a fresh one.
    const user = userEvent.setup();
    await user.keyboard('{Alt>}');
    await user.click(screen.getByRole('button', { name: /slack/i }));
    await user.keyboard('{/Alt}');
    expect(sent).toContainEqual({ type: 'open-in-new-pane', serviceId: 'slack' });
  });

  it('right-click asks main for the native menu and suppresses the browser one', async () => {
    await renderRail(state());
    await userEvent.pointer({
      keys: '[MouseRight]',
      target: screen.getByRole('button', { name: /gmail/i }),
    });
    expect(sent).toContainEqual({ type: 'show-service-menu', serviceId: 'gmail' });
  });
});

describe('rendering', () => {
  it('renders nothing before state arrives, rather than a broken shell', () => {
    setShellState(null);
    const { container } = render(<Rail />);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows an unread badge only when there is unread', async () => {
    await renderRail(state({ services: [svc('gmail', { unread: 3 }), svc('slack')] }));
    expect(screen.getByText('3')).toBeInTheDocument();
  });

  it('a service missing from the services map is skipped, not crashed on', async () => {
    // railItems and services can disagree for a frame while a removal propagates.
    const s = state({ services: [svc('gmail')] });
    s.railItems = [
      { kind: 'service', id: 'gmail' },
      { kind: 'service', id: 'ghost' },
    ];
    await renderRail(s);
    expect(screen.getByRole('button', { name: /gmail/i })).toBeInTheDocument();
  });

  it('survives a state broadcast replacing the whole service list', async () => {
    await renderRail(state());
    const next = state({ services: [svc('notion')] });
    await act(async () => pushState(next));
    expect(screen.getByRole('button', { name: /notion/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /gmail/i })).not.toBeInTheDocument();
  });

  it('renders folder members when expanded and hides them when collapsed', async () => {
    const services = [svc('gmail'), svc('slack')];
    const open = state({ services });
    open.railItems = [
      { kind: 'folder', id: 'f', name: 'Work', collapsed: false, serviceIds: ['gmail', 'slack'] },
    ];
    const { unmount } = await renderRail(open);
    expect(screen.getByRole('button', { name: /gmail/i })).toBeInTheDocument();
    unmount();

    const shut = state({ services });
    shut.railItems = [
      { kind: 'folder', id: 'f', name: 'Work', collapsed: true, serviceIds: ['gmail', 'slack'] },
    ];
    await renderRail(shut);
    expect(screen.queryByRole('button', { name: /^gmail$/i })).not.toBeInTheDocument();
  });
});

describe('the add and settings buttons', () => {
  beforeEach(() => setShellState(state()));

  it('both are labelled and dispatch', async () => {
    await renderRail(state());
    await userEvent.click(screen.getByRole('button', { name: 'Add a connection' }));
    expect(sent).toContainEqual({ type: 'open-connections' });
    await userEvent.click(screen.getByRole('button', { name: 'Settings' }));
    expect(sent).toContainEqual({ type: 'open-settings' });
  });
});
