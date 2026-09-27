/**
 * Time helpers the renderer and main both need — the tray and Settings offer the same "until
 * tomorrow", and they must agree on when that is.
 */

export const HOUR_MS = 60 * 60 * 1000;

/**
 * 9am tomorrow, local time — what "until tomorrow" means to someone silencing things at 6pm, and
 * also to someone doing it at 1am, who means "until the morning", not "for 32 hours". So before
 * 5am it is 9am *today*.
 */
export function tomorrowMorning(now: number): number {
  const at = new Date(now);
  if (at.getHours() >= 5) at.setDate(at.getDate() + 1);
  at.setHours(9, 0, 0, 0);
  return at.getTime();
}
