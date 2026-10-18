import { describe, it, expect, vi } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Assistant } from '../../src/renderer/ai/Assistant';
import { setShellState } from './setup';
import type { ShellState } from '@shared/types';
import type { AiSnapshot } from '@shared/ai';

function setup() {
  setShellState({ aiOpen: true, activeWorkspaceId: 'w', preferences: { appearance: { aiPanelWidth: 420 } } } as ShellState);
  let snapshot: AiSnapshot = { providers: [{ id: 'codex', name: 'Codex', state: 'ready', detail: 'Signed in' }],
    sources: [{ id: 'work', serviceId: 's', kind: 'slack', app: 'Slack', label: 'Work', identity: 'me · team', state: 'ready', detail: '', updatedAt: 1, canRead: true, canSearch: true, hasMore: false },
      { id: 'personal', serviceId: 'p', kind: 'page', app: 'Messenger', label: 'Personal', identity: null, state: 'limited', detail: '', updatedAt: null, canRead: false, canSearch: false, hasMore: false }],
    workspaceId: 'w', workspaceName: 'Work', allWorkspaces: false, context: null, run: null };
  let changed = () => {};
  const ok = async () => ({ ok: true as const, value: null });
  window.hangar.ai = { snapshot: vi.fn(async () => ({ ok: true as const, value: snapshot })), scope: vi.fn(ok), probe: vi.fn(ok), login: vi.fn(ok), logout: vi.fn(ok),
    start: vi.fn(ok), cancel: vi.fn(ok), clear: vi.fn(ok), openCitation: vi.fn(ok), onChanged: (fn) => { changed = fn; return () => {}; } };
  render(<Assistant />);
  return { snapshot, update: async (value: AiSnapshot) => { snapshot = value; await act(async () => changed()); } };
}
describe('assistant scope and citations', () => {
  it('requires an explicit search click with selected readable accounts and discloses the provider', async () => {
    setup();
    expect(await screen.findByRole('checkbox', { name: /Slack/ })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: /Messenger/ })).toBeDisabled();
    expect(window.hangar.ai.start).not.toHaveBeenCalled();
    await userEvent.type(screen.getByLabelText('Your question'), 'What did we decide?');
    expect(screen.getByText(/Searching shares your question.*with Codex/)).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: 'Search with Codex' }));
    expect(window.hangar.ai.start).toHaveBeenCalledWith({ provider: 'codex', query: 'What did we decide?', sourceIds: ['work'], allWorkspaces: false, includeContext: true, consent: true });
  });
  it('opens only broker-backed citations and removes content when the account is revoked', async () => {
    const f = setup();
    await f.update({ ...f.snapshot, run: { id: 'run', provider: 'codex', query: 'What did we decide?', state: 'complete', answer: 'Monday. [S1] Fake [S99] <script>alert(1)</script>', progress: [], error: null,
      evidence: [{ id: 'S1', ref: { connectionId: 'work', threadId: 'C1:1.1' }, title: 'Feature', source: 'Slack · me', author: 'Maya', at: 1, retrievedAt: 1, preview: 'Monday', read: true }] } });
    await userEvent.click(await screen.findByRole('button', { name: 'Open source S1: Feature' }));
    expect(window.hangar.ai.openCitation).toHaveBeenCalledWith('S1');
    expect(document.querySelector('script')).toBeNull();
    expect(screen.queryByRole('button', { name: /S99/ })).toBeNull();
    await f.update({ ...f.snapshot, sources: [], run: null });
    expect(screen.queryByText(/Monday/)).toBeNull();
    expect(screen.getByRole('button', { name: 'Search with Codex' })).toBeDisabled();
  });
});
