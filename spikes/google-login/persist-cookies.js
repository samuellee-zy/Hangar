// Session cookies (no Expires/Max-Age) live in memory only — Chromium never writes them to disk,
// so they die with the process. Salesforce's `sid` is one of these, which is why Salesforce is the
// one service that asks you to sign in again after every restart.
//
// Real Chrome papers over this with "Continue where you left off", which restores session cookies
// on launch. Electron has no equivalent, so we do it by hand: on quit, re-set every session cookie
// with an explicit expiry so it gets persisted.
//
// This is client-side memory only. It does not extend the *server's* session — Salesforce still
// enforces its own org timeout and will bounce an expired sid regardless. It buys parity with a
// normal browser, not a longer session than the service intended.

const DEFAULT_TTL_DAYS = 30;

// Rebuilds the URL a cookie belongs to. cookies.set() requires one, and it has to match the
// cookie's domain/path/secure or the write is rejected.
function urlFor(cookie) {
  const host = cookie.domain.replace(/^\./, '');
  return `${cookie.secure ? 'https' : 'http'}://${host}${cookie.path || '/'}`;
}

async function promoteSessionCookies(ses, { ttlDays = DEFAULT_TTL_DAYS, label = '' } = {}) {
  let all;
  try {
    all = await ses.cookies.get({});
  } catch {
    return { promoted: 0, failed: 0 };
  }

  // No expirationDate === session cookie.
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
      // Host-prefixed (__Host-) and some __Secure- cookies reject a domain attribute; not worth
      // special-casing here since they're re-issued on the next authenticated request anyway.
      failed++;
    }
  }

  // cookies.set() only updates the in-memory store; Chromium decides when to write through.
  // Without an explicit flush the promotion can still be pending when the process exits — which
  // is exactly the failure it was meant to fix.
  if (promoted) {
    try {
      await ses.cookies.flushStore();
    } catch {}
  }

  if (promoted || failed) {
    console.log(`[cookies] ${label}: promoted ${promoted} session cookie(s), ${failed} rejected`);
  }
  return { promoted, failed };
}

// DOM storage is written lazily; an unclean exit loses recent writes. Cheap insurance.
async function flush(ses) {
  try {
    await ses.flushStorageData();
  } catch {}
}

module.exports = { promoteSessionCookies, flush };
