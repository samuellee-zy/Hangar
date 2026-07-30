import { randomUUID } from 'node:crypto';
import { catalogById } from '../shared/catalog';
import type { Account, Config, ServiceInstance } from '../shared/types';

/**
 * Accounts own cookie jars; services borrow them.
 *
 * The invariant that matters: `Account.partition` is written once at creation and never derived
 * from anything mutable. A partition name *is* the identity of a cookie jar in Chromium, so if it
 * were computed from the account id or label, renaming an account — or changing the naming scheme,
 * which is exactly what this refactor does — would silently orphan every session on disk.
 */

export const accountsForProvider = (config: Config, provider: string): Account[] =>
  config.accounts.filter((a) => a.provider === provider);

export const accountById = (config: Config, id: string): Account | undefined =>
  config.accounts.find((a) => a.id === id);

/** "Google", then "Google (2)", "Google (3)" — renamable afterwards. */
function defaultLabel(config: Config, provider: string): string {
  const pretty = provider.charAt(0).toUpperCase() + provider.slice(1);
  const existing = accountsForProvider(config, provider).length;
  return existing === 0 ? pretty : `${pretty} (${existing + 1})`;
}

export function createAccount(config: Config, provider: string, label?: string): Account {
  const id = randomUUID();
  const account: Account = {
    id,
    provider,
    label: label ?? defaultLabel(config, provider),
    // New accounts use the acct- scheme. Migrated ones keep grp- forever; both are just opaque
    // strings once written, which is the whole point.
    partition: `persist:acct-${id}`,
  };
  config.accounts.push(account);
  return account;
}

/**
 * The account a newly added service should use by default: the provider's first existing account
 * if there is one — so adding Calendar rides the Google login you already have — otherwise a new
 * one. Adding a *second* Gmail is the caller passing `forceNew`.
 */
export function resolveAccount(config: Config, provider: string, forceNew = false): Account {
  if (!forceNew) {
    const existing = accountsForProvider(config, provider)[0];
    if (existing) return existing;
  }
  return createAccount(config, provider);
}

/**
 * v1 → v2. Each distinct `sessionGroup` becomes an Account that **keeps its original partition
 * name**, so upgrading doesn't sign anyone out. Provider comes from the catalog entry of the first
 * service in the group.
 */
export function migrateV1(raw: {
  services?: Array<ServiceInstance & { sessionGroup?: string }>;
}): { accounts: Account[]; services: ServiceInstance[] } {
  const accounts: Account[] = [];
  const byGroup = new Map<string, Account>();
  const services: ServiceInstance[] = [];

  for (const svc of raw.services ?? []) {
    const group = svc.sessionGroup ?? svc.catalogId;
    const provider = catalogById(svc.catalogId)?.provider ?? 'custom';

    let account = byGroup.get(group);
    if (!account) {
      const seen = accounts.filter((a) => a.provider === provider).length;
      const pretty = provider.charAt(0).toUpperCase() + provider.slice(1);
      account = {
        id: randomUUID(),
        provider,
        label: seen === 0 ? pretty : `${pretty} (${seen + 1})`,
        // Verbatim reuse — this line is why the upgrade is lossless.
        partition: `persist:grp-${group}`,
      };
      byGroup.set(group, account);
      accounts.push(account);
    }

    const { sessionGroup: _dropped, ...rest } = svc;
    services.push({ ...rest, accountId: account.id });
  }

  return { accounts, services };
}
