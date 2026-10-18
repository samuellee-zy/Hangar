import { useCallback, useEffect, useRef, useState } from 'react';
import type { AiSnapshot, EngineId } from '@shared/ai';
import type { InboxReply } from '@shared/inbox';
import { useShellState } from '../useShellState';
import { Icon } from '../Icon';
import './assistant.css';

export function Assistant() {
  const shell = useShellState();
  const [snapshot, setSnapshot] = useState<AiSnapshot | null>(null);
  const [provider, setProvider] = useState<EngineId>('codex');
  const [selected, setSelected] = useState<string[]>([]);
  const [query, setQuery] = useState('');
  const [includeContext, setIncludeContext] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [loginMode, setLoginMode] = useState<'subscription' | 'console' | 'sso'>('subscription');
  const scope = useRef<string | null>(null), sequence = useRef(0);
  const pull = useCallback(async () => {
    const seq = ++sequence.current;
    const result = await window.hangar.ai.snapshot();
    if (seq !== sequence.current) return;
    if (!result.ok) { setError(result.error); return; }
    const next = result.value, key = JSON.stringify([next.allWorkspaces, next.workspaceId]);
    const ids = next.sources.filter((s) => s.canSearch).map((s) => s.id);
    if (scope.current !== key) { scope.current = key; setSelected(ids.slice(0, 8)); }
    else setSelected((old) => old.filter((id) => ids.includes(id)));
    setSnapshot(next);
  }, []);
  const invalidate = useCallback(() => { sequence.current++; }, []);
  useEffect(() => {
    if (!shell?.aiOpen) return;
    const off = window.hangar.ai.onChanged(() => { void pull(); });
    void pull();
    return () => { invalidate(); off(); };
  }, [shell?.aiOpen, shell?.activeWorkspaceId, pull, invalidate]);
  const act = async (operation: () => Promise<InboxReply<unknown>>) => {
    setBusy(true); setError('');
    try { const r = await operation(); if (!r.ok) setError(r.error); await pull(); }
    catch { setError('The assistant could not complete this action. Try again.'); }
    finally { setBusy(false); }
  };
  const current = snapshot?.providers.find((p) => p.id === provider);
  const run = snapshot?.run, running = run?.state === 'running';
  const locked = busy || running;
  const name = provider === 'codex' ? 'Codex' : 'Claude Code';
  const ready = current?.state === 'ready';
  const selectedSources = snapshot?.sources.filter((s) => selected.includes(s.id) && s.canSearch) ?? [];
  const start = async () => act(async () => {
    const result = await window.hangar.ai.start({ provider, query: query.trim(), sourceIds: selectedSources.map((s) => s.id),
      allWorkspaces: snapshot?.allWorkspaces ?? false, includeContext, consent: true });
    if (result.ok) setQuery('');
    return result;
  });
  const openCitation = (id: string) => { void act(() => window.hangar.ai.openCitation(id)); };
  return <main className="assistant">
    <header className="assistant-header"><div><div className="assistant-eyebrow">CONNECTED KNOWLEDGE</div><h1><Icon name="spark" size={21} /> Ask AI</h1></div>
      <button aria-label="Close assistant" title="Close assistant · Escape" onClick={() => window.hangar.send({ type: 'close-ai' })}><Icon name="close" /></button>
    </header>
    <div className="assistant-scroll" role="region" aria-label="Assistant workspace" tabIndex={0}>
      <p className="assistant-intro">Find the conversation behind a decision.</p>
      {error && <p className="assistant-error" role="alert">{error}</p>}
      <section className="assistant-setup" aria-label="Search setup">
        <label className="assistant-field">AI provider<select value={provider} disabled={locked} onChange={(e) => {
          const next = e.target.value as EngineId;
          void act(async () => { const r = await window.hangar.ai.clear(); if (r.ok) setProvider(next); return r; });
        }}><option value="codex">Codex · ChatGPT sign-in</option><option value="claude">Claude Code</option></select></label>
        <p className="assistant-note">{current?.detail ?? 'Check your runtime to get started.'}</p>
        <div className="assistant-actions">
          <button disabled={locked} onClick={() => void act(() => window.hangar.ai.probe(provider))}>{current?.state === 'unchecked' ? 'Check runtime' : 'Refresh login status'}</button>
          {current?.state === 'sign-in' && <button disabled={locked} onClick={() => void act(() => window.hangar.ai.login(provider, loginMode))}>Sign in to {name}</button>}
          {ready && <button disabled={locked} onClick={() => void act(() => window.hangar.ai.logout(provider))}>Sign out</button>}
        </div>
        {provider === 'claude' && !ready && <label className="assistant-field">Sign-in method<select disabled={locked} value={loginMode} onChange={(e) => setLoginMode(e.target.value as typeof loginMode)}>
          <option value="subscription">Claude subscription</option><option value="console">Anthropic Console</option><option value="sso">Organization SSO</option>
        </select></label>}
        <details className="assistant-sources" open={!run}>
          <summary>Search scope <span>{selectedSources.length} selected</span></summary>
          <label className="assistant-field">Workspace<select disabled={locked} value={snapshot?.allWorkspaces ? 'all' : 'current'} onChange={(e) => void act(() => window.hangar.ai.scope(e.target.value === 'all'))}>
            <option value="current">{snapshot?.allWorkspaces ? 'Current workspace' : snapshot?.workspaceName ?? 'Current workspace'}</option><option value="all">All workspaces</option>
          </select></label>
          <fieldset disabled={locked}><legend>Accounts the assistant may search</legend>
            {snapshot?.sources.map((s) => <label className={`assistant-source ${s.canSearch ? '' : 'unavailable'}`} key={s.id}>
              <input type="checkbox" checked={s.canSearch && selected.includes(s.id)} disabled={!s.canSearch || !selected.includes(s.id) && selected.length >= 8}
                onChange={(e) => setSelected((old) => e.target.checked ? [...old, s.id] : old.filter((id) => id !== s.id))} />
              <span><strong>{s.app}</strong><span>{s.identity ?? s.label}</span>{!s.canSearch && <small>{s.state === 'reconnect' ? 'Reconnect read access in Inbox' : 'History search unavailable'}</small>}</span>
            </label>)}
          </fieldset>
          {!snapshot?.sources.some((s) => s.canSearch) && <p className="assistant-note">Connect Slack or Gmail read access from Inbox to search. Browser sign-in alone does not grant API access.</p>}
          <button onClick={() => window.hangar.send({ type: 'open-inbox' })}>Manage connections in Inbox</button>
        </details>
      </section>
      {snapshot?.context && <label className="assistant-context"><input type="checkbox" checked={includeContext} disabled={locked} onChange={(e) => setIncludeContext(e.target.checked)} />
        <span>Include selected thread<strong>{snapshot.context.title}</strong></span></label>}
      {!run && <section className="assistant-welcome"><h2>Start with a feature or a question</h2><p>The assistant chooses relevant apps within your scope, reads matching threads and brings back sources.</p>
        <button onClick={() => setQuery('What decisions have we made about [feature name], and what is still unresolved?')}>Trace a feature’s decisions <span aria-hidden="true">↗</span></button>
      </section>}
      {run && <section className="assistant-result" aria-label="Search result">
        <div className="assistant-question">{run.query}</div>
        <div className="assistant-run-state" role="status">{running ? run.progress.at(-1) ?? 'Searching…' : run.state === 'complete' ? 'Search complete' : run.state === 'cancelled' ? 'Search stopped' : 'Search failed'}</div>
        <details className="assistant-activity"><summary>Search activity · {run.progress.length} steps</summary><ul>{run.progress.map((p, i) => <li key={i}>{p}</li>)}</ul></details>
        {run.answer && <div className="assistant-answer">{run.answer.split(/(\[S\d+\])/g).map((part, i) => {
          const id = part.slice(1, -1), evidence = run.evidence.find((e) => e.id === id);
          return evidence ? <button key={i} className="assistant-citation" onClick={() => openCitation(id)} title={`${evidence.source} · ${evidence.title}`} aria-label={`Open source ${id}: ${evidence.title}`}>{part}</button> : <span key={i}>{part}</span>;
        })}</div>}
        {run.error && <p className="assistant-error" role="alert">{run.error}</p>}
        {!!run.evidence.length && <details className="assistant-evidence" open={!running}><summary>Sources · {run.evidence.length}</summary>{run.evidence.map((e) => <button key={e.id} onClick={() => openCitation(e.id)}>
          <span className="assistant-source-id">{e.id}</span><span><strong>{e.title}</strong><small>{e.source}</small><small>{e.read ? 'Thread read' : 'Search preview only'} · Retrieved {new Date(e.retrievedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</small></span><Icon name="pop-out" size={13} />
        </button>)}</details>}
        <p className="assistant-note">Results cover the searches shown, not every message. Check original sources for full context.</p>
        {!running && <button disabled={busy} onClick={() => void act(() => window.hangar.ai.clear())}>Clear search</button>}
      </section>}
      <details className="assistant-display"><summary>Panel width</summary><label>Width <input aria-label="Assistant panel width" type="range" min="320" max="600" step="20" value={shell?.preferences.appearance.aiPanelWidth ?? 420}
        onChange={(e) => window.hangar.send({ type: 'set-preference', path: 'appearance.aiPanelWidth', value: Number(e.target.value) })} /></label></details>
    </div>
    <form className="assistant-compose" onSubmit={(e) => { e.preventDefault(); void start(); }}>
      <label htmlFor="assistant-question">{run ? 'Ask a follow-up' : 'Your question'}</label>
      <textarea id="assistant-question" value={query} onChange={(e) => setQuery(e.target.value)} maxLength={4000} rows={3} disabled={locked} placeholder="Give me the decisions and open questions about…" />
      <p className="assistant-disclosure">Searching shares your question and retrieved content from {selectedSources.length} selected account{selectedSources.length === 1 ? '' : 's'} with {name}. Account limits apply.</p>
      {running ? <button className="assistant-submit" type="button" onClick={() => void act(() => window.hangar.ai.cancel())}>Stop search</button>
        : <button className="assistant-submit" type="submit" disabled={busy || !ready || !query.trim() || !selectedSources.length}>Search with {name} <Icon name="arrow-up" /></button>}
    </form>
  </main>;
}
