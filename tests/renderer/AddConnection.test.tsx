// The `+` surface, and the one decision it has to get right: is this service already added?
//
// It asked `state.services`, which is the *active workspace only*. `state.allServices` is the
// cross-workspace list, and Settings and EmptyState both already used it. So a Gmail added in
// workspace B read as "not added" from workspace A — the tile said "new account", and clicking it
// created a duplicate instead of focusing the one that exists. Accounts are global; this check has
// to be too.

import { describe, it, expect } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AddConnection } from '../../src/renderer/AddConnection';
import { sent, setShellState } from './setup';
import { DEFAULT_PREFERENCES } from '../../src/core/config/preferences';
import type { Account, ServiceView, ShellState } from '../../src/shared/types';

const svc = (id: string, catalogId: string, accountId = 'a1'): ServiceView =>
  ({
    id,
    catalogId,
    name: catalogId,
    accountId,
    notifications: true,
    hibernate: true,
    zoom: 1,
    initials: 'XX',
    color: '#4A154B',
    loading: false,
    sleeping: false,
    unread: 0,
  }) as ServiceView;

const account = (id: string, provider: string, label: string): Account =>
  ({ id, provider, label, partition: `persist:${id}` }) as Account;

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
    workspaces: [{ id: 'w1', name: 'Work', items: [] }],
    panes: [],
    focusedPaneId: null,
    activeWorkspaceId: 'w1',
    ...over,
  }) as ShellState;

async function renderPicker(s: ShellState) {
  setShellState(s);
  const view = render(<AddConnection />);
  await act(async () => {});
  return view;
}

/**
 * The main Gmail tile.
 *
 * Excludes the "sign into a different account" button beside it, which also names the service in
 * its title — matching on the name alone finds both.
 */
const gmailTile = () =>
  screen.getAllByTitle(/Gmail/).find((el) => !el.title.startsWith('Sign into'))!;

describe('a service added in another workspace', () => {
  /**
   * Gmail exists, but not in the workspace being viewed. This is the exact shape the bug needed:
   * `services` empty, `allServices` populated.
   */
  const elsewhere = () =>
    state({
      services: [],
      allServices: [svc('s1', 'gmail')],
      accounts: [account('a1', 'google', 'Google')],
    });

  it('READS AS ALREADY ADDED, not as a new account', async () => {
    await renderPicker(elsewhere());

    // Scoped to the tile: every other catalog entry legitimately says "new account", so a
    // document-wide query would be asserting something else entirely.
    expect(gmailTile()).toHaveAttribute('title', expect.stringMatching(/already added/i));
    expect(gmailTile()).toHaveTextContent('✓ added');
    expect(gmailTile()).not.toHaveTextContent('new account');
  });

  it('CLICKING IT FOCUSES THE EXISTING SERVICE rather than adding a duplicate', async () => {
    await renderPicker(elsewhere());

    await userEvent.click(gmailTile());

    expect(sent).toContainEqual({ type: 'focus-service', serviceId: 's1' });
    expect(sent).not.toContainEqual(
      expect.objectContaining({ type: 'add-service', catalogId: 'gmail' })
    );
  });

  it('counts every instance across workspaces, not just the visible ones', async () => {
    await renderPicker(
      state({
        services: [svc('s1', 'gmail')],
        allServices: [svc('s1', 'gmail'), svc('s2', 'gmail', 'a2')],
        accounts: [account('a1', 'google', 'Google')],
      })
    );

    expect(screen.getByText('✓ 2 added')).toBeInTheDocument();
  });
});

describe('a service that genuinely is not added', () => {
  it('offers to add it, so the guard has not been made unconditional', async () => {
    // Without this the tests above pass with `isAdded` hardcoded true.
    await renderPicker(state());

    expect(gmailTile()).toHaveAttribute('title', expect.stringMatching(/^Add Gmail/));

    await userEvent.click(gmailTile());
    expect(sent).toContainEqual({ type: 'add-service', catalogId: 'gmail' });
  });

  it('names the account it will ride when the provider already has one', async () => {
    // Adding Calendar should use the Google login you already have — the case that makes reusing
    // `allServices` for *accounts* correct as well.
    await renderPicker(
      state({
        allServices: [svc('s1', 'gmail')],
        accounts: [account('a1', 'google', 'Google')],
      })
    );

    expect(screen.getByTitle('Add Calendar using Google')).toBeInTheDocument();
  });
});

describe('adding a second account', () => {
  it('is still offered for a service you already have', async () => {
    // "Already added" must not remove the way to sign into a second Gmail — that is the feature
    // the whole picker exists for.
    await renderPicker(
      state({
        allServices: [svc('s1', 'gmail')],
        accounts: [account('a1', 'google', 'Google')],
      })
    );

    await userEvent.click(screen.getByTitle('Sign into a different Gmail account'));

    expect(sent).toContainEqual({
      type: 'add-service',
      catalogId: 'gmail',
      forceNewAccount: true,
    });
  });
});
