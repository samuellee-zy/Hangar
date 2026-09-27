import { powerMonitor } from 'electron';
import { catalogById } from '@shared/catalog';
import { loadConfig } from '@main/platform/config';
import { DEFAULT_COOKIE_TTL_DAYS, flushStorage, promoteSessionCookies } from '@main/platform/persist-cookies';
import { allLiveSessions, partitionFor, pruneSessions, takeDirtyPartitions } from '@main/platform/session';

/**
 * What keeps running in the background: session-cookie promotion, the hibernation and endpoint
 * sweeps, and the flush-and-refresh around sleep.
 *
 * Out of `boot/index.ts`, which owns boot order, the single-instance lock, IPC and quitting; these
 * are timers, and they need the window only for three things.
 */
export interface MaintainedWindow {
  hibernateIdle(): void;
  pollEndpoints(): Promise<void>;
  refreshAfterWake(suspendedForMs: number): void;
}

// --- session durability --------------------------------------------------------------------
// Session cookies never reach disk, so without this a restart signs you out of anything that
// doesn't issue a persistent cookie. See the Phase 0 findings in persist-cookies.ts.

/**
 * How long to extend a partition's session cookies by, or 0 to leave them alone.
 *
 * Several services can share one partition, so the *shortest* TTL wins — if any service in the
 * group opts out, the whole jar opts out. `sessionNotPersistable` forces 0: Phase 0 proved that
 * promoting Salesforce's `sid` achieves nothing because the org invalidates it server-side, so
 * extending it is pure downside.
 */
export function ttlForPartition(partition: string): number {
  const services = loadConfig().services.filter((svc) => {
    // Same reason as `persistAll`: a service with a missing account throws rather than answering,
    // and it is not this function's job to fail the whole partition over it.
    try {
      return partitionFor(svc) === partition;
    } catch {
      return false;
    }
  });
  if (services.length === 0) return DEFAULT_COOKIE_TTL_DAYS;

  return services.reduce((shortest, svc) => {
    const entry = catalogById(svc.catalogId);
    const ttl = entry?.sessionNotPersistable ? 0 : svc.cookieTtlDays ?? DEFAULT_COOKIE_TTL_DAYS;
    return Math.min(shortest, ttl);
  }, Number.POSITIVE_INFINITY);
}

/**
 * `all` for quit and suspend, where everything must be on disk; the minute loop passes `false` and
 * touches only partitions that gained a session cookie since last time (see `takeDirtyPartitions`),
 * plus a storage flush for everyone every fifth minute.
 */
let tick = 0;
export async function persistAll({ all = true }: { all?: boolean } = {}): Promise<void> {
  // Per service, not `services.map(partitionFor)`. `partitionFor` throws on a service whose
  // account is missing, and one throw here took out the whole loop — permanently, because it runs
  // under `void` on an interval with nothing to report the rejection. Cookie promotion and storage
  // flushing would then stop for *every* service, and the user finds out weeks later by being
  // signed out of everything after a restart.
  //
  // `migrateConfig` now refuses a config that could produce this, so it should be unreachable.
  // Keeping the guard anyway: the cost of being wrong is the durability of every session in the
  // app, and this loop should degrade to "skip that one" rather than "stop".
  const needed = new Set<string>();
  for (const svc of loadConfig().services) {
    try {
      needed.add(partitionFor(svc));
    } catch (err) {
      console.error(`[session] skipping ${svc.name}:`, err);
    }
  }

  for (const partition of pruneSessions(needed)) {
    console.log(`[session] released ${partition} — no service uses it`);
  }

  const dirty = takeDirtyPartitions();
  const flushEveryone = all || tick++ % 5 === 0;
  for (const [partition, ses] of allLiveSessions()) {
    const promote = all || dirty.has(partition);
    const ttlDays = ttlForPartition(partition);
    if (promote && ttlDays > 0) await promoteSessionCookies(ses, { label: partition, ttlDays });
    if (promote || flushEveryone) await flushStorage(ses);
  }
}

/**
 * Starts the loops. Called once, at module load in boot/index.ts as before — `window` is read at
 * every tick, since ⌘W and a Dock click replace the window the loops act on.
 */
export function startMaintenance(window: () => MaintainedWindow | null): void {
  setInterval(() => {
    // The interval is fire-and-forget, so an unhandled rejection here is invisible. Catch it, or
    // the only symptom of a broken persistence loop is lost sessions much later.
    void persistAll({ all: false }).catch((err) => console.error('[session] persist failed:', err));
  }, 60_000);

  // Hibernation sweep. Frequent enough that a 1-minute timeout behaves as advertised, cheap
  // enough that it doesn't matter — the decision is pure arithmetic over a handful of services.
  setInterval(() => window()?.hibernateIdle(), 30_000);

  // Unread for sleeping services. The sweep is far cheaper than the interval suggests: it only
  // considers services with no live view *and* an endpoint rule, and each of those carries its
  // own interval floored at a minute. On a typical config it does nothing at all.
  setInterval(() => {
    // Same reason as `persistAll`: this runs under `void` on a timer, where an unhandled rejection
    // is invisible and the loop just stops.
    void window()?.pollEndpoints().catch((err) => console.error('[endpoint] sweep failed:', err));
  }, 30_000);

  // --- power ----------------------------------------------------------------------------------
  // A closing lid is an unclean exit as far as unwritten session cookies are concerned, and
  // views that slept through it hold stale content and often a dead socket.

  let suspendedAt: number | null = null;

  powerMonitor.on('suspend', () => {
    suspendedAt = Date.now();
    console.log('[power] suspending — flushing sessions');
    void persistAll().catch((err) => console.error('[power] suspend flush failed:', err));
  });

  powerMonitor.on('resume', () => {
    const suspendedFor = suspendedAt ? Date.now() - suspendedAt : 0;
    suspendedAt = null;
    console.log(`[power] resumed after ${Math.round(suspendedFor / 1000)}s`);
    window()?.refreshAfterWake(suspendedFor);
  });
}
