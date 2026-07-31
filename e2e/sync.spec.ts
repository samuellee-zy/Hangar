import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, expect } from '@playwright/test';
import { launch, seedConfig, type Harness } from './harness';

/**
 * Config sync, driven through the real app against a real git repo.
 *
 * Every bug this feature shipped with survived a full suite of unit tests. They passed because they
 * exercised the design — two machines taking turns — rather than the way it gets used: one machine
 * with changes that never pushed, a restart, and a conflict nobody planned for.
 *
 * So these run git for real.
 */

let h: Harness;
let scratch: string;

function git(repo: string, ...args: string[]) {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8' });
}

/** A bare origin plus one clone, with an identity so commits work. */
function makeRepo(): { origin: string; clone: string } {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-sync-'));
  const origin = path.join(scratch, 'origin.git');
  const clone = path.join(scratch, 'clone');
  execFileSync('git', ['init', '-q', '--bare', origin]);
  execFileSync('git', ['clone', '-q', origin, clone]);
  git(clone, 'config', 'user.email', 'test@example.com');
  git(clone, 'config', 'user.name', 'Test');
  return { origin, clone };
}

const services = (dir: string, file: string) =>
  (JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')).services as { name: string }[]).map(
    (s) => s.name
  );

test.afterEach(async () => {
  await h?.close();
  if (scratch) fs.rmSync(scratch, { recursive: true, force: true });
});

test('seeds an empty repo, and never commits the Firebase credential', async () => {
  const { clone } = makeRepo();
  h = await launch((origin) => ({
    ...seedConfig(origin),
    preferences: {
      sync: { repoPath: clone },
      notifications: {
        firebase: { projectId: 'p', appId: 'a', apiKey: 'SUPER-SECRET', messagingSenderId: 'm' },
      },
    },
  }));
  await h.rail();

  await expect.poll(() => fs.existsSync(path.join(clone, 'hangar.config.json')), { timeout: 20_000 })
    .toBe(true);

  // The security case: preferences travel as a block, and one of them is an API key.
  const committed = fs.readFileSync(path.join(clone, 'hangar.config.json'), 'utf8');
  expect(committed).not.toContain('SUPER-SECRET');
  expect(committed).not.toContain('apiKey');
  // The repo path is the transport's own config — syncing it kills sync on the other machine.
  expect(committed).not.toContain(clone);
});

test('LOCAL CHANGES THAT NEVER PUSHED SURVIVE A RESTART', async () => {
  // The P0. Add a service, quit before the debounce fires, relaunch. The old code pulled the
  // repo's older copy over the top and the service was gone.
  const { clone } = makeRepo();
  const withRepo = (origin: string) => ({
    ...seedConfig(origin),
    preferences: { sync: { repoPath: clone } },
  });

  h = await launch(withRepo);
  await h.rail();
  await expect.poll(() => fs.existsSync(path.join(clone, 'hangar.config.json')), { timeout: 20_000 })
    .toBe(true);
  const userData = h.userData;
  await h.close({ keepProfile: true });

  // Add a service directly, exactly as a quit-inside-the-debounce would leave things.
  const configPath = path.join(userData, 'config.json');
  const local = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  local.services.push({
    id: 'added',
    catalogId: '__custom',
    name: 'AddedOffline',
    url: 'http://127.0.0.1/',
    accountId: 'acct-one',
    notifications: true,
    hibernate: true,
    zoom: 1,
    allowedHosts: ['127.0.0.1'],
  });
  fs.writeFileSync(configPath, JSON.stringify(local, null, 2));
  expect(services(clone, 'hangar.config.json')).not.toContain('AddedOffline');

  // Relaunch against the SAME profile — a fresh one would prove nothing.
  h = await launch(undefined, { reuseUserData: userData });
  await h.rail();

  await expect
    .poll(() => JSON.parse(fs.readFileSync(configPath, 'utf8')).services.map((s: { name: string }) => s.name))
    .toContain('AddedOffline');
});

