import { useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { catalog } from '@shared/catalog';
import { brightenForDark } from './accent';
import { fuzzy } from './fuzzy';
import { useFocusTrap } from './useFocusTrap';
import { useShellState } from './useShellState';

/**
 * The `+` surface. Two jobs: add a catalog service (optionally on a second account), or point
 * Hangar at an arbitrary URL.
 *
 * The account choice is the interesting part. If a provider already has an account, adding
 * Calendar should ride the Google login you already have — but adding a *second* Gmail must not.
 * Both are offered explicitly rather than guessed, because guessing wrong either shows you the
 * wrong mailbox or makes you sign in again for no reason.
 */
export function AddConnection() {
  const trapRef = useFocusTrap<HTMLDivElement>();
  const state = useShellState();
  const [query, setQuery] = useState('');
  const [customOpen, setCustomOpen] = useState(false);

  const [customSeed, setCustomSeed] = useState('');
  const gridRef = useRef<HTMLDivElement>(null);

  // Name first, then everything else someone might type for it: "twitter" for X, "microsoft" for
  // Outlook, "openai" for ChatGPT. Matched per field, not over one joined string, or a subsequence
  // could wander across fields and match nearly anything.
  const results = useMemo(() => {
    const q = query.trim();
    const byName = catalog.filter((entry) => fuzzy(q, entry.name));
    if (!q) return byName;
    const others = catalog.filter(
      (entry) =>
        !byName.includes(entry) &&
        [entry.id, entry.provider, ...(entry.aliases ?? [])].some((field) => fuzzy(q, field)),
    );
    return [...byName, ...others];
  }, [query]);

  // Something typed that matches nothing, and looks like an address: offer it as a website.
  const trimmed = query.trim();
  const looksLikeAddress = /^[^\s]+\.[^\s]{2,}$/.test(trimmed);

  /**
   * Arrow keys across the grid, and down into it from the search field — the picker was mouse-only
   * past the search box. Columns are counted from the layout, since the grid wraps to its width.
   */
  const onGridKey = (e: KeyboardEvent) => {
    const tiles = [...(gridRef.current?.querySelectorAll<HTMLElement>('.grid-tile') ?? [])];
    const at = tiles.indexOf(document.activeElement as HTMLElement);
    if (at === -1) return;
    const columns = Math.max(1, tiles.filter((t) => t.offsetTop === tiles[0]!.offsetTop).length);
    const next = { ArrowRight: at + 1, ArrowLeft: at - 1, ArrowDown: at + columns, ArrowUp: at - columns }[
      e.key as 'ArrowRight' | 'ArrowLeft' | 'ArrowDown' | 'ArrowUp'
    ];
    if (next === undefined) return;
    e.preventDefault();
    if (next < 0) {
      (gridRef.current?.closest('.sheet')?.querySelector('input') as HTMLElement | null)?.focus();
      return;
    }
    tiles[Math.min(next, tiles.length - 1)]?.focus();
  };

  const accountFor = (provider: string) => state?.accounts.find((a) => a.provider === provider);
  // `allServices`, not `services`: the latter is the active workspace only, so a Gmail added in
  // another workspace read as "not added" here and the tile offered a second account — creating a
  // duplicate instead of focusing the one that exists. Accounts are global; this check must be too.
  const existingOf = (catalogId: string) =>
    state?.allServices.filter((s) => s.catalogId === catalogId) ?? [];

  /** What the no-results button does: add an address straight away, or open the form with it. */
  function addTyped() {
    if (looksLikeAddress) {
      const url = trimmed.includes('://') ? trimmed : `https://${trimmed}`;
      let host = trimmed;
      try {
        host = new URL(url).hostname;
      } catch {
        // Falls through to the form, which validates as you type.
      }
      window.hangar.send({ type: 'add-custom-service', name: host, url });
      return;
    }
    setCustomSeed('');
    setCustomOpen(true);
  }

  if (!state) return null;

  return (
    <div className="scrim" onClick={() => window.hangar.send({ type: 'close-overlay' })}>
      <div
        className="sheet"
        // A real dialog: `aria-modal` tells a screen reader the rest of the view is inert, and the
        // trap makes that true for the keyboard too. The overlay is its own WebContentsView, so
        // tabbing out of it lands on nothing at all rather than on a page behind.
        role="dialog"
        aria-modal="true"
        aria-label="Add a connection"
        ref={trapRef}
        onClick={(e) => e.stopPropagation()}
      >
        <input
          autoFocus
          className="palette-input"
          aria-label="Search services"
          placeholder="Search services…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') window.hangar.send({ type: 'close-overlay' });
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              gridRef.current?.querySelector<HTMLElement>('.grid-tile')?.focus();
            }
            // Enter adds the only match, or the address you typed when nothing matches.
            if (e.key === 'Enter') {
              if (results.length === 1) gridRef.current?.querySelector<HTMLElement>('.grid-tile')?.click();
              else if (results.length === 0 && looksLikeAddress) addTyped();
            }
          }}
        />

        {/* Catalog grid. Every tile states which account it will use, because "add" and "open"
            look identical otherwise — see docs/decisions.md #18. */}
        {results.length === 0 && trimmed && (
          <div className="grid-none" role="status">
            <p>Nothing in the catalog called “{trimmed}”.</p>
            <button onClick={addTyped}>
              {looksLikeAddress ? `Add ${trimmed} as a website` : 'Add it as a website by URL…'}
            </button>
          </div>
        )}

        <div className="grid" ref={gridRef} onKeyDown={onGridKey}>
          {results.map((entry) => {
            const account = accountFor(entry.provider);
            const already = existingOf(entry.id);
            const isAdded = already.length > 0;

            return (
              <div key={entry.id} className="grid-item">
                <button
                  className={`grid-tile${isAdded ? ' is-added' : ''}`}
                  style={{ ['--accent' as string]: brightenForDark(entry.color) }}
                  title={
                    [
                      isAdded
                        ? `Already added — go to ${entry.name}`
                        : account
                          ? `Add ${entry.name} using ${account.label}`
                          : `Add ${entry.name}`,
                      entry.caveat,
                    ]
                      .filter(Boolean)
                      .join('\n')
                  }
                  onClick={() =>
                    // Clicking a service you already have should take you to it. Silently adding a
                    // duplicate on the same account looks identical to nothing happening, which is
                    // exactly how this read the first time.
                    window.hangar.send(
                      isAdded
                        ? { type: 'focus-service', serviceId: already[0]!.id }
                        : { type: 'add-service', catalogId: entry.id }
                    )
                  }
                >
                  {/*
                    Guarded: `icon` is optional, and an entry without one requested
                    `hangar-catalog://undefined`, which 404s and left a blank gap. Unlike the rail's
                    ServiceIcon this grid has no fallback of its own, so the "initials covers it"
                    reasoning behind making `icon` optional didn't actually hold here.
                  */}
                  {entry.icon ? (
                    <img
                      className="grid-icon"
                      src={`hangar-catalog://${entry.icon}`}
                      alt=""
                      onError={(e) => (e.currentTarget.style.visibility = 'hidden')}
                    />
                  ) : (
                    <span className="grid-icon grid-initials">{entry.initials}</span>
                  )}
                  <span className="grid-name">{entry.name}</span>
                  <span className="grid-sub">
                    {isAdded
                      ? already.length > 1
                        ? `✓ ${already.length} added`
                        : '✓ added'
                      : account
                        ? `via ${account.label}`
                        : 'new account'}
                  </span>
                  {/* Said on the tile, not just in the tooltip: the whole point is that it is read
                      before the service is added, and a tooltip needs a hover that a click beats. */}
                  {entry.caveat && <span className="grid-caveat">{entry.caveat}</span>}
                </button>
                {account && (
                  <button
                    className="grid-alt"
                    title={`Sign into a different ${entry.name} account`}
                    onClick={() =>
                      window.hangar.send({
                        type: 'add-service',
                        catalogId: entry.id,
                        forceNewAccount: true,
                      })
                    }
                  >
                    + another account
                  </button>
                )}
              </div>
            );
          })}
        </div>

        {customOpen ? (
          <CustomForm initialUrl={customSeed} onCancel={() => setCustomOpen(false)} />
        ) : (
          <button className="sheet-footer-btn" onClick={() => setCustomOpen(true)}>
            Add any website by URL
          </button>
        )}
      </div>
    </div>
  );
}

