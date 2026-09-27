// Dragging a rail tile onto a pane — the rail's half.
//
// The feature spent a long time filed as impossible (decisions #10): panes are separate
// webContents, and a drag can't cross that boundary. What it does instead is refuse to decide
// anything in a renderer — the rail reports where the pointer is and main works out what that
// means. So what there is to test here is narrow and entirely about the reporting:
//
//   - a lift is announced, and only for tiles that could actually land in a pane
//   - positions are reported while the pointer is down, and not at any other time
//   - a release outside the rail belongs to main, and must NOT also reorder the rail
//   - a drag that ended somewhere this renderer couldn't see still puts the tile down
//
// That last one is the subtle one. If the release happens over the drag layer, this renderer never
// sees a pointerup, and dnd-kit is left holding a lifted tile forever.

import { describe, it, expect } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Rail } from '../../src/renderer/Rail';
import { insideRail, moveOnRelease } from '../../src/renderer/SortableRail';
import { sent, setShellState, pushDragEnded } from './setup';
import { DEFAULT_PREFERENCES } from '../../src/core/config/preferences';
import type { ServiceView, ShellState, RailItem } from '../../src/shared/types';

const svc = (id: string): ServiceView =>
  ({
    id,
    catalogId: 'gmail',
    name: id,
    accountId: `acct-${id}`,
    notifications: true,
    hibernate: true,
    zoom: 1,
    initials: id.slice(0, 2),
    color: '#4A154B',
    loading: false,
    sleeping: false,
    unread: 0,
  }) as ServiceView;

function state(railItems?: RailItem[]): ShellState {
  const services = [svc('gmail'), svc('slack')];
  return {
    services,
    railItems: railItems ?? services.map((s): RailItem => ({ kind: 'service', id: s.id })),
    allServices: services,
    preferences: DEFAULT_PREFERENCES,
    orphanPartitions: [],
    quarantinedConfigs: [],
    syncStatus: { state: 'off' },
    accounts: [],
    workspaces: [],
    panes: [{ id: 'p1', serviceId: 'gmail' }],
    focusedPaneId: 'p1',
    activeWorkspaceId: 'w',
    railExpanded: false,
    keyboard: { actions: [], reserved: [], passthrough: {} },
  } as ShellState;
}

async function renderRail(s: ShellState = state()) {
  setShellState(s);
  render(<Rail />);
  await act(async () => {});
}

const typesSent = () => sent.map((c) => (c as { type: string }).type);
const ofType = <T,>(type: string): T[] => sent.filter((c) => (c as { type: string }).type === type) as T[];

/**
 * A pointer drag from a tile to `to`, in client coordinates.
 *
 * jsdom reports a 1024×768 window, so anything past that is "outside the rail" as far as
 * `insideRail` is concerned — which is the distinction the reorder suppression turns on.
 */
async function dragTile(name: RegExp, to: { x: number; y: number }, { release = true } = {}) {
  const user = userEvent.setup();
  const tile = screen.getByRole('button', { name });
  await user.pointer([
    { keys: '[MouseLeft>]', target: tile, coords: { clientX: 20, clientY: 20 } },
    { target: tile, coords: { clientX: 20 + 30, clientY: 20 } },
    { target: tile, coords: { clientX: to.x, clientY: to.y } },
  ]);
  if (release) await user.pointer({ keys: '[/MouseLeft]', target: tile, coords: { clientX: to.x, clientY: to.y } });
}

