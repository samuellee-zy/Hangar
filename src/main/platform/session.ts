import {
  app,
  BrowserWindow,
  desktopCapturer,
  dialog,
  session,
  webContents,
  type DesktopCapturerSource,
  type Session,
  type WebContents,
} from 'electron';
import { catalogById } from '@shared/catalog';
import { accountById } from '@core/services/accounts';
import { userAgentFor } from '@core/services/user-agent';
import { decidePermission } from '@core/runtime/permissions';
import { blockedPageHtml, shouldShowBlockedPage } from '@core/runtime/recovery';
import { isBlankPage, isWebUrl, redactUrl } from '@core/runtime/urls';
import { applyProxy, attachDownloadHandler } from '@main/platform/system';
import { applyAdBlocking } from '@main/platform/adblock';
import { loadConfig } from '@main/platform/config';
import { openExternalSafely } from '@main/platform/external';
import type { ServiceInstance } from '@shared/types';

/**
 * The partition comes from the service's Account, verbatim — never recomputed from an id or label.
 * See Account.partition: a partition name is the identity of a cookie jar, so deriving it from
 * anything mutable turns a rename into a silent sign-out.
 */
export const partitionFor = (svc: ServiceInstance): string => {
  const account = accountById(loadConfig(), svc.accountId);
  if (!account) throw new Error(`Service ${svc.id} references unknown account ${svc.accountId}`);
  return account.partition;
};

const configured = new Set<string>();
const liveSessions = new Map<string, Session>();

export const allLiveSessions = () => liveSessions;

/** Whether the account on this partition blocks ads: its own setting, or else the global one. */
export function adsBlockedFor(partition: string): boolean {
  const config = loadConfig();
  const own = config.accounts.find((a) => a.partition === partition)?.blockAds;
  return own ?? config.preferences.network.blockAds;
}

/** Applies each live session's effective setting — after the global one or an account's changes. */
export function applyAdBlockingEverywhere(): void {
  for (const [partition, ses] of liveSessions) applyAdBlocking(ses, adsBlockedFor(partition));
}

/**
 * Partitions that have gained a session cookie since they were last promoted.
 *
 * The minute-by-minute persistence loop promoted every partition every minute, reading every
 * cookie in every jar, whether or not anything had changed — the log shows the same seven cookies
 * promoted over and over. Promotion only exists for *session* cookies (persistent ones already
 * reach disk), so a partition only needs it when one is set. Our own promotion sets persistent
 * cookies, which don't count, so it cannot re-dirty what it just cleaned.
 */
const needsPromotion = new Set<string>();

/** Takes the set of partitions to promote, and forgets them. */
export function takeDirtyPartitions(): Set<string> {
  const dirty = new Set(needsPromotion);
  needsPromotion.clear();
  return dirty;
}

/**
 * Drop sessions no service uses any more. Without this the map only ever grows, and once
 * hibernation starts destroying views we'd keep calling into dead sessions on the persist timer.
 * Partitions are shared across a session group, so a partition is only released when *no*
 * remaining service maps to it.
 */
export function pruneSessions(stillNeeded: Set<string>): string[] {
  const dropped: string[] = [];
  for (const partition of liveSessions.keys()) {
    if (stillNeeded.has(partition)) continue;
    liveSessions.delete(partition);
    configured.delete(partition);
    dropped.push(partition);
  }
  return dropped;
}

/** True when the URL belongs to the service (or its identity provider) rather than the open web. */
export function isAllowedHost(svc: ServiceInstance, rawUrl: string): boolean {
  // Instance list first: custom connections have no catalog entry, and without their own list
  // every navigation would bounce to the system browser and look like a broken service.
  //
  // `extraAllowedHosts` is unioned rather than consulted as a fallback, so a host added by hand
  // never costs the service its catalog list. See the field's own comment for why it isn't simply
  // merged into `allowedHosts`.
  const base = svc.allowedHosts ?? catalogById(svc.catalogId)?.allowedHosts ?? [];
  const allowed = svc.extraAllowedHosts?.length ? [...base, ...svc.extraAllowedHosts] : base;
  if (!allowed.length) return false;
  // Web URLs only. `file:`, `data:` and `about:` have an empty hostname, and a custom connection
  // made from a `file:` URL had an allowlist of `['']` — which matched every one of them.
  if (!isWebUrl(rawUrl)) return false;
  const host = new URL(rawUrl).hostname;
  return allowed.some((h) => h !== '' && (host === h || host.endsWith(`.${h}`)));
}

