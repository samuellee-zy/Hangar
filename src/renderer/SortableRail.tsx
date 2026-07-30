import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import { restrictToVerticalAxis } from '@dnd-kit/modifiers';
import {
  SortableContext,
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

export function SortableRailList({
  ids,
  onReorder,
  children,
}: {
  ids: string[];
  onReorder: (ids: string[]) => void;
  children: ReactNode;
}) {
  const sensors = useSensors(
    // Without a distance constraint every click registers as a zero-length drag and the tile
    // stops responding to plain clicks.
    useSensor(PointerSensor, { activationConstraint: { distance: ACTIVATION_DISTANCE } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  const onDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return;
    const from = ids.indexOf(String(active.id));
    const to = ids.indexOf(String(over.id));
    if (from === -1 || to === -1) return;
    const next = [...ids];
    next.splice(to, 0, ...next.splice(from, 1));
    onReorder(next);
  };

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      modifiers={[restrictToVerticalAxis]}
      onDragEnd={onDragEnd}
    >
      <SortableContext items={ids} strategy={verticalListSortingStrategy}>
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
  const handleProps = {
    ...attributes,
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
