import { useEffect, useMemo, useRef, useState } from 'react';
import { fuzzy } from './fuzzy';
import { useShellState } from './useShellState';

/**
 * The ⌘K command palette — fuzzy jump to a service or workspace.
 *
 * Shares the overlay view with the connection picker (`OverlayRoot` swaps between them), so it
 * inherits the same lifecycle: attached on open, *removed* on close. Never merely hidden — a
 * transparent attached view hit-tests across its whole bounds and would swallow every click.
 *
 * ⌘↵ opens in a new pane rather than replacing the focused one.
 */
export function Palette() {
  const state = useShellState();
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  // OverlayRoot remounts on every open via key={mode}, so state resets itself — only focus needs
  // doing here.
  useEffect(() => inputRef.current?.focus(), []);

  const results = useMemo(() => {
    if (!state) return [];
    const services = state.services
      .filter((s) => fuzzy(query, s.name))
      .map((s) => ({ kind: 'service' as const, id: s.id, label: s.name, hint: 'Open' }));
    const workspaces = state.workspaces
      .filter((w) => fuzzy(query, w.name))
      .map((w) => ({ kind: 'workspace' as const, id: w.id, label: w.name, hint: 'Workspace' }));
    return [...services, ...workspaces];
  }, [state, query]);

  const run = (i: number, newPane: boolean) => {
    const item = results[i];
    if (!item) return;
    if (item.kind === 'workspace') {
      window.hangar.send({ type: 'set-workspace', workspaceId: item.id });
    } else {
      window.hangar.send(
        newPane
          ? { type: 'open-in-new-pane', serviceId: item.id }
          : { type: 'focus-service', serviceId: item.id }
      );
    }
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') return window.hangar.send({ type: 'close-overlay' });
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setIndex((i) => Math.min(i + 1, results.length - 1));
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      setIndex((i) => Math.max(i - 1, 0));
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      run(index, e.metaKey);
    }
  };

  return (
    // Clicking the scrim closes — the overlay is removed from the view tree, restoring clicks.
    <div className="scrim" onClick={() => window.hangar.send({ type: 'close-overlay' })}>
      <div className="palette" onClick={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          className="palette-input"
          placeholder="Jump to a service or workspace…"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setIndex(0);
          }}
          onKeyDown={onKeyDown}
        />
        <ul className="palette-results">
          {results.map((item, i) => (
            <li
              key={`${item.kind}:${item.id}`}
              className={i === index ? 'is-active' : ''}
              onMouseEnter={() => setIndex(i)}
              onClick={(e) => run(i, e.metaKey)}
            >
              <span>{item.label}</span>
              <span className="palette-hint">{item.hint}</span>
            </li>
          ))}
          {results.length === 0 && <li className="palette-empty">No matches</li>}
        </ul>
        <footer className="palette-footer">
          <kbd>↵</kbd> open · <kbd>⌘↵</kbd> open in new pane · <kbd>esc</kbd> dismiss
        </footer>
      </div>
    </div>
  );
}