/**
 * Which service each webContents belongs to: service views and every popup they open, registered as
 * their guards attach. A partition is shared by every service on one account — Gmail, Calendar and
 * Drive are one Google login — so the session alone cannot say which of them is asking.
 */
const ownerOf = new WeakMap<WebContents, string>();

const servicesIn = (partition: string): ServiceInstance[] =>
  loadConfig().services.filter((svc) => {
    // `partitionFor` throws for a service with a missing account; that one simply isn't a match.
    try {
      return partitionFor(svc) === partition;
    } catch {
      return false;
    }
  });

/**
 * The service a permission request really comes from, or null when it comes from nobody's own
 * frame — an embed, an ad, a tracker, the error page.
 *
 * Read fresh from config on every request. The handler used to capture whichever service first
 * created the partition, so toggling camera and microphone for a custom connection did nothing
 * until restart, and a second service sharing the partition was judged as the first.
 */
function requestingService(
  partition: string,
  wc: WebContents | null,
  requestingUrl: string | undefined,
  isMainFrame = false,
): ServiceInstance | null {
  if (!requestingUrl) return null;
  const ownerId = wc ? ownerOf.get(wc) : undefined;
  // A blank window a service opened and drew into — Slack's huddle — asks from `about:blank`,
  // which is on nobody's allowlist, so its microphone was refused: the huddle opened and couldn't
  // hear you. It runs with the origin of the page that opened it; judge by that. Only when the
  // blank page *is* the window's top frame, of a window we know whose it is — a blank iframe in a
  // third-party embed is judged by its own origin still — and an opaque origin ("null") matches
  // nothing.
  if (isBlankPage(requestingUrl) && isMainFrame && wc && ownerId) requestingUrl = wc.mainFrame.origin;
  const candidates = ownerId
    ? loadConfig().services.filter((s) => s.id === ownerId)
    : servicesIn(partition);
  return candidates.find((svc) => isAllowedHost(svc, requestingUrl)) ?? null;
}

function permitted(
  partition: string,
  wc: WebContents | null,
  permission: string,
  requestingUrl: string | undefined,
  isMainFrame = false,
): boolean {
  const svc = requestingService(partition, wc, requestingUrl, isMainFrame);
  return decidePermission({
    permission,
    fromService: svc !== null,
    isCatalogService: Boolean(svc && catalogById(svc.catalogId)),
    allowMedia: Boolean(svc?.allowMedia),
  });
}

/**
 * Screen sharing. Without a display-media handler `getDisplayMedia` simply fails, so granting
 * `display-capture` did nothing and screen share in Meet, Teams and Slack never worked.
 *
 * The choice is the user's, every time, from a native dialog — nothing here shares a screen
 * because a page asked. Screens first, then windows by name.
 */
async function chooseCaptureSource(serviceName: string): Promise<DesktopCapturerSource | null> {
  const sources = await desktopCapturer.getSources({
    types: ['screen', 'window'],
    thumbnailSize: { width: 0, height: 0 },
  });
  const screens = sources.filter((s) => s.id.startsWith('screen:'));
  const windows = sources.filter((s) => s.id.startsWith('window:') && s.name.trim() !== '');
  const choices = [...screens, ...windows].slice(0, 10);
  if (choices.length === 0) return null;

  const { response } = await dialog.showMessageBox({
    type: 'question',
    message: `${serviceName} wants to share your screen`,
    detail: 'Choose what to share. Nothing is shared until you pick.',
    buttons: [
      ...choices.map((s) => (s.id.startsWith('screen:') ? `Entire screen — ${s.name}` : s.name)),
      'Cancel',
    ],
    cancelId: choices.length,
    defaultId: choices.length,
  });
  return choices[response] ?? null;
}

