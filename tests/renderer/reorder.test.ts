// Rail drag-to-reorder.
//
// The splice order is easy to get wrong and the failure is silent: tiles land one position off,
// which looks like the drag "not quite working" rather than a bug.

import { describe, it, expect } from 'vitest';
import { reorder } from '../../src/renderer/SortableRail';

const ids = ['a', 'b', 'c', 'd'];

describe('reorder', () => {
  it('moves an item forward, matching dnd-kit arrayMove semantics', () => {
    // Removal happens first, so `to` indexes the already-shortened array. Dragging a onto c means
    // a takes c's slot and b, c shift up.
    expect(reorder(ids, 'a', 'c')).toEqual(['b', 'c', 'a', 'd']);
  });

  it('moves an item backward', () => {
    expect(reorder(ids, 'd', 'b')).toEqual(['a', 'd', 'b', 'c']);
  });

  it('moves to either end', () => {
    expect(reorder(ids, 'd', 'a')).toEqual(['d', 'a', 'b', 'c']);
    expect(reorder(ids, 'a', 'd')).toEqual(['b', 'c', 'd', 'a']);
  });

  it('swaps neighbours in both directions', () => {
    expect(reorder(ids, 'b', 'c')).toEqual(['a', 'c', 'b', 'd']);
    expect(reorder(ids, 'c', 'b')).toEqual(['a', 'c', 'b', 'd']);
  });

  it('a drop onto itself is a no-op, not a reorder', () => {
    expect(reorder(ids, 'b', 'b')).toBeNull();
  });

  it('AN UNKNOWN ID DROPS THE REORDER rather than moving the wrong tile', () => {
    // The rail can change underneath a drag — a service removed from Settings or the context menu
    // while the pointer is down. Reordering against a stale list would move something else.
    expect(reorder(ids, 'gone', 'b')).toBeNull();
    expect(reorder(ids, 'a', 'gone')).toBeNull();
  });

  it('never loses or duplicates an item', () => {
    for (const from of ids) {
      for (const to of ids) {
        const next = reorder(ids, from, to);
        if (!next) continue;
        expect([...next].sort()).toEqual([...ids].sort());
        expect(next).toHaveLength(ids.length);
      }
    }
  });

  it('handles a single-item and an empty rail', () => {
    expect(reorder(['a'], 'a', 'a')).toBeNull();
    expect(reorder([], 'a', 'b')).toBeNull();
  });
});
