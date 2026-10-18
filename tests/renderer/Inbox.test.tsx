import { describe, it, expect, vi } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Inbox } from '../../src/renderer/inbox/Inbox';
import { setShellState } from './setup';
import type { ShellState } from '@shared/types';
import type { InboxReply, InboxSnapshot, InboxThread } from '@shared/inbox';

function setup() {
  setShellState({ inboxOpen: true, activeWorkspaceId: 'work', workspaces: [{ id: 'work', name: 'Work' }] } as ShellState);
  let snapshot: InboxSnapshot = { workspaceId: 'work', workspaceName: 'Work', sources: [
    { id: 'slack', serviceId: 's', kind: 'slack', app: 'Slack', label: 'Work', identity: 'me · team', state: 'ready', detail: '', updatedAt: 1000, canRead: true, canSearch: true, hasMore: false },
    { id: 'page:wa', serviceId: 'wa', kind: 'page', app: 'WhatsApp', label: 'Personal', identity: null, state: 'limited', detail: 'Names only', updatedAt: null, canRead: false, canSearch: false, hasMore: false },
  ], items: [
    { id: 'one', ref: { connectionId: 'slack', threadId: 'C1:1.1' }, title: 'Feature decision', preview: 'Ship it', author: 'Maya', at: 1000, unread: null, mention: true, category: 'mentions' },
    { id: 'two', ref: { connectionId: 'page:wa', threadId: 'Family' }, title: 'Family', preview: 'Limited preview', author: '', at: null, unread: true, mention: false, category: 'other' },
  ] };
  let changed = () => {};
  const read = vi.fn(async (ref) => ({ ok: true as const, value: { ref, title: 'Feature', messages: [{ id: 'm1', author: 'Maya', at: 1000, text: 'The decision is ready.' }], partial: false } }));
  window.hangar.inbox = { snapshot: vi.fn(async () => ({ ok: true as const, value: snapshot })), refresh: vi.fn(async () => ({ ok: true as const, value: null })),
    more: vi.fn(), read, open: vi.fn(async () => ({ ok: true as const, value: null })), connect: vi.fn(), disconnect: vi.fn(), cancelConnect: vi.fn(),
    onChanged: (fn) => { changed = fn; return () => {}; } };
  render(<Inbox />);
  return { read, update: async (next: InboxSnapshot) => { snapshot = next; await act(async () => changed()); }, snapshot };
}

describe('unified inbox interactions', () => {
  it('keeps unknown read states separate and does not request bodies for limited previews', async () => {
    const { read } = setup();
    await screen.findByRole('button', { name: /Feature decision Ship it/ });
    await userEvent.click(screen.getByRole('button', { name: 'Unread only' }));
    expect(screen.queryByRole('button', { name: /Feature decision Ship it/ })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: /Family.*Limited preview/ }));
    expect(read).not.toHaveBeenCalled();
    expect(screen.getByText('Continue in the original app')).toBeVisible();
  });
  it('reads only the selected source and opens an opaque reference rather than a provider URL', async () => {
    setup();
    await userEvent.click(await screen.findByRole('button', { name: /Feature decision Ship it/ }));
    expect(await screen.findByText('The decision is ready.')).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: 'Open in Slack' }));
    expect(window.hangar.inbox.open).toHaveBeenCalledWith({ connectionId: 'slack', threadId: 'C1:1.1' });
    expect(screen.getByText('Previewing here does not mark messages read.')).toBeVisible();
  });
  it('discards a delayed thread when its source is revoked', async () => {
    const { read, snapshot, update } = setup();
    let finish: (r: InboxReply<InboxThread>) => void = () => {};
    read.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve as typeof finish; }));
    await userEvent.click(await screen.findByRole('button', { name: /Feature decision Ship it/ }));
    await update({ ...snapshot, sources: snapshot.sources.filter((s) => s.id !== 'slack'), items: snapshot.items.slice(1) });
    await act(async () => finish({ ok: true as const, value: { ref: snapshot.items[0]!.ref, title: 'Private', messages: [{ id: 'secret', author: 'A', at: 1000, text: 'Do not retain this revoked body' }], partial: false } }));
    expect(screen.queryByText('Do not retain this revoked body')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Open in Slack' })).toBeNull();
  });
});
