// The palette main and the in-pane pages share with the stylesheet. They were copies, and a copy is
// how the window stayed dark behind a light rail; this is what keeps them one set of values.

import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { THEME } from '@shared/theme';

const css = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'renderer', 'styles.css'), 'utf8');

/** The first value of `--name` inside `block`. */
const token = (block: string, name: string) =>
  new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{3,8})`).exec(block)?.[1]?.toLowerCase();

const root = css.slice(css.indexOf(':root {'), css.indexOf('}', css.indexOf(':root {')));
const lightStart = css.indexOf('@media (prefers-color-scheme: light)');
const light = css.slice(lightStart, css.indexOf('}', css.indexOf(':root {', lightStart)));

describe('shared/theme.ts matches styles.css', () => {
  for (const [name, key] of [['bg', 'bg'], ['fg', 'fg'], ['tile', 'tile'], ['tile-focused', 'tileFocused']] as const) {
    it(`--${name}, dark`, () => expect(token(root, name)).toBe(THEME.dark[key]));
    it(`--${name}, light`, () => expect(token(light, name)).toBe(THEME.light[key]));
  }
});

describe('the quietest text reads on every tile', () => {
  const lum = (hex: string) => {
    const c = [1, 3, 5]
      .map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
      .map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;
  };
  const contrast = (a: string, b: string) => {
    const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x) as [number, number];
    return (hi + 0.05) / (lo + 0.05);
  };

  // `--muted` is sub-text inside tiles, and a hovered or focused tile is the extreme of the ramp.
  // It cleared the plain tile and made 4.26:1 (dark) and 4.02:1 (light) on a hovered one.
  for (const [scheme, block] of [['dark', root], ['light', light]] as const) {
    it(`--muted on --tile through --tile-focused, ${scheme}`, () => {
      const muted = token(block, 'muted')!;
      for (const surface of ['tile', 'tile-hover', 'tile-visible', 'tile-focused']) {
        expect(contrast(muted, token(block, surface)!), surface).toBeGreaterThanOrEqual(4.5);
      }
    });
  }
});
