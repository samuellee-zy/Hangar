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
    railExpanded: false,
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
      expect(sent).toContainEqual({
        type: 'focus-service',
        serviceId: 'gmail',
      });
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
    expect(sent).not.toContainEqual({
      type: 'focus-service',
      serviceId: 'gmail',
    });
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
    expect(sent).toContainEqual({
      type: 'open-in-new-pane',
      serviceId: 'slack',
    });
  });

  it('right-click asks main for the native menu and suppresses the browser one', async () => {
    await renderRail(state());
    await userEvent.pointer({
      keys: '[MouseRight]',
      target: screen.getByRole('button', { name: /gmail/i }),
    });
    expect(sent).toContainEqual({
      type: 'show-service-menu',
      serviceId: 'gmail',
    });
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
      {
        kind: 'folder',
        id: 'f',
        name: 'Work',
        collapsed: false,
        serviceIds: ['gmail', 'slack'],
      },
    ];
    const { unmount } = await renderRail(open);
    expect(screen.getByRole('button', { name: /gmail/i })).toBeInTheDocument();
    unmount();

    const shut = state({ services });
    shut.railItems = [
      {
        kind: 'folder',
        id: 'f',
        name: 'Work',
        collapsed: true,
        serviceIds: ['gmail', 'slack'],
      },
    ];
    await renderRail(shut);
    expect(screen.queryByRole('button', { name: /^gmail$/i })).not.toBeInTheDocument();
  });
});

