import { describe, it, expect, vi } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Inbox } from '../../src/renderer/inbox/Inbox';
import { setShellState } from './setup';
import type { ShellState } from '@shared/types';
import type { InboxReply, InboxSnapshot, InboxThread, SourceRef } from '@shared/inbox';

function setup() {
  setShellState({ inboxOpen: true, activeWorkspaceId: 'work', workspaces: [{ id: 'work', name: 'Work' }] } as ShellState);
  let snapshot: InboxSnapshot = { workspaceId: 'work', workspaceName: 'Work', sources: [
    { id: 'slack', serviceId: 's', kind: 'slack', app: 'Slack', label: 'Work', identity: 'me · team', state: 'ready', detail: '', updatedAt: 1000, canRead: true, canSearch: true, hasMore: false, canChat: true, connectConfigured: true },
    { id: 'page:wa', serviceId: 'wa', kind: 'page', app: 'WhatsApp', label: 'Personal', identity: null, state: 'limited', detail: 'Names only', updatedAt: null, canRead: false, canSearch: false, hasMore: false },
  ], items: [
    { id: 'one', ref: { connectionId: 'slack', threadId: 'dm:D123' }, title: 'Feature decision', preview: 'Ship it', author: 'Maya', at: 1000, unread: null, mention: true, category: 'direct', conversationKind: 'direct' },
    { id: 'two', ref: { connectionId: 'page:wa', threadId: 'Family' }, title: 'Family', preview: 'Limited preview', author: '', at: null, unread: true, mention: false, category: 'other' },
  ] };
  let changed = () => {};
  const read = vi.fn(async (ref: SourceRef): Promise<InboxReply<InboxThread>> => ({ ok: true as const, value: { ref, title: 'Feature', messages: [{ id: 'm1', author: 'Maya', at: 1000, text: 'The decision is ready.' }], partial: false } }));
  window.hangar.inbox = { snapshot: vi.fn(async () => ({ ok: true as const, value: snapshot })), refresh: vi.fn(async () => ({ ok: true as const, value: null })),
    more: vi.fn(), read, open: vi.fn(async () => ({ ok: true as const, value: null })), connect: vi.fn(async () => ({ ok: true as const, value: null })), disconnect: vi.fn(), cancelConnect: vi.fn(),
    onChanged: (fn) => { changed = fn; return () => {}; } };
  render(<Inbox />);
  const broadcast = (next: InboxSnapshot) => { snapshot = next; changed(); };
  return { read, broadcast, update: async (next: InboxSnapshot) => { await act(async () => broadcast(next)); }, snapshot };
}

