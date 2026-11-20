import { describe, expect, it, vi } from 'vitest';
import { ConnectorBroker, isWireValue } from '../../src/connectors/broker';
import type { AccountBinding, ConnectorAdapter, ConnectorRequest, Resource } from '../../src/connectors/contracts';
import { ReaderModules } from '@main/connectors/modules';
import type { Connection, ReadConnector } from '@main/connectors/contracts';

const cap = { id: 'documents.read', version: 1 };
const request: ConnectorRequest = { protocolVersion: 1, requestId: 'r1', accountId: 'docs-work', capability: cap, deadline: 2000, input: { id: 'design-1' } };
const grant = { accountIds: ['docs-work'], capabilities: [cap] };
const cancellation = { throwIfCancelled() {} };
function fixture() {
  let binding: AccountBinding | undefined = { accountId: 'docs-work', provider: 'fixture-docs', adapterId: 'fixture-docs.local',
    executorId: 'desktop-a', target: 'desktop', available: true, generation: 1, capabilities: [cap] };
  const document: Resource<{ title: string; body: string; revisionAuthor: string }> = { ref: { accountId: 'docs-work', kind: 'documents.document', id: 'design-1' },
    revision: 'v2', updatedAt: 1000, coverage: { extent: 'complete', detail: 'Synthetic contract fixture' },
    payload: { title: 'Feature design', body: 'Keyboard navigation is required.', revisionAuthor: 'Maya' } };
  const adapter: ConnectorAdapter = { manifest: { id: 'fixture-docs.local', provider: 'fixture-docs', version: '1.0.0', protocolVersion: 1,
    capabilities: [cap], authentication: ['oauth-pkce'], executionTargets: ['desktop'] }, execute: vi.fn(async () => document) };
  const broker = new ConnectorBroker(() => binding, () => 1000);
  broker.register(adapter);
  return { broker, adapter, document, setBinding: (next: AccountBinding | undefined) => { binding = next; }, binding: binding! };
}
describe('portable capability broker', () => {
  it('reads and cites a document without any messaging contract or broker change', async () => {
    const { broker, document } = fixture();
    const result = await broker.execute(request, grant, cancellation);
    expect(result).toEqual(document);
    expect(JSON.parse(JSON.stringify(result)).ref).toEqual({ accountId: 'docs-work', kind: 'documents.document', id: 'design-1' });
  });
  it('denies other accounts, undeclared operations and unsupported capability versions before execution', async () => {
    const { broker, adapter } = fixture();
    await expect(broker.execute(request, { ...grant, accountIds: ['personal'] }, cancellation)).rejects.toMatchObject({ code: 'outside-scope' });
    await expect(broker.execute(request, { ...grant, capabilities: [] }, cancellation)).rejects.toMatchObject({ code: 'outside-scope' });
    const unimplemented = { id: 'messages.send', version: 1 };
    await expect(broker.execute({ ...request, capability: unimplemented }, { ...grant, capabilities: [unimplemented] }, cancellation)).rejects.toMatchObject({ code: 'unsupported' });
    const newer = { ...cap, version: 2 };
    await expect(broker.execute({ ...request, capability: newer }, { ...grant, capabilities: [newer] }, cancellation)).rejects.toMatchObject({ code: 'unsupported' });
    expect(adapter.execute).not.toHaveBeenCalled();
  });
  it('does not infer mobile execution support from shared contracts', async () => {
    const { broker, setBinding, binding } = fixture();
    setBinding({ ...binding, target: 'ios' });
    await expect(broker.execute(request, grant, cancellation)).rejects.toMatchObject({ code: 'unsupported' });
  });
  it('drops a delayed response after account revocation or executor changes', async () => {
    for (const revoke of [true, false]) {
      const { broker, adapter, setBinding, binding, document } = fixture();
      let finish: (value: unknown) => void = () => {};
      vi.mocked(adapter.execute).mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
      const pending = broker.execute(request, grant, cancellation);
      setBinding(revoke ? undefined : { ...binding, executorId: 'desktop-b', generation: 2 });
      finish(document);
      await expect(pending).rejects.toMatchObject({ code: 'unavailable' });
    }
  });
  it('checks deadlines, cancellation and bounded wire values on both sides', async () => {
    const { broker, adapter } = fixture();
    await expect(broker.execute({ ...request, deadline: 900 }, grant, cancellation)).rejects.toMatchObject({ code: 'expired' });
    await expect(broker.execute(request, grant, { throwIfCancelled() { throw new Error('cancelled'); } })).rejects.toThrow('cancelled');
    await expect(broker.execute({ ...request, input: { callback() {} } }, grant, cancellation)).rejects.toMatchObject({ code: 'invalid-request' });
    vi.mocked(adapter.execute).mockResolvedValue(new Date());
    await expect(broker.execute(request, grant, cancellation)).rejects.toMatchObject({ code: 'invalid-response' });
    const cyclic: { self?: unknown } = {}; cyclic.self = cyclic;
    for (const invalid of [cyclic, Infinity, undefined, new Uint8Array(2), { body: 'x'.repeat(2_000_001) }]) expect(isWireValue(invalid)).toBe(false);
  });
});

describe('desktop module host', () => {
  const connection: Connection = { id: 'gmail-work', kind: 'gmail', serviceId: 'g', identity: 'work@example.test', remoteId: 'work', userId: 'me', clientId: 'client', accessToken: 'secret', refreshToken: '', expiresAt: 0 };
  it('migrates Gmail list/search/read without granting chat or exposing a credential in the wire result', async () => {
    const ref = { connectionId: connection.id, threadId: 'abc123' };
    const item = { id: 'a', ref, title: 'Design', preview: 'Preview', author: 'Maya', at: 1, unread: false, mention: false, category: 'email' as const };
    const reader: ReadConnector = { list: vi.fn(async () => ({ items: [item], cursor: 'next', detail: 'Partial inbox' })),
      search: vi.fn(async () => ({ items: [item], cursor: null, detail: 'Search' })),
      read: vi.fn(async () => ({ ref, title: 'Design', messages: [{ id: 'm', author: 'Maya', at: 1, text: 'Body' }], partial: false })), sourceUrl: () => 'https://mail.google.com/' };
    const modules = new ReaderModules({ gmail: reader, slack: reader }, () => connection);
    const signal = new AbortController().signal;
    expect((await modules.list(connection, signal)).items[0].category).toBe('email');
    expect((await modules.search(connection, 'design', signal, new Set([connection.id]))).items).toEqual([item]);
    const result = await modules.read(connection, ref, signal, new Set([connection.id]));
    expect(JSON.stringify(result)).not.toContain('secret');
    expect(result.messages[0].text).toBe('Body');
    await expect(modules.read(connection, ref, signal, new Set(['personal']))).rejects.toThrow('scope');
    vi.mocked(reader.read).mockResolvedValue({ ref: { ...ref, connectionId: 'personal' }, title: 'Wrong account', messages: [], partial: false });
    await expect(modules.read(connection, ref, signal, new Set([connection.id]))).rejects.toThrow('different account');
  });
});
