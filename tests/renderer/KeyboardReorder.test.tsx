// Reordering the rail from the keyboard. dnd-kit's keyboard drag sits behind ⌃Space, which macOS
// also uses to switch input source — so with two keyboard layouts it never reached the rail.

import { describe, it, expect } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Rail } from '../../src/renderer/Rail';
import { keyboardStep } from '../../src/renderer/SortableRail';
import { sent, setShellState } from './setup';
import { DEFAULT_PREFERENCES } from '../../src/core/config/preferences';
import type { RailItem, ServiceView, ShellState } from '../../src/shared/types';

const svc = (id: string): ServiceView =>
  ({
    id, catalogId: 'gmail', name: id, accountId: 'a', notifications: true, hibernate: true, zoom: 1,
    initials: id.slice(0, 2), color: '#4A154B', loading: false, sleeping: false, unread: 0,
  }) as ServiceView;

describe('keyboardStep', () => {
  const ids = ['a', 'b', 'c'];
  it('one neighbour back or forward, on the rail\'s own axis', () => {
    expect(keyboardStep(ids, 'b', 'ArrowUp', false)).toEqual({ activeId: 'b', overId: 'a' });
    expect(keyboardStep(ids, 'b', 'ArrowDown', false)).toEqual({ activeId: 'b', overId: 'c' });
    expect(keyboardStep(ids, 'b', 'ArrowLeft', true)).toEqual({ activeId: 'b', overId: 'a' });
    expect(keyboardStep(ids, 'b', 'ArrowLeft', false), 'off-axis does nothing').toBeNull();
  });

  it('nothing past either end', () => {
    expect(keyboardStep(ids, 'a', 'ArrowUp', false)).toBeNull();
    expect(keyboardStep(ids, 'c', 'ArrowDown', false)).toBeNull();
  });
});

describe('on the rail', () => {
  const state = (): ShellState => {
    const services = [svc('gmail'), svc('slack'), svc('notion')];
    return {
      services,
      allServices: services,
      railItems: services.map((s): RailItem => ({ kind: 'service', id: s.id })),
      preferences: DEFAULT_PREFERENCES,
      orphanPartitions: [],
      quarantinedConfigs: [],
      syncStatus: { state: 'off' },
      accounts: [],
      workspaces: [],
      panes: [],
      focusedPaneId: null,
      activeWorkspaceId: 'w',
      railExpanded: false,
    } as unknown as ShellState;
  };

  it('⌥↓ ON A FOCUSED TILE MOVES IT, and says so', async () => {
    setShellState(state());
    render(<Rail />);
    await act(async () => {});

    screen.getByRole('button', { name: /^slack/ }).focus();
    await userEvent.keyboard('{Alt>}{ArrowDown}{/Alt}');
    expect(sent).toContainEqual({ type: 'move-item', activeId: 'slack', overId: 'notion' });
    expect(screen.getByText('slack moved after notion')).toBeInTheDocument();
  });

  it('the drag instructions name the keys that actually work', async () => {
    setShellState(state());
    render(<Rail />);
    await act(async () => {});
    expect(document.body.textContent).toMatch(/Option and the up or down arrow/);
    expect(document.body.textContent).not.toMatch(/press space or enter/i);
  });
});
