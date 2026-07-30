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

/**
 * Returns null for anything that isn't a hex colour.
 *
 * This used to assume `#RRGGBB` and index blindly, which produced *invalid CSS* for two inputs
 * that occur constantly:
 *
 *   brightenForDark('hsl(147 55% 55%)')  →  '#NaNNaN14'   — every custom connection
 *   brightenForDark('#666')              →  '#6606NaN'    — the state() fallback
 *
 * `colorForHost` emits `hsl(…)` for every custom connection and `'#666'` is the hardcoded fallback
 * in `state()`, so both were live. Nothing complained: `parseInt('hs', 16)` is `NaN`, `NaN < 4.5`
 * is `false` so the contrast loop never ran, and the browser silently dropped the bad `--accent`.
 * The tile just lost its colour.
 */
const parse = (color: string): RGB | null => {
  const h = color.trim().replace(/^#/, '');
  // Expand #abc → #aabbcc. Shorthand is valid CSS and was being read as a truncated 6-digit hex.
  const full = h.length === 3 ? [...h].map((c) => c + c).join('') : h;
  if (!/^[0-9a-fA-F]{6}$/.test(full)) return null;
  return [
    parseInt(full.slice(0, 2), 16),
    parseInt(full.slice(2, 4), 16),
    parseInt(full.slice(4, 6), 16),
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

export function brightenForDark(color: string): string {
  const cached = cache.get(color);
  if (cached) return cached;

  const base = parse(color);
  // Anything we can't read is returned untouched rather than mangled into `#NaN…`. An `hsl()`
  // string is perfectly good CSS — leaving it alone means the tile keeps its colour, just without
  // the contrast lift. Failing open beats emitting a value the browser will discard.
  if (!base) {
    cache.set(color, color);
    return color;
  }
  // TILE_BG is a literal we control, so this cannot be null — but assert rather than assume.
  const bg = parse(TILE_BG);
  if (!bg) return color;

  let result = base;
  // 5% steps: fine enough that nothing overshoots into pastel, coarse enough to terminate fast.
  for (let amount = 0; amount <= 1 && contrast(result, bg) < TARGET_CONTRAST; amount += 0.05) {
    result = lighten(base, amount);
  }

  const out = toHex(result);
  cache.set(color, out);
  return out;
}
