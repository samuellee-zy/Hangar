/**
 * Decides what a notification does. Pure, so the policy can be tested without windows or a
 * notification centre.
 *
 * The distinction that matters: **suppressing the banner is not the same as ignoring the event.**
 * Do Not Disturb should stop the interruption while still counting the message, or you come back
 * from a focus session to a badge of zero and no idea anything happened. Muting a service is the
 * opposite — you asked not to care, so it doesn't count either.
 */

export type NotificationLevel = 'all' | 'muted';

export interface NotifyContext {
  /** Global toggle. */
  enabled: boolean;
  /** Global Do Not Disturb. */
  dnd: boolean;
  /** Per-service. */
  level: NotificationLevel;
  /** True when the service is on screen — no point interrupting you about what you're looking at. */
  visible: boolean;
}

export interface NotifyDecision {
  /** Show a native banner. */
  banner: boolean;
  /** Add to the unread count. */
  count: boolean;
}

export function decideNotification(ctx: NotifyContext): NotifyDecision {
  // Muted means "I don't care about this service" — neither banner nor badge.
  if (ctx.level === 'muted') return { banner: false, count: false };

  // Notifications off entirely is a global mute, same reasoning.
  if (!ctx.enabled) return { banner: false, count: false };

  // Already looking at it: no banner, and nothing unread about a message you can see.
  if (ctx.visible) return { banner: false, count: false };

  // DND silences the interruption but keeps the tally, so nothing is lost while you focus.
  if (ctx.dnd) return { banner: false, count: true };

  return { banner: true, count: true };
}

/**
 * Unread is cleared by *looking* at a service, not by dismissing a banner — matching how the
 * underlying web apps behave, and the only signal we reliably have.
 */
export function nextUnread(current: number, decision: NotifyDecision): number {
  return decision.count ? current + 1 : current;
}

/** macOS shows no badge at 0, so the dock call has to be given exactly 0 rather than skipped. */
export function badgeTotal(unreadPerService: number[]): number {
  return unreadPerService.reduce((sum, n) => sum + Math.max(0, n), 0);
}
