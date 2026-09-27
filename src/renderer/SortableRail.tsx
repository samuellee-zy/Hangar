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
import { createContext, useContext, useEffect, useRef, useState } from 'react';
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

/**
 * The one step a keyboard reorder takes: to the neighbour before or after, or nowhere at an end.
 *
 * ⌥↑/⌥↓ (⌥←/→ on a horizontal rail) on a focused tile. dnd-kit's keyboard drag is still there, but
 * it lives behind ⌃Space, which is also macOS's default shortcut for switching input source — so
 * for anyone with two keyboard layouts, reordering from the keyboard simply did not work.
 */
export function keyboardStep(
  ids: string[],
  id: string,
  key: string,
  horizontal: boolean,
): { activeId: string; overId: string } | null {
  const back = horizontal ? 'ArrowLeft' : 'ArrowUp';
  const forward = horizontal ? 'ArrowRight' : 'ArrowDown';
  if (key !== back && key !== forward) return null;
  const i = ids.indexOf(id);
  const j = key === back ? i - 1 : i + 1;
  if (i < 0 || j < 0 || j >= ids.length) return null;
  return { activeId: id, overId: ids[j]! };
}

/** What a tile needs from its list to move itself from the keyboard. */
const RailOrder = createContext<{
  ids: string[];
  horizontal: boolean;
  move: (step: { activeId: string; overId: string }) => void;
} | null>(null);

export function SortableRailList({
  ids,
  onMove,
  canDropOnPane,
  horizontal = false,
  nameOf = (id) => id,
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
  /**
   * A tile's name, for what a screen reader hears. dnd-kit's default announcements read out the
   * draggable's id — a UUID — so a reorder was announced as "Picked up draggable item 3f2a…".
   */
  nameOf?: (id: string) => string;
  children: ReactNode;
}) {
  const [moved, setMoved] = useState('');
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
  /**
   * A tile lifted by the pointer that main hasn't been told about, because the pointer is still
   * inside the rail. Handed over only once it leaves.
   *
   * A reorder or a drop onto a folder never leaves the rail, and telling main at the lift made
   * every one of them depend on main: the drag layer attached and took the keyboard focus, and
   * anything that relaid the window out mid-gesture — a resize, the hibernation sweep, a late
   * `activate` — ended the drag from outside. On CI that was an intermittent "the tile never went
   * into the folder". Now the only drags main can end are the ones that are actually its business.
   */
  const lifted = useRef<string | null>(null);

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
      const point = { x: event.clientX, y: event.clientY };
      if (!flight.current) {
        if (!lifted.current || insideRail(point)) return;
        flight.current = lifted.current;
        lifted.current = null;
        window.hangar.send({ type: 'begin-tile-drag', serviceId: flight.current });
      }
      pointer.current = point;
      window.hangar.send({ type: 'drag-tile-to', from: 'rail', ...point });
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
    lifted.current = id;
  };

  const onDragEnd = ({ active, over }: DragEndEvent) => {
    lifted.current = null;
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
    lifted.current = null;
    if (!flight.current) return;
    flight.current = null;
    window.hangar.send({ type: 'cancel-tile-drag' });
  };

  const keys = horizontal ? 'Option and the left or right arrow' : 'Option and the up or down arrow';
  const name = (id: string | number | undefined) => (id === undefined ? '' : nameOf(String(id)));

  return (
    <RailOrder.Provider
      value={{
        ids,
        horizontal,
        move: (step) => {
          onMove(step);
          const i = ids.indexOf(step.overId);
          const after = i > ids.indexOf(step.activeId);
          setMoved(`${nameOf(step.activeId)} moved ${after ? 'after' : 'before'} ${nameOf(step.overId)}`);
        },
      }}
    >
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        modifiers={[horizontal ? restrictToHorizontalAxis : restrictToVerticalAxis]}
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
        onDragCancel={onDragCancel}
        accessibility={{
          // Says the keys that actually work. The default told you to press Space, which here opens
          // the service — the drag is on ⌃Space, and the simpler reorder is ⌥ and an arrow.
          screenReaderInstructions: {
            draggable:
              `To move this, press ${keys}. To drag it instead, press Control and Space, ` +
              'use the arrow keys, then Space to drop or Escape to cancel.',
          },
          announcements: {
            onDragStart: ({ active }) => `Picked up ${name(active.id)}.`,
            onDragOver: ({ active, over }) =>
              over ? `${name(active.id)} is over ${name(over.id)}.` : `${name(active.id)} is not over anything.`,
            onDragEnd: ({ active, over }) =>
              over ? `${name(active.id)} dropped on ${name(over.id)}.` : `${name(active.id)} dropped.`,
            onDragCancel: ({ active }) => `Moving ${name(active.id)} was cancelled.`,
          },
        }}
      >
        <SortableContext
          items={ids}
          strategy={horizontal ? horizontalListSortingStrategy : verticalListSortingStrategy}
        >
          {children}
        </SortableContext>
      </DndContext>
      <span className="visually-hidden" role="status" aria-live="polite">
        {moved}
      </span>
    </RailOrder.Provider>
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
    /** Another item is being dragged over this one — what a folder shows as "drop here". */
    isOver: boolean;
  }) => ReactNode;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging, isOver, active } =
    useSortable({ id });

  // dnd-kit's keyboard sensor binds Space/Enter to "lift". On the tile itself that shadows plain
  // activation, so a keyboard user could never simply open a service. Pointer listeners stay;
  // keyboard dragging moves behind ⌃Space, leaving Space/Enter to activate as normal.
  const { onKeyDown, ...pointerListeners } = listeners ?? {};
  // `attributes` carries role="button" and tabIndex=0. Spread onto the wrapper — which contains a
  // real <button> — that nests one interactive element inside another: a screen reader announces a
  // button inside a button, and there are two tab stops for one tile. Keep the drag semantics
  // (`aria-roledescription`, `aria-describedby`) and drop the ones that duplicate the child.
  const { role: _role, tabIndex: _tabIndex, ...dragAttributes } = attributes;
  const order = useContext(RailOrder);
  const handleProps = {
    ...dragAttributes,
    ...pointerListeners,
    onKeyDown: (event: React.KeyboardEvent) => {
      if (event.ctrlKey && event.key === ' ') {
        onKeyDown?.(event);
        return;
      }
      // ⌥ and an arrow: one step, no lift. See `keyboardStep`.
      if (order && event.altKey && !event.metaKey && !event.ctrlKey && !event.shiftKey) {
        const arrows = order.horizontal ? ['ArrowLeft', 'ArrowRight'] : ['ArrowUp', 'ArrowDown'];
        if (!arrows.includes(event.key)) return;
        // Stopped even at an end, where there is no step to take: a folder member's wrapper sits
        // inside the folder's, and letting the key bubble would move the folder instead.
        event.preventDefault();
        event.stopPropagation();
        const step = keyboardStep(order.ids, id, event.key, order.horizontal);
        if (step) order.move(step);
      }
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
        isOver: isOver && active?.id !== id,
      })}
    </>
  );
}
