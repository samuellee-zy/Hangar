// Lets main-process modules be bundled and exercised under plain node. Between them they touch
// Electron for two things — `app.getPath('userData')` and `net.isOnline()` — so a short stub is
// enough to test the whole add-service path, and the endpoint poller's guards, without launching a
// window.

import os from 'node:os';
import path from 'node:path';

const dir = path.join(os.tmpdir(), 'hangar-check');

export const app = {
  getPath: () => dir,
  getAppPath: () => process.cwd(),
};

// True, because the interesting assertions are about what the poller refuses to do while it *can*
// reach the network. A stub that claimed to be offline would make every one of them pass vacuously.
export const net = {
  isOnline: () => true,
};

// Only ever reached on an uncaught exception, which no unit test raises. Present because
// `platform/logging.ts` imports it at module scope, and a missing export fails the import itself.
export const dialog = {
  showErrorBox: () => {},
};

/**
 * Recording rather than inert, because "was this URL handed to the system browser?" is the
 * assertion the navigation guard tests are actually making — a no-op stub would let a guard that
 * silently swallowed a blocked URL pass. Tests clear `opened` themselves.
 */
export const shell = {
  opened: [],
  openExternal(url) {
    shell.opened.push(url);
    return Promise.resolve();
  },
};

// Light, because the tests that reach this only need the import to resolve — nothing asserts on
// the colour a view is painted before its first frame.
export const nativeTheme = {
  shouldUseDarkColors: false,
};

export default { app, net, dialog, shell, nativeTheme };
