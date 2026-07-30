import { session, shell, type Session } from 'electron';
import { catalogById } from '../shared/catalog';
import { accountById } from './accounts';
import { decidePermission } from './permissions';
import { applyProxy, attachDownloadHandler } from './system';
import { loadConfig } from './config';
import type { ServiceInstance } from '../shared/types';

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
  const allowed = svc.allowedHosts ?? catalogById(svc.catalogId)?.allowedHosts;
  if (!allowed?.length) return false;
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
  attachDownloadHandler(ses, () => loadConfig().preferences);

  return ses;
}

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
  wc.setWindowOpenHandler(({ url }) => {
    if (isAllowedHost(svc, url)) {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          width: 640,
          height: 780,
          webPreferences: { partition },
        },
      };
    }
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  wc.on('will-navigate', (event, url) => {
    if (isAllowedHost(svc, url)) return;
    event.preventDefault();
    void shell.openExternal(url);
  });
}
