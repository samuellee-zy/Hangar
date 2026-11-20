import { randomUUID } from 'node:crypto';
import { ConnectorBroker } from '../../connectors/broker';
import { CapabilityError, type AccountBinding, type Capability, type ConnectorAdapter, type Resource, type ResourcePage } from '../../connectors/contracts';
import type { InboxItem, InboxThread } from '@shared/inbox';
import { isRef, object, string } from '@core/inbox/policy';
import { ConnectorError, type Connection, type ConnectorPage, type ReadConnector } from './contracts';

const capability = (id: string): Capability => ({ id, version: 1 });
const listOperation = (kind: Connection['kind']) => kind === 'gmail' ? 'email.list' : 'messaging.list';
const kindOf = (c: Connection, id: string) => c.kind === 'gmail' ? 'email.thread' : id.startsWith('dm:') ? 'messaging.conversation' : 'messaging.thread';
const capabilities = (c: Connection, reader: ReadConnector): Capability[] => [...(!reader.canSearch || reader.canSearch(c) ? [capability('search.query')] : []), capability('resources.read'),
  ...(!reader.canChat || reader.canChat(c) ? [capability(listOperation(c.kind))] : [])];

/** Desktop compatibility host. Credentials/signals stay here; only normalized resources cross the portable broker. */
export class ReaderModules {
  private readonly broker: ConnectorBroker;
  private readonly requests = new Map<string, { connection: Connection; signal: AbortSignal }>();
  private readonly generations = new Map<string, number>();
  constructor(private readonly readers: Record<Connection['kind'], ReadConnector>, resolve: (id: string) => Connection | undefined) {
    this.broker = new ConnectorBroker((id): AccountBinding | undefined => {
      const c = resolve(id);
      return c ? { accountId: c.id, provider: c.kind, adapterId: `${c.kind}.api`, executorId: 'local-desktop', target: 'desktop',
        available: true, generation: this.generations.get(id) ?? 0, capabilities: capabilities(c, this.readers[c.kind]) } : undefined;
    }, Date.now);
    for (const kind of ['slack', 'gmail'] as const) this.broker.register(this.adapter(kind));
  }
  invalidate(id: string): void { this.generations.set(id, (this.generations.get(id) ?? 0) + 1); }
  private adapter(kind: Connection['kind']): ConnectorAdapter {
    return {
      manifest: { id: `${kind}.api`, provider: kind, version: '1.0.0', protocolVersion: 1,
        capabilities: [capability('search.query'), capability('resources.read'), capability(listOperation(kind))],
        authentication: ['oauth-pkce'], executionTargets: ['desktop'] },
      execute: async (binding, request, cancellation) => {
        const context = this.requests.get(request.requestId);
        if (!context || context.connection.id !== binding.accountId) throw new ConnectorError('The desktop request has expired.');
        cancellation.throwIfCancelled();
        const { connection: c, signal } = context, reader = this.readers[kind], input = object(request.input);
        if (request.capability.id === 'resources.read') {
          if (!isRef(input.ref) || input.ref.connectionId !== c.id) throw new ConnectorError('Invalid account resource reference.');
          if (input.cursor !== undefined && (typeof input.cursor !== 'string' || input.cursor.length > 1000)) throw new ConnectorError('Invalid history cursor.');
          const thread = await reader.read(c, input.ref, signal, string(input.cursor, 1000) || undefined);
          if (thread.ref.connectionId !== c.id || thread.ref.threadId !== input.ref.threadId) throw new ConnectorError('The source returned a different account or resource.');
          return { ref: { accountId: c.id, kind: kindOf(c, input.ref.threadId), id: input.ref.threadId }, revision: null, updatedAt: null,
            coverage: { extent: thread.partial ? 'partial' : 'unknown', detail: thread.historyDetail ?? 'Provider retention and membership apply.' }, payload: thread } satisfies Resource<InboxThread>;
        }
        let page: ConnectorPage;
        if (request.capability.id === 'search.query') {
          if (typeof input.query !== 'string' || !input.query.trim() || input.query.length > 1000) throw new ConnectorError('Invalid search terms.');
          page = await reader.search(c, input.query, signal);
        } else {
          if (input.cursor !== undefined && (typeof input.cursor !== 'string' || input.cursor.length > 1000)) throw new ConnectorError('Invalid page cursor.');
          page = await reader.list(c, signal, string(input.cursor, 1000) || undefined);
        }
        const coverage = { extent: 'partial' as const, detail: page.detail };
        if (page.items.some((item) => item.ref.connectionId !== c.id)) throw new ConnectorError('The source returned content outside this account.');
        return { items: page.items.map((item) => ({ ref: { accountId: c.id, kind: kindOf(c, item.ref.threadId), id: item.ref.threadId },
          revision: null, updatedAt: item.at, coverage, payload: item })), cursor: page.cursor, coverage } satisfies ResourcePage<InboxItem>;
      },
    };
  }
  private async execute(c: Connection, operation: string, input: unknown, signal: AbortSignal, allowed: ReadonlySet<string>) {
    const requestId = randomUUID(), cap = capability(operation);
    const deadlineSignal = AbortSignal.any([signal, AbortSignal.timeout(180_000)]);
    this.requests.set(requestId, { connection: c, signal: deadlineSignal });
    try {
      return await this.broker.execute({ protocolVersion: 1, requestId, accountId: c.id, capability: cap, deadline: Date.now() + 180_000, input },
        { accountIds: [...allowed], capabilities: [cap] }, { throwIfCancelled: () => deadlineSignal.throwIfAborted() });
    } catch (error) {
      if (error instanceof CapabilityError) throw new ConnectorError(error.message);
      throw error;
    } finally { this.requests.delete(requestId); }
  }
  async list(c: Connection, signal: AbortSignal, cursor?: string): Promise<ConnectorPage> {
    if (this.readers[c.kind].canChat && !this.readers[c.kind].canChat!(c)) {
      return { items: [], cursor: null, detail: 'Reconnect to grant DM listing and history access. Search remains available.' };
    }
    const page = await this.execute(c, listOperation(c.kind), cursor ? { cursor } : {}, signal, new Set([c.id])) as ResourcePage<InboxItem>;
    return { items: page.items.map((item) => item.payload), cursor: page.cursor, detail: page.coverage.detail };
  }
  async search(c: Connection, query: string, signal: AbortSignal, allowed: ReadonlySet<string>): Promise<ConnectorPage> {
    const page = await this.execute(c, 'search.query', { query }, signal, allowed) as ResourcePage<InboxItem>;
    return { items: page.items.map((item) => item.payload), cursor: page.cursor, detail: page.coverage.detail };
  }
  async read(c: Connection, ref: InboxThread['ref'], signal: AbortSignal, allowed: ReadonlySet<string>, cursor?: string): Promise<InboxThread> {
    const resource = await this.execute(c, 'resources.read', { ref, ...(cursor ? { cursor } : {}) }, signal, allowed) as Resource<InboxThread>;
    return resource.payload;
  }
}
