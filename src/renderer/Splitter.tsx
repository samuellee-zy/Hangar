import { useEffect, useRef, useState } from 'react';

/**
 * The handle on the gutter between two columns of panes, or two rows: one of these per boundary,
 * each its own thin view (`main/features/splitters.ts`). Its `index` is in the route, `#splitter-0`
 * or `#splitter-row-0`.
 *
 * Like the drag layer it decides nothing. It reports the pointer, once a frame, and main moves the
 * panes — and this view with them. Screen coordinates for that reason: a client position would be
 * measured from where this view was, not where it is.
 *
 * Double-click puts every pane back to an equal share, across and down.
 */
export function Splitter({ index, axis = 'column' }: { index: number; axis?: 'column' | 'row' }) {
  const across = axis === 'column';
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
    const grab = across ? event.clientX - handle.clientWidth / 2 : event.clientY - handle.clientHeight / 2;
    let latest = across ? event.screenX : event.screenY;
    const report = () =>
      window.hangar.send(
        across
          ? { type: 'drag-split', index, screenX: latest - grab }
          : { type: 'drag-row-split', index, screenY: latest - grab },
      );

    const onMove = (move: PointerEvent) => {
      latest = across ? move.screenX : move.screenY;
      if (frame.current !== null) return;
      frame.current = requestAnimationFrame(() => {
        frame.current = null;
        report();
      });
    };
    const onEnd = () => {
      handle.removeEventListener('pointermove', onMove);
      handle.removeEventListener('pointerup', onEnd);
      handle.removeEventListener('lostpointercapture', onEnd);
      if (frame.current !== null) {
        cancelAnimationFrame(frame.current);
        frame.current = null;
        report();
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
      className={`splitter${across ? '' : ' is-row'}${dragging ? ' is-dragging' : ''}`}
      role="separator"
      // A separator's orientation is the line's: a column boundary is a vertical line.
      aria-orientation={across ? 'vertical' : 'horizontal'}
      aria-label="Resize panes"
      title="Drag to resize · double-click for equal sizes"
      onPointerDown={onPointerDown}
      onDoubleClick={() => window.hangar.send({ type: 'reset-splits' })}
    />
  );
}
