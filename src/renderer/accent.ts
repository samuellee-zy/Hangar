import type { CSSProperties } from 'react';
import { accentFor } from '@shared/accent';

export { accentFor, brightenForDark, type ColorScheme } from '@shared/accent';

/**
 * A service's colour for both themes, as custom properties; `.accented` in styles.css picks one.
 *
 * Chosen in CSS rather than here. Picking in JavaScript meant listening for `prefers-color-scheme`
 * to change, and a change that fires no event — a theme emulated in a test, a view that missed the
 * switch — left a tile coloured for the other theme: dark purple initials on a dark tile.
 */
export function accentStyle(colour: string): CSSProperties {
  return {
    ['--accent-dark' as string]: accentFor(colour, 'dark'),
    ['--accent-light' as string]: accentFor(colour, 'light'),
  };
}