/**
 * Diverges both sides while the app is CLOSED.
 *
 * Editing the repo under a running app races its own debounced reconcile, which can rewrite the
 * file between the test's write and its commit — `git commit` then fails with "nothing to commit"
 * for reasons that have nothing to do with what's being tested. Two machines never edit
 * simultaneously anyway; that isn't the scenario.
 */
async function divergeWhileClosed(clone: string): Promise<string> {
  const userData = h.userData;
  await h.close({ keepProfile: true });

  const configPath = path.join(userData, 'config.json');
  const local = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  local.services[0].name = 'RenamedLocally';
  fs.writeFileSync(configPath, JSON.stringify(local, null, 2));

  const repoFile = path.join(clone, 'hangar.config.json');
  const remote = JSON.parse(fs.readFileSync(repoFile, 'utf8'));
  remote.services[0].name = 'RenamedInRepo';
  fs.writeFileSync(repoFile, JSON.stringify(remote, null, 2));
  git(clone, 'add', 'hangar.config.json');
  git(clone, 'commit', '-m', 'remote edit');
  git(clone, 'push');

  h = await launch(undefined, { reuseUserData: userData });
  await h.rail();
  return configPath;
}

test('a conflict is reported and NEITHER side is modified', async () => {
  const { clone } = makeRepo();
  h = await launch((origin) => ({
    ...seedConfig(origin),
    preferences: { sync: { repoPath: clone } },
  }));
  await h.rail();
  await expect.poll(() => fs.existsSync(path.join(clone, 'hangar.config.json')), { timeout: 20_000 })
    .toBe(true);

  const configPath = await divergeWhileClosed(clone);
  const repoFile = path.join(clone, 'hangar.config.json');

  const status = await h.app.evaluate(async () => {
    const shell = (globalThis as never as {
      __hangarShell?: { dispatch: (c: unknown) => boolean; state: () => { syncStatus: { state: string } } };
    }).__hangarShell!;
    shell.dispatch({ type: 'sync-now' });
    await new Promise((r) => setTimeout(r, 4000));
    return shell.state().syncStatus.state;
  });

  expect(status).toBe('conflict');
  expect(JSON.parse(fs.readFileSync(configPath, 'utf8')).services[0].name).toBe('RenamedLocally');
  expect(JSON.parse(fs.readFileSync(repoFile, 'utf8')).services[0].name).toBe('RenamedInRepo');
});

test('KEEP REPO adopts the repo, and KEEP LOCAL pushes this machine', async () => {
  // Both resolution branches originally wrote the *remote* as the base, which made them identical —
  // so "Keep repo" pushed local over the repo, the precise opposite of its label. A conflict UI
  // that does the wrong thing is worse than none, because the user believes it.
  const { clone } = makeRepo();
  h = await launch((origin) => ({
    ...seedConfig(origin),
    preferences: { sync: { repoPath: clone } },
  }));
  await h.rail();
  const repoFile = path.join(clone, 'hangar.config.json');
  await expect.poll(() => fs.existsSync(repoFile), { timeout: 20_000 }).toBe(true);

  const configPath = await divergeWhileClosed(clone);

  // Fire and return immediately. Awaiting inside `evaluate` while `onApplied` tears down and
  // rebuilds every pane keeps the call open long enough to trip Playwright's own timeout — poll
  // the file instead, which is what actually has to change.
  await h.app.evaluate(() => {
    (globalThis as never as { __hangarShell?: { dispatch: (c: unknown) => boolean } })
      .__hangarShell!.dispatch({ type: 'resolve-sync', winner: 'remote' });
  });

  // Keep repo → this machine adopts the repo's name, not the other way round.
  await expect
    .poll(() => JSON.parse(fs.readFileSync(configPath, 'utf8')).services[0].name, { timeout: 30_000 })
    .toBe('RenamedInRepo');
});
