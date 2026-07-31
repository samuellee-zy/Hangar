import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  applyIncoming,
  hasDiverged,
  serialise,
  validateIncoming,
  type SyncStatus,
} from '@core/config/sync';
import type { Config } from '@shared/types';

const run = promisify(execFile);

/**
 * Git-backed config sync.
 *
 * A repo you already control: pull on launch, commit and push when the portable half of the config
 * changes. No server, no account, no protocol — and you get history and a real conflict model for
 * free, which matters because config is the one thing this project has already destroyed once.
 *
 * `core/config/sync.ts` decides *what* travels; this moves it.
 *
 * **Conflicts are never resolved automatically.** A merge algorithm guessing at which machine's
 * rename of a service to keep can cost an account-to-partition mapping, and that signs you out of
 * something you never touched. On divergence this stops, reports, and leaves the repo for you.
 */

const CONFIG_FILE = 'hangar.config.json';

export interface SyncDeps {
  repoPath: () => string | null;
  read: () => Config;
  write: (config: Config) => void;
  /** Called after an incoming config lands, so the window can rebuild. */
  onApplied: () => void;
  log: (message: string) => void;
}

export class ConfigSync {
  private status: SyncStatus = { state: 'off' };
  private timer: NodeJS.Timeout | null = null;
  private busy = false;

  constructor(private deps: SyncDeps) {}

  current(): SyncStatus {
    return this.status;
  }

  /** Pull and apply. Called once at boot and from the Settings button. */
  async pull(): Promise<SyncStatus> {
    const repo = await this.ready();
    if (!repo) return this.status;

    // Fetch first, unconditionally. It never merges, so it's always safe — and it's the only way
    // to know whether the *remote* has anything.
    //
    // The earlier version asked whether the **local** clone had commits, which is the wrong repo:
    // a clone taken before the other machine's first push is locally empty while the remote is
    // not. It then skipped the pull, decided it should seed, and had the push rejected. Only a
    // genuine two-machine test surfaces that.
    try {
      await this.git(repo, ['fetch']);
    } catch (error) {
      return this.set({ state: 'error', detail: describe(error) });
    }

    const remote = await this.remoteRef(repo);
    if (remote) {
      try {
        if (await this.hasLocalHead(repo)) {
          // `--ff-only`: a merge commit created behind your back is how a sync tool loses data. A
          // genuine divergence is a disagreement, and it's yours to resolve.
          await this.git(repo, ['merge', '--ff-only', remote]);
        } else {
          // Unborn HEAD — a clone taken while the remote was still empty. There are no local
          // commits to lose, and `merge` refuses this case outright ("unrelated histories"), so
          // adopt the remote wholesale. Untracked files are left alone by `reset --hard`.
          await this.git(repo, ['reset', '--hard', remote]);
        }
      } catch (error) {
        return this.set({ state: 'conflict', detail: describe(error) });
      }
    }

    const file = path.join(repo, CONFIG_FILE);
    if (!fs.existsSync(file)) {
      this.deps.log('no synced config in the repo yet; seeding it from this machine');
      this.set({ state: 'idle', lastSync: Date.now() });
      return this.push();
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (error) {
      return this.set({ state: 'error', detail: `synced config is not valid JSON: ${describe(error)}` });
    }

    const local = this.deps.read();
    const verdict = validateIncoming(parsed, local);
    if (!verdict.ok) {
      // Refusing is the safe answer. Applying a config that would orphan an account makes services
      // permanently unloadable, and the user didn't ask for that on this machine.
      return this.set({ state: 'error', detail: verdict.reason });
    }

    const merged = applyIncoming(local, verdict.config);
    if (!hasDiverged(local, merged)) return this.set({ state: 'idle', lastSync: Date.now() });

    this.deps.write(merged);
    this.deps.onApplied();
    this.deps.log('applied an incoming config');
    return this.set({ state: 'idle', lastSync: Date.now() });
  }

  /**
   * Commit and push if the portable half changed.
   *
   * Debounced hard: config is written on every preference change, every reorder and a 400ms
   * window-bounds debounce. Committing on each would produce a repo of noise — and `hasDiverged`
   * already ignores the machine-local fields that cause most of those writes.
   */
  schedulePush(): void {
    if (this.deps.repoPath() === null) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.push(), 5_000);
    this.timer.unref?.();
  }

  async push(): Promise<SyncStatus> {
    const repo = await this.ready();
    if (!repo || this.busy) return this.status;
    this.busy = true;
    try {
      const file = path.join(repo, CONFIG_FILE);
      const next = serialise(this.deps.read());
      const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
      if (existing === next) return this.set({ state: 'idle', lastSync: Date.now() });

      fs.writeFileSync(file, next);
      await this.git(repo, ['add', CONFIG_FILE]);
      // `--allow-empty-message` is deliberately not used: a readable history is most of the reason
      // to choose git over a blob store.
      await this.git(repo, ['commit', '-m', `Hangar config from ${hostLabel()}`]);
      try {
        await this.git(repo, ['push']);
      } catch {
        // First push to a fresh repo: no upstream to push to yet.
        await this.git(repo, ['push', '-u', 'origin', 'HEAD']);
      }
      this.deps.log('pushed config');
      return this.set({ state: 'idle', lastSync: Date.now() });
    } catch (error) {
      return this.set({ state: 'error', detail: describe(error) });
    } finally {
      this.busy = false;
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
      // Xcode command line tools missing, most likely. Saying so beats a silent no-op.
      this.set({ state: 'unavailable', reason: 'git is not available on PATH' });
      return null;
    }
    return repo;
  }

  /** Whether this clone has any commits of its own. False right after cloning an empty repo. */
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
   * `@{upstream}` isn't enough: cloning an *empty* repo leaves the local branch with no tracking
   * configuration at all, which is exactly the second machine's starting state. `FETCH_HEAD` is
   * written by the fetch we just did and doesn't depend on that config.
   */
  private async remoteRef(repo: string): Promise<string | null> {
    for (const ref of ['@{upstream}', 'FETCH_HEAD']) {
      try {
        await this.git(repo, ['rev-parse', '--verify', `${ref}^{commit}`]);
        return ref;
      } catch {
        // Try the next one.
      }
    }
    return null;
  }

  private git(repo: string, args: string[]) {
    // `cwd` rather than `-C`: identical effect, and it keeps the repo path out of the argv that
    // ends up in error messages and logs.
    return run('git', args, { cwd: repo, timeout: 30_000 });
  }

  private set(status: SyncStatus): SyncStatus {
    this.status = status;
    if (status.state === 'error' || status.state === 'conflict') {
      this.deps.log(`${status.state}: ${'detail' in status ? status.detail : ''}`);
    }
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

/** Which machine a commit came from — the first thing you want to know reading the history. */
function hostLabel(): string {
  try {
    return require('node:os').hostname();
  } catch {
    return 'unknown host';
  }
}
