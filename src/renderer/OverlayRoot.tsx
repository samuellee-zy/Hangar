import { useEffect, useState } from 'react';
import { AddConnection } from './AddConnection';
import { Palette } from './Palette';
import type { OverlayOpen } from '@shared/types';

/**
 * One WebContentsView serves both overlay surfaces. Main attaches and removes it (never merely
 * hides it — a transparent attached view hit-tests across its whole bounds and would eat every
 * click meant for the panes) and tells us which surface to show.
 *
 * Keyed on mode *and* an open-nonce, so every open remounts — a mode-only key meant reopening
 * the picker reused a stale component with a stale snapshot of the services.
 */
export function OverlayRoot() {
  const [open, setOpen] = useState<OverlayOpen | null>(null);

  useEffect(() => {
    // Pull first: on the very first open the view is still loading when main pushes the mode, so
    // the message lands nowhere and the overlay renders blank while still eating every click.
    // Subscribing afterwards covers switching mode while already open.
    void window.hangar.getOverlayOpen().then((o: OverlayOpen | null) => o && setOpen(o));
    return window.hangar.onOverlayOpen(setOpen);
  }, []);

  if (!open) return null;
  // Keyed on the nonce too: reopening in the same mode must still remount, or the picker keeps the
  // service list it fetched the first time it ever opened.
  const key = `${open.mode}:${open.nonce}`;
  return open.mode === 'connections' ? <AddConnection key={key} /> : <Palette key={key} />;
}
