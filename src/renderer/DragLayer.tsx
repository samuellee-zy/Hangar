import { useEffect, useState } from 'react';
import type { DropHighlight } from '@shared/types';

/**
 * The drop indicator, drawn over the panes while a rail tile is in flight.
 *
 * This view is only attached between the lift and the release — `main/features/drag-layer.ts` says
 * why it can't stay. It holds no opinion about where the tile would land: it reports the pointer
 * and draws the rectangle main sends back. Deciding here would mean this renderer needed the pane
 * geometry, and would work only on the platforms where the pointer events arrive here at all.
 *
 * The pointer is *already down* when this mounts — the drag started in the rail — so there is no
 * `pointerdown` to wait for, and the release we care about is the first `pointerup` we ever see.
 */
export function DragLayer() {
  const [highlight, setHighlight] = useState<DropHighlight | null>(null);

  useEffect(() => {
    let live = true;
    const off = window.hangar.onDragHighlight((next) => {
      live = false; // anything sent from here on is newer than what the question below returns
      setHighlight(next);
    });
    // Asked as well as listened for: the first highlight can be sent before this is listening.
    void window.hangar.getDragHighlight().then((current) => {
      if (live && current) setHighlight(current);
    });
    return () => {
      live = false;
      off();
    };
  }, []);

  useEffect(() => {
    const send = window.hangar.send;
    const at = (event: PointerEvent) => ({ x: event.clientX, y: event.clientY });

    const onMove = (event: PointerEvent) =>
      send({ type: 'drag-tile-to', from: 'content', ...at(event) });
    const onUp = (event: PointerEvent) => send({ type: 'drop-tile', from: 'content', ...at(event) });
    const onCancel = () => send({ type: 'cancel-tile-drag' });

    // Escape has to work: a drag that can only end by committing is a trap, and this view is
    // covering every pane while it's up.
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onCancel();
    };

    // `pointercancel` as well as `pointerup` — a system gesture, or the window losing the pointer,
    // ends a drag without a release. Main would otherwise leave this view attached, swallowing
    // every click in every pane with nothing on screen to explain why.
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
      window.removeEventListener('keydown', onKey);
    };
  }, []);

  if (!highlight) return null;
  const { rect, kind, label } = highlight;

  return (
    <div
      className={`drop-target${kind === 'new-pane' ? ' is-new-pane' : ''}`}
      style={{ left: rect.x, top: rect.y, width: rect.width, height: rect.height }}
      role="presentation"
    >
      <span className="drop-label">{label ?? (kind === 'new-pane' ? 'Open alongside' : 'Open here')}</span>
    </div>
  );
}
