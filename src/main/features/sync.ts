import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  applyIncoming,
  decideSync,
  parseRemote,
  probeUrlFor,
  publicRepoRefusal,
  restoreLocalPreferences,
  serialise,
  validateIncoming,
  visibilityFromStatus,
  type PortableConfig,
  type RepoVisibility,
  type SyncStatus,
} from '@core/config/sync';
import { migrateConfig } from '@core/config/migrate';
import type { Config } from '@shared/types';

const run = promisify(execFile);

/**
 * Git-backed config sync.
 *
 * A repo you already control: no server, no account, no protocol, and history and a real conflict
 * model for free. `core/config/sync.ts` decides *what* travels and *whether* to move it; this moves
 * it.
 *
 * ## One operation, not two
 *
 * There is a single `reconcile()` — fetch, decide against the last-synced base, then act — behind
 * one mutex. The first version had independent `pull()` and `push()`, which produced three separate
 * bugs that were really one: they could interleave and fight over `index.lock`; a push dropped
 * because the other was running was never re-armed; and pushing without fetching first created
 * commits that could never fast-forward. Splitting the operation was the mistake.
 *
 * **The mutex is module-level, not per-instance.** It was `this.running`, which is correct within
 * one `ConfigSync` and absent across two — and there are two whenever ⌘W destroys the window and a
 * dock click builds a fresh `AppWindow`, each with its own `ConfigSync` pointed at the same repo.
 * Both could then run git concurrently, which is exactly the `index.lock` fight the single-operation
 * design exists to prevent. A per-instance flag cannot express "one git at a time on this machine".
 *
 * ## Conflicts are never resolved automatically
 *
 * A merge guessing which machine's rename of a service to keep can cost an account-to-partition
 * mapping, and that signs you out of something you never touched. On divergence this stops and
 * reports; `resolve()` exists for the user to choose explicitly.
 */

const CONFIG_FILE = 'hangar.config.json';

/**
 * Git must never block on a prompt.
 *
 * An HTTPS remote, or an SSH key with a passphrase and no agent, otherwise waits on stdin until the
 * 30-second timeout and surfaces as an opaque failure. These make it fail immediately with a
 * message that names the actual problem.
 */
const NON_INTERACTIVE = {
  GIT_TERMINAL_PROMPT: '0',
  GIT_ASKPASS: '/usr/bin/true',
  SSH_ASKPASS: '/usr/bin/true',
  SSH_ASKPASS_REQUIRE: 'never',
};

/**
 * How long a non-`public` verdict is trusted before re-probing.
 *
 * `public` is cached forever — a repo does not quietly become private, and if it does, the answer
 * only gets safer. Everything else is provisional: it's mostly "we were offline", and caching that
 * permanently would mean one flight turns the guard off for the rest of the process.
 */
const VISIBILITY_TTL_MS = 10 * 60 * 1_000;

/** How long to wait for the probe. Short: it sits in front of every reconcile. */
const PROBE_TIMEOUT_MS = 5_000;

/**
 * Serialises every git-touching pass across every `ConfigSync` instance in the process.
 *
 * A promise chain rather than a boolean, because callers have to *wait* their turn rather than be
 * turned away: an instance that skipped its pass because another was running would drop the change.
 * Both settlement paths are swallowed when extending the chain, or one rejected pass wedges sync
 * for the rest of the process.
 */
let gitQueue: Promise<unknown> = Promise.resolve();

function exclusively<T>(work: () => Promise<T>): Promise<T> {
  const next = gitQueue.then(work, work);
  gitQueue = next.then(
    () => undefined,
    () => undefined
  );
  return next;
}

export interface SyncDeps {
  repoPath: () => string | null;
  /** `preferences.sync.allowPublicRepo` — the override for a repo that probes as world-readable. */
  allowPublicRepo: () => boolean;
  read: () => Config;
  write: (config: Config) => void;
  /** The last-synced snapshot, persisted outside `Config` so it can't sync itself. */
  readBase: () => string | null;
  writeBase: (serialised: string) => void;
  /** Called after an incoming config lands, so the window can rebuild. */
  /** An incoming config was written. `previous` is the config it replaced. */
  onApplied: (previous: Config) => void;
  /** Called whenever status changes, so Settings reflects a background failure. */
  onStatusChange: () => void;
  log: (message: string) => void;
}

