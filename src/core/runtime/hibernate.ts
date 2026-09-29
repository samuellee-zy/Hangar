/**
 * Decides which services are due to be unloaded.
 *
 * Pure so it can be tested without Electron — the decision is the part worth pinning, not the
 * teardown. Getting it wrong either wastes memory (never sleeps) or, much worse, unloads something
 * you're looking at.
 *
 * The rules, in order of precedence:
 *   1. Never sleep a service that's on screen. Obvious, but it's the one that would be catastrophic.
 *   2. Never sleep one that's busy — in a call, or playing sound. Off screen isn't idle: a huddle
 *      runs in its own window with the pane long gone, and music plays with no pane at all.
 *   3. Never sleep one the user opted out of.
 *   4. Never sleep when the timeout is 0 — that's the "off" setting.
 *   5. Otherwise sleep anything idle longer than the timeout.
 */

export interface HibernationCandidate {
  serviceId: string;
  /** Currently occupying a pane. */
  visible: boolean;
  /** Already unloaded — no view exists. */
  sleeping: boolean;
  /** Per-service opt-out. */
  hibernate: boolean;
  /** In a call or playing sound: unloading it would end what you're in the middle of. */
  busy: boolean;
  /** Epoch ms when this service was last visible or interacted with. */
  lastActiveAt: number;
}

/**
 * Whether a service stays loaded off screen: its own "Keep running", or "Keep every service
 * running". One answer for the three places that ask — loading at launch, the idle sweep, and
 * "Sleep background services" — which each read `svc.keepRunning` on their own before.
 */
export const keepsRunning = (
  svc: { keepRunning?: boolean },
  behaviour: { keepAllRunning: boolean },
): boolean => behaviour.keepAllRunning || svc.keepRunning === true;

export function servicesToHibernate(
  candidates: HibernationCandidate[],
  timeoutMinutes: number,
  now: number
): string[] {
  if (timeoutMinutes <= 0) return [];
  const cutoff = now - timeoutMinutes * 60_000;

  return candidates
    .filter((c) => !c.visible && !c.sleeping && !c.busy && c.hibernate && c.lastActiveAt <= cutoff)
    .map((c) => c.serviceId);
}

/**
 * Time the machine spent asleep is not time you spent ignoring a service.
 *
 * Idle is wall-clock distance from `lastActiveAt`, which is right while the machine is awake and
 * wrong the moment it isn't: shut the lid at a 30-minute timeout and every off-screen service is
 * overdue before you have finished opening it, so the first sweep after wake unloads all of them —
 * including the one you were mid-thought in. Pushing the stamp forward by the suspended span makes
 * the timeout mean "time you could have used this and didn't", which is what a user reads it as.
 *
 * Clamped to `now`, so a long sleep after a recent use can't leave a stamp in the future.
 */
export function creditSuspendedTime(
  lastActiveAt: number,
  suspendedForMs: number,
  now: number
): number {
  if (suspendedForMs <= 0) return lastActiveAt;
  return Math.min(now, lastActiveAt + suspendedForMs);
}

/**
 * What counts as a sleep worth reacting to.
 *
 * Shared rather than local to `servicesToRefresh`, because the push sockets need the same answer:
 * one notion of "the machine was actually away" beats two constants that drift apart.
 */
export const LONG_SUSPEND_MS = 5 * 60_000;

/**
 * Views loaded before the machine slept are showing stale content and often a dead socket, so a
 * long suspend should reload them. Visible ones first — those are what you're looking at on wake.
 */
export function servicesToRefresh(
  candidates: Array<{ serviceId: string; sleeping: boolean; visible: boolean; lastActiveAt: number }>,
  suspendedForMs: number,
  minimumMs = LONG_SUSPEND_MS
): string[] {
  if (suspendedForMs < minimumMs) return [];
  return candidates
    .filter((c) => !c.sleeping)
    .sort((a, b) => Number(b.visible) - Number(a.visible))
    .map((c) => c.serviceId);
}
