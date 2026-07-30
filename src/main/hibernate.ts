/**
 * Decides which services are due to be unloaded.
 *
 * Pure so it can be tested without Electron — the decision is the part worth pinning, not the
 * teardown. Getting it wrong either wastes memory (never sleeps) or, much worse, unloads something
 * you're looking at.
 *
 * The rules, in order of precedence:
 *   1. Never sleep a service that's on screen. Obvious, but it's the one that would be catastrophic.
 *   2. Never sleep one the user opted out of.
 *   3. Never sleep when the timeout is 0 — that's the "off" setting.
 *   4. Otherwise sleep anything idle longer than the timeout.
 */

export interface HibernationCandidate {
  serviceId: string;
  /** Currently occupying a pane. */
  visible: boolean;
  /** Already unloaded — no view exists. */
  sleeping: boolean;
  /** Per-service opt-out. */
  hibernate: boolean;
  /** Epoch ms when this service was last visible or interacted with. */
  lastActiveAt: number;
}

export function servicesToHibernate(
  candidates: HibernationCandidate[],
  timeoutMinutes: number,
  now: number
): string[] {
  if (timeoutMinutes <= 0) return [];
  const cutoff = now - timeoutMinutes * 60_000;

  return candidates
    .filter((c) => !c.visible && !c.sleeping && c.hibernate && c.lastActiveAt <= cutoff)
    .map((c) => c.serviceId);
}

/**
 * Views loaded before the machine slept are showing stale content and often a dead socket, so a
 * long suspend should reload them. Visible ones first — those are what you're looking at on wake.
 */
export function servicesToRefresh(
  candidates: Array<{ serviceId: string; sleeping: boolean; visible: boolean; lastActiveAt: number }>,
  suspendedForMs: number,
  minimumMs = 5 * 60_000
): string[] {
  if (suspendedForMs < minimumMs) return [];
  return candidates
    .filter((c) => !c.sleeping)
    .sort((a, b) => Number(b.visible) - Number(a.visible))
    .map((c) => c.serviceId);
}
