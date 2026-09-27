// The tray glyph. The bug this replaces produced an *empty* image — so the assertions are about
// there being pixels, in the right places, at both resolutions.

import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { TRAY_GLYPH_POINTS, trayGlyphBitmap } from '@main/features/tray-glyph';

const alphaAt = (bitmap: Buffer, scale: number, x: number, y: number): number =>
  bitmap[(y * TRAY_GLYPH_POINTS * scale + x) * 4 + 3];

describe('the tray glyph', () => {
  it('IS NOT EMPTY — the SVG it replaces decoded to nothing and the tray was invisible', () => {
    for (const scale of [1, 2]) {
      const bitmap = trayGlyphBitmap(scale);
      const opaque = [...Array(bitmap.length / 4).keys()].filter((i) => bitmap[i * 4 + 3] > 128);
      assert.ok(opaque.length > 20 * scale * scale, `scale ${scale}: only ${opaque.length} opaque pixels`);
    }
  });

  it('is sized for the 16pt menu bar at 1x and 2x', () => {
    assert.equal(trayGlyphBitmap(1).length, 16 * 16 * 4);
    assert.equal(trayGlyphBitmap(2).length, 32 * 32 * 4);
  });

  it('is black with alpha, as a template image must be', () => {
    const bitmap = trayGlyphBitmap(2);
    for (let i = 0; i < bitmap.length; i += 4) {
      assert.equal(bitmap[i] + bitmap[i + 1] + bitmap[i + 2], 0);
    }
  });

  it('draws the shape: a solid centre, a ring, transparent between them and at the corners', () => {
    const s = 2;
    assert.ok(alphaAt(trayGlyphBitmap(s), s, 16, 16) > 200, 'centre square is filled');
    assert.ok(alphaAt(trayGlyphBitmap(s), s, 16, 4) > 200, 'outline crosses the top edge');
    assert.equal(alphaAt(trayGlyphBitmap(s), s, 16, 8), 0, 'gap between outline and centre');
    assert.equal(alphaAt(trayGlyphBitmap(s), s, 0, 0), 0, 'corner outside the rounded square');
  });

  it('is symmetric, so it sits centred in the menu bar', () => {
    const s = 2;
    const side = TRAY_GLYPH_POINTS * s;
    const bitmap = trayGlyphBitmap(s);
    for (let y = 0; y < side; y++) {
      for (let x = 0; x < side; x++) {
        assert.equal(alphaAt(bitmap, s, x, y), alphaAt(bitmap, s, side - 1 - x, y), `(${x},${y})`);
      }
    }
  });
});
