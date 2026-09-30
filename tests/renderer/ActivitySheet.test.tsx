// The sheet of recent notifications and downloads — kept all along, and shown only in the tray.

import { describe, it, expect } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ActivitySheet, ago } from '../../src/renderer/ActivitySheet';
import { sent, setShellState } from './setup';
import { DEFAULT_PREFERENCES } from '../../src/core/config/preferences';
import type { ServiceView, ShellState } from '../../src/shared/types';

const svc = (id: string, name: string, unread = 0) =>
  ({ id, name, catalogId: 'slack', accountId: 'a', notifications: true, hibernate: true, zoom: 1, initials: 'Sl', color: '#4A154B', loading: false, sleeping: false, unread }) as ServiceView;

const state = (over: Partial<ShellState> = {}): ShellState =>
  ({
    services: [],
    allServices: [svc('slack', 'Slack', 2)],
    railItems: [],
    preferences: DEFAULT_PREFERENCES,
    workspaces: [],
    panes: [],
    focusedPaneId: null,
    activeWorkspaceId: null,
    recentNotifications: [{ serviceId: 'slack', title: 'Alex', body: 'are you free?', at: Date.now() - 5 * 60_000 }],
    downloads: [{ id: 'd1', name: 'report.pdf', path: '/tmp/report.pdf', state: 'completed', received: 10, total: 10, at: 0 }],
    ...over,
  }) as ShellState;

async function renderSheet(s: ShellState = state()) {
  setShellState(s);
  render(<ActivitySheet />);
  await act(async () => {});
}

describe('recent notifications and downloads', () => {
  it('A MISSED NOTIFICATION IS HERE, NAMED BY SERVICE, AND LEADS BACK TO IT', async () => {
    await renderSheet();
    const row = screen.getByRole('button', { name: /Slack · Alex/ });
    expect(row).toHaveTextContent('are you free?');
    expect(row).toHaveTextContent('5 min ago');
    await userEvent.click(row);
    expect(sent).toContainEqual({ type: 'close-overlay' });
    expect(sent).toContainEqual({ type: 'focus-service', serviceId: 'slack' });
  });

  it('offers Mark all as read only while something is unread', async () => {
    await renderSheet();
    await userEvent.click(screen.getByRole('button', { name: 'Mark all as read' }));
    expect(sent).toContainEqual({ type: 'mark-all-read' });
  });

  it('a finished download shows its file in Finder; an unfinished one says how far', async () => {
    await renderSheet(
      state({
        downloads: [
          { id: 'd1', name: 'done.pdf', path: '/x', state: 'completed', received: 1, total: 1, at: 0, service: 'Slack' },
          { id: 'd2', name: 'half.zip', path: '', state: 'progressing', received: 5, total: 10, at: 0, service: null },
        ],
      }),
    );
    await userEvent.click(screen.getByRole('button', { name: /done\.pdf/ }));
    expect(sent).toContainEqual({ type: 'reveal-download', id: 'd1' });
    expect(screen.getByRole('button', { name: /half\.zip/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: /half\.zip/ })).toHaveTextContent('50%');
  });

  it('SAYS WHICH SERVICE A DOWNLOAD CAME FROM — a file from one of six chat apps', async () => {
    await renderSheet(
      state({
        downloads: [
          { id: 'd1', name: 'done.pdf', path: '/x', state: 'completed', received: 1, total: 1, at: 0, service: 'Slack' },
          { id: 'd2', name: 'own.png', path: '/y', state: 'completed', received: 1, total: 1, at: 0, service: null },
        ],
      }),
    );
    expect(screen.getByRole('button', { name: /done\.pdf/ })).toHaveTextContent(/^Slack · done\.pdf/);
    expect(screen.getByRole('button', { name: /own\.png/ })).toHaveTextContent(/^own\.png/);
  });

  it('says what collects here when nothing has yet', async () => {
    await renderSheet(state({ recentNotifications: [], downloads: [] }));
    expect(screen.getByText(/Nothing yet/)).toBeInTheDocument();
  });
});

describe('ago', () => {
  it('reads like a person would say it', () => {
    const now = 1_000_000_000_000;
    expect(ago(now - 10_000, now)).toBe('just now');
    expect(ago(now - 5 * 60_000, now)).toBe('5 min ago');
    expect(ago(now - 3 * 3_600_000, now)).toBe('3 h ago');
  });
});
