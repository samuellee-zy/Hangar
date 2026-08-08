import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import { restrictToHorizontalAxis, restrictToVerticalAxis } from '@dnd-kit/modifiers';
import {
  SortableContext,
  horizontalListSortingStrategy,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useEffect, useRef } from 'react';
import type { ReactNode } from 'react';

/**
 * Drag-to-reorder for the rail, wrapping dnd-kit.
 *
 * Reordering within the rail is ordinary DOM drag — the rail is one webContents, so dnd-kit works
 * normally here. The KeyboardSensor is the reason for dnd-kit over a hand-rolled solution: space to
 * lift, arrows to move, space to drop, escape to cancel — announced to screen readers — without
 * extra work.
 *
 * Dragging a tile *onto a pane* is a different problem, and used to be listed as impossible: panes
 * are separate webContents and Electron can't drag across that boundary (docs/decisions.md #10).
 * The way through is not to cross it. On a pointer lift, main attaches a transparent view over the
 * whole content area, so the pointer passes from the rail into one other renderer and no further;
 * `main/features/drag-layer.ts` has the rest. From this file's point of view the consequence is
 * narrow but load-bearing: **the release may happen somewhere this renderer cannot see**, so dnd-
 * kit has to be told, or it is left holding a lifted tile with no way to put it down.
 */

const ACTIVATION_DISTANCE = 5; // px — below this a drag is treated as a click

/**
 * Whether a point in this view's coordinates is still over the rail itself.
 *
 * The rail's renderer fills exactly the rail, so its own viewport *is* the rail — there is nothing
 * else to compare against, and nothing to keep in step with main's idea of the geometry.
 */
export function insideRail(
  { x, y }: { x: number; y: number },
  viewport = { width: window.innerWidth, height: window.innerHeight }
): boolean {
  return x >= 0 && y >= 0 && x <= viewport.width && y <= viewport.height;
}

/**
 * The move a release should perform, or null for none.
 *
 * Separate from the event handler because the interesting case can't be reached from a test that
 * drives dnd-kit: `releasedOutside` means the drop belongs to main's pane hit-testing, and moving
 * the tile in the rail as well would act on one gesture twice. `overId` is not enough to tell on
 * its own — `closestCenter` always names *some* tile, however far outside the rail the pointer has
 * gone.
 */
export function moveOnRelease(
  activeId: string,
  overId: string | null,
  releasedOutside: boolean
): { activeId: string; overId: string } | null {
  if (releasedOutside || !overId || overId === activeId) return null;
  return { activeId, overId };
}

