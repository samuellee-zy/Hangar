// Settings as a whole: one group at a time, and a search across all of them.

import { describe, it, expect } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Settings } from '../../src/renderer/Settings';
import { setShellState } from './setup';
import { DEFAULT_PREFERENCES } from '../../src/core/config/preferences';
import type { ShellState } from '../../src/shared/types';

const state = (): ShellState =>
  ({
    services: [],
    allServices: [],
    railItems: [],
    preferences: DEFAULT_PREFERENCES,
    orphanPartitions: [],
    quarantinedConfigs: [],
    syncStatus: { state: 'off' },
    accounts: [],
    workspaces: [{ id: 'w1', name: 'Work', items: [] }],
    panes: [],
    focusedPaneId: null,
    activeWorkspaceId: 'w1',
    keyboard: { actions: [], reserved: [], passthrough: {} },
  }) as unknown as ShellState;

const renderSettings = async () => {
  setShellState(state());
  render(<Settings />);
  await act(async () => {});
};

const visibleHeadings = () =>
  screen
    .queryAllByRole('heading', { level: 2 })
    .filter((h) => !h.closest('section')?.hidden)
    .map((h) => h.textContent);

describe('Settings', () => {
  it('opens on General, not on eighteen sections in one scroll', async () => {
    await renderSettings();
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('General');
    expect(visibleHeadings()).toContain('Behaviour');
    expect(visibleHeadings()).not.toContain('Network');
  });

  it('the sidebar switches group', async () => {
    await renderSettings();
    await userEvent.click(screen.getByRole('button', { name: 'Network & downloads' }));
    expect(visibleHeadings()).toContain('Network');
    expect(visibleHeadings()).not.toContain('Behaviour');
  });

  it('SEARCH LOOKS THROUGH EVERY GROUP, and hides the sections that say nothing about it', async () => {
    await renderSettings();
    await userEvent.type(screen.getByRole('searchbox', { name: 'Search settings' }), 'proxy');
    expect(visibleHeadings()).toContain('Network');
    expect(visibleHeadings()).not.toContain('Behaviour');
  });

  it('says so when nothing matches', async () => {
    await renderSettings();
    await userEvent.type(screen.getByRole('searchbox', { name: 'Search settings' }), 'zzqqxx');
    expect(screen.getByText('Nothing in Settings mentions that.')).toBeInTheDocument();
  });
});
