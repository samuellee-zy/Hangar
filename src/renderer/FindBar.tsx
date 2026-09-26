import { useEffect, useRef, useState } from 'react';

/**
 * The find-in-page bar. Lives in its own small view over the top-right of the focused pane rather
 * than in the overlay layer — a full-window transparent view would block clicking and scrolling the
 * page you're searching, which is the one interaction find must leave working.
 *
 * Searching happens in main against the focused pane's webContents; this only collects the query
 * and renders the result count reported back.
 */
export function FindBar() {
  const [query, setQuery] = useState('');
  const [result, setResult] = useState<{ active: number; total: number } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    // Re-focus on every open: the view is reused, so React doesn't remount it.
    const off = window.hangar.onFindOpened(() => {
      setQuery('');
      setResult(null);
      inputRef.current?.focus();
      inputRef.current?.select();
    });
    inputRef.current?.focus();
    return off;
  }, []);

  useEffect(() => window.hangar.onFindResult(setResult), []);

  const search = (next: string, forward = true, findNext = false) =>
    window.hangar.send({ type: 'find', query: next, forward, findNext });

  const close = () => window.hangar.send({ type: 'close-find' });

  return (
    <div className="findbar">
      <input
        ref={inputRef}
        aria-label="Find in page"
        placeholder="Find in page"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          // Live search as you type, matching browser behaviour.
          search(e.target.value, true, false);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') close();
          if (e.key === 'Enter') search(query, !e.shiftKey, true);
        }}
      />
      {/* A status region, so the count is read out as it changes rather than only when found. */}
      <span className="findbar-count" role="status" aria-live="polite">
        {query && result ? (result.total ? `${result.active}/${result.total}` : 'none') : ''}
      </span>
      {/* Glyph-only, so each needs a name of its own: "↑" is not something a screen reader says
          usefully, and `title` is not an accessible name. */}
      <button title="Previous (⇧↵)" aria-label="Previous match" onClick={() => search(query, false, true)}>
        <span aria-hidden="true">↑</span>
      </button>
      <button title="Next (↵)" aria-label="Next match" onClick={() => search(query, true, true)}>
        <span aria-hidden="true">↓</span>
      </button>
      <button title="Close (esc)" aria-label="Close find" onClick={close}>
        <span aria-hidden="true">✕</span>
      </button>
    </div>
  );
}