export class ConfigSync {
  private status: SyncStatus = { state: 'off' };
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  /** Set when a request arrives mid-run, so it isn't silently dropped. */
  private rerun = false;
  /**
   * Set by `dispose()`. Everything that reaches back into `deps` checks it, because those closures
   * capture an `AppWindow` that no longer exists — `onApplied` calls `restoreLayout()` and
   * `relayout()` on a destroyed `BaseWindow`.
   */
  private disposed = false;
  /** Probe results by web URL, so a reconcile every few seconds isn't a request every few seconds. */
  private visibility = new Map<string, { verdict: RepoVisibility; at: number }>();

  constructor(private deps: SyncDeps) {}

  current(): SyncStatus {
    return this.status;
  }

  /**
   * Debounced. Config is written on every preference change, every reorder and a 400ms
   * window-bounds debounce; reconciling on each would be a repo full of noise. `serialise` already
   * ignores the machine-local fields behind most of those writes, so most of these are no-ops.
   */
  schedule(): void {
    if (this.disposed) return;
    if (this.deps.repoPath() === null) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.reconcile(), 5_000);
    this.timer.unref?.();
  }

  /**
   * Stops this instance for good: cancels the armed debounce and makes any pass already queued or
   * running a no-op.
   *
   * `unref()` on the timer keeps it from holding the process open; it does nothing to stop it
   * firing while the process is alive. And dropping the `onConfigSaved` hook — which is what
   * teardown used to rely on — only prevents *new* schedules. Neither reaches a timer already
   * armed, or a `reconcile()` sitting inside an `await`.
   */
  dispose(): void {
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** Fetch, decide, act. The only thing that touches git. */
  async reconcile(): Promise<SyncStatus> {
    if (this.disposed) return this.status;
    if (this.running) {
      // Re-run rather than drop. `schedule()` has already cleared its timer, so returning here
      // without this flag loses the change entirely.
      this.rerun = true;
      return this.status;
    }
    this.running = true;
    try {
      do {
        this.rerun = false;
        // Re-checked inside the loop as well as at entry: the pass ahead of us in the queue can
        // take tens of seconds, and the window may be gone by the time our turn arrives.
        await exclusively(() => (this.disposed ? Promise.resolve() : this.once()));
      } while (this.rerun && !this.disposed);
    } finally {
      this.running = false;
    }
    return this.status;
  }

  /**
   * Resolves a conflict the only way that's safe: the user says which side wins.
   *
   * Detecting a conflict and offering nothing leaves them stuck forever, so both directions are
   * explicit and each discards something the UI names.
   */
  async resolve(winner: 'local' | 'remote'): Promise<SyncStatus> {
    const repo = await this.ready();
    if (!repo) return this.status;

    // Set the base to the side being DISCARDED. `decideSync` then sees exactly one side as having
    // moved, and does the right thing without needing a special case.
    //
    // Both branches originally wrote the *remote* as the base, which made them identical — so
    // "Keep repo" pushed local over the repo, the precise opposite of its label, discarding the
    // copy the user had just asked to keep.
    if (winner === 'local') {
      // Discarding the remote: base := remote, so local looks ahead → push.
      this.deps.writeBase(this.readRemote(repo) ?? '');
      return this.reconcile();
    }

    if (!this.readRemote(repo)) {
      return this.set({ state: 'error', detail: 'the repo has no config to adopt' });
    }
    // Discarding local: base := local, so the remote looks ahead → apply it.
    this.deps.writeBase(serialise(this.deps.read()));
    return this.reconcile();
  }

  private async once(): Promise<void> {
    const repo = await this.ready();
    if (!repo) return;

    try {
      await this.git(repo, ['fetch']);
    } catch (error) {
      this.set({ state: 'error', detail: describe(error) });
      return;
    }

    // Fast-forward the working tree first so the file on disk is the remote's current state. A
    // genuine history divergence is reported rather than merged.
    const ref = await this.remoteRef(repo);
    if (ref) {
      try {
        if (await this.hasLocalHead(repo)) await this.git(repo, ['merge', '--ff-only', ref]);
        // Unborn HEAD — cloned while the remote was empty. `merge` refuses that as "unrelated
        // histories", and there are no local commits to lose.
        else await this.git(repo, ['reset', '--hard', ref]);
      } catch (error) {
        this.set({ state: 'conflict', detail: describe(error) });
        return;
      }
    }

    const local = this.deps.read();
    const localText = serialise(local);
    const remoteText = this.readRemote(repo);
    const action = decideSync({ local: localText, remote: remoteText, base: this.deps.readBase() });

    switch (action.kind) {
      case 'up-to-date':
        // Record the agreed state, which is what makes the *next* decision meaningful.
        this.deps.writeBase(localText);
        this.set({ state: 'idle', lastSync: Date.now() });
        return;

      case 'push-local':
        await this.commitAndPush(repo, localText);
        return;

      case 'conflict':
        this.set({ state: 'conflict', detail: action.detail });
        return;

      case 'apply-remote':
        this.applyRemote(local, remoteText!, localText);
        return;
    }
  }

  private applyRemote(local: Config, remoteText: string, _localText: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(remoteText);
    } catch (error) {
      this.set({ state: 'error', detail: `synced config is not valid JSON: ${describe(error)}` });
      return;
    }

    // Through the same normalisation `loadConfig` uses. A repo file written by an older build is
    // otherwise adopted verbatim — the exact hole decisions #58 closed for `importConfig`, and
    // sync had reopened it.
    let migrated: Config;
    try {
      migrated = migrateConfig(parsed);
    } catch (error) {
      this.set({ state: 'error', detail: `synced config could not be migrated: ${describe(error)}` });
      return;
    }

    const verdict = validateIncoming(migrated as unknown as PortableConfig, local);
    if (!verdict.ok) {
      // Refusing is the safe answer: a config that orphans an account makes those services
      // permanently unloadable, and the user didn't ask for that on this machine.
      this.set({ state: 'error', detail: verdict.reason });
      return;
    }

    // Machine-local preferences — the Firebase credential above all — never come from the repo.
    const incoming = restoreLocalPreferences(verdict.config, local);
    const merged = applyIncoming(local, incoming);

    // `once()` is only entered while live, but every git call above it is an await — the window can
    // be torn down mid-pass. Landing a config now would write against a stale read and then call
    // `onApplied` on a destroyed window. The repo is unchanged, so the next instance re-decides.
    if (this.disposed) return;

    this.deps.write(merged);
    // The base is what we just agreed on, computed from the merged config so it matches what a
    // subsequent `serialise(local)` will produce.
    this.deps.writeBase(serialise(merged));
    this.deps.onApplied(local);
    this.deps.log('applied an incoming config');
    this.set({ state: 'idle', lastSync: Date.now() });
  }

  private async commitAndPush(repo: string, localText: string): Promise<void> {
    try {
      const file = path.join(repo, CONFIG_FILE);
      // Existence first: readFileSync on a missing file throws, and a missing file is the normal
      // case the very first time this runs.
      const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
      if (existing !== localText) fs.writeFileSync(file, localText);
      await this.git(repo, ['add', '--', CONFIG_FILE]);

      // `--only` commits ONLY this path. Plain `git commit` commits the whole index, and the
      // Settings placeholder is literally `~/code/dotfiles` — a repo you work in. Without this,
      // toggling a preference commits and pushes your half-finished work under Hangar's message.
      //
      // `--no-verify` skips the user's hooks: a lint hook in their dotfiles repo should not be able
      // to break config sync, and we only ever touch our own file.
      try {
        await this.git(repo, [
          'commit',
          '--only',
          '--no-verify',
          '-m',
          `Hangar config from ${os.hostname()}`,
          '--',
          CONFIG_FILE,
        ]);
      } catch (error) {
        // "nothing to commit" means the file already matches what's committed — reachable when a
        // previous run committed but failed to record the base. That's success with nothing to do,
        // not a failure, and reporting it as one would leave sync stuck in `error` forever.
        if (!/nothing (added )?to commit|no changes added/i.test(describe(error))) throw error;
      }
      await this.git(repo, ['push']);

      this.deps.writeBase(localText);
      this.deps.log('pushed config');
      this.set({ state: 'idle', lastSync: Date.now() });
    } catch (error) {
      this.set({ state: 'error', detail: describe(error) });
    }
  }

  /** The repo's copy, or null when there isn't one. */
  private readRemote(repo: string): string | null {
    const file = path.join(repo, CONFIG_FILE);
    try {
      return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
    } catch {
      return null;
    }
  }

  /** Resolves the repo path, or sets an honest status explaining why sync isn't running. */
  private async ready(): Promise<string | null> {
    const repo = this.deps.repoPath();
    if (!repo) {
      this.set({ state: 'off' });
      return null;
    }
    if (!fs.existsSync(path.join(repo, '.git'))) {
      this.set({ state: 'unavailable', reason: `${repo} is not a git repository` });
      return null;
    }
    try {
      await run('git', ['--version']);
    } catch {
      this.set({ state: 'unavailable', reason: 'git is not available on PATH' });
      return null;
    }
    try {
      // `git commit` fails outright without an identity, and the raw error is a wall of advice.
      await this.git(repo, ['config', '--get', 'user.email']);
    } catch {
      this.set({
        state: 'unavailable',
        reason: 'git has no user.email configured, so it cannot commit',
      });
      return null;
    }

    // Last, because it's the only check that touches the network. Placed in `ready()` rather than in
    // `once()` so it also covers `resolve('local')`, which pushes — a guard that only watches the
    // ordinary path is not a guard.
    const probe = await this.probeVisibility(repo);
    if (probe) {
      const refusal = publicRepoRefusal({
        visibility: probe.verdict,
        allowPublicRepo: this.deps.allowPublicRepo(),
        probeUrl: probe.url,
      });
      if (refusal) {
        this.set({ state: 'unavailable', reason: refusal });
        return null;
      }
    }

    return repo;
  }

  /**
   * Asks the internet whether this repo's origin is world-readable.
   *
   * Returns null when there is no question to ask — no origin, a local path, a host where the answer
   * would not be trustworthy. `core/config/sync.ts` holds the parsing and the verdict table; this is
   * only the request and the cache.
   *
   * `fetch` here is Node's, not Chromium's — Electron exposes the Chromium stack separately as
   * `net.fetch`. That distinction is the point: this must be an *anonymous* request, and going
   * through a session would attach whatever GitHub cookies the user's own browsing has left behind,
   * turning "the public can read this" into "I can read this", which is true of every private repo
   * you own.
   */
  private async probeVisibility(repo: string): Promise<{ verdict: RepoVisibility; url: string } | null> {
    let url: string;
    try {
      const { stdout } = await this.git(repo, ['remote', 'get-url', 'origin']);
      const ref = parseRemote(stdout);
      if (!ref) return null;
      const candidate = probeUrlFor(ref);
      if (!candidate) return null;
      url = candidate;
    } catch {
      // No origin at all: a purely local repo, which nobody else can read.
      return null;
    }

    const cached = this.visibility.get(url);
    if (cached && (cached.verdict === 'public' || Date.now() - cached.at < VISIBILITY_TTL_MS)) {
      return { verdict: cached.verdict, url };
    }

    let status: number | null = null;
    try {
      // HEAD, because only the status code matters and these pages are not small.
      const response = await fetch(url, {
        method: 'HEAD',
        redirect: 'follow',
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      });
      status = response.status;
    } catch {
      // Offline, DNS failure, timeout. `visibilityFromStatus(null)` is 'unknown', which allows.
      status = null;
    }

    const verdict = visibilityFromStatus(status);
    this.visibility.set(url, { verdict, at: Date.now() });
    return { verdict, url };
  }

  private async hasLocalHead(repo: string): Promise<boolean> {
    try {
      await this.git(repo, ['rev-parse', '--verify', 'HEAD']);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * The fetched remote tip, or null if the remote is genuinely empty.
   *
   * `@{upstream}` first — it names the branch this one actually tracks. `FETCH_HEAD` is only a
   * fallback, because `rev-parse` takes its first line regardless of the `not-for-merge` marker, so
   * in a multi-branch repo it can point somewhere unrelated. `origin/HEAD` sits between the two.
   */
  private async remoteRef(repo: string): Promise<string | null> {
    for (const ref of ['@{upstream}', 'origin/HEAD', 'FETCH_HEAD']) {
      try {
        await this.git(repo, ['rev-parse', '--verify', `${ref}^{commit}`]);
        return ref;
      } catch {
        // Try the next.
      }
    }
    return null;
  }

  private git(repo: string, args: string[]) {
    // `cwd` rather than `-C`, which keeps the repo path out of the argv in error messages.
    return run('git', args, {
      cwd: repo,
      timeout: 30_000,
      env: { ...process.env, ...NON_INTERACTIVE },
    });
  }

  private set(status: SyncStatus): SyncStatus {
    this.status = status;
    if (this.disposed) return status;
    if (status.state === 'error' || status.state === 'conflict') {
      this.deps.log(`${status.state}: ${'detail' in status ? status.detail : ''}`);
    }
    // Always, not just on the paths that happen to run inside a dispatch — a background failure
    // otherwise leaves Settings showing a stale "Ready".
    this.deps.onStatusChange();
    return status;
  }
}

function describe(error: unknown): string {
  if (error && typeof error === 'object' && 'stderr' in error) {
    const stderr = String((error as { stderr: unknown }).stderr).trim();
    if (stderr) return stderr.split('\n').slice(0, 3).join(' ');
  }
  return error instanceof Error ? error.message : String(error);
}
