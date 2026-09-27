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
  for (const [name, key] of [['bg', 'bg'], ['fg', 'fg'], ['tile', 'tile']] as const) {
    it(`--${name}, dark`, () => expect(token(root, name)).toBe(THEME.dark[key]));
    it(`--${name}, light`, () => expect(token(light, name)).toBe(THEME.light[key]));
  }
});
