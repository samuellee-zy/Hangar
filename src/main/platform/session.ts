import { session, shell, type Session } from 'electron';
import { catalogById } from '@shared/catalog';
import { accountById } from '@core/services/accounts';
import { decidePermission } from '@core/runtime/permissions';
import { blockedPageHtml, shouldShowBlockedPage } from '@core/runtime/recovery';
import { applyProxy, attachDownloadHandler } from '@main/platform/system';
import { applyAdBlocking } from '@main/platform/adblock';
import { loadConfig } from '@main/platform/config';
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
  let host: string;
  try {
    host = new URL(rawUrl).hostname;
  } catch {
    return false;
  }
  return allowed.some((h) => host === h || host.endsWith(`.${h}`));
}

export function sessionFor(svc: ServiceInstance): Session {
  const partition = partitionFor(svc);
  const ses = session.fromPartition(partition);
  if (configured.has(partition)) return ses;
  configured.add(partition);
  liveSessions.set(partition, ses);

  if (svc.userAgent) ses.setUserAgent(svc.userAgent);

  // Deny-by-default, with curated services trusted further than arbitrary URLs. See permissions.ts.
  const decide = (permission: string) =>
    decidePermission({
      permission,
      isCatalogService: Boolean(catalogById(svc.catalogId)),
      allowMedia: Boolean(svc.allowMedia),
    });

  ses.setPermissionRequestHandler((_wc, permission, callback) => callback(decide(permission)));
  // The *check* handler covers synchronous queries (navigator.permissions.query, getUserMedia's
  // internal check). Leaving it at the default would let a page bypass the handler above.
  ses.setPermissionCheckHandler((_wc, permission) => decide(permission));

  ses.setSpellCheckerLanguages(loadConfig().preferences.behaviour.spellcheckLanguages);
  // Applied at creation, not only in the bulk pass — hibernation destroys and recreates views, so
  // a proxy set once would silently stop applying to anything woken afterwards.
  void applyProxy([ses], loadConfig().preferences);
  // Same reasoning as the proxy above, and the same trap: applied here rather than in a bulk pass
  // so a view woken from hibernation is covered too.
  applyAdBlocking(ses, loadConfig().preferences.network.blockAds);
  attachDownloadHandler(ses, () => loadConfig().preferences);

  return ses;
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

  wc.setWindowOpenHandler(({ url }) => {
    if (isAllowedHost(current(), url)) {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          width: 640,
          height: 780,
          webPreferences: { partition },
        },
      };
    }
    console.log(`[nav] ${svc.name}: popup ${url} not on allowlist — opened in browser`);
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  // The allowlist above is checked once, on the URL the popup *opens* with. Without this the popup
  // could then navigate anywhere while still carrying the service's cookie jar — the allowlist
  // guarded the front door and left the window open. Recursive, because an IdP flow is a chain of
  // redirects and any of them can spawn another popup.
  wc.on('did-create-window', (child) => {
    attachNavigationGuards(child.webContents, svc, partition);
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
    console.log(`[nav] ${svc.name}: ${hostOf(url)} not on allowlist (${via}) — opened in browser`);
    void shell.openExternal(url);

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
  wc.on('will-redirect', (event, url) => {
    if (refuse(url, 'will-redirect')) event.preventDefault();
  });
}
