/**
 * The few colours that something other than the stylesheet has to know: the window behind the
 * views, the pages main builds as data URLs, and the tile that service colours are adjusted
 * against. The same values as `--bg`, `--fg` and `--tile` in styles.css, in both themes —
 * `tests/renderer/theme.test.ts` fails if the two drift apart.
 *
 * They were copied into five places, and a copy is how the window stayed dark behind a light rail.
 */
export const THEME = {
  dark: { bg: '#1b1b1f', fg: '#e8e8ea', tile: '#26262c' },
  light: { bg: '#f4f4f6', fg: '#1b1b1f', tile: '#e7e7ec' },
} as const;
