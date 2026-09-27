import { Notification, app, type WebContents } from 'electron';
import { catalogById } from '@shared/catalog';
import { loadConfig } from '@main/platform/config';
import { safeSend } from '@main/platform/safe-send';
import { decideNotification, normaliseNotification } from '@core/notify/policy';
import { extractNotification } from '@core/push/policy';
import {
  UnreadCounts,
  resolveUnreadRules,
  unreadFromDom,
  unreadFromTitle,
} from '@core/notify/unread';
import type { DomUnreadRule, ServiceInstance, ShellState } from '@shared/types';

/**
 * Everything that asks for your attention: unread counts, notification banners, the Dock badge,
 * and the recent-notifications list — from every source that feeds them (a page's own
 * `Notification`, a Web Push, a title pattern, a DOM badge, an endpoint asked while asleep).
 *
 * Its own module because it was a quarter of a 2,500-line window class and depends on almost none
 * of it: which services are on screen, whether the window is, and a way to broadcast. That is the
 * whole host interface, and the reason the rest of the window can change without this noticing.
 */

export interface AttentionHost {
  /** Services drawn in a pane right now — what someone could be looking at. */
  drawnServiceIds(): Set<string>;
  /** Services in any pane, drawn or not, for acknowledging when the window reappears. */
  paneServiceIds(): string[];
  /** Whether a service has a live view (isn't asleep). */
  isLive(serviceId: string): boolean;
  contentsFor(serviceId: string): WebContents | null;
  /** Whether the window is somewhere a person could be looking at it. */
  windowOnScreen(): boolean;
  sync(): void;
  /** Bring the window forward on this service — a banner was clicked. */
  focusService(serviceId: string): void;
}

type RecentNotification = NonNullable<ShellState['recentNotifications']>[number];

/** Where a banner click goes. Set once by boot, which can build a window if there isn't one. */
let clickRoute: ((serviceId: string) => void) | null = null;

export function setNotificationClickRoute(route: ((serviceId: string) => void) | null): void {
  clickRoute = route;
}

export class AttentionCenter {
  readonly unread = new UnreadCounts();
  /** Banners held until dismissed, so GC can't take one before its click handler fires. */
  private live = new Set<Notification>();
  /** Newest first, capped. In memory only — never written, never synced. */
  private recent: RecentNotification[] = [];
  /**
   * Services whose count the page itself reported — a badge or a title — rather than one we
   * tallied from notifications. The page is the authority on those, and it only reports a
   * *change*: clear one because the pane came into view and it stays at zero until the next
   * message, although the page still says 3.
   */
  private reported = new Set<string>();

  constructor(private readonly host: AttentionHost) {}

  recentNotifications(limit = 10): RecentNotification[] {
    return this.recent.slice(0, limit);
  }

  /**
   * A push arrived for a service. Routed through the same notification path as an in-page one, so
   * DND, muting, unread counting and click-to-focus all behave identically — the transport
   * shouldn't be visible in the behaviour.
   */
  handlePushMessage(serviceId: string, message: unknown): void {
    const svc = loadConfig().services.find((s) => s.id === serviceId);
    if (!svc) return;
    const content = extractNotification(message, svc.name);
    // A payload we can't read at all is dropped rather than shown as an empty banner.
    if (!content) {
      console.warn(`[push] unreadable payload for ${svc.name}`);
      return;
    }
    this.handleNotification(serviceId, { title: content.title, body: content.body, silent: false });
  }

  /**
   * A service changed its title.
   *
   * Where the catalog declares a pattern, the title is treated as the *authoritative* unread count
   * rather than another event to tally. That's a real difference: counting `new Notification()`
   * calls only ever goes up, never reflects what you've already read elsewhere, and reads zero for
   * a service whose browser notifications are off — Gmail showing "(5) Inbox" reported nothing.
   *
   * A title that stops matching means zero, which is how reading your mail on your phone clears
   * the badge here.
   */
  handleTitle(serviceId: string, title: string): void {
    const svc = loadConfig().services.find((s) => s.id === serviceId);
    if (!svc) return;
    this.applyDetectedUnread(svc, unreadFromTitle(title, catalogById(svc.catalogId)?.unread));
  }

