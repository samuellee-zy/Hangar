import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { _electron as electron, type ElectronApplication, type Page, type TestInfo } from '@playwright/test';
import { startFixtureServer, type FixtureServer } from './fixture-server';

/**
 * Launching the real app against a scratch profile.
 *
 * Every run gets its own `userData`, seeded with a config pointing at the local fixture server.
 * That's what makes these tests deterministic: no network, no login, and nothing they can damage.
 */
export interface Harness {
  app: ElectronApplication;
  fixture: FixtureServer;
  userData: string;
  /** The rail's renderer. Most assertions about the UI go through this. */
  rail: () => Promise<Page>;
  /** The main process's own output, oldest first — the `[sync]`, `[drag]`… lines. */
  log: () => string;
  /**
   * Quits the app, and fails if it won't. A hang is bounded (see `QUIT_TIMEOUT_MS`) and killed, and
   * the error carries the app's last output — a quit that never finished used to surface only as
   * Playwright's 60-second hook timeout, with nothing to say what the app was doing.
   */
  close: (options?: { keepProfile?: boolean }) => Promise<void>;
}

/** Generous: a normal quit — cookie promotion included — takes well under a second. */
const QUIT_TIMEOUT_MS = 15_000;

/** How much of the app's output to keep. Enough to see the last few operations, not a whole run. */
const LOG_LINES = 400;

/**
 * For each spec's `afterEach`. When a test failed, the app's own output goes into the report and
 * onto the console — CI's log is often the only thing that can be read afterwards.
 */
export async function tearDown(h: Harness | undefined, testInfo: TestInfo): Promise<void> {
  if (!h) return;
  if (testInfo.status !== testInfo.expectedStatus) {
    const log = h.log();
    await testInfo.attach('main-process.log', { body: log, contentType: 'text/plain' });
    console.error(`--- main process, last output (${testInfo.title}) ---\n${tail(log, 60)}`);
  }
  await h.close();
}

function tail(log: string, lines: number): string {
  return log.split('\n').slice(-lines).join('\n');
}

let seq = 0;

/** A config with two services on the fixture origin, both custom so no catalog URL applies. */
export function seedConfig(origin: string, over: Record<string, unknown> = {}) {
  const service = (id: string, name: string, urlPath: string) => ({
    id,
    catalogId: '__custom',
    name,
    url: `${origin}${urlPath}`,
    accountId: `acct-${id}`,
    notifications: true,
    hibernate: true,
    zoom: 1,
    // Without this every navigation is treated as external and bounced to the system browser,
    // which looks exactly like the page failing to load.
    allowedHosts: ['127.0.0.1'],
    color: '#4A154B',
  });

  // Overrides are merged one level into `preferences` rather than replacing it, so a test that
  // sets `sync` or `appearance` still gets `blockAds: false` below.
  const { preferences: overPreferences, ...rest } = over as {
    preferences?: Record<string, unknown>;
  };

  return {
    version: 5,
    accounts: [
      { id: 'acct-one', label: 'One', provider: 'custom', partition: 'persist:acct-one' },
      { id: 'acct-two', label: 'Two', provider: 'custom', partition: 'persist:acct-two' },
    ],
    services: [service('one', 'One', '/'), service('two', 'Two', '/unread')],
    workspaces: [
      {
        id: 'w1',
        name: 'All',
        items: [
          { kind: 'service', id: 'one' },
          { kind: 'service', id: 'two' },
        ],
      },
    ],
    activeWorkspaceId: 'w1',
    layouts: {},
    preferences: {
      // Off for the same reason the fixture server exists: these tests are meant to touch nothing
      // outside the machine, and `blockAds` is the one thing in the app that fetches at startup.
      //
      // It also cost stability, not just time. Building the engine allocates hard enough to
      // trigger a major GC a few hundred ms into every launch, and V8 collects the pending
      // `app.evaluate` promise along with it — Playwright reports "Resulting promise was garbage
      // collected" and every later evaluate in that test fails too. It landed on a different test
      // each run, which is what made it look like flakiness rather than one cause.
      network: { blockAds: false },
      ...overPreferences,
    },
    ...rest,
  };
}