export function sessionFor(svc: ServiceInstance): Session {
  const partition = partitionFor(svc);
  const ses = session.fromPartition(partition);
  if (configured.has(partition)) return ses;
  configured.add(partition);
  liveSessions.set(partition, ses);
  // A new jar starts dirty: whatever it restored from disk has never been checked this run.
  needsPromotion.add(partition);
  ses.cookies.on('changed', (_event, cookie, _cause, removed) => {
    if (!removed && cookie.session) needsPromotion.add(partition);
  });

  // Not the session's user agent: that is shared by every service on the account, and was set by
  // whichever one happened to configure it first. Per page now — see ServiceManager.ensure.

  // Deny-by-default, with curated services trusted further than arbitrary URLs, and only a
  // service's own frames trusted at all. See permissions.ts.
  ses.setPermissionRequestHandler((wc, permission, callback, details) =>
    callback(permitted(partition, wc, permission, details.requestingUrl, details.isMainFrame)),
  );
  // The *check* handler covers synchronous queries (navigator.permissions.query, getUserMedia's
  // internal check). Leaving it at the default would let a page bypass the handler above.
  ses.setPermissionCheckHandler((wc, permission, requestingOrigin, details) =>
    permitted(partition, wc, permission, details.requestingUrl ?? requestingOrigin, details.isMainFrame),
  );
  ses.setDisplayMediaRequestHandler((request, callback) => {
    const wc = request.frame ? webContents.fromFrame(request.frame) ?? null : null;
    // A blank window's frame has no address, but has its opener's origin — see `requestingService`.
    // So sharing a screen from a huddle is judged as Slack, not refused as about:blank.
    const frameUrl = request.frame?.url;
    const url = isBlankPage(frameUrl) ? (request.frame?.origin ?? request.securityOrigin) : (frameUrl ?? request.securityOrigin);
    const svc = requestingService(partition, wc, url);
    if (!svc || !permitted(partition, wc, 'display-capture', url)) {
      callback({});
      return;
    }
    chooseCaptureSource(svc.name)
      .then((source) => callback(source ? { video: source } : {}))
      .catch((err: unknown) => {
        console.warn(`[media] ${svc.name}: screen share failed — ${String(err)}`);
        callback({});
      });
  });

  ses.setSpellCheckerLanguages(loadConfig().preferences.behaviour.spellcheckLanguages);
  // Applied at creation, not only in the bulk pass — hibernation destroys and recreates views, so
  // a proxy set once would silently stop applying to anything woken afterwards.
  void applyProxy([ses], loadConfig().preferences);
  // Same reasoning as the proxy above, and the same trap: applied here rather than in a bulk pass
  // so a view woken from hibernation is covered too.
  applyAdBlocking(ses, adsBlockedFor(partition));
  attachDownloadHandler(ses, () => loadConfig().preferences);

  return ses;
}

/**
 * Where a link leaving a service can go instead of the browser — another of your services — or
 * null to leave it to the browser. Set by the window, which knows the services and the preference;
 * returns whether it took the link.
 */
type LinkRouter = (url: string, fromServiceId: string) => boolean;
let routeLink: LinkRouter | null = null;
export function setLinkRouter(router: LinkRouter | null): void {
  routeLink = router;
}

/**
 * Told about each window a service's page opens, and which service it belongs to — for the meeting
 * bridge, which needs Slack's huddle window (popups don't get the preload). Set by the window.
 */
type PopupListener = (serviceId: string, contents: Electron.WebContents) => void;
let onPopup: PopupListener | null = null;
export function setPopupListener(listener: PopupListener | null): void {
  onPopup = listener;
}

/** `window.open()` with no URL, or `about:blank`: a window the page fills in itself. */
const isBlankUrl = (url: string): boolean => isBlankPage(url);

/**
 * Blank popups opened by entries that allow them (`blankPopups`), for as long as they've shown
 * nothing else. Their first navigation off the allowlist closes them: the link was going somewhere
 * else, and an empty window left behind would be all that remained of it.
 */
const blankWindows = new WeakSet<Electron.WebContents>();

