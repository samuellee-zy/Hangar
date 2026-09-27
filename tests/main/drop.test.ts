// Where a dragged tile lands.
//
// This is the half of drag-to-pane that can be tested without a window, and it is the half worth
// testing: the drop target is a rectangle nobody draws until the drag is already happening, so a
// wrong answer here is invisible until someone drops a tile into the wrong pane.

import { describe, it, expect } from 'vitest';
import { contains, dropAt, highlightFor, paneAt, type DropContext } from '../../src/core/workspace/drop';
import { Layout, chromeFor, contentArea } from '../../src/core/workspace/layout';

const CONTENT = { x: 48, y: 0, width: 952, height: 700 };

function context(over: Partial<DropContext> = {}): DropContext {
  return {
    content: CONTENT,
    panes: [
      { paneId: 'a', rect: { x: 58, y: 10, width: 450, height: 680 } },
      { paneId: 'b', rect: { x: 518, y: 10, width: 450, height: 680 } },
    ],
    canOpenNewPane: true,
    ...over,
  };
}

describe('contains', () => {
  const rect = { x: 10, y: 10, width: 100, height: 100 };

  it('includes the top-left corner and excludes the bottom-right', () => {
    // Half-open, so two rectangles sharing an edge can't both claim the same pixel.
    expect(contains(rect, 10, 10)).toBe(true);
    expect(contains(rect, 110, 110)).toBe(false);
    expect(contains(rect, 109, 109)).toBe(true);
  });
});

describe('paneAt', () => {
  it('finds the pane under the point', () => {
    expect(paneAt(context().panes, 100, 100)).toBe('a');
    expect(paneAt(context().panes, 600, 100)).toBe('b');
  });

  it('returns null in the gutter between two panes', () => {
    expect(paneAt(context().panes, 512, 100)).toBeNull();
  });

  it('prefers the last pane where two overlap', () => {
    // Not reachable through Layout.bounds today, which tiles with gutters. Pinned because "the one
    // on top wins" is the rule every other surface follows, and the day splitters land this is
    // where they would disagree.
    const overlapping = [
      { paneId: 'under', rect: { x: 0, y: 0, width: 100, height: 100 } },
      { paneId: 'over', rect: { x: 50, y: 0, width: 100, height: 100 } },
    ];
    expect(paneAt(overlapping, 60, 10)).toBe('over');
  });
});

describe('dropAt', () => {
  it('over the middle of a pane, replaces that pane', () => {
    expect(dropAt(context(), 283, 100)).toEqual({ kind: 'replace', paneId: 'a' });
  });

  it("NEAR A PANE'S EDGE, OPENS BESIDE IT ON THAT SIDE — the gutter was the only way, and 6px", () => {
    // Pane a is 58–508: a quarter in from either edge opens beside it rather than replacing it.
    expect(dropAt(context(), 70, 100)).toEqual({ kind: 'new-pane', beside: { paneId: 'a', side: 'before' } });
    expect(dropAt(context(), 500, 100)).toEqual({ kind: 'new-pane', beside: { paneId: 'a', side: 'after' } });
  });

  it('an edge replaces when there is no room for another pane', () => {
    expect(dropAt(context({ canOpenNewPane: false }), 70, 100)).toEqual({ kind: 'replace', paneId: 'a' });
  });

  it('the preview for an edge is the half of that pane the new one would take', () => {
    const c = context();
    const rect = highlightFor({ kind: 'new-pane', beside: { paneId: 'a', side: 'after' } }, c);
    expect(rect).toEqual({ x: 58 + 225, y: 10, width: 225, height: 680 });
  });

  it('over the rail, does nothing — the content area is the whole target', () => {
    expect(dropAt(context(), 20, 100)).toEqual({ kind: 'none' });
  });

  it('in the gutter, opens alongside', () => {
    expect(dropAt(context(), 512, 100)).toEqual({ kind: 'new-pane' });
  });

  it('in the empty remainder left by one pane, opens alongside', () => {
    const single = context({ panes: [{ paneId: 'a', rect: { x: 58, y: 10, width: 200, height: 680 } }] });
    expect(dropAt(single, 800, 300)).toEqual({ kind: 'new-pane' });
  });

  it('refuses to open alongside when the layout is full', () => {
    // Falling back to `replace` here would swap a pane the user was not pointing at. Refusing is
    // the only answer that can't act on a guess.
    expect(dropAt(context({ canOpenNewPane: false }), 512, 100)).toEqual({ kind: 'none' });
  });
});

describe('highlightFor', () => {
  it('outlines the pane a replace would hit', () => {
    const ctx = context();
    expect(highlightFor({ kind: 'replace', paneId: 'b' }, ctx)).toEqual(ctx.panes[1]!.rect);
  });

  it('outlines the whole content area for a new pane', () => {
    expect(highlightFor({ kind: 'new-pane' }, context())).toEqual(CONTENT);
  });

  it('draws nothing when a release would do nothing', () => {
    expect(highlightFor({ kind: 'none' }, context())).toBeNull();
  });

  it('draws nothing for a pane that has since gone', () => {
    expect(highlightFor({ kind: 'replace', paneId: 'ghost' }, context())).toBeNull();
  });
});

describe('against real Layout geometry', () => {
  // The rectangles above are hand-written for legibility. This is the check that they resemble
  // what the app actually produces — a drop test that agrees only with itself would pass happily
  // while every real drop missed.
  const chrome = chromeFor('left', 48, 10);
  const WIDTH = 1000;
  const HEIGHT = 700;

  function fromLayout(serviceIds: string[]): DropContext {
    const layout = new Layout();
    for (const id of serviceIds) layout.add(id);
    const bounds = layout.bounds(chrome, WIDTH, HEIGHT);
    return {
      content: contentArea(chrome, WIDTH, HEIGHT),
      panes: layout.panes.map((p) => ({ paneId: p.id, rect: bounds.get(p.id)! })),
      canOpenNewPane: !layout.isFull,
    };
  }

  it('every pane centre resolves to its own pane', () => {
    const ctx = fromLayout(['a', 'b', 'c', 'd']);
    for (const { paneId, rect } of ctx.panes) {
      const x = rect.x + rect.width / 2;
      const y = rect.y + rect.height / 2;
      expect(dropAt(ctx, x, y)).toEqual({ kind: 'replace', paneId });
    }
  });

  it('a full 2×2 layout has no new-pane target anywhere', () => {
    const ctx = fromLayout(['a', 'b', 'c', 'd']);
    const kinds = new Set<string>();
    for (let x = ctx.content.x; x < ctx.content.x + ctx.content.width; x += 7) {
      for (let y = ctx.content.y; y < ctx.content.y + ctx.content.height; y += 7) {
        kinds.add(dropAt(ctx, x, y).kind);
      }
    }
    expect(kinds.has('new-pane')).toBe(false);
  });

  it('a single pane leaves the surrounding gutter as open-alongside', () => {
    const ctx = fromLayout(['a']);
    // Inside the content area, in the gutter above the only pane.
    expect(dropAt(ctx, ctx.content.x + 100, ctx.content.y + 2)).toEqual({ kind: 'new-pane' });
  });

  it('the rail strip is never a target', () => {
    const ctx = fromLayout(['a', 'b']);
    for (let y = 0; y < HEIGHT; y += 13) {
      expect(dropAt(ctx, 20, y)).toEqual({ kind: 'none' });
    }
  });
});