describe('compact rail chevron', () => {
  // The rail's whole part in this is one message. It does not decide anything — main refuses the
  // change during a drag, and a renderer that had also decided would disagree exactly then — so
  // what is tested here is that the click is reported and that `railExpanded` is obeyed.

  const rail = () => document.querySelector('.rail') as HTMLElement;
  const chevron = () => document.querySelector('.rail-chevron') as HTMLElement | null;

  const compactState = (over: Partial<ShellState> = {}) =>
    state({
      preferences: {
        ...DEFAULT_PREFERENCES,
        appearance: {
          ...DEFAULT_PREFERENCES.appearance,
          compactRail: true,
          showLabels: true,
        },
      },
      ...over,
    });

  it('reports the click', async () => {
    await renderRail(compactState());
    await userEvent.click(chevron()!);
    expect(sent).toContainEqual({ type: 'toggle-rail' });
  });

  it('HOVERING REPORTS NOTHING AT ALL', async () => {
    // The rail used to open on `pointerenter` and close on `pointerleave`, and closing depended on
    // a leave event Chromium does not reliably deliver when the pointer crosses into a sibling
    // WebContentsView — so the rail stayed open over the panes. There is no hover path left.
    await renderRail(compactState());
    await userEvent.hover(rail());
    await userEvent.unhover(rail());
    expect(sent).toEqual([]);
  });

  it('an ordinary rail has no chevron — there is nothing to collapse to', async () => {
    await renderRail(state());
    expect(chevron()).toBeNull();
  });

  it('A COLLAPSED RAIL STILL SHOWS EVERY ICON — only the labels are traded away', async () => {
    // The whole reason to collapse rather than hide: switching service stays ONE click. Hiding the
    // tiles made it three (open, click, close), which is worse than the width it bought back.
    await renderRail(compactState());
    expect(rail().className).toContain('is-compact');
    expect(screen.getByLabelText('gmail')).toBeInTheDocument();
    expect(screen.queryByText('gmail')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Show the rail')).toBeInTheDocument();
    // Add and Settings survive too — the strip is wide enough for a tile, and they are the two
    // things the rail cannot otherwise reach.
    expect(screen.getByLabelText('Add a connection')).toBeInTheDocument();
    expect(screen.getByLabelText('Settings')).toBeInTheDocument();
  });

  it('THE CHEVRON DOES NOT MOVE when the rail opens', async () => {
    // It lives in the bottom-anchored footer in both states. A control that jumps to the other end
    // of the window as a result of being pressed is one you have to hunt for to press again.
    await renderRail(compactState());
    expect(chevron()?.closest('.rail-footer')).not.toBeNull();

    await renderRail(compactState({ railExpanded: true }));
    const footer = chevron()?.closest('.rail-footer');
    expect(footer).not.toBeNull();
    // And it is last, below Add and Settings, being the only one that survives the collapse.
    expect(footer?.lastElementChild).toBe(chevron());
  });

  it('AN OPENED ONE IS A PANEL — the name beside the icon, not under it', async () => {
    // The labels are the only thing opening it buys, so they are not left to `showLabels` the way
    // an ordinary rail's are. A wider strip of unlabelled icons would be a pointless state.
    await renderRail(compactState({ railExpanded: true }));
    expect(rail().className).not.toContain('is-compact');
    expect(rail().className).toContain('is-panel');
    expect(screen.getByText('gmail')).toBeInTheDocument();
    // INSIDE the tile, not beside it: the whole row is the click target, the way a Chrome tab is
    // clickable across its width. A name that looks pressable and is not is worse than no name.
    expect(screen.getByLabelText('gmail')).toContainElement(screen.getByText('gmail'));
    await userEvent.click(screen.getByText('gmail'));
    expect(sent).toContainEqual({ type: 'focus-service', serviceId: 'gmail' });
    // And the chevron turns round, so the way back is where the way in was.
    expect(screen.getByLabelText('Hide the rail')).toBeInTheDocument();
  });

  it('ONLY THE CHEVRON CLOSES THE PANEL — the background is inert', async () => {
    // Dismiss-on-background-click was tried and reported as the panel closing by itself: the empty
    // column under the icons is most of the panel's area, so every stray or mistimed click landed
    // in it. A control that shuts on contact with its own dead space is not dismissible, it is
    // fragile. The chevron is the one way in and the one way out.
    await renderRail(compactState({ railExpanded: true }));
    await userEvent.click(rail());
    expect(sent).not.toContainEqual({ type: 'toggle-rail' });

    await userEvent.click(screen.getByLabelText('Hide the rail'));
    expect(sent).toContainEqual({ type: 'toggle-rail' });
  });

  it('and the tiles in that column still answer for themselves', async () => {
    await renderRail(compactState({ railExpanded: true }));
    await userEvent.click(screen.getByLabelText('gmail'));
    expect(sent).toContainEqual({ type: 'focus-service', serviceId: 'gmail' });

    sent.length = 0;
    await userEvent.click(screen.getByLabelText('Settings'));
    expect(sent).toContainEqual({ type: 'open-settings' });
    expect(sent).not.toContainEqual({ type: 'toggle-rail' });
  });

  it('DOUBLE-CLICKING A NAME RENAMES IT IN PLACE', async () => {
    // Two services from one catalog entry arrive identically named — two tiles both called "Teams"
    // — and the panel is the only place the name is on screen to be corrected.
    await renderRail(compactState({ railExpanded: true }));
    await userEvent.dblClick(screen.getByText('gmail'));

    const field = screen.getByLabelText('Rename gmail');
    await userEvent.clear(field);
    await userEvent.type(field, 'Work mail{Enter}');
    expect(sent).toContainEqual({ type: 'rename-service', serviceId: 'gmail', name: 'Work mail' });
  });

  it('typing a SPACE into the name does not start a drag', async () => {
    // The row is a dnd-kit draggable and its keyboard sensor reads Space on a focused draggable as
    // "lift this". The field has to stop the event before it reaches the slot.
    await renderRail(compactState({ railExpanded: true }));
    await userEvent.dblClick(screen.getByText('gmail'));

    const field = screen.getByLabelText('Rename gmail');
    await userEvent.clear(field);
    await userEvent.type(field, 'a b{Enter}');
    expect(sent).toContainEqual({ type: 'rename-service', serviceId: 'gmail', name: 'a b' });
  });

  it('ESCAPE ABANDONS the edit rather than committing it', async () => {
    await renderRail(compactState({ railExpanded: true }));
    await userEvent.dblClick(screen.getByText('gmail'));
    await userEvent.type(screen.getByLabelText('Rename gmail'), 'zzz{Escape}');
    expect(sent.filter((c) => (c as { type: string }).type === 'rename-service')).toEqual([]);
  });

  it('RIGHT-CLICK ▸ RENAME EDITS THE ROW rather than opening Settings', async () => {
    // The old fallback sent you to a Settings page listing every connection — no use at all when
    // the reason you are renaming is that two rows are both called "Teams".
    await renderRail(compactState({ railExpanded: true }));
    expect(screen.queryByLabelText('Rename gmail')).not.toBeInTheDocument();

    await act(async () =>
      pushState(
        compactState({ railExpanded: true, renameRequest: { serviceId: 'gmail', nonce: 1 } }),
      ),
    );
    expect(screen.getByLabelText('Rename gmail')).toBeInTheDocument();
    expect(sent).not.toContainEqual({ type: 'open-settings' });
  });

  it('AN UNRELATED BROADCAST DOES NOT REOPEN a finished edit', async () => {
    // `renameRequest` is carried by every subsequent broadcast. Reacting to the request rather
    // than to a *change* in its nonce would reopen the field on the next unread tick.
    const request = { serviceId: 'gmail', nonce: 1 };
    await renderRail(compactState({ railExpanded: true, renameRequest: request }));
    await userEvent.type(screen.getByLabelText('Rename gmail'), '{Escape}');
    await userEvent.tab();
    expect(screen.queryByLabelText('Rename gmail')).not.toBeInTheDocument();

    await act(async () =>
      pushState(compactState({ railExpanded: true, renameRequest: { ...request } })),
    );
    expect(screen.queryByLabelText('Rename gmail')).not.toBeInTheDocument();

    // A second, genuinely new request still lands.
    await act(async () =>
      pushState(
        compactState({ railExpanded: true, renameRequest: { serviceId: 'gmail', nonce: 2 } }),
      ),
    );
    expect(screen.getByLabelText('Rename gmail')).toBeInTheDocument();
  });

  it('falls back to Settings when the rail has nowhere to put a field', async () => {
    // An ordinary 72px rail cannot hold a text field, and a horizontal one has no name on screen.
    await renderRail(state({ renameRequest: { serviceId: 'gmail', nonce: 1 } }));
    expect(screen.queryByLabelText('Rename gmail')).not.toBeInTheDocument();
    expect(sent).toContainEqual({ type: 'open-settings' });
  });

  it('clicking away commits the edit and leaves the panel open', async () => {
    await renderRail(compactState({ railExpanded: true }));
    await userEvent.dblClick(screen.getByText('gmail'));
    await userEvent.clear(screen.getByLabelText('Rename gmail'));
    await userEvent.type(screen.getByLabelText('Rename gmail'), 'Work mail');

    sent.length = 0;
    await userEvent.click(rail());
    expect(sent).toContainEqual({ type: 'rename-service', serviceId: 'gmail', name: 'Work mail' });
    expect(sent).not.toContainEqual({ type: 'toggle-rail' });
  });

  it('follows main rather than its own click: expansion arrives as state', async () => {
    await renderRail(compactState());
    expect(rail().className).toContain('is-compact');
    await userEvent.click(chevron()!);
    // Clicking alone changes nothing on screen — main has not answered yet.
    expect(rail().className).toContain('is-compact');
    await act(async () => pushState(compactState({ railExpanded: true })));
    expect(rail().className).not.toContain('is-compact');
  });

  it('sets no width of its own — the view is the rail', async () => {
    // Sizing from state as well would leave the box and the view it lives in disagreeing for a
    // frame on every expand: a stripe of pane through the rail, or a tile clipped in half.
    await renderRail(compactState({ railExpanded: true }));
    expect(rail().style.width).toBe('');
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