/**
 * Closes a blank popup if nothing has been drawn into it. Asked of the page, since a document the
 * opener wrote into leaves no trace main can see: no navigation, no load, the same address.
 * Unanswerable — the page gone or hung — leaves it open, which loses nothing.
 */
function closeIfEmpty(wc: Electron.WebContents): void {
  wc.executeJavaScript('!document.body || (document.body.childElementCount === 0 && !document.body.textContent.trim())', true)
    .then((empty: unknown) => {
      if (empty === true && !wc.isDestroyed()) BrowserWindow.fromWebContents(wc)?.close();
    })
    .catch(() => {});
}

/** Hands a link to the router, or to the system browser when the router declines it. */
function leave(url: string, svc: ServiceInstance): void {
  if (routeLink?.(url, svc.id)) return;
  openExternalSafely(url, svc.name);
}

/**
 * The host of the most recent navigation we both blocked *and* showed a blocked page for, per
 * service. The blocked page's Allow button carries no argument; this is what it means.
 *
 * Only written on the path that renders the page, so the button can never allow a host the user
 * was not just shown. Never read for any other purpose.
 */
const lastBlockedHost = new Map<string, string>();

export const hostBlockedFor = (serviceId: string): string | null =>
  lastBlockedHost.get(serviceId) ?? null;

export const clearBlockedHost = (serviceId: string): void => {
  lastBlockedHost.delete(serviceId);
};

const hostOf = (rawUrl: string): string => {
  try {
    return new URL(rawUrl).hostname;
  } catch {
    return rawUrl;
  }
};

/**
 * Links to the wider web open in the real browser; anything belonging to the service or its
 * identity provider stays in-app. Sign-in flows lean on popups, so blocking them wholesale looks
 * exactly like an auth failure — Slack and Notion both break without this.
 */
