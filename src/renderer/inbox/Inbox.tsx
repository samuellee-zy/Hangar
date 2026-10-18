import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { INBOX_CATEGORIES, type InboxCategory, type InboxItem, type InboxSnapshot, type InboxSource, type InboxThread } from '@shared/inbox';
import { useShellState } from '../useShellState';
import { Icon } from '../Icon';
import './inbox.css';

const stateLabel: Record<InboxSource['state'], string> = { ready: 'Connected', refreshing: 'Updating', limited: 'Limited preview', sleeping: 'Sleeping', connect: 'Read access available', reconnect: 'Reconnect', error: 'Update failed' };
const date = (at: number | null) => at ? new Date(at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : 'Time unavailable';

export function Inbox() {
  const shell = useShellState();
  const [snapshot, setSnapshot] = useState<InboxSnapshot | null>(null);
  const [error, setError] = useState('');
  const [allWorkspaces, setAllWorkspaces] = useState(false);
  const [sourceId, setSourceId] = useState('all');
  const [category, setCategory] = useState<InboxCategory | 'all'>('all');
  const [groupBy, setGroupBy] = useState<'category' | 'app'>('category');
  const [unread, setUnread] = useState(false);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<InboxItem | null>(null);
  const [thread, setThread] = useState<InboxThread | null>(null);
  const [reading, setReading] = useState(false);
  const [readError, setReadError] = useState('');
  const [showSources, setShowSources] = useState(false);
  const [pending, setPending] = useState<InboxSnapshot | null>(null);
  const current = useRef<InboxSnapshot | null>(null);
  const selectedRef = useRef<InboxItem | null>(null);
  const request = useRef(0), readRequest = useRef(0);
  const workspaceId = shell?.activeWorkspaceId;
  const open = shell?.inboxOpen ?? false;
  const invalidate = useCallback(() => { request.current++; readRequest.current++; }, []);

  const pull = useCallback(async () => {
    const seq = ++request.current;
    const result = await window.hangar.inbox.snapshot({ allWorkspaces });
    if (seq !== request.current) return;
    if (!result.ok) { setError(result.error); return; }
    const next = result.value;
    const old = current.current;
    // Preserve the reading position, but revoke stale content immediately when a source vanishes.
    const selection = selectedRef.current;
    const source = next.sources.find((s) => s.id === selection?.ref.connectionId);
    if (selection && (!source || source.state === 'reconnect')) {
      readRequest.current++;
      setSelected(null); selectedRef.current = null; setThread(null); setReading(false);
    }
    if (old && selectedRef.current && old.workspaceId === next.workspaceId && JSON.stringify(old.items) !== JSON.stringify(next.items)) {
      setPending(next);
      setSnapshot({ ...next, items: old.items.filter((i) => next.sources.some((s) => s.id === i.ref.connectionId && s.state !== 'reconnect')) });
    } else { current.current = next; setSnapshot(next); setPending(null); }
  }, [allWorkspaces]);

  useEffect(() => {
    current.current = null; selectedRef.current = null;
    setSnapshot(null); setPending(null); setSelected(null); setThread(null); setError(''); setSourceId('all');
    readRequest.current++;
    if (!open) return;
    let live = true;
    void pull();
    const unsubscribe = window.hangar.inbox.onChanged(() => { void pull(); });
    const refresh = async () => {
      const result = await window.hangar.inbox.refresh({ allWorkspaces });
      if (live && !result.ok) setError(result.error);
    };
    void refresh();
    const timer = setInterval(() => { if (!document.hidden) void refresh(); }, 90_000);
    return () => { live = false; invalidate(); unsubscribe(); clearInterval(timer); };
  }, [pull, allWorkspaces, workspaceId, open, invalidate]);

  const sources = snapshot?.sources ?? [];
  const sourceMap = new Map(sources.map((s) => [s.id, s]));
  const filtered = useMemo(() => (snapshot?.items ?? []).filter((item) =>
    (sourceId === 'all' || item.ref.connectionId === sourceId) && (category === 'all' || item.category === category)
    && (!unread || item.unread === true) && (!query || `${item.title} ${item.author} ${item.preview}`.toLocaleLowerCase().includes(query.toLocaleLowerCase())),
  ), [snapshot, sourceId, category, unread, query]);
  const groups = new Map<string, InboxItem[]>();
  const orderedKeys = groupBy === 'category' ? Object.keys(INBOX_CATEGORIES) : [...new Set(sources.map((s) => s.app))];
  for (const key of orderedKeys) groups.set(key, []);
  for (const item of filtered) {
    const key = groupBy === 'category' ? item.category : sourceMap.get(item.ref.connectionId)?.app ?? 'Other';
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }

  const select = async (item: InboxItem) => {
    const seq = ++readRequest.current;
    setSelected(item); selectedRef.current = item; setThread(null); setReadError('');
    if (!sourceMap.get(item.ref.connectionId)?.canRead) { setReading(false); return; }
    setReading(true);
    const result = await window.hangar.inbox.read(item.ref);
    if (seq !== readRequest.current) return;
    setReading(false);
    if (result.ok) setThread(result.value); else setReadError(result.error);
  };
  const back = () => { readRequest.current++; setSelected(null); selectedRef.current = null; setThread(null); setReading(false); };
  const selectedSource = selected ? sourceMap.get(selected.ref.connectionId) : null;
  const refresh = async () => {
    setError('');
    const result = await window.hangar.inbox.refresh({ allWorkspaces });
    if (!result.ok) setError(result.error);
  };

  return <main className={`inbox ${selected ? 'has-selection' : ''}`}>
    <header className="inbox-top">
      <div><div className="inbox-eyebrow">YOUR WORKSPACE</div><h1>Inbox <span className="inbox-count">{snapshot?.items.length ?? '—'}</span></h1></div>
      <div className="inbox-top-actions">
        <label className="inbox-scope"><span className="sr-only">Workspace scope</span><select value={allWorkspaces ? 'all' : 'current'} onChange={(e) => setAllWorkspaces(e.target.value === 'all')}>
          <option value="current">{shell?.workspaces.find((w) => w.id === workspaceId)?.name ?? 'Current workspace'}</option><option value="all">All workspaces</option>
        </select></label>
        <button onClick={() => setShowSources(!showSources)} aria-expanded={showSources}>Connections</button>
        <button onClick={refresh} aria-label="Refresh inbox" title="Refresh inbox"><Icon name="reload" /></button>
        <button onClick={() => window.hangar.send({ type: 'close-inbox' })}>Back to apps</button>
      </div>
    </header>
    <p className="inbox-subtitle">Conversations from your connected apps, with their source always in view.</p>
    {error && <div className="inbox-error" role="alert">{error}<button onClick={() => setError('')} aria-label="Dismiss error">×</button></div>}
    {showSources && <section className="inbox-connections" aria-label="Inbox connections">
      <p>Read connections are separate from signing into app panes. Previews stay on this device; opening a source may mark it read in that app.</p>
      {sources.map((source) => <ConnectionRow key={source.id} source={source} onError={setError} onDisconnect={back} />)}
      {sources.length === 0 && <button onClick={() => window.hangar.send({ type: 'open-connections' })}>Add your first app</button>}
    </section>}
    <div className="inbox-filters">
      <label className="inbox-search"><span className="sr-only">Filter loaded conversations</span><input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Filter loaded conversations…" /></label>
      <label><span className="sr-only">App and account</span><select value={sourceId} onChange={(e) => { setSourceId(e.target.value); back(); }}><option value="all">All apps & accounts</option>{sources.map((s) => <option key={s.id} value={s.id}>{s.app} · {s.identity ?? s.label}</option>)}</select></label>
      <label><span className="sr-only">Group conversations</span><select value={groupBy} onChange={(e) => setGroupBy(e.target.value as 'category' | 'app')}><option value="category">Group by category</option><option value="app">Group by app</option></select></label>
      <button aria-pressed={unread} onClick={() => setUnread(!unread)}>Unread only</button>
    </div>
    <div className="inbox-body">
      <nav className="inbox-nav" aria-label="Conversation categories">
        <button aria-current={category === 'all' ? 'page' : undefined} onClick={() => setCategory('all')}>All conversations</button>
        {(Object.entries(INBOX_CATEGORIES) as [InboxCategory, string][]).map(([id, label]) => <button key={id} aria-current={category === id ? 'page' : undefined} onClick={() => setCategory(id)}>{label}<span>{snapshot?.items.filter((i) => i.category === id).length ?? 0}</span></button>)}
        <div className="inbox-nav-note"><strong>Recent conversations</strong><p>Read-only previews. Counts cover loaded conversations, not all message history.</p></div>
      </nav>
      <section className="inbox-list" aria-label="Conversations" aria-busy={!snapshot}>
        <div className="inbox-list-status" role="status">{filtered.length} shown{sources.some((s) => s.state === 'refreshing') ? ' · Updating…' : ''}{unread ? ' · Unknown read states excluded' : ''}</div>
        {pending && <button className="inbox-new" onClick={() => { current.current = pending; setSnapshot(pending); setPending(null); }}>New activity · Update list</button>}
        {[...groups].filter(([, items]) => items.length).map(([key, items]) => <section key={key} aria-label={groupBy === 'category' ? INBOX_CATEGORIES[key as InboxCategory] : key}>
          <h2>{groupBy === 'category' ? INBOX_CATEGORIES[key as InboxCategory] : key}<span>{items.length}</span></h2>
          {items.map((item) => { const source = sourceMap.get(item.ref.connectionId); return <button key={item.id} className={`inbox-row ${item.id === selected?.id ? 'selected' : ''}`} aria-pressed={item.id === selected?.id} onClick={() => select(item)}
            onKeyDown={(event) => { if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); const rows = [...event.currentTarget.closest('.inbox-list')!.querySelectorAll<HTMLButtonElement>('.inbox-row')]; rows[rows.indexOf(event.currentTarget) + (event.key === 'ArrowDown' ? 1 : -1)]?.focus(); } }}>
            <div className="inbox-row-heading"><strong>{item.title}</strong>{item.unread === true && <span className="inbox-dot" aria-label="Unread" />}</div>
            <div className="inbox-row-preview">{item.preview || 'Open to read this conversation'}</div>
            <div className="inbox-row-meta"><span>{source?.app} · {source?.identity ?? source?.label}</span><time>{item.at ? date(item.at) : 'Limited'}</time></div>
            {item.unread === null && <span className="inbox-unknown">Read state unknown</span>}
          </button>; })}
        </section>)}
        {snapshot && !filtered.length && <div className="inbox-empty"><Icon name="inbox" size={32} /><h2>{query || unread || category !== 'all' ? 'No matching conversations' : 'Your conversations will appear here'}</h2><p>{sources.some((s) => s.canRead) ? 'Refresh your sources or adjust the filters. Source errors are shown in Connections.' : 'Connect Slack or Gmail read access, or open an app to load its limited unread preview.'}</p><button onClick={() => setShowSources(true)}>Manage connections</button></div>}
        {sources.filter((s) => s.hasMore).map((s) => <button className="inbox-more" key={s.id} disabled={s.state === 'refreshing'} onClick={async () => { const r = await window.hangar.inbox.more(s.id); if (!r.ok) setError(r.error); }}>Load more from {s.app} · {s.label}</button>)}
      </section>
      <section className="inbox-reader" aria-label="Conversation preview" aria-busy={reading}>
        {selected ? <>
          <header className="inbox-reader-head"><button onClick={back} aria-label="Back to conversation list"><Icon name="chevron-left" />Back</button><span>{selectedSource?.app} · {selectedSource?.identity ?? selectedSource?.label}</span></header>
          <div className="inbox-reader-title"><span className="inbox-eyebrow">{INBOX_CATEGORIES[selected.category]}</span><h2>{selected.title}</h2><p>{selected.at ? date(selected.at) : 'Limited preview · message time unavailable'}</p><button onClick={async () => { const r = await window.hangar.inbox.open(selected.ref); if (!r.ok) setReadError(r.error); }}>Open in {selectedSource?.app ?? 'app'} <Icon name="pop-out" /></button></div>
          <div className="inbox-messages" role="region" aria-label="Messages" tabIndex={0} aria-live="polite">
            {reading && <p>Loading conversation…</p>}{readError && <p className="inbox-error" role="alert">{readError}</p>}
            {!selectedSource?.canRead && <div className="inbox-empty"><h3>Continue in the original app</h3><p>This source provides unread names only. It does not provide message bodies or a complete inbox.</p></div>}
            {thread?.messages.map((m) => <article className="inbox-message" key={m.id}><header><strong>{m.author || 'Unknown sender'}</strong><time>{date(m.at)}</time></header><p>{m.text}</p></article>)}
            {thread?.partial && <p className="inbox-note">This is a partial preview. Open the original thread for all messages, formatting and attachments.</p>}
          </div>
          <footer className="inbox-reader-footer">Previewing here does not mark messages read.</footer>
        </> : <div className="inbox-empty inbox-reader-empty"><Icon name="inbox" size={40} /><h2>A little less app switching.</h2><p>Choose a conversation to read it here.<br />Its account and original source stay attached.</p></div>}
      </section>
    </div>
    <footer className="inbox-status"><span>{sources.filter((s) => s.canRead).length} read connections · {sources.filter((s) => !s.canRead).length} limited or unavailable</span><button onClick={() => setShowSources(!showSources)}>Source status</button></footer>
  </main>;
}

