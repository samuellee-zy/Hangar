import type { WindowBounds } from '@shared/types';

/**
 * Where the window may open, given where it last was and which displays exist now.
 *
 * Pure, so the question "can the user reach this window?" is testable without a screen. It used to
 * be a private function in AppWindow that accepted any 1px overlap with any display — a window
 * whose last sliver hung onto the edge of a monitor passed, and so did one taller than the screen
 * it was on, with its title bar out of reach above the menu bar.
 */

export const DEFAULT_WINDOW_SIZE = { width: 1440, height: 940 };

/**
 * The part of the window that has to be on a display for it to count as reachable: its top strip,
 * where the traffic lights are and where a drag moves it. Everything else can hang off an edge —
 * people park windows half off-screen on purpose — but without this strip there is no grabbing it.
 */
const TITLE_STRIP_HEIGHT = 40;
const MIN_VISIBLE_WIDTH = 100;

const isFiniteRect = (r: WindowBounds): boolean =>
  [r.x, r.y, r.width, r.height].every(Number.isFinite) && r.width > 0 && r.height > 0;

function overlap(a: WindowBounds, b: WindowBounds): { width: number; height: number } {
  return {
    width: Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x),
    height: Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y),
  };
}

/** Enough of the title strip is on this display to see it and drag it. */
function titleStripOn(bounds: WindowBounds, workArea: WindowBounds): boolean {
  const strip = { ...bounds, height: Math.min(TITLE_STRIP_HEIGHT, bounds.height) };
  const seen = overlap(strip, workArea);
  // Half the strip's height, not all of it: the menu bar is 24px on one display and 37px under a
  // notch, so a window pinned to the top of one reads a few pixels high on the other.
  return seen.width >= Math.min(MIN_VISIBLE_WIDTH, bounds.width) && seen.height >= strip.height / 2;
}

/** The default size, shrunk to fit if need be, in the middle of `workArea`. */
export function centredIn(workArea: WindowBounds, size = DEFAULT_WINDOW_SIZE): WindowBounds {
  const width = Math.min(size.width, workArea.width);
  const height = Math.min(size.height, workArea.height);
  return {
    x: Math.round(workArea.x + (workArea.width - width) / 2),
    y: Math.round(workArea.y + (workArea.height - height) / 2),
    width,
    height,
  };
}

/**
 * `saved` if its title strip is on one of `workAreas`, with its size clamped to that display;
 * otherwise the default size centred on `primary`.
 *
 * The size clamp matters on its own: a window sized for a 27" monitor and restored on a laptop
 * keeps its top-left corner on-screen and its bottom edge, resize handle included, far below it.
 */
export function reachableBounds(
  saved: WindowBounds | undefined,
  workAreas: readonly WindowBounds[],
  primary: WindowBounds,
): WindowBounds {
  if (!saved || !isFiniteRect(saved)) return centredIn(primary);

  const home = workAreas.find((area) => titleStripOn(saved, area));
  if (!home) return centredIn(primary);

  return {
    x: saved.x,
    y: saved.y,
    width: Math.min(saved.width, home.width),
    height: Math.min(saved.height, home.height),
  };
}

export const sameBounds = (a: WindowBounds, b: WindowBounds): boolean =>
  a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
