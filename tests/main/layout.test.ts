// Pane geometry across all four rail positions. Everything here is pure arithmetic, and getting it
// wrong shows up as panes overlapping the rail or uneven gutters — visible but easy to mis-eyeball.
//

import { describe, it, expect } from 'vitest';
import assert from 'node:assert/strict';
import {
  COMPACT_RAIL_SIZE,
  EXPANDED_RAIL_SIZE,
  Layout,
  TOP_STRIP,
  chromeFor,
  contentArea,
  railBounds,
  railSizes,
  windowButtonPosition,
} from '@core/workspace/layout';

const W = 1440;
const H = 900;
const RAIL = 72;
const GUTTER = 6;

const chrome = (pos) => chromeFor(pos, RAIL, GUTTER);
const panesFor = (ids, pos = 'left', w = W, h = H) => {
  const l = new Layout();
  ids.forEach((id) => l.add(id));
  return [...l.bounds(chrome(pos), w, h).values()];
};

describe('chrome and window buttons', () => {
  it('left and top host the window buttons; right and bottom reserve a strip', () => {
    assert.equal(chrome('left').topStrip, 0);
    assert.equal(chrome('top').topStrip, 0);
    assert.equal(chrome('right').topStrip, TOP_STRIP);
    assert.equal(chrome('bottom').topStrip, TOP_STRIP);
  });

  it('window buttons are centred in a left rail and never clip off-window', () => {
    for (const pos of ['left', 'right', 'top', 'bottom']) {
      const { x, y } = windowButtonPosition(chrome(pos));
      assert.ok(x >= 0 && y >= 0, `${pos} places buttons at ${x},${y}`);
      assert.ok(x + 52 <= W, `${pos} keeps the 52pt span on screen`);
    }
    // 72px rail, 52pt span → 10px each side.
    assert.deepEqual(windowButtonPosition(chrome('left')), { x: 10, y: 17 });
  });

  it('A LEFT RAIL NARROWER THAN MACOS 26\'S 60PT SPAN HANDS THE LIGHTS TO THE STRIP', () => {
    // Decided at the classic 52pt, a 56px rail kept them, and macOS 26 drew them over its edge.
    assert.ok(chromeFor('left', 56, GUTTER).topStrip > 0);
    assert.equal(chromeFor('left', 60, GUTTER).topStrip, 0);
  });

  it("CENTRES THE BUTTONS THE OS ACTUALLY DRAWS — macOS 26's are bigger", () => {
    // Laid out for the 52pt span, macOS 26's 60pt one sat 10pt from the rail's left edge and 2pt
    // from its right.
    const tahoe = { span: 60, height: 14 };
    assert.deepEqual(windowButtonPosition(chrome('left'), tahoe), { x: 6, y: 17 });
    // And never off the window, however narrow a hand-edited rail gets.
    assert.ok(windowButtonPosition(chromeFor('left', 56, GUTTER), tahoe).x >= 0);
    // Centred in a top rail's height by the real height, not the old 12pt.
    assert.equal(windowButtonPosition(chromeFor('top', 48, GUTTER), tahoe).y, 17);
  });

  it('A COMPACT TOP RAIL HOLDS THE TRAFFIC LIGHTS ITSELF, centred in its height', () => {
    // It used to hand them to the top strip, like a compact left rail — but a top rail has no strip
    // above it, so they were drawn over its first two tiles.
    const c = chromeFor('top', COMPACT_RAIL_SIZE, GUTTER, COMPACT_RAIL_SIZE);
    assert.equal(c.topStrip, 0);
    const { y } = windowButtonPosition(c);
    const BUTTON_HEIGHT = 12;
    assert.ok(y > 0 && y + BUTTON_HEIGHT < COMPACT_RAIL_SIZE, `y ${y} sits inside the rail`);
    assert.equal(Math.round(y + BUTTON_HEIGHT / 2), COMPACT_RAIL_SIZE / 2);
  });
});

