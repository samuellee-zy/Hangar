// Pane geometry across all four rail positions. Everything here is pure arithmetic, and getting it
// wrong shows up as panes overlapping the rail or uneven gutters — visible but easy to mis-eyeball.
//

import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import {
  Layout,
  TOP_STRIP,
  chromeFor,
  contentArea,
  railBounds,
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

describe("chrome and window buttons", () => {

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
});

describe("rail bounds per position", () => {

  it('the rail occupies the correct edge and never overlaps the chrome strip', () => {
    assert.deepEqual(railBounds(chrome('left'), W, H), { x: 0, y: 0, width: RAIL, height: H });
    assert.deepEqual(railBounds(chrome('right'), W, H), {
      x: W - RAIL,
      y: TOP_STRIP,
      width: RAIL,
      height: H - TOP_STRIP,
    });
    assert.deepEqual(railBounds(chrome('top'), W, H), { x: 0, y: 0, width: W, height: RAIL });
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
      const overlapX = Math.max(0, Math.min(rail.x + rail.width, area.x + area.width) - Math.max(rail.x, area.x));
      const overlapY = Math.max(0, Math.min(rail.y + rail.height, area.y + area.height) - Math.max(rail.y, area.y));
      assert.equal(overlapX * overlapY, 0, `${pos}: content overlaps the rail`);
      assert.ok(area.width > 0 && area.height > 0, `${pos}: content area collapsed`);
    }
  });
});

describe("pane geometry", () => {

  it('one pane fills the content area inset by a gutter, whatever the rail position', () => {
    for (const pos of ['left', 'right', 'top', 'bottom']) {
      const c = chrome(pos);
      const area = contentArea(c, W, H);
      const [r] = panesFor(['a'], pos);
      assert.deepEqual(r, {
        x: area.x + GUTTER,
        y: area.y + GUTTER,
        width: area.width - GUTTER * 2,
        height: area.height - GUTTER * 2,
      }, `wrong for ${pos}`);
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
          const overlapX = Math.max(0, Math.min(rail.x + rail.width, r.x + r.width) - Math.max(rail.x, r.x));
          const overlapY = Math.max(0, Math.min(rail.y + rail.height, r.y + r.height) - Math.max(rail.y, r.y));
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

describe("pane lifecycle", () => {

  it('capped at 4 panes — a 5th replaces the focused one', () => {
    const l = new Layout();
    ['a', 'b', 'c', 'd'].forEach((id) => l.add(id));
    l.add('e');
    assert.equal(l.panes.length, 4);
    assert.equal(l.focused().serviceId, 'e');
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
    l.close(focused);
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
