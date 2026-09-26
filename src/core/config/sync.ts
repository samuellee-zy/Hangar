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

/**
 * Preferences that must not travel, even though `preferences` as a whole does.
 *
 * Top-level exclusion isn't enough — most of `preferences` is genuinely portable, and a handful of
 * leaves inside it are not:
 *
 * | Path | Why |
 * | --- | --- |
 * | `notifications.firebase` | **A credential.** Syncing it commits an API key into a git repo — wrong even in a private one, and a leak if the repo is public. This is the one that matters. |
 * | `sync.repoPath` | An absolute local path. The second machine adopts the first's, it doesn't exist there, and sync reports `unavailable` — the transport config travelling over the transport and killing it. |
 * | `network.proxy` | A work proxy on a laptop should not follow you home. |
 * | `downloads.folder` | An absolute local path. |
 * | `notifications.dndUntil` | A timestamp. Transient state, not a preference. |
 * | `behaviour.launchAtLogin` | Per-machine by nature: laptop yes, desktop no. |
 * | `behaviour.relaunchOnCrash` | The other half of the same launchd job, and local for the same reason. |
 *
 * `notifications.push` *does* travel. Without credentials the second machine shows the toggle as
 * pending with "Fill in the Firebase project below first", which is honest.
 *
 * `sync.allowPublicRepo` is local for the same reason as `repoPath`: it's an override about one
 * particular repo on one particular machine. Travelling, it would silently pre-authorise a repo the
 * other machine never looked at — and writing "yes, I know this is public" *into* the public repo is
 * its own small absurdity.
 */
export const LOCAL_PREFERENCE_PATHS = [
  'notifications.firebase',
  'notifications.dndUntil',
  'sync.repoPath',
  'sync.allowPublicRepo',
  'network.proxy',
  'downloads.folder',
  'behaviour.launchAtLogin',
  'behaviour.relaunchOnCrash',
] as const;

/**
 * Fields of a *service* that stay on this machine, though the service itself travels.
 *
 * | Field | Why |
 * | --- | --- |
 * | `customJs` | **Code that runs inside a signed-in page.** Synced, anyone who can push to the repo — or a repo that is later made public and forked — can run script in your Gmail on every machine that pulls. CSS can restyle a page; this can read it and act as you. It is written by hand on the machine that needs it. |
 */
export const LOCAL_SERVICE_FIELDS = ['customJs'] as const;

export type PortableConfig = Pick<Config, (typeof PORTABLE_KEYS)[number]>;

/* ------------------------------------------------------------------------------------------------
 * Refusing to write your config into a repo the whole world can read.
 *
 * The synced file carries no credentials — `LOCAL_PREFERENCE_PATHS` above strips them, with a test
 * asserting the output contains neither the Firebase key nor the string `apiKey`. It is still not
 * *public-safe*: account labels are usually email addresses, and custom connection URLs are
 * plausibly internal hostnames.
 *
 * ## The first design of this guard was backwards
 *
 * It refused any remote on github.com, gitlab.com or bitbucket.org — which is precisely where a
 * private dotfiles repo lives. It would have fired on the correct, common case, and the override
 * would have been switched on permanently within a day. A guard that trains you to disable it is
 * worse than no guard.
 *
 * The host list survived, with the opposite job. It no longer marks where sync is *forbidden*; it
 * marks where an unauthenticated 200 can be *believed*.
 * ---------------------------------------------------------------------------------------------- */

/**
 * Hosts where an anonymous HTTP 200 really does mean "anyone on the internet can read this".
 *
 * A self-hosted forge is deliberately absent. Probing `git.internal.example` from a laptop on the
 * corporate VPN can easily answer 200 for a repo no outsider can reach, and refusing to sync to your
 * own company's private git server would be a false positive of exactly the kind that gets a guard
 * switched off.
 *
 * Verified against all four: a public repo answers 200, and a nonexistent one answers 404 (403 on
 * GitLab). Only 200 is load-bearing, so the difference doesn't matter.
 */
export const PUBLIC_FORGES = ['github.com', 'gitlab.com', 'bitbucket.org', 'codeberg.org'] as const;

