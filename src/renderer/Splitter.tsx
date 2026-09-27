import { useEffect, useRef, useState } from 'react';

/**
 * The handle on the gutter between two columns of panes: one of these per boundary, each its own
 * thin view (`main/features/splitters.ts`). Its `index` is in the route, `#splitter-0`.
 *
 * Like the drag layer it decides nothing. It reports the pointer, once a frame, and main moves the
 * panes — and this view with them. Screen coordinates for that reason: a client position would be
 * measured from where this view was, not where it is.
 *
 * Double-click puts every column back to an equal share.
 */
export function Splitter({ index }: { index: number }) {
  const [dragging, setDragging] = useState(false);
  const frame = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current);
    },
    [],
  );

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    // Not a drag, but the press still focused this view: send the keyboard back to the page.
    if (event.button !== 0) {
      window.hangar.send({ type: 'end-split' });
      return;
    }
    event.preventDefault();
    const handle = event.currentTarget;
    handle.setPointerCapture(event.pointerId);
    setDragging(true);
    // Where on the handle it was grabbed, from its centre line — which is where main puts the
    // boundary. Without it the first move jumps the boundary under the pointer by up to half the
    // handle's width.
    const grab = event.clientX - handle.clientWidth / 2;
    let latest = event.screenX;

    const onMove = (move: PointerEvent) => {
      latest = move.screenX;
      if (frame.current !== null) return;
      frame.current = requestAnimationFrame(() => {
        frame.current = null;
        window.hangar.send({ type: 'drag-split', index, screenX: latest - grab });
      });
    };
    const onEnd = () => {
      handle.removeEventListener('pointermove', onMove);
      handle.removeEventListener('pointerup', onEnd);
      handle.removeEventListener('lostpointercapture', onEnd);
      if (frame.current !== null) {
        cancelAnimationFrame(frame.current);
        frame.current = null;
        window.hangar.send({ type: 'drag-split', index, screenX: latest - grab });
      }
      setDragging(false);
      window.hangar.send({ type: 'end-split' });
    };
    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup', onEnd);
    // Also the end of a drag the system took away — a gesture, the window losing the pointer.
    handle.addEventListener('lostpointercapture', onEnd);
  };

  return (
    <div
      className={`splitter${dragging ? ' is-dragging' : ''}`}
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize panes"
      title="Drag to resize · double-click for equal widths"
      onPointerDown={onPointerDown}
      onDoubleClick={() => window.hangar.send({ type: 'reset-splits' })}
    />
  );
}
