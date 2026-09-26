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
  /**
   * True when the service occupies a pane. NOT sufficient on its own — see `windowVisible`.
   */
  inVisiblePane: boolean;
  /**
   * Whether the window is actually on screen.
   *
   * Pane occupancy was previously the whole test, with no check of `win.isVisible()`. So with
   * `closeToTray` on, closing the window while Slack held the focused pane discarded **every**
   * Slack message — no banner, no unread, no tray count — because the app believed you were
   * looking at a pane inside a hidden window. Two features silently cancelling each other out.
   */
  windowVisible: boolean;
  /** Per-service notification toggle. Off means neither banner nor count. */
  serviceEnabled: boolean;
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

  // The per-service toggle. This used to gate Web Push but not in-page notifications, so turning
  // notifications off for a service half-worked: pushes stopped, banners kept arriving.
  if (!ctx.serviceEnabled) return { banner: false, count: false };

  // Notifications off entirely is a global mute, same reasoning.
  if (!ctx.enabled) return { banner: false, count: false };

  // Already looking at it: no banner, and nothing unread about a message you can see. Both halves
  // are required — a pane inside a hidden window is not something you are looking at.
  if (ctx.inVisiblePane && ctx.windowVisible) return { banner: false, count: false };

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

/** What `handleNotification` needs, once the wire payload has been made trustworthy. */
export interface NotificationContent {
  title: string;
  body: string;
  silent: boolean;
}

/**
 * Coerces whatever arrived over IPC into something safe to read.
 *
 * The payload is typed as an object at the call site and is not one in practice: it comes from a
 * *page*, through a bridge the preload exposes to the main world, so `__hangar.notify(null)` from
 * any loaded service reaches the main process verbatim. Reading `.title` off that threw a
 * `TypeError` inside an `ipcMain.on` handler, where nothing catches it.
 *
 * Title and body are stringified rather than rejected: a site passing a number is doing something
 * ordinary, and dropping the notification would be a worse answer than showing "3".
 */
export function normaliseNotification(payload: unknown): NotificationContent {
  const source: Record<string, unknown> =
    payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : {};

  const text = (value: unknown): string => {
    if (typeof value === 'string') return value;
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    return '';
  };

  return {
    title: text(source.title),
    body: text(source.body),
    silent: source.silent === true,
  };
}

export { HOUR_MS, tomorrowMorning } from '@shared/time';

/** The quiet periods whose time is up at `now`: whether DND should end, and which mutes. */
export function expiredQuiet(
  config: {
    preferences: { notifications: { dnd: boolean; dndUntil: number | null } };
    services: Array<{ id: string; notificationLevel?: NotificationLevel; mutedUntil?: number }>;
  },
  now: number,
): { dnd: boolean; services: string[] } {
  const { dnd, dndUntil } = config.preferences.notifications;
  return {
    dnd: dnd && dndUntil !== null && now >= dndUntil,
    services: config.services
      .filter((s) => s.notificationLevel === 'muted' && s.mutedUntil !== undefined && now >= s.mutedUntil)
      .map((s) => s.id),
  };
}