describe('rail bounds per position', () => {
  it('the rail occupies the correct edge and never overlaps the chrome strip', () => {
    assert.deepEqual(railBounds(chrome('left'), W, H), {
      x: 0,
      y: 0,
      width: RAIL,
      height: H,
    });
    assert.deepEqual(railBounds(chrome('right'), W, H), {
      x: W - RAIL,
      y: TOP_STRIP,
      width: RAIL,
      height: H - TOP_STRIP,
    });
    assert.deepEqual(railBounds(chrome('top'), W, H), {
      x: 0,
      y: 0,
      width: W,
      height: RAIL,
    });
    assert.deepEqual(railBounds(chrome('bottom'), W, H), {
      x: 0,
      y: H - RAIL,
      width: W,
      height: RAIL,
    });
  });

  it('content never intersects the rail, in any position', () => {
    for (const pos of ['left', 'right', 'top', 'bottom']) {
      const c = chrome(pos);
      const rail = railBounds(c, W, H);
      const area = contentArea(c, W, H);
      const overlapX = Math.max(
        0,
        Math.min(rail.x + rail.width, area.x + area.width) - Math.max(rail.x, area.x),
      );
      const overlapY = Math.max(
        0,
        Math.min(rail.y + rail.height, area.y + area.height) - Math.max(rail.y, area.y),
      );
      assert.equal(overlapX * overlapY, 0, `${pos}: content overlaps the rail`);
      assert.ok(area.width > 0 && area.height > 0, `${pos}: content area collapsed`);
    }
  });
});

describe('the two thicknesses of a compact rail', () => {
  const compact = (railSize = RAIL) => ({ railSize, compactRail: true });

  it('an ordinary rail has one size, expanded or not', () => {
    for (const expanded of [false, true]) {
      assert.deepEqual(railSizes({ railSize: RAIL, compactRail: false }, expanded), {
        reserved: RAIL,
        rail: RAIL,
      });
    }
  });

  it('A COMPACT RAIL ALONG THE TOP OR BOTTOM NEVER OPENS', () => {
    // Opening puts names beside the icons, and a horizontal rail has no room beside them — it grew
    // into a 180px band of the same icons. Ignored here rather than left to the caller, so a flag
    // still set from a side rail can't do it either.
    for (const railPosition of ['top', 'bottom'] as const) {
      assert.deepEqual(railSizes({ ...compact(), railPosition }, true), {
        reserved: COMPACT_RAIL_SIZE,
        rail: COMPACT_RAIL_SIZE,
      });
    }
    assert.equal(railSizes({ ...compact(), railPosition: 'right' }, true).rail, EXPANDED_RAIL_SIZE);
  });

  it('THE PANES RECLAIM THE SPACE the rail gives up', () => {
    // The reason the redesign is worth having: collapsed, the rail costs a strip of icons and
    // nothing more. An expanded rail that floated over the panes reserved its width permanently.
    assert.deepEqual(railSizes(compact(), false), {
      reserved: COMPACT_RAIL_SIZE,
      rail: COMPACT_RAIL_SIZE,
    });
    assert.deepEqual(railSizes(compact(), true), {
      reserved: EXPANDED_RAIL_SIZE,
      rail: EXPANDED_RAIL_SIZE,
    });
  });

  it('THE OPENED PANEL IS WIDE ENOUGH FOR A NAME, not just a wider strip', () => {
    // The labels are the whole point of opening it, so the opened width is its own constant rather
    // than `railSize` — which is sized for a column of icons and would ellipsise every name.
    assert.ok(EXPANDED_RAIL_SIZE > COMPACT_RAIL_SIZE * 3);
    assert.equal(railSizes(compact(72), true).rail, EXPANDED_RAIL_SIZE);
  });

  it('EXPANDING NEVER MAKES THE RAIL NARROWER than the strip it grew from', () => {
    // `railSize` has a floor of 56 in Settings, but a synced or hand-edited config need not.
    assert.ok(railSizes(compact(20), true).rail >= COMPACT_RAIL_SIZE);
    // And a rail deliberately set wider than the panel keeps its width.
    assert.equal(railSizes(compact(400), true).rail, 400);
  });

  it('A COMPACT RAIL NEVER OVERLAPS THE PANES, open or shut', () => {
    // The property the hover rail did not have. An attached view hit-tests its whole rectangle, so
    // any overlap here is a region of the page that silently refuses clicks.
    for (const pos of ['left', 'right', 'top', 'bottom'] as const) {
      for (const expanded of [false, true]) {
        const sizes = railSizes(compact(), expanded);
        const chrome = chromeFor(pos, sizes.reserved, GUTTER, COMPACT_RAIL_SIZE);
        const area = contentArea(chrome, W, H);
        const rail = railBounds(chrome, W, H);

        const x = Math.max(
          0,
          Math.min(rail.x + rail.width, area.x + area.width) - Math.max(rail.x, area.x),
        );
        const y = Math.max(
          0,
          Math.min(rail.y + rail.height, area.y + area.height) - Math.max(rail.y, area.y),
        );
        assert.equal(
          x * y,
          0,
          `${pos} ${expanded ? 'expanded' : 'collapsed'}: rail is over a pane`,
        );
      }
    }
  });

  it('a right or bottom rail MOVES ITS ORIGIN when it expands', () => {
    // Not cosmetic: `beginTileDrag` translates every rail-relative pointer position through this
    // rectangle, so using the collapsed one would offset the whole drag by the difference.
    for (const [pos, axis] of [
      ['right', 'x'],
      ['bottom', 'y'],
    ] as const) {
      const collapsed = railBounds(chromeFor(pos, COMPACT_RAIL_SIZE, GUTTER), W, H);
      const expanded = railBounds(chromeFor(pos, RAIL, GUTTER), W, H);
      assert.notEqual(expanded[axis], collapsed[axis], `${pos} origin should shift`);
    }
    // Left and top grow away from their origin, which is why this went unnoticed for so long.
    assert.equal(railBounds(chromeFor('left', RAIL, GUTTER), W, H).x, 0);
  });

  it('A RAIL TOO NARROW FOR THE TRAFFIC LIGHTS hands them to the top strip', () => {
    // Centring a 52pt span in the collapsed 30px rail put them at x:-11, off the window entirely.
    // The strip is decided from the *collapsed* width so it doesn't come and go as the rail opens,
    // which would shunt every pane down the window and back on each toggle.
    for (const expanded of [false, true]) {
      const size = railSizes(compact(), expanded).rail;
      const chrome = chromeFor('left', size, GUTTER, COMPACT_RAIL_SIZE);
      assert.ok(chrome.topStrip > 0, `left compact rail (${size}px) should reserve a strip`);
      assert.ok(windowButtonPosition(chrome).x > 0, 'traffic lights must stay on screen');
    }
    // A full-size left rail still hosts them itself.
    assert.equal(chromeFor('left', RAIL, GUTTER).topStrip, 0);
  });
});