/** A git remote reduced to the two things needed to build a web URL for it. */
export interface RemoteRef {
  host: string;
  /** Repo path with no leading slash and no `.git`. Keeps nested GitLab groups intact. */
  path: string;
}

function asRef(host: string, rawPath: string): RemoteRef | null {
  const path = rawPath
    .replace(/^\/+/, '')
    .replace(/\/+$/, '')
    .replace(/\.git$/i, '');
  if (!host || !path) return null;
  return { host: host.toLowerCase(), path };
}

/**
 * Parses the output of `git remote get-url origin`.
 *
 * Two syntaxes, because git accepts both and people use both:
 *
 * | Form | Example |
 * | --- | --- |
 * | scp-like | `git@github.com:owner/repo.git` |
 * | URL | `https://github.com/owner/repo.git`, `ssh://git@github.com/owner/repo` |
 *
 * Returns null for anything without a network host — a plain local path, a relative path, a
 * `file://` URL. Those cannot be probed and are not the risk this guards against.
 */
export function parseRemote(url: string): RemoteRef | null {
  const trimmed = url.trim();
  if (!trimmed) return null;

  // scp-like: [user@]host:path. The negative lookahead on `/` is what keeps `https://…` out — its
  // colon *is* followed by slashes, so only the URL branch below can claim it.
  const scp = /^(?:[^@/]+@)?([^:/]+):(?!\/)(.+)$/.exec(trimmed);
  if (scp) return asRef(scp[1]!, scp[2]!);

  try {
    const parsed = new URL(trimmed);
    if (!['ssh:', 'git:', 'http:', 'https:'].includes(parsed.protocol)) return null;
    return asRef(parsed.hostname, parsed.pathname);
  } catch {
    return null;
  }
}

/**
 * The URL to probe, or null when probing this host would tell us nothing.
 *
 * Null is not "assume private" — it's "don't ask the question", which lands on the same permissive
 * answer by a different route.
 */
export function probeUrlFor(ref: RemoteRef): string | null {
  if (!(PUBLIC_FORGES as readonly string[]).includes(ref.host)) return null;
  return `https://${ref.host}/${ref.path}`;
}

export type RepoVisibility = 'public' | 'unknown';

/**
 * The verdict table. Decisive in exactly one direction.
 *
 * | Response | Meaning | Verdict |
 * | --- | --- | --- |
 * | 200 | anyone can read it | `public` |
 * | 404 | private **or** nonexistent — indistinguishable by design, deliberately, so that probing cannot enumerate private repos | `unknown` |
 * | anything else, or no response at all | offline, DNS failure, rate limit, a forge having a bad day | `unknown` |
 */
export function visibilityFromStatus(status: number | null): RepoVisibility {
  return status === 200 ? 'public' : 'unknown';
}

/**
 * Whether to refuse, and what to say. Null means proceed.
 *
 * **Fails open on purpose.** Every uncertain answer allows the sync. The risk being weighed is
 * publishing your own service list to your own repo — something you configured and can see in
 * Settings — against sync silently breaking every time you open the laptop on a train. The second is
 * worse, and it's the one that erodes trust in the feature.
 */
export function publicRepoRefusal(args: {
  visibility: RepoVisibility;
  allowPublicRepo: boolean;
  probeUrl: string;
}): string | null {
  if (args.visibility !== 'public' || args.allowPublicRepo) return null;
  return (
    `${args.probeUrl} is readable by anyone, and the synced file lists your services, ` +
    'account labels and any custom URLs. Credentials are never written to it. ' +
    'Use a private repo, or allow this one below.'
  );
}

function getPath(root: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((node, key) => {
    if (!node || typeof node !== 'object') return undefined;
    return (node as Record<string, unknown>)[key];
  }, root);
}

/** Sets `path` on a structurally-cloned copy. Never mutates the input. */
function withPath(root: unknown, path: string, value: unknown): unknown {
  const keys = path.split('.');
  const clone = structuredClone(root) as Record<string, unknown>;
  let node = clone;
  for (const key of keys.slice(0, -1)) {
    const next = node[key];
    if (!next || typeof next !== 'object') return clone;
    node = next as Record<string, unknown>;
  }
  const leaf = keys[keys.length - 1]!;
  if (value === undefined) delete node[leaf];
  else node[leaf] = value;
  return clone;
}

