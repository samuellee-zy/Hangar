import { usePanelState } from '../PanelState';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { InboxItem, InboxSnapshot, InboxSource } from '@shared/inbox';
import { useShellState } from '../useShellState';
import { Icon } from '../Icon';
import { ChatTimeline } from './ChatTimeline';
import './inbox.css';

const stateLabel: Record<InboxSource['state'], string> = { ready: 'Connected', refreshing: 'Updating', limited: 'Open in app', sleeping: 'Sleeping', connect: 'Read access available', reconnect: 'Reconnect', error: 'Update failed' };
const date = (at: number | null) => at ? new Date(at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : 'Activity unknown';
const appKey = (source?: InboxSource) => source?.app === 'WhatsApp' ? 'whatsapp' : source?.app === 'Messenger' || source?.app === 'Facebook Messenger' ? 'messenger' : source?.kind ?? 'unknown';
const initials = (name: string) => name.trim().split(/\s+/).slice(0, 2).map((word) => word[0]).join('').toLocaleUpperCase();

export function Inbox() {
  const shell = useShellState();
  const [snapshot, setSnapshot] = useState<InboxSnapshot | null>(null);
  const [error, setError] = useState('');
  const [allWorkspaces, setAllWorkspaces] = usePanelState('allWorkspaces', false);
  const [sourceId, setSourceId] = usePanelState('sourceId', 'all');
  const [unread, setUnread] = usePanelState('unread', false), [query, setQuery] = usePanelState('query', '');
  const [selected, setSelected] = usePanelState<InboxItem | null>('selected', null);
  const [showSources, setShowSources] = usePanelState('showSources', false);
  const [pending, setPending] = useState<InboxSnapshot | null>(null);
  const current = useRef<InboxSnapshot | null>(null), selection = useRef<InboxItem | null>(selected), request = useRef(0);
  const scope = useRef(0);
  const previousScope = useRef('');
  const invalidate = useCallback(() => { request.current++; scope.current++; }, []);
  const workspaceId = shell?.activeWorkspaceId, open = shell?.inboxOpen ?? false;
  const back = useCallback(() => { selection.current = null; setSelected(null); }, [setSelected]);
  const pull = useCallback(async (requestedPage = false) => {
    const seq = ++request.current;
    const result = await window.hangar.inbox.snapshot({ allWorkspaces });
    if (seq !== request.current) return;
    if (!result.ok) { setError(result.error); return; }
    let next = result.value;
    const old = current.current;
    if (requestedPage && old?.workspaceId === next.workspaceId) {
      // An explicit page request should append immediately without moving rows already on screen.
      const remaining = new Map(next.items.map((item) => [item.id, item]));
      const retained = old.items.flatMap((item) => {
        const updated = remaining.get(item.id);
        remaining.delete(item.id);
        return updated ? [updated] : [];
      });
      next = { ...next, items: [...retained, ...remaining.values()] };
    }
    const source = next.sources.find((s) => s.id === selection.current?.ref.connectionId);
    if (selection.current && (!source?.canChat || source.state === 'reconnect')) back();
    const nextItems = new Map(next.items.map((item) => [item.id, item]));
    const itemsChanged = old && (old.items.length !== next.items.length
      || old.items.some((item) => JSON.stringify(item) !== JSON.stringify(nextItems.get(item.id))));
    if (!requestedPage && old && selection.current && old.workspaceId === next.workspaceId && itemsChanged) {
      setPending(next);
      setSnapshot({ ...next, items: old.items.filter((i) => next.sources.some((s) => s.id === i.ref.connectionId && s.canChat)) });
    } else {
      if (old && old.workspaceId === next.workspaceId && !itemsChanged) next = { ...next, items: old.items };
      current.current = next; setSnapshot(next); setPending(null);
    }
  }, [allWorkspaces, back]);
  useEffect(() => {
    const nextScope = workspaceId ? `${workspaceId}:${allWorkspaces}` : '';
    if (nextScope && previousScope.current && previousScope.current !== nextScope) { back(); setSourceId('all'); }
    if (nextScope) previousScope.current = nextScope;
    current.current = null; setSnapshot(null); setPending(null); setError('');
    if (!open) return;
    let live = true;
    void pull();
    const unsubscribe = window.hangar.inbox.onChanged(() => { void pull(); });
    const refresh = async () => {
      const result = await window.hangar.inbox.refresh({ allWorkspaces, messagingOnly: true });
      if (live && !result.ok) setError(result.error);
    };
    void refresh();
    const timer = setInterval(() => { if (!document.hidden) void refresh(); }, 90_000);
    return () => { live = false; invalidate(); unsubscribe(); clearInterval(timer); };
  }, [pull, allWorkspaces, workspaceId, open, back, invalidate, setSourceId]);
  const sources = snapshot?.sources ?? [];
  const sourceMap = new Map(sources.map((s) => [s.id, s]));
  const chats = useMemo(() => (snapshot?.items ?? []).filter((item) => item.conversationKind === 'direct'
    && snapshot?.sources.some((source) => source.id === item.ref.connectionId && source.canChat)), [snapshot]);
  const filtered = chats.filter((item) => (sourceId === 'all' || item.ref.connectionId === sourceId) && (!unread || item.unread === true)
    && (!query || `${item.title} ${item.preview}`.toLocaleLowerCase().includes(query.toLocaleLowerCase())));
  const selectedSource = selected ? sourceMap.get(selected.ref.connectionId) : undefined;
  const refresh = async () => { setError(''); const r = await window.hangar.inbox.refresh({ allWorkspaces, messagingOnly: true }); if (!r.ok) setError(r.error); };
  const more = async (id: string) => {
    const startedIn = scope.current;
    setError('');
    const result = await window.hangar.inbox.more(id);
    if (scope.current !== startedIn) return;
    if (!result.ok) setError(result.error); else await pull(true);
  };

  return <main className={`inbox ${selected ? 'has-selection' : ''}`}>
    <header className="inbox-top">
      <h1>Chats <span className="inbox-count">{chats.length}</span></h1>
      <div className="inbox-top-actions">
        <label className="inbox-scope"><span className="sr-only">Workspace scope</span><select value={allWorkspaces ? 'all' : 'current'} onChange={(e) => setAllWorkspaces(e.target.value === 'all')}>
          <option value="current">{shell?.workspaces.find((w) => w.id === workspaceId)?.name ?? 'Current workspace'}</option><option value="all">All workspaces</option>
        </select></label>
        <button onClick={() => setShowSources(!showSources)} aria-expanded={showSources}>Connections</button>
        <button onClick={refresh} aria-label="Refresh chats"><Icon name="reload" /></button>
        <button onClick={() => window.hangar.send({ type: 'close-inbox' })}>Back to apps</button>
      </div>
    </header>
    {error && <div className="inbox-error" role="alert">{error}<button onClick={() => setError('')} aria-label="Dismiss error">×</button></div>}
    {showSources && <section className="inbox-connections" aria-label="Chat connections">
      <p>Message connections are separate from signing into app panes. Only readable one-to-one DMs appear in Chats. Gmail remains available to search.</p>
      {sources.map((source) => <ConnectionRow key={source.id} source={source} onError={setError} onDisconnect={back} />)}
      {sources.length === 0 && <button onClick={() => window.hangar.send({ type: 'open-connections' })}>Add your first app</button>}
    </section>}
    <div className="inbox-body">
      <section className="inbox-list" aria-label="Direct conversations" aria-busy={!snapshot}>
        <div className="inbox-filters">
          <label className="inbox-search"><span className="sr-only">Filter loaded conversations</span><input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Find a conversation…" /></label>
          <label><span className="sr-only">App and account</span><select value={sourceId} onChange={(e) => { setSourceId(e.target.value); back(); }}><option value="all">All apps & accounts</option>{sources.filter((s) => s.canChat).map((s) => <option key={s.id} value={s.id}>{s.app} · {s.identity ?? s.label}</option>)}</select></label>
          <button aria-pressed={unread} onClick={() => setUnread(!unread)}>Unread only</button>
        </div>
        <div className="inbox-list-status" role="status">{filtered.length} direct conversation{filtered.length === 1 ? '' : 's'}{sources.some((s) => s.state === 'refreshing') ? ' · Updating…' : ''}{unread ? ' · Unknown read states excluded' : ''}</div>
        {pending && <button className="inbox-new" onClick={() => { current.current = pending; setSnapshot(pending); setPending(null); }}>New activity · Update list</button>}
        {filtered.map((item) => { const source = sourceMap.get(item.ref.connectionId); return <button key={item.id} data-app={appKey(source)} className={`inbox-row ${item.id === selected?.id ? 'selected' : ''}`} aria-pressed={item.id === selected?.id}
          aria-label={`${item.title} ${item.preview || 'Open to load messages'} · ${source?.app} · ${source?.identity ?? source?.label} · ${item.unread === true ? 'Unread' : item.unread === null ? 'Read state unknown' : 'Read'}`}
          onClick={() => { selection.current = item; setSelected(item); }}
          onKeyDown={(event) => { if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); const rows = [...event.currentTarget.closest('.inbox-list')!.querySelectorAll<HTMLButtonElement>('.inbox-row')]; rows[rows.indexOf(event.currentTarget) + (event.key === 'ArrowDown' ? 1 : -1)]?.focus(); } }}>
          <span className="chat-avatar" aria-hidden="true">{initials(item.title)}</span>
          <span className="chat-row-content"><span className="inbox-row-heading"><strong>{item.title}</strong>{item.unread === true && <span className="inbox-dot" aria-label="Unread" />}</span>
          <span className="inbox-row-preview">{item.preview || 'Open to load messages'}</span>
          <span className="inbox-row-meta"><span className="chat-source">{source?.app}</span><span>{source?.identity ?? source?.label}</span></span>
          <span className="inbox-row-meta"><time>{date(item.at)}</time>{item.unread === null && <span>Read state unknown</span>}</span></span>
        </button>; })}
        {snapshot && !filtered.length && <div className="inbox-empty"><Icon name="chat" size={32} /><h2>{query || unread || sourceId !== 'all' ? 'No matching DMs' : 'Your DMs, together'}</h2><p>{sources.some((s) => s.canChat) ? 'Refresh or adjust your filters. Only verified one-to-one conversations appear here.' : 'Connect Slack message access to read your DMs here. WhatsApp and Messenger message connections are still in development; their app panes remain available.'}</p><button onClick={() => setShowSources(true)}>Manage connections</button></div>}
        {sources.filter((s) => s.canChat && s.hasMore).map((s) => <button className="inbox-more" key={s.id} disabled={s.state === 'refreshing'} onClick={() => more(s.id)}>Load more from {s.app} · {s.identity ?? s.label}</button>)}
      </section>
      <section className="inbox-reader" aria-label="Conversation" data-app={appKey(selectedSource)}>
        {selected && selectedSource?.canChat ? <ChatTimeline key={selected.id} item={selected} source={selectedSource} back={back} />
          : <div className="inbox-empty inbox-reader-empty"><Icon name="chat" size={40} /><h2>A little less app switching.</h2><p>One list. Your conversations, in their own colours.<br />Choose a DM to read its messages here.</p></div>}
      </section>
    </div>
    <footer className="inbox-status"><span>{sources.filter((s) => s.canChat).length} message connection{sources.filter((s) => s.canChat).length === 1 ? '' : 's'} · Read only</span><button onClick={() => setShowSources(!showSources)}>Connection status</button></footer>
  </main>;
}