describe('pane geometry', () => {
  it('one pane fills the content area inset by a gutter, whatever the rail position', () => {
    for (const pos of ['left', 'right', 'top', 'bottom']) {
      const c = chrome(pos);
      const area = contentArea(c, W, H);
      const [r] = panesFor(['a'], pos);
      assert.deepEqual(
        r,
        {
          x: area.x + GUTTER,
          y: area.y + GUTTER,
          width: area.width - GUTTER * 2,
          height: area.height - GUTTER * 2,
        },
        `wrong for ${pos}`,
      );
    }
  });

  it('two panes are separated by exactly one gutter, in every position', () => {
    for (const pos of ['left', 'right', 'top', 'bottom']) {
      const [p, q] = panesFor(['a', 'b'], pos);
      assert.equal(q.x - (p.x + p.width), GUTTER, `gap wrong for ${pos}`);
    }
  });

  it('outer margins stay even despite an odd remainder', () => {
    const c = chrome('left');
    const area = contentArea(c, 1441, H);
    const rects = panesFor(['a', 'b', 'c'], 'left', 1441);
    assert.equal(rects[0].x, area.x + GUTTER);
    assert.equal(area.x + area.width - (rects[2].x + rects[2].width), GUTTER);
  });

  it('four panes form a 2x2 grid with uniform gutters', () => {
    const rects = panesFor(['a', 'b', 'c', 'd']);
    assert.equal(new Set(rects.map((r) => r.y)).size, 2, 'two distinct rows');
    assert.equal(rects[1].x - (rects[0].x + rects[0].width), GUTTER, 'column gap');
    assert.equal(rects[2].y - (rects[0].y + rects[0].height), GUTTER, 'row gap');
  });

  it('panes never intrude on the rail, in any position or count', () => {
    for (const pos of ['left', 'right', 'top', 'bottom']) {
      const c = chrome(pos);
      const rail = railBounds(c, W, H);
      for (const ids of [['a'], ['a', 'b'], ['a', 'b', 'c'], ['a', 'b', 'c', 'd']]) {
        for (const r of panesFor(ids, pos)) {
          const overlapX = Math.max(
            0,
            Math.min(rail.x + rail.width, r.x + r.width) - Math.max(rail.x, r.x),
          );
          const overlapY = Math.max(
            0,
            Math.min(rail.y + rail.height, r.y + r.height) - Math.max(rail.y, r.y),
          );
          assert.equal(overlapX * overlapY, 0, `${pos} with ${ids.length} panes`);
          assert.ok(r.width > 0 && r.height > 0);
        }
      }
    }
  });

  it('a zero gutter still produces valid, non-overlapping panes', () => {
    const l = new Layout();
    ['a', 'b'].forEach((id) => l.add(id));
    const [p, q] = [...l.bounds(chromeFor('left', RAIL, 0), W, H).values()];
    assert.equal(q.x, p.x + p.width, 'flush, not overlapping');
  });
});

