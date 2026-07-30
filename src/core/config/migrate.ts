import { catalogById } from '@shared/catalog';
import { migrateV1, type StoredService } from '@core/services/accounts';
import { migrateWorkspaceV3 } from '@core/workspace/folders';
import { withDefaults } from '@core/config/preferences';
import type { Config, RailItem, ServiceInstance } from '@shared/types';

/**
 * Brings a config of any prior version up to the current shape.
 *
 * Lifted out of `loadConfig` for two reasons. It was welded to `readWithRecovery` and
 * `app.getPath`, so the composition of three separately-tested migrations was itself untested —
 * and that composition is where a mistake signs every user out. And `importConfig` *bypassed it
 * entirely*, doing `saveConfig({ ...parsed })` with no defaults, no migration and no version
 * handling, so importing a v3-era export wrote a structurally invalid config straight to disk.
 * Both paths now go through here.
 *
 * Throws on input it can't make sense of. Callers decide what to do about that; this doesn't
 * silently substitute defaults, because the caller is the only one that knows whether the original
 * file is still recoverable.
 */

/** The loose shape of anything read from disk — untrusted, and possibly any prior version. */
type StoredConfig = Omit<Partial<Config>, 'version' | 'workspaces'> & {
  version?: number;
  services?: StoredService[];
  workspaces?: Array<{ id: string; name: string; serviceIds?: string[]; items?: RailItem[] }>;
};

/**
 * Fields typed as required on `ServiceInstance` that older configs simply don't have.
 *
 * Nothing backfilled these, and the type asserted they were present, so:
 *   - `hibernate === undefined` is falsy, so the service never hibernated — silently, forever.
 *   - `zoom === undefined` reached `setZoomFactor(undefined)`, which throws out of `openService` →
 *     `restoreLayout` → the constructor, so the app failed to render at all on the first launch
 *     after upgrading.
 */
function backfillService(svc: StoredService): ServiceInstance {
  return {
    ...svc,
    notifications: svc.notifications ?? true,
    hibernate: svc.hibernate ?? true,
    zoom: svc.zoom ?? 1,
  } as ServiceInstance;
}

export function migrateConfig(raw: unknown): Config {
  if (!raw || typeof raw !== 'object') throw new Error('config is not an object');
  const parsed = raw as StoredConfig;
  if (!Array.isArray(parsed.services)) throw new Error('config has no services array');

  // v1 had no accounts and keyed partitions off `sessionGroup`. The migration rebuilds accounts
  // while preserving the original partition names, so an upgrade never signs you out.
  //
  // The `parsed.accounts` half of this condition is load-bearing and dangerous: a v4 config that
  // has *lost* its accounts array falls into migrateV1, which regenerates partitions from
  // `sessionGroup ?? catalogId`. For a v4 config neither exists as expected, so the names differ
  // from what's on disk and the user is signed out of everything. Guarded below.
  const isV2Plus = (parsed.version ?? 0) >= 2;
  if (isV2Plus && !parsed.accounts) {
    throw new Error(
      `config claims version ${parsed.version} but has no accounts array; refusing to rebuild ` +
        'partitions from scratch, which would sign out every service'
    );
  }

  const migrated = isV2Plus
    ? { accounts: parsed.accounts!, services: parsed.services.map(backfillService) }
    : migrateV1({ services: parsed.services.map(backfillService) });

  return {
    version: 4,
    // v2 → v3 added preferences (additive). v3 → v4 turns each workspace's flat serviceIds array
    // into an ordered RailItem tree; migrateWorkspaceV3 is a no-op if it's already v4.
    preferences: withDefaults(parsed.preferences),
    accounts: migrated.accounts,
    // Drop URLs copied from the catalog by older builds so those services pick up catalog fixes.
    // Safe only while there's no UI for editing a service URL — when Settings gains one this must
    // become a versioned migration that preserves genuine overrides.
    services: migrated.services.map((svc) =>
      catalogById(svc.catalogId) ? { ...svc, url: undefined } : svc
    ),
    workspaces: (parsed.workspaces ?? []).map(migrateWorkspaceV3),
    activeWorkspaceId: parsed.activeWorkspaceId ?? parsed.workspaces?.[0]?.id ?? null,
    layouts: parsed.layouts ?? {},
    pushRegistrations: parsed.pushRegistrations,
    window: parsed.window,
  };
}