function ConnectionRow({ source, onError, onDisconnect }: { source: InboxSource; onError: (error: string) => void; onDisconnect: () => void }) {
  const [setup, setSetup] = useState(false), [clientId, setClientId] = useState(''), [secret, setSecret] = useState(''), [busy, setBusy] = useState(false);
  // The app catalog id isn't exposed as a credential authority: main rechecks the service kind.
  const supported = source.kind !== 'page' || source.app === 'Gmail' || source.app === 'Slack';
  const gmail = source.kind === 'gmail' || source.app === 'Gmail';
  const connect = async (developer = false) => {
    setBusy(true); onError('');
    const result = await window.hangar.inbox.connect({ serviceId: source.serviceId,
      ...(developer ? { clientId: clientId.trim(), ...(secret ? { clientSecret: secret } : {}) } : {}) });
    setBusy(false); setSecret('');
    if (!result.ok) onError(result.error); else setSetup(false);
  };
  return <div className="inbox-connection">
    <div><strong>{source.app}</strong><span> {source.identity ?? source.label}</span><small>{stateLabel[source.state]}{source.updatedAt ? ` · Updated ${date(source.updatedAt)}` : ''}</small><p>{source.detail}</p></div>
    <div className="inbox-connection-actions">
      <button onClick={() => window.hangar.send({ type: 'focus-service', serviceId: source.serviceId })}>Open {source.app}</button>
      {supported && source.connectConfigured && <button disabled={busy} onClick={() => connect()}>{busy ? 'Waiting for sign-in…' : source.kind === 'page' ? `Connect ${source.app}` : 'Reconnect'}</button>}
      {busy && <button onClick={() => { void window.hangar.inbox.cancelConnect(); }}>Cancel sign-in</button>}
      {source.kind !== 'page' && <button onClick={async () => { const r = await window.hangar.inbox.disconnect(source.id); if (!r.ok) onError(r.error); else onDisconnect(); }}>Disconnect & clear</button>}
    </div>
    {supported && !source.connectConfigured && <p className="inbox-note">Message access is not configured in this build of Hangar. Continue in the app while its connection is being set up.</p>}
    {supported && <details className="inbox-developer" onToggle={(event) => setSetup(event.currentTarget.open)}><summary>Developer connection settings</summary>
    {setup && <form className="inbox-connect-form" onSubmit={(event) => { event.preventDefault(); void connect(true); }}>
      <p>{gmail ? 'Use a Google OAuth Desktop client with the Gmail API enabled. Register your account as a test user while the app is in testing.' : 'Use a Slack public client with PKCE enabled and hangar://oauth/slack as its redirect URL. Sign-in returns to the installed Hangar app.'}</p>
      <label>OAuth client ID<input required autoComplete="off" value={clientId} onChange={(e) => setClientId(e.target.value)} disabled={busy} maxLength={250} /></label>
      {gmail && <label>Desktop client secret (if issued)<input type="password" autoComplete="off" value={secret} onChange={(e) => setSecret(e.target.value)} disabled={busy} maxLength={500} /></label>}
      <p>Continue in your browser to choose the account and grant read access. No send, archive or mark-read permission is requested.</p>
      <button type="submit" disabled={busy || !clientId.trim()}>{busy ? 'Waiting for sign-in…' : 'Continue in browser'}</button>
      {busy && <button type="button" onClick={() => { void window.hangar.inbox.cancelConnect(); }}>Cancel sign-in</button>}
    </form>}</details>}
  </div>;
}
