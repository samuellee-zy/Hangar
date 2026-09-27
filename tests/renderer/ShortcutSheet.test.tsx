// The ⌘/ sheet is read from main's keymap, so it cannot advertise a chord that has moved.

import { describe, it, expect } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { ShortcutSheet } from '../../src/renderer/ShortcutSheet';
import { setShellState } from './setup';
import type { ShellState } from '../../src/shared/types';

const state = (actions: ShellState['keyboard']['actions']) =>
  ({
    services: [],
    allServices: [],
    workspaces: [],
    keyboard: { actions, reserved: [], passthrough: {} },
  }) as unknown as ShellState;

describe('the shortcut sheet', () => {
  it('SHOWS A REBOUND CHORD AS REBOUND, and an unbound action as unbound', async () => {
    setShellState(
      state([
        { id: 'palette', label: 'Command palette', chord: 'meta+j', conflict: false, command: { type: 'open-palette' } },
        { id: 'sleep-others', label: 'Sleep background services', chord: '', conflict: false, command: { type: 'sleep-others' } },
      ]),
    );
    render(<ShortcutSheet />);
    await act(async () => {});

    const palette = screen.getByText('Command palette').parentElement!;
    expect(palette).toHaveTextContent('⌘J');
    expect(palette).not.toHaveTextContent('⌘K');
    expect(screen.getByText('Sleep background services').parentElement!).toHaveTextContent('not set');
  });

  it('lists the gestures that are not bindings and appear nowhere else', async () => {
    setShellState(state([]));
    render(<ShortcutSheet />);
    await act(async () => {});
    expect(screen.getByText('⌥-click a tile')).toBeInTheDocument();
    expect(screen.getByText('⌘1 … ⌘9')).toBeInTheDocument();
  });

  it('is a labelled modal dialog', async () => {
    setShellState(state([]));
    render(<ShortcutSheet />);
    await act(async () => {});
    expect(screen.getByRole('dialog', { name: 'Keyboard shortcuts' })).toHaveAttribute('aria-modal', 'true');
  });
});
