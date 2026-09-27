/**
 * The two facts about window chrome that both sides of the process boundary need: main lays the
 * window out around them, and the rail's renderer leaves room for the traffic lights when they are
 * in it. One definition, so the rail can't clear space for buttons main put somewhere else — which
 * is how a compact top rail ended up with the traffic lights drawn over its first two tiles.
 */

export type RailPosition = 'left' | 'right' | 'top' | 'bottom';

/** macOS traffic lights span this much, and cannot be made smaller. */
export const WINDOW_BUTTON_SPAN = 52;

/** Height of the strip that hosts the traffic lights when the rail can't. */
export const TOP_STRIP = 38;

/**
 * A collapsed compact rail is a strip of icons, wide enough for a 36px tile and its padding.
 *
 * It was briefly a bare chevron with the tiles hidden entirely. That reclaimed the most space and
 * was the worst of the three: switching service became open the rail, click, and the rail is still
 * open, where it had been one click. Chrome's vertical tabs are the reference — collapsed still
 * shows every favicon, so the common action stays a single click and only the labels are traded
 * away.
 */
export const COMPACT_RAIL_SIZE = 48;

/**
 * Whether a compact rail can open into a labelled panel. Only a vertical one: a horizontal rail has
 * no room beside its icons for a name, so "opening" it only made the strip 180px tall — the same
 * icons, centred in a band that took a fifth of the window.
 */
export function railCanExpand(appearance: { compactRail: boolean; railPosition: RailPosition }): boolean {
  return appearance.compactRail && (appearance.railPosition === 'left' || appearance.railPosition === 'right');
}

/** The narrowest the rail gets without a preference change: collapsed, if it's compact. */
export function smallestRailSize(appearance: { railSize: number; compactRail: boolean }): number {
  return appearance.compactRail ? COMPACT_RAIL_SIZE : appearance.railSize;
}

/**
 * Whether the rail holds the traffic lights itself, rather than a strip across the top of the
 * window.
 *
 * - **left**: when the rail is wide enough for the 52pt span. A compact rail never is, and deciding
 *   from the *collapsed* width keeps the answer fixed as it opens and shuts — deciding per-size
 *   would move the traffic lights and drop the strip on every toggle, shunting every pane down the
 *   window and back.
 * - **top**: always, at its left end, the way a toolbar holds them. The span runs *along* a top
 *   rail, so its width is irrelevant; all it needs is the height of the strip it replaces.
 * - **right / bottom**: never. The traffic lights are at the top left, and those rails aren't.
 */
export function railHostsWindowButtons(position: RailPosition, smallest: number): boolean {
  if (position === 'top') return smallest >= TOP_STRIP;
  return position === 'left' && smallest >= WINDOW_BUTTON_SPAN;
}
