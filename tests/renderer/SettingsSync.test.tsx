// The sync section, and specifically the conflict resolution UI.
//
// This is the most consequential control surface in Settings and it had no coverage, because it
// lived inside a 679-line render function that could only be exercised whole. It is also the one
// place where the label and the behaviour have already disagreed: both buttons originally wrote the
// *remote* as the new base, which made them identical — "Keep repo" pushed local over the repo, the
// exact opposite of its label, discarding the copy the user had just asked to keep.
//
// So these assert the pairing of *label to command*, not merely that two buttons exist.

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Sync, syncNote } from '../../src/renderer/settings/Sync';
import { sent } from './setup';
import { DEFAULT_PREFERENCES } from '../../src/core/config/preferences';
import type { SyncStatus } from '../../src/shared/types';

const prefs = (over: Partial<{ repoPath: string; allowPublicRepo: boolean }> = {}) => ({
  ...DEFAULT_PREFERENCES.sync,
  repoPath: '/home/me/dotfiles',
  ...over,
});

const renderSync = (status: SyncStatus, sync = prefs()) =>
  render(<Sync sync={sync} status={status} />);

const conflict: SyncStatus = { state: 'conflict', detail: 'histories diverged' };

describe('resolving a conflict', () => {
  it('OFFERS BOTH DIRECTIONS, because detecting a conflict and offering nothing is a dead end', async () => {
    renderSync(conflict);

    expect(screen.getByRole('heading', { name: /resolve the conflict/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Keep local' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Keep repo' })).toBeInTheDocument();
  });

  it('"KEEP LOCAL" SENDS winner: local — the pairing that was once inverted', async () => {
    renderSync(conflict);

    await userEvent.click(screen.getByRole('button', { name: 'Keep local' }));

    expect(sent).toContainEqual({ type: 'resolve-sync', winner: 'local' });
  });

  it('"KEEP REPO" SENDS winner: remote', async () => {
    renderSync(conflict);

    await userEvent.click(screen.getByRole('button', { name: 'Keep repo' }));

    expect(sent).toContainEqual({ type: 'resolve-sync', winner: 'remote' });
  });

  it('says out loud that the other copy is discarded', async () => {
    // Both buttons destroy something. Neither is recoverable from inside Hangar.
    renderSync(conflict);

    expect(screen.getByText(/the other one is discarded/i)).toBeInTheDocument();
    expect(screen.getByText(/overwrites the repo/i)).toBeInTheDocument();
    expect(screen.getByText(/overwrites this machine/i)).toBeInTheDocument();
  });

  it('IS ABSENT when there is no conflict, so the buttons cannot be hit by accident', () => {
    for (const status of [
      { state: 'idle', lastSync: null },
      { state: 'off' },
      { state: 'error', detail: 'no' },
      { state: 'unavailable', reason: 'no git' },
    ] as SyncStatus[]) {
      const { unmount } = renderSync(status);
      expect(
        screen.queryByRole('button', { name: 'Keep local' }),
        `visible in state "${status.state}"`
      ).not.toBeInTheDocument();
      unmount();
    }
  });
});

describe('the sync-now button', () => {
  it('is disabled without a repository path, since there is nothing to sync with', () => {
    renderSync({ state: 'off' }, prefs({ repoPath: '' }));

    expect(screen.getByRole('button', { name: 'Sync' })).toBeDisabled();
  });

  it('is disabled for a path that is only whitespace', () => {
    renderSync({ state: 'off' }, prefs({ repoPath: '   ' }));

    expect(screen.getByRole('button', { name: 'Sync' })).toBeDisabled();
  });

  it('sends sync-now when there is a path', async () => {
    renderSync({ state: 'idle', lastSync: null });

    await userEvent.click(screen.getByRole('button', { name: 'Sync' }));

    expect(sent).toContainEqual({ type: 'sync-now' });
  });
});

describe('the status line', () => {
  // An opaque "error" helps nobody — every state has to say what it means and, where relevant,
  // what to do about it.
  it('reports why sync is unavailable rather than that it is', () => {
    expect(syncNote({ state: 'unavailable', reason: 'git is not available on PATH' })).toBe(
      'git is not available on PATH'
    );
  });

  it('surfaces an error detail verbatim', () => {
    expect(syncNote({ state: 'error', detail: 'permission denied (publickey)' })).toContain(
      'permission denied (publickey)'
    );
  });

  it('a conflict says what to do next, not just that something is wrong', () => {
    const note = syncNote(conflict);
    expect(note).toMatch(/resolve/i);
    expect(note).toContain('histories diverged');
  });

  it('distinguishes never-synced from synced-at-a-time', () => {
    expect(syncNote({ state: 'idle', lastSync: null })).toBe('Ready');
    expect(syncNote({ state: 'idle', lastSync: Date.parse('2026-01-01T09:30:00Z') })).toMatch(
      /^Last synced /
    );
  });

  it('explains that an empty path is how you turn sync off', () => {
    expect(syncNote({ state: 'off' })).toMatch(/empty disables sync/i);
  });

  it('is rendered into the section, not merely computed', () => {
    // Otherwise the tests above pass while the note never reaches the user.
    renderSync({ state: 'unavailable', reason: 'git is not available on PATH' });

    expect(screen.getByText('git is not available on PATH')).toBeInTheDocument();
  });
});