  /**
   * The DOM rules a service view should watch, answered when its preload asks on load.
   *
   * Resolved here rather than in the preload because it needs the config: which catalog entry this
   * instance came from, and whether the user has overridden the selector.
   */
  unreadRulesFor(serviceId: string): DomUnreadRule[] {
    const svc = loadConfig().services.find((s) => s.id === serviceId);
    if (!svc) return [];
    // A muted service isn't going to be allowed to set a count, so don't make its page watch every
    // mutation to produce one.
    if (svc.notificationLevel === 'muted' || !svc.notifications) return [];
    return resolveUnreadRules(catalogById(svc.catalogId)?.unread, svc.unreadSelector);
  }

  /** Tells a live view to start watching a different set of rules. No-op if it isn't loaded. */
  pushUnreadRules(serviceId: string): void {
    const contents = this.host.contentsFor(serviceId);
    if (contents) safeSend(contents, 'service:unread-rules-changed', this.unreadRulesFor(serviceId));
  }

  /**
   * A service view read its own badge. The probes are raw page output: the page-side code collects
   * strings and `unreadFromDom` decides what they mean, so the rule semantics stay in a pure
   * function rather than in a serialised closure no test can reach.
   */
  handleUnreadProbes(serviceId: string, probes: unknown): void {
    const svc = loadConfig().services.find((s) => s.id === serviceId);
    if (!svc) return;
    const rules = resolveUnreadRules(catalogById(svc.catalogId)?.unread, svc.unreadSelector);
    this.applyDetectedUnread(svc, unreadFromDom(rules, probes));
  }

  /** A count from the endpoint poller, for a service that is asleep. */
  applyEndpointCount(serviceId: string, count: number): void {
    const svc = loadConfig().services.find((s) => s.id === serviceId);
    // Raced with the service being deleted, or with it waking up — in which case its own page is
    // about to report, and the endpoint's answer is the staler of the two.
    if (!svc || this.host.isLive(serviceId)) return;
    this.applyDetectedUnread(svc, count);
  }

  /**
   * Records an absolute count from detection — a title pattern or a DOM rule.
   *
   * `null` means the rule had nothing to say, which is not zero: a service we cannot read keeps
   * whatever count it has rather than being silently cleared.
   */
  private applyDetectedUnread(svc: ServiceInstance, detected: number | null): void {
    if (detected === null) return;
    // Muting and the per-service toggle still win: an unread count is an interruption of a
    // quieter kind, and opting out should mean opting out of both.
    if (svc.notificationLevel === 'muted' || !svc.notifications) return;
    this.reported.add(svc.id);
    if (this.unread.get(svc.id) === detected) return;
    this.unread.set(svc.id, detected);
    this.updateBadge();
    this.host.sync();
  }

  /**
   * A service fired a notification. Attribution is the whole reason the preload wraps the
   * constructor rather than letting Electron route it directly.
   */
  handleNotification(serviceId: string, raw: unknown): void {
    // `unknown`, because one caller is an IPC handler fed by a page. See `normaliseNotification`.
    const payload = normaliseNotification(raw);
    const config = loadConfig();
    const svc = config.services.find((s) => s.id === serviceId);
    // Deliberately no runtime check. A hibernated service has no runtime by definition, and a Web
    // Push exists precisely to reach you then — requiring one dropped every push this feature was
    // built for. See docs/decisions.md #56.
    if (!svc) return;

    const decision = decideNotification({
      enabled: config.preferences.notifications.enabled,
      dnd: config.preferences.notifications.dnd,
      level: svc.notificationLevel ?? 'all',
      serviceEnabled: svc.notifications,
      // Drawn: a pane hidden behind a maximised one is not something you're looking at.
      inVisiblePane: this.host.drawnServiceIds().has(serviceId),
      // A pane inside a window you closed to the tray is not something you're looking at.
      windowVisible: this.host.windowOnScreen(),
    });

    if (decision.count) {
      this.unread.increment(serviceId);
      // Counted ones only: a message you were looking at as it arrived isn't one you missed.
      this.recent.unshift({
        serviceId,
        title: payload.title || svc.name,
        body: payload.body ?? '',
        at: Date.now(),
      });
      this.recent.length = Math.min(this.recent.length, 30);
    }

    if (decision.banner) this.showBanner(svc, payload, config.preferences.notifications.sound);

    this.updateBadge();
    this.host.sync();
  }

