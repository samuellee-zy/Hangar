// Rebinding and the per-service passthrough list, from the renderer's side.
//
// The interesting part is the capture: a keypress has to become the same canonical string main
// would have produced from the same physical key, or the chord that gets stored is not the chord
// that was pressed. That is why the renderer parses chords itself rather than being handed
// pre-rendered strings — and why it is worth asserting rather than assuming.

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Keyboard } from '../../src/renderer/settings/Keyboard';
import { sent } from './setup';
import { DEFAULT_PREFERENCES } from '../../src/core/config/preferences';
import type { ServiceView, ShellState } from '../../src/shared/types';

const svc = (id: string, over: Partial<ServiceView> = {}): ServiceView =>
  ({
    id,
    catalogId: 'slack',
    name: id,
    accountId: 'a1',
    notifications: true,
    hibernate: true,
    zoom: 1,
    initials: 'SL',
    color: '#4A154B',
    loading: false,
    sleeping: false,
    unread: 0,
    ...over,
  }) as ServiceView;

const state = (over: Partial<ShellState> = {}): ShellState =>
  ({
    services: [],
    allServices: [],
    railItems: [],
    preferences: DEFAULT_PREFERENCES,
    orphanPartitions: [],
    quarantinedConfigs: [],
    syncStatus: { state: 'off' },
    accounts: [],
    workspaces: [],
    panes: [],
    focusedPaneId: null,
    activeWorkspaceId: null,
    railExpanded: false,
    keyboard: {
      actions: [
        { id: 'palette', label: 'Command palette', chord: 'meta+k', conflict: false },
        { id: 'sleep-others', label: 'Sleep background services', chord: '', conflict: false },
      ],
      reserved: ['meta+q'],
      passthrough: {},
    },
    ...over,
  }) as ShellState;

describe('rebinding', () => {
  it('renders a chord as symbols and an unbound action as words', () => {
    render(<Keyboard state={state()} />);

    expect(screen.getByRole('button', { name: '⌘K' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Not bound' })).toBeInTheDocument();
  });

  it('CAPTURES A KEYPRESS AS THE CANONICAL CHORD MAIN WILL STORE', async () => {
    // The whole contract between the two processes. `⌥⌘J` has to arrive as `alt+meta+j` — modifier
    // order and all — or `actionForChord` compares two spellings of one chord and matches neither.
    render(<Keyboard state={state()} />);

    await userEvent.click(screen.getByRole('button', { name: '⌘K' }));
    await userEvent.keyboard('{Alt>}{Meta>}j{/Meta}{/Alt}');

    expect(sent).toContainEqual({ type: 'rebind', actionId: 'palette', chord: 'alt+meta+j' });
  });

  it('keeps listening through a bare modifier', async () => {
    // Holding ⌘ before pressing K is the normal way to type a chord. Committing on the ⌘ alone
    // would make every capture produce the same useless result.
    //
    // One `user` for the whole test: the modifier has to still be held on the second call, and the
    // bare `userEvent.keyboard` helper starts from a clean keyboard each time.
    const user = userEvent.setup();
    render(<Keyboard state={state()} />);

    await user.click(screen.getByRole('button', { name: '⌘K' }));
    await user.keyboard('{Meta>}');
    expect(sent).toEqual([]);

    await user.keyboard('j{/Meta}');
    expect(sent).toContainEqual({ type: 'rebind', actionId: 'palette', chord: 'meta+j' });
  });

  it('REFUSES A CHORD THE MENU BAR OWNS, and says which', async () => {
    // Main would reject it too, by returning the map unchanged — which on its own is
    // indistinguishable from the keypress not having registered.
    render(<Keyboard state={state()} />);

    await userEvent.click(screen.getByRole('button', { name: '⌘K' }));
    await userEvent.keyboard('{Meta>}q{/Meta}');

    expect(sent).toEqual([]);
    expect(screen.getByText(/⌘Q belongs to the menu bar/)).toBeInTheDocument();
  });

  it('refuses a chord with no command modifier', async () => {
    // A binding on bare J would fire in every text field in every service.
    render(<Keyboard state={state()} />);

    await userEvent.click(screen.getByRole('button', { name: '⌘K' }));
    await userEvent.keyboard('j');

    expect(sent).toEqual([]);
    expect(screen.getByText(/needs ⌘ or ⌃/)).toBeInTheDocument();
  });

  it('Escape abandons the capture without binding anything', async () => {
    render(<Keyboard state={state()} />);

    await userEvent.click(screen.getByRole('button', { name: '⌘K' }));
    await userEvent.keyboard('{Escape}');

    expect(sent).toEqual([]);
    expect(screen.getByRole('button', { name: '⌘K' })).toBeInTheDocument();
  });

  it('clearing sends null, and is unavailable for an action that has no chord', async () => {
    render(<Keyboard state={state()} />);

    expect(screen.getByTitle('Unbind Sleep background services')).toBeDisabled();
    await userEvent.click(screen.getByTitle('Unbind Command palette'));

    expect(sent).toContainEqual({ type: 'rebind', actionId: 'palette', chord: null });
  });

  it('marks a conflict, which only a hand-edited or synced config can produce', () => {
    render(
      <Keyboard
        state={state({
          keyboard: {
            actions: [
              { id: 'palette', label: 'Command palette', chord: 'meta+k', conflict: true },
              { id: 'find', label: 'Find in page…', chord: 'meta+k', conflict: true },
            ],
            reserved: [],
            passthrough: {},
          },
        })}
      />
    );

    for (const button of screen.getAllByRole('button', { name: '⌘K' })) {
      expect(button).toHaveAttribute('title', expect.stringMatching(/another action/i));
    }
  });
});

describe('service shortcuts', () => {
  const withSlack = (chords: string[], fromCatalog = true) =>
    state({
      allServices: [svc('slack')],
      keyboard: {
        actions: [],
        reserved: [],
        passthrough: { slack: { chords, fromCatalog } },
      },
    });

  it('shows the chords a service keeps, and marks them as the catalog default', () => {
    render(<Keyboard state={withSlack(['meta+k', 'meta+f'])} />);

    expect(screen.getByRole('button', { name: '⌘K ✕' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '⌘F ✕' })).toBeInTheDocument();
    expect(screen.getByText(/· default/)).toBeInTheDocument();
  });

  it('REMOVING ONE PINS THE REST, rather than sending an empty override', async () => {
    // Sending just the removal would be read as "claim nothing" and hand every other default back
    // to Hangar — so taking ⌘K off Slack would silently also take ⌘F.
    render(<Keyboard state={withSlack(['meta+k', 'meta+f'])} />);

    await userEvent.click(screen.getByRole('button', { name: '⌘K ✕' }));

    expect(sent).toContainEqual({
      type: 'update-service',
      serviceId: 'slack',
      patch: { keyboardPassthrough: ['meta+f'] },
    });
  });

  it('adds a captured chord to the existing list', async () => {
    render(<Keyboard state={withSlack(['meta+k'])} />);

    await userEvent.click(screen.getByTitle('Leave a chord to slack'));
    await userEvent.keyboard('{Meta>}f{/Meta}');

    expect(sent).toContainEqual({
      type: 'update-service',
      serviceId: 'slack',
      patch: { keyboardPassthrough: ['meta+k', 'meta+f'] },
    });
  });

  it('a service claiming nothing is still listed, so it can be given something', () => {
    render(<Keyboard state={withSlack([], false)} />);

    expect(screen.getByTitle('Leave a chord to slack')).toBeInTheDocument();
    expect(screen.queryByText(/· default/)).not.toBeInTheDocument();
  });
});
