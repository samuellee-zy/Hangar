import fs from 'node:fs';
import path from 'node:path';
import { test, expect } from '@playwright/test';
import { launch, seedConfig, tearDown, type Harness } from './harness';

/**
 * Import, through the real handler. The dialogs are stubbed in main — a file chooser and a confirm
 * box need a person — and everything after them is the app's own code.
 */

let h: Harness;
test.afterEach(async ({}, testInfo) => {
  await tearDown(h, testInfo);
});

const FIREBASE = { projectId: 'mine', appId: 'a', apiKey: 'this-machine', messagingSenderId: 'm' };
const REGISTRATION = { serviceId: 'one', vapidKey: 'k', credentials: { token: 't' }, seenIds: [] };

/** Import `file`, answering the confirm with `response`. Returns what the confirm was asked. */
const importFrom = (file: string, response: number) =>
  h.app.evaluate(
    async ({ dialog }, { file, response }) => {
      let asked: Electron.MessageBoxOptions | null = null;
      dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [file] })) as never;
      dialog.showMessageBox = (async (...args: unknown[]) => {
        asked = args.find((a) => a && typeof a === 'object' && 'buttons' in (a as object)) as Electron.MessageBoxOptions;
        return { response, checkboxChecked: false };
      }) as never;
      (globalThis as never as { __hangarShell: { dispatch: (c: unknown) => boolean } }).__hangarShell.dispatch({
        type: 'import-config',
      });
      for (let i = 0; i < 50 && !asked; i++) await new Promise((r) => setTimeout(r, 50));
      await new Promise((r) => setTimeout(r, 500));
      const box = asked as Electron.MessageBoxOptions | null;
      return box ? { defaultId: box.defaultId, cancelId: box.cancelId, buttons: box.buttons } : null;
    },
    { file, response },
  );

const onDisk = () => JSON.parse(fs.readFileSync(path.join(h.userData, 'config.json'), 'utf8'));

test("AN IMPORT KEEPS THIS MAC'S PUSH KEYS AND FIREBASE CREDENTIAL — an export leaves them out", async () => {
  h = await launch((origin) =>
    seedConfig(origin, {
      pushRegistrations: [REGISTRATION],
      preferences: { notifications: { firebase: FIREBASE } },
    }),
  );
  await h.rail();

  // What an export writes: this setup, without the machine's keys or credential — one service.
  const exported = seedConfig('http://127.0.0.1:1') as { services: unknown[] };
  const file = path.join(h.userData, 'hangar-config.json');
  fs.writeFileSync(file, JSON.stringify({ ...exported, services: exported.services.slice(0, 1) }));

  const asked = await importFrom(file, 0);
  expect(asked, 'the confirm was shown').not.toBeNull();
  expect(asked!.defaultId, 'Return cancels rather than replacing everything').toBe(asked!.cancelId);

  await expect.poll(() => onDisk().services.length, 'the import landed').toBe(1);
  expect(onDisk().pushRegistrations).toEqual([REGISTRATION]);
  expect(onDisk().preferences.notifications.firebase).toEqual(FIREBASE);
});

test("A CREDENTIAL IN THE FILE STILL WINS — an older export carried one", async () => {
  h = await launch((origin) => seedConfig(origin, { preferences: { notifications: { firebase: FIREBASE } } }));
  await h.rail();
  const theirs = { ...FIREBASE, apiKey: 'from-the-file' };
  const file = path.join(h.userData, 'old-export.json');
  fs.writeFileSync(
    file,
    JSON.stringify(seedConfig('http://127.0.0.1:1', { preferences: { notifications: { firebase: theirs } } })),
  );
  await importFrom(file, 0);
  await expect.poll(() => onDisk().preferences.notifications.firebase).toEqual(theirs);
});
