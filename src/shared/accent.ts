/**
 * A service's colour, adjusted until it reads against the tile it's drawn on.
 *
 * Brand colours are published for use on white, and several are unreadable on a dark tile —
 * Slack's #4A154B against our #26262c surface is 1.07:1, i.e. invisible. Rather than hand-tune a
 * second hex per catalog entry (which wouldn't cover custom connections or favicon-derived
 * colours), move lightness until the colour clears a contrast target: lighter on a dark tile,
 * darker on a light one.
 *
 * It only ever lifted, and every surface used it in both themes — so on a light tile a colour made
 * *for* white was washed out to 2.5:1. Slack's lifted #a58aa5 on #e7e7ec, where the unmodified
 * purple is 11:1.
 *
 * Hue and saturation are preserved, so the result still reads as the brand. Shared, not renderer
 * code, because main draws the pane's focus ring in the same colour.
 */

import { THEME } from './theme';

export type ColorScheme = 'dark' | 'light';

/**
 * Every tile a colour is drawn on, in each theme: `--tile`, and `--tile-focused` — the lightest of
 * the dark ramp and the darkest of the light one. The colour has to read on all of them. It was
 * adjusted against `--tile` alone, so Slack's lifted #a58aa5 cleared 4.5:1 there and made 4.03:1
 * on the focused tile — the tile you're looking at.
 */
const TILE_BGS: Record<ColorScheme, readonly string[]> = {
  dark: [THEME.dark.tile, THEME.dark.tileFocused],
  light: [THEME.light.tile, THEME.light.tileFocused],
};
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
  const hsl = parseHsl(color);
  if (hsl) return hsl;
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

/**
 * `hsl(147 55% 55%)` or `hsl(147, 55%, 55%)` — what `colorForHost` gives every custom connection.
 * Returned untouched before this, so custom tiles never got a contrast adjustment at all, and the
 * focus ring fell back to grey for them.
 */
function parseHsl(color: string): RGB | null {
  const m = /^hsla?\(\s*(-?[\d.]+)(?:deg)?[\s,]+([\d.]+)%[\s,]+([\d.]+)%/i.exec(color.trim());
  if (!m) return null;
  const h = ((Number(m[1]) % 360) + 360) % 360;
  const s = Math.min(1, Number(m[2]) / 100);
  const l = Math.min(1, Number(m[3]) / 100);
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
  return [f(0) * 255, f(8) * 255, f(4) * 255];
}

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

/** Blend toward black by `amount` (0–1) — keeps hue, lowers lightness. */
const darken = (rgb: RGB, amount: number): RGB => rgb.map((v) => v * (1 - amount)) as RGB;

const cache = new Map<string, string>();

/** Any colour `accentFor` understands, as `#rrggbb`, or null — for native APIs that take only hex. */
export function hexFor(color: string): string | null {
  const rgb = parse(color);
  return rgb ? toHex(rgb) : null;
}

/** The dark theme's adjustment. Kept by name: it is what every existing test asserts. */
export function brightenForDark(color: string): string {
  return accentFor(color, 'dark');
}

export function accentFor(color: string, scheme: ColorScheme): string {
  const key = `${scheme}:${color}`;
  const cached = cache.get(key);
  if (cached) return cached;

  const base = parse(color);
  // Anything we can't read is returned untouched rather than mangled into `#NaN…`. An `hsl()`
  // string is perfectly good CSS — leaving it alone means the tile keeps its colour, just without
  // the contrast lift. Failing open beats emitting a value the browser will discard.
  if (!base) {
    cache.set(key, color);
    return color;
  }
  // TILE_BGS are literals we control, so none can be null — but assert rather than assume.
  const bgs = TILE_BGS[scheme].map(parse);
  if (bgs.some((bg) => !bg)) return color;
  const worst = (rgb: RGB) => Math.min(...bgs.map((bg) => contrast(rgb, bg!)));
  const step = scheme === 'dark' ? lighten : darken;

  let result = base;
  // 5% steps: fine enough that nothing overshoots into pastel, coarse enough to terminate fast.
  // Judged as it will be drawn — rounded to whole channels. Measured before rounding, a colour could
  // clear 4.5:1 by a hair and come out of `toHex` just under it.
  for (let amount = 0; amount <= 1 && worst(result) < TARGET_CONTRAST; amount += 0.05) {
    result = step(base, amount).map(Math.round) as RGB;
  }

  // A colour that was readable as given comes back as given — hex or hsl — rather than rewritten.
  const out = result === base && !color.trim().startsWith('#') ? color : toHex(result);
  cache.set(key, out);
  return out;
}
