import { app } from 'electron';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { catalog, catalogById } from '@shared/catalog';
import { createAccount, migrateV1, resolveAccount } from '@core/services/accounts';
import { findQuarantined, pathsFor, readWithRecovery, writeAtomic } from '@core/config/store';
import { migrateWorkspaceV3 } from '@core/workspace/folders';
import { withDefaults } from '@core/config/preferences';
import type { Config, RailItem, ServiceInstance } from '@shared/types';

// Plain JSON in userData. No cloud account, no telemetry, no server-side copy of your service
// list — which is one of the things that pushed us off Rambox in the first place.

export const CUSTOM_CATALOG_ID = '__custom';

const configPaths = () => pathsFor(app.getPath('userData'));

export function makeInstance(
  config: Config,
  catalogId: string,
  { forceNewAccount = false, ...overrides }: Partial<ServiceInstance> & { forceNewAccount?: boolean } = {}
): ServiceInstance {
  const entry = catalogById(catalogId);
  if (!entry) throw new Error(`Unknown catalog entry: ${catalogId}`);
  // Reuses the provider's existing account unless told otherwise, so adding Calendar rides the
  // Google login you already have. `forceNewAccount` is how "add another Gmail" is expressed.
  const account = resolveAccount(config, entry.provider, forceNewAccount);
  return {
    id: randomUUID(),
    catalogId,
    name: entry.name,
    // Deliberately no `url` — see ServiceInstance.url. Catalog-backed services follow the catalog.
    accountId: account.id,
    notifications: true,
    hibernate: true,
    zoom: config.preferences.behaviour.defaultZoom,
    ...overrides,
  };
}

/**
 * A connection to an arbitrary URL. Gets its own account (no provider to share with), its own
 * allowlist derived from the URL's host, and its own colour derived from that host so two custom
 * tiles never look identical.
 */
export function makeCustomInstance(
  config: Config,
  { name, url }: { name: string; url: string }
): ServiceInstance {
  const host = new URL(url).hostname;
  const account = createAccount(config, 'custom', name);
  return {
    id: randomUUID(),
    catalogId: CUSTOM_CATALOG_ID,
    name,
    url,
    accountId: account.id,
    // The exact host only. `isAllowedHost` already matches subdomains via a leading-dot suffix
    // check, so app.example.com is covered. Deriving a "registrable domain" by taking the last two
    // labels was actively dangerous: foo.example.co.uk yielded `co.uk`, which allowed every .co.uk
    // site in the world to navigate inside the app.
    allowedHosts: [host],
    color: colorForHost(host),
    notifications: true,
    hibernate: true,
    zoom: config.preferences.behaviour.defaultZoom,
  };
}

/** Stable pseudo-random hue per host, so a custom tile is at least self-consistent. */
function colorForHost(host: string): string {
  let hash = 0;
  for (const ch of host) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return `hsl(${hash % 360} 55% 55%)`;
}

/** Appends to the active workspace too — a service absent from it renders nowhere. */
export function addService(config: Config, svc: ServiceInstance): ServiceInstance {
  config.services.push(svc);
  const workspace =
    config.workspaces.find((w) => w.id === config.activeWorkspaceId) ?? config.workspaces[0];
  workspace?.items.push({ kind: 'service', id: svc.id });
  return svc;
}

function defaultConfig(): Config {
  const config: Config = {
    version: 4,
    preferences: withDefaults(undefined),
    accounts: [],
    services: [],
    workspaces: [],
    activeWorkspaceId: 'default',
    layouts: {},
  };
  // Order matters: Gmail creates the Google account, then Calendar joins it.
  config.services = ['gmail', 'gcal', 'slack', 'notion', 'linear', 'teams'].map((id) =>
    makeInstance(config, id)
  );
  config.workspaces = [
    {
      id: 'default',
      name: 'All',
      items: config.services.map((s) => ({ kind: 'service' as const, id: s.id })),
    },
  ];
  return config;
}

let cached: Config | null = null;

