import { array, itemId, mergeItems, object, string } from '@core/inbox/policy';
import type { InboxItem, InboxThread, SourceRef, ThreadMessage } from '@shared/inbox';
import { ConnectorError, type Connection, type ReadConnector } from './contracts';
import { ConnectorHttp } from './http';

export class SlackConnector implements ReadConnector {
  private readonly users = new Map<string, { name: string; at: number }>();
  constructor(private readonly http: ConnectorHttp) {}
  private get(c: Connection, method: string, params: Record<string, string>, signal: AbortSignal) {
    return this.http.json(`https://slack.com/api/${method}?${new URLSearchParams(params)}`,
      { headers: { Authorization: `Bearer ${c.accessToken}` }, signal }, `${c.id}:${method}`);
  }
  canChat(c: Connection): boolean { return ['im:read', 'im:history'].every((scope) => c.scopes?.includes(scope)); }
  // Credentials predating scope persistence came from Hangar's original mandatory search grant.
  canSearch(c: Connection): boolean { return c.scopes === undefined || c.scopes.includes('search:read'); }
  clear(connectionId: string): void {
    for (const key of this.users.keys()) if (key.startsWith(`${connectionId}:`)) this.users.delete(key);
  }
  async list(c: Connection, signal: AbortSignal, cursor?: string) {
    if (!this.canChat(c)) return { items: [], cursor: null, detail: 'Reconnect Slack to grant DM listing and history access. Existing search access is unchanged.' };
    const result = await this.get(c, 'conversations.list', { types: 'im', limit: '20', exclude_archived: 'true', ...(cursor ? { cursor } : {}) }, signal);
    const conversations = array(result.channels).slice(0, 20).map(object).filter((channel) =>
      channel.is_im === true && channel.is_mpim !== true && /^D[A-Z0-9]+$/.test(string(channel.id, 100)));
    await this.loadUsers(c, conversations.map((channel) => string(channel.user, 100)), signal);
    const items: InboxItem[] = conversations.map((channel) => {
      const ref = { connectionId: c.id, threadId: `dm:${string(channel.id, 100)}` };
      const latest = object(channel.latest), at = this.timestamp(latest.ts);
      const count = channel.unread_count_display ?? channel.unread_count;
      return { id: itemId(ref), ref, title: this.userName(c, string(channel.user, 100)), author: this.userName(c, string(latest.user, 100)),
        preview: this.text(c, string(latest.text)).slice(0, 400), at,
        unread: typeof count === 'number' && Number.isFinite(count) && count >= 0 ? count > 0 : null,
        mention: false, category: 'direct', conversationKind: 'direct' };
    });
    return { items: mergeItems(items), cursor: string(object(result.response_metadata).next_cursor, 1000) || null,
      detail: 'Verified Slack DMs. Open a conversation to load messages. Latest activity and read state are unknown when Slack omits them; workspace retention applies.' };
  }
  search(c: Connection, query: string, signal: AbortSignal) { return this.query(c, query, signal, '1'); }
  private async query(c: Connection, query: string, signal: AbortSignal, page: string) {
    const result = await this.get(c, 'search.messages', { query, count: '40', page, sort: 'timestamp', sort_dir: 'desc', highlight: 'false' }, signal);
    const messages = object(result.messages);
    const items: InboxItem[] = [];
    for (const raw of array(messages.matches)) {
      const message = object(raw), channel = object(message.channel);
      const channelId = string(channel.id, 100), ts = string(message.thread_ts || message.ts, 40);
      if (!/^[A-Z0-9]+$/.test(channelId) || !/^\d+\.\d+$/.test(ts)) continue;
      const ref = { connectionId: c.id, threadId: `${channelId}:${ts}` };
      const text = string(message.text);
      const direct = channel.is_im === true || channel.is_mpim === true || channelId.startsWith('D');
      const mention = text.includes(`<@${c.userId}>`);
      items.push({ id: itemId(ref), ref, title: direct ? (string(channel.name, 200) || 'Direct message') : `#${string(channel.name, 200) || channelId}`,
        preview: text.slice(0, 400), author: string(message.user, 100), at: Number(message.ts) * 1000 || null,
        unread: null, mention, category: direct ? 'direct' : mention ? 'mentions' : 'channels' });
    }
    const pages = Number(object(messages.paging).pages ?? object(messages.pagination).page_count ?? 1);
    return { items: mergeItems(items), cursor: Number(page) < Math.min(pages, 10) ? String(Number(page) + 1) : null,
      detail: 'Recent matching conversations. Slack search does not report read state; unread counts are unknown.' };
  }
  async read(c: Connection, ref: SourceRef, signal: AbortSignal, cursor?: string): Promise<InboxThread> {
    const dm = /^dm:(D[A-Z0-9]+)$/.exec(ref.threadId);
    if (dm) {
      if (!this.canChat(c)) throw new ConnectorError('Reconnect Slack to grant DM listing and history access.', true);
      const result = await this.get(c, 'conversations.history', { channel: dm[1]!, limit: '15', ...(cursor ? { cursor } : {}) }, signal);
      const messages = await this.messages(c, array(result.messages).slice(0, 15), signal);
      const olderCursor = string(object(result.response_metadata).next_cursor, 1000) || null;
      return { ref, title: 'Slack direct conversation', messages, olderCursor, partial: true,
        historyDetail: olderCursor ? 'Older messages are available. Slack rate limits and workspace retention apply.'
          : result.has_more === true ? 'Slack reports more history but did not supply a continuation. Open Slack for older messages.'
            : 'Start of history available to this connection. Workspace retention may exclude older messages.' };
    }
    const [channel, ts] = this.parse(ref);
    const result = await this.get(c, 'conversations.replies', { channel, ts, limit: '50' }, signal);
    return { ref, title: 'Slack thread', partial: result.has_more === true,
      messages: await this.messages(c, array(result.messages).slice(0, 50), signal) };
  }
  private timestamp(value: unknown): number | null {
    const ts = string(value, 40), at = Number(ts) * 1000;
    return /^\d+\.\d+$/.test(ts) && Number.isFinite(at) && at > 0 ? at : null;
  }
  private userName(c: Connection, id: string): string { return this.users.get(`${c.id}:${id}`)?.name || id || 'Unknown sender'; }
  private async loadUsers(c: Connection, ids: string[], signal: AbortSignal): Promise<void> {
    if (!c.scopes?.includes('users:read')) return;
    const missing = [...new Set(ids)].filter((id) => /^[UW][A-Z0-9]+$/.test(id) && (this.users.get(`${c.id}:${id}`)?.at ?? 0) < Date.now() - 3600_000).slice(0, 50);
    for (let i = 0; i < missing.length; i += 4) {
      await Promise.all(missing.slice(i, i + 4).map(async (id) => {
        try {
          const response = await this.get(c, 'users.info', { user: id }, signal), user = object(response.user), profile = object(user.profile);
          signal.throwIfAborted();
          this.users.set(`${c.id}:${id}`, { name: string(profile.display_name, 200) || string(profile.real_name, 200) || string(user.name, 200) || id, at: Date.now() });
        } catch (error) {
          signal.throwIfAborted();
          if (error instanceof ConnectorError && error.reconnect) throw error;
          // A profile outage must not prevent reading the conversation; preserve the stable ID.
        }
      }));
    }
    while (this.users.size > 500) this.users.delete(this.users.keys().next().value!);
  }
  private text(c: Connection, text: string): string {
    return text.replace(/<@([UW][A-Z0-9]+)>/g, (_match, id: string) => `@${this.userName(c, id)}`)
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  }
  private async messages(c: Connection, raw: unknown[], signal: AbortSignal): Promise<ThreadMessage[]> {
    const records = raw.map(object).filter((m) => this.timestamp(m.ts) !== null && m.subtype !== 'message_deleted');
    await this.loadUsers(c, records.flatMap((m) => [string(m.user, 100), ...[...string(m.text).matchAll(/<@([UW][A-Z0-9]+)>/g)].map((match) => match[1]!)]), signal);
    return [...new Map(records.map((m): [string, ThreadMessage] => {
      const id = string(m.ts, 40), user = string(m.user, 100);
      return [id, { id, author: user ? this.userName(c, user) : string(m.username, 100) || 'Slack', at: this.timestamp(m.ts),
        text: this.text(c, string(m.text)), direction: user ? user === c.userId ? 'outgoing' : 'incoming' : 'unknown', attachmentCount: array(m.files).length }];
    })).values()].sort((a, b) => (a.at ?? 0) - (b.at ?? 0) || a.id.localeCompare(b.id));
  }
  private parse(ref: SourceRef): [string, string] {
    const match = /^([A-Z0-9]+):(\d+\.\d+)$/.exec(ref.threadId);
    if (!match) throw new ConnectorError('This Slack thread reference is invalid.');
    return [match[1]!, match[2]!];
  }
  sourceUrl(c: Connection, ref: SourceRef): string {
    const dm = /^dm:(D[A-Z0-9]+)$/.exec(ref.threadId);
    if (dm) return `https://app.slack.com/client/${encodeURIComponent(c.remoteId)}/${dm[1]}`;
    const [channel, ts] = this.parse(ref);
    return `https://app.slack.com/client/${encodeURIComponent(c.remoteId)}/${channel}/thread/${channel}-${ts}`;
  }
}
