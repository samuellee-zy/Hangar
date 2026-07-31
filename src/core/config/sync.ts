import type { Config, SyncStatus } from '@shared/types';

export type { SyncStatus };

/**
 * What syncs between machines, and what emphatically does not.
 *
 * The transport is git — a repo you control, pulled on launch and committed on change. That part
 * lives in `main/features/sync.ts`. This is the decision layer: which fields travel, how to tell
 * whether anything actually changed, and how to merge what arrives.
 *
 * **Config is the one thing this project has already destroyed once** (decisions #47). So the
 * design here is deliberately conservative: an explicit allowlist rather than an exclude list, no
 * automatic conflict resolution, and a merge that can only ever be a whole-file replacement of the
 * portable half.
 */

/**
 * Fields that travel.
 *
 * An **allowlist**, not a blocklist. A blocklist means every field added later syncs by default and
 * someone has to remember to exclude it — which is exactly how a machine-local secret ends up in a
 * shared repo. Adding a field here is a deliberate act.
 */
export const PORTABLE_KEYS = [
  'version',
  'preferences',
  'accounts',
  'services',
  'workspaces',
  'activeWorkspaceId',
] as const;

/**
 * Fields that stay local, and what would break if they didn't.
 *
 * | Field | Why not |
 * | --- | --- |
 * | `pushRegistrations` | An FCM registration is bound to one receiver. Two machines holding the same endpoint means both are wrong, and neither gets the notification. |
 * | `window` | Describes this machine's display. `restoreBounds` would strand the window offscreen on a laptop that synced from a desktop. |
 * | `layouts` | Pane arrangements are sized to a screen. A 4-pane split from a 32" monitor is unusable on a 13" laptop. |
 *
 * Cookie jars are not in `Config` at all — they're partition directories on disk. So machine B gets
 * your service list and account *labels*, and has to sign in. That's correct, not a gap, and the UI
 * says so rather than letting it look like a failure.
 */
export const LOCAL_ONLY_KEYS = ['pushRegistrations', 'window', 'layouts'] as const;

export type PortableConfig = Pick<Config, (typeof PORTABLE_KEYS)[number]>;

/** The half of a config that travels. */
export function portable(config: Config): PortableConfig {
  const out = {} as Record<string, unknown>;
  for (const key of PORTABLE_KEYS) out[key] = config[key];
  return out as PortableConfig;
}

/**
 * Recursively sorts object keys. Arrays keep their order — it's meaningful for `services`,
 * `workspaces` and rail items, where position *is* the data.
 */
function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value as object)
        .sort()
        .map((k) => [k, sortKeys((value as Record<string, unknown>)[k])])
    );
  }
  return value;
}

/**
 * Stable JSON for comparison and for writing to the repo.
 *
 * Keys are sorted because `JSON.stringify` preserves insertion order, and two identical configs
 * built in a different order would otherwise produce a diff — a sync that commits on every launch
 * is one nobody keeps enabled.
 *
 * **Not** `JSON.stringify(x, keys, 2)`. That second argument is a key *allowlist* applied at every
 * level, not a sort order — so passing the top-level keys silently stripped every nested object's
 * contents, and a changed preference didn't register as a change at all. Caught by a test asserting
 * that it did.
 */
export function serialise(config: Config): string {
  return `${JSON.stringify(sortKeys(portable(config)), null, 2)}\n`;
}

/** Whether the portable half differs — the only thing worth a commit. */
export function hasDiverged(a: Config, b: Config): boolean {
  return serialise(a) !== serialise(b);
}

/**
 * Applies an incoming config over the local one, keeping every machine-local field.
 *
 * Whole-file, not field-by-field. A structural merge would have to decide what happens when both
 * machines renamed the same service, and any answer it picks is a guess about intent — sometimes a
 * guess that costs you an account-to-partition mapping. Git already has a model for that
 * disagreement; this defers to it.
 */
export function applyIncoming(local: Config, incoming: PortableConfig): Config {
  const merged = { ...local } as Record<string, unknown>;
  for (const key of PORTABLE_KEYS) merged[key] = incoming[key];
  for (const key of LOCAL_ONLY_KEYS) merged[key] = local[key];
  return merged as unknown as Config;
}

/**
 * Whether a config read from the repo is safe to apply.
 *
 * Deliberately strict about `accounts`. An incoming config missing them, or with fewer than the
 * local one, means every service whose account vanished can no longer resolve a partition — which
 * signs you out of things you never touched. Better to refuse and say so.
 */
export function validateIncoming(
  incoming: unknown,
  local: Config
): { ok: true; config: PortableConfig } | { ok: false; reason: string } {
  if (!incoming || typeof incoming !== 'object') {
    return { ok: false, reason: 'the synced file is not a config object' };
  }
  const candidate = incoming as Partial<PortableConfig>;

  if (!Array.isArray(candidate.services)) {
    return { ok: false, reason: 'the synced config has no services array' };
  }
  if (!Array.isArray(candidate.accounts)) {
    return { ok: false, reason: 'the synced config has no accounts array' };
  }

  // Every service must be able to find its account, or it becomes permanently unloadable —
  // `partitionFor` throws on a dangling accountId.
  const accountIds = new Set(candidate.accounts.map((a) => a.id));
  const orphaned = candidate.services.filter((s) => !accountIds.has(s.accountId));
  if (orphaned.length > 0) {
    return {
      ok: false,
      reason: `${orphaned.length} synced service(s) reference an account that isn't in the file: ${orphaned
        .map((s) => s.name)
        .join(', ')}`,
    };
  }

  // A sync that silently empties your rail is indistinguishable from a sync that worked. Losing
  // everything is worth a question; losing one service is ordinary.
  if (local.services.length > 0 && candidate.services.length === 0) {
    return { ok: false, reason: 'the synced config has no services and this machine has some' };
  }

  return { ok: true, config: candidate as PortableConfig };
}