export function SortableRailList({
  ids,
  onMove,
  canDropOnPane,
  horizontal = false,
  children,
}: {
  /**
   * Every draggable row, in visual order: top-level tiles, and the members of any folder that is
   * open. Members are in the same list rather than a nested context because a service dragged out
   * of a folder and a service dragged into one are the same gesture, and dnd-kit can only match an
   * `active` to an `over` inside one `SortableContext`.
   */
  ids: string[];
  /** A tile was dropped on another. What that means for the tree is decided in main. */
  onMove: (move: { activeId: string; overId: string }) => void;
  /**
   * Whether this item can be dropped onto a pane. Folders can't — there is nothing to show — so
   * lifting one is an ordinary in-rail move and main is never told about it.
   */
  canDropOnPane?: (id: string) => boolean;
  /**
   * The rail runs as a row on the top and bottom edges.
   *
   * This used to be hardcoded vertical — both the axis modifier and the sorting strategy — so with
   * the rail on top or bottom, **drag was simply broken**: the modifier clamped movement to an axis
   * the tiles didn't lie on, and `closestCenter` ranked candidates by a vertical distance that was
   * always zero. Two of the four rail positions the app advertises.
   */
  horizontal?: boolean;
  children: ReactNode;
}) {
  const sensors = useSensors(
    // Without a distance constraint every click registers as a zero-length drag and the tile
    // stops responding to plain clicks.
    useSensor(PointerSensor, { activationConstraint: { distance: ACTIVATION_DISTANCE } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  // Where the pointer was last seen, in this view's coordinates. Tracked because dnd-kit reports
  // movement relative to the lift, and main needs a position it can translate into the window.
  const pointer = useRef<{ x: number; y: number } | null>(null);
  /** Non-null only while a pointer drag that main knows about is in flight. */
  const flight = useRef<string | null>(null);

  // The release may be one this renderer never sees: whether the pointer events keep coming here
  // after the press or start going to the drag layer is a mouse-capture detail that differs by
  // platform. Main reports the end either way, and the lifted tile is cancelled here. Escape is
  // dnd-kit's own cancel path — it listens for the keydown on the document, and exposes no
  // imperative equivalent to call instead.
  useEffect(
    () =>
      window.hangar.onDragEnded(() => {
        if (!flight.current) return;
        flight.current = null;
        document.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true })
        );
      }),
    []
  );

  // Bound for the whole life of the rail rather than per drag, because the lift itself happens
  // inside a pointermove and a listener added then misses the events already in flight. The guard
  // is what keeps it quiet: no lift, no messages.
  useEffect(() => {
    const onMove = (event: PointerEvent) => {
      if (!flight.current) return;
      pointer.current = { x: event.clientX, y: event.clientY };
      window.hangar.send({ type: 'drag-tile-to', from: 'rail', ...pointer.current });
    };
    window.addEventListener('pointermove', onMove);
    return () => window.removeEventListener('pointermove', onMove);
  }, []);

  const onDragStart = ({ active, activatorEvent }: DragStartEvent) => {
    // Keyboard lifts stay in the rail: the drag layer takes the keyboard focus when it attaches, so
    // an arrow-key reorder would end on the first press.
    if (activatorEvent.type !== 'pointerdown') return;
    const id = String(active.id);
    if (canDropOnPane && !canDropOnPane(id)) return;
    const event = activatorEvent as PointerEvent;
    pointer.current = { x: event.clientX, y: event.clientY };
    flight.current = id;
    window.hangar.send({ type: 'begin-tile-drag', serviceId: id });
  };

  const onDragEnd = ({ active, over }: DragEndEvent) => {
    const point = flight.current ? pointer.current : null;
    if (point) {
      flight.current = null;
      window.hangar.send({ type: 'drop-tile', from: 'rail', ...point });
    }
    const move = moveOnRelease(
      String(active.id),
      over ? String(over.id) : null,
      point !== null && !insideRail(point)
    );
    if (move) onMove(move);
  };

  const onDragCancel = () => {
    if (!flight.current) return;
    flight.current = null;
    window.hangar.send({ type: 'cancel-tile-drag' });
  };

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      modifiers={[horizontal ? restrictToHorizontalAxis : restrictToVerticalAxis]}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragCancel={onDragCancel}
    >
      <SortableContext
        items={ids}
        strategy={horizontal ? horizontalListSortingStrategy : verticalListSortingStrategy}
      >
        {children}
      </SortableContext>
    </DndContext>
  );
}

/** Wraps one tile. Renders via a child function so the tile keeps owning its own markup. */
export function SortableTile({
  id,
  children,
}: {
  id: string;
  children: (props: {
    setNodeRef: (el: HTMLElement | null) => void;
    style: React.CSSProperties;
    handleProps: Record<string, unknown>;
  }) => ReactNode;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id,
  });

  // dnd-kit's keyboard sensor binds Space/Enter to "lift". On the tile itself that shadows plain
  // activation, so a keyboard user could never simply open a service. Pointer listeners stay;
  // keyboard dragging moves behind ⌃Space, leaving Space/Enter to activate as normal.
  const { onKeyDown, ...pointerListeners } = listeners ?? {};
  // `attributes` carries role="button" and tabIndex=0. Spread onto the wrapper — which contains a
  // real <button> — that nests one interactive element inside another: a screen reader announces a
  // button inside a button, and there are two tab stops for one tile. Keep the drag semantics
  // (`aria-roledescription`, `aria-describedby`) and drop the ones that duplicate the child.
  const { role: _role, tabIndex: _tabIndex, ...dragAttributes } = attributes;
  const handleProps = {
    ...dragAttributes,
    ...pointerListeners,
    onKeyDown: (event: React.KeyboardEvent) => {
      if (event.ctrlKey && event.key === ' ') onKeyDown?.(event);
    },
  };

  return (
    <>
      {children({
        setNodeRef,
        style: {
          transform: CSS.Transform.toString(transform),
          transition,
          opacity: isDragging ? 0.4 : undefined,
          zIndex: isDragging ? 1 : undefined,
        },
        handleProps,
      })}
    </>
  );
}
