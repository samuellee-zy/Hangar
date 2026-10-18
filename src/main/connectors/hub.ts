import { itemId, mergeItems } from '@core/inbox/policy';
import { flattenServiceIds } from '@core/workspace/folders';
import { catalogById } from '@shared/catalog';
import type { Config, Conversation } from '@shared/types';
import type { InboxConnect, InboxItem, InboxQuery, InboxSnapshot, InboxSource, InboxThread, SourceRef } from '@shared/inbox';
import { ConnectorError, type Connection, type ReadConnector } from './contracts';
import { ConnectorHttp } from './http';
import { SlackConnector } from './slack';
import { GmailConnector } from './gmail';
import { authorize, refreshToken } from './oauth';

interface Vault { load(): Connection[]; save(connections: Connection[]): void }
interface Host {
  config(): Config;
  previews(): ReadonlyMap<string, Conversation[]>;
  sleeping(serviceId: string): boolean;
  changed(): void;
  openPage(serviceId: string, conversationId: string): Promise<boolean>;
  openUrl(url: string): Promise<void>;
}
interface Cache { items: InboxItem[]; cursor: string | null; at: number; detail: string }

/** Account-scoped read broker shared by inbox and AI. No credentials or arbitrary URL tools escape. */
export class ConnectorHub {
  private connections: Connection[] | null = null;
  private caches = new Map<string, Cache>();
  private errors = new Map<string, ConnectorError>();
  private controllers = new Map<string, AbortController>();
  private refreshing = new Set<string>();
  private tokenRefreshes = new Map<string, Promise<Connection>>();
  private known = new Map<string, InboxItem>();
  private login: AbortController | null = null;
  private disposed = false;
  private readonly adapters: Record<Connection['kind'], ReadConnector>;
  constructor(private readonly host: Host, private readonly vault: Vault, private readonly http = new ConnectorHttp(), adapters?: Record<Connection['kind'], ReadConnector>) {
    this.adapters = adapters ?? { slack: new SlackConnector(http), gmail: new GmailConnector(http) };
  }
  private load(): Connection[] { return this.connections ??= this.vault.load(); }
  private allowedServices(query: InboxQuery): Set<string> {
    const c = this.host.config();
    const workspace = c.workspaces.find((w) => w.id === c.activeWorkspaceId);
    return new Set(query.allWorkspaces ? c.services.map((s) => s.id) : workspace ? flattenServiceIds(workspace) : []);
  }
  private remember(items: InboxItem[]): void {
    for (const item of items) this.known.set(item.id, item);
    while (this.known.size > 1500) this.known.delete(this.known.keys().next().value!);
  }
  snapshot(query: InboxQuery): InboxSnapshot {
    const c = this.host.config(), allowed = this.allowedServices(query), connections = this.load();
    const sources: InboxSource[] = [], items: InboxItem[] = [];
    for (const service of c.services.filter((s) => allowed.has(s.id))) {
      const connection = connections.find((a) => a.serviceId === service.id);
      const entry = catalogById(service.catalogId), label = c.accounts.find((a) => a.id === service.accountId)?.label ?? service.name;
      if (connection) {
        const cache = this.caches.get(connection.id), error = this.errors.get(connection.id);
        sources.push({ id: connection.id, serviceId: service.id, kind: connection.kind, app: entry?.name ?? service.name, label,
          identity: connection.identity, state: this.refreshing.has(connection.id) ? 'refreshing' : error ? error.reconnect ? 'reconnect' : 'error' : 'ready',
          detail: error?.message ?? cache?.detail ?? 'Ready to load recent conversations.', updatedAt: cache?.at ?? null,
          canSearch: !error?.reconnect, canRead: !error?.reconnect, hasMore: Boolean(cache?.cursor) });
        items.push(...(cache?.items ?? []));
      } else {
        const id = `page:${service.id}`, sleeping = this.host.sleeping(service.id);
        const canConnect = service.catalogId === 'gmail' || service.catalogId === 'slack';
        sources.push({ id, serviceId: service.id, kind: 'page', app: entry?.name ?? service.name, label, identity: null,
          state: sleeping ? 'sleeping' : canConnect ? 'connect' : 'limited', updatedAt: null,
          detail: canConnect ? 'Connect read access for threads and search. Page previews contain only rendered unread names.'
            : 'Limited page preview: only currently rendered unread names. No message bodies or historical search.',
          canRead: false, canSearch: false, hasMore: false });
        if (!sleeping) for (const preview of this.host.previews().get(service.id) ?? []) {
          const ref = { connectionId: id, threadId: preview.id };
          items.push({ id: itemId(ref), ref, title: preview.name, author: '', preview: 'Limited preview · open the app to read this conversation', at: null,
            unread: true, mention: preview.mention, category: preview.mention ? 'mentions' : 'other' });
        }
      }
    }
    this.remember(items);
    return { sources, items: mergeItems(items), workspaceId: query.allWorkspaces ? null : c.activeWorkspaceId,
      workspaceName: query.allWorkspaces ? 'All workspaces' : c.workspaces.find((w) => w.id === c.activeWorkspaceId)?.name ?? 'Workspace' };
  }
  private connection(id: string): Connection {
    const c = this.load().find((a) => a.id === id);
    if (this.disposed || !c || !this.host.config().services.some((s) => s.id === c.serviceId)) throw new ConnectorError('This account is no longer connected.');
    return c;
  }
  private signal(id: string, outer?: AbortSignal): AbortSignal {
    if (!this.controllers.has(id)) this.controllers.set(id, new AbortController());
    return AbortSignal.any([this.controllers.get(id)!.signal, ...(outer ? [outer] : [])]);
  }
  private async token(id: string, signal: AbortSignal): Promise<Connection> {
    const current = this.connection(id);
    if (!this.tokenRefreshes.has(id)) {
      const promise = refreshToken(current, signal, this.http).then((next) => {
        signal.throwIfAborted();
        this.connection(id);
        if (next !== current) {
          const connections = this.load().map((c) => c.id === id ? next : c);
          this.vault.save(connections);
          this.connections = connections;
        }
        return next;
      }).finally(() => this.tokenRefreshes.delete(id));
      this.tokenRefreshes.set(id, promise);
    }
    return this.tokenRefreshes.get(id)!;
  }
  async refresh(query: InboxQuery): Promise<void> {
    const allowed = this.allowedServices(query);
    await Promise.allSettled(this.load().filter((c) => allowed.has(c.serviceId)).map((c) => this.page(c.id, false)));
  }
  more(id: string): Promise<void> { return this.page(id, true); }
  private async page(id: string, more: boolean): Promise<void> {
    if (this.refreshing.has(id)) return;
    const previous = this.caches.get(id);
    if (more && !previous?.cursor) return;
    this.connection(id);
    this.refreshing.add(id);
    this.host.changed();
    const signal = this.signal(id);
    try {
      const c = await this.token(id, signal);
      const page = await this.adapters[c.kind].list(c, signal, more ? previous?.cursor ?? undefined : undefined);
      signal.throwIfAborted();
      this.connection(id);
      const items = mergeItems([...(more ? previous?.items ?? [] : []), ...page.items], 200);
      this.caches.set(id, { items, cursor: items.length < 200 ? page.cursor : null, detail: page.detail, at: Date.now() });
      this.errors.delete(id);
      this.remember(items);
    } catch (e) {
      if (!signal.aborted) {
        const error = e instanceof ConnectorError ? e : new ConnectorError('Unable to reach this source. Please try again.');
        this.errors.set(id, error);
        if (error.reconnect) this.clearContent(id);
      }
    } finally {
      this.refreshing.delete(id);
      if (!this.disposed) this.host.changed();
    }
  }
  /** The caller supplies an allowlist fixed by main at run start, never from model arguments. */
  async search(id: string, query: string, allowed: ReadonlySet<string>, outer: AbortSignal): Promise<InboxItem[]> {
    if (!allowed.has(id)) throw new ConnectorError('This account is outside the search scope.');
    if (!query.trim() || query.length > 1000) throw new ConnectorError('Search terms must be between 1 and 1,000 characters.');
    const signal = this.signal(id, outer);
    try {
      const c = await this.token(id, signal);
      const page = await this.adapters[c.kind].search(c, query, signal);
      signal.throwIfAborted(); this.connection(id); this.remember(page.items);
      return page.items;
    } catch (error) { this.recordFailure(id, error, signal); throw error; }
  }
  private recordFailure(id: string, error: unknown, signal: AbortSignal): void {
    if (!signal.aborted && error instanceof ConnectorError) {
      this.errors.set(id, error);
      if (error.reconnect) { this.clearContent(id); this.controllers.get(id)?.abort(); this.controllers.delete(id); }
      this.host.changed();
    }
  }
  async read(ref: SourceRef, allowed?: ReadonlySet<string>, outer?: AbortSignal): Promise<InboxThread> {
    if (allowed && !allowed.has(ref.connectionId)) throw new ConnectorError('This account is outside the search scope.');
    if (!this.known.has(itemId(ref))) throw new ConnectorError('Refresh the conversation list before opening this thread.');
    const signal = this.signal(ref.connectionId, outer);
    try {
      const c = await this.token(ref.connectionId, signal);
      const thread = await this.adapters[c.kind].read(c, ref, signal);
      signal.throwIfAborted(); this.connection(c.id);
      return thread;
    } catch (error) { this.recordFailure(ref.connectionId, error, signal); throw error; }
  }
  async open(ref: SourceRef): Promise<void> {
    if (!this.known.has(itemId(ref))) throw new ConnectorError('Refresh the list to open this conversation.');
    if (ref.connectionId.startsWith('page:')) {
      const serviceId = ref.connectionId.slice(5);
      if (!this.host.config().services.some((s) => s.id === serviceId)) throw new ConnectorError('This app was removed.');
      if (!await this.host.openPage(serviceId, ref.threadId)) throw new ConnectorError('The app is open, but that row is no longer visible.');
    } else {
      const c = this.connection(ref.connectionId);
      await this.host.openUrl(this.adapters[c.kind].sourceUrl(c, ref));
    }
  }
  async connect(input: InboxConnect): Promise<void> {
    if (this.login) throw new ConnectorError('Finish or cancel the current sign-in first.');
    const service = this.host.config().services.find((s) => s.id === input.serviceId);
    if (!service || (service.catalogId !== 'slack' && service.catalogId !== 'gmail')) throw new ConnectorError('This app does not have a read connector.');
    // Check storage before opening a browser. A corrupt/locked vault is never overwritten.
    this.vault.save(this.load());
    const controller = new AbortController();
    this.login = controller;
    try {
      const next = await authorize(service.catalogId, input, controller.signal, this.host.openUrl, this.http);
      controller.signal.throwIfAborted();
      if (!this.host.config().services.some((s) => s.id === input.serviceId)) throw new ConnectorError('This app was removed during sign-in.');
      if (this.load().some((c) => c.serviceId !== input.serviceId && c.kind === next.kind && c.remoteId === next.remoteId && c.userId === next.userId)) {
        throw new ConnectorError('This remote account already has a read connection in Hangar. Use its existing inbox connection.');
      }
      const previous = this.load().filter((c) => c.serviceId === input.serviceId);
      const connections = [...this.load().filter((c) => c.serviceId !== input.serviceId), next];
      this.vault.save(connections);
      this.connections = connections;
      for (const c of previous) { this.controllers.get(c.id)?.abort(); this.clearContent(c.id); }
      this.host.changed();
      await this.page(next.id, false);
    } finally { this.login = null; }
  }
  cancelConnect(): void { this.login?.abort(); }
  private clearContent(id: string): void {
    this.caches.delete(id);
    for (const [key, item] of this.known) if (item.ref.connectionId === id) this.known.delete(key);
  }
  disconnect(id: string): void {
    this.connection(id);
    const connections = this.load().filter((c) => c.id !== id);
    this.vault.save(connections);
    this.connections = connections;
    this.controllers.get(id)?.abort();
    this.controllers.delete(id);
    this.errors.delete(id);
    this.clearContent(id);
    this.host.changed();
  }
  /** Called when config changes, including service removal/sign-out and workspace imports. */
  reconcile(): void {
    if (!this.connections) return;
    const ids = new Set(this.host.config().services.map((s) => s.id));
    const kept = this.connections.filter((c) => ids.has(c.serviceId));
    if (kept.length === this.connections.length) return;
    for (const c of this.connections) if (!ids.has(c.serviceId)) {
      this.controllers.get(c.id)?.abort();
      this.clearContent(c.id);
    }
    // Removing an app also forgets its separate API credentials. A locked vault can be retried;
    // the config reachability check still denies every read in the meantime.
    try { this.vault.save(kept); this.connections = kept; } catch { /* Retain encrypted file for retry. */ }
  }
  dispose(): void {
    this.disposed = true;
    this.cancelConnect();
    for (const controller of this.controllers.values()) controller.abort();
    this.caches.clear(); this.known.clear(); this.connections = null;
  }
}
