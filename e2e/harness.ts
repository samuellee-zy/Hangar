import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
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
  close: () => Promise<void>;
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

  return {
    version: 4,
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
    ...over,
  };
}

export async function launch(
  configOverride?: (origin: string) => unknown | string
): Promise<Harness> {
  const fixture = await startFixtureServer();
  const userData = path.join(os.tmpdir(), `hangar-e2e-${process.pid}-${seq++}`);
  fs.rmSync(userData, { recursive: true, force: true });
  fs.mkdirSync(userData, { recursive: true });

  const seeded = configOverride ? configOverride(fixture.origin) : seedConfig(fixture.origin);
  // A string lets a test write deliberately malformed bytes — the corrupt-config case.
  fs.writeFileSync(
    path.join(userData, 'config.json'),
    typeof seeded === 'string' ? seeded : JSON.stringify(seeded, null, 2)
  );

  const app = await electron.launch({
    args: [path.join(__dirname, '..', 'out', 'main', 'index.js')],
    env: {
      ...process.env,
      HANGAR_USER_DATA: userData,
      // Keep the diagnostic probe out of the way — it drives the app itself and would race the
      // test.
      HANGAR_PROBE: '',
    },
  });

  return {
    app,
    fixture,
    userData,
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
    close: async () => {
      await app.close().catch(() => {});
      await fixture.close();
      fs.rmSync(userData, { recursive: true, force: true });
    },
  };
}
