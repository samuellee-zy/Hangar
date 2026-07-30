/**
 * Brand colours are published for use on white. Several are unreadable on a dark tile — Slack's
 * #4A154B against our #26262c surface is 1.2:1, i.e. invisible. Rather than hand-tune a second
 * hex per catalog entry (which wouldn't cover custom connections or favicon-derived colours),
 * lift lightness until the colour clears a contrast target.
 *
 * Hue and saturation are preserved, so the result still reads as the brand.
 */

const TILE_BG = '#26262c';
const TARGET_CONTRAST = 4.5;

type RGB = [number, number, number];

const parse = (hex: string): RGB => {
  const h = hex.replace('#', '');
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16),
  ];
};

const toHex = ([r, g, b]: RGB) =>
  '#' + [r, g, b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');

const channel = (v: number) => {
  const c = v / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};

const luminance = ([r, g, b]: RGB) =>
  0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);

const contrast = (a: RGB, b: RGB) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
};

/** Blend toward white by `amount` (0–1) — keeps hue, raises lightness. */
const lighten = (rgb: RGB, amount: number): RGB =>
  rgb.map((v) => v + (255 - v) * amount) as RGB;

const cache = new Map<string, string>();

export function brightenForDark(hex: string): string {
  const cached = cache.get(hex);
  if (cached) return cached;

  const base = parse(hex);
  const bg = parse(TILE_BG);

  let result = base;
  // 5% steps: fine enough that nothing overshoots into pastel, coarse enough to terminate fast.
  for (let amount = 0; amount <= 1 && contrast(result, bg) < TARGET_CONTRAST; amount += 0.05) {
    result = lighten(base, amount);
  }

  const out = toHex(result);
  cache.set(hex, out);
  return out;
}
