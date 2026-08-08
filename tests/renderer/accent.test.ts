// Tile accent contrast lifting.
//
// This module had two live bugs and no tests. Both produced *invalid CSS* rather than a wrong
// colour, so the browser silently discarded `--accent` and the tile just looked plain — no error,
// nothing in the console, nothing to notice.

import { describe, it, expect } from 'vitest';
import { brightenForDark } from '../../src/renderer/accent';

/** What the module is ultimately for: readable against the tile background. */
const TILE_BG = '#26262c';

const parse = (hex: string) => [
  parseInt(hex.slice(1, 3), 16),
  parseInt(hex.slice(3, 5), 16),
  parseInt(hex.slice(5, 7), 16),
];

function contrastAgainstTile(hex: string): number {
  const channel = (v: number) => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const lum = (rgb: number[]) =>
    0.2126 * channel(rgb[0]!) + 0.7152 * channel(rgb[1]!) + 0.0722 * channel(rgb[2]!);
  const [hi, lo] = [lum(parse(hex)), lum(parse(TILE_BG))].sort((a, b) => b - a) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

describe('the two bugs this module shipped with', () => {
  // config.ts:colorForHost returns `hsl(<hash> 55% 55%)` for EVERY custom connection, and it flows
  // straight into style={{ '--accent': brightenForDark(svc.color) }}. It used to come back as
  // '#NaNNaN14'.
  it('an hsl() string is never mangled into NaN — this hit every custom connection', () => {
    const out = brightenForDark('hsl(147 55% 55%)');
    expect(out).not.toContain('NaN');
    // Returned untouched: hsl() is valid CSS, so the tile keeps its colour.
    expect(out).toBe('hsl(147 55% 55%)');
  });

  // '#666' is the hardcoded fallback in window.ts state(): color: entry?.color ?? svc.color ?? '#666'
  it('3-digit shorthand expands instead of producing NaN', () => {
    const out = brightenForDark('#666');
    expect(out).not.toContain('NaN');
    expect(out).toMatch(/^#[0-9a-f]{6}$/);
    // #666 is #666666, which is too dark on the tile and must actually be lifted.
    expect(contrastAgainstTile(out)).toBeGreaterThanOrEqual(4.5);
  });
});

describe('contrast lifting', () => {
  it("Slack's brand purple is invisible on the tile and gets lifted", () => {
    // #4A154B against #26262c is 1.07:1 — the reason this module exists. It lifts to #a58aa5 at
    // 4.86:1, but the assertion stays on the threshold rather than the exact value, which is the
    // algorithm's business to change.
    expect(contrastAgainstTile('#4A154B')).toBeLessThan(2);
    expect(contrastAgainstTile(brightenForDark('#4A154B'))).toBeGreaterThanOrEqual(4.5);
  });

  it('a colour already readable is left alone', () => {
    expect(brightenForDark('#ffffff')).toBe('#ffffff');
  });

  it('hue is preserved, so the result still reads as the brand', () => {
    // Lightening blends toward white, so the channel *ordering* must survive.
    const [r, g, b] = parse(brightenForDark('#4A154B'));
    expect(r!).toBeGreaterThan(g!); // red above green, as in the source
    expect(b!).toBeGreaterThan(g!); // blue above green
  });

  it('terminates for pure black rather than looping', () => {
    const out = brightenForDark('#000000');
    expect(out).toMatch(/^#[0-9a-f]{6}$/);
    expect(contrastAgainstTile(out)).toBeGreaterThanOrEqual(4.5);
  });
});

describe('output shape and caching', () => {
  it('always emits valid CSS for any hex input', () => {
    for (const input of ['#4A154B', '#0f0f0f', '#ABCDEF', '#abc', '#FFF', '#000']) {
      expect(brightenForDark(input)).toMatch(/^#[0-9a-f]{6}$|^#[0-9a-fA-F]{3}$/);
      expect(brightenForDark(input)).not.toContain('NaN');
    }
  });

  it('is idempotent — re-lifting an already-lifted colour changes nothing', () => {
    const once = brightenForDark('#4A154B');
    expect(brightenForDark(once)).toBe(once);
  });

  it('the cache is keyed per colour and does not leak between them', () => {
    // A cache keyed on the wrong variable would serve the first call's answer to everyone.
    expect(brightenForDark('#4A154B')).toBe(brightenForDark('#4A154B'));
    expect(brightenForDark('#1a1a2e')).not.toBe(brightenForDark('#4A154B'));
  });

  it('garbage in, garbage out — but never invalid CSS', () => {
    for (const junk of ['', 'transparent', 'var(--x)', 'rgb(1,2,3)', '#12345', 'nothex']) {
      expect(brightenForDark(junk)).not.toContain('NaN');
      expect(brightenForDark(junk)).toBe(junk);
    }
  });
});