function ConnectionRow({ source, onError, onDisconnect }: { source: InboxSource; onError: (error: string) => void; onDisconnect: () => void }) {
  const [setup, setSetup] = useState(false), [clientId, setClientId] = useState(''), [secret, setSecret] = useState(''), [busy, setBusy] = useState(false);
  // The app catalog id isn't exposed as a credential authority: main rechecks the service kind.
  const supported = source.kind !== 'page' || source.app === 'Gmail' || source.app === 'Slack';
  const gmail = source.kind === 'gmail' || source.app === 'Gmail';
  const connect = async () => {
    setBusy(true); onError('');
    const result = await window.hangar.inbox.connect({ serviceId: source.serviceId, clientId: clientId.trim(), ...(secret ? { clientSecret: secret } : {}) });
    setBusy(false); setSecret('');
    if (!result.ok) onError(result.error); else setSetup(false);
  };
  return <div className="inbox-connection">
    <div><strong>{source.app}</strong><span> {source.identity ?? source.label}</span><small>{stateLabel[source.state]}{source.updatedAt ? ` · Updated ${date(source.updatedAt)}` : ''}</small><p>{source.detail}</p></div>
    <div className="inbox-connection-actions">
      {supported && <button onClick={() => setSetup(!setup)} aria-expanded={setup}>{source.kind === 'page' ? 'Connect read access' : 'Reconnect'}</button>}
      {source.kind !== 'page' && <button onClick={async () => { const r = await window.hangar.inbox.disconnect(source.id); if (!r.ok) onError(r.error); else onDisconnect(); }}>Disconnect & clear</button>}
    </div>
    {setup && <form className="inbox-connect-form" onSubmit={(event) => { event.preventDefault(); void connect(); }}>
      <p>{gmail ? 'Use a Google OAuth Desktop client with the Gmail API enabled. Register your account as a test user while the app is in testing.' : 'Use a Slack public client with PKCE enabled. Register http://localhost:53682/oauth/callback as its redirect URL.'}</p>
      <label>OAuth client ID<input required autoComplete="off" value={clientId} onChange={(e) => setClientId(e.target.value)} disabled={busy} maxLength={250} /></label>
      {gmail && <label>Desktop client secret (if issued)<input type="password" autoComplete="off" value={secret} onChange={(e) => setSecret(e.target.value)} disabled={busy} maxLength={500} /></label>}
      <p>Continue in your browser to choose the account and grant read access. No send, archive or mark-read permission is requested.</p>
      <button type="submit" disabled={busy || !clientId.trim()}>{busy ? 'Waiting for sign-in…' : 'Continue in browser'}</button>
      {busy && <button type="button" onClick={() => { void window.hangar.inbox.cancelConnect(); }}>Cancel sign-in</button>}
    </form>}
  </div>;
}
