import { itemId, object, string } from '@core/inbox/policy';
import { SEARCH_TOOLS } from '@core/ai/policy';
import type { InboxItem, InboxSource, SourceRef } from '@shared/inbox';
import type { Evidence } from '@shared/ai';
import type { ConnectorHub } from '@main/connectors/hub';
import { ConnectorError } from '@main/connectors/contracts';
import { AgentError, type AgentEvent, type ToolBroker } from './contracts';

/** Per-run capability object. Model arguments cannot extend this allowlist or mint a source URL. */
export class SearchBroker implements ToolBroker {
  readonly tools = SEARCH_TOOLS;
  private calls = 0;
  private characters = 0;
  private evidence = new Map<string, Evidence>();
  private identities = new Map<string, string>();
  readonly allowed: ReadonlySet<string>;
  constructor(private readonly hub: Pick<ConnectorHub, 'search' | 'read'>, private readonly sources: InboxSource[],
    private readonly signal: AbortSignal, private readonly emit: (event: AgentEvent) => void) {
    this.allowed = new Set(sources.map((s) => s.id));
  }
  private record(item: InboxItem): Evidence {
    const key = itemId(item.ref), existing = this.identities.get(key);
    if (existing) return this.evidence.get(existing)!;
    if (this.evidence.size >= 80) throw new AgentError('Evidence limit reached. Summarize existing results.');
    const id = `S${this.evidence.size + 1}`, source = this.sources.find((s) => s.id === item.ref.connectionId)!;
    const evidence: Evidence = { id, ref: item.ref, title: item.title, source: `${source.app} · ${source.identity ?? source.label}`,
      author: item.author, at: item.at, retrievedAt: Date.now(), preview: item.preview.slice(0, 800), read: false };
    this.identities.set(key, id); this.evidence.set(id, evidence); this.emit({ type: 'evidence', evidence });
    return evidence;
  }
  private budget(): void {
    this.signal.throwIfAborted();
    if (++this.calls > 16 || this.characters >= 100_000) throw new AgentError('Search budget reached. Summarize the evidence already retrieved.');
  }
  async context(ref: SourceRef, title: string): Promise<unknown> {
    if (!this.allowed.has(ref.connectionId)) throw new AgentError('The selected thread is outside the authorized accounts.');
    const e = this.record({ id: itemId(ref), ref, title, preview: '', author: '', at: null, unread: null, mention: false, category: 'other' });
    return this.call('hangar_read', { evidenceId: e.id });
  }
  async call(name: string, args: unknown): Promise<unknown> {
    try {
      this.budget();
      const input = object(args);
      let output: unknown;
      if (name === 'hangar_search') {
        const id = string(input.connectionId, 200), query = string(input.query, 1001);
        if (!this.allowed.has(id) || !query.trim() || query.length > 1000) throw new AgentError('Search denied: invalid query or account outside this run.');
        const source = this.sources.find((s) => s.id === id)!;
        this.emit({ type: 'status', text: `Searching ${source.app} · ${source.identity ?? source.label}` });
        const items = await this.hub.search(id, query, this.allowed, this.signal);
        this.signal.throwIfAborted();
        output = { partial: true, account: source.identity ?? source.label, results: items.slice(0, 12).map((i) => this.record(i)),
          note: 'Bounded search results, not a full history. Read relevant threads before making claims.' };
      } else if (name === 'hangar_read') {
        const e = this.evidence.get(string(input.evidenceId, 10));
        if (!e || !this.allowed.has(e.ref.connectionId)) throw new AgentError('Read denied: use an evidence ID returned in this run.');
        this.emit({ type: 'status', text: `Reading ${e.title} · ${e.source}` });
        const thread = await this.hub.read(e.ref, this.allowed, this.signal);
        this.signal.throwIfAborted();
        let remaining = 18_000;
        const messages = thread.messages.slice(-30).map((m) => { const text = m.text.slice(0, remaining); remaining = Math.max(0, remaining - text.length); return { ...m, text }; }).filter((m) => m.text);
        const read = { ...e, read: true };
        this.evidence.set(e.id, read); this.emit({ type: 'evidence', evidence: read });
        output = { evidence: read, messages, partial: thread.partial || remaining === 0 || thread.messages.length > 30 };
      } else throw new AgentError('Tool denied. Only connected-app search and reading are available.');
      const serialized = JSON.stringify(output);
      if (serialized.length + this.characters > 100_000) throw new AgentError('Content budget reached. Summarize existing evidence.');
      this.characters += serialized.length;
      return output;
    } catch (error) {
      this.signal.throwIfAborted();
      return { error: error instanceof AgentError || error instanceof ConnectorError ? error.message : 'This source could not be reached. Continue with available evidence and disclose the gap.' };
    }
  }
}
