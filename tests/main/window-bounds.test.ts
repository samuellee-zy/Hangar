// Whether a restored window can be reached. The failure this guards is silent: the app runs, the
// window exists, and it is somewhere no display shows — which from the chair is indistinguishable
// from "it never opened".

import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import {
  DEFAULT_WINDOW_SIZE,
  centredIn,
  reachableBounds,
  sameBounds,
} from '@core/workspace/window-bounds';

// A 14" MacBook Pro's work area under the notch, and a 27" to its right.
const laptop = { x: 0, y: 38, width: 1512, height: 944 };
const external = { x: 1512, y: 25, width: 2560, height: 1415 };

describe('saved bounds that are still reachable', () => {
  it('a window fully on the laptop is left exactly where it was', () => {
    const saved = { x: 34, y: 40, width: 1200, height: 800 };
    assert.deepEqual(reachableBounds(saved, [laptop], laptop), saved);
  });

  it('a window on the external display stays there while it is connected', () => {
    const saved = { x: 1800, y: 100, width: 1440, height: 940 };
    assert.deepEqual(reachableBounds(saved, [laptop, external], laptop), saved);
  });

  it('a window parked half off the right edge is honoured — its title strip is still reachable', () => {
    const saved = { x: 1100, y: 100, width: 1000, height: 700 };
    assert.deepEqual(reachableBounds(saved, [laptop], laptop), saved);
  });
});

describe('saved bounds that would strand the window', () => {
  it('THE MONITOR WAS UNPLUGGED — a window on it comes back centred on the laptop', () => {
    const saved = { x: 1800, y: 100, width: 1440, height: 940 };
    assert.deepEqual(reachableBounds(saved, [laptop], laptop), centredIn(laptop));
  });

  it('A 1PX SLIVER DOES NOT COUNT — the old any-overlap check accepted this', () => {
    const saved = { x: 1511, y: 100, width: 1200, height: 800 };
    assert.deepEqual(reachableBounds(saved, [laptop], laptop), centredIn(laptop));
  });

  it('a title bar above the top of the display is unreachable even if the body is on it', () => {
    const saved = { x: 100, y: -600, width: 1200, height: 900 };
    assert.deepEqual(reachableBounds(saved, [laptop], laptop), centredIn(laptop));
  });

  it('nonsense from a hand-edited config is treated as no bounds at all', () => {
    for (const saved of [
      { x: Number.NaN, y: 0, width: 800, height: 600 },
      { x: 0, y: 0, width: 0, height: 600 },
      { x: 0, y: 0, width: 800, height: -1 },
    ]) {
      assert.deepEqual(reachableBounds(saved, [laptop], laptop), centredIn(laptop));
    }
  });

  it('no saved bounds opens at the default size, centred', () => {
    const bounds = reachableBounds(undefined, [laptop], laptop);
    assert.equal(bounds.width, DEFAULT_WINDOW_SIZE.width);
    assert.equal(bounds.height, Math.min(DEFAULT_WINDOW_SIZE.height, laptop.height));
    assert.equal(bounds.x, Math.round((laptop.width - bounds.width) / 2));
  });
});

describe('size', () => {
  it('A WINDOW SIZED FOR THE 27" IS SHRUNK TO FIT THE LAPTOP it is restored on', () => {
    // Top-left on-screen, bottom edge and resize handle far below the display.
    const saved = { x: 10, y: 40, width: 2400, height: 1350 };
    const bounds = reachableBounds(saved, [laptop], laptop);
    assert.equal(bounds.x, 10);
    assert.equal(bounds.y, 40);
    assert.equal(bounds.width, laptop.width);
    assert.equal(bounds.height, laptop.height);
  });

  it('centring on a display smaller than the default size fits the display', () => {
    const tiny = { x: 0, y: 25, width: 1024, height: 743 };
    assert.deepEqual(centredIn(tiny), { x: 0, y: 25, width: 1024, height: 743 });
  });
});

describe('sameBounds', () => {
  it('compares all four fields', () => {
    const a = { x: 1, y: 2, width: 3, height: 4 };
    assert.equal(sameBounds(a, { ...a }), true);
    assert.equal(sameBounds(a, { ...a, height: 5 }), false);
  });
});