/** The half of a config that travels, with machine-local preference leaves removed. */
export function portable(config: Config): PortableConfig {
  const out = {} as Record<string, unknown>;
  for (const key of PORTABLE_KEYS) out[key] = config[key];
  // Stripped rather than blanked: a key present but empty would overwrite the other machine's
  // value with nothing, which for `sync.repoPath` disables sync there just as effectively.
  let result: unknown = structuredClone(out);
  for (const path of LOCAL_PREFERENCE_PATHS) {
    result = withPath(result, `preferences.${path}`, undefined);
  }
  for (const svc of (result as PortableConfig).services ?? []) {
    for (const field of LOCAL_SERVICE_FIELDS) delete svc[field];
  }
  return result as PortableConfig;
}

/**
 * Puts this machine's own values back over an incoming config: the local preference leaves, and the
 * local-only fields of each service that exists on both sides. A service new to this machine
 * arrives without them, which is the point — it has none here yet.
 */
export function restoreLocalPreferences(incoming: PortableConfig, local: Config): PortableConfig {
  let result: unknown = structuredClone(incoming);
  for (const path of LOCAL_PREFERENCE_PATHS) {
    const mine = getPath(local.preferences, path);
    result = withPath(result, `preferences.${path}`, mine);
  }
  const localById = new Map(local.services.map((svc) => [svc.id, svc]));
  for (const svc of (result as PortableConfig).services ?? []) {
    const mine = localById.get(svc.id);
    for (const field of LOCAL_SERVICE_FIELDS) {
      if (mine?.[field] !== undefined) svc[field] = mine[field];
      else delete svc[field];
    }
  }
  return result as PortableConfig;
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
 * What a reconcile should do, decided against the last-synced base.
 *
 * Without a base there is no way to tell "the remote is newer" from "I have local changes that
 * never pushed" — and `applyIncoming` replacing the portable half wholesale meant the second case
 * silently deleted them. That was a data-loss path reachable on a single machine.
 */
export type SyncAction =
  | { kind: 'up-to-date' }
  | { kind: 'apply-remote' }
  | { kind: 'push-local' }
  | { kind: 'conflict'; detail: string };

/**
 * The three-way decision.
 *
 * | local vs base | remote vs base | Action |
 * | --- | --- | --- |
 * | same | changed | the remote moved — apply it |
 * | changed | same | we moved — push |
 * | changed | changed | both moved — refuse |
 * | same | same | nothing to do |
 *
 * **A missing base** is every existing install's starting state, and it means we genuinely cannot
 * tell who is ahead. If the two sides are already identical, adopt that as the base silently. If
 * they differ, refuse and make the user choose — guessing here is the whole bug.
 */
export function decideSync(args: {
  local: string;
  remote: string | null;
  base: string | null;
}): SyncAction {
  const { local, remote, base } = args;

  // No config in the repo — either never seeded, or someone deleted it. Push either way: doing
  // nothing because `local === base` would leave the repo permanently empty while sync reported
  // success.
  if (remote === null) return { kind: 'push-local' };

  if (base === null) {
    if (local === remote) return { kind: 'up-to-date' };
    return {
      kind: 'conflict',
      detail:
        'no record of a previous sync on this machine, and the two copies differ — choose which ' +
        'one to keep',
    };
  }

  const localMoved = local !== base;
  const remoteMoved = remote !== base;

  if (!localMoved && !remoteMoved) return { kind: 'up-to-date' };
  if (!localMoved && remoteMoved) return { kind: 'apply-remote' };
  if (localMoved && !remoteMoved) return { kind: 'push-local' };

  // Both moved. Identical outcomes are not a conflict — two machines can make the same edit.
  if (local === remote) return { kind: 'up-to-date' };
  return {
    kind: 'conflict',
    detail: 'this machine and the repo have both changed since the last sync',
  };
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
