import { array, itemId, mergeItems, object, string } from '@core/inbox/policy';
import type { InboxItem, SourceRef } from '@shared/inbox';
import { ConnectorError, type Connection, type ReadConnector } from './contracts';
import { ConnectorHttp } from './http';

export class SlackConnector implements ReadConnector {
  constructor(private readonly http: ConnectorHttp) {}
  private get(c: Connection, method: string, params: Record<string, string>, signal: AbortSignal) {
    return this.http.json(`https://slack.com/api/${method}?${new URLSearchParams(params)}`,
      { headers: { Authorization: `Bearer ${c.accessToken}` }, signal }, `${c.id}:${method}`);
  }
  list(c: Connection, signal: AbortSignal, cursor = '1') {
    return this.query(c, `after:${new Date(Date.now() - 30 * 86400_000).toISOString().slice(0, 10)}`, signal, cursor);
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
  async read(c: Connection, ref: SourceRef, signal: AbortSignal) {
    const [channel, ts] = this.parse(ref);
    const result = await this.get(c, 'conversations.replies', { channel, ts, limit: '50' }, signal);
    return { ref, title: 'Slack thread', partial: result.has_more === true,
      messages: array(result.messages).slice(0, 50).map((raw) => {
        const m = object(raw);
        return { id: string(m.ts, 40), author: string(m.user, 100) || string(m.username, 100) || 'Slack', at: Number(m.ts) * 1000 || null, text: string(m.text) };
      }) };
  }
  private parse(ref: SourceRef): [string, string] {
    const match = /^([A-Z0-9]+):(\d+\.\d+)$/.exec(ref.threadId);
    if (!match) throw new ConnectorError('This Slack thread reference is invalid.');
    return [match[1]!, match[2]!];
  }
  sourceUrl(c: Connection, ref: SourceRef): string {
    const [channel, ts] = this.parse(ref);
    return `https://app.slack.com/client/${encodeURIComponent(c.remoteId)}/${channel}/thread/${channel}-${ts}`;
  }
}
