import type { Cookie, Session } from 'electron';

/**
 * Session cookies (no Expires/Max-Age) live in memory only, so they die with the process. Chrome
 * papers over this with "Continue where you left off"; Electron has no equivalent. Without this,
 * services keep asking you to sign in again after every restart.
 *
 * Client-side only. The service's own server-side timeout still applies — this buys parity with a
 * normal browser, not a longer session than the service intended. Salesforce is the proof: even
 * with every cookie promoted and flushed correctly, its org invalidates the session on browser
 * close, which is why it belongs on Tier 2 instead.
 */

export const DEFAULT_COOKIE_TTL_DAYS = 30;

const hostOf = (cookie: Cookie): string => cookie.domain?.replace(/^\./, '') ?? '';

/** cookies.set() needs a URL, and it must match the cookie's domain/path/secure or it's rejected. */
function urlFor(cookie: Cookie): string {
  return `${cookie.secure ? 'https' : 'http'}://${hostOf(cookie)}${cookie.path || '/'}`;
}

/**
 * Cookie name prefixes are enforced by Chromium on write, not merely conventional.
 *
 * `__Host-` means host-locked: valid only with no Domain attribute at all, a path of exactly `/`,
 * and Secure. `cookies.get` reports the resolved host in `domain` regardless, so handing that
 * straight back to `cookies.set` is rejected — the same cookie failing on every sweep, forever,
 * which is a log line a minute and no promotion. Google sets one of these, hence `rejected 1` in
 * perpetuity for Gmail.
 *
 * `__Secure-` is the weaker form: Domain is allowed, Secure is not optional.
 */
function setDetailsFor(cookie: Cookie, expirationDate: number): Electron.CookiesSetDetails {
  const common = {
    name: cookie.name,
    value: cookie.value,
    httpOnly: cookie.httpOnly,
    sameSite: cookie.sameSite,
    expirationDate,
  };

  if (cookie.name.startsWith('__Host-')) {
    return { ...common, url: `https://${hostOf(cookie)}/`, path: '/', secure: true };
  }

  return {
    ...common,
    url: urlFor(cookie),
    domain: cookie.domain,
    path: cookie.path,
    secure: cookie.secure || cookie.name.startsWith('__Secure-'),
  };
}

/**
 * The last line printed per partition, so a steady state prints once instead of every 60 seconds.
 *
 * That volume is not hypothetical: an unpromotable cookie plus a one-minute loop is what filled the
 * pipe whose eventual collapse took the app down. Keyed by label, so tests distinguish partitions
 * by passing different ones rather than needing a reset hook.
 */
const lastReported = new Map<string, string>();

/** Names, never values. Enough to identify a cookie that keeps coming back; useless to an attacker. */
function summarise(promoted: string[], failed: string[]): string {
  const list = (names: string[]) =>
    names.length <= 4 ? names.join(', ') : `${names.slice(0, 4).join(', ')}, +${names.length - 4}`;

  const parts = [`promoted ${promoted.length}`];
  if (promoted.length) parts[0] += ` (${list(promoted)})`;
  parts.push(`rejected ${failed.length}`);
  if (failed.length) parts[1] += ` (${list(failed)})`;
  return parts.join(', ');
}

export async function promoteSessionCookies(
  ses: Session,
  { ttlDays = DEFAULT_COOKIE_TTL_DAYS, label = '' } = {}
): Promise<{ promoted: number; failed: number }> {
  let all: Cookie[];
  try {
    all = await ses.cookies.get({});
  } catch {
    return { promoted: 0, failed: 0 };
  }

  const ephemeral = all.filter((c) => !c.expirationDate);
  if (!ephemeral.length) return { promoted: 0, failed: 0 };

  const expirationDate = Math.floor(Date.now() / 1000) + ttlDays * 86400;
  const promotedNames: string[] = [];
  const failedNames: string[] = [];

  for (const c of ephemeral) {
    try {
      await ses.cookies.set(setDetailsFor(c, expirationDate));
      promotedNames.push(c.name);
    } catch {
      // Whatever is left once the prefix rules above are honoured — a malformed domain, or a cookie
      // the service has since invalidated. It gets re-issued on the next authenticated request
      // anyway, so there's nothing to recover here.
      failedNames.push(c.name);
    }
  }

  const promoted = promotedNames.length;
  const failed = failedNames.length;

  // set() only updates the in-memory store. Without this flush the write can still be pending at
  // exit — which is the exact failure this function exists to prevent.
  if (promoted) {
    try {
      await ses.cookies.flushStore();
    } catch {}
  }

  if (promoted || failed) {
    const line = summarise(promotedNames, failedNames);
    if (lastReported.get(label) !== line) {
      lastReported.set(label, line);
      console.log(`[cookies] ${label}: ${line}`);
    }
  }
  return { promoted, failed };
}

/** DOM storage is written lazily and loses recent writes on an unclean exit. Cheap insurance. */
export async function flushStorage(ses: Session): Promise<void> {
  try {
    await ses.flushStorageData();
  } catch {}
}
