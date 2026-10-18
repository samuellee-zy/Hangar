import { array, itemId, object, string } from '@core/inbox/policy';
import type { InboxItem, SourceRef, ThreadMessage } from '@shared/inbox';
import { ConnectorError, type Connection, type ReadConnector } from './contracts';
import { ConnectorHttp } from './http';

const header = (payload: Record<string, unknown>, name: string) => string(object(array(payload.headers).find((h) => string(object(h).name).toLowerCase() === name)).value, 500);
/** Plain text only. Never render provider HTML, tracking images or scripts in a privileged view. */
export function gmailText(part: Record<string, unknown>, depth = 0): string {
  if (depth > 10) return '';
  if (part.mimeType === 'text/plain') return Buffer.from(string(object(part.body).data, 100_000), 'base64url').toString('utf8').slice(0, 20_000);
  return array(part.parts).slice(0, 40).map((p) => gmailText(object(p), depth + 1)).filter(Boolean).join('\n').slice(0, 20_000);
}
export function gmailMessages(raw: unknown): ThreadMessage[] {
  return array(raw).slice(-50).map((value) => {
    const m = object(value), payload = object(m.payload);
    return { id: string(m.id, 100), author: header(payload, 'from'), at: Number(m.internalDate) || null,
      text: gmailText(payload) || `${string(m.snippet, 1000)}\n\n[Plain-text body unavailable. Open in Gmail to read the full message.]` };
  });
}
export class GmailConnector implements ReadConnector {
  constructor(private readonly http: ConnectorHttp) {}
  private get(c: Connection, resource: string, params: Record<string, string>, signal: AbortSignal) {
    return this.http.json(`https://gmail.googleapis.com/gmail/v1/users/me/${resource}?${new URLSearchParams(params)}`,
      { headers: { Authorization: `Bearer ${c.accessToken}` }, signal }, `${c.id}:gmail`);
  }
  list(c: Connection, signal: AbortSignal, cursor?: string) { return this.query(c, 'in:inbox', signal, cursor); }
  search(c: Connection, query: string, signal: AbortSignal) { return this.query(c, query, signal); }
  private async query(c: Connection, q: string, signal: AbortSignal, cursor?: string) {
    const result = await this.get(c, 'threads', { q, maxResults: '20', ...(cursor ? { pageToken: cursor } : {}) }, signal);
    const refs = array(result.threads).slice(0, 20).map((r) => string(object(r).id, 100)).filter((id) => /^[a-f0-9]+$/.test(id));
    const items: InboxItem[] = [];
    // Four at once, rather than one request per message or unbounded fanout.
    for (let i = 0; i < refs.length; i += 4) {
      const threads = await Promise.all(refs.slice(i, i + 4).map((id) => this.get(c, `threads/${id}`, { format: 'metadata' }, signal)));
      for (const t of threads) {
        const messages = array(t.messages).map(object), last = messages[messages.length - 1];
        if (!last) continue;
        const ref = { connectionId: c.id, threadId: string(t.id, 100) };
        const payload = object(last.payload);
        items.push({ id: itemId(ref), ref, title: header(payload, 'subject') || '(No subject)', preview: string(last.snippet, 400),
          author: header(payload, 'from'), at: Number(last.internalDate) || null,
          unread: messages.some((m) => array(m.labelIds).includes('UNREAD')), mention: false, category: 'email' });
      }
    }
    return { items, cursor: string(result.nextPageToken, 500) || null, detail: 'Recent inbox threads. Refresh replaces this bounded snapshot; previews do not mark mail read.' };
  }
  async read(c: Connection, ref: SourceRef, signal: AbortSignal) {
    this.validate(ref);
    const result = await this.get(c, `threads/${ref.threadId}`, { format: 'full' }, signal);
    const messages = array(result.messages);
    return { ref, title: header(object(object(messages[0]).payload), 'subject') || '(No subject)',
      messages: gmailMessages(messages), partial: messages.length > 50 || messages.some((m) => !gmailText(object(object(m).payload))) };
  }
  private validate(ref: SourceRef) {
    if (!/^[a-f0-9]+$/.test(ref.threadId)) throw new ConnectorError('This Gmail thread reference is invalid.');
  }
  sourceUrl(c: Connection, ref: SourceRef): string {
    this.validate(ref);
    return `https://mail.google.com/mail/u/?authuser=${encodeURIComponent(c.identity)}#all/${ref.threadId}`;
  }
}
