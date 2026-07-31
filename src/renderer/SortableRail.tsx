import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
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
import type { ReactNode } from 'react';

/**
 * Drag-to-reorder for the rail, wrapping dnd-kit.
 *
 * Only the *top level* reorders here. Dropping a tile onto a pane crosses a webContents boundary,
 * which Electron doesn't support (docs/decisions.md #10), and filing into a folder goes through
 * the right-click menu rather than nested sortable.
 */

/**
 * Reordering within the rail is ordinary DOM drag — the rail is one webContents, so dnd-kit works
 * normally here. Dragging a tile *onto a pane* is a different problem entirely: panes are separate
 * webContents and Electron can't drag across that boundary. See docs/decisions.md #10.
 *
 * The KeyboardSensor is the reason for dnd-kit over a hand-rolled solution: space to lift, arrows
 * to move, space to drop, escape to cancel — announced to screen readers — without extra work.
 */

const ACTIVATION_DISTANCE = 5; // px — below this a drag is treated as a click

/**
 * Moves `from` to `to`, matching dnd-kit's own `arrayMove` semantics.
 *
 * Extracted so it can be tested without a DOM. The order of operations is easy to get wrong: the
 * removal happens first, which shifts every later index down by one, so `to` is interpreted
 * against the *already-shortened* array. That happens to be the behaviour dnd-kit expects — but
 * only by construction, not by accident, so it's pinned by a test.
 */
export function reorder(ids: string[], activeId: string, overId: string): string[] | null {
  const from = ids.indexOf(activeId);
  const to = ids.indexOf(overId);
  // An id that isn't in the list means the rail changed underneath the drag — a service removed
  // from another surface, say. Dropping the reorder is safer than reordering the wrong thing.
  if (from === -1 || to === -1 || from === to) return null;
  const next = [...ids];
  next.splice(to, 0, ...next.splice(from, 1));
  return next;
}

export function SortableRailList({
  ids,
  onReorder,
  horizontal = false,
  children,
}: {
  ids: string[];
  onReorder: (ids: string[]) => void;
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

  const onDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over) return;
    const next = reorder(ids, String(active.id), String(over.id));
    if (next) onReorder(next);
  };

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      modifiers={[horizontal ? restrictToHorizontalAxis : restrictToVerticalAxis]}
      onDragEnd={onDragEnd}
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
