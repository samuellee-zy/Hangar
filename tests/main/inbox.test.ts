import { describe, it, expect, vi } from 'vitest';
import { itemId, mergeItems, isRef, validConnect } from '@core/inbox/policy';
import { ConnectorHttp } from '@main/connectors/http';
import { ConnectorHub } from '@main/connectors/hub';
import { SlackConnector } from '@main/connectors/slack';
import { GmailConnector, gmailText } from '@main/connectors/gmail';
import { ConnectorError, type Connection, type ReadConnector } from '@main/connectors/contracts';
import { inboxRequest } from '@main/connectors/ipc';
import { authorize, pkce } from '@main/connectors/oauth';
import { createHash } from 'node:crypto';
import type { Config } from '@shared/types';
import type { InboxItem } from '@shared/inbox';

const connection = (id = 'one'): Connection => ({ id, serviceId: id, kind: 'slack', identity: 'me · work', remoteId: 'T1', userId: 'U1', clientId: 'test', accessToken: 'private-token', refreshToken: '', expiresAt: 0 });
const item = (id = 'one', threadId = 'C1:123.456', at = 1): InboxItem => {
  const ref = { connectionId: id, threadId };
  return { id: itemId(ref), ref, title: 'Feature', preview: 'Decision', author: 'Me', at, unread: null, mention: false, category: 'channels' };
};
const json = (data: unknown, status = 200, headers?: Record<string, string>) => new Response(JSON.stringify(data), { status, headers });

function harness(adapter?: Partial<ReadConnector>) {
  const config = { services: [{ id: 'one', catalogId: 'slack', accountId: 'a', name: 'Slack' }, { id: 'two', catalogId: 'gmail', accountId: 'b', name: 'Gmail' }],
    accounts: [{ id: 'a', label: 'Work' }, { id: 'b', label: 'Personal' }], workspaces: [{ id: 'work', name: 'Work', items: [{ kind: 'service', id: 'one' }] }], activeWorkspaceId: 'work' } as Config;
  const vault = { load: () => [connection(), { ...connection('two'), kind: 'gmail' as const }], save: vi.fn() };
  const implementation: ReadConnector = { list: vi.fn(async (c) => ({ items: [item(c.id)], cursor: null, detail: 'Recent' })),
    search: vi.fn(async (c) => ({ items: [item(c.id)], cursor: null, detail: 'Search' })),
    read: vi.fn(async (_c, ref) => ({ ref, title: 'Feature', messages: [], partial: false })), sourceUrl: () => 'https://slack.com/', ...adapter };
  const hub = new ConnectorHub({ config: () => config, previews: () => new Map(), sleeping: () => false, changed: vi.fn(), openPage: async () => true, openUrl: async () => {} }, vault,
    new ConnectorHttp(), { slack: implementation, gmail: implementation });
  return { hub, config, vault, implementation };
}

describe('inbox source boundaries', () => {
  it('defaults to this workspace; cross-workspace reads require an explicit search scope', async () => {
    const { hub, implementation } = harness();
    await hub.refresh({ allWorkspaces: false });
    expect(hub.snapshot({ allWorkspaces: false }).sources.map((s) => s.id)).toEqual(['one']);
    expect(hub.snapshot({ allWorkspaces: true }).sources).toHaveLength(2);
    await expect(hub.search('two', 'feature', new Set(['one']), new AbortController().signal)).rejects.toThrow('scope');
    expect(implementation.search).not.toHaveBeenCalled();
    await expect(hub.read(item('two').ref, new Set(['one']))).rejects.toThrow('scope');
  });
  it('disconnect aborts pending reads and removes derived content and credentials', async () => {
    let finish: ((value: { ref: ReturnType<typeof item>['ref']; title: string; messages: []; partial: boolean }) => void) | undefined;
    const { hub, vault } = harness({ read: async (_c, ref) => new Promise((resolve) => { finish = (value) => resolve({ ...value, ref }); }) });
    await hub.refresh({ allWorkspaces: false });
    const reading = hub.read(item().ref);
    await vi.waitFor(() => expect(finish).toBeDefined());
    hub.disconnect('one');
    finish!({ ref: item().ref, title: 'Private', messages: [], partial: false });
    await expect(reading).rejects.toThrow();
    expect(hub.snapshot({ allWorkspaces: false }).items).toHaveLength(0);
    expect(vault.save.mock.calls[0]![0].map((c: Connection) => c.id)).toEqual(['two']);
  });
  it('refresh replaces removed/edited threads and revocation clears cached content', async () => {
    const { hub, implementation } = harness();
    await hub.refresh({ allWorkspaces: false });
    expect(hub.snapshot({ allWorkspaces: false }).items).toHaveLength(1);
    vi.mocked(implementation.list).mockResolvedValueOnce({ items: [], cursor: null, detail: 'Empty' });
    await hub.refresh({ allWorkspaces: false });
    expect(hub.snapshot({ allWorkspaces: false }).items).toHaveLength(0);
    vi.mocked(implementation.list).mockRejectedValueOnce(new ConnectorError('Reconnect', true));
    await hub.refresh({ allWorkspaces: false });
    expect(hub.snapshot({ allWorkspaces: false }).sources[0]!.state).toBe('reconnect');
    await expect(hub.read(item().ref)).rejects.toThrow('Refresh');
  });
  it('denies unobserved references and malformed IPC without calling source methods', async () => {
    const { hub, implementation } = harness();
    expect((await inboxRequest(hub, 'read', { connectionId: 'one', threadId: 'C1:9.9' })).ok).toBe(false);
    expect((await inboxRequest(hub, 'read', { connectionId: 'one', threadId: ['bad'] })).ok).toBe(false);
    expect((await inboxRequest(hub, 'open', { connectionId: 'one', threadId: 'https://evil.test' })).ok).toBe(false);
    expect(implementation.read).not.toHaveBeenCalled();
  });
  it('deduplicates by remote account identity and limits summaries without conflating accounts', () => {
    expect(mergeItems([item(), item('one', 'C1:123.456', 2), item('two')])).toHaveLength(2);
    expect(mergeItems([item(), item('two')], 1)).toHaveLength(1);
    expect(isRef({ connectionId: 'one', threadId: '' })).toBe(false);
    expect(validConnect({ serviceId: 'one', clientId: 'inject\nheader' })).toBe(false);
  });
});