  private showBanner(
    svc: ServiceInstance,
    payload: ReturnType<typeof normaliseNotification>,
    sound: boolean,
  ): void {
    const notification = new Notification({
      title: payload.title || svc.name,
      // Which service, under the page's own title. "Alex: are you free?" from two Slacks and a
      // WhatsApp looked identical; the title is the page's, and says nothing about where it's from.
      subtitle: payload.title && payload.title !== svc.name ? svc.name : undefined,
      body: payload.body,
      silent: payload.silent || !sound,
    });
    // Clicking should land you on the thing that pinged you — through the app's route when there is
    // one, because a banner outlives the window that raised it. After ⌘W on the last pane the
    // window is destroyed, and a click that reached back into it threw on the dead window and kept
    // it alive besides. The handlers below capture locals, not `this`, for the same reason.
    const serviceId = svc.id;
    const route = clickRoute;
    const host = this.host;
    const live = this.live;
    notification.on('click', () => (route ? route(serviceId) : host.focusService(serviceId)));
    notification.show();
    // Retained until it's dismissed: the object is otherwise only referenced by this local, so
    // GC can collect it before the click handler ever fires and click-to-focus does nothing.
    live.add(notification);
    notification.on('close', () => live.delete(notification));
    // Bounded. A notification left in Notification Center never closes, so over a week of
    // messages the set only grew. The oldest are the least likely to be clicked; a Set iterates
    // in insertion order, so the first entry is the oldest.
    while (this.live.size > 50) {
      const oldest = this.live.values().next().value;
      if (!oldest) break;
      this.live.delete(oldest);
    }
    // The only evidence there will ever be. macOS delivers nothing to an unsigned bundle, and
    // before this the banner simply never appeared — unread counted, the badge moved, and the
    // log said nothing at all. Also released here: a failed notification never closes.
    const name = svc.name;
    notification.on('failed', (_event, error) => {
      console.error(`[notification] ${name}: not delivered — ${error}`);
      live.delete(notification);
    });
  }

  /**
   * The window is going. Its counts go with it — a rebuilt window starts from zero, as a restart
   * does — so the Dock badge must too, or it kept a number nothing on screen could explain.
   */
  dispose(): void {
    app.setBadgeCount(0);
  }

  /** The window has just come back into view: whatever is in a pane has now been seen. */
  acknowledgePanes(): void {
    for (const serviceId of this.host.paneServiceIds()) {
      if (this.host.isLive(serviceId)) this.acknowledge(serviceId);
    }
    this.host.sync();
  }

  /**
   * A service is on screen. For a count we tallied, that is the only sign it was read we will ever
   * get. A count the page reported is left alone: having the pane in view doesn't read Gmail's
   * inbox, and the page reports again when the number actually changes.
   */
  acknowledge(serviceId: string): void {
    if (!this.reported.has(serviceId)) this.clearUnread(serviceId);
  }

  /** Marks a service read outright — the user said so, or the rules that produced the count changed. */
  clearUnread(serviceId: string): void {
    // Forgotten as well: the next report, from whatever rules apply now, starts afresh.
    this.reported.delete(serviceId);
    if (this.unread.get(serviceId) === 0) return;
    this.unread.clear(serviceId);
    this.updateBadge();
  }

  /** macOS hides the badge at 0, so it must be *set* to 0 rather than skipped. */
  updateBadge(): void {
    app.setBadgeCount(this.unread.total());
  }
}