describe('pane lifecycle', () => {
  it('capped at 4 panes — a 5th replaces the focused one', () => {
    const l = new Layout();
    ['a', 'b', 'c', 'd'].forEach((id) => l.add(id));
    l.add('e');
    assert.equal(l.panes.length, 4);
    assert.equal(l.focused()!.serviceId, 'e');
  });

  it('the last pane cannot be closed', () => {
    const l = new Layout();
    l.add('a');
    l.close(l.panes[0].id);
    assert.equal(l.panes.length, 1);
  });

  it('closing the focused pane moves focus to a surviving neighbour', () => {
    const l = new Layout();
    l.add('a');
    l.add('b');
    const focused = l.focusedPaneId;
    l.close(focused!);
    assert.equal(l.panes.length, 1);
    assert.notEqual(l.focusedPaneId, focused);
  });

  it('focus cycles and wraps in both directions', () => {
    const l = new Layout();
    ['a', 'b', 'c'].forEach((id) => l.add(id));
    l.focusedPaneId = l.panes[0].id;
    l.cycleFocus(-1);
    assert.equal(l.focusedPaneId, l.panes[2].id);
    l.cycleFocus(1);
    assert.equal(l.focusedPaneId, l.panes[0].id);
  });

  it('show() replaces the focused pane rather than adding one', () => {
    const l = new Layout();
    l.add('a');
    l.add('b');
    l.show('c');
    assert.equal(l.panes.length, 2);
    assert.deepEqual([...l.visibleServiceIds()], ['a', 'c']);
  });

  it('zero panes yields no bounds rather than dividing by zero', () => {
    assert.equal(new Layout().bounds(chrome('left'), W, H).size, 0);
  });
});

