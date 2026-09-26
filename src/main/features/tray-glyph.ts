/**
 * The menu-bar glyph, as raw pixels.
 *
 * It used to be an SVG handed to `nativeImage.createFromDataURL`. `nativeImage` decodes PNG and
 * JPEG and nothing else, so the result was an empty image, and with no unread the tray's title is
 * `''` too — a zero-width menu-bar item. The tray existed, had a menu, and could not be seen or
 * clicked: the one route back to a hidden window was invisible (decision #96).
 *
 * Rasterised here rather than shipped as PNGs, so there is still no asset to keep in step with the
 * artwork and nothing that differs between `npm run dev` and a packaged build. The shape is a
 * rounded-square outline around a smaller filled rounded square — the same drawing the SVG was —
 * evaluated as signed distances, which gives antialiased edges at any scale for a few lines of
 * arithmetic. No Electron import, so it is testable under plain node.
 */

/** macOS menu-bar extras are drawn on a 16pt canvas. */
export const TRAY_GLYPH_POINTS = 16;

interface RoundedSquare {
  x: number;
  y: number;
  size: number;
  radius: number;
}

const OUTLINE: RoundedSquare = { x: 2, y: 2, size: 12, radius: 3 };
const OUTLINE_STROKE = 1.6;
const CORE: RoundedSquare = { x: 5, y: 5, size: 6, radius: 1.5 };

/** Signed distance from a point to a rounded square, in points: negative inside, positive outside. */
function distanceTo(px: number, py: number, shape: RoundedSquare): number {
  const half = shape.size / 2;
  const qx = Math.abs(px - (shape.x + half)) - (half - shape.radius);
  const qy = Math.abs(py - (shape.y + half)) - (half - shape.radius);
  const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0));
  const inside = Math.min(Math.max(qx, qy), 0);
  return outside + inside - shape.radius;
}

/** How much of a pixel a shape covers, from its signed distance — a one-pixel-wide ramp. */
const coverage = (distance: number, scale: number): number =>
  Math.min(1, Math.max(0, 0.5 - distance * scale));

/**
 * A `TRAY_GLYPH_POINTS * scale` square bitmap, 4 bytes per pixel, for `nativeImage.createFromBitmap`.
 *
 * Black with alpha, because it is a template image: macOS uses only the alpha and paints it in the
 * menu bar's own colour. Black also makes the channel order and premultiplication moot — BGRA or
 * RGBA, premultiplied or not, zero is zero.
 */
export function trayGlyphBitmap(scale: number): Buffer {
  const side = TRAY_GLYPH_POINTS * scale;
  const pixels = Buffer.alloc(side * side * 4);

  for (let y = 0; y < side; y++) {
    for (let x = 0; x < side; x++) {
      const px = (x + 0.5) / scale;
      const py = (y + 0.5) / scale;
      const ring = Math.abs(distanceTo(px, py, OUTLINE)) - OUTLINE_STROKE / 2;
      const alpha = Math.max(coverage(ring, scale), coverage(distanceTo(px, py, CORE), scale));
      pixels[(y * side + x) * 4 + 3] = Math.round(alpha * 255);
    }
  }
  return pixels;
}
