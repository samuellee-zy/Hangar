// The public-repo guard, driven through the real ConfigSync against a real git repo.
//
// Everything the guard *decides* is pure and tested in sync.test.ts. This tests the one thing those
// tests structurally cannot see: whether the probe is called at all.
//
// That is not a hypothetical gap. This project has shipped a function with zero call sites, a
// duplicated block, and three dependency rules that silently matched nothing — every one of them
// passing a full suite. A guard nobody invokes is indistinguishable from a guard that always
// approves, and no amount of unit-testing the verdict table would tell them apart.
//
// Hermetic: `git` runs against a temp repo, `fetch` is stubbed. Nothing here touches the network.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfigSync } from '@main/features/sync';
import { DEFAULT_PREFERENCES } from '@core/config/preferences';
import type { Config, SyncStatus } from '@shared/types';

let scratch: string;
let repo: string;
let fetchMock: ReturnType<typeof vi.fn>;

const PUBLIC_URL = 'https://github.com/owner/repo';

function config(allowPublicRepo = false): Config {
  return {
    version: 4,
    preferences: {
      ...DEFAULT_PREFERENCES,
      sync: { repoPath: repo, allowPublicRepo },
    },
    accounts: [{ id: 'a1', label: 'Google', provider: 'google', partition: 'persist:grp-google' }],
    services: [],
    workspaces: [{ id: 'w', name: 'All', items: [] }],
    activeWorkspaceId: 'w',
    layouts: {},
    pushRegistrations: [],
    window: { x: 0, y: 0, width: 1440, height: 900 },
  } as unknown as Config;
}

/** A ConfigSync wired to the temp repo. `write` throws: nothing here should reach it. */
function makeSync(allowPublicRepo = false) {
  const current = config(allowPublicRepo);
  return new ConfigSync({
    repoPath: () => repo,
    allowPublicRepo: () => allowPublicRepo,
    read: () => current,
    write: () => {
      throw new Error('the guard let a write through');
    },
    readBase: () => null,
    writeBase: () => {},
    onApplied: () => {},
    onStatusChange: () => {},
    log: () => {},
  });
}

beforeEach(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-guard-'));
  repo = path.join(scratch, 'clone');
  execFileSync('git', ['init', '-q', repo]);
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repo });

  // 200 = "anyone can read this". The refusal path never reaches `git fetch`, so no network.
  fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  fs.rmSync(scratch, { recursive: true, force: true });
});

const setOrigin = (url: string) =>
  execFileSync('git', ['remote', 'add', 'origin', url], { cwd: repo });

describe('a repo whose origin is world-readable', () => {
  it('IS PROBED — proving the guard is wired into ready(), not merely written', async () => {
    setOrigin(`${PUBLIC_URL}.git`);
    await makeSync().reconcile();

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(PUBLIC_URL);
    // HEAD: only the status matters, and these pages are not small.
    expect((init as RequestInit).method).toBe('HEAD');
  });

  it('is refused, with a reason that names the repo', async () => {
    setOrigin(`${PUBLIC_URL}.git`);
    const status = await makeSync().reconcile();

    expect(status.state).toBe('unavailable');
    expect((status as Extract<SyncStatus, { state: 'unavailable' }>).reason).toContain(PUBLIC_URL);
  });

  it('the override lets it through', async () => {
    setOrigin(`${PUBLIC_URL}.git`);
    const status = await makeSync(true).reconcile();

    // It still probes — the override suppresses the refusal, not the question. What happens after
    // is a git failure against an origin that isn't really there, which is not what's under test.
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(status.state).not.toBe('unavailable');
  });
});

describe('repos where the question does not arise', () => {
  it('a local origin is never probed', async () => {
    // The common private case, and the one the first draft of this guard got wrong by refusing it.
    setOrigin(path.join(scratch, 'somewhere.git'));
    await makeSync().reconcile();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a self-hosted forge is never probed', async () => {
    // An internal GitLab can answer 200 to a laptop on the VPN for a repo no outsider can reach.
    setOrigin('git@git.internal.example:team/dotfiles.git');
    await makeSync().reconcile();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('no origin at all is never probed', async () => {
    await makeSync().reconcile();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('failing open', () => {
  it.each([
    [404, 'private, or nonexistent — GitHub refuses to distinguish them'],
    [500, 'the forge is having a bad day'],
  ])('a %s response does not refuse (%s)', async (status) => {
    setOrigin(`${PUBLIC_URL}.git`);
    fetchMock.mockResolvedValue(new Response(null, { status }));
    const result = await makeSync().reconcile();

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(result.state).not.toBe('unavailable');
  });

  it('a network failure does not refuse — sync must survive a train tunnel', async () => {
    setOrigin(`${PUBLIC_URL}.git`);
    fetchMock.mockRejectedValue(new Error('getaddrinfo ENOTFOUND github.com'));
    const result = await makeSync().reconcile();

    expect(result.state).not.toBe('unavailable');
  });
});

describe('the probe is cached', () => {
  it('two reconciles make one request', async () => {
    // `schedule()` debounces at 5s and config is written on every preference change. Without the
    // cache this is one HTTP request per keystroke-ish, to a host that rate-limits.
    setOrigin(`${PUBLIC_URL}.git`);
    const sync = makeSync();
    await sync.reconcile();
    await sync.reconcile();
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