describe('lifting a tile', () => {
  it('tells main a drag has begun once the pointer leaves the rail, naming the service', async () => {
    await renderRail();
    await dragTile(/gmail/i, { x: 2000, y: 300 });
    expect(sent).toContainEqual({ type: 'begin-tile-drag', serviceId: 'gmail' });
  });

  it('A DRAG THAT STAYS IN THE RAIL NEVER INVOLVES MAIN — a relayout there could end it', async () => {
    // Telling main at the lift attached the drag layer for every reorder, and anything that relaid
    // the window out mid-gesture ended the drag: the intermittent CI failure of the folder test.
    await renderRail();
    await dragTile(/gmail/i, { x: 400, y: 300 });
    expect(typesSent()).not.toContain('begin-tile-drag');
    expect(typesSent()).not.toContain('drag-tile-to');
    expect(typesSent()).not.toContain('drop-tile');
  });

  it('reports the pointer position in its own coordinates while dragging', async () => {
    await renderRail();
    await dragTile(/gmail/i, { x: 2000, y: 300 });
    const moves = ofType<{ x: number; y: number; from: string }>('drag-tile-to');
    expect(moves.length).toBeGreaterThan(0);
    // `from` is how main knows which origin to translate against — the rail doesn't know where it
    // sits in the window, and shouldn't have to.
    expect(moves.every((m) => m.from === 'rail')).toBe(true);
    expect(moves.at(-1)).toMatchObject({ x: 2000, y: 300 });
  });

  it('says nothing at all when the pointer moves without a drag', async () => {
    await renderRail();
    const user = userEvent.setup();
    await user.pointer({ target: screen.getByRole('button', { name: /gmail/i }), coords: { clientX: 60, clientY: 60 } });
    expect(typesSent()).not.toContain('drag-tile-to');
    expect(typesSent()).not.toContain('begin-tile-drag');
  });

  it('a folder member is draggable in its own right', async () => {
    // Members used to be inert markup inside the folder's slot, which is why filing a service in or
    // out was menu-only. They are rows of the same sortable list now, so a lift on one behaves
    // exactly like a lift on a top-level tile.
    await renderRail(
      state([
        { kind: 'folder', id: 'f1', name: 'Work', collapsed: false, serviceIds: ['gmail'] },
        { kind: 'service', id: 'slack' },
      ])
    );
    expect(document.querySelectorAll('.rail-slot.is-member')).toHaveLength(1);
    await dragTile(/gmail/i, { x: 2000, y: 300 });
    expect(sent).toContainEqual({ type: 'begin-tile-drag', serviceId: 'gmail' });
  });

  it('a collapsed folder contributes no member rows', async () => {
    await renderRail(
      state([{ kind: 'folder', id: 'f1', name: 'Work', collapsed: true, serviceIds: ['gmail'] }])
    );
    expect(document.querySelectorAll('.rail-slot.is-member')).toHaveLength(0);
  });

  it('never begins a pane drag for a folder — there is nothing to show in a pane', async () => {
    await renderRail(
      state([
        { kind: 'folder', id: 'f1', name: 'Work', collapsed: true, serviceIds: ['gmail'] },
        { kind: 'service', id: 'slack' },
      ])
    );
    await dragTile(/work/i, { x: 400, y: 300 });
    expect(typesSent()).not.toContain('begin-tile-drag');
    expect(typesSent()).not.toContain('drag-tile-to');
  });

  it('a keyboard lift stays in the rail — the drag layer would steal the keyboard', async () => {
    // ⌃Space is the keyboard lift (decisions #25). Attaching the layer focuses it, so an arrow-key
    // reorder would end on the very first press.
    await renderRail();
    screen.getByRole('button', { name: /gmail/i }).focus();
    await userEvent.keyboard('{Control>} {/Control}');
    expect(typesSent()).not.toContain('begin-tile-drag');
  });
});

describe('releasing', () => {
  it('outside the rail, hands the drop to main', async () => {
    await renderRail();
    await dragTile(/gmail/i, { x: 2000, y: 300 });
    expect(sent).toContainEqual({ type: 'drop-tile', from: 'rail', x: 2000, y: 300 });
  });

  // Whether that release *also* reorders is decided by `reorderOnRelease`, tested directly below.
  // It can't be reached through dnd-kit here: jsdom gives every element a zero-sized rect, so
  // `closestCenter` never resolves an `over` and the reorder path is unreachable in this
  // environment — a test that drove the drag would pass whether the rule existed or not.

  it('back inside the rail after leaving it, still tells main so the layer gets detached', async () => {
    // Once main has attached the drag layer, only a message from here takes it down again.
    await renderRail();
    const user = userEvent.setup();
    const gmail = screen.getByRole('button', { name: /gmail/i });
    const slack = screen.getByRole('button', { name: /slack/i });
    await user.pointer([
      { keys: '[MouseLeft>]', target: gmail, coords: { clientX: 20, clientY: 20 } },
      { target: gmail, coords: { clientX: 20, clientY: 60 } },
      { target: gmail, coords: { clientX: 2000, clientY: 60 } },
      { target: slack, coords: { clientX: 20, clientY: 90 } },
      { keys: '[/MouseLeft]', target: slack, coords: { clientX: 20, clientY: 90 } },
    ]);
    expect(typesSent()).toContain('begin-tile-drag');
    expect(typesSent()).toContain('drop-tile');
  });
});