describe('the focus invariant', () => {
  // `show()` and `add()` used to call each other with no base case: full plus no usable focus meant
  // show → add → show until the stack blew, in the main process, freezing the window.
  //
  // Every caller happened to make it unreachable, which is why it survived. These pin the base case
  // directly rather than relying on that continuing to be true — `retargetPane` was one line away
  // from breaking it. Verified by restoring `return this.add(serviceId)` in `show`: both hang.

  const full = () => {
    const l = new Layout();
    ['a', 'b', 'c', 'd'].forEach((id) => l.add(id));
    return l;
  };

  it('A FULL LAYOUT WITH NO FOCUS TERMINATES instead of recursing forever', () => {
    const l = full();
    l.focusedPaneId = null;
    const pane = l.show('e');
    assert.equal(l.panes.length, 4, 'no pane was added');
    assert.equal(pane.serviceId, 'e');
    assert.equal(l.focusedPaneId, pane.id, 'and focus now names a pane that exists');
  });

  it('a full layout whose focus names a DELETED pane terminates too', () => {
    // Not the same case: `focused()` returns undefined for a non-null id that resolves to nothing,
    // so a stale id reaches the identical branch by a different route.
    const l = full();
    l.focusedPaneId = 'a-pane-that-never-existed';
    l.show('e');
    assert.equal(l.panes.length, 4);
    assert.ok(l.focused(), 'focus was repaired rather than left dangling');
  });

  it('add() on a full layout with no focus terminates', () => {
    const l = full();
    l.focusedPaneId = null;
    l.add('e');
    assert.equal(l.panes.length, 4);
  });

  it('dropPane removes the last pane, which close() refuses', () => {
    // The empty state depends on this: with no service left to show, the pane has to go or the
    // window renders a blank rectangle with no explanation.
    const l = new Layout();
    l.add('a');
    l.close(l.panes[0].id);
    assert.equal(l.panes.length, 1, 'close() still refuses');
    l.dropPane(l.panes[0].id);
    assert.equal(l.panes.length, 0);
    assert.equal(l.focusedPaneId, null);
  });

  it('DROPPING THE FOCUSED PANE REPAIRS FOCUS — the invariant retargetPane used to skip', () => {
    // `retargetPane` assigned `layout.panes` directly, bypassing the focus fixup and leaving
    // `focusedPaneId` naming a pane that no longer existed.
    const l = new Layout();
    ['a', 'b'].forEach((id) => l.add(id));
    const dropped = l.focusedPaneId!;
    l.dropPane(dropped);
    assert.notEqual(l.focusedPaneId, dropped);
    assert.ok(l.focused(), 'focus resolves to a live pane');
  });

  it('dropping an unfocused pane leaves focus alone', () => {
    const l = new Layout();
    ['a', 'b'].forEach((id) => l.add(id));
    const focused = l.focusedPaneId;
    l.dropPane(l.panes[0].id);
    assert.equal(l.focusedPaneId, focused);
  });

  it('no removal path can leave focus naming a missing pane', () => {
    // The property behind all of the above, stated once.
    for (const remove of ['close', 'dropPane'] as const) {
      const l = new Layout();
      ['a', 'b', 'c'].forEach((id) => l.add(id));
      for (const pane of [...l.panes]) {
        l[remove](pane.id);
        assert.ok(
          l.focusedPaneId === null || l.find(l.focusedPaneId),
          `${remove} left focus dangling`,
        );
      }
    }
  });
});

describe('maximising a pane', () => {
  const chrome = { railPosition: 'left' as const, railSize: 72, gutter: 6, topStrip: 0 };

  it('ONE PANE FILLS THE AREA; THE OTHERS KEEP THEIR PLACES BUT ARE NOT DRAWN', () => {
    const layout = new Layout();
    const a = layout.add('a');
    const b = layout.add('b');
    const split = layout.bounds(chrome, 1400, 900);
    layout.toggleMaximise();
    const max = layout.bounds(chrome, 1400, 900);
    expect([...max.keys()]).toEqual([b.id]);
    expect(max.get(b.id)!.width).toBeGreaterThan(split.get(b.id)!.width);
    expect(layout.panes.map((p) => p.id)).toEqual([a.id, b.id]);
    expect([...layout.drawnServiceIds()]).toEqual(['b']);
    expect([...layout.visibleServiceIds()].sort(), 'hibernation still sees both').toEqual(['a', 'b']);
  });

  it('cycling focus moves the maximised pane with it; toggling again restores the split', () => {
    const layout = new Layout();
    const a = layout.add('a');
    layout.add('b');
    layout.toggleMaximise();
    layout.cycleFocus(1);
    expect(layout.maximisedPaneId).toBe(a.id);
    layout.toggleMaximise();
    expect(layout.bounds(chrome, 1400, 900).size).toBe(2);
  });

  it('opening another pane, or closing down to one, ends it', () => {
    const layout = new Layout();
    layout.add('a');
    const b = layout.add('b');
    layout.toggleMaximise();
    layout.add('c');
    expect(layout.maximisedPaneId).toBeNull();
    layout.toggleMaximise();
    layout.close(b.id);
    layout.close(layout.panes[1]!.id);
    expect(layout.maximisedPaneId).toBeNull();
  });

  it('with one pane there is nothing to maximise', () => {
    const layout = new Layout();
    layout.add('a');
    layout.toggleMaximise();
    expect(layout.maximisedPaneId).toBeNull();
  });
});

describe('opening beside a pane', () => {
  it('INSERTS NEXT TO THAT PANE, ON THE SIDE OF THE DROP — not always at the end', () => {
    const l = new Layout();
    const a = l.add('a');
    const b = l.add('b');
    l.add('left-of-b', { paneId: b.id, side: 'before' });
    l.add('right-of-a', { paneId: a.id, side: 'after' });
    assert.deepEqual(
      l.panes.map((p) => p.serviceId),
      ['a', 'right-of-a', 'left-of-b', 'b'],
    );
  });
});