describe('unified chat interactions', () => {
  it('appends an explicitly requested page without an extra update click or losing the selected chat', async () => {
    const { snapshot, update, broadcast, read } = setup();
    await screen.findByRole('button', { name: /Feature decision Ship it/ });
    const initial = { ...snapshot, sources: snapshot.sources.map((source) => ({ ...source, hasMore: source.id === 'slack' })) };
    await update(initial);
    await userEvent.click(await screen.findByRole('button', { name: /Feature decision Ship it/ }));
    await screen.findByText('The decision is ready.');
    const extra = { ...snapshot.items[0], id: 'extra', title: 'Another person', ref: { connectionId: 'slack', threadId: 'dm:D456' } };
    const paged = { ...initial, items: [extra, ...snapshot.items] };
    vi.mocked(window.hangar.inbox.more).mockImplementationOnce(async () => {
      broadcast(paged);
      return { ok: true, value: null };
    });
    await userEvent.click(screen.getByRole('button', { name: 'Load more from Slack · me · team' }));
    await screen.findByRole('button', { name: /Another person Ship it/ });
    const rows = screen.getAllByRole('button', { name: /Ship it/ });
    expect(rows.map((row) => row.textContent)).toEqual([expect.stringContaining('Feature decision'), expect.stringContaining('Another person')]);
    expect(rows[0]).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText('The decision is ready.')).toBeVisible();
    expect(read).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('button', { name: 'New activity · Update list' })).toBeNull();
    // A status-only refresh must not undo the stable page order or announce false activity.
    await update(paged);
    expect(screen.getAllByRole('button', { name: /Ship it/ })[0]).toHaveTextContent('Feature decision');
    expect(screen.queryByRole('button', { name: 'New activity · Update list' })).toBeNull();
  });
  it('still holds background changes until requested, and preserves the chat on a page failure', async () => {
    const { snapshot, update } = setup();
    await userEvent.click(await screen.findByRole('button', { name: /Feature decision Ship it/ }));
    await screen.findByText('The decision is ready.');
    await update({ ...snapshot, sources: snapshot.sources.map((source) => ({ ...source, hasMore: source.id === 'slack' })),
      items: [{ ...snapshot.items[0], preview: 'Updated preview' }, ...snapshot.items.slice(1)] });
    expect(screen.getByRole('button', { name: 'New activity · Update list' })).toBeVisible();
    expect(screen.getByRole('button', { name: /Feature decision Ship it/ })).toBeVisible();
    vi.mocked(window.hangar.inbox.more).mockResolvedValueOnce({ ok: false, error: 'Try again later' });
    await userEvent.click(screen.getByRole('button', { name: 'Load more from Slack · me · team' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Try again later');
    expect(screen.getByText('The decision is ready.')).toBeVisible();
  });
  it('uses Hangar-owned registration without asking the user for developer credentials', async () => {
    setup();
    await screen.findByRole('button', { name: /Feature decision Ship it/ });
    await userEvent.click(screen.getByRole('button', { name: 'Connections' }));
    expect(screen.queryByRole('textbox', { name: 'OAuth client ID' })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Reconnect' }));
    expect(window.hangar.inbox.connect).toHaveBeenCalledWith({ serviceId: 's' });
  });
  it('loads older messages once, deduplicates overlapping pages and preserves the account reference', async () => {
    const { read, snapshot } = setup();
    const ref = snapshot.items[0].ref;
    const message = { id: 'm1', author: 'Maya', at: 2000, text: 'Latest message' };
    read.mockResolvedValueOnce({ ok: true, value: { ref, title: 'Maya', messages: [message], partial: true, olderCursor: 'older' } });
    await userEvent.click(await screen.findByRole('button', { name: /Feature decision Ship it/ }));
    await screen.findByText('Latest message');
    read.mockResolvedValueOnce({ ok: true, value: { ref, title: 'Maya', messages: [{ ...message, id: 'm0', at: 1000, text: 'Earlier message' }, message], partial: true, olderCursor: null } });
    await userEvent.click(screen.getByRole('button', { name: 'Load older messages' }));
    await screen.findByText('Earlier message');
    expect(screen.getAllByText('Latest message')).toHaveLength(1);
    expect(read).toHaveBeenLastCalledWith(ref, 'older');
    expect(screen.queryByRole('button', { name: 'Load older messages' })).toBeNull();
  });
  it('removes a deleted message when refreshing the latest history window', async () => {
    const { read, snapshot } = setup();
    await userEvent.click(await screen.findByRole('button', { name: /Feature decision Ship it/ }));
    await screen.findByText('The decision is ready.');
    read.mockResolvedValueOnce({ ok: true, value: { ref: snapshot.items[0].ref, title: 'Feature', messages: [], partial: false } });
    await userEvent.click(screen.getByRole('button', { name: 'Refresh messages' }));
    await screen.findByText('No messages were returned by this connection.');
    expect(screen.queryByText('The decision is ready.')).toBeNull();
  });
  it('keeps unknown read states separate and does not request bodies for limited previews', async () => {
    const { read } = setup();
    await screen.findByRole('button', { name: /Feature decision Ship it/ });
    await userEvent.click(screen.getByRole('button', { name: 'Unread only' }));
    expect(screen.queryByRole('button', { name: /Feature decision Ship it/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Family.*Limited preview/ })).toBeNull();
    expect(read).not.toHaveBeenCalled();
    expect(screen.getByText('No matching DMs')).toBeVisible();
  });
  it('reads only the selected source and opens an opaque reference rather than a provider URL', async () => {
    setup();
    await userEvent.click(await screen.findByRole('button', { name: /Feature decision Ship it/ }));
    expect(await screen.findByText('The decision is ready.')).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: 'Reply in Slack' }));
    expect(window.hangar.inbox.open).toHaveBeenCalledWith({ connectionId: 'slack', threadId: 'dm:D123' });
    expect(screen.getByText('Reading here does not mark messages read. Replying opens the original app.')).toBeVisible();
  });
  it('discards a delayed thread when its source is revoked', async () => {
    const { read, snapshot, update } = setup();
    let finish: (r: InboxReply<InboxThread>) => void = () => {};
    read.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve as typeof finish; }));
    await userEvent.click(await screen.findByRole('button', { name: /Feature decision Ship it/ }));
    await update({ ...snapshot, sources: snapshot.sources.filter((s) => s.id !== 'slack'), items: snapshot.items.slice(1) });
    await act(async () => finish({ ok: true as const, value: { ref: snapshot.items[0]!.ref, title: 'Private', messages: [{ id: 'secret', author: 'A', at: 1000, text: 'Do not retain this revoked body' }], partial: false } }));
    expect(screen.queryByText('Do not retain this revoked body')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Reply in Slack' })).toBeNull();
  });
});
