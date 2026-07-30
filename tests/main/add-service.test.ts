// Exercises the "+ button" path end to end at the config layer: adding a catalog service, adding
// a second account for one that already exists, and adding a custom URL.
//
// This exists because the failure mode is invisible from the UI — a throw inside the main-process
// command handler looks exactly like a button that does nothing.
//

import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// config.ts writes on load, so start from a clean directory every run.
fs.rmSync(path.join(os.tmpdir(), 'hangar-check'), { recursive: true, force: true });

const { addService, loadConfig, makeCustomInstance, makeInstance } = await import(
  '../../src/main/config'
);


const config = loadConfig();
const partitionOf = (svc) => config.accounts.find((a) => a.id === svc.accountId).partition;

describe("adding a catalog service", () => {

  it('the default config is well formed', () => {
    assert.ok(config.services.length > 0);
    assert.ok(config.accounts.length > 0);
    assert.ok(config.preferences?.appearance, 'preferences are part of a fresh config');
    assert.equal(config.version, 4);
  });

  it('adding Drive reuses the existing Google account — no second sign-in', () => {
    const gmail = config.services.find((s) => s.catalogId === 'gmail');
    const drive = addService(config, makeInstance(config, 'gdrive'));
    assert.equal(drive.accountId, gmail.accountId);
    assert.equal(partitionOf(drive), partitionOf(gmail));
  });

  it('the new service lands in the active workspace — otherwise it renders nowhere', () => {
    const drive = config.services.find((s) => s.catalogId === 'gdrive');
    const workspace = config.workspaces.find((w) => w.id === config.activeWorkspaceId);
    const inTree = workspace.items.some((i) => i.kind === 'service' && i.id === drive.id);
    assert.ok(inTree, 'missing from the active workspace rail tree');
  });
});

describe("adding a second account", () => {

  it('a second Gmail gets its own account AND its own partition', () => {
    const first = config.services.find((s) => s.catalogId === 'gmail');
    const second = addService(config, makeInstance(config, 'gmail', { forceNewAccount: true }));
    assert.notEqual(second.accountId, first.accountId);
    assert.notEqual(partitionOf(second), partitionOf(first), 'two mailboxes need two cookie jars');
  });

  it('the second Gmail does not disturb Calendar, which still rides the first login', () => {
    const gcal = config.services.find((s) => s.catalogId === 'gcal');
    const firstGmail = config.services.find((s) => s.catalogId === 'gmail');
    assert.equal(gcal.accountId, firstGmail.accountId);
  });
});

describe("adding a custom connection", () => {

  it('a custom URL produces a usable instance', () => {
    const svc = addService(
      config,
      makeCustomInstance(config, { name: 'Grafana', url: 'https://grafana.example.com/d/abc' })
    );
    assert.equal(svc.name, 'Grafana');
    assert.equal(svc.url, 'https://grafana.example.com/d/abc');
    assert.ok(svc.color, 'needs a colour — there is no catalog entry to borrow one from');
  });

  it('its allowlist is the exact host — never a guessed registrable domain', () => {
    const svc = config.services.find((s) => s.name === 'Grafana');
    assert.deepEqual(svc.allowedHosts, ['grafana.example.com']);
  });

  it('a multi-part TLD does not open the allowlist to the whole suffix', () => {
    // The old `split('.').slice(-2)` turned foo.example.co.uk into `co.uk`, letting every .co.uk
    // site navigate inside the app.
    const svc = makeCustomInstance(config, { name: 'UK', url: 'https://foo.example.co.uk/' });
    assert.deepEqual(svc.allowedHosts, ['foo.example.co.uk']);
    assert.ok(!svc.allowedHosts.includes('co.uk'));
  });

  it('a custom connection gets an isolated account of its own', () => {
    const svc = config.services.find((s) => s.name === 'Grafana');
    const partitions = config.services.filter((s) => s.id !== svc.id).map(partitionOf);
    assert.ok(!partitions.includes(partitionOf(svc)));
  });

  it('a bare host is rejected before it can create a broken service', () => {
    assert.throws(() => makeCustomInstance(config, { name: 'x', url: 'not a url' }));
  });
});
