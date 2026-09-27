/**
 * The few colours that something other than the stylesheet has to know: the window behind the
 * views, the pages main builds as data URLs, and the tiles that service colours are adjusted
 * against — plain and focused, the lightest and darkest a colour is drawn on. The same values as
 * `--bg`, `--fg`, `--tile` and `--tile-focused` in styles.css, in both themes —
 * `tests/renderer/theme.test.ts` fails if the two drift apart.
 *
 * They were copied into five places, and a copy is how the window stayed dark behind a light rail.
 */
export const THEME = {
  dark: { bg: '#1b1b1f', fg: '#e8e8ea', tile: '#26262c', tileFocused: '#33333c' },
  light: { bg: '#f4f4f6', fg: '#1b1b1f', tile: '#e7e7ec', tileFocused: '#c9c9d2' },
} as const;