export function attachNavigationGuards(
  wc: Electron.WebContents,
  svc: ServiceInstance,
  partition: string
): void {
  // Guards are attached once per view, in `ServiceManager.ensure()`, and `ensure()` returns early
  // for a live runtime — so a captured `svc` would hold the allowlist as it stood when the view was
  // created, and a host added by hand would do nothing until the view was destroyed and rebuilt.
  // Re-read per navigation instead. The captured value stays the fallback: mid-teardown the service
  // is already out of config, and treating that as "allow nothing" would bounce a closing view's
  // last navigation to the browser.
  const current = (): ServiceInstance =>
    loadConfig().services.find((s) => s.id === svc.id) ?? svc;

  ownerOf.set(wc, svc.id);

  wc.setWindowOpenHandler(({ url }) => {
    // A blank window only for entries that opt in (Slack's huddle), since the allowlist can't judge
    // a page the opener fills in itself. Whatever it navigates to next is still guarded below.
    const blankAllowed = isBlankUrl(url) && catalogById(current().catalogId)?.blankPopups === true;
    if (isAllowedHost(current(), url) || blankAllowed) {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          width: 640,
          height: 780,
          // `safeDialogs`: a popup looping `alert()` can otherwise pin a modal until it's killed.
          webPreferences: { partition, safeDialogs: true },
        },
      };
    }
    console.log(`[nav] ${svc.name}: popup ${redactUrl(url)} not on allowlist — leaving the service`);
    leave(url, svc);
    return { action: 'deny' };
  });

  // The allowlist above is checked once, on the URL the popup *opens* with. Without this the popup
  // could then navigate anywhere while still carrying the service's cookie jar — the allowlist
  // guarded the front door and left the window open. Recursive, because an IdP flow is a chain of
  // redirects and any of them can spawn another popup.
  wc.on('did-create-window', (child, details) => {
    if (isBlankUrl(details.url)) {
      // Only the service's own page may open a window it then fills in itself. The handler above
      // can't tell which frame asked, and a third-party iframe in Slack — an embed, a media player —
      // could otherwise open a window with no address bar, Slack's cookie jar, and anything it
      // cares to write into it, which no navigation guard would ever see. The opener's origin says
      // who it was; `noopener` leaves none, and a blank window nobody can write into is useless.
      const origin = child.webContents.opener?.origin;
      if (!origin || !isAllowedHost(current(), origin)) {
        console.log(`[nav] ${svc.name}: a blank window opened by ${origin ? hostOf(origin) : 'an unknown frame'} — closed`);
        child.close();
        return;
      }
      blankWindows.add(child.webContents);
    }
    attachNavigationGuards(child.webContents, svc, partition);
    onPopup?.(svc.id, child.webContents);
    // The service's own user agent, which is set per page now rather than on the session: a sign-in
    // popup is often exactly what the user agent was set to get through. From its next request on —
    // the first has already been sent by the time the window exists.
    const svcNow = current();
    const userAgent = userAgentFor(svcNow, catalogById(svcNow.catalogId), app.userAgentFallback, app.getName());
    if (userAgent) child.webContents.setUserAgent(userAgent);
  });

  /**
   * Shared by both navigation events. Returns true when the navigation was refused.
   *
   * Blocking is never silent — every refusal is logged with the service and the full URL, because
   * a bounced sign-in step is otherwise indistinguishable from a service that simply won't load,
   * and there was no way to tell from the outside which had happened.
   */
  const refuse = (url: string, via: string): boolean => {
    if (isAllowedHost(current(), url)) return false;
    console.log(`[nav] ${svc.name}: ${hostOf(url)} not on allowlist (${via}) — leaving the service`);
    // Routed to another of your services, the pane stays where it was: the link went somewhere.
    const routed = routeLink?.(url, svc.id) === true;
    if (!routed) openExternalSafely(url, svc.name);

    // A blank popup. If it's still empty it was a link on its way somewhere — the browser or
    // another service has it now — and what's left is an empty window: close it. If the page drew
    // into it, it's Slack's huddle, whose address stays about:blank for its whole life, and a
    // refused link inside it must leave the call up. Either way it gets no blocked page, which
    // would replace whatever was drawn.
    if (blankWindows.has(wc) && isBlankUrl(wc.getURL())) {
      closeIfEmpty(wc);
      return true;
    }
    if (routed) return true;

    // The pane is only replaced when it holds nothing worth keeping. Clicking an external link in
    // a working service must leave that service exactly where it was.
    if (shouldShowBlockedPage(wc.getURL())) {
      lastBlockedHost.set(svc.id, hostOf(url));
      void wc.loadURL(
        blockedPageHtml({ serviceName: svc.name, url, host: hostOf(url) })
      );
    }
    return true;
  };

  wc.on('will-navigate', (event, url) => {
    if (refuse(url, 'will-navigate')) event.preventDefault();
  });

  // `will-navigate` covers only navigations *the page* asks for. A server-side 302 fires this
  // instead, and without it an allowed host could hand the main frame to any other host while it
  // still carried the service's cookie jar — the same hole `did-create-window` closes for popups.
  //
  // `preventDefault()` here cancels the whole navigation rather than just the redirect hop, which
  // is exactly the case that can leave a dead pane, so it leans on the blocked page above.
  //
  // Main frame only. The event fires for subframes too, and without this an iframe redirecting off
  // the allowlist — a silent sign-in refresh, an embed, a tracker — was cancelled and bounced to the
  // browser, a tab popping open for something the user never clicked. A subframe cannot take the
  // pane's cookie jar anywhere, which is what this guard is for. `!== false`, so an event without
  // the field is treated as the main frame: when unsure, guard.
  wc.on('will-redirect', (event, url) => {
    if ((event as { isMainFrame?: boolean }).isMainFrame === false) return;
    if (refuse(url, 'will-redirect')) event.preventDefault();
  });

  // Once the pane has left its blocked page, the host that page offered is no longer on offer.
  // Otherwise it stayed armed after "Back to …", and any script in the service could call
  // `__hangar.allowHost()` and widen its own allowlist to a host the user had just declined.
  wc.on('did-navigate', (_event, url) => {
    // It showed a real page, so it's an ordinary popup now.
    if (!isBlankUrl(url)) blankWindows.delete(wc);
    if (!url.startsWith('data:')) clearBlockedHost(svc.id);
  });
}
