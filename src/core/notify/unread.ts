/**
 * Unread counts, keyed by service id.
 *
 * **Why this exists as its own thing.** `unread` used to be a field on `ServiceRuntime` — the
 * object holding a service's live `WebContentsView`. That coupled the count to the view's
 * lifetime, and two features broke on it:
 *
 *   1. **Hibernation wiped the count.** `sleep()` destroys the runtime, so "3 unread in Slack"
 *      evaporated the moment Slack idled out. Dock badge, tray count and folder roll-up all reset
 *      with no user action.
 *   2. **Web Push was dropped entirely.** A push exists precisely to reach you when the service
 *      *isn't* running. `handleNotification` bailed on a missing runtime, so every push for a
 *      hibernated service was decrypted, deduplicated, marked consumed — and discarded. The whole
 *      point of Phase 3.6 was that hibernating a service shouldn't mean going silent on it, and
 *      this is why it did.
 *
 * A count outliving its view is the entire requirement, so it lives here rather than there.
 *
 * **Not persisted.** A restart legitimately starts from zero — you have not been notified of
 * anything yet this session — and persisting would mean a disk write per notification.
 */

export class UnreadCounts {
  private counts = new Map<string, number>();

  get(serviceId: string): number {
    return this.counts.get(serviceId) ?? 0;
  }

  /** Returns the new count, so the caller can log or compare without a second lookup. */
  increment(serviceId: string): number {
    const next = this.get(serviceId) + 1;
    this.counts.set(serviceId, next);
    return next;
  }

  /**
   * Sets an absolute count, for detection that reports a *state* rather than an event — a title
   * showing "(3)". Unlike `increment`, this can go down, which is the point.
   */
  set(serviceId: string, count: number): void {
    if (count <= 0) this.counts.delete(serviceId);
    else this.counts.set(serviceId, count);
  }

  /** Looking at a service is what marks it read — the only signal we reliably have. */
  clear(serviceId: string): void {
    this.counts.delete(serviceId);
  }

  /**
   * Drops services that no longer exist. Without this the badge keeps counting a service you
   * deleted, and nothing in the UI can explain the number.
   */
  prune(liveServiceIds: Iterable<string>): void {
    const live = new Set(liveServiceIds);
    for (const id of [...this.counts.keys()]) {
      if (!live.has(id)) this.counts.delete(id);
    }
  }

  /** macOS shows no badge at 0, so the dock call needs exactly 0 rather than being skipped. */
  total(): number {
    let sum = 0;
    for (const n of this.counts.values()) sum += Math.max(0, n);
    return sum;
  }

  /** For the shell-state projection, which needs a lookup per service. */
  snapshot(): Map<string, number> {
    return new Map(this.counts);
  }
}
