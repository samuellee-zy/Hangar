import fs from 'node:fs';
import path from 'node:path';
import { app, type Session } from 'electron';
import { ElectronBlocker } from '@ghostery/adblocker-electron';

/**
 * Ad and tracker blocking, per session.
 *
 * Per session because that is where every other network-shaped concern already lives (`sessionFor`
 * — proxy, downloads, permissions) and because hibernation destroys and recreates views: anything
 * applied in a one-off bulk pass silently stops covering whatever wakes up afterwards. The proxy
 * learnt this the hard way; the comment above `applyProxy` is the same warning.
 *
 * **One engine, many sessions.** A single module-level promise is shared and each session gets only
 * its own thin `BlockingContext`. Measured on the prebuilt ads-and-tracking lists: ~18MB retained
 * per engine, so one per partition would have cost that again for every account, and the rules do
 * not vary by service.
 *
 * The same measurement is why the disk cache is not a nicety. Building from the lists takes ~530ms
 * and spikes RSS by ~275MB while parsing; deserialising the 6.8MB cache instead takes ~8ms. Paying
 * the former on every launch would be visible.
 *
 * **This is the one thing in Hangar that fetches from the network at startup.** Worth being
 * explicit, given the icons are vendored precisely to avoid that. The difference: the request is
 * for a static, universal filter list and carries nothing about which services you use, and the
 * result is cached on disk so it happens roughly weekly rather than per launch. A failed fetch is
 * non-fatal — no blocking, services load as normal.
 */

/** Refetched past this age. The lists themselves change daily; weekly is the usual compromise. */
const MAX_CACHE_AGE_MS = 7 * 24 * 60 * 60 * 1000;

const cachePath = () => path.join(app.getPath('userData'), 'adblock-engine.bin');

let engine: Promise<ElectronBlocker> | null = null;

/**
 * `fromCached` reads the cache and only falls back to the network when the read *rejects*, so a
 * stale file would be served forever. Deleting it first is how staleness is expressed.
 */
function dropStaleCache(file: string): void {
  try {
    if (Date.now() - fs.statSync(file).mtimeMs > MAX_CACHE_AGE_MS) fs.rmSync(file);
  } catch {
    // No cache yet, or it cannot be read. Either way the fetch path handles it.
  }
}

function loadEngine(): Promise<ElectronBlocker> {
  if (engine) return engine;
  const file = cachePath();
  dropStaleCache(file);

  const startedAt = Date.now();
  engine = ElectronBlocker.fromPrebuiltAdsAndTracking(fetch, {
    path: file,
    read: fs.promises.readFile,
    write: fs.promises.writeFile,
  })
    .then((blocker) => {
      const size = fs.existsSync(file) ? fs.statSync(file).size : 0;
      console.log(
        `[adblock] engine ready in ${Date.now() - startedAt}ms (${Math.round(size / 1024)}KB on disk)`
      );
      return blocker;
    })
    .catch((err) => {
      // Cleared rather than left as a rejected promise, so the next session created after the
      // network comes back gets a fresh attempt instead of inheriting the failure forever.
      engine = null;
      throw err;
    });

  return engine;
}

/**
 * Turn blocking on for one session. Asynchronous by nature — the engine may still be loading — so
 * early requests in a brand new session go unblocked rather than being held up behind a download.
 * Letting an ad through is a far better failure than a service that will not load.
 */
export function applyAdBlocking(ses: Session, enabled: boolean): void {
  if (!enabled) {
    disableAdBlocking(ses);
    return;
  }
  void loadEngine()
    .then((blocker) => {
      // The session can be gone by the time the engine arrives, and enabling twice would register
      // a second set of webRequest listeners.
      if (!blocker.isBlockingEnabled(ses)) blocker.enableBlockingInSession(ses);
    })
    .catch((err) => {
      console.warn('[adblock] unavailable, continuing without it:', err?.message ?? err);
    });
}

export function disableAdBlocking(ses: Session): void {
  if (!engine) return;
  void engine
    .then((blocker) => {
      if (blocker.isBlockingEnabled(ses)) blocker.disableBlockingInSession(ses);
    })
    .catch(() => {
      // Never loaded, so there is nothing enabled to turn off.
    });
}

/** The preference changed. Applies to every live session without recreating any view. */
export function setAdBlocking(sessions: Iterable<Session>, enabled: boolean): void {
  for (const ses of sessions) applyAdBlocking(ses, enabled);
}
