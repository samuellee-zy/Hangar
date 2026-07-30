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

/**
 * Detecting unread from what a service *displays*, rather than counting the notifications it fires.
 *
 * The count today is a tally of `new Notification()` calls. That only ever rises, never reflects
 * reality, and reads zero for a service whose browser notifications are off — Gmail showing
 * "(5) Inbox" reports nothing at all.
 *
 * **Per-service, and opt-in.** A global `\((\d+)\)` parser is the obvious idea and the wrong one:
 * a Notion page named "(2) Draft", a Google Doc, a YouTube tab all match, and each becomes a
 * permanent phantom count. Rambox learned this — it injects per-service JavaScript as the primary
 * mechanism and falls back to a title pattern only where a site has none. So detection is declared
 * per catalog entry and simply absent for custom connections, where there is nothing to know.
 */
export interface UnreadDetection {
  /**
   * Regex source matched against the page title. The first capturing group is the count; a match
   * with no group counts as 1, which covers sites that show a bare dot or asterisk.
   */
  titlePattern?: string;
}

/**
 * Returns the count a title implies, or null when the rule doesn't apply — null meaning "no
 * information", which is different from zero. A title that stops matching *is* zero: that's how
 * reading your mail elsewhere clears the badge here.
 */
export function unreadFromTitle(
  title: string,
  detection: UnreadDetection | undefined
): number | null {
  if (!detection?.titlePattern) return null;
  let match: RegExpMatchArray | null;
  try {
    match = title.match(new RegExp(detection.titlePattern));
  } catch {
    // A bad pattern in the catalog shouldn't take out title handling for every service.
    return null;
  }
  if (!match) return 0;

  const captured = match[1];
  if (captured === undefined) return 1;

  const n = Number.parseInt(captured, 10);
  // "99+" parses to 99, which is the right answer. Anything unparseable means matched-but-unknown.
  return Number.isFinite(n) ? Math.max(0, n) : 1;
}