function CustomForm({ onCancel, initialUrl = '' }: { onCancel: () => void; initialUrl?: string }) {
  const [name, setName] = useState('');
  const [url, setUrl] = useState(initialUrl);

  const host = (() => {
    try {
      return new URL(url.includes('://') ? url : `https://${url}`).hostname;
    } catch {
      return null;
    }
  })();

  const submit = () => {
    if (!host) return;
    window.hangar.send({
      type: 'add-custom-service',
      name: name.trim() || host,
      url: url.includes('://') ? url : `https://${url}`,
    });
  };

  return (
    <div className="custom-form">
      <input
        className="field"
        aria-label="Website address"
        placeholder="example.com"
        value={url}
        autoFocus
        onChange={(e) => setUrl(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && submit()}
      />
      <input
        className="field"
        aria-label="Name"
        placeholder={host ? `Name (default: ${host})` : 'Name'}
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && submit()}
      />
      {/* Said, rather than only disabling Add: a greyed-out button doesn't say what is wrong. */}
      {url.trim() && !host && (
        <p className="hint refused" role="alert">
          That doesn’t look like a web address — try something like example.com
        </p>
      )}
      {/* The single most likely way a custom connection appears broken: it signs in with Google
          or Okta, that host isn't in its allowlist, so its own login opens in Safari instead. */}
      <p className="hint">
        Signs in with Google, Okta or similar? Add that provider's domain under Settings → Allowed
        hosts after adding, or its login will open in your browser instead.
      </p>
      <div className="row">
        <button onClick={submit} disabled={!host}>
          Add {host ?? ''}
        </button>
        <button onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}
