import { useMemo, useState } from 'react';
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

  const results = useMemo(
    () => catalog.filter((entry) => fuzzy(query, entry.name)),
    [query]
  );

  const accountFor = (provider: string) => state?.accounts.find((a) => a.provider === provider);
  const existingOf = (catalogId: string) =>
    state?.services.filter((s) => s.catalogId === catalogId) ?? [];

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
          placeholder="Search services…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === 'Escape' && window.hangar.send({ type: 'close-overlay' })}
        />

        {/* Catalog grid. Every tile states which account it will use, because "add" and "open"
            look identical otherwise — see docs/decisions.md #18. */}
        <div className="grid">
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
                    isAdded
                      ? `Already added — go to ${entry.name}`
                      : account
                        ? `Add ${entry.name} using ${account.label}`
                        : `Add ${entry.name}`
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
          <CustomForm onCancel={() => setCustomOpen(false)} />
        ) : (
          <button className="sheet-footer-btn" onClick={() => setCustomOpen(true)}>
            Add any website by URL
          </button>
        )}
      </div>
    </div>
  );
}

function CustomForm({ onCancel }: { onCancel: () => void }) {
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');

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
        placeholder="example.com"
        value={url}
        autoFocus
        onChange={(e) => setUrl(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && submit()}
      />
      <input
        className="field"
        placeholder={host ? `Name (default: ${host})` : 'Name'}
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && submit()}
      />
      {/* The single most likely way a custom connection appears broken: it signs in with Google
          or Okta, that host isn't in its allowlist, so its own login opens in Safari instead. */}
      <p className="hint">
        Signs in with Google, Okta or similar? Add that provider's domain under Settings →
        Connections after adding, or its login will open in your browser instead.
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
