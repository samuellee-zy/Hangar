// Lets config.ts be bundled and exercised under plain node. It touches Electron for exactly one
// thing — `app.getPath('userData')` — so a two-line stub is enough to test the whole add-service
// path without launching a window.

import os from 'node:os';
import path from 'node:path';

const dir = path.join(os.tmpdir(), 'hangar-check');

export const app = {
  getPath: () => dir,
  getAppPath: () => process.cwd(),
};

export default { app };
