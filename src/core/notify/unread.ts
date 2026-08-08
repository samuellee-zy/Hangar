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

import type { DomUnreadProbe, DomUnreadRule } from '../../shared/types';

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
 *
 * Two mechanisms, one answer. `titlePattern` reads the tab title; `dom` reads the page's own badge
 * for the majority of services that never put a count in the title. Both produce an *absolute*
 * count, which is the point — `increment` from the notification tally can only ever rise, and
 * reads zero for a service whose browser notifications are off.
 */
export interface UnreadDetection {
  /**
   * Regex source matched against the page title. The first capturing group is the count; a match
   * with no group counts as 1, which covers sites that show a bare dot or asterisk.
   */
  titlePattern?: string;
  /**
   * DOM rules, for the services — most of them — that keep the count out of the title. Tried in
   * order; the first with anything to say wins. See `unreadFromDom`.
   */
  dom?: DomUnreadRule[];
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

/**
 * The count a badge's text implies.
 *
 * Sites write badges every way there is: "3", "3 unread", "9+", "(12)", "•". Digits anywhere in
 * the string are the count; text with none is a dot-style badge and counts as 1; nothing at all is
 * nothing. `parseInt` alone would read "9+" correctly and "3 unread messages" as 3 by luck, but
 * "unread: 3" as NaN — so match the digits rather than leading with them.
 */
export function countFromBadgeText(text: string): number {
  const trimmed = text.trim();
  if (trimmed === '') return 0;
  const digits = trimmed.match(/\d+/);
  if (!digits) return 1;
  const n = Number.parseInt(digits[0], 10);
  return Number.isFinite(n) ? Math.max(0, n) : 1;
}

/**
 * The count a set of DOM probes implies, or null for "no information" — the same three-way answer
 * `unreadFromTitle` gives, and for the same reason: a service we cannot read must keep whatever
 * count the notification tally has built up rather than being silently zeroed.
 *
 * Rules are tried in order and the first that can answer does. A rule can answer in two ways:
 * matches, which give a count; or an anchor found with no matches, which is a genuine zero. A rule
 * whose anchor is missing has not loaded and is skipped, so a fallback rule below it still gets its
 * turn.
 *
 * `probes` is untyped on the way in because it arrives from a page over IPC — a service's own
 * JavaScript can reach the bridge, so nothing about its shape is a given.
 */
export function unreadFromDom(
  rules: DomUnreadRule[] | undefined,
  probes: unknown
): number | null {
  if (!rules || rules.length === 0) return null;
  if (!Array.isArray(probes)) return null;

  for (const [index, rule] of rules.entries()) {
    const probe = asProbe(probes[index]);
    if (!probe) continue;

    if (probe.values.length === 0) {
      // Anchored and empty is the case that lets a badge clear. Unanchored and empty is a page
      // that may simply not have drawn yet, and guessing zero there wipes a real count on reload.
      if (probe.anchored) return 0;
      continue;
    }

    if (rule.read === 'count') return probe.values.length;

    // The first match, not a sum: a service showing both a per-channel badge and a total would
    // otherwise report roughly double, and which nodes a selector catches is the rule author's
    // decision to make with the selector.
    return countFromBadgeText(probe.values[0] ?? '');
  }

  return null;
}

function asProbe(value: unknown): DomUnreadProbe | null {
  if (!value || typeof value !== 'object') return null;
  const { anchored, values } = value as Partial<DomUnreadProbe>;
  if (!Array.isArray(values)) return null;
  return {
    anchored: anchored === true,
    values: values.filter((v): v is string => typeof v === 'string'),
  };
}

/**
 * The rules to actually run for a service: the user's selector if they set one, otherwise the
 * catalog's.
 *
 * Absent and empty differ, as they do for keyboard passthrough. Absent follows the catalog, so a
 * rule we fix later reaches installs that already exist. The empty string is the deliberate "read
 * nothing", which is the only way to switch off a catalog rule that has started matching the wrong
 * node — and a site *will* eventually make that true of one of ours.
 */
export function resolveUnreadRules(
  detection: UnreadDetection | undefined,
  override: string | undefined
): DomUnreadRule[] {
  if (override === undefined) return detection?.dom ?? [];
  const selector = override.trim();
  return selector === '' ? [] : [{ selector }];
}
