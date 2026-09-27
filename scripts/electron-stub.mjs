// Lets main-process modules be bundled and exercised under plain node. Each export is the least a
// module needs from Electron to import and run under a unit test — `app.getPath`, `net.isOnline`,
// and the few others below, each with a note on why it's shaped the way it is.

import os from 'node:os';
import path from 'node:path';

/**
 * One userData per worker. Vitest runs test files in parallel, and a single shared directory let one
 * file delete it (add-service does, to start clean) while another was reading its config — a failure
 * that appeared once and never again, in whichever test happened to be reading at the time.
 */
const dir = path.join(os.tmpdir(), `hangar-check-${process.env['VITEST_POOL_ID'] ?? process.pid}`);

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