export async function launch(
  configOverride?: (origin: string) => unknown | string,
  /**
   * Reuse an existing profile instead of creating one.
   *
   * The restart tests need this: relaunching against a *fresh* userData proves nothing about
   * whether state survives, which is the whole question.
   */
  options: {
    reuseUserData?: string;
    /** More command-line arguments for the app, after its entry point — `--open two`. */
    args?: string[];
  } = {}
): Promise<Harness> {
  const fixture = await startFixtureServer();
  const reusing = Boolean(options.reuseUserData);
  const userData = options.reuseUserData ?? path.join(os.tmpdir(), `hangar-e2e-${process.pid}-${seq++}`);
  if (!reusing) {
    fs.rmSync(userData, { recursive: true, force: true });
    fs.mkdirSync(userData, { recursive: true });
  }

  // A reused profile keeps whatever is already on disk — that is the point of reusing it.
  if (!reusing) {
    const seeded = configOverride ? configOverride(fixture.origin) : seedConfig(fixture.origin);
    // A string lets a test write deliberately malformed bytes — the corrupt-config case.
    fs.writeFileSync(
      path.join(userData, 'config.json'),
      typeof seeded === 'string' ? seeded : JSON.stringify(seeded, null, 2)
    );
  }

  // Inherited, minus one. `ELECTRON_RUN_AS_NODE` turns the Electron binary into a plain node, which
  // then rejects `--remote-debugging-port` and reports only "Process failed to launch!" — a
  // confusing way to discover that whatever spawned the test run had it set.
  const { ELECTRON_RUN_AS_NODE: _asNode, ...inherited } = process.env;

  const app = await electron.launch({
    args: [path.join(__dirname, '..', 'out', 'main', 'index.js'), ...(options.args ?? [])],
    env: {
      ...inherited,
      HANGAR_USER_DATA: userData,
      // Tells the app no one is at the screen: see `reportFatal`.
      HANGAR_E2E: '1',
    },
  });

  const output: string[] = [];
  const keep = (chunk: Buffer) => {
    for (const line of chunk.toString('utf8').split('\n')) if (line.trim()) output.push(line);
    if (output.length > LOG_LINES) output.splice(0, output.length - LOG_LINES);
  };
  app.process().stdout?.on('data', keep);
  app.process().stderr?.on('data', keep);

  return {
    app,
    fixture,
    userData,
    log: () => output.join('\n'),
    rail: async () => {
      // Windows arrive in load order; the rail is the shell's own renderer, identified by its
      // route hash rather than by position, which is not stable.
      for (let attempt = 0; attempt < 40; attempt++) {
        for (const page of app.windows()) {
          if (page.url().includes('#rail')) return page;
        }
        await new Promise((r) => setTimeout(r, 250));
      }
      throw new Error(`no rail window; saw ${app.windows().map((w) => w.url()).join(', ')}`);
    },
    close: async ({ keepProfile = false } = {}) => {
      let timer: NodeJS.Timeout | undefined;
      const quit = await Promise.race([
        // An app that already exited — the --quit tests — rejects here, which is a quit too.
        app.close().then(
          () => true,
          () => true
        ),
        new Promise<false>((resolve) => (timer = setTimeout(() => resolve(false), QUIT_TIMEOUT_MS))),
      ]);
      clearTimeout(timer);
      if (!quit) app.process().kill('SIGKILL');
      await fixture.close();
      if (!keepProfile) fs.rmSync(userData, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      if (!quit) {
        throw new Error(
          `the app did not quit within ${QUIT_TIMEOUT_MS / 1000}s and was killed. Its last output:\n` +
            tail(output.join('\n'), 80)
        );
      }
    },
  };
}