export function loadConfig(): Config {
  if (cached) return cached;

  const { value: raw, note } = readWithRecovery(configPaths(), (text) => {
    const parsed = JSON.parse(text) as { services?: unknown[] };
    // Structurally absent is a failure — `{}` would otherwise look like a valid config and
    // silently replace a real one.
    //
    // An **empty** array is not. `services: []` is a state the app deliberately writes: removing
    // your last service produces it, and there's an EmptyState view built for it. Rejecting it
    // here made a legitimate config indistinguishable from a truncated file, so `readWithRecovery`
    // quarantined it and fell back to the backup — which the next window-bounds write had already
    // overwritten with the same empty config. The result was every service, account and partition
    // mapping replaced by defaults. See docs/decisions.md #47.
    if (!Array.isArray(parsed.services)) {
      throw new Error('no services array');
    }
    return parsed;
  });
  if (note) console.warn(`[config] ${note}`);

  // Not only the copy quarantined on *this* boot — any left by an earlier one. A user whose setup
  // was replaced by defaults had a full copy sitting beside it and no way to know.
  const stale = findQuarantined(configPaths());
  if (stale.length) {
    console.warn(
      `[config] ${stale.length} quarantined config copy/copies from earlier failures. ` +
        `Most recent: ${stale[0]}`
    );
  }

  if (!raw) {
    cached = defaultConfig();
    saveConfig(cached);
    return cached;
  }

  try {
    // Typed loosely on purpose: this is untrusted input from disk and may be any prior version.
    const parsed = raw as Omit<Partial<Config>, 'version' | 'workspaces'> & {
      version?: number;
      services?: Array<ServiceInstance & { sessionGroup?: string }>;
      workspaces?: Array<{ id: string; name: string; serviceIds?: string[]; items?: RailItem[] }>;
    };

    // v1 had no accounts and keyed partitions off `sessionGroup`. The migration rebuilds accounts
    // while preserving the original partition names, so an upgrade never signs you out.
    const migrated =
      (parsed.version ?? 0) >= 2 && parsed.accounts
        ? { accounts: parsed.accounts, services: parsed.services as ServiceInstance[] }
        : migrateV1(parsed);

    cached = {
      version: 4,
      // v2 → v3 added preferences (additive). v3 → v4 turns each workspace's flat serviceIds
      // array into an ordered RailItem tree; migrateWorkspaceV3 is a no-op if it's already v4.
      preferences: withDefaults(parsed.preferences),
      accounts: migrated.accounts,
      // Drop URLs copied from the catalog by older builds so those services pick up catalog fixes.
      // Safe only while there's no UI for editing a service URL — when Settings gains one this
      // must become a versioned migration that preserves genuine overrides.
      services: migrated.services.map((svc) =>
        catalogById(svc.catalogId) ? { ...svc, url: undefined } : svc
      ),
      workspaces: (parsed.workspaces ?? []).map(migrateWorkspaceV3),
      activeWorkspaceId: parsed.activeWorkspaceId ?? parsed.workspaces?.[0]?.id ?? null,
      layouts: parsed.layouts ?? {},
      window: parsed.window,
    };
    if (parsed.version !== 4) saveConfig(cached);
  } catch (err) {
    // Migration failed on structurally-valid JSON. The file itself is intact and already
    // quarantine-free, so start from defaults but leave the original alone for inspection.
    console.error('[config] could not migrate; starting from defaults:', err);
    cached = defaultConfig();
    saveConfig(cached);
  }
  return cached;
}

export function saveConfig(next: Config): void {
  cached = next;
  writeAtomic(configPaths(), JSON.stringify(next, null, 2));
}

export function updateConfig(mutate: (c: Config) => void): Config {
  const c = loadConfig();
  mutate(c);
  saveConfig(c);
  return c;
}

/** Same, but hands back whatever the mutation produced — used when adding a service. */
export function updateConfigReturning<T>(mutate: (c: Config) => T): T {
  const c = loadConfig();
  const out = mutate(c);
  saveConfig(c);
  return out;
}

export { catalog };

/** Quarantined copies on disk, newest first. Surfaced in Settings; never deleted automatically. */
export function quarantinedConfigs(): string[] {
  return findQuarantined(configPaths());
}
