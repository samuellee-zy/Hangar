import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { InboxItem, InboxSource, InboxThread } from '@shared/inbox';
import { Icon } from '../Icon';

const date = (at: number | null) => at ? new Date(at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : 'Time unknown';
export function ChatTimeline({ item, source, back }: { item: InboxItem; source: InboxSource; back(): void }) {
  const [thread, setThread] = useState<InboxThread | null>(null);
  const [pending, setPending] = useState<InboxThread | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const sequence = useRef(0), scroll = useRef<HTMLDivElement>(null), nearBottom = useRef(true);
  const position = useRef<{ height: number; top: number } | null>(null);
  const current = useRef<InboxThread | null>(null), loading = useRef(false), loadedOlder = useRef(false);
  const invalidate = useCallback(() => { sequence.current++; loading.current = false; }, []);
  const apply = useCallback((next: InboxThread) => { current.current = next; setThread(next); setPending(null); }, []);
  const read = useCallback(async (older = false) => {
    if (loading.current) return;
    const cursor = older ? current.current?.olderCursor : undefined;
    if (older && !cursor) return;
    loading.current = true; setBusy(true); setError('');
    const seq = ++sequence.current;
    const result = cursor ? await window.hangar.inbox.read(item.ref, cursor) : await window.hangar.inbox.read(item.ref);
    if (seq !== sequence.current) return;
    loading.current = false; setBusy(false);
    if (!result.ok) { setError(result.error); return; }
    const previous = current.current, next = result.value;
    if (older && previous) {
      if (scroll.current) position.current = { height: scroll.current.scrollHeight, top: scroll.current.scrollTop };
      const byId = new Map([...next.messages, ...previous.messages].map((m) => [m.id, m]));
      loadedOlder.current = true;
      apply({ ...next, messages: [...byId.values()].sort((a, b) => (a.at ?? 0) - (b.at ?? 0) || a.id.localeCompare(b.id)).slice(-500) });
    } else {
      // Replace the latest window so edits and deletions disappear; retain older loaded pages.
      const first = next.messages[0]?.at;
      const olderMessages = loadedOlder.current && first ? previous?.messages.filter((m) => m.at !== null && m.at < first) ?? [] : [];
      const merged = { ...next, messages: [...olderMessages, ...next.messages].slice(-500),
        ...(loadedOlder.current && olderMessages.length ? { olderCursor: previous?.olderCursor ?? null, historyDetail: previous?.historyDetail } : {}) };
      if (previous && !nearBottom.current) setPending(merged); else apply(merged);
    }
  }, [item.ref, apply]);
  useEffect(() => {
    void read();
    const timer = setInterval(() => { if (!document.hidden) void read(); }, 90_000);
    return () => { invalidate(); clearInterval(timer); };
  }, [read, invalidate]);
  useLayoutEffect(() => {
    const node = scroll.current;
    if (!node) return;
    if (position.current) {
      node.scrollTop = position.current.top + node.scrollHeight - position.current.height;
      position.current = null;
    } else if (nearBottom.current) node.scrollTop = node.scrollHeight;
  }, [thread]);
  return <>
    <header className="inbox-reader-head">
      <button onClick={back} aria-label="Back to conversation list"><Icon name="chevron-left" />Back</button>
      <div className="chat-person"><h2>{item.title}</h2><span className="chat-source">{source.app} · {source.identity ?? source.label}</span></div>
      <button disabled={busy} onClick={() => read()} aria-label="Refresh messages"><Icon name="reload" /></button>
      <button onClick={async () => { const r = await window.hangar.inbox.open(item.ref); if (!r.ok) setError(r.error); }}>Reply in {source.app}<Icon name="pop-out" /></button>
    </header>
    {error && <div className="inbox-error" role="alert">{error} <button disabled={busy} onClick={() => read()}>Retry</button></div>}
    <div className="inbox-messages" ref={scroll} role="region" aria-label="Messages" tabIndex={0} aria-busy={busy}
      onScroll={() => { const n = scroll.current; if (n) nearBottom.current = n.scrollHeight - n.scrollTop - n.clientHeight < 60; }}>
      {thread?.olderCursor && <button className="inbox-more" disabled={busy || thread.messages.length >= 500} onClick={() => read(true)}>{thread.messages.length >= 500 ? '500 messages loaded · continue in the app' : 'Load older messages'}</button>}
      {thread?.historyDetail && <p className="chat-history">{thread.historyDetail}</p>}
      {!thread && busy && <p className="inbox-empty" role="status">Loading messages…</p>}
      {thread?.messages.map((message, index) => {
        const previous = thread.messages[index - 1];
        const day = message.at ? new Date(message.at).toLocaleDateString([], { month: 'long', day: 'numeric', year: 'numeric' }) : null;
        const previousDay = previous?.at ? new Date(previous.at).toLocaleDateString([], { month: 'long', day: 'numeric', year: 'numeric' }) : null;
        return <div key={message.id}>
          {day && day !== previousDay && <div className="chat-day">{day}</div>}
          <article className={`inbox-message ${message.direction === 'outgoing' ? 'outgoing' : ''}`}>
            <header><strong>{message.direction === 'outgoing' ? 'You' : message.author || 'Unknown sender'}</strong><time>{date(message.at)}</time></header>
            {message.text && <p>{message.text}</p>}
            {!!message.attachmentCount && <p className="chat-attachment">{message.attachmentCount} attachment{message.attachmentCount === 1 ? '' : 's'} · view in {source.app}</p>}
            {!message.text && !message.attachmentCount && <p className="chat-attachment">This message has no supported text. View it in {source.app}.</p>}
          </article>
        </div>;
      })}
      {thread && !thread.messages.length && <div className="inbox-empty">No messages were returned by this connection.</div>}
    </div>
    {pending && <button className="inbox-new" onClick={() => { nearBottom.current = true; apply(pending); }}>New activity · Show latest messages</button>}
    <footer className="inbox-reader-footer"><span>Reading here does not mark messages read. Replying opens the original app.</span></footer>
  </>;
}