describe('moveOnRelease', () => {
  it('moves a tile for a release that stayed in the rail', () => {
    expect(moveOnRelease('notion', 'gmail', false)).toEqual({
      activeId: 'notion',
      overId: 'gmail',
    });
  });

  it('refuses to move for a release that left the rail, even with a tile named', () => {
    // The whole point: dnd-kit still names the nearest tile when the pointer is 900px away over a
    // pane, and acting on both would move one tile twice for one gesture.
    expect(moveOnRelease('notion', 'gmail', true)).toBeNull();
  });

  it('does nothing when no tile was named, or when it was the tile itself', () => {
    expect(moveOnRelease('notion', null, false)).toBeNull();
    expect(moveOnRelease('notion', 'notion', false)).toBeNull();
  });
});

describe('insideRail', () => {
  const viewport = { width: 48, height: 700 };

  it('accepts a point within the rail and rejects one past its edge', () => {
    expect(insideRail({ x: 20, y: 20 }, viewport)).toBe(true);
    expect(insideRail({ x: 49, y: 20 }, viewport)).toBe(false);
    expect(insideRail({ x: 20, y: 900 }, viewport)).toBe(false);
  });

  it('rejects a negative coordinate — the rail can sit against any edge', () => {
    // With the rail on the right, dragging left produces negative x rather than x past the width.
    expect(insideRail({ x: -5, y: 20 }, viewport)).toBe(false);
  });
});

describe('a drag that ends where this renderer cannot see it', () => {
  it('puts the tile down when main reports the end', async () => {
    // The release landed on the drag layer, so this renderer's pointerup is never coming and
    // dnd-kit would hold the tile lifted forever. `opacity: 0.4` is dnd-kit's own lifted state, so
    // asserting on it is asserting that the drag really ended rather than that we stopped
    // listening to it.
    await renderRail();
    const slot = () => document.querySelector('.rail-slot') as HTMLElement;
    await dragTile(/gmail/i, { x: 2000, y: 300 }, { release: false });
    expect(slot().style.opacity).toBe('0.4');

    await act(async () => pushDragEnded());

    expect(slot().style.opacity).toBe('');
  });

  it('treats a stray release afterwards as nothing, not as a second drop', async () => {
    await renderRail();
    await dragTile(/gmail/i, { x: 2000, y: 300 }, { release: false });
    await act(async () => pushDragEnded());
    sent.length = 0;

    const user = userEvent.setup();
    await user.pointer({
      keys: '[/MouseLeft]',
      target: screen.getByRole('button', { name: /gmail/i }),
      coords: { clientX: 2000, clientY: 300 },
    });
    expect(typesSent()).not.toContain('drop-tile');
  });

  it('does not answer back, so the two processes cannot ping-pong', async () => {
    // Main sends `drag:ended`; if the resulting cancel sent `cancel-tile-drag` back, main would
    // answer that with another `drag:ended`.
    await renderRail();
    await dragTile(/gmail/i, { x: 2000, y: 300 }, { release: false });
    sent.length = 0;
    await act(async () => pushDragEnded());
    expect(typesSent()).not.toContain('cancel-tile-drag');
  });

  it('ignores a report when nothing is in flight', async () => {
    await renderRail();
    await act(async () => pushDragEnded());
    expect(sent).toEqual([]);
  });
});
