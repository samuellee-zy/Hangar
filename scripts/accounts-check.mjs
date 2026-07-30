// The v1 → v2 migration is the riskiest change in Phase 1.5: a partition name IS the identity of
// a cookie jar in Chromium, so getting it wrong signs you out of every service at once, silently,
// with the old jars orphaned on disk. These checks pin the invariant.
//
// Run: npm run check:accounts

import assert from 'node:assert/strict';
import { accountsForProvider, createAccount, migrateV1, resolveAccount } from '../out-check/accounts.mjs';

let checks = 0;
const ok = (label, fn) => {
  fn();
  checks++;
  console.log(`  ✓ ${label}`);
};

// Shape of a real v1 config: Gmail and Calendar shared the 'gmail' group, everything else its own.
const v1 = {
  services: [
    { id: 's1', catalogId: 'gmail', name: 'Gmail', sessionGroup: 'gmail', zoom: 1 },
    { id: 's2', catalogId: 'gcal', name: 'Calendar', sessionGroup: 'gmail', zoom: 1 },
    { id: 's3', catalogId: 'slack', name: 'Slack', sessionGroup: 'slack', zoom: 1 },
    { id: 's4', catalogId: 'teams', name: 'Teams', sessionGroup: 'teams', zoom: 1 },
  ],
};

console.log('v1 → v2 migration');

ok('every original partition name survives verbatim — nobody gets signed out', () => {
  const { accounts } = migrateV1(v1);
  const partitions = accounts.map((a) => a.partition).sort();
  assert.deepEqual(partitions, ['persist:grp-gmail', 'persist:grp-slack', 'persist:grp-teams']);
});

ok('services that shared a session group share one account', () => {
  const { services } = migrateV1(v1);
  const [gmail, gcal] = services;
  assert.equal(gmail.accountId, gcal.accountId, 'Gmail and Calendar keep one Google login');
});

ok('distinct groups stay distinct — no accidental jar merging', () => {
  const { accounts, services } = migrateV1(v1);
  assert.equal(accounts.length, 3);
  assert.equal(new Set(services.map((s) => s.accountId)).size, 3);
});

ok('provider is inferred from the catalog', () => {
  const { accounts, services } = migrateV1(v1);
  const byId = Object.fromEntries(accounts.map((a) => [a.id, a]));
  assert.equal(byId[services[0].accountId].provider, 'google');
  assert.equal(byId[services[2].accountId].provider, 'slack');
  assert.equal(byId[services[3].accountId].provider, 'microsoft');
});

ok('the obsolete sessionGroup field is dropped from services', () => {
  const { services } = migrateV1(v1);
  for (const s of services) assert.equal('sessionGroup' in s, false);
});

ok('a service with no sessionGroup falls back to its catalog id', () => {
  const { accounts } = migrateV1({ services: [{ id: 'x', catalogId: 'notion', zoom: 1 }] });
  assert.equal(accounts[0].partition, 'persist:grp-notion');
});

console.log('account resolution');

const freshConfig = () => ({ version: 2, accounts: [], services: [], workspaces: [], layouts: {} });

ok('a second service on the same provider reuses the existing account', () => {
  const c = freshConfig();
  const first = resolveAccount(c, 'google');
  const second = resolveAccount(c, 'google');
  assert.equal(first.id, second.id, 'Calendar should ride Gmail login');
  assert.equal(c.accounts.length, 1);
});

ok('forceNew creates a separate account with a separate partition — "add another Gmail"', () => {
  const c = freshConfig();
  const first = resolveAccount(c, 'google');
  const second = resolveAccount(c, 'google', true);
  assert.notEqual(first.id, second.id);
  assert.notEqual(first.partition, second.partition, 'two mailboxes need two cookie jars');
  assert.equal(accountsForProvider(c, 'google').length, 2);
});

ok('new accounts use the acct- scheme, never colliding with migrated grp- names', () => {
  const c = freshConfig();
  const a = createAccount(c, 'google');
  assert.match(a.partition, /^persist:acct-/);
});

ok('labels disambiguate additional accounts on the same provider', () => {
  const c = freshConfig();
  assert.equal(createAccount(c, 'google').label, 'Google');
  assert.equal(createAccount(c, 'google').label, 'Google (2)');
  assert.equal(createAccount(c, 'slack').label, 'Slack');
});

console.log(`\n${checks} checks passed`);
