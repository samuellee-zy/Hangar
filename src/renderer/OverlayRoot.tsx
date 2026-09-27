import { useEffect, useState } from 'react';
import { ActivitySheet } from './ActivitySheet';
import { AddConnection } from './AddConnection';
import { Palette } from './Palette';
import { ShortcutSheet } from './ShortcutSheet';
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
    // Same race as useShellState: the pull is async, the subscription isn't, so a mode pushed
    // while the fetch is in flight would be overwritten by the mode it started with — reopening
    // the picker as the palette, or vice versa.
    let pushed = false;
    let live = true;

    void window.hangar.getOverlayOpen().then((o: OverlayOpen | null) => {
      if (o && live && !pushed) setOpen(o);
    });

    const unsubscribe = window.hangar.onOverlayOpen((o: OverlayOpen) => {
      pushed = true;
      setOpen(o);
    });

    return () => {
      live = false;
      unsubscribe();
    };
  }, []);

  if (!open) return null;
  // Keyed on the nonce too: reopening in the same mode must still remount, or the picker keeps the
  // service list it fetched the first time it ever opened.
  const key = `${open.mode}:${open.nonce}`;
  if (open.mode === 'connections') return <AddConnection key={key} />;
  if (open.mode === 'shortcuts') return <ShortcutSheet key={key} />;
  if (open.mode === 'activity') return <ActivitySheet key={key} />;
  return <Palette key={key} />;
}