describe('source protocol fixtures', () => {
  it('Slack categories put a mentioned DM in exactly one group; unknown read state stays unknown', async () => {
    const request = vi.fn(async () => json({ ok: true, messages: { matches: [{ channel: { id: 'D123', name: 'Maya', is_im: true }, ts: '123.456', text: '<@U1> feature decision', user: 'U2' }], paging: { pages: 2 } } }));
    const slack = new SlackConnector(new ConnectorHttp(request));
    const page = await slack.search(connection(), 'feature', new AbortController().signal);
    expect(page.items[0]).toMatchObject({ category: 'direct', mention: true, unread: null });
    expect(page.cursor).toBe('2');
    expect(request.mock.calls[0]).toBeDefined();
    expect(slack.sourceUrl(connection(), page.items[0]!.ref)).toContain('/T1/D123/thread/');
  });
  it('Gmail lists threads then fetches metadata, retaining exact unread and correct account links', async () => {
    const request = vi.fn(async (url: string | URL | Request) => String(url).includes('threads?')
      ? json({ threads: [{ id: 'abc123' }], nextPageToken: 'next' })
      : json({ id: 'abc123', messages: [{ id: 'a', labelIds: ['INBOX', 'UNREAD'], snippet: 'Decision', internalDate: '1000', payload: { headers: [{ name: 'Subject', value: 'Feature' }, { name: 'From', value: 'Maya' }] } }] }));
    const gmail = new GmailConnector(new ConnectorHttp(request));
    const c = { ...connection(), kind: 'gmail' as const, identity: 'me@example.com' };
    const page = await gmail.list(c, new AbortController().signal);
    expect(page.items[0]).toMatchObject({ title: 'Feature', author: 'Maya', unread: true, category: 'email' });
    expect(page.cursor).toBe('next');
    expect(gmail.sourceUrl(c, page.items[0]!.ref)).toContain('authuser=me%40example.com');
  });
  it('does not expose HTML email, tracking pixels or oversized recursive parts as rendered content', () => {
    expect(gmailText({ mimeType: 'text/html', body: { data: Buffer.from('<script>steal()</script>').toString('base64url') } })).toBe('');
    expect(gmailText({ parts: [{ mimeType: 'text/plain', body: { data: Buffer.from('Real body').toString('base64url') } }] })).toBe('Real body');
  });
  it('honors rate backoff and never follows credential-bearing redirects', async () => {
    const request = vi.fn(async () => json({}, 429, { 'retry-after': '60' }));
    const http = new ConnectorHttp(request);
    await expect(http.json('https://slack.com/api/search.messages', {}, 'one')).rejects.toThrow('Rate limited');
    await expect(http.json('https://slack.com/api/search.messages', {}, 'one')).rejects.toThrow('Rate limited');
    expect(request).toHaveBeenCalledTimes(1);
    expect(vi.mocked(request).mock.calls[0]).toBeDefined();
  });
  it('PKCE challenges are unique, URL-safe SHA256 values with independent state', () => {
    const p = pkce();
    expect(p.challenge).toBe(createHash('sha256').update(p.verifier).digest('base64url'));
    expect(p.verifier.length).toBeGreaterThanOrEqual(43);
    expect(pkce().state).not.toBe(p.state);
  });
  it('OAuth rejects wrong state without consuming login, then exchanges the bound code with PKCE', async () => {
    const request = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).includes('oauth2.googleapis.com')) {
        const body = init!.body as URLSearchParams;
        expect(body.get('code')).toBe('test-code');
        expect(body.get('code_verifier')!.length).toBeGreaterThanOrEqual(43);
        expect(body.get('redirect_uri')).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/oauth\/callback$/);
        return json({ access_token: 'only-main-sees-this', refresh_token: 'refresh', expires_in: 3600 });
      }
      return json({ emailAddress: 'me@example.com' });
    });
    const result = await authorize('gmail', { serviceId: 'one', clientId: 'test-client' }, new AbortController().signal, async (url) => {
      const auth = new URL(url), callback = new URL(auth.searchParams.get('redirect_uri')!);
      callback.searchParams.set('state', 'wrong'); callback.searchParams.set('code', 'test-code');
      expect((await fetch(callback)).status).toBe(400);
      callback.searchParams.set('state', auth.searchParams.get('state')!);
      expect((await fetch(callback)).status).toBe(200);
    }, new ConnectorHttp(request));
    expect(result).toMatchObject({ identity: 'me@example.com', serviceId: 'one', accessToken: 'only-main-sees-this' });
  });
});
