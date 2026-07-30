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

/** cookies.set() needs a URL, and it must match the cookie's domain/path/secure or it's rejected. */
function urlFor(cookie: Cookie): string {
  const host = cookie.domain?.replace(/^\./, '') ?? '';
  return `${cookie.secure ? 'https' : 'http'}://${host}${cookie.path || '/'}`;
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
  let promoted = 0;
  let failed = 0;

  for (const c of ephemeral) {
    try {
      await ses.cookies.set({
        url: urlFor(c),
        name: c.name,
        value: c.value,
        domain: c.domain,
        path: c.path,
        secure: c.secure,
        httpOnly: c.httpOnly,
        sameSite: c.sameSite,
        expirationDate,
      });
      promoted++;
    } catch {
      // __Host-/__Secure- prefixed cookies reject an explicit domain. They're re-issued on the
      // next authenticated request anyway, so there's nothing to recover here.
      failed++;
    }
  }

  // set() only updates the in-memory store. Without this flush the write can still be pending at
  // exit — which is the exact failure this function exists to prevent.
  if (promoted) {
    try {
      await ses.cookies.flushStore();
    } catch {}
  }

  if (promoted || failed) {
    console.log(`[cookies] ${label}: promoted ${promoted}, rejected ${failed}`);
  }
  return { promoted, failed };
}

/** DOM storage is written lazily and loses recent writes on an unclean exit. Cheap insurance. */
export async function flushStorage(ses: Session): Promise<void> {
  try {
    await ses.flushStorageData();
  } catch {}
}
